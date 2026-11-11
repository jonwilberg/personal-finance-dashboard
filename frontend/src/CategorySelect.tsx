import type { Category } from "./api";

/** A category picker grouped by kind, with an empty first choice ("Choose category", "Uncategorized"…). */
export function CategorySelect(props: {
  categories: Category[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Marks the box as still to be chosen (in the full list, where most rows have a category). */
  needsCategory?: boolean;
}) {
  const groups: [string, Category["kind"]][] = [
    ["Spending", "expense"],
    ["Income", "income"],
    ["Saving", "saving"],
    ["Loans", "loan"],
    ["Other", "transfer"],
  ];
  return (
    <select
      className={props.needsCategory ? "needs-category" : undefined}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      aria-label="Category"
    >
      <option value="">{props.placeholder ?? "Choose category"}</option>
      {groups.map(([label, kind]) => (
        <optgroup key={kind} label={label}>
          {props.categories
            .filter((c) => c.kind === kind)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}
