import json
import threading
import time
import urllib.request
from datetime import UTC, date, datetime

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from finance.cli import _wait_for_callback
from finance.enable_banking import API_URL, EnableBankingClient, EnableBankingError
from finance.transactions import field_coverage, signed_amount

APP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


@pytest.fixture(scope="module")
def key_pair():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    return private_pem, key.public_key()


def make_client(private_pem, handler):
    http = httpx.Client(base_url=API_URL, transport=httpx.MockTransport(handler))
    return EnableBankingClient(APP_ID, private_pem, http_client=http)


def test_requests_carry_signed_jwt(key_pair):
    private_pem, public_key = key_pair
    seen = {}

    def handler(request):
        seen["auth"] = request.headers["Authorization"]
        return httpx.Response(200, json={"name": "test", "environment": "SANDBOX"})

    client = make_client(private_pem, handler)
    assert client.get_application()["environment"] == "SANDBOX"

    token = seen["auth"].removeprefix("Bearer ")
    assert jwt.get_unverified_header(token)["kid"] == APP_ID
    claims = jwt.decode(token, public_key, algorithms=["RS256"], audience="api.enablebanking.com")
    assert claims["iss"] == "enablebanking.com"
    assert 0 < claims["exp"] - claims["iat"] <= 86400


def test_start_authorization_body(key_pair):
    private_pem, _ = key_pair
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"url": "https://bank.example/auth", "authorization_id": "a1"})

    client = make_client(private_pem, handler)
    valid_until = datetime(2027, 1, 1, tzinfo=UTC)
    result = client.start_authorization("Mock ASPSP", "fi", "http://localhost:8765/callback", valid_until)

    assert seen["body"]["aspsp"] == {"name": "Mock ASPSP", "country": "FI"}
    assert seen["body"]["access"] == {"valid_until": "2027-01-01T00:00:00+00:00"}
    assert seen["body"]["psu_type"] == "personal"
    assert result["state"] == seen["body"]["state"]
    assert result["url"] == "https://bank.example/auth"


def test_transactions_follow_continuation_key(key_pair):
    private_pem, _ = key_pair
    requests = []

    def handler(request):
        requests.append(dict(request.url.params))
        if "continuation_key" not in request.url.params:
            return httpx.Response(200, json={"transactions": [{"id": 1}, {"id": 2}], "continuation_key": "next"})
        return httpx.Response(200, json={"transactions": [{"id": 3}], "continuation_key": None})

    client = make_client(private_pem, handler)
    transactions = list(client.iter_transactions("acc-1", date_from=date(2026, 8, 1)))

    assert [t["id"] for t in transactions] == [1, 2, 3]
    assert requests == [
        {"date_from": "2026-08-01"},
        {"date_from": "2026-08-01", "continuation_key": "next"},
    ]


def test_api_errors_raise(key_pair):
    private_pem, _ = key_pair
    client = make_client(private_pem, lambda request: httpx.Response(401, json={"message": "bad token"}))

    with pytest.raises(EnableBankingError) as error:
        client.get_application()
    assert error.value.status_code == 401
    assert error.value.body == {"message": "bad token"}


def test_signed_amount():
    debit = {"transaction_amount": {"amount": "12.50", "currency": "EUR"}, "credit_debit_indicator": "DBIT"}
    credit = {"transaction_amount": {"amount": "100", "currency": "EUR"}, "credit_debit_indicator": "CRDT"}
    assert str(signed_amount(debit)) == "-12.50"
    assert str(signed_amount(credit)) == "100"


def test_transactions_pass_strategy(key_pair):
    private_pem, _ = key_pair
    seen = []

    def handler(request):
        seen.append(dict(request.url.params))
        return httpx.Response(200, json={"transactions": []})

    client = make_client(private_pem, handler)
    list(client.iter_transactions("acc-1", strategy="longest"))
    assert seen == [{"strategy": "longest"}]


def test_field_coverage_counts_nested_non_empty_fields():
    transactions = [
        {"creditor": {"name": "Rema 1000"}, "remittance_information": ["Kortkjøp"], "merchant_category_code": None},
        {"creditor": {"name": ""}, "remittance_information": [], "merchant_category_code": "5411"},
    ]
    assert dict(field_coverage(transactions)) == {
        "creditor.name": 0.5,
        "merchant_category_code": 0.5,
        "remittance_information": 0.5,
    }


def test_local_callback_captures_code():
    redirect_url = "http://localhost:8799/callback"
    result = {}
    thread = threading.Thread(target=lambda: result.update(_wait_for_callback(redirect_url, timeout=10)))
    thread.start()
    time.sleep(0.5)
    urllib.request.urlopen(f"{redirect_url}?code=abc&state=xyz").read()
    thread.join()
    assert result == {"code": "abc", "state": "xyz"}
