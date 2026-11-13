import { useEffect, useId, useRef, useState } from "react";
import type { OverviewMonth } from "./api";
import { formatKr } from "./format";

// Each month is a pair of bars: spending stacked on the left (fixed at the bottom, adjustable, then uncategorized,
// hatched so it never relies on colour), and income on the right.
const SEGMENTS = [
  { key: "fixed", label: "Fixed", fill: "var(--chart-fixed)" },
  { key: "adjustable", label: "Adjustable", fill: "var(--chart-adjustable)" },
  { key: "uncategorized", label: "Not categorized", fill: "hatch" },
] as const;
const INCOME_FILL = "var(--chart-income)";

const HEIGHT = 240;
const PAD = { top: 28, right: 8, bottom: 28, left: 52 }; // top leaves room for the selected month's total
const GAP = 2; // surface gap between stacked segments
const RADIUS = 4; // rounded data-end on the top of each bar
const PAIR_GAP = 3; // between a month's spending and income bars

export function SpendingChart(props: {
  series: OverviewMonth[];
  selected: string;
  usual: number | null;
  onSelect: (month: string) => void;
}) {
  const { series, selected, usual } = props;
  const [hover, setHover] = useState<number | null>(null);
  const hatchId = useId().replace(/:/g, "");
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
  const { max, ticks } = niceScale(Math.max(usual ?? 0, ...totals, ...series.map((m) => m.income), 1));
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / Math.max(series.length, 1);
  const barW = Math.min(26, band * 0.34);
  const pairW = barW * 2 + PAIR_GAP;
  const y = (value: number) => PAD.top + plotH - (value / max) * plotH;
  const pairX = (i: number) => PAD.left + band * i + (band - pairW) / 2; // left edge of a month's spending bar

  /**
   * Where a month's spending total goes: above its spending bar. When the income bar beside it is taller, the label is
   * nudged left so it doesn't run into it. Returns null when there's no room for that either (narrow bars on phones):
   * lifted above the income bar, the figure would read as income.
   */
  const totalSpot = (i: number, text: string, size: number) => {
    const half = (text.length * size * 0.58 + 4) / 2; // estimated width (tabular figures), plus the halo
    const offset = size > 11 ? 8 : 6;
    const incomeX = pairX(i) + barW + PAIR_GAP;
    let cx = pairX(i) + barW / 2;
    const baseline = y(totals[i]) - offset;
    const income = series[i].income;
    if (income > 0 && y(income) < baseline + 2 && cx + half > incomeX - 2) {
      cx = incomeX - 2 - half;
      const limit = i === 0 ? PAD.left : pairX(i - 1) + pairW + 2; // the previous month's income bar
      if (cx - half < limit) return null;
    }
    return { cx, baseline };
  };

  const hovered = hover !== null ? series[hover] : null;

  return (
    <div className="chart">
      <div className="chart-legend" aria-hidden="true">
        {SEGMENTS.map((s) => (
          <span key={s.key} className="legend-item">
            <span
              className={`legend-swatch ${s.fill === "hatch" ? "legend-hatch" : ""}`}
              style={s.fill === "hatch" ? undefined : { background: s.fill }}
            />
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
            Median spending
          </span>
        )}
      </div>

      <div className="chart-frame" ref={frameRef}>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Spending and income per month">
          <defs>
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--paper-sunken)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--ink-muted)" strokeWidth="2" />
            </pattern>
          </defs>

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
            const segments = SEGMENTS.map((s) => {
              const value = month[s.key];
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
                  const fill = s.fill === "hatch" ? `url(#${hatchId})` : s.fill;
                  return j === segments.length - 1 ? (
                    <path key={s.key} d={roundedTop(x, top, barW, h, RADIUS)} fill={fill} />
                  ) : (
                    <rect key={s.key} x={x} y={top} width={barW} height={h} fill={fill} />
                  );
                })}
                {month.income > 0 && (
                  <path
                    d={roundedTop(x + barW + PAIR_GAP, y(month.income), barW, Math.max(y(0) - y(month.income), 0.5), RADIUS)}
                    fill={INCOME_FILL}
                  />
                )}
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

          {/* Each month's spending total above its bar: in full for the selected month (where there's room), compact
              for the rest so twelve labels fit. Income is in the tooltip. Drawn after the median line, with a halo
              (see .chart-total), so the line never runs through them. */}
          <g pointerEvents="none">
            {series.map((month, i) => {
              if (totals[i] <= 0) return null;
              const isSelected = month.month === selected;
              const tint = isSelected ? " is-selected" : hover === i ? " is-hovered" : "";
              const size = isSelected ? 12 : 11;
              const full = formatKr(totals[i]);
              const short = barTotal(totals[i], band);
              const fullSpot = isSelected ? totalSpot(i, full, size) : null;
              const spot = fullSpot ?? totalSpot(i, short, size);
              if (!spot) return null; // every figure is in the tooltip and the table
              return (
                <text
                  key={month.month}
                  x={spot.cx}
                  y={spot.baseline}
                  textAnchor="middle"
                  className={`chart-total${tint}`}
                >
                  {fullSpot ? full : short}
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
            {SEGMENTS.map((s) => (
              <div key={s.key} className="tooltip-row">
                <span>{s.label}</span>
                <span>{formatKr(hovered[s.key])}</span>
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
            {SEGMENTS.map((s) => (
              <th key={s.key}>{s.label}</th>
            ))}
            <th>Income</th>
          </tr>
        </thead>
        <tbody>
          {series.map((m) => (
            <tr key={m.month}>
              <td>{monthTitle(m.month)}</td>
              {SEGMENTS.map((s) => (
                <td key={s.key}>{formatKr(m[s.key])}</td>
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
