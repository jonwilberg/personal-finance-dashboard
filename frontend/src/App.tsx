import { useCallback, useEffect, useState } from "react";
import { type Account, type AppInfo, type Connection, type InspectReport, api } from "./api";
import { CategoriesPage } from "./CategoriesPage";
import { ConnectBank } from "./ConnectBank";
import { formatDate, formatMoney, formatUpdated } from "./format";
import { OverviewPage } from "./OverviewPage";
import { TransactionsPage } from "./TransactionsPage";

type Notice = { kind: "success" | "error"; text: string };

/** Reads ?connected= / ?error= set by the backend after a bank login, then cleans the URL. */
function takeRedirectNotice(): Notice | null {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("connected");
  const error = params.get("error");
  if (connected || error) window.history.replaceState(null, "", window.location.pathname);
  if (connected) return { kind: "success", text: `Connected ${connected}.` };
  if (error) return { kind: "error", text: `Bank connection failed: ${error}` };
  return null;
}

const PAGES = {
  "#/overview": {
    nav: "Overview",
    title: "Overview",
    dek: "How your money moved, one month at a time.",
  },
  "#/transactions": {
    nav: "Transactions",
    title: "Transactions",
    dek: "Every transaction gets a category so the statistics add up. Review the ones the rules can't place.",
  },
  "#/categories": {
    nav: "Categories",
    title: "Categories",
    dek: "Rename, add and remove categories, and mark which costs are fixed.",
  },
  "#/accounts": {
    nav: "Accounts",
    title: "Accounts",
    dek: "Your banks, connected through Enable Banking.",
  },
} as const;
type Route = keyof typeof PAGES;

