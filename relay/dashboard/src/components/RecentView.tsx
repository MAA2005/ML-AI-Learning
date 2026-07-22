import { sortRecent } from "../api/selectors";
import type { UsageEntry } from "../api/types";
import { formatLatency, formatRelative, formatTime, formatUsd } from "../utils/format";

interface Props {
  recent: UsageEntry[] | undefined;
}

export function RecentView({ recent }: Props) {
  const entries = sortRecent(recent);

  return (
    <section className="view" aria-labelledby="recent-heading">
      <div className="view__head">
        <h2 id="recent-heading">Recent attempts</h2>
        <span className="pill">{entries.length} shown</span>
      </div>

      {entries.length === 0 ? (
        <p className="empty">No recent attempts.</p>
      ) : (
        <ul className="feed">
          {entries.map((e, i) => (
            <li key={`${e.ts}-${i}`} className={`feed__row feed__row--${e.outcome}`}>
              <span className={`dot dot--${e.outcome}`} aria-hidden="true" />
              <div className="feed__main">
                <div className="feed__line">
                  <strong>{e.provider}</strong>
                  <span className="feed__model">{e.model}</span>
                  <span className="tag">{e.chain}</span>
                </div>
                <div className="feed__meta">
                  <span className={`outcome outcome--${e.outcome}`}>{e.outcome}</span>
                  <span>{formatLatency(e.latencyMs)}</span>
                  <span>{formatUsd(e.costUsd)}</span>
                </div>
              </div>
              <time className="feed__time" dateTime={new Date(e.ts).toISOString()}>
                <span>{formatTime(e.ts)}</span>
                <span className="feed__ago">{formatRelative(e.ts)}</span>
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
