import {
  AdapterError,
  ChatRequest,
  ChatResponse,
  type Capability,
  type ChatStream,
  type HealthResult,
  type ProviderAdapter,
  type ProviderConfig,
} from "./types.js";
import { parseSse } from "./sse.js";
import { z } from "zod";

/**
 * Adapter for OpenAI and any OpenAI-compatible Chat Completions endpoint
 * (Groq, Together, Mistral's compat layer, local Ollama/vLLM, ...).
 *
 * It uses ONLY the user-provided baseUrl + apiKey from ProviderConfig. It sends
 * a plain, honest User-Agent identifying Relay — it does not impersonate any
 * other client, and does not touch TLS fingerprinting.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

// Minimal schema for the slice of the OpenAI response we consume. Kept narrow
// on purpose: we validate what we read, and pass unknown fields through nowhere.
const OpenAIChatCompletion = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
});

/** The slice of an OpenAI streaming chunk we read (parsed, not Zod-validated —
 *  streaming is hot-path and chunks are tiny and self-consistent). */
interface OpenAIStreamChunk {
  model?: string;
  choices?: Array<{
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(["chat"]);

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly defaultModel?: string;

  constructor(cfg: ProviderConfig) {
    if (!cfg.baseUrl) {
      throw new Error(`Provider "${cfg.id}" is missing a baseUrl.`);
    }
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
      // GET /models is the cheapest documented auth probe for the compat API.
      const res = await this.fetchWithTimeout(`${this.baseUrl}/models`, {
        method: "GET",
        headers: this.headers(),
      });
      const latencyMs = Math.round(performance.now() - started);
      if (!res.ok) {
        return {
          ok: false,
          latencyMs,
          detail: `HTTP ${res.status} ${res.statusText}`,
        };
      }
      return { ok: true, latencyMs };
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

    const body = this.buildBody(req, model);

    const started = performance.now();
    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
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
      throw new AdapterError(
        `Provider "${this.id}" returned HTTP ${res.status}: ${this.redact(text).slice(0, 500)}`,
        classifyStatus(res.status),
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

    const parsed = OpenAIChatCompletion.safeParse(json);
    if (!parsed.success) {
      throw new AdapterError(
        `Provider "${this.id}" response failed schema validation: ${parsed.error.message}`,
        "server",
        this.id,
        res.status,
      );
    }

    const choice = parsed.data.choices[0]!;
    return {
      provider: this.id,
      model: parsed.data.model ?? model,
      content: choice.message.content ?? "",
      finishReason: choice.finish_reason ?? null,
      usage: parsed.data.usage
        ? {
            promptTokens: parsed.data.usage.prompt_tokens,
            completionTokens: parsed.data.usage.completion_tokens,
            totalTokens: parsed.data.usage.total_tokens,
            // The OpenAI-compatible surface reports no cache split.
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
          }
        : null,
      latencyMs,
    };
  }

  /**
   * Streaming chat over the OpenAI SSE protocol. Honors the failover contract:
   * any connect-time failure throws BEFORE the first delta is yielded, so the
   * router can still switch providers; once tokens flow, this provider is
   * committed. `stream_options.include_usage` asks for a final usage chunk —
   * compat endpoints that ignore it simply leave `usage` null (never faked).
   */
  async *chatStream(reqInput: ChatRequest): ChatStream {
    const req = ChatRequest.parse(reqInput);
    const model = this.resolveModel(req.model);
    const body = {
      ...this.buildBody(req, model),
      stream: true,
      stream_options: { include_usage: true },
    };

    const started = performance.now();
    // Time-limit only the connection, not the stream body (a long stream is fine).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw this.toAdapterError(err);
    }
    clearTimeout(timer);

    // These throws happen before any yield → the router can still fail over.
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AdapterError(
        `Provider "${this.id}" returned HTTP ${res.status}: ${this.redact(text).slice(0, 500)}`,
        classifyStatus(res.status),
        this.id,
        res.status,
        { retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")) },
      );
    }
    if (!res.body) {
      throw new AdapterError(`Provider "${this.id}" streamed no body.`, "server", this.id);
    }

    let servedModel = model;
    let finishReason: string | null = null;
    let usage: ChatResponse["usage"] = null;

    for await (const ev of parseSse(res.body)) {
      if (ev.data === "[DONE]") break;
      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue; // ignore keep-alive / malformed lines
      }
      if (chunk.model) servedModel = chunk.model;
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) {
        yield { text: choice.delta.content };
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
        };
      }
    }

    return {
      provider: this.id,
      model: servedModel,
      finishReason,
      usage,
      latencyMs: Math.round(performance.now() - started),
    };
  }

  // -------------------------------------------------------------------------

  private resolveModel(requested: string): string {
    const model = requested || this.defaultModel;
    if (!model) {
      throw new AdapterError(
        `No model specified and provider "${this.id}" has no defaultModel.`,
        "bad_request",
        this.id,
      );
    }
    return model;
  }

  private buildBody(req: ChatRequest, model: string): Record<string, unknown> {
    return {
      model,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.extra ?? {}),
    };
  }

  /**
   * Defense-in-depth: strip our own key from any text (e.g. an error body a
   * provider might echo back) before it can reach a log or error message.
   */
  private redact(text: string): string {
    if (!this.apiKey) return text;
    return text.split(this.apiKey).join("***");
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/json",
      // Honest identification. We are Relay, and we say so.
      "user-agent": "relay-gateway/0.0.1",
    };
    if (this.apiKey) h["authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
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

function classifyStatus(status: number): AdapterError["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  if (status >= 400) return "bad_request";
  return "unknown";
}

/**
 * Parse an HTTP Retry-After header, which is either delta-seconds (an integer)
 * or an HTTP-date. Returns milliseconds, or undefined if absent/unparseable.
 */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}
