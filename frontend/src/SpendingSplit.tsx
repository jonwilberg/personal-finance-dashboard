import { useEffect, useId, useRef, useState } from "react";
import type { ScoreboardRow, SpendingGroup } from "./api";
import { formatKr } from "./format";
import { groupFill } from "./spendingGroups";

// The month's spending as one tall bar, split by category: a "zoom in" on the month's column in the chart above it,
// stacked the same way (the groups in their order from the bottom, each group's categories largest first, what
// isn't categorized hatched on top of Other). The month's income stands to its left on the same scale, drawn like
// the chart's income (a pale column with a dark top edge), and cut short with a break when it is far above the
// spending. Both totals head their bars.
// - Every category gets a one-line label to the right, joined by an elbowed leader line, spread only as far as
//   needed to stop labels touching (order is kept, so leaders never cross).
// - On wide screens each group gets a bracket on the left with its name and total; narrower screens show the
//   groups as a legend line above instead.
// - Clicking a block or label jumps to its row in the table below.

const UNCATEGORIZED = "uncategorized";
const HEAD = 44; // the totals above the bars
const BAR_H = 420; // the bars' area below the totals
const BAR_W = 56;
const BAR_GAP = 12; // between the income and spending bars
const GAP = 2; // surface gap between blocks
const LINE = 21; // a label's line, spacing included
const GROUP_LINE = 38; // a group label's two lines, spacing included
const GROUPS_W = 190; // the bracket column, on wide screens
const BRACKETS_FROM = 620; // narrower than this: a legend line instead of brackets
const ELBOW = 14; // the leader's first, straight stretch out of the bar
const LEADER = 46; // from the bar's edge to the labels
// Income above this many times the spending is cut short, so the spending keeps most of the height.
const BREAK_FACTOR = 1.5;
const OVERSHOOT = 6; // a cut income bar reaches this far above the area, to show it carries on
const BREAK_AT = 16; // the break's distance below the area's top
const INCOME = "var(--chart-income)";
const INCOME_GHOST = "color-mix(in srgb, var(--chart-income) 9%, transparent)";

interface Block {
  row: ScoreboardRow;
  share: number;
  top: number;
  height: number;
}

export function shareText(share: number) {
  return share > 0 && share < 0.005 ? "<1 %" : `${Math.round(share * 100)} %`;
}

/**
 * Centres for a run of labels, each wanting to sit at `wanted` (top to bottom): pushed down where they would
 * touch, then back up from the bottom edge, so the run keeps its order and stays as near its marks as it can.
 */
function spread(wanted: number[], step: number, low: number, high: number) {
  const y = wanted.map((w) => Math.min(Math.max(w, low), high));
  for (let i = 1; i < y.length; i++) y[i] = Math.max(y[i], y[i - 1] + step);
  for (let i = y.length - 1; i >= 0; i--) {
    y[i] = Math.min(y[i], i === y.length - 1 ? high : y[i + 1] - step);
  }
  return y;
}

