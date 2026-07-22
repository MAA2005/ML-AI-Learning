import { z } from "zod";
import type { ProviderConfig, ProviderKind } from "../adapters/types.js";
import type { SecretStore } from "../secrets/store.js";
import type { ProviderDef, RelayConfigFile } from "./chains.js";

/**
 * Provider resolution. Two kinds of input are kept strictly separate:
 *
 *   - Definitions (id, baseUrl, defaultModel) — NON-secret. Come from the config
 *     file's `providers[]`, plus a few env conveniences for local dev.
 *   - Keys — secret. Resolved per provider from the SecretStore first, then an
 *     env fallback. Never read from the config file.
 *
 * A provider is only enabled if it has a key, or its endpoint is loopback
 * (keyless local models like Ollama / a local vLLM).
 */

export const EnvSchema = z.object({
  RELAY_HOST: z.string().default("127.0.0.1"),
  RELAY_PORT: z.coerce.number().int().positive().default(8787),

  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_COMPAT_BASE_URL: z.string().url().optional(),
  OPENAI_COMPAT_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().url().optional(),
});
export type Env = z.infer<typeof EnvSchema>;

export interface ServerSettings {
  host: string;
  port: number;
}

export function loadServerSettings(rawEnv: NodeJS.ProcessEnv = process.env): ServerSettings {
  const env = EnvSchema.parse(rawEnv);
  return { host: env.RELAY_HOST, port: env.RELAY_PORT };
}

/**
 * Public, documented base URLs for well-known providers, so `relay add-provider
 * openai` needs no --base-url. These are configuration, not credentials.
 */
export const KNOWN_PROVIDERS: Record<
  string,
  { label: string; baseUrl: string; defaultModel?: string; kind?: ProviderKind }
> = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-opus-4-8",
    kind: "anthropic",
  },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  mistral: { label: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  together: { label: "Together", baseUrl: "https://api.together.xyz/v1" },
};

function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

/** Generic env fallback for a provider key: RELAY_KEY_<UPPER_SNAKE_ID>. */
function genericEnvKey(id: string, env: NodeJS.ProcessEnv): string | undefined {
  const name = `RELAY_KEY_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  return env[name] || undefined;
}

/** Provider-specific env fallbacks (back-compat with .env.example). */
function envKeyFor(id: string, env: NodeJS.ProcessEnv): string | undefined {
  const specific =
    id === "openai"
      ? env.OPENAI_API_KEY
      : id === "anthropic"
        ? env.ANTHROPIC_API_KEY
        : id === "openai-compat"
          ? env.OPENAI_COMPAT_API_KEY
          : undefined;
  return specific || genericEnvKey(id, env);
}

/** Definitions implied by env vars, for local dev without a config file. */
function envDefinitions(env: NodeJS.ProcessEnv): ProviderDef[] {
  const defs: ProviderDef[] = [];
  if (env.OPENAI_API_KEY) {
    defs.push({ id: "openai", ...KNOWN_PROVIDERS.openai! });
  }
  if (env.ANTHROPIC_API_KEY) {
    defs.push({ id: "anthropic", ...KNOWN_PROVIDERS.anthropic! });
  }
  if (env.OPENAI_COMPAT_BASE_URL) {
    defs.push({
      id: "openai-compat",
      label: "OpenAI-compatible",
      baseUrl: env.OPENAI_COMPAT_BASE_URL,
    });
  }
  if (env.OLLAMA_BASE_URL) {
    defs.push({ id: "ollama", label: "Ollama (local)", baseUrl: env.OLLAMA_BASE_URL });
  }
  return defs;
}

export interface ResolveOptions {
  configFile: RelayConfigFile;
  store: SecretStore | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * Merge config-file + env provider definitions, attach each key from the store
 * (or env fallback), and keep only providers that are actually usable.
 */
export async function resolveProviders(opts: ResolveOptions): Promise<ProviderConfig[]> {
  const env = opts.env ?? process.env;

  // Config-file definitions win over env-derived ones on id collision.
  const defs = new Map<string, ProviderDef>();
  for (const d of envDefinitions(env)) defs.set(d.id, d);
  for (const d of opts.configFile.providers) defs.set(d.id, d);

  const resolved: ProviderConfig[] = [];
  for (const def of defs.values()) {
    const key = (await opts.store?.get(def.id)) ?? envKeyFor(def.id, env);
    // Enabled if we have a key, or the endpoint is local + keyless.
    if (!key && !isLoopback(def.baseUrl)) continue;
    resolved.push({
      id: def.id,
      label: def.label ?? def.id,
      kind: def.kind,
      baseUrl: def.baseUrl,
      apiKey: key,
      defaultModel: def.defaultModel,
    });
  }
  return resolved;
}
