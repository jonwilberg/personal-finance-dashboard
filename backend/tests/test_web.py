import json

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from finance.config import Settings
from finance.enable_banking import API_URL, EnableBankingClient
from finance.manual import ManualAccountError, manual_account
from finance.storage import Storage
from finance.web import create_app

TRANSACTIONS = [
    {
        "transaction_amount": {"amount": "120.50", "currency": "NOK"},
        "credit_debit_indicator": "DBIT",
        "status": "BOOK",
        "booking_date": "2026-10-01",
        "creditor": {"name": "Rema 1000"},
    },
    {
        "transaction_amount": {"amount": "30000", "currency": "NOK"},
        "credit_debit_indicator": "CRDT",
        "status": "BOOK",
        "booking_date": "2026-10-25",
        "remittance_information": ["Lønn"],
    },
]


class FakeBank:
    """Answers Enable Banking API calls and remembers the last /auth request."""

    def __init__(self):
        self.auth_body = None
        self.deleted = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/aspsps":
            return httpx.Response(200, json={"aspsps": [{"name": "Mock ASPSP", "country": "NO", "maximum_consent_validity": 15552000}]})
        if path == "/auth":
            self.auth_body = json.loads(request.content)
            return httpx.Response(200, json={"url": "https://bank.example/login", "authorization_id": "a1"})
        if path == "/sessions" and request.method == "POST":
            return httpx.Response(
                200,
                json={
                    "session_id": "s1",
                    "aspsp": {"name": "Mock ASPSP", "country": "NO"},
                    "access": {"valid_until": "2099-01-01T00:00:00Z"},
                    "accounts": [{"uid": "acc-1", "name": "Jon", "currency": "NOK", "account_id": {"iban": "NO9386011117947"}}],
                },
            )
        if path == "/sessions/s1" and request.method == "DELETE":
            self.deleted.append("s1")
            return httpx.Response(200, json={"message": "OK"})
        if path == "/accounts/acc-1/balances":
            return httpx.Response(200, json={"balances": [{"balance_amount": {"amount": "100", "currency": "NOK"}, "balance_type": "CLBD"}]})
        if path == "/accounts/acc-1/transactions":
            return httpx.Response(200, json={"transactions": TRANSACTIONS, "continuation_key": None})
        return httpx.Response(404, json={"message": f"unexpected {request.method} {path}"})


@pytest.fixture
def bank():
    return FakeBank()


@pytest.fixture
def api(tmp_path, bank):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    client = EnableBankingClient("app-id", pem, http_client=httpx.Client(base_url=API_URL, transport=httpx.MockTransport(bank)))
    settings = Settings(
        application_id="app-id",
        private_key_path=tmp_path / "unused.pem",
        redirect_url="https://localhost:8765/callback",
        data_dir=tmp_path / "data",
    )
    return TestClient(create_app(settings, client=client), follow_redirects=False)


def connect(api, bank):
    started = api.post("/api/connections", json={"bank": "mock aspsp", "country": "no", "days": 30})
    assert started.status_code == 200
    assert started.json() == {"url": "https://bank.example/login"}
    return api.get("/callback", params={"code": "c1", "state": bank.auth_body["state"]})


def test_connect_flow_saves_session(api, bank):
    callback = connect(api, bank)

    assert callback.status_code == 303
    assert callback.headers["location"] == "/?connected=Mock+ASPSP"
    assert bank.auth_body["redirect_url"] == "https://localhost:8765/callback"
    [connection] = api.get("/api/connections").json()
    assert connection["session_id"] == "s1"
    assert connection["expired"] is False
    assert connection["accounts"][0]["uid"] == "acc-1"
    assert connection["accounts"][0]["transactions"] is None


def test_callback_rejects_unknown_state(api, bank):
    connect(api, bank)
    replay = api.get("/callback", params={"code": "c1", "state": bank.auth_body["state"]})

    assert replay.status_code == 303
    assert "error=" in replay.headers["location"]


