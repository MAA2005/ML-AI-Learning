import type {
  HealthResponse,
  ProvidersResponse,
  UsageResponse,
} from "../api/types";

// The canary. A realistic-looking dummy key that must NEVER surface in any
// payload the dashboard consumes or renders.
export const FIXTURE_KEY = "sk-test-fixture-do-not-use";

export const healthFixture: HealthResponse = {
  ok: true,
  keyStore: "keychain",
  providers: {
    openai: { ok: true, latencyMs: 142 },
    anthropic: { ok: true, latencyMs: 210, detail: "warm" },
    groq: { ok: false, latencyMs: 0, detail: "connection refused" },
  },
};

export const providersFixture: ProvidersResponse = {
  providers: [
    { id: "openai", label: "OpenAI", capabilities: ["chat", "tools", "vision"] },
    { id: "anthropic", label: "Anthropic", capabilities: ["chat", "tools"] },
    { id: "groq", label: "Groq", capabilities: ["chat"] },
  ],
};

export const usageFixture: UsageResponse = {
  byProvider: [
    {
      key: "openai",
      requests: 40,
      promptTokens: 12000,
      completionTokens: 6000,
      totalTokens: 18000,
      costUsd: 0.42,
      unknownCostRequests: 0,
    },
    {
      key: "anthropic",
      requests: 25,
      promptTokens: 8000,
      completionTokens: 4000,
      totalTokens: 12000,
      costUsd: 0.31,
      unknownCostRequests: 0,
    },
    {
      key: "groq",
      requests: 10,
      promptTokens: 3000,
      completionTokens: 1500,
      totalTokens: 4500,
      costUsd: 0,
      unknownCostRequests: 10, // provider returns no pricing -> not priced
    },
  ],
  byChain: [
    {
      key: "default",
      requests: 65,
      promptTokens: 20000,
      completionTokens: 10000,
      totalTokens: 30000,
      costUsd: 0.73,
      unknownCostRequests: 0,
    },
  ],
  recent: [
    {
      ts: 1_752_000_000_000,
      provider: "openai",
      model: "gpt-4o-mini",
      chain: "default",
      promptTokens: 300,
      completionTokens: 150,
      totalTokens: 450,
      costUsd: 0.0012,
      latencyMs: 140,
      outcome: "success",
    },
    {
      ts: 1_752_000_060_000,
      provider: "groq",
      model: "llama-3.1-70b",
      chain: "default",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      costUsd: null,
      latencyMs: 5,
      outcome: "error",
    },
  ],
};
