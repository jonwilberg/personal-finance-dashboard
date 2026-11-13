from finance.transactions import payment_date, transaction_date


def t(booking, **fields):
    return {"booking_date": booking, **fields}


def test_a_payment_booked_on_the_next_weekday_counts_on_the_day_it_was_paid():
    paid_saturday = t("2026-03-02", value_date="2026-03-02", remittance_information=["Til: Example AS Betalt: 28.02.26"])
    assert payment_date(paid_saturday) == "2026-02-28"
    assert transaction_date(paid_saturday) == "2026-03-02"  # storage still orders and replaces by booking date
    assert payment_date(t("2026-03-02", remittance_information=["Betalt 28.02.2026"])) == "2026-02-28"


def test_a_card_purchase_counts_on_its_purchase_day_and_never_on_a_later_due_date():
    purchase = t("2026-11-11", transaction_date="2026-11-10", value_date="2026-12-15")
    assert payment_date(purchase) == "2026-11-10"
    assert payment_date(t("2026-11-11", value_date="2026-11-09")) == "2026-11-09"
    assert payment_date(t("2026-11-11", value_date="2026-12-15")) == "2026-11-11"


def test_dates_that_cant_be_the_payment_day_are_ignored():
    assert payment_date(t("2026-03-02", remittance_information=["Betalt: 31.02.26"])) == "2026-03-02"  # no such day
    assert payment_date(t("2026-03-02", remittance_information=["Betalt: 01.01.26"])) == "2026-03-02"  # too long before
    assert payment_date(t("2026-03-02", remittance_information=["Betalt: 05.03.26"])) == "2026-03-02"  # after booking
    assert payment_date({}) == ""
