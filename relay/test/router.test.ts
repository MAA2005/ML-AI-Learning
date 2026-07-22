import { describe, expect, it } from "vitest";
import {
  AdapterError,
  type Capability,
  type ChatRequest,
  type ChatResponse,
  type HealthResult,
  type ProviderAdapter,
} from "../src/adapters/types.js";
import type { Chain } from "../src/config/chains.js";
import { Router, RoutingError } from "../src/routing/router.js";

/**
 * Router tests drive a scripted fake adapter — no network. Each fake returns a
 * pre-programmed sequence of successes/errors; the last scripted action repeats,
 * so "always fails" or "always ok" is just a one-element script.
 */

type Action = ChatResponse | AdapterError;

class FakeAdapter implements ProviderAdapter {
  readonly label: string;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(["chat"]);
  callCount = 0;

  constructor(
    readonly id: string,
    private readonly actions: Action[],
  ) {
    this.label = id;
  }

  async health(): Promise<HealthResult> {
    return { ok: true, latencyMs: 0 };
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    const idx = Math.min(this.callCount, this.actions.length - 1);
    this.callCount++;
    const action = this.actions[idx]!;
    if (action instanceof AdapterError) throw action;
    return action;
  }
}

const REQ: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };

function ok(provider: string, content = "ok"): ChatResponse {
  return { provider, model: "m", content, finishReason: "stop", usage: null, latencyMs: 1 };
}

function err(
  kind: AdapterError["kind"],
  provider: string,
  retryAfterMs?: number,
): AdapterError {
  return new AdapterError(
    `${kind} from ${provider}`,
    kind,
    provider,
    undefined,
    retryAfterMs !== undefined ? { retryAfterMs } : undefined,
  );
}

function chain(strategy: Chain["strategy"], providers: Chain["providers"]): Chain {
  return { name: "test", strategy, providers };
}

