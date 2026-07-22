import { parseSse } from "./sse.js";
import {
  AdapterError,
  ChatRequest,
  type Capability,
  type ChatMessage,
  type ChatResponse,
  type ChatStream,
  type HealthResult,
  type ProviderAdapter,
  type ProviderConfig,
} from "./types.js";

/**
 * Native adapter for Google's Generative Language API (Gemini) —
 * `POST {base}/models/{model}:generateContent`.
 *
 * Like the Anthropic adapter, this is deliberately NOT an OpenAI-compatible
 * shim: Gemini's shape is genuinely different, and every difference below is a
 * place a shim silently gets it wrong.
 *
 *   - the operation is a URL SUFFIX (`:generateContent`), and the model name is
 *     in the PATH — not a `model` body field, not a fixed `/chat/completions`
 *   - auth is an `x-goog-api-key` header (we avoid the `?key=` query form so the
 *     key never lands in a URL or a log)
 *   - messages are `contents: [{role, parts:[{text}]}]` with roles `user` /
 *     `model` (NOT `assistant`)
 *   - the system prompt is a separate top-level `systemInstruction`, so
 *     multi-turn system messages must be hoisted and joined — the same class of
 *     bug the Anthropic adapter's system handling avoids
 *   - finish reasons are UPPERCASE (`STOP` / `MAX_TOKENS` / `SAFETY` / …) and a
 *     `SAFETY` block is a successful 200, not an error
 *   - errors carry a `status` string (`RESOURCE_EXHAUSTED`, `UNAUTHENTICATED`,
 *     …) alongside the HTTP code
 *   - usage is `usageMetadata` with `cachedContentTokenCount` folded INTO
 *     `promptTokenCount`, so honest cost needs the cached portion split back out
 *
 * Raw fetch (not the Google SDK) for the same reason as the other adapters:
 * every adapter must produce the same normalized `AdapterError` the router and
 * breaker key off, with no hidden retry layer.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }>; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
}

interface GeminiErrorBody {
  error?: { code?: number; message?: string; status?: string };
}

/**
 * Map Gemini's finish reason into the shared vocabulary. `STOP`/`MAX_TOKENS`
 * map onto the OpenAI-style values; safety/recitation blocks pass through
 * lowercased so they surface honestly rather than being flattened to "stop".
 */
export function mapGeminiFinishReason(reason: string | undefined): string | null {
  switch (reason) {
    case undefined:
    case "FINISH_REASON_UNSPECIFIED":
      return null;
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    default:
      // SAFETY | RECITATION | BLOCKLIST | PROHIBITED_CONTENT | SPII | OTHER | …
      return reason.toLowerCase();
  }
}

/**
 * Map a Gemini failure onto the shared retriable/non-retriable split, keyed on
 * the `status` string first (more precise than the HTTP code), then the code.
 */
export function classifyGeminiError(
  status: number,
  errorStatus?: string,
): AdapterError["kind"] {
  switch (errorStatus) {
    case "RESOURCE_EXHAUSTED":
      return "rate_limit";
    case "UNAUTHENTICATED":
    case "PERMISSION_DENIED":
      return "auth";
    case "INVALID_ARGUMENT":
    case "FAILED_PRECONDITION":
    case "NOT_FOUND":
    case "OUT_OF_RANGE":
      return "bad_request";
    case "INTERNAL":
    case "UNAVAILABLE":
    case "DEADLINE_EXCEEDED":
      return "server";
  }
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server";
  if (status >= 400) return "bad_request";
  return "unknown";
}

export class GeminiAdapter implements ProviderAdapter {
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
    const model = this.resolveModel(req.model);

    const started = performance.now();
    let res: Response;
    try {
      res = await this.fetchWithTimeout(this.url(model, "generateContent"), {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify(this.buildBody(req)),
      });
    } catch (err) {
      throw this.toAdapterError(err);
    }
    const latencyMs = Math.round(performance.now() - started);

    if (!res.ok) throw await this.errorFromResponse(res);

    const json = (await res.json().catch((err) => {
      throw new AdapterError(
        `Provider "${this.id}" returned non-JSON body.`,
        "server",
        this.id,
        res.status,
        { cause: err },
      );
    })) as GeminiResponse;

    const candidate = json.candidates?.[0];
    const content = (candidate?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");

    return {
      provider: this.id,
      model: json.modelVersion ?? model,
      content,
      // A SAFETY / RECITATION block is a successful 200 with (often) empty
      // content — surfaced as a finishReason, never thrown as a retriable error
      // (retrying a safety block elsewhere would be evasion).
      finishReason: mapGeminiFinishReason(candidate?.finishReason),
      usage: this.mapUsage(json.usageMetadata),
      latencyMs,
    };
  }

