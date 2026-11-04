"""Command line tool for connecting banks through Enable Banking and pulling transactions.

Run `uv run finance --help` from the backend folder.
"""

from __future__ import annotations

import argparse
import sys
import time
import webbrowser
from datetime import date, timedelta
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from finance.config import ConfigError, Settings, load_settings
from finance.connections import (
    BankNotFound,
    ConnectionStore,
    consent_valid_until,
    find_aspsp,
    session_record,
)
from finance.enable_banking import EnableBankingClient, EnableBankingError
from finance.transactions import description, inspect, signed_amount, transaction_date

CALLBACK_TIMEOUT_SECONDS = 300
DEFAULT_CONSENT_DAYS = 90


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="finance", description=__doc__.splitlines()[0])
    parser.add_argument(
        "--env",
        help='Use backend/.env.<ENV> and data/<ENV> instead of backend/.env, e.g. "--env production"',
    )
    commands = parser.add_subparsers(dest="command", required=True)

    serve = commands.add_parser("serve", help="Run the local web app")
    serve.add_argument("--port", type=int, help="Defaults to the port of the redirect URL")

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

    inspect_parser = commands.add_parser(
        "inspect", help="Summarize which fields saved transactions contain, without printing their values"
    )
    inspect_parser.add_argument("account", help="Account uid with saved transactions")

    disconnect = commands.add_parser("disconnect", help="Revoke a saved session")
    disconnect.add_argument("session_id")

    args = parser.parse_args(argv)
    try:
        settings = load_settings(args.env)
        store = ConnectionStore(settings.data_dir)
        if args.command == "serve":
            from finance.web import serve_app

            serve_app(settings, cert_dir=settings.data_dir / "certs", port=args.port)
            return 0
        if args.command == "inspect":
            cmd_inspect(store, args)
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
            handler(client, settings, store, args)
    except (ConfigError, BankNotFound, EnableBankingError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


def cmd_app(client: EnableBankingClient, settings: Settings, store: ConnectionStore, args: argparse.Namespace) -> None:
    app = client.get_application()
    print(f"Name:          {app.get('name')}")
    print(f"Environment:   {app.get('environment')}")
    print(f"Active:        {app.get('active')}")
    print(f"Redirect URLs: {', '.join(app.get('redirect_urls', []))}")


def cmd_banks(client: EnableBankingClient, settings: Settings, store: ConnectionStore, args: argparse.Namespace) -> None:
    aspsps = client.list_aspsps(country=args.country)
    if args.search:
        aspsps = [a for a in aspsps if args.search.lower() in a["name"].lower()]
    for aspsp in sorted(aspsps, key=lambda a: (a["country"], a["name"])):
        max_days = aspsp.get("maximum_consent_validity", 0) // 86400
        print(f"{aspsp['country']}  {aspsp['name']:<45} max consent {max_days} days")
    print(f"\n{len(aspsps)} bank(s)")


def cmd_connect(client: EnableBankingClient, settings: Settings, store: ConnectionStore, args: argparse.Namespace) -> None:
    aspsp = find_aspsp(client, args.bank, args.country)
    redirect_url = settings.redirect_url or client.get_application()["redirect_urls"][0]
    valid_until = consent_valid_until(aspsp, args.days)

    auth = client.start_authorization(aspsp["name"], aspsp["country"], redirect_url, valid_until)
    print(f"Open this URL to log in to {aspsp['name']} and approve access:\n\n  {auth['url']}\n")
    webbrowser.open(auth["url"])

    if _is_local_http(redirect_url):
        print(f"Waiting for the bank to redirect back to {redirect_url} ...")
        params = _wait_for_callback(redirect_url)
    else:
        print("After approving, your browser is sent to the redirect URL (the page may fail to load).")
        print('Tip: "finance serve" does this in the browser without copying URLs.')
        pasted = input("Paste the full URL from the address bar here: ").strip()
        params = {k: v[0] for k, v in parse_qs(urlparse(pasted).query).items()}

    if "error" in params:
        raise EnableBankingError(400, f"{params['error']}: {params.get('error_description', '')}")
    if params.get("state") != auth["state"]:
        raise EnableBankingError(400, "State in the redirect does not match; aborting.")
    if "code" not in params:
        raise EnableBankingError(400, "No authorization code in the redirect URL.")

    record = session_record(client.create_session(params["code"]))
    store.add_session(record)

    print(f"\nConnected {aspsp['name']}, consent valid until {record['valid_until']}.")
    for account in record["accounts"]:
        print(f"  {account['uid']}  {account['name'] or ''}  {account['iban'] or ''}  {account['currency'] or ''}")


def cmd_accounts(client: EnableBankingClient, settings: Settings, store: ConnectionStore, args: argparse.Namespace) -> None:
    sessions = store.sessions()
    if not sessions:
        print('No saved sessions. Connect a bank with "finance connect" or "finance serve".')
        return
    for saved in sessions:
        status = client.get_session(saved["session_id"]).get("status")
        print(f"{saved['aspsp']['name']} ({saved['aspsp']['country']})  session {saved['session_id']}")
        print(f"  status {status}, valid until {saved['valid_until']}")
        for account in saved["accounts"]:
            balances = client.get_balances(account["uid"])
            store.save_balances(account["uid"], balances)
            balance = (
                f"{balances[0]['balance_amount']['amount']} {balances[0]['balance_amount']['currency']}"
                f" ({balances[0].get('balance_type')})"
                if balances
                else "no balance"
            )
            print(f"  {account['uid']}  {account['name'] or ''}  {account['iban'] or ''}  {balance}")


def cmd_transactions(client: EnableBankingClient, settings: Settings, store: ConnectionStore, args: argparse.Namespace) -> None:
    if args.longest:
        transactions = list(client.iter_transactions(args.account, strategy="longest"))
    else:
        date_from = date.today() - timedelta(days=args.days)
        transactions = list(client.iter_transactions(args.account, date_from=date_from))
    out_path = store.save_transactions(args.account, transactions)

    amounts = [signed_amount(t) for t in transactions]
    money_in = sum((a for a in amounts if a > 0), Decimal())
    money_out = sum((a for a in amounts if a < 0), Decimal())
    since = min((d for t in transactions if (d := transaction_date(t))), default="-")
    print(f"{len(transactions)} transactions since {since}  in {money_in}  out {money_out}")
    for transaction in transactions[:15]:
        print(f"  {transaction_date(transaction):<10}  {signed_amount(transaction):>12}  {description(transaction)}")
    if len(transactions) > 15:
        print(f"  ... and {len(transactions) - 15} more")
    print(f"\nSaved raw transactions to {out_path}")


def cmd_inspect(store: ConnectionStore, args: argparse.Namespace) -> None:
    transactions = store.load_transactions(args.account)
    if transactions is None:
        raise ConfigError(f'No saved transactions for {args.account}. Run "finance transactions" first.')
    if not transactions:
        print("No transactions saved for this account.")
        return

    report = inspect(transactions)
    print(f"{report['count']} transactions, {report['first_date']} to {report['last_date']}")
    for label, key in [("Status", "statuses"), ("Direction", "directions"), ("Currency", "currencies")]:
        print(f"{label + ':':<11}" + ", ".join(f"{value} {count}" for value, count in report[key].items()))
    print("\nField coverage (share of transactions where the field has a value):")
    for item in report["coverage"]:
        print(f"  {item['share']:>4.0%}  {item['field']}")


def cmd_disconnect(client: EnableBankingClient, settings: Settings, store: ConnectionStore, args: argparse.Namespace) -> None:
    client.delete_session(args.session_id)
    store.remove_session(args.session_id)
    print(f"Revoked session {args.session_id}.")


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
