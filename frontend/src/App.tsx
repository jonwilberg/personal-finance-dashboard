import { useCallback, useEffect, useState } from "react";
import { type Account, type AppInfo, type Connection, type InspectReport, api } from "./api";
import { ConnectBank } from "./ConnectBank";
import { formatDate, formatMoney } from "./format";
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
  "#/transactions": {
    nav: "Transactions",
    title: "Transactions",
    dek: "Every transaction gets a category so the statistics add up. Review the ones the rules can't place.",
  },
  "#/accounts": {
    nav: "Accounts",
    title: "Accounts",
    dek: "Banks connected through Enable Banking, with read-only access to balances and transactions.",
  },
} as const;
type Route = keyof typeof PAGES;

function currentRoute(): Route {
  return window.location.hash in PAGES ? (window.location.hash as Route) : "#/accounts";
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
          <span className="wordmark">Personal Finance</span>
          <nav className="nav">
            {(Object.keys(PAGES) as Route[]).map((key) => (
              <a key={key} href={key} aria-current={key === route ? "page" : undefined}>
                {PAGES[key].nav}
              </a>
            ))}
          </nav>
          {appInfo && (
            <span className={`badge ${appInfo.environment === "PRODUCTION" ? "badge-live" : "badge-test"}`}>
              {appInfo.environment === "PRODUCTION" ? "Production" : "Sandbox"}
              {!appInfo.active && " · inactive"}
            </span>
          )}
        </div>
        <h1>{page.title}</h1>
        <p className="dek">{page.dek}</p>
      </header>

      {notice && (
        <div className={`notice notice-${notice.kind}`} role="status">
          <span>{notice.text}</span>
          <button className="link" onClick={() => setNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {route === "#/transactions" ? <TransactionsPage onError={showError} /> : <AccountsPage onError={showError} />}
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

      <ConnectBank onError={onError} />
    </>
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
    <article className="connection">
      <div className="connection-header">
        <div>
          <h3>{connection.aspsp.name}</h3>
          <p className="meta">
            {connection.expired ? (
              <span className="badge badge-warn">Consent expired, reconnect</span>
            ) : (
              <>Access until {formatDate(connection.valid_until)}</>
            )}
          </p>
        </div>
        <button className="text" onClick={disconnect} disabled={busy}>
          Disconnect
        </button>
      </div>
      <div className="accounts">
        {connection.accounts.map((account) => (
          <AccountRow key={account.uid} account={account} onError={onError} />
        ))}
      </div>
    </article>
  );
}

function AccountRow(props: { account: Account; onError: (e: unknown) => void }) {
  const [account, setAccount] = useState(props.account);
  const [fetching, setFetching] = useState(false);
  const [report, setReport] = useState<InspectReport | null>(null);
  const balance = account.balances?.balances[0];

  const fetchHistory = async () => {
    setFetching(true);
    try {
      const state = await api.refresh(account.uid);
      setAccount((current) => ({ ...current, ...state }));
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
      <div className="account-main">
        <div>
          <div className="account-name">{account.product || account.name || "Account"}</div>
          <div className="muted small">
            {[maskIban(account.iban), account.currency, account.cash_account_type].filter(Boolean).join(" · ")}
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
                  {account.transactions.first_date} → {account.transactions.last_date}
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

function maskIban(iban: string | null) {
  return iban ? `•••• ${iban.slice(-4)}` : null;
}
