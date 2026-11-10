from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[2]


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Settings:
    application_id: str
    private_key_path: Path
    # None means "use the first redirect URL registered on the application".
    redirect_url: str | None
    data_dir: Path
    # Where the web app sends the browser after a bank login: "/" when the backend serves the built
    # frontend, or the Vite dev server (e.g. http://localhost:5173/) during frontend development.
    frontend_url: str = "/"


def load_settings(env_name: str | None = None) -> Settings:
    """Load settings from backend/.env, or from backend/.env.<env_name> when an environment is named.

    Named environments (e.g. "production") default to their own data folder, data/<env_name>,
    so sandbox and production sessions never mix.
    """
    env_file = BACKEND_DIR / (f".env.{env_name}" if env_name else ".env")
    if env_name and not env_file.is_file():
        raise ConfigError(f"{env_file} not found. Copy backend/.env.example to it and fill it in.")
    load_dotenv(env_file)

    application_id = os.getenv("ENABLE_BANKING_APP_ID", "").strip()
    key_path = os.getenv("ENABLE_BANKING_KEY_PATH", "").strip()
    missing = [
        name
        for name, value in [("ENABLE_BANKING_APP_ID", application_id), ("ENABLE_BANKING_KEY_PATH", key_path)]
        if not value
    ]
    if missing:
        raise ConfigError(f"Missing {', '.join(missing)} in {env_file}.")

    private_key_path = Path(key_path).expanduser()
    if not private_key_path.is_file():
        raise ConfigError(f"Private key not found at {private_key_path} (ENABLE_BANKING_KEY_PATH).")

    default_data_dir = BACKEND_DIR / "data" / env_name if env_name else BACKEND_DIR / "data"
    data_dir = Path(os.getenv("FINANCE_DATA_DIR", "") or default_data_dir).expanduser()
    return Settings(
        application_id=application_id,
        private_key_path=private_key_path,
        redirect_url=os.getenv("ENABLE_BANKING_REDIRECT_URL", "").strip() or None,
        data_dir=data_dir,
        frontend_url=os.getenv("FINANCE_FRONTEND_URL", "").strip() or "/",
    )
