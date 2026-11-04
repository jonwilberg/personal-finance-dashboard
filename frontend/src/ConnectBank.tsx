import { type FormEvent, useEffect, useState } from "react";
import { type Bank, api } from "./api";
import { BankPicker } from "./BankPicker";

const COUNTRIES = [
  ["NO", "Norway"],
  ["SE", "Sweden"],
  ["DK", "Denmark"],
  ["FI", "Finland"],
] as const;

export function ConnectBank({ onError }: { onError: (e: unknown) => void }) {
  const [country, setCountry] = useState("NO");
  const [banks, setBanks] = useState<Bank[]>([]);
  const [bank, setBank] = useState("");
  const [days, setDays] = useState(180);
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    setBanks([]);
    api.banks(country).then(setBanks).catch(onError);
  }, [country, onError]);

  const selected = banks.find((b) => b.name.toLowerCase() === bank.trim().toLowerCase());
  const maxDays = selected?.max_consent_days || 180;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setRedirecting(true);
    try {
      const { url } = await api.connect(selected.name, country, Math.min(days, maxDays));
      window.location.href = url; // the bank sends the browser back to /callback when done
    } catch (error) {
      onError(error);
      setRedirecting(false);
    }
  };

  return (
    <section className="section">
      <p className="label">Add a bank</p>
      <h2>Connect another bank</h2>
      <p className="dek small">Log in at your bank to give read-only access to balances and transactions.</p>
      <form className="connect-form" onSubmit={submit}>
        <label>
          Country
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <div className="grow">
          <BankPicker label="Bank" banks={banks} value={bank} onChange={setBank} />
        </div>
        <label>
          Access for (days)
          <input
            type="number"
            min={1}
            max={maxDays}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          />
        </label>
        <button type="submit" disabled={!selected || redirecting}>
          {redirecting ? "Opening bank…" : "Connect"}
        </button>
      </form>
    </section>
  );
}
