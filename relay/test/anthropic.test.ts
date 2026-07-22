import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicAdapter,
  classifyAnthropicError,
  mapStopReason,
  toAnthropicMessages,
} from "../src/adapters/anthropic.js";
import { AdapterError, type ChatRequest } from "../src/adapters/types.js";

/**
 * Native Anthropic Messages API adapter. Stubbed fetch — no network, no keys.
 * These pin the shape differences a generic OpenAI-compatible shim gets wrong.
 */

const KEY = "sk-ant-test-fixture-do-not-use";

function adapter(overrides: Record<string, unknown> = {}) {
  return new AnthropicAdapter({
    id: "anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.test/v1",
    apiKey: KEY,
    timeoutMs: 5_000,
    ...overrides,
  });
}

function okBody(over: Record<string, unknown> = {}) {
  return {
    model: "claude-opus-4-8",
    content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
    ...over,
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const REQ: ChatRequest = { model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] };

afterEach(() => vi.restoreAllMocks());

describe("request shape", () => {
  it("authenticates with x-api-key + anthropic-version, not Bearer", async () => {
    const fetchMock = vi.fn(async () => jsonRes(okBody()));
    vi.stubGlobal("fetch", fetchMock);
    await adapter().chat(REQ);

    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(KEY);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["authorization"]).toBeUndefined();
    expect(headers["user-agent"]).toBe("relay-gateway/0.0.1");
  });

  it("posts to /messages with required max_tokens and content blocks", async () => {
    const fetchMock = vi.fn(async () => jsonRes(okBody()));
    vi.stubGlobal("fetch", fetchMock);
    await adapter().chat(REQ);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.test/v1/messages");
    const body = JSON.parse(String(init!.body));
    // max_tokens is REQUIRED by the Messages API; we default it.
    expect(body.max_tokens).toBe(16000);
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("respects an explicit maxTokens", async () => {
    const fetchMock = vi.fn(async () => jsonRes(okBody()));
    vi.stubGlobal("fetch", fetchMock);
    await adapter().chat({ ...REQ, maxTokens: 256 });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).max_tokens).toBe(256);
  });
});

describe("toAnthropicMessages", () => {
  it("hoists system to a top-level field, not a message", () => {
    const { system, messages } = toAnthropicMessages(
      [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
      "anthropic",
    );
    expect(system).toBe("be terse");
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    // The system text must NOT appear as a message role.
    expect(messages.some((m) => (m.role as string) === "system")).toBe(false);
  });

  it("joins MULTI-TURN system prompts in order (the shim edge case)", () => {
    const { system, messages } = toAnthropicMessages(
      [
        { role: "system", content: "first" },
        { role: "user", content: "a" },
        { role: "system", content: "second" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      "anthropic",
    );
    expect(system).toBe("first\n\nsecond");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("maps a tool message to a tool_result block when toolCallId is present", () => {
    const { messages } = toAnthropicMessages(
      [
        { role: "user", content: "run it" },
        { role: "tool", content: "42", toolCallId: "toolu_abc" },
      ],
      "anthropic",
    );
    expect(messages[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_abc", content: "42" }],
    });
  });

  it("rejects a conversation that doesn't start with a user turn", () => {
    expect(() =>
      toAnthropicMessages(
        [
          { role: "system", content: "s" },
          { role: "assistant", content: "a" },
        ],
        "anthropic",
      ),
    ).toThrow(/must start with a user message/);
  });

  it("rejects a system-only conversation as bad_request (non-retriable)", () => {
    try {
      toAnthropicMessages([{ role: "system", content: "s" }], "anthropic");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AdapterError);
      expect((e as AdapterError).kind).toBe("bad_request");
      expect((e as AdapterError).retriable).toBe(false);
    }
  });
});

describe("response normalization", () => {
  it("concatenates text blocks and skips non-text blocks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes(
          okBody({
            content: [
              { type: "thinking", text: "SHOULD NOT APPEAR" },
              { type: "text", text: "part one " },
              { type: "text", text: "part two" },
            ],
          }),
        ),
      ),
    );
    const res = await adapter().chat(REQ);
    expect(res.content).toBe("part one part two");
    expect(res.content).not.toContain("SHOULD NOT APPEAR");
  });

  it("maps Anthropic stop reasons into the shared vocabulary", () => {
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("stop_sequence")).toBe("stop");
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason("tool_use")).toBe("tool_use");
    expect(mapStopReason("refusal")).toBe("refusal");
    expect(mapStopReason(null)).toBeNull();
  });

  it("surfaces a refusal as a finishReason, NOT a retriable error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(okBody({ stop_reason: "refusal", content: [] }))),
    );
    // A policy refusal is a successful 200. Throwing retriably here would make
    // the router shop the request to another provider — that's evasion.
    const res = await adapter().chat(REQ);
    expect(res.finishReason).toBe("refusal");
    expect(res.content).toBe("");
  });

  it("reads the real usage object including BOTH cache token fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes(
          okBody({
            usage: {
              input_tokens: 1000,
              output_tokens: 500,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 300,
            },
          }),
        ),
      ),
    );
    const res = await adapter().chat(REQ);
    expect(res.usage).toEqual({
      promptTokens: 1000, // base-rate input only
      completionTokens: 500,
      totalTokens: 2000, // includes cached input, which input_tokens excludes
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 300,
    });
  });

  it("reports null cache fields when the provider omits them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(okBody())));
    const res = await adapter().chat(REQ);
    expect(res.usage?.cacheCreationInputTokens).toBeNull();
    expect(res.usage?.cacheReadInputTokens).toBeNull();
    expect(res.usage?.totalTokens).toBe(15);
  });
});

