import json

import pytest

from finance.categorize import Rule
from finance.storage import CategoryError, Storage

SESSION = {
    "session_id": "s1",
    "aspsp": {"name": "Bank A", "country": "NO"},
    "valid_until": "2027-05-01T00:00:00Z",
    "created_at": "2026-11-01T00:00:00+00:00",
    "accounts": [
        {"uid": "acc-1", "name": "Jon", "product": "Brukskonto", "iban": "NO9386011117947", "currency": "NOK",
         "cash_account_type": "CACC", "identifiers": ["NO9386011117947"]},
        {"uid": "acc-2", "name": "Jon", "currency": "NOK", "cash_account_type": "CARD"},
    ],
}
TRANSACTIONS = [
    {"transaction_id": "t2", "booking_date": "2026-10-02", "transaction_amount": {"amount": "5", "currency": "NOK"}},
    {"transaction_id": "t1", "booking_date": "2026-10-01", "transaction_amount": {"amount": "7", "currency": "NOK"}},
]


def test_sessions_round_trip(tmp_path):
    storage = Storage(tmp_path)
    storage.add_session(SESSION)

    [session] = storage.sessions()
    assert session["aspsp"] == {"name": "Bank A", "country": "NO"}
    assert session["accounts"][0] == SESSION["accounts"][0]
    assert session["accounts"][1]["identifiers"] == []
    assert storage.has_account("acc-2")


def test_transactions_keep_order_and_refresh_keeps_older_history(tmp_path):
    storage = Storage(tmp_path)
    storage.add_session(SESSION)
    assert storage.load_transactions("acc-1") is None

    storage.save_transactions("acc-1", TRANSACTIONS)
    assert storage.load_transactions("acc-1") == TRANSACTIONS
    assert storage.has_transaction("acc-1:t1")
    assert storage.transactions_fetched_at("acc-1") is not None

    # A later fetch covering only 2 Oct leaves 1 Oct alone.
    storage.save_transactions("acc-1", TRANSACTIONS[:1])
    assert storage.load_transactions("acc-1") == TRANSACTIONS
    assert storage.has_transaction("acc-1:t1")

    storage.save_transactions("acc-2", [])
    assert storage.load_transactions("acc-2") == []


def _tx(transaction_id, day, status="BOOK"):
    return {"transaction_id": transaction_id, "booking_date": f"2026-{day}", "status": status,
            "transaction_amount": {"amount": "1", "currency": "NOK"}}


def test_refresh_replaces_its_own_period_and_keeps_older_history(tmp_path):
    """Full history first, then a bank's usual ~90 days: old history stays, the recent period is replaced."""
    storage = Storage(tmp_path)
    storage.add_session(SESSION)
    first = [_tx("pending", "11-03", "PDNG"), _tx("c", "10-20"), _tx("b", "08-10"), _tx("a", "01-05")]
    storage.save_transactions("acc-1", first)

    # The pending one was booked under a new id; "b" is outside the bank's new window.
    later = [_tx("new", "11-09"), _tx("booked", "11-04"), _tx("c", "10-20")]
    storage.save_transactions("acc-1", later)

    ids = [t["transaction_id"] for t in storage.load_transactions("acc-1")]
    assert ids == ["new", "booked", "c", "b", "a"]  # newest first, like the bank
    assert not storage.has_transaction("acc-1:pending")


def test_refresh_keeps_order_when_bank_sends_oldest_first(tmp_path):
    storage = Storage(tmp_path)
    storage.add_session(SESSION)
    storage.save_transactions("acc-1", [_tx("a", "01-05"), _tx("b", "08-10"), _tx("c", "10-20")])
    storage.save_transactions("acc-1", [_tx("c", "10-20"), _tx("d", "11-09")])

    assert [t["transaction_id"] for t in storage.load_transactions("acc-1")] == ["a", "b", "c", "d"]


def test_empty_refresh_keeps_history(tmp_path):
    storage = Storage(tmp_path)
    storage.add_session(SESSION)
    storage.save_transactions("acc-1", TRANSACTIONS)
    storage.save_transactions("acc-1", [])
    assert storage.load_transactions("acc-1") == TRANSACTIONS


