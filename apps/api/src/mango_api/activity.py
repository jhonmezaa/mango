"""La Actividad (D90; threat model ``activity-threat-model.md``): what the agents did.

Operation, not governance (design ``activity.jsx``, «Disponible hoy» of round 19): tool calls
with their result and time, the approvals agents asked for and the turns an agent's budget
blocked, in chats and tasks. Decisions and settings changes stay in the audit log.

Who sees what (D90 (1), taken by the owner on 2026-10-24):

* **Everyone** sees their own activity, live: the events of their turns, read only from their
  own partition with their row-level security client, and the approvals they asked for (the
  rule of the approvals screen, D56).
* **An administrator** (``ViewAudit``) sees everyone's: the day partitions, where a turn lands
  once it ended (D90 (7)), and also the approvals that need approvers. Of someone else's
  event only the agent, the tool, the result and the time: never the person, the
  conversation (D23), the task or its run.

Never the input or the answer of a tool (D90 (3)): they are not stored anywhere. Tickets,
publications and the state of an agent are not in this mode of the design.

Security notes (security-best-practices, FastAPI):
* The route declares its Cedar action (``ViewActivity``, any person with a session, audited
  as a read); ``ViewAudit`` decides whose activity is read, before anything is read.
* Query parameters are validated by schema; the response model is explicit and bounded
  (``MAX_EVENTS``, ``truncated``). A per-person rate limit stops a loop of the live mode.
* Nothing of an event is logged.
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Query
from pydantic import AwareDatetime, BaseModel, ConfigDict

from mango_api.activity_store import (
    RETENTION,
    ActivityRecord,
    ActivityStore,
    ActivityStoreUnavailableError,
    Origin,
)
from mango_api.approval_policy import Tier
from mango_api.approvals_store import ApprovalRecord, ApprovalStore
from mango_api.harness import ToolCall
from mango_api.probe import RateLimiter
from mango_api.rate_limits import Limiter
from mango_api.web import ApiError, Caller, rate_limited

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
MAX_EVENTS = 1000
"""Events of one answer; the design shows 50 at a time and «Mostrar más»."""
READS_PER_MINUTE = 60
"""The live mode asks every 15 s; a person with four tabs open stays below."""
RANGES: dict[str, timedelta] = {
    "1h": timedelta(hours=1),
    "24h": timedelta(days=1),
    "7d": timedelta(days=7),
}


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


EventKind = Literal["tool", "error", "approval", "budget"]


class ActivityEvent(_Strict):
    id: str
    kind: EventKind
    agent_id: str
    at: str
    tool: str | None
    """The tool of a call or of an approval, as the chat shows it."""
    ms: int | None
    ok: bool | None
    approval_id: str | None
    approval_status: str | None
    """The status of the approval request (``approvals_store.Status``)."""
    mine: bool
    """The caller's own: only these carry their conversation, task and run (D23)."""
    conversation_id: str | None
    task_id: str | None
    run_id: str | None
    task_name: str | None
    """«Tarea · {nombre}», on the caller's own events only."""


class ActivityAgent(_Strict):
    id: str
    name: str
    icon: str
    color: int
    published: bool
    """``False`` for a retired agent that still has events in the period. Who sees everyone's
    activity counts the published ones («de {n} publicados») and those without activity."""


class ActivityPage(_Strict):
    scope: Literal["mine", "all"]
    """``all`` for an administrator: everyone's activity, metadata only."""
    events: list[ActivityEvent]
    """Newest first."""
    truncated: bool
    """More events than ``MAX_EVENTS`` in the period: the oldest were left out."""
    agents: list[ActivityAgent]
    """The agents of the scope: the published ones the caller may use (all of them for an
    administrator), plus retired ones that appear in the events."""
    retention_days: int
    """How long an event is kept («La actividad se guarda 30 días»)."""


Range = Literal["1h", "24h", "7d"]


# --- Use cases --------------------------------------------------------------------------


@dataclass(frozen=True)
class AgentView:
    agent_id: str
    name: str
    icon: str
    color: int
    published: bool


@dataclass
class ActivityDeps:
    store: ActivityStore
    agents: Callable[[Caller, bool], list[AgentView]]
    """The published and retired agents, of the caller (``UseAgent``) or all of them."""
    approvals: ApprovalStore | None
    clock: Callable[[], datetime]
    reads: Limiter = field(default_factory=lambda: RateLimiter(READS_PER_MINUTE, 60))


def _unavailable() -> ApiError:
    logger.exception("activity unavailable")
    return ApiError(503, "activity_unavailable", "please try again")


def _tool_event(record: ActivityRecord, user_id: str) -> ActivityEvent:
    own = record.user_id == user_id
    failed = record.kind == "tool" and record.ok is False
    return ActivityEvent(
        id=record.event_id,
        kind="error" if failed else record.kind,
        agent_id=record.agent_id,
        at=record.at,
        tool=record.tool,
        ms=record.ms,
        ok=record.ok,
        approval_id=None,
        approval_status=None,
        mine=own,
        # Someone else's: only the agent, the tool, the result and the time (D23, D90 (1)).
        conversation_id=record.conversation_id if own else None,
        task_id=record.task_id if own else None,
        run_id=record.run_id if own else None,
        task_name=record.task_name if own else None,
    )


