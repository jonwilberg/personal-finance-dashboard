"""Bank connections: helpers for the Enable Banking consent flow. Results are stored by storage.Storage."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from finance.enable_banking import EnableBankingClient


class BankNotFound(Exception):
    pass


def find_aspsp(client: EnableBankingClient, name: str, country: str) -> dict[str, Any]:
    aspsps = client.list_aspsps(country=country)
    for aspsp in aspsps:
        if aspsp["name"].lower() == name.lower():
            return aspsp
    close = [a["name"] for a in aspsps if name.lower() in a["name"].lower()]
    hint = f" Did you mean: {', '.join(close)}?" if close else ""
    raise BankNotFound(f"No bank named {name!r} in {country.upper()}.{hint}")


def consent_valid_until(aspsp: dict[str, Any], days: int) -> datetime:
    """Requested consent end, capped at the longest consent the bank supports."""
    seconds = days * 86400
    if max_seconds := aspsp.get("maximum_consent_validity"):
        seconds = min(seconds, max_seconds)
    return datetime.now(UTC) + timedelta(seconds=seconds)


def session_record(session: dict[str, Any]) -> dict[str, Any]:
    """The parts of a POST /sessions response worth keeping."""
    return {
        "session_id": session["session_id"],
        "aspsp": session["aspsp"],
        "valid_until": session["access"]["valid_until"],
        "created_at": datetime.now(UTC).isoformat(),
        "accounts": [
            {
                "uid": account["uid"],
                "name": account.get("name"),
                "product": account.get("product"),
                "iban": (account.get("account_id") or {}).get("iban"),
                "currency": account.get("currency"),
                "cash_account_type": account.get("cash_account_type"),
                "identifiers": account_identifiers(account),
            }
            for account in session["accounts"]
        ],
    }


def account_identifiers(account: dict[str, Any]) -> list[str]:
    """All account numbers the bank reports for an account (used to recognise transfers between your accounts)."""
    account_id = account.get("account_id") or {}
    candidates = [account_id.get("iban"), (account_id.get("other") or {}).get("identification")]
    for identification in account.get("all_account_ids") or []:
        candidates += [identification.get("identification"), identification.get("iban")]
    return sorted({c for c in candidates if c})

