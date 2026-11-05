"""Costos (D105, D106, D107; threat model ``costs-threat-model.md``): what the organization spent
on Amazon Bedrock in a month, per day, per agent, per model and per origin, with the month
before, the projection and the budget of each agent.

The numbers are the day counters of ``mango_core.usage_days``, written in the transaction that
closes each turn: ``DAY#ORG`` (D102), ``DAY#AGENT#<id>`` (D104), ``DAY#MODEL#<model id>`` and
``DAY#SOURCE#<origin>`` (D106). Each breakdown counts from the day its counters started
(``counted_since``); what the organization spent that no row of a breakdown holds (titles in the
agents', turns recorded before a counter) is ``unattributed_usd``, never spread over the rows.
«Por equipo», «Asignado a equipos» and «Oportunidades de ahorro» have no source: «Próximamente»
(D107), not answered here.

Security notes (security-best-practices, FastAPI):
* The route declares its Cedar action, ``ViewCosts`` (administrators and central FinOps, deny by
  default), audited as a read. Both see the same, the budgets of the agents included (D105 (c),
  which widens D17 and D89 (1) for this view).
* The only input is ``month``: a pattern, and one of the months the counters keep (the current
  one and the eleven before). No parameter chooses agents, models or people: the keys to read
  come from the catalogs, on the server.
* Never people or conversations: no ``DAY#USER#``, ``DAY#AREA#`` or ``USER#`` key is read.
* No ``Scan``: one bounded ``Query`` per counter (the days of the month and the one before) and a
  ``BatchGetItem`` of the agents' monthly budgets. At most ``MAX_AGENTS`` agents and
  ``MAX_MODELS`` models per read, limited per person and cached for a short time (TM-C3).
  Responses use explicit models (VALID-001, RESP-001).
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import calendar
import logging
import re
import time
from collections.abc import Awaitable, Callable, Collection, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict

from mango_api.rate_limits import Limiter
from mango_api.web import ApiError, Caller, rate_limited
from mango_core import usage_days
from mango_core.playground import PLAYGROUND_ID

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
READS_PER_MINUTE = 30
CACHE_SECONDS = 30.0
CACHE_ENTRIES = 64
MONTHS_BACK = 11
"""The current month and the eleven before: the counters expire after 400 days, so the oldest
month still has the one before it to compare."""
MAX_AGENTS = 500
MAX_MODELS = 100
MIN_PROJECTION_DAYS = 5
"""As the design (``costs2.jsx``): with fewer days of the month there is no projection."""
WORKERS = 8
"""Concurrent queries of one read: the counters are one partition each."""
_BATCH = 100
"""Keys per ``BatchGetItem``."""
_BATCH_ATTEMPTS = 4
_MONTH = re.compile(r"^\d{4}-(?:0[1-9]|1[0-2])$")
MONTH_PATTERN = _MONTH.pattern
_CENT = Decimal("0.01")
_MICRO = Decimal("0.000001")
_ZERO = Decimal(0)


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CostDayOut(_Strict):
    day: str
    """``yyyy-mm-dd``, UTC."""
    spent_usd: str
    turns: int
    """Turns that reached the agent (real, not estimated)."""


class CostRowOut(_Strict):
    id: str
    """The agent's id (``playground`` for the Playground's tests), the model id or the origin
    (``chat``, ``task``, ``playground``, ``eval``)."""
    spent_usd: str
    turns: int
    previous_usd: str
    """The same counter in the month before."""
    projected_usd: str | None
    """At the current pace, at the end of the month; ``None`` for a closed month or before
    ``MIN_PROJECTION_DAYS`` days."""


class AgentCostBudgetOut(_Strict):
    limit_usd: str
    spent_usd: str
    """What the agent's budget counts this month (``spent`` and ``held``, as Presupuestos): it
    includes the Playground's tests of the agent, which its day counter does not."""


