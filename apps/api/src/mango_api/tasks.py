"""Tasks: a published agent that works without chat, on demand and on a schedule (D78).

An automation («schedule» in the design) names an agent, an instruction and a trigger. Each
run reserves budget like a chat turn (D73) and runs as the person who created it (D26): the
identity of a run is a Cognito token of its owner issued for that run (``task_identity``).
Runs are started from the queue ``Mango-<ns>-TaskRuns`` (``task_worker``); EventBridge
Scheduler leaves a message there for each due time, and «Ejecutar ahora» leaves one too.
Design: ``docs/specs/tasks.md``. Threat model:
``docs/security/threat-models/tasks-threat-model.md``.

Security notes (security-best-practices, FastAPI):
* Every route declares its authorization (AUTH-001): ``CreateTask`` on the platform, and on
  the task itself ``ViewTask`` and ``ControlTask`` (owner or administrator) or ``OwnTask``
  (owner only: it runs with the owner's identity, so nobody else edits, runs or resumes it).
  A task the caller may not see answers 404, not 403 (TM-T4).
* The owner is the verified subject of the caller; request models forbid extra fields so
  nobody sends an owner, a cron expression or a status (VALID-001, TM-T4). The expression of
  a schedule is computed here from the fields of the design.
* The instruction is checked for credentials like an agent's prompt (D26) and never reaches
  logs or the audit trail; neither does the result of a run (TM-T8).
* Responses use explicit models (RESP-001); changes and «Ejecutar ahora» count in the shared
  rate limits (D70).
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING, Annotated, Any, Literal, Protocol, cast
from zoneinfo import ZoneInfo

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, ConfigDict, Field, model_validator

from mango_api.agent_rules import find_secrets
from mango_api.audit import AuditLog
from mango_api.authz import AgentResource, TaskResource
from mango_api.published import AgentUnavailableError, PublishedAgent, PublishedAgents
from mango_api.rate_limits import Limiter, RateLimitUnavailableError
from mango_api.tasks_store import (
    RUNS_SHOWN,
    Automation,
    PauseReason,
    Run,
    RunStatus,
    Status,
    TaskConflictError,
    TaskLimitError,
    TaskStore,
    TaskStoreUnavailableError,
)
from mango_api.web import ApiError, Caller, rate_limited
from mango_core import task_runs
from mango_core.agents import AGENT_ID_PATTERN

if TYPE_CHECKING:
    from mypy_boto3_scheduler import EventBridgeSchedulerClient
    from mypy_boto3_sqs import SQSClient

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
TASK_TYPE = "Mango::Task"
TASK_ID_PATTERN = task_runs.ID_PATTERN
MAX_PER_OWNER = 10
MAX_PER_INSTALLATION = 200
"""Automations that are not retired (decided 2026-10-15, the design's limits)."""
RUNS_PER_HOUR = 10
"""«Ejecutar ahora» per person (D70: shared between the tasks of mango-api)."""
CHANGES_PER_HOUR = 30
"""Creating, editing, pausing, resuming and retiring: each one writes to Scheduler."""
NEXT_RUNS = 3
CENTRAL_EVENTS = frozenset({"cost_anomaly"})
"""Events only central people may subscribe to (D79 (5)): anomalies are of the whole
organization, and the ones without an account are only theirs to see."""
DAILY_RUNS = {"cost_anomaly": 5}
"""Runs per automation and UTC day, by event (D79 (3)): a storm of anomalies never becomes a
storm of investigations. The next ones are skipped with ``daily_cap``, without a model call."""
TIMEZONES = ("America/Mexico_City", "America/Bogota", "America/Sao_Paulo", "UTC")
"""The design's list. A closed list: each one is a valid ``ScheduleExpressionTimezone``."""
Frequency = Literal["15m", "hourly", "6h", "daily", "weekdays", "days", "weekly", "monthly"]
_DOW = ("SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT")
"""Day 0 is Sunday, as in the design."""
_SCHEDULE_EVENT_AGE_SECONDS = 900
"""A due time Scheduler could not deliver for 15 minutes is dropped, not run late."""


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ScheduleSpec(_Strict):
    """When a schedule runs, as the design asks for it. Never a cron expression."""

    freq: Frequency
    hour: Annotated[int, Field(ge=0, le=23)] = 9
    minute: Annotated[int, Field(ge=0, le=59)] = 0
    days: Annotated[list[Annotated[int, Field(ge=0, le=6)]], Field(max_length=7)] = []
    dow: Annotated[int, Field(ge=0, le=6)] = 1
    dom: Annotated[int, Field(ge=1, le=28)] = 1

    @model_validator(mode="after")
    def _days(self) -> "ScheduleSpec":
        if self.freq == "days" and not self.days:
            raise ValueError("choose at least one day")
        self.days = sorted(set(self.days))
        return self


class TriggerIn(_Strict):
    kind: Literal["manual", "schedule", "event"]
    schedule: ScheduleSpec | None = None
    timezone: Literal["America/Mexico_City", "America/Bogota", "America/Sao_Paulo", "UTC"] = (
        "America/Mexico_City"
    )
    event_type: Literal["cost_anomaly"] | None = None

    @model_validator(mode="after")
    def _shape(self) -> "TriggerIn":
        if (self.kind == "schedule") != (self.schedule is not None):
            raise ValueError("a schedule trigger, and only one, has a schedule")
        if (self.kind == "event") != (self.event_type is not None):
            raise ValueError("an event trigger, and only one, has an event type")
        return self


class TaskIn(_Strict):
    name: Annotated[str, Field(min_length=1, max_length=48)]
    agent_id: Annotated[str, Field(pattern=AGENT_ID_PATTERN)]
    task: Annotated[str, Field(min_length=1, max_length=2000)]
    trigger: TriggerIn
    deliver: Literal["inbox"] = "inbox"
    """The only delivery of this wave (A4): «Crear ticket» and Slack are «Próximamente»."""


class RetireIn(_Strict):
    reason: Annotated[str, Field(min_length=1, max_length=200)]


class PauseIn(_Strict):
    reason: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    """Required when an administrator pauses someone else's task (D82 (2)); the owner's own
    pause has none."""


class PreviewIn(_Strict):
    """The editor's schedule, to show its next runs before it is saved (design 2.5)."""

    schedule: ScheduleSpec
    timezone: Literal["America/Mexico_City", "America/Bogota", "America/Sao_Paulo", "UTC"]


class PreviewOut(_Strict):
    next_runs: list[datetime]


class EmptyIn(_Strict):
    pass


class PersonOut(_Strict):
    user_id: str
    email: str | None
    name: str | None


class RetiredOut(_Strict):
    by: str | None
    at: str | None
    reason: str | None


class HealthOut(_Strict):
    tone: Literal["red", "amber"]
    code: Literal["agent_unavailable", "access_lost", "budget_skipped", "failing"]


RunStatusOut = Literal["queued", "running", "ok", "failed", "skipped", "approval"]


class AnomalyOut(_Strict):
    """The cost anomaly that started an event run: its dates and AWS's id, nothing written by
    people (D79 (4), D85). Runs from before D85 have no id."""

    start: date
    end: date
    id: str | None = None


class StepOut(_Strict):
    text: str
    tool: str | None


class RunOut(_Strict):
    run_id: str
    trigger: Literal["manual", "schedule", "event"]
    status: RunStatusOut
    queued_at: datetime
    started_at: datetime | None
    ended_at: datetime | None
    cost_usd: str | None
    reason: str | None
    has_result: bool
    approvals: list[str]
    anomaly: AnomalyOut | None = None
    waiting_since: datetime | None = None
    """When an event run started to wait for the previous one (D81)."""


class RunDetailOut(RunOut):
    result: str | None
    """The agent's answer as Markdown; the SPA renders it without raw HTML. With steps, only
    what it wrote after the last tool call: the report."""
    steps: list[StepOut] = []
    """What the agent wrote before each tool call, with the tool; empty for older runs."""


class TriggerOut(_Strict):
    kind: Literal["manual", "schedule", "event"]
    schedule: ScheduleSpec | None
    timezone: str | None
    event_type: str | None
    daily_cap: int | None = None
    """Runs per day an event may start (D79 (3)); the next ones are skipped."""


class TaskOut(_Strict):
    task_id: str
    name: str
    agent_id: str
    agent_name: str | None
    task: str | None
    """The instruction, only for its owner (D82 (3)): it is theirs, as their conversations."""
    trigger: TriggerOut
    deliver: Literal["inbox"]
    status: Literal["active", "paused", "retired"]
    paused_reason: Literal["owner", "admin", "access_lost"] | None
    paused_at: str | None
    paused_note: str | None = None
    """Why an administrator paused it (D82 (2)), for the owner and administrators."""
    paused_by: str | None = None
    """Who paused it, when an administrator did: only for administrators."""
    retired: RetiredOut | None
    owner: PersonOut
    is_owner: bool
    next_runs: list[datetime]
    running: bool
    runs: list[RunOut]
    health: HealthOut | None
    created_at: str
    updated_at: str


class TaskListOut(_Strict):
    items: list[TaskOut]
    can_create: bool
    can_subscribe_events: bool
    """Hint for the SPA (D79 (5)): the server decides on its own."""


# --- Schedules ----------------------------------------------------------------------------


def schedule_expression(spec: ScheduleSpec) -> str:
    """The EventBridge Scheduler expression of a spec (six fields, day of week by name)."""
    m, h = spec.minute, spec.hour
    fields = {
        "15m": "0/15 * * * ? *",
        "hourly": f"{m} * * * ? *",
        "6h": f"{m} 0/6 * * ? *",
        "daily": f"{m} {h} * * ? *",
        "weekdays": f"{m} {h} ? * MON-FRI *",
        "days": f"{m} {h} ? * {','.join(_DOW[d] for d in spec.days)} *",
        "weekly": f"{m} {h} ? * {_DOW[spec.dow]} *",
        "monthly": f"{m} {h} {spec.dom} * ? *",
    }[spec.freq]
    return f"cron({fields})"


def _due_on(spec: ScheduleSpec, day: datetime) -> list[tuple[int, int]]:
    """``(hour, minute)`` a spec runs at on one local day."""
    weekday = (day.weekday() + 1) % 7  # Python's Monday is 0; the design's Sunday is 0.
    if spec.freq == "15m":
        return [(h, m) for h in range(24) for m in (0, 15, 30, 45)]
    if spec.freq == "hourly":
        return [(h, spec.minute) for h in range(24)]
    if spec.freq == "6h":
        return [(h, spec.minute) for h in (0, 6, 12, 18)]
    matches = {
        "daily": True,
        "weekdays": 1 <= weekday <= 5,  # noqa: PLR2004
        "days": weekday in spec.days,
        "weekly": weekday == spec.dow,
        "monthly": day.day == spec.dom,
    }[spec.freq]
    return [(spec.hour, spec.minute)] if matches else []


def next_runs(
    spec: ScheduleSpec, timezone: str, now: datetime, count: int = NEXT_RUNS
) -> list[datetime]:
    """The next due times of a spec, in UTC, after ``now``."""
    zone = ZoneInfo(timezone)
    local = now.astimezone(zone)
    out: list[datetime] = []
    for offset in range(62):
        day = (local + timedelta(days=offset)).replace(hour=0, minute=0, second=0, microsecond=0)
        for hour, minute in _due_on(spec, day):
            due = day.replace(hour=hour, minute=minute).astimezone(UTC)
            if due > now:
                out.append(due)
                if len(out) == count:
                    return out
    return out


class SchedulerUnavailableError(Exception):
    """EventBridge Scheduler could not be changed."""


class TaskScheduler:
    """The schedule of each automation, in the group of the installation (D25: SDK calls)."""

    def __init__(
        self,
        client: "EventBridgeSchedulerClient",
        *,
        group: str,
        queue_arn: str,
        role_arn: str,
    ) -> None:
        self._client = client
        self._group = group
        self._queue_arn = queue_arn
        self._role_arn = role_arn

    def _request(self, automation: Automation, *, enabled: bool) -> dict[str, Any]:
        spec = ScheduleSpec.model_validate(automation.spec)
        return {
            "Name": automation.automation_id,
            "GroupName": self._group,
            "ScheduleExpression": schedule_expression(spec),
            "ScheduleExpressionTimezone": automation.timezone or "UTC",
            "FlexibleTimeWindow": {"Mode": "OFF"},
            "State": "ENABLED" if enabled else "DISABLED",
            "ActionAfterCompletion": "NONE",
            "Target": {
                "Arn": self._queue_arn,
                "RoleArn": self._role_arn,
                "Input": task_runs.schedule_input(automation.automation_id),
                "RetryPolicy": {
                    "MaximumEventAgeInSeconds": _SCHEDULE_EVENT_AGE_SECONDS,
                    "MaximumRetryAttempts": 3,
                },
            },
        }

    def create(self, automation: Automation) -> None:
        try:
            self._client.create_schedule(**self._request(automation, enabled=True))
        except (ClientError, BotoCoreError) as exc:
            raise SchedulerUnavailableError from exc

    def update(self, automation: Automation, *, enabled: bool) -> None:
        try:
            self._client.update_schedule(**self._request(automation, enabled=enabled))
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
                self.create(automation) if enabled else None
                return
            raise SchedulerUnavailableError from exc
        except BotoCoreError as exc:
            raise SchedulerUnavailableError from exc

    def delete(self, automation_id: str) -> None:
        try:
            self._client.delete_schedule(Name=automation_id, GroupName=self._group)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
                return
            raise SchedulerUnavailableError from exc
        except BotoCoreError as exc:
            raise SchedulerUnavailableError from exc


class RunQueue:
    """Leaves a message in the queue the worker reads: a manual run, or the wait of an event
    run that found its task busy (D81), delayed by ``delay_seconds`` (SQS allows 900)."""

    def __init__(self, client: "SQSClient", queue_url: str) -> None:
        self._client = client
        self._url = queue_url

    def send(self, body: str, *, delay_seconds: int = 0) -> None:
        if delay_seconds:
            self._client.send_message(
                QueueUrl=self._url, MessageBody=body, DelaySeconds=delay_seconds
            )
            return
        self._client.send_message(QueueUrl=self._url, MessageBody=body)


# --- Use cases --------------------------------------------------------------------------


class AuthorizeTask(Protocol):
    def __call__(
        self,
        caller: Caller,
        action: str,
        resource_type: str,
        resource_id: str,
        *,
        read_only: bool = ...,
        context: dict[str, str] | None = ...,
        agent: AgentResource | None = ...,
        task: TaskResource | None = ...,
    ) -> Awaitable[None]: ...


@dataclass
class TasksDeps:
    store: TaskStore
    scheduler: TaskScheduler
    queue: RunQueue
    published: PublishedAgents
    audit: AuditLog
    runs: Limiter
    changes: Limiter
    clock: Callable[[], float] = time.time


def _unavailable(exc: Exception) -> ApiError:
    logger.error("tasks unavailable: %s", type(exc).__name__)
    return ApiError(503, "tasks_unavailable", "please try again")


def _limit(limiter: Limiter, key: str) -> None:
    try:
        allowed = limiter.allow(key)
    except RateLimitUnavailableError as exc:
        raise ApiError(503, "rate_limit_unavailable", "please try again") from exc
    if not allowed:
        raise rate_limited(limiter.retry_after(key))


def _ts(value: int | None) -> datetime | None:
    return datetime.fromtimestamp(value, UTC) if value is not None else None


def run_out(run: Run, *, owner: bool = True) -> RunOut:
    """``owner``: whether the reader is the owner of the task. Only the owner learns that a run
    left a result (D78, D1 after the review: the result was obtained with the owner's access)."""
    return RunOut(
        run_id=run.run_id,
        # Validated against the literals of the model: the table holds nothing else.
        trigger=cast(Any, run.trigger),
        status=cast(Any, run.status.value),
        queued_at=datetime.fromtimestamp(run.queued_at, UTC),
        started_at=_ts(run.started_at),
        ended_at=_ts(run.ended_at),
        cost_usd=run.cost_usd,
        reason=run.reason,
        has_result=owner and bool(run.result or run.steps),
        approvals=list(run.approvals),
        anomaly=(
            AnomalyOut(
                start=date.fromisoformat(run.anomaly_start),
                end=date.fromisoformat(run.anomaly_end),
                id=run.anomaly_id,
            )
            if run.anomaly_start and run.anomaly_end
            else None
        ),
        waiting_since=_ts(run.waiting_since),
    )


def _served(deps: TasksDeps, agent_id: str) -> PublishedAgent | None:
    try:
        return deps.published.get(agent_id)
    except AgentUnavailableError as exc:
        raise _unavailable(exc) from exc


def _health(
    automation: Automation, agent: PublishedAgent | None, runs: list[Run]
) -> HealthOut | None:
    if automation.status is Status.RETIRED:
        return None
    if agent is None or agent.retired:
        return HealthOut(tone="red", code="agent_unavailable")
    if automation.paused_reason is PauseReason.ACCESS_LOST:
        return HealthOut(tone="red", code="access_lost")
    # The design: until the agent's budget is computed, the last run tells it (2026-10-16b).
    if runs and runs[0].status is RunStatus.SKIPPED and runs[0].reason == "budget_exceeded":
        return HealthOut(tone="amber", code="budget_skipped")
    failed = sum(1 for r in runs[:3] if r.status is RunStatus.FAILED)
    if failed >= 2:  # noqa: PLR2004 - the design: «2 de las últimas 3 ejecuciones fallaron»
        return HealthOut(tone="red", code="failing")
    return None


def task_out(deps: TasksDeps, automation: Automation, caller: Caller) -> TaskOut:
    is_owner = automation.owner_id == caller.user.user_id
    agent = _served(deps, automation.agent_id)
    runs = deps.store.recent_runs(automation.automation_id, RUNS_SHOWN)
    spec = ScheduleSpec.model_validate(automation.spec) if automation.spec else None
    now = datetime.fromtimestamp(deps.clock(), UTC)
    upcoming = (
        next_runs(spec, automation.timezone or "UTC", now)
        if spec is not None and automation.status is Status.ACTIVE
        else []
    )
    retired = (
        RetiredOut(
            by=automation.retired_by, at=automation.retired_at, reason=automation.retired_reason
        )
        if automation.status is Status.RETIRED
        else None
    )
    return TaskOut(
        task_id=automation.automation_id,
        name=automation.name,
        agent_id=automation.agent_id,
        agent_name=agent.definition.name if agent is not None else None,
        task=automation.task if is_owner else None,
        trigger=TriggerOut(
            kind=cast(Any, automation.trigger),
            schedule=spec,
            timezone=automation.timezone,
            event_type=automation.event_type,
            daily_cap=DAILY_RUNS.get(automation.event_type or ""),
        ),
        deliver=cast(Any, automation.deliver),
        status=cast(Any, automation.status.value),
        paused_reason=cast(
            Any, automation.paused_reason.value if automation.paused_reason else None
        ),
        paused_at=automation.paused_at,
        paused_note=automation.paused_note,
        paused_by=automation.paused_by if caller.user.is_admin else None,
        retired=retired,
        owner=PersonOut(
            user_id=automation.owner_id, email=automation.owner_email, name=automation.owner_name
        ),
        is_owner=is_owner,
        next_runs=upcoming,
        running=any(r.status in {RunStatus.QUEUED, RunStatus.RUNNING} for r in runs),
        runs=[run_out(r, owner=is_owner) for r in runs],
        health=_health(automation, agent, runs),
        created_at=automation.created_at,
        updated_at=automation.updated_at,
    )


def _check_task(body: TaskIn) -> None:
    if find_secrets(f"{body.name}\n{body.task}"):
        # D26: the same validation as an agent's prompt; the match is never repeated.
        raise ApiError(422, "secret_in_task", "the task contains what looks like a credential")


def _audit(
    deps: TasksDeps, event: str, caller: Caller, automation: Automation, **detail: Any
) -> None:
    """Fail closed: a change that cannot be audited is not made (rule 4)."""
    try:
        deps.audit.emit(
            event,
            caller.user.user_id,
            {
                "task_id": automation.automation_id,
                "agent": automation.agent_id,
                "owner": automation.owner_id,
                "trigger": automation.trigger,
                **detail,
            },
            caller.user,
        )
    except Exception as exc:
        raise ApiError(503, "audit_unavailable", "the change could not be audited; retry") from exc


def _now_iso(deps: TasksDeps) -> str:
    return datetime.fromtimestamp(deps.clock(), UTC).isoformat(timespec="seconds")


def _check_trigger(caller: Caller, trigger: TriggerIn) -> None:
    if trigger.event_type in CENTRAL_EVENTS and not caller.user.is_central:
        raise ApiError(403, "central_only", "only central people may subscribe to this event")


def create_task(deps: TasksDeps, caller: Caller, body: TaskIn) -> Automation:
    _check_task(body)
    _check_trigger(caller, body.trigger)
    now = _now_iso(deps)
    trigger = body.trigger
    automation = Automation(
        automation_id=secrets.token_hex(16),
        owner_id=caller.user.user_id,
        owner_email=caller.user.email,
        owner_name=caller.user.name,
        agent_id=body.agent_id,
        name=body.name.strip(),
        task=body.task.strip(),
        trigger=trigger.kind,
        spec=trigger.schedule.model_dump() if trigger.schedule else None,
        timezone=trigger.timezone if trigger.kind == "schedule" else None,
        event_type=trigger.event_type,
        deliver=body.deliver,
        status=Status.ACTIVE,
        paused_reason=None,
        paused_at=None,
        retired_by=None,
        retired_at=None,
        retired_reason=None,
        created_at=now,
        updated_at=now,
    )
    _audit(deps, "task.created", caller, automation, outcome="requested")
    try:
        deps.store.create(automation)
    except TaskLimitError as exc:
        raise ApiError(409, "task_limit", "the limit of tasks was reached") from exc
    except TaskStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    if automation.trigger == "schedule":
        try:
            deps.scheduler.create(automation)
        except SchedulerUnavailableError as exc:
            # Never a task without its schedule, nor a schedule without its task.
            deps.store.delete_new(automation)
            raise _unavailable(exc) from exc
    _audit(deps, "task.created", caller, automation, outcome="applied")
    return automation


def update_task(
    deps: TasksDeps, caller: Caller, automation: Automation, body: TaskIn
) -> Automation:
    if automation.status is Status.RETIRED or automation.paused_reason is PauseReason.ACCESS_LOST:
        raise ApiError(409, "task_not_editable", "this task cannot be edited")
    if body.trigger.kind != automation.trigger:
        # A trigger is what a task is: a new trigger is a new task.
        raise ApiError(409, "trigger_change", "the trigger of a task cannot change")
    _check_task(body)
    trigger = body.trigger
    changes: dict[str, Any] = {
        "name": body.name.strip(),
        "task": body.task.strip(),
        "agent_id": body.agent_id,
        "deliver": body.deliver,
        "spec": trigger.schedule.model_dump() if trigger.schedule else None,
        "timezone": trigger.timezone if trigger.kind == "schedule" else None,
    }
    updated = replace(
        automation,
        name=changes["name"],
        task=changes["task"],
        agent_id=body.agent_id,
        spec=changes["spec"],
        timezone=changes["timezone"],
    )
    _audit(deps, "task.updated", caller, updated, outcome="requested")
    try:
        deps.store.update(automation, changes, expect_status=frozenset({automation.status}))
    except TaskConflictError as exc:
        raise ApiError(409, "version_conflict", "the task changed; reload it") from exc
    except TaskStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    if updated.trigger == "schedule":
        try:
            deps.scheduler.update(updated, enabled=updated.status is Status.ACTIVE)
        except SchedulerUnavailableError as exc:
            raise _unavailable(exc) from exc
    _audit(deps, "task.updated", caller, updated, outcome="applied")
    return updated


def pause_task(
    deps: TasksDeps,
    caller: Caller,
    automation: Automation,
    *,
    reason: PauseReason,
    note: str | None = None,
) -> Automation:
    # An administrator may also hold a task its owner paused (A1 of the second review, D78
    # (19)): the reason becomes ``admin`` and the brake of D2 applies from then on.
    takes_over = (
        automation.status is Status.PAUSED
        and automation.paused_reason is PauseReason.OWNER
        and reason is PauseReason.ADMIN
    )
    if automation.status is not Status.ACTIVE and not takes_over:
        raise ApiError(409, "task_not_active", "this task is not active")
    expected = frozenset({Status.PAUSED}) if takes_over else frozenset({Status.ACTIVE})
    by_admin = reason is PauseReason.ADMIN
    if by_admin and not (note and note.strip()):
        # D82 (2): an administrator says why; the owner reads it in the task.
        raise ApiError(422, "reason_required", "say why you pause this task")
    paused = replace(
        automation,
        status=Status.PAUSED,
        paused_reason=reason,
        paused_at=_now_iso(deps),
        paused_note=note.strip() if by_admin and note else None,
        paused_by=(caller.user.email or caller.user.user_id) if by_admin else None,
    )
    # The note is the administrator's text: shown in the app, never audited (TM-T8).
    _audit(deps, "task.paused", caller, automation, reason=reason.value, outcome="requested")
    try:
        deps.store.update(
            automation,
            {
                "status": Status.PAUSED,
                "paused_reason": reason.value,
                "paused_at": paused.paused_at,
                "paused_note": paused.paused_note,
                "paused_by": paused.paused_by,
            },
            expect_status=expected,
        )
        if automation.trigger == "schedule" and not takes_over:
            deps.scheduler.update(paused, enabled=False)
    except TaskConflictError as exc:
        raise ApiError(409, "version_conflict", "the task changed; reload it") from exc
    except (TaskStoreUnavailableError, SchedulerUnavailableError) as exc:
        raise _unavailable(exc) from exc
    _audit(deps, "task.paused", caller, automation, reason=reason.value, outcome="applied")
    return paused


def resume_task(deps: TasksDeps, caller: Caller, automation: Automation) -> Automation:
    """Only the owner resumes, with the access they have now (checked by the route)."""
    if automation.status is not Status.PAUSED:
        raise ApiError(409, "task_not_paused", "this task is not paused")
    is_owner = automation.owner_id == caller.user.user_id
    if automation.event_type in CENTRAL_EVENTS and is_owner and not caller.user.is_central:
        raise ApiError(403, "central_only", "only central people may subscribe to this event")
    resumed = replace(
        automation,
        status=Status.ACTIVE,
        paused_reason=None,
        paused_at=None,
        paused_note=None,
        paused_by=None,
    )
    _audit(deps, "task.resumed", caller, automation, outcome="requested")
    try:
        deps.store.update(
            automation,
            {
                "status": Status.ACTIVE,
                "paused_reason": None,
                "paused_at": None,
                "paused_note": None,
                "paused_by": None,
            },
            expect_status=frozenset({Status.PAUSED}),
        )
        if automation.trigger == "schedule":
            deps.scheduler.update(resumed, enabled=True)
    except TaskConflictError as exc:
        raise ApiError(409, "version_conflict", "the task changed; reload it") from exc
    except (TaskStoreUnavailableError, SchedulerUnavailableError) as exc:
        raise _unavailable(exc) from exc
    _audit(deps, "task.resumed", caller, automation, outcome="applied")
    return resumed


def retire_task(deps: TasksDeps, caller: Caller, automation: Automation, reason: str) -> Automation:
    if automation.status is Status.RETIRED:
        raise ApiError(409, "task_retired", "this task was retired")
    # The reason is the person's text: audited as its length only, shown in the app.
    _audit(deps, "task.retired", caller, automation, outcome="requested")
    retired = replace(
        automation,
        status=Status.RETIRED,
        retired_by=caller.user.email or caller.user.user_id,
        retired_at=_now_iso(deps),
        retired_reason=reason.strip(),
    )
    try:
        deps.store.update(
            automation,
            {
                "status": Status.RETIRED,
                "retired_by": retired.retired_by,
                "retired_at": retired.retired_at,
                "retired_reason": retired.retired_reason,
            },
            expect_status=frozenset({Status.ACTIVE, Status.PAUSED}),
        )
    except TaskConflictError as exc:
        raise ApiError(409, "version_conflict", "the task changed; reload it") from exc
    except TaskStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    _audit(deps, "task.retired", caller, automation, outcome="applied")
    if automation.trigger == "schedule":
        try:
            deps.scheduler.delete(automation.automation_id)
        except SchedulerUnavailableError:
            # Retired already: whatever it still sends is skipped (TM-T7). The next retire of
            # the same task cannot happen, so this is logged for the operator.
            logger.exception("the schedule of a retired task could not be deleted")
    return retired


def run_now(deps: TasksDeps, caller: Caller, automation: Automation) -> Run:
    if automation.status is Status.RETIRED or automation.paused_reason is PauseReason.ACCESS_LOST:
        raise ApiError(409, "task_not_runnable", "this task cannot run")
    if automation.paused_reason is PauseReason.ADMIN:
        # D2 (after the review): an administrator's pause is a brake, also for its owner.
        raise ApiError(409, "paused_by_admin", "an administrator paused this task")
    _limit(deps.runs, caller.user.user_id)
    run = Run(
        run_id=secrets.token_hex(16),
        automation_id=automation.automation_id,
        trigger=task_runs.KIND_MANUAL,
        status=RunStatus.QUEUED,
        queued_at=int(deps.clock()),
    )
    try:
        stored = deps.store.add_run(run)
    except TaskStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    if stored is None:
        raise _unavailable(TaskConflictError())
    try:
        deps.queue.send(task_runs.manual_message(automation.automation_id, run.run_id))
    except Exception as exc:
        deps.store.update_run(
            stored,
            status=RunStatus.FAILED,
            expect=frozenset({RunStatus.QUEUED}),
            reason="queue_unavailable",
            ended_at=int(deps.clock()),
        )
        raise _unavailable(exc) from exc
    return stored


def list_tasks(deps: TasksDeps, caller: Caller) -> list[Automation]:
    """The caller's tasks; an administrator sees every task of the installation."""
    try:
        if caller.user.is_admin:
            return deps.store.everything()
        return deps.store.by_owner(caller.user.user_id)
    except TaskStoreUnavailableError as exc:
        raise _unavailable(exc) from exc


# --- Router -------------------------------------------------------------------------------


def tasks_router(  # noqa: PLR0915 - registers the route closures
    deps: TasksDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: AuthorizeTask,
    is_allowed: Callable[[Caller, str, str, str, TaskResource | None], bool],
) -> APIRouter:
    """``is_allowed(caller, action, resource_type, resource_id)``: one decision, no 403."""
    router = APIRouter(prefix="/api/tasks")
    TaskId = Annotated[str, Path(pattern=TASK_ID_PATTERN)]  # noqa: N806
    RunId = Annotated[str, Path(pattern=task_runs.ID_PATTERN)]  # noqa: N806

    async def run[T](fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        return await asyncio.to_thread(fn, *args, **kwargs)

    async def signed_in(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        return caller

    async def creator(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        await authorize(caller, "CreateTask", *PLATFORM)
        return caller

    SignedIn = Annotated[Caller, Depends(signed_in)]  # noqa: N806
    Creator = Annotated[Caller, Depends(creator)]  # noqa: N806

    async def load(caller: Caller, task_id: str, action: str) -> Automation:
        """The task, if the caller may ``action`` it; 404 for anyone who may not even see it."""
        try:
            automation = await run(deps.store.get, task_id)
        except TaskStoreUnavailableError as exc:
            raise _unavailable(exc) from exc
        if automation is None:
            raise HTTPException(status_code=404, detail="not found")
        resource = TaskResource(task_id, automation.owner_id)
        if action != "ViewTask" and not await run(
            is_allowed, caller, "ViewTask", TASK_TYPE, task_id, resource
        ):
            raise HTTPException(status_code=404, detail="not found")
        try:
            await authorize(caller, action, TASK_TYPE, task_id, task=resource)
        except HTTPException as exc:
            if action == "ViewTask":
                raise HTTPException(status_code=404, detail="not found") from exc
            raise
        return automation

    async def use_agent(caller: Caller, agent_id: str, task_id: str | None) -> None:
        """A task on an agent is using it: only a published agent the caller may use."""
        agent = await run(_served, deps, agent_id)
        resource = (
            AgentResource(agent_id)
            if agent is None
            else AgentResource(
                agent_id,
                groups=frozenset(agent.definition.groups),
                users=frozenset(agent.definition.users),
            )
        )
        context = {"task": task_id} if task_id else None
        await authorize(
            caller, "UseAgent", "Mango::Agent", agent_id, context=context, agent=resource
        )
        if agent is None or agent.retired:
            raise ApiError(409, "agent_unavailable", "this agent is not published")

    @router.get("", response_model=TaskListOut)
    async def list_tasks_of_caller(caller: SignedIn) -> TaskListOut:
        automations = await run(list_tasks, deps, caller)
        items = [await run(task_out, deps, a, caller) for a in automations]
        can_create = await run(is_allowed, caller, "CreateTask", *PLATFORM, None)
        return TaskListOut(
            items=items, can_create=can_create, can_subscribe_events=caller.user.is_central
        )

    @router.post("/next-runs", response_model=PreviewOut)
    async def preview_next_runs(body: PreviewIn, caller: Creator) -> PreviewOut:
        """The next runs of a schedule in its zone, before it is saved (design 2.5): computed
        here, as for a saved task. Pure computation on a validated body: nothing is read or
        written, and nothing is audited."""
        now = datetime.fromtimestamp(deps.clock(), UTC)
        return PreviewOut(next_runs=next_runs(body.schedule, body.timezone, now))

    @router.post("", response_model=TaskOut, status_code=201)
    async def create_new_task(body: TaskIn, caller: Creator) -> TaskOut:
        _limit(deps.changes, caller.user.user_id)
        await use_agent(caller, body.agent_id, None)
        automation = await run(create_task, deps, caller, body)
        return await run(task_out, deps, automation, caller)

    @router.get("/{task_id}", response_model=TaskOut)
    async def get_task(task_id: TaskId, caller: SignedIn) -> TaskOut:
        automation = await load(caller, task_id, "ViewTask")
        return await run(task_out, deps, automation, caller)

    @router.put("/{task_id}", response_model=TaskOut)
    async def update_existing_task(task_id: TaskId, body: TaskIn, caller: Creator) -> TaskOut:
        automation = await load(caller, task_id, "OwnTask")
        _limit(deps.changes, caller.user.user_id)
        await use_agent(caller, body.agent_id, task_id)
        updated = await run(update_task, deps, caller, automation, body)
        return await run(task_out, deps, updated, caller)

    @router.post("/{task_id}/run", response_model=RunOut, status_code=202)
    async def run_task_now(task_id: TaskId, _body: EmptyIn, caller: SignedIn) -> RunOut:
        automation = await load(caller, task_id, "OwnTask")
        # The owner is here: their access now decides, before anything is queued.
        await use_agent(caller, automation.agent_id, task_id)
        return run_out(await run(run_now, deps, caller, automation))

    @router.post("/{task_id}/pause", response_model=TaskOut)
    async def pause_existing_task(task_id: TaskId, body: PauseIn, caller: SignedIn) -> TaskOut:
        automation = await load(caller, task_id, "ControlTask")
        _limit(deps.changes, caller.user.user_id)
        reason = (
            PauseReason.OWNER if automation.owner_id == caller.user.user_id else PauseReason.ADMIN
        )
        paused = await run(pause_task, deps, caller, automation, reason=reason, note=body.reason)
        return await run(task_out, deps, paused, caller)

    @router.post("/{task_id}/resume", response_model=TaskOut)
    async def resume_paused_task(task_id: TaskId, _body: EmptyIn, caller: SignedIn) -> TaskOut:
        automation = await load(caller, task_id, "ViewTask")
        resource = TaskResource(task_id, automation.owner_id)
        if automation.paused_reason is PauseReason.ADMIN:
            # D2 (after the review): only an administrator lifts an administrator's pause. The
            # next run checks its owner's access as always.
            await authorize(caller, "ControlTask", TASK_TYPE, task_id, task=resource)
            if not caller.user.is_admin:
                raise ApiError(403, "paused_by_admin", "an administrator paused this task")
            _limit(deps.changes, caller.user.user_id)
        else:
            await authorize(caller, "OwnTask", TASK_TYPE, task_id, task=resource)
            _limit(deps.changes, caller.user.user_id)
            # Paused because its owner lost access: it resumes only if the owner has it again.
            await use_agent(caller, automation.agent_id, task_id)
        resumed = await run(resume_task, deps, caller, automation)
        return await run(task_out, deps, resumed, caller)

    @router.post("/{task_id}/retire", response_model=TaskOut)
    async def retire_existing_task(task_id: TaskId, body: RetireIn, caller: SignedIn) -> TaskOut:
        automation = await load(caller, task_id, "ControlTask")
        _limit(deps.changes, caller.user.user_id)
        retired = await run(retire_task, deps, caller, automation, body.reason)
        return await run(task_out, deps, retired, caller)

    @router.get("/{task_id}/runs/{run_id}", response_model=RunDetailOut)
    async def get_task_run(task_id: TaskId, run_id: RunId, caller: SignedIn) -> RunDetailOut:
        automation = await load(caller, task_id, "ViewTask")
        owner = automation.owner_id == caller.user.user_id
        try:
            found = await run(deps.store.run, task_id, run_id)
        except TaskStoreUnavailableError as exc:
            raise _unavailable(exc) from exc
        if found is None:
            raise HTTPException(status_code=404, detail="not found")
        # D1 (after the review): status, cost and reason for whoever sees the task; the
        # answer, obtained with the owner's access, only for the owner (as D23 for chats).
        return RunDetailOut(
            **run_out(found, owner=owner).model_dump(),
            result=found.result if owner else None,
            steps=[StepOut(text=step["text"], tool=step["tool"] or None) for step in found.steps]
            if owner
            else [],
        )

    return router


__all__ = [
    "MAX_PER_INSTALLATION",
    "MAX_PER_OWNER",
    "TIMEZONES",
    "RunQueue",
    "ScheduleSpec",
    "TaskScheduler",
    "TasksDeps",
    "next_runs",
    "schedule_expression",
    "tasks_router",
]