function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("Router", () => {
  it("fails over on a retriable error to the next provider", async () => {
    const registry = new Map<string, ProviderAdapter>([
      ["a", new FakeAdapter("a", [err("rate_limit", "a")])],
      ["b", new FakeAdapter("b", [ok("b")])],
    ]);
    const router = new Router(registry, []);
    const result = await router.run(REQ, chain("ordered", [{ id: "a" }, { id: "b" }]));

    expect(result.response.provider).toBe("b");
    expect(result.attempts.map((a) => a.outcome)).toEqual(["error", "success"]);
    expect(result.attempts[0]?.errorKind).toBe("rate_limit");
  });

  it("stops the chain immediately on a non-retriable auth error", async () => {
    const b = new FakeAdapter("b", [ok("b")]);
    const registry = new Map<string, ProviderAdapter>([
      ["a", new FakeAdapter("a", [err("auth", "a")])],
      ["b", b],
    ]);
    const router = new Router(registry, []);

    await expect(
      router.run(REQ, chain("ordered", [{ id: "a" }, { id: "b" }])),
    ).rejects.toMatchObject({ name: "RoutingError" });

    // b must never be tried — failing over on a 401 would hide the config bug.
    expect(b.callCount).toBe(0);
  });

  it("stops the chain on a non-retriable bad_request", async () => {
    const registry = new Map<string, ProviderAdapter>([
      ["a", new FakeAdapter("a", [err("bad_request", "a")])],
      ["b", new FakeAdapter("b", [ok("b")])],
    ]);
    const router = new Router(registry, []);
    try {
      await router.run(REQ, chain("ordered", [{ id: "a" }, { id: "b" }]));
      expect.unreachable();
    } catch (e) {
      const re = e as RoutingError;
      expect(re.lastError?.kind).toBe("bad_request");
      expect(re.attempts).toHaveLength(1);
    }
  });

  it("throws RoutingError with all attempts when every provider fails", async () => {
    const registry = new Map<string, ProviderAdapter>([
      ["a", new FakeAdapter("a", [err("server", "a")])],
      ["b", new FakeAdapter("b", [err("timeout", "b")])],
    ]);
    const router = new Router(registry, []);
    try {
      await router.run(REQ, chain("ordered", [{ id: "a" }, { id: "b" }]));
      expect.unreachable();
    } catch (e) {
      const re = e as RoutingError;
      expect(re.attempts.map((a) => a.outcome)).toEqual(["error", "error"]);
    }
  });

  it("opens a provider's breaker, skips it, then probes it after cooldown", async () => {
    const clock = makeClock();
    const a = new FakeAdapter("a", [err("rate_limit", "a"), err("rate_limit", "a"), ok("a")]);
    const registry = new Map<string, ProviderAdapter>([
      ["a", a],
      ["b", new FakeAdapter("b", [ok("b")])],
    ]);
    const router = new Router(registry, [], {
      breaker: {
        failureThreshold: 2,
        baseCooldownMs: 1_000,
        halfOpenSuccessesToClose: 1,
        now: clock.now,
      },
    });
    const c = chain("ordered", [{ id: "a" }, { id: "b" }]);

    // Call 1 + 2: a errors (fail 1, then fail 2 → opens), b serves both.
    const r1 = await router.run(REQ, c);
    expect(r1.response.provider).toBe("b");
    const r2 = await router.run(REQ, c);
    expect(r2.response.provider).toBe("b");

    // Call 3: a's circuit is open → skipped without touching the adapter.
    const r3 = await router.run(REQ, c);
    expect(r3.response.provider).toBe("b");
    expect(r3.attempts[0]).toMatchObject({ provider: "a", outcome: "skipped_open_circuit" });
    expect(a.callCount).toBe(2); // never called while open

    // After cooldown, a is probed and now succeeds → routed back to a.
    clock.advance(1_000);
    const r4 = await router.run(REQ, c);
    expect(r4.response.provider).toBe("a");
    expect(a.callCount).toBe(3);
  });

  it("round-robin rotates the primary across calls", async () => {
    const registry = new Map<string, ProviderAdapter>([
      ["a", new FakeAdapter("a", [ok("a")])],
      ["b", new FakeAdapter("b", [ok("b")])],
    ]);
    const router = new Router(registry, []);
    const c = chain("round-robin", [{ id: "a" }, { id: "b" }]);

    expect((await router.run(REQ, c)).response.provider).toBe("a");
    expect((await router.run(REQ, c)).response.provider).toBe("b");
    expect((await router.run(REQ, c)).response.provider).toBe("a");
  });

  it("weighted uses the injected rng to pick the primary", async () => {
    const registry = new Map<string, ProviderAdapter>([
      ["a", new FakeAdapter("a", [ok("a")])],
      ["b", new FakeAdapter("b", [ok("b")])],
    ]);
    const c = chain("weighted", [
      { id: "a", weight: 1 },
      { id: "b", weight: 3 },
    ]);

    // total weight 4; rng 0.9 → 3.6 lands in b's band.
    const highRng = new Router(registry, [], { rng: () => 0.9 });
    expect((await highRng.run(REQ, c)).response.provider).toBe("b");

    // rng 0.1 → 0.4 lands in a's band.
    const lowRng = new Router(registry, [], { rng: () => 0.1 });
    expect((await lowRng.run(REQ, c)).response.provider).toBe("a");
  });

  it("a direct single-provider chain does not fall back", async () => {
    const b = new FakeAdapter("b", [ok("b")]);
    const registry = new Map<string, ProviderAdapter>([
      ["a", new FakeAdapter("a", [err("server", "a")])],
      ["b", b],
    ]);
    const router = new Router(registry, []);
    await expect(
      router.run(REQ, router.singleProviderChain("a")),
    ).rejects.toMatchObject({ name: "RoutingError" });
    expect(b.callCount).toBe(0);
  });
});
