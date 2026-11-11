"""Local web app: JSON API for the frontend plus the bank redirect (callback) endpoint.

Start it with `uv run finance serve` (add `--env production` for real banks).
"""

from __future__ import annotations

import time
from collections import Counter
from dataclasses import asdict
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlparse

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from finance.categories import KINDS
from finance.categorize import categorized_transactions, summarize_categorization
from finance.config import BACKEND_DIR, Settings
from finance.connections import (
    BankNotFound,
    account_identifiers,
    consent_valid_until,
    find_aspsp,
    session_record,
)
from finance.enable_banking import EnableBankingClient, EnableBankingError
from finance.overview import build_overview
from finance.storage import CategoryError, PersonError, Storage
from finance.transactions import summarize

FRONTEND_DIST = BACKEND_DIR.parent / "frontend" / "dist"
# A bank login that hasn't come back within this time is forgotten.
PENDING_LOGIN_TTL_SECONDS = 30 * 60


class ConnectRequest(BaseModel):
    bank: str
    country: str = "NO"
    days: int = Field(default=180, ge=1, le=365)


class CategoryChoice(BaseModel):
    # None removes your manual choice, so the automatic category applies again.
    category: str | None


class RuleRequest(BaseModel):
    pattern: str = Field(min_length=2)
    category: str


class OwnerChoice(BaseModel):
    # A person's id (as text, from /api/owners), or "shared".
    owner: str


class PersonName(BaseModel):
    name: str


# The owner of accounts that aren't one person's.
SHARED = "shared"


class RuleCategory(BaseModel):
    category: str


class NewCategory(BaseModel):
    name: str
    kind: str = "expense"
    fixed: bool = False


class CategoryChanges(BaseModel):
    name: str | None = None
    kind: str | None = None
    fixed: bool | None = None


