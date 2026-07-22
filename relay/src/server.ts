import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import {
  ChatRequest,
  type ProviderAdapter,
  type ProviderConfig,
  type TokenUsage,
} from "./adapters/types.js";
import { compressMessages, getEngine } from "./compression/index.js";
import { loadRelayConfig, type Chain } from "./config/chains.js";
import { loadServerSettings, resolveProviders } from "./config/providers.js";
import { NdjsonLedger, type UsageEntry, type UsageLedger } from "./cost/ledger.js";
import { openLedger } from "./cost/open-ledger.js";
import { computeCostUsd, loadPricing, type PricingTable } from "./cost/pricing.js";
import { buildRegistry } from "./registry.js";
import { defaultBreakerStatePath, writeBreakerState } from "./routing/breaker-state.js";
import { Router, RoutingError, type RouteStreamEvent } from "./routing/router.js";
import { openSecretStore, type SecretStore } from "./secrets/store.js";

// --- SSE helpers (OpenAI-compatible chunk shape) ---------------------------

function sse(raw: ServerResponse, payload: unknown): void {
  raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}
function sseDone(raw: ServerResponse): void {
  raw.write("data: [DONE]\n\n");
}

/** An OpenAI-shaped streaming chunk carrying one content delta. */
function deltaChunk(id: string, model: string, created: number, text: string): unknown {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

/**
 * The terminal chunk: an empty delta with the finish_reason and usage, plus an
 * `x_relay` extension carrying the honest-transparency data that can't ride in
 * headers once the body is already streaming (cost, cache split, attempt count).
 */
function finalChunk(
  id: string,
  model: string,
  created: number,
  finishReason: string | null,
  usage: TokenUsage | null,
  extra: { provider: string; chain: string; costUsd: number | null; attempts: number },
): unknown {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason ?? "stop" }],
    usage: usage
      ? {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
        }
      : null,
    x_relay: {
      provider: extra.provider,
      chain: extra.chain,
      attempts: extra.attempts,
      cost_usd: extra.costUsd,
      usage_detail: usage
        ? {
            cache_creation_input_tokens: usage.cacheCreationInputTokens,
            cache_read_input_tokens: usage.cacheReadInputTokens,
          }
        : null,
    },
  };
}

interface StreamPipeCtx {
  model: string;
  pricing: PricingTable;
  ledger: UsageLedger;
  now: () => number;
  compression?: { engine: string; before: number; after: number };
  log: (obj: object, msg: string) => void;
}

/**
 * Consume a router stream and write it out as OpenAI-compatible SSE.
 *
 * Header timing is the crux: `x-relay-*` headers go out with the SSE response
 * head on the `committed` event — the last moment before the body starts. A
 * PRE-commit failure throws (the generator hasn't emitted `committed` yet), so
 * Fastify still owns the reply and we send a normal JSON error, exactly like the
 * non-streaming path. Cost/usage — known only at `final` — ride in the terminal
 * chunk's `x_relay` field, and that's where the ledger row is written.
 */
async function pipeStream(
  gen: AsyncGenerator<RouteStreamEvent>,
  reply: FastifyReply,
  ctx: StreamPipeCtx,
): Promise<void> {
  const raw = reply.raw;
  const created = Math.floor(ctx.now() / 1000);
  const id = `relay-${ctx.now().toString(36)}`;
  let committed = false;

  const recordRow = (over: Partial<UsageEntry>): void =>
    ctx.ledger.record({
      ts: ctx.now(),
      provider: ctx.model,
      model: ctx.model,
      chain: "",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      costUsd: null,
      latencyMs: 0,
      outcome: "success",
      ...over,
    });

  try {
    for await (const ev of gen) {
      switch (ev.type) {
        case "committed": {
          raw.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-relay-chain": ev.chain,
            "x-relay-provider": ev.provider,
            "x-relay-attempts": String(ev.attempts.length),
            ...(ctx.compression
              ? {
                  "x-relay-compress-engine": ctx.compression.engine,
                  "x-relay-compress-before": String(ctx.compression.before),
                  "x-relay-compress-after": String(ctx.compression.after),
                }
              : {}),
          });
          reply.hijack();
          committed = true;
          break;
        }
        case "delta":
          sse(raw, deltaChunk(id, ctx.model, created, ev.text));
          break;
        case "final": {
          const { result } = ev;
          const costUsd = computeCostUsd(ctx.pricing, result.provider, result.model, result.usage);
          recordRow({
            provider: result.provider,
            model: result.model,
            chain: ev.chain,
            promptTokens: result.usage?.promptTokens ?? null,
            completionTokens: result.usage?.completionTokens ?? null,
            totalTokens: result.usage?.totalTokens ?? null,
            costUsd,
            latencyMs: result.latencyMs,
            outcome: "success",
          });
          sse(
            raw,
            finalChunk(id, result.model, created, result.finishReason, result.usage, {
              provider: result.provider,
              chain: ev.chain,
              costUsd,
              attempts: ev.attempts.length,
            }),
          );
          sseDone(raw);
          raw.end();
          ctx.log(
            { chain: ev.chain, provider: result.provider, costUsd, streamed: true },
            "routed (stream)",
          );
          break;
        }
        case "stream_error": {
          // Committed provider failed mid-stream — record the failure and tell
          // the client honestly rather than leaving the connection hanging.
          recordRow({ provider: ev.provider, chain: ev.chain, outcome: "error" });
          sse(raw, {
            error: { type: ev.error.kind, message: ev.error.message, provider: ev.provider },
          });
          sseDone(raw);
          raw.end();
          ctx.log(
            { chain: ev.chain, provider: ev.provider, errorKind: ev.error.kind, streamed: true },
            "stream error after commit",
          );
          break;
        }
      }
    }
  } catch (err) {
    if (!committed) {
      // Pre-commit: Fastify still owns the reply — send a normal JSON error.
      sendRoutingError(err, reply, ctx.log);
    } else {
      // Post-commit errors are delivered as stream_error events, not throws, so
      // this is a belt-and-suspenders guard against a hung socket.
      try {
        sse(raw, { error: { message: "internal stream error" } });
        sseDone(raw);
        raw.end();
      } catch {
        /* socket already gone */
      }
    }
  }
}

