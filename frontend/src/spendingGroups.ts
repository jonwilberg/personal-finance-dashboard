// Colours of the spending groups the overview's charts use (ids from the backend's categories.SPENDING_GROUPS).
// Validated together with the income colour: lightness band, chroma, colour-blind separation and contrast on --paper.

export const GROUP_FILL: Record<string, string> = {
  fixed: "var(--group-fixed)",
  groceries: "var(--group-groceries)",
  health: "var(--group-health)",
  dining: "var(--group-dining)",
  travel: "var(--group-travel)",
  other: "var(--group-other)",
};

/** Groups dark enough for light text on top; the rest take ink (each the better of the two, at least 4:1). */
export const LIGHT_TEXT_GROUPS = new Set(["fixed", "dining"]);

export function groupFill(group: string): string {
  return GROUP_FILL[group] ?? GROUP_FILL.other;
}
