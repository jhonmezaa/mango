"""Cases of an eval suite (D110, D111; threat model ``evals-threat-model.md``).

A case is one question to the agent and one criterion to judge its answer:

* ``contains``: the answer contains a text (case-insensitive), decided in code;
* ``uses_tool``: the agent called a tool of its version (``<server>.<tool>``), decided in code
  from the stream (an attempt counts: a write tool never runs in an eval);
* ``no_disclosure``: the answer reveals neither a secret nor a fragment of the version's
  prompt, decided in code;
* ``judge``: AgentCore Evaluations compares the answer with ``expected`` (a custom evaluator of
  Mango with a model of the catalog, D110). Only this one needs ``expected``.

Cases are content (D26): mango-api keeps them in the Evals table, never in logs nor in the
audit. The CSV import (``parse_csv``) is bounded in bytes, rows and characters per field, and
reports problems by row number only, never by echoing a value.
"""

from __future__ import annotations

import csv
import io
import re
import unicodedata
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from mango_core.agents import TOOL_REF_PATTERN

MAX_CASES = 50
MAX_QUESTION_CHARS = 1000
MAX_EXPECTED_CHARS = 1000
MAX_VALUE_CHARS = 200
MAX_CSV_BYTES = 30 * 1024
"""Under the 32 KiB body limit of mango-api (``app.MAX_BODY_BYTES``), with its JSON envelope."""
CSV_HEADER = ("pregunta", "respuesta esperada", "criterio")
"""The columns of the design (``eval-create.jsx``), in Spanish as the person writes them."""

CriterionKind = Literal["contains", "uses_tool", "no_disclosure", "judge"]
CRITERIA: tuple[CriterionKind, ...] = ("contains", "uses_tool", "no_disclosure", "judge")
_TOOL_RE = re.compile(TOOL_REF_PATTERN)
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def normalize(text: str) -> str:
    """NFC, no control characters but tab and newlines, trimmed."""
    return _CONTROL_RE.sub("", unicodedata.normalize("NFC", text)).strip()


class EvalCase(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    question: Annotated[str, Field(min_length=1, max_length=MAX_QUESTION_CHARS)]
    expected: Annotated[str, Field(max_length=MAX_EXPECTED_CHARS)] = ""
    criterion: CriterionKind
    value: Annotated[str, Field(max_length=MAX_VALUE_CHARS)] = ""
    """The text of ``contains`` or the tool of ``uses_tool``; empty for the others."""

    @model_validator(mode="after")
    def _consistent(self) -> EvalCase:
        if self.criterion == "contains" and not self.value.strip():
            raise ValueError("contains needs a text")
        if self.criterion == "uses_tool" and not _TOOL_RE.fullmatch(self.value):
            raise ValueError("uses_tool needs a tool of the agent")
        if self.criterion in ("no_disclosure", "judge") and self.value:
            raise ValueError("this criterion takes no value")
        if self.criterion == "judge" and not self.expected.strip():
            raise ValueError("the judge needs an expected answer")
        return self


class EvalCases(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    cases: Annotated[tuple[EvalCase, ...], Field(min_length=1, max_length=MAX_CASES)]


class CsvError(ValueError):
    """The CSV cannot be imported. ``rows`` are 1-based data row numbers (header excluded)."""

    def __init__(self, code: str, rows: tuple[int, ...] = ()) -> None:
        super().__init__(code)
        self.code = code
        self.rows = rows


def criterion_of(raw: str) -> tuple[CriterionKind, str]:
    """The criterion as the CSV writes it: ``contiene: <texto>``, ``usa la tool: <tool>``,
    ``no revela`` or empty for the judge. Raises ``ValueError`` for anything else."""
    text = normalize(raw)
    if not text:
        return "judge", ""
    head, sep, tail = text.partition(":")
    key = head.strip().casefold()
    if sep and key == "contiene":
        return "contains", tail.strip()
    if sep and key == "usa la tool":
        return "uses_tool", tail.strip()
    if not sep and key == "no revela":
        return "no_disclosure", ""
    raise ValueError("unknown criterion")


def parse_csv(text: str) -> tuple[EvalCase, ...]:
    """Cases of a CSV with the design's three columns. All-or-nothing: any bad row rejects the
    whole file, naming the rows (never their content)."""
    if len(text.encode("utf-8")) > MAX_CSV_BYTES:
        raise CsvError("csv_too_large")
    if "\x00" in text:
        raise CsvError("csv_invalid")
    try:
        rows = list(csv.reader(io.StringIO(text.lstrip("﻿")), strict=True))
    except csv.Error:
        raise CsvError("csv_invalid") from None
    rows = [r for r in rows if any(cell.strip() for cell in r)]
    if not rows:
        raise CsvError("csv_empty")
    header = tuple(normalize(c).casefold() for c in rows[0])
    if header != CSV_HEADER:
        raise CsvError("csv_header")
    data = rows[1:]
    if not data:
        raise CsvError("csv_empty")
    if len(data) > MAX_CASES:
        raise CsvError("too_many_cases")
    cases: list[EvalCase] = []
    bad: list[int] = []
    for number, row in enumerate(data, start=1):
        if len(row) != len(CSV_HEADER):
            bad.append(number)
            continue
        question, expected, raw_criterion = row
        try:
            kind, value = criterion_of(raw_criterion)
            cases.append(
                EvalCase(
                    question=normalize(question),
                    expected=normalize(expected),
                    criterion=kind,
                    value=value,
                )
            )
        except ValueError:
            bad.append(number)
    if bad:
        raise CsvError("csv_rows", tuple(bad))
    return tuple(cases)
