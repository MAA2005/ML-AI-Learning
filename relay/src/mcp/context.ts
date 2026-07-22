import { OpenAICompatibleAdapter } from "../adapters/openai-compatible.js";
import type { ProviderConfig } from "../adapters/types.js";
import type { RelayConfigFile } from "../config/chains.js";
import { resolveProviders } from "../config/providers.js";
import type { UsageLedger } from "../cost/ledger.js";
import { readBreakerStates } from "../routing/breaker-state.js";
import type { SecretStore } from "../secrets/store.js";
import {
  toChainDTO,
  toProviderStatusDTO,
  toRecentAttemptDTO,
  toUsageSummaryDTO,
  type ChainDTO,
  type CircuitState,
  type HealthState,
  type ProviderStatusDTO,
  type RecentAttemptDTO,
  type UsageSummaryDTO,
} from "./dto.js";

/**
 * Supplies the read-only data the MCP tools return, always as allowlisted DTOs.
 * The tools never touch internal config/ledger objects directly — they go
 * through here, and everything that leaves is built by a serializer in dto.ts.
 */
export interface McpContext {
  listProviderStatus(probe: boolean): Promise<ProviderStatusDTO[]>;
  listChains(): ChainDTO[];
  getUsage(): { byProvider: UsageSummaryDTO[]; byChain: UsageSummaryDTO[] };
  getRecentAttempts(limit: number): RecentAttemptDTO[];
}

export interface StandaloneContextOptions {
  configFile: RelayConfigFile;
  store: SecretStore | null;
  ledger: UsageLedger;
  breakerStatePath: string;
  /** Injectable for tests; defaults to a live adapter probe. */
  probeHealth?: (cfg: ProviderConfig) => Promise<{ ok: boolean; latencyMs: number }>;
}

/**
 * The default context for the stdio MCP server. It reads what a separate process
 * can truthfully know: provider/chain config, the usage ledger, the persisted
 * breaker state, and (only when asked) a live health probe. It never reports a
 * fabricated value — unknown is unknown.
 */
export class StandaloneContext implements McpContext {
  constructor(private readonly opts: StandaloneContextOptions) {}

  async listProviderStatus(probe: boolean): Promise<ProviderStatusDTO[]> {
    const providers = await resolveProviders({
      configFile: this.opts.configFile,
      store: this.opts.store,
    });
    const breakerStates = readBreakerStates(this.opts.breakerStatePath);

    const out: ProviderStatusDTO[] = [];
    for (const cfg of providers) {
      let health: HealthState = "unknown";
      let healthLatencyMs: number | null = null;
      if (probe) {
        const probeFn =
          this.opts.probeHealth ??
          (async (c: ProviderConfig) => {
            const h = await new OpenAICompatibleAdapter(c).health();
            return { ok: h.ok, latencyMs: h.latencyMs };
          });
        const r = await probeFn(cfg);
        health = r.ok ? "ok" : "fail";
        healthLatencyMs = r.latencyMs;
      }
      const circuitState: CircuitState = breakerStates[cfg.id]?.state ?? "unknown";
      out.push(
        toProviderStatusDTO({
          config: cfg,
          health,
          healthLatencyMs,
          circuitState,
          models: cfg.defaultModel ? [cfg.defaultModel] : [],
        }),
      );
    }
    return out;
  }

  listChains(): ChainDTO[] {
    return this.opts.configFile.chains.map(toChainDTO);
  }

  getUsage(): { byProvider: UsageSummaryDTO[]; byChain: UsageSummaryDTO[] } {
    return {
      byProvider: this.opts.ledger.summaryByProvider().map(toUsageSummaryDTO),
      byChain: this.opts.ledger.summaryByChain().map(toUsageSummaryDTO),
    };
  }

  getRecentAttempts(limit: number): RecentAttemptDTO[] {
    return this.opts.ledger.recent(limit).map(toRecentAttemptDTO);
  }
}