def test_callback_passes_bank_errors_to_frontend(api, bank):
    response = api.get("/callback", params={"error": "access_denied", "error_description": "Cancelled by user"})
    assert response.headers["location"].startswith("/?error=access_denied")


def test_refresh(api, bank):
    connect(api, bank)

    refreshed = api.post("/api/accounts/acc-1/refresh", params={"longest": True}).json()
    assert refreshed["balances"]["balances"][0]["balance_amount"]["amount"] == "100"
    assert refreshed["transactions"]["count"] == 2
    assert refreshed["transactions"]["first_date"] == "2026-10-01"


def test_unknown_account_is_rejected(api):
    assert api.post("/api/accounts/%2E%2E/refresh").status_code == 404  # ".." must never reach a file path
    assert api.post("/api/accounts/not-mine/refresh").status_code == 404


def test_disconnect(api, bank):
    connect(api, bank)
    assert api.delete("/api/connections/s1").json() == {"ok": True}
    assert bank.deleted == ["s1"]
    assert api.get("/api/connections").json() == []


def test_unknown_bank_is_404(api):
    response = api.post("/api/connections", json={"bank": "Nope"})
    assert response.status_code == 404


def test_transactions_categories_and_rules(api, bank):
    connect(api, bank)
    api.post("/api/accounts/acc-1/refresh", params={"longest": True})

    assert {c["id"] for c in api.get("/api/categories").json()} >= {"groceries", "salary", "transfer"}
    listing = api.get("/api/transactions").json()
    assert listing["total"] == 2
    by_text = {t["description"]: t for t in listing["items"]}
    assert by_text["Rema 1000"]["category"] == "groceries"
    assert by_text["Rema 1000"]["amount"] == -120.5
    assert by_text["Lønn"]["category"] == "salary"
    assert "text" not in by_text["Rema 1000"]

    rema_id = by_text["Rema 1000"]["id"]
    changed = api.put(f"/api/transactions/{rema_id}/category", json={"category": "eating_out"}).json()
    assert (changed["category"], changed["category_source"]) == ("eating_out", "manual")
    assert api.put(f"/api/transactions/{rema_id}/category", json={"category": "nope"}).status_code == 422
    reset = api.put(f"/api/transactions/{rema_id}/category", json={"category": None}).json()
    assert reset["category_source"] == "keyword"

    rule = api.post("/api/rules", json={"pattern": "rema", "category": "shopping"}).json()
    assert rule == {"pattern": "REMA", "category": "shopping", "regex": False, "matched": 1}
    assert api.get("/api/transactions", params={"category": "shopping"}).json()["total"] == 1
    assert api.delete("/api/rules", params={"pattern": "REMA"}).json() == {"ok": True}

    summary = api.get("/api/categorization/summary").json()
    assert summary["count"] == 2 and summary["uncategorized"] == 0


def test_categories_can_be_managed(api, bank):
    connect(api, bank)
    api.post("/api/accounts/acc-1/refresh", params={"longest": True})

    groceries = next(c for c in api.get("/api/categories").json() if c["id"] == "groceries")
    assert groceries | {"transactions": 1} == groceries and groceries["fixed"] is False

    added = api.post("/api/categories", json={"name": "Memberships", "kind": "expense", "fixed": True}).json()
    assert added["id"] == "memberships"
    assert api.patch("/api/categories/memberships", json={"name": "Clubs"}).json()["name"] == "Clubs"
    assert api.post("/api/categories", json={"name": "", "kind": "expense"}).status_code == 422

    assert api.delete("/api/categories/groceries", params={"move_to": "memberships"}).json() == {"ok": True}
    ids = [c["id"] for c in api.get("/api/categories").json()]
    assert "groceries" not in ids
    # Rema was a built-in groceries keyword; with groceries gone it needs review.
    rema = next(t for t in api.get("/api/transactions").json()["items"] if t["description"] == "Rema 1000")
    assert rema["category"] is None
    assert api.delete("/api/categories/transfer").status_code == 422


