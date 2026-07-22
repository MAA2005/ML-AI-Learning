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
