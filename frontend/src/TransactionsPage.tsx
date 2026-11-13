import { useCallback, useEffect, useMemo, useState } from "react";
import { accountName, accountNumber } from "./accounts";
import {
  type CategorizationSummary,
  type Category,
  type CategoryRule,
  type Connection,
  type Transaction,
  api,
} from "./api";
import { CategorySelect } from "./CategorySelect";
import { RulePattern, RulesView } from "./RulesView";
import { formatDate, formatMoney } from "./format";

type View = "review" | "all" | "rules";

/** The category filter's choice for transactions without a category. The colon can't occur in a category id. */
const UNCATEGORIZED = ":uncategorized";

export function TransactionsPage({ onError }: { onError: (e: unknown) => void }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [summary, setSummary] = useState<CategorizationSummary | null>(null);
  const [view, setView] = useState<View>("review");
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  // Rules have their own category filter: "Uncategorized" means nothing for a rule.
  const [ruleCategory, setRuleCategory] = useState("");
  // All transactions narrowed to what one rule categorizes, opened from that rule's count.
  const [ruleFilter, setRuleFilter] = useState<CategoryRule | null>(null);
  // One account's transactions (its uid), in both Needs review and All transactions.
  const [accountFilter, setAccountFilter] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [items, setItems] = useState<Transaction[] | null>(null);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    api.categories().then(setCategories).catch(onError);
    api.connections().then(setConnections).catch(onError);
  }, [onError]);

  const reloadSummary = useCallback(() => {
    api.categorizationSummary().then(setSummary).catch(onError);
  }, [onError]);

  const reload = useCallback(() => {
    reloadSummary();
    if (view === "rules") return; // the rules view loads its own list
    // The full list filtered to uncategorized asks the API for the same set as Needs review, shown as a list.
    const onlyUncategorized = view === "all" && categoryFilter === UNCATEGORIZED;
    api
      .transactions({
        view: onlyUncategorized ? "review" : view,
        q: query.trim(),
        category: view === "all" && !onlyUncategorized ? categoryFilter : undefined,
        rule: view === "all" ? ruleFilter?.pattern : undefined,
        account: accountFilter || undefined,
        limit: view === "review" ? 5000 : 300,
      })
      .then((result) => {
        setItems(result.items);
        setTotal(result.total);
      })
      .catch(onError);
  }, [view, query, categoryFilter, ruleFilter, accountFilter, onError, reloadSummary]);

  /** From a rule's count to exactly the transactions it categorizes. */
  const showTransactionsFor = (rule: CategoryRule) => {
    setCategoryFilter("");
    setAccountFilter("");
    setQuery("");
    setRuleFilter(rule);
    setView("all");
  };
  const switchTo = (next: View) => {
    if (next !== "all") setRuleFilter(null);
    setView(next);
  };

  useEffect(() => {
    const timer = window.setTimeout(reload, query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [reload, query]);

  return (
    <section className="section">
      <p className="label">Categorization</p>
      <h2>{headline(summary)}</h2>
      {summary && summary.count > 0 && (
        <p className="dek small">
          {percent(summary.categorized_share)} of {summary.count} transactions have a category. The ones without make up{" "}
          {percent(summary.uncategorized_spend_share)} of spending.
        </p>
      )}

      <div className="toolbar">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={view === "review"} onClick={() => switchTo("review")}>
            Needs review
          </button>
          <button role="tab" aria-selected={view === "all"} onClick={() => switchTo("all")}>
            All transactions
          </button>
          <button role="tab" aria-selected={view === "rules"} onClick={() => switchTo("rules")}>
            Rules
          </button>
        </div>
        <input
          className="search"
          type="search"
          placeholder={view === "rules" ? "Search rules" : "Search payee or text"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {view === "all" && (
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            <option value={UNCATEGORIZED}>Uncategorized</option>
            <option disabled>──────────</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {view !== "rules" && connections.length > 0 && (
          <select
            className={accountFilter ? "is-filtering" : undefined}
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
            aria-label="Account"
          >
            <option value="">All accounts</option>
            {connections.map((connection) => (
              <optgroup key={connection.session_id} label={connection.aspsp.name}>
                {connection.accounts.map((account) => (
                  <option key={account.uid} value={account.uid}>
                    {[accountName(account), accountNumber(account)].filter(Boolean).join(" ")}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
        {view === "rules" && (
          <select value={ruleCategory} onChange={(e) => setRuleCategory(e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {view === "rules" && (
        <RulesView
          categories={categories}
          query={query}
          categoryFilter={ruleCategory}
          onShowTransactions={showTransactionsFor}
          onChanged={reloadSummary}
          onError={onError}
        />
      )}
      {view === "all" && ruleFilter && (
        <div className="rule-filter small">
          <span>
            Categorized by the rule <RulePattern rule={ruleFilter} />
          </span>
          <button className="text" onClick={() => setRuleFilter(null)}>
            Show all transactions
          </button>
        </div>
      )}
      {view !== "rules" && items === null && <p className="muted">Loading…</p>}
      {items && view === "review" && (
        <ReviewGroups
          items={items}
          categories={categories}
          onSaved={reload}
          onError={onError}
          narrowed={!!accountFilter || !!query.trim()}
        />
      )}
      {items && view === "all" && (
        <TransactionTable
          items={items}
          total={total}
          categories={categories}
          onChanged={(updated) => {
            setItems((current) => current?.map((t) => (t.id === updated.id ? updated : t)) ?? null);
            api.categorizationSummary().then(setSummary).catch(onError);
          }}
          onError={onError}
        />
      )}
    </section>
  );
}

interface Group {
  key: string;
  label: string;
  transactions: Transaction[];
  total: number;
  accounts: string[];
}

/** Uncategorized transactions grouped by payee, biggest money first, so a few choices cover most spending. */
function ReviewGroups(props: {
  items: Transaction[];
  categories: Category[];
  onSaved: () => void;
  onError: (e: unknown) => void;
  /** True when a search or the account filter narrows the list, so "nothing" doesn't mean everywhere. */
  narrowed?: boolean;
}) {
  const groups = useMemo(() => groupByMerchant(props.items), [props.items]);
  if (groups.length === 0) {
    return (
      <p className="empty">
        {props.narrowed
          ? "Nothing to review here. Every matching transaction has a category."
          : "Nothing to review. Every transaction has a category."}
      </p>
    );
  }
  return (
    <div className="ledger">
      <div className="ledger-head review-grid">
        <span>Payee</span>
        <span className="num">Total</span>
        <span>Category</span>
      </div>
      {groups.map((group) => (
        <ReviewGroup key={group.key} group={group} {...props} />
      ))}
    </div>
  );
}

function ReviewGroup(props: {
  group: Group;
  categories: Category[];
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const { group } = props;
  const [category, setCategory] = useState("");
  const [pattern, setPattern] = useState(group.key);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!category || pattern.trim().length < 2) return;
    setSaving(true);
    try {
      await api.addRule(pattern.trim(), category);
      props.onSaved();
    } catch (error) {
      props.onError(error);
      setSaving(false);
    }
  };

  return (
    <div className="ledger-row">
      <div className="review-grid">
        <div>
          <div className="payee">{group.label}</div>
          <div className="meta small">{group.accounts.join(", ")}</div>
          <button
            className="text disclosure small"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-controls={`group-${group.key}`}
          >
            <span className="disclosure-arrow" aria-hidden="true">
              ▸
            </span>
            {open ? "Hide" : "Show"} {group.transactions.length} transaction{group.transactions.length === 1 ? "" : "s"}
          </button>
        </div>
        <div className="num amount-cell">{formatMoney(group.total, group.transactions[0].currency ?? "NOK")}</div>
        <div className="rule-editor">
          <CategorySelect categories={props.categories} value={category} onChange={setCategory} />
          {category && (
            <>
              <label className="inline-label">
                Applies to text containing
                <input value={pattern} onChange={(e) => setPattern(e.target.value)} />
              </label>
              <button onClick={save} disabled={saving || pattern.trim().length < 2}>
                {saving ? "Saving…" : "Save rule"}
              </button>
            </>
          )}
        </div>
      </div>
      {open && (
        <table className="group-transactions small" id={`group-${group.key}`}>
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">Amount</th>
              <th>Text</th>
              {group.accounts.length > 1 && <th>Account</th>}
            </tr>
          </thead>
          <tbody>
            {group.transactions.map((t) => (
              <tr key={t.id}>
                <td className="nowrap">
                  {formatDate(t.date)}
                  {t.status === "PDNG" && <span className="meta"> · pending</span>}
                </td>
                <td className="num amount-cell">{formatMoney(t.amount, t.currency ?? "NOK")}</td>
                <td>{t.description || "No description"}</td>
                {group.accounts.length > 1 && <td className="meta nowrap">{t.account}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TransactionTable(props: {
  items: Transaction[];
  total: number;
  categories: Category[];
  onChanged: (t: Transaction) => void;
  onError: (e: unknown) => void;
}) {
  const change = async (t: Transaction, category: string) => {
    try {
      props.onChanged(await api.setCategory(t.id, category || null));
    } catch (error) {
      props.onError(error);
    }
  };

  if (props.items.length === 0) return <p className="empty">No transactions match.</p>;
  return (
    <div className="ledger">
      <div className="ledger-head table-grid">
        <span>Date</span>
        <span>Description</span>
        <span className="num">Amount</span>
        <span>Category</span>
      </div>
      {props.items.map((t) => (
        // Rows without a category stand out while scrolling; transfers between your own accounts, which aren't
        // spending or income, step back (see .is-uncategorized and .is-transfer).
        <div key={t.id} className={`ledger-row table-grid${rowMark(t)}`}>
          <span className="small nowrap">{formatDate(t.date)}</span>
          <span>
            {t.description || "No description"}
            <span className="meta small block">
              {t.bank} · {t.account}
              {t.status === "PDNG" && " · pending"}
            </span>
          </span>
          <span className="num amount-cell">{formatMoney(t.amount, t.currency ?? "NOK")}</span>
          <span className="category-cell">
            <CategorySelect
              categories={props.categories}
              value={t.category ?? ""}
              onChange={(value) => change(t, value)}
              placeholder="Uncategorized"
              needsCategory={!t.category}
            />
            <span className={`source source-${t.category_source ?? "none"}`}>{sourceLabel(t.category_source)}</span>
          </span>
        </div>
      ))}
      {props.total > props.items.length && (
        <p className="meta small">
          Showing {props.items.length} of {props.total}. Search or filter to narrow down.
        </p>
      )}
    </div>
  );
}

function groupByMerchant(items: Transaction[]): Group[] {
  const groups = new Map<string, Group>();
  for (const t of items) {
    const key = t.merchant || t.description.toUpperCase() || "(NO DESCRIPTION)";
    const group = groups.get(key) ?? { key, label: key, transactions: [], total: 0, accounts: [] };
    group.transactions.push(t);
    group.total += t.amount;
    if (!group.accounts.includes(t.account)) group.accounts.push(t.account);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

function headline(summary: CategorizationSummary | null) {
  if (!summary) return "Loading…";
  if (summary.count === 0) return "No transactions yet";
  if (summary.uncategorized === 0) return "Every transaction has a category";
  return `${summary.uncategorized} transaction${summary.uncategorized === 1 ? "" : "s"} need${summary.uncategorized === 1 ? "s" : ""} a category`;
}

function rowMark(t: Transaction) {
  if (!t.category) return " is-uncategorized";
  if (t.kind === "transfer") return " is-transfer";
  return "";
}

function sourceLabel(source: Transaction["category_source"]) {
  switch (source) {
    case "manual":
      return "set by you";
    case "rule":
      return "your rule";
    case "transfer":
      return "own accounts";
    case "keyword":
    case "bank":
      return "automatic";
    default:
      return "";
  }
}

function percent(share: number) {
  return `${Math.round(share * 100)}%`;
}
