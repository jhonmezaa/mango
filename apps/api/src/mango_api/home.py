"""Inicio (D102; threat model ``home-threat-model.md``): spend and turns per day, what waits for
the caller in Aprobaciones and the budgets closest to their limit, in one read.

Whose numbers each person gets is decided here, with Cedar, never by the client:

* **The organization** (``ViewOrgUsage``: administrators and central FinOps).
* **Their area** (``ViewAreaUsage``: a ``bu-lead``), the one of their verified token.
* **Their own**, for anyone else, read with their row-level security client
  (``dynamodb:LeadingKeys`` = ``DAY#USER#<sub>``, ``USER#<sub>``).

The day counters are ``mango_core.usage_days``: written in the transaction that closes each
turn. Agent health, latency and tickets have no source: «Próximamente» (D24).

Security notes (security-best-practices, FastAPI):
* The route declares its Cedar action, ``ViewHome`` (anyone with a session), audited as a
  read. The scope and each section are decided again with their own action, deny by default:
  ``ViewOrgUsage``, ``ViewAreaUsage``, ``ApproveToolCall`` and, for the agents' budgets,
  ``ViewAdmin`` plus ``is_admin`` in process (as Presupuestos). Without them: the caller's own.
* Only sums per day: never conversations, people or agents behind a number (TM-H2). Approvals
  are a count. The budgets of agents reach administrators only (D17, D89 (1)).
* The period is a closed list; no other input. Reads are bounded (one query per counter, at
  most 360 days), limited per person and cached for a short time per person, scope and period
  (TM-H3). Responses use explicit models (VALID-001, RESP-001).
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Annotated, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict

from mango_api.admin import AdminDeps, budgets_view
from mango_api.approvals import ApprovalDeps
from mango_api.budget import current_period
from mango_api.governance import approvals_summary
from mango_api.knowledge_sources import QueuedSourceOut
from mango_api.rate_limits import Limiter
from mango_api.web import ApiError, Caller, rate_limited
from mango_core import usage_days

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
READS_PER_MINUTE = 30
CACHE_SECONDS = 30.0
CACHE_ENTRIES = 256
MAX_BUDGETS = 4
"""As the design's card: the four closest to their limit."""
PERIOD_DAYS: dict[str, int] = {"7d": 7, "30d": 30, "90d": 90, "180d": 180}
_CENT = Decimal("0.01")
_MICRO = Decimal("0.000001")

Period = Literal["7d", "30d", "90d", "180d"]
Scope = Literal["org", "area", "mine"]


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UsageDayOut(_Strict):
    day: str
    """``yyyy-mm-dd``, UTC."""
    spent_usd: str
    """What the turns that started that day cost, with the titles of new conversations."""
    turns: int
    """Turns that reached the agent: chat, tasks and Playground."""


class HomeBudgetOut(_Strict):
    scope: Literal["agent", "user"]
    id: str
    """The agent's id, or the caller's own user id."""
    name: str | None
    """The agent's name, or the caller's email; ``None`` when unknown."""
    spent_usd: str
    limit_usd: str


class HomeOut(_Strict):
    scope: Scope
    """Whose numbers these are: the organization's, the caller's area's or the caller's."""
    area: str | None
    """The area of ``scope = area``; ``None`` otherwise."""
    period: Period
    counted_since: str | None
    """The first day the organization's counter has; ``None`` before the first turn. The days
    before it show 0 because nothing was counted, not because nothing happened."""
    days: list[UsageDayOut]
    """Every day of the period, oldest first, the last one today (UTC)."""
    previous: list[UsageDayOut]
    """The same number of days just before, to compare."""
    approvals: int
    """What waits for the caller's decision in Aprobaciones."""
    budgets_scope: Literal["agents", "mine"]
    """``agents`` for administrators; ``mine`` (their own budget) for anyone else."""
    budgets: list[HomeBudgetOut]
    """At most four, the closest to their limit first."""


# --- Use cases --------------------------------------------------------------------------


@dataclass(frozen=True)
class Access:
    """What the caller may read, decided for each request."""

    scope: Scope
    area: str | None
    approver: bool
    agent_budgets: bool


