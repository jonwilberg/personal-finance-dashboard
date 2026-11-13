"""The front page: one month's key figures, its spending against the median month, and what changed.

Money is counted by the kind of category a transaction has:
- spending:      expense categories (refunds count as negative spending), plus uncategorized money going out
- income:        income categories
- saved:         saving categories, net of withdrawals
- loan payments: loan categories
Transfers between your own accounts are left out.

The median month is the median of the previous 12 months that have data, so a single holiday or one-off month doesn't
move it much.
"""

from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import date
from decimal import Decimal
from statistics import median
from typing import Any

from finance.categories import Category

HISTORY_MONTHS = 12
# Fewer previous months than this and there's no meaningful "usual" to compare with.
MIN_MONTHS_FOR_USUAL = 3
# Spending within this share of the usual month counts as "about as usual".
AS_USUAL_SHARE = 0.05
TOP_CHANGES = 5
# A category is named in the headline only if it explains at least this share of the difference from usual.
DRIVER_SHARE = 0.3
UNCATEGORIZED = "uncategorized"


def build_overview(
    transactions: list[dict[str, Any]],
    categories: list[Category],
    month: str | None = None,
    today: date | None = None,
) -> dict[str, Any]:
    today = today or date.today()
    by_id = {c.id: c for c in categories}
    totals = _monthly_totals(transactions, by_id)
    data_months = sorted(totals)
    current = _month_key(today)

    if not data_months:
        return {"month": None, "months": [], "is_partial": False, "headline": "No transactions yet", "series": []}

    if month not in totals:
        # Default to the last complete month; a month in progress always looks cheap.
        complete = [m for m in data_months if m < current]
        month = complete[-1] if complete else data_months[-1]

    first = data_months[0]
    previous = [m for m in _months_before(month, HISTORY_MONTHS) if m >= first]
    this = totals.get(month, _empty())
    usual = _usual(totals, previous)

    spent = this["fixed"] + this["adjustable"] + this["uncategorized"]
    changes = _changes(this, usual, by_id) if usual else []
    shown = [m for m in [*reversed(_months_before(month, HISTORY_MONTHS - 1)), month] if m >= first]
    return {
        "month": month,
        "month_label": _month_label(month),
        "months": data_months,
        "is_partial": month == current,
        "headline": _headline(month, spent, usual, changes, month == current),
        "figures": {
            "spent": _money(spent),
            "fixed": _money(this["fixed"]),
            "adjustable": _money(this["adjustable"]),
            "uncategorized": _money(this["uncategorized"]),
            "income": _money(this["income"]),
            "saved": _money(this["saved"]),
            "loans": _money(this["loans"]),
            "savings_rate": float(this["saved"] / this["income"]) if this["income"] > 0 else None,
            "usual_spent": _money(usual["spent"]) if usual else None,
        },
        "usual_months": len(previous) if usual else 0,
        "series": [
            {
                "month": m,
                "label": _month_label(m, short=True),
                "fixed": _money(totals.get(m, _empty())["fixed"]),
                "adjustable": _money(totals.get(m, _empty())["adjustable"]),
                "uncategorized": _money(totals.get(m, _empty())["uncategorized"]),
                "income": _money(totals.get(m, _empty())["income"]),
            }
            for m in shown
        ],
        "changes": changes,
        "scoreboard": _scoreboard(totals, shown, this, usual, spent, categories),
    }


def _monthly_totals(transactions: list[dict[str, Any]], by_id: dict[str, Category]) -> dict[str, dict[str, Any]]:
    totals: dict[str, dict[str, Any]] = defaultdict(_empty)
    for t in transactions:
        if not t["date"]:
            continue
        month = t["date"][:7]
        amount: Decimal = t["amount"]
        category = by_id.get(t["category"]) if t["category"] else None
        bucket = totals[month]
        if category is None:
            if t["direction"] == "DBIT":
                bucket["uncategorized"] -= amount
                bucket["by_category"][UNCATEGORIZED] -= amount
        elif category.kind == "expense":
            bucket["fixed" if category.fixed else "adjustable"] -= amount
            bucket["by_category"][category.id] -= amount
        elif category.kind == "income":
            bucket["income"] += amount
        elif category.kind == "saving":
            bucket["saved"] -= amount
        elif category.kind == "loan":
            bucket["loans"] -= amount
    return totals


def _empty() -> dict[str, Any]:
    return {
        "fixed": Decimal(),
        "adjustable": Decimal(),
        "uncategorized": Decimal(),
        "income": Decimal(),
        "saved": Decimal(),
        "loans": Decimal(),
        "by_category": defaultdict(Decimal),
    }


