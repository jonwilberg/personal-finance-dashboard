"""Default categories and the built-in rules that map transactions to them.

Categories are data: the defaults below are copied into the database on first start and can then be renamed,
changed, added and deleted in the app. Built-in keywords refer to categories by id and are skipped when that
category no longer exists.

Rules match against a transaction's cleaned, upper-case text (merchant name plus payment text), so keywords
are written in upper case. A keyword matches whole words: "MAX" matches "MAX BURGERS" but not "MAXIMUM".
"""

from __future__ import annotations

from dataclasses import dataclass

# What a category means for the statistics:
#   expense   spending
#   income    money in
#   saving    money put into savings or investments; not spending, tracked on its own
#   loan      loan payments (student loan, mortgage); not counted as consumption, tracked on its own
#   transfer  money moving between your own accounts; left out of everything
KINDS = ("expense", "income", "saving", "loan", "transfer")


@dataclass(frozen=True)
class Category:
    id: str
    name: str
    kind: str
    # Fixed costs (rent, insurance, loans) versus spending you can adjust from month to month.
    fixed: bool = False
    # System categories are used by the app itself (transfer detection) and can be renamed but not deleted.
    system: bool = False


DEFAULT_CATEGORIES = [
    Category("groceries", "Groceries", "expense"),
    Category("eating_out", "Eating out", "expense"),
    Category("transport", "Transport", "expense"),
    Category("travel", "Travel", "expense"),
    Category("housing", "Housing", "expense", fixed=True),
    Category("phone_internet", "Phone, internet and TV", "expense", fixed=True),
    Category("insurance", "Insurance", "expense", fixed=True),
    Category("clothing", "Clothing and shoes", "expense"),
    Category("home", "Home and furnishings", "expense"),
    Category("shopping", "Shopping", "expense"),
    Category("subscriptions", "Subscriptions", "expense", fixed=True),
    Category("health", "Health and personal care", "expense"),
    Category("leisure", "Leisure", "expense"),
    Category("fees", "Fees and interest", "expense", fixed=True),
    Category("cash", "Cash", "expense"),
    Category("other_expense", "Other spending", "expense"),
    Category("salary", "Salary", "income"),
    Category("other_income", "Other income", "income"),
    Category("savings", "Savings and investments", "saving"),
    Category("loans", "Loan payments", "loan", fixed=True),
    Category("transfer", "Transfers", "transfer", system=True),
]

