import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicAdapter } from "../src/adapters/anthropic.js";
import { OpenAICompatibleAdapter } from "../src/adapters/openai-compatible.js";
import { parseSse } from "../src/adapters/sse.js";
import {
  AdapterError,
  type ChatRequest,
  type ChatStream,
  type ProviderAdapter,
  type StreamResult,
} from "../src/adapters/types.js";
import type { Chain } from "../src/config/chains.js";
import { Router, RoutingError, type RouteStreamEvent } from "../src/routing/router.js";

const REQ: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };

/** Build a fetch Response whose body streams the given SSE text. */
function sseResponse(text: string, status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Chunk it oddly to exercise the parser's buffering across reads.
      const enc = new TextEncoder();
      const mid = Math.floor(text.length / 2);
      controller.enqueue(enc.encode(text.slice(0, mid)));
      controller.enqueue(enc.encode(text.slice(mid)));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

async function collectStream(gen: ChatStream): Promise<{ text: string; result: StreamResult }> {
  let text = "";
  let r = await gen.next();
  while (!r.done) {
    text += r.value.text;
    r = await gen.next();
  }
  return { text, result: r.value };
}

afterEach(() => vi.restoreAllMocks());

describe("parseSse", () => {
  it("splits events, joins multi-line data, and ignores comments", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(": keep-alive\ndata: a\n\nevent: x\ndata: b\ndata: c\n\n"));
        c.close();
      },
    });
    const events = [];
    for await (const e of parseSse(stream)) events.push(e);
    expect(events).toEqual([
      { event: undefined, data: "a" },
      { event: "x", data: "b\nc" },
    ]);
  });
});

describe("OpenAI-compatible streaming", () => {
  const OAI_STREAM = [
    'data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"Hel"}}]}',
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
    "data: [DONE]",
  ].join("\n\n") + "\n\n";

  function adapter() {
    return new OpenAICompatibleAdapter({
      id: "openai",
      baseUrl: "https://x.test/v1",
      apiKey: "sk-x",
    });
  }

  it("streams deltas and returns usage from the final chunk", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(OAI_STREAM)));
    const { text, result } = await collectStream(adapter().chatStream(REQ));
    expect(text).toBe("Hello");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toMatchObject({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    expect(result.provider).toBe("openai");
  });

  it("sets stream + include_usage on the request", async () => {
    const fetchMock = vi.fn(async () => sseResponse(OAI_STREAM));
    vi.stubGlobal("fetch", fetchMock);
    await collectStream(adapter().chatStream(REQ));
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("throws a classified error BEFORE any delta on a connect-time failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429 })));
    const gen = adapter().chatStream(REQ);
    // The very first pull triggers the fetch and must throw — nothing yielded.
    await expect(gen.next()).rejects.toMatchObject({ kind: "rate_limit", retriable: true });
  });
});

describe("Anthropic streaming", () => {
  const ANTHROPIC_STREAM = [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"cache_read_input_tokens":300}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":500}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ].join("\n\n") + "\n\n";

  function adapter() {
    return new AnthropicAdapter({
      id: "anthropic",
      kind: "anthropic",
      baseUrl: "https://a.test/v1",
      apiKey: "sk-ant-x",
    });
  }

  it("parses the named-event stream: deltas, stop_reason, and the 4-field usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(ANTHROPIC_STREAM)));
    const { text, result } = await collectStream(adapter().chatStream(REQ));
    expect(text).toBe("Hello");
    expect(result.finishReason).toBe("stop"); // end_turn -> stop
    expect(result.usage).toEqual({
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1800, // 1000 + 500 + 300 cache read
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 300,
    });
  });

  it("sends stream:true with x-api-key (not Bearer)", async () => {
    const fetchMock = vi.fn(async () => sseResponse(ANTHROPIC_STREAM));
    vi.stubGlobal("fetch", fetchMock);
    await collectStream(adapter().chatStream(REQ));
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init!.body)).stream).toBe(true);
    const headers = init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-x");
    expect(headers["authorization"]).toBeUndefined();
  });

  it("throws a classified error before any delta on a 529 overloaded_error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { type: "overloaded_error" } }), { status: 529 }),
      ),
    );
    await expect(adapter().chatStream(REQ).next()).rejects.toMatchObject({
      kind: "server",
      retriable: true,
    });
  });
});

// --- Router-level streaming: the failover boundary --------------------------

/** A fake streaming adapter. `preError` throws before the first delta (connect
 *  failure); `deltas` then stream; `midError` throws after the deltas (commit
 *  then fail). */
class FakeStreamAdapter implements ProviderAdapter {
  readonly label: string;
  readonly capabilities = new Set(["chat"] as const);
  constructor(
    readonly id: string,
    private readonly opts: {
      preError?: AdapterError;
      deltas?: string[];
      midError?: AdapterError;
      usage?: StreamResult["usage"];
    },
  ) {
    this.label = id;
  }
  async health() {
    return { ok: true, latencyMs: 0 };
  }
  async chat(): Promise<never> {
    throw new Error("not used");
  }
  async *chatStream(): ChatStream {
    if (this.opts.preError) throw this.opts.preError;
    for (const d of this.opts.deltas ?? []) yield { text: d };
    if (this.opts.midError) throw this.opts.midError;
    return {
      provider: this.id,
      model: "m",
      finishReason: "stop",
      usage: this.opts.usage ?? null,
      latencyMs: 1,
    };
  }
}