  /**
   * Streaming chat over `:streamGenerateContent?alt=sse`. Gemini's SSE has no
   * `[DONE]` terminator — the stream just ends. `usageMetadata` and the
   * finishReason arrive in the final chunk(s). Honors the failover contract:
   * connect-time errors throw before the first delta.
   */
  async *chatStream(reqInput: ChatRequest): ChatStream {
    const req = ChatRequest.parse(reqInput);
    const model = this.resolveModel(req.model);

    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.url(model, "streamGenerateContent") + "?alt=sse", {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify(this.buildBody(req)),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw this.toAdapterError(err);
    }
    clearTimeout(timer);

    if (!res.ok) throw await this.errorFromResponse(res); // before any yield
    if (!res.body) {
      throw new AdapterError(`Provider "${this.id}" streamed no body.`, "server", this.id);
    }

    let servedModel = model;
    let finishReason: string | undefined;
    let usage: GeminiUsageMetadata | undefined;

    for await (const ev of parseSse(res.body)) {
      let chunk: GeminiResponse;
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (chunk.modelVersion) servedModel = chunk.modelVersion;
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.text) yield { text: part.text };
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      if (chunk.usageMetadata) usage = chunk.usageMetadata; // cumulative; last wins
    }

    return {
      provider: this.id,
      model: servedModel,
      finishReason: mapGeminiFinishReason(finishReason),
      usage: this.mapUsage(usage),
      latencyMs: Math.round(performance.now() - started),
    };
  }

  // -------------------------------------------------------------------------

  private resolveModel(requested: string): string {
    const model = (requested || this.defaultModel || "").replace(/^models\//, "");
    if (!model) {
      throw new AdapterError(
        `No model specified and provider "${this.id}" has no defaultModel.`,
        "bad_request",
        this.id,
      );
    }
    return model;
  }

  private url(model: string, method: "generateContent" | "streamGenerateContent"): string {
    return `${this.baseUrl}/models/${encodeURIComponent(model)}:${method}`;
  }

  private buildBody(req: ChatRequest): Record<string, unknown> {
    const { systemInstruction, contents } = toGeminiContents(req.messages, this.id);
    const generationConfig: Record<string, unknown> = {};
    if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    return {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
      ...(req.extra ?? {}),
    };
  }

  /**
   * Normalize `usageMetadata`. Gemini folds cached tokens INTO
   * `promptTokenCount`, so base-rate input = promptTokenCount − cached, and the
   * cached portion is reported separately (it bills cheaper) — the same honesty
   * the Anthropic adapter applies. Gemini has no per-request cache-creation
   * count (caching is a separate explicit API), so that field stays null.
   */
  private mapUsage(u: GeminiUsageMetadata | undefined): ChatResponse["usage"] {
    if (!u) return null;
    const cached = u.cachedContentTokenCount ?? 0;
    const promptTotal = u.promptTokenCount ?? 0;
    const completion = u.candidatesTokenCount ?? 0;
    return {
      promptTokens: Math.max(0, promptTotal - cached),
      completionTokens: completion,
      totalTokens: u.totalTokenCount ?? promptTotal + completion,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: cached > 0 ? cached : null,
    };
  }

  private async errorFromResponse(res: Response): Promise<AdapterError> {
    const text = await res.text().catch(() => "");
    let errorStatus: string | undefined;
    let detail = text;
    try {
      const parsed = JSON.parse(text) as GeminiErrorBody;
      if (parsed.error) {
        errorStatus = parsed.error.status;
        detail = parsed.error.message ?? text;
      }
    } catch {
      /* non-JSON body — keep raw text */
    }
    return new AdapterError(
      `Provider "${this.id}" returned HTTP ${res.status}${
        errorStatus ? ` (${errorStatus})` : ""
      }: ${this.redact(detail).slice(0, 500)}`,
      classifyGeminiError(res.status, errorStatus),
      this.id,
      res.status,
      { retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")) },
    );
  }

  private redact(text: string): string {
    if (!this.apiKey) return text;
    return text.split(this.apiKey).join("***");
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/json",
      "user-agent": "relay-gateway/0.0.1",
    };
    // Header auth (not ?key=) keeps the key out of the URL and any request log.
    if (this.apiKey) h["x-goog-api-key"] = this.apiKey;
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

export interface GeminiPart {
  text: string;
}
export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/**
 * Translate normalized messages into Gemini's shape.
 *
 *   - ALL `system` messages are hoisted into the top-level `systemInstruction`
 *     and joined in order — Gemini has no `system` role in `contents`, so a shim
 *     would drop or misplace them (the multi-turn-system-prompt trap).
 *   - `assistant` maps to role `model`; `tool` maps to a `user` turn carrying
 *     its text (function-response tool calls are a later capability).
 *   - The first content must be `user`; we validate and fail as `bad_request`.
 */
export function toGeminiContents(
  messages: ChatMessage[],
  providerId: string,
): { systemInstruction?: { parts: GeminiPart[] }; contents: GeminiContent[] } {
  const systemParts: string[] = [];
  const contents: GeminiContent[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    const role: "user" | "model" = m.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: [{ text: m.content }] });
  }

  if (contents.length === 0) {
    throw new AdapterError(
      `Request to "${providerId}" has no non-system messages; Gemini requires at least one.`,
      "bad_request",
      providerId,
    );
  }
  if (contents[0]!.role !== "user") {
    throw new AdapterError(
      `Request to "${providerId}" must start with a user message (after system messages are hoisted); got "${contents[0]!.role}".`,
      "bad_request",
      providerId,
    );
  }

  return {
    ...(systemParts.length > 0
      ? { systemInstruction: { parts: [{ text: systemParts.join("\n\n") }] } }
      : {}),
    contents,
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
