"""Charts and tables of the chat (D118, G1 and T1): the closed spec a chart or a table of a code
cell is shown with.

The code sandbox writes ``<name>.chart.json`` (``display_chart``) and ``<name>.table.json``
(``display_table``) next to its figures (``connectors/code-interpreter``, ``sandbox_helper``);
both reach the chat as generated files (D116). Before the SPA draws one, mango-api reads it and
validates it here: what leaves is always one of the closed models below, normalized, never the
file as the sandbox wrote it.

The parsing is tolerant, like the format it copies (rea-gaps §2.1): an unknown field is ignored
and an invalid one falls back to its default, so that a small slip of the model still draws.
Only a missing or unknown ``chartType``, no rows, or a spec over the limits (5,000 rows, 20
series) is refused («No se pudo dibujar esta gráfica…»). The SPA validates a ```` ```mango-chart
```` block of the answer's text against the same models (exported through the OpenAPI).

Security notes (security-best-practices, TM-CI5, D118 (3)):
* Everything in a spec came from the model and from the sandbox: untrusted data. Only plain
  values pass (text, finite numbers, booleans); a nested value is dropped, every text is capped,
  and the SPA shows it as text (React escapes it), never as HTML nor code.
* The texts a chart or a table shows go through ``ApplyGuardrail`` before they are shown, once
  per file (``texts``): the same rule as the «Analizando» block.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping, Sequence
from typing import Literal

from pydantic import BaseModel, ConfigDict

MAX_ROWS = 5_000
"""Rows of a chart or of a table (D118 (1)); the sandbox's helper keeps the same cap."""
MAX_SERIES = 20
MAX_COLUMNS = 64
"""Keys of a chart's row and columns of a table: the rest are dropped."""
TABLE_SHOWN_ROWS = 200
"""What the chat shows of a table (design round 40): «Se muestran 200 de {n} filas…»."""
MAX_SPEC_BYTES = 2 * 1024 * 1024
"""What one spec file may weigh (the helper's cap)."""
MAX_GUARD_CHARS = 100_000
"""Texts of one spec checked by the guardrail (100 text units): a spec with more is refused."""
KEY_CHARS = 64
LABEL_CHARS = 120
TITLE_CHARS = 200
VALUE_CHARS = 200
"""A text value of a chart (a category, a point's label)."""
CELL_CHARS = 1_000
"""A text cell of a table."""
AFFIX_CHARS = 16
_RESERVED_KEYS = frozenset({"__proto__", "constructor", "prototype"})
"""Keys a row may not have: the SPA reads rows as JavaScript objects (prototype pollution)."""
_CSV_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,96}\.csv$")

ChartType = Literal["bar", "line", "pie", "scatter"]
ValueFormat = Literal["compact", "integer", "raw"]
_CHART_TYPES: frozenset[str] = frozenset({"bar", "line", "pie", "scatter"})
_FORMATS: frozenset[str] = frozenset({"compact", "integer", "raw"})

DataValue = str | int | float | bool | None
"""A value of a row: text, a finite number, a boolean or nothing."""


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- Models -----------------------------------------------------------------------------
# The field names are the spec's own (camelCase), as the model writes them.


class ChartSeriesOut(_Strict):
    key: str
    """The column of each row with the series' values."""
    label: str
    valueFormat: ValueFormat  # noqa: N815
    valuePrefix: str  # noqa: N815
    valueSuffix: str  # noqa: N815
    stack: str | None = None
    """Bars of the same ``stack`` are piled up."""


class ChartAxisOut(_Strict):
    label: str | None = None


class ChartAxesOut(_Strict):
    x: ChartAxisOut
    y: ChartAxisOut


class ChartMetaOut(_Strict):
    title: str | None = None
    subtitle: str | None = None
    footer: str | None = None


class ChartSpecOut(_Strict):
    """A chart as the chat draws it (D118 (1)), normalized: every default is filled in."""

    chartType: ChartType  # noqa: N815
    data: list[dict[str, DataValue]]
    xKey: str  # noqa: N815
    """The column of the categories (bar, line, pie) or of the x values (scatter)."""
    series: list[ChartSeriesOut]
    """At least one; a pie draws only the first."""
    layout: Literal["horizontal", "vertical"]
    """``vertical``: bars along the y axis (bar only)."""
    valueFormat: ValueFormat  # noqa: N815
    axes: ChartAxesOut
    meta: ChartMetaOut


class ChatTableOut(_Strict):
    """A table of a cell (D118 (5)): its first rows; the CSV of the same cell has them all."""

    name: str
    columns: list[str]
    rows: list[list[DataValue]]
    """At most ``TABLE_SHOWN_ROWS``, each one as long as ``columns``."""
    total_rows: int
    """Every row of the table, those over 5,000 included: «Se muestran 200 de {n} filas»."""
    csv: str | None = None
    """The name of its CSV among the files of the same cell («la tarjeta del CSV al pie»)."""