class AgentCostOut(CostRowOut):
    name: str | None
    """The name of its published (or else retired) version; ``None`` for the Playground or an
    agent the catalog does not know."""
    category: str | None
    model: str | None
    """Its default model now: what it runs on may have changed during the month."""
    budget: AgentCostBudgetOut | None
    """Only in the current month: the limits of past months are not kept."""


class CostBreakdownOut(_Strict):
    counted_since: str | None
    """The first day its counters have; ``None`` before the first one. A month before it is not
    a month without spend."""
    unattributed_usd: str
    """What the organization spent this month that no row holds (it is never negative)."""
    previous_unattributed_usd: str


class AgentsBreakdownOut(CostBreakdownOut):
    rows: list[AgentCostOut]
    """The agents with spend in the month or the one before, the most spent first."""


class CostsBreakdownOut(CostBreakdownOut):
    rows: list[CostRowOut]


class CostsOut(_Strict):
    month: str
    """``yyyy-mm``."""
    previous_month: str
    days_in_month: int
    elapsed_days: int
    """Days of the month with data so far: today's day in the current month, all in a past
    one."""
    closed: bool
    """A past month: no projection."""
    counted_since: str | None
    """The first day of the organization's counter."""
    days: list[CostDayOut]
    """Each day of the month up to ``elapsed_days``, oldest first."""
    previous_days: list[CostDayOut]
    """Each day of the month before."""
    spent_usd: str
    turns: int
    previous_usd: str
    previous_turns: int
    projected_usd: str | None
    agents: AgentsBreakdownOut
    models: CostsBreakdownOut
    sources: CostsBreakdownOut
    """Always the four origins, in this order: ``chat``, ``task``, ``playground``, ``eval``."""


# --- Data -------------------------------------------------------------------------------


@dataclass(frozen=True)
class AgentInfo:
    name: str
    category: str
    model: str | None


@dataclass
class CostsDeps:
    table: str
    """The Budgets table."""
    dynamodb: "DynamoDBClient"
    """mango-api's own client: only organization-wide counters are read."""
    agents: Callable[[], Mapping[str, AgentInfo]]
    """The published and retired agents by id (published wins)."""
    models: Callable[[], Collection[str]]
    """The model ids of the catalog and the auxiliary model."""
    agent_limit: Callable[[], Decimal]
    """The monthly limit of every agent (D17: the default)."""
    default_agent: str
    """The agent of the release, which has a budget even before its first turn."""
    clock: Callable[[], datetime]
    limiter: Limiter
    monotonic: Callable[[], float] = time.monotonic
    _cache: dict[tuple[str, str], tuple[float, CostsOut]] = field(default_factory=dict)


@dataclass(frozen=True)
class _Month:
    month: str
    previous: str
    days: list[str]
    previous_days: list[str]
    days_in_month: int
    closed: bool


def _first(month: str) -> date:
    year, number = (int(part) for part in month.split("-"))
    return date(year, number, 1)


def _all_days(first: date) -> list[str]:
    count = calendar.monthrange(first.year, first.month)[1]
    return [(first + timedelta(days=offset)).isoformat() for offset in range(count)]


def month_of(month: str, today: date) -> _Month:
    """The days to read for ``month``; ``ApiError`` 422 if it is not one the counters keep."""
    if not _MONTH.fullmatch(month):
        raise ApiError(422, "invalid_month", "month must be yyyy-mm")
    first = _first(month)
    current = today.replace(day=1)
    oldest = current
    for _ in range(MONTHS_BACK):
        oldest = (oldest - timedelta(days=1)).replace(day=1)
    if first > current or first < oldest:
        raise ApiError(422, "invalid_month", "that month is not kept")
    previous = (first - timedelta(days=1)).replace(day=1)
    days = _all_days(first)
    closed = first < current
    return _Month(
        month=month,
        previous=previous.isoformat()[:7],
        days=days if closed else days[: today.day],
        previous_days=_all_days(previous),
        days_in_month=len(days),
        closed=closed,
    )