@dataclass(frozen=True)
class HomeData:
    table: str
    """The Budgets table: the day counters and the budgets."""
    dynamodb: "DynamoDBClient"
    """mango-api's own client: the organization's and an area's counters."""
    own: Callable[[str], "DynamoDBClient"]
    """The row-level security client of a person: their counter and their budget."""


@dataclass
class HomeDeps:
    data: HomeData
    user_limit: Callable[[str], Decimal]
    """A person's monthly limit (defaults and their override)."""
    admin: AdminDeps
    approvals: ApprovalDeps | None
    clock: Callable[[], datetime]
    limiter: Limiter
    sources: Callable[[Caller], list[QueuedSourceOut]] | None = None
    """The bucket proposals of Aprobaciones for the caller (D88 (48)); ``None`` without
    knowledge bases."""
    monotonic: Callable[[], float] = time.monotonic
    _cache: dict[tuple[str, Access, str], tuple[float, HomeOut]] = field(default_factory=dict)


def _money(value: Decimal) -> str:
    return str(value.quantize(_CENT))


def _days(first: date, count: int) -> list[str]:
    return [(first + timedelta(days=offset)).isoformat() for offset in range(count)]


def _series(days: list[str], counted: dict[str, usage_days.Day]) -> list[UsageDayOut]:
    out: list[UsageDayOut] = []
    for day in days:
        found = counted.get(day)
        out.append(
            UsageDayOut(
                day=day,
                spent_usd=str((found.spent if found else Decimal(0)).quantize(_MICRO)),
                turns=found.turns if found else 0,
            )
        )
    return out


def _counter(access: Access, user_id: str) -> str:
    if access.scope == "org":
        return usage_days.ORG_KEY
    if access.scope == "area" and access.area is not None:
        return usage_days.area_key(access.area)
    return usage_days.user_key(user_id)


def _ratio(spent: Decimal, limit: Decimal) -> Decimal:
    if limit <= 0:
        return Decimal(100) if spent > 0 else Decimal(0)
    return spent / limit * 100


def _own_budget(deps: HomeDeps, caller: Caller, period: str) -> HomeBudgetOut:
    user = caller.user
    item = (
        deps.data.own(user.user_id)
        .get_item(
            TableName=deps.data.table,
            Key={"PK": {"S": f"USER#{user.user_id}"}, "SK": {"S": period}},
            ProjectionExpression="#spent, #held",
            ExpressionAttributeNames={"#spent": "spent", "#held": "held"},
        )
        .get("Item", {})
    )
    # As the chat's budget (``BudgetService.status``): what is held is not available.
    spent = Decimal(item.get("spent", {}).get("N", "0")) + Decimal(
        item.get("held", {}).get("N", "0")
    )
    return HomeBudgetOut(
        scope="user",
        id=user.user_id,
        name=user.email,
        spent_usd=_money(spent),
        limit_usd=_money(deps.user_limit(user.user_id)),
    )


def _agent_budgets(deps: HomeDeps) -> list[HomeBudgetOut]:
    """The agents of the budgets screen closest to their limit (D17: every agent uses the
    default limit)."""
    rows = [
        (
            _ratio(Decimal(a.spent_usd), Decimal(a.limit_usd)),
            HomeBudgetOut(
                scope="agent",
                id=a.agent_id,
                name=a.name,
                spent_usd=a.spent_usd,
                limit_usd=a.limit_usd,
            ),
        )
        for a in budgets_view(deps.admin).agents
    ]
    rows.sort(key=lambda pair: (-pair[0], pair[1].id))
    return [row for _, row in rows[:MAX_BUDGETS]]


def _sources(deps: HomeDeps, caller: Caller) -> list[QueuedSourceOut]:
    if deps.sources is None:
        return []
    try:
        return deps.sources(caller)
    except ApiError:
        # As the Bandeja: without the knowledge table the rest of Inicio is still answered.
        logger.warning("the bucket proposals could not be read for Inicio")
        return []


