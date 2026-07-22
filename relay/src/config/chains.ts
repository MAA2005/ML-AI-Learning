import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Routing config lives in a dedicated, git-ignored file — `relay.config.json`
 * (or `.jsonc` for inline comments) — NOT in an env blob. Chain topology (names,
 * strategy, provider order, weights) is fiddly to edit and worth diffing, so it
 * gets a real file. Provider *credentials* stay in env/keychain.
 *
 * Migration path: when the dashboard needs to mutate chains at runtime, this
 * file seeds the SQLite store once and the DB takes over — a one-way migration,
 * not a rewrite, because the Router already consumes this shape.
 */

export const ChainStrategy = z.enum(["ordered", "round-robin", "weighted"]);
export type ChainStrategy = z.infer<typeof ChainStrategy>;

export const ChainProvider = z.object({
  id: z.string().min(1),
  weight: z.number().positive().optional(),
});
export type ChainProvider = z.infer<typeof ChainProvider>;

export const Chain = z.object({
  name: z.string().min(1),
  strategy: ChainStrategy.default("ordered"),
  providers: z.array(ChainProvider).min(1),
});
export type Chain = z.infer<typeof Chain>;

/**
 * Non-secret provider definition. Base URLs and default models are public
 * configuration, NOT credentials — the API key lives only in the secret store
 * (keychain / encrypted file), never here.
 */
export const ProviderDef = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  /** Adapter implementation; omitted means "openai-compatible". */
  kind: z.enum(["openai-compatible", "anthropic", "gemini"]).optional(),
  baseUrl: z.string().url(),
  defaultModel: z.string().optional(),
});
export type ProviderDef = z.infer<typeof ProviderDef>;

export const RelayConfigFile = z.object({
  providers: z.array(ProviderDef).default([]),
  chains: z.array(Chain).default([]),
});
export type RelayConfigFile = z.infer<typeof RelayConfigFile>;

/**
 * Strip `//` and `/* *​/` comments from JSONC while respecting string literals
 * and escapes, so a commented config file parses as plain JSON.
 */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    const next = i + 1 < input.length ? input[i + 1]! : "";
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next;
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** Candidate config paths, in priority order. */
function candidatePaths(explicit?: string): string[] {
  if (explicit) return [resolve(explicit)];
  const cwd = process.cwd();
  return [
    process.env.RELAY_CONFIG ? resolve(process.env.RELAY_CONFIG) : "",
    resolve(cwd, "relay.config.json"),
    resolve(cwd, "relay.config.jsonc"),
  ].filter(Boolean);
}

/**
 * Load and validate the routing config file. A missing file is fine — routing
 * falls back to an implicit ordered chain over whatever providers are configured.
 */
export function loadRelayConfig(explicitPath?: string): RelayConfigFile {
  for (const path of candidatePaths(explicitPath)) {
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      throw new Error(
        `Could not read config ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(text));
    } catch (err) {
      throw new Error(
        `${path} is not valid JSON/JSONC: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const result = RelayConfigFile.safeParse(parsed);
    if (!result.success) {
      throw new Error(`${path} failed validation: ${result.error.message}`);
    }
    return result.data;
  }
  return { providers: [], chains: [] };
}

/** Convenience: just the chains. */
export function loadChains(explicitPath?: string): Chain[] {
  return loadRelayConfig(explicitPath).chains;
}

/** The single concrete path the CLI writes config to. */
export function writableConfigPath(explicitPath?: string): string {
  if (explicitPath) return resolve(explicitPath);
  if (process.env.RELAY_CONFIG) return resolve(process.env.RELAY_CONFIG);
  return resolve(process.cwd(), "relay.config.json");
}

/**
 * Insert or replace a provider *definition* (non-secret) in the config file,
 * preserving existing chains and other providers. Written as plain JSON — if the
 * file used JSONC comments, they are normalized away on write (chains are meant
 * to be hand-edited; provider defs are CLI-managed).
 */
export function upsertProviderDefinition(
  def: ProviderDef,
  explicitPath?: string,
): string {
  const path = writableConfigPath(explicitPath);
  const current: RelayConfigFile = existsSync(path)
    ? loadRelayConfig(path)
    : { providers: [], chains: [] };
  const providers = [...current.providers];
  const idx = providers.findIndex((p) => p.id === def.id);
  if (idx >= 0) providers[idx] = def;
  else providers.push(def);
  const next: RelayConfigFile = { providers, chains: current.chains };
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8" });
  return path;
}

/** Remove a provider definition by id. Returns true if one was removed. */
export function removeProviderDefinition(id: string, explicitPath?: string): boolean {
  const path = writableConfigPath(explicitPath);
  if (!existsSync(path)) return false;
  const current = loadRelayConfig(path);
  const providers = current.providers.filter((p) => p.id !== id);
  if (providers.length === current.providers.length) return false;
  writeFileSync(
    path,
    JSON.stringify({ providers, chains: current.chains }, null, 2) + "\n",
    { encoding: "utf8" },
  );
  return true;
}
