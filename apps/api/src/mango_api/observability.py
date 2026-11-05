"""Observabilidad (D108 (b), D109 (b); threat model ``observability-threat-model.md``): each answer
of an agent as a trace, with its model and tool calls, duration, tokens, status and cost.

The spans are read by the function ``Mango-<ns>-TraceReader`` (``functions/trace-reader``), which
returns metadata only. mango-api joins each trace with the reference its turn wrote when it bound
its runtime session (``observability_store.py``): that gives the person, the agent's version, the
conversation's kind and the price; a trace without one is shown without a person.

Security notes (security-best-practices, FastAPI):
* The route declares its Cedar action, ``ViewObservability``: administrators only (D109 (b)),
  checked again in process (``is_admin``). Audited as a read. Administrators already see who
  made each turn in Auditoría (``agent.completed``), so the person adds nothing to what they see.
* Query parameters are closed lists or have the shape of an agent id; ``limit``, ``offset`` and
  the search ``q`` are bounded (VALID-001). ``q`` is only compared as text with what the response
  already shows (email, id, tool name); it never reaches the trace reader nor a log.
* The response is an explicit model (RESP-001): the runtime ``session.id``, the harness's
  ``traceId``, the conversation id and any text of a span have no field in it (TM-OB1, TM-OB4).
  The id of a trace is Mango's own and random (D108 (3)).
* One reading is bounded by the function (time, pages, 1,000 traces: ``capped``), limited per
  administrator and shared between tasks, and cached for a minute per range and agent: the page
  and its filters read the cache (TM-OB6).
* Text that comes from a span (model and tool names) was checked for shape by the function and is
  checked again here; the SPA renders it as text.
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import json
import logging
import math
import re
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Annotated, Any, Literal, Protocol, cast

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from mango_api.directory import DirectoryUnavailableError
from mango_api.observability_store import TraceRef, TraceRefs, TraceRefsUnavailableError
from mango_api.rate_limits import Limiter
from mango_api.web import ApiError, Caller, rate_limited
from mango_core.agents import AGENT_ID_PATTERN
from mango_core.budget_turns import TokenUsage, token_cost
from mango_core.playground import PLAYGROUND_ID

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
READS_PER_MINUTE = 30
CACHE_SECONDS = 60.0
CACHE_ENTRIES = 64
MAX_EMAIL_LOOKUPS = 50
"""Distinct people one reading resolves to an email; the rest are shown by id."""
EMAIL_CACHE_SECONDS = 600.0
EMAIL_CACHE_ENTRIES = 4096
TOP_TOOLS = 10
PAGE = 40
MAX_PAGE = 200
MAX_QUERY = 100
"""Longest search the view sends (tool, email or id: «Buscar tool, persona o ID de traza»)."""
TRACE_READER_TIMEOUT_SECONDS = 30
"""How long mango-api waits for one reading: the function stops at 20 s and times out at 25."""
EVALS_ID = "evals"
"""The evals harness (D110 (3)): the trace reader never reads it."""
START_SKEW_SECONDS = 2
"""How much earlier than its turn's reservation a trace may say it started (clocks)."""
RANGES: dict[str, timedelta] = {
    "1h": timedelta(hours=1),
    "6h": timedelta(hours=6),
    "24h": timedelta(hours=24),
}
Range = Literal["1h", "6h", "24h"]
StatusFilter = Literal["all", "error", "slow"]
Origin = Literal["chat", "task", "playground", "eval"]
_TRACE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_SESSION_RE = re.compile(r"^[0-9a-f]{64}$")
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
_TOOL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_MS_PER_HOUR = 3_600_000


class TracesUnavailableError(Exception):
    """The trace reader failed or answered something it never answers."""


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _Read(BaseModel):
    """What the trace reader answers; checked again here: it reads spans nobody vouches for."""

    model_config = ConfigDict(extra="forbid", strict=True)


