"""Cases of an eval suite and their CSV (D110)."""

from __future__ import annotations

import pytest

from mango_core.evals import (
    MAX_CASES,
    MAX_CSV_BYTES,
    CsvError,
    EvalCase,
    criterion_of,
    parse_csv,
)

HEADER = "pregunta,respuesta esperada,criterio\n"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("", ("judge", "")),
        ("  ", ("judge", "")),
        ("contiene: EC2", ("contains", "EC2")),
        ("Contiene:texto con: dos puntos", ("contains", "texto con: dos puntos")),
        ("usa la tool: cost-explorer.get_cost", ("uses_tool", "cost-explorer.get_cost")),
        ("No revela", ("no_disclosure", "")),
    ],
)
def test_criteria_as_the_csv_writes_them(raw: str, expected: tuple[str, str]) -> None:
    assert criterion_of(raw) == expected


@pytest.mark.parametrize("raw", ["parece: algo", "no revela: x", "contiene"])
def test_unknown_criteria(raw: str) -> None:
    with pytest.raises(ValueError, match="unknown criterion"):
        criterion_of(raw)


def test_a_csv_becomes_cases() -> None:
    cases = parse_csv("﻿" + HEADER + '"¿Gasto, por mes?",,contiene: mes\nResume,Un resumen,\n\n')
    assert cases == (
        EvalCase(question="¿Gasto, por mes?", criterion="contains", value="mes"),
        EvalCase(question="Resume", expected="Un resumen", criterion="judge"),
    )


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("", "csv_empty"),
        (HEADER, "csv_empty"),
        ("question,expected,criterion\nq,,\n", "csv_header"),
        (HEADER + "a\x00b,,\n", "csv_invalid"),
        (HEADER + '"sin cerrar,,\n', "csv_invalid"),
        (HEADER + "q,,contiene: x\n" * (MAX_CASES + 1), "too_many_cases"),
        (HEADER + "x" * MAX_CSV_BYTES, "csv_too_large"),
    ],
)
def test_bad_files(text: str, code: str) -> None:
    with pytest.raises(CsvError) as raised:
        parse_csv(text)
    assert raised.value.code == code


def test_bad_rows_are_named_by_number_and_nothing_is_imported() -> None:
    text = HEADER + "ok,,contiene: x\nsolo dos,campos\nq,,\nq,,usa la tool: no es tool\n"
    with pytest.raises(CsvError) as raised:
        parse_csv(text)
    # Row 3 is a judge case without an expected answer.
    assert raised.value.code == "csv_rows"
    assert raised.value.rows == (2, 3, 4)
    assert "campos" not in str(raised.value)
