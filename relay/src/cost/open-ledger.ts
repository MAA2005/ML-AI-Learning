import { existsSync, renameSync } from "node:fs";
import { NdjsonLedger, defaultLedgerPath, type UsageLedger } from "./ledger.js";
import { SqliteLedger, defaultSqlitePath, tryOpenSqliteLedger } from "./sqlite-ledger.js";

/**
 * Chooses the usage-ledger backend and performs the one-way NDJSON → SQLite
 * migration on first open.
 *
 * Order: SQLite (indexed, the intended home) → NDJSON fallback when the native
 * module can't load. `RELAY_LEDGER_BACKEND=ndjson` forces the fallback.
 *
 * The migration is deliberately conservative:
 *   - it runs ONLY when the SQLite table is empty and an NDJSON file exists,
 *     so it can't double-import;
 *   - it copies rows in one transaction, preserving null costs as null;
 *   - it does NOT delete the NDJSON file — it renames it to `.migrated` so the
 *     original data is still on disk if anything looks wrong afterwards.
 */

export interface OpenLedgerOptions {
  sqlitePath?: string;
  ndjsonPath?: string;
  /** Override backend selection; defaults to env RELAY_LEDGER_BACKEND. */
  backend?: "sqlite" | "ndjson";
  /** Called with a human-readable note about backend choice / migration. */
  onInfo?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface OpenedLedger {
  ledger: UsageLedger;
  /** How many rows were imported from NDJSON on this open (0 if none). */
  migrated: number;
}

export async function openLedger(opts: OpenLedgerOptions = {}): Promise<OpenedLedger> {
  const sqlitePath = opts.sqlitePath ?? defaultSqlitePath();
  const ndjsonPath = opts.ndjsonPath ?? defaultLedgerPath();
  const requested = opts.backend ?? (process.env.RELAY_LEDGER_BACKEND as
    | "sqlite"
    | "ndjson"
    | undefined);
  const info = opts.onInfo ?? (() => {});

  if (requested === "ndjson") {
    info("usage ledger: ndjson (forced by RELAY_LEDGER_BACKEND)");
    return { ledger: new NdjsonLedger(ndjsonPath), migrated: 0 };
  }

  const sqlite = await tryOpenSqliteLedger(sqlitePath);
  if (!sqlite) {
    info(
      "usage ledger: ndjson (better-sqlite3 unavailable — install it for indexed queries)",
    );
    return { ledger: new NdjsonLedger(ndjsonPath), migrated: 0 };
  }

  const migrated = migrateNdjsonIfNeeded(sqlite, ndjsonPath, info);
  info("usage ledger: sqlite", { path: sqlitePath, migrated });
  return { ledger: sqlite, migrated };
}

function migrateNdjsonIfNeeded(
  sqlite: SqliteLedger,
  ndjsonPath: string,
  info: (message: string, detail?: Record<string, unknown>) => void,
): number {
  // Only migrate into a fresh table, so re-opening can't duplicate rows.
  if (sqlite.count() > 0) return 0;
  if (!existsSync(ndjsonPath)) return 0;

  const legacy = new NdjsonLedger(ndjsonPath);
  // Large limit: we want the whole file, not a recent window.
  const rows = legacy.recent(Number.MAX_SAFE_INTEGER).reverse(); // oldest-first
  if (rows.length === 0) return 0;

  sqlite.recordMany(rows);

  // Keep the original data on disk rather than deleting it.
  const archived = `${ndjsonPath}.migrated`;
  try {
    renameSync(ndjsonPath, archived);
    info("migrated NDJSON usage ledger into SQLite", {
      rows: rows.length,
      archived,
    });
  } catch {
    info("migrated NDJSON usage ledger into SQLite (original left in place)", {
      rows: rows.length,
    });
  }
  return rows.length;
}
