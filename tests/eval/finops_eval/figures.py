"""Figure extraction from agent answers and comparison against Cost Explorer.

The agent answers in prose and Markdown tables, usually in Spanish (``USD 1.234,56``) but
sometimes in English (``$1,234.56``). A numeric token whose format is ambiguous keeps every
plausible reading, and a figure matches when any reading is within tolerance.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Literal

Kind = Literal["money", "percent", "decimal", "integer"]

RELATIVE_TOLERANCE = Decimal("0.01")  # spec §8: figures within ±1 % of Cost Explorer
# Answers are rounded to 2 decimals, so half a cent is the smallest meaningful tolerance.
ROUNDING_TOLERANCE = Decimal("0.005")
PERCENT_TOLERANCE = Decimal("0.1")  # percentage points
THOUSANDS_GROUP = 3
MAX_GROUPED_LEAD = 3

_DATE_RE = re.compile(r"\b\d{4}-\d{2}(?:-\d{2})?\b|\b\d{1,2}/\d{1,2}/\d{2,4}\b")
_LONG_ID_RE = re.compile(r"\b\d{9,}\b")
_NUMBER_RE = re.compile(
    r"(?:(?P<prefix>US\$|USD|\$)\s?|(?<![\w.,]))"
    r"(?P<sign>[-\u2212])?"
    r"(?P<num>\d+(?:[.,]\d+)*)"
    r"(?P<suffix>\s?%|\s?USD\b|\s?d[oó]lares)?",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Figure:
    """One numeric token of an answer with every plausible reading of it."""

    raw: str
    kind: Kind
    readings: tuple[Decimal, ...]
    position: int = field(default=0, compare=False)
    """Order of appearance in the answer (for ranking checks)."""


def normalize(text: str) -> str:
    """Lowercase without accents, for phrase checks."""
    decomposed = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def _to_decimal(digits: str) -> Decimal | None:
    try:
        return Decimal(digits)
    except InvalidOperation:
        return None


def _is_grouped(parts: list[str]) -> bool:
    """Whether ``parts`` are thousands groups: 1-3 leading digits, then groups of three."""
    return (
        1 <= len(parts[0]) <= MAX_GROUPED_LEAD
        and (parts[0] != "0" or len(parts) == 1)
        and all(len(p) == THOUSANDS_GROUP for p in parts[1:])
    )


def _single_separator_readings(number: str, sep: str) -> list[str]:
    parts = number.split(sep)
    grouped = _is_grouped(parts)
    if len(parts) > 2:
        return ["".join(parts)] if grouped else []
    readings = [f"{parts[0]}.{parts[1]}"]
    if grouped:
        readings.append("".join(parts))  # "1.234" may be 1234 (es) or 1.234 (en)
    return readings


def parse_number(number: str) -> tuple[Decimal, ...]:
    """Every plausible value of a numeric token such as ``1.234,56``, ``1,234.56`` or ``7,8``."""
    has_dot, has_comma = "." in number, "," in number
    if has_dot and has_comma:
        decimal_sep = "." if number.rfind(".") > number.rfind(",") else ","
        thousands_sep = "," if decimal_sep == "." else "."
        integer, _, fraction = number.rpartition(decimal_sep)
        groups = integer.split(thousands_sep)
        if decimal_sep in integer or not _is_grouped(groups):
            return ()
        candidates = [f"{integer.replace(thousands_sep, '')}.{fraction}"]
    elif has_dot or has_comma:
        candidates = _single_separator_readings(number, "." if has_dot else ",")
    else:
        candidates = [number]
    values = [v for v in (_to_decimal(c) for c in candidates) if v is not None]
    return tuple(dict.fromkeys(values))


def extract_figures(text: str) -> list[Figure]:
    """Numeric tokens of ``text``; dates and long identifiers (account ids) are skipped."""
    cleaned = _LONG_ID_RE.sub(" ", _DATE_RE.sub(" ", text))
    figures: list[Figure] = []
    for match in _NUMBER_RE.finditer(cleaned):
        number = match.group("num")
        readings = parse_number(number)
        if not readings:
            continue
        if match.group("sign"):
            readings = tuple(-r for r in readings)
        suffix = (match.group("suffix") or "").strip()
        kind: Kind
        if suffix == "%":
            kind = "percent"
        elif match.group("prefix") or suffix:
            kind = "money"
        elif "." in number or "," in number:
            kind = "decimal"
        else:
            kind = "integer"
        figures.append(Figure(match.group(0).strip(), kind, readings, match.start()))
    return figures


def within_tolerance(expected: Decimal, actual: Decimal, kind: Kind = "money") -> bool:
    """±1 % of the expected value (or the rounding tolerance when that is larger).

    Signs are ignored: answers word decreases and credits in prose ("bajó USD 3,10").
    """
    delta = abs(abs(expected) - abs(actual))
    if kind == "percent":
        return delta <= max(PERCENT_TOLERANCE, RELATIVE_TOLERANCE * abs(expected))
    return delta <= max(ROUNDING_TOLERANCE, RELATIVE_TOLERANCE * abs(expected))


def amount_candidates(figures: Iterable[Figure]) -> list[Figure]:
    """Figures that can be an amount: marked as money, or bare numbers with decimals.

    Bare integers ("5 servicios", "2026") are never read as amounts.
    """
    return [f for f in figures if f.kind in ("money", "decimal")]


def find_match(expected: Decimal, figures: Iterable[Figure], kind: Kind = "money") -> Figure | None:
    """The first figure of the right kind with a reading within tolerance of ``expected``."""
    pool = (
        [f for f in figures if f.kind == "percent"]
        if kind == "percent"
        else amount_candidates(figures)
    )
    for figure in pool:
        if any(within_tolerance(expected, reading, kind) for reading in figure.readings):
            return figure
    return None
