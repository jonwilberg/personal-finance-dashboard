"""Accounts added by hand, such as a closed credit card copied from its statements.

They have no bank connection behind them: they're stored like a bank's accounts, but never refreshed. The file is
JSON:

    {
      "bank": "Example Bank",
      "country": "NO",
      "name": "Credit card",
      "card": true,
      "transactions": [
        {"date": "2026-01-04", "text": "SHOP, Main street 1", "amount": "-120.00"},
        {"date": "2026-01-12", "text": "HOTEL, Harbour road", "amount": "-1000.00", "details": "1 500,00 ZAR"},
        {"date": "2026-02-15", "text": "Payment", "amount": "1120.00", "payment": true}
      ]
    }

Amounts are negative for money out (purchases) and positive for money in (refunds, payments). `payment` marks a
payment of the card's bill, which is then matched with the payment leaving a bank account and counted as a transfer.
Adding the same bank and name again replaces the account's transactions.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

MANUAL_SESSION_PREFIX = "manual:"
NEVER_EXPIRES = "9999-12-31T00:00:00+00:00"
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class ManualAccountError(Exception):
    pass


@dataclass
class ManualAccount:
    bank: str
    country: str
    account: dict[str, Any]  # as a bank connection's account record
    transactions: list[dict[str, Any]]  # in the bank's (Enable Banking) format

    @property
    def session_id(self) -> str:
        return MANUAL_SESSION_PREFIX + self.account["uid"]

    def session_record(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "aspsp": {"name": self.bank, "country": self.country},
            "valid_until": NEVER_EXPIRES,
            "accounts": [self.account],
        }


def is_manual_session(session_id: str) -> bool:
    return session_id.startswith(MANUAL_SESSION_PREFIX)


def load_manual_account(path: Path) -> ManualAccount:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ManualAccountError(f"Can't read {path}: {error}") from error
    return manual_account(data)


def manual_account(data: dict[str, Any]) -> ManualAccount:
    bank = str(data.get("bank") or "").strip()
    name = str(data.get("name") or "").strip()
    if not bank or not name:
        raise ManualAccountError('The file needs a "bank" and a "name".')
    currency = str(data.get("currency") or "NOK")
    is_card = bool(data.get("card"))
    account = {
        "uid": f"manual-{_slug(bank)}-{_slug(name)}",
        "name": name,
        "product": name,
        "iban": None,
        "currency": currency,
        "cash_account_type": "CARD" if is_card else None,
        "identifiers": [],
    }
    rows = data.get("transactions") or []
    transactions = [_transaction(row, currency, number) for number, row in enumerate(rows, start=1)]
    return ManualAccount(bank, str(data.get("country") or "NO"), account, transactions)


def _transaction(row: dict[str, Any], currency: str, number: int) -> dict[str, Any]:
    day = str(row.get("date") or "")
    text = str(row.get("text") or "").strip()
    if not _DATE_RE.match(day) or not text:
        raise ManualAccountError(f'Transaction {number} needs a "date" (YYYY-MM-DD) and a "text".')
    try:
        amount = Decimal(str(row.get("amount")))
    except InvalidOperation as error:
        raise ManualAccountError(f'Transaction {number} has no valid "amount".') from error
    if amount == 0:
        raise ManualAccountError(f"Transaction {number} has an amount of 0.")
    is_debit = amount < 0
    raw: dict[str, Any] = {
        "transaction_amount": {"amount": str(abs(amount)), "currency": currency},
        "credit_debit_indicator": "DBIT" if is_debit else "CRDT",
        "status": "BOOK",
        "booking_date": day,
        "value_date": day,
        ("creditor" if is_debit else "debtor"): {"name": text},
    }
    if row.get("details"):
        raw["remittance_information"] = [str(row["details"])]
    if row.get("payment"):
        raw["bank_transaction_code"] = {"code": "INNBETALING", "description": "Payment"}
    return raw


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "account"
