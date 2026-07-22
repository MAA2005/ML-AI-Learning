import { computeUsageTotals } from "../api/selectors";
import type { Summary } from "../api/types";
import { formatTokens, formatUsd } from "../utils/format";

interface Props {
  byProvider: Summary[] | undefined;
}

export function UsageView({ byProvider }: Props) {
  const rows = byProvider ?? [];
  const totals = computeUsageTotals(rows);

  return (
    <section className="view" aria-labelledby="usage-heading">
      <div className="view__head">
        <h2 id="usage-heading">Usage &amp; cost</h2>
        <span className="pill">Total: {formatUsd(totals.costUsd)}</span>
      </div>

      {rows.length === 0 ? (
        <p className="empty">No usage recorded yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col" className="num">Requests</th>
                <th scope="col" className="num">Prompt</th>
                <th scope="col" className="num">Completion</th>
                <th scope="col" className="num">Total tokens</th>
                <th scope="col" className="num">Cost (USD)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <th scope="row">{r.key}</th>
                  <td className="num">{formatTokens(r.requests)}</td>
                  <td className="num">{formatTokens(r.promptTokens)}</td>
                  <td className="num">{formatTokens(r.completionTokens)}</td>
                  <td className="num">{formatTokens(r.totalTokens)}</td>
                  <td className="num">
                    {formatUsd(r.costUsd)}
                    {r.unknownCostRequests > 0 && (
                      <sup
                        className="footnote-mark"
                        title={`${r.unknownCostRequests} request(s) not priced`}
                      >
                        *
                      </sup>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td className="num">{formatTokens(totals.requests)}</td>
                <td className="num">{formatTokens(totals.promptTokens)}</td>
                <td className="num">{formatTokens(totals.completionTokens)}</td>
                <td className="num">{formatTokens(totals.totalTokens)}</td>
                <td className="num">
                  {formatUsd(totals.costUsd)}
                  {totals.hasUnpriced && <sup className="footnote-mark">*</sup>}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {totals.hasUnpriced && (
        <p className="footnote">
          <span className="footnote-mark">*</span> {totals.unknownCostRequests}{" "}
          request(s) could not be priced (no cost data from the provider). Their
          cost is shown as not-priced and excluded from the dollar total — no
          cost is fabricated.
        </p>
      )}
    </section>
  );
}
