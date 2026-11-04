// Chart colours from theme.css, as CSS variables so they follow light and dark mode. See docs/design.md.

export const chartColors = {
  ink: "var(--ink)",
  muted: "var(--ink-muted)",
  grid: "var(--rule)",
  signal: "var(--signal)",
  compare: "var(--compare)",
  positive: "var(--positive)",
  // Default colour for data that isn't the point of the chart.
  background: "var(--cat-other)",
} as const;

const CATEGORY_COLORS = Array.from({ length: 8 }, (_, i) => `var(--cat-${i + 1})`);
export const OTHER_COLOR = "var(--cat-other)";

/**
 * Stable colour per category: the same category gets the same colour on every chart.
 * `categories` is the app-wide category order (e.g. by total spend over all time), not the order in one chart.
 * Categories beyond the first eight share the "Other" grey and should be grouped as Other in the chart.
 */
export function categoryColor(category: string, categories: readonly string[]): string {
  const index = categories.indexOf(category);
  return index >= 0 && index < CATEGORY_COLORS.length ? CATEGORY_COLORS[index] : OTHER_COLOR;
}
