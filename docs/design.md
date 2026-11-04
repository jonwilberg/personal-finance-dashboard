# Visual design: Editorial paper

The dashboard reads like a data feature in a good newspaper. Warm paper, ink-coloured type, serif headlines, and
charts that are mostly ink and grey, so the one thing worth noticing can be shown in colour. Every chart answers a
question, and its headline states the answer.

The tokens live in [`frontend/src/theme.css`](../frontend/src/theme.css) and the chart palette in
[`frontend/src/chartPalette.ts`](../frontend/src/chartPalette.ts). Components use tokens only, never raw colours.

## Principles

1. **Headline the insight.** A chart's title is a sentence that states the takeaway ("Groceries fell for the third
   month in a row"), with a small label line above naming the measure ("Spending on groceries, NOK per month").
2. **Grey by default, colour on purpose.** Data is ink or grey. Colour goes to what the headline is about: the
   category, month or change in question.
3. **Two signal colours.** *Signal red* for spending that is up or over, and *compare blue* for the previous period or
   reference. *Positive green* only for good news (spending down, savings up), used sparingly.
4. **Label directly.** Put labels at line ends and on bars instead of in legends. Gridlines are faint dotted rules;
   axes have no boxes or frames.
5. **Rules, not boxes.** Sections start with a 2px ink rule across the top instead of sitting in cards. Cards are
   reserved for interactive panels (forms, account rows) and use hairline borders with square-ish corners (2px).
6. **Numbers are type.** Hero figures are set in the serif. Numbers in tables and axes use Inter with tabular figures,
   so columns line up.

## Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#FBF7EF` | `#1B1916` | Page background |
| `--paper-raised` | `#FFFDF8` | `#24211D` | Cards, inputs |
| `--paper-sunken` | `#F3ECDF` | `#151310` | Wells, inspect panels, bar tracks |
| `--ink` | `#22201C` | `#F1EADC` | Text, primary data, section rules |
| `--ink-secondary` | `#5E574B` | `#C2B8A6` | Supporting text |
| `--ink-muted` | `#8C8475` | `#8F8676` | Captions, axis labels |
| `--rule` | `#E3D9C6` | `#3A352E` | Hairlines, gridlines |
| `--signal` | `#C8452F` | `#E7705A` | Up / over / attention |
| `--compare` | `#2E5E8C` | `#7FA8D4` | Previous period, reference, links |
| `--positive` | `#3F7A4F` | `#7DB38A` | Down / under / good news |
| `--highlight` | `#F6E3C8` | `#3B2F1E` | Marked text, selected row |

Dark mode ("night edition") follows the system setting. It keeps the warm hue: charcoal paper and cream ink, never
pure black or white.

### Categories

Category charts are where this scheme needs care. The default view shows **every category in grey** and colours
only the one or two the headline is about. When all categories need colours (stacked bars, breakdowns), use the eight
muted inks from `chartPalette.ts` in this order, and group the remainder into **Other** (grey). Colour follows the
category, never its rank, so groceries stays the same colour on every chart.

`ink · red · blue · ochre · olive · plum · slate · rust`, then `Other`.

## Typography

| Role | Font | Size / line height | Notes |
|---|---|---|---|
| Display | Fraunces | 32 / 1.15 | Page title, hero figures |
| Headline | Fraunces | 22 / 1.25 | Chart and section headlines |
| Subhead | Fraunces | 17 / 1.3 | Card titles |
| Body | Inter | 15 / 1.55 | Default UI text |
| Label | Inter, 500, uppercase tracking 0.06em | 11 / 1.4 | Measure labels above headlines |
| Small | Inter | 13 / 1.45 | Table cells, secondary info |
| Caption | Inter | 12 / 1.4 | Axis labels, sources, footnotes |

Fonts are self-hosted (`@fontsource-variable`), so the app makes no requests to Google. Use weights 400 and 500 only.
Numbers in tables use `font-variant-numeric: tabular-nums`.

## Layout and components

- Content width up to 1200px on a 12-column grid with 24px gutters and a 16px side margin on phones.
- A section = 2px ink top rule, then label line, headline, chart, then an optional source or footnote line in caption
  style.
- Spacing scale: 4, 8, 12, 16, 24, 32, 48.
- Corners: 2px for cards, inputs and buttons. Bars have square tops.
- Buttons: primary = ink fill with paper text; secondary = transparent with ink hairline; text buttons in compare blue.
- Amounts: NOK formatted for `nb-NO` (`kr 1 234,50`). Show spending as positive numbers in spending views, and show
  the sign only where both directions appear.
