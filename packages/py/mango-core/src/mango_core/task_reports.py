"""Downloadable reports of task runs (D86, D87): what an agent hands over and what is computed.

A task may ask for a PDF of each run. The agent hands its data over with the internal tool
``mango_report``, an ``inline_function`` of the harness (D87 (3)): the call comes back to
mango-api and reaches no other system. Its input is model output, untrusted (TM-R1, TM-R4):

* It is validated here, strictly, by mango-api when the run ends and again by the function
  that draws the PDF: no extra fields, finite bounded amounts, dates in order, the limits of
  D86 (8), no control characters.
* What can be computed is computed here, never taken from the model: variations, shares,
  totals of the rows and the «Otros» row (``summary``).
* The daily cost series is taken from the answer of a ``get_cost_and_usage`` query of the run
  when one matches (D87 (4), ``series_from_query``); otherwise the agent's copy is used, and
  the report says which.

The tool exists in two shapes, one per type, fixed by the trigger of the task (D86 (7)).
Threat model: ``docs/security/threat-models/task-reports-threat-model.md``.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

REPORT_TOOL = "mango_report"
"""Name of the internal tool in the harness. Never a tool of the Gateway: it has no prefix."""
ReportType = Literal["cost_summary", "anomaly"]
TYPE_NAMES: dict[str, str] = {
    "cost_summary": "Resumen de costos",
    "anomaly": "Investigación de anomalía",
}
REPORT_SOURCES = ("cost-explorer", "aws-billing")
"""Tools (connector or pack ids) that read Cost Explorer or billing: only an agent with one of
them may produce a report (design: «solo para agentes que leen Cost Explorer o la facturación»)."""
COST_QUERY_TOOL = "get_cost_and_usage"

MAX_ROWS_SHOWN = 25
"""Rows of a table in the PDF; the rest is one «Otros» row (D86 (8))."""
MAX_ROWS_IN = 200
MAX_DAYS = 400
MAX_LONG_TEXT = 4000
MAX_SHORT_TEXT = 280
MAX_NAME = 128
MAX_PDF_BYTES = 10 * 1024 * 1024
MAX_PAGES = 12
"""Bounds the work of the renderer whatever the data says (TM-R1, TM-R7)."""
MAX_INPUT_CHARS = 128 * 1024
"""Input of the internal tool kept by mango-api; a longer one is not a report (``data``)."""
MAX_QUERY_CHARS = 512 * 1024
"""Answer of a ``get_cost_and_usage`` call kept to take a series from it."""
MAX_AMOUNT = Decimal(10) ** 12
CENT = Decimal("0.01")
RETENTION_DAYS = 90
GENERATION_TIMEOUT_SECONDS = 15 * 60
"""A report still «generating» after this failed without saying so (its function died): it is
shown as ``render`` and may be generated again."""
FAILURE_REASONS = ("data", "size", "render")

_CONTROL = re.compile(
    r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f"
    r"\u2028\u2029\u202a-\u202e\u2066-\u2069]"
)
_ID = re.compile(r"[0-9a-f]{32}")
_RUN_SK = re.compile(r"RUN#[0-9]{13}#[0-9a-f]{32}")
_OWNER = re.compile(r"[0-9A-Za-z-]{1,128}")


class InvalidReportError(ValueError):
    """The data does not make a report: the run's report fails with ``data``."""


def _clean(value: str) -> str:
    """No control or bidirectional characters: they could hide or reorder what the PDF shows."""
    if _CONTROL.search(value.replace("\n", "").replace("\t", "")):
        raise ValueError("control characters are not allowed")
    return value.replace("\t", " ").strip()


def _one_line(value: str) -> str:
    value = _clean(value)
    if "\n" in value:
        raise ValueError("one line only")
    return value


def _money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


Money = Annotated[
    Decimal,
    Field(ge=-MAX_AMOUNT, le=MAX_AMOUNT, allow_inf_nan=False),
    AfterValidator(_money),
]
Name = Annotated[str, Field(min_length=1, max_length=MAX_NAME), AfterValidator(_one_line)]
Short = Annotated[str, Field(min_length=1, max_length=MAX_SHORT_TEXT), AfterValidator(_one_line)]
Long = Annotated[str, Field(max_length=MAX_LONG_TEXT), AfterValidator(_clean)]
AccountId = Annotated[str, Field(pattern=r"^\d{12}$")]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class DayCost(_Strict):
    date: date
    cost: Money


class DayCostExpected(_Strict):
    date: date
    cost: Money
    expected: Money | None = None