function currentRoute(): Route {
  return window.location.hash in PAGES ? (window.location.hash as Route) : "#/overview";
}

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [route, setRoute] = useState<Route>(currentRoute);
  const [notice, setNotice] = useState<Notice | null>(takeRedirectNotice);

  const showError = useCallback((error: unknown) => {
    setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
  }, []);

  useEffect(() => {
    api.app().then(setAppInfo).catch(showError);
    const onHashChange = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [showError]);

  const page = PAGES[route];
  return (
    <div className="page">
      <header className="masthead">
        <div className="masthead-top">
          <span className="wordmark">Wilberg Household Finance</span>
          <nav className="nav">
            {(Object.keys(PAGES) as Route[]).map((key) => (
              <a key={key} href={key} aria-current={key === route ? "page" : undefined}>
                {PAGES[key].nav}
              </a>
            ))}
          </nav>
          {/* Only flag the unusual cases: test data, or a bank access that stopped working. */}
          {appInfo && (appInfo.environment !== "PRODUCTION" || !appInfo.active) && (
            <span className="badge badge-test">
              {appInfo.environment === "PRODUCTION" ? "Inactive" : "Sandbox"}
              {appInfo.environment !== "PRODUCTION" && !appInfo.active && " · inactive"}
            </span>
          )}
        </div>
        {/* The overview's own headline is its title. */}
        {route !== "#/overview" && (
          <>
            <h1>{page.title}</h1>
            <p className="dek">{page.dek}</p>
          </>
        )}
      </header>

      {notice && (
        <div className={`notice notice-${notice.kind}`} role="status">
          <span>{notice.text}</span>
          <button className="link" onClick={() => setNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {route === "#/overview" && <OverviewPage onError={showError} />}
      {route === "#/transactions" && <TransactionsPage onError={showError} />}
      {route === "#/categories" && <CategoriesPage onError={showError} />}
      {route === "#/accounts" && <AccountsPage onError={showError} />}
    </div>
  );
}

function AccountsPage({ onError }: { onError: (e: unknown) => void }) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const loadConnections = useCallback(() => {
    api.connections().then(setConnections).catch(onError);
  }, [onError]);
  useEffect(loadConnections, [loadConnections]);

  return (
    <>
      {connections && connections.length > 0 && (
        <RefreshAll connections={connections} onChanged={loadConnections} />
      )}

      <ConnectBank onError={onError} />

      <section className="section">
        <p className="label">Connections</p>
        <h2>{connectionsHeadline(connections)}</h2>
        {connections?.map((connection) => (
          <ConnectionCard
            key={connection.session_id}
            connection={connection}
            onChanged={loadConnections}
            onError={onError}
          />
        ))}
      </section>
    </>
  );
}

type RefreshStatus = { state: "waiting" | "refreshing" | "done" } | { state: "failed"; message: string };

/** The most recent time the account's balance or transactions were fetched from the bank. */
function lastUpdated(account: Account) {
  const times = [account.balances?.fetched_at, account.transactions?.fetched_at].filter((t): t is string => !!t);
  return times.length ? times.reduce((a, b) => (new Date(a) > new Date(b) ? a : b)) : null;
}

/** Refreshes every account with a valid consent, one at a time, and lists when each was last updated. */
function RefreshAll({ connections, onChanged }: { connections: Connection[]; onChanged: () => void }) {
  const [status, setStatus] = useState<Record<string, RefreshStatus>>({});
  const [running, setRunning] = useState(false);

  const rows = connections.flatMap((connection) =>
    connection.accounts.map((account) => ({ connection, account, updated: lastUpdated(account) })),
  );
  const refreshable = rows.filter((row) => !row.connection.expired);

  const refreshAll = async () => {
    setRunning(true);
    setStatus(Object.fromEntries(refreshable.map((row) => [row.account.uid, { state: "waiting" }])));
    // One at a time: banks rate-limit, and it keeps a failing bank from hiding the others' progress.
    for (const { account } of refreshable) {
      setStatus((s) => ({ ...s, [account.uid]: { state: "refreshing" } }));
      try {
        await api.refresh(account.uid);
        setStatus((s) => ({ ...s, [account.uid]: { state: "done" } }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus((s) => ({ ...s, [account.uid]: { state: "failed", message } }));
      }
    }
    setRunning(false);
    onChanged();
  };

  const done = Object.values(status).filter((s) => s.state === "done" || s.state === "failed").length;
  const failed = Object.values(status).filter((s) => s.state === "failed").length;

  return (
    <section className="section refresh-all">
      <div className="refresh-all-head">
        <button
          onClick={refreshAll}
          disabled={running || refreshable.length === 0}
          title="Fetches balance and full history for every account. Many banks allow about 4 fetches per account per day."
        >
          {running ? `Refreshing ${Math.min(done + 1, refreshable.length)} of ${refreshable.length}…` : "Refresh all"}
        </button>
        {!running && done > 0 && (
          <span className={`small ${failed ? "refresh-failed" : "muted"}`}>
            {failed ? `${failed} of ${done} failed` : `All ${plural(done, "account")} updated`}
          </span>
        )}
      </div>
      <ul className="refresh-list small">
        {rows.map(({ connection, account, updated }) => {
          const s = status[account.uid];
          return (
            <li key={account.uid}>
              <span>
                {connection.aspsp.name} · {accountName(account)}
                {accountNumber(account) && <span className="muted"> {accountNumber(account)}</span>}
              </span>
              <span className={s?.state === "failed" ? "refresh-failed" : "muted"}>
                {connection.expired
                  ? "Consent expired, reconnect"
                  : s?.state === "refreshing"
                    ? "Refreshing…"
                    : s?.state === "waiting"
                      ? "Waiting…"
                      : s?.state === "failed"
                        ? `Failed: ${s.message}`
                        : updated
                          ? `Updated ${formatUpdated(updated)}`
                          : "Never updated"}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function connectionsHeadline(connections: Connection[] | null) {
  if (connections === null) return "Loading…";
  if (connections.length === 0) return "No banks connected yet";
  const accounts = connections.reduce((sum, c) => sum + c.accounts.length, 0);
  const expired = connections.filter((c) => c.expired).length;
  const summary = `${plural(connections.length, "bank")}, ${plural(accounts, "account")}`;
  return expired ? `${summary}; ${expired} need${expired === 1 ? "s" : ""} reconnecting` : summary;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function ConnectionCard(props: { connection: Connection; onChanged: () => void; onError: (e: unknown) => void }) {
  const { connection, onChanged, onError } = props;
  const [busy, setBusy] = useState(false);

  const disconnect = async () => {
    if (!window.confirm(`Revoke access to ${connection.aspsp.name}?`)) return;
    setBusy(true);
    try {
      await api.disconnect(connection.session_id);
      onChanged();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="bank">
      <header className="bank-header">
        <span className="bank-mark" aria-hidden="true">
          {initials(connection.aspsp.name)}
        </span>
        <div className="bank-title">
          <h3>{connection.aspsp.name}</h3>
          <p className="meta small">
            {plural(connection.accounts.length, "account")} ·{" "}
            {connection.expired ? (
              <span className="badge badge-warn">Consent expired, reconnect</span>
            ) : (
              <>access until {formatDate(connection.valid_until)}</>
            )}
          </p>
        </div>
        <button className="text" onClick={disconnect} disabled={busy}>
          Disconnect
        </button>
      </header>
      <div className="account-list">
        <div className="account-head account-grid" aria-hidden="true">
          <span>Account</span>
          <span className="num">Balance</span>
          <span>Transactions</span>
          <span />
        </div>
        {connection.accounts.map((account) => (
          <AccountRow key={account.uid} account={account} onChanged={onChanged} onError={onError} />
        ))}
      </div>
    </article>
  );
}

function initials(bankName: string) {
  const words = bankName.split(/\s+/).filter((w) => /^[A-Za-zÆØÅæøå]/.test(w));
  return words
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

const ACCOUNT_TYPES: Record<string, string> = {
  CACC: "Current account",
  SVGS: "Savings",
  CARD: "Credit card",
  LOAN: "Loan",
};

/** Bank product names arrive as "BRUKSKONTO PLUSS" or "SavingsAccountPlus"; make them readable. */
function accountName(account: Account) {
  const raw = account.product || account.name || ACCOUNT_TYPES[account.cash_account_type ?? ""] || "Account";
  const spaced = raw.replace(/([a-z])([A-Z])/g, "$1 $2");
  if (spaced !== spaced.toUpperCase()) return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return spaced.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, space, letter) => space + letter.toUpperCase());
}

function accountNumber(account: Account) {
  const number = account.iban ?? account.identifiers?.[0];
  return number ? `••${number.replace(/\D/g, "").slice(-4)}` : null;
}

function monthRange(first: string | null, last: string | null) {
  if (!first || !last) return null;
  const month = (iso: string) => new Date(iso).toLocaleDateString("nb-NO", { month: "short", year: "numeric" });
  return `${month(first)} – ${month(last)}`;
}

function AccountRow(props: { account: Account; onChanged: () => void; onError: (e: unknown) => void }) {
  const [account, setAccount] = useState(props.account);
  const [fetching, setFetching] = useState(false);
  const [report, setReport] = useState<InspectReport | null>(null);
  const balance = account.balances?.balances[0];

  // Pick up new data when the page reloads connections, e.g. after "Refresh all".
  useEffect(() => setAccount(props.account), [props.account]);

  const fetchHistory = async () => {
    setFetching(true);
    try {
      const state = await api.refresh(account.uid);
      setAccount((current) => ({ ...current, ...state }));
      props.onChanged(); // keeps the "last updated" list at the top in step
      if (report) setReport(await api.inspect(account.uid));
    } catch (error) {
      props.onError(error);
    } finally {
      setFetching(false);
    }
  };

  const toggleInspect = async () => {
    if (report) return setReport(null);
    try {
      setReport(await api.inspect(account.uid));
    } catch (error) {
      props.onError(error);
    }
  };

  return (
    <div className="account">
      <div className="account-grid">
        <div>
          <div className="account-name">{accountName(account)}</div>
          <div className="account-meta small">
            {ACCOUNT_TYPES[account.cash_account_type ?? ""] && (
              <span className="account-type">{ACCOUNT_TYPES[account.cash_account_type ?? ""]}</span>
            )}
            <span className="muted">{[accountNumber(account), account.currency].filter(Boolean).join(" · ")}</span>
          </div>
        </div>
        <div className="account-balance">
          {balance ? (
            <>
              <div className="amount">{formatMoney(balance.balance_amount.amount, balance.balance_amount.currency)}</div>
              <div className="muted small">as of {formatDate(account.balances!.fetched_at)}</div>
            </>
          ) : (
            <span className="muted small">No balance yet</span>
          )}
        </div>
        <div className="account-transactions muted small">
          {account.transactions ? (
            <>
              {account.transactions.count} transactions
              {account.transactions.first_date && (
                <>
                  <br />
                  {monthRange(account.transactions.first_date, account.transactions.last_date)}
                </>
              )}
            </>
          ) : (
            "Not fetched yet"
          )}
        </div>
        <div className="account-actions">
          <button
            className="secondary"
            onClick={fetchHistory}
            disabled={fetching}
            title="Fetches balance and full history. Many banks allow about 4 fetches per account per day."
          >
            {fetching ? "Fetching…" : account.transactions ? "Refresh" : "Fetch history"}
          </button>
          <button className="text" onClick={toggleInspect} disabled={!account.transactions}>
            {report ? "Hide fields" : "Inspect fields"}
          </button>
        </div>
      </div>
      {report && <InspectPanel report={report} />}
    </div>
  );
}

function InspectPanel({ report }: { report: InspectReport }) {
  return (
    <div className="inspect">
      <p className="small">
        {report.count} transactions from {report.first_date ?? "?"} to {report.last_date ?? "?"} ·{" "}
        {describeCounts(report.statuses)} · {describeCounts(report.directions)} · {describeCounts(report.currencies)}
      </p>
      <table className="coverage">
        <thead>
          <tr>
            <th>Field</th>
            <th>Filled in</th>
          </tr>
        </thead>
        <tbody>
          {report.coverage.map(({ field, share }) => (
            <tr key={field}>
              <td>
                <code>{field}</code>
              </td>
              <td>
                <div className="bar">
                  <div className="bar-fill" style={{ width: `${share * 100}%` }} />
                  <span>{Math.round(share * 100)}%</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function describeCounts(counts: Record<string, number>) {
  return Object.entries(counts)
    .map(([value, count]) => `${value} ${count}`)
    .join(", ");
}
