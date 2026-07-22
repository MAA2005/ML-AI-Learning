import { z } from "zod";
import {
  AdapterError,
  ChatRequest,
  type Capability,
  type ChatMessage,
  type ChatResponse,
  type HealthResult,
  type ProviderAdapter,
  type ProviderConfig,
} from "./types.js";

/**
 * Native adapter for Anthropic's Messages API (`POST /v1/messages`).
 *
 * This is deliberately NOT routed through the OpenAI-compatible adapter: the
 * Messages API is a genuinely different shape, and a translation shim gets the
 * edge cases wrong. Concretely:
 *
 *   - auth is `x-api-key` + `anthropic-version`, not `Authorization: Bearer`
 *   - `system` is a TOP-LEVEL field, not a message with role "system"
 *   - message content is an array of typed blocks, not a plain string
 *   - `max_tokens` is REQUIRED (OpenAI treats it as optional)
 *   - stop reasons have their own vocabulary (end_turn / tool_use / refusal / …)
 *   - errors carry a typed `error.type`, and 529 `overloaded_error` has no
 *     OpenAI equivalent
 *   - usage reports FOUR token counts, splitting cached input out from base
 *     input — which is what makes honest cost tracking possible here
 *
 * Raw fetch (rather than the Anthropic SDK) is intentional for this gateway:
 * every adapter must produce the same normalized `AdapterError` the router and
 * circuit breaker key off, and the SDK's own retry layer (default 2 retries on
 * 429/5xx) would retry *inside* the adapter — corrupting the breaker's failure
 * accounting and double-spending a Retry-After window it can't see.
 */

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The Messages API requires `max_tokens`. Our normalized ChatRequest treats it
 * as optional (OpenAI-shaped), so we supply a default rather than 400ing.
 */
const DEFAULT_MAX_TOKENS = 16_000;

// Narrow schema for the slice of the response we consume.
const AnthropicMessage = z.object({
  model: z.string().optional(),
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .default([]),
  stop_reason: z.string().nullable().optional(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().nullable().optional(),
      cache_read_input_tokens: z.number().nullable().optional(),
    })
    .optional(),
});

const AnthropicErrorBody = z.object({
  error: z.object({ type: z.string().optional(), message: z.string().optional() }),
});

/**
 * Normalize Anthropic's stop_reason into the shared vocabulary so callers see
 * consistent values across providers. `end_turn`/`stop_sequence` map onto the
 * OpenAI-style "stop", `max_tokens` onto "length"; the Anthropic-specific ones
 * pass through unchanged rather than being flattened into something untrue.
 */
export function mapStopReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case undefined:
    case null:
      return null;
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    default:
      // tool_use | refusal | pause_turn | anything new — report it verbatim.
      return reason;
  }
}

/**
 * Map an Anthropic failure onto the shared retriable/non-retriable split, so
 * the router and breaker never need to know Anthropic is different.
 *
 *   429 rate_limit_error   → rate_limit (retriable, honors Retry-After)
 *   529 overloaded_error   → server     (retriable) — no OpenAI equivalent
 *   5xx api_error          → server     (retriable)
 *   401 authentication_error / 403 permission_error → auth (STOPS the chain)
 *   400 invalid_request_error / 404 / 413 → bad_request (STOPS the chain)
 */
