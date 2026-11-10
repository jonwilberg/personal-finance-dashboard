// Typed wrappers around the FastAPI backend (backend/src/finance/web.py).

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
  accounts: Account[];
}

export type CategoryKind = "expense" | "income" | "saving" | "loan" | "transfer";

export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  fixed: boolean;
  system: boolean;
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
  q?: string;
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
  addCategory: (name: string, kind: CategoryKind, fixed: boolean) =>
    request<Category>("/api/categories", { method: "POST", body: JSON.stringify({ name, kind, fixed }) }),
  updateCategory: (id: string, changes: Partial<Pick<Category, "name" | "kind" | "fixed">>) =>
    request<Category>(`/api/categories/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(changes) }),
  deleteCategory: (id: string, moveTo: string | null) =>
    request<{ ok: boolean }>(
      `/api/categories/${encodeURIComponent(id)}${moveTo ? `?move_to=${encodeURIComponent(moveTo)}` : ""}`,
      { method: "DELETE" },
    ),
  transactions: (query: TransactionQuery) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    return request<{ total: number; items: Transaction[] }>(`/api/transactions?${params}`);
  },
  setCategory: (id: string, category: string | null) =>
    request<Transaction>(`/api/transactions/${encodeURIComponent(id)}/category`, {
      method: "PUT",
      body: JSON.stringify({ category }),
    }),
  addRule: (pattern: string, category: string) =>
    request<{ pattern: string; category: string; matched: number }>("/api/rules", {
      method: "POST",
      body: JSON.stringify({ pattern, category }),
    }),
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
  amount: number;
  share: number | null;
  usual: number | null;
  delta: number | null;
  history: number[];
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
  changes?: OverviewChange[];
  scoreboard?: ScoreboardRow[];
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
