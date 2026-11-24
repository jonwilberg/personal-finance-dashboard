"""Recurring payments: money going out to the same payee about once a month, such as rent, subscriptions, insurance
and power. The overview lists them for the selected month.

A payee paid about once a month, in at least three months, is recurring whatever the amounts: power, a card bill, a
subscription that changed plan. Otherwise its payments are split into series. A payment continues a series when it
comes about a month after the series' last payment (or two, when a month was skipped) and is within 10 % of it, so a
price can drift with exchange rates, and two subscriptions at one payee (two insurance policies) are two series. A
series paid in at least three months is recurring, unless the same amounts are also paid at other times while it runs
(tickets, a bakery): that's everyday spending that happens to repeat.

Payees are matched by the name the transactions page groups by, so a payee that changes its name shows up as one that
stopped and one that's new. Payees you mark as not recurring are left out (and listed, to bring back).
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal
from statistics import median
from typing import Any

from finance.categories import Category, spending_group

WINDOW_MONTHS = 12  # the selected month and the 11 before it
MIN_PAYMENTS = 3
MONTH_GAP = range(20, 41)  # days between two monthly payments; dates shift with weekends and month ends
SKIPPED_MONTH_GAP = range(50, 71)
DRIFT = Decimal("0.10")  # how much a payment may differ from the one before it in the same series
SAME_AMOUNT = Decimal("0.02")  # payments this close to a series' amount are "the same amount"
REGULAR_SHARE = 0.6  # payees whose amount varies: this share of the gaps between payments must be about a month
MAX_PER_MONTH = 1.3  # ...with about one payment a month
NEW_MONTHS = 3  # a payee first paid within this many months (the selected one included) is new
CHANGED_SHARE = Decimal("0.10")  # this month's amount differs this much from its median month: changed
STOPPED_AFTER_MONTHS = 2  # no payment in this many months: stopped
SHOW_STOPPED_MONTHS = 3  # a stopped payee is listed for this many months after its last payment


def build_recurring(
    transactions: list[dict[str, Any]],
    by_id: dict[str, Category],
    month: str,
    hidden: set[str],
    today: date,
) -> dict[str, Any]:
    """The recurring payments for `month` (YYYY-MM), counting the transactions given (the overview's, already
    limited to the chosen owners' accounts)."""
    months = _window(month)
    outgoing = [t for t in transactions if _is_payment(t, by_id) and t["date"][:7] <= month]
    first_paid: dict[str, str] = {}
    by_payee: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for t in outgoing:
        payee = t["merchant"]
        first_paid[payee] = min(first_paid.get(payee, t["date"]), t["date"])
        if t["date"][:7] >= months[0]:
            by_payee[payee].append(t)

    items, hidden_items = [], []
    for payee, payments in by_payee.items():
        series = recurring_series(payments)
        if not series:
            continue
        item = _item(payee, series, months, first_paid[payee], by_id, today)
        if item is None:
            continue
        (hidden_items if payee in hidden else items).append(item)

    items.sort(key=lambda i: (i["amount"], i["usual"] or 0), reverse=True)
    hidden_items.sort(key=lambda i: i["payee"])
    return {
        "months": months,
        "items": items,
        "total": sum(i["amount"] for i in items),
        "hidden": [{"payee": i["payee"], "amount": i["amount"]} for i in hidden_items],
    }


def recurring_series(payments: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """One payee's payments split into the series that recur, oldest payment first in each; [] if none do."""
    payments = sorted(payments, key=lambda t: (t["date"], t["id"]))
    if _about_monthly(payments):
        # About one payment a month: one series whatever the amounts, so a bill that changes every month (power, a
        # card bill) or a subscription that changed plan stays in one piece.
        return [payments]
    chains: list[list[dict[str, Any]]] = []
    for t in payments:
        fits = [chain for chain in chains if _follows(chain[-1], t)]
        if fits:
            min(fits, key=lambda chain: abs(_paid(chain[-1]) - _paid(t))).append(t)
        else:
            chains.append([t])
    return [
        chain
        for chain in chains
        if len({t["date"][:7] for t in chain}) >= MIN_PAYMENTS and not _everyday(chain, payments)
    ]


def _item(
    payee: str,
    series: list[list[dict[str, Any]]],
    months: list[str],
    first_paid: str,
    by_id: dict[str, Category],
    today: date,
) -> dict[str, Any] | None:
    month = months[-1]
    members = sorted((t for s in series for t in s), key=lambda t: t["date"])
    by_month: dict[str, Decimal] = defaultdict(Decimal)
    for t in members:
        by_month[t["date"][:7]] += _paid(t)
    amount = by_month.get(month, Decimal())
    earlier = [by_month[m] for m in months[:-1] if m in by_month]
    usual = Decimal(median(earlier)) if earlier else None
    last = members[-1]
    paid_months = [by_month[m] for m in months if m in by_month]
    # An amount that changes most months (power): a change this month is nothing new.
    varies = sum(abs(b - a) > CHANGED_SHARE * a for a, b in zip(paid_months, paid_months[1:])) > (len(paid_months) - 1) / 2
    since_last = _months_between(last["date"][:7], month)

    if amount > 0:
        if first_paid[:7] >= months[-NEW_MONTHS]:
            status = "new"
        elif usual and not varies and abs(amount - usual) > CHANGED_SHARE * usual:
            status = "changed"
        else:
            status = "paid"
    elif since_last > SHOW_STOPPED_MONTHS:
        return None  # stopped a while ago: no longer news
    elif since_last >= STOPPED_AFTER_MONTHS:
        status = "stopped"
    elif month == f"{today.year:04d}-{today.month:02d}":
        status = "due"  # the month is still going
    else:
        status = "missed"

    category = by_id.get(last["category"]) if last["category"] else None
    return {
        "payee": payee,
        "category": category.id if category else None,
        "category_name": category.name if category else "Not categorized",
        "kind": category.kind if category else "expense",
        "group": spending_group(category) if category is None or category.kind == "expense" else None,
        "amount": _money(amount),
        "usual": _money(usual) if usual is not None else None,
        "status": status,
        "varies": varies,
        # The day of the month it was last paid, for when to expect it.
        "day": int(last["date"][8:10]),
        "history": [_money(by_month.get(m, Decimal())) for m in months],
        # Each subscription at this payee: its usual amount and how many times it was paid in the window.
        "series": _subscriptions(series),
        "payments": [
            {"id": t["id"], "date": t["date"], "amount": _money(_paid(t)), "description": t["description"]}
            for t in members
            if t["date"][:7] == month
        ],
    }


def _subscriptions(series: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """The series as amounts and payment counts, largest first. Series of the same amount are one subscription that
    paused for a while and came back."""
    counts: dict[float, int] = defaultdict(int)
    for s in series:
        counts[_money(Decimal(median(_paid(t) for t in s)))] += len(s)
    return [{"amount": amount, "payments": counts[amount]} for amount in sorted(counts, reverse=True)]


def _is_payment(t: dict[str, Any], by_id: dict[str, Category]) -> bool:
    """Money going out to a payee: not a transfer between your own accounts, and not a refund."""
    if not t["date"] or t["direction"] != "DBIT" or not t.get("merchant"):
        return False
    category = by_id.get(t["category"]) if t["category"] else None
    return category is None or category.kind not in ("transfer", "income")


def _follows(previous: dict[str, Any], t: dict[str, Any]) -> bool:
    """True when `t` can be the next payment after `previous` in a series: about a month later, about the same."""
    gap = (date.fromisoformat(t["date"]) - date.fromisoformat(previous["date"])).days
    before = _paid(previous)
    return (gap in MONTH_GAP or gap in SKIPPED_MONTH_GAP) and abs(_paid(t) - before) <= DRIFT * before


def _everyday(chain: list[dict[str, Any]], payments: list[dict[str, Any]]) -> bool:
    """True when the series' amounts are also paid often outside it while it runs: a ticket or a coffee that costs
    the same each time, which a monthly series can be picked out of by chance."""
    amounts = {_paid(t) for t in chain}
    ids = {t["id"] for t in chain}
    start, end = chain[0]["date"], chain[-1]["date"]
    others = sum(
        1
        for t in payments
        if t["id"] not in ids
        and start <= t["date"] <= end
        and any(abs(_paid(t) - a) <= SAME_AMOUNT * a for a in amounts)
    )
    return others > len(chain) / 2


def _about_monthly(payments: list[dict[str, Any]]) -> bool:
    """True when the payments, whatever their amounts, come about once a month."""
    months = {t["date"][:7] for t in payments}
    if len(months) < MIN_PAYMENTS or len(payments) > MAX_PER_MONTH * len(months):
        return False
    days = [date.fromisoformat(t["date"]) for t in payments]
    gaps = [(b - a).days for a, b in zip(days, days[1:])]
    monthly = sum(1 for g in gaps if g in MONTH_GAP or g in SKIPPED_MONTH_GAP)
    return monthly >= REGULAR_SHARE * len(gaps)


def _paid(t: dict[str, Any]) -> Decimal:
    return -t["amount"]  # money out is negative


def _window(month: str) -> list[str]:
    """The WINDOW_MONTHS months up to and including `month`, oldest first."""
    year, number = int(month[:4]), int(month[5:7])
    months = []
    for _ in range(WINDOW_MONTHS):
        months.append(f"{year:04d}-{number:02d}")
        year, number = (year - 1, 12) if number == 1 else (year, number - 1)
    return months[::-1]


def _months_between(earlier: str, later: str) -> int:
    return (int(later[:4]) - int(earlier[:4])) * 12 + int(later[5:7]) - int(earlier[5:7])


def _money(value: Decimal) -> float:
    return round(float(value), 2)
