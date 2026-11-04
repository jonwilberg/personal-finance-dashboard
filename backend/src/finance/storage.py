"""Local storage: one SQLite database per environment (data/finance.db or data/<env>/finance.db).

Holds bank connections, accounts, balances, raw transactions as the bank sent them, and your categorization
choices and rules. Earlier versions kept the same data in JSON files; those are imported once and moved to
data/json-backup/.
"""

from __future__ import annotations

import json
import re
import shutil
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from finance.categories import DEFAULT_CATEGORIES, KINDS, SPLIT_CATEGORIES, Category
from finance.categorize import CategorizationSettings, Rule, keyword_category
from finance.transactions import transaction_date, unique_transaction_keys

DATABASE_FILE = "finance.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- A consent given at one bank. Accounts belong to the session they were authorized in.
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    aspsp_name TEXT NOT NULL,
    aspsp_country TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
    uid TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    name TEXT,
    product TEXT,
    iban TEXT,
    currency TEXT,
    cash_account_type TEXT,
    identifiers TEXT NOT NULL DEFAULT '[]'  -- JSON list of account numbers
);

-- Latest balances per account, as the bank sent them (JSON).
CREATE TABLE IF NOT EXISTS balances (
    account_uid TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    balances TEXT NOT NULL
);

-- Raw transactions as the bank sent them. Kept when a connection is removed, so history isn't lost.
CREATE TABLE IF NOT EXISTS transactions (
    account_uid TEXT NOT NULL,
    transaction_key TEXT NOT NULL,
    position INTEGER NOT NULL,  -- order within the bank's response
    booking_date TEXT,
    raw TEXT NOT NULL,
    PRIMARY KEY (account_uid, transaction_key)
);
CREATE INDEX IF NOT EXISTS transactions_by_date ON transactions (booking_date);

CREATE TABLE IF NOT EXISTS transaction_fetches (
    account_uid TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL
);

