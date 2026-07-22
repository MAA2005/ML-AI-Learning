#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderKind } from "../adapters/types.js";
import type { ProviderDef } from "../config/chains.js";
import {
  loadRelayConfig,
  removeProviderDefinition,
  upsertProviderDefinition,
} from "../config/chains.js";
import {
  KNOWN_PROVIDERS,
  loadServerSettings,
  resolveProviders,
} from "../config/providers.js";
import { openLedger } from "../cost/open-ledger.js";
import { StandaloneContext } from "../mcp/context.js";
import { startHttp, startStdio } from "../mcp/server.js";
import { buildAdapter, buildRegistry } from "../registry.js";
import { defaultBreakerStatePath } from "../routing/breaker-state.js";
import { start } from "../server.js";
import { openSecretStore } from "../secrets/store.js";
import { readSecret } from "./prompt.js";

/**
 * CLI. Subcommands:
 *   relay start                       Start the gateway server.
 *   relay doctor                      Live health-check every configured provider.
 *   relay add-provider <id> [flags]   Store a key (validated live) + record the
 *                                     provider definition.
 *   relay list-providers              List configured providers + key backend.
 *   relay remove-provider <id>        Delete a provider's key + definition.
 *
 * Flags for add-provider:
 *   --base-url <url>   Endpoint (required for unknown ids; templated for known).
 *   --model <name>     Default model for requests that omit one.
 */

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  switch (cmd) {
    case "start":
      await start();
      return;
    case "doctor":
      await doctor();
      return;
    case "add-provider":
      await addProvider(rest);
      return;
    case "list-providers":
      await listProviders();
      return;
    case "remove-provider":
      await removeProvider(rest);
      return;
    case "usage":
      await usage();
      return;
    case "mcp":
      await mcp(rest);
      return;
    case "dev":
      await dev();
      return;
    default:
      printHelp();
      return;
  }
}

function printHelp(): void {
  console.log(
    [
      "relay — personal transparent multi-provider AI gateway",
      "",
      "Usage:",
      "  relay start                     Start the gateway server",
      "  relay dev                       Start the gateway + dashboard dev server",
      "  relay doctor                    Health-check every configured provider",
      "  relay add-provider <id> [..]    Add a provider key (validated live)",
      "      --base-url <url>            Endpoint (needed for unknown ids)",
      "      --model <name>              Default model",
      "  relay list-providers            List configured providers",
      "  relay remove-provider <id>      Remove a provider's key + definition",
      "  relay usage                     Show tokens + $ spent per provider",
      "  relay mcp [--http]              Read-only status MCP server (stdio default)",
      "      --host <h> --port <n>       HTTP bind (localhost only unless --allow-external)",
      "",
      "The key is read from a hidden prompt (or piped stdin) — never passed as an",
      "argument, so it can't leak into shell history or the process list.",
    ].join("\n"),
  );
}

/**
 * Minimal flag parser. A `--flag` whose next token is another `--flag` (or the
 * end of args) is a boolean (value ""); otherwise it consumes the next token as
 * its value. Supports `--flag=value` too. This keeps boolean flags like `--http`
 * from swallowing the following `--host` as their value.
 */