def _usual(totals: dict[str, dict[str, Any]], months: list[str]) -> dict[str, Any] | None:
    if len(months) < MIN_MONTHS_FOR_USUAL:
        return None
    rows = [totals.get(m, _empty()) for m in months]
    keys = {k for row in rows for k in row["by_category"]}
    return {
        "spent": Decimal(median(r["fixed"] + r["adjustable"] + r["uncategorized"] for r in rows)),
        "by_category": {k: Decimal(median(r["by_category"].get(k, Decimal()) for r in rows)) for k in keys},
    }


def _scoreboard(
    totals: dict[str, dict[str, Any]],
    months: list[str],
    this: dict[str, Any],
    usual: dict[str, Any] | None,
    spent: Decimal,
    categories: list[Category],
) -> list[dict[str, Any]]:
    """Every spending category with this month, the median month, the difference, and its monthly history (the
    months shown in the chart, up to and including this month) with their total."""
    rows = []
    entries = [(c.id, c.name, c.fixed) for c in categories if c.kind == "expense"]
    for key, name, fixed in [*entries, (UNCATEGORIZED, "Not categorized", False)]:
        history = [totals.get(m, _empty())["by_category"].get(key, Decimal()) for m in months]
        amount = this["by_category"].get(key, Decimal())
        median_month = usual["by_category"].get(key, Decimal()) if usual else None
        if not any(history) and not median_month:
            continue  # never used in the period shown
        rows.append(
            {
                "category": key,
                "name": name,
                "fixed": fixed,
                "amount": _money(amount),
                "share": float(amount / spent) if spent > 0 else None,
                "usual": _money(median_month) if median_month is not None else None,
                "delta": _money(amount - median_month) if median_month is not None else None,
                "history": [_money(v) for v in history],
                "ltm": _money(sum(history, Decimal())),
            }
        )
    rows.sort(key=lambda r: r["amount"], reverse=True)
    return rows


def _changes(this: dict[str, Any], usual: dict[str, Any], by_id: dict[str, Category]) -> list[dict[str, Any]]:
    keys = set(this["by_category"]) | set(usual["by_category"])
    rows = []
    for key in keys:
        amount = this["by_category"].get(key, Decimal())
        typical = usual["by_category"].get(key, Decimal())
        if amount == typical:
            continue
        category = by_id.get(key)
        rows.append(
            {
                "category": key,
                "name": category.name if category else "Not categorized",
                "fixed": bool(category and category.fixed),
                "amount": _money(amount),
                "usual": _money(typical),
                "delta": _money(amount - typical),
            }
        )
    rows.sort(key=lambda r: abs(r["delta"]), reverse=True)
    return rows[:TOP_CHANGES]


def _headline(month: str, spent: Decimal, usual: dict[str, Any] | None, changes: list[dict[str, Any]], partial: bool) -> str:
    name = _month_label(month, with_year=False)
    if partial:
        return f"So far in {name}, you've spent {_kr(spent)}"
    if not usual or usual["spent"] <= 0:
        return f"You spent {_kr(spent)} in {name}"
    share = float((spent - usual["spent"]) / usual["spent"])
    if abs(share) < AS_USUAL_SHARE:
        return "Spending was about the same as in a median month"
    direction = "less" if share < 0 else "more"
    # Name a reason only when one change explains a good part of the difference.
    difference = float(spent - usual["spent"])
    driver = next((c for c in changes if (c["delta"] < 0) == (difference < 0)), None)
    reason = ""
    if driver and abs(driver["delta"]) >= DRIVER_SHARE * abs(difference):
        if driver["category"] == UNCATEGORIZED:
            reason = ", mostly in payments that aren't categorized yet"
        else:
            reason = f", mostly on {driver['name'].lower()}"
    return f"You spent {abs(share):.0%} {direction} than in a median month{reason}"


def _months_before(month: str, count: int) -> list[str]:
    """The `count` months before `month`, most recent first."""
    year, number = int(month[:4]), int(month[5:7])
    result = []
    for _ in range(count):
        year, number = (year - 1, 12) if number == 1 else (year, number - 1)
        result.append(f"{year:04d}-{number:02d}")
    return result


def _month_key(day: date) -> str:
    return f"{day.year:04d}-{day.month:02d}"


def _month_label(month: str, short: bool = False, with_year: bool = True) -> str:
    year, number = int(month[:4]), int(month[5:7])
    name = calendar.month_abbr[number] if short else calendar.month_name[number]
    return f"{name} {year}" if with_year and not short else name


def _money(value: Decimal) -> float:
    return round(float(value), 2)


def _kr(value: Decimal) -> str:
    # Non-breaking spaces so "kr 14 000" never wraps across lines.
    return "kr " + f"{round(value):,}".replace(",", " ")
