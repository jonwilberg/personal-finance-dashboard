import { useEffect, useState } from "react";
import { type Overview, type Owner, api, overviewApi } from "./api";
import { CategoryScoreboard } from "./CategoryScoreboard";
import { OwnerFilter, ownerScope } from "./OwnerPicker";
import { SpendingChart, monthTitle } from "./SpendingChart";
import { SpendingSplit } from "./SpendingSplit";

const OWNERS_KEY = "overview-owners";

/** The owners chosen last time in this browser, if they still exist; otherwise everyone. */
function rememberedOwners(owners: Owner[]): string[] {
  const all = owners.map((o) => o.id);
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(OWNERS_KEY) ?? "null");
    const kept = Array.isArray(saved) ? all.filter((id) => saved.includes(id)) : [];
    return kept.length ? kept : all;
  } catch {
    return all;
  }
}

export function OverviewPage({ onError }: { onError: (e: unknown) => void }) {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [owners, setOwners] = useState<Owner[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    api
      .owners()
      .then((list) => {
        setOwners(list);
        setSelected(rememberedOwners(list));
      })
      .catch((error) => {
        setOwners([]); // still show everyone's overview
        onError(error);
      });
  }, [onError]);

  // Everyone selected means no filter, so accounts of anyone added later are counted too.
  const filter = owners && selected.length < owners.length ? selected : undefined;
  const filterKey = filter?.join(",");
  useEffect(() => {
    if (owners === null) return; // wait for the remembered choice
    overviewApi.get(month, filterKey?.split(",")).then(setOverview).catch(onError);
  }, [month, owners, filterKey, onError]);

  const choose = (next: string[]) => {
    setSelected(next);
    try {
      localStorage.setItem(OWNERS_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable: the choice lasts until the page reloads
    }
  };

  // Shown once there's someone to choose between; until then every account is shared.
  const ownerFilter = owners && owners.length > 1 && (
    <OwnerFilter owners={owners} selected={selected} onChange={choose} />
  );
  const scope = owners ? ownerScope(owners, selected) : null;

  if (!overview) return <p className="muted">Loading…</p>;
  if (!overview.month || !overview.figures) {
    return (
      <section className="section front">
        {ownerFilter}
        <h2>{filter ? `No transactions in ${scope ?? "these accounts"}` : overview.headline}</h2>
        <p className="dek">
          {filter ? (
            "Tick more accounts above, or mark whose each account is on the Accounts page."
          ) : (
            <>
              Connect a bank and fetch its history on the <a href="#/accounts">Accounts</a> page.
            </>
          )}
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
      {/* The month is the page's title, like the titles of the other pages, with the controls on the same line:
          arrows to step through months, and on the right whose accounts are counted. */}
      <header className="overview-header">
        <div className="overview-title">
          <h1>{overview.month_label}</h1>
          <span className="month-steps">
            <button
              className="month-step"
              onClick={() => setMonth(previous)}
              disabled={!previous}
              aria-label={previous ? `Previous month, ${monthTitle(previous)}` : "No earlier month"}
              title={previous ? monthTitle(previous) : undefined}
            >
              ‹
            </button>
            <button
              className="month-step"
              onClick={() => setMonth(next)}
              disabled={!next}
              aria-label={next ? `Next month, ${monthTitle(next)}` : "No later month"}
              title={next ? monthTitle(next) : undefined}
            >
              ›
            </button>
          </span>
          {overview.is_partial && <span className="badge badge-test">So far</span>}
        </div>
        {ownerFilter}
      </header>

      <section className="section">
        <p className="label">
          Spending and income, last {overview.series.length} months{scope && ` · ${scope}`}
        </p>
        <SpendingChart
          series={overview.series}
          groups={overview.groups ?? []}
          selected={overview.month}
          usual={f.usual_spent}
          onSelect={setMonth}
        />
      </section>

      {overview.scoreboard && overview.scoreboard.length > 0 && (
        <section className="section">
          <p className="label">Spending by category{scope && ` · ${scope}`}</p>
          <SpendingSplit rows={overview.scoreboard} groups={overview.groups ?? []} />
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
