import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicAdapter } from "../src/adapters/anthropic.js";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { OpenAICompatibleAdapter } from "../src/adapters/openai-compatible.js";
import type { ChatRequest, ProviderAdapter } from "../src/adapters/types.js";
import type { Chain } from "../src/config/chains.js";
import { Router, RoutingError } from "../src/routing/router.js";

/**
 * End-to-end (adapter + router) tests exercising the *real* OpenAI-compatible
 * adapter with a stubbed fetch. These pin down the two failure modes that are
 * cheapest to get wrong and most painful to debug against a live provider:
 *   1. a genuine 401 must STOP the chain, not be misclassified as retriable;
 *   2. key material must never appear in the attempt log / routing fields that
 *      feed the request log and the x-relay-* response headers.
 */

const KEY = "sk-super-secret-DO-NOT-LOG";
const REQ: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };

function realAdapter(id: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({ id, baseUrl: "https://x.test/v1", apiKey: KEY });
}
function chain(providers: Chain["providers"]): Chain {
  return { name: "c", strategy: "ordered", providers };
}
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("real 401 handling through the router", () => {
  it("stops the chain on a live 401 and does not fail over", async () => {
    const fetchMock = vi.fn(async () => new Response("invalid api key", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const registry = new Map<string, ProviderAdapter>([
      ["a", realAdapter("a")],
      ["b", realAdapter("b")],
    ]);
    const router = new Router(registry, []);

    try {
      await router.run(REQ, chain([{ id: "a" }, { id: "b" }]));
      expect.unreachable("a 401 must not resolve");
    } catch (e) {
      const re = e as RoutingError;
      expect(re.lastError?.kind).toBe("auth");
      expect(re.lastError?.retriable).toBe(false);
    }
    // Exactly one upstream call: b was never tried (no failover on auth).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("native Anthropic adapter through the router", () => {
  it("stops the chain on a real Anthropic 401 authentication_error", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "invalid x-api-key" },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const registry = new Map<string, ProviderAdapter>([
      [
        "anthropic",
        new AnthropicAdapter({
          id: "anthropic",
          kind: "anthropic",
          baseUrl: "https://api.anthropic.test/v1",
          apiKey: KEY,
        }),
      ],
      ["b", realAdapter("b")],
    ]);
    const router = new Router(registry, []);

    try {
      await router.run(REQ, chain([{ id: "anthropic" }, { id: "b" }]));
      expect.unreachable("a 401 must not resolve");
    } catch (e) {
      const re = e as RoutingError;
      expect(re.lastError?.kind).toBe("auth");
      expect(re.lastError?.retriable).toBe(false);
    }
    // Exactly one upstream call — no failover past an auth failure.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails over on a 529 overloaded_error (Anthropic-specific, retriable)", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        call++;
        if (String(url).includes("anthropic")) {
          return new Response(
            JSON.stringify({ error: { type: "overloaded_error", message: "overloaded" } }),
            { status: 529, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            model: "m",
            choices: [{ message: { content: "from fallback" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const registry = new Map<string, ProviderAdapter>([
      [
        "anthropic",
        new AnthropicAdapter({
          id: "anthropic",
          kind: "anthropic",
          baseUrl: "https://api.anthropic.test/v1",
          apiKey: KEY,
        }),
      ],
      ["b", realAdapter("b")],
    ]);
    const router = new Router(registry, []);
    const result = await router.run(REQ, chain([{ id: "anthropic" }, { id: "b" }]));

    expect(result.response.provider).toBe("b");
    expect(result.attempts[0]).toMatchObject({ provider: "anthropic", errorKind: "server" });
    expect(call).toBe(2);
  });
});

describe("native Gemini adapter through the router", () => {
  function gemini(id: string): GeminiAdapter {
    return new GeminiAdapter({
      id,
      kind: "gemini",
      baseUrl: "https://gen.test/v1beta",
      apiKey: KEY,
    });
  }

  it("stops the chain on a Gemini UNAUTHENTICATED (401)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 401, status: "UNAUTHENTICATED" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const registry = new Map<string, ProviderAdapter>([
      ["gemini", gemini("gemini")],
      ["b", realAdapter("b")],
    ]);
    const router = new Router(registry, []);
    try {
      await router.run(REQ, chain([{ id: "gemini" }, { id: "b" }]));
      expect.unreachable();
    } catch (e) {
      expect((e as RoutingError).lastError?.kind).toBe("auth");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1); // no failover past auth
  });

  it("fails over on a Gemini RESOURCE_EXHAUSTED (429)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("gen.test")) {
          return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            model: "m",
            choices: [{ message: { content: "fallback" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const registry = new Map<string, ProviderAdapter>([
      ["gemini", gemini("gemini")],
      ["b", realAdapter("b")],
    ]);
    const result = await new Router(registry, []).run(REQ, chain([{ id: "gemini" }, { id: "b" }]));
    expect(result.response.provider).toBe("b");
    expect(result.attempts[0]).toMatchObject({ provider: "gemini", errorKind: "rate_limit" });
  });
});

describe("redaction on the request/response path", () => {
  it("never puts key material in the attempt log or routing fields (success)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes({
          model: "m",
          choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        }),
      ),
    );
    const registry = new Map<string, ProviderAdapter>([["a", realAdapter("a")]]);
    const router = new Router(registry, []);
    const result = await router.run(REQ, chain([{ id: "a" }]));

    // These three are exactly what the server writes to the log + x-relay-* headers.
    const exposed = JSON.stringify({
      chain: result.chain,
      provider: result.response.provider,
      attempts: result.attempts,
    });
    expect(exposed).not.toContain(KEY);
  });

  it("strips the key even if a provider echoes it back in an error body", async () => {
    // Pathological provider that reflects the Authorization value in its 400 body.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const auth = (init.headers as Record<string, string>)["authorization"] ?? "";
        return new Response(`bad request with token ${auth}`, { status: 400 });
      }),
    );
    const registry = new Map<string, ProviderAdapter>([["a", realAdapter("a")]]);
    const router = new Router(registry, []);

    try {
      await router.run(REQ, chain([{ id: "a" }]));
      expect.unreachable();
    } catch (e) {
      const re = e as RoutingError;
      expect(JSON.stringify(re.attempts)).not.toContain(KEY);
      expect(re.lastError?.message).not.toContain(KEY);
      expect(re.lastError?.message).toContain("***"); // redacted marker
    }
  });

  it("still sends the real key upstream (redaction is log-only)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonRes({ model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const registry = new Map<string, ProviderAdapter>([["a", realAdapter("a")]]);
    await new Router(registry, []).run(REQ, chain([{ id: "a" }]));

    const sent = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(sent["authorization"]).toBe(`Bearer ${KEY}`);
  });
});