function chain(providers: Chain["providers"]): Chain {
  return { name: "c", strategy: "ordered", providers };
}

async function drain(gen: AsyncGenerator<RouteStreamEvent>): Promise<RouteStreamEvent[]> {
  const out: RouteStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("Router streaming failover boundary", () => {
  it("fails over BEFORE the first token on a retriable connect error", async () => {
    const registry = new Map<string, ProviderAdapter>([
      ["a", new FakeStreamAdapter("a", { preError: new AdapterError("429", "rate_limit", "a") })],
      ["b", new FakeStreamAdapter("b", { deltas: ["hi ", "there"] })],
    ]);
    const router = new Router(registry, []);
    const events = await drain(router.streamRun(REQ, chain([{ id: "a" }, { id: "b" }])));

    const committed = events.find((e) => e.type === "committed");
    expect(committed).toMatchObject({ provider: "b" });
    const text = events.filter((e) => e.type === "delta").map((e: any) => e.text).join("");
    expect(text).toBe("hi there");
    // The committed event's attempts show a failed 'a' then a successful 'b'.
    expect((committed as any).attempts.map((x: any) => `${x.provider}:${x.outcome}`)).toEqual([
      "a:error",
      "b:success",
    ]);
  });

  it("stops the chain (no failover) on a non-retriable connect error", async () => {
    const b = new FakeStreamAdapter("b", { deltas: ["nope"] });
    const registry = new Map<string, ProviderAdapter>([
      ["a", new FakeStreamAdapter("a", { preError: new AdapterError("401", "auth", "a") })],
      ["b", b],
    ]);
    const router = new Router(registry, []);
    await expect(drain(router.streamRun(REQ, chain([{ id: "a" }, { id: "b" }])))).rejects.toMatchObject({
      name: "RoutingError",
    });
  });

  it("does NOT fail over once committed — a mid-stream error becomes stream_error", async () => {
    const b = new FakeStreamAdapter("b", { deltas: ["SHOULD-NOT-RUN"] });
    const registry = new Map<string, ProviderAdapter>([
      [
        "a",
        new FakeStreamAdapter("a", {
          deltas: ["par", "tial"],
          midError: new AdapterError("boom", "server", "a"),
        }),
      ],
      ["b", b],
    ]);
    const router = new Router(registry, []);
    const events = await drain(router.streamRun(REQ, chain([{ id: "a" }, { id: "b" }])));

    // 'a' committed and streamed two deltas, then errored — b must never run.
    expect(events.find((e) => e.type === "committed")).toMatchObject({ provider: "a" });
    expect(events.filter((e) => e.type === "delta").map((e: any) => e.text).join("")).toBe("partial");
    const err = events.find((e) => e.type === "stream_error");
    expect(err).toMatchObject({ provider: "a" });
    expect(events.find((e) => e.type === "final")).toBeUndefined(); // no clean final
  });

  it("emits final with the served provider's usage on a clean stream", async () => {
    const registry = new Map<string, ProviderAdapter>([
      [
        "a",
        new FakeStreamAdapter("a", {
          deltas: ["ok"],
          usage: {
            promptTokens: 5,
            completionTokens: 2,
            totalTokens: 7,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
          },
        }),
      ],
    ]);
    const router = new Router(registry, []);
    const events = await drain(router.streamRun(REQ, chain([{ id: "a" }])));
    const final = events.find((e) => e.type === "final") as any;
    expect(final.result.usage.totalTokens).toBe(7);
    expect(final.provider).toBe("a");
  });

  it("fails over from a non-streaming-capable provider to a streaming one", async () => {
    // 'a' has no chatStream method at all.
    const a: ProviderAdapter = {
      id: "a",
      label: "a",
      capabilities: new Set(["chat"]),
      async health() {
        return { ok: true, latencyMs: 0 };
      },
      async chat() {
        throw new Error("x");
      },
    };
    const registry = new Map<string, ProviderAdapter>([
      ["a", a],
      ["b", new FakeStreamAdapter("b", { deltas: ["ok"] })],
    ]);
    const router = new Router(registry, []);
    const events = await drain(router.streamRun(REQ, chain([{ id: "a" }, { id: "b" }])));
    expect(events.find((e) => e.type === "committed")).toMatchObject({ provider: "b" });
  });

  it("RoutingErrors when no provider in the chain can stream", async () => {
    const a: ProviderAdapter = {
      id: "a",
      label: "a",
      capabilities: new Set(["chat"]),
      async health() {
        return { ok: true, latencyMs: 0 };
      },
      async chat() {
        throw new Error("x");
      },
    };
    const router = new Router(new Map([["a", a]]), []);
    await expect(drain(router.streamRun(REQ, chain([{ id: "a" }])))).rejects.toMatchObject({
      name: "RoutingError",
    });
  });
});
