import { type FormEvent, useEffect, useState } from "react";
import { type Person, api } from "./api";

/** The people in the household. Each account can be one person's, or shared. */
export function PeopleSection(props: {
  people: Person[];
  /** Accounts per person id, to say what removing someone changes. */
  accountCounts: Record<string, number>;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const { people, accountCounts, onChanged, onError } = props;
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.addPerson(name);
      setName("");
      onChanged();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="section">
      <p className="label">People</p>
      <h2>Who’s in the household</h2>
      <p className="dek small">
        {people.length
          ? "Mark each account above as one person’s or Shared. The Overview can then show any of them."
          : "Add the people whose accounts these are, then mark each account as theirs or Shared."}
      </p>
      {people.length > 0 && (
        <ul className="people-list">
          {people.map((person) => (
            <PersonRow
              key={person.id}
              person={person}
              accounts={accountCounts[String(person.id)] ?? 0}
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </ul>
      )}
      <form className="connect-form" onSubmit={add}>
        <label className="grow">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" maxLength={40} />
        </label>
        <button type="submit" disabled={saving || !name.trim()}>
          {saving ? "Adding…" : "Add person"}
        </button>
      </form>
    </section>
  );
}

function PersonRow(props: { person: Person; accounts: number; onChanged: () => void; onError: (e: unknown) => void }) {
  const { person, accounts, onChanged, onError } = props;
  const [name, setName] = useState(person.name);
  useEffect(() => setName(person.name), [person.name]);

  const saveName = async () => {
    if (!name.trim() || name.trim() === person.name) return setName(person.name);
    try {
      await api.renamePerson(person.id, name);
      onChanged();
    } catch (error) {
      setName(person.name);
      onError(error);
    }
  };

  const remove = async () => {
    const note = accounts ? ` Their ${accounts} account${accounts === 1 ? "" : "s"} will become Shared.` : "";
    if (!window.confirm(`Remove ${person.name}?${note}`)) return;
    try {
      await api.removePerson(person.id);
      onChanged();
    } catch (error) {
      onError(error);
    }
  };

  return (
    <li className="person">
      <input
        className="category-name"
        aria-label="Name"
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onBlur={saveName}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setName(person.name);
        }}
      />
      <span className="meta small nowrap">
        {accounts} account{accounts === 1 ? "" : "s"}
      </span>
      <button className="text" onClick={remove}>
        Remove
      </button>
    </li>
  );
}
