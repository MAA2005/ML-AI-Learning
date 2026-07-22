import { useGatewayData } from "./hooks/useGatewayData";
import { ProvidersView } from "./components/ProvidersView";
import { UsageView } from "./components/UsageView";
import { RecentView } from "./components/RecentView";
import { formatRelative } from "./utils/format";

export function App() {
  const { data, error, loading, lastUpdated, refresh } = useGatewayData(7000);

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <h1>Relay</h1>
          <span className="app__tagline">gateway monitor · read-only</span>
        </div>
        <div className="app__status">
          {error && <span className="banner banner--error">Gateway unreachable: {error}</span>}
          {lastUpdated && (
            <span className="app__updated">Updated {formatRelative(lastUpdated)}</span>
          )}
          <button className="btn" onClick={refresh} type="button">
            Refresh
          </button>
        </div>
      </header>

      {loading && !data ? (
        <p className="empty empty--page">Connecting to gateway on 127.0.0.1:8787…</p>
      ) : (
        <main className="app__main">
          <ProvidersView
            providers={data?.providers ?? null}
            health={data?.health ?? null}
            byChain={data?.usage.byChain}
          />
          <UsageView byProvider={data?.usage.byProvider} />
          <RecentView recent={data?.usage.recent} />
        </main>
      )}

      <footer className="app__footer">
        <span>
          Read-only monitoring. This dashboard never handles API keys — manage
          providers with the <code>relay add-provider</code> CLI.
        </span>
      </footer>
    </div>
  );
}