def _household_tx(amount, direction, day, **fields):
    return {"transaction_amount": {"amount": amount, "currency": "NOK"}, "credit_debit_indicator": direction,
            "status": "BOOK", "booking_date": f"2026-10-{day}", **fields}


@pytest.fixture
def household(tmp_path, bank):
    """Two people with an account each, and a shared account; one of them sends the other money."""
    from finance.storage import Storage

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    client = EnableBankingClient("app-id", pem, http_client=httpx.Client(base_url=API_URL, transport=httpx.MockTransport(bank)))
    settings = Settings(
        application_id="app-id",
        private_key_path=tmp_path / "unused.pem",
        redirect_url="https://localhost:8765/callback",
        data_dir=tmp_path / "data",
    )
    store = Storage(settings.data_dir)
    store.add_session({
        "session_id": "s1", "aspsp": {"name": "Bank", "country": "NO"}, "valid_until": "2099-01-01T00:00:00+00:00",
        "accounts": [
            {"uid": "alex", "iban": "NO1111111111111", "cash_account_type": "CACC"},
            {"uid": "sam", "iban": "NO2222222222222", "cash_account_type": "CACC"},
            {"uid": "joint", "iban": "NO3333333333333", "cash_account_type": "CACC"},
        ],
    })
    store.save_transactions("alex", [
        _household_tx("300", "DBIT", "05", creditor={"name": "Rema 1000"}),
        _household_tx("1000", "DBIT", "10", remittance_information=["Til Sam"], creditor_account={"iban": "NO2222222222222"}),
    ])
    store.save_transactions("sam", [
        _household_tx("1000", "CRDT", "10", remittance_information=["Fra Alex"], debtor_account={"iban": "NO1111111111111"}),
        _household_tx("200", "DBIT", "12", creditor={"name": "Kiwi"}),
    ])
    store.save_transactions("joint", [_household_tx("50", "DBIT", "15", creditor={"name": "Coop Extra"})])
    return TestClient(create_app(settings, client=client), follow_redirects=False)


def spent(api, *owners):
    figures = api.get("/api/overview", params={"month": "2026-10", "owner": list(owners)}).json()["figures"]
    return figures["spent"], figures["income"]


def add_people(api, *names):
    return {name: str(api.post("/api/people", json={"name": name}).json()["id"]) for name in names}


def test_people_can_be_added_renamed_and_removed(household):
    assert household.get("/api/owners").json() == [{"id": "shared", "name": "Shared"}]
    ids = add_people(household, "Alex", "Sam")
    assert household.get("/api/owners").json() == [
        {"id": ids["Alex"], "name": "Alex"}, {"id": ids["Sam"], "name": "Sam"}, {"id": "shared", "name": "Shared"},
    ]
    assert household.post("/api/people", json={"name": " alex "}).status_code == 422  # taken, whatever the case
    assert household.post("/api/people", json={"name": "Shared"}).status_code == 422
    assert household.post("/api/people", json={"name": "  "}).status_code == 422

    assert household.patch(f"/api/people/{ids['Alex']}", json={"name": "Alexandra"}).json()["name"] == "Alexandra"
    assert household.patch(f"/api/people/{ids['Alex']}", json={"name": "sam"}).status_code == 422
    assert household.patch("/api/people/999", json={"name": "Kim"}).status_code == 404
    assert household.delete("/api/people/999").status_code == 404


def owners_of(api):
    return {a["uid"]: a["owner"] for a in api.get("/api/connections").json()[0]["accounts"]}


