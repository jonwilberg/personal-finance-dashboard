import { useEffect, useId, useRef, useState } from "react";
import type { ScoreboardRow } from "./api";
import { formatKr } from "./format";

// The month's spending as one bar, split by category: fixed costs first, then adjustable, each largest first, then
// what isn't categorized (hatched). Colours match the 12-month chart above it.
// - A block wide enough for its label carries it inside.
// - The others get a label just above or below the bar (alternating), starting at the block's centre and spread
//   only as far as needed to stop labels touching. Order is kept on each side, so leader lines never cross.
// - A bracket under the bar names the fixed and adjustable groups with their share.
// - Clicking a block or label jumps to its row in the table below.

const UNCATEGORIZED = "uncategorized";
const BAR_H = 38; // room for a two-line label inside a block
const LABEL_H = 30; // two lines: name, then "amount · share"
const LEADER = 16; // leader length above the bar
const BRACKET_H = 30; // tick line and group caption under the bar
const LEADER_BELOW = BRACKET_H + 10; // leaders below the bar pass the bracket
const GAP = 2; // surface gap between blocks
const LABEL_GAP = 12; // space between neighbouring labels
const LIST_BELOW = 480; // narrower than this (phones): a list instead of placed labels
const FONT = '12px "Inter Variable", system-ui, -apple-system, "Segoe UI", sans-serif';

interface Part {
  row: ScoreboardRow;
  share: number;
  x: number;
  w: number;
  labelW: number;
}

interface Placed {
  part: Part;
  above: boolean;
  lx: number; // label centre
}

let canvas: HTMLCanvasElement | null = null;
/** Text width in the label font, with room for the fixed-width digits the labels use (canvas can't apply them). */
function textWidth(text: string, weight = 400): number {
  canvas ??= document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return text.length * 7.5;
  context.font = `${weight} ${FONT}`;
  return context.measureText(text).width * 1.08;
}

export function shareText(share: number) {
  return share > 0 && share < 0.005 ? "<1 %" : `${Math.round(share * 100)} %`;
}