def _money(value: Decimal) -> str:
    return str(value.quantize(_CENT))


def _micro(value: Decimal) -> str:
    return str(value.quantize(_MICRO))


def _series(days: list[str], counted: Mapping[str, usage_days.Day]) -> list[CostDayOut]:
    return [
        CostDayOut(
            day=day,
            spent_usd=_micro(found.spent if (found := counted.get(day)) else _ZERO),
            turns=found.turns if found else 0,
        )
        for day in days
    ]


@dataclass(frozen=True)
class _Sum:
    spent: Decimal = _ZERO
    turns: int = 0
    previous: Decimal = _ZERO
    previous_turns: int = 0


def _sum(month: _Month, counted: Mapping[str, usage_days.Day]) -> _Sum:
    current, previous = set(month.days), set(month.previous_days)
    return _Sum(
        spent=sum((d.spent for k, d in counted.items() if k in current), _ZERO),
        turns=sum(d.turns for k, d in counted.items() if k in current),
        previous=sum((d.spent for k, d in counted.items() if k in previous), _ZERO),
        previous_turns=sum(d.turns for k, d in counted.items() if k in previous),
    )


def _projection(month: _Month, spent: Decimal) -> str | None:
    """As the design: the pace of the days so far, over the whole month."""
    elapsed = len(month.days)
    if month.closed or elapsed < MIN_PROJECTION_DAYS:
        return None
    return _money(spent / elapsed * month.days_in_month)


def _row(row_id: str, month: _Month, total: _Sum) -> CostRowOut:
    return CostRowOut(
        id=row_id,
        spent_usd=_money(total.spent),
        turns=total.turns,
        previous_usd=_money(total.previous),
        projected_usd=_projection(month, total.spent),
    )


def _rest(org: _Sum, rows: Collection[_Sum]) -> tuple[str, str]:
    spent = org.spent - sum((r.spent for r in rows), _ZERO)
    previous = org.previous - sum((r.previous for r in rows), _ZERO)
    return _money(max(spent, _ZERO)), _money(max(previous, _ZERO))


def _earliest(days: Collection[str | None]) -> str | None:
    found = [d for d in days if d is not None]
    return min(found) if found else None


class _Reader:
    """The queries of one read, run concurrently (``boto3`` clients are thread-safe)."""

    def __init__(self, deps: CostsDeps, month: _Month, pool: ThreadPoolExecutor) -> None:
        self._deps = deps
        self._month = month
        self._pool = pool

    def days(self, keys: list[str]) -> dict[str, dict[str, usage_days.Day]]:
        first, last = self._month.previous_days[0], self._month.days[-1]
        deps = self._deps

        def one(key: str) -> dict[str, usage_days.Day]:
            return {d.day: d for d in usage_days.read(deps.dynamodb, deps.table, key, first, last)}

        return dict(zip(keys, self._pool.map(one, keys), strict=True))

    def first_days(self, keys: list[str]) -> dict[str, str | None]:
        deps = self._deps
        found = self._pool.map(lambda k: usage_days.first_day(deps.dynamodb, deps.table, k), keys)
        return dict(zip(keys, found, strict=True))


def _budgets(deps: CostsDeps, agent_ids: list[str], month: str) -> dict[str, Decimal]:
    """What each agent's budget counts in ``month`` (``spent`` and ``held``), without a scan."""
    out: dict[str, Decimal] = {}
    for start in range(0, len(agent_ids), _BATCH):
        keys: list[dict[str, Any]] = [
            {"PK": {"S": f"AGENT#{agent_id}"}, "SK": {"S": month}}
            for agent_id in agent_ids[start : start + _BATCH]
        ]
        for _ in range(_BATCH_ATTEMPTS):
            page = deps.dynamodb.batch_get_item(
                RequestItems={
                    deps.table: {
                        "Keys": keys,
                        "ProjectionExpression": "PK, #spent, #held",
                        "ExpressionAttributeNames": {"#spent": "spent", "#held": "held"},
                    }
                }
            )
            for item in page.get("Responses", {}).get(deps.table, []):
                out[item["PK"]["S"].removeprefix("AGENT#")] = Decimal(
                    item.get("spent", {}).get("N", "0")
                ) + Decimal(item.get("held", {}).get("N", "0"))
            unprocessed: dict[str, Any] = dict(page.get("UnprocessedKeys", {}))
            keys = list(unprocessed.get(deps.table, {}).get("Keys", []))
            if not keys:
                break
        if keys:
            raise RuntimeError("budgets not read")
    return out


