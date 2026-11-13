import { useEffect, useRef, useState } from "react";
import type { OverviewMonth, SpendingGroup } from "./api";
import { formatKr } from "./format";
import { groupFill } from "./spendingGroups";

// Each month is a pair of bars: spending stacked on the left by group (fixed costs at the bottom, Other on top), and
// income on the right.
const INCOME_FILL = "var(--chart-income)";

const HEIGHT = 240;
const PAD = { top: 28, right: 8, bottom: 28, left: 52 }; // top leaves room for the labels and broken bars
const GAP = 2; // surface gap between stacked segments
const RADIUS = 4; // rounded data-end on the top of each bar
const PAIR_GAP = 3; // between a month's spending and income bars

// Income far above a typical month (a bonus, a tax refund) would squash every other bar, so it's left out of the
// scale and its bar is cut short with a break. "Far above": more than BREAK_FACTOR times the median month's income,
// and well above every other bar.
const BREAK_FACTOR = 1.5;
const OVERSHOOT = 6; // a broken bar reaches this far above the top gridline, to show it carries on
const BREAK_AT = 14; // the break's distance below the top gridline
const BREAK_GAP = 4;
const BREAK_SLANT = 3;

type Box = { x0: number; x1: number; y0: number; y1: number };
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

export function SpendingChart(props: {
  series: OverviewMonth[];
  /** The spending groups, in stacking order (bottom first). */
  groups: SpendingGroup[];
  selected: string;
  usual: number | null;
  onSelect: (month: string) => void;
}) {
  const { series, selected, usual } = props;
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
  const outliers = incomeOutliers(incomes, Math.max(usual ?? 0, ...totals));
  const { max, ticks } = niceScale(
    Math.max(usual ?? 0, ...totals, ...incomes.filter((_, i) => !outliers.has(i)), 1),
  );
  // An outlier can still fit under the rounded-up scale; then it's drawn in full after all.
  const cut = incomes.map((income) => income > max);
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / Math.max(series.length, 1);
  const barW = Math.min(26, band * 0.34);
  const pairW = barW * 2 + PAIR_GAP;
  const y = (value: number) => PAD.top + plotH - (value / max) * plotH;
  const pairX = (i: number) => PAD.left + band * i + (band - pairW) / 2; // left edge of a month's spending bar
  const incomeX = (i: number) => pairX(i) + barW + PAIR_GAP;
  const incomeTop = (i: number) => (cut[i] ? PAD.top - OVERSHOOT : y(incomes[i]));

  const labels = placeLabels();
  const hovered = hover !== null ? series[hover] : null;

  /**
   * The figures above the bars: each month's spending and income, compact ("38,3k") so twelve months fit; the
   * selected month's are only set bolder. A label sits above its own bar, nudged sideways off the bar beside it
   * or lifted a line when that's what it takes, and is left out when it would still touch a bar or another label
   * (narrow bars on phones): the tooltip and the table have every figure. The selected month goes first, then
   * spending, then income.
   */
  function placeLabels() {
    const bars: Box[] = series.flatMap((_, i) => [
      { x0: pairX(i), x1: pairX(i) + barW, y0: y(totals[i]), y1: y(0) },
      ...(incomes[i] > 0 ? [{ x0: incomeX(i), x1: incomeX(i) + barW, y0: incomeTop(i), y1: y(0) }] : []),
    ]);
    const placed: Box[] = [];
    const out: { key: string; i: number; text: string; cx: number; baseline: number }[] = [];

    const place = (i: number, kind: "spent" | "income") => {
      const value = kind === "spent" ? totals[i] : incomes[i];
      if (value <= 0) return;
      const isSelected = series[i].month === selected;
      const size = isSelected ? 12 : 11;
      const top = kind === "spent" ? y(totals[i]) : incomeTop(i);
      const centre = kind === "spent" ? pairX(i) + barW / 2 : incomeX(i) + barW / 2;
      const text = barTotal(value, band);
      const half = (text.length * size * 0.58 + 4) / 2; // estimated width (tabular figures), plus the halo
      // Above the bar, or sideways off the other bar of the pair: spending to the left, income to the right.
      const xs = [centre, kind === "spent" ? incomeX(i) - 2 - half : incomeX(i) - 1 + half];
      const baseline = top - (isSelected ? 8 : 6);
      for (const lift of [0, size + 3]) {
        for (const cx of xs) {
          const box = { x0: cx - half, x1: cx + half, y0: baseline - lift - size * 0.75 - 2, y1: baseline - lift + 2 };
          const inside = box.x0 >= PAD.left - 4 && box.x1 <= WIDTH - 2 && box.y0 >= 0;
          if (inside && !bars.some((b) => overlaps(box, b)) && !placed.some((p) => overlaps(box, p))) {
            placed.push(box);
            out.push({ key: `${kind}-${i}`, i, text, cx, baseline: baseline - lift });
            return;
          }
        }
      }
    };

    const chosen = series.findIndex((m) => m.month === selected);
    if (chosen >= 0) {
      place(chosen, "spent");
      place(chosen, "income");
    }
    series.forEach((_, i) => i !== chosen && place(i, "spent"));
    series.forEach((_, i) => i !== chosen && place(i, "income"));
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
          <span className="legend-swatch" style={{ background: INCOME_FILL }} />
          Income
        </span>
        {usual !== null && (
          <span className="legend-item">
            <span className="legend-line" />
            Median spend LTM
          </span>
        )}
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
            const x = pairX(i);
            const isSelected = month.month === selected;
            let base = 0;
            const segments = segmentsOf.map((s) => {
              const value = month.groups[s.key] ?? 0;
              const segment = { ...s, value, from: base, to: base + value };
              base += value;
              return segment;
            }).filter((s) => s.value > 0);
            return (
              <g
                key={month.month}
                className={`chart-bar ${isSelected ? "is-selected" : ""}`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onClick={() => props.onSelect(month.month)}
              >
                {/* The month's column: highlights the selected month (and the hovered one, lightly) and doubles as
                    a hit target wider and taller than the bar. */}
                <rect
                  className={`chart-column ${isSelected ? "is-selected" : hover === i ? "is-hovered" : ""}`}
                  x={PAD.left + band * i + 2}
                  y={4}
                  width={band - 4}
                  height={HEIGHT - 4}
                  rx={4}
                />
                {segments.map((s, j) => {
                  const top = y(s.to);
                  const bottom = y(s.from) - (j > 0 ? GAP : 0);
                  const h = Math.max(bottom - top, 0.5);
                  return j === segments.length - 1 ? (
                    <path key={s.key} d={roundedTop(x, top, barW, h, RADIUS)} fill={s.fill} />
                  ) : (
                    <rect key={s.key} x={x} y={top} width={barW} height={h} fill={s.fill} />
                  );
                })}
                {incomes[i] > 0 &&
                  (cut[i] ? (
                    <path d={brokenBar(incomeX(i), incomeTop(i), barW, y(0), PAD.top + BREAK_AT)} fill={INCOME_FILL} />
                  ) : (
                    <path
                      d={roundedTop(incomeX(i), y(incomes[i]), barW, Math.max(y(0) - y(incomes[i]), 0.5), RADIUS)}
                      fill={INCOME_FILL}
                    />
                  ))}
                <text
                  x={x + pairW / 2}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                  className={`chart-axis ${isSelected ? "chart-axis-strong" : ""}`}
                >
                  {month.label}
                </text>
              </g>
            );
          })}

          {usual !== null && (
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={y(usual)}
              y2={y(usual)}
              stroke="var(--ink)"
              strokeWidth="1.5"
              strokeDasharray="6 4"
              pointerEvents="none"
            />
          )}

          {/* The figures above the bars (see placeLabels). Drawn after the median line, with a halo (see .chart-total),
              so the line never runs through them. */}
          <g pointerEvents="none">
            {labels.map((label) => {
              const isSelected = series[label.i].month === selected;
              const tint = isSelected ? " is-selected" : hover === label.i ? " is-hovered" : "";
              return (
                <text
                  key={label.key}
                  x={label.cx}
                  y={label.baseline}
                  textAnchor="middle"
                  className={`chart-total${tint}`}
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
          </tr>
        </thead>
        <tbody>
          {series.map((m) => (
            <tr key={m.month}>
              <td>{monthTitle(m.month)}</td>
              {segmentsOf.map((s) => (
                <td key={s.key}>{formatKr(m.groups[s.key] ?? 0)}</td>
              ))}
              <td>{formatKr(m.income)}</td>
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
 * month with income, and more than a quarter above everything else on the chart (`floor` is the tallest spending or
 * median line). Needs three months with income to say what's typical.
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

/** A bar's total as "38,3k", or "38k" where bars are too narrow for the decimal. */
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
