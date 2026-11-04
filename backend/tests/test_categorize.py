from finance.categorize import (
    CategorizationSettings,
    Rule,
    categorized_transactions,
    clean_text,
    summarize_categorization,
)

SESSIONS = [
    {
        "aspsp": {"name": "Bank A", "country": "NO"},
        "accounts": [
            {"uid": "checking", "product": "Brukskonto", "iban": "NO9386011117947", "cash_account_type": "CACC"},
            {"uid": "savings", "product": "Sparekonto", "iban": "NO8330001234567", "cash_account_type": "SVGS"},
        ],
    },
    {
        "aspsp": {"name": "Card Bank", "country": "NO"},
        "accounts": [{"uid": "card", "product": "Kredittkort", "cash_account_type": "CARD"}],
    },
]


def tx(id, amount, direction, date="2026-10-01", text=None, creditor=None, counterparty_account=None, code=None, description=None):
    t = {
        "transaction_id": id,
        "transaction_amount": {"amount": amount, "currency": "NOK"},
        "credit_debit_indicator": direction,
        "status": "BOOK",
        "booking_date": date,
        "remittance_information": [text] if text else [],
    }
    if creditor:
        t["creditor"] = {"name": creditor}
    if counterparty_account:
        side = "creditor_account" if direction == "DBIT" else "debtor_account"
        t[side] = {"other": {"identification": counterparty_account}}
    if code or description:
        t["bank_transaction_code"] = {"code": code, "description": description}
    return t


def run(raw_by_account, settings=None):
    result = categorized_transactions(SESSIONS, raw_by_account, settings or CategorizationSettings())
    return {t["id"].split(":", 1)[1]: (t["category"], t["category_source"]) for t in result}


def test_clean_text_removes_varying_parts():
    assert clean_text("Varekjøp REMA 1000 MAJORSTUEN 12.10 kl 14:33 *1234 NOK 412,50") == "REMA 1000 MAJORSTUEN"
    assert clean_text("VISA 4567********1234 KIWI 123456789") == "KIWI"


def test_keywords_match_whole_words_only():
    result = run({"card": [tx("a", "120", "DBIT", creditor="MAX BURGERS AS"), tx("b", "99", "DBIT", creditor="MAXIMUM STORE")]})
    assert result["a"] == ("eating_out", "keyword")
    assert result["b"] == (None, None)


def test_bank_category_hint_used_when_no_keyword():
    result = run({"card": [tx("a", "250", "DBIT", creditor="SOME LOCAL SHOP", description="GROCERY STORES/SUPERMARKETS")]})
    assert result["a"] == ("groceries", "bank")


def test_transfer_by_own_account_number():
    # Checking pays the savings account's domestic number (the IBAN's last 11 digits).
    result = run({"checking": [tx("a", "5000", "DBIT", text="Til sparing", counterparty_account="30001234567")]})
    assert result["a"] == ("transfer", "transfer")


def test_card_payment_and_its_debit_are_transfers():
    result = run(
        {
            "card": [tx("pay", "3200", "CRDT", date="2026-10-05", code="PAYMENT")],
            "checking": [
                tx("bill", "3200", "DBIT", date="2026-10-02", text="Card Bank faktura"),
                tx("other", "3200", "DBIT", date="2026-09-01", text="Something else"),
            ],
        }
    )
    assert result["pay"] == ("transfer", "transfer")
    assert result["bill"] == ("transfer", "transfer")
    assert result["other"] == (None, None)


def test_matching_amounts_between_own_accounts_are_transfers():
    result = run(
        {
            "checking": [tx("out", "1000", "DBIT", date="2026-10-01", text="Overføring")],
            "savings": [tx("in", "1000", "CRDT", date="2026-10-02", text="Overføring")],
        }
    )
    assert result["out"] == ("transfer", "transfer")
    assert result["in"] == ("transfer", "transfer")


def test_income_keywords_only_for_money_in():
    result = run({"checking": [tx("in", "100", "CRDT", text="Renter"), tx("out", "50", "DBIT", text="Renter")]})
    assert result["in"] == ("other_income", "keyword")
    assert result["out"] == ("fees", "keyword")