def _agent_ids(deps: CostsDeps, agents: Mapping[str, AgentInfo]) -> list[str]:
    ids = {deps.default_agent, PLAYGROUND_ID, *agents}
    valid = sorted(a for a in ids if usage_days.is_agent(a))
    if len(valid) > MAX_AGENTS:
        logger.warning("costs: %d agents, only %d are read", len(valid), MAX_AGENTS)
    return valid[:MAX_AGENTS]


def _model_ids(deps: CostsDeps, agents: Mapping[str, AgentInfo]) -> list[str]:
    ids = {*deps.models(), *(a.model for a in agents.values() if a.model)}
    valid = sorted(m for m in ids if usage_days.is_model(m))
    if len(valid) > MAX_MODELS:
        logger.warning("costs: %d models, only %d are read", len(valid), MAX_MODELS)
    return valid[:MAX_MODELS]


def _agents_breakdown(
    deps: CostsDeps,
    month: _Month,
    *,
    org: _Sum,
    agents: Mapping[str, AgentInfo],
    counted: Mapping[str, Mapping[str, usage_days.Day]],
    since: str | None,
) -> AgentsBreakdownOut:
    sums = {agent_id: _sum(month, days) for agent_id, days in counted.items()}
    active = [a for a, s in sums.items() if s.spent > 0 or s.previous > 0 or s.turns > 0]
    # The Playground has no budget of its own: its tests charge the tested agent's.
    budgeted = [a for a in active if a != PLAYGROUND_ID]
    budgets = None if month.closed else _budgets(deps, budgeted, month.month)
    limit = None if month.closed else _money(deps.agent_limit())
    rows: list[AgentCostOut] = []
    for agent_id in active:
        info = agents.get(agent_id)
        row = _row(agent_id, month, sums[agent_id])
        rows.append(
            AgentCostOut(
                **row.model_dump(),
                name=info.name if info else None,
                category=(info.category or None) if info else None,
                model=info.model if info else None,
                budget=(
                    AgentCostBudgetOut(
                        limit_usd=limit, spent_usd=_money(budgets.get(agent_id, _ZERO))
                    )
                    if budgets is not None and limit is not None and agent_id != PLAYGROUND_ID
                    else None
                ),
            )
        )
    rows.sort(key=lambda r: (-Decimal(r.spent_usd), -Decimal(r.previous_usd), r.id))
    rest, previous_rest = _rest(org, [sums[a] for a in active])
    return AgentsBreakdownOut(
        counted_since=since,
        unattributed_usd=rest,
        previous_unattributed_usd=previous_rest,
        rows=rows,
    )


def _breakdown(
    month: _Month,
    org: _Sum,
    counted: Mapping[str, Mapping[str, usage_days.Day]],
    prefix: str,
    since: str | None,
    *,
    keep_empty: bool,
) -> CostsBreakdownOut:
    sums = {key.removeprefix(prefix): _sum(month, days) for key, days in counted.items()}
    rows = [
        _row(row_id, month, total)
        for row_id, total in sums.items()
        if keep_empty or total.spent > 0 or total.previous > 0 or total.turns > 0
    ]
    if not keep_empty:
        rows.sort(key=lambda r: (-Decimal(r.spent_usd), -Decimal(r.previous_usd), r.id))
    rest, previous_rest = _rest(org, list(sums.values()))
    return CostsBreakdownOut(
        counted_since=since,
        unattributed_usd=rest,
        previous_unattributed_usd=previous_rest,
        rows=rows,
    )