export function SpendingSplit({
  rows,
  groups,
  income,
}: {
  rows: ScoreboardRow[];
  groups: SpendingGroup[];
  /** The month's income, for the bar beside the spending. */
  income: number;
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
  const figures = (amount: number, share: number) => `${formatKr(amount)} · ${shareText(share)}`;

  // One scale for both bars: the taller one fills the area, unless income is far above the spending, when the
  // spending sets the scale (with some headroom) and the income bar is cut short.
  const earned = Math.max(income, 0);
  const cut = earned > total * BREAK_FACTOR;
  const scale = cut ? total * 1.15 : Math.max(total, earned);
  const base = HEAD + BAR_H; // the bars' common bottom
  const spentH = (total / scale) * BAR_H;
  const incomeTop = cut ? HEAD - OVERSHOOT : base - (earned / scale) * BAR_H;

  // Blocks from the bottom up; y grows downwards, so each block sits above the one before.
  const usable = spentH - GAP * (ordered.length - 1);
  let bottom = base;
  const blocks: Block[] = ordered.map((row) => {
    const height = Math.max((row.amount / total) * usable, 1.5);
    const block = { row, share: row.amount / total, top: bottom - height, height };
    bottom -= height + GAP;
    return block;
  });

  const brackets = width >= BRACKETS_FROM;
  const incomeX = brackets ? GROUPS_W : 0;
  const barX = incomeX + BAR_W + BAR_GAP;
  const barRight = barX + BAR_W;
  const labelX = barRight + LEADER;

  // Category labels, top to bottom (the reverse of the stacking order).
  const topDown = [...blocks].reverse();
  const labelY = spread(
    topDown.map((b) => b.top + b.height / 2),
    LINE,
    HEAD + LINE / 2,
    base - LINE / 2,
  );

  // Groups, with their span on the bar and their totals.
  const groupSpans = groups.flatMap((group) => {
    const members = blocks.filter((b) => b.row.group === group.id);
    if (members.length === 0) return [];
    const amount = members.reduce((sum, b) => sum + b.row.amount, 0);
    const top = Math.min(...members.map((b) => b.top));
    const end = Math.max(...members.map((b) => b.top + b.height));
    return [{ group, amount, share: amount / total, top, end }];
  });
  const groupsTopDown = [...groupSpans].reverse();
  const groupY = spread(
    groupsTopDown.map((g) => (g.top + g.end) / 2),
    GROUP_LINE,
    HEAD + GROUP_LINE / 2,
    base - GROUP_LINE / 2,
  );

  const fill = (row: ScoreboardRow) => (row.category === UNCATEGORIZED ? `url(#${hatchId})` : groupFill(row.group));
  const events = (category: string) => ({
    onMouseEnter: () => setHover(category),
    onMouseLeave: () => setHover(null),
    onFocus: () => setHover(category),
    onBlur: () => setHover(null),
    onClick: () => showRow(category),
  });
  const breakAt = HEAD + BREAK_AT;

  return (
    <div className="split" ref={frameRef}>
      {!brackets && (
        // Narrow screens: what the colours mean, with each group's total, as a legend line above.
        <div className="chart-legend split-legend">
          {groupSpans.map((g) => (
            <span key={g.group.id} className="legend-item">
              <span className="legend-swatch" style={{ background: groupFill(g.group.id) }} aria-hidden="true" />
              <span className="split-legend-name">{g.group.name}</span>
              <span className="split-figures">{figures(g.amount, g.share)}</span>
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

          {/* The month's income, on the spending's scale: a pale column with a dark top edge, broken when cut. */}
          {earned > 0 && (
            <g className="split-income">
              {cut ? (
                <>
                  <path
                    d={`M${incomeX},${incomeTop} H${incomeX + BAR_W} V${breakAt - 5} L${incomeX},${breakAt + 1} Z`}
                    fill={INCOME_GHOST}
                  />
                  <path
                    d={`M${incomeX},${breakAt + 5} L${incomeX + BAR_W},${breakAt - 1} V${base} H${incomeX} Z`}
                    fill={INCOME_GHOST}
                  />
                </>
              ) : (
                <rect x={incomeX} y={incomeTop} width={BAR_W} height={base - incomeTop} fill={INCOME_GHOST} />
              )}
              <line x1={incomeX} x2={incomeX + BAR_W} y1={incomeTop} y2={incomeTop} stroke={INCOME} strokeWidth={2} />
            </g>
          )}

          {brackets &&
            groupsTopDown.map((g, i) => {
              const x = incomeX - 10;
              const mid = (g.top + g.end) / 2;
              return (
                <g key={g.group.id} className="split-bracket">
                  <path d={`M${x + 5},${g.top + 1} H${x} V${g.end - 1} H${x + 5}`} fill="none" />
                  {/* From the bracket's middle out to its label, where the label had to move. */}
                  <path d={`M${x},${mid} H${x - 8} L${x - 16},${groupY[i]}`} fill="none" />
                </g>
              );
            })}

          {topDown.map((b, i) => {
            const isHover = hover === b.row.category;
            const cy = b.top + b.height / 2;
            return (
              <g key={b.row.category}>
                <rect
                  className={`split-block${hover && !isHover ? " is-dimmed" : ""}`}
                  x={barX}
                  y={b.top}
                  width={BAR_W}
                  height={b.height}
                  fill={fill(b.row)}
                  onMouseEnter={() => setHover(b.row.category)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => showRow(b.row.category)}
                />
                <path
                  className={`split-leader${isHover ? " is-hover" : ""}`}
                  d={`M${barRight + 2},${cy} H${barRight + ELBOW} L${labelX - 6},${labelY[i]}`}
                  fill="none"
                />
              </g>
            );
          })}
        </svg>

        {/* The two totals, heading their bars. */}
        {earned > 0 && (
          <div className="split-total" style={{ left: incomeX - BAR_GAP / 2, width: BAR_W + BAR_GAP }}>
            <span className="split-total-label">Income</span>
            <span className="split-total-value">{formatKr(earned)}</span>
          </div>
        )}
        <div className="split-total" style={{ left: barX - BAR_GAP / 2, width: BAR_W + BAR_GAP }}>
          <span className="split-total-label">Spent</span>
          <span className="split-total-value">{formatKr(total)}</span>
        </div>

        {brackets &&
          groupsTopDown.map((g, i) => (
            <div
              key={g.group.id}
              className="split-group"
              style={{ top: groupY[i] - GROUP_LINE / 2 + 2, right: width - (incomeX - 30), height: GROUP_LINE - 4 }}
            >
              <span className="split-group-name">
                <span className="legend-swatch" style={{ background: groupFill(g.group.id) }} aria-hidden="true" />
                {g.group.name}
              </span>
              <span className="split-figures">{figures(g.amount, g.share)}</span>
            </div>
          ))}

        {topDown.map((b, i) => (
          <button
            key={b.row.category}
            type="button"
            className={`split-label${hover === b.row.category ? " is-hover" : ""}`}
            style={{ top: labelY[i] - LINE / 2, left: labelX, maxWidth: width - labelX, height: LINE }}
            title={`${b.row.name}: ${figures(b.row.amount, b.share)}. Show in the table.`}
            {...events(b.row.category)}
          >
            <span className="split-name">{b.row.name}</span>
            <span className="split-figures">
              {formatKr(b.row.amount)} · <span className="split-share">{shareText(b.share)}</span>
            </span>
          </button>
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