class ServiceRow(_Strict):
    service: Name
    cost: Money
    previous: Money | None = None


class AccountRow(_Strict):
    account_id: AccountId
    name: Name | None = None
    cost: Money
    previous: Money | None = None


class CauseRow(_Strict):
    usage_type: Name
    service: Name
    account_id: AccountId | None = None
    impact: Money


def _fits(total: Decimal, parts: list[Decimal]) -> None:
    """Rows never add up to more than their total (1 % or USD 1 of rounding): «Otros» is what
    the total leaves, and a table that does not fit its total is not a report."""
    listed = sum((p for p in parts if p > 0), Decimal(0))
    if listed > max(total, Decimal(0)) + max(Decimal(1), abs(total) / 100):
        raise ValueError("the rows add up to more than the total")


def _days_in_order(days: Iterable[date]) -> None:
    seen = list(days)
    if seen != sorted(set(seen)):
        raise ValueError("days must be unique and in order")


class CostSummaryData(_Strict):
    """«Resumen de costos»: a scheduled (or manual) task's period (design `Reporte de tarea`)."""

    period_start: date
    period_end: date = Field(description="Last day of the period, inclusive")
    total: Money
    previous_total: Money | None = None
    forecast: Money | None = Field(
        default=None, description="Forecast for the whole period, only while it is under way"
    )
    daily: Annotated[list[DayCost], Field(max_length=MAX_DAYS)] = []
    services: Annotated[list[ServiceRow], Field(max_length=MAX_ROWS_IN)] = []
    accounts: Annotated[list[AccountRow], Field(max_length=MAX_ROWS_IN)] = []
    notes: Long = ""

    @model_validator(mode="after")
    def _shape(self) -> CostSummaryData:
        if self.period_end < self.period_start:
            raise ValueError("the period ends before it starts")
        if (self.period_end - self.period_start).days + 1 > MAX_DAYS:
            raise ValueError("the period is longer than 400 days")
        _days_in_order(d.date for d in self.daily)
        if any(not self.period_start <= d.date <= self.period_end for d in self.daily):
            raise ValueError("a day of the series is outside the period")
        if len({r.service for r in self.services}) != len(self.services):
            raise ValueError("a service is repeated")
        if len({r.account_id for r in self.accounts}) != len(self.accounts):
            raise ValueError("an account is repeated")
        for rows in (self.services, self.accounts):
            _fits(self.total, [r.cost for r in rows])
            if self.previous_total is not None:
                _fits(self.previous_total, [r.previous for r in rows if r.previous is not None])
        return self


class AnomalyData(_Strict):
    """«Investigación de anomalía». The id and the dates of the anomaly are Mango's (the run),
    never the agent's (design: «El id, el monitor y las fechas los pone Mango»)."""

    expected: Money
    actual: Money
    service: Name | None = Field(default=None, description="Service of the main root cause")
    account_name: Name | None = Field(default=None, description="Name of its account")
    daily: Annotated[list[DayCostExpected], Field(max_length=MAX_DAYS)] = []
    causes: Annotated[list[CauseRow], Field(max_length=MAX_ROWS_IN)] = []
    conclusion: Long = ""
    next_step: Annotated[str, Field(max_length=MAX_SHORT_TEXT), AfterValidator(_one_line)] = ""

    @model_validator(mode="after")
    def _shape(self) -> AnomalyData:
        _days_in_order(d.date for d in self.daily)
        if self.daily and (self.daily[-1].date - self.daily[0].date).days + 1 > MAX_DAYS:
            raise ValueError("the series is longer than 400 days")
        return self


DATA_MODELS: dict[str, type[CostSummaryData] | type[AnomalyData]] = {
    "cost_summary": CostSummaryData,
    "anomaly": AnomalyData,
}

