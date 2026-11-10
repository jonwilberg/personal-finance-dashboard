import type { Owner } from "./api";

/**
 * A row of joined buttons, one per owner (each person, then Shared).
 * - "single": exactly one is chosen, like radio buttons (whose an account is).
 * - "multi": each can be switched in and out on its own (whose accounts the overview counts).
 */
export function OwnerPicker(props: {
  mode: "single" | "multi";
  label: string;
  owners: Owner[];
  selected: string[];
  onToggle: (owner: string) => void;
}) {
  const { mode, label, owners, selected, onToggle } = props;
  const single = mode === "single";
  return (
    <div className="owner-picker" role={single ? "radiogroup" : "group"} aria-label={label}>
      {owners.map((owner) => {
        const on = selected.includes(owner.id);
        // In multi mode the last owner left can't be switched out: an overview of nobody's accounts is empty.
        const locked = !single && on && selected.length === 1;
        return (
          <button
            key={owner.id}
            type="button"
            className={on ? "is-on" : undefined}
            role={single ? "radio" : undefined}
            aria-checked={single ? on : undefined}
            aria-pressed={single ? undefined : on}
            aria-disabled={locked || undefined}
            title={locked ? "At least one must be selected" : undefined}
            onClick={() => !locked && !(single && on) && onToggle(owner.id)}
          >
            {owner.name}
          </button>
        );
      })}
    </div>
  );
}
