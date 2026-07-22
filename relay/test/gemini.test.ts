import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiAdapter,
  classifyGeminiError,
  mapGeminiFinishReason,
  toGeminiContents,
} from "../src/adapters/gemini.js";
import { AdapterError, type ChatRequest, type ChatStream } from "../src/adapters/types.js";
import { computeCostUsd, DEFAULT_PRICING } from "../src/cost/pricing.js";

const KEY = "AIza-test-fixture-do-not-use";
const REQ: ChatRequest = { model: "gemini-2.0-flash", messages: [{ role: "user", content: "hi" }] };

function adapter(overrides: Record<string, unknown> = {}) {
  return new GeminiAdapter({
    id: "gemini",
    kind: "gemini",
    baseUrl: "https://gen.test/v1beta",
    apiKey: KEY,
    timeoutMs: 5_000,
    ...overrides,
  });
}

function okBody(over: Record<string, unknown> = {}) {
  return {
    candidates: [{ content: { parts: [{ text: "hello" }], role: "model" }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    modelVersion: "gemini-2.0-flash",
    ...over,
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function collectStream(gen: ChatStream) {
  let text = "";
  let r = await gen.next();
  while (!r.done) {
    text += r.value.text;
    r = await gen.next();
  }
  return { text, result: r.value };
}

afterEach(() => vi.restoreAllMocks());

describe("Gemini request shape", () => {
  it("hits /models/<model>:generateContent with x-goog-api-key (no Bearer, no ?key=)", async () => {
    const fetchMock = vi.fn(async () => jsonRes(okBody()));
    vi.stubGlobal("fetch", fetchMock);
    await adapter().chat(REQ);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://gen.test/v1beta/models/gemini-2.0-flash:generateContent");
    expect(String(url)).not.toContain("key="); // key not in the URL
    const headers = init!.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe(KEY);
    expect(headers["authorization"]).toBeUndefined();
  });

  it("maps maxTokens to generationConfig.maxOutputTokens", async () => {
    const fetchMock = vi.fn(async () => jsonRes(okBody()));
    vi.stubGlobal("fetch", fetchMock);
    await adapter().chat({ ...REQ, maxTokens: 256, temperature: 0.5 });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.generationConfig).toEqual({ maxOutputTokens: 256, temperature: 0.5 });
  });

  it("strips a leading models/ prefix from the model name", async () => {
    const fetchMock = vi.fn(async () => jsonRes(okBody()));
    vi.stubGlobal("fetch", fetchMock);
    await adapter().chat({ ...REQ, model: "models/gemini-1.5-pro" });
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/models/gemini-1.5-pro:generateContent");
  });
});

describe("toGeminiContents", () => {
  it("hoists system into a top-level systemInstruction, joining multi-turn in order", () => {
    const { systemInstruction, contents } = toGeminiContents(
      [
        { role: "system", content: "first" },
        { role: "user", content: "a" },
        { role: "system", content: "second" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      "gemini",
    );
    expect(systemInstruction).toEqual({ parts: [{ text: "first\n\nsecond" }] });
    // assistant -> model; system is never a content role.
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "a" }] });
  });

  it("rejects a conversation not starting with a user turn as bad_request", () => {
    try {
      toGeminiContents(
        [
          { role: "system", content: "s" },
          { role: "assistant", content: "a" },
        ],
        "gemini",
      );
      expect.unreachable();
    } catch (e) {
      expect((e as AdapterError).kind).toBe("bad_request");
      expect((e as AdapterError).retriable).toBe(false);
    }
  });
});

describe("Gemini response normalization", () => {
  it("joins candidate text parts and maps STOP -> stop", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes(okBody({ candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] }, finishReason: "STOP" }] })),
      ),
    );
    const res = await adapter().chat(REQ);
    expect(res.content).toBe("ab");
    expect(res.finishReason).toBe("stop");
    expect(res.provider).toBe("gemini");
  });

  it("maps finish reasons: STOP/MAX_TOKENS normalized, SAFETY passes through", () => {
    expect(mapGeminiFinishReason("STOP")).toBe("stop");
    expect(mapGeminiFinishReason("MAX_TOKENS")).toBe("length");
    expect(mapGeminiFinishReason("SAFETY")).toBe("safety");
    expect(mapGeminiFinishReason("RECITATION")).toBe("recitation");
    expect(mapGeminiFinishReason(undefined)).toBeNull();
  });

  it("surfaces a SAFETY block as a finishReason, not a thrown error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(okBody({ candidates: [{ finishReason: "SAFETY" }] }))),
    );
    const res = await adapter().chat(REQ);
    expect(res.finishReason).toBe("safety");
    expect(res.content).toBe("");
  });

  it("splits cached tokens out of promptTokenCount for honest usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes(
          okBody({
            usageMetadata: {
              promptTokenCount: 1000, // INCLUDES the cached portion
              candidatesTokenCount: 500,
              totalTokenCount: 1500,
              cachedContentTokenCount: 300,
            },
          }),
        ),
      ),
    );
    const res = await adapter().chat(REQ);
    expect(res.usage).toEqual({
      promptTokens: 700, // 1000 - 300 cached = base-rate input
      completionTokens: 500,
      totalTokens: 1500,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 300,
    });
  });
});

