import { useEffect, useState } from "react";
import { type Category, type CategoryRule, api } from "./api";
import { CategorySelect } from "./CategorySelect";

/** What's happening to a row: a category being saved, just saved, or the rule deleted (kept for Undo). */
type RowState = "saving" | "saved" | "deleted";

/**
 * Your rules, one per row in pattern order: the text it looks for, how many transactions it decides, and its
 * category, which can be changed in place. Deleting leaves an Undo in the row instead of asking first, and rows
 * never move while you work (re-targeting keeps the pattern order).
 */
export function RulesView(props: {
  categories: Category[];
  query: string;
  categoryFilter: string;
  /** Opens All transactions searched for the rule's text. */
  onShowTransactions: (pattern: string) => void;
  /** Rules changed, so the categorization summary should reload. */
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const { categories, query, categoryFilter, onChanged, onError } = props;
  const [rules, setRules] = useState<CategoryRule[] | null>(null);
  const [states, setStates] = useState<Record<string, RowState>>({});

  useEffect(() => {
    api.rules().then(setRules).catch(onError);
  }, [onError]);

  const setState = (pattern: string, state: RowState | null) =>
    setStates((current) => {
      const next = { ...current };
      if (state) next[pattern] = state;
      else delete next[pattern];
      return next;
    });
  const update = (pattern: string, changes: Partial<CategoryRule>) =>
    setRules((current) => current?.map((r) => (r.pattern === pattern ? { ...r, ...changes } : r)) ?? null);

  const retarget = async (rule: CategoryRule, category: string) => {
    if (!category || category === rule.category) return;
    update(rule.pattern, { category });
    setState(rule.pattern, "saving");
    try {
      const saved = await api.retargetRule(rule.pattern, category);
      update(rule.pattern, { matched: saved.matched });
      setState(rule.pattern, "saved");
      window.setTimeout(() => setStates((s) => (s[rule.pattern] === "saved" ? omit(s, rule.pattern) : s)), 2000);
      onChanged();
    } catch (error) {
      update(rule.pattern, { category: rule.category });
      setState(rule.pattern, null);
      onError(error);
    }
  };

  const remove = async (rule: CategoryRule) => {
    try {
      await api.deleteRule(rule.pattern);
      setState(rule.pattern, "deleted");
      onChanged();
    } catch (error) {
      onError(error);
    }
  };

  const undo = async (rule: CategoryRule) => {
    try {
      const restored = await api.addRule(rule.pattern, rule.category);
      update(rule.pattern, { matched: restored.matched });
      setState(rule.pattern, null);
      onChanged();
    } catch (error) {
      onError(error);
    }
  };

  if (rules === null) return <p className="muted">Loading…</p>;
  if (rules.length === 0) {
    return (
      <p className="empty">
        No rules yet. Under Needs review, choose a category for a payee and save it as a rule; it then applies to
        every transaction with that text.
      </p>
    );
  }

  const needle = query.trim().toUpperCase();
  const shown = rules.filter(
    (r) => (!needle || r.pattern.includes(needle)) && (!categoryFilter || r.category === categoryFilter),
  );
  const live = rules.filter((r) => states[r.pattern] !== "deleted");
  const decided = live.reduce((sum, r) => sum + r.matched, 0);
  const unused = live.filter((r) => r.matched === 0).length;

  return (
    <>
      <p className="meta small rules-summary">
        {plural(live.length, "rule")} · {plural(decided, "transaction")} categorized by them
        {unused > 0 && ` · ${unused} match${unused === 1 ? "es" : ""} nothing`}
        <br />A rule applies to transactions whose text contains it. When several match, the longest wins, and
        categories you set by hand always win.
      </p>
      {shown.length === 0 ? (
        <p className="empty">No rules match.</p>
      ) : (
        <div className="ledger">
          <div className="ledger-head rules-grid">
            <span>Text contains</span>
            <span>Categorizes</span>
            <span>Category</span>
            <span />
          </div>
          {shown.map((rule) =>
            states[rule.pattern] === "deleted" ? (
              <div key={rule.pattern} className="ledger-row rules-grid is-deleted">
                <span className="rule-deleted small">
                  Rule <span className="rule-pattern">“{rule.pattern}”</span> deleted.
                </span>
                <button className="text" onClick={() => undo(rule)}>
                  Undo
                </button>
              </div>
            ) : (
              <div key={rule.pattern} className="ledger-row rules-grid">
                <span className="rule-pattern">“{rule.pattern}”</span>
                <span className="small">
                  {rule.matched > 0 ? (
                    <button
                      className="link rule-matches"
                      onClick={() => props.onShowTransactions(rule.pattern)}
                      title="Show every transaction containing this text in All transactions"
                    >
                      {plural(rule.matched, "transaction")}
                    </button>
                  ) : (
                    <span
                      className="muted"
                      title="It decides no transaction now: none contain this text, or a longer rule or your own choice wins"
                    >
                      No matches
                    </span>
                  )}
                </span>
                <span className="category-cell">
                  <CategorySelect
                    categories={categories}
                    value={rule.category}
                    onChange={(category) => retarget(rule, category)}
                  />
                  <span className="source" aria-live="polite">
                    {states[rule.pattern] === "saving" ? "Saving…" : states[rule.pattern] === "saved" ? "Saved" : ""}
                  </span>
                </span>
                <span className="rule-actions">
                  <button className="text" onClick={() => remove(rule)} aria-label={`Delete rule ${rule.pattern}`}>
                    Delete
                  </button>
                </span>
              </div>
            ),
          )}
        </div>
      )}
    </>
  );
}

function omit(states: Record<string, RowState>, key: string) {
  const next = { ...states };
  delete next[key];
  return next;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}
