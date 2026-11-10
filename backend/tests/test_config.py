from finance.config import parse_people


def test_people_are_parsed_without_blanks_repeats_or_shared():
    assert parse_people(" Alex, Sam ,, alex, Shared ") == ("Alex", "Sam")
    assert parse_people("") == ()
