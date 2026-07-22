import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { ChatRequest, type ProviderAdapter, type ProviderConfig } from "./adapters/types.js";
import { compressMessages, getEngine } from "./compression/index.js";
import { loadRelayConfig, type Chain } from "./config/chains.js";
import { loadServerSettings, resolveProviders } from "./config/providers.js";
import { NdjsonLedger, type UsageLedger } from "./cost/ledger.js";
import { openLedger } from "./cost/open-ledger.js";
import { computeCostUsd, loadPricing, type PricingTable } from "./cost/pricing.js";
import { buildRegistry } from "./registry.js";
import { defaultBreakerStatePath, writeBreakerState } from "./routing/breaker-state.js";
import { Router, RoutingError } from "./routing/router.js";
import { openSecretStore, type SecretStore } from "./secrets/store.js";

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
      if (err instanceof RoutingError) {
        request.log.warn({ chain: err.chain, attempts: err.attempts }, "routing failed");
        reply.header("x-relay-chain", err.chain);
        reply.header("x-relay-attempts", String(err.attempts.length));
        const last = err.lastError;
        const httpStatus =
          last?.kind === "bad_request"
            ? 400
            : last?.kind === "rate_limit"
              ? 429
              : last?.kind === "auth"
                ? 502
                : 502;
        return reply.status(httpStatus).send({
          error: last?.kind ?? "routing_failed",
          chain: err.chain,
          detail: err.message,
          attempts: err.attempts,
        });
      }
      request.log.error(err);
      return reply.status(500).send({ error: "internal", detail: String(err) });
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