-- Categories you set on single transactions. transaction_id is "<account uid>:<transaction key>".
CREATE TABLE IF NOT EXISTS category_overrides (
    transaction_id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Your rules: transactions whose text contains the pattern get the category.
CREATE TABLE IF NOT EXISTS category_rules (
    pattern TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- Categories you can rename, change, add and delete. Seeded from categories.DEFAULT_CATEGORIES.
CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,          -- expense, income, saving, loan or transfer (see categories.KINDS)
    fixed INTEGER NOT NULL DEFAULT 0,
    system INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL
);
"""


class CategoryError(Exception):
    pass


class Storage:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.path = data_dir / DATABASE_FILE
        data_dir.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript(SCHEMA)
        _import_json_files(self)
        _seed_categories(self)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        """A connection per operation, committed on success. Safe to use from the web server's threads."""
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    # Connections

    def sessions(self) -> list[dict[str, Any]]:
        with self._connect() as db:
            sessions = db.execute("SELECT * FROM sessions ORDER BY created_at").fetchall()
            accounts = db.execute("SELECT * FROM accounts ORDER BY session_id, position").fetchall()
        by_session: dict[str, list[dict[str, Any]]] = {}
        for row in accounts:
            by_session.setdefault(row["session_id"], []).append(
                {
                    "uid": row["uid"],
                    "name": row["name"],
                    "product": row["product"],
                    "iban": row["iban"],
                    "currency": row["currency"],
                    "cash_account_type": row["cash_account_type"],
                    "identifiers": json.loads(row["identifiers"]),
                }
            )
        return [
            {
                "session_id": row["session_id"],
                "aspsp": {"name": row["aspsp_name"], "country": row["aspsp_country"]},
                "valid_until": row["valid_until"],
                "created_at": row["created_at"],
                "accounts": by_session.get(row["session_id"], []),
            }
            for row in sessions
        ]

    def add_session(self, record: dict[str, Any]) -> None:
        with self._connect() as db:
            db.execute("DELETE FROM sessions WHERE session_id = ?", (record["session_id"],))
            db.execute(
                "INSERT INTO sessions VALUES (?, ?, ?, ?, ?)",
                (
                    record["session_id"],
                    record["aspsp"]["name"],
                    record["aspsp"]["country"],
                    record["valid_until"],
                    record.get("created_at") or _now(),
                ),
            )
            db.executemany(
                "INSERT OR REPLACE INTO accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        account["uid"],
                        record["session_id"],
                        position,
                        account.get("name"),
                        account.get("product"),
                        account.get("iban"),
                        account.get("currency"),
                        account.get("cash_account_type"),
                        json.dumps(account.get("identifiers") or []),
                    )
                    for position, account in enumerate(record["accounts"])
                ],
            )

    def remove_session(self, session_id: str) -> None:
        with self._connect() as db:
            db.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))

    def has_account(self, account_uid: str) -> bool:
        with self._connect() as db:
            return db.execute("SELECT 1 FROM accounts WHERE uid = ?", (account_uid,)).fetchone() is not None

    def account_needs_numbers(self, account_uid: str) -> bool:
        """True for a bank account (not a card) whose account numbers we don't know yet."""
        with self._connect() as db:
            row = db.execute(
                "SELECT iban, identifiers, cash_account_type FROM accounts WHERE uid = ?", (account_uid,)
            ).fetchone()
        return bool(row) and row["cash_account_type"] != "CARD" and not row["iban"] and row["identifiers"] == "[]"

    def set_account_identifiers(self, account_uid: str, identifiers: list[str]) -> None:
        with self._connect() as db:
            db.execute(
                "UPDATE accounts SET identifiers = ? WHERE uid = ?", (json.dumps(sorted(set(identifiers))), account_uid)
            )

    # Balances

    def save_balances(self, account_uid: str, balances: list[dict[str, Any]]) -> None:
        with self._connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO balances VALUES (?, ?, ?)", (account_uid, _now(), json.dumps(balances))
            )

    def load_balances(self, account_uid: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM balances WHERE account_uid = ?", (account_uid,)).fetchone()
        return {"fetched_at": row["fetched_at"], "balances": json.loads(row["balances"])} if row else None

    # Transactions

    def save_transactions(
        self, account_uid: str, transactions: list[dict[str, Any]], fetched_at: str | None = None
    ) -> None:
        """Replace the account's transactions with what the bank returned (pending ones may have changed)."""
        with self._connect() as db:
            db.execute("DELETE FROM transactions WHERE account_uid = ?", (account_uid,))
            db.executemany(
                "INSERT INTO transactions VALUES (?, ?, ?, ?, ?)",
                [
                    (account_uid, key, position, transaction_date(t) or None, json.dumps(t, ensure_ascii=False))
                    for position, (t, key) in enumerate(zip(transactions, unique_transaction_keys(transactions)))
                ],
            )
            db.execute(
                "INSERT OR REPLACE INTO transaction_fetches VALUES (?, ?)", (account_uid, fetched_at or _now())
            )

    def load_transactions(self, account_uid: str) -> list[dict[str, Any]] | None:
        """The account's raw transactions, or None if they were never fetched."""
        with self._connect() as db:
            if not db.execute("SELECT 1 FROM transaction_fetches WHERE account_uid = ?", (account_uid,)).fetchone():
                return None
            rows = db.execute(
                "SELECT raw FROM transactions WHERE account_uid = ? ORDER BY position", (account_uid,)
            ).fetchall()
        return [json.loads(row["raw"]) for row in rows]

    def transactions_fetched_at(self, account_uid: str) -> str | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT fetched_at FROM transaction_fetches WHERE account_uid = ?", (account_uid,)
            ).fetchone()
        return row["fetched_at"] if row else None

    def raw_transactions_by_account(self) -> dict[str, list[dict[str, Any]]]:
        """Raw transactions of every connected account."""
        with self._connect() as db:
            rows = db.execute(
                "SELECT t.account_uid, t.raw FROM transactions t JOIN accounts a ON a.uid = t.account_uid "
                "ORDER BY t.account_uid, t.position"
            ).fetchall()
            account_uids = [row["uid"] for row in db.execute("SELECT uid FROM accounts")]
        result: dict[str, list[dict[str, Any]]] = {uid: [] for uid in account_uids}
        for row in rows:
            result[row["account_uid"]].append(json.loads(row["raw"]))
        return result

    def has_transaction(self, transaction_id: str) -> bool:
        account_uid, _, key = transaction_id.partition(":")
        with self._connect() as db:
            return (
                db.execute(
                    "SELECT 1 FROM transactions WHERE account_uid = ? AND transaction_key = ?", (account_uid, key)
                ).fetchone()
                is not None
            )

    # Categorization

    def categorization(self) -> CategorizationSettings:
        with self._connect() as db:
            overrides = {row["transaction_id"]: row["category"] for row in db.execute("SELECT * FROM category_overrides")}
            rules = [Rule(row["pattern"], row["category"]) for row in db.execute("SELECT * FROM category_rules ORDER BY created_at")]
        return CategorizationSettings(overrides=overrides, rules=rules, categories=self.categories())

    # Categories

    def categories(self) -> list[Category]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM categories ORDER BY position, name").fetchall()
        return [Category(r["id"], r["name"], r["kind"], bool(r["fixed"]), bool(r["system"])) for r in rows]

    def category(self, category_id: str) -> Category | None:
        return next((c for c in self.categories() if c.id == category_id), None)

    def rule_counts(self) -> dict[str, int]:
        with self._connect() as db:
            rows = db.execute("SELECT category, count(*) AS n FROM category_rules GROUP BY category").fetchall()
        return {row["category"]: row["n"] for row in rows}

    def add_category(self, name: str, kind: str, fixed: bool = False) -> Category:
        name = _category_name(name)
        _check_kind(kind)
        with self._connect() as db:
            taken = {row["id"] for row in db.execute("SELECT id FROM categories")}
            category_id = _unique_slug(name, taken)
            position = db.execute("SELECT coalesce(max(position), -1) + 1 FROM categories").fetchone()[0]
            db.execute(
                "INSERT INTO categories VALUES (?, ?, ?, ?, 0, ?)", (category_id, name, kind, int(fixed), position)
            )
        return Category(category_id, name, kind, fixed)

    def update_category(
        self, category_id: str, *, name: str | None = None, kind: str | None = None, fixed: bool | None = None
    ) -> Category:
        current = self.category(category_id)
        if current is None:
            raise CategoryError("Unknown category")
        if kind is not None:
            _check_kind(kind)
            if current.system and kind != current.kind:
                raise CategoryError(f"{current.name} is used by the app itself, so its type can't change")
        updated = Category(
            category_id,
            _category_name(name) if name is not None else current.name,
            kind or current.kind,
            current.fixed if fixed is None else fixed,
            current.system,
        )
        with self._connect() as db:
            db.execute(
                "UPDATE categories SET name = ?, kind = ?, fixed = ? WHERE id = ?",
                (updated.name, updated.kind, int(updated.fixed), category_id),
            )
        return updated

    def delete_category(self, category_id: str, move_to: str | None = None) -> None:
        """Delete a category. Your rules and choices for it move to `move_to`, or are removed (back to review)."""
        current = self.category(category_id)
        if current is None:
            raise CategoryError("Unknown category")
        if current.system:
            raise CategoryError(f"{current.name} is used by the app itself and can't be deleted")
        if move_to is not None and (move_to == category_id or self.category(move_to) is None):
            raise CategoryError("Choose another existing category to move to")
        with self._connect() as db:
            if move_to is None:
                db.execute("DELETE FROM category_rules WHERE category = ?", (category_id,))
                db.execute("DELETE FROM category_overrides WHERE category = ?", (category_id,))
            else:
                db.execute("UPDATE category_rules SET category = ? WHERE category = ?", (move_to, category_id))
                db.execute("UPDATE category_overrides SET category = ? WHERE category = ?", (move_to, category_id))
            db.execute("DELETE FROM categories WHERE id = ?", (category_id,))

    def set_override(self, transaction_id: str, category: str | None) -> None:
        """Set your category for one transaction, or remove it (None) so the automatic category applies."""
        with self._connect() as db:
            if category is None:
                db.execute("DELETE FROM category_overrides WHERE transaction_id = ?", (transaction_id,))
            else:
                db.execute(
                    "INSERT OR REPLACE INTO category_overrides VALUES (?, ?, ?)", (transaction_id, category, _now())
                )

    def add_rule(self, pattern: str, category: str) -> None:
        with self._connect() as db:
            db.execute("INSERT OR REPLACE INTO category_rules VALUES (?, ?, ?)", (pattern.upper(), category, _now()))

    def delete_rule(self, pattern: str) -> bool:
        with self._connect() as db:
            return db.execute("DELETE FROM category_rules WHERE pattern = ?", (pattern.upper(),)).rowcount > 0

    # Meta

    def _meta(self, key: str) -> str | None:
        with self._connect() as db:
            row = db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def _set_meta(self, key: str, value: str) -> None:
        with self._connect() as db:
            db.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (key, value))


