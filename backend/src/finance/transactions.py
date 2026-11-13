"""Helpers for reading Enable Banking transaction objects."""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from datetime import date, timedelta
from decimal import Decimal
from typing import Any


def transaction_key(transaction: dict[str, Any]) -> str:
    """Stable identity of a transaction within its account, for de-duplication and remembering choices.

    The bank's transaction_id when there is one. entry_reference is not unique at every bank (the sandbox reuses
    a handful of values), so it is combined with date, amount and direction. Otherwise a hash of the content.
    """
    if transaction.get("transaction_id"):
        return str(transaction["transaction_id"])
    if transaction.get("entry_reference"):
        amount = (transaction.get("transaction_amount") or {}).get("amount", "")
        parts = [transaction["entry_reference"], transaction_date(transaction), amount, transaction.get("credit_debit_indicator") or ""]
        return "|".join(str(p) for p in parts)
    content = json.dumps(transaction, sort_keys=True, ensure_ascii=False).encode()
    return "h:" + hashlib.sha256(content).hexdigest()[:20]


def unique_transaction_keys(transactions: list[dict[str, Any]]) -> list[str]:
    """Keys for one account's transactions, numbering repeats (#2, #3) so no transaction is merged away."""
    seen: Counter[str] = Counter()
    keys = []
    for transaction in transactions:
        key = transaction_key(transaction)
        seen[key] += 1
        keys.append(key if seen[key] == 1 else f"{key}#{seen[key]}")
    return keys


def signed_amount(transaction: dict[str, Any]) -> Decimal:
    amount = Decimal(transaction["transaction_amount"]["amount"])
    return -abs(amount) if transaction.get("credit_debit_indicator") == "DBIT" else abs(amount)


def transaction_date(transaction: dict[str, Any]) -> str:
    """The booking date (or the best the bank gave): how stored transactions are ordered and replaced."""
    return transaction.get("booking_date") or transaction.get("transaction_date") or transaction.get("value_date") or ""


# "Betalt: 28.02.26" in a payment's text: the day it was paid, which the bank may book on the next weekday.
_PAID_RE = re.compile(r"\bBetalt:?\s*(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})\b", re.IGNORECASE)
# Earlier dates further back than this aren't trusted as the day the money moved.
_MAX_DAYS_BEFORE_BOOKING = 31


def payment_date(transaction: dict[str, Any]) -> str:
    """The day the money moved, which is the date transactions are counted by.

    The earliest of the booking date, the bank's transaction date (a card purchase's day), an earlier value date
    and a payment date in the text ("Betalt: 28.02.26"), within a month before booking. Banks book a payment made
    on a Saturday on the next weekday, so a bill paid on the last day of a month would otherwise count in the next.
    Later dates are ignored: on some cards the value date is the bill's due date.
    """
    booked = transaction_date(transaction)
    try:
        booked_day = date.fromisoformat(booked)
    except ValueError:
        return booked
    candidates = [booked_day]
    for key in ("transaction_date", "value_date"):
        try:
            candidates.append(date.fromisoformat(transaction.get(key) or ""))
        except ValueError:
            pass
    for line in transaction.get("remittance_information") or []:
        for day, month, year in _PAID_RE.findall(line or ""):
            try:
                candidates.append(date(int(year) + (2000 if len(year) == 2 else 0), int(month), int(day)))
            except ValueError:
                pass
    earliest = booked_day - timedelta(days=_MAX_DAYS_BEFORE_BOOKING)
    return min(d for d in candidates if earliest <= d <= booked_day).isoformat()


def description(transaction: dict[str, Any]) -> str:
    is_debit = transaction.get("credit_debit_indicator") == "DBIT"
    counterparty = transaction.get("creditor") if is_debit else transaction.get("debtor")
    parts = [(counterparty or {}).get("name"), *(transaction.get("remittance_information") or [])]
    # Banks often repeat the counterparty name in the remittance text; show each part once.
    return " | ".join(dict.fromkeys(p.strip() for p in parts if p and p.strip()))


def summarize(transactions: list[dict[str, Any]]) -> dict[str, Any]:
    dates = sorted(d for t in transactions if (d := transaction_date(t)))
    return {
        "count": len(transactions),
        "first_date": dates[0] if dates else None,
        "last_date": dates[-1] if dates else None,
    }


def inspect(transactions: list[dict[str, Any]]) -> dict[str, Any]:
    """Describe which fields are filled in, without exposing amounts, names or texts."""
    return summarize(transactions) | {
        "statuses": value_counts(transactions, "status"),
        "directions": value_counts(transactions, "credit_debit_indicator"),
        "currencies": value_counts(transactions, "transaction_amount.currency"),
        "coverage": [{"field": f, "share": s} for f, s in field_coverage(transactions)],
    }


def value_counts(transactions: list[dict[str, Any]], path: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for transaction in transactions:
        value = str(_field(transaction, path) or "(missing)")
        counts[value] = counts.get(value, 0) + 1
    return dict(sorted(counts.items(), key=lambda item: -item[1]))


def field_coverage(transactions: list[dict[str, Any]]) -> list[tuple[str, float]]:
    """Share of transactions with a non-empty value for every (nested) field path, most common first."""
    counts: dict[str, int] = {}
    for transaction in transactions:
        for path in _filled_paths(transaction):
            counts[path] = counts.get(path, 0) + 1
    return sorted(((p, n / len(transactions)) for p, n in counts.items()), key=lambda item: (-item[1], item[0]))


def _filled_paths(value: Any, prefix: str = "") -> set[str]:
    if isinstance(value, dict):
        return {p for key, child in value.items() for p in _filled_paths(child, f"{prefix}.{key}" if prefix else key)}
    if value in (None, "", [], {}):
        return set()
    return {prefix}


def _field(transaction: dict[str, Any], path: str) -> Any:
    value: Any = transaction
    for key in path.split("."):
        value = (value or {}).get(key)
    return value
