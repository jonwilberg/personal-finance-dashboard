// Typed wrappers around the FastAPI backend (backend/src/finance/web.py).

/** The running build: the commit it was made from (null for a local build) and when the app started. */
export interface VersionInfo {
  revision: string | null;
  started_at: string;
}

export interface AppInfo {
  name: string;
  environment: "SANDBOX" | "PRODUCTION";
  active: boolean;
  redirect_urls: string[];
}

export interface Bank {
  name: string;
  country: string;
  logo: string | null;
  max_consent_days: number;
}

export interface Balance {
  name?: string;
  balance_amount: { amount: string; currency: string };
  balance_type?: string;
}

export interface TransactionsSummary {
  count: number;
  first_date: string | null;
  last_date: string | null;
  fetched_at: string | null;
}

export interface Account {
  uid: string;
  name: string | null;
  product: string | null;
  iban: string | null;
  currency: string | null;
  cash_account_type: string | null;
  identifiers?: string[];
  balances: { fetched_at: string; balances: Balance[] } | null;
  transactions: TransactionsSummary | null;
  /** The owning person's id (as text), or "shared". */
  owner: string;
}

export interface Person {
  id: number;
  name: string;
}

/** Someone accounts can belong to: a person, or "shared" (always last). */
export interface Owner {
  id: string;
  name: string;
}

export interface Connection {
  session_id: string;
  aspsp: { name: string; country: string };
  valid_until: string;
  created_at: string;
  expired: boolean;
  /** Added by hand from statements (no bank connection), so it's never refreshed. */
  manual: boolean;
  accounts: Account[];
}

export type CategoryKind = "expense" | "income" | "saving" | "loan" | "transfer";

export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  fixed: boolean;
  system: boolean;
  /** Spending categories: their group on the Overview's charts (see SpendingGroup). Null for other kinds. */
  group: string | null;
  transactions?: number;
  rules?: number;
}

export const KIND_LABELS: Record<CategoryKind, string> = {
  expense: "Spending",
  income: "Income",
  saving: "Saving",
  loan: "Loans",
  transfer: "Transfers",
};

export type CategorySource = "manual" | "transfer" | "rule" | "keyword" | "bank" | null;

export interface Transaction {
  id: string;
  account_uid: string;
  account: string;
  bank: string;
  date: string;
  amount: number;
  currency: string | null;
  direction: "DBIT" | "CRDT";
  status: string | null;
  description: string;
  merchant: string;
  bank_code: string;
  bank_category: string;
  category: string | null;
  category_source: CategorySource;
  /** The kind of its category ("transfer" for money between your own accounts); null when uncategorized. */
  kind: CategoryKind | null;
  /** The pattern of your rule that decided the category, when a rule did. */
  rule: string | null;
}

/** What a rule would catch before it is saved. */
export interface RulePreview {
  matches: number;
  uncategorized: number;
  examples: Transaction[];
}

/** One of your rules: transactions whose text contains `pattern` get `category`. */
export interface CategoryRule {
  pattern: string;
  category: string;
  created_at: string;
  /** True when pattern is a regular expression (matched against the text as shown, ignoring case). */
  regex: boolean;
  /** How many transactions it categorizes now; a longer rule or your own choice can win over it. */
  matched: number;
}

export interface CategorizationSummary {
  count: number;
  categorized_share: number;
  uncategorized: number;
  uncategorized_spend_share: number;
  by_source: Record<string, number>;
  by_category: Record<string, number>;
}

