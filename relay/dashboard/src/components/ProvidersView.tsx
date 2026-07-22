import { mergeProviders } from "../api/selectors";
import type { HealthResponse, ProvidersResponse, Summary } from "../api/types";
import { formatLatency } from "../utils/format";
import { StatusBadge } from "./StatusBadge";

interface Props {
  providers: ProvidersResponse | null;
  health: HealthResponse | null;
  byChain?: Summary[];
}

const KEY_STORE_LABEL: Record<string, string> = {
  keychain: "OS keychain",
  "encrypted-file": "Encrypted file",
  none: "No key store",
};

export function ProvidersView({ providers, health, byChain }: Props) {
  const merged = mergeProviders(providers?.providers, health ?? undefined);
  const keyStore = health?.keyStore;
  const chains = byChain ?? [];

  return (
    <section className="view" aria-labelledby="providers-heading">
      <div className="view__head">
        <h2 id="providers-heading">Providers &amp; chains</h2>
        {keyStore && (
          <span className="pill" title="Where the gateway stores API keys">
            Key store: {KEY_STORE_LABEL[keyStore] ?? keyStore}
          </span>
        )}
      </div>

      {merged.length === 0 ? (
        <p className="empty">No providers reported by the gateway.</p>
      ) : (
        <div className="card-grid">
          {merged.map((p) => (
            <article key={p.id} className="card">
              <div className="card__head">
                <div>
                  <h3 className="card__title">{p.label}</h3>
                  <code className="card__sub">{p.id}</code>
                </div>
                <StatusBadge ok={p.health.ok} known={p.health.known} />
              </div>

              <dl className="kv">
                <div>
                  <dt>Latency</dt>
                  <dd>{formatLatency(p.health.latencyMs)}</dd>
                </div>
                {p.health.detail && (
                  <div>
                    <dt>Detail</dt>
                    <dd>{p.health.detail}</dd>
                  </div>
                )}
              </dl>

              {p.capabilities.length > 0 && (
                <div className="chips" aria-label="capabilities">
                  {p.capabilities.map((c) => (
                    <span key={c} className="chip">
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {chains.length > 0 && (
        <div className="subsection">
          <h3 className="subsection__title">Chains</h3>
          <div className="chips">
            {chains.map((c) => (
              <span key={c.key} className="chip chip--wide">
                <strong>{c.key}</strong>
                <span className="chip__meta">{c.requests} req</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
