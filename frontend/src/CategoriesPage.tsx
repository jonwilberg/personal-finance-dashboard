import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type Category, type CategoryKind, KIND_LABELS, type SpendingGroup, api } from "./api";
import { groupFill } from "./spendingGroups";

// Kinds a category can be given. Transfers are reserved for the app's own transfer detection.
const EDITABLE_KINDS: CategoryKind[] = ["expense", "income", "saving", "loan"];
const KIND_HINTS: Record<CategoryKind, string> = {
  expense:
    "Counted as spending. Each category belongs to a group, which is its colour on the Overview's charts; Fixed is " +
    "for costs that stay the same from month to month.",
  income: "Counted as money in.",
  saving: "Money put into savings or investments. Not spending; tracked on its own.",
  loan: "Loan payments. Not counted as consumption; tracked on its own.",
  transfer: "Money moving between your own accounts. Left out of all statistics.",
};
const NEW_SPENDING_GROUP = "other";

export function CategoriesPage({ onError }: { onError: (e: unknown) => void }) {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [groups, setGroups] = useState<SpendingGroup[]>([]);
  const reload = useCallback(() => {
    api.categories().then(setCategories).catch(onError);
  }, [onError]);
  useEffect(reload, [reload]);
  useEffect(() => {
    api.spendingGroups().then(setGroups).catch(onError);
  }, [onError]);

  const row = (category: Category) => (
    <CategoryRow
      key={category.id}
      category={category}
      groups={groups}
      others={(categories ?? []).filter((c) => c.id !== category.id)}
      onChanged={reload}
      onError={onError}
    />
  );

  return (
    <>
      <AddCategory groups={groups} onAdded={reload} onError={onError} />
      {(Object.keys(KIND_LABELS) as CategoryKind[]).map((kind) => {
        const ofKind = categories?.filter((c) => c.kind === kind) ?? [];
        if (categories && ofKind.length === 0) return null;
        return (
          <section className="section" key={kind}>
            <p className="label">{KIND_LABELS[kind]}</p>
            <h2>{categories ? `${ofKind.length} ${ofKind.length === 1 ? "category" : "categories"}` : "Loading…"}</h2>
            <p className="dek small">{KIND_HINTS[kind]}</p>
            {kind === "expense" && groups.length > 0 ? (
              // Spending in its chart groups, in the order the charts stack them.
              groups.map((group) => {
                const members = ofKind.filter((c) => (c.group ?? NEW_SPENDING_GROUP) === group.id);
                return (
                  <div className="category-group" key={group.id}>
                    <h3 className="category-group-heading">
                      <span className="legend-swatch" style={{ background: groupFill(group.id) }} aria-hidden="true" />
                      {group.name}
                      <span className="meta small">{members.length}</span>
                    </h3>
                    {members.length > 0 ? (
                      <div className="category-list">{members.map(row)}</div>
                    ) : (
                      <p className="meta small category-group-empty">
                        No categories yet. Move one here with its group menu.
                      </p>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="category-list">{ofKind.map(row)}</div>
            )}
          </section>
        );
      })}
    </>
  );
}

function AddCategory(props: { groups: SpendingGroup[]; onAdded: () => void; onError: (e: unknown) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [group, setGroup] = useState(NEW_SPENDING_GROUP);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.addCategory(name, kind, kind === "expense" ? group : null);
      setName("");
      setGroup(NEW_SPENDING_GROUP);
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
        {kind === "expense" && props.groups.length > 0 && (
          <label>
            Group
            <GroupSelect groups={props.groups} value={group} onChange={setGroup} />
          </label>
        )}
        <button type="submit" disabled={saving || !name.trim()}>
          {saving ? "Adding…" : "Add category"}
        </button>
      </form>
    </section>
  );
}

function CategoryRow(props: {
  category: Category;
  groups: SpendingGroup[];
  others: Category[];
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const { category } = props;
  const [name, setName] = useState(category.name);
  const [deleting, setDeleting] = useState(false);
  const [moveTo, setMoveTo] = useState("");
  useEffect(() => setName(category.name), [category.name]);

  const update = async (changes: Partial<Pick<Category, "name" | "kind" | "group">>) => {
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
          {category.kind === "expense" && props.groups.length > 0 && (
            <GroupSelect
              groups={props.groups}
              value={category.group ?? NEW_SPENDING_GROUP}
              onChange={(group) => update({ group })}
            />
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

/** The spending group a category belongs to, with the group's chart colour beside it. */
function GroupSelect(props: { groups: SpendingGroup[]; value: string; onChange: (group: string) => void }) {
  return (
    <span className="group-pick">
      <span className="legend-swatch" style={{ background: groupFill(props.value) }} aria-hidden="true" />
      <select aria-label="Group" value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
    </span>
  );
}