def _import_json_files(storage: Storage) -> None:
    """One-time import of the JSON files earlier versions wrote, which are then moved to json-backup/."""
    data_dir = storage.data_dir
    legacy = [data_dir / name for name in ("sessions.json", "balances.json", "categorization.json", "transactions")]
    if storage._meta("json_imported_at") or not any(p.exists() for p in legacy):
        return

    sessions = _read_json(data_dir / "sessions.json", [])
    for record in sessions:
        storage.add_session(record)

    for account_uid, entry in _read_json(data_dir / "balances.json", {}).items():
        with storage._connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO balances VALUES (?, ?, ?)",
                (account_uid, entry["fetched_at"], json.dumps(entry["balances"])),
            )

    transactions_dir = data_dir / "transactions"
    if transactions_dir.is_dir():
        for path in sorted(transactions_dir.glob("*.json")):
            fetched_at = datetime.fromtimestamp(path.stat().st_mtime, UTC).isoformat()
            storage.save_transactions(path.stem, _read_json(path, []), fetched_at=fetched_at)

    categorization = _read_json(data_dir / "categorization.json", {})
    for transaction_id, category in categorization.get("overrides", {}).items():
        storage.set_override(transaction_id, category)
    for rule in categorization.get("rules", []):
        storage.add_rule(rule["pattern"], rule["category"])

    backup = data_dir / "json-backup"
    backup.mkdir(exist_ok=True)
    for path in legacy:
        if path.exists():
            shutil.move(str(path), str(backup / path.name))
    storage._set_meta("json_imported_at", _now())


