import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleAdapter } from "../src/adapters/openai-compatible.js";
import { AdapterError } from "../src/adapters/types.js";

/**
 * Adapter tests stub global fetch — no network, no real keys. They verify the
 * request we build and the normalization/error-classification of responses.
 */

function adapter() {
  return new OpenAICompatibleAdapter({
    id: "test",
    baseUrl: "https://example.test/v1/",
    apiKey: "sk-user-supplied-only",
    timeoutMs: 5_000,
  });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("OpenAICompatibleAdapter.chat", () => {
  it("sends a well-formed request and normalizes the response", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
      // Honest UA, user key in Authorization, no impersonation.
      const headers = init.headers as Record<string, string>;
      expect(headers["user-agent"]).toBe("relay-gateway/0.0.1");
      expect(headers["authorization"]).toBe("Bearer sk-user-supplied-only");
      return jsonResponse({
        model: "gpt-4o-mini",
        choices: [{ message: { content: "hello there" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await adapter().chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(res.provider).toBe("test");
    expect(res.content).toBe("hello there");
    expect(res.finishReason).toBe("stop");
    expect(res.usage).toEqual({
      promptTokens: 5,
      completionTokens: 2,
      totalTokens: 7,
      // This surface reports no prompt-cache split.
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("classifies a 429 as a retriable rate_limit error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("slow down", { status: 429 })),
    );
    try {
      await adapter().chat({ model: "m", messages: [{ role: "user", content: "x" }] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      const ae = err as AdapterError;
      expect(ae.kind).toBe("rate_limit");
      expect(ae.retriable).toBe(true);
    }
  });

  it("classifies a 401 as a non-retriable auth error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad key", { status: 401 })),
    );
    await expect(
      adapter().chat({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ kind: "auth", retriable: false });
  });

  it("rejects a malformed provider response via schema validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ choices: [] })),
    );
    await expect(
      adapter().chat({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});
