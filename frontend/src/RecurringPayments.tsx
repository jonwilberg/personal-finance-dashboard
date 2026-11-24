import { Fragment, useState } from "react";
import { type RecurringItem, type RecurringPayments as Recurring, api } from "./api";
import { Sparkline } from "./CategoryScoreboard";
import { formatDate, formatKr } from "./format";
import { monthTitle } from "./SpendingChart";
import { groupFill } from "./spendingGroups";

const COLUMNS = ["Payee", "Category", "This month", "Usual month", "Total LTM", "Last 12 months", ""];
const NUMERIC = new Set([2, 3, 4]);

/**
 * Payments that come about once a month (rent, subscriptions, insurance, power), for the selected month: what each
 * came to, against its usual month, with a strip of its last 12 months. Each row opens to the month's payments, and a
 * payee that isn't really recurring (a card bill, say) can be left out; those are listed at the end to bring back.
 */
export function RecurringPayments(props: {
  recurring: Recurring;
  month: string;
  scope: string | null;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const { recurring, month } = props;
  const [open, setOpen] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const months = recurring.months.map((m) => ({ month: m }));
  const ltm = (item: RecurringItem) => item.history.reduce((sum, v) => sum + v, 0);

  const choose = async (payee: string, isRecurring: boolean) => {
    setBusy(payee);
    try {
      await api.setRecurring(payee, isRecurring);
      setOpen(null);
      props.onChanged();
    } catch (error) {
      props.onError(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <p className="label">
        Recurring payments{props.scope && ` · ${props.scope}`}
      </p>
      {recurring.items.length > 0 && (
        <table className="scoreboard recurring">
          <thead>
            <tr>
              {COLUMNS.map((label, i) => (
                <th key={i} className={NUMERIC.has(i) ? "num" : undefined}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recurring.items.map((item) => {
              const isOpen = open === item.payee;
              const flip = () => setOpen(isOpen ? null : item.payee);
              const detailId = `recurring-detail-${item.payee.replace(/\W+/g, "-")}`;
              return (
                <Fragment key={item.payee}>
                  <tr className={`score-row${isOpen ? " is-open" : ""}`} onClick={flip}>
                    <td>
                      <button
                        className="score-toggle"
                        aria-expanded={isOpen}
                        aria-controls={detailId}
                        onClick={(e) => {
                          e.stopPropagation();
                          flip();
                        }}
                      >
                        <span className="score-chevron" aria-hidden="true">
                          ›
                        </span>
                        {/* Its spending group's colour, as in the category table; grey for loans and savings. */}
                        <span
                          className="score-group"
                          style={{ background: item.group ? groupFill(item.group) : "var(--ink-muted)" }}
                          aria-hidden="true"
                        />
                        <span className="score-name">{item.payee}</span>
                      </button>
                    </td>
                    <td className="meta">{item.category_name}</td>
                    <td className="num">
                      <span className="score-amount">{item.amount > 0 ? formatKr(item.amount) : "–"}</span>
                      {item.payments.length > 1 && (
                        <span className="meta small recurring-count">{item.payments.length} payments</span>
                      )}
                    </td>
                    <td className="num meta">
                      {item.usual !== null ? `${item.varies ? "~" : ""}${formatKr(item.usual)}` : "–"}
                    </td>
                    <td className="num">{formatKr(ltm(item))}</td>
                    <td>
                      <Sparkline values={item.history} months={months} name={item.payee} />
                    </td>
                    <td className="recurring-status">
                      <Status item={item} />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="score-detail" id={detailId}>
                      <td colSpan={COLUMNS.length}>
                        <Detail
                          item={item}
                          month={month}
                          busy={busy === item.payee}
                          onNotRecurring={() => choose(item.payee, false)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            {/* A cell per column, so phones hide the same columns here as in the rows. */}
            <tr>
              <td>Total</td>
              <td />
              <td className="num">
                <span className="score-amount">{formatKr(recurring.total)}</span>
              </td>
              <td className="num meta">{formatKr(recurring.items.reduce((sum, i) => sum + (i.usual ?? 0), 0))}</td>
              <td className="num">{formatKr(recurring.items.reduce((sum, i) => sum + ltm(i), 0))}</td>
              <td />
              <td />
            </tr>
          </tfoot>
        </table>
      )}
      {recurring.hidden.length > 0 && (
        <div className="recurring-hidden">
          <p className="meta small">
            {recurring.hidden.length === 1 ? "1 payee" : `${recurring.hidden.length} payees`} marked as not recurring
            {" · "}
            <button className="link recurring-hidden-toggle" onClick={() => setShowHidden(!showHidden)} aria-expanded={showHidden}>
              {showHidden ? "Hide" : "Show"}
            </button>
          </p>
          {showHidden && (
            <ul className="recurring-hidden-list">
              {recurring.hidden.map((h) => (
                <li key={h.payee}>
                  <span>{h.payee}</span>
                  <span className="meta">{h.amount > 0 ? formatKr(h.amount) : "–"}</span>
                  <button className="text" disabled={busy === h.payee} onClick={() => choose(h.payee, true)}>
                    {busy === h.payee ? "Saving…" : "Recurring after all"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

/** What's worth knowing about this payee this month, in words; nothing when it was paid as usual. */
function Status({ item }: { item: RecurringItem }) {
  switch (item.status) {
    case "new":
      return <span className="badge badge-test">New</span>;
    case "changed": {
      const change = item.usual ? (item.amount - item.usual) / item.usual : 0;
      // The sign carries the direction, so it never depends on colour alone.
      return (
        <span className={`change-delta ${change > 0 ? "is-up" : "is-down"}`}>
          {change > 0 ? "+" : "−"}
          {Math.round(Math.abs(change) * 100)} %
        </span>
      );
    }
    case "due":
      return <span className="meta small">Due around the {ordinal(item.day)}</span>;
    case "missed":
      return <span className="meta small">Not paid this month</span>;
    case "stopped":
      return <span className="meta small">Stopped</span>;
    default:
      return null;
  }
}

function Detail(props: { item: RecurringItem; month: string; busy: boolean; onNotRecurring: () => void }) {
  const { item } = props;
  return (
    <div className="recurring-detail">
      {item.series.length > 1 && (
        <p className="drill-note meta small">
          {item.series.length} payments a month, usually {joinAnd(item.series.map((s) => formatKr(s.amount)))}.
        </p>
      )}
      {item.payments.length > 0 ? (
        <ul className="drill-list">
          {item.payments.map((p) => (
            <li key={p.id} className="drill-row recurring-payment">
              <span className="drill-date meta">{formatDate(p.date)}</span>
              <span className="drill-text">
                <span className="drill-description">{p.description || item.payee}</span>
              </span>
              <span className="drill-amount num">{formatKr(p.amount)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="drill-note meta small">Nothing paid to {item.payee} in {monthTitle(props.month)}.</p>
      )}
      <p className="recurring-actions">
        <button className="text" disabled={props.busy} onClick={props.onNotRecurring}>
          {props.busy ? "Saving…" : "Not a recurring payment"}
        </button>
        <span className="meta small">Leaves it out of this list. Its spending still counts above.</span>
      </p>
    </div>
  );
}

function joinAnd(parts: string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "");
}

/** 1st, 2nd, 3rd, 4th … 21st, 22nd. */
function ordinal(day: number): string {
  const tens = day % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][day % 10] ?? "th";
  return `${day}${suffix}`;
}