def _approval_event(record: ApprovalRecord, user_id: str) -> ActivityEvent:
    return ActivityEvent(
        id=f"approval-{record.approval_id}",
        kind="approval",
        agent_id=record.agent_id,
        at=record.created_at.astimezone(UTC).isoformat(timespec="milliseconds"),
        tool=record.tool,
        ms=None,
        ok=None,
        approval_id=record.approval_id,
        approval_status=record.status.value,
        mine=record.requested_by == user_id,
        conversation_id=None,
        task_id=None,
        run_id=None,
        task_name=None,
    )


def _approvals(deps: ActivityDeps, user_id: str, everyone: bool) -> list[ApprovalRecord]:
    """The requests the approvals screen would show (D56): one's own and, for an
    administrator, also those that need approvers."""
    if deps.approvals is None:
        return []
    records = {r.approval_id: r for r in deps.approvals.by_requester(user_id)}
    if everyone:
        for open_ in (True, False):
            for r in deps.approvals.inbox(open_=open_):
                if r.tier is Tier.APPROVERS:
                    records.setdefault(r.approval_id, r)
    return list(records.values())


def list_activity(
    deps: ActivityDeps,
    caller: Caller,
    period: Range,
    since: datetime | None,
    *,
    everyone: bool,
) -> ActivityPage:
    user_id = caller.user.user_id
    now = deps.clock()
    start = now - RANGES[period]
    if since is not None:
        # Only what is new for the live mode, never beyond the period nor after now.
        start = min(max(start, since.astimezone(UTC)), now)
    until = now + timedelta(seconds=1)
    try:
        records, truncated = (
            deps.store.everyone(since=start, until=until, limit=MAX_EVENTS)
            if everyone
            else deps.store.mine(user_id, since=start, until=until, limit=MAX_EVENTS)
        )
        approvals = _approvals(deps, user_id, everyone)
        agents = deps.agents(caller, everyone)
    except (ActivityStoreUnavailableError, ClientError, BotoCoreError) as exc:
        raise _unavailable() from exc

    def recent(at: datetime | None) -> bool:
        return at is not None and start < at.astimezone(UTC) <= now

    events = [_tool_event(r, user_id) for r in records]
    events += [_approval_event(r, user_id) for r in approvals if recent(r.created_at)]
    # The ids of the store and of the requests are opaque: the time orders, the id breaks ties.
    events.sort(key=lambda e: (e.at, e.id), reverse=True)
    if since is not None:
        # The live mode asks for what is strictly newer than what it has.
        cutoff = since.astimezone(UTC).isoformat(timespec="milliseconds")
        events = [e for e in events if e.at > cutoff]
    if len(events) > MAX_EVENTS:
        events, truncated = events[:MAX_EVENTS], True
    seen = {e.agent_id for e in events}
    return ActivityPage(
        scope="all" if everyone else "mine",
        events=events,
        truncated=truncated,
        agents=[
            ActivityAgent(
                id=a.agent_id, name=a.name, icon=a.icon, color=a.color, published=a.published
            )
            for a in agents
            if a.published or a.agent_id in seen
        ],
        retention_days=RETENTION.days,
    )


# --- Recording what the agents do -------------------------------------------------------


@dataclass
class TurnActivity:
    """What one turn (chat or task) tells the Actividad as its agent works. Never raises: the
    turn goes on whatever happens to its activity, and a failure is logged without the event.

    Each call is written at once in the person's partition (they see it live) and kept for the
    day's partition, written when the turn ends (``end``): who sees everyone's activity reads
    a turn once it ended, each call with its own time (D90 (7))."""

    store: ActivityStore
    origin: Origin
    _everyone: list[dict[str, Any]] = field(default_factory=list)

    def call(self, call: ToolCall) -> None:
        try:
            _, every = self.store.add(
                self.origin, "tool", tool=call.name, ok=call.ok, ms=call.ms, everyone_now=False
            )
            self._everyone.append(every)
        except Exception:
            logger.exception("an activity event could not be written")

    def budget_blocked(self) -> None:
        """The agent's own budget stopped the turn (D90 (4)); the person's is not an event of
        the agent. The turn ends here: written for everyone at once."""
        try:
            self.store.add(self.origin, "budget")
        except Exception:
            logger.exception("an activity event could not be written")

    def end(self) -> None:
        items, self._everyone = self._everyone, []
        if not items:
            return
        try:
            self.store.add_everyone(items)
        except Exception:
            logger.exception("an activity event could not be written")


# --- Routes -----------------------------------------------------------------------------


Authorize = Callable[[Caller, str, str, str], Awaitable[None]]
ViewsAll = Callable[[Caller], bool]


def activity_router(
    deps: ActivityDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
    views_all: ViewsAll,
) -> APIRouter:
    router = APIRouter(prefix="/api/activity")

    async def view_activity(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        await authorize(caller, "ViewActivity", *PLATFORM)
        return caller

    @router.get("", response_model=ActivityPage)
    async def list_route(
        caller: Annotated[Caller, Depends(view_activity)],
        period: Annotated[Range, Query(alias="range")] = "24h",
        since: Annotated[AwareDatetime | None, Query()] = None,
    ) -> ActivityPage:
        actor = caller.user.user_id
        if not deps.reads.allow(actor):
            raise rate_limited(deps.reads.retry_after(actor))
        everyone = await asyncio.to_thread(views_all, caller)
        return await asyncio.to_thread(
            list_activity, deps, caller, period, since, everyone=everyone
        )

    return router