_DESCRIPTIONS = {
    "cost_summary": (
        "Entrega a Mango los datos del reporte PDF «Resumen de costos» de esta ejecución. "
        "Llámala una sola vez, al final, después de escribir tu informe. Usa solo cifras que "
        "devolvieron tus consultas en esta ejecución. El periodo es el que analizaste (fechas "
        "inclusive). total y previous_total son los totales de ese periodo y del anterior de la "
        "misma duración. services y accounts, ordenados de mayor a menor costo, con el costo del "
        "periodo anterior en previous. daily: omítela si consultaste get_cost_and_usage con "
        "granularidad DAILY sin agrupar para todo el periodo (Mango toma la serie de esa "
        "consulta); si no, el costo de cada día. notes: tu análisis breve en Markdown simple "
        "(párrafos, listas y negritas), sin enlaces ni HTML."
    ),
    "anomaly": (
        "Entrega a Mango los datos del reporte PDF «Investigación de anomalía» de esta "
        "ejecución. Llámala una sola vez, al final, después de escribir tu informe. Usa solo "
        "cifras que devolvieron tus consultas en esta ejecución. expected y actual: gasto "
        "esperado y real de la anomalía. service y account_name: el servicio y el nombre de la "
        "cuenta de la causa principal. daily: costo diario desde 14 días antes de la anomalía "
        "hasta su último día, con lo esperado por día si lo tienes (si consultaste "
        "get_cost_and_usage diario sin agrupar para esos días, Mango toma el costo de esa "
        "consulta). causes: tipos de uso que la "
        "explican, de mayor a menor impacto. conclusion en Markdown simple y next_step en una "
        "línea, sin enlaces ni HTML. No pongas el id, el monitor ni las fechas de la anomalía: "
        "los pone Mango."
    ),
}


def _inline(schema: dict[str, Any]) -> dict[str, Any]:
    """The JSON schema without ``$ref``: a tool schema the model reads in one piece."""
    defs = schema.pop("$defs", {})

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str):
                return walk(dict(defs[ref.rsplit("/", 1)[-1]]))
            return {k: walk(v) for k, v in node.items() if k != "title"}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    result: dict[str, Any] = walk(schema)
    return result


def tool_spec(report_type: ReportType) -> dict[str, Any]:
    """The ``inline_function`` tool of the harness for a run of this type."""
    model = DATA_MODELS[report_type]
    return {
        "type": "inline_function",
        "name": REPORT_TOOL,
        "config": {
            "inlineFunction": {
                "description": _DESCRIPTIONS[report_type],
                "inputSchema": _inline(model.model_json_schema()),
            }
        },
    }


def report_type(trigger: str, event_type: str | None) -> ReportType:
    """Fixed by the trigger (D86 (7)): an anomaly investigates it; anything else summarizes."""
    return "anomaly" if trigger == "event" and event_type == "cost_anomaly" else "cost_summary"


def reads_costs(tools: Iterable[str]) -> bool:
    """Whether an agent version reads Cost Explorer or billing (``<source>.<tool>`` names)."""
    return any(tool.split(".", 1)[0] in REPORT_SOURCES for tool in tools)


def parse(report_type: ReportType, raw: str | Mapping[str, Any]) -> CostSummaryData | AnomalyData:
    """The data of a report, validated; ``InvalidReportError`` if it is not one."""
    if isinstance(raw, str):
        if len(raw) > MAX_INPUT_CHARS:
            raise InvalidReportError("too large")
        try:
            loaded = json.loads(raw, parse_float=Decimal)
        except ValueError as exc:
            raise InvalidReportError("not JSON") from exc
    else:
        loaded = raw
    if not isinstance(loaded, Mapping):
        raise InvalidReportError("not an object")
    try:
        return DATA_MODELS[report_type].model_validate(dict(loaded))
    except ValueError as exc:
        # Never the model's text in the error: it may be anything (TM-R6).
        raise InvalidReportError("invalid") from exc


# --- The daily series from a query (D87 (4)) ------------------------------------------------


@dataclass(frozen=True)
class ToolCall:
    """A tool call of the run, by its id in the stream: its input and its answer (text)."""

    call_id: str
    name: str
    input: str
    output: str


@dataclass(frozen=True)
class QuerySeries:
    days: dict[date, Decimal]
    accounts: list[str]
    services: list[str]


def _json(text: str) -> Any:
    try:
        return json.loads(text, parse_float=Decimal)
    except ValueError:
        return None


def _answer(text: str) -> Mapping[str, Any] | None:
    """The tool's answer: its JSON, or the JSON in its first MCP text block."""
    loaded = _json(text)
    if isinstance(loaded, Mapping) and isinstance(loaded.get("content"), list):
        for block in loaded["content"]:
            if isinstance(block, Mapping) and isinstance(block.get("text"), str):
                loaded = _json(block["text"])
                break
    return loaded if isinstance(loaded, Mapping) else None


