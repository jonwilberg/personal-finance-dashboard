import { Fragment, useMemo, useState } from "react";
import type { OverviewMonth, ScoreboardRow } from "./api";
import { CategoryTransactions } from "./CategoryTransactions";
import { formatKr } from "./format";
import { monthTitle } from "./SpendingChart";

type SortKey = "name" | "amount" | "usual" | "delta" | "ltm";

const COLUMNS: { key: SortKey | null; label: string; numeric: boolean }[] = [
  { key: "name", label: "Category", numeric: false },
  { key: "amount", label: "This month", numeric: true },
  { key: "usual", label: "Median month", numeric: true },
  { key: "delta", label: "Difference", numeric: true },
  { key: "ltm", label: "Total LTM", numeric: true },
  { key: null, label: "Last 12 months", numeric: false },
];

/**
 * Every spending category for the selected month, sortable, with a sparkline of its monthly history. A row opens
 * to the month's transactions in that category, to move any that belong somewhere else.
 */
export function CategoryScoreboard(props: {
  rows: ScoreboardRow[];
  months: OverviewMonth[];
  total: number;
  usual: number | null;
  /** The selected month (YYYY-MM) and whose accounts count, for the transactions a row opens to. */
  month: string;
  owners?: string[];
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "amount", descending: true });
  const [open, setOpen] = useState<string | null>(null);
  const flip = (category: string) => setOpen((current) => (current === category ? null : category));

  const rows = useMemo(() => {
    const value = (row: ScoreboardRow) => (sort.key === "name" ? row.name : (row[sort.key] ?? -Infinity));
    return [...props.rows].sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      const order = typeof x === "string" ? x.localeCompare(String(y), "nb") : (x as number) - (y as number);
      return sort.descending ? -order : order;
    });
  }, [props.rows, sort]);

  // Every spending category is a row (uncategorized included), so together they make the period's total spending.
  const ltmTotal = props.rows.reduce((sum, row) => sum + row.ltm, 0);

  const toggle = (key: SortKey) =>
    setSort((current) =>
      current.key === key ? { key, descending: !current.descending } : { key, descending: key !== "name" },
    );

  return (
    <table className="scoreboard">
      <thead>
        <tr>
          {COLUMNS.map((column) => (
            <th
              key={column.label}
              className={column.numeric ? "num" : undefined}
              aria-sort={
                column.key && sort.key === column.key ? (sort.descending ? "descending" : "ascending") : undefined
              }
            >
              {column.key ? (
                <button className="sort" onClick={() => toggle(column.key!)}>
                  {column.label}
                  <span className="sort-arrow" aria-hidden="true">
                    {sort.key === column.key ? (sort.descending ? "↓" : "↑") : ""}
                  </span>
                </button>
              ) : (
                column.label
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const isOpen = open === row.category;
          return (
            <Fragment key={row.category}>
              {/* The id lets the spending split above jump to a category's row. Clicking anywhere on the row opens it;
                  the name is the button for keyboards and screen readers. */}
              <tr
                id={`scoreboard-${row.category}`}
                className={`score-row${isOpen ? " is-open" : ""}`}
                onClick={() => flip(row.category)}
              >
                <td>
                  <button
                    className="score-toggle"
                    aria-expanded={isOpen}
                    aria-controls={`score-detail-${row.category}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      flip(row.category);
                    }}
                  >
                    <span className="score-chevron" aria-hidden="true">
                      ›
                    </span>
                    <span className="score-name">
                      {row.name}
                      {row.fixed && <span className="account-type">Fixed</span>}
                    </span>
                  </button>
                </td>
                <td className="num">
                  <span className="score-amount">{formatKr(row.amount)}</span>
                  {row.share !== null && row.amount > 0 && (
                    <span className="meta small score-share">{Math.round(row.share * 100)} %</span>
                  )}
                </td>
                <td className="num meta">{row.usual !== null ? formatKr(row.usual) : "–"}</td>
                <td className="num">
                  <Difference delta={row.delta} />
                </td>
                <td className="num">{formatKr(row.ltm)}</td>
                <td>
                  <Sparkline values={row.history} months={props.months} name={row.name} />
                </td>
              </tr>
              {isOpen && (
                <tr className="score-detail" id={`score-detail-${row.category}`}>
                  <td colSpan={COLUMNS.length}>
                    <CategoryTransactions
                      category={row.category}
                      month={props.month}
                      owners={props.owners}
                      onChanged={props.onChanged}
                      onError={props.onError}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td>Total spending</td>
          <td className="num">
            <span className="score-amount">{formatKr(props.total)}</span>
          </td>
          <td className="num meta">{props.usual !== null ? formatKr(props.usual) : "–"}</td>
          <td className="num">
            <Difference delta={props.usual !== null ? props.total - props.usual : null} />
          </td>
          <td className="num">{formatKr(ltmTotal)}</td>
          <td />
        </tr>
      </tfoot>
    </table>
  );
}

function Difference({ delta }: { delta: number | null }) {
  if (delta === null) return <span className="meta">–</span>;
  if (Math.round(delta) === 0) return <span className="meta">±0</span>;
  // Arrow and sign carry the direction, so it never depends on colour alone.
  return (
    <span className={`change-delta ${delta > 0 ? "is-up" : "is-down"}`}>
      {delta > 0 ? "▲ +" : "▼ −"}
      {formatKr(Math.abs(delta))}
    </span>
  );
}

const SPARK_W = 112;
const SPARK_H = 26;

function Sparkline({ values, months, name }: { values: number[]; months: OverviewMonth[]; name: string }) {
  if (values.length < 2) return null;
  const low = Math.min(0, ...values);
  const high = Math.max(...values, 1);
  const x = (i: number) => 3 + (i / (values.length - 1)) * (SPARK_W - 6);
  const y = (v: number) => 3 + (1 - (v - low) / (high - low)) * (SPARK_H - 6);
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const last = values.length - 1;
  const description = values.map((v, i) => `${monthTitle(months[i]?.month ?? "")}: ${formatKr(v)}`).join(", ");
  return (
    <svg className="sparkline" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} width={SPARK_W} height={SPARK_H} role="img">
      <title>{`${name} per month. ${description}`}</title>
      <line x1="3" x2={SPARK_W - 3} y1={y(0)} y2={y(0)} stroke="var(--rule)" />
      <polyline points={points} fill="none" stroke="var(--ink-muted)" strokeWidth="2" strokeLinejoin="round" />
      <circle cx={x(last)} cy={y(values[last])} r="3.5" fill="var(--ink)" stroke="var(--paper)" strokeWidth="2" />
    </svg>
  );
}
