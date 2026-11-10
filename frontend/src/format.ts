// Norwegian formatting for dates and amounts (see docs/design.md).

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("nb-NO", { day: "numeric", month: "short", year: "numeric" });
}

/** "today 14:32", "yesterday 09:05" or "3. nov. 2026 14:32", for when data was last fetched. */
export function formatUpdated(iso: string, now = new Date()) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(date)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return `${formatDate(iso)} ${time}`;
}

export function formatMoney(amount: number | string, currency: string) {
  return new Intl.NumberFormat("nb-NO", { style: "currency", currency }).format(Number(amount));
}

/** Whole kroner, for overviews where øre are noise. */
export function formatKr(amount: number) {
  return new Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK", maximumFractionDigits: 0 }).format(amount);
}
