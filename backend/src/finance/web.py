"""Local web app: JSON API for the frontend plus the bank redirect (callback) endpoint.

Start it with `uv run finance serve` (add `--env production` for real banks).
"""

from __future__ import annotations

import time
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from finance.config import BACKEND_DIR, Settings
from finance.connections import (
    BankNotFound,
    ConnectionStore,
    consent_valid_until,
    find_aspsp,
    session_record,
)
from finance.enable_banking import EnableBankingClient, EnableBankingError
from finance.transactions import inspect, summarize

FRONTEND_DIST = BACKEND_DIR.parent / "frontend" / "dist"
# A bank login that hasn't come back within this time is forgotten.
PENDING_LOGIN_TTL_SECONDS = 30 * 60


class ConnectRequest(BaseModel):
    bank: str
    country: str = "NO"
    days: int = Field(default=180, ge=1, le=365)


def create_app(settings: Settings, client: EnableBankingClient | None = None) -> FastAPI:
    client = client or EnableBankingClient.from_key_file(settings.application_id, settings.private_key_path)
    store = ConnectionStore(settings.data_dir)
    redirect_url = settings.redirect_url or client.get_application()["redirect_urls"][0]
    # state -> bank login started by this server; checked when the bank redirects back.
    pending_logins: dict[str, dict[str, Any]] = {}

    app = FastAPI(title="Personal finance dashboard")
    app.state.redirect_url = redirect_url

    @app.exception_handler(EnableBankingError)
    async def enable_banking_error(request: Request, error: EnableBankingError) -> JSONResponse:
        return JSONResponse({"detail": f"Enable Banking: {error.body}"}, status_code=502)

    @app.exception_handler(BankNotFound)
    async def bank_not_found(request: Request, error: BankNotFound) -> JSONResponse:
        return JSONResponse({"detail": str(error)}, status_code=404)

    @app.get("/api/app")
    def application() -> dict[str, Any]:
        info = client.get_application()
        return {key: info.get(key) for key in ("name", "environment", "active", "redirect_urls")}

    @app.get("/api/banks")
    def banks(country: str = "NO") -> list[dict[str, Any]]:
        return [
            {
                "name": aspsp["name"],
                "country": aspsp["country"],
                "logo": aspsp.get("logo"),
                "max_consent_days": (aspsp.get("maximum_consent_validity") or 0) // 86400,
            }
            for aspsp in sorted(client.list_aspsps(country=country), key=lambda a: a["name"].lower())
        ]

    @app.get("/api/connections")
    def connections() -> list[dict[str, Any]]:
        now = datetime.now(UTC)
        return [
            record
            | {
                "expired": datetime.fromisoformat(record["valid_until"]) <= now,
                "accounts": [account | _account_state(store, account["uid"]) for account in record["accounts"]],
            }
            for record in store.sessions()
        ]

    @app.post("/api/connections")
    def start_connection(request: ConnectRequest) -> dict[str, str]:
        aspsp = find_aspsp(client, request.bank, request.country)
        valid_until = consent_valid_until(aspsp, request.days)
        auth = client.start_authorization(aspsp["name"], aspsp["country"], redirect_url, valid_until)
        _forget_stale(pending_logins)
        pending_logins[auth["state"]] = {"bank": aspsp["name"], "started": time.monotonic()}
        return {"url": auth["url"]}

    @app.delete("/api/connections/{session_id}")
    def disconnect(session_id: str) -> dict[str, bool]:
        if not any(s["session_id"] == session_id for s in store.sessions()):
            raise HTTPException(404, "Unknown connection")
        client.delete_session(session_id)
        store.remove_session(session_id)
        return {"ok": True}

    @app.post("/api/accounts/{account_uid}/refresh")
    def refresh_account(account_uid: str, longest: bool = False, days: int = 90) -> dict[str, Any]:
        """Fetch balances and transactions from the bank. Many banks allow ~4 of these per day per account."""
        _require_account(store, account_uid)
        store.save_balances(account_uid, client.get_balances(account_uid))
        if longest:
            transactions = client.iter_transactions(account_uid, strategy="longest")
        else:
            transactions = client.iter_transactions(account_uid, date_from=date.today() - timedelta(days=days))
        store.save_transactions(account_uid, list(transactions))
        return _account_state(store, account_uid)

    @app.get("/api/accounts/{account_uid}/inspect")
    def inspect_account(account_uid: str) -> dict[str, Any]:
        _require_account(store, account_uid)
        transactions = store.load_transactions(account_uid)
        if transactions is None:
            raise HTTPException(404, "No transactions fetched for this account yet")
        return inspect(transactions)

    def bank_callback(request: Request) -> RedirectResponse:
        params = request.query_params
        login = pending_logins.pop(params.get("state", ""), None)
        if "error" in params:
            return _to_frontend(settings, error=f"{params['error']}: {params.get('error_description', '')}")
        if login is None:
            return _to_frontend(settings, error="Unknown or expired bank login. Please start again.")
        if "code" not in params:
            return _to_frontend(settings, error="The bank did not return an authorization code.")
        try:
            store.add_session(session_record(client.create_session(params["code"])))
        except EnableBankingError as error:
            return _to_frontend(settings, error=f"Could not create session: {error.body}")
        return _to_frontend(settings, connected=login["bank"])

    app.add_api_route(
        urlparse(redirect_url).path or "/", bank_callback, methods=["GET"], include_in_schema=False
    )

    if FRONTEND_DIST.is_dir():
        app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
    else:

        @app.get("/", include_in_schema=False)
        def frontend_missing() -> HTMLResponse:
            return HTMLResponse(
                "<h1>Frontend not built</h1><p>Run <code>npm run build</code> in <code>frontend/</code>, "
                "or use the Vite dev server (<code>npm run dev</code>).</p>"
            )

    return app


