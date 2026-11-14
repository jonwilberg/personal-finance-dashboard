import { useEffect, useId, useRef, useState } from "react";
import type { IncomeRow, ScoreboardRow, SpendingGroup } from "./api";
import { formatKr } from "./format";
import { groupFill } from "./spendingGroups";

// The month as money in and money out, side by side: a "zoom in" on the month's column in the chart above.
// - Spending is one tall bar stacked like the chart (the groups in their order from the bottom, a slightly wider gap
//   between groups, each group's categories largest first, uncategorized hatched on top). On the right each group
//   has a heading with its total, joined to its band by one leader, and its categories listed underneath.
// - Income stands to its left on the same scale, split by income category in tints of the income ink and labelled
//   on the left. It is cut short with a break when it is far above the spending.
// - A bracket between the bars marks what was kept or overspent; the two totals head their bars.
// - Amounts and shares sit in right-aligned columns, so they read like the ledger above.
// - Clicking a category jumps to its row in the table below.

const UNCATEGORIZED = "uncategorized";
const HEAD = 44; // the totals above the bars
const MIN_BAR_H = 420; // the bars' area below the totals; taller when the labels need it
const BAR_W = 56;
const BAR_GAP = 16; // between the income and spending bars, where the kept bracket goes
const GAP = 2; // surface gap between blocks
const GROUP_GAP = 6; // a slightly wider gap between groups
const LINE = 20; // a label line
const BLOCK_GAP = 8; // between one group's labels and the next
const ELBOW = 12; // a leader's first, straight stretch out of a bar
const LEADER = 40; // from a bar's edge to its labels
const INCOME_LABELS_W = 240; // the income labels on the left, on wide screens
const WIDE = 720; // narrower than this: income categories as a line above
const BREAK_FACTOR = 1.5; // income above this many times the spending is cut short
const OVERSHOOT = 6; // a cut income bar reaches this far above the area, to show it carries on
const BREAK_AT = 18; // the break's distance below the area's top
const INCOME = "var(--chart-income)";
const INCOME_TINTS = [20, 11, 7, 5]; // % of the income ink, largest category first

interface Block {
  row: ScoreboardRow;
  top: number;
  height: number;
}

export function shareText(share: number) {
  return share > 0 && share < 0.005 ? "<1 %" : `${Math.round(share * 100)} %`;
}

/**
 * Tops for a run of label blocks of the given heights, each wanting to start at `wanted` (top to bottom): pushed
 * down where they would touch, then back up from the bottom edge, so the run keeps its order and stays as near its
 * marks as it can.
 */
function spread(wanted: number[], heights: number[], gap: number, low: number, high: number) {
  const top = wanted.map((w, i) => Math.min(Math.max(w, low), high - heights[i]));
  for (let i = 1; i < top.length; i++) top[i] = Math.max(top[i], top[i - 1] + heights[i - 1] + gap);
  for (let i = top.length - 1; i >= 0; i--) {
    const limit = i === top.length - 1 ? high - heights[i] : top[i + 1] - gap - heights[i];
    top[i] = Math.max(low, Math.min(top[i], limit));
  }
  return top;
}