def _daily_query(call: ToolCall) -> QuerySeries | None:  # noqa: PLR0911 - one return per check
    """The series of one ``get_cost_and_usage`` call, if it is a daily cost query without
    grouping, with an answer of the connector's shape."""
    if call.name != COST_QUERY_TOOL or len(call.output) > MAX_QUERY_CHARS:
        return None
    args = _json(call.input)
    answer = _answer(call.output)
    if not isinstance(args, Mapping) or answer is None:
        return None
    if args.get("granularity") != "DAILY" or args.get("group_by"):
        return None
    if answer.get("granularity") != "DAILY" or answer.get("group_by"):
        return None
    if answer.get("metric") not in ("UnblendedCost", "AmortizedCost", "NetUnblendedCost"):
        return None
    days: dict[date, Decimal] = {}
    rows = answer.get("rows")
    if not isinstance(rows, list):
        return None
    for row in rows:
        if not isinstance(row, Mapping) or row.get("keys"):
            return None
        try:
            day = date.fromisoformat(str(row.get("period_start")))
            amount = Decimal(str(row.get("amount")))
        except (ValueError, ArithmeticError):
            return None
        if not amount.is_finite() or abs(amount) > MAX_AMOUNT or day in days:
            return None
        days[day] = _money(amount)
    accounts = args.get("account_ids") or []
    services = args.get("services") or []
    return QuerySeries(
        days=days,
        accounts=[str(a)[:12] for a in accounts][:5] if isinstance(accounts, list) else [],
        services=[str(s)[:MAX_NAME] for s in services][:3] if isinstance(services, list) else [],
    )


def series_from_query(calls: Iterable[ToolCall], start: date, end: date) -> QuerySeries | None:
    """The last daily query of the run that has every day from ``start`` to ``end``."""
    wanted = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    found: QuerySeries | None = None
    for call in calls:
        series = _daily_query(call)
        if series is not None and all(day in series.days for day in wanted):
            found = QuerySeries(
                days={day: series.days[day] for day in wanted},
                accounts=series.accounts,
                services=series.services,
            )
    return found


# --- The document: what Mango stores for the function to draw -------------------------------


def build(
    report_type: ReportType,
    data: CostSummaryData | AnomalyData,
    calls: Iterable[ToolCall],
) -> dict[str, Any]:
    """What the run keeps (``report_data``): the validated data and where its series came
    from. The series of a matching query replaces the agent's copy (D87 (4))."""
    calls = list(calls)
    source: dict[str, Any] = {"daily": "agent"}
    if isinstance(data, CostSummaryData):
        query = series_from_query(calls, data.period_start, data.period_end)
        if query is not None:
            data = data.model_copy(
                update={"daily": [DayCost(date=d, cost=c) for d, c in query.days.items()]}
            )
            source = {"daily": "query", "accounts": query.accounts, "services": query.services}
        elif not data.daily:
            raise InvalidReportError("no daily series")
    else:
        if not data.daily:
            raise InvalidReportError("no daily series")
        query = series_from_query(calls, data.daily[0].date, data.daily[-1].date)
        if query is not None:
            data = data.model_copy(
                update={
                    "daily": [
                        DayCostExpected(date=d.date, cost=query.days[d.date], expected=d.expected)
                        for d in data.daily
                    ]
                }
            )
            source = {"daily": "query", "accounts": query.accounts, "services": query.services}
    tools = sorted({c.name for c in calls if c.name})[:20]
    return {
        "type": report_type,
        "data": data.model_dump(mode="json"),
        "source": source,
        "tools": tools,
    }


def load(stored: str) -> tuple[ReportType, CostSummaryData | AnomalyData, dict[str, Any]]:
    """What ``build`` stored, validated again (the function trusts nothing it reads)."""
    loaded = _json(stored)
    if not isinstance(loaded, Mapping) or loaded.get("type") not in DATA_MODELS:
        raise InvalidReportError("not a stored report")
    kind: ReportType = loaded["type"]
    data = parse(kind, loaded.get("data") or {})
    source = loaded.get("source")
    return kind, data, dict(source) if isinstance(source, Mapping) else {"daily": "agent"}


# --- What the server computes ---------------------------------------------------------------


@dataclass(frozen=True)
class Row:
    label: str
    detail: str | None
    cost: Decimal
    previous: Decimal | None
    share: Decimal
    """Of the largest row (the bar), 0 to 1."""


@dataclass(frozen=True)
class Table:
    rows: list[Row]
    others: int
    others_cost: Decimal | None
    others_previous: Decimal | None
    total: Decimal
    total_previous: Decimal | None


def change(cost: Decimal, previous: Decimal | None) -> Decimal | None:
    """Percentage change, only when the earlier amount is at least USD 1 (FinOps' rule)."""
    if previous is None or previous < 1:
        return None
    return ((cost - previous) / previous * 100).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)


