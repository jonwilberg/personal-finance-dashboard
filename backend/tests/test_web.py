import json

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from finance.config import Settings
from finance.enable_banking import API_URL, EnableBankingClient
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
    assert rule == {"pattern": "REMA", "category": "shopping", "matched": 1}
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
        people=("Alex", "Sam"),
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


def test_accounts_are_shared_until_given_to_a_person(household):
    assert household.get("/api/owners").json() == [
        {"id": "Alex", "name": "Alex"}, {"id": "Sam", "name": "Sam"}, {"id": "shared", "name": "Shared"},
    ]
    owners = lambda: {a["uid"]: a["owner"] for a in household.get("/api/connections").json()[0]["accounts"]}  # noqa: E731
    assert owners() == {"alex": "shared", "sam": "shared", "joint": "shared"}

    assert household.put("/api/accounts/alex/owner", json={"owner": "Alex"}).status_code == 200
    assert household.put("/api/accounts/sam/owner", json={"owner": "Sam"}).status_code == 200
    assert owners() == {"alex": "Alex", "sam": "Sam", "joint": "shared"}

    assert household.put("/api/accounts/alex/owner", json={"owner": "shared"}).status_code == 200
    assert owners()["alex"] == "shared"
    assert household.put("/api/accounts/alex/owner", json={"owner": "Nobody"}).status_code == 422
    assert household.put("/api/accounts/missing/owner", json={"owner": "Alex"}).status_code == 404


def test_overview_counts_only_the_chosen_owners_and_never_transfers(household):
    household.put("/api/accounts/alex/owner", json={"owner": "Alex"})
    household.put("/api/accounts/sam/owner", json={"owner": "Sam"})

    assert spent(household) == (550, 0)  # everyone: the 1 000 moved between the two accounts is left out
    # Alex's 1 000 to Sam's account is a transfer, not spending, even when Sam's accounts aren't shown...
    assert spent(household, "Alex") == (300, 0)
    # ...and not income on Sam's side either.
    assert spent(household, "Sam") == (200, 0)
    assert spent(household, "shared") == (50, 0)
    assert spent(household, "Alex", "shared") == (350, 0)
