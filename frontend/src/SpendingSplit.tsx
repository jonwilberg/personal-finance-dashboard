import { useEffect, useId, useRef, useState } from "react";
import type { IncomeRow, ScoreboardRow, SpendingGroup } from "./api";
import { formatKr } from "./format";
import { groupFill } from "./spendingGroups";

// The month as money in and money out, side by side: a "zoom in" on the month's column in the chart above.
// - Spending is one wide bar stacked like the chart (the groups in their order from the bottom, each group's
//   categories largest first, uncategorized hatched on top). Each category's name and amount sit inside its block
//   when they fit; on the right each group has its total, on a leader from a line spanning the group's whole band.
// - Income stands to its left on the same scale, split by income category in tints of the income ink, labelled the
//   same way. It is cut short with a break when it is far above the spending.
// - A bracket between the bars marks what was kept or overspent; the two totals head their bars.
// - Clicking a spending category jumps to its row in the table below.

const UNCATEGORIZED = "uncategorized";
const TOTALS_H = 34; // a total above its bar
const HEAD = 76; // room above the taller bar for its total and, above that, the savings connector
const BAR_H = 480; // the bars' area below the totals
const GAP = 2; // surface gap between blocks
const LINE = 22; // a group label's line on wide screens
const NARROW_LINE = 36; // two lines (name, then figures) on narrow ones
const LABEL_GAP = 6; // between group labels
const ELBOW = 12; // a leader's first, straight stretch out of the bar
const WIDE = 720; // narrower than this: slimmer bars and two-line group labels
const SIZES = {
  wide: { income: 200, spent: 260, gap: 28, leader: 40 },
  narrow: { income: 60, spent: 150, gap: 14, leader: 16 },
};
const INSIDE_PAD = 8; // text inset inside a block
const ONE_LINE_H = 17; // a block this tall takes a one-line label
const TWO_LINE_H = 34; // and this tall, two lines
const BREAK_FACTOR = 1.5; // income above this many times the spending is cut short
const OVERSHOOT = 6; // a cut income bar reaches this far above the area, to show it carries on
const BREAK_AT = 18; // the break's distance below the area's top
const INCOME = "var(--chart-income)";
const INCOME_TINTS = [20, 11, 7, 5]; // % of the income ink, largest category first
// Group colours dark enough for light text inside; the rest take ink (each the better of the two).
const LIGHT_TEXT_GROUPS = new Set(["fixed", "dining", "travel"]);
const FONT = '12px "Inter Variable", system-ui, -apple-system, "Segoe UI", sans-serif';

interface Block {
  key: string;
  name: string;
  amount: number;
  top: number;
  height: number;
}

type Fit = "one" | "two" | "none";

let canvas: HTMLCanvasElement | null = null;
/** Text width in the label font, with room for the fixed-width digits the labels use (canvas can't apply them). */
function textWidth(text: string, weight = 400): number {
  canvas ??= document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return text.length * 7;
  context.font = `${weight} ${FONT}`;
  return context.measureText(text).width * 1.08;
}

/** How a block's name and amount fit inside it: side by side, stacked, or not at all. */
function fit(name: string, amount: string, width: number, height: number): Fit {
  const room = width - INSIDE_PAD * 2;
  const nameW = textWidth(name);
  const amountW = textWidth(amount);
  if (height >= ONE_LINE_H && nameW + amountW + 16 <= room) return "one";
  if (height >= TWO_LINE_H && Math.max(nameW, amountW) <= room) return "two";
  return "none";
}

export function shareText(share: number) {
  return share > 0 && share < 0.005 ? "<1 %" : `${Math.round(share * 100)} %`;
}

/**
 * Tops for a run of labels of one height, each wanting to start at `wanted` (top to bottom): pushed down where they
 * would touch, then back up from the bottom edge, so the run keeps its order and stays as near its marks as it can.
 */
function spread(wanted: number[], height: number, gap: number, low: number, high: number) {
  const top = wanted.map((w) => Math.min(Math.max(w, low), high - height));
  for (let i = 1; i < top.length; i++) top[i] = Math.max(top[i], top[i - 1] + height + gap);
  for (let i = top.length - 1; i >= 0; i--) {
    const limit = i === top.length - 1 ? high - height : top[i + 1] - gap - height;
    top[i] = Math.max(low, Math.min(top[i], limit));
  }
  return top;
}