def _read_json(path: Path, default: Any) -> Any:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _seed_categories(storage: Storage) -> None:
    """Copy the default categories into the database once, and move rules from categories that were split."""
    if storage._meta("categories_seeded_at"):
        return
    with storage._connect() as db:
        db.executemany(
            "INSERT OR IGNORE INTO categories VALUES (?, ?, ?, ?, ?, ?)",
            [(c.id, c.name, c.kind, int(c.fixed), int(c.system), i) for i, c in enumerate(DEFAULT_CATEGORIES)],
        )
        for old, (targets, fallback) in SPLIT_CATEGORIES.items():
            for row in db.execute("SELECT pattern FROM category_rules WHERE category = ?", (old,)).fetchall():
                db.execute(
                    "UPDATE category_rules SET category = ? WHERE pattern = ?",
                    (keyword_category(row["pattern"], targets) or fallback, row["pattern"]),
                )
            db.execute("UPDATE category_overrides SET category = ? WHERE category = ?", (fallback, old))
    storage._set_meta("categories_seeded_at", _now())


def _category_name(name: str) -> str:
    name = " ".join(name.split())
    if not name:
        raise CategoryError("A category needs a name")
    if len(name) > 60:
        raise CategoryError("Keep the name under 60 characters")
    return name


def _check_kind(kind: str) -> None:
    if kind not in KINDS:
        raise CategoryError(f"Unknown type {kind!r}")


def _unique_slug(name: str, taken: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "_", name.lower().replace("æ", "ae").replace("ø", "o").replace("å", "a")).strip("_")
    base = base or "category"
    slug, n = base, 2
    while slug in taken:
        slug, n = f"{base}_{n}", n + 1
    return slug
