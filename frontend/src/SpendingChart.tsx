import { useEffect, useRef, useState } from "react";
import type { OverviewMonth, SpendingGroup } from "./api";
import { formatKr } from "./format";
import { groupFill } from "./spendingGroups";

// Each month is one column: income stands behind as a pale column with a dark top edge, and spending is stacked in
// front of it by group (fixed costs at the bottom, Other on top). Where the spending stops short of the income's top,
// that is what was kept; where it rises above it, the month was overspent. The label on top says which, and by how
// much.
const INCOME = "var(--chart-income)";
const INCOME_GHOST = "color-mix(in srgb, var(--chart-income) 9%, transparent)";

const HEIGHT = 240;
const PAD = { top: 28, right: 8, bottom: 28, left: 52 }; // top leaves room for the labels and broken columns
const GAP = 2; // surface gap between stacked segments
const RADIUS = 4; // rounded data-end on the top of each bar
const EDGE = 2; // the income column's top edge

// Income far above a typical month (a bonus, a tax refund) would squash every other bar, so it's left out of the
// scale and its column is cut short with a break. "Far above": more than BREAK_FACTOR times the median month's income,
// and well above every other bar.
const BREAK_FACTOR = 1.5;
const OVERSHOOT = 6; // a broken column reaches this far above the top gridline, to show it carries on
const BREAK_AT = 14; // the break's distance below the top gridline
const BREAK_GAP = 4;
const BREAK_SLANT = 3;

