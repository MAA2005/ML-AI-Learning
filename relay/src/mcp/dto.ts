import type { ProviderConfig } from "../adapters/types.js";
import type { Chain } from "../config/chains.js";
import type { UsageEntry, UsageSummary } from "../cost/ledger.js";
import type { BreakerState } from "../routing/breaker.js";

/**
 * Read-only Data Transfer Objects for the MCP server — the ONLY shapes any MCP
 * tool may return.
 *
 * Security model: allowlist, not blocklist. Each DTO lists exactly the fields
 * deemed safe to expose, and every serializer CONSTRUCTS its DTO field-by-field
 * from primitives — it never spreads or `delete`s from an internal object. That
 * way, if a secret-bearing field (apiKey, a key-in-URL baseUrl, headers) is ever
 * added to an internal model, it cannot leak here by default: it simply isn't
 * one of the fields we copy. The secret-canary test enforces this permanently.
 *
 * Notably absent on purpose: apiKey, baseUrl (can embed a key), request/response
 * bodies, auth headers, and anything resembling raw config or env.
 */

export type HealthState = "ok" | "fail" | "unknown";
export type CircuitState = BreakerState | "unknown";

export interface ProviderStatusDTO {
  id: string;
  label: string;
  enabled: boolean;
  health: HealthState;
  healthLatencyMs: number | null;
  circuitState: CircuitState;
  /** Configured/known model ids only — never a URL or key. */
  models: string[];
}

export interface ChainDTO {
  name: string;
  strategy: Chain["strategy"];
  /** Ordered provider *names* only. */
  providers: string[];
}

export interface UsageSummaryDTO {
  key: string; // provider id or chain name
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  unknownCostRequests: number;
}

export interface RecentAttemptDTO {
  ts: number;
  provider: string;
  chain: string;
  outcome: "success" | "error";
  latencyMs: number;
  costUsd: number | null;
}

// --- Serializers: explicit field construction, never object spread ---------

export function toProviderStatusDTO(input: {
  config: ProviderConfig;
  health: HealthState;
  healthLatencyMs: number | null;
  circuitState: CircuitState;
  models: string[];
}): ProviderStatusDTO {
  return {
    id: input.config.id,
    label: input.config.label ?? input.config.id,
    enabled: true,
    health: input.health,
    healthLatencyMs: input.healthLatencyMs,
    circuitState: input.circuitState,
    // Copy model ids as fresh strings; never pass through arbitrary objects.
    models: input.models.map((m) => String(m)),
  };
}

export function toChainDTO(chain: Chain): ChainDTO {
  return {
    name: chain.name,
    strategy: chain.strategy,
    providers: chain.providers.map((p) => p.id),
  };
}

export function toUsageSummaryDTO(s: UsageSummary): UsageSummaryDTO {
  return {
    key: s.key,
    requests: s.requests,
    promptTokens: s.promptTokens,
    completionTokens: s.completionTokens,
    totalTokens: s.totalTokens,
    costUsd: s.costUsd,
    unknownCostRequests: s.unknownCostRequests,
  };
}

export function toRecentAttemptDTO(e: UsageEntry): RecentAttemptDTO {
  return {
    ts: e.ts,
    provider: e.provider,
    chain: e.chain,
    outcome: e.outcome,
    latencyMs: e.latencyMs,
    costUsd: e.costUsd,
  };
}