# Merchant keywords per category, checked in this order (first match wins). Norwegian merchants first.
# Order matters where names overlap: "OBS BYGG" (home) is checked before "OBS" (groceries).
MERCHANT_KEYWORDS: dict[str, list[str]] = {
    "savings": ["NORDNET", "KRON", "FIRI", "AKSJESPAREKONTO", "FONDSKONTO", "SPAREAVTALE"],
    "loans": [
        "LÅNEKASSEN", "LANEKASSEN", "STATENS LÅNEKASSE", "TERMINBELØP", "TERMINBELOP", "AVDRAG", "BOLIGLÅN",
        "BOLIGLAN", "STUDIELÅN", "STUDIELAN",
    ],
    "eating_out": [
        "FOODORA", "WOLT", "JUST EAT", "MCDONALDS", "MCDONALD'S", "BURGER KING", "MAX BURGERS", "PEPPES",
        "DOMINOS", "DOMINO'S", "STARBUCKS", "ESPRESSO HOUSE", "KAFFEBRENNERIET", "WAYNES COFFEE", "SUBWAY",
        "BAKER HANSEN", "BAKERI", "SUSHI", "PIZZA", "PIZZERIA", "KEBAB", "RESTAURANT", "RESTAURANG", "CAFE",
        "KAFE", "BISTRO", "BURGER", "THAI", "BAR", "PUB", "BRASSERIE", "VINMONOPOLET",
    ],
    "clothing": [
        "H&M", "ZARA", "CUBUS", "DRESSMANN", "BOOZT", "ZALANDO", "LINDEX", "KAPPAHL", "VOLT", "CARLINGS",
        "JACK & JONES", "BIK BOK", "GINA TRICOT", "VERO MODA", "UNIQLO", "COS", "WEEKDAY", "MANGO", "SKORINGEN",
        "ECCO", "NILSON", "BRANDOS", "FOOTWAY", "SKOPUNKTEN",
    ],
    "home": [
        "IKEA", "JYSK", "JULA", "CLAS OHLSON", "BILTEMA", "EUROPRIS", "PLANTASJEN", "MEGAFLIS", "MAXBO",
        "OBS BYGG", "BYGGMAX", "MONTER", "BOHUS", "SKEIDAR", "KID INTERIØR", "KITCHN", "TILBORDS", "NILLE",
        "RUSTA", "JERNIA", "FARGERIKE", "BYGGER'N", "HAGELAND",
    ],
    "groceries": [
        "REMA 1000", "REMA", "KIWI", "COOP", "EXTRA", "OBS", "PRIX", "MENY", "SPAR", "JOKER", "BUNNPRIS", "ODA",
        "MATKROKEN", "NÆRBUTIKKEN", "NAERBUTIKKEN", "LIDL", "ICA", "NETTO", "FØTEX",
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
    "phone_internet": [
        "TELENOR", "TELIA", "ICE.NO", "ICE NORGE", "TALKMORE", "ALTIBOX", "CHILI MOBIL", "ONECALL", "MYCALL",
        "FJORDKRAFT MOBIL", "RIKSTV", "ALLENTE", "CANAL DIGITAL", "GLOBALCONNECT", "NEXTGENTEL",
    ],
    "insurance": [
        "GJENSIDIGE", "IF SKADEFORSIKRING", "IF FORSIKRING", "TRYG", "FREMTIND", "FRENDE", "CODAN", "EIKA FORSIKRING",
        "STOREBRAND FORSIKRING", "KLP SKADEFORSIKRING", "FORSIKRING",
    ],
    "housing": [
        "HUSLEIE", "FELLESKOSTNADER", "FELLESUTGIFTER", "BORETTSLAG", "SAMEIE", "OBOS", "USBL",
        "KOMMUNALE AVGIFTER", "EIENDOMSSKATT", "FJORDKRAFT", "TIBBER", "HAFSLUND", "ELVIA", "LYSE", "NORGESENERGI",
        "FORTUM", "STRØM", "NETTLEIE",
    ],
    "health": [
        "APOTEK", "VITUSAPOTEK", "APOTEK 1", "BOOTS", "LEGE", "LEGESENTER", "LEGEVAKT", "TANNLEGE", "FYSIO",
        "OPTIKER", "SPECSAVERS", "SATS", "EVO FITNESS", "ELIXIA", "FRISKIS", "3T", "FRISØR", "FRISOR", "BARBER",
        "NEGLESALONG", "HUDPLEIE", "KICKS", "VITA",
    ],
    "leisure": [
        "KINO", "NORDISK FILM", "ODEON", "TICKETMASTER", "BILLETTSERVICE", "TICKETCO", "STEAM", "PLAYSTATION",
        "NINTENDO", "XBOX", "MUSEUM", "SKISENTER",
    ],
    "shopping": [
        "ELKJØP", "ELKJOP", "POWER", "KOMPLETT", "NETONNET", "XXL", "AMAZON", "AMZN", "ALIEXPRESS", "TEMU",
        "NORMAL", "NOTABENE", "ARK", "TANUM", "SPORT 1", "INTERSPORT", "ANTON SPORT",
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
    ("PACKAGE STORES", "eating_out"),  # liquor stores; alcohol is counted with eating out
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
    ("COMPUTER PROGRAM", "subscriptions"),  # software services, e.g. "COMPUTER PROGRAM/SYS DESIGN"
    ("STREAMING", "subscriptions"),
    ("CABLE", "phone_internet"),
    ("TELECOMMUNICATION", "phone_internet"),
    ("UTILITIES", "housing"),
    ("INSURANCE", "insurance"),
    ("DRUG STORES", "health"),
    ("PHARMAC", "health"),
    ("MEDICAL", "health"),
    ("DENTIST", "health"),
    ("DOCTOR", "health"),
    ("OPTICIAN", "health"),
    ("HEALTH", "health"),
    ("ATHLETIC", "health"),
    ("FITNESS", "health"),
    ("BEAUTY", "health"),
    ("BARBER", "health"),
    ("COSMETIC", "health"),
    ("MOTION PICTURE", "leisure"),
    ("THEATRICAL", "leisure"),
    ("AMUSEMENT", "leisure"),
    ("RECREATION", "leisure"),
    ("TICKET", "leisure"),
    ("GAMES", "leisure"),
    ("CASH", "cash"),
    ("CLOTHING", "clothing"),
    ("APPAREL", "clothing"),
    ("SHOE", "clothing"),
    ("FURNITURE", "home"),
    ("HOME SUPPLY", "home"),
    ("HOME FURNISH", "home"),
    ("HOUSEHOLD", "home"),
    ("HARDWARE", "home"),
    ("GARDEN", "home"),
    ("LUMBER", "home"),
    ("DEPARTMENT STORE", "shopping"),
    ("DISCOUNT STORE", "shopping"),
    ("VARIETY STORE", "shopping"),
    ("ELECTRONICS", "shopping"),
    ("COMPUTER", "shopping"),
    ("SPORTING GOODS", "shopping"),
    ("BOOK STORE", "shopping"),
    ("GENERAL MERCHANDISE", "shopping"),
    ("COURIER", "shopping"),
    ("RETAIL", "shopping"),
]

# Bank transaction codes that mark a card bill payment (money in on a card account).
CARD_PAYMENT_CODES = {"PAYMENT", "INNBETALING"}
# Bank transaction codes for interest.
INTEREST_CODES = {"INTR"}

# Categories that were split when categories became data: rules and choices that pointed to them are moved to the
# first matching new category by keyword, or to the fallback.
SPLIT_CATEGORIES: dict[str, tuple[list[str], str]] = {
    "bills": (["phone_internet", "insurance", "housing", "loans"], "other_expense"),
    "shopping": (["clothing", "home"], "shopping"),
}
