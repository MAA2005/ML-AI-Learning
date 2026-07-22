import { AnthropicAdapter } from "./adapters/anthropic.js";
import { OpenAICompatibleAdapter } from "./adapters/openai-compatible.js";
import type { ProviderAdapter, ProviderConfig } from "./adapters/types.js";

/**
 * Builds live adapter instances from resolved provider configs, dispatching on
 * `kind`. Defaults to the OpenAI-compatible adapter so existing configs (which
 * predate the field) keep working unchanged.
 */
export function buildAdapter(cfg: ProviderConfig): ProviderAdapter {
  switch (cfg.kind) {
    case "anthropic":
      return new AnthropicAdapter(cfg);
    case "openai-compatible":
    case undefined:
      return new OpenAICompatibleAdapter(cfg);
    default: {
      // Exhaustiveness guard: a new kind must be handled here explicitly.
      const never: never = cfg.kind;
      throw new Error(`Unknown provider kind: ${String(never)}`);
    }
  }
}

export function buildRegistry(
  providers: ProviderConfig[],
): Map<string, ProviderAdapter> {
  const registry = new Map<string, ProviderAdapter>();
  for (const p of providers) {
    registry.set(p.id, buildAdapter(p));
  }
  return registry;
}