/** Blocks stacked from `base` upwards over `height`, with `gapBefore(i)` above each block after the first. */
function stack<T>(items: T[], amount: (item: T) => number, base: number, height: number, gapBefore: (i: number) => number) {
  const total = items.reduce((sum, item) => sum + amount(item), 0) || 1;
  const gaps = items.reduce((sum, _, i) => sum + (i > 0 ? gapBefore(i) : 0), 0);
  const usable = Math.max(height - gaps, 0);
  let bottom = base;
  return items.map((item, i) => {
    if (i > 0) bottom -= gapBefore(i);
    const h = Math.max((amount(item) / total) * usable, 1.5);
    const top = bottom - h;
    bottom = top;
    return { item, top, height: h };
  });
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
  const [, setFontsReady] = useState(false); // re-measure once the web font has loaded
  const hatchId = useId().replace(/:/g, "");

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))));
    observer.observe(frame);
    document.fonts?.ready.then(() => setFontsReady(true));
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

  const wide = width >= WIDE;
  const size = wide ? SIZES.wide : SIZES.narrow;
  const incomeX = 0;
  const barX = size.income + size.gap;
  const barRight = barX + size.spent;
  const labelX = barRight + size.leader;
  const labelW = Math.max(Math.min(width - labelX, 270), 0); // capped, so totals stay near their names
  const base = HEAD + BAR_H; // the bars' common bottom

  // One scale for both bars: the taller one fills the area, unless income is far above the spending, when the
  // spending sets the scale (with some headroom) and the income bar is cut short.
  const cut = earned > total * BREAK_FACTOR;
  const scale = cut ? total * 1.15 : Math.max(total, earned, 1);
  const spentTop = base - (total / scale) * BAR_H;
  const incomeTop = earned <= 0 ? base : cut ? HEAD - OVERSHOOT : base - (earned / scale) * BAR_H;

  const blocks: (Block & { row: ScoreboardRow })[] = stack(
    ordered,
    (r) => r.amount,
    base,
    base - spentTop,
    () => GAP,
  ).map(({ item, top, height }) => ({ key: item.category, name: item.name, amount: item.amount, top, height, row: item }));

  const incomeBlocks = stack(earnedRows, (r) => r.amount, base, base - incomeTop, () => GAP).map(
    ({ item, top, height }, i) => ({
      key: item.category,
      name: item.name,
      amount: item.amount,
      top,
      height,
      tint: INCOME_TINTS[Math.min(i, INCOME_TINTS.length - 1)],
    }),
  );

  // Each group's band on the bar and its label on the right, top down.
  const groupsTopDown = [...groups]
    .filter((g) => blocks.some((b) => b.row.group === g.id))
    .reverse()
    .map((group) => {
      const members = blocks.filter((b) => b.row.group === group.id);
      const top = Math.min(...members.map((b) => b.top));
      const end = Math.max(...members.map((b) => b.top + b.height));
      const amount = members.reduce((sum, b) => sum + b.amount, 0);
      return { group, amount, top, end, mid: (top + end) / 2 };
    });
  const lineH = wide ? LINE : NARROW_LINE;
  const groupTops = spread(
    groupsTopDown.map((g) => g.mid - lineH / 2),
    lineH,
    LABEL_GAP,
    HEAD,
    base,
  );

  // Savings or loss: a connector from the top of the income bar, over, and down onto the top of the spending bar,
  // with the difference in a pill on it (green for savings, red for a loss).
  const net = earned - total;
  const showNet = earned > 0 && Math.round(net) !== 0;
  const fromX = incomeX + size.income / 2;
  const toX = barX + size.spent / 2;
  // Each total sits just above its bar; the connector runs above both, from one total over to the other.
  const incomeLabelTop = incomeTop - TOTALS_H - 4;
  const spentLabelTop = spentTop - TOTALS_H - 4;
  const connectorY = Math.min(incomeLabelTop, spentLabelTop) - 14;
  const breakAt = HEAD + BREAK_AT;

  const fill = (row: ScoreboardRow) => (row.category === UNCATEGORIZED ? `url(#${hatchId})` : groupFill(row.group));
  const textTone = (row: ScoreboardRow) =>
    row.category === UNCATEGORIZED ? "on-hatch" : LIGHT_TEXT_GROUPS.has(row.group) ? "on-dark" : "on-light";

  return (
    <div className={`split${wide ? "" : " is-narrow"}`} ref={frameRef}>
      {!wide && earnedRows.length > 0 && (
        // Narrow screens: the income bar is too slim for labels, so its categories are a line above.
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
              key={b.key}
              x={incomeX}
              y={b.top}
              width={size.income}
              height={b.height}
              fill={`color-mix(in srgb, ${INCOME} ${b.tint}%, transparent)`}
            />
          ))}
          {earned > 0 && (
            <line x1={incomeX} x2={incomeX + size.income} y1={incomeTop} y2={incomeTop} stroke={INCOME} strokeWidth={2} />
          )}
          {cut && (
            <path
              d={`M${incomeX - 1},${breakAt + 4} L${incomeX + size.income + 1},${breakAt - 6} V${breakAt - 2} L${incomeX - 1},${breakAt + 8} Z`}
              fill="var(--paper)"
            />
          )}

          {/* Spending by category. */}
          {blocks.map((b) => (
            <rect
              key={b.key}
              className={`split-block${hover && hover !== b.key ? " is-dimmed" : ""}`}
              x={barX}
              y={b.top}
              width={size.spent}
              height={b.height}
              fill={fill(b.row)}
              onMouseEnter={() => setHover(b.key)}
              onMouseLeave={() => setHover(null)}
              onClick={() => showRow(b.key)}
            />
          ))}
          {groupsTopDown.map((g, i) => (
            <path
              key={g.group.id}
              className="split-leader"
              d={`M${barRight + 5},${g.top + 1} V${g.end - 1} M${barRight + 5},${g.mid} H${barRight + Math.min(ELBOW, size.leader / 2)} L${labelX - 4},${groupTops[i] + lineH / 2}`}
              fill="none"
            />
          ))}

          {showNet && (
            <g className="split-connector">
              <path d={`M${fromX},${incomeLabelTop - 3} V${connectorY} H${toX} V${spentLabelTop - 9}`} fill="none" />
              <path
                d={`M${toX - 4},${spentLabelTop - 10} H${toX + 4} L${toX},${spentLabelTop - 3} Z`}
                className="split-arrow"
              />
            </g>
          )}
        </svg>

        {/* The two totals, each just above its bar, under the connector. */}
        {earned > 0 && (
          <div className="split-total" style={{ left: incomeX, width: size.income, top: incomeLabelTop }}>
            <span className="split-total-label">Income</span>
            <span className="split-total-value">{formatKr(earned)}</span>
          </div>
        )}
        <div className="split-total" style={{ left: barX, width: size.spent, top: spentLabelTop }}>
          <span className="split-total-label">Spending</span>
          <span className="split-total-value">{formatKr(total)}</span>
        </div>

        {/* Each income category's name and amount inside its block, where they fit. */}
        {incomeBlocks.map((b) => {
          const amount = formatKr(b.amount);
          const how = fit(b.name, amount, size.income, b.height);
          if (how === "none") return null;
          return (
            <div
              key={b.key}
              className={`split-inside on-light is-${how}`}
              style={{ left: incomeX, top: b.top, width: size.income, height: b.height }}
              title={`${b.name}: ${amount}`}
            >
              <span className="split-inside-name">{b.name}</span>
              <span className="split-inside-amount">{amount}</span>
            </div>
          );
        })}

        {/* Each spending category inside its block, where it fits; all of them are in the table below. */}
        {blocks.map((b) => {
          const amount = formatKr(b.amount);
          const how = fit(b.name, amount, size.spent, b.height);
          if (how === "none") return null;
          return (
            <button
              key={b.key}
              type="button"
              className={`split-inside ${textTone(b.row)} is-${how}${hover === b.key ? " is-hover" : ""}`}
              style={{ left: barX, top: b.top, width: size.spent, height: b.height }}
              title={`${b.name}: ${amount}. Show in the table.`}
              onMouseEnter={() => setHover(b.key)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(b.key)}
              onBlur={() => setHover(null)}
              onClick={() => showRow(b.key)}
            >
              <span className="split-inside-name">{b.name}</span>
              <span className="split-inside-amount">{amount}</span>
            </button>
          );
        })}

        {showNet && (
          <div
            className={`split-pill ${net >= 0 ? "is-up" : "is-down"}`}
            style={{ left: (fromX + toX) / 2, top: connectorY }}
          >
            {net >= 0 ? "Savings" : "Loss"} <span className="split-pill-value">{formatKr(Math.abs(net))}</span>
          </div>
        )}

        {/* Each group's total on the right, joined to its band. */}
        {groupsTopDown.map((g, i) => (
          <div
            key={g.group.id}
            className={`split-group-label${wide ? "" : " is-stacked"}`}
            style={{ top: groupTops[i], left: labelX, width: labelW, height: lineH }}
          >
            <span className="split-name">
              <span className="legend-swatch" style={{ background: groupFill(g.group.id) }} aria-hidden="true" />
              {g.group.name}
            </span>
            <span className="split-amount">{formatKr(g.amount)}</span>
            <span className="split-share">{shareText(g.amount / total)}</span>
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
