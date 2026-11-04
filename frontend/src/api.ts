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
  balances: { fetched_at: string; balances: Balance[] } | null;
  transactions: TransactionsSummary | null;
}

export interface Connection {
  session_id: string;
  aspsp: { name: string; country: string };
  valid_until: string;
  created_at: string;
  expired: boolean;
  accounts: Account[];
}

export interface InspectReport {
  count: number;
  first_date: string | null;
  last_date: string | null;
  statuses: Record<string, number>;
  directions: Record<string, number>;
  currencies: Record<string, number>;
  coverage: { field: string; share: number }[];
}

export interface Category {
  id: string;
  name: string;
  kind: "expense" | "income" | "transfer";
}

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
  refresh: (uid: string) =>
    request<Pick<Account, "balances" | "transactions">>(
      `/api/accounts/${encodeURIComponent(uid)}/refresh?longest=true`,
      { method: "POST" },
    ),
  inspect: (uid: string) => request<InspectReport>(`/api/accounts/${encodeURIComponent(uid)}/inspect`),
  categories: () => request<Category[]>("/api/categories"),
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