describe("error classification", () => {
  it("maps Anthropic error types onto the shared retriable split", () => {
    // Retriable — the breaker should back off and the router should fail over.
    expect(classifyAnthropicError(429, "rate_limit_error")).toBe("rate_limit");
    expect(classifyAnthropicError(529, "overloaded_error")).toBe("server");
    expect(classifyAnthropicError(500, "api_error")).toBe("server");
    // Non-retriable — these must STOP the chain.
    expect(classifyAnthropicError(401, "authentication_error")).toBe("auth");
    expect(classifyAnthropicError(403, "permission_error")).toBe("auth");
    expect(classifyAnthropicError(400, "invalid_request_error")).toBe("bad_request");
    expect(classifyAnthropicError(404, "not_found_error")).toBe("bad_request");
    expect(classifyAnthropicError(413, "request_too_large")).toBe("bad_request");
  });

  it("falls back to the status code when the body has no typed error", () => {
    expect(classifyAnthropicError(429)).toBe("rate_limit");
    expect(classifyAnthropicError(529)).toBe("server");
    expect(classifyAnthropicError(401)).toBe("auth");
    expect(classifyAnthropicError(400)).toBe("bad_request");
  });

  it("treats 529 overloaded_error as retriable (no OpenAI equivalent)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes({ type: "error", error: { type: "overloaded_error", message: "overloaded" } }, 529),
      ),
    );
    await expect(adapter().chat(REQ)).rejects.toMatchObject({
      kind: "server",
      retriable: true,
    });
  });

  it("treats 401 authentication_error as non-retriable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes({ type: "error", error: { type: "authentication_error", message: "bad key" } }, 401),
      ),
    );
    await expect(adapter().chat(REQ)).rejects.toMatchObject({
      kind: "auth",
      retriable: false,
    });
  });

  it("honors Retry-After on a 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
            status: 429,
            headers: { "retry-after": "7", "content-type": "application/json" },
          }),
      ),
    );
    try {
      await adapter().chat(REQ);
      expect.unreachable();
    } catch (e) {
      expect((e as AdapterError).retryAfterMs).toBe(7000);
    }
  });

  it("redacts the key from an echoed error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes({ error: { type: "invalid_request_error", message: `bad key ${KEY}` } }, 400),
      ),
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
