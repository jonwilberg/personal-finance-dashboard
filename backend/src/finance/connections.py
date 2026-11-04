"""Bank connections: helpers for the Enable Banking consent flow and the local files that store its results."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
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
                "identifiers": _account_identifiers(account),
            }
            for account in session["accounts"]
        ],
    }


def _account_identifiers(account: dict[str, Any]) -> list[str]:
    """All account numbers the bank reports for an account (used to recognise transfers between your accounts)."""
    account_id = account.get("account_id") or {}
    candidates = [account_id.get("iban"), (account_id.get("other") or {}).get("identification")]
    for identification in account.get("all_account_ids") or []:
        candidates += [identification.get("identification"), identification.get("iban")]
    return sorted({c for c in candidates if c})


class ConnectionStore:
    """Sessions, balances and raw transactions stored as JSON files under the data folder."""

    def __init__(self, data_dir: Path):
        self.data_dir = data_dir

    @property
    def _sessions_path(self) -> Path:
        return self.data_dir / "sessions.json"

    def sessions(self) -> list[dict[str, Any]]:
        return _read_json(self._sessions_path, default=[])

    def add_session(self, record: dict[str, Any]) -> None:
        others = [s for s in self.sessions() if s["session_id"] != record["session_id"]]
        _write_json(self._sessions_path, [*others, record])

    def remove_session(self, session_id: str) -> None:
        _write_json(self._sessions_path, [s for s in self.sessions() if s["session_id"] != session_id])

    def has_account(self, account_uid: str) -> bool:
        return any(a["uid"] == account_uid for s in self.sessions() for a in s["accounts"])

    def save_transactions(self, account_uid: str, transactions: list[dict[str, Any]]) -> Path:
        path = self._transactions_path(account_uid)
        _write_json(path, transactions)
        return path

    def load_transactions(self, account_uid: str) -> list[dict[str, Any]] | None:
        return _read_json(self._transactions_path(account_uid), default=None)

    def transactions_fetched_at(self, account_uid: str) -> str | None:
        path = self._transactions_path(account_uid)
        return datetime.fromtimestamp(path.stat().st_mtime, UTC).isoformat() if path.exists() else None

    def save_balances(self, account_uid: str, balances: list[dict[str, Any]]) -> None:
        all_balances = _read_json(self._balances_path, default={})
        all_balances[account_uid] = {"fetched_at": datetime.now(UTC).isoformat(), "balances": balances}
        _write_json(self._balances_path, all_balances)

    def load_balances(self, account_uid: str) -> dict[str, Any] | None:
        return _read_json(self._balances_path, default={}).get(account_uid)

    def load_categorization(self) -> dict[str, Any]:
        return _read_json(self.data_dir / "categorization.json", default={"overrides": {}, "rules": []})

    def save_categorization(self, data: dict[str, Any]) -> None:
        _write_json(self.data_dir / "categorization.json", data)

    def raw_transactions_by_account(self) -> dict[str, list[dict[str, Any]]]:
        return {
            account["uid"]: self.load_transactions(account["uid"]) or []
            for session in self.sessions()
            for account in session["accounts"]
        }

    @property
    def _balances_path(self) -> Path:
        return self.data_dir / "balances.json"

    def _transactions_path(self, account_uid: str) -> Path:
        return self.data_dir / "transactions" / f"{account_uid}.json"


def _read_json(path: Path, default: Any) -> Any:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
