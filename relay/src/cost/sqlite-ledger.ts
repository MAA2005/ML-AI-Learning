import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  ProviderSummary,
  UsageEntry,
  UsageLedger,
  UsageSummary,
} from "./ledger.js";

/**
 * SQLite-backed usage ledger — the indexed successor to the NDJSON ledger,
 * behind the SAME `UsageLedger` interface, so nothing upstream changes.
 *
 * Why SQLite: NDJSON re-reads and re-parses the whole file for every summary,
 * which is O(n) per dashboard poll. Here the aggregates are indexed GROUP BYs.
 *
 * Honesty note carried over from the NDJSON ledger: `cost_usd` is NULLABLE and
 * NULL means "no pricing entry", NOT zero. SQL `SUM` skips NULLs, and unpriced
 * requests are counted separately — so an unpriced call never silently becomes
 * a $0 call in the totals.
 */

/** Structural type for better-sqlite3, so this module needs no value import. */
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                  INTEGER NOT NULL,
  provider            TEXT    NOT NULL,
  model               TEXT    NOT NULL,
  chain               TEXT    NOT NULL,
  prompt_tokens       INTEGER,
  completion_tokens   INTEGER,
  total_tokens        INTEGER,
  cost_usd            REAL,          -- NULL = unpriced, NOT zero
  latency_ms          INTEGER NOT NULL,
  outcome             TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_ts       ON usage(ts);
CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage(provider);
CREATE INDEX IF NOT EXISTS idx_usage_chain    ON usage(chain);
`;

/** Aggregate query, parameterized only by the grouping column (never user input). */
function aggregateSql(column: "provider" | "chain"): string {
  return `
    SELECT ${column}                                             AS key,
           COUNT(*)                                              AS requests,
           COALESCE(SUM(prompt_tokens), 0)                       AS promptTokens,
           COALESCE(SUM(completion_tokens), 0)                   AS completionTokens,
           COALESCE(SUM(total_tokens), 0)                        AS totalTokens,
           COALESCE(SUM(cost_usd), 0)                            AS costUsd,
           SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END)     AS unknownCostRequests
      FROM usage
     GROUP BY ${column}
     ORDER BY costUsd DESC`;
}

interface SummaryRow {
  key: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  unknownCostRequests: number;
}

interface EntryRow {
  ts: number;
  provider: string;
  model: string;
  chain: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number;
  outcome: string;
}

export function defaultSqlitePath(): string {
  return resolve(process.cwd(), ".relay", "usage.db");
}

export class SqliteLedger implements UsageLedger {
  readonly backend = "sqlite" as const;
  private readonly db: SqliteDb;
  private readonly insert: SqliteStatement;

  constructor(db: SqliteDb) {
    this.db = db;
    this.db.exec(SCHEMA);
    this.insert = this.db.prepare(
      `INSERT INTO usage
         (ts, provider, model, chain, prompt_tokens, completion_tokens,
          total_tokens, cost_usd, latency_ms, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  record(e: UsageEntry): void {
    this.insert.run(
      e.ts,
      e.provider,
      e.model,
      e.chain,
      e.promptTokens,
      e.completionTokens,
      e.totalTokens,
      e.costUsd, // null stays null — do NOT coalesce to 0
      e.latencyMs,
      e.outcome,
    );
  }

  /** Bulk insert in one transaction — used by the NDJSON migration. */
  recordMany(entries: UsageEntry[]): void {
    const run = this.db.transaction((rows: UsageEntry[]) => {
      for (const r of rows) this.record(r);
    });
    run(entries as never[]);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number };
    return row.n;
  }

  private aggregate(column: "provider" | "chain"): UsageSummary[] {
    return (this.db.prepare(aggregateSql(column)).all() as SummaryRow[]).map((r) => ({
      key: r.key,
      requests: r.requests,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      totalTokens: r.totalTokens,
      costUsd: r.costUsd,
      unknownCostRequests: r.unknownCostRequests,
    }));
  }

  summaryByProvider(): ProviderSummary[] {
    return this.aggregate("provider").map((s) => ({ ...s, provider: s.key }));
  }

  summaryByChain(): UsageSummary[] {
    return this.aggregate("chain");
  }

  recent(limit: number): UsageEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM usage ORDER BY id DESC LIMIT ?`)
      .all(limit) as EntryRow[];
    return rows.map((r) => ({
      ts: r.ts,
      provider: r.provider,
      model: r.model,
      chain: r.chain,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      totalTokens: r.total_tokens,
      costUsd: r.cost_usd,
      latencyMs: r.latency_ms,
      outcome: r.outcome as UsageEntry["outcome"],
    }));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Open a SQLite ledger, dynamically importing the optional native module.
 * Returns null if `better-sqlite3` isn't installed or can't load (it's a
 * native addon and needs a prebuild matching the running Node ABI).
 */
export async function tryOpenSqliteLedger(
  filePath: string = defaultSqlitePath(),
): Promise<SqliteLedger | null> {
  try {
    const mod = (await import("better-sqlite3")) as unknown as {
      default: new (path: string) => SqliteDb;
    };
    const Database = mod.default;
    mkdirSync(dirname(filePath), { recursive: true });
    return new SqliteLedger(new Database(filePath));
  } catch {
    return null;
  }
}