/** Map a RoutingError (or anything else) to a JSON error response. Shared by the
 *  streaming pre-commit path and the non-streaming catch. */
function sendRoutingError(
  err: unknown,
  reply: FastifyReply,
  log: (obj: object, msg: string) => void,
): void {
  if (err instanceof RoutingError) {
    log({ chain: err.chain, attempts: err.attempts }, "routing failed");
    reply.header("x-relay-chain", err.chain);
    reply.header("x-relay-attempts", String(err.attempts.length));
    const last = err.lastError;
    const status =
      last?.kind === "bad_request"
        ? 400
        : last?.kind === "rate_limit"
          ? 429
          : 502;
    reply.status(status).send({
      error: last?.kind ?? "routing_failed",
      chain: err.chain,
      detail: err.message,
      attempts: err.attempts,
    });
    return;
  }
  log({ err: String(err) }, "internal error");
  reply.status(500).send({ error: "internal", detail: String(err) });
}

/**
 * v0 gateway. Multi-provider round-trip end to end:
 *   client -> POST /v1/chat -> Router (fallback + circuit breaker) -> adapter
 *          -> upstream provider -> normalized reply
 *
 * The Router picks the chain (by request `chain`, or a direct `provider`, or the
 * default chain), fails over on retriable errors, and skips providers whose
 * circuit breaker is cooling off. Every attempt is echoed in response headers
 * for transparency.
 *
 * IMPORTANT (redaction): nothing on the request/response path may carry key
 * material. The attempt log records only provider ids, outcomes, error kinds and
 * error *messages* (never headers/keys); the `x-relay-*` headers carry only
 * chain/provider names and an attempt count. This is asserted by tests.
 */

const ChatBody = ChatRequest.extend({
  /** Target a single configured provider directly (bypasses fallback). */
  provider: z.string().optional(),
  /** Route through a named chain from relay.config.json. */
  chain: z.string().optional(),
});

export interface BuiltServerConfig {
  providers: ProviderConfig[];
  chains: Chain[];
  storeBackend?: SecretStore["backend"] | "none";
  /** Usage/cost ledger; defaults to the local NDJSON ledger. */
  ledger?: UsageLedger;
  /** Pricing table; defaults to the seed table merged with relay.pricing.json. */
  pricing?: PricingTable;
  /** Clock for ledger timestamps; injectable for tests. */
  now?: () => number;
  /**
   * When set, breaker state transitions are persisted here so a separate process
   * (the stdio MCP server) can report circuit state. Omit in tests to avoid file
   * writes.
   */
  breakerStatePath?: string;
}

