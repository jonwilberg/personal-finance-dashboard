import { useEffect, useState } from "react";
import { type Overview, overviewApi } from "./api";
import { formatKr } from "./format";
import { SpendingChart, monthTitle } from "./SpendingChart";

export function OverviewPage({ onError }: { onError: (e: unknown) => void }) {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [overview, setOverview] = useState<Overview | null>(null);

  useEffect(() => {
    overviewApi.get(month).then(setOverview).catch(onError);
  }, [month, onError]);

  if (!overview) return <p className="muted">Loading…</p>;
  if (!overview.month || !overview.figures) {
    return (
      <section className="section">
        <h2>{overview.headline}</h2>
        <p className="dek">
          Connect a bank and fetch its history on the <a href="#/accounts">Accounts</a> page.
        </p>
      </section>
    );
  }

  const index = overview.months.indexOf(overview.month);
  const previous = overview.months[index - 1];
  const next = overview.months[index + 1];
  const f = overview.figures;

  return (
    <>
      <section className="section front">
        <div className="month-switcher">
          <button className="text" onClick={() => setMonth(previous)} disabled={!previous} aria-label="Previous month">
            ‹ {previous ? shortMonth(previous) : ""}
          </button>
          <span className="label month-current">
            {overview.month_label}
            {overview.is_partial && <span className="badge badge-test">So far</span>}
          </span>
          <button className="text" onClick={() => setMonth(next)} disabled={!next} aria-label="Next month">
            {next ? shortMonth(next) : ""} ›
          </button>
        </div>

        <h2 className="front-headline">{overview.headline}</h2>

        <div className="figures">
          <Figure
            label="Spent"
            value={formatKr(f.spent)}
            note={f.usual_spent !== null ? `Usual ${formatKr(f.usual_spent)}` : undefined}
          />
          <Figure label="Income" value={formatKr(f.income)} />
          <Figure label="Saved" value={formatKr(f.saved)} />
          <Figure
            label="Savings rate"
            value={f.savings_rate !== null ? `${Math.round(f.savings_rate * 100)} %` : "–"}
            note="Saved ÷ income"
          />
        </div>
        <p className="figures-note small">
          Of the spending, {formatKr(f.fixed)} was fixed and {formatKr(f.adjustable)} adjustable.
          {f.loans > 0 && <> Loan payments of {formatKr(f.loans)} come on top.</>}
          {f.uncategorized > 0 && (
            <>
              {" "}
              <a href="#/transactions">{formatKr(f.uncategorized)} isn't categorized yet</a>.
            </>
          )}
        </p>
      </section>

      <section className="section">
        <p className="label">Spending per month</p>
        <h3>Fixed costs against what you can adjust, last {overview.series.length} months</h3>
        <SpendingChart
          series={overview.series}
          selected={overview.month}
          usual={f.usual_spent}
          onSelect={setMonth}
        />
        <p className="meta small">
          Usual month: the median of the {overview.usual_months || "previous"} months before. Select a bar to open that
          month.
        </p>
      </section>

      {overview.changes && overview.changes.length > 0 && (
        <section className="section">
          <p className="label">What changed</p>
          <h3>Biggest differences from a usual {monthTitle(overview.month).split(" ")[0]}</h3>
          <div className="changes">
            {overview.changes.map((c) => (
              <div key={c.category} className="change-row">
                <span className="change-name">
                  {c.name}
                  {c.fixed && <span className="account-type">Fixed</span>}
                </span>
                <span className="num">{formatKr(c.amount)}</span>
                <span className="num meta">usual {formatKr(c.usual)}</span>
                <span className={`num change-delta ${c.delta > 0 ? "is-up" : "is-down"}`}>
                  {c.delta > 0 ? "▲ +" : "▼ −"}
                  {formatKr(Math.abs(c.delta))}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Figure(props: { label: string; value: string; note?: string }) {
  return (
    <div className="figure">
      <span className="label">{props.label}</span>
      <span className="figure-value">{props.value}</span>
      {props.note && <span className="meta small">{props.note}</span>}
    </div>
  );
}

function shortMonth(month: string) {
  const [year, number] = month.split("-").map(Number);
  return new Date(year, number - 1, 1).toLocaleDateString("en-GB", { month: "short" });
}
