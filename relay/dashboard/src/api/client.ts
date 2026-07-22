import type {
  HealthResponse,
  ProvidersResponse,
  UsageResponse,
} from "./types";

// Same-origin relative paths. In dev, Vite proxies these to the gateway on
// 127.0.0.1:8787 (see vite.config.ts). In any deployment the dashboard is
// served from the same origin as the gateway, or fronted by an equivalent proxy.
const HEALTH = "/health";
const PROVIDERS = "/v1/providers";
const USAGE = "/v1/usage";

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Request to ${path} failed: ${res.status} ${res.statusText}`);
  }
  // NOTE: we deliberately never console.log the parsed body — these payloads
  // are redacted by contract, but logging full bodies is still avoided as a
  // structural habit (secret discipline).
  return (await res.json()) as T;
}

export const fetchHealth = (signal?: AbortSignal) =>
  getJson<HealthResponse>(HEALTH, signal);

export const fetchProviders = (signal?: AbortSignal) =>
  getJson<ProvidersResponse>(PROVIDERS, signal);

export const fetchUsage = (signal?: AbortSignal) =>
  getJson<UsageResponse>(USAGE, signal);

export interface GatewaySnapshot {
  health: HealthResponse;
  providers: ProvidersResponse;
  usage: UsageResponse;
}

export async function fetchSnapshot(
  signal?: AbortSignal
): Promise<GatewaySnapshot> {
  const [health, providers, usage] = await Promise.all([
    fetchHealth(signal),
    fetchProviders(signal),
    fetchUsage(signal),
  ]);
  return { health, providers, usage };
}
