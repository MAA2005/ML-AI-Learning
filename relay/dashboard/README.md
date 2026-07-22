# Relay Dashboard

A small, self-contained, **read-only** monitoring dashboard for the
[Relay](../) local-first multi-provider AI gateway. React 18 + Vite 5 +
TypeScript.

It is a second, independent consumer of the gateway's stable REST contract —
it imports **no** backend code and talks to the gateway only over HTTP.

## Run

Easiest — from the gateway package, launch both together:

```bash
cd ..            # into relay/
npm run cli -- dev
```

`relay dev` starts the gateway and this Vite dev server in one command and passes
the gateway's real address through as `RELAY_GATEWAY_URL`, so the proxy targets
the right port even when `RELAY_PORT` is non-default. Ctrl-C stops both.

Or run the dashboard on its own (expects the gateway already up):

```bash
npm install
npm run dev
```

Then open the printed URL (default http://localhost:5173).

Vite's dev server proxies `/health` and `/v1/*` to the gateway (see
`vite.config.ts`) so the browser calls everything same-origin. The proxy target
is `RELAY_GATEWAY_URL`, else `http://127.0.0.1:${RELAY_PORT}`, defaulting to
**http://127.0.0.1:8787**.

## What it shows

- **Providers & chains** — from `GET /v1/providers` + `GET /health`: each
  provider's id, label, capabilities, live health (ok/fail + latency) and the
  gateway's key-store backend. Chains render only if `/v1/usage` includes
  `byChain`.
- **Usage & cost** — from `GET /v1/usage` `byProvider`: requests, tokens and
  USD cost per provider with a clear total. Requests the gateway could not
  price are flagged with a `*` footnote and **never** given a fabricated cost.
- **Recent attempts** — from `GET /v1/usage` `recent`: a reverse-chronological
  feed (timestamp, provider, chain, outcome, latency, cost).

It polls those three GETs every ~7s. It makes **no** other backend calls.

## Security: read-only, never handles keys

This dashboard is monitoring-only and by design never handles API keys:

- There is **no** key-entry UI. No endpoint it calls returns key material, so
  it never displays one. Manage providers/keys with the `relay add-provider`
  CLI instead.
- Full response bodies are never logged to the console.
- A **secret-canary** test (`src/test/canary.test.ts`) asserts the dummy key
  `sk-test-fixture-do-not-use` never appears in any payload the dashboard
  consumes or in the rendered DOM. See that file's header comment for why the
  fixture-response form was chosen over standing up the real gateway.

## Scripts

| Command                   | Purpose                                     |
| ------------------------- | ------------------------------------------- |
| `relay dev` (in `relay/`) | Start the gateway **and** this dev server   |
| `npm run dev`             | Start the Vite dev server alone             |
| `npm run build`           | Type-check + production build               |
| `npm run typecheck`       | `tsc --noEmit`                              |
| `npm test`                | Run the Vitest suite (`run`)                |
