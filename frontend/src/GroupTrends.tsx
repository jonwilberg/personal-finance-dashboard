import { useState } from "react";
import type { OverviewMonth, SpendingGroup } from "./api";
import { formatKr } from "./format";
import { monthTitle, thousands } from "./SpendingChart";
import { groupFill } from "./spendingGroups";

// Each spending group's last 12 months, one small row per group beside the month's split bar, top to bottom in the
// bar's order. Monthly columns in the group's colour (the selected month solid, the rest a tint), a dashed line at
// the group's median month, and on the right this month against that median.
// Each row has its own scale, so a small group's trend shows as clearly as Fixed's; the row's top value is printed
// at the top of its chart so the scales stay honest.

const NAME_W = 132; // the group's name
const FIGURES_W = 116; // the difference and median on the right
const COL_GAP = 4; // between a row's columns
const MAX_COL = 22; // the widest a column gets
const PAD_TOP = 14; // room above a row's columns for its top value
const PAD_BOTTOM = 8; // between rows

export function GroupTrends({
  series,
  groups,
  groupUsual,
  selected,
  onSelect,
  active,
  onActive,
  width,
  rowHeight,
}: {
  series: OverviewMonth[];
  /** The groups to show, top down. */
  groups: SpendingGroup[];
  groupUsual: Record<string, number> | null;
  selected: string;
  onSelect: (month: string) => void;
  /** The group highlighted here and on the bar, if any. */
  active: string | null;
  onActive: (group: string | null) => void;
  width: number;
  rowHeight: number;
}) {
  const [tip, setTip] = useState<{ group: string; index: number } | null>(null);
  const chartW = Math.max(width - NAME_W - FIGURES_W, 120);
  const slot = chartW / Math.max(series.length, 1);
  const colW = Math.min(Math.max(slot - COL_GAP, 3), MAX_COL);
  const chartH = rowHeight - PAD_TOP - PAD_BOTTOM;

  return (
    <div className="trends" style={{ width }} onMouseLeave={() => onActive(null)}>
      {groups.map((group) => {
        const values = series.map((m) => m.groups[group.id] ?? 0);
        const high = Math.max(...values, 1);
        const y = (v: number) => PAD_TOP + chartH - (Math.max(v, 0) / high) * chartH;
        const usual = groupUsual?.[group.id] ?? null;
        const current = series.findIndex((m) => m.month === selected);
        const now = current >= 0 ? values[current] : 0;
        const delta = usual !== null ? now - usual : null;
        const dimmed = active !== null && active !== group.id;
        const description = series.map((m, i) => `${monthTitle(m.month)}: ${formatKr(values[i])}`).join(", ");
        const tipHere = tip?.group === group.id ? tip.index : null;
        return (
          <div
            key={group.id}
            className={`trend-row${dimmed ? " is-dimmed" : ""}`}
            style={{ height: rowHeight }}
            onMouseEnter={() => onActive(group.id)}
          >
            <span className="split-name trend-name">
              <span className="legend-swatch" style={{ background: groupFill(group.id) }} aria-hidden="true" />
              {group.name}
            </span>
            <div className="trend-chart" style={{ width: chartW, height: rowHeight }}>
              <svg width={chartW} height={rowHeight} role="img">
                <title>{`${group.name} per month. ${description}`}</title>
                <line className="trend-base" x1={0} x2={chartW} y1={PAD_TOP + chartH + 0.5} y2={PAD_TOP + chartH + 0.5} />
                {values.map((v, i) => {
                  const top = y(v);
                  const isSelected = series[i].month === selected;
                  return (
                    <g key={series[i].month}>
                      {v > 0 && (
                        <rect
                          x={i * slot + (slot - colW) / 2}
                          y={top}
                          width={colW}
                          height={Math.max(PAD_TOP + chartH - top, 1)}
                          fill={isSelected ? groupFill(group.id) : `color-mix(in srgb, ${groupFill(group.id)} 38%, var(--paper))`}
                        />
                      )}
                      {/* The whole slot is the hover and click target, taller and wider than the column. */}
                      <rect
                        className="trend-hit"
                        x={i * slot}
                        y={0}
                        width={slot}
                        height={rowHeight}
                        onMouseEnter={() => setTip({ group: group.id, index: i })}
                        onMouseLeave={() => setTip(null)}
                        onClick={() => onSelect(series[i].month)}
                      />
                    </g>
                  );
                })}
                {usual !== null && usual > 0 && (
                  <line className="trend-median" x1={0} x2={chartW} y1={y(usual)} y2={y(usual)} />
                )}
              </svg>
              <span className="trend-top" aria-hidden="true">
                {thousands(high)}
              </span>
              {tipHere !== null && (
                <div
                  className="chart-tooltip trend-tooltip"
                  style={{ left: tipHere * slot + slot / 2, top: y(values[tipHere]) - 6 }}
                  role="status"
                >
                  <strong>{monthTitle(series[tipHere].month)}</strong>
                  <div className="tooltip-row">
                    <span>{group.name}</span>
                    <span>{formatKr(values[tipHere])}</span>
                  </div>
                </div>
              )}
            </div>
            <span className="trend-figures">
              <Difference delta={delta} />
              {usual !== null && <span className="meta small">median {formatKr(usual)}</span>}
            </span>
          </div>
        );
      })}
      {/* The months under the last row, shared by every row above. */}
      <div className="trend-months" aria-hidden="true" style={{ marginLeft: NAME_W, width: chartW }}>
        {series.map((m, i) => (
          <span
            key={m.month}
            className={m.month === selected ? "is-selected" : undefined}
            style={{ left: i * slot, width: slot }}
          >
            {slot >= 26 ? m.label : m.label.slice(0, 1)}
          </span>
        ))}
      </div>
    </div>
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
