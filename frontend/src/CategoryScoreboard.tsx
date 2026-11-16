import { Fragment, useMemo, useState } from "react";
import type { OverviewMonth, ScoreboardRow, SpendingGroup } from "./api";
import { CategoryTransactions } from "./CategoryTransactions";
import { formatKr } from "./format";
import { monthTitle } from "./SpendingChart";
import { groupFill } from "./spendingGroups";

// "bar": the order of the spending bar above, read top to bottom (the default); the others are column sorts.
type SortKey = "bar" | "name" | "amount" | "usual" | "delta" | "ltm";
const UNCATEGORIZED = "uncategorized";

const COLUMNS: { key: SortKey | null; label: string; numeric: boolean }[] = [
  { key: "name", label: "Category", numeric: false },
  { key: "amount", label: "This month", numeric: true },
  { key: "usual", label: "Median month", numeric: true },
  { key: "delta", label: "Difference", numeric: true },
  { key: "ltm", label: "Total LTM", numeric: true },
  { key: null, label: "Last 12 months", numeric: false },
];

/**
 * The categories in the order the spending bar above shows them, top to bottom: its groups from the top (Other
 * first, Fixed last), and within a group the blocks as they're stacked. Categories with nothing spent this month
 * aren't on the bar and come last.
 */
function barOrder(rows: ScoreboardRow[], groups: SpendingGroup[]): ScoreboardRow[] {
  const rank = (row: ScoreboardRow) => {
    const index = groups.findIndex((g) => g.id === row.group);
    return index < 0 ? groups.length : index;
  };
  // The bar's stacking order, bottom first (see SpendingSplit), then reversed to read from the top.
  const stacked = rows
    .filter((r) => r.amount > 0)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Number(a.category === UNCATEGORIZED) - Number(b.category === UNCATEGORIZED) ||
        b.amount - a.amount,
    )
    .reverse();
  const rest = rows.filter((r) => r.amount <= 0).sort((a, b) => a.name.localeCompare(b.name, "nb"));
  return [...stacked, ...rest];
}

/**
 * Every spending category for the selected month, in the spending bar's order (or sorted by a column), each marked
 * with its group's colour and with a sparkline of its monthly history. A row opens to the month's transactions in
 * that category, to move any that belong somewhere else.
 */
export function CategoryScoreboard(props: {
  rows: ScoreboardRow[];
  /** The spending groups in stacking order, for the bar's order and each row's colour mark. */
  groups: SpendingGroup[];
  months: OverviewMonth[];
  total: number;
  usual: number | null;
  /** The selected month (YYYY-MM) and whose accounts count, for the transactions a row opens to. */
  month: string;
  owners?: string[];
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "bar", descending: false });
  const [open, setOpen] = useState<string | null>(null);
  const flip = (category: string) => setOpen((current) => (current === category ? null : category));

  const rows = useMemo(() => {
    if (sort.key === "bar") return barOrder(props.rows, props.groups);
    const key = sort.key;
    const value = (row: ScoreboardRow) => (key === "name" ? row.name : (row[key] ?? -Infinity));
    return [...props.rows].sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      const order = typeof x === "string" ? x.localeCompare(String(y), "nb") : (x as number) - (y as number);
      return sort.descending ? -order : order;
    });
  }, [props.rows, props.groups, sort]);

  // Every spending category is a row (uncategorized included), so together they make the period's total spending.
  const ltmTotal = props.rows.reduce((sum, row) => sum + row.ltm, 0);
  const historyTotal = props.months.map((_, i) => props.rows.reduce((sum, row) => sum + (row.history[i] ?? 0), 0));

  // A heading sorts by its column, then the other way round, then back to the bar's order.
  const toggle = (key: SortKey) =>
    setSort((current) => {
      const first = key !== "name"; // numbers start largest first, names A to Z
      if (current.key !== key) return { key, descending: first };
      if (current.descending === first) return { key, descending: !first };
      return { key: "bar", descending: false };
    });

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
              {column.key === "amount" && <span className="score-share" aria-hidden="true" />}
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
                    {/* Its group's colour, as on the bar; striped for spending without a category. */}
                    <span
                      className={`score-group${row.category === UNCATEGORIZED ? " is-uncategorized" : ""}`}
                      style={row.category === UNCATEGORIZED ? undefined : { background: groupFill(row.group) }}
                      title={props.groups.find((g) => g.id === row.group)?.name}
                      aria-hidden="true"
                    />
                    <span className="score-name">{row.name}</span>
                  </button>
                </td>
                <td className="num">
                  <span className="score-amount">{formatKr(row.amount)}</span>
                  <span className="meta small score-share">
                    {row.share !== null && row.amount > 0 && `${Math.round(row.share * 100)} %`}
                  </span>
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
            <span className="score-share" aria-hidden="true" />
          </td>
          <td className="num meta">{props.usual !== null ? formatKr(props.usual) : "–"}</td>
          <td className="num">
            <Difference delta={props.usual !== null ? props.total - props.usual : null} />
          </td>
          <td className="num">{formatKr(ltmTotal)}</td>
          <td>
            <Sparkline values={historyTotal} months={props.months} name="Total spending" />
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function Difference({ delta }: { delta: number | null }) {
  if (delta === null) return <span className="meta">–</span>;
  if (Math.round(delta) === 0) return <span className="meta">0</span>;
  // The sign carries the direction, so it never depends on colour alone.
  return (
    <span className={`change-delta ${delta > 0 ? "is-up" : "is-down"}`}>
      {delta > 0 ? "+" : "−"}
      {formatKr(Math.abs(delta))}
    </span>
  );
}

const SPARK_W = 112;
const SPARK_H = 26;
const SPARK_GAP = 2; // between the little bars

/** A tiny bar per month, grey, with the last month (the selected one) in ink. */
function Sparkline({ values, months, name }: { values: number[]; months: OverviewMonth[]; name: string }) {
  if (values.length < 2) return null;
  const low = Math.min(0, ...values);
  const high = Math.max(...values, 1);
  const barW = (SPARK_W - SPARK_GAP * (values.length - 1)) / values.length;
  const x = (i: number) => i * (barW + SPARK_GAP);
  const y = (v: number) => 1 + (1 - (v - low) / (high - low)) * (SPARK_H - 2);
  const last = values.length - 1;
  const description = values.map((v, i) => `${monthTitle(months[i]?.month ?? "")}: ${formatKr(v)}`).join(", ");
  return (
    <svg className="sparkline" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} width={SPARK_W} height={SPARK_H} role="img">
      <title>{`${name} per month. ${description}`}</title>
      <line x1="0" x2={SPARK_W} y1={y(0)} y2={y(0)} stroke="var(--rule)" />
      {values.map((v, i) => {
        const top = Math.min(y(v), y(0));
        return (
          <rect
            key={i}
            x={x(i)}
            y={top}
            width={barW}
            height={Math.max(Math.abs(y(v) - y(0)), 0.5)}
            fill={i === last ? "var(--ink)" : "var(--ink-muted)"}
          />
        );
      })}
    </svg>
  );
}