function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[a.slice(2)] = ""; // boolean flag
      } else {
        flags[a.slice(2)] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/** Open the store, requiring it (add/remove must persist). Exits with a clear
 *  message if neither keychain nor passphrase is available. */
async function requireStore() {
  try {
    const store = await openSecretStore({ required: true });
    return store!;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function addProvider(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const id = positional[0];
  if (!id) {
    console.error("Usage: relay add-provider <id> [--base-url <url>] [--model <name>]");
    process.exit(1);
  }

  const known = KNOWN_PROVIDERS[id];
  const baseUrl = flags["base-url"] ?? known?.baseUrl;
  if (!baseUrl) {
    console.error(
      `Unknown provider "${id}". Pass --base-url <url> (its OpenAI-compatible endpoint), ` +
        `e.g. https://api.example.com/v1`,
    );
    process.exit(1);
  }
  const defaultModel = flags["model"] ?? known?.defaultModel;
  const label = known?.label ?? id;
  // --kind overrides the template (needed for a self-hosted Anthropic-shaped
  // endpoint, or an unknown id that speaks the Messages API).
  const kindFlag = flags["kind"];
  if (kindFlag && kindFlag !== "anthropic" && kindFlag !== "openai-compatible") {
    console.error(`Unknown --kind "${kindFlag}". Use "anthropic" or "openai-compatible".`);
    process.exit(1);
  }
  const kind = (kindFlag as ProviderKind | undefined) ?? known?.kind;

  const store = await requireStore();

  // Read the key without echoing it or putting it in argv.
  const key = (await readSecret(`Enter API key for "${id}": `)).trim();
  if (!key) {
    console.error("No key entered — aborting. Nothing was saved.");
    process.exit(1);
  }

  // Live validation BEFORE saving: a mistyped key fails here, clearly, instead
  // of surfacing as a confusing 401 during routing later.
  // Probe with the SAME adapter the gateway will use — an Anthropic key against
  // an OpenAI-shaped probe would fail validation for the wrong reason.
  process.stdout.write(`Validating against ${baseUrl} ... `);
  const probe = buildAdapter({ id, kind, baseUrl, apiKey: key, defaultModel });
  const health = await probe.health();
  if (!health.ok) {
    console.log("FAILED");
    console.error(
      `Could not validate the key for "${id}": ${health.detail ?? "unknown error"}.\n` +
        `Nothing was saved. Check the key and --base-url, then try again.`,
    );
    process.exit(1);
  }
  console.log(`OK (${health.latencyMs}ms)`);

  await store.set(id, key);
  const def: ProviderDef = { id, label, kind, baseUrl, defaultModel };
  const path = upsertProviderDefinition(def);
  console.log(
    `Saved "${id}": key in ${store.backend}, definition in ${path}.\n` +
      `Add it to a chain in that file to use it for fallback routing.`,
  );
}

async function listProviders(): Promise<void> {
  const store = await openSecretStore().catch(() => null);
  const configFile = loadRelayConfig();
  const providers = await resolveProviders({ configFile, store });
  console.log(`Key backend: ${store?.backend ?? "none (env only)"}`);
  if (providers.length === 0) {
    console.log("No providers configured.");
    return;
  }
  for (const p of providers) {
    const keyState = p.apiKey ? "key set" : "keyless (loopback)";
    console.log(`  ${p.id.padEnd(16)} ${p.baseUrl}  [${keyState}]`);
  }
}

async function removeProvider(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error("Usage: relay remove-provider <id>");
    process.exit(1);
  }
  const store = await requireStore();
  await store.delete(id);
  const removedDef = removeProviderDefinition(id);
  console.log(
    `Removed "${id}": key deleted from ${store.backend}` +
      (removedDef ? " and definition removed from config." : " (no config definition found)."),
  );
}

async function usage(): Promise<void> {
  const { ledger } = await openLedger();
  const rows = ledger.summaryByProvider();
  if (rows.length === 0) {
    console.log("No usage recorded yet.");
    return;
  }
  console.log(
    `${"provider".padEnd(16)} ${"reqs".padStart(6)} ${"tokens".padStart(12)} ${"cost (USD)".padStart(12)}`,
  );
  let totalCost = 0;
  let anyUnknown = false;
  for (const r of rows) {
    totalCost += r.costUsd;
    if (r.unknownCostRequests > 0) anyUnknown = true;
    const cost = r.unknownCostRequests > 0 ? `${r.costUsd.toFixed(4)}*` : r.costUsd.toFixed(4);
    console.log(
      `${r.provider.padEnd(16)} ${String(r.requests).padStart(6)} ${String(
        r.totalTokens,
      ).padStart(12)} ${cost.padStart(12)}`,
    );
  }
  console.log(`${"TOTAL".padEnd(16)} ${"".padStart(6)} ${"".padStart(12)} ${totalCost.toFixed(4).padStart(12)}`);
  if (anyUnknown) {
    console.log("\n* some requests had no pricing entry and are excluded from cost.");
    console.log("  Add prices in relay.pricing.json (see relay.pricing.example.json).");
  }
}

/** Resolve the sibling `dashboard/` directory from the compiled/loaded CLI. */
function dashboardDir(): string {
  // dist/cli/index.js or src/cli/index.ts → up two levels to the package root.
  const cliDir = dirname(fileURLToPath(import.meta.url));
  return resolve(cliDir, "..", "..", "dashboard");
}

/**
 * `relay dev` — run the gateway and the dashboard's Vite dev server together.
 *
 * The gateway starts in THIS process; the dashboard runs as a child `npm run
 * dev`, with RELAY_GATEWAY_URL set to the gateway's actual address so the Vite
 * proxy targets the right port even when RELAY_PORT is non-default. Ctrl-C tears
 * down both.
 */
async function dev(): Promise<void> {
  const dir = dashboardDir();
  if (!existsSync(join(dir, "package.json"))) {
    console.error(`Dashboard package not found at ${dir}.`);
    process.exit(1);
  }
  if (!existsSync(join(dir, "node_modules"))) {
    console.error(
      `Dashboard dependencies are not installed. Run:\n  (cd "${dir}" && npm install)`,
    );
    process.exit(1);
  }

  const settings = loadServerSettings();
  const gatewayUrl = `http://127.0.0.1:${settings.port}`;

  // Start the gateway first so the dashboard proxy has a live target.
  await start();
  process.stderr.write(`relay dev: gateway on ${gatewayUrl}; starting dashboard...\n`);

  // `npm` is a shim (npm.cmd on Windows), which Node refuses to spawn without a
  // shell. Use shell:true with the command as ONE fixed string (no args array):
  // that both satisfies Windows and avoids the DEP0190 arg-escaping warning. The
  // command is a hard-coded literal, so there is no injection surface.
  const child = spawn("npm run dev", {
    cwd: dir,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, RELAY_GATEWAY_URL: gatewayUrl },
  });

  let shuttingDown = false;
  const shutdown = (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    child.kill();
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  // Without an error handler a spawn failure (ENOENT/EINVAL) is an uncaught
  // exception that takes down the gateway too — surface it cleanly instead.
  child.on("error", (err) => {
    process.stderr.write(
      `relay dev: could not start the dashboard (${err.message}). ` +
        `Is npm on PATH and are the dashboard deps installed?\n`,
    );
    shutdown(1);
  });
  child.on("exit", (code) => {
    process.stderr.write(`relay dev: dashboard exited (${code ?? 0}); shutting down.\n`);
    shutdown(code ?? 0);
  });
}

async function mcp(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const useHttp = "http" in flags || "host" in flags || "port" in flags;

  const store = await openSecretStore().catch(() => null);
  const configFile = loadRelayConfig();
  const { ledger } = await openLedger();
  const ctx = new StandaloneContext({
    configFile,
    store,
    ledger,
    breakerStatePath: defaultBreakerStatePath(),
  });

  if (useHttp) {
    await startHttp(ctx, {
      host: flags["host"],
      port: flags["port"] ? Number(flags["port"]) : undefined,
      allowExternal: "allow-external" in flags,
    });
  } else {
    await startStdio(ctx);
  }
}

async function doctor(): Promise<void> {
  const store = await openSecretStore().catch(() => null);
  const configFile = loadRelayConfig();
  const providers = await resolveProviders({ configFile, store });
  loadServerSettings(); // validates host/port env early

  console.log(`Key backend: ${store?.backend ?? "none (env only)"}`);
  if (providers.length === 0) {
    console.log(
      "No providers configured. Run `relay add-provider <id>` or set keys in .env.",
    );
    process.exitCode = 1;
    return;
  }
  const registry = buildRegistry(providers);
  let anyFail = false;
  for (const [id, adapter] of registry) {
    const h = await adapter.health();
    const mark = h.ok ? "OK " : "FAIL";
    console.log(
      `[${mark}] ${id.padEnd(16)} ${h.latencyMs}ms${h.detail ? `  ${h.detail}` : ""}`,
    );
    if (!h.ok) anyFail = true;
  }
  process.exitCode = anyFail ? 1 : 0;
}

main().catch((err) => {
  // Clean message for expected CLI errors; full detail only if it's not an Error.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
