# Contributing to Relay

Relay is a personal, transparent, local-first AI gateway. Contributions are
welcome — but the project has hard **non-goals** that define what Relay is *not*,
and they are not negotiable. They exist so future contributors (human or AI)
don't quietly reintroduce them.

## Non-goals — do not implement, do not suggest workarounds for

1. **No embedding of any other application's OAuth `client_id`/`client_secret`.**
   Relay authenticates only with credentials the *user* enters, or OAuth apps the
   user registers themselves in a provider's developer console.
2. **No extracting, reusing, or "borrowing" credentials that belong to another
   application** — regardless of where they're published or how they're labeled
   (including files named "public"). If it's another app's secret, Relay doesn't
   touch it.
3. **No obfuscation/encoding of any credential to evade secret scanners.** If
   something looks like a secret, it lives in `.env` or the OS keychain, full stop.
4. **No TLS/JA3/JA4 fingerprint spoofing** and **no User-Agent impersonation** of
   another client. Adapters identify honestly as Relay.
5. **No MITM interception** of other applications' traffic.
6. **No features whose purpose is to evade a provider's rate-limiting,
   abuse-detection, or bot-detection.**
7. **No multi-account pooling/farming** of per-account free tiers, and **no quota
   sharing across multiple people's accounts** against a provider's per-seat
   terms. Assume one account per provider, entered honestly.

If a change would require any of the above to work, it doesn't belong in Relay.

## What good contributions look like

- New **provider adapters** that speak a provider's *documented* API with the
  user's own key, validated with Zod, covered by Vitest (stubbed fetch, no real
  keys or network in tests).
- Routing/observability/cost-tracking improvements that increase **transparency**.
- The token-compression middleware (plain text processing) — off by default,
  opt-in per request, with before/after token counts logged.

## Dev workflow

```bash
npm install
npm run typecheck
npm run test
```

Please keep the MCP server and any agent-facing surface **scoped so it cannot
read out stored API keys** — status/routing info only.
