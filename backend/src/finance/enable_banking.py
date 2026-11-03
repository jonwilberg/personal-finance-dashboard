"""Minimal client for the Enable Banking API.

Reference: https://enablebanking.com/docs/api/reference/
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Iterator
from datetime import date, datetime
from pathlib import Path
from typing import Any

import httpx
import jwt

API_URL = "https://api.enablebanking.com"
# The API rejects tokens with a lifetime above 24 hours; one hour matches the official samples.
TOKEN_TTL_SECONDS = 3600


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
    ) -> Iterator[dict[str, Any]]:
        """Yield every transaction in the range, following `continuation_key` pagination."""
        params: dict[str, str] = {}
        if date_from:
            params["date_from"] = date_from.isoformat()
        if date_to:
            params["date_to"] = date_to.isoformat()
        while True:
            page = self._request("GET", f"/accounts/{account_uid}/transactions", params=params)
            yield from page.get("transactions", [])
            continuation_key = page.get("continuation_key")
            if not continuation_key:
                return
            params["continuation_key"] = continuation_key