def test_accounts_are_shared_until_given_to_a_person(household):
    ids = add_people(household, "Alex", "Sam")
    assert owners_of(household) == {"alex": "shared", "sam": "shared", "joint": "shared"}

    assert household.put("/api/accounts/alex/owner", json={"owner": ids["Alex"]}).status_code == 200
    assert household.put("/api/accounts/sam/owner", json={"owner": ids["Sam"]}).status_code == 200
    assert owners_of(household) == {"alex": ids["Alex"], "sam": ids["Sam"], "joint": "shared"}

    # Renaming keeps the accounts; removing a person makes their accounts shared.
    household.patch(f"/api/people/{ids['Alex']}", json={"name": "Alexandra"})
    assert owners_of(household)["alex"] == ids["Alex"]
    assert household.delete(f"/api/people/{ids['Sam']}").status_code == 200
    assert owners_of(household)["sam"] == "shared"

    assert household.put("/api/accounts/alex/owner", json={"owner": "shared"}).status_code == 200
    assert owners_of(household)["alex"] == "shared"
    assert household.put("/api/accounts/alex/owner", json={"owner": "Nobody"}).status_code == 422
    assert household.put("/api/accounts/alex/owner", json={"owner": "999"}).status_code == 404
    assert household.put("/api/accounts/missing/owner", json={"owner": ids["Alex"]}).status_code == 404


def test_overview_counts_only_the_chosen_owners_and_never_transfers(household):
    ids = add_people(household, "Alex", "Sam")
    household.put("/api/accounts/alex/owner", json={"owner": ids["Alex"]})
    household.put("/api/accounts/sam/owner", json={"owner": ids["Sam"]})

    assert spent(household) == (550, 0)  # everyone: the 1 000 moved between the two accounts is left out
    # Alex's 1 000 to Sam's account is a transfer, not spending, even when Sam's accounts aren't shown...
    assert spent(household, ids["Alex"]) == (300, 0)
    # ...and not income on Sam's side either.
    assert spent(household, ids["Sam"]) == (200, 0)
    assert spent(household, "shared") == (50, 0)
    assert spent(household, ids["Alex"], "shared") == (350, 0)


def test_rules_can_be_listed_retargeted_and_deleted(api, bank):
    connect(api, bank)
    api.post("/api/accounts/acc-1/refresh", params={"longest": True})
    api.post("/api/rules", json={"pattern": "rema", "category": "shopping"})
    api.post("/api/rules", json={"pattern": "rema 1000", "category": "eating_out"})  # longer, so it wins
    api.post("/api/rules", json={"pattern": "kiwi", "category": "groceries"})  # matches nothing

    listed = {r["pattern"]: r for r in api.get("/api/rules").json()}
    assert [r["pattern"] for r in api.get("/api/rules").json()] == ["KIWI", "REMA", "REMA 1000"]
    assert {p: (r["category"], r["matched"]) for p, r in listed.items()} == {
        "KIWI": ("groceries", 0), "REMA": ("shopping", 0), "REMA 1000": ("eating_out", 1),
    }
    assert listed["KIWI"]["created_at"]
    rema = next(t for t in api.get("/api/transactions").json()["items"] if t["description"] == "Rema 1000")
    assert (rema["category"], rema["rule"]) == ("eating_out", "REMA 1000")

    moved = api.patch("/api/rules", params={"pattern": "rema 1000"}, json={"category": "groceries"})
    assert moved.json() == {"pattern": "REMA 1000", "category": "groceries", "matched": 1}
    assert api.get("/api/transactions", params={"category": "groceries"}).json()["total"] == 1
    assert api.patch("/api/rules", params={"pattern": "REMA 1000"}, json={"category": "nope"}).status_code == 422
    assert api.patch("/api/rules", params={"pattern": "missing"}, json={"category": "groceries"}).status_code == 404

    assert api.delete("/api/rules", params={"pattern": "REMA 1000"}).status_code == 200
    assert {r["pattern"]: r["matched"] for r in api.get("/api/rules").json()} == {"KIWI": 0, "REMA": 1}


