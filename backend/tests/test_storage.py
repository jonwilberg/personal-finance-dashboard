import json

from finance.categorize import Rule
from finance.storage import Storage

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


def test_transactions_keep_order_and_are_replaced_on_refresh(tmp_path):
    storage = Storage(tmp_path)
    storage.add_session(SESSION)
    assert storage.load_transactions("acc-1") is None

    storage.save_transactions("acc-1", TRANSACTIONS)
    assert storage.load_transactions("acc-1") == TRANSACTIONS
    assert storage.has_transaction("acc-1:t1")
    assert storage.transactions_fetched_at("acc-1") is not None

    storage.save_transactions("acc-1", TRANSACTIONS[:1])
    assert storage.load_transactions("acc-1") == TRANSACTIONS[:1]
    assert not storage.has_transaction("acc-1:t1")

    storage.save_transactions("acc-2", [])
    assert storage.load_transactions("acc-2") == []


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
