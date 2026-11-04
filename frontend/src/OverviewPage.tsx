import { useEffect, useState } from "react";
import { type Overview, overviewApi } from "./api";
import { formatKr } from "./format";
import { CategoryScoreboard } from "./CategoryScoreboard";
import { SpendingChart } from "./SpendingChart";

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

        {/* --chars lets CSS size the headline to fit on one line (see .front-headline). */}
        <h2 className="front-headline" style={{ ["--chars" as string]: overview.headline.length }}>
          {overview.headline}
        </h2>

        <div className="figures">
          <Figure
            label="Spent"
            value={formatKr(f.spent)}
            note={f.usual_spent !== null ? `median month ${formatKr(f.usual_spent)}` : undefined}
          />
          <Figure label="Income" value={formatKr(f.income)} />
          <Figure
            label="Saved"
            value={formatKr(f.saved)}
            note={f.savings_rate !== null ? `${Math.round(f.savings_rate * 100)} % of income` : undefined}
          />
        </div>
      </section>

      <section className="section">
        <p className="label">Spending, last {overview.series.length} months</p>
        <SpendingChart
          series={overview.series}
          selected={overview.month}
          usual={f.usual_spent}
          onSelect={setMonth}
        />
        <p className="meta small">
          Median month: the median of the {overview.usual_months || "previous"} months before. Select a bar to open that
          month.
        </p>
      </section>

      {overview.scoreboard && overview.scoreboard.length > 0 && (
        <section className="section">
          <p className="label">Spending by category</p>
          <CategoryScoreboard
            rows={overview.scoreboard}
            months={overview.series}
            total={f.spent}
            usual={f.usual_spent}
          />
          <p className="meta small">Select a column heading to sort.</p>
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
