from datetime import date, timedelta
from decimal import Decimal

from finance.categories import Category
from finance.recurring import build_recurring

CATEGORIES = {
    c.id: c
    for c in [
        Category("subscriptions", "Subscriptions", "expense", group="other"),
        Category("insurance", "Insurance", "expense", fixed=True, group="fixed"),
        Category("electricity", "Electricity", "expense", fixed=True, group="fixed"),
        Category("transport", "Transport", "expense", group="other"),
        Category("transfer", "Transfers", "transfer", system=True),
        Category("loans", "Loan payments", "loan"),
    ]
}
TODAY = date(2026, 11, 20)
_ids = iter(range(10**6))


def pay(payee, amount, day, category="subscriptions", direction="DBIT"):
    """A payment of `amount` kr to `payee` on `day` (YYYY-MM-DD)."""
    return {
        "id": f"acc:{next(_ids)}",
        "date": day,
        "direction": direction,
        "merchant": payee,
        "amount": Decimal(str(-amount if direction == "DBIT" else amount)),
        "category": category,
        "description": payee.title(),
    }


def monthly(payee, amounts, first="2025-11-05", category="subscriptions"):
    """One payment a month from `first`, with the amounts given (None skips that month)."""
    start = date.fromisoformat(first)
    payments = []
    for i, amount in enumerate(amounts):
        year, month = divmod(start.month - 1 + i, 12)
        day = date(start.year + year, month + 1, start.day)
        if amount is not None:
            payments.append(pay(payee, amount, day.isoformat(), category))
    return payments


def recurring(transactions, month="2026-10", hidden=frozenset()):
    return build_recurring(transactions, CATEGORIES, month, set(hidden), TODAY)


def by_payee(result):
    return {i["payee"]: i for i in result["items"]}


def test_two_subscriptions_at_one_payee_are_one_line_with_both_amounts():
    transactions = monthly("FORSIKRING AS", [544] * 12, category="insurance") + monthly(
        "FORSIKRING AS", [1019] * 12, first="2025-11-20", category="insurance"
    )
    item = by_payee(recurring(transactions))["FORSIKRING AS"]
    assert item["amount"] == 1563
    assert [s["amount"] for s in item["series"]] == [1019, 544]
    assert len(item["payments"]) == 2
    assert (item["status"], item["group"]) == ("paid", "fixed")


def test_a_bill_that_changes_every_month_is_recurring_but_never_changed():
    amounts = [900, 1400, 2100, 1800, 1200, 700, 450, 400, 500, 650, 1100, 811]
    item = by_payee(recurring(monthly("STROM AS", amounts, category="electricity")))["STROM AS"]
    assert item["varies"] is True
    assert item["status"] == "paid"
    assert item["amount"] == 811


def test_a_price_that_drifts_with_the_exchange_rate_is_one_subscription():
    amounts = [114, 116, 118, 121, 125, 123, 119, 117, 115, 116, 118, 120]
    item = by_payee(recurring(monthly("LYDBOK UK", amounts)))["LYDBOK UK"]
    assert len(item["series"]) == 1 and item["status"] == "paid"


def test_a_new_price_is_a_change():
    item = by_payee(recurring(monthly("STREAMING", [99] * 11 + [129])))["STREAMING"]
    assert (item["status"], item["usual"], item["amount"]) == ("changed", 99, 129)


def test_tickets_bought_often_at_the_same_price_are_not_recurring():
    start = date(2025, 11, 1)
    tickets = [pay("BILLETTAPP", 41.4, (start + timedelta(days=d)).isoformat(), "transport") for d in range(0, 360, 2)]
    assert recurring(tickets)["items"] == []


def test_a_subscription_among_one_off_purchases_at_the_same_payee():
    subscription = monthly("APPBUTIKK", [None] * 9 + [129, 129, 129], first="2025-11-28")
    one_offs = [pay("APPBUTIKK", a, d) for a, d in [(49, "2026-08-03"), (49, "2026-08-21"), (110, "2026-09-08"), (49, "2026-10-02")]]
    item = by_payee(recurring(subscription + one_offs))["APPBUTIKK"]
    assert [s["amount"] for s in item["series"]] == [129]
    assert item["amount"] == 129  # this month's one-off purchase isn't counted


def test_a_new_payee_is_marked_new():
    item = by_payee(recurring(monthly("NYTT ABONNEMENT", [149, 149, 149], first="2026-08-10")))["NYTT ABONNEMENT"]
    assert item["status"] == "new"


def test_a_payee_that_stops_is_stopped_for_a_while_then_gone():
    transactions = monthly("GAMMELT ABONNEMENT", [199] * 8)  # last paid in June
    assert by_payee(recurring(transactions, month="2026-07"))["GAMMELT ABONNEMENT"]["status"] == "missed"
    assert by_payee(recurring(transactions, month="2026-08"))["GAMMELT ABONNEMENT"]["status"] == "stopped"
    assert by_payee(recurring(transactions, month="2026-09"))["GAMMELT ABONNEMENT"]["status"] == "stopped"
    assert "GAMMELT ABONNEMENT" not in by_payee(recurring(transactions, month="2026-10"))


def test_not_paid_yet_in_the_current_month_is_due():
    item = by_payee(recurring(monthly("HUSLEIE", [9000] * 12, first="2025-11-25"), month="2026-11"))["HUSLEIE"]
    assert item["status"] == "due"


def test_transfers_and_money_in_are_left_out():
    transactions = monthly("EGEN KONTO", [5000] * 12, category="transfer") + [
        pay("ARBEIDSGIVER", 40000, f"2026-{m:02d}-25", "subscriptions", direction="CRDT") for m in range(1, 11)
    ]
    assert recurring(transactions)["items"] == []


def test_a_payee_marked_not_recurring_is_listed_apart():
    transactions = monthly("KORTREGNING", [11000, 9000, 12000] * 4) + monthly("STREAMING", [99] * 12)
    result = recurring(transactions, hidden={"KORTREGNING"})
    assert list(by_payee(result)) == ["STREAMING"]
    assert result["hidden"] == [{"payee": "KORTREGNING", "amount": 12000}]
    assert result["total"] == 99
