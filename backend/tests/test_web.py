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


def test_refresh_and_inspect(api, bank):
    connect(api, bank)

    refreshed = api.post("/api/accounts/acc-1/refresh", params={"longest": True}).json()
    assert refreshed["balances"]["balances"][0]["balance_amount"]["amount"] == "100"
    assert refreshed["transactions"]["count"] == 2
    assert refreshed["transactions"]["first_date"] == "2026-10-01"

    report = api.get("/api/accounts/acc-1/inspect").json()
    assert report["directions"] == {"DBIT": 1, "CRDT": 1}
    coverage = {item["field"]: item["share"] for item in report["coverage"]}
    assert coverage["creditor.name"] == 0.5
    assert "Rema" not in json.dumps(report)


def test_unknown_account_is_rejected(api):
    assert api.post("/api/accounts/../../secrets/refresh").status_code == 404
    assert api.post("/api/accounts/not-mine/refresh").status_code == 404


def test_disconnect(api, bank):
    connect(api, bank)
    assert api.delete("/api/connections/s1").json() == {"ok": True}
    assert bank.deleted == ["s1"]
    assert api.get("/api/connections").json() == []


def test_unknown_bank_is_404(api):
    response = api.post("/api/connections", json={"bank": "Nope"})
    assert response.status_code == 404
