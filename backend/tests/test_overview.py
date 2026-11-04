from datetime import date
from decimal import Decimal

from finance.categories import DEFAULT_CATEGORIES
from finance.overview import build_overview

KINDS = {c.id: c.kind for c in DEFAULT_CATEGORIES}


def t(day, amount, category):
    """A categorized transaction as categorized_transactions returns it (only the fields the overview uses)."""
    value = Decimal(amount)
    return {
        "date": day,
        "amount": value,
        "direction": "DBIT" if value < 0 else "CRDT",
        "category": category,
        "kind": KINDS.get(category),
    }


def months_of(month, transactions):
    return [{**x, "date": f"{month}-{x['date']}"} for x in transactions]


TYPICAL = [t("01", "-10000", "housing"), t("05", "-3000", "groceries"), t("10", "-1000", "eating_out"),
           t("25", "40000", "salary"), t("26", "-5000", "savings"), t("27", "-2500", "loans")]


def history():
    data = []
    for month in ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]:
        data += months_of(month, TYPICAL)
    # October: much less eating out, a refund at the grocer, and an uncategorized payment.
    data += months_of("2026-10", [t("01", "-10000", "housing"), t("05", "-3000", "groceries"), t("07", "200", "groceries"),
                                  t("25", "40000", "salary"), t("26", "-5000", "savings"), t("27", "-2500", "loans"),
                                  t("28", "-300", None)])
    data += months_of("2026-11", [t("02", "-500", "groceries")])
    return data


def test_defaults_to_last_complete_month():
    result = build_overview(history(), DEFAULT_CATEGORIES, today=date(2026, 11, 4))
    assert result["month"] == "2026-10"
    assert result["is_partial"] is False
    assert result["months"] == ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]


def test_figures_count_each_kind_once():
    figures = build_overview(history(), DEFAULT_CATEGORIES, today=date(2026, 11, 4))["figures"]
    assert figures["fixed"] == 10000
    assert figures["adjustable"] == 2800  # groceries net of the refund; no eating out this month
    assert figures["uncategorized"] == 300
    assert figures["spent"] == 13100
    assert figures["income"] == 40000
    assert figures["saved"] == 5000
    assert figures["loans"] == 2500
    assert figures["savings_rate"] == 0.125
    assert figures["usual_spent"] == 14000


def test_headline_and_changes_compare_with_usual():
    result = build_overview(history(), DEFAULT_CATEGORIES, today=date(2026, 11, 4))
    assert result["headline"] == "You spent 6% less than in a median month, mostly on eating out"
    first = result["changes"][0]
    assert (first["category"], first["amount"], first["usual"], first["delta"]) == ("eating_out", 0, 1000, -1000)
    assert {c["category"] for c in result["changes"]} == {"eating_out", "uncategorized", "groceries"}


def test_series_ends_at_selected_month_and_starts_at_first_data():
    series = build_overview(history(), DEFAULT_CATEGORIES, today=date(2026, 11, 4))["series"]
    assert [s["month"] for s in series] == ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]
    assert series[-1] | {"fixed": 10000.0, "adjustable": 2800.0, "uncategorized": 300.0} == series[-1]


def test_partial_month_and_too_little_history():
    current = build_overview(history(), DEFAULT_CATEGORIES, month="2026-11", today=date(2026, 11, 4))
    assert current["is_partial"] and current["headline"] == "So far in November, you've spent kr\u00a0500"
    early = build_overview(history(), DEFAULT_CATEGORIES, month="2026-06", today=date(2026, 11, 4))
    assert early["figures"]["usual_spent"] is None
    assert early["headline"] == "You spent kr\u00a014\u00a0000 in June"
    assert early["changes"] == []


def test_as_usual_and_no_data():
    data = []
    for month in ["2026-05", "2026-06", "2026-07", "2026-08"]:
        data += months_of(month, TYPICAL)
    result = build_overview(data, DEFAULT_CATEGORIES, today=date(2026, 11, 4))
    assert result["headline"] == "Spending was about the same as in a median month"
    assert build_overview([], DEFAULT_CATEGORIES)["headline"] == "No transactions yet"


def test_headline_names_uncategorized_or_nothing_when_no_category_explains_it():
    data = []
    for month in ["2026-05", "2026-06", "2026-07", "2026-08"]:
        data += months_of(month, TYPICAL)
    # September: a big uncategorized payment and a little more groceries.
    data += months_of("2026-09", [*TYPICAL, t("12", "-20000", None), t("13", "-300", "groceries")])
    assert build_overview(data, DEFAULT_CATEGORIES, today=date(2026, 11, 4))["headline"] == (
        "You spent 145% more than in a median month, mostly in payments that aren't categorized yet"
    )
    # October: spread over several categories, none explaining 30% of it.
    spread = [t("01", "-10000", "housing"), t("02", "-1000", "transport"), t("03", "-1000", "leisure"),
              t("04", "-1000", "clothing"), t("05", "-1000", "home"), t("06", "-3000", "groceries"),
              t("07", "-1000", "eating_out"), t("08", "-1000", "travel")]
    data += months_of("2026-10", spread)
    assert build_overview(data, DEFAULT_CATEGORIES, today=date(2026, 11, 4))["headline"] == (
        "You spent 36% more than in a median month"
    )


def test_scoreboard_lists_spending_categories_with_history():
    board = build_overview(history(), DEFAULT_CATEGORIES, today=date(2026, 11, 4))["scoreboard"]
    assert [r["category"] for r in board] == ["housing", "groceries", "uncategorized", "eating_out"]
    housing, groceries, uncategorized, eating_out = board
    assert housing["fixed"] is True and housing["delta"] == 0
    assert (groceries["amount"], groceries["usual"], groceries["delta"]) == (2800, 3000, -200)
    assert groceries["history"] == [3000, 3000, 3000, 3000, 3000, 2800]
    assert round(groceries["share"], 3) == round(2800 / 13100, 3)
    assert (uncategorized["name"], uncategorized["delta"]) == ("Not categorized", 300)
    assert (eating_out["amount"], eating_out["usual"]) == (0, 1000)
    # Savings, loans and income aren't spending, and unused categories are left out.
    assert not {"savings", "loans", "salary", "transport"} & {r["category"] for r in board}


def test_scoreboard_without_enough_history_has_no_median():
    board = build_overview(history(), DEFAULT_CATEGORIES, month="2026-06", today=date(2026, 11, 4))["scoreboard"]
    assert all(r["usual"] is None and r["delta"] is None for r in board)
