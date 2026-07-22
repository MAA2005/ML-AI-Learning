import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NdjsonLedger, type UsageEntry } from "../src/cost/ledger.js";
import { openLedger } from "../src/cost/open-ledger.js";
import { SqliteLedger } from "../src/cost/sqlite-ledger.js";

/**
 * SQLite ledger + the one-way NDJSON→SQLite migration. Uses a real in-memory /
 * temp-file better-sqlite3 database — no mocks, so the SQL is exercised for real.
 */

function memLedger(): SqliteLedger {
  return new SqliteLedger(new Database(":memory:") as never);
}

function entry(over: Partial<UsageEntry>): UsageEntry {
  return {
    ts: 1000,
    provider: "openai",
    model: "gpt-4o-mini",
    chain: "default",
    promptTokens: 1000,
    completionTokens: 500,
    totalTokens: 1500,
    costUsd: 0.001,
    latencyMs: 10,
    outcome: "success",
    ...over,
  };
}

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "relay-sqlite-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  delete process.env.RELAY_LEDGER_BACKEND;
});

describe("SqliteLedger", () => {
  it("records and summarizes per provider and per chain", () => {
    const l = memLedger();
    l.record(entry({ provider: "openai", chain: "a", costUsd: 0.001 }));
    l.record(entry({ provider: "openai", chain: "b", costUsd: 0.001 }));
    l.record(entry({ provider: "anthropic", chain: "a", costUsd: 0.005 }));

    const byProvider = l.summaryByProvider();
    // Ordered by cost desc → anthropic first.
    expect(byProvider[0]).toMatchObject({ provider: "anthropic", requests: 1 });
    const openai = byProvider.find((s) => s.provider === "openai")!;
    expect(openai.requests).toBe(2);
    expect(openai.costUsd).toBeCloseTo(0.002, 10);
    expect(openai.totalTokens).toBe(3000);

    const byChain = l.summaryByChain();
    expect(byChain.find((s) => s.key === "a")!.requests).toBe(2);
    expect(byChain.find((s) => s.key === "b")!.requests).toBe(1);
  });

  it("keeps a NULL cost as NULL — an unpriced request never becomes a $0 request", () => {
    const l = memLedger();
    l.record(entry({ provider: "groq", costUsd: null }));
    l.record(entry({ provider: "groq", costUsd: 0.002 }));

    const groq = l.summaryByProvider().find((s) => s.provider === "groq")!;
    expect(groq.requests).toBe(2);
    // SUM ignores the NULL — the known cost stands alone, not diluted by a fake 0.
    expect(groq.costUsd).toBeCloseTo(0.002, 10);
    expect(groq.unknownCostRequests).toBe(1);

    // And the raw row round-trips the null, not 0.
    const recent = l.recent(10);
    expect(recent.find((e) => e.costUsd === null)).toBeDefined();
  });

  it("recent() returns newest-first", () => {
    const l = memLedger();
    l.record(entry({ ts: 1, model: "a" }));
    l.record(entry({ ts: 2, model: "b" }));
    l.record(entry({ ts: 3, model: "c" }));
    expect(l.recent(2).map((e) => e.model)).toEqual(["c", "b"]);
  });

  it("round-trips all fields including cache-null token counts", () => {
    const l = memLedger();
    l.record(entry({ promptTokens: null, completionTokens: null, totalTokens: null }));
    const [row] = l.recent(1);
    expect(row).toMatchObject({
      provider: "openai",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
  });
});

describe("openLedger migration", () => {
  it("imports an existing NDJSON ledger into SQLite exactly once, archiving the original", async () => {
    const dir = tmp();
    const ndjsonPath = join(dir, "usage.ndjson");
    const sqlitePath = join(dir, "usage.db");

    // Seed a legacy NDJSON ledger with a priced and an unpriced row.
    const legacy = new NdjsonLedger(ndjsonPath);
    legacy.record(entry({ ts: 1, provider: "openai", costUsd: 0.001 }));
    legacy.record(entry({ ts: 2, provider: "groq", costUsd: null }));

    const opened = await openLedger({ sqlitePath, ndjsonPath });
    expect(opened.ledger.backend).toBe("sqlite");
    expect(opened.migrated).toBe(2);

    // Data is queryable from SQLite, with the null cost preserved.
    const groq = opened.ledger.summaryByProvider().find((s) => s.key === "groq")!;
    expect(groq.unknownCostRequests).toBe(1);
    expect(opened.ledger.summaryByProvider().reduce((n, s) => n + s.requests, 0)).toBe(2);

    // Original NDJSON is archived, not deleted.
    expect(existsSync(ndjsonPath)).toBe(false);
    expect(existsSync(`${ndjsonPath}.migrated`)).toBe(true);
    (opened.ledger as SqliteLedger).close();

    // Re-opening must NOT re-import (table already has rows; NDJSON is gone).
    const reopened = await openLedger({ sqlitePath, ndjsonPath });
    expect(reopened.migrated).toBe(0);
    expect(reopened.ledger.summaryByProvider().reduce((n, s) => n + s.requests, 0)).toBe(2);
    (reopened.ledger as SqliteLedger).close();
  });

  it("does not migrate into a non-empty SQLite table", async () => {
    const dir = tmp();
    const ndjsonPath = join(dir, "usage.ndjson");
    const sqlitePath = join(dir, "usage.db");

    // SQLite already has a row.
    const first = await openLedger({ sqlitePath, ndjsonPath });
    first.ledger.record(entry({ provider: "existing" }));
    (first.ledger as SqliteLedger).close();

    // Now an NDJSON file appears — it must be ignored, not merged in.
    new NdjsonLedger(ndjsonPath).record(entry({ provider: "legacy" }));
    const second = await openLedger({ sqlitePath, ndjsonPath });
    expect(second.migrated).toBe(0);
    expect(existsSync(ndjsonPath)).toBe(true); // untouched
    expect(second.ledger.summaryByProvider().map((s) => s.provider)).toEqual(["existing"]);
    (second.ledger as SqliteLedger).close();
  });

  it("RELAY_LEDGER_BACKEND=ndjson forces the NDJSON backend (no migration)", async () => {
    const dir = tmp();
    const ndjsonPath = join(dir, "usage.ndjson");
    const sqlitePath = join(dir, "usage.db");
    process.env.RELAY_LEDGER_BACKEND = "ndjson";

    const opened = await openLedger({ sqlitePath, ndjsonPath });
    expect(opened.ledger.backend).toBe("ndjson");
    expect(opened.migrated).toBe(0);
    expect(existsSync(sqlitePath)).toBe(false); // never created
  });
});