def _approvals(deps: HomeDeps, caller: Caller, access: Access, now: datetime) -> int:
    sources = _sources(deps, caller)
    if access.approver and deps.approvals is not None:
        return approvals_summary(deps.approvals, caller.user.user_id, now, sources).mine
    return sum(1 for s in sources if s.status.value == "pending" and s.can_decide)


def summary(deps: HomeDeps, caller: Caller, access: Access, period: Period) -> HomeOut:
    now = deps.clock()
    count = PERIOD_DAYS[period]
    today = now.date()
    current = _days(today - timedelta(days=count - 1), count)
    previous = _days(today - timedelta(days=2 * count - 1), count)
    user_id = caller.user.user_id
    try:
        key = _counter(access, user_id)
        # A person's own counter is only ever read with their row-level security client.
        client = deps.data.own(user_id) if access.scope == "mine" else deps.data.dynamodb
        counted = {
            d.day: d
            for d in usage_days.read(client, deps.data.table, key, previous[0], current[-1])
        }
        budgets = (
            _agent_budgets(deps)
            if access.agent_budgets
            else [_own_budget(deps, caller, current_period(now))]
        )
        return HomeOut(
            scope=access.scope,
            area=access.area if access.scope == "area" else None,
            period=period,
            counted_since=usage_days.first_day(deps.data.dynamodb, deps.data.table),
            days=_series(current, counted),
            previous=_series(previous, counted),
            approvals=_approvals(deps, caller, access, now),
            budgets_scope="agents" if access.agent_budgets else "mine",
            budgets=budgets,
        )
    except ApiError:
        raise
    except Exception as exc:
        logger.exception("home unavailable")
        raise ApiError(503, "home_unavailable", "please try again") from exc


def cached(deps: HomeDeps, caller: Caller, access: Access, period: Period) -> HomeOut:
    """The same answer for a short time per person, permissions and period: reloading Inicio
    does not read the counters again (TM-H3). A change of permissions misses the cache."""
    key = (caller.user.user_id, access, period)
    now = deps.monotonic()
    hit = deps._cache.get(key)
    if hit is not None and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    out = summary(deps, caller, access, period)
    if len(deps._cache) >= CACHE_ENTRIES:
        for stale in [k for k, (at, _) in deps._cache.items() if now - at >= CACHE_SECONDS]:
            del deps._cache[stale]
        if len(deps._cache) >= CACHE_ENTRIES:
            deps._cache.clear()
    deps._cache[key] = (now, out)
    return out


# --- Routes -----------------------------------------------------------------------------


Authorize = Callable[[Caller, str, str, str], Awaitable[None]]
Allowed = Callable[[Caller, str], bool]
"""``(caller, action)``: one decision on the platform, not audited (a section, not a request)."""


def decide(caller: Caller, allowed: Allowed) -> Access:
    """The scope and the sections the caller may read. Deny by default: without an allow, the
    caller's own numbers."""
    user = caller.user
    if allowed(caller, "ViewOrgUsage"):
        scope: Scope = "org"
    elif usage_days.is_area(user.business_unit) and allowed(caller, "ViewAreaUsage"):
        scope = "area"
    else:
        scope = "mine"
    return Access(
        scope=scope,
        area=user.business_unit if scope == "area" else None,
        approver=allowed(caller, "ApproveToolCall"),
        # Defense in depth, as Presupuestos: the Cedar policy already requires isAdmin.
        agent_budgets=user.is_admin and allowed(caller, "ViewAdmin"),
    )


def home_router(
    deps: HomeDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
    allowed: Allowed,
) -> APIRouter:
    router = APIRouter(prefix="/api/home")

    async def view(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        await authorize(caller, "ViewHome", *PLATFORM)
        return caller

    @router.get("", response_model=HomeOut)
    async def get_home(
        caller: Annotated[Caller, Depends(view)],
        period: Annotated[Period, Query()] = "30d",
    ) -> HomeOut:
        user_id = caller.user.user_id
        if not deps.limiter.allow(user_id):
            raise rate_limited(deps.limiter.retry_after(user_id))
        granted = await asyncio.to_thread(decide, caller, allowed)
        return await asyncio.to_thread(cached, deps, caller, granted, period)

    return router