export function SpendingSplit({
  rows,
  groups,
  income,
}: {
  rows: ScoreboardRow[];
  groups: SpendingGroup[];
  /** The month's income per income category, largest first. */
  income: IncomeRow[];
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<string | null>(null);
  const hatchId = useId().replace(/:/g, "");

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const spent = rows.filter((r) => r.amount > 0); // refunds larger than the spending leave nothing to show
  if (spent.length === 0) return null;
  const rank = (row: ScoreboardRow) => {
    const index = groups.findIndex((g) => g.id === row.group);
    return index < 0 ? groups.length : index;
  };
  // Bottom first: the groups in chart order, each group's largest first, uncategorized last.
  const ordered = [...spent].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Number(a.category === UNCATEGORIZED) - Number(b.category === UNCATEGORIZED) ||
      b.amount - a.amount,
  );
  const total = ordered.reduce((sum, r) => sum + r.amount, 0);
  const earnedRows = income.filter((r) => r.amount > 0);
  const earned = earnedRows.reduce((sum, r) => sum + r.amount, 0);

  // The groups top down, each with its categories (largest first) for the labels on the right.
  const groupsUsed = groups.filter((g) => ordered.some((r) => r.group === g.id));
  const labelGroups = [...groupsUsed].reverse().map((group) => {
    const members = ordered.filter((r) => r.group === group.id);
    const amount = members.reduce((sum, r) => sum + r.amount, 0);
    return { group, members, amount, height: LINE * (members.length + 1) };
  });
  const needed = labelGroups.reduce((sum, g) => sum + g.height, 0) + BLOCK_GAP * (labelGroups.length - 1);
  const barH = Math.max(MIN_BAR_H, needed);
  const base = HEAD + barH; // the bars' common bottom

  // One scale for both bars: the taller one fills the area, unless income is far above the spending, when the
  // spending sets the scale (with some headroom) and the income bar is cut short.
  const cut = earned > total * BREAK_FACTOR;
  const scale = cut ? total * 1.15 : Math.max(total, earned, 1);
  const spentTop = base - (total / scale) * barH;
  const incomeTop = earned <= 0 ? base : cut ? HEAD - OVERSHOOT : base - (earned / scale) * barH;

  // Spending blocks from the bottom up, with a wider gap where the group changes.
  const changes = ordered.filter((r, i) => i > 0 && r.group !== ordered[i - 1].group).length;
  const usable = base - spentTop - GAP * (ordered.length - 1) - (GROUP_GAP - GAP) * changes;
  let bottom = base;
  const blocks: Block[] = ordered.map((row, i) => {
    if (i > 0) bottom -= row.group !== ordered[i - 1].group ? GROUP_GAP : GAP;
    const height = Math.max((row.amount / total) * usable, 1.5);
    const block = { row, top: bottom - height, height };
    bottom -= height;
    return block;
  });

  // Income blocks from the bottom up, largest first, within the income bar as drawn.
  const incomeUsable = base - incomeTop - GAP * Math.max(earnedRows.length - 1, 0);
  let incomeBottom = base;
  const incomeBlocks = earnedRows.map((row, i) => {
    if (i > 0) incomeBottom -= GAP;
    const height = Math.max((row.amount / earned) * incomeUsable, 1.5);
    const block = { row, top: incomeBottom - height, height, tint: INCOME_TINTS[Math.min(i, INCOME_TINTS.length - 1)] };
    incomeBottom -= height;
    return block;
  });

  const wide = width >= WIDE;
  // Narrow screens: slimmer bars and shorter leaders, so the category names keep their room.
  const barW = wide ? BAR_W : 44;
  const barGap = wide ? BAR_GAP : 14;
  const leader = wide ? LEADER : 22;
  const incomeX = wide ? INCOME_LABELS_W + LEADER : 0;
  const barX = incomeX + barW + barGap;
  const barRight = barX + barW;
  const labelX = barRight + leader;
  const labelW = Math.min(400, width - labelX);
  const withShares = labelW >= 300;

  // Where each group's labels go, and where its band sits on the bar.
  const bands = labelGroups.map((g) => {
    const members = blocks.filter((b) => b.row.group === g.group.id);
    const top = Math.min(...members.map((b) => b.top));
    const end = Math.max(...members.map((b) => b.top + b.height));
    return { top, end, mid: (top + end) / 2 };
  });
  const groupTops = spread(
    bands.map((band) => band.mid - LINE / 2),
    labelGroups.map((g) => g.height),
    BLOCK_GAP,
    HEAD,
    base,
  );

  // Income labels on the left, top down.
  const incomeTopDown = [...incomeBlocks].reverse();
  const incomeLabelTops = spread(
    incomeTopDown.map((b) => b.top + b.height / 2 - LINE / 2),
    incomeTopDown.map(() => LINE),
    2,
    HEAD,
    base,
  );

  // What was kept or overspent: a bracket between the bars, labelled over the shorter one.
  const net = earned - total;
  const higher = Math.min(incomeTop, spentTop);
  const lower = Math.max(incomeTop, spentTop);
  const showNet = earned > 0 && lower - higher >= 6;
  const shorterX = incomeTop > spentTop ? incomeX : barX;
  const netY = Math.max(HEAD + 18, (higher + lower) / 2);
  const bracketX = incomeX + barW + barGap / 2;
  const breakAt = HEAD + BREAK_AT;

  const fill = (row: ScoreboardRow) => (row.category === UNCATEGORIZED ? `url(#${hatchId})` : groupFill(row.group));
  const events = (category: string) => ({
    onMouseEnter: () => setHover(category),
    onMouseLeave: () => setHover(null),
    onFocus: () => setHover(category),
    onBlur: () => setHover(null),
    onClick: () => showRow(category),
  });
  const columns = withShares ? "minmax(0, 1fr) 96px 44px" : "minmax(0, 1fr) 72px";

  return (
    <div className={`split${wide ? "" : " is-narrow"}`} ref={frameRef}>
      {!wide && earnedRows.length > 0 && (
        // Narrow screens: the income categories as a line above.
        <div className="chart-legend split-legend">
          {earnedRows.map((row, i) => (
            <span key={row.category} className="legend-item">
              <span
                className="legend-swatch"
                style={{ background: `color-mix(in srgb, ${INCOME} ${INCOME_TINTS[Math.min(i, 3)]}%, transparent)` }}
                aria-hidden="true"
              />
              <span className="split-legend-name">{row.name}</span>
              <span className="split-figures">{formatKr(row.amount)}</span>
            </span>
          ))}
        </div>
      )}
      <div className="split-frame" style={{ height: base }}>
        <svg width={width} height={base} aria-hidden="true">
          <defs>
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--paper-sunken)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--ink-muted)" strokeWidth="2" />
            </pattern>
          </defs>

          {/* Income by category, in tints of the income ink, with its dark top edge and, when cut, a break. */}
          {incomeBlocks.map((b) => (
            <rect
              key={b.row.category}
              x={incomeX}
              y={b.top}
              width={barW}
              height={b.height}
              fill={`color-mix(in srgb, ${INCOME} ${b.tint}%, transparent)`}
            />
          ))}
          {earned > 0 && (
            <line x1={incomeX} x2={incomeX + barW} y1={incomeTop} y2={incomeTop} stroke={INCOME} strokeWidth={2} />
          )}
          {cut && (
            <path
              d={`M${incomeX - 1},${breakAt + 2} L${incomeX + barW + 1},${breakAt - 4} V${breakAt} L${incomeX - 1},${breakAt + 6} Z`}
              fill="var(--paper)"
            />
          )}
          {wide &&
            incomeTopDown.map((b, i) => (
              <path
                key={b.row.category}
                className="split-leader"
                d={`M${incomeX - 2},${b.top + b.height / 2} H${incomeX - ELBOW} L${incomeX - LEADER + 6},${incomeLabelTops[i] + LINE / 2}`}
                fill="none"
              />
            ))}

          {/* Spending by category. */}
          {blocks.map((b) => (
            <rect
              key={b.row.category}
              className={`split-block${hover && hover !== b.row.category ? " is-dimmed" : ""}`}
              x={barX}
              y={b.top}
              width={barW}
              height={b.height}
              fill={fill(b.row)}
              onMouseEnter={() => setHover(b.row.category)}
              onMouseLeave={() => setHover(null)}
              onClick={() => showRow(b.row.category)}
            />
          ))}
          {labelGroups.map((g, i) => (
            <path
              key={g.group.id}
              className="split-leader"
              d={`M${barRight + 2},${bands[i].mid} H${barRight + ELBOW} L${labelX - 6},${groupTops[i] + LINE / 2}`}
              fill="none"
            />
          ))}

          {showNet && (
            <path
              className={`split-net-bracket ${net >= 0 ? "is-up" : "is-down"}`}
              d={`M${bracketX - 3},${higher} H${bracketX + 3} M${bracketX},${higher} V${lower} M${bracketX - 3},${lower} H${bracketX + 3}`}
              fill="none"
            />
          )}
        </svg>

        {/* The two totals, heading their bars. */}
        {earned > 0 && (
          <div className="split-total" style={{ left: incomeX - barGap / 2, width: barW + barGap }}>
            <span className="split-total-label">Income</span>
            <span className="split-total-value">{formatKr(earned)}</span>
          </div>
        )}
        <div className="split-total" style={{ left: barX - barGap / 2, width: barW + barGap }}>
          <span className="split-total-label">Spent</span>
          <span className="split-total-value">{formatKr(total)}</span>
        </div>

        {showNet && (
          <div
            className={`split-net ${net >= 0 ? "is-up" : "is-down"}`}
            style={{ left: shorterX + barW / 2, top: netY }}
          >
            <span>{net >= 0 ? "Kept" : "Overspent"}</span>
            <span className="split-net-value">{formatKr(Math.abs(net))}</span>
          </div>
        )}

        {wide &&
          incomeTopDown.map((b, i) => (
            <div
              key={b.row.category}
              className="split-row split-income-row"
              style={{ top: incomeLabelTops[i], left: 0, width: INCOME_LABELS_W, height: LINE, gridTemplateColumns: columns }}
            >
              <span className="split-name">{b.row.name}</span>
              <span className="split-amount">{formatKr(b.row.amount)}</span>
              {withShares && <span className="split-share">{shareText(b.row.amount / earned)}</span>}
            </div>
          ))}

        {labelGroups.map((g, i) => (
          <div key={g.group.id} className="split-group" style={{ top: groupTops[i], left: labelX, width: labelW }}>
            <div className="split-row split-group-row" style={{ height: LINE, gridTemplateColumns: columns }}>
              <span className="split-name">
                <span className="legend-swatch" style={{ background: groupFill(g.group.id) }} aria-hidden="true" />
                {g.group.name}
              </span>
              <span className="split-amount">{formatKr(g.amount)}</span>
              {withShares && <span className="split-share">{shareText(g.amount / total)}</span>}
            </div>
            {g.members.map((row) => (
              <button
                key={row.category}
                type="button"
                className={`split-row split-category${hover === row.category ? " is-hover" : ""}`}
                style={{ height: LINE, gridTemplateColumns: columns }}
                title={`${row.name}: ${formatKr(row.amount)}. Show in the table.`}
                {...events(row.category)}
              >
                <span className="split-name">{row.name}</span>
                <span className="split-amount">{formatKr(row.amount)}</span>
                {withShares && <span className="split-share">{shareText(row.amount / total)}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Scroll to the category's row in the table below and flash it briefly. */
function showRow(category: string) {
  const row = document.getElementById(`scoreboard-${category}`);
  if (!row) return;
  const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  row.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "center" });
  row.classList.remove("is-flash");
  void row.getBoundingClientRect(); // restart the animation if it's clicked again
  row.classList.add("is-flash");
  window.setTimeout(() => row.classList.remove("is-flash"), 1800);
}
