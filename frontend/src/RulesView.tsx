import { type FormEvent, useEffect, useState } from "react";
import { type Category, type CategoryRule, type RulePreview, api } from "./api";
import { CategorySelect } from "./CategorySelect";
import { formatDate, formatMoney } from "./format";

/** What's happening to a row: a category being saved, just saved, or the rule deleted (kept for Undo). */
type RowState = "saving" | "saved" | "deleted";

/**
 * Your rules, one per row in pattern order: what it looks for, how many transactions it decides, and its category,
 * which can be changed in place. Deleting leaves an Undo in the row instead of asking first, and rows never move
 * while you work (re-targeting keeps the pattern order). New rules, including regex rules, are added at the top
 * with a preview of what they'd catch.
 */
export function RulesView(props: {
  categories: Category[];
  query: string;
  categoryFilter: string;
  /** Opens All transactions showing just the transactions this rule categorizes. */
  onShowTransactions: (rule: CategoryRule) => void;
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
    setStates((current) => (state ? { ...current, [pattern]: state } : omit(current, pattern)));
  const update = (pattern: string, changes: Partial<CategoryRule>) =>
    setRules((current) => current?.map((r) => (r.pattern === pattern ? { ...r, ...changes } : r)) ?? null);

  const added = async () => {
    setRules(await api.rules());
    onChanged();
  };

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
      const restored = await api.addRule(rule.pattern, rule.category, rule.regex);
      update(rule.pattern, { matched: restored.matched });
      setState(rule.pattern, null);
      onChanged();
    } catch (error) {
      onError(error);
    }
  };

  if (rules === null) return <p className="muted">Loading…</p>;

  const needle = query.trim().toUpperCase();
  const shown = rules.filter(
    (r) => (!needle || r.pattern.toUpperCase().includes(needle)) && (!categoryFilter || r.category === categoryFilter),
  );
  const live = rules.filter((r) => states[r.pattern] !== "deleted");
  const decided = live.reduce((sum, r) => sum + r.matched, 0);
  const unused = live.filter((r) => r.matched === 0).length;

  return (
    <>
      <AddRule categories={categories} onAdded={added} onError={onError} />

      <p className="meta small rules-summary">
        {plural(live.length, "rule")} · {plural(decided, "transaction")} categorized by them
        {unused > 0 && ` · ${unused} match${unused === 1 ? "es" : ""} nothing`}
        <br />
        Text rules apply to transactions whose text contains them, and the longest wins. Regex rules come after them, in
        the order you saved them. Categories you set by hand always win.
      </p>
      {rules.length === 0 ? (
        <p className="empty">
          No rules yet. Add one above, or under Needs review choose a category for a payee and save it as a rule.
        </p>
      ) : shown.length === 0 ? (
        <p className="empty">No rules match.</p>
      ) : (
        <div className="ledger">
          <div className="ledger-head rules-grid">
            <span>Matches</span>
            <span>Categorizes</span>
            <span>Category</span>
            <span />
          </div>
          {shown.map((rule) =>
            states[rule.pattern] === "deleted" ? (
              <div key={rule.pattern} className="ledger-row rules-grid is-deleted">
                <span className="rule-deleted small">
                  Rule <RulePattern rule={rule} /> deleted.
                </span>
                <button className="text" onClick={() => undo(rule)}>
                  Undo
                </button>
              </div>
            ) : (
              <div key={rule.pattern} className="ledger-row rules-grid">
                <RulePattern rule={rule} />
                <span className="small">
                  {rule.matched > 0 ? (
                    <button
                      className="link rule-matches"
                      onClick={() => props.onShowTransactions(rule)}
                      title="Show the transactions this rule categorizes, in All transactions"
                    >
                      {plural(rule.matched, "transaction")}
                    </button>
                  ) : (
                    <span
                      className="muted"
                      title="It decides no transaction now: nothing matches, or another rule or your own choice wins"
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

/** A text rule in quotes; a regex between slashes in a code face, with a tag, so the two never look alike. */
export function RulePattern({ rule }: { rule: Pick<CategoryRule, "pattern" | "regex"> }) {
  return rule.regex ? (
    <span className="rule-pattern">
      <code className="rule-regex">/{rule.pattern}/</code> <span className="account-type">Regex</span>
    </span>
  ) : (
    <span className="rule-pattern">“{rule.pattern}”</span>
  );
}

/**
 * New rule: what to look for (text, or a regex), the category, and, before saving, a preview of what it would
 * catch, since a regex is easy to get subtly wrong.
 */
function AddRule(props: { categories: Category[]; onAdded: () => Promise<void>; onError: (e: unknown) => void }) {
  const [regex, setRegex] = useState(false);
  const [pattern, setPattern] = useState("");
  const [category, setCategory] = useState("");
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ready = pattern.trim().length >= 2;

  // Preview as you type, a moment after you stop.
  useEffect(() => {
    setPreview(null);
    setProblem(null);
    if (!ready) return;
    let current = true;
    const timer = window.setTimeout(() => {
      api
        .previewRule(pattern, regex)
        .then((result) => current && setPreview(result))
        .catch((error) => current && setProblem(error instanceof Error ? error.message : String(error)));
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [pattern, regex, ready]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !category || problem) return;
    setSaving(true);
    try {
      await api.addRule(pattern, category, regex);
      setPattern("");
      setCategory("");
      await props.onAdded();
    } catch (error) {
      props.onError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="add-rule" onSubmit={save}>
      <div className="add-rule-fields">
        <div className="segmented segmented-small" role="radiogroup" aria-label="Kind of rule">
          <button type="button" role="radio" aria-checked={!regex} onClick={() => setRegex(false)}>
            Text contains
          </button>
          <button type="button" role="radio" aria-checked={regex} onClick={() => setRegex(true)}>
            Regex
          </button>
        </div>
        <input
          className={`grow${regex ? " rule-regex" : ""}`}
          aria-label={regex ? "Regular expression" : "Text the transaction contains"}
          placeholder={regex ? "e.g. ^BF\\d{13} [A-Z0-9]{12}$" : "e.g. REMA 1000"}
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          spellCheck={false}
        />
        <CategorySelect categories={props.categories} value={category} onChange={setCategory} />
        <button type="submit" disabled={saving || !ready || !category || !!problem}>
          {saving ? "Adding…" : "Add rule"}
        </button>
      </div>
      <div className="add-rule-preview small" aria-live="polite">
        {!ready ? (
          <span className="muted">
            {regex
              ? "A regex is matched against the text as shown in the list, ignoring upper and lower case."
              : "Matches transactions whose text contains this, ignoring upper and lower case."}
          </span>
        ) : problem ? (
          <span className="rule-problem">{problem}</span>
        ) : !preview ? (
          <span className="muted">Checking…</span>
        ) : preview.matches === 0 ? (
          <span className="muted">Matches no transactions yet.</span>
        ) : (
          <>
            <span>
              Matches {plural(preview.matches, "transaction")}
              {preview.uncategorized > 0 && `, ${preview.uncategorized} of them uncategorized`}.
            </span>
            <ul className="add-rule-examples">
              {preview.examples.map((t) => (
                <li key={t.id}>
                  <span className="muted nowrap">{formatDate(t.date)}</span>
                  <span className="add-rule-example-text">{t.description || "No description"}</span>
                  <span className="num nowrap">{formatMoney(t.amount, t.currency ?? "NOK")}</span>
                </li>
              ))}
              {preview.matches > preview.examples.length && (
                <li className="muted">and {preview.matches - preview.examples.length} more</li>
              )}
            </ul>
          </>
        )}
      </div>
    </form>
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