export function buildServer(cfg: BuiltServerConfig): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.RELAY_LOG_LEVEL ?? "info" } });
  const registry = buildRegistry(cfg.providers);
  const ledger = cfg.ledger ?? new NdjsonLedger();
  const pricing = cfg.pricing ?? loadPricing();
  const now = cfg.now ?? (() => Date.now());
  const router = new Router(registry, cfg.chains, {
    onBreakerTransition: (provider, from, to, reason) => {
      app.log.info({ provider, from, to, reason }, "circuit breaker transition");
      if (cfg.breakerStatePath) {
        try {
          writeBreakerState(cfg.breakerStatePath, provider, to, reason, now());
        } catch (err) {
          app.log.warn({ err }, "could not persist breaker state");
        }
      }
    },
  });

  app.get("/health", async () => {
    const results: Record<string, unknown> = {};
    for (const [id, adapter] of registry) {
      results[id] = await adapter.health();
    }
    return { ok: true, keyStore: cfg.storeBackend ?? "none", providers: results };
  });

  app.get("/v1/providers", async () => ({
    providers: [...registry.values()].map((a: ProviderAdapter) => ({
      id: a.id,
      label: a.label,
      capabilities: [...a.capabilities],
    })),
  }));

  app.get("/v1/usage", async () => ({
    byProvider: ledger.summaryByProvider(),
    recent: ledger.recent(20),
  }));

  app.post("/v1/chat", async (request, reply) => {
    const parsed = ChatBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        detail: parsed.error.flatten(),
      });
    }
    const { provider, chain, ...chatReq } = parsed.data;

    if (registry.size === 0) {
      return reply.status(503).send({
        error: "no_provider",
        detail: "No providers configured. Run `relay add-provider` or set env keys.",
      });
    }

    // Opt-in compression: applied to the normalized request BEFORE it's routed
    // upstream. Off by default; enabled per request via `x-relay-compress: <mode>`.
    let compression: { engine: string; before: number; after: number } | undefined;
    const compressHeader = request.headers["x-relay-compress"];
    const mode = Array.isArray(compressHeader) ? compressHeader[0] : compressHeader;
    if (mode && mode !== "off") {
      const engine = getEngine(mode);
      if (engine) {
        const r = compressMessages(chatReq.messages, engine);
        chatReq.messages = r.messages;
        compression = { engine: engine.mode, before: r.before, after: r.after };
      } else {
        request.log.warn({ mode }, "unknown x-relay-compress mode; skipping compression");
      }
    }

    // --- Streaming path (opt-in via "stream": true) ------------------------
    if (chatReq.stream) {
      const gen = provider
        ? router.streamRun(chatReq, router.singleProviderChain(provider))
        : router.streamChat(chatReq, chain);
      await pipeStream(gen, reply, {
        model: chatReq.model,
        pricing,
        ledger,
        now,
        compression,
        log: (o, m) => request.log.info(o, m),
      });
      return reply;
    }

    try {
      // A direct `provider` bypasses fallback (single-provider chain); otherwise
      // route through the named or default chain with failover + breaker.
      const result = provider
        ? await router.run(chatReq, router.singleProviderChain(provider))
        : await router.chat(chatReq, chain);

      // Honest cost accounting from the provider's own reported token usage.
      const { response } = result;
      const costUsd = computeCostUsd(pricing, response.provider, response.model, response.usage);
      ledger.record({
        ts: now(),
        provider: response.provider,
        model: response.model,
        chain: result.chain,
        promptTokens: response.usage?.promptTokens ?? null,
        completionTokens: response.usage?.completionTokens ?? null,
        totalTokens: response.usage?.totalTokens ?? null,
        costUsd,
        latencyMs: response.latencyMs,
        outcome: "success",
      });

      // Transparency: surface the routing story in response headers + logs.
      reply.header("x-relay-chain", result.chain);
      reply.header("x-relay-provider", response.provider);
      reply.header("x-relay-attempts", String(result.attempts.length));
      if (costUsd !== null) reply.header("x-relay-cost-usd", costUsd.toFixed(6));
      if (compression) {
        // Token counts here are pre-send ESTIMATES (see compression/tokens.ts).
        reply.header("x-relay-compress-engine", compression.engine);
        reply.header("x-relay-compress-before", String(compression.before));
        reply.header("x-relay-compress-after", String(compression.after));
      }
      request.log.info(
        { chain: result.chain, attempts: result.attempts, costUsd, compression },
        "routed",
      );
      return reply.send(response);
    } catch (err) {
      sendRoutingError(err, reply, (o, m) => request.log.warn(o, m));
      return reply;
    }
  });

  return app;
}

export async function start(): Promise<void> {
  const settings = loadServerSettings();
  const configFile = loadRelayConfig();
  // Best-effort at startup: env-only dev works without a store. Writing keys
  // (add-provider) requires one and fails loudly — see the CLI.
  const store = await openSecretStore().catch(() => null);
  const providers = await resolveProviders({ configFile, store });

  // Open the usage ledger (SQLite, migrating any legacy NDJSON on first run;
  // NDJSON fallback if the native module can't load).
  const opened = await openLedger();

  const app = buildServer({
    providers,
    chains: configFile.chains,
    storeBackend: store?.backend ?? "none",
    breakerStatePath: defaultBreakerStatePath(),
    ledger: opened.ledger,
  });
  app.log.info(
    {
      keyStore: store?.backend ?? "none (env only)",
      providers: providers.length,
      ledger: opened.ledger.backend,
      migratedRows: opened.migrated,
    },
    "relay starting",
  );
  if (providers.length === 0) {
    app.log.warn(
      "No providers configured. Run `relay add-provider <id>` or set keys in .env (see .env.example).",
    );
  }
  await app.listen({ host: settings.host, port: settings.port });
}
