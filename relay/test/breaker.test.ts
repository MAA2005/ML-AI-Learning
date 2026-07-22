import { describe, expect, it } from "vitest";
import { CircuitBreaker, type BreakerState } from "../src/routing/breaker.js";

/**
 * Deterministic breaker tests using an injected clock. No timers, no sleeps.
 */

function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("CircuitBreaker", () => {
  it("opens after the configured number of consecutive retriable failures", () => {
    const clock = makeClock();
    const b = new CircuitBreaker({ failureThreshold: 3, now: clock.now });

    b.recordFailure(true);
    b.recordFailure(true);
    expect(b.currentState).toBe("closed");
    expect(b.canAttempt()).toBe(true);

    b.recordFailure(true); // third → trip
    expect(b.currentState).toBe("open");
    expect(b.canAttempt()).toBe(false);
  });

  it("does NOT count non-retriable failures toward opening", () => {
    const b = new CircuitBreaker({ failureThreshold: 2, now: makeClock().now });
    b.recordFailure(false); // auth/bad_request — ignored
    b.recordFailure(false);
    b.recordFailure(false);
    expect(b.currentState).toBe("closed");
  });

  it("moves open → half-open only after the cooldown elapses", () => {
    const clock = makeClock();
    const b = new CircuitBreaker({
      failureThreshold: 1,
      baseCooldownMs: 1_000,
      now: clock.now,
    });
    b.recordFailure(true); // open, cooldown 1000ms
    expect(b.canAttempt()).toBe(false);

    clock.advance(999);
    expect(b.canAttempt()).toBe(false);

    clock.advance(1);
    expect(b.canAttempt()).toBe(true); // probe granted
    expect(b.currentState).toBe("half-open");
  });

  it("requires TWO consecutive half-open successes to close (anti-flap)", () => {
    const clock = makeClock();
    const b = new CircuitBreaker({
      failureThreshold: 1,
      baseCooldownMs: 1_000,
      halfOpenSuccessesToClose: 2,
      now: clock.now,
    });
    b.recordFailure(true); // open
    clock.advance(1_000);

    expect(b.canAttempt()).toBe(true); // probe 1
    b.recordSuccess();
    expect(b.currentState).toBe("half-open"); // one success is not enough

    expect(b.canAttempt()).toBe(true); // probe 2
    b.recordSuccess();
    expect(b.currentState).toBe("closed"); // two in a row → closed
  });

  it("flapping: a half-open success then failure re-opens (does NOT close on one)", () => {
    const clock = makeClock();
    const b = new CircuitBreaker({
      failureThreshold: 1,
      baseCooldownMs: 1_000,
      maxCooldownMs: 60_000,
      halfOpenSuccessesToClose: 2,
      now: clock.now,
    });
    b.recordFailure(true); // open @ 1000ms cooldown
    clock.advance(1_000);

    expect(b.canAttempt()).toBe(true); // probe 1 succeeds
    b.recordSuccess();
    expect(b.currentState).toBe("half-open");

    expect(b.canAttempt()).toBe(true); // probe 2 fails
    b.recordFailure(true);
    expect(b.currentState).toBe("open"); // re-opened, not closed

    // Backoff doubled: 1000 → 2000ms.
    clock.advance(1_000);
    expect(b.canAttempt()).toBe(false);
    clock.advance(1_000);
    expect(b.canAttempt()).toBe(true);
  });

  it("honors Retry-After for the cooldown instead of exponential backoff", () => {
    const clock = makeClock();
    const b = new CircuitBreaker({
      failureThreshold: 1,
      baseCooldownMs: 1_000,
      maxCooldownMs: 60_000,
      now: clock.now,
    });

    // A rate-limit failure carrying Retry-After = 5s should set a 5s cooldown,
    // NOT the 1s base.
    b.recordFailure(true, 5_000);
    expect(b.currentState).toBe("open");

    clock.advance(1_000);
    expect(b.canAttempt()).toBe(false); // base backoff would have fired here
    clock.advance(4_000);
    expect(b.canAttempt()).toBe(true); // exactly at the 5s Retry-After
  });

  it("emits a transition for every state change", () => {
    const clock = makeClock();
    const seen: Array<[BreakerState, BreakerState]> = [];
    const b = new CircuitBreaker({
      failureThreshold: 1,
      baseCooldownMs: 1_000,
      halfOpenSuccessesToClose: 1,
      now: clock.now,
      onTransition: (from, to) => seen.push([from, to]),
    });

    b.recordFailure(true); // closed → open
    clock.advance(1_000);
    b.canAttempt(); // open → half-open
    b.recordSuccess(); // half-open → closed

    expect(seen).toEqual([
      ["closed", "open"],
      ["open", "half-open"],
      ["half-open", "closed"],
    ]);
  });
});
