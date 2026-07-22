import { z } from "zod";

/**
 * The common contract every provider adapter implements.
 *
 * A ProviderAdapter normalizes requests/responses across providers. It ONLY
 * ever uses credentials the user explicitly configured (passed in via
 * ProviderConfig at construction) — never a bundled default. Adapters must not
 * spoof client fingerprints or impersonate another application; they speak each
 * provider's documented API with the user's own key.
 */

// ---------------------------------------------------------------------------
// Normalized wire types (Zod schemas double as runtime validation)
// ---------------------------------------------------------------------------

export const ChatRole = z.enum(["system", "user", "assistant", "tool"]);
export type ChatRole = z.infer<typeof ChatRole>;

export const ChatMessage = z.object({
  role: ChatRole,
  content: z.string(),
  /** Optional tool-call correlation id, passed through when present. */
  toolCallId: z.string().optional(),
  name: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatRequest = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessage).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  /** When true the adapter should return an async token stream. */
  stream: z.boolean().optional(),
  /** Free-form provider-specific passthrough, validated per-adapter. */
  extra: z.record(z.unknown()).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

/**
 * Normalized token usage.
 *
 * `promptTokens` is the input billed at the provider's BASE input rate — for
 * Anthropic that is `input_tokens`, i.e. the uncached remainder only. Cached
 * input is reported separately because it bills at different rates (a cache
 * write costs more than base input; a cache read costs far less), so folding it
 * into `promptTokens` would misstate cost in both directions. Providers that
 * don't do prompt caching simply leave the cache fields null.
 *
 * Total prompt size = promptTokens + cacheCreationInputTokens + cacheReadInputTokens.
 */
export const TokenUsage = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  /** Input tokens written to the prompt cache (billed above base input rate). */
  cacheCreationInputTokens: z.number().int().nonnegative().nullable().default(null),
  /** Input tokens served from the prompt cache (billed well below base rate). */
  cacheReadInputTokens: z.number().int().nonnegative().nullable().default(null),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const ChatResponse = z.object({
  /** Which provider actually served this (set by the adapter). */
  provider: z.string(),
  model: z.string(),
  content: z.string(),
  finishReason: z.string().nullable(),
  usage: TokenUsage.nullable(),
  /** Wall-clock latency for the upstream call, ms. */
  latencyMs: z.number().nonnegative(),
});
export type ChatResponse = z.infer<typeof ChatResponse>;

/** One incremental text delta from a streaming chat. */
export interface StreamDelta {
  text: string;
}

/**
 * The terminal value of a chat stream — the same normalized metadata a
 * non-streaming `ChatResponse` carries, minus the concatenated content (the
 * caller has already seen every delta). Returned as the generator's return
 * value, so `for await` yields deltas and the final `.next()` carries this.
 */
export interface StreamResult {
  provider: string;
  model: string;
  finishReason: string | null;
  usage: TokenUsage | null;
  latencyMs: number;
}

/**
 * A streaming chat. Yields text deltas and returns a `StreamResult`.
 *
 * FAILOVER CONTRACT: an adapter MUST throw its `AdapterError` (with the right
 * retriable classification) BEFORE yielding the first delta if the upstream
 * call fails to establish — a bad key, a 429, a 5xx on connect. That first
 * moment is the only point at which the router can still fail over to another
 * provider, because nothing has reached the client yet. Once the first delta is
 * yielded the provider is committed; a mid-stream failure surfaces to the caller
 * as a truncated stream, never as a silent retry on a different provider.
 */
export type ChatStream = AsyncGenerator<StreamDelta, StreamResult, void>;

// ---------------------------------------------------------------------------
// Capabilities & config
// ---------------------------------------------------------------------------

export type Capability = "chat" | "embeddings" | "vision" | "audio";

/**
 * Which adapter implementation serves a provider. Defaults to
 * "openai-compatible"; "anthropic" selects the native Messages API adapter;
 * "gemini" the native Google Generative Language API adapter.
 */
export type ProviderKind = "openai-compatible" | "anthropic" | "gemini";

export interface ProviderConfig {
  /** Stable id used in routing chains and logs, e.g. "openai" or "groq-1". */
  id: string;
  /** Human label for the dashboard. */
  label?: string;
  /** Adapter implementation; defaults to "openai-compatible". */
  kind?: ProviderKind;
  /** Base URL of the provider's API endpoint. */
  baseUrl: string;
  /**
   * The user's own API key. May be empty for keyless local endpoints
   * (e.g. Ollama). Never a bundled default.
   */
  apiKey?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Optional default model if a request omits one. */
  defaultModel?: string;
}

export interface HealthResult {
  ok: boolean;
  /** Round-trip latency of the health probe, ms. */
  latencyMs: number;
  detail?: string;
}

/**
 * A normalized error every adapter throws on failure, so the routing engine
 * can make consistent failover decisions without knowing provider internals.
 */
export class AdapterError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "auth" // 401/403 — do NOT retry other providers with same creds
      | "rate_limit" // 429 — back off, failover is appropriate
      | "server" // 5xx — failover is appropriate
      | "timeout" // network/timeout — failover is appropriate
      | "bad_request" // 4xx (non-auth) — our fault, do not failover
      | "network" // DNS/connection — failover is appropriate,
      | "unknown",
    readonly provider: string,
    readonly status?: number,
    options?: { cause?: unknown; retryAfterMs?: number },
  ) {
    super(message, options);
    this.name = "AdapterError";
    this.retryAfterMs = options?.retryAfterMs;
  }

  /**
   * Cooldown the provider explicitly asked for via a Retry-After header, in ms.
   * When present the circuit breaker honors this instead of guessing a backoff —
   * the cooperative behavior a provider expects.
   */
  readonly retryAfterMs?: number;

  /** Whether the routing engine should try the next provider in the chain. */
  get retriable(): boolean {
    return (
      this.kind === "rate_limit" ||
      this.kind === "server" ||
      this.kind === "timeout" ||
      this.kind === "network"
    );
  }
}

export interface ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ReadonlySet<Capability>;

  /** Lightweight connectivity/auth probe for the dashboard health checks. */
  health(): Promise<HealthResult>;

  /** Normalized, non-streaming chat completion. */
  chat(req: ChatRequest): Promise<ChatResponse>;

  /**
   * Streaming chat. Optional — capability-detected by the router, which falls
   * back to a clear error if a targeted provider can't stream. See `ChatStream`
   * for the pre-first-token failover contract.
   */
  chatStream?(req: ChatRequest): ChatStream;

  // Embeddings / vision / audio are added incrementally as each capability
  // lands, so the contract stays honest about what actually works.
}
