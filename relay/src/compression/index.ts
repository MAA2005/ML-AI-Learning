import type { ChatMessage } from "../adapters/types.js";
import { ProseShrinkEngine } from "./prose.js";
import type { CompressionEngine } from "./types.js";

export type { CompressionEngine, CompressionResult } from "./types.js";
export { estimateTokens } from "./tokens.js";

/** Registry of available engines, keyed by their `x-relay-compress` mode. */
const ENGINES = new Map<string, CompressionEngine>([["prose", new ProseShrinkEngine()]]);

/**
 * Resolve the engine for a header value. `undefined`/empty/`off` → no
 * compression (null). An unrecognized mode also returns null so a typo can't
 * break a request; the caller logs that it was ignored.
 */
export function getEngine(mode: string | undefined): CompressionEngine | null {
  if (!mode || mode === "off") return null;
  return ENGINES.get(mode) ?? null;
}

export function knownModes(): string[] {
  return [...ENGINES.keys()];
}

export interface CompressMessagesResult {
  messages: ChatMessage[];
  before: number;
  after: number;
}

/** Apply an engine to every message's content, summing before/after estimates. */
export function compressMessages(
  messages: ChatMessage[],
  engine: CompressionEngine,
): CompressMessagesResult {
  let before = 0;
  let after = 0;
  const out = messages.map((m) => {
    const r = engine.compress(m.content);
    before += r.before;
    after += r.after;
    return { ...m, content: r.text };
  });
  return { messages: out, before, after };
}
