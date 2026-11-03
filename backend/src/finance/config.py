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


def load_settings() -> Settings:
    load_dotenv(BACKEND_DIR / ".env")

    application_id = os.getenv("ENABLE_BANKING_APP_ID", "").strip()
    key_path = os.getenv("ENABLE_BANKING_KEY_PATH", "").strip()
    missing = [
        name
        for name, value in [("ENABLE_BANKING_APP_ID", application_id), ("ENABLE_BANKING_KEY_PATH", key_path)]
        if not value
    ]
    if missing:
        raise ConfigError(
            f"Missing {', '.join(missing)}. Copy backend/.env.example to backend/.env and fill it in."
        )

    private_key_path = Path(key_path).expanduser()
    if not private_key_path.is_file():
        raise ConfigError(f"Private key not found at {private_key_path} (ENABLE_BANKING_KEY_PATH).")

    data_dir = Path(os.getenv("FINANCE_DATA_DIR", "") or BACKEND_DIR / "data").expanduser()
    return Settings(
        application_id=application_id,
        private_key_path=private_key_path,
        redirect_url=os.getenv("ENABLE_BANKING_REDIRECT_URL", "").strip() or None,
        data_dir=data_dir,
    )
