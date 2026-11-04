import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Bank } from "./api";

const MAX_RESULTS = 60;

/** Searchable bank list (an accessible combobox), styled with the app's tokens instead of the browser's datalist. */
export function BankPicker(props: { banks: Bank[]; value: string; onChange: (name: string) => void; label: string }) {
  const { banks, value, onChange } = props;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const id = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const query = value.trim().toLowerCase();
  const matches = useMemo(() => rank(banks, query).slice(0, MAX_RESULTS), [banks, query]);
  const selected = banks.find((b) => b.name.toLowerCase() === query);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const choose = (bank: Bank) => {
    onChange(bank.name);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) return setOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (matches.length ? (i + step + matches.length) % matches.length : 0));
    } else if (event.key === "Enter" && open && matches[active]) {
      event.preventDefault();
      choose(matches[active]);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="combobox">
      <label htmlFor={`${id}-input`}>{props.label}</label>
      <div className="combobox-field">
        {selected && <BankLogo bank={selected} />}
        <input
          id={`${id}-input`}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${id}-option-${active}` : undefined}
          autoComplete="off"
          value={value}
          placeholder={banks.length ? `Search ${banks.length} banks` : "Loading banks…"}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
      </div>
      {open && banks.length > 0 && (
        <ul className="combobox-list" id={`${id}-list`} role="listbox" ref={listRef} aria-label={props.label}>
          {matches.length === 0 && <li className="combobox-empty">No banks match "{value.trim()}"</li>}
          {matches.map((bank, index) => (
            <li
              key={bank.name}
              id={`${id}-option-${index}`}
              data-index={index}
              role="option"
              aria-selected={index === active}
              className="combobox-option"
              // Keep focus in the input so the click isn't lost to the input's blur.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(bank)}
              onMouseMove={() => setActive(index)}
            >
              <BankLogo bank={bank} />
              <span className="combobox-name">
                <Highlight text={bank.name} query={query} />
              </span>
              {bank.max_consent_days > 0 && <span className="combobox-meta">{bank.max_consent_days} days</span>}
            </li>
          ))}
          {matches.length === MAX_RESULTS && (
            <li className="combobox-empty">Type to narrow down the list</li>
          )}
        </ul>
      )}
    </div>
  );
}

function BankLogo({ bank }: { bank: Bank }) {
  const [failed, setFailed] = useState(false);
  if (!bank.logo || failed) {
    return (
      <span className="bank-logo bank-logo-fallback" aria-hidden="true">
        {bank.name.charAt(0).toUpperCase()}
      </span>
    );
  }
  return <img className="bank-logo" src={bank.logo} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const start = query ? text.toLowerCase().indexOf(query) : -1;
  if (start < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, start)}
      <mark>{text.slice(start, start + query.length)}</mark>
      {text.slice(start + query.length)}
    </>
  );
}

/** Banks whose name starts with the query first, then those with a word starting with it, then any match. */
function rank(banks: Bank[], query: string): Bank[] {
  if (!query) return banks;
  const score = (name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith(query)) return 0;
    if (lower.split(/[\s-]+/).some((word) => word.startsWith(query))) return 1;
    return lower.includes(query) ? 2 : -1;
  };
  return banks
    .map((bank) => ({ bank, score: score(bank.name) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.bank.name.localeCompare(b.bank.name, "nb"))
    .map((entry) => entry.bank);
}