def create_app(settings: Settings, client: EnableBankingClient | None = None) -> FastAPI:
    client = client or EnableBankingClient.from_key_file(settings.application_id, settings.private_key_path)
    store = Storage(settings.data_dir)
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

    def owners_by_account() -> dict[str, str]:
        """Account uid -> owner id (a person's id as text) for accounts that are one person's."""
        return {uid: str(person_id) for uid, person_id in store.account_owners().items()}

    @app.exception_handler(PersonError)
    async def person_error(request: Request, error: PersonError) -> JSONResponse:
        status = 404 if str(error) == "Unknown person" else 422
        return JSONResponse({"detail": str(error)}, status_code=status)

    @app.get("/api/people")
    def people() -> list[dict[str, Any]]:
        return store.people()

    @app.post("/api/people")
    def add_person(request: PersonName) -> dict[str, Any]:
        return store.add_person(request.name)

    @app.patch("/api/people/{person_id}")
    def rename_person(person_id: int, request: PersonName) -> dict[str, Any]:
        return store.rename_person(person_id, request.name)

    @app.delete("/api/people/{person_id}")
    def remove_person(person_id: int) -> dict[str, bool]:
        """Remove a person; their accounts become shared."""
        store.remove_person(person_id)
        return {"ok": True}

    @app.get("/api/owners")
    def owners() -> list[dict[str, str]]:
        """Who accounts can belong to: each person (id as text), then shared."""
        return [{"id": str(p["id"]), "name": p["name"]} for p in store.people()] + [{"id": SHARED, "name": "Shared"}]

    @app.get("/api/connections")
    def connections() -> list[dict[str, Any]]:
        now = datetime.now(UTC)
        owned = owners_by_account()
        return [
            record
            | {
                "expired": datetime.fromisoformat(record["valid_until"]) <= now,
                "accounts": [
                    account | _account_state(store, account["uid"]) | {"owner": owned.get(account["uid"], SHARED)}
                    for account in record["accounts"]
                ],
            }
            for record in store.sessions()
        ]

    @app.put("/api/accounts/{account_uid}/owner")
    def set_owner(account_uid: str, choice: OwnerChoice) -> dict[str, str]:
        _require_account(store, account_uid)
        if choice.owner == SHARED:
            store.set_account_owner(account_uid, None)
        elif choice.owner.isdigit():
            store.set_account_owner(account_uid, int(choice.owner))
        else:
            raise HTTPException(422, f"Unknown owner {choice.owner!r}")
        return {"owner": choice.owner}

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
        if store.account_needs_numbers(account_uid):
            # Needed to recognise transfers to this account; fetched once.
            store.set_account_identifiers(account_uid, account_identifiers(client.get_account_details(account_uid)))
        store.save_balances(account_uid, client.get_balances(account_uid))
        if longest:
            transactions = client.iter_transactions(account_uid, strategy="longest")
        else:
            transactions = client.iter_transactions(account_uid, date_from=date.today() - timedelta(days=days))
        store.save_transactions(account_uid, list(transactions))
        return _account_state(store, account_uid)

    def all_transactions() -> list[dict[str, Any]]:
        return categorized_transactions(store.sessions(), store.raw_transactions_by_account(), store.categorization())

    def require_category(category: str) -> None:
        if store.category(category) is None:
            raise HTTPException(422, f"Unknown category {category!r}")

    @app.exception_handler(CategoryError)
    async def category_error(request: Request, error: CategoryError) -> JSONResponse:
        return JSONResponse({"detail": str(error)}, status_code=422)

    @app.get("/api/categories")
    def categories() -> list[dict[str, Any]]:
        """Your categories, with how many transactions and rules use each."""
        used = Counter(t["category"] for t in all_transactions())
        rules = store.rule_counts()
        return [
            asdict(c) | {"transactions": used.get(c.id, 0), "rules": rules.get(c.id, 0)} for c in store.categories()
        ]

    @app.get("/api/category-kinds")
    def category_kinds() -> list[str]:
        return list(KINDS)

    @app.post("/api/categories")
    def add_category(request: NewCategory) -> dict[str, Any]:
        return asdict(store.add_category(request.name, request.kind, request.fixed))

    @app.patch("/api/categories/{category_id}")
    def update_category(category_id: str, changes: CategoryChanges) -> dict[str, Any]:
        return asdict(store.update_category(category_id, name=changes.name, kind=changes.kind, fixed=changes.fixed))

    @app.delete("/api/categories/{category_id}")
    def delete_category(category_id: str, move_to: str | None = None) -> dict[str, bool]:
        """Delete a category; its rules and choices move to `move_to`, or are removed so they show up for review."""
        store.delete_category(category_id, move_to or None)
        return {"ok": True}

    @app.get("/api/transactions")
    def transactions(
        view: str = "all",
        category: str | None = None,
        account: str | None = None,
        q: str | None = None,
        limit: int = Query(default=200, ge=1, le=5000),
        offset: int = 0,
    ) -> dict[str, Any]:
        """Categorized transactions, newest first. view=review shows only uncategorized ones."""
        items = all_transactions()
        if view == "review":
            items = [t for t in items if t["category"] is None]
        if category:
            items = [t for t in items if t["category"] == category]
        if account:
            items = [t for t in items if t["account_uid"] == account]
        if q:
            needle = q.upper()
            items = [t for t in items if needle in t["text"] or needle in t["description"].upper()]
        return {"total": len(items), "items": [_public(t) for t in items[offset : offset + limit]]}

    @app.put("/api/transactions/{transaction_id:path}/category")
    def set_category(transaction_id: str, choice: CategoryChoice) -> dict[str, Any]:
        if not store.has_transaction(transaction_id):
            raise HTTPException(404, "Unknown transaction")
        if choice.category is not None:
            require_category(choice.category)
        store.set_override(transaction_id, choice.category)
        return _public(next(t for t in all_transactions() if t["id"] == transaction_id))

    def rule_matches() -> Counter[str]:
        """How many transactions each rule decides now (a longer rule or your own choice can win over it)."""
        return Counter(t["rule"] for t in all_transactions() if t["rule"])

    @app.get("/api/rules")
    def rules() -> list[dict[str, Any]]:
        """Your rules in pattern order, each with how many transactions it categorizes now."""
        matches = rule_matches()
        return [rule | {"matched": matches.get(rule["pattern"], 0)} for rule in store.rules()]

    @app.post("/api/rules")
    def add_rule(request: RuleRequest) -> dict[str, Any]:
        """Save a rule: transactions whose text contains the pattern get the category (unless set by hand)."""
        require_category(request.category)
        pattern = request.pattern.strip().upper()
        store.add_rule(pattern, request.category)
        return {"pattern": pattern, "category": request.category, "matched": rule_matches().get(pattern, 0)}

    @app.patch("/api/rules")
    def retarget_rule(pattern: str, choice: RuleCategory) -> dict[str, Any]:
        """Point a rule at another category."""
        require_category(choice.category)
        if not store.set_rule_category(pattern, choice.category):
            raise HTTPException(404, "Unknown rule")
        pattern = pattern.upper()
        return {"pattern": pattern, "category": choice.category, "matched": rule_matches().get(pattern, 0)}

    @app.delete("/api/rules")
    def delete_rule(pattern: str) -> dict[str, bool]:
        if not store.delete_rule(pattern):
            raise HTTPException(404, "Unknown rule")
        return {"ok": True}

    @app.get("/api/overview")
    def overview(month: str | None = None, owner: list[str] | None = Query(default=None)) -> dict[str, Any]:
        """The front page for one month (YYYY-MM); defaults to the last complete month.

        With `owner` (repeatable: a person or "shared"), only those owners' accounts count. Transfers are found
        across all accounts first, so money moved between any two of your accounts never counts as spending or
        income, whoever the accounts belong to.
        """
        transactions = all_transactions()
        if owner:
            owned = owners_by_account()
            wanted = set(owner)
            transactions = [t for t in transactions if owned.get(t["account_uid"], SHARED) in wanted]
        return build_overview(transactions, store.categories(), month)

    @app.get("/api/categorization/summary")
    def categorization_summary() -> dict[str, Any]:
        return summarize_categorization(all_transactions())

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


def _account_state(store: Storage, account_uid: str) -> dict[str, Any]:
    transactions = store.load_transactions(account_uid)
    return {
        "balances": store.load_balances(account_uid),
        "transactions": (
            summarize(transactions) | {"fetched_at": store.transactions_fetched_at(account_uid)}
            if transactions is not None
            else None
        ),
    }


def _public(transaction: dict[str, Any]) -> dict[str, Any]:
    """A transaction as the frontend sees it: amounts as numbers, matching internals left out."""
    hidden = {"text", "counterparty_account"}
    return {k: v for k, v in transaction.items() if k not in hidden} | {"amount": float(transaction["amount"])}


def _require_account(store: Storage, account_uid: str) -> None:
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
