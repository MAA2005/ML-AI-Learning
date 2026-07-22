/**
 * Prompt-compression middleware — opt-in text processing that trims verbose
 * prompt/tool-output text before it's sent upstream, to save tokens. It is OFF
 * by default and enabled per request via the `x-relay-compress: <mode>` header.
 *
 * Hard guarantee across ALL engines/modes: code blocks, inline code, URLs, and
 * structured JSON are preserved byte-for-byte. Only prose between them is shrunk.
 * Every run's before/after token estimate + engine name is logged in the same
 * per-request "routed" log line as the routing decisions — never a silent side
 * channel.
 */

export interface CompressionResult {
  text: string;
  /** Estimated token count before compression. */
  before: number;
  /** Estimated token count after compression. */
  after: number;
}

/**
 * A pluggable engine. The contract is deliberately tiny — `compress(text)` — so
 * adding a second mode later is a registry change, not a rewrite.
 */
export interface CompressionEngine {
  /** The `x-relay-compress` value that selects this engine. */
  readonly mode: string;
  compress(text: string): CompressionResult;
}
