import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { TokenUsage } from "../adapters/types.js";

/**
 * Honest cost tracking: prices come from a small, EDITABLE local table, applied
 * to the token counts each provider actually reports. When a model isn't in the
 * table we return null (unknown) rather than guessing — the dashboard shows
 * "unknown", never a fabricated number.
 *
 * Prices are USD per 1,000,000 tokens, split input/output. The seed values below
 * are a starting point ONLY — providers change pricing, so verify/edit them (or
 * override via relay.pricing.json). Each provider's pricing page is linked in the
 * README.
 */

export const ModelPrice = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  /**
   * Multipliers applied to `inputPerMTok` for prompt-cached input. Providers
   * with prompt caching bill a cache WRITE above the base input rate and a
   * cache READ well below it, so a flat input rate would misstate cost in both
   * directions. Defaults match Anthropic's published economics (5-minute TTL
   * writes at 1.25x, reads at 0.1x); override per model if a provider differs.
   */
  cacheWriteMultiplier: z.number().nonnegative().default(1.25),
  cacheReadMultiplier: z.number().nonnegative().default(0.1),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

export const PricingTable = z.record(z.string(), z.record(z.string(), ModelPrice));
export type PricingTable = z.infer<typeof PricingTable>;

/**
 * Seed prices. VERIFY before trusting — these reflect published rates at authoring
 * time and are meant to be edited in relay.pricing.json.
 */
const CACHE_DEFAULTS = { cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 };

export const DEFAULT_PRICING: PricingTable = {
  openai: {
    "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6, ...CACHE_DEFAULTS },
    "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10, ...CACHE_DEFAULTS },
    "o4-mini": { inputPerMTok: 1.1, outputPerMTok: 4.4, ...CACHE_DEFAULTS },
  },
  // Published USD per 1M tokens. VERIFY before trusting — see README for the
  // pricing page link; cache multipliers follow Anthropic's documented
  // economics (5-minute-TTL write 1.25x base input, read 0.1x).
  anthropic: {
    "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25, ...CACHE_DEFAULTS },
    "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25, ...CACHE_DEFAULTS },
    "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25, ...CACHE_DEFAULTS },
    "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15, ...CACHE_DEFAULTS },
    "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15, ...CACHE_DEFAULTS },
    "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5, ...CACHE_DEFAULTS },
    "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50, ...CACHE_DEFAULTS },
  },
  // Gemini folds cached tokens into promptTokenCount and bills them cheaper;
  // the adapter splits them out, and cached input is priced at ~0.25x here
  // (Gemini also bills cache storage per hour — not modeled; edit if it matters).
  // VERIFY: Gemini pricing is context-length tiered — these are the small-context
  // rates.
  gemini: {
    "gemini-2.0-flash": {
      inputPerMTok: 0.1,
      outputPerMTok: 0.4,
      cacheWriteMultiplier: 1,
      cacheReadMultiplier: 0.25,
    },
    "gemini-1.5-flash": {
      inputPerMTok: 0.075,
      outputPerMTok: 0.3,
      cacheWriteMultiplier: 1,
      cacheReadMultiplier: 0.25,
    },
    "gemini-1.5-pro": {
      inputPerMTok: 1.25,
      outputPerMTok: 5,
      cacheWriteMultiplier: 1,
      cacheReadMultiplier: 0.25,
    },
  },
  groq: {
    "llama-3.3-70b-versatile": {
      inputPerMTok: 0.59,
      outputPerMTok: 0.79,
      ...CACHE_DEFAULTS,
    },
  },
  ollama: {
    // Local models are free to run; record zero so totals stay honest.
    "*": { inputPerMTok: 0, outputPerMTok: 0, ...CACHE_DEFAULTS },
  },
};

/** Merge a user override file over the defaults (per provider/model). */
export function loadPricing(explicitPath?: string): PricingTable {
  const path = explicitPath
    ? resolve(explicitPath)
    : process.env.RELAY_PRICING
      ? resolve(process.env.RELAY_PRICING)
      : resolve(process.cwd(), "relay.pricing.json");

  const merged: PricingTable = structuredCloneTable(DEFAULT_PRICING);
  if (!existsSync(path)) return merged;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const override = PricingTable.safeParse(parsed);
  if (!override.success) {
    throw new Error(`${path} failed validation: ${override.error.message}`);
  }
  for (const [provider, models] of Object.entries(override.data)) {
    merged[provider] = { ...(merged[provider] ?? {}), ...models };
  }
  return merged;
}

function structuredCloneTable(t: PricingTable): PricingTable {
  const out: PricingTable = {};
  for (const [p, models] of Object.entries(t)) out[p] = { ...models };
  return out;
}

/**
 * Cost in USD for a call, or null if the model has no price entry. A per-provider
 * "*" wildcard price (e.g. free local models) applies when the exact model is
 * absent.
 */
export function computeCostUsd(
  table: PricingTable,
  provider: string,
  model: string,
  usage: TokenUsage | null,
): number | null {
  if (!usage) return null;
  const price = table[provider]?.[model] ?? table[provider]?.["*"];
  if (!price) return null;

  const perMTok = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;

  // `promptTokens` is base-rate input only. Cached input is priced separately —
  // this is what keeps Anthropic's numbers honest rather than estimated.
  return (
    perMTok(usage.promptTokens, price.inputPerMTok) +
    perMTok(usage.cacheCreationInputTokens ?? 0, price.inputPerMTok * price.cacheWriteMultiplier) +
    perMTok(usage.cacheReadInputTokens ?? 0, price.inputPerMTok * price.cacheReadMultiplier) +
    perMTok(usage.completionTokens, price.outputPerMTok)
  );
}