def summary(deps: CostsDeps, month_text: str) -> CostsOut:
    month = month_of(month_text, deps.clock().date())
    try:
        agents = deps.agents()
        agent_keys = [usage_days.agent_key(a) for a in _agent_ids(deps, agents)]
        model_keys = [usage_days.model_key(m) for m in _model_ids(deps, agents)]
        source_keys = [usage_days.source_key(o) for o in usage_days.ORIGINS]
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            reader = _Reader(deps, month, pool)
            counted = reader.days([usage_days.ORG_KEY, *agent_keys, *model_keys, *source_keys])
            first = reader.first_days([usage_days.ORG_KEY, *agent_keys, *source_keys])
        org_days = counted[usage_days.ORG_KEY]
        org = _sum(month, org_days)
        # The model's and the origin's counters are written together (D106): one start.
        breakdown_since = _earliest([first[k] for k in source_keys])
        return CostsOut(
            month=month.month,
            previous_month=month.previous,
            days_in_month=month.days_in_month,
            elapsed_days=len(month.days),
            closed=month.closed,
            counted_since=first[usage_days.ORG_KEY],
            days=_series(month.days, org_days),
            previous_days=_series(month.previous_days, org_days),
            spent_usd=_money(org.spent),
            turns=org.turns,
            previous_usd=_money(org.previous),
            previous_turns=org.previous_turns,
            projected_usd=_projection(month, org.spent),
            agents=_agents_breakdown(
                deps,
                month,
                org=org,
                agents=agents,
                counted={k.removeprefix(usage_days.AGENT_PREFIX): counted[k] for k in agent_keys},
                since=_earliest([first[k] for k in agent_keys]),
            ),
            models=_breakdown(
                month,
                org,
                {k: counted[k] for k in model_keys},
                usage_days.MODEL_PREFIX,
                breakdown_since,
                keep_empty=False,
            ),
            sources=_breakdown(
                month,
                org,
                {k: counted[k] for k in source_keys},
                usage_days.SOURCE_PREFIX,
                breakdown_since,
                keep_empty=True,
            ),
        )
    except ApiError:
        raise
    except Exception as exc:
        logger.exception("costs unavailable")
        raise ApiError(503, "costs_unavailable", "please try again") from exc


def cached(deps: CostsDeps, caller: Caller, month: str) -> CostsOut:
    """The same answer for a short time per person and month: reloading Costos does not read the
    counters again (TM-C3). Everyone with ``ViewCosts`` sees the same, so permissions are not
    part of the key; the route decided them before."""
    key = (caller.user.user_id, month)
    now = deps.monotonic()
    hit = deps._cache.get(key)
    if hit is not None and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    out = summary(deps, month)
    if len(deps._cache) >= CACHE_ENTRIES:
        for stale in [k for k, (at, _) in deps._cache.items() if now - at >= CACHE_SECONDS]:
            del deps._cache[stale]
        if len(deps._cache) >= CACHE_ENTRIES:
            deps._cache.clear()
    deps._cache[key] = (now, out)
    return out


# --- Routes -----------------------------------------------------------------------------


Authorize = Callable[[Caller, str, str, str], Awaitable[None]]


def costs_router(
    deps: CostsDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    router = APIRouter(prefix="/api/costs")

    async def view(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        await authorize(caller, "ViewCosts", *PLATFORM)
        return caller

    @router.get("", response_model=CostsOut)
    async def get_costs(
        caller: Annotated[Caller, Depends(view)],
        month: Annotated[str | None, Query(pattern=MONTH_PATTERN)] = None,
    ) -> CostsOut:
        user_id = caller.user.user_id
        if not deps.limiter.allow(user_id):
            raise rate_limited(deps.limiter.retry_after(user_id))
        chosen = month or deps.clock().date().isoformat()[:7]
        return await asyncio.to_thread(cached, deps, caller, chosen)

    return router