class _ReadTokens(_Read):
    input: int = Field(ge=0)
    output: int = Field(ge=0)
    cache_read: int = Field(ge=0)
    cache_write: int = Field(ge=0)


class _ReadStep(_Read):
    kind: Literal["model", "tool"]
    name: str | None
    offset_ms: int = Field(ge=0)
    duration_ms: int = Field(ge=0)
    failed: bool
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)


class _ReadTrace(_Read):
    trace_id: str = Field(pattern=_TRACE_ID_RE.pattern)
    session_id: str | None = Field(default=None, pattern=_SESSION_RE.pattern)
    agent_id: str = Field(pattern=AGENT_ID_PATTERN)
    start_ms: int = Field(gt=0)
    duration_ms: int = Field(ge=0)
    failed: bool
    model: str | None = Field(default=None, pattern=_MODEL_RE.pattern)
    tokens: _ReadTokens | None
    model_calls: int = Field(ge=0)
    tool_calls: int = Field(ge=0)
    spans: list[_ReadStep] = Field(max_length=60)
    more_spans: int = Field(ge=0)


class _Reading(_Read):
    traces: list[_ReadTrace] = Field(max_length=1000)
    capped: bool
    unreadable: int = Field(ge=0)
    found: dict[str, int]


class SpanOut(_Strict):
    kind: Literal["model", "tool"]
    name: str | None
    """The model of a model call, the tool of a tool call (as the harness names them)."""
    offset_ms: int
    duration_ms: int
    failed: bool
    input_tokens: int | None
    output_tokens: int | None


class TraceOut(_Strict):
    id: str
    """Mango's own random id of the trace (D108 (3)), never the harness's ``traceId``: «Copiar
    ID». A trace of a turn keeps it (the turn's random key and the trace's place in the turn);
    one without a turn gets a new one at every reading."""
    agent_id: str
    agent_name: str | None
    agent_version: int | None
    playground: bool
    """A test of the Playground (D91) rather than a turn of a published agent."""
    origin: Literal["chat", "task", "playground", "eval"] | None
    """Where the turn came from (D106); ``None`` without a turn of Mango."""
    user_id: str | None
    user_email: str | None
    """The person of the turn; ``None`` when the trace has no turn of Mango."""
    matched: bool
    """The trace was joined with the turn mango-api recorded; without it, no person nor cost."""
    started_at: str
    duration_ms: int
    status: Literal["ok", "error"]
    model: str | None
    input_tokens: int | None
    output_tokens: int | None
    cost_usd: str | None
    """Tokens at the price the turn reserved with; model only (no guardrail)."""
    model_calls: int
    tool_calls: int
    tools_failed: int
    spans: list[SpanOut]
    more_spans: int


class SummaryOut(_Strict):
    traces: int
    agents: int
    p50_ms: int | None
    p95_ms: int | None
    failed: int
    failed_by_tool: int
    """Traces with a failed tool call («{n} trazas con una tool fallida»)."""
    error_percent: str
    cost_usd: str
    """Of the traces with a known price."""
    input_tokens: int
    output_tokens: int


class HourOut(_Strict):
    hour: str
    ok: int
    error: int


class AgentLatencyOut(_Strict):
    agent_id: str
    agent_name: str | None
    traces: int
    p95_ms: int
    failed: int


class ToolOut(_Strict):
    name: str
    calls: int
    failed: int
    p95_ms: int


class ObservabilityOut(_Strict):
    range: Range
    generated_at: str
    capped: bool
    """A cap of the reading cut the window: what is shown is its newest part («al menos»)."""
    unreadable: int
    """Spans of the installation whose shape could not be read (counted, never shown)."""
    unmatched: int
    """Traces without a turn of Mango (written by a harness of the installation with no turn
    recorded: before this view existed, or by something that is not mango-api)."""
    summary: SummaryOut
    hourly: list[HourOut]
    by_agent: list[AgentLatencyOut]
    tools: list[ToolOut]
    total: int
    """Traces that match ``status`` and ``q``; ``traces`` is the page of them asked for. The
    summary, the hours, the agents and the tools are of the whole reading."""
    offset: int
    traces: list[TraceOut]


