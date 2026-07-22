/**
 * Per-provider circuit breaker.
 *
 * This is cooperative back-off, NOT rate-limit evasion: when a provider keeps
 * failing (esp. 429s), we stop sending it traffic for a cooling-off window,
 * then probe before fully resuming. The point is to be a well-behaved client
 * that backs off cleanly — the opposite of hammering.
 *
 *   closed     — normal; requests flow.
 *   open        — recent failures tripped it; requests are skipped until cooldown.
 *   half-open   — cooldown elapsed; probes are allowed one at a time. It takes
 *                 `halfOpenSuccessesToClose` consecutive successes to fully
 *                 close (anti-flap); any probe failure re-opens it.
 *
 * Cooldown policy: if a rate-limit failure carried a Retry-After hint, honor it
 * verbatim; otherwise grow the window exponentially (base → 2× → … → max).
 * Every state transition is emitted via the `onTransition` hook so the breaker's
 * behavior is as visible as the routing decisions.
 */

export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerOptions {
  /** Consecutive retriable failures that trip the breaker open. */
  failureThreshold: number;
  /** First cooldown after opening, ms. */
  baseCooldownMs: number;
  /** Ceiling for the exponentially-growing cooldown, ms (Retry-After may exceed it). */
  maxCooldownMs: number;
  /** Consecutive half-open successes required to fully close. */
  halfOpenSuccessesToClose: number;
  /** Injectable clock for testing; defaults to Date.now. */
  now: () => number;
  /** Called on every state change with (from, to, humanReason). */
  onTransition?: (from: BreakerState, to: BreakerState, reason: string) => void;
}

export const DEFAULT_BREAKER: Omit<BreakerOptions, "now" | "onTransition"> = {
  failureThreshold: 3,
  baseCooldownMs: 1_000,
  maxCooldownMs: 60_000,
  halfOpenSuccessesToClose: 2,
};

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private halfOpenSuccesses = 0;
  private probeOutstanding = false;
  private openedAt = 0;
  private cooldownMs: number;
  private readonly opts: BreakerOptions;

  constructor(options: Partial<BreakerOptions> = {}) {
    this.opts = { ...DEFAULT_BREAKER, now: Date.now, ...options };
    this.cooldownMs = this.opts.baseCooldownMs;
  }

  get currentState(): BreakerState {
    return this.state;
  }

  private transition(to: BreakerState, reason: string): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.opts.onTransition?.(from, to, reason);
  }

  /**
   * Whether a request may be attempted now. Side effects: an `open` breaker past
   * its cooldown moves to `half-open`, and a granted probe is reserved so no two
   * probes run at once.
   */
  canAttempt(): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      const elapsed = this.opts.now() - this.openedAt;
      if (elapsed >= this.cooldownMs) {
        this.halfOpenSuccesses = 0;
        this.probeOutstanding = true;
        this.transition("half-open", "cooldown elapsed, probing");
        return true;
      }
      return false;
    }

    // half-open: allow a probe only if one isn't already outstanding.
    if (this.probeOutstanding) return false;
    this.probeOutstanding = true;
    return true;
  }

  /** Milliseconds until the next probe is allowed (0 if attemptable now). */
  msUntilRetry(): number {
    if (this.state !== "open") return 0;
    return Math.max(0, this.cooldownMs - (this.opts.now() - this.openedAt));
  }

  recordSuccess(): void {
    if (this.state === "half-open") {
      this.probeOutstanding = false;
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses >= this.opts.halfOpenSuccessesToClose) {
        this.consecutiveFailures = 0;
        this.halfOpenSuccesses = 0;
        this.cooldownMs = this.opts.baseCooldownMs; // reset backoff
        this.transition(
          "closed",
          `recovered: ${this.opts.halfOpenSuccessesToClose} consecutive successes`,
        );
      }
      // else: stay half-open; the next attempt is allowed to probe again.
      return;
    }
    // closed: a success clears any partial failure streak.
    this.consecutiveFailures = 0;
  }

  /**
   * Record a failed attempt. Only *retriable* failures (429/5xx/timeout/network)
   * count toward tripping — an auth error or bad request is our problem, not the
   * provider being unhealthy, so it must not open the circuit. `retryAfterMs`, if
   * present, overrides the computed cooldown.
   */
  recordFailure(retriable: boolean, retryAfterMs?: number): void {
    if (this.state === "half-open") {
      this.probeOutstanding = false;
      if (!retriable) return; // client-side error during a probe; don't penalize
      this.openWith(retryAfterMs, /*doubling*/ true, "probe failed");
      return;
    }

    if (!retriable) return;

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.opts.failureThreshold) {
      this.consecutiveFailures = 0;
      this.openWith(
        retryAfterMs,
        /*doubling*/ false,
        `tripped: ${this.opts.failureThreshold} consecutive retriable failures`,
      );
    }
  }

  private openWith(
    retryAfterMs: number | undefined,
    doubling: boolean,
    reason: string,
  ): void {
    if (retryAfterMs !== undefined) {
      // Honor the provider's explicit hint verbatim (it knows best).
      this.cooldownMs = Math.max(0, retryAfterMs);
      reason += ` (Retry-After ${this.cooldownMs}ms)`;
    } else if (doubling) {
      this.cooldownMs = Math.min(this.cooldownMs * 2, this.opts.maxCooldownMs);
    } else {
      // First trip from closed: start at the base window.
      this.cooldownMs = Math.min(this.cooldownMs, this.opts.maxCooldownMs);
    }
    this.halfOpenSuccesses = 0;
    this.probeOutstanding = false;
    this.openedAt = this.opts.now();
    this.transition("open", reason);
  }
}
