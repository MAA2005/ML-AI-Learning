// Presentation helpers. Kept pure so they can be unit-tested.

/** Format a USD cost. null means "no known price" and renders as an em dash. */
export function formatUsd(value: number | null | undefined): string {
  if (value == null) return "—";
  // Costs are often tiny (sub-cent). Show up to 4 decimals but trim.
  if (value === 0) return "$0.00";
  const abs = Math.abs(value);
  const decimals = abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
  return `$${value.toFixed(decimals)}`;
}

export function formatTokens(value: number | null | undefined): string {
  if (value == null) return "—";
  return value.toLocaleString("en-US");
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return `${Math.round(ms)} ms`;
}

export function formatTime(tsMs: number): string {
  const d = new Date(tsMs);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatRelative(tsMs: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - tsMs);
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}
