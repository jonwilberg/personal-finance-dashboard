// How accounts are named in the app, from what the bank sends.
import type { Account } from "./api";

export const ACCOUNT_TYPES: Record<string, string> = {
  CACC: "Current account",
  SVGS: "Savings",
  CARD: "Credit card",
  LOAN: "Loan",
};

/** Bank product names arrive as "BRUKSKONTO PLUSS" or "SavingsAccountPlus"; make them readable. */
export function accountName(account: Account) {
  const raw = account.product || account.name || ACCOUNT_TYPES[account.cash_account_type ?? ""] || "Account";
  const spaced = raw.replace(/([a-z])([A-Z])/g, "$1 $2");
  if (spaced !== spaced.toUpperCase()) return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return spaced.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, space, letter) => space + letter.toUpperCase());
}

export function accountNumber(account: Account) {
  const number = account.iban ?? account.identifiers?.[0];
  return number ? `••${number.replace(/\D/g, "").slice(-4)}` : null;
}
