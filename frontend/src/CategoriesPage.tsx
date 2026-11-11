import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type Category, type CategoryKind, KIND_LABELS, api } from "./api";

// Kinds a category can be given. Transfers are reserved for the app's own transfer detection.
const EDITABLE_KINDS: CategoryKind[] = ["expense", "income", "saving", "loan"];
const KIND_HINTS: Record<CategoryKind, string> = {
  expense: "Counted as spending.",
  income: "Counted as money in.",
  saving: "Money put into savings or investments. Not spending; tracked on its own.",
  loan: "Loan payments. Not counted as consumption; tracked on its own.",
  transfer: "Money moving between your own accounts. Left out of all statistics.",
};
// Fixed versus adjustable only matters for money going out on costs.
const HAS_FIXED = new Set<CategoryKind>(["expense", "loan"]);

export function CategoriesPage({ onError }: { onError: (e: unknown) => void }) {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const reload = useCallback(() => {
    api.categories().then(setCategories).catch(onError);
  }, [onError]);
  useEffect(reload, [reload]);

  return (
    <>
      <AddCategory onAdded={reload} onError={onError} />
      {(Object.keys(KIND_LABELS) as CategoryKind[]).map((kind) => {
        const ofKind = categories?.filter((c) => c.kind === kind) ?? [];
        if (categories && ofKind.length === 0) return null;
        return (
          <section className="section" key={kind}>
            <p className="label">{KIND_LABELS[kind]}</p>
            <h2>{categories ? `${ofKind.length} ${ofKind.length === 1 ? "category" : "categories"}` : "Loading…"}</h2>
            <p className="dek small">{KIND_HINTS[kind]}</p>
            <div className="category-list">
              {ofKind.map((category) => (
                <CategoryRow
                  key={category.id}
                  category={category}
                  others={(categories ?? []).filter((c) => c.id !== category.id)}
                  onChanged={reload}
                  onError={onError}
                />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

function AddCategory(props: { onAdded: () => void; onError: (e: unknown) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [fixed, setFixed] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.addCategory(name, kind, HAS_FIXED.has(kind) && fixed);
      setName("");
      setFixed(false);
      props.onAdded();
    } catch (error) {
      props.onError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="section">
      <p className="label">Add a category</p>
      <h2>New category</h2>
      <form className="connect-form" onSubmit={submit}>
        <label className="grow">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Memberships" maxLength={60} />
        </label>
        <label>
          Type
          <select value={kind} onChange={(e) => setKind(e.target.value as CategoryKind)}>
            {EDITABLE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        {HAS_FIXED.has(kind) && <FixedToggle fixed={fixed} onChange={setFixed} label="Cost type" />}
        <button type="submit" disabled={saving || !name.trim()}>
          {saving ? "Adding…" : "Add category"}
        </button>
      </form>
    </section>
  );
}

function CategoryRow(props: {
  category: Category;
  others: Category[];
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const { category } = props;
  const [name, setName] = useState(category.name);
  const [deleting, setDeleting] = useState(false);
  const [moveTo, setMoveTo] = useState("");
  useEffect(() => setName(category.name), [category.name]);

  const update = async (changes: Partial<Pick<Category, "name" | "kind" | "fixed">>) => {
    try {
      await api.updateCategory(category.id, changes);
      props.onChanged();
    } catch (error) {
      props.onError(error);
      setName(category.name);
    }
  };

  const saveName = () => {
    if (name.trim() && name.trim() !== category.name) update({ name });
    else setName(category.name);
  };

  const remove = async () => {
    try {
      await api.deleteCategory(category.id, moveTo || null);
      props.onChanged();
    } catch (error) {
      props.onError(error);
    }
  };

  // Rules live in Transactions > Rules; the delete panel still says how many would move.
  const usage = `${category.transactions ?? 0} transaction${category.transactions === 1 ? "" : "s"}`;

  return (
    <div className="category-row">
      <div className="category-grid">
        <input
          className="category-name"
          aria-label="Category name"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setName(category.name);
          }}
        />
        {category.system ? (
          <span className="meta small">Used by the app</span>
        ) : (
          <select
            aria-label="Type"
            value={category.kind}
            onChange={(e) => update({ kind: e.target.value as CategoryKind })}
          >
            {EDITABLE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        )}
        <div>
          {HAS_FIXED.has(category.kind) && (
            <FixedToggle fixed={category.fixed} onChange={(fixed) => update({ fixed })} />
          )}
        </div>
        <span className="meta small nowrap">{usage}</span>
        <div className="category-actions">
          {!category.system && (
            <button className="text" onClick={() => setDeleting(!deleting)} aria-expanded={deleting}>
              Delete
            </button>
          )}
        </div>
      </div>
      {deleting && (
        <div className="delete-panel small">
          <p>
            Delete <strong>{category.name}</strong>? Your {category.rules ?? 0} rule
            {category.rules === 1 ? "" : "s"} and any categories you set by hand can move to another category.
            Transactions placed here automatically go back to review.
          </p>
          <div className="delete-actions">
            <label className="inline-label">
              Move my rules and choices to
              <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                <option value="">Nowhere (back to review)</option>
                {props.others.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="danger" onClick={remove}>
              Delete category
            </button>
            <button className="secondary" onClick={() => setDeleting(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FixedToggle(props: { fixed: boolean; onChange: (fixed: boolean) => void; label?: string }) {
  const toggle = (
    <div className="segmented segmented-small" role="radiogroup" aria-label="Fixed or adjustable cost">
      <button type="button" role="radio" aria-checked={props.fixed} aria-selected={props.fixed} onClick={() => props.onChange(true)}>
        Fixed
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={!props.fixed}
        aria-selected={!props.fixed}
        onClick={() => props.onChange(false)}
      >
        Adjustable
      </button>
    </div>
  );
  if (!props.label) return toggle;
  return (
    <div className="field">
      <span className="field-label">{props.label}</span>
      {toggle}
    </div>
  );
}
