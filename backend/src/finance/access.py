"""Who may use the app when it's hosted: Cloudflare Access lets through only the people on its policy (a Google
login for the allowed emails) and signs every request it lets through. The app checks that signature on every
request, so nothing reaches it without passing Cloudflare's login for this app, even through some other way in.
Who is allowed is decided in Cloudflare alone.

Cloudflare Access sends its token in the Cf-Access-Jwt-Assertion header (and the CF_Authorization cookie). It's an
RS256 JWT signed with keys published at https://<team domain>/cdn-cgi/access/certs, with the Access application's
audience tag as "aud" and the team domain as issuer. See docs/hosting.md.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

import jwt

HEADER = "Cf-Access-Jwt-Assertion"
COOKIE = "CF_Authorization"


class AccessDenied(Exception):
    pass


@dataclass(frozen=True)
class AccessSettings:
    # e.g. "yourteam.cloudflareaccess.com"
    team_domain: str
    # The Access application's "Application Audience (AUD) Tag".
    audience: str

    @property
    def issuer(self) -> str:
        return f"https://{self.team_domain}"

    @property
    def certs_url(self) -> str:
        return f"{self.issuer}/cdn-cgi/access/certs"


class SigningKeys(Protocol):
    def get_signing_key_from_jwt(self, token: str) -> Any: ...


class AccessVerifier:
    def __init__(self, settings: AccessSettings, keys: SigningKeys | None = None):
        self.settings = settings
        # Cloudflare rotates its keys; PyJWKClient caches them and fetches again for a key id it doesn't know.
        self.keys = keys or jwt.PyJWKClient(settings.certs_url, cache_keys=True, lifespan=3600, timeout=10)

    def email(self, token: str | None) -> str:
        """The signed-in email, if the token is a valid Access login for this app; otherwise AccessDenied."""
        if not token:
            raise AccessDenied("Not signed in through Cloudflare Access")
        try:
            key = self.keys.get_signing_key_from_jwt(token).key
            claims = jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                audience=self.settings.audience,
                issuer=self.settings.issuer,
                options={"require": ["exp", "iat", "aud", "iss"]},
                leeway=30,
            )
        except (jwt.PyJWTError, jwt.PyJWKClientError) as error:
            raise AccessDenied(f"Invalid Access token: {error}") from error
        email = str(claims.get("email", "")).strip().lower()
        if not email:
            raise AccessDenied("The Access token has no signed-in email")
        return email
