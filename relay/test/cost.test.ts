import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NdjsonLedger, type UsageEntry } from "../src/cost/ledger.js";
import { computeCostUsd, DEFAULT_PRICING, loadPricing } from "../src/cost/pricing.js";

function tmpLedger(): NdjsonLedger {
  const dir = mkdtempSync(join(tmpdir(), "relay-usage-"));
  return new NdjsonLedger(join(dir, "usage.ndjson"));
}

function entry(over: Partial<UsageEntry>): UsageEntry {
  return {
    ts: 1000,
    provider: "openai",
    model: "gpt-4o-mini",
    chain: "default",
    promptTokens: 1000,
    completionTokens: 500,
    totalTokens: 1500,
    costUsd: 0,
    latencyMs: 10,
    outcome: "success",
    ...over,
  };
}

describe("computeCostUsd", () => {
  it("prices a known model from input/output rates", () => {
    // 1000 in @ 0.15/Mtok + 500 out @ 0.60/Mtok = 0.00015 + 0.0003 = 0.00045
    const cost = computeCostUsd(DEFAULT_PRICING, "openai", "gpt-4o-mini", {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
    });
    expect(cost).toBeCloseTo(0.00045, 10);
  });

  it("returns null for an unknown model rather than guessing", () => {
    expect(
      computeCostUsd(DEFAULT_PRICING, "openai", "mystery-model", {
        promptTokens: 10,
        completionTokens: 10,
        totalTokens: 20,
      }),
    ).toBeNull();
  });

  it("applies a per-provider '*' wildcard (free local models → 0)", () => {
    expect(
      computeCostUsd(DEFAULT_PRICING, "ollama", "llama3:8b", {
        promptTokens: 999,
        completionTokens: 999,
        totalTokens: 1998,
      }),
    ).toBe(0);
  });

  it("returns null when usage is missing", () => {
    expect(computeCostUsd(DEFAULT_PRICING, "openai", "gpt-4o-mini", null)).toBeNull();
  });

  it("prices Anthropic cached input at its own rates, not the base input rate", () => {
    // claude-opus-4-8: $5/Mtok in, $25/Mtok out.
    // Cache write bills at 1.25x input ($6.25), cache read at 0.1x ($0.50).
    //   1000 base in   → 1000/1e6 * 5.00   = 0.00500
    //    200 cache wr  →  200/1e6 * 6.25   = 0.00125
    //    300 cache rd  →  300/1e6 * 0.50   = 0.00015
    //    500 out       →  500/1e6 * 25.00  = 0.01250
    //                                  total = 0.01890
    const cost = computeCostUsd(DEFAULT_PRICING, "anthropic", "claude-opus-4-8", {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 2000,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 300,
    });
    expect(cost).toBeCloseTo(0.0189, 10);
  });

  it("does not overcharge cached input as if it were base input", () => {
    // The naive (wrong) result would treat all 1500 input tokens at $5/Mtok
    // plus output: 1500/1e6*5 + 500/1e6*25 = 0.0200. Ours must be cheaper,
    // because reads are 0.1x — that gap is the whole point of splitting them.
    const cost = computeCostUsd(DEFAULT_PRICING, "anthropic", "claude-opus-4-8", {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 2000,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 300,
    })!;
    expect(cost).toBeLessThan(0.02);
  });

  it("is unchanged for providers that report no cache split", () => {
    // 1000 in @0.15 + 500 out @0.60 = 0.00015 + 0.0003 = 0.00045
    const cost = computeCostUsd(DEFAULT_PRICING, "openai", "gpt-4o-mini", {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
    expect(cost).toBeCloseTo(0.00045, 10);
  });
});

describe("loadPricing", () => {
  it("returns the seed table when no override file exists", () => {
    const t = loadPricing(join(tmpdir(), "does-not-exist-relay.pricing.json"));
    expect(t.openai?.["gpt-4o-mini"]).toBeDefined();
  });
});

describe("NdjsonLedger", () => {
  it("records and summarizes per provider, tracking unknown-cost requests", () => {
    const l = tmpLedger();
    l.record(entry({ provider: "openai", costUsd: 0.0005 }));
    l.record(entry({ provider: "openai", costUsd: 0.0005 }));
    l.record(entry({ provider: "groq", costUsd: null })); // unpriced

    const summary = l.summaryByProvider();
    const openai = summary.find((s) => s.provider === "openai")!;
    const groq = summary.find((s) => s.provider === "groq")!;

    expect(openai.requests).toBe(2);
    expect(openai.costUsd).toBeCloseTo(0.001, 10);
    expect(openai.totalTokens).toBe(3000);
    expect(openai.unknownCostRequests).toBe(0);

    expect(groq.requests).toBe(1);
    expect(groq.costUsd).toBe(0); // unknown cost excluded from the sum
    expect(groq.unknownCostRequests).toBe(1);
  });

  it("recent() returns the newest entries first", () => {
    const l = tmpLedger();
    l.record(entry({ ts: 1, model: "a" }));
    l.record(entry({ ts: 2, model: "b" }));
    l.record(entry({ ts: 3, model: "c" }));
    expect(l.recent(2).map((e) => e.model)).toEqual(["c", "b"]);
  });
});
