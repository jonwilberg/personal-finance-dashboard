"""Minimal client for the Enable Banking API.

Reference: https://enablebanking.com/docs/api/reference/
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Iterator
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import jwt

from finance.transactions import transaction_date, transaction_key

API_URL = "https://api.enablebanking.com"
# The API rejects tokens with a lifetime above 24 hours; one hour matches the official samples.
TOKEN_TTL_SECONDS = 3600
# Some banks return at most this many transactions per request and no
# continuation_key. A final page this full means older transactions may be missing.
CAPPED_PAGE_SIZE = 100
# How far back to ask when splitting a capped request that had no date_from.
CAPPED_LOOKBACK_DAYS = 730
# A safety net for banks that cap: at most this many extra requests per account and fetch.
CAPPED_MAX_REQUESTS = 40


class EnableBankingError(Exception):
    def __init__(self, status_code: int, body: Any):
        self.status_code = status_code
        self.body = body
        super().__init__(f"Enable Banking API returned {status_code}: {body}")


class EnableBankingClient:
    def __init__(
        self,
        application_id: str,
        private_key: bytes,
        *,
        http_client: httpx.Client | None = None,
    ):
        self.application_id = application_id
        self._private_key = private_key
        self._http = http_client or httpx.Client(base_url=API_URL, timeout=30.0)
        self._token: str | None = None
        self._token_expires_at = 0

    @classmethod
    def from_key_file(cls, application_id: str, key_path: Path, **kwargs: Any) -> EnableBankingClient:
        return cls(application_id, key_path.read_bytes(), **kwargs)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> EnableBankingClient:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def _auth_token(self) -> str:
        now = int(time.time())
        # Renew a minute early so a token never expires mid-request.
        if self._token is None or now >= self._token_expires_at - 60:
            claims = {
                "iss": "enablebanking.com",
                "aud": "api.enablebanking.com",
                "iat": now,
                "exp": now + TOKEN_TTL_SECONDS,
            }
            self._token = jwt.encode(
                claims, self._private_key, algorithm="RS256", headers={"kid": self.application_id}
            )
            self._token_expires_at = now + TOKEN_TTL_SECONDS
        return self._token

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        headers = {"Authorization": f"Bearer {self._auth_token()}"}
        response = self._http.request(method, path, headers=headers, **kwargs)
        if response.is_error:
            try:
                body = response.json()
            except ValueError:
                body = response.text
            raise EnableBankingError(response.status_code, body)
        return response.json()

    def get_application(self) -> dict[str, Any]:
        return self._request("GET", "/application")

    def list_aspsps(self, country: str | None = None, psu_type: str = "personal") -> list[dict[str, Any]]:
        params = {"psu_type": psu_type}
        if country:
            params["country"] = country.upper()
        return self._request("GET", "/aspsps", params=params)["aspsps"]

    def start_authorization(
        self,
        aspsp_name: str,
        country: str,
        redirect_url: str,
        valid_until: datetime,
        *,
        state: str | None = None,
        psu_type: str = "personal",
    ) -> dict[str, Any]:
        """Start a consent flow. Returns the bank `url` to send the user to and the `state` used."""
        body = {
            "access": {"valid_until": valid_until.isoformat()},
            "aspsp": {"name": aspsp_name, "country": country.upper()},
            "state": state or str(uuid.uuid4()),
            "redirect_url": redirect_url,
            "psu_type": psu_type,
        }
        return self._request("POST", "/auth", json=body) | {"state": body["state"]}

    def create_session(self, code: str) -> dict[str, Any]:
        return self._request("POST", "/sessions", json={"code": code})

    def get_session(self, session_id: str) -> dict[str, Any]:
        return self._request("GET", f"/sessions/{session_id}")

    def delete_session(self, session_id: str) -> None:
        self._request("DELETE", f"/sessions/{session_id}")

    def get_account_details(self, account_uid: str) -> dict[str, Any]:
        return self._request("GET", f"/accounts/{account_uid}/details")

    def get_balances(self, account_uid: str) -> list[dict[str, Any]]:
        return self._request("GET", f"/accounts/{account_uid}/balances")["balances"]

    def iter_transactions(
        self,
        account_uid: str,
        date_from: date | None = None,
        date_to: date | None = None,
        strategy: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Yield every transaction in the range once, following `continuation_key` pagination.

        `strategy="longest"` asks the bank for as much history as it allows (recommended for a first fetch).

        Some banks return at most CAPPED_PAGE_SIZE transactions and no continuation_key, and they differ in what
        they return then: the newest, the oldest, or (SEB Kort, for "longest") old purchases plus a few recent
        rows with months missing in between. So when a response is full, its date range is asked for again in
        two halves, and so on, until every window comes back short of full. That makes no assumption about what
        the bank kept; it costs a few extra requests, and only for fetches that hit the cap.
        """
        params: dict[str, str] = {}
        if date_from:
            params["date_from"] = date_from.isoformat()
        if date_to:
            params["date_to"] = date_to.isoformat()
        if strategy:
            params["strategy"] = strategy

        # Keys from earlier (overlapping) requests. Within one response every transaction is kept, even if two
        # look the same, since they can be separate purchases.
        seen: set[str] = set()

        def fetch(request: dict[str, str]) -> tuple[list[dict[str, Any]], list[str], bool]:
            """One request, following continuation keys: the transactions not seen before, the dates of all it
            returned (sorted), and whether the last page was full."""
            new: list[dict[str, Any]] = []
            keys: set[str] = set()
            dates: list[str] = []
            while True:
                page = self._request("GET", f"/accounts/{account_uid}/transactions", params=request)
                rows = page.get("transactions", [])
                for transaction in rows:
                    key = transaction_key(transaction)
                    keys.add(key)
                    if day := transaction_date(transaction):
                        dates.append(day)
                    if key not in seen:
                        new.append(transaction)
                continuation_key = page.get("continuation_key")
                if not continuation_key:
                    seen.update(keys)
                    return new, sorted(dates), len(rows) >= CAPPED_PAGE_SIZE
                request = {**request, "continuation_key": continuation_key}

        first, dates, capped = fetch(params)
        yield from first
        if not capped:
            return

        # Ask again in explicit windows, from the earliest date the bank might hold to the end of the range.
        today = date.today().isoformat()
        lookback = (date.today() - timedelta(days=CAPPED_LOOKBACK_DAYS)).isoformat()
        start = params.get("date_from") or min([lookback, *dates[:1]])
        end = params.get("date_to") or max([today, *dates[-1:]])
        windows = [(start, end)]
        requests = 0
        while windows and requests < CAPPED_MAX_REQUESTS:
            low, high = windows.pop()
            rows, got, capped = fetch({"date_from": low, "date_to": high})
            requests += 1
            yield from rows
            if not capped:
                continue
            days = (date.fromisoformat(high) - date.fromisoformat(low)).days
            if days < 1:
                continue  # a full page within one day: there's no smaller window to ask for
            # Split the window in two and ask for both halves, whatever part the bank chose to return.
            middle = date.fromisoformat(low) + timedelta(days=days // 2)
            windows += [(low, middle.isoformat()), ((middle + timedelta(days=1)).isoformat(), high)]

