// Norwegian formatting for dates and amounts (see docs/design.md).

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("nb-NO", { day: "numeric", month: "short", year: "numeric" });
}

export function formatMoney(amount: number | string, currency: string) {
  return new Intl.NumberFormat("nb-NO", { style: "currency", currency }).format(Number(amount));
}

/** Whole kroner, for overviews where øre are noise. */
export function formatKr(amount: number) {
  return new Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK", maximumFractionDigits: 0 }).format(amount);
}
