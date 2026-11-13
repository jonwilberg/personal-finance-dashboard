import { useEffect, useState } from "react";
import { type Category, type Transaction, api } from "./api";
import { CategorySelect } from "./CategorySelect";
import { formatMoney } from "./format";

const UNCATEGORIZED = "uncategorized";

function dayAndMonth(iso: string) {
  return new Date(iso).toLocaleDateString("nb-NO", { day: "numeric", month: "short" });
}

/**
 * The transactions behind one row of the overview's category table, for its month and owners, each with a
 * category picker. A change is saved at once and the overview recounts; the transaction stays in this list,
 * marked as moved with an undo, until the row is closed, so nothing jumps away while you work through it.
 */
export function CategoryTransactions(props: {
  category: string;
  month: string;
  owners?: string[];
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const { category, month, owners, onError } = props;
  const [items, setItems] = useState<Transaction[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  // Each changed transaction's category before the first change here, to undo to.
  const [before, setBefore] = useState<Record<string, Transaction>>({});
  const ownersKey = owners?.join(",");

  useEffect(() => {
    api
      .transactions({ category, month, owner: ownersKey?.split(","), limit: 1000 })
      // Money in without a category isn't spending, so it isn't in the row's total either.
      .then((r) => setItems(category === UNCATEGORIZED ? r.items.filter((t) => t.direction === "DBIT") : r.items))
      .catch(onError);
    api.categories().then(setCategories).catch(onError);
  }, [category, month, ownersKey, onError]);

  const save = async (t: Transaction, value: string | null) => {
    try {
      const { items: [updated] } = await api.setCategories([{ id: t.id, category: value }]);
      setItems((list) => list?.map((x) => (x.id === t.id ? updated : x)) ?? null);
      props.onChanged();
      return updated;
    } catch (error) {
      onError(error);
      return null;
    }
  };

  const choose = async (t: Transaction, value: string) => {
    if (!before[t.id]) setBefore((b) => ({ ...b, [t.id]: t }));
    await save(t, value || null);
  };

  // Back to how it was: your own earlier choice, or the automatic category if there was none.
  const undo = async (t: Transaction) => {
    const original = before[t.id];
    if (!original) return;
    if (await save(t, original.category_source === "manual" ? original.category : null)) {
      setBefore(({ [t.id]: _, ...rest }) => rest);
    }
  };

  if (items === null) return <p className="meta small drill-note">Loading transactions…</p>;
  if (items.length === 0) return <p className="meta small drill-note">No transactions this month.</p>;

  const name = (id: string | null) => categories.find((c) => c.id === id)?.name ?? "Uncategorized";
  const moved = (t: Transaction) => (category === UNCATEGORIZED ? t.category !== null : t.category !== category);

  return (
    <div className="drill">
      <p className="meta small drill-note">
        {items.length} transaction{items.length === 1 ? "" : "s"} · choose another category to move one
      </p>
      <ul className="drill-list">
        {items.map((t) => (
          <li key={t.id} className={`drill-row${moved(t) ? " is-moved" : ""}`}>
            <span className="small nowrap drill-date">{dayAndMonth(t.date)}</span>
            <span className="drill-text">
              <span className="drill-description">{t.description || t.merchant || "—"}</span>
              <span className="meta small">
                {t.account}
                {moved(t) && (
                  <>
                    {" · "}
                    <strong>Moved to {name(t.category)}</strong>
                    {before[t.id] && (
                      <>
                        {" · "}
                        <button className="text" onClick={() => undo(t)}>
                          Undo
                        </button>
                      </>
                    )}
                  </>
                )}
              </span>
            </span>
            <span className="num amount-cell drill-amount">{formatMoney(t.amount, t.currency ?? "NOK")}</span>
            <CategorySelect
              categories={categories}
              value={t.category ?? ""}
              placeholder="Uncategorized"
              onChange={(value) => choose(t, value)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
