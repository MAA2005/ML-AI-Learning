import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

/**
 * The usage/cost ledger. Records one row per gateway request so the dashboard
 * can show tokens and $ spent per provider over time — the transparency this
 * whole project is about.
 *
 * v0 storage is append-only NDJSON (`.relay/usage.ndjson`): simple, local, and
 * trivially inspectable. A SQLite-backed `UsageLedger` drops in behind this same
 * interface when the dashboard needs indexed/time-range queries — the wiring
 * doesn't change.
 */

export const UsageEntry = z.object({
  ts: z.number(), // epoch ms
  provider: z.string(),
  model: z.string(),
  chain: z.string(),
  promptTokens: z.number().nullable(),
  completionTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  costUsd: z.number().nullable(), // null = no pricing entry (unknown, not free)
  latencyMs: z.number(),
  outcome: z.enum(["success", "error"]),
});
export type UsageEntry = z.infer<typeof UsageEntry>;

export interface UsageSummary {
  /** The grouping key's value (a provider id or a chain name). */
  key: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number; // sum of KNOWN costs
  unknownCostRequests: number; // requests whose cost couldn't be priced
}

/** @deprecated shape alias kept for existing callers; `key` is the provider. */
export interface ProviderSummary extends UsageSummary {
  provider: string;
}

export interface UsageLedger {
  readonly backend: "ndjson" | "sqlite";
  record(entry: UsageEntry): void;
  summaryByProvider(): ProviderSummary[];
  summaryByChain(): UsageSummary[];
  recent(limit: number): UsageEntry[];
}

export function defaultLedgerPath(): string {
  return resolve(process.cwd(), ".relay", "usage.ndjson");
}

export class NdjsonLedger implements UsageLedger {
  readonly backend = "ndjson" as const;

  constructor(private readonly filePath: string = defaultLedgerPath()) {}

  record(entry: UsageEntry): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf8");
  }

  private readAll(): UsageEntry[] {
    if (!existsSync(this.filePath)) return [];
    const out: UsageEntry[] = [];
    for (const line of readFileSync(this.filePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const parsed = UsageEntry.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data); // skip malformed lines silently
    }
    return out;
  }

  private aggregate(keyOf: (e: UsageEntry) => string): UsageSummary[] {
    const map = new Map<string, UsageSummary>();
    for (const e of this.readAll()) {
      const key = keyOf(e);
      let s = map.get(key);
      if (!s) {
        s = {
          key,
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          unknownCostRequests: 0,
        };
        map.set(key, s);
      }
      s.requests += 1;
      s.promptTokens += e.promptTokens ?? 0;
      s.completionTokens += e.completionTokens ?? 0;
      s.totalTokens += e.totalTokens ?? 0;
      if (e.costUsd === null) s.unknownCostRequests += 1;
      else s.costUsd += e.costUsd;
    }
    return [...map.values()].sort((a, b) => b.costUsd - a.costUsd);
  }

  summaryByProvider(): ProviderSummary[] {
    return this.aggregate((e) => e.provider).map((s) => ({ ...s, provider: s.key }));
  }

  summaryByChain(): UsageSummary[] {
    return this.aggregate((e) => e.chain);
  }

  recent(limit: number): UsageEntry[] {
    const all = this.readAll();
    return all.slice(Math.max(0, all.length - limit)).reverse();
  }
}
