import { Fragment, useEffect, useState } from "react";
import { type RecurringItem, type RecurringPayments as Recurring, api } from "./api";
import { Difference, Sparkline } from "./CategoryScoreboard";
import { formatDate, formatKr } from "./format";
import { monthTitle } from "./SpendingChart";
import { groupFill } from "./spendingGroups";

// The category table's columns, with the category where it has its transaction count, so the two line up.
const COLUMNS = ["Payee", "Category", "This month", "Median month", "Difference", "Total LTM", "Last 12 months"];
const NUMERIC = new Set([2, 3, 4, 5]);

/**
 * Payments that come about once a month (rent, subscriptions, insurance, power), for the selected month: what each
 * came to, against its median month, with a strip of its last 12 months. Each row opens to the month's payments, and a
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
  // The payee just marked as non-recurring and the row it had, for an Undo line in its place.
  const [marked, setMarked] = useState<{ payee: string; index: number } | null>(null);
  useEffect(() => setMarked(null), [month]); // its row means nothing in another month
  const months = recurring.months.map((m) => ({ month: m }));
  const ltm = (item: RecurringItem) => item.history.reduce((sum, v) => sum + v, 0);
  const usualTotal = recurring.items.reduce((sum, i) => sum + (i.usual ?? 0), 0);

  const choose = async (payee: string, isRecurring: boolean) => {
    setBusy(payee);
    try {
      await api.setRecurring(payee, isRecurring);
      setOpen(null);
      const index = recurring.items.findIndex((i) => i.payee === payee);
      setMarked(isRecurring || index < 0 ? null : { payee, index });
      props.onChanged();
    } catch (error) {
      props.onError(error);
    } finally {
      setBusy(null);
    }
  };

  // Shown once the list has been fetched again without the payee.
  const undoRow = marked && !recurring.items.some((i) => i.payee === marked.payee) && (
    <tr className="recurring-undo" key="undo">
      <td colSpan={COLUMNS.length}>
        <span className="meta">
          <strong>{marked.payee}</strong> marked as non-recurring
        </span>
        <button className="text" disabled={busy === marked.payee} onClick={() => choose(marked.payee, true)}>
          {busy === marked.payee ? "Undoing…" : "Undo"}
        </button>
      </td>
    </tr>
  );

  return (
    <>
      <p className="label">
        Recurring payments{props.scope && ` · ${props.scope}`}
      </p>
      {(recurring.items.length > 0 || undoRow) && (
        <table className="scoreboard recurring">
          <thead>
            <tr>
              {COLUMNS.map((label, i) => (
                <th key={i} className={NUMERIC.has(i) ? "num" : undefined}>
                  {label}
                  {/* The category table's amounts leave room for their share; so do these, so both end alike. */}
                  {i === 2 && <span className="score-share" aria-hidden="true" />}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recurring.items.map((item, index) => {
              const isOpen = open === item.payee;
              const flip = () => setOpen(isOpen ? null : item.payee);
              const detailId = `recurring-detail-${item.payee.replace(/\W+/g, "-")}`;
              return (
                <Fragment key={item.payee}>
                  {undoRow && index === marked?.index && undoRow}
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
                        <span className="score-name" title={item.payee}>
                          {item.payee}
                        </span>
                      </button>
                    </td>
                    <td className="meta score-category">
                      {item.category_name}
                    </td>
                    <td className="num">
                      <span className="score-amount">{item.amount > 0 ? formatKr(item.amount) : "–"}</span>
                      <span className="score-share" aria-hidden="true" />
                    </td>
                    <td className="num meta">
                      {item.usual !== null ? formatKr(item.usual) : "–"}
                    </td>
                    <td className="num">
                      <Difference delta={item.usual !== null ? item.amount - item.usual : null} />
                    </td>
                    <td className="num">{formatKr(ltm(item))}</td>
                    <td>
                      <Sparkline values={item.history} months={months} name={item.payee} />
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
            {undoRow && marked && marked.index >= recurring.items.length && undoRow}
          </tbody>
          <tfoot>
            {/* A cell per column, so phones hide the same columns here as in the rows. */}
            <tr>
              <td>Total</td>
              <td />
              <td className="num">
                <span className="score-amount">{formatKr(recurring.total)}</span>
                <span className="score-share" aria-hidden="true" />
              </td>
              <td className="num meta">{formatKr(usualTotal)}</td>
              <td className="num">
                <Difference delta={recurring.total - usualTotal} />
              </td>
              <td className="num">{formatKr(recurring.items.reduce((sum, i) => sum + ltm(i), 0))}</td>
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
          {props.busy ? "Saving…" : "Mark as non-recurring"}
        </button>
      </p>
    </div>
  );
}

function joinAnd(parts: string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "");
}