# --- Data access ------------------------------------------------------------------------


class TraceSource(Protocol):
    def read(self, start_ms: int, end_ms: int, agent_id: str | None) -> dict[str, Any]: ...


@dataclass
class LambdaTraceSource:
    """``InvokeFunction`` synchronously on ``Mango-<ns>-TraceReader``."""

    client: Any
    function: str

    def read(self, start_ms: int, end_ms: int, agent_id: str | None) -> dict[str, Any]:
        event = {"start": start_ms, "end": end_ms, "agent": agent_id}
        try:
            resp = self.client.invoke(
                FunctionName=self.function,
                InvocationType="RequestResponse",
                Payload=json.dumps(event).encode(),
            )
            payload = resp["Payload"].read()
        except (BotoCoreError, ClientError) as exc:
            raise TracesUnavailableError(type(exc).__name__) from None
        if resp.get("FunctionError"):
            # The function's own log says why; its answer is not logged here (TM-OB1).
            raise TracesUnavailableError("function error")
        try:
            out = json.loads(payload)
        except ValueError:
            raise TracesUnavailableError("unexpected answer") from None
        if not isinstance(out, dict):
            raise TracesUnavailableError("unexpected answer")
        return out


class Emails:
    """Email of a person by ``sub``, from the directory, cached a few minutes."""

    def __init__(
        self,
        lookup: Callable[[str], str | None],
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._lookup = lookup
        self._monotonic = monotonic
        self._cache: dict[str, tuple[float, str | None]] = {}

    def of(self, user_ids: list[str]) -> dict[str, str]:
        now = self._monotonic()
        out: dict[str, str] = {}
        looked = 0
        for user_id in sorted(set(user_ids)):
            hit = self._cache.get(user_id)
            if hit is None or now - hit[0] >= EMAIL_CACHE_SECONDS:
                if looked >= MAX_EMAIL_LOOKUPS:
                    continue
                looked += 1
                try:
                    email = self._lookup(user_id)
                except DirectoryUnavailableError:
                    logger.warning("an email of the observability view could not be read")
                    continue
                if len(self._cache) >= EMAIL_CACHE_ENTRIES:
                    self._cache.clear()
                hit = self._cache[user_id] = (now, email)
            if hit[1]:
                out[user_id] = hit[1]
        return out


# --- Use cases --------------------------------------------------------------------------


@dataclass
class ObservabilityDeps:
    traces: TraceSource
    refs: TraceRefs
    emails: Emails
    agent_names: Callable[[], dict[str, str]]
    limiter: Limiter
    clock: Callable[[], datetime] = lambda: datetime.now(UTC)
    monotonic: Callable[[], float] = time.monotonic
    _cache: dict[tuple[str, str | None], tuple[float, "_Loaded"]] = field(default_factory=dict)


@dataclass(frozen=True)
class _Loaded:
    """One reading of a range and agent, joined and summarized: what the cache keeps."""

    out: ObservabilityOut
    slow_ms: int | None


def percentile(values: list[int], q: float) -> int | None:
    """Nearest-rank percentile; ``None`` without values."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(q * len(ordered)) - 1)]


def _iso_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, UTC).isoformat(timespec="milliseconds")


def _days(start: datetime, end: datetime) -> list[date]:
    """Days whose references may belong to a trace of the window (a turn reserves before its
    trace starts, so the day before the window too)."""
    first = (start - timedelta(hours=1)).date()
    out: list[date] = []
    day = first
    while day <= end.date():
        out.append(day)
        day += timedelta(days=1)
    return out


def join(traces: list[_ReadTrace], refs: list[TraceRef]) -> dict[str, TraceRef]:
    """The turn of each trace: the latest reference of its session that reserved before the
    trace started; by ``trace_id``."""
    by_session: dict[str, list[TraceRef]] = {}
    for ref in refs:
        by_session.setdefault(ref.session_id, []).append(ref)
    for refs_of in by_session.values():
        refs_of.sort(key=lambda r: r.started_at)
    out: dict[str, TraceRef] = {}
    for trace in traces:
        if trace.session_id is None:
            continue
        started = trace.start_ms // 1000 + START_SKEW_SECONDS
        candidates = [r for r in by_session.get(trace.session_id, []) if r.started_at <= started]
        # Same agent, or the Playground's harness testing that agent's draft.
        if candidates and (
            candidates[-1].agent_id == trace.agent_id
            or (candidates[-1].playground and trace.agent_id == PLAYGROUND_ID)
        ):
            out[trace.trace_id] = candidates[-1]
    return out


def view_ids(traces: list[_ReadTrace], turns: dict[str, TraceRef]) -> list[str]:
    """The id the view gives each trace (D108 (3)): the random key of its turn and its place
    among the turn's traces (oldest first), or a new random id for a trace without a turn."""
    places: dict[str, int] = {}
    seen: dict[str, int] = {}
    for trace in sorted(traces, key=lambda t: (t.start_ms, t.trace_id)):
        ref = turns.get(trace.trace_id)
        if ref is not None:
            places[trace.trace_id] = seen.get(ref.trace_key, 0)
            seen[ref.trace_key] = places[trace.trace_id] + 1
    out: list[str] = []
    for trace in traces:
        ref = turns.get(trace.trace_id)
        if ref is None:
            out.append(secrets.token_hex(16))
        else:
            out.append(f"{ref.trace_key}{min(places[trace.trace_id], 255):02x}")
    return out


def _trace_out(
    trace: _ReadTrace,
    ref: TraceRef | None,
    names: dict[str, str],
    emails: dict[str, str],
    trace_id: str,
) -> TraceOut:
    agent_id = ref.agent_id if ref is not None else trace.agent_id
    tokens = trace.tokens
    cost = (
        str(
            token_cost(
                TokenUsage(tokens.input, tokens.output, tokens.cache_read, tokens.cache_write),
                ref.price,
            )
        )
        if ref is not None and tokens is not None
        else None
    )
    spans = [
        SpanOut(
            kind=s.kind,
            name=s.name
            if s.name and (_MODEL_RE if s.kind == "model" else _TOOL_RE).fullmatch(s.name)
            else None,
            offset_ms=s.offset_ms,
            duration_ms=s.duration_ms,
            failed=s.failed,
            input_tokens=s.input_tokens,
            output_tokens=s.output_tokens,
        )
        for s in trace.spans
    ]
    return TraceOut(
        id=trace_id,
        agent_id=agent_id,
        agent_name=names.get(agent_id),
        agent_version=ref.agent_version if ref is not None else None,
        playground=(ref.playground if ref is not None else trace.agent_id == PLAYGROUND_ID),
        origin=cast(Origin, ref.origin) if ref is not None and ref.origin else None,
        user_id=ref.user_id if ref is not None else None,
        user_email=emails.get(ref.user_id) if ref is not None else None,
        matched=ref is not None,
        started_at=_iso_ms(trace.start_ms),
        duration_ms=trace.duration_ms,
        status="error" if trace.failed else "ok",
        model=trace.model or (ref.model if ref is not None else None),
        input_tokens=tokens.input if tokens is not None else None,
        output_tokens=tokens.output if tokens is not None else None,
        cost_usd=cost,
        model_calls=trace.model_calls,
        tool_calls=trace.tool_calls,
        tools_failed=sum(1 for s in trace.spans if s.kind == "tool" and s.failed),
        spans=spans,
        more_spans=trace.more_spans,
    )


def summarize(
    traces: list[TraceOut], *, start: datetime, end: datetime, names: dict[str, str]
) -> tuple[SummaryOut, list[HourOut], list[AgentLatencyOut], list[ToolOut]]:
    durations = [t.duration_ms for t in traces]
    failed = sum(1 for t in traces if t.status == "error")
    costs = [Decimal(t.cost_usd) for t in traces if t.cost_usd is not None]
    summary = SummaryOut(
        traces=len(traces),
        agents=len({t.agent_id for t in traces}),
        p50_ms=percentile(durations, 0.5),
        p95_ms=percentile(durations, 0.95),
        failed=failed,
        failed_by_tool=sum(1 for t in traces if t.tools_failed),
        error_percent=(
            str((Decimal(failed * 100) / len(traces)).quantize(Decimal("0.1"))) if traces else "0.0"
        ),
        cost_usd=str(sum(costs, Decimal(0)).quantize(Decimal("0.000001"))),
        input_tokens=sum(t.input_tokens or 0 for t in traces),
        output_tokens=sum(t.output_tokens or 0 for t in traces),
    )
    first_hour = int(start.timestamp() * 1000) // _MS_PER_HOUR
    last_hour = (int(end.timestamp() * 1000) - 1) // _MS_PER_HOUR
    hours = {h: [0, 0] for h in range(first_hour, last_hour + 1)}
    for t in traces:
        hour = int(datetime.fromisoformat(t.started_at).timestamp() * 1000) // _MS_PER_HOUR
        if hour in hours:
            hours[hour][1 if t.status == "error" else 0] += 1
    hourly = [
        HourOut(hour=_iso_ms(h * _MS_PER_HOUR), ok=ok, error=error)
        for h, (ok, error) in sorted(hours.items())
    ]
    agents: dict[str, list[TraceOut]] = {}
    for t in traces:
        agents.setdefault(t.agent_id, []).append(t)
    by_agent = sorted(
        (
            AgentLatencyOut(
                agent_id=agent_id,
                agent_name=names.get(agent_id),
                traces=len(of),
                p95_ms=percentile([t.duration_ms for t in of], 0.95) or 0,
                failed=sum(1 for t in of if t.status == "error"),
            )
            for agent_id, of in agents.items()
        ),
        key=lambda a: (-a.p95_ms, a.agent_id),
    )
    calls: dict[str, list[SpanOut]] = {}
    for t in traces:
        for s in t.spans:
            if s.kind == "tool" and s.name:
                calls.setdefault(s.name, []).append(s)
    tools = sorted(
        (
            ToolOut(
                name=name,
                calls=len(of),
                failed=sum(1 for s in of if s.failed),
                p95_ms=percentile([s.duration_ms for s in of], 0.95) or 0,
            )
            for name, of in calls.items()
        ),
        key=lambda x: (-x.failed, -x.p95_ms, x.name),
    )[:TOP_TOOLS]
    return summary, hourly, by_agent, tools


def load(deps: ObservabilityDeps, window: Range, agent_id: str | None) -> _Loaded:
    end = deps.clock()
    start = end - RANGES[window]
    start_ms, end_ms = int(start.timestamp() * 1000), int(end.timestamp() * 1000)
    raw = deps.traces.read(start_ms, end_ms, agent_id)
    try:
        reading = _Reading.model_validate(raw)
    except ValidationError:
        # Never the answer itself in the log: it is read from spans (TM-OB1).
        raise TracesUnavailableError("unexpected answer") from None
    try:
        refs, refs_capped = deps.refs.read(_days(start, end))
    except TraceRefsUnavailableError:
        raise TracesUnavailableError("references unavailable") from None
    turns = join(reading.traces, refs)
    emails = deps.emails.of([ref.user_id for ref in turns.values()])
    names = deps.agent_names()
    traces = [
        _trace_out(t, turns.get(t.trace_id), names, emails, view_id)
        for t, view_id in zip(reading.traces, view_ids(reading.traces, turns), strict=True)
    ]
    traces.sort(key=lambda t: (t.started_at, t.id), reverse=True)
    summary, hourly, by_agent, tools = summarize(traces, start=start, end=end, names=names)
    out = ObservabilityOut(
        range=window,
        generated_at=end.isoformat(timespec="seconds"),
        capped=reading.capped or refs_capped,
        unreadable=reading.unreadable,
        unmatched=sum(1 for t in traces if not t.matched),
        summary=summary,
        hourly=hourly,
        by_agent=by_agent,
        tools=tools,
        total=len(traces),
        offset=0,
        traces=traces,
    )
    return _Loaded(out=out, slow_ms=summary.p95_ms)


def cached(deps: ObservabilityDeps, window: Range, agent_id: str | None) -> _Loaded:
    """One reading per range and agent for a minute, for every administrator: they all see the
    same (D109 (b)). The filters and pages of the view read it."""
    key = (window, agent_id)
    now = deps.monotonic()
    hit = deps._cache.get(key)
    if hit is not None and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    loaded = load(deps, window, agent_id)
    if len(deps._cache) >= CACHE_ENTRIES:
        deps._cache.clear()
    deps._cache[key] = (now, loaded)
    return loaded


def matches(trace: TraceOut, query: str) -> bool:
    """«Buscar tool, persona o ID de traza»: a case-insensitive part of the person's email, of the
    view's id or of a tool's name. Only what the response already shows is searched."""
    needle = query.strip().casefold()
    if not needle:
        return True
    haystack = [trace.id, trace.user_email or ""]
    haystack += [s.name for s in trace.spans if s.kind == "tool" and s.name]
    return any(needle in value.casefold() for value in haystack)


def page(
    loaded: _Loaded, status: StatusFilter, offset: int, limit: int, query: str = ""
) -> ObservabilityOut:
    traces = [t for t in loaded.out.traces if matches(t, query)]
    if status == "error":
        traces = [t for t in traces if t.status == "error"]
    elif status == "slow":
        slow = loaded.slow_ms
        traces = [t for t in traces if slow is not None and t.duration_ms >= slow]
    return loaded.out.model_copy(
        update={"total": len(traces), "offset": offset, "traces": traces[offset : offset + limit]}
    )


def observability(  # noqa: PLR0917 - the query of one reading, all required
    deps: ObservabilityDeps,
    window: Range,
    agent_id: str | None,
    status: StatusFilter,
    offset: int,
    limit: int,
    query: str = "",
) -> ObservabilityOut:
    try:
        loaded = cached(deps, window, agent_id)
    except TracesUnavailableError as exc:
        logger.warning("observability unavailable: %s", exc)
        raise ApiError(503, "observability_unavailable", "please try again") from None
    return page(loaded, status, offset, limit, query)


# --- Routes -----------------------------------------------------------------------------


Authorize = Callable[..., Awaitable[None]]


def observability_router(
    deps: ObservabilityDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    router = APIRouter(prefix="/api/observability")

    async def view(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        await authorize(caller, "ViewObservability", *PLATFORM, read_only=True)
        # Defense in depth: the Cedar policy already requires isAdmin (D109 (b)).
        if not caller.user.is_admin:
            raise ApiError(403, "forbidden", "not allowed")
        return caller

    @router.get("", response_model=ObservabilityOut)
    async def get_observability(  # noqa: PLR0917 - FastAPI query parameters
        caller: Annotated[Caller, Depends(view)],
        range: Annotated[Range, Query()] = "24h",  # noqa: A002
        agent: Annotated[str | None, Query(pattern=AGENT_ID_PATTERN)] = None,
        status: Annotated[StatusFilter, Query()] = "all",
        offset: Annotated[int, Query(ge=0, le=1000)] = 0,
        limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = PAGE,
        q: Annotated[str, Query(max_length=MAX_QUERY)] = "",
    ) -> ObservabilityOut:
        if agent == EVALS_ID:
            # The evals harness is never read (D110 (3)).
            raise ApiError(422, "invalid_agent", "not an agent of this view")
        user_id = caller.user.user_id
        if not deps.limiter.allow(user_id):
            raise rate_limited(deps.limiter.retry_after(user_id))
        return await asyncio.to_thread(observability, deps, range, agent, status, offset, limit, q)

    return router
