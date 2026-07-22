import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSnapshot, type GatewaySnapshot } from "../api/client";

export interface GatewayState {
  data: GatewaySnapshot | null;
  error: string | null;
  loading: boolean;
  lastUpdated: number | null;
  refresh: () => void;
}

/**
 * Polls the three read-only gateway endpoints on an interval. Keeps the last
 * good snapshot on transient errors so the UI does not flash empty.
 */
export function useGatewayData(intervalMs = 7000): GatewayState {
  const [data, setData] = useState<GatewaySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const snap = await fetchSnapshot(ctrl.signal);
      if (ctrl.signal.aborted) return;
      setData(snap);
      setError(null);
      setLastUpdated(Date.now());
    } catch (e) {
      if (ctrl.signal.aborted) return;
      // Message only — never the response body.
      setError(e instanceof Error ? e.message : "Failed to reach gateway");
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, intervalMs);
    return () => {
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [load, intervalMs]);

  return { data, error, loading, lastUpdated, refresh: load };
}