def test_removed_connection_hides_but_keeps_transactions(tmp_path):
    storage = Storage(tmp_path)
    storage.add_session(SESSION)
    storage.save_transactions("acc-1", TRANSACTIONS)

    storage.remove_session("s1")

    assert storage.sessions() == []
    assert storage.raw_transactions_by_account() == {}
    assert storage.load_transactions("acc-1") == TRANSACTIONS


def test_overrides_and_rules(tmp_path):
    storage = Storage(tmp_path)
    storage.set_override("acc-1:t1", "groceries")
    storage.add_rule("obos", "housing")
    storage.add_rule("OBOS", "bills")  # same pattern, case-insensitive: replaced

    settings = storage.categorization()
    assert settings.overrides == {"acc-1:t1": "groceries"}
    assert settings.rules == [Rule("OBOS", "bills")]

    storage.set_override("acc-1:t1", None)
    assert storage.delete_rule("obos")
    assert not storage.delete_rule("obos")
    assert storage.categorization().overrides == {}
    assert storage.categorization().rules == []


def test_balances(tmp_path):
    storage = Storage(tmp_path)
    storage.save_balances("acc-1", [{"balance_amount": {"amount": "100", "currency": "NOK"}}])
    assert storage.load_balances("acc-1")["balances"][0]["balance_amount"]["amount"] == "100"
    assert storage.load_balances("missing") is None


def test_imports_json_files_once_and_backs_them_up(tmp_path):
    (tmp_path / "sessions.json").write_text(json.dumps([SESSION]), encoding="utf-8")
    (tmp_path / "balances.json").write_text(
        json.dumps({"acc-1": {"fetched_at": "2026-11-02T00:00:00+00:00", "balances": [{"name": "x"}]}}),
        encoding="utf-8",
    )
    (tmp_path / "transactions").mkdir()
    (tmp_path / "transactions" / "acc-1.json").write_text(json.dumps(TRANSACTIONS), encoding="utf-8")
    (tmp_path / "transactions" / "acc-2.json").write_text("[]", encoding="utf-8")
    (tmp_path / "categorization.json").write_text(
        json.dumps({"overrides": {"acc-1:t1": "housing"}, "rules": [{"pattern": "KIWI", "category": "groceries"}]}),
        encoding="utf-8",
    )

    storage = Storage(tmp_path)

    assert [s["session_id"] for s in storage.sessions()] == ["s1"]
    assert storage.load_transactions("acc-1") == TRANSACTIONS
    assert storage.load_transactions("acc-2") == []
    assert storage.load_balances("acc-1")["fetched_at"] == "2026-11-02T00:00:00+00:00"
    assert storage.categorization().overrides == {"acc-1:t1": "housing"}
    assert storage.categorization().rules == [Rule("KIWI", "groceries")]
    assert not (tmp_path / "sessions.json").exists()
    assert (tmp_path / "json-backup" / "sessions.json").exists()
    assert (tmp_path / "json-backup" / "transactions" / "acc-1.json").exists()

    # A second start doesn't import again, even if old files reappear.
    (tmp_path / "sessions.json").write_text("[]", encoding="utf-8")
    assert len(Storage(tmp_path).sessions()) == 1


def test_transactions_with_shared_entry_reference_are_all_kept(tmp_path):
    # Some banks reuse entry_reference for different transactions; identical-looking ones can be real too.
    shared = [
        {"entry_reference": "0", "booking_date": "2026-10-01", "credit_debit_indicator": "DBIT",
         "transaction_amount": {"amount": "10", "currency": "NOK"}},
        {"entry_reference": "0", "booking_date": "2026-10-02", "credit_debit_indicator": "DBIT",
         "transaction_amount": {"amount": "10", "currency": "NOK"}},
        {"entry_reference": "0", "booking_date": "2026-10-02", "credit_debit_indicator": "DBIT",
         "transaction_amount": {"amount": "10", "currency": "NOK"}},
    ]
    storage = Storage(tmp_path)
    storage.add_session(SESSION)
    storage.save_transactions("acc-1", shared)

    assert storage.load_transactions("acc-1") == shared
    assert storage.has_transaction("acc-1:0|2026-10-02|10|DBIT#2")


