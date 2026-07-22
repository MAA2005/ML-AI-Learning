import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { BreakerState } from "./breaker.js";

/**
 * The circuit breaker lives in the running gateway's memory. A separate process
 * (e.g. the stdio MCP server) can't see it, so the gateway persists the latest
 * per-provider state to a small file that read-only consumers can inspect. This
 * is status only — no secrets, just a state name + reason + timestamp.
 */

export const BreakerSnapshot = z.object({
  state: z.enum(["closed", "open", "half-open"]),
  reason: z.string(),
  ts: z.number(),
});
export type BreakerSnapshot = z.infer<typeof BreakerSnapshot>;

export const BreakerStateFile = z.record(z.string(), BreakerSnapshot);
export type BreakerStateFile = z.infer<typeof BreakerStateFile>;

export function defaultBreakerStatePath(): string {
  return resolve(process.cwd(), ".relay", "breakers.json");
}

export function readBreakerStates(path: string): BreakerStateFile {
  if (!existsSync(path)) return {};
  try {
    const parsed = BreakerStateFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writeBreakerState(
  path: string,
  provider: string,
  state: BreakerState,
  reason: string,
  ts: number,
): void {
  const current = readBreakerStates(path);
  current[provider] = { state, reason, ts };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(current, null, 2) + "\n", "utf8");
}
