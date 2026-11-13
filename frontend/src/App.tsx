import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ACCOUNT_TYPES, accountName, accountNumber } from "./accounts";
import { type Account, type AppInfo, type Connection, type Owner, api } from "./api";
import { OwnerPicker } from "./OwnerPicker";
import { PeopleSection } from "./PeopleSection";
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
  const [titleActions, setTitleActions] = useState<HTMLElement | null>(null);

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
            <div className="title-row">
              <h1>{page.title}</h1>
              {/* Pages can put actions here, on the title's row (see AccountsPage). */}
              <div className="title-actions" ref={setTitleActions} />
            </div>
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
      {route === "#/accounts" && <AccountsPage titleActions={titleActions} onError={showError} />}
    </div>
  );
}

function AccountsPage({ titleActions, onError }: { titleActions: HTMLElement | null; onError: (e: unknown) => void }) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const loadConnections = useCallback(() => {
    api.connections().then(setConnections).catch(onError);
  }, [onError]);
  useEffect(loadConnections, [loadConnections]);
  const [owners, setOwners] = useState<Owner[]>([]);
  const loadOwners = useCallback(() => {
    api.owners().then(setOwners).catch(onError);
  }, [onError]);
  useEffect(loadOwners, [loadOwners]);
  const people = owners.filter((o) => o.id !== "shared").map((o) => ({ id: Number(o.id), name: o.name }));
  const accountCounts: Record<string, number> = {};
  for (const account of connections?.flatMap((c) => c.accounts) ?? []) {
    accountCounts[account.owner] = (accountCounts[account.owner] ?? 0) + 1;
  }
  // Adding, renaming or removing someone changes the pickers and, on removal, the accounts' owners.
  const peopleChanged = useCallback(() => {
    loadOwners();
    loadConnections();
  }, [loadOwners, loadConnections]);

  /** Shows the new owner at once, saves it, and puts the old one back if saving fails. */
  const changeOwner = useCallback(
    async (uid: string, owner: string) => {
      const withOwner = (list: Connection[] | null, pick: (current: string) => string) =>
        list?.map((c) => ({ ...c, accounts: c.accounts.map((a) => (a.uid === uid ? { ...a, owner: pick(a.owner) } : a)) })) ??
        null;
      let previous = "shared";
      setConnections((list) => {
        previous = list?.flatMap((c) => c.accounts).find((a) => a.uid === uid)?.owner ?? previous;
        return withOwner(list, () => owner);
      });
      try {
        await api.setOwner(uid, owner);
      } catch (error) {
        setConnections((list) => withOwner(list, () => previous));
        onError(error);
      }
    },
    [onError],
  );

  return (
    <>
      {titleActions &&
        connections &&
        connections.length > 0 &&
        createPortal(<RefreshAll connections={connections} onChanged={loadConnections} />, titleActions)}

      <ConnectBank onError={onError} />

      <section className="section">
        <p className="label">Connections</p>
        <h2>{connectionsHeadline(connections)}</h2>
        {connections?.map((connection) => (
          <ConnectionCard
            key={connection.session_id}
            connection={connection}
            owners={owners}
            onOwnerChange={changeOwner}
            onChanged={loadConnections}
            onError={onError}
          />
        ))}
      </section>

      <PeopleSection people={people} accountCounts={accountCounts} onChanged={peopleChanged} onError={onError} />
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
  const latest = rows
    .map((row) => row.updated)
    .filter((t): t is string => !!t)
    .reduce<string | null>((a, b) => (a && new Date(a) > new Date(b) ? a : b), null);

  return (
    <div className="refresh-all">
      {/* Focusable so keyboard users can open the per-account list too. */}
      <span className={`refresh-summary small ${failed && !running ? "refresh-failed" : "muted"}`} tabIndex={0}>
        {failed && !running
          ? `${failed} of ${done} failed`
          : latest
            ? `Last refreshed ${formatUpdated(latest)}`
            : "Never refreshed"}
      </span>
      {/* Shown on hover or focus of the summary, and kept open while refreshing to show progress. */}
      <ul className={`refresh-list small${running ? " is-open" : ""}`} role="tooltip">
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
                          ? formatUpdated(updated)
                          : "Never"}
              </span>
            </li>
          );
        })}
      </ul>
      <button
        className="secondary"
        onClick={refreshAll}
        disabled={running || refreshable.length === 0}
        title="Fetches balance and full history for every account. Many banks allow about 4 fetches per account per day."
      >
        {running ? `Refreshing ${Math.min(done + 1, refreshable.length)} of ${refreshable.length}…` : "Refresh all"}
      </button>
    </div>
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

function ConnectionCard(props: {
  connection: Connection;
  owners: Owner[];
  onOwnerChange: (uid: string, owner: string) => void;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const { connection, owners, onOwnerChange, onChanged, onError } = props;
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
      <ul className="account-list">
        {connection.accounts.map((account) => (
          <AccountRow key={account.uid} account={account} owners={owners} onOwnerChange={onOwnerChange} />
        ))}
      </ul>
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

function sinceMonth(iso: string) {
  return new Date(iso).toLocaleDateString("nb-NO", { month: "short", year: "numeric" });
}

function transactionsText(account: Account) {
  const t = account.transactions;
  if (!t) return "Not fetched yet";
  if (t.count === 0) return "No transactions";
  return `${plural(t.count, "transaction")}${t.first_date ? ` since ${sinceMonth(t.first_date)}` : ""}`;
}

/** One line per account: name and details on the left, balance on the right. */
function AccountRow(props: { account: Account; owners: Owner[]; onOwnerChange: (uid: string, owner: string) => void }) {
  const { account, owners, onOwnerChange } = props;
  const name = accountName(account);
  const type = ACCOUNT_TYPES[account.cash_account_type ?? ""];
  const balance = account.balances?.balances[0];
  const details = [type !== name ? type : null, accountNumber(account), transactionsText(account)].filter(Boolean);

  return (
    <li className="account">
      <div className="account-main">
        <div className="account-name">{name}</div>
        <div className="account-meta small">{details.join(" · ")}</div>
      </div>
      {/* Until people are added (below) every account is shared, so there's nothing to pick. */}
      {owners.length > 1 && (
        <OwnerPicker
          label={`Whose is ${name}?`}
          owners={owners}
          selected={account.owner}
          onChange={(owner) => onOwnerChange(account.uid, owner)}
        />
      )}
      {balance ? (
        <div className="account-balance amount" title={`Balance as of ${formatDate(account.balances!.fetched_at)}`}>
          {formatMoney(balance.balance_amount.amount, balance.balance_amount.currency)}
        </div>
      ) : (
        <div className="account-balance muted" title="The bank hasn't reported a balance">
          –
        </div>
      )}
    </li>
  );
}