def test_priority_manual_then_rule_then_keyword():
    raw = {"checking": [tx("a", "12000", "DBIT", text="OBOS husleie"), tx("b", "300", "DBIT", text="REMA 1000")]}
    settings = CategorizationSettings(rules=[Rule("obos", "bills")])
    assert run(raw, settings)["a"] == ("bills", "rule")
    settings.overrides["checking:a"] = "housing"
    assert run(raw, settings)["a"] == ("housing", "manual")
    assert run(raw, settings)["b"] == ("groceries", "keyword")


def test_longer_rules_win():
    raw = {"checking": [tx("a", "100", "DBIT", text="VIPPS*ANNA HANSEN")]}
    settings = CategorizationSettings(rules=[Rule("VIPPS", "shopping"), Rule("VIPPS*ANNA", "other_expense")])
    assert run(raw, settings)["a"] == ("other_expense", "rule")


def test_summary_reports_shares_without_texts():
    transactions = categorized_transactions(
        SESSIONS,
        {"checking": [tx("a", "100", "DBIT", text="REMA 1000"), tx("b", "300", "DBIT", text="Unknown payee")]},
        CategorizationSettings(),
    )
    summary = summarize_categorization(transactions)
    assert summary["count"] == 2
    assert summary["uncategorized"] == 1
    assert summary["uncategorized_spend_share"] == 0.75
    assert "REMA" not in str(summary)


def test_settings_round_trip():
    settings = CategorizationSettings(overrides={"x": "groceries"}, rules=[Rule("KIWI", "groceries")])
    assert CategorizationSettings.from_json(settings.to_json()) == settings


def test_transfers_to_unknown_accounts_are_grouped_by_account_number():
    raw = {
        "checking": [
            tx("a", "5000", "DBIT", text="Til: 1234.56.78901 Betalt: 01.10.26", counterparty_account="12345678901"),
            tx("b", "200", "DBIT", text="Til: 9876.54.32109 Betalt: 02.10.26", counterparty_account="98765432109"),
        ]
    }
    result = categorized_transactions(SESSIONS, raw, CategorizationSettings(rules=[Rule("KONTO 12345678901", "housing")]))
    by_id = {t["id"].split(":", 1)[1]: t for t in result}
    assert by_id["a"]["merchant"] == "KONTO 12345678901"
    assert (by_id["a"]["category"], by_id["a"]["category_source"]) == ("housing", "rule")
    assert by_id["b"]["merchant"] == "KONTO 98765432109"
    assert by_id["b"]["category"] is None


def test_named_payees_keep_their_name_as_merchant():
    raw = {"checking": [tx("a", "300", "DBIT", creditor="Rema 1000 Majorstuen", counterparty_account="12345678901")]}
    [t] = categorized_transactions(SESSIONS, raw, CategorizationSettings())
    assert t["merchant"] == "REMA 1000 MAJORSTUEN"


def test_payee_taken_from_first_line_that_names_one():
    raw = {
        "checking": [
            {
                **tx("a", "1500.00", "DBIT", counterparty_account="11112233334"),
                "remittance_information": ["123456789012", "Til: KORTSELSKAP FINANS AS Betalt: 30.10.26"],
            },
            {
                **tx("b", "1200.00", "DBIT", counterparty_account="11112233334"),
                "remittance_information": ["123456789012", "Til: Kortselskap Finans AS Betalt: 25.04.26"],
            },
        ]
    }
    result = categorized_transactions(SESSIONS, raw, CategorizationSettings(rules=[Rule("KORTSELSKAP FINANS AS", "other_expense")]))
    assert {t["merchant"] for t in result} == {"KORTSELSKAP FINANS AS"}
    assert {t["category"] for t in result} == {"other_expense"}


def test_savings_are_not_spending():
    raw = {
        "checking": [
            tx("a", "100", "DBIT", text="REMA 1000"),
            tx("b", "5000", "DBIT", text="Nordnet Bank AB"),
            tx("c", "300", "DBIT", text="Unknown payee"),
        ]
    }
    transactions = categorized_transactions(SESSIONS, raw, CategorizationSettings())
    assert {t["id"].split(":", 1)[1]: t["category"] for t in transactions}["b"] == "savings"
    # 300 of 400 spent is uncategorized; the 5000 put into savings doesn't count as spending.
    assert summarize_categorization(transactions)["uncategorized_spend_share"] == 0.75
