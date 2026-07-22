import { describe, expect, it } from "vitest";
import {
  computeUsageTotals,
  mergeProviders,
  sortRecent,
} from "../api/selectors";
import { healthFixture, providersFixture, usageFixture } from "./fixtures";

describe("computeUsageTotals", () => {
  it("sums requests, tokens, and cost across providers", () => {
    const t = computeUsageTotals(usageFixture.byProvider);
    expect(t.requests).toBe(75);
    expect(t.promptTokens).toBe(23000);
    expect(t.completionTokens).toBe(11500);
    expect(t.totalTokens).toBe(34500);
    expect(t.costUsd).toBeCloseTo(0.73, 5);
  });

  it("flags unpriced requests and never fabricates their cost", () => {
    const t = computeUsageTotals(usageFixture.byProvider);
    expect(t.unknownCostRequests).toBe(10);
    expect(t.hasUnpriced).toBe(true);
    // Groq contributed 0 to the dollar total, not an invented price.
    const pricedOnly = usageFixture.byProvider
      .filter((p) => p.unknownCostRequests === 0)
      .reduce((s, p) => s + p.costUsd, 0);
    expect(t.costUsd).toBeCloseTo(pricedOnly, 5);
  });

  it("handles missing/empty input defensively", () => {
    expect(computeUsageTotals(undefined).requests).toBe(0);
    expect(computeUsageTotals([]).hasUnpriced).toBe(false);
  });
});

describe("mergeProviders", () => {
  it("joins catalog with live health by id", () => {
    const merged = mergeProviders(providersFixture.providers, healthFixture);
    const openai = merged.find((m) => m.id === "openai");
    expect(openai?.health.known).toBe(true);
    expect(openai?.health.ok).toBe(true);
    expect(openai?.health.latencyMs).toBe(142);
  });

  it("keeps providers with no health data, marked unknown", () => {
    const merged = mergeProviders(providersFixture.providers, {
      ok: true,
      keyStore: "none",
      providers: {},
    });
    expect(merged).toHaveLength(3);
    expect(merged.every((m) => !m.health.known)).toBe(true);
  });
});

describe("sortRecent", () => {
  it("returns newest first without mutating input", () => {
    const input = usageFixture.recent;
    const sorted = sortRecent(input);
    expect(sorted[0].ts).toBeGreaterThanOrEqual(sorted[1].ts);
    expect(input[0].ts).toBe(1_752_000_000_000); // original order untouched
  });

  it("tolerates undefined", () => {
    expect(sortRecent(undefined)).toEqual([]);
  });
});
