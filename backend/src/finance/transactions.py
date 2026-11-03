"""Helpers for reading Enable Banking transaction objects."""

from __future__ import annotations

from decimal import Decimal
from typing import Any


def signed_amount(transaction: dict[str, Any]) -> Decimal:
    amount = Decimal(transaction["transaction_amount"]["amount"])
    return -abs(amount) if transaction.get("credit_debit_indicator") == "DBIT" else abs(amount)


def transaction_date(transaction: dict[str, Any]) -> str:
    return transaction.get("booking_date") or transaction.get("transaction_date") or transaction.get("value_date") or ""


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
