"""Category list and the built-in rules that map transactions to categories.

Rules match against a transaction's cleaned, upper-case text (merchant name plus payment text), so keywords
are written in upper case. A keyword matches whole words: "MAX" matches "MAX BURGERS" but not "MAXIMUM".
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Category:
    id: str
    name: str
    # "expense" counts as spending and "income" as money in. "saving" (money put into savings or investments) and
    # "transfer" (money moving between your own accounts) are left out of both; saving is tracked on its own.
    kind: str


CATEGORIES = [
    Category("groceries", "Groceries", "expense"),
    Category("eating_out", "Eating out", "expense"),
    Category("transport", "Transport", "expense"),
    Category("travel", "Travel", "expense"),
    Category("housing", "Housing", "expense"),
    Category("bills", "Bills and utilities", "expense"),
    Category("shopping", "Shopping", "expense"),
    Category("subscriptions", "Subscriptions", "expense"),
    Category("health", "Health and fitness", "expense"),
    Category("leisure", "Leisure", "expense"),
    Category("fees", "Fees and interest", "expense"),
    Category("cash", "Cash", "expense"),
    Category("other_expense", "Other spending", "expense"),
    Category("salary", "Salary", "income"),
    Category("other_income", "Other income", "income"),
    Category("savings", "Savings and investments", "saving"),
    Category("transfer", "Transfers", "transfer"),
]
CATEGORY_IDS = {c.id for c in CATEGORIES}
CATEGORY_KINDS = {c.id: c.kind for c in CATEGORIES}

# Merchant keywords per category, checked in this order (first match wins). Norwegian merchants first.
MERCHANT_KEYWORDS: dict[str, list[str]] = {
    "savings": ["NORDNET", "KRON", "FIRI", "AKSJESPAREKONTO", "FONDSKONTO", "SPAREAVTALE"],
    "eating_out": [
        "FOODORA", "WOLT", "JUST EAT", "MCDONALDS", "MCDONALD'S", "BURGER KING", "MAX BURGERS", "PEPPES",
        "DOMINOS", "DOMINO'S", "STARBUCKS", "ESPRESSO HOUSE", "KAFFEBRENNERIET", "WAYNES COFFEE", "SUBWAY",
        "BAKER HANSEN", "BAKERI", "SUSHI", "PIZZA", "PIZZERIA", "KEBAB", "RESTAURANT", "RESTAURANG", "CAFE",
        "KAFE", "BISTRO", "BURGER", "THAI", "BAR", "PUB", "BRASSERIE",
    ],
    "groceries": [
        "REMA 1000", "REMA", "KIWI", "COOP", "EXTRA", "OBS", "PRIX", "MENY", "SPAR", "JOKER", "BUNNPRIS", "ODA",
        "MATKROKEN", "NÆRBUTIKKEN", "NAERBUTIKKEN", "VINMONOPOLET", "LIDL", "ICA", "NETTO", "FØTEX",
    ],
    "transport": [
        "RUTER", "VY", "ENTUR", "ATB", "SKYSS", "KOLUMBUS", "BRAKAR", "FLYTOGET", "BOLT", "UBER", "VOI", "TIER",
        "RYDE", "TAXI", "CIRCLE K", "ESSO", "SHELL", "UNO-X", "YX", "ST1", "EASYPARK", "APCOA", "ONEPARK",
        "AIMO PARK", "AUTOPASS", "FJELLINJEN", "FERDE", "BOMPENGER", "TESLA SUPERCHARGER", "RECHARGE", "MER NORWAY",
    ],
    "travel": [
        "NORWEGIAN AIR", "SAS AIRLINE", "SCANDINAVIAN AIRLINES", "WIDEROE", "WIDERØE", "FINNAIR", "KLM",
        "LUFTHANSA", "RYANAIR", "EASYJET", "AIRBNB", "BOOKING.COM", "HOTELS.COM", "EXPEDIA", "SCANDIC", "THON HOTEL",
        "RADISSON", "CLARION", "COMFORT HOTEL", "QUALITY HOTEL", "HOTEL", "HOSTEL",
    ],
    "subscriptions": [
        "NETFLIX", "SPOTIFY", "HBO", "VIAPLAY", "DISNEY PLUS", "DISNEYPLUS", "APPLE.COM", "ITUNES",
        "GOOGLE STORAGE", "GOOGLE ONE", "YOUTUBE", "MICROSOFT", "ADOBE", "OPENAI", "ANTHROPIC", "CLAUDE.AI",
        "GITHUB", "DROPBOX", "AUDIBLE", "STORYTEL", "TV 2 PLAY", "PATREON", "1PASSWORD",
    ],
    "bills": [
        "TELENOR", "TELIA", "ICE.NO", "TALKMORE", "ALTIBOX", "FJORDKRAFT", "TIBBER", "HAFSLUND", "ELVIA", "LYSE",
        "GJENSIDIGE", "IF SKADEFORSIKRING", "TRYG", "FREMTIND", "FORSIKRING", "STRØM", "NETTLEIE",
    ],
    "housing": [
        "HUSLEIE", "FELLESKOSTNADER", "FELLESUTGIFTER", "BORETTSLAG", "SAMEIE", "OBOS", "USBL",
        "KOMMUNALE AVGIFTER", "EIENDOMSSKATT",
    ],
    "health": [
        "APOTEK", "VITUSAPOTEK", "APOTEK 1", "BOOTS", "LEGE", "LEGESENTER", "LEGEVAKT", "TANNLEGE", "FYSIO",
        "OPTIKER", "SPECSAVERS", "SATS", "EVO FITNESS", "ELIXIA", "FRISKIS", "3T",
    ],
    "leisure": [
        "KINO", "NORDISK FILM", "ODEON", "TICKETMASTER", "BILLETTSERVICE", "TICKETCO", "STEAM", "PLAYSTATION",
        "NINTENDO", "XBOX", "MUSEUM", "SKISENTER",
    ],
    "shopping": [
        "ELKJØP", "ELKJOP", "POWER", "KOMPLETT", "NETONNET", "XXL", "CLAS OHLSON", "BILTEMA", "JULA", "IKEA",
        "JYSK", "H&M", "ZARA", "CUBUS", "DRESSMANN", "BOOZT", "ZALANDO", "AMAZON", "AMZN", "ALIEXPRESS", "TEMU",
        "NORMAL", "EUROPRIS", "PLANTASJEN", "MEGAFLIS", "MAXBO", "OBS BYGG", "BYGGMAX", "MONTER", "NOTABENE",
        "ARK", "TANUM", "SPORT 1", "INTERSPORT", "ANTON SPORT",
    ],
    "fees": ["GEBYR", "ÅRSAVGIFT", "ARSAVGIFT", "RENTER", "RENTE", "TERMINGEBYR", "PURREGEBYR"],
    "cash": ["MINIBANK", "ATM", "KONTANTUTTAK", "UTTAK MINIBANK"],
}

# Keywords that only count as income when money comes in.
INCOME_KEYWORDS: dict[str, list[str]] = {
    "salary": ["LØNN", "LONN", "LØNNING", "SALARY", "PAYROLL", "FERIEPENGER"],
    "other_income": ["SKATTEETATEN", "NAV", "UTBYTTE", "RENTER", "TILBAKEBETALING"],
}

# Category descriptions some banks send in bank_transaction_code.description (card scheme merchant categories),
# mapped by substring. Checked after merchant keywords.
BANK_CATEGORY_HINTS: list[tuple[str, str]] = [
    ("GROCERY", "groceries"),
    ("SUPERMARKET", "groceries"),
    ("BAKERIES", "groceries"),
    ("PACKAGE STORES", "groceries"),
    ("FAST FOOD", "eating_out"),
    ("RESTAURANT", "eating_out"),
    ("EATING PLACES", "eating_out"),
    ("DRINKING PLACES", "eating_out"),
    ("CATERERS", "eating_out"),
    ("COMMUTER TRANSPORT", "transport"),
    ("TAXI", "transport"),
    ("PARKING", "transport"),
    ("TOLL", "transport"),
    ("SERVICE STATION", "transport"),
    ("FUEL", "transport"),
    ("BUS LINES", "transport"),
    ("RAILROAD", "transport"),
    ("TRANSPORTATION", "transport"),
    ("AIRLINE", "travel"),
    ("AIR CARRIER", "travel"),
    ("HOTEL", "travel"),
    ("LODGING", "travel"),
    ("TRAVEL AGENC", "travel"),
    ("CAR RENTAL", "travel"),
    ("DIGITAL GOODS", "subscriptions"),
    ("COMPUTER SOFTWARE", "subscriptions"),
    ("CABLE", "subscriptions"),
    ("STREAMING", "subscriptions"),
    ("TELECOMMUNICATION", "bills"),
    ("UTILITIES", "bills"),
    ("INSURANCE", "bills"),
    ("DRUG STORES", "health"),
    ("PHARMAC", "health"),
    ("MEDICAL", "health"),
    ("DENTIST", "health"),
    ("DOCTOR", "health"),
    ("OPTICIAN", "health"),
    ("HEALTH", "health"),
    ("ATHLETIC", "health"),
    ("FITNESS", "health"),
    ("MOTION PICTURE", "leisure"),
    ("THEATRICAL", "leisure"),
    ("AMUSEMENT", "leisure"),
    ("RECREATION", "leisure"),
    ("TICKET", "leisure"),
    ("GAMES", "leisure"),
    ("CASH", "cash"),
    ("CLOTHING", "shopping"),
    ("APPAREL", "shopping"),
    ("SHOE", "shopping"),
    ("DEPARTMENT STORE", "shopping"),
    ("DISCOUNT STORE", "shopping"),
    ("VARIETY STORE", "shopping"),
    ("ELECTRONICS", "shopping"),
    ("COMPUTER", "shopping"),
    ("HARDWARE", "shopping"),
    ("HOME SUPPLY", "shopping"),
    ("FURNITURE", "shopping"),
    ("HOUSEHOLD", "shopping"),
    ("SPORTING GOODS", "shopping"),
    ("BOOK", "shopping"),
    ("COSMETIC", "shopping"),
    ("GENERAL MERCHANDISE", "shopping"),
    ("COURIER", "shopping"),
    ("RETAIL", "shopping"),
]

# Bank transaction codes that mark a card bill payment (money in on a card account).
CARD_PAYMENT_CODES = {"PAYMENT", "INNBETALING"}
# Bank transaction codes for interest.
INTEREST_CODES = {"INTR"}
