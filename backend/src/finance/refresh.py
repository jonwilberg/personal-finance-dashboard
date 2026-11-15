"""Fetching an account's balances and transactions from its bank: for one account (the app's refresh button) or for
every connected account (`finance refresh-all`, run daily when hosted)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from finance.connections import account_identifiers
from finance.enable_banking import EnableBankingClient, EnableBankingError
from finance.manual import is_manual_session
from finance.storage import Storage

DEFAULT_DAYS = 90


class ManualAccount(Exception):
    pass


@dataclass
class RefreshResult:
    account_uid: str
    name: str
    bank: str
    # Transactions the bank returned, or None when the refresh failed or was skipped.
    fetched: int | None
    problem: str | None = None


def refresh_account(
    client: EnableBankingClient, store: Storage, account_uid: str, days: int = DEFAULT_DAYS, longest: bool = False
) -> int:
    """Fetch and save the account's balances and recent transactions; returns how many transactions came back.
    Older stored history is kept (see Storage.save_transactions)."""
    if any(
        is_manual_session(s["session_id"]) and any(a["uid"] == account_uid for a in s["accounts"])
        for s in store.sessions()
    ):
        raise ManualAccount("This account was added by hand, so there's no bank to refresh it from.")
    if store.account_needs_numbers(account_uid):
        # Needed to recognise transfers to this account; fetched once.
        store.set_account_identifiers(account_uid, account_identifiers(client.get_account_details(account_uid)))
    store.save_balances(account_uid, client.get_balances(account_uid))
    if longest:
        transactions = client.iter_transactions(account_uid, strategy="longest")
    else:
        transactions = client.iter_transactions(account_uid, date_from=date.today() - timedelta(days=days))
    fetched = list(transactions)
    store.save_transactions(account_uid, fetched)
    return len(fetched)


def refresh_all(
    client: EnableBankingClient, store: Storage, days: int = DEFAULT_DAYS, now: datetime | None = None
) -> list[RefreshResult]:
    """Refresh every account of every bank connection whose consent is still valid. One account failing (a bank
    that's down, a daily limit reached) doesn't stop the others."""
    now = now or datetime.now(UTC)
    results = []
    for session in store.sessions():
        if is_manual_session(session["session_id"]):
            continue
        bank = session.get("aspsp", {}).get("name", "")
        expired = datetime.fromisoformat(session["valid_until"]) <= now
        for account in session["accounts"]:
            result = RefreshResult(account["uid"], account.get("name") or account["uid"], bank, None)
            if expired:
                result.problem = "consent expired: reconnect the bank in the app"
            else:
                try:
                    result.fetched = refresh_account(client, store, account["uid"], days=days)
                except EnableBankingError as error:
                    result.problem = f"Enable Banking: {error.body}"
            results.append(result)
    return results