export function classifyAnthropicError(
  status: number,
  errorType?: string,
): AdapterError["kind"] {
  // Prefer the typed error from the body — it's more precise than the status.
  switch (errorType) {
    case "rate_limit_error":
      return "rate_limit";
    case "overloaded_error":
    case "api_error":
      return "server";
    case "authentication_error":
    case "permission_error":
      return "auth";
    case "invalid_request_error":
    case "not_found_error":
    case "request_too_large":
      return "bad_request";
  }
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 529 || status >= 500) return "server";
  if (status >= 400) return "bad_request";
  return "unknown";
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(["chat"]);

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly defaultModel?: string;

  constructor(cfg: ProviderConfig) {
    if (!cfg.baseUrl) throw new Error(`Provider "${cfg.id}" is missing a baseUrl.`);
    this.id = cfg.id;
    this.label = cfg.label ?? cfg.id;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey || undefined;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultModel = cfg.defaultModel;
  }

  async health(): Promise<HealthResult> {
    const started = performance.now();
    try {
      // GET /v1/models is the cheapest authenticated probe.
      const res = await this.fetchWithTimeout(`${this.baseUrl}/models`, {
        method: "GET",
        headers: this.headers(),
      });
      const latencyMs = Math.round(performance.now() - started);
      return res.ok
        ? { ok: true, latencyMs }
        : { ok: false, latencyMs, detail: `HTTP ${res.status} ${res.statusText}` };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async chat(reqInput: ChatRequest): Promise<ChatResponse> {
    const req = ChatRequest.parse(reqInput);
    const model = req.model || this.defaultModel;
    if (!model) {
      throw new AdapterError(
        `No model specified and provider "${this.id}" has no defaultModel.`,
        "bad_request",
        this.id,
      );
    }

    const { system, messages } = toAnthropicMessages(req.messages, this.id);

    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      ...(system ? { system } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.extra ?? {}),
    };

    const started = performance.now();
    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw this.toAdapterError(err);
    }
    const latencyMs = Math.round(performance.now() - started);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let errorType: string | undefined;
      let detail = text;
      try {
        const parsed = AnthropicErrorBody.safeParse(JSON.parse(text));
        if (parsed.success) {
          errorType = parsed.data.error.type;
          detail = parsed.data.error.message ?? text;
        }
      } catch {
        /* non-JSON body — fall back to raw text */
      }
      throw new AdapterError(
        `Provider "${this.id}" returned HTTP ${res.status}${
          errorType ? ` (${errorType})` : ""
        }: ${this.redact(detail).slice(0, 500)}`,
        classifyAnthropicError(res.status, errorType),
        this.id,
        res.status,
        { retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")) },
      );
    }

    const json = await res.json().catch((err) => {
      throw new AdapterError(
        `Provider "${this.id}" returned non-JSON body.`,
        "server",
        this.id,
        res.status,
        { cause: err },
      );
    });

    const parsed = AnthropicMessage.safeParse(json);
    if (!parsed.success) {
      throw new AdapterError(
        `Provider "${this.id}" response failed schema validation: ${parsed.error.message}`,
        "server",
        this.id,
        res.status,
      );
    }

    const msg = parsed.data;
    // Concatenate text blocks; non-text blocks (thinking, tool_use) are not
    // part of the normalized string surface and are skipped rather than
    // stringified into something misleading.
    const content = msg.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");

    const u = msg.usage;
    return {
      provider: this.id,
      model: msg.model ?? model,
      content,
      // NOTE: stop_reason "refusal" is a successful HTTP 200 with (possibly)
      // empty content. It is surfaced as a finishReason, NOT thrown as a
      // retriable error — retrying a policy refusal on another provider would
      // be evasion, which this project explicitly does not do.
      finishReason: mapStopReason(msg.stop_reason),
      usage: u
        ? {
            promptTokens: u.input_tokens,
            completionTokens: u.output_tokens,
            // Total prompt size includes cached input, which `input_tokens` excludes.
            totalTokens:
              u.input_tokens +
              u.output_tokens +
              (u.cache_creation_input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0),
            cacheCreationInputTokens: u.cache_creation_input_tokens ?? null,
            cacheReadInputTokens: u.cache_read_input_tokens ?? null,
          }
        : null,
      latencyMs,
    };
  }

  // -------------------------------------------------------------------------

  private redact(text: string): string {
    if (!this.apiKey) return text;
    return text.split(this.apiKey).join("***");
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      "user-agent": "relay-gateway/0.0.1",
    };
    // Anthropic authenticates with x-api-key, NOT Authorization: Bearer.
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    return h;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private toAdapterError(err: unknown): AdapterError {
    if (err instanceof Error && err.name === "AbortError") {
      return new AdapterError(
        `Provider "${this.id}" timed out after ${this.timeoutMs}ms.`,
        "timeout",
        this.id,
        undefined,
        { cause: err },
      );
    }
    return new AdapterError(
      `Provider "${this.id}" network error: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "network",
      this.id,
      undefined,
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------

export interface AnthropicContentBlock {
  type: "text" | "tool_result";
  text?: string;
  tool_use_id?: string;
  content?: string;
}

export interface AnthropicTurn {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

/**
 * Translate normalized messages into the Messages API shape.
 *
 *   - ALL `system` messages are hoisted to the top-level `system` field and
 *     joined in order. This is the multi-turn-system-prompt case a shim gets
 *     wrong: Anthropic has no `role: "system"` message on the models we target,
 *     so a shim either drops them or forges a user turn.
 *   - `tool` messages become a user turn carrying a `tool_result` block when a
 *     toolCallId is present (plain text otherwise).
 *   - Content becomes an array of typed blocks.
 *
 * The API requires the first non-system message to be `user`; we validate that
 * up front and fail as `bad_request` (non-retriable) rather than letting it
 * surface as an opaque upstream 400 mid-chain.
 */
export function toAnthropicMessages(
  messages: ChatMessage[],
  providerId: string,
): { system?: string; messages: AnthropicTurn[] } {
  const systemParts: string[] = [];
  const turns: AnthropicTurn[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      turns.push({
        role: "user",
        content: [
          m.toolCallId
            ? { type: "tool_result", tool_use_id: m.toolCallId, content: m.content }
            : { type: "text", text: m.content },
        ],
      });
      continue;
    }
    turns.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: [{ type: "text", text: m.content }],
    });
  }

  if (turns.length === 0) {
    throw new AdapterError(
      `Request to "${providerId}" has no non-system messages; the Messages API requires at least one.`,
      "bad_request",
      providerId,
    );
  }
  if (turns[0]!.role !== "user") {
    throw new AdapterError(
      `Request to "${providerId}" must start with a user message (after system messages are hoisted); got "${turns[0]!.role}".`,
      "bad_request",
      providerId,
    );
  }

  return {
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    messages: turns,
  };
}

/** Parse Retry-After (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}
