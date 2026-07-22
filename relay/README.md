# Relay

A personal, transparent, **local-first** multi-provider AI gateway. Point any
OpenAI-compatible coding tool at one endpoint and route across the AI providers
**you** have your own accounts/keys for — with fallback, honest cost tracking,
and optional prompt compression.

> **Honest-auth only.** Relay uses exclusively official, provider-sanctioned
> auth: your own API keys, or standard OAuth apps you register yourself. It never
> embeds, extracts, or reuses another application's credentials, never spoofs
> TLS/HTTP fingerprints, and never tries to evade a provider's rate-limiting or
> abuse-detection. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full non-goals.

## Status

**v0.** Working end-to-end multi-provider round-trip: the OpenAI-compatible
adapter, the routing/fallback engine (ordered / round-robin / weighted
strategies) with a per-provider circuit breaker, an **encrypted key store** with
live-validated `relay add-provider`, **honest cost/quota tracking** (per-call $
from the provider's own token counts), an opt-in **prompt-compression
middleware**, a **read-only MCP status server** (stdio-first, allowlisted DTOs,
cannot expose keys), and a separate **read-only dashboard** (`dashboard/`).
Verified live — a rate-limited provider is skipped and the request fails over,
reported transparently in `x-relay-*` headers.

## Key storage & auth

Keys are added via the CLI, validated against the provider **before** they're
saved, and stored encrypted — never in plaintext, never in a config file.

```bash
relay add-provider openai            # prompts (hidden) for the key, validates, saves
relay add-provider groq --model llama-3.3-70b-versatile
relay add-provider my-vllm --base-url http://127.0.0.1:8000/v1
relay list-providers                 # what's configured + which backend
relay remove-provider groq           # deletes key + definition
```

- **Backends, in order:** the OS keychain (via optional `keytar`), else a
  **passphrase-encrypted file** (`.relay/secrets.enc.json`): scrypt-derived key,
  AES-256-GCM, unlocked by `RELAY_PASSPHRASE`. No passphrase → **no store, stated
  loudly** — Relay never degrades to plaintext. Force the file backend with
  `RELAY_KEY_BACKEND=file`.
- **Live validation:** `add-provider` makes a cheap `GET /models` call with the
  key first; a mistyped key fails immediately with a clear message and **nothing
  is saved**, instead of surfacing as a confusing 401 mid-route later.
- **The key never leaks into logs:** the attempt log and `x-relay-*` headers
  carry only provider/chain names and counts; the adapter additionally redacts
  its own key from any provider error body. Asserted by tests.
- The **provider definition** (id, base URL, default model — non-secret) is
  recorded in `relay.config.json`; only the key goes to the store.

## Quick start

```bash
cd relay
npm install
npm run test              # full suite (no network, no keys needed)
npm run build
npm run cli -- add-provider openai   # add YOUR key (validated, encrypted)
npm start                 # or: npm run dev
```

Then:

```bash
# gateway + dashboard together, one command (Ctrl-C stops both)
npm run cli -- dev

# health-check every configured provider
npm run cli -- doctor

# a chat round-trip through the gateway
curl -s http://127.0.0.1:8787/v1/chat \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini",
       "messages":[{"role":"user","content":"say hi"}]}'
```

> Prefer not to use the keychain/encrypted store yet? `cp .env.example .env` and
> put a key there — it's a dev fallback. `RELAY_PASSPHRASE` is required for the
> encrypted-file store (see [Key storage & auth](#key-storage--auth)).

## Endpoints (v0)

| Method | Path             | Purpose                                        |
| ------ | ---------------- | ---------------------------------------------- |
| POST   | `/v1/chat`       | Chat completion, routed w/ fallback; SSE when `"stream": true` |
| GET    | `/v1/providers`  | List configured providers + capabilities       |
| GET    | `/v1/usage`      | Tokens + $ per provider, and recent calls      |
| GET    | `/health`        | Per-provider connectivity/auth probe           |

## Architecture

```
client tool ─▶ Fastify server (/v1/chat)
                     │
                     ▼
            [routing/fallback engine]   ◀── strategies + circuit breaker
                     │
                     ▼
             adapter registry ──▶ ProviderAdapter (OpenAI-compatible, ...)
                     │
                     ▼
        provider HTTP API (your key, honest UA)
```

- **`src/adapters/types.ts`** — the `ProviderAdapter` contract + Zod-validated
  normalized request/response types + a normalized `AdapterError` with a
  `retriable` signal the router will key off of.
- **`src/adapters/openai-compatible.ts`** — the OpenAI-shaped adapter. Uses only
  user-supplied `baseUrl` + `apiKey`; sends an honest `relay-gateway/x.y.z` UA.
- **`src/adapters/anthropic.ts`** — the native Messages API adapter (see above).
  `src/registry.ts` dispatches on the provider's `kind`.
- **`src/adapters/sse.ts`** — shared SSE line parser; each adapter's `chatStream`
  interprets the payloads in its own provider's shape.
- **`src/routing/router.ts`** — chain resolution, strategy ordering, failover,
  and the transparent per-attempt log. **`src/routing/breaker.ts`** — the
  per-provider circuit breaker (Retry-After aware, 2-success close).
- **`src/secrets/`** — the key store: `store.ts` (backend selection + factory),
  `keychain.ts` (optional `keytar`), `encrypted-file.ts` (scrypt + AES-256-GCM).
- **`src/cost/pricing.ts`** — the editable pricing table + `computeCostUsd`
  (unknown model → null, never a guess; cached input priced at its own rate).
  **`src/cost/ledger.ts`** (NDJSON) + **`src/cost/sqlite-ledger.ts`** (indexed
  SQLite) behind one `UsageLedger` interface; **`src/cost/open-ledger.ts`**
  selects the backend and runs the one-way NDJSON→SQLite migration.
- **`src/compression/`** — opt-in prompt compression: `prose.ts` (the engine +
  the code/URL/JSON-preserving segmenter), `tokens.ts` (pre-send estimate),
  `index.ts` (engine registry + `compressMessages`).
- **`src/mcp/`** — the read-only MCP status server: `dto.ts` (allowlisted DTOs +
  field-by-field serializers), `tools.ts` (the four tools, SDK-independent),
  `context.ts` (safe data access), `server.ts` (stdio + localhost-only HTTP).
- **`dashboard/`** — a separate read-only React + Vite frontend (its own package
  and tests) that consumes only the REST surface.
- **`src/config/providers.ts`** — merges provider *definitions* and attaches keys
  from the store (env fallback). **`src/config/chains.ts`** — loads/validates
  `relay.config.json` (provider defs + routing topology). A SQLite seed slots in
  behind these next.
- **`src/server.ts`** — the Fastify gateway.
- **`src/cli/index.ts`** — `start` / `doctor` / `add-provider` / `list-providers`
  / `remove-provider`; **`src/cli/prompt.ts`** — hidden, argv-free key entry.

## Providers & the auth method each needs

Relay only connects a provider when **you** supply its credentials. Before
connecting an account, check that provider's own API terms (linked) so you can
verify compliance yourself.

| Provider          | Auth method              | Adapter            | Terms to check yourself                           |
| ----------------- | ------------------------ | ------------------ | -------------------------------------------------- |
| OpenAI            | Your API key (Bearer)    | openai-compatible  | https://openai.com/policies/usage-policies         |
| Anthropic         | Your API key (`x-api-key`) | **native**       | https://www.anthropic.com/legal/commercial-terms   |
| OpenAI-compatible | Your base URL + key      | openai-compatible  | (the specific vendor's API terms)                  |
| Groq              | Your API key             | openai-compatible  | https://groq.com/terms-of-use/                     |
| Mistral           | Your API key             | openai-compatible  | https://mistral.ai/terms/                          |
| Ollama (local)    | None (localhost)         | openai-compatible  | https://github.com/ollama/ollama                   |
| Gemini            | Your API key *(planned)* | —                  | https://ai.google.dev/gemini-api/terms             |

Pricing pages to verify against when editing `relay.pricing.json`:
[OpenAI](https://openai.com/api/pricing/) · [Anthropic](https://www.anthropic.com/pricing).

## The native Anthropic adapter

Anthropic does **not** go through an OpenAI-compatible shim. The Messages API is
a genuinely different shape, and translating through a shim either drops or
mangles the edge cases:

| Concern | OpenAI-compatible | Anthropic native (`src/adapters/anthropic.ts`) |
| --- | --- | --- |
| Auth | `Authorization: Bearer` | `x-api-key` + `anthropic-version: 2023-06-01` |
| System prompt | a message with `role: "system"` | a **top-level `system` field** — all system messages are hoisted and joined **in order**, so multi-turn system prompts survive |
| Message content | plain string | array of typed **content blocks** |
| `max_tokens` | optional | **required** (Relay defaults it rather than 400ing) |
| Stop reasons | `stop` / `length` | `end_turn` / `stop_sequence` / `tool_use` / `refusal` / `pause_turn`, normalized onto the shared vocabulary |
| Overload | — | **HTTP 529 `overloaded_error`**, which has no OpenAI equivalent |
| Usage | 3 token counts | **4** — cached input is split out from base input |

- **Error mapping is invisible to the router.** Anthropic's typed `error.type`
  is mapped onto the same retriable/non-retriable split as everything else, so
  the breaker and failover logic need no Anthropic-specific branches:
  `rate_limit_error`/429 and `overloaded_error`/529 and `api_error`/5xx are
  retriable; `authentication_error`, `permission_error`, and
  `invalid_request_error` **stop the chain**.
- **A refusal is not an error.** `stop_reason: "refusal"` is a successful 200; it
  surfaces as a `finishReason`, never as a retriable failure. Shopping a policy
  refusal to another provider would be evasion, which this project does not do.
- **Cost is read, not estimated.** The adapter reads Anthropic's real `usage`
  object, and `computeCostUsd` prices each component at its own rate — base
  input at 1×, a cache **write** at 1.25×, a cache **read** at 0.1×. Folding
  cached tokens into one input number would misstate cost in both directions.
- Raw `fetch` rather than the Anthropic SDK is deliberate: every adapter must
  produce the same normalized `AdapterError`, and the SDK's own retry layer
  (2 retries on 429/5xx by default) would retry *inside* the adapter, corrupting
  the circuit breaker's failure accounting and burning a `Retry-After` window it
  can't observe.

```bash
relay add-provider anthropic          # native adapter, validated live
relay add-provider my-claude-proxy --kind anthropic --base-url http://localhost:8000/v1
```

## Routing / fallback engine

Configured in `relay.config.json` (git-ignored; copy from
`relay.config.example.json`). Credentials stay in `.env`/keychain — this file
only owns chain topology, so it's safe to diff and comment (`.jsonc` supported).

```jsonc
{
  "chains": [
    { "name": "default", "strategy": "ordered",
      "providers": [{ "id": "openai" }, { "id": "ollama" }] }
  ]
}
```

- **Strategies:** `ordered` (primary + fallbacks), `round-robin` (rotate the
  primary each call), `weighted` (weighted primary pick, rest as fallbacks).
- **Failover:** on a `retriable` `AdapterError` (429 / 5xx / timeout / network) →
  advance to the next provider. `auth` and `bad_request` **stop the chain** — a
  401 is a config bug, and failing over would hide it behind a fallback.
- **Circuit breaker** (per provider): opens after 3 consecutive retriable
  failures; skips the provider while open; probes when the cooldown elapses;
  requires **2 consecutive successes** to fully close (anti-flap). Cooldown grows
  exponentially (1s → 2s → … → 60s), but a **`Retry-After` header is honored
  verbatim** — cooperative back-off, not evasion.
- **Transparency:** every attempt and every breaker state transition is logged;
  the served chain / provider / attempt-count come back as `x-relay-*` headers.

**Request routing selectors** on `POST /v1/chat`:
`"chain": "name"` routes through a named chain; `"provider": "id"` targets one
provider directly (no fallback); neither → the default (first) chain.

### Streaming (`"stream": true`)

`POST /v1/chat` with `"stream": true` responds with OpenAI-compatible
`text/event-stream` SSE — so existing chat UIs and SDKs that already speak
OpenAI streaming work unchanged when pointed at Relay. Each adapter speaks its
provider's native stream shape (OpenAI's `data:` chunks vs. Anthropic's named
events) and normalizes to the same delta/usage contract.

- **Failover has a hard, honest boundary.** The router can transparently fail
  over to the next provider on a connect-time error (bad key, 429, 5xx) because
  nothing has reached the client yet. Once the **first token** is emitted the
  provider is committed — a mid-stream failure surfaces as an SSE `error` event,
  never a silent retry that would duplicate or truncate output. Pre-commit
  failures come back as a normal JSON error (not a half-open stream).
- **Transparency rides the stream.** `x-relay-chain` / `x-relay-provider` /
  `x-relay-attempts` are sent as SSE response headers at commit; cost, the cache
  split, and attempt count — known only at end-of-stream — arrive in the final
  chunk's `x_relay` extension field, and that's where the ledger row is written.

```bash
curl -N -sX POST localhost:8787/v1/chat -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","stream":true,
       "messages":[{"role":"user","content":"say hi"}]}'
# data: {"choices":[{"delta":{"content":"Hi"}}]}
# ...
# data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{...},
#        "x_relay":{"provider":"openai","cost_usd":0.00045,...}}
# data: [DONE]
```

### Request selection

```bash
# fail over across the default chain
curl -sX POST localhost:8787/v1/chat -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'

# force a specific chain, or a single provider (no fallback)
#   ... -d '{"chain":"cheap-first", ...}'
#   ... -d '{"provider":"ollama", ...}'
```

## Cost & quota tracking

Every request is priced from the provider's **own reported token counts** and
logged to a local ledger — the point is visibility, so nothing is hidden or
fabricated.

```bash
relay usage                       # tokens + $ per provider (CLI)
curl -s localhost:8787/v1/usage   # same data as JSON, plus recent calls
# each POST /v1/chat also returns:  x-relay-cost-usd: 0.000450
```

- **Pricing** is a small, editable table (USD per 1M tokens, input/output). Seed
  values live in code; override any of them in `relay.pricing.json` (copy from
  `relay.pricing.example.json`). **Verify prices yourself** — they change, and the
  seeds are only a starting point.
- **Unknown models are reported as unknown, never guessed:** a model with no
  price entry records `costUsd: null` and is excluded from cost totals (flagged
  with `*` in `relay usage`), so the number you see is always real.
- **Local models** (a per-provider `"*"` price of 0) record zero cost, keeping
  totals honest without pretending they were paid calls.
- **Ledger** is **SQLite** at `.relay/usage.db` (git-ignored), with indexed
  `GROUP BY` aggregates instead of re-parsing a file per dashboard poll. It falls
  back to append-only NDJSON (`.relay/usage.ndjson`) if the native
  `better-sqlite3` module can't load; force NDJSON with `RELAY_LEDGER_BACKEND=ndjson`.
  On first run with SQLite available, an existing NDJSON ledger is **migrated in
  once** (only into an empty table, so re-runs can't double-import) and the
  original is renamed to `.migrated` rather than deleted. Both backends sit
  behind the same `UsageLedger` interface — nothing upstream changed. Unpriced
  requests keep a **NULL** cost (SQL `SUM` skips it), so an unknown cost never
  becomes a fabricated `$0`.

## Prompt compression (opt-in)

Off by default; enabled per request with the `x-relay-compress: <mode>` header.
Compression is applied to the normalized request **before** it's routed upstream,
and its before/after token estimate + engine name are logged in the same
per-request `routed` line as the routing decisions (and echoed as
`x-relay-compress-*` response headers) — never a silent side channel.

```bash
curl -sX POST localhost:8787/v1/chat -H 'content-type: application/json' \
  -H 'x-relay-compress: prose' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"..."}]}'
# response headers: x-relay-compress-engine: prose
#                   x-relay-compress-before: 812   (estimated tokens)
#                   x-relay-compress-after:  610
```

- **Guaranteed byte-for-byte preservation** of fenced code blocks, inline code,
  URLs, and structured JSON — only prose between them is shrunk. A dedicated test
  pins this with a fixture containing all four.
- **Pluggable engines** behind a tiny `compress(text) → {text, before, after}`
  contract; `prose` ships now, adding a mode later is a registry change.
- Token counts are **pre-send estimates** (no provider tokenizer available before
  the call); the ledger still records the provider's exact counts afterward.

## Dashboard (read-only)

A separate, self-contained React + Vite package under [`dashboard/`](./dashboard)
that reads the gateway's REST surface (`/health`, `/v1/providers`, `/v1/usage`)
and shows provider/chain status, usage & cost, and a recent-attempts feed. It is
**read-only and never handles keys** — no key-entry UI, and it carries its own
secret-canary test as an independent second consumer of the API.

Run **`relay dev`** to start the gateway and the dashboard's Vite dev server
together — the gateway's actual address is passed through as `RELAY_GATEWAY_URL`,
so the dashboard's dev proxy targets the right port even when `RELAY_PORT` is
non-default. (The dashboard can still be run on its own with `npm run dev` in
`dashboard/`.) See [`dashboard/README.md`](./dashboard/README.md).

## MCP status server (read-only)

Exposes Relay's status to a connected agent (Claude Code, Cursor, …) over MCP —
and is built so it **structurally cannot** leak stored keys.

```bash
relay mcp                       # stdio (primary; no network exposure at all)
relay mcp --http                # opt-in Streamable HTTP on 127.0.0.1:8788
relay mcp --http --host 0.0.0.0 --allow-external   # refused without the flag
```

**Tools (all read-only, `readOnlyHint: true`):**

| Tool                  | Returns                                                        |
| --------------------- | ------------------------------------------------------------- |
| `list_providers`      | id, label, enabled, health, circuit-breaker state, model ids  |
| `list_chains`         | chain name, strategy, ordered provider names                  |
| `get_usage`           | tokens + cost per provider and per chain                      |
| `get_recent_attempts` | recent requests: provider, chain, outcome, latency, cost      |

**Why it's safe by construction:**

- **Allowlist, not blocklist.** Every response is a read-only DTO built
  field-by-field by a serializer — internal config/ledger objects are never
  spread through with fields deleted. A secret field added to an internal model
  later simply isn't copied, so it can't leak. `baseUrl` (can embed a key),
  `apiKey`, auth headers, and request/response bodies are **never** in a DTO.
- **A permanent secret-canary test** feeds a realistic dummy key
  (`sk-test-fixture-do-not-use`) through every tool — in `apiKey` *and* embedded
  in the base URL — and asserts it appears in no output, nested or otherwise.
- **A tool-manifest snapshot test** pins the exact tool names and input fields,
  so adding a tool or field shows up in review instead of shipping silently.
- **Narrow surface:** no `add_provider` / `remove_provider`, no `get_config` or
  env access, no arbitrary store query. A write capability would be a separate,
  deliberate decision — not a door left open.
- **Safe binding:** stdio has no network surface; HTTP defaults to loopback and
  refuses any other interface without `--allow-external` (never `0.0.0.0` by
  default).

## Non-goals

Relay deliberately does **not** implement credential misappropriation,
fingerprint spoofing, rate-limit evasion, multi-account farming, or traffic
MITM. The full list — and why — is in [CONTRIBUTING.md](./CONTRIBUTING.md).
```
