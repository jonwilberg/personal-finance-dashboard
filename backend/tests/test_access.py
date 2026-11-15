import time
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from finance.access import AccessSettings
from finance.config import ConfigError, Settings, load_settings
from finance.enable_banking import API_URL, EnableBankingClient
from finance.refresh import refresh_all
from finance.storage import Storage
from finance.web import create_app, serve_app
from test_web import FakeBank, connect

TEAM = "example.cloudflareaccess.com"
AUD = "aud-tag"
ALLOWED = "one@example.com"


@pytest.fixture(scope="module")
def signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def token(key, email=ALLOWED, aud=AUD, iss=f"https://{TEAM}", expires_in=600):
    now = int(time.time())
    claims = {"email": email, "aud": aud, "iss": iss, "iat": now, "exp": now + expires_in, "sub": "x"}
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "k1"})


def enable_banking_client(bank):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    return EnableBankingClient("app-id", pem, http_client=httpx.Client(base_url=API_URL, transport=httpx.MockTransport(bank)))


def settings(tmp_path, access=True):
    return Settings(
        application_id="app-id",
        private_key_path=tmp_path / "unused.pem",
        redirect_url="https://finance.example.com/callback",
        data_dir=tmp_path / "data",
        access=AccessSettings(TEAM, AUD, frozenset({ALLOWED})) if access else None,
    )


@pytest.fixture
def hosted(tmp_path, signing_key):
    keys = SimpleNamespace(get_signing_key_from_jwt=lambda _token: SimpleNamespace(key=signing_key.public_key()))
    app = create_app(settings(tmp_path), client=enable_banking_client(FakeBank()), access_keys=keys)
    return TestClient(app, follow_redirects=False)


def test_requests_need_a_valid_access_token_for_an_allowed_email(hosted, signing_key):
    assert hosted.get("/api/overview").status_code == 403
    assert hosted.get("/api/overview", headers={"Cf-Access-Jwt-Assertion": "nonsense"}).status_code == 403

    good = {"Cf-Access-Jwt-Assertion": token(signing_key)}
    assert hosted.get("/api/overview", headers=good).status_code == 200
    assert hosted.get("/api/me", headers=good).json() == {"email": ALLOWED}
    # The bank's redirect back arrives in the browser with the Access cookie.
    assert hosted.get("/callback", cookies={"CF_Authorization": token(signing_key)}).status_code == 303

    for bad in [
        token(signing_key, email="someone@else.com"),
        token(signing_key, aud="another-app"),
        token(signing_key, iss="https://other.cloudflareaccess.com"),
        token(signing_key, expires_in=-3600),
        token(rsa.generate_private_key(public_exponent=65537, key_size=2048)),  # not signed by Cloudflare
    ]:
        assert hosted.get("/api/overview", headers={"Cf-Access-Jwt-Assertion": bad}).status_code == 403


def test_health_check_needs_no_token_and_says_nothing(hosted):
    assert hosted.get("/healthz").json() == {"ok": True}


def test_api_docs_are_not_served(hosted, signing_key):
    good = {"Cf-Access-Jwt-Assertion": token(signing_key)}
    assert hosted.get("/docs", headers=good).status_code in (404, 405)
    assert hosted.get("/openapi.json", headers=good).status_code in (404, 405)


def test_serving_beyond_this_machine_needs_access(tmp_path):
    with pytest.raises(ConfigError, match="Cloudflare Access"):
        serve_app(settings(tmp_path, access=False), cert_dir=tmp_path, host="0.0.0.0", plain=True)


def test_access_settings_come_all_together_or_not_at_all(tmp_path, monkeypatch):
    key = tmp_path / "key.pem"
    key.write_text("unused")
    monkeypatch.setenv("ENABLE_BANKING_APP_ID", "app-id")
    monkeypatch.setenv("ENABLE_BANKING_KEY_PATH", str(key))
    for name in ("CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "FINANCE_ALLOWED_EMAILS"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr("finance.config.BACKEND_DIR", tmp_path)
    assert load_settings().access is None

    monkeypatch.setenv("CF_ACCESS_TEAM_DOMAIN", f"https://{TEAM}/")
    with pytest.raises(ConfigError, match="CF_ACCESS_AUD"):
        load_settings()

    monkeypatch.setenv("CF_ACCESS_AUD", AUD)
    monkeypatch.setenv("FINANCE_ALLOWED_EMAILS", " One@Example.com, two@example.com ")
    access = load_settings().access
    assert access == AccessSettings(TEAM, AUD, frozenset({"one@example.com", "two@example.com"}))


def test_refresh_all_fetches_every_connected_account_and_reports_expired_consents(tmp_path):
    bank = FakeBank()
    client = enable_banking_client(bank)
    local = TestClient(create_app(settings(tmp_path, access=False), client=client), follow_redirects=False)
    connect(local, bank)
    store = Storage(tmp_path / "data")

    [result] = refresh_all(client, store)
    assert (result.account_uid, result.fetched, result.problem) == ("acc-1", 2, None)
    assert len(store.load_transactions("acc-1")) == 2

    [late] = refresh_all(client, store, now=datetime(2100, 1, 1, tzinfo=UTC))
    assert late.fetched is None and "expired" in late.problem