describe("Gemini error classification", () => {
  it("maps status strings onto the shared retriable split", () => {
    expect(classifyGeminiError(429, "RESOURCE_EXHAUSTED")).toBe("rate_limit");
    expect(classifyGeminiError(503, "UNAVAILABLE")).toBe("server");
    expect(classifyGeminiError(500, "INTERNAL")).toBe("server");
    expect(classifyGeminiError(401, "UNAUTHENTICATED")).toBe("auth");
    expect(classifyGeminiError(403, "PERMISSION_DENIED")).toBe("auth");
    expect(classifyGeminiError(400, "INVALID_ARGUMENT")).toBe("bad_request");
    expect(classifyGeminiError(404, "NOT_FOUND")).toBe("bad_request");
  });

  it("treats RESOURCE_EXHAUSTED as retriable and UNAUTHENTICATED as not", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, 429)),
    );
    await expect(adapter().chat(REQ)).rejects.toMatchObject({ kind: "rate_limit", retriable: true });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401)),
    );
    await expect(adapter().chat(REQ)).rejects.toMatchObject({ kind: "auth", retriable: false });
  });

  it("redacts the key from an echoed error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ error: { status: "INVALID_ARGUMENT", message: `bad ${KEY}` } }, 400)),
    );
    try {
      await adapter().chat(REQ);
      expect.unreachable();
    } catch (e) {
      expect((e as AdapterError).message).not.toContain(KEY);
      expect((e as AdapterError).message).toContain("***");
    }
  });
});

describe("Gemini streaming", () => {
  const GEMINI_SSE =
    [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}],"role":"model"}}]}',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"totalTokenCount":12},"modelVersion":"gemini-2.0-flash"}',
    ].join("\n\n") + "\n\n";

  function sseResponse(text: string): Response {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  it("streams deltas and returns usage from the final chunk (no [DONE] terminator)", async () => {
    const fetchMock = vi.fn(async () => sseResponse(GEMINI_SSE));
    vi.stubGlobal("fetch", fetchMock);
    const { text, result } = await collectStream(adapter().chatStream(REQ));
    expect(text).toBe("Hello");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toMatchObject({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    // Streaming hits :streamGenerateContent?alt=sse
    expect(String(fetchMock.mock.calls[0]![0])).toContain(":streamGenerateContent?alt=sse");
  });

  it("throws a classified error BEFORE any delta on a connect-time 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ error: { status: "RESOURCE_EXHAUSTED" } }, 429)),
    );
    await expect(adapter().chatStream(REQ).next()).rejects.toMatchObject({
      kind: "rate_limit",
      retriable: true,
    });
  });
});

describe("Gemini cost via the pricing table", () => {
  it("prices gemini-2.0-flash including the cache-read discount", () => {
    // gemini-2.0-flash: $0.10 in, $0.40 out, cache read 0.25x.
    //   700 base in  -> 700/1e6 * 0.10          = 0.00007
    //   300 cache rd -> 300/1e6 * (0.10*0.25)   = 0.0000075
    //   500 out      -> 500/1e6 * 0.40          = 0.0002
    //                                     total  = 0.0002775
    const cost = computeCostUsd(DEFAULT_PRICING, "gemini", "gemini-2.0-flash", {
      promptTokens: 700,
      completionTokens: 500,
      totalTokens: 1500,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 300,
    });
    expect(cost).toBeCloseTo(0.0002775, 10);
  });
});