class ChatOutputOut(_Strict):
    """``GET /api/conversations/{id}/files/{file}/output``: what one chart or table file shows."""

    kind: Literal["chart", "table"]
    chart: ChartSpecOut | None = None
    table: ChatTableOut | None = None


# --- Normalization -----------------------------------------------------------------------


def _text(value: object, cap: int) -> str | None:
    """A text value, trimmed and capped; ``None`` for anything else or an empty one."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:cap] if text else None


def _key(value: object) -> str | None:
    """A column name of the spec (``xKey``, a series' ``key``): never a reserved one."""
    key = _text(value, KEY_CHARS)
    return key if key not in _RESERVED_KEYS else None


def _value(value: object, cap: int) -> DataValue:
    """A plain value of a row: text (capped), a finite number or a boolean; else nothing."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value if abs(value) < 2**63 else float(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        return value[:cap]
    return None


def _number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _rows(raw: object) -> list[dict[str, DataValue]] | None:
    if not isinstance(raw, list) or len(raw) > MAX_ROWS:
        return None
    rows: list[dict[str, DataValue]] = []
    for item in raw:
        if not isinstance(item, Mapping):
            continue
        row: dict[str, DataValue] = {}
        for key, value in item.items():
            if not isinstance(key, str) or not key or len(key) > KEY_CHARS:
                continue
            if key in _RESERVED_KEYS:
                continue
            if len(row) >= MAX_COLUMNS:
                break
            row[key] = _value(value, VALUE_CHARS)
        if row:
            rows.append(row)
    return rows


def _default_x(rows: Sequence[Mapping[str, DataValue]]) -> str:
    """rea-gaps §2.1: the first text column of the first row, else its first key, else
    ``name``."""
    first = rows[0] if rows else {}
    for key, value in first.items():
        if isinstance(value, str):
            return key
    return next(iter(first), "name")


def _default_value(rows: Sequence[Mapping[str, DataValue]], x_key: str) -> str:
    """The first numeric column that is not ``x_key``, else ``value``."""
    first = rows[0] if rows else {}
    for key, value in first.items():
        if key != x_key and _number(value):
            return key
    return "value"


def _format(value: object, default: ValueFormat) -> ValueFormat:
    return value if isinstance(value, str) and value in _FORMATS else default  # type: ignore[return-value]


def _series(
    raw: object, value_key: str, value_format: ValueFormat, prefix: str, suffix: str
) -> list[ChartSeriesOut] | None:
    if raw is None or not isinstance(raw, list):
        raw = []
    if len(raw) > MAX_SERIES:
        return None
    out: list[ChartSeriesOut] = []
    for item in raw:
        if not isinstance(item, Mapping):
            continue
        key = _key(item.get("key")) or _key(item.get("dataKey"))
        if key is None:
            continue
        out.append(
            ChartSeriesOut(
                key=key,
                label=_text(item.get("label"), LABEL_CHARS) or key,
                valueFormat=_format(item.get("valueFormat"), value_format),
                valuePrefix=_text(item.get("valuePrefix"), AFFIX_CHARS) or prefix,
                valueSuffix=_text(item.get("valueSuffix"), AFFIX_CHARS) or suffix,
                stack=_text(item.get("stack"), KEY_CHARS),
            )
        )
    return out or [
        ChartSeriesOut(
            key=value_key,
            label=value_key,
            valueFormat=value_format,
            valuePrefix=prefix,
            valueSuffix=suffix,
        )
    ]


def _axis_label(raw: object, dimension: str, fallback: object) -> str | None:
    """``axes`` as ``{x: {label}, y: {label}}`` (Mango) or ``[{dimension, label}]`` (the format
    it copies); ``xAxisLabel``-like fields as the fallback."""
    if isinstance(raw, Mapping):
        axis = raw.get(dimension)
        if isinstance(axis, Mapping) and (label := _text(axis.get("label"), LABEL_CHARS)):
            return label
    elif isinstance(raw, list):
        for axis in raw:
            label = _text(axis.get("label"), LABEL_CHARS) if isinstance(axis, Mapping) else None
            if label and isinstance(axis, Mapping) and axis.get("dimension") == dimension:
                return label
    return _text(fallback, LABEL_CHARS)


def parse_chart(raw: object) -> ChartSpecOut | None:
    """A chart spec as the chat draws it, or ``None`` when it cannot be drawn: not an object,
    no known ``chartType``, no rows, or over 5,000 rows or 20 series."""
    if not isinstance(raw, Mapping):
        return None
    chart_type = raw.get("chartType")
    if not isinstance(chart_type, str) or chart_type not in _CHART_TYPES:
        return None
    rows = _rows(raw.get("data"))
    if not rows:
        return None
    x_key = _key(raw.get("xKey")) or _default_x(rows)
    value_key = _key(raw.get("valueKey")) or _default_value(rows, x_key)
    value_format = _format(raw.get("valueFormat"), "compact")
    series = _series(
        raw.get("series"),
        value_key,
        value_format,
        _text(raw.get("valuePrefix"), AFFIX_CHARS) or "",
        _text(raw.get("valueSuffix"), AFFIX_CHARS) or "",
    )
    if series is None:
        return None
    meta_raw = raw.get("meta")
    meta: Mapping[str, object] = meta_raw if isinstance(meta_raw, Mapping) else {}
    axes = raw.get("axes")
    return ChartSpecOut(
        chartType=chart_type,  # type: ignore[arg-type]
        data=rows,
        xKey=x_key,
        series=series,
        layout="vertical"
        if chart_type == "bar" and raw.get("layout") == "vertical"
        else "horizontal",
        valueFormat=value_format,
        axes=ChartAxesOut(
            x=ChartAxisOut(label=_axis_label(axes, "x", raw.get("xAxisLabel"))),
            y=ChartAxisOut(label=_axis_label(axes, "y", raw.get("yAxisLabel"))),
        ),
        meta=ChartMetaOut(
            title=_text(meta.get("title"), TITLE_CHARS),
            subtitle=_text(meta.get("subtitle"), TITLE_CHARS)
            or _text(meta.get("description"), TITLE_CHARS),
            footer=_text(meta.get("footer"), TITLE_CHARS),
        ),
    )


def parse_table(raw: object) -> ChatTableOut | None:
    """A table as the chat shows it (its first 200 rows), or ``None`` without columns."""
    if not isinstance(raw, Mapping):
        return None
    columns_raw = raw.get("columns")
    rows_raw = raw.get("rows")
    if not isinstance(columns_raw, list) or not columns_raw or not isinstance(rows_raw, list):
        return None
    if len(rows_raw) > MAX_ROWS:
        return None
    columns = [str(c)[:LABEL_CHARS] if c is not None else "" for c in columns_raw[:MAX_COLUMNS]]
    width = len(columns)
    rows: list[list[DataValue]] = []
    for item in rows_raw[:TABLE_SHOWN_ROWS]:
        if not isinstance(item, list):
            continue
        row = [_value(v, CELL_CHARS) for v in item[:width]]
        rows.append(row + [None] * (width - len(row)))
    total = raw.get("total_rows")
    total_rows = total if isinstance(total, int) and not isinstance(total, bool) else 0
    csv = raw.get("csv")
    return ChatTableOut(
        name=_text(raw.get("name"), TITLE_CHARS) or "table",
        columns=columns,
        rows=rows,
        total_rows=max(total_rows, len(rows_raw)),
        csv=csv if isinstance(csv, str) and _CSV_NAME.fullmatch(csv) else None,
    )


def output_kind(name: str) -> Literal["chart", "table"] | None:
    """What a generated file is, by the suffix the sandbox's helper gives it."""
    if name.endswith(".chart.json"):
        return "chart"
    if name.endswith(".table.json"):
        return "table"
    return None


def parse_output(kind: Literal["chart", "table"], raw: object) -> ChatOutputOut | None:
    if kind == "chart":
        chart = parse_chart(raw)
        return ChatOutputOut(kind="chart", chart=chart) if chart is not None else None
    table = parse_table(raw)
    return ChatOutputOut(kind="table", table=table) if table is not None else None


def _unique(values: Iterable[object]) -> list[str]:
    seen: dict[str, None] = {}
    for value in values:
        if isinstance(value, str) and value.strip():
            seen.setdefault(value, None)
    return list(seen)


def texts(output: ChatOutputOut) -> list[str] | None:
    """Every distinct text the chat shows of ``output``, for the guardrail; ``None`` when they
    are more than ``MAX_GUARD_CHARS`` (the output is refused rather than shown unchecked)."""
    found: list[object] = []
    if output.chart is not None:
        chart = output.chart
        found += [chart.meta.title, chart.meta.subtitle, chart.meta.footer]
        found += [chart.axes.x.label, chart.axes.y.label]
        for s in chart.series:
            found += [s.label, s.valuePrefix, s.valueSuffix]
        found.append(chart.xKey)
        for row in chart.data:
            # The keys head the columns of «Copiar datos».
            found += [*row.keys(), *row.values()]
    if output.table is not None:
        table = output.table
        found += [table.name, *table.columns]
        for cells in table.rows:
            found += cells
    out = _unique(found)
    if sum(len(t) for t in out) > MAX_GUARD_CHARS:
        return None
    return out