export function SpendingSplit({ rows }: { rows: ScoreboardRow[] }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<string | null>(null);
  const [, setFontsReady] = useState(false); // re-measure once the web font has loaded
  const hatchId = useId().replace(/:/g, "");
  const clipId = `${hatchId}-clip`;

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
  const ordered = [
    ...spent.filter((r) => r.fixed && r.category !== UNCATEGORIZED).sort((a, b) => b.amount - a.amount),
    ...spent.filter((r) => !r.fixed && r.category !== UNCATEGORIZED).sort((a, b) => b.amount - a.amount),
    ...spent.filter((r) => r.category === UNCATEGORIZED),
  ];
  const total = ordered.reduce((sum, r) => sum + r.amount, 0);
  const figures = (row: ScoreboardRow, share: number) => `${formatKr(row.amount)} · ${shareText(share)}`;

  const usable = width - GAP * (ordered.length - 1);
  let cursor = 0;
  const parts: Part[] = ordered.map((row) => {
    const w = Math.max((row.amount / total) * usable, 1.5);
    const share = row.amount / total;
    const labelW = Math.ceil(Math.max(textWidth(row.name), textWidth(figures(row, share)))) + 12;
    const part = { row, share, x: cursor, w, labelW };
    cursor += w + GAP;
    return part;
  });

  const inside = (p: Part) => p.row.category !== UNCATEGORIZED && p.w >= p.labelW + 8;
  const outside = parts.filter((p) => !inside(p));
  const placed = width < LIST_BELOW ? null : placeLabels(outside, width);
  const list = placed === null;

  const hasAbove = !!placed?.some((p) => p.above);
  const hasBelow = !!placed?.some((p) => !p.above);
  const barTop = hasAbove ? LABEL_H + LEADER : 0;
  const barBottom = barTop + BAR_H;
  const belowTop = barBottom + LEADER_BELOW;
  const height = list ? BAR_H : hasBelow ? belowTop + LABEL_H : barBottom + BRACKET_H;
  const leaders = (placed ?? []).map((p) => ({
    p,
    x1: p.part.x + p.part.w / 2,
    y1: p.above ? barTop : barBottom,
    x2: p.lx,
    y2: p.above ? LABEL_H : belowTop,
  }));

  // The two groups, named under the bar. A caption moves out of a leader line's way where it can.
  const groups = list
    ? []
    : (["fixed", "adjustable"] as const).flatMap((kind) => {
        const members = parts.filter((p) => p.row.category !== UNCATEGORIZED && (kind === "fixed") === p.row.fixed);
        if (!members.length) return [];
        const start = members[0].x;
        const end = members[members.length - 1].x + members[members.length - 1].w;
        const share = members.reduce((sum, p) => sum + p.row.amount, 0) / total;
        const text = `${kind === "fixed" ? "Fixed" : "Adjustable"} · ${shareText(share)}`;
        const textW = textWidth(text, 500);
        const y = barBottom + 24;
        const clear = (x: number) =>
          leaders.every((l) => l.y1 !== barBottom || !segmentHitsBox(l, { left: x - 2, right: x + textW + 2, top: y - 12, bottom: y + 3 }));
        const options = [start, end - textW, (start + end - textW) / 2].map((x) => Math.min(Math.max(x, 0), width - textW));
        return [{ kind, start, end, text, y, x: options.find(clear) ?? options[0] }];
      });

  const fill = (row: ScoreboardRow) =>
    row.category === UNCATEGORIZED ? `url(#${hatchId})` : row.fixed ? "var(--chart-fixed)" : "var(--chart-adjustable)";
  const isHover = (p: Part) => hover === p.row.category;
  const events = (p: Part) => ({
    onMouseEnter: () => setHover(p.row.category),
    onMouseLeave: () => setHover(null),
    onClick: () => showRow(p.row.category),
  });
  const labelText = (part: Part) => (
    <>
      <span className="split-name">{part.row.name}</span>
      <span className="split-figures">
        {formatKr(part.row.amount)} · <span className="split-share">{shareText(part.share)}</span>
      </span>
    </>
  );

  return (
    <div className="split" ref={frameRef}>
      <div className="split-frame" style={{ height }}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Spending this month by category: ${parts.map((p) => `${p.row.name} ${figures(p.row, p.share)}`).join(", ")}`}
        >
          <defs>
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--paper-sunken)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--ink-muted)" strokeWidth="2" />
            </pattern>
            {/* Rounded ends on the bar as a whole, not on every block. */}
            <clipPath id={clipId}>
              <rect x={0} y={barTop} width={width} height={BAR_H} rx={4} />
            </clipPath>
          </defs>

          {groups.map((g) => (
            <g key={g.kind} className="split-bracket">
              <path d={`M${g.start + 1},${barBottom + 4} V${barBottom + 9} H${g.end - 1} V${barBottom + 4}`} />
              <text x={g.x} y={g.y}>
                {g.text}
              </text>
            </g>
          ))}

          {leaders.map(({ p, x1, y1, x2, y2 }) => (
            <line
              key={p.part.row.category}
              className={`split-leader${isHover(p.part) ? " is-hover" : ""}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
            />
          ))}

          <g clipPath={`url(#${clipId})`}>
            {parts.map((part) => (
              <rect
                key={part.row.category}
                className={`split-block${hover && !isHover(part) ? " is-dimmed" : ""}`}
                x={part.x}
                y={barTop}
                width={part.w}
                height={BAR_H}
                fill={fill(part.row)}
                {...events(part)}
              >
                <title>{`${part.row.name}: ${figures(part.row, part.share)}`}</title>
              </rect>
            ))}
          </g>
        </svg>

        {!list &&
          parts.filter(inside).map((part) => (
            <div
              key={part.row.category}
              className={`split-label split-inside ${part.row.fixed ? "on-fixed" : "on-adjustable"}${isHover(part) ? " is-hover" : ""}`}
              style={{ left: part.x, width: part.w, top: barTop, height: BAR_H }}
              title={`${part.row.name}: ${figures(part.row, part.share)}`}
              {...events(part)}
            >
              {labelText(part)}
            </div>
          ))}

        {placed?.map(({ part, above, lx }) => (
          <div
            key={part.row.category}
            className={`split-label split-outside${isHover(part) ? " is-hover" : ""}`}
            style={{ left: lx - part.labelW / 2, width: part.labelW, top: above ? 0 : belowTop, height: LABEL_H }}
            title={`${part.row.name}: ${figures(part.row, part.share)}`}
            {...events(part)}
          >
            {labelText(part)}
          </div>
        ))}
      </div>

      {list && (
        <ul className="split-list small">
          {parts.map((part) => (
            <li key={part.row.category} {...events(part)}>
              <span
                className={`legend-swatch${part.row.category === UNCATEGORIZED ? " legend-hatch" : ""}`}
                style={part.row.category === UNCATEGORIZED ? undefined : { background: fill(part.row) }}
                aria-hidden="true"
              />
              <span className="split-name">{part.row.name}</span>
              <span className="split-figures">
                {formatKr(part.row.amount)} · <span className="split-share">{shareText(part.share)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Labels for blocks too narrow to hold their own, alternating above and below the bar. On each side every label
 * starts at its block's centre and is spread just enough that none touch, keeping their order, so their leader
 * lines never cross. Returns null when a side can't fit its labels at all (then a list is used instead).
 */
function placeLabels(parts: Part[], width: number): Placed[] | null {
  const sides = [parts.filter((_, i) => i % 2 === 0), parts.filter((_, i) => i % 2 === 1)];
  const placed: Placed[] = [];
  for (const [side, members] of sides.entries()) {
    const needed = members.reduce((sum, p) => sum + p.labelW, 0) + LABEL_GAP * Math.max(members.length - 1, 0);
    if (needed > width) return null;
    const centre = members.map((p) => Math.min(Math.max(p.x + p.w / 2, p.labelW / 2), width - p.labelW / 2));
    // Push right where labels touch, then back left from the right edge, so the cluster stays as near as it can.
    for (let i = 1; i < members.length; i++) {
      centre[i] = Math.max(centre[i], centre[i - 1] + (members[i - 1].labelW + members[i].labelW) / 2 + LABEL_GAP);
    }
    for (let i = members.length - 1; i >= 0; i--) {
      const limit =
        i === members.length - 1
          ? width - members[i].labelW / 2
          : centre[i + 1] - (members[i].labelW + members[i + 1].labelW) / 2 - LABEL_GAP;
      centre[i] = Math.min(centre[i], limit);
    }
    members.forEach((part, i) => placed.push({ part, above: side === 0, lx: centre[i] }));
  }
  return placed;
}

type Box = { left: number; right: number; top: number; bottom: number };

function segmentHitsBox(s: { x1: number; y1: number; x2: number; y2: number }, b: Box): boolean {
  const steps = Math.max(8, Math.ceil(Math.hypot(s.x2 - s.x1, s.y2 - s.y1) / 2));
  for (let i = 0; i <= steps; i++) {
    const x = s.x1 + ((s.x2 - s.x1) * i) / steps;
    const y = s.y1 + ((s.y2 - s.y1) * i) / steps;
    if (x > b.left && x < b.right && y > b.top && y < b.bottom) return true;
  }
  return false;
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
