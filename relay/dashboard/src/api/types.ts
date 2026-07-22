// Typed mirror of the STABLE Relay gateway REST contract.
// These shapes are the single source of truth for the dashboard's data layer.
// Note: none of these shapes contain an API key field. No endpoint the
// dashboard calls returns key material, so the dashboard never reads or
// renders one. See src/test/canary.test.ts for the enforcing guarantee.

export type KeyStore = "keychain" | "encrypted-file" | "none";

/** GET /health */
export interface HealthResponse {
  ok: boolean;
  keyStore: KeyStore;
  providers: Record<string, ProviderHealth>;
}

export interface ProviderHealth {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

/** GET /v1/providers */
export interface ProvidersResponse {
  providers: ProviderInfo[];
}

export interface ProviderInfo {
  id: string;
  label: string;
  capabilities: string[];
}

/** GET /v1/usage */
export interface UsageResponse {
  byProvider: Summary[];
  // byChain may be absent in the current build; always treat as optional.
  byChain?: Summary[];
  recent: UsageEntry[];
}

export interface Summary {
  key: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  unknownCostRequests: number;
}

export type Outcome = "success" | "error";

export interface UsageEntry {
  ts: number; // epoch ms
  provider: string;
  model: string;
  chain: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  latencyMs: number;
  outcome: Outcome;
}