export function SpendingChart(props: {
  series: OverviewMonth[];
  /** The spending groups, in stacking order (bottom first). */
  groups: SpendingGroup[];
  selected: string;
  onSelect: (month: string) => void;
}) {
  const { series, selected } = props;
  const [hover, setHover] = useState<number | null>(null);
  const segmentsOf = props.groups.map((g) => ({ key: g.id, label: g.name, fill: groupFill(g.id) }));
  // Draw at the frame's real width so text and marks keep their pixel sizes.
  const frameRef = useRef<HTMLDivElement>(null);
  const [WIDTH, setWidth] = useState(720);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, Math.round(entry.contentRect.width))));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const totals = series.map((m) => m.fixed + m.adjustable + m.uncategorized);
  const incomes = series.map((m) => Math.max(m.income, 0));
  const nets = series.map((_, i) => incomes[i] - totals[i]);
  const outliers = incomeOutliers(incomes, Math.max(...totals));
  const { max, ticks } = niceScale(Math.max(...totals, ...incomes.filter((_, i) => !outliers.has(i)), 1));
  // An outlier can still fit under the rounded-up scale; then it's drawn in full after all.
  const cut = incomes.map((income) => income > max);
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / Math.max(series.length, 1);
  const colW = Math.min(46, band * 0.72); // the income column
  const barW = colW * 0.58; // the spending stack in front of it
  const y = (value: number) => PAD.top + plotH - (value / max) * plotH;
  const colX = (i: number) => PAD.left + band * i + (band - colW) / 2;
  const barX = (i: number) => colX(i) + (colW - barW) / 2;
  const incomeTop = (i: number) => (cut[i] ? PAD.top - OVERSHOOT : y(incomes[i]));

  const labels = placeLabels();
  const hovered = hover !== null ? series[hover] : null;

  /**
   * Each month's net above its column, "+42k" kept or "−30k" overspent, compact so twelve fit; the selected month's
   * is set bolder. The selected month goes first; a label that would touch one already placed (narrow columns on
   * phones) is left out, since the tooltip and the table have every figure.
   */
  function placeLabels() {
    const placed: { x0: number; x1: number }[] = [];
    const out: { i: number; text: string; cx: number; baseline: number; up: boolean }[] = [];
    const place = (i: number) => {
      if (incomes[i] <= 0 && totals[i] <= 0) return;
      const isSelected = series[i].month === selected;
      const size = isSelected ? 12 : 11;
      const text = `${nets[i] >= 0 ? "+" : "−"}${barTotal(Math.abs(nets[i]), band)}`;
      const half = (text.length * size * 0.58 + 4) / 2; // estimated width (tabular figures), plus the halo
      const cx = colX(i) + colW / 2;
      const box = { x0: cx - half, x1: cx + half };
      if (box.x0 < PAD.left - 4 || box.x1 > WIDTH - 2 || placed.some((p) => box.x0 < p.x1 + 2 && p.x0 < box.x1 + 2)) {
        return;
      }
      placed.push(box);
      const top = Math.min(incomes[i] > 0 ? incomeTop(i) : y(0), y(totals[i]));
      out.push({ i, text, cx, baseline: top - (isSelected ? 8 : 6), up: nets[i] >= 0 });
    };
    const chosen = series.findIndex((m) => m.month === selected);
    if (chosen >= 0) place(chosen);
    series.forEach((_, i) => i !== chosen && place(i));
    return out;
  }

  return (
    <div className="chart">
      <div className="chart-legend" aria-hidden="true">
        {segmentsOf.map((s) => (
          <span key={s.key} className="legend-item">
            <span className="legend-swatch" style={{ background: s.fill }} />
            {s.label}
          </span>
        ))}
        <span className="legend-item">
          <span className="legend-swatch legend-income" />
          Income
        </span>
      </div>

      <div className="chart-frame" ref={frameRef}>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Spending and income per month">
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--rule)"
                strokeDasharray={tick === 0 ? undefined : "2 3"}
              />
              <text x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="chart-axis">
                {compactKr(tick)}
              </text>
            </g>
          ))}

          {series.map((month, i) => {
            const x = barX(i);
            const isSelected = month.month === selected;
            let base = 0;
            const segments = segmentsOf
              .map((s) => {
                const value = month.groups[s.key] ?? 0;
                const segment = { ...s, value, from: base, to: base + value };
                base += value;
                return segment;
              })
              .filter((s) => s.value > 0);
            const top = incomeTop(i);
            return (
              <g
                key={month.month}
                className={`chart-bar ${isSelected ? "is-selected" : ""}`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onClick={() => props.onSelect(month.month)}
              >
                {/* The month's column: highlights the selected month (and the hovered one, lightly) and doubles as
                    a hit target wider and taller than the bars. */}
                <rect
                  className={`chart-column ${isSelected ? "is-selected" : hover === i ? "is-hovered" : ""}`}
                  x={PAD.left + band * i + 2}
                  y={4}
                  width={band - 4}
                  height={HEIGHT - 4}
                  rx={4}
                />
                {incomes[i] > 0 && (
                  <>
                    <path
                      d={
                        cut[i]
                          ? brokenBar(colX(i), top, colW, y(0), PAD.top + BREAK_AT)
                          : roundedTop(colX(i), top, colW, Math.max(y(0) - top, 0.5), RADIUS)
                      }
                      fill={INCOME_GHOST}
                    />
                    <path d={roundedEdge(colX(i), top, colW, RADIUS)} fill="none" stroke={INCOME} strokeWidth={EDGE} />
                  </>
                )}
                {segments.map((s, j) => {
                  const segTop = y(s.to);
                  const bottom = y(s.from) - (j > 0 ? GAP : 0);
                  const h = Math.max(bottom - segTop, 0.5);
                  return j === segments.length - 1 ? (
                    <path key={s.key} d={roundedTop(x, segTop, barW, h, RADIUS)} fill={s.fill} />
                  ) : (
                    <rect key={s.key} x={x} y={segTop} width={barW} height={h} fill={s.fill} />
                  );
                })}
                <text
                  x={colX(i) + colW / 2}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                  className={`chart-axis ${isSelected ? "chart-axis-strong" : ""}`}
                >
                  {month.label}
                </text>
              </g>
            );
          })}

          {/* The nets above the columns (see placeLabels), with a halo (see .chart-total) so gridlines never run
              through them. */}
          <g pointerEvents="none">
            {labels.map((label) => {
              const isSelected = series[label.i].month === selected;
              const tint = isSelected ? " is-selected" : hover === label.i ? " is-hovered" : "";
              return (
                <text
                  key={label.i}
                  x={label.cx}
                  y={label.baseline}
                  textAnchor="middle"
                  className={`chart-total chart-net ${label.up ? "is-up" : "is-down"}${tint}`}
                >
                  {label.text}
                </text>
              );
            })}
          </g>
        </svg>

        {hovered && hover !== null && (
          <div
            className="chart-tooltip"
            style={{ left: `${((PAD.left + band * hover + band / 2) / WIDTH) * 100}%` }}
            role="status"
          >
            <strong>{monthTitle(hovered.month)}</strong>
            {segmentsOf.map((s) => (
              <div key={s.key} className="tooltip-row">
                <span>{s.label}</span>
                <span>{formatKr(hovered.groups[s.key] ?? 0)}</span>
              </div>
            ))}
            <div className="tooltip-row tooltip-total">
              <span>Spent</span>
              <span>{formatKr(totals[hover])}</span>
            </div>
            <div className="tooltip-row">
              <span>Income</span>
              <span>{formatKr(hovered.income)}</span>
            </div>
            <div className="tooltip-row tooltip-total">
              <span>{nets[hover] >= 0 ? "Kept" : "Overspent"}</span>
              <span>{formatKr(Math.abs(nets[hover]))}</span>
            </div>
          </div>
        )}
      </div>

      <table className="sr-only">
        <caption>Spending and income per month</caption>
        <thead>
          <tr>
            <th>Month</th>
            {segmentsOf.map((s) => (
              <th key={s.key}>{s.label}</th>
            ))}
            <th>Income</th>
            <th>Kept (negative: overspent)</th>
          </tr>
        </thead>
        <tbody>
          {series.map((m, i) => (
            <tr key={m.month}>
              <td>{monthTitle(m.month)}</td>
              {segmentsOf.map((s) => (
                <td key={s.key}>{formatKr(m.groups[s.key] ?? 0)}</td>
              ))}
              <td>{formatKr(m.income)}</td>
              <td>{formatKr(nets[i])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function monthTitle(month: string) {
  const [year, number] = month.split("-").map(Number);
  return new Date(year, number - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

/**
 * The months whose income is far above a typical month's (see BREAK_FACTOR): more than that factor times the median
 * month with income, and more than a quarter above everything else on the chart (`floor` is the tallest spending).
 * Needs three months with income to say what's typical.
 */
function incomeOutliers(incomes: number[], floor: number): Set<number> {
  const paid = incomes.filter((v) => v > 0).sort((a, b) => a - b);
  if (paid.length < 3) return new Set();
  const middle = (paid.length - 1) / 2;
  const median = (paid[Math.floor(middle)] + paid[Math.ceil(middle)]) / 2;
  const limit = median * BREAK_FACTOR;
  const rest = Math.max(floor, ...incomes.filter((v) => v <= limit));
  return new Set(incomes.flatMap((v, i) => (v > limit && v > rest * 1.25 ? [i] : [])));
}

/** A bar cut short: rounded top at `top`, down to `bottom`, with a slanted gap around `at` where it's broken. */
function brokenBar(x: number, top: number, w: number, bottom: number, at: number) {
  const r = Math.min(RADIUS, w / 2);
  const upper = [
    `M${x},${at + BREAK_SLANT - BREAK_GAP / 2}`,
    `V${top + r}`,
    `Q${x},${top} ${x + r},${top}`,
    `H${x + w - r}`,
    `Q${x + w},${top} ${x + w},${top + r}`,
    `V${at - BREAK_SLANT - BREAK_GAP / 2}`,
    "Z",
  ];
  const lower = [
    `M${x},${bottom}`,
    `V${at + BREAK_SLANT + BREAK_GAP / 2}`,
    `L${x + w},${at - BREAK_SLANT + BREAK_GAP / 2}`,
    `V${bottom}`,
    "Z",
  ];
  return [...upper, ...lower].join(" ");
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h);
  return [
    `M${x},${y + h}`,
    `V${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `H${x + w - radius}`,
    `Q${x + w},${y} ${x + w},${y + radius}`,
    `V${y + h}`,
    "Z",
  ].join(" ");
}

/** Just the rounded top edge of a column, for drawing as a line. */
function roundedEdge(x: number, y: number, w: number, r: number) {
  const radius = Math.min(r, w / 2);
  return [
    `M${x},${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `H${x + w - radius}`,
    `Q${x + w},${y} ${x + w},${y + radius}`,
  ].join(" ");
}

/**
 * Axis top just above the tallest bar: about five round steps (1, 2, 2.5 or 5 × 10ⁿ), rounded up to the next
 * step, so headroom is at most one step instead of up to doubling the value.
 */
function niceScale(value: number) {
  const rough = value / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((s) => s * magnitude >= rough) ?? 10) * magnitude;
  const max = Math.ceil(value / step) * step;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  return { max, ticks };
}

/** A figure as "38,3k", or "38k" where columns are too narrow for the decimal. */
function barTotal(value: number, band: number) {
  if (value < 1000) return String(Math.round(value));
  const digits = band >= 48 ? 1 : 0;
  return `${(value / 1000).toLocaleString("nb-NO", { maximumFractionDigits: digits })}k`;
}

function compactKr(value: number) {
  if (value === 0) return "0";
  if (value < 1000) return String(Math.round(value));
  return `${(value / 1000).toLocaleString("nb-NO", { maximumFractionDigits: 1 })}k`;
}
