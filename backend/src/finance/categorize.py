"""Turns raw bank transactions into normalized, categorized transactions.

For each transaction, the first of these that applies decides its category:

1. Your manual choice for that transaction.
2. Transfer between your own accounts: the other party's account number is one of yours, or it's a card bill
   payment, or a matching amount leaves one of your accounts and arrives in another within a few days.
3. Your own rules: the transaction text contains a pattern you saved.
4. Built-in keywords: income keywords (money in only), then merchant keywords (see categories.py).
5. The bank's own merchant category, where the bank sends one.
6. Interest, by bank transaction code.

Anything left is uncategorized and shows up for review.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

from finance.categories import (
    BANK_CATEGORY_HINTS,
    CARD_PAYMENT_CODES,
    DEFAULT_CATEGORIES,
    INCOME_KEYWORDS,
    INTEREST_CODES,
    MERCHANT_KEYWORDS,
    Category,
)
from finance.transactions import description, signed_amount, transaction_date, unique_transaction_keys

# Kinds of category that aren't spending: money put into savings, loan payments and transfers between own accounts.
NOT_SPENDING_KINDS = {"saving", "loan", "transfer"}

# Days between a card bill payment leaving a bank account and arriving on the card.
CARD_PAYMENT_WINDOW_DAYS = 7
# Days between the two legs of a transfer between your own accounts.
TRANSFER_WINDOW_DAYS = 3

# Parts of payment texts that vary between purchases at the same merchant.
_NOISE = [
    r"\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b",  # dates like 12.10 or 12.10.26
    r"\b(?:KL\.?\s*)?\d{1,2}:\d{2}(?::\d{2})?\b",  # times, optionally after "kl"
    r"\b(?:NOK|EUR|USD|SEK|DKK|GBP)\s*-?\d[\d .,]*",  # amounts with currency
    r"\b\d+[.,]\d{2}\b",  # bare amounts
    r"[*Xx]{3,}\d{2,4}|\b\d{4,6}[*Xx]{3,}\d{0,4}|\*\d{4}\b",  # masked card numbers
    r"\b\d{5,}\b",  # references and long numbers
    # Months and years, as in "Terminbeløp okt. 2026" (Norwegian and English month names and abbreviations).
    r"\b(?:JANUAR|FEBRUAR|MARS|APRIL|JUNI|JULI|AUGUST|SEPTEMBER|OKTOBER|NOVEMBER|DESEMBER|JANUARY|FEBRUARY|"
    r"MARCH|JUNE|JULY|OCTOBER|DECEMBER|JAN|FEB|MAR|APR|MAI|MAY|JUN|JUL|AUG|SEP|SEPT|OKT|OCT|NOV|DES|DEC)\b\.?"
    r"(?:\s*(?:19|20)\d{2}\b)?",
    r"\b(?:19|20)\d{2}\b(?=\s*$|\s*[|/-])",  # a year at the end of a text or segment
    r"\b(?:VISA|MASTERCARD|KORTKJØP|KORTKJOP|VAREKJØP|VAREKJOP|BETALING|RESERVASJON|RESERVERT|KURS|VALUTA)\b",
]
_NOISE_RE = re.compile("|".join(_NOISE), re.IGNORECASE)
_SPACES_RE = re.compile(r"\s+")
_WORD = "A-Z0-9ÆØÅÄÖÜ"


def clean_text(text: str) -> str:
    """Upper-case text with dates, amounts, card numbers and references removed, for matching merchants."""
    cleaned = _NOISE_RE.sub(" ", text.upper())
    return _SPACES_RE.sub(" ", cleaned).strip(" -*/.,:;")


def _keyword_regex(keywords: list[str]) -> re.Pattern[str]:
    alternatives = "|".join(re.escape(k) for k in sorted(keywords, key=len, reverse=True))
    return re.compile(rf"(?<![{_WORD}])(?:{alternatives})(?![{_WORD}])")


_MERCHANT_PATTERNS = [(category, _keyword_regex(words)) for category, words in MERCHANT_KEYWORDS.items()]
_INCOME_PATTERNS = [(category, _keyword_regex(words)) for category, words in INCOME_KEYWORDS.items()]


def keyword_category(text: str, allowed: list[str]) -> str | None:
    """The first of the `allowed` categories whose built-in merchant keywords match the text, if any."""
    patterns = dict(_MERCHANT_PATTERNS)
    return next((c for c in allowed if c in patterns and patterns[c].search(text.upper())), None)


@dataclass
class Rule:
    pattern: str
    category: str

    def matches(self, text: str) -> bool:
        return self.pattern.upper() in text


@dataclass
class CategorizationSettings:
    """Your categories, the categories you set on single transactions, and your saved rules."""

    overrides: dict[str, str] = field(default_factory=dict)
    rules: list[Rule] = field(default_factory=list)
    categories: list[Category] = field(default_factory=lambda: list(DEFAULT_CATEGORIES))

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> CategorizationSettings:
        return cls(
            overrides=dict(data.get("overrides", {})),
            rules=[Rule(r["pattern"], r["category"]) for r in data.get("rules", [])],
        )

    def to_json(self) -> dict[str, Any]:
        return {"overrides": self.overrides, "rules": [{"pattern": r.pattern, "category": r.category} for r in self.rules]}


@dataclass
class Account:
    uid: str
    bank: str
    label: str
    is_card: bool
    numbers: set[str]


def accounts_from_sessions(sessions: list[dict[str, Any]]) -> list[Account]:
    accounts = []
    for session in sessions:
        for account in session["accounts"]:
            numbers = {n for n in [account.get("iban"), *account.get("identifiers", [])] if n}
            label = account.get("product") or account.get("name") or account.get("cash_account_type") or "Account"
            if account.get("iban"):
                label = f"{label} ••{account['iban'][-4:]}"
            accounts.append(
                Account(
                    uid=account["uid"],
                    bank=session["aspsp"]["name"],
                    label=label,
                    is_card=account.get("cash_account_type") == "CARD",
                    numbers={_digits(n) for n in numbers},
                )
            )
    return accounts


def normalize(account: Account, raw: dict[str, Any], key: str) -> dict[str, Any]:
    is_debit = raw.get("credit_debit_indicator") == "DBIT"
    counterparty = (raw.get("creditor") if is_debit else raw.get("debtor")) or {}
    counterparty_account = (raw.get("creditor_account") if is_debit else raw.get("debtor_account")) or {}
    remittance = [line for line in raw.get("remittance_information") or [] if line]
    name = counterparty.get("name") or ""
    code = raw.get("bank_transaction_code") or {}
    number = _digits(counterparty_account.get("iban") or (counterparty_account.get("other") or {}).get("identification") or "")
    merchant = clean_text(name) if name else _payee_from_lines(remittance)
    text = clean_text(" ".join([name, *remittance]))
    if number:
        # Account numbers are stripped from the text as noise; keep the other party's number in a form rules can match.
        text = f"{text} KONTO {number}".strip()
        if _is_generic(merchant):
            merchant = f"KONTO {number}"
    return {
        "id": f"{account.uid}:{key}",
        "account_uid": account.uid,
        "account": account.label,
        "bank": account.bank,
        "date": transaction_date(raw),
        "amount": signed_amount(raw),
        "currency": (raw.get("transaction_amount") or {}).get("currency"),
        "direction": raw.get("credit_debit_indicator"),
        "status": raw.get("status"),
        "description": description(raw),
        "merchant": merchant,
        "text": text,
        "counterparty_account": number,
        "bank_code": str(code.get("code") or "").upper(),
        "bank_category": str(code.get("description") or "").upper(),
        "category": None,
        "category_source": None,
    }


def own_account_numbers(accounts: list[Account], raw_by_account: dict[str, list[dict[str, Any]]]) -> set[str]:
    """Your account numbers: from the connections, plus the own side of each transaction."""
    numbers = set().union(*(a.numbers for a in accounts)) if accounts else set()
    for account in accounts:
        if account.is_card:
            continue  # the own side of card transactions holds masked card numbers
        for raw in raw_by_account.get(account.uid, []):
            own = (raw.get("debtor_account") if raw.get("credit_debit_indicator") == "DBIT" else raw.get("creditor_account")) or {}
            number = own.get("iban") or (own.get("other") or {}).get("identification")
            if number:
                numbers.add(_digits(number))
    numbers.discard("")
    # Norwegian IBANs end with the 11-digit domestic account number banks often send instead.
    return numbers | {n[-11:] for n in numbers if len(n) > 11}


def find_transfers(transactions: list[dict[str, Any]], accounts: list[Account], own_numbers: set[str]) -> set[str]:
    cards = {a.uid for a in accounts if a.is_card}
    transfers: set[str] = set()

    for t in transactions:
        number = t["counterparty_account"]
        if number and (number in own_numbers or number[-11:] in own_numbers):
            transfers.add(t["id"])

    # Card bill payments arrive on the card as a payment; the matching debit leaves a bank account.
    card_payments = [
        t for t in transactions
        if t["account_uid"] in cards and t["direction"] == "CRDT" and t["bank_code"] in CARD_PAYMENT_CODES
    ]
    transfers.update(t["id"] for t in card_payments)
    for payment in card_payments:
        _pair(payment, transactions, transfers, CARD_PAYMENT_WINDOW_DAYS, exclude_accounts=cards)

    # Same amount leaving one of your accounts and arriving in another shortly after.
    for credit in (t for t in transactions if t["direction"] == "CRDT" and t["id"] not in transfers):
        _pair(credit, transactions, transfers, TRANSFER_WINDOW_DAYS, exclude_accounts={credit["account_uid"]}, mark_self=True)
    return transfers


def _pair(credit, transactions, transfers, window_days, exclude_accounts, mark_self=False) -> None:
    for debit in transactions:
        if (
            debit["direction"] == "DBIT"
            and debit["id"] not in transfers
            and debit["account_uid"] not in exclude_accounts
            and -debit["amount"] == credit["amount"]
            and _days_apart(debit["date"], credit["date"]) <= window_days
        ):
            transfers.add(debit["id"])
            if mark_self:
                transfers.add(credit["id"])
            return


def categorize(transactions: list[dict[str, Any]], settings: CategorizationSettings, transfers: set[str]) -> None:
    kinds = {c.id: c.kind for c in settings.categories}
    # Rules and built-in keywords for categories that no longer exist are skipped.
    rules = sorted((r for r in settings.rules if r.category in kinds), key=lambda r: len(r.pattern), reverse=True)
    for t in transactions:
        category, source = _decide(t, settings.overrides, rules, transfers, kinds)
        t["category"], t["category_source"], t["kind"] = category, source, kinds.get(category)


def _decide(t, overrides, rules, transfers, kinds) -> tuple[str | None, str | None]:
    if (chosen := overrides.get(t["id"])) in kinds:
        return chosen, "manual"
    if t["id"] in transfers and "transfer" in kinds:
        return "transfer", "transfer"
    for rule in rules:
        if rule.matches(t["text"]):
            return rule.category, "rule"
    if t["direction"] == "CRDT":
        for category, pattern in _INCOME_PATTERNS:
            if category in kinds and pattern.search(t["text"]):
                return category, "keyword"
    for category, pattern in _MERCHANT_PATTERNS:
        if category in kinds and pattern.search(t["text"]):
            return category, "keyword"
    if t["bank_code"] in INTEREST_CODES:
        category = "fees" if t["direction"] == "DBIT" else "other_income"
        if category in kinds:
            return category, "bank"
    if _is_merchant_category(t["bank_category"]):
        for hint, category in BANK_CATEGORY_HINTS:
            if category in kinds and hint in t["bank_category"]:
                return category, "bank"
    return None, None


def _is_merchant_category(description: str) -> bool:
    """Card-scheme merchant categories ("GROCERY STORES/SUPERMARKETS"), not technical ISO 20022 codes such as
    "BOOK", "PMNT" or "OTHR" that some banks send in the same field."""
    return bool(description.strip()) and not re.fullmatch(r"[A-Z]{4}", description.strip())


def categorized_transactions(
    sessions: list[dict[str, Any]],
    raw_by_account: dict[str, list[dict[str, Any]]],
    settings: CategorizationSettings,
) -> list[dict[str, Any]]:
    """All transactions, normalized and categorized, newest first."""
    accounts = accounts_from_sessions(sessions)
    transactions = [
        normalize(account, raw, key)
        for account in accounts
        for raw, key in zip(raw_by_account.get(account.uid, []), unique_transaction_keys(raw_by_account.get(account.uid, [])))
    ]
    transfers = find_transfers(transactions, accounts, own_account_numbers(accounts, raw_by_account))
    categorize(transactions, settings, transfers)
    transactions.sort(key=lambda t: (t["date"], t["id"]), reverse=True)
    return transactions


def summarize_categorization(transactions: list[dict[str, Any]]) -> dict[str, Any]:
    """Coverage numbers without any transaction text, for checking how well categorization works."""
    by_source: dict[str, int] = {}
    by_category: dict[str, int] = {}
    uncategorized_spend = Decimal()
    total_spend = Decimal()
    for t in transactions:
        source = t["category_source"] or "uncategorized"
        by_source[source] = by_source.get(source, 0) + 1
        by_category[t["category"] or "uncategorized"] = by_category.get(t["category"] or "uncategorized", 0) + 1
        # Spending: money out, except transfers, savings and loan payments.
        if t["direction"] == "DBIT" and t.get("kind") not in NOT_SPENDING_KINDS:
            total_spend -= t["amount"]
            if t["category"] is None:
                uncategorized_spend -= t["amount"]
    count = len(transactions)
    uncategorized = by_source.get("uncategorized", 0)
    return {
        "count": count,
        "categorized_share": (count - uncategorized) / count if count else 1.0,
        "uncategorized": uncategorized,
        "uncategorized_spend_share": float(uncategorized_spend / total_spend) if total_spend else 0.0,
        "by_source": by_source,
        "by_category": by_category,
    }


_GENERIC_WORDS_RE = re.compile(r"\b(?:TIL|FRA|BETALT|OVERFØRING|OVERFORING|DATO|KONTO|AVTALEGIRO|EFAKTURA|GIRO)\b")


def _payee_core(text: str) -> str:
    """Cleaned text without words like "Til:" and "Betalt:" that say nothing about the payee."""
    return _SPACES_RE.sub(" ", _GENERIC_WORDS_RE.sub(" ", text)).strip(" -*/.,:;|")


def _is_generic(merchant: str) -> bool:
    """True when the text says nothing about the payee, e.g. "TIL: . BETALT" once numbers are removed."""
    return len(re.sub(r"[^A-ZÆØÅÄÖÜ]", "", _payee_core(merchant))) < 3


def _payee_from_lines(lines: list[str]) -> str:
    """The payee from the first text line that names one. Banks often put a reference number on the first line
    ("123456789012") and the payee on the next ("Til: Kortselskap Finans AS Betalt: 30.10.26")."""
    for line in lines:
        core = _payee_core(clean_text(line))
        if not _is_generic(core):
            return core
    return ""


def _digits(value: str) -> str:
    return re.sub(r"\D", "", value or "")


def _days_apart(a: str, b: str) -> int:
    if not a or not b:
        return 10**6
    return abs((date.fromisoformat(a) - date.fromisoformat(b)).days)
