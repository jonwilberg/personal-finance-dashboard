import type { Owner } from "./api";

/**
 * Whose an account is: one choice of each person or Shared, as a segmented control (joined buttons read as
 * "pick one").
 */
export function OwnerPicker(props: { label: string; owners: Owner[]; selected: string; onChange: (owner: string) => void }) {
  const { label, owners, selected, onChange } = props;
  return (
    <div className="owner-picker" role="radiogroup" aria-label={label}>
      {owners.map((owner) => {
        const on = owner.id === selected;
        return (
          <button
            key={owner.id}
            type="button"
            role="radio"
            aria-checked={on}
            className={on ? "is-on" : undefined}
            onClick={() => !on && onChange(owner.id)}
          >
            {owner.name}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Whose accounts the overview counts, as filter chips: Everyone, or any mix of people and Shared.
 * Separate chips with a tick read as "pick any". Picking a person from Everyone shows just them; switching the
 * last one off goes back to Everyone, so there's never an empty choice.
 */
export function OwnerFilter(props: { owners: Owner[]; selected: string[]; onChange: (selected: string[]) => void }) {
  const { owners, selected, onChange } = props;
  const all = owners.map((o) => o.id);
  const everyone = selected.length === all.length;

  const toggle = (id: string) => {
    if (everyone) return onChange([id]);
    const next = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
    onChange(next.length === 0 ? all : all.filter((o) => next.includes(o)));
  };

  return (
    <div className="owner-filter" role="group" aria-label="Whose accounts to count">
      <Chip on={everyone} onClick={() => !everyone && onChange(all)}>
        Everyone
      </Chip>
      <span className="owner-filter-rule" aria-hidden="true" />
      {owners.map((owner) => (
        <Chip key={owner.id} on={!everyone && selected.includes(owner.id)} onClick={() => toggle(owner.id)}>
          {owner.name}
        </Chip>
      ))}
    </div>
  );
}

function Chip(props: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`chip${props.on ? " is-on" : ""}`} aria-pressed={props.on} onClick={props.onClick}>
      {/* A tick box, so the state reads like a checkbox and doesn’t rest on colour alone. */}
      <span className="chip-box" aria-hidden="true">
        <svg viewBox="0 0 12 12">
          <path d="M2.6 6.3 5 8.6l4.4-5" />
        </svg>
      </span>
      {props.children}
    </button>
  );
}

/** "Jon’s and shared accounts", for saying whose money a view counts; null for everyone's. */
export function ownerScope(owners: Owner[], selected: string[]): string | null {
  if (selected.length === owners.length) return null;
  const parts = owners
    .filter((o) => selected.includes(o.id))
    .map((o) => (o.id === "shared" ? "shared" : `${o.name}’s`));
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `${text} accounts`;
}
