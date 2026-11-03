"""Command line tool for connecting banks through Enable Banking and pulling transactions.

Run `uv run finance --help` from the backend folder.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import webbrowser
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from finance.config import ConfigError, Settings, load_settings
from finance.enable_banking import EnableBankingClient, EnableBankingError

CALLBACK_TIMEOUT_SECONDS = 300
DEFAULT_CONSENT_DAYS = 90


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="finance", description=__doc__.splitlines()[0])
    parser.add_argument(
        "--env",
        help='Use backend/.env.<ENV> and data/<ENV> instead of backend/.env, e.g. "--env production"',
    )
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("app", help="Show the registered Enable Banking application")

    banks = commands.add_parser("banks", help="List banks (ASPSPs) you can connect to")
    banks.add_argument("--country", help="Two-letter country code, e.g. NO, FI, SE")
    banks.add_argument("--search", help="Only show banks whose name contains this text")

    connect = commands.add_parser("connect", help="Authorize access to a bank and save the session")
    connect.add_argument("--bank", required=True, help='Bank name exactly as listed by "banks"')
    connect.add_argument("--country", required=True, help="Two-letter country code of the bank")
    connect.add_argument(
        "--days", type=int, default=DEFAULT_CONSENT_DAYS, help="How long the consent should last"
    )

    commands.add_parser("accounts", help="List accounts and balances in saved sessions")

    transactions = commands.add_parser("transactions", help="Fetch transactions for an account")
    transactions.add_argument("account", help='Account uid as shown by "accounts"')
    transactions.add_argument("--days", type=int, default=90, help="How many days back to fetch")
    transactions.add_argument(
        "--longest",
        action="store_true",
        help="Ask the bank for as much history as it allows (ignores --days)",
    )

    inspect = commands.add_parser(
        "inspect", help="Summarize which fields saved transactions contain, without printing their values"
    )
    inspect.add_argument("account", help="Account uid with saved transactions")

    disconnect = commands.add_parser("disconnect", help="Revoke a saved session")
    disconnect.add_argument("session_id")

    args = parser.parse_args(argv)
    try:
        settings = load_settings(args.env)
        if args.command == "inspect":
            cmd_inspect(settings, args)
            return 0
        with EnableBankingClient.from_key_file(settings.application_id, settings.private_key_path) as client:
            handler = {
                "app": cmd_app,
                "banks": cmd_banks,
                "connect": cmd_connect,
                "accounts": cmd_accounts,
                "transactions": cmd_transactions,
                "disconnect": cmd_disconnect,
            }[args.command]
            handler(client, settings, args)
    except (ConfigError, EnableBankingError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


def cmd_app(client: EnableBankingClient, settings: Settings, args: argparse.Namespace) -> None:
    app = client.get_application()
    print(f"Name:          {app.get('name')}")
    print(f"Environment:   {app.get('environment')}")
    print(f"Active:        {app.get('active')}")
    print(f"Redirect URLs: {', '.join(app.get('redirect_urls', []))}")


def cmd_banks(client: EnableBankingClient, settings: Settings, args: argparse.Namespace) -> None:
    aspsps = client.list_aspsps(country=args.country)
    if args.search:
        aspsps = [a for a in aspsps if args.search.lower() in a["name"].lower()]
    for aspsp in sorted(aspsps, key=lambda a: (a["country"], a["name"])):
        max_days = aspsp.get("maximum_consent_validity", 0) // 86400
        print(f"{aspsp['country']}  {aspsp['name']:<45} max consent {max_days} days")
    print(f"\n{len(aspsps)} bank(s)")


def cmd_connect(client: EnableBankingClient, settings: Settings, args: argparse.Namespace) -> None:
    aspsp = _find_aspsp(client, args.bank, args.country)
    redirect_url = settings.redirect_url or client.get_application()["redirect_urls"][0]

    consent_seconds = args.days * 86400
    if max_seconds := aspsp.get("maximum_consent_validity"):
        consent_seconds = min(consent_seconds, max_seconds)
    valid_until = datetime.now(UTC) + timedelta(seconds=consent_seconds)

    auth = client.start_authorization(aspsp["name"], aspsp["country"], redirect_url, valid_until)
    print(f"Open this URL to log in to {aspsp['name']} and approve access:\n\n  {auth['url']}\n")
    webbrowser.open(auth["url"])

    if _is_local_http(redirect_url):
        print(f"Waiting for the bank to redirect back to {redirect_url} ...")
        params = _wait_for_callback(redirect_url)
    else:
        print("After approving, your browser is sent to the redirect URL (the page may fail to load).")
        pasted = input("Paste the full URL from the address bar here: ").strip()
        params = {k: v[0] for k, v in parse_qs(urlparse(pasted).query).items()}

    if "error" in params:
        raise EnableBankingError(400, f"{params['error']}: {params.get('error_description', '')}")
    if params.get("state") != auth["state"]:
        raise EnableBankingError(400, "State in the redirect does not match; aborting.")
    if "code" not in params:
        raise EnableBankingError(400, "No authorization code in the redirect URL.")

    session = client.create_session(params["code"])
    saved = {
        "session_id": session["session_id"],
        "aspsp": session["aspsp"],
        "valid_until": session["access"]["valid_until"],
        "created_at": datetime.now(UTC).isoformat(),
        "accounts": [
            {
                "uid": account["uid"],
                "name": account.get("name"),
                "iban": (account.get("account_id") or {}).get("iban"),
                "currency": account.get("currency"),
            }
            for account in session["accounts"]
        ],
    }
    sessions = [s for s in _load_sessions(settings) if s["session_id"] != saved["session_id"]]
    _save_sessions(settings, [*sessions, saved])

    print(f"\nConnected {aspsp['name']}, consent valid until {saved['valid_until']}.")
    for account in saved["accounts"]:
        print(f"  {account['uid']}  {account['name'] or ''}  {account['iban'] or ''}  {account['currency'] or ''}")


def cmd_accounts(client: EnableBankingClient, settings: Settings, args: argparse.Namespace) -> None:
    sessions = _load_sessions(settings)
    if not sessions:
        print('No saved sessions. Connect a bank with "finance connect".')
        return
    for saved in sessions:
        status = client.get_session(saved["session_id"]).get("status")
        print(f"{saved['aspsp']['name']} ({saved['aspsp']['country']})  session {saved['session_id']}")
        print(f"  status {status}, valid until {saved['valid_until']}")
        for account in saved["accounts"]:
            balances = client.get_balances(account["uid"])
            balance = (
                f"{balances[0]['balance_amount']['amount']} {balances[0]['balance_amount']['currency']}"
                f" ({balances[0].get('balance_type')})"
                if balances
                else "no balance"
            )
            print(f"  {account['uid']}  {account['name'] or ''}  {account['iban'] or ''}  {balance}")


def cmd_transactions(client: EnableBankingClient, settings: Settings, args: argparse.Namespace) -> None:
    if args.longest:
        date_from = None
        transactions = list(client.iter_transactions(args.account, strategy="longest"))
    else:
        date_from = date.today() - timedelta(days=args.days)
        transactions = list(client.iter_transactions(args.account, date_from=date_from))

    out_path = settings.data_dir / "transactions" / f"{args.account}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(transactions, indent=2, ensure_ascii=False), encoding="utf-8")

    money_in = sum((_signed_amount(t) for t in transactions if _signed_amount(t) > 0), Decimal())
    money_out = sum((_signed_amount(t) for t in transactions if _signed_amount(t) < 0), Decimal())
    since = date_from or min((_transaction_date(t) for t in transactions if _transaction_date(t)), default="-")
    print(f"{len(transactions)} transactions since {since}  in {money_in}  out {money_out}")
    for transaction in transactions[:15]:
        print(f"  {_transaction_date(transaction):<10}  {_signed_amount(transaction):>12}  {_description(transaction)}")
    if len(transactions) > 15:
        print(f"  ... and {len(transactions) - 15} more")
    print(f"\nSaved raw transactions to {out_path}")


def cmd_inspect(settings: Settings, args: argparse.Namespace) -> None:
    path = settings.data_dir / "transactions" / f"{args.account}.json"
    if not path.exists():
        raise ConfigError(f'No saved transactions at {path}. Run "finance transactions {args.account}" first.')
    transactions = json.loads(path.read_text(encoding="utf-8"))
    if not transactions:
        print("No transactions saved for this account.")
        return

    dates = sorted(d for t in transactions if (d := _transaction_date(t)))
    print(f"{len(transactions)} transactions, {dates[0] if dates else '?'} to {dates[-1] if dates else '?'}")
    for label, key in [
        ("Status", "status"),
        ("Direction", "credit_debit_indicator"),
        ("Currency", "transaction_amount.currency"),
    ]:
        counts: dict[str, int] = {}
        for transaction in transactions:
            value = str(_field(transaction, key) or "(missing)")
            counts[value] = counts.get(value, 0) + 1
        print(f"{label + ':':<11}" + ", ".join(f"{v} {n}" for v, n in sorted(counts.items(), key=lambda i: -i[1])))

    print("\nField coverage (share of transactions where the field has a value):")
    for field_path, share in field_coverage(transactions):
        print(f"  {share:>4.0%}  {field_path}")


def field_coverage(transactions: list[dict[str, Any]]) -> list[tuple[str, float]]:
    """Share of transactions with a non-empty value for every (nested) field path, most common first."""
    counts: dict[str, int] = {}
    for transaction in transactions:
        for path in _filled_paths(transaction):
            counts[path] = counts.get(path, 0) + 1
    return sorted(((p, n / len(transactions)) for p, n in counts.items()), key=lambda i: (-i[1], i[0]))


def _filled_paths(value: Any, prefix: str = "") -> set[str]:
    if isinstance(value, dict):
        return {p for key, child in value.items() for p in _filled_paths(child, f"{prefix}.{key}" if prefix else key)}
    if value in (None, "", [], {}):
        return set()
    return {prefix}


def _field(transaction: dict[str, Any], path: str) -> Any:
    for key in path.split("."):
        transaction = (transaction or {}).get(key)
    return transaction


def _transaction_date(transaction: dict[str, Any]) -> str:
    return transaction.get("booking_date") or transaction.get("transaction_date") or transaction.get("value_date") or ""


def cmd_disconnect(client: EnableBankingClient, settings: Settings, args: argparse.Namespace) -> None:
    client.delete_session(args.session_id)
    _save_sessions(settings, [s for s in _load_sessions(settings) if s["session_id"] != args.session_id])
    print(f"Revoked session {args.session_id}.")


def _find_aspsp(client: EnableBankingClient, name: str, country: str) -> dict[str, Any]:
    aspsps = client.list_aspsps(country=country)
    for aspsp in aspsps:
        if aspsp["name"].lower() == name.lower():
            return aspsp
    close = [a["name"] for a in aspsps if name.lower() in a["name"].lower()]
    hint = f" Did you mean: {', '.join(close)}?" if close else ' Run "finance banks" to see the options.'
    raise ConfigError(f"No bank named {name!r} in {country.upper()}.{hint}")


def _signed_amount(transaction: dict[str, Any]) -> Decimal:
    amount = Decimal(transaction["transaction_amount"]["amount"])
    return -abs(amount) if transaction.get("credit_debit_indicator") == "DBIT" else abs(amount)


def _description(transaction: dict[str, Any]) -> str:
    counterparty = transaction.get("creditor") if transaction.get("credit_debit_indicator") == "DBIT" else transaction.get("debtor")
    parts = [(counterparty or {}).get("name"), *(transaction.get("remittance_information") or [])]
    # Banks often repeat the counterparty name in the remittance text; show each part once.
    return " | ".join(dict.fromkeys(p.strip() for p in parts if p and p.strip()))


def _is_local_http(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1")


def _wait_for_callback(redirect_url: str, timeout: float = CALLBACK_TIMEOUT_SECONDS) -> dict[str, str]:
    """Serve the redirect URL locally until the bank redirects the browser back with a code."""
    expected = urlparse(redirect_url)
    params: dict[str, str] = {}

    class CallbackHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            url = urlparse(self.path)
            if url.path.rstrip("/") != expected.path.rstrip("/"):
                self.send_error(404)
                return
            params.update({k: v[0] for k, v in parse_qs(url.query).items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"<h1>Done</h1><p>You can close this tab and go back to the terminal.</p>")

        def log_message(self, format: str, *args: Any) -> None:
            pass

    with HTTPServer((expected.hostname, expected.port or 80), CallbackHandler) as server:
        server.timeout = 1
        deadline = time.monotonic() + timeout
        while not params and time.monotonic() < deadline:
            server.handle_request()
    if not params:
        raise EnableBankingError(408, "Timed out waiting for the bank to redirect back.")
    return params


def _sessions_path(settings: Settings) -> Path:
    return settings.data_dir / "sessions.json"


def _load_sessions(settings: Settings) -> list[dict[str, Any]]:
    path = _sessions_path(settings)
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def _save_sessions(settings: Settings, sessions: list[dict[str, Any]]) -> None:
    path = _sessions_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(sessions, indent=2), encoding="utf-8")