def _account_state(store: ConnectionStore, account_uid: str) -> dict[str, Any]:
    transactions = store.load_transactions(account_uid)
    return {
        "balances": store.load_balances(account_uid),
        "transactions": (
            summarize(transactions) | {"fetched_at": store.transactions_fetched_at(account_uid)}
            if transactions is not None
            else None
        ),
    }


def _require_account(store: ConnectionStore, account_uid: str) -> None:
    # Also keeps arbitrary path segments out of the file names built from account_uid.
    if not store.has_account(account_uid):
        raise HTTPException(404, "Unknown account")


def _forget_stale(pending_logins: dict[str, dict[str, Any]]) -> None:
    cutoff = time.monotonic() - PENDING_LOGIN_TTL_SECONDS
    for state in [s for s, login in pending_logins.items() if login["started"] < cutoff]:
        del pending_logins[state]


def _to_frontend(settings: Settings, **params: str) -> RedirectResponse:
    return RedirectResponse(f"{settings.frontend_url}?{urlencode(params)}", status_code=303)


def serve_app(settings: Settings, cert_dir: Path, port: int | None = None) -> None:
    """Run the app on the scheme and port of the redirect URL, so the bank's redirect lands here."""
    import uvicorn

    from finance.certs import ensure_localhost_certificate

    app = create_app(settings)
    redirect = urlparse(app.state.redirect_url)
    port = port or redirect.port or (443 if redirect.scheme == "https" else 80)
    ssl_options: dict[str, str] = {}
    if redirect.scheme == "https":
        cert_path, key_path = ensure_localhost_certificate(cert_dir)
        ssl_options = {"ssl_certfile": str(cert_path), "ssl_keyfile": str(key_path)}

    print(f"\n  Open {redirect.scheme}://localhost:{port}/ in your browser.")
    if ssl_options:
        print("  The certificate is self-signed: accept the browser warning once (Advanced -> Proceed).\n")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", **ssl_options)
