import type {
  HealthResponse,
  ProviderInfo,
  Summary,
  UsageEntry,
} from "./types";

// Pure, testable data-layer transforms. No rendering, no I/O.

export interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /** How many requests across all providers had no known price. */
  unknownCostRequests: number;
  /** True if any provider reported requests we could not price. */
  hasUnpriced: boolean;
}

export function computeUsageTotals(byProvider: Summary[] | undefined): UsageTotals {
  const rows = byProvider ?? [];
  const totals = rows.reduce<UsageTotals>(
    (acc, row) => {
      acc.requests += row.requests;
      acc.promptTokens += row.promptTokens;
      acc.completionTokens += row.completionTokens;
      acc.totalTokens += row.totalTokens;
      acc.costUsd += row.costUsd;
      acc.unknownCostRequests += row.unknownCostRequests;
      return acc;
    },
    {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      unknownCostRequests: 0,
      hasUnpriced: false,
    }
  );
  totals.hasUnpriced = totals.unknownCostRequests > 0;
  return totals;
}

export interface MergedProvider {
  id: string;
  label: string;
  capabilities: string[];
  health: {
    known: boolean;
    ok: boolean;
    latencyMs: number | null;
    detail?: string;
  };
}

/**
 * Join the provider catalog (/v1/providers) with live health (/health).
 * A provider present in the catalog but missing from health is marked
 * `known: false` rather than being dropped.
 */
export function mergeProviders(
  providers: ProviderInfo[] | undefined,
  health: HealthResponse | undefined
): MergedProvider[] {
  const catalog = providers ?? [];
  const healthMap = health?.providers ?? {};
  return catalog.map((p) => {
    const h = healthMap[p.id];
    return {
      id: p.id,
      label: p.label,
      capabilities: p.capabilities ?? [],
      health: h
        ? { known: true, ok: h.ok, latencyMs: h.latencyMs, detail: h.detail }
        : { known: false, ok: false, latencyMs: null },
    };
  });
}

/** Reverse-chronological copy of the recent feed (newest first). */
export function sortRecent(recent: UsageEntry[] | undefined): UsageEntry[] {
  return [...(recent ?? [])].sort((a, b) => b.ts - a.ts);
}
