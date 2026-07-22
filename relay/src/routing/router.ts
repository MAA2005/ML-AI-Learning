import {
  AdapterError,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
} from "../adapters/types.js";
import type { Chain } from "../config/chains.js";
import { CircuitBreaker, type BreakerOptions, type BreakerState } from "./breaker.js";

/**
 * The routing / fallback ("combo") engine.
 *
 * Given a chain of configured providers, it tries them in a strategy-determined
 * order and fails over on *retriable* errors (429 / 5xx / timeout / network),
 * while a per-provider circuit breaker skips providers that are cooling off.
 * Auth and bad-request errors stop the chain immediately — failing over would
 * just burn another provider on a client-side mistake.
 *
 * Every attempt is captured in `attempts` for transparent logging.
 */

export type AttemptOutcome =
  | "success"
  | "error"
  | "skipped_open_circuit"
  | "not_configured";

export interface RouteAttempt {
  provider: string;
  outcome: AttemptOutcome;
  latencyMs?: number;
  errorKind?: AdapterError["kind"];
  detail?: string;
}

export interface RouteResult {
  response: ChatResponse;
  chain: string;
  attempts: RouteAttempt[];
}

export class RoutingError extends Error {
  constructor(
    message: string,
    readonly chain: string,
    readonly attempts: RouteAttempt[],
    readonly lastError?: AdapterError,
  ) {
    super(message);
    this.name = "RoutingError";
  }
}

export interface RouterOptions {
  breaker?: Partial<BreakerOptions>;
  /** Injectable RNG in [0,1) for weighted selection; defaults to Math.random. */
  rng?: () => number;
  /** Called on every breaker state change, tagged with the provider id. */
  onBreakerTransition?: (
    provider: string,
    from: BreakerState,
    to: BreakerState,
    reason: string,
  ) => void;
}

export class Router {
  private readonly breakers = new Map<string, CircuitBreaker>();
  /** Per-chain cursor for round-robin. */
  private readonly rrCursor = new Map<string, number>();
  private readonly rng: () => number;

  constructor(
    private readonly registry: Map<string, ProviderAdapter>,
    private readonly chains: Chain[],
    private readonly opts: RouterOptions = {},
  ) {
    this.rng = opts.rng ?? Math.random;
  }

  /** Resolve a chain by name, falling back to the first configured chain, then
   *  to an implicit ordered chain over all registered providers. */
  resolveChain(name?: string): Chain {
    if (name) {
      const found = this.chains.find((c) => c.name === name);
      if (!found) {
        throw new RoutingError(`Unknown chain "${name}".`, name, []);
      }
      return found;
    }
    if (this.chains[0]) return this.chains[0];
    return {
      name: "implicit-default",
      strategy: "ordered",
      providers: [...this.registry.keys()].map((id) => ({ id })),
    };
  }

  /** A one-off chain that targets a single provider directly (bypasses fallback). */
  singleProviderChain(id: string): Chain {
    return { name: `direct:${id}`, strategy: "ordered", providers: [{ id }] };
  }

  private breakerFor(id: string): CircuitBreaker {
    let b = this.breakers.get(id);
    if (!b) {
      b = new CircuitBreaker({
        ...this.opts.breaker,
        onTransition: (from, to, reason) =>
          this.opts.onBreakerTransition?.(id, from, to, reason),
      });
      this.breakers.set(id, b);
    }
    return b;
  }

  /** Provider ids in the order this chain's strategy wants them attempted. */
  private orderProviders(chain: Chain): string[] {
    const ids = chain.providers.map((p) => p.id);
    if (ids.length <= 1) return ids;

    switch (chain.strategy) {
      case "ordered":
        return ids;

      case "round-robin": {
        const start = (this.rrCursor.get(chain.name) ?? 0) % ids.length;
        this.rrCursor.set(chain.name, start + 1);
        return [...ids.slice(start), ...ids.slice(0, start)];
      }

      case "weighted": {
        // Weighted pick for the primary; the rest follow in listed order as
        // fallbacks. Deterministic under an injected rng for tests.
        const weights = chain.providers.map((p) => p.weight ?? 1);
        const total = weights.reduce((a, w) => a + w, 0);
        let r = this.rng() * total;
        let primaryIdx = 0;
        for (let i = 0; i < weights.length; i++) {
          r -= weights[i]!;
          if (r < 0) {
            primaryIdx = i;
            break;
          }
        }
        return [ids[primaryIdx]!, ...ids.filter((_, i) => i !== primaryIdx)];
      }
    }
  }

  async chat(req: ChatRequest, chainName?: string): Promise<RouteResult> {
    const chain = chainName ? this.resolveChain(chainName) : this.resolveChain();
    return this.run(req, chain);
  }

  /** Route through an explicit chain object (used for direct-provider requests). */
  async run(req: ChatRequest, chain: Chain): Promise<RouteResult> {
    const order = this.orderProviders(chain);
    const attempts: RouteAttempt[] = [];
    let lastError: AdapterError | undefined;

    for (const id of order) {
      const adapter = this.registry.get(id);
      if (!adapter) {
        attempts.push({ provider: id, outcome: "not_configured" });
        continue;
      }

      const breaker = this.breakerFor(id);
      if (!breaker.canAttempt()) {
        attempts.push({
          provider: id,
          outcome: "skipped_open_circuit",
          detail: `cooling off, retry in ~${breaker.msUntilRetry()}ms`,
        });
        continue;
      }

      try {
        const response = await adapter.chat(req);
        breaker.recordSuccess();
        attempts.push({
          provider: id,
          outcome: "success",
          latencyMs: response.latencyMs,
        });
        return { response, chain: chain.name, attempts };
      } catch (err) {
        const ae =
          err instanceof AdapterError
            ? err
            : new AdapterError(String(err), "unknown", id);
        breaker.recordFailure(ae.retriable, ae.retryAfterMs);
        attempts.push({
          provider: id,
          outcome: "error",
          errorKind: ae.kind,
          detail: ae.message,
        });
        lastError = ae;

        // Non-retriable (auth / bad_request) → stop; failover won't help.
        if (!ae.retriable) {
          throw new RoutingError(
            `Chain "${chain.name}" stopped on non-retriable ${ae.kind} from "${id}".`,
            chain.name,
            attempts,
            ae,
          );
        }
        // Retriable → fall through to the next provider.
      }
    }

    throw new RoutingError(
      `Chain "${chain.name}" exhausted all providers without success.`,
      chain.name,
      attempts,
      lastError,
    );
  }
}