def test_account_numbers_are_fetched_only_where_missing(tmp_path):
    storage = Storage(tmp_path)
    session = {**SESSION, "accounts": [*SESSION["accounts"], {"uid": "acc-3", "cash_account_type": "SVGS"}]}
    storage.add_session(session)

    assert not storage.account_needs_numbers("acc-1")  # has an IBAN
    assert not storage.account_needs_numbers("acc-2")  # card
    assert storage.account_needs_numbers("acc-3")

    storage.set_account_identifiers("acc-3", ["11223344556"])
    assert not storage.account_needs_numbers("acc-3")
    assert storage.sessions()[0]["accounts"][2]["identifiers"] == ["11223344556"]


def test_default_categories_are_seeded(tmp_path):
    storage = Storage(tmp_path)
    categories = {c.id: c for c in storage.categories()}
    assert categories["housing"].fixed and not categories["groceries"].fixed
    assert categories["loans"].kind == "loan"
    assert categories["transfer"].system
    assert "bills" not in categories


def test_add_rename_and_change_categories(tmp_path):
    storage = Storage(tmp_path)
    added = storage.add_category("  Memberships ", "expense", fixed=True)
    assert (added.id, added.name, added.fixed) == ("memberships", "Memberships", True)
    assert storage.add_category("Memberships", "expense").id == "memberships_2"

    renamed = storage.update_category("eating_out", name="Dining out")
    assert (renamed.name, renamed.kind) == ("Dining out", "expense")
    assert storage.update_category("memberships", fixed=False).fixed is False

    with pytest.raises(CategoryError):
        storage.update_category("transfer", kind="expense")
    with pytest.raises(CategoryError):
        storage.add_category("   ", "expense")
    with pytest.raises(CategoryError):
        storage.add_category("Weird", "nonsense")


def test_delete_category_moves_or_removes_rules_and_choices(tmp_path):
    storage = Storage(tmp_path)
    storage.add_rule("FORENING", "other_expense")
    storage.set_override("acc-1:t1", "other_expense")
    memberships = storage.add_category("Memberships", "expense", fixed=True)

    storage.delete_category("other_expense", move_to=memberships.id)
    settings = storage.categorization()
    assert settings.rules == [Rule("FORENING", "memberships")]
    assert settings.overrides == {"acc-1:t1": "memberships"}

    storage.delete_category("memberships")
    assert storage.categorization().rules == []
    assert storage.categorization().overrides == {}

    with pytest.raises(CategoryError):
        storage.delete_category("transfer")
    with pytest.raises(CategoryError):
        storage.delete_category("groceries", move_to="groceries")


def test_rules_on_split_categories_are_moved(tmp_path):
    storage = Storage(tmp_path)
    with storage._connect() as db:
        db.execute("DELETE FROM categories")
        db.execute("DELETE FROM meta WHERE key = 'categories_seeded_at'")
    for pattern, category in [("TERMINBELØP", "bills"), ("FORENING-KONTINGENT", "bills"), ("GJENSIDIGE", "bills"),
                              ("UNIQLO ONLINE", "shopping"), ("ELKJØP", "shopping")]:
        storage.add_rule(pattern, category)

    rules = {r.pattern: r.category for r in Storage(tmp_path).categorization().rules}
    assert rules == {
        "TERMINBELØP": "loans",
        "FORENING-KONTINGENT": "other_expense",
        "GJENSIDIGE": "insurance",
        "UNIQLO ONLINE": "clothing",
        "ELKJØP": "shopping",
    }


def test_account_owners_survive_reconnecting(tmp_path):
    storage = Storage(tmp_path)
    storage.add_session(SESSION)
    storage.set_account_owner("acc-1", "Alex")
    storage.add_session(SESSION)  # reconnecting rewrites the accounts
    assert storage.account_owners() == {"acc-1": "Alex"}

    storage.set_account_owner("acc-1", None)
    assert storage.account_owners() == {}
