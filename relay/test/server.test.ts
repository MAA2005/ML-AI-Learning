import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../src/adapters/types.js";
import type { UsageEntry, UsageLedger } from "../src/cost/ledger.js";
import { DEFAULT_PRICING } from "../src/cost/pricing.js";
import { buildServer } from "../src/server.js";

/**
 * Server-level tests via Fastify `inject` (no real socket). They confirm the
 * cost/usage wiring end to end and re-assert the redaction guarantee at the HTTP
 * boundary (response headers must not carry key material).
 */

class MemoryLedger implements UsageLedger {
  readonly backend = "ndjson" as const;
  entries: UsageEntry[] = [];
  record(e: UsageEntry): void {
    this.entries.push(e);
  }
  summaryByProvider() {
    return [];
  }
  summaryByChain() {
    return [];
  }
  recent(limit: number) {
    return this.entries.slice(-limit).reverse();
  }
}

const KEY = "sk-server-test-secret";
const provider: ProviderConfig = {
  id: "openai",
  baseUrl: "https://x.test/v1",
  apiKey: KEY,
  defaultModel: "gpt-4o-mini",
};

function okBody() {
  return {
    model: "gpt-4o-mini",
    choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("POST /v1/chat cost + usage wiring", () => {
  it("records a costed ledger entry and returns cost/routing headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(okBody()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const ledger = new MemoryLedger();
    const app = buildServer({
      providers: [provider],
      chains: [{ name: "default", strategy: "ordered", providers: [{ id: "openai" }] }],
      ledger,
      pricing: DEFAULT_PRICING,
      now: () => 12345,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-relay-provider"]).toBe("openai");
    expect(res.headers["x-relay-chain"]).toBe("default");
    // 1000 in @0.15/M + 500 out @0.60/M = 0.00045
    expect(res.headers["x-relay-cost-usd"]).toBe("0.000450");

    expect(ledger.entries).toHaveLength(1);
    const e = ledger.entries[0]!;
    expect(e).toMatchObject({
      ts: 12345,
      provider: "openai",
      model: "gpt-4o-mini",
      totalTokens: 1500,
      outcome: "success",
    });
    expect(e.costUsd).toBeCloseTo(0.00045, 10);

    // Redaction at the HTTP boundary: no header carries the key.
    expect(JSON.stringify(res.headers)).not.toContain(KEY);

    await app.close();
  });

  it("applies opt-in compression to the upstream body and reports it in headers", async () => {
    let sentBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify(okBody()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const app = buildServer({
      providers: [provider],
      chains: [{ name: "default", strategy: "ordered", providers: [{ id: "openai" }] }],
      ledger: new MemoryLedger(),
      pricing: DEFAULT_PRICING,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { "x-relay-compress": "prose" },
      payload: {
        model: "gpt-4o-mini",
        messages: [
          { role: "user", content: "Please    look   at `let x=1;` and    fix    it." },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-relay-compress-engine"]).toBe("prose");
    expect(Number(res.headers["x-relay-compress-after"])).toBeLessThanOrEqual(
      Number(res.headers["x-relay-compress-before"]),
    );
    // Upstream got the shrunk prose, with the inline code preserved.
    expect(sentBody.messages[0].content).toBe("Please look at `let x=1;` and fix it.");

    await app.close();
  });

  it("does not compress when no header is present", async () => {
    let sentBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify(okBody()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const app = buildServer({
      providers: [provider],
      chains: [{ name: "default", strategy: "ordered", providers: [{ id: "openai" }] }],
      ledger: new MemoryLedger(),
      pricing: DEFAULT_PRICING,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "keep   spaces" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-relay-compress-engine"]).toBeUndefined();
    expect(sentBody.messages[0].content).toBe("keep   spaces"); // untouched
    await app.close();
  });

  it("streams OpenAI-compatible SSE and records a costed ledger row at end", async () => {
    const OAI_STREAM =
      [
        'data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500,"total_tokens":1500}}',
        "data: [DONE]",
      ].join("\n\n") + "\n\n";

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(OAI_STREAM, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    const ledger = new MemoryLedger();
    const app = buildServer({
      providers: [provider],
      chains: [{ name: "default", strategy: "ordered", providers: [{ id: "openai" }] }],
      ledger,
      pricing: DEFAULT_PRICING,
      now: () => 1_700_000_000_000,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["x-relay-provider"]).toBe("openai");

    // The SSE body carries the deltas, a final chunk with x_relay cost, and DONE.
    const body = res.payload;
    expect(body).toContain('"content":"Hel"');
    expect(body).toContain('"content":"lo"');
    expect(body).toContain("x_relay");
    expect(body).toContain("data: [DONE]");
    // Reassemble the streamed text.
    const text = [...body.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join("");
    expect(text).toBe("Hello");

    // Cost/usage was written to the ledger at end-of-stream, not before.
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({
      provider: "openai",
      totalTokens: 1500,
      outcome: "success",
    });
    expect(ledger.entries[0]!.costUsd).toBeCloseTo(0.00045, 10);

    // Redaction still holds on the streaming path.
    expect(body).not.toContain(KEY);
    expect(JSON.stringify(res.headers)).not.toContain(KEY);

    await app.close();
  });

  it("returns a normal JSON error (not SSE) when a stream fails before the first token", async () => {
    // 401 before any token → pre-commit → JSON error, headers not yet sent as SSE.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));
    const app = buildServer({
      providers: [provider],
      chains: [{ name: "default", strategy: "ordered", providers: [{ id: "openai" }] }],
      ledger: new MemoryLedger(),
      pricing: DEFAULT_PRICING,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: "hi" }] },
    });
    // Auth stops the chain: a JSON error body, not an event stream.
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("auth");
    await app.close();
  });

  it("GET /v1/usage returns recorded entries", async () => {
    const ledger = new MemoryLedger();
    ledger.record({
      ts: 1,
      provider: "openai",
      model: "gpt-4o-mini",
      chain: "default",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      costUsd: 0.001,
      latencyMs: 3,
      outcome: "success",
    });
    const app = buildServer({ providers: [provider], chains: [], ledger });

    const res = await app.inject({ method: "GET", url: "/v1/usage" });
    expect(res.statusCode).toBe(200);
    expect(res.json().recent).toHaveLength(1);

    await app.close();
  });
});