def test_regex_rules_match_a_format_and_come_after_text_rules(api, bank):
    connect(api, bank)
    api.post("/api/accounts/acc-1/refresh", params={"longest": True})

    bad = api.post("/api/rules/preview", json={"pattern": "L[ønn", "regex": True})
    assert bad.status_code == 422 and "Not a valid regex" in bad.json()["detail"]
    assert api.post("/api/rules", json={"pattern": "L[ønn", "category": "salary", "regex": True}).status_code == 422

    # Case-insensitive, against the text as shown ("Lønn"); kept as written, not upper-cased.
    preview = api.post("/api/rules/preview", json={"pattern": r"^l\wnn$", "regex": True}).json()
    assert (preview["matches"], preview["uncategorized"]) == (1, 0)
    assert preview["examples"][0]["description"] == "Lønn"
    saved = api.post("/api/rules", json={"pattern": r"^l\wnn$", "category": "other_income", "regex": True}).json()
    assert saved == {"pattern": r"^l\wnn$", "category": "other_income", "regex": True, "matched": 1}

    listed = {r["pattern"]: r for r in api.get("/api/rules").json()}
    assert listed[r"^l\wnn$"]["regex"] is True and listed[r"^l\wnn$"]["matched"] == 1

    # A text rule that also matches wins over the regex.
    api.post("/api/rules", json={"pattern": "lønn", "category": "salary"})
    assert {r["pattern"]: r["matched"] for r in api.get("/api/rules").json()} == {"LØNN": 1, r"^l\wnn$": 0}
    api.delete("/api/rules", params={"pattern": "LØNN"})

    # Re-target and delete find the regex as written.
    assert api.patch("/api/rules", params={"pattern": r"^l\wnn$"}, json={"category": "salary"}).json()["pattern"] == r"^l\wnn$"
    assert api.delete("/api/rules", params={"pattern": r"^l\wnn$"}).status_code == 200
    assert api.get("/api/rules").json() == []


def test_transactions_can_be_filtered_to_the_ones_a_rule_categorizes(api, bank):
    connect(api, bank)
    api.post("/api/accounts/acc-1/refresh", params={"longest": True})
    api.post("/api/rules", json={"pattern": "rema", "category": "shopping"})
    api.post("/api/rules", json={"pattern": "rema 1000", "category": "eating_out"})

    assert api.get("/api/transactions", params={"rule": "REMA 1000"}).json()["total"] == 1
    assert api.get("/api/transactions", params={"rule": "REMA"}).json()["total"] == 0  # the longer rule wins


def test_many_transactions_can_get_a_category_at_once_and_be_undone(api, bank):
    connect(api, bank)
    api.post("/api/accounts/acc-1/refresh", params={"longest": True})
    items = {t["description"]: t for t in api.get("/api/transactions").json()["items"]}
    rema, salary = items["Rema 1000"], items["Lønn"]
    assert (rema["category"], rema["category_source"]) == ("groceries", "keyword")

    changed = api.put("/api/transactions/categories", json={"changes": [
        {"id": rema["id"], "category": "eating_out"}, {"id": salary["id"], "category": "eating_out"},
    ]}).json()["items"]
    assert {(t["category"], t["category_source"]) for t in changed} == {("eating_out", "manual")}

    # Undo: back to how each one was, which for both means the automatic category.
    undone = api.put("/api/transactions/categories", json={"changes": [
        {"id": rema["id"], "category": None}, {"id": salary["id"], "category": None},
    ]}).json()["items"]
    assert {t["description"]: t["category"] for t in undone} == {"Rema 1000": "groceries", "Lønn": "salary"}

    # All or nothing: one unknown id or category changes none of them.
    assert api.put("/api/transactions/categories", json={"changes": [
        {"id": rema["id"], "category": "shopping"}, {"id": "acc-1:nope", "category": "shopping"},
    ]}).status_code == 404
    assert api.put("/api/transactions/categories", json={"changes": [
        {"id": rema["id"], "category": "nope"},
    ]}).status_code == 422
    assert next(t for t in api.get("/api/transactions").json()["items"] if t["id"] == rema["id"])["category"] == "groceries"


CARD = {
    "bank": "Example Bank",
    "country": "NO",
    "name": "Credit card",
    "card": True,
    "transactions": [
        {"date": "2026-10-03", "text": "SHOP, Main street 1", "amount": "-250.00"},
        {"date": "2026-10-03", "text": "SHOP, Main street 1", "amount": "-250.00"},
        {"date": "2026-10-09", "text": "HOTEL, Harbour road", "amount": "-1000.00", "details": "1 500,00 ZAR"},
        {"date": "2026-10-20", "text": "Innbetaling", "amount": "1500.00", "payment": True},
    ],
}


