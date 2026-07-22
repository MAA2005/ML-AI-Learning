import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../src/adapters/types.js";
import type { RelayConfigFile } from "../src/config/chains.js";
import { NdjsonLedger, type UsageEntry } from "../src/cost/ledger.js";
import { StandaloneContext } from "../src/mcp/context.js";
import { assertBindableHost, isLoopbackHost } from "../src/mcp/server.js";
import { MCP_TOOLS } from "../src/mcp/tools.js";
import type { SecretStore } from "../src/secrets/store.js";

/**
 * MCP security tests. Two are permanent canaries:
 *   1. secret-canary — a realistic dummy key must never appear in ANY tool's
 *      output (nested objects included). Guards the allowlist-DTO design against
 *      a future internal field leaking through.
 *   2. tool-manifest snapshot — the exact tool names + input shapes are pinned,
 *      so adding a tool or field shows up in review instead of shipping silently.
 */

const FIXTURE_KEY = "sk-test-fixture-do-not-use";

// A realistic provider config: key in apiKey AND embedded in the base URL, to
// prove neither path leaks through the DTOs.
const providerWithKey: ProviderConfig = {
  id: "openai",
  label: "OpenAI",
  baseUrl: `https://user:${FIXTURE_KEY}@api.openai.com/v1`,
  apiKey: FIXTURE_KEY,
  defaultModel: "gpt-4o-mini",
};

function configFile(): RelayConfigFile {
  return {
    providers: [
      {
        id: "openai",
        label: "OpenAI",
        baseUrl: providerWithKey.baseUrl,
        defaultModel: "gpt-4o-mini",
      },
    ],
    chains: [
      { name: "default", strategy: "ordered", providers: [{ id: "openai" }] },
    ],
  };
}

function tmpLedgerWithKey(): NdjsonLedger {
  const dir = mkdtempSync(join(tmpdir(), "relay-mcp-"));
  const l = new NdjsonLedger(join(dir, "usage.ndjson"));
  const entry: UsageEntry = {
    ts: 1,
    provider: "openai",
    model: "gpt-4o-mini",
    chain: "default",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costUsd: 0.001,
    latencyMs: 12,
    outcome: "success",
  };
  l.record(entry);
  return l;
}

// A store that hands back the fixture key, so it flows into the resolved
// ProviderConfig.apiKey — the DTO must still not leak it.
const fakeStore: SecretStore = {
  backend: "encrypted-file",
  async get(id) {
    return id === "openai" ? FIXTURE_KEY : undefined;
  },
  async set() {},
  async delete() {},
  async list() {
    return ["openai"];
  },
};

function makeContext(): StandaloneContext {
  const dir = mkdtempSync(join(tmpdir(), "relay-mcp-bs-"));
  return new StandaloneContext({
    configFile: configFile(),
    store: fakeStore,
    ledger: tmpLedgerWithKey(),
    breakerStatePath: join(dir, "breakers.json"),
    // Health probe stub — its result must also be free of the key.
    probeHealth: async () => ({ ok: true, latencyMs: 5 }),
  });
}

describe("MCP secret canary", () => {
  it("never emits the fixture key in any tool output (probe on and off)", async () => {
    const ctx = makeContext();
    for (const probe of [false, true]) {
      for (const tool of MCP_TOOLS) {
        // Use each tool's own defaults; force probe where the tool accepts it.
        const args = tool.inputSchema.parse(
          tool.name === "list_providers" ? { probe } : {},
        );
        const out = await tool.handler(args as never, ctx);
        const serialized = JSON.stringify(out);
        expect(serialized, `${tool.name} leaked the key`).not.toContain(FIXTURE_KEY);
        // Also assert no base-URL / auth-ish fields rode along.
        expect(serialized).not.toContain("baseUrl");
        expect(serialized).not.toContain("apiKey");
        expect(serialized).not.toContain("authorization");
      }
    }
  });

  it("still exposes the useful (non-secret) status fields", async () => {
    const ctx = makeContext();
    const providers = (await MCP_TOOLS[0]!.handler({ probe: true } as never, ctx)) as {
      providers: Array<Record<string, unknown>>;
    };
    expect(providers.providers[0]).toMatchObject({
      id: "openai",
      label: "OpenAI",
      enabled: true,
      health: "ok",
      circuitState: "unknown", // no persisted breaker state in this test
      models: ["gpt-4o-mini"],
    });
  });
});

describe("MCP tool manifest", () => {
  it("matches the pinned read-only surface", () => {
    const manifest = MCP_TOOLS.map((t) => ({
      name: t.name,
      inputKeys: Object.keys((t.inputSchema as unknown as { shape: object }).shape).sort(),
    }));
    // Pinning the surface: any added/removed tool or input field breaks this.
    expect(manifest).toEqual([
      { name: "list_providers", inputKeys: ["probe"] },
      { name: "list_chains", inputKeys: [] },
      { name: "get_usage", inputKeys: [] },
      { name: "get_recent_attempts", inputKeys: ["limit"] },
    ]);
  });

  it("exposes no write/config/query tools", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    for (const forbidden of [
      "add_provider",
      "remove_provider",
      "get_config",
      "set_config",
      "query",
      "exec",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe("MCP HTTP bind safety", () => {
  it("allows loopback hosts without any flag", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      expect(isLoopbackHost(host)).toBe(true);
      expect(() => assertBindableHost(host, false)).not.toThrow();
    }
  });

  it("refuses non-loopback (incl. 0.0.0.0) unless allowExternal is set", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com"]) {
      expect(() => assertBindableHost(host, false)).toThrow(/allow-external/);
      expect(() => assertBindableHost(host, true)).not.toThrow(); // explicit opt-in
    }
  });
});

describe("MCP tool behavior", () => {
  it("get_usage returns per-provider and per-chain summaries", async () => {
    const ctx = makeContext();
    const usage = (await MCP_TOOLS[2]!.handler({} as never, ctx)) as {
      byProvider: Array<{ key: string; totalTokens: number }>;
      byChain: Array<{ key: string; totalTokens: number }>;
    };
    expect(usage.byProvider[0]).toMatchObject({ key: "openai", totalTokens: 150 });
    expect(usage.byChain[0]).toMatchObject({ key: "default", totalTokens: 150 });
  });

  it("get_recent_attempts returns redacted request rows", async () => {
    const ctx = makeContext();
    const res = (await MCP_TOOLS[3]!.handler({ limit: 10 } as never, ctx)) as {
      attempts: Array<Record<string, unknown>>;
    };
    expect(res.attempts[0]).toMatchObject({
      provider: "openai",
      chain: "default",
      outcome: "success",
      latencyMs: 12,
    });
    // No token/body/header fields beyond the allowlisted ones.
    expect(Object.keys(res.attempts[0]!).sort()).toEqual([
      "chain",
      "costUsd",
      "latencyMs",
      "outcome",
      "provider",
      "ts",
    ]);
  });
});
