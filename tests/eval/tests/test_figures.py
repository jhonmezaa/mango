from decimal import Decimal

import pytest

from finops_eval.figures import (
    Figure,
    amount_candidates,
    extract_figures,
    find_match,
    normalize,
    parse_number,
    within_tolerance,
)


def D(value: str) -> Decimal:  # noqa: N802 - short alias for readability
    return Decimal(value)


@pytest.mark.parametrize(
    ("token", "readings"),
    [
        ("1.234,56", [D("1234.56")]),
        ("1,234.56", [D("1234.56")]),
        ("12.345.678,90", [D("12345678.90")]),
        ("7,80", [D("7.80")]),
        ("7.80", [D("7.80")]),
        ("0,02", [D("0.02")]),
        ("1234", [D("1234")]),
        # Ambiguous: Spanish thousands or English decimals; both readings are kept.
        ("1.234", [D("1.234"), D("1234")]),
        ("1,234", [D("1.234"), D("1234")]),
        ("1.234.567", [D("1234567")]),
        # Not a thousands group: a leading zero or a 4-digit lead is a decimal number.
        ("0.482", [D("0.482")]),
        ("1234.567", [D("1234.567")]),
    ],
)
def test_parse_number_readings(token: str, readings: list[Decimal]) -> None:
    assert list(parse_number(token)) == readings


@pytest.mark.parametrize("token", ["1.2.3", "1,23,4.5", "1.234,56,7"])
def test_parse_number_rejects_malformed_tokens(token: str) -> None:
    assert parse_number(token) == ()


def _kinds(text: str) -> list[tuple[str, str]]:
    return [(f.raw, f.kind) for f in extract_figures(text)]


def test_extract_marks_money_percent_and_bare_numbers() -> None:
    text = "Gastamos USD 1.234,56 (un 8,2 % más), es decir 7,80 por día en 5 servicios."
    assert _kinds(text) == [
        ("USD 1.234,56", "money"),
        ("8,2 %", "percent"),
        ("7,80", "decimal"),
        ("5", "integer"),
    ]


@pytest.mark.parametrize(
    "text", ["$7.80", "US$ 7.80", "USD 7,80", "7,80 USD", "7,80 dólares", "USD7,80"]
)
def test_extract_currency_markers(text: str) -> None:
    [figure] = extract_figures(text)
    assert figure.kind == "money"
    assert figure.readings == (D("7.80"),)


def test_extract_skips_dates_account_ids_and_identifiers() -> None:
    text = (
        "Período 2026-09-01 a 2026-10-01 (también 01/09/2026), cuenta 123456789012, "
        "instancia m5.2xlarge, bucket S3, Q1 y EC2."
    )
    assert extract_figures(text) == []


def test_extract_reads_markdown_table_cells() -> None:
    text = "| Servicio | Costo (USD) |\n|---|---|\n| Amazon S3 | 0,48 |\n| AWS Config | 12,00 |\n"
    assert [f.readings[0] for f in extract_figures(text)] == [D("0.48"), D("12.00")]


def test_extract_negative_amounts() -> None:
    hyphen, minus = extract_figures(f"Variación: USD -3,10 y {chr(0x2212)}0,25 %")
    assert hyphen.readings == (D("-3.10"),)
    assert (minus.kind, minus.readings) == ("percent", (D("-0.25"),))


def test_integers_are_amounts_only_with_a_currency_marker() -> None:
    figures = extract_figures("Los 5 servicios suman USD 8 en 2026.")
    assert [f.raw for f in amount_candidates(figures)] == ["USD 8"]


@pytest.mark.parametrize(
    ("expected", "actual", "ok"),
    [
        ("100", "100.99", True),
        ("100", "101.01", False),
        ("100", "99.00", True),
        ("100", "98.99", False),
        # Low spend: the rounding tolerance (half a cent) is wider than 1 %.
        ("0.0202", "0.02", True),
        ("0.0202", "0.03", False),
        ("7.8021632216", "7.80", True),
        ("7.8021632216", "7.90", False),
        ("0", "0.00", True),
        ("0", "0.01", False),
        # Signs are ignored.
        ("-3.10", "3.10", True),
    ],
)
def test_within_tolerance_money(expected: str, actual: str, ok: bool) -> None:
    assert within_tolerance(D(expected), D(actual)) is ok


@pytest.mark.parametrize(
    ("expected", "actual", "ok"),
    [("42.5", "42.6", True), ("42.5", "42.0", False), ("0", "0", True), ("0", "0.2", False)],
)
def test_within_tolerance_percent(expected: str, actual: str, ok: bool) -> None:
    assert within_tolerance(D(expected), D(actual), "percent") is ok


def test_find_match_uses_any_reading_of_an_ambiguous_token() -> None:
    figures = extract_figures("El total fue USD 1.234 este mes.")
    assert find_match(D("1234.4"), figures) is not None
    assert find_match(D("1.234"), figures) is not None
    assert find_match(D("12.34"), figures) is None


def test_find_match_never_reads_a_percentage_as_money_or_the_reverse() -> None:
    figures = extract_figures("Subió 7,80 % hasta USD 12,00.")
    assert find_match(D("7.80"), figures) is None
    assert find_match(D("12"), figures, "percent") is None
    assert find_match(D("7.8"), figures, "percent") == Figure("7,80 %", "percent", (D("7.80"),))


def test_find_match_ignores_bare_integers() -> None:
    assert find_match(D("5"), extract_figures("Top 5 servicios")) is None


def test_normalize_strips_accents_and_case() -> None:
    assert normalize("No Hubo ANOMALÍAS") == "no hubo anomalias"