def test_a_card_added_by_hand_is_never_refreshed_and_its_bill_payment_is_a_transfer(api, bank, tmp_path):
    connect(api, bank)
    store = Storage(tmp_path / "data")
    bill_payment = {
        "transaction_amount": {"amount": "1500.00", "currency": "NOK"},
        "credit_debit_indicator": "DBIT",
        "status": "BOOK",
        "booking_date": "2026-10-20",
        "creditor": {"name": "Example Bank"},
    }
    store.save_transactions("acc-1", [bill_payment])
    store.add_manual_account(manual_account(CARD))

    card = next(c for c in api.get("/api/connections").json() if c["manual"])
    assert card["expired"] is False
    assert card["aspsp"]["name"] == "Example Bank"
    [account] = card["accounts"]
    assert account["cash_account_type"] == "CARD"
    assert account["transactions"]["count"] == 4  # the same purchase twice is kept twice
    assert api.post(f"/api/accounts/{account['uid']}/refresh").status_code == 409

    items = api.get("/api/transactions", params={"view": "all"}).json()["items"]
    payments = [t for t in items if abs(t["amount"]) == 1500]
    assert len(payments) == 2 and all(t["kind"] == "transfer" for t in payments)
    hotel = next(t for t in items if t["amount"] == -1000)
    assert hotel["description"] == "HOTEL, Harbour road | 1 500,00 ZAR"

    # Adding it again replaces its transactions; removing it never calls the bank.
    store.add_manual_account(manual_account(CARD | {"transactions": CARD["transactions"][:1]}))
    assert sum(t["account_uid"] == account["uid"] for t in api.get("/api/transactions").json()["items"]) == 1
    assert api.delete(f"/api/connections/{card['session_id']}").json() == {"ok": True}
    assert bank.deleted == []


@pytest.mark.parametrize(
    "change",
    [
        {"bank": ""},
        {"transactions": [{"date": "05.01.2026", "text": "SHOP", "amount": "-1"}]},
        {"transactions": [{"date": "2026-01-05", "text": "SHOP", "amount": "lots"}]},
        {"transactions": [{"date": "2026-01-05", "text": "", "amount": "-1"}]},
    ],
)
def test_a_hand_added_account_file_must_be_complete(change):
    with pytest.raises(ManualAccountError):
        manual_account(CARD | change)


def test_spending_groups_are_listed_and_a_category_can_move_between_them(api):
    groups = api.get("/api/spending-groups").json()
    assert [g["id"] for g in groups] == ["fixed", "groceries", "health", "dining", "travel", "other"]
    moved = api.patch("/api/categories/shopping", json={"group": "fixed"}).json()
    assert (moved["group"], moved["fixed"]) == ("fixed", True)
    added = api.post("/api/categories", json={"name": "Gym", "kind": "expense", "group": "dining"}).json()
    assert (added["group"], added["fixed"]) == ("dining", False)
    assert api.patch("/api/categories/shopping", json={"group": "nonsense"}).status_code == 422


def test_transactions_can_be_narrowed_to_a_month_owner_and_category(api, bank):
    connect(api, bank)
    api.post("/api/accounts/acc-1/refresh", params={"longest": True})

    def ids(**params):
        return len(api.get("/api/transactions", params=params).json()["items"])

    assert ids(month="2026-10") == 2 and ids(month="2026-09") == 0
    assert ids(month="2026-10", category="groceries") == 1
    assert ids(owner="shared") == 2 and ids(owner="999") == 0  # accounts are shared until given to someone
    api.put("/api/transactions/categories", json={"changes": [
        {"id": t["id"], "category": None} for t in api.get("/api/transactions").json()["items"]]})
    assert ids(category="uncategorized") == ids(view="review")