export interface TransactionQuery {
  view?: "all" | "review";
  category?: string;
  account?: string;
  /** Only the transactions this rule (its stored pattern) categorizes. */
  rule?: string;
  q?: string;
  /** YYYY-MM */
  month?: string;
  /** Only these owners' accounts (people's ids or "shared"), as on the overview. */
  owner?: string[];
  limit?: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.detail ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  app: () => request<AppInfo>("/api/app"),
  version: () => request<VersionInfo>("/api/version"),
  banks: (country: string) => request<Bank[]>(`/api/banks?country=${encodeURIComponent(country)}`),
  connections: () => request<Connection[]>("/api/connections"),
  connect: (bank: string, country: string, days: number) =>
    request<{ url: string }>("/api/connections", {
      method: "POST",
      body: JSON.stringify({ bank, country, days }),
    }),
  disconnect: (sessionId: string) =>
    request<{ ok: boolean }>(`/api/connections/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
  owners: () => request<Owner[]>("/api/owners"),
  people: () => request<Person[]>("/api/people"),
  addPerson: (name: string) => request<Person>("/api/people", { method: "POST", body: JSON.stringify({ name }) }),
  renamePerson: (id: number, name: string) =>
    request<Person>(`/api/people/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  removePerson: (id: number) => request<{ ok: boolean }>(`/api/people/${id}`, { method: "DELETE" }),
  /** Leave a payee out of the overview's recurring payments (false), or let the overview decide again (true). */
  setRecurring: (payee: string, recurring: boolean) =>
    request<{ ok: boolean }>("/api/recurring", { method: "PUT", body: JSON.stringify({ payee, recurring }) }),
  setOwner: (uid: string, owner: string) =>
    request<{ owner: string }>(`/api/accounts/${encodeURIComponent(uid)}/owner`, {
      method: "PUT",
      body: JSON.stringify({ owner }),
    }),
  refresh: (uid: string) =>
    request<Pick<Account, "balances" | "transactions">>(
      `/api/accounts/${encodeURIComponent(uid)}/refresh?longest=true`,
      { method: "POST" },
    ),
  categories: () => request<Category[]>("/api/categories"),
  /** `group` is for spending categories (fixed costs go in "fixed"); null for other kinds. */
  addCategory: (name: string, kind: CategoryKind, group: string | null) =>
    request<Category>("/api/categories", { method: "POST", body: JSON.stringify({ name, kind, group }) }),
  spendingGroups: () => request<SpendingGroup[]>("/api/spending-groups"),
  updateCategory: (id: string, changes: Partial<Pick<Category, "name" | "kind" | "fixed" | "group">>) =>
    request<Category>(`/api/categories/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(changes) }),
  deleteCategory: (id: string, moveTo: string | null) =>
    request<{ ok: boolean }>(
      `/api/categories/${encodeURIComponent(id)}${moveTo ? `?move_to=${encodeURIComponent(moveTo)}` : ""}`,
      { method: "DELETE" },
    ),
  transactions: (query: TransactionQuery) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) value.forEach((v) => params.append(key, String(v)));
      else if (value !== undefined && value !== "") params.set(key, String(value));
    }
    return request<{ total: number; items: Transaction[] }>(`/api/transactions?${params}`);
  },
  /** Set (or, with null, remove) your category on many transactions at once; returns them as they are now. */
  setCategories: (changes: { id: string; category: string | null }[]) =>
    request<{ items: Transaction[] }>("/api/transactions/categories", {
      method: "PUT",
      body: JSON.stringify({ changes }),
    }),
  rules: () => request<CategoryRule[]>("/api/rules"),
  addRule: (pattern: string, category: string, regex = false) =>
    request<{ pattern: string; category: string; regex: boolean; matched: number }>("/api/rules", {
      method: "POST",
      body: JSON.stringify({ pattern, category, regex }),
    }),
  previewRule: (pattern: string, regex: boolean) =>
    request<RulePreview>("/api/rules/preview", { method: "POST", body: JSON.stringify({ pattern, regex }) }),
  retargetRule: (pattern: string, category: string) =>
    request<{ pattern: string; category: string; matched: number }>(
      `/api/rules?pattern=${encodeURIComponent(pattern)}`,
      { method: "PATCH", body: JSON.stringify({ category }) },
    ),
  deleteRule: (pattern: string) =>
    request<{ ok: boolean }>(`/api/rules?pattern=${encodeURIComponent(pattern)}`, { method: "DELETE" }),
  categorizationSummary: () => request<CategorizationSummary>("/api/categorization/summary"),
};

export interface OverviewFigures {
  spent: number;
  fixed: number;
  adjustable: number;
  uncategorized: number;
  income: number;
  saved: number;
  loans: number;
  savings_rate: number | null;
  usual_spent: number | null;
}

export interface OverviewMonth {
  month: string;
  label: string;
  fixed: number;
  adjustable: number;
  uncategorized: number;
  income: number;
  /** Spending per group (see SpendingGroup), in stacking order. */
  groups: Record<string, number>;
}

/** A month's income from one income category. */
export interface IncomeRow {
  category: string;
  name: string;
  amount: number;
}

/** A group spending is shown in on the charts: fixed costs, a few large categories, and Other. */
export interface SpendingGroup {
  id: string;
  name: string;
}

export interface OverviewChange {
  category: string;
  name: string;
  fixed: boolean;
  amount: number;
  usual: number;
  delta: number;
}

export interface ScoreboardRow {
  category: string;
  name: string;
  fixed: boolean;
  /** Its spending group's id. */
  group: string;
  amount: number;
  share: number | null;
  usual: number | null;
  delta: number | null;
  history: number[];
  /** Total of `history`: the months in the chart, up to and including this month. */
  ltm: number;
}

export interface Overview {
  month: string | null;
  month_label?: string;
  months: string[];
  is_partial: boolean;
  headline: string;
  figures?: OverviewFigures;
  usual_months?: number;
  series: OverviewMonth[];
  /** The spending groups, in stacking order (bottom first). */
  groups?: SpendingGroup[];
  /** This month's income per income category, largest first. */
  income_breakdown?: IncomeRow[];
  /** Each spending group's median month; null with too little history. */
  group_usual?: Record<string, number> | null;
  changes?: OverviewChange[];
  scoreboard?: ScoreboardRow[];
  /** Payments that come about once a month; missing when there are no transactions. */
  recurring?: RecurringPayments;
}

export interface RecurringItem {
  /** The name transactions are grouped by (as on the transactions page). */
  payee: string;
  category: string | null;
  category_name: string;
  kind: CategoryKind;
  /** Its spending group's id; null for loans and savings. */
  group: string | null;
  /** Paid this month (0 if nothing yet). */
  amount: number;
  /** The median of the earlier months it was paid in; null for a first payment. */
  usual: number | null;
  /** paid: as usual; changed: more than 10 % from usual; due: not yet, the month is still going. */
  status: "paid" | "new" | "changed" | "due" | "missed" | "stopped";
  /** The amount changes most months (power), so a change says little. */
  varies: boolean;
  /** Day of the month it was last paid. */
  day: number;
  /** Paid per month, the window's months in order (see RecurringPayments.months). */
  history: number[];
  /** Each subscription at this payee, largest first: two insurance policies are two. */
  series: { amount: number; payments: number }[];
  /** This month's payments. */
  payments: { id: string; date: string; amount: number; description: string }[];
}

export interface RecurringPayments {
  /** The 12 months up to and including the selected one (YYYY-MM), oldest first. */
  months: string[];
  /** Largest this month first. */
  items: RecurringItem[];
  total: number;
  /** Payees marked as not recurring, with what they came to this month. */
  hidden: { payee: string; amount: number }[];
}

export const overviewApi = {
  /** `owners` limits the overview to those owners' accounts; leave it out for everyone's. */
  get: (month?: string, owners?: string[]) => {
    const params = new URLSearchParams();
    if (month) params.set("month", month);
    for (const owner of owners ?? []) params.append("owner", owner);
    const query = params.toString();
    return request<Overview>(`/api/overview${query ? `?${query}` : ""}`);
  },
};