def _sum(values: Iterable[Decimal | None]) -> Decimal | None:
    items = list(values)
    if not items or any(v is None for v in items):
        return None
    return sum((v for v in items if v is not None), Decimal(0))


def table(
    rows: list[tuple[str, str | None, Decimal, Decimal | None]],
    *,
    total: Decimal,
    total_previous: Decimal | None,
    shown: int = MAX_ROWS_SHOWN,
) -> Table:
    """Rows from the highest cost, the rest in one «Otros» row whose amount is what the total
    leaves (so «Otros» also counts what the agent did not list), bars against the largest."""
    ordered = sorted(rows, key=lambda r: r[2], reverse=True)
    head, rest = ordered[:shown], ordered[shown:]
    top = max((r[2] for r in head), default=Decimal(0))
    listed = sum((r[2] for r in head), Decimal(0))
    listed_previous = _sum(r[3] for r in head)
    others_cost = total - listed
    others_previous = (
        total_previous - listed_previous
        if total_previous is not None and listed_previous is not None
        else None
    )
    has_others = bool(rest) or others_cost.copy_abs() >= CENT
    return Table(
        rows=[
            Row(
                label=label,
                detail=detail,
                cost=cost,
                previous=previous,
                share=(cost / top).quantize(Decimal("0.001"))
                if top > 0 and cost > 0
                else Decimal(0),
            )
            for label, detail, cost, previous in head
        ],
        others=len(rest),
        others_cost=others_cost if has_others else None,
        others_previous=others_previous if has_others else None,
        total=total,
        total_previous=total_previous,
    )


def shares(impacts: list[Decimal]) -> list[Decimal]:
    """Share of each impact in their sum, as whole percentages."""
    whole = sum((i for i in impacts if i > 0), Decimal(0))
    if whole <= 0:
        return [Decimal(0) for _ in impacts]
    return [
        (max(i, Decimal(0)) / whole * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP)
        for i in impacts
    ]


# --- Names and keys -------------------------------------------------------------------------


def slug(name: str, limit: int = 60) -> str:
    """Lowercase, without accents, with hyphens and at most ``limit`` characters (design)."""
    plain = unicodedata.normalize("NFD", name).encode("ascii", "ignore").decode("ascii")
    out = re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-")[:limit].rstrip("-")
    return out or "tarea"


def file_name(
    task_name: str,
    *,
    at: datetime,
    timezone: str | None,
    anomaly_id: str | None,
) -> str:
    """``{tarea}-{AAAA-MM-DD}-{hhmm}.pdf`` in the task's zone; an anomaly's, with its UTC date
    and the 8 first characters of its id (D86 (8))."""
    if anomaly_id:
        local = at.astimezone(UTC)
        return f"{slug(task_name)}-{local:%Y-%m-%d}-{anomaly_id[:8]}.pdf"
    local = at.astimezone(ZoneInfo(timezone or "UTC"))
    return f"{slug(task_name)}-{local:%Y-%m-%d}-{local:%H%M}.pdf"


def object_key(owner_id: str, task_id: str, run_id: str, name: str) -> str:
    """The object of a run's PDF, under its owner's prefix (D86 (3))."""
    if not _OWNER.fullmatch(owner_id) or not _ID.fullmatch(task_id) or not _ID.fullmatch(run_id):
        raise ValueError("invalid ids")
    if not re.fullmatch(r"[a-z0-9-]{1,60}-\d{4}-\d{2}-\d{2}-[0-9a-f]{4,8}\.pdf", name):
        raise ValueError("invalid file name")
    return f"owner/{owner_id}/{task_id}/{run_id}/{name}"


def valid_event(event: Any) -> tuple[str, str, str]:
    """The event of the function: a task, a run and the sort key of the run, nothing else."""
    if not isinstance(event, Mapping) or set(event) != {"task_id", "run_id", "run_sk"}:
        raise ValueError("unexpected event")
    task_id, run_id, run_sk = (str(event[k]) for k in ("task_id", "run_id", "run_sk"))
    if not _ID.fullmatch(task_id) or not _ID.fullmatch(run_id) or not _RUN_SK.fullmatch(run_sk):
        raise ValueError("unexpected event")
    if not run_sk.endswith(f"#{run_id}"):
        raise ValueError("unexpected event")
    return task_id, run_id, run_sk


def keep_until(queued_at: int) -> date:
    """The day the run and its PDF are deleted (D78 (6), D86 (3))."""
    return (datetime.fromtimestamp(queued_at, UTC) + timedelta(days=RETENTION_DAYS)).date()
