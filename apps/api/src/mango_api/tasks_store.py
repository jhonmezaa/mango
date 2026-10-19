"""Tasks table repository (D78): automations of a published agent and their runs.

Item layout, all under ``PK = AUTO#<automation id>``:

* ``SK = META``: the automation. ``owner_id`` is the verified subject of whoever created it
  and never changes; ``spec`` is the schedule as the design describes it (never a cron
  expression from the client); ``status`` and its reason; ``running_run`` while a run holds
  the automation (one at a time, TM-T5).
* ``SK = RUN#<start, reversed>#<run id>``: a run, newest first. Its result (the agent's text)
  lives here, with the table's TTL: never in logs nor in the audit trail (TM-T8). An event run
  that waits for the previous one (D81) keeps ``waiting_since`` and the ``wake`` of the one
  message that may resume it.
  A run of a task with a report (D86) keeps it in ``report_*``: its status (``generating``,
  ``ready``, ``failed`` with ``report_reason``), what mango-api computed for the PDF
  (``report_meta``: file, object key, names) and the validated data (``report_data``). The
  function ``Mango-<ns>-TaskReport`` may change only ``report_status``, ``report_reason``,
  ``report_pages`` and ``report_bytes`` (its role says so).
* ``SK = RUNKEY#<run id>``: the idempotency mark of a run, written in the same transaction as
  the run. A trigger delivered twice finds it and runs nothing (D78, SQS at least once).

Two counters (``PK = COUNT#USER#<sub>`` and ``COUNT#ALL``, ``SK = COUNT``) keep the number of
automations that are not retired below the limits per person and per installation in the
same transaction as the automation they count.

Indexes: ``ByOwner`` (``owner_id``, ``created_at``), ``All`` (``all_pk`` = ``AUTO``,
``created_at``) and ``ByEvent`` (``event_key`` = ``EVENT#<type>``, only automations with an
event trigger). Keep in sync with ``infra/lib/constructs/tasks.ts``.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from botocore.exceptions import ClientError

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

INDEX_BY_OWNER = "ByOwner"
INDEX_ALL = "All"
INDEX_BY_EVENT = "ByEvent"
SK_META = "META"
ALL_PK = "AUTO"
RETENTION = timedelta(days=90)
"""TTL of a run and its result (decided 2026-10-15). A retired automation stays listed."""
MAX_RESULT_CHARS = 32 * 1024
RUNS_SHOWN = 10
_MAX_REVERSED = 10**13
_PAGE = 100


class Status(StrEnum):
    ACTIVE = "active"
    PAUSED = "paused"
    RETIRED = "retired"


class PauseReason(StrEnum):
    OWNER = "owner"
    ADMIN = "admin"
    ACCESS_LOST = "access_lost"
    """The owner lost access (D26): only the owner resumes it, and only with access again."""


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    OK = "ok"
    FAILED = "failed"
    SKIPPED = "skipped"
    APPROVAL = "approval"
    """The agent asked for a write: a request waits for its owner (A3, D56)."""


FINAL_RUN_STATUSES = frozenset(
    {RunStatus.OK, RunStatus.FAILED, RunStatus.SKIPPED, RunStatus.APPROVAL}
)


class TaskConflictError(Exception):
    """A condition refused the write: the item is not in the state the caller read."""


class TaskLimitError(Exception):
    """One more automation would pass the limit per person or per installation."""


class TaskStoreUnavailableError(Exception):
    """The table could not be read or written."""


@dataclass(frozen=True)
class Automation:
    automation_id: str
    owner_id: str
    owner_email: str | None
    owner_name: str | None
    agent_id: str
    name: str
    task: str
    trigger: str
    """``manual``, ``schedule`` or ``event``."""
    spec: dict[str, Any] | None
    timezone: str | None
    event_type: str | None
    deliver: str
    status: Status
    paused_reason: PauseReason | None
    paused_at: str | None
    retired_by: str | None
    retired_at: str | None
    retired_reason: str | None
    created_at: str
    updated_at: str
    running_run: str | None = None
    running_since: int | None = None
    paused_note: str | None = None
    """Why an administrator paused it (D82 (2)): the administrator's text, shown to the owner."""
    paused_by: str | None = None
    """Who paused it, when an administrator did; only administrators read it (D82 (2))."""
    report: str | None = None
    """The type of PDF each run also delivers (D86): ``cost_summary`` or ``anomaly``."""


@dataclass(frozen=True)
class Run:
    run_id: str
    automation_id: str
    trigger: str
    status: RunStatus
    queued_at: int
    started_at: int | None = None
    ended_at: int | None = None
    cost_usd: str | None = None
    reason: str | None = None
    """Why it was skipped or failed: a fixed code, never text of the model or of an event."""
    result: str | None = None
    turn_id: str | None = None
    approvals: list[str] = field(default_factory=list)
    scheduled_at: str | None = None
    event_ref: str | None = None
    waiting_since: int | None = None
    """When an event run first found its task busy and started to wait (D81)."""
    wake: str | None = None
    """The random id of the only message that resumes a waiting run; never shown."""
    anomaly_start: str | None = None
    anomaly_end: str | None = None
    """The dates of the cost anomaly that started an event run (ISO dates, validated)."""
    anomaly_id: str | None = None
    """AWS's id of that anomaly (a UUID, validated; D85)."""
    steps: list[dict[str, str]] = field(default_factory=list)
    """What the agent wrote before each tool call, with the tool (``text``, ``tool``). When a run
    has steps, ``result`` is only what it wrote after the last one: the report."""
    report_status: str | None = None
    """``generating``, ``ready`` or ``failed`` (D86); ``None`` when the run has no PDF."""
    report_reason: str | None = None
    report_pages: int | None = None
    report_bytes: int | None = None
    report_at: int | None = None
    """When its PDF was asked for: a generation older than the timeout failed in silence."""
    report_meta: dict[str, Any] = field(default_factory=dict)
    sk: str = ""


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: int) -> dict[str, str]:
    return {"N": str(value)}


def _str(item: dict[str, Any], name: str) -> str | None:
    value = item.get(name)
    return value["S"] if value and "S" in value else None


def _int(item: dict[str, Any], name: str) -> int | None:
    value = item.get(name)
    return int(value["N"]) if value and "N" in value else None


def _pk(automation_id: str) -> str:
    return f"AUTO#{automation_id}"


def _owner_counter(owner_id: str) -> dict[str, Any]:
    return {"PK": _s(f"COUNT#USER#{owner_id}"), "SK": _s("COUNT")}


_ALL_COUNTER = {"PK": _s("COUNT#ALL"), "SK": _s("COUNT")}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _automation(item: dict[str, Any]) -> Automation:
    spec = _str(item, "spec")
    reason = _str(item, "paused_reason")
    return Automation(
        automation_id=item["PK"]["S"].removeprefix("AUTO#"),
        owner_id=item["owner_id"]["S"],
        owner_email=_str(item, "owner_email"),
        owner_name=_str(item, "owner_name"),
        agent_id=item["agent_id"]["S"],
        name=item["name"]["S"],
        task=item["task"]["S"],
        trigger=item["trigger"]["S"],
        spec=json.loads(spec) if spec else None,
        timezone=_str(item, "timezone"),
        event_type=_str(item, "event_type"),
        deliver=item["deliver"]["S"],
        status=Status(item["status"]["S"]),
        paused_reason=PauseReason(reason) if reason else None,
        paused_at=_str(item, "paused_at"),
        retired_by=_str(item, "retired_by"),
        retired_at=_str(item, "retired_at"),
        retired_reason=_str(item, "retired_reason"),
        created_at=item["created_at"]["S"],
        updated_at=item["updated_at"]["S"],
        running_run=_str(item, "running_run"),
        running_since=_int(item, "running_since"),
        paused_note=_str(item, "paused_note"),
        paused_by=_str(item, "paused_by"),
        report=_str(item, "report"),
    )


def _run(item: dict[str, Any]) -> Run:
    approvals = item.get("approvals", {}).get("L", [])
    return Run(
        run_id=item["run_id"]["S"],
        automation_id=item["PK"]["S"].removeprefix("AUTO#"),
        trigger=item["trigger"]["S"],
        status=RunStatus(item["status"]["S"]),
        queued_at=int(item["queued_at"]["N"]),
        started_at=_int(item, "started_at"),
        ended_at=_int(item, "ended_at"),
        cost_usd=_str(item, "cost_usd"),
        reason=_str(item, "reason"),
        result=_str(item, "result"),
        turn_id=_str(item, "turn_id"),
        approvals=[a["S"] for a in approvals if "S" in a],
        scheduled_at=_str(item, "scheduled_at"),
        event_ref=_str(item, "event_ref"),
        waiting_since=_int(item, "waiting_since"),
        wake=_str(item, "wake"),
        anomaly_start=_str(item, "anomaly_start"),
        anomaly_end=_str(item, "anomaly_end"),
        anomaly_id=_str(item, "anomaly_id"),
        steps=_steps(_str(item, "steps")),
        report_status=_str(item, "report_status"),
        report_reason=_str(item, "report_reason"),
        report_pages=_int(item, "report_pages"),
        report_bytes=_int(item, "report_bytes"),
        report_at=_int(item, "report_at"),
        report_meta=_meta(_str(item, "report_meta")),
        sk=item["SK"]["S"],
    )


def _steps(raw: str | None) -> list[dict[str, str]]:
    if not raw:
        return []
    try:
        loaded = json.loads(raw)
    except ValueError:
        return []
    if not isinstance(loaded, list):
        return []
    return [
        {"text": str(step.get("text", "")), "tool": str(step.get("tool", ""))}
        for step in loaded
        if isinstance(step, dict)
    ]


def _meta(raw: str | None) -> dict[str, Any]:
    try:
        loaded = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _conditional(exc: ClientError) -> bool:
    code = exc.response.get("Error", {}).get("Code")
    return code in {"ConditionalCheckFailedException", "TransactionCanceledException"}


class TaskStore:
    def __init__(
        self,
        dynamodb: DynamoDBClient,
        table: str,
        *,
        per_owner: int,
        per_installation: int,
        clock: Any = time.time,
    ) -> None:
        self._db = dynamodb
        self._table = table
        self._per_owner = per_owner
        self._per_installation = per_installation
        self._clock = clock

    # --- Automations --------------------------------------------------------------------

    def create(self, automation: Automation) -> None:
        """Save a new automation, counted against both limits in the same transaction."""
        item: dict[str, Any] = {
            "PK": _s(_pk(automation.automation_id)),
            "SK": _s(SK_META),
            "all_pk": _s(ALL_PK),
            "owner_id": _s(automation.owner_id),
            "agent_id": _s(automation.agent_id),
            "name": _s(automation.name),
            "task": _s(automation.task),
            "trigger": _s(automation.trigger),
            "deliver": _s(automation.deliver),
            "status": _s(automation.status),
            "created_at": _s(automation.created_at),
            "updated_at": _s(automation.updated_at),
        }
        if automation.owner_email:
            item["owner_email"] = _s(automation.owner_email)
        if automation.owner_name:
            item["owner_name"] = _s(automation.owner_name)
        if automation.spec is not None:
            item["spec"] = _s(json.dumps(automation.spec, sort_keys=True, separators=(",", ":")))
        if automation.timezone:
            item["timezone"] = _s(automation.timezone)
        if automation.event_type:
            item["event_type"] = _s(automation.event_type)
            item["event_key"] = _s(f"EVENT#{automation.event_type}")
        if automation.report:
            item["report"] = _s(automation.report)
        count = "SET n = if_not_exists(n, :zero) + :one"
        try:
            self._db.transact_write_items(
                TransactItems=[
                    {
                        "Put": {
                            "TableName": self._table,
                            "Item": item,
                            "ConditionExpression": "attribute_not_exists(PK)",
                        }
                    },
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": _owner_counter(automation.owner_id),
                            "UpdateExpression": count,
                            "ConditionExpression": "attribute_not_exists(n) OR n < :limit",
                            "ExpressionAttributeValues": {
                                ":zero": _n(0),
                                ":one": _n(1),
                                ":limit": _n(self._per_owner),
                            },
                        }
                    },
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": _ALL_COUNTER,
                            "UpdateExpression": count,
                            "ConditionExpression": "attribute_not_exists(n) OR n < :limit",
                            "ExpressionAttributeValues": {
                                ":zero": _n(0),
                                ":one": _n(1),
                                ":limit": _n(self._per_installation),
                            },
                        }
                    },
                ]
            )
        except ClientError as exc:
            if _conditional(exc):
                raise TaskLimitError from exc
            raise TaskStoreUnavailableError from exc

    def delete_new(self, automation: Automation) -> None:
        """Undo ``create`` when its schedule could not be created; never raises."""
        try:
            self._db.transact_write_items(
                TransactItems=[
                    {
                        "Delete": {
                            "TableName": self._table,
                            "Key": {"PK": _s(_pk(automation.automation_id)), "SK": _s(SK_META)},
                        }
                    },
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": _owner_counter(automation.owner_id),
                            "UpdateExpression": "SET n = n - :one",
                            "ConditionExpression": "n > :zero",
                            "ExpressionAttributeValues": {":one": _n(1), ":zero": _n(0)},
                        }
                    },
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": _ALL_COUNTER,
                            "UpdateExpression": "SET n = n - :one",
                            "ConditionExpression": "n > :zero",
                            "ExpressionAttributeValues": {":one": _n(1), ":zero": _n(0)},
                        }
                    },
                ]
            )
        except ClientError:
            return

    def get(self, automation_id: str) -> Automation | None:
        try:
            resp = self._db.get_item(
                TableName=self._table,
                Key={"PK": _s(_pk(automation_id)), "SK": _s(SK_META)},
                ConsistentRead=True,
            )
        except ClientError as exc:
            raise TaskStoreUnavailableError from exc
        item = resp.get("Item")
        return _automation(item) if item else None

    def _query(self, **kwargs: Any) -> list[Automation]:
        out: list[Automation] = []
        start: dict[str, Any] | None = None
        try:
            while True:
                request: dict[str, Any] = {
                    "TableName": self._table,
                    "ScanIndexForward": False,
                    "Limit": _PAGE,
                    **kwargs,
                }
                if start:
                    request["ExclusiveStartKey"] = start
                page = self._db.query(**request)
                out.extend(_automation(item) for item in page.get("Items", []))
                start = page.get("LastEvaluatedKey")
                if not start:
                    return out
        except ClientError as exc:
            raise TaskStoreUnavailableError from exc

    def by_owner(self, owner_id: str) -> list[Automation]:
        return self._query(
            IndexName=INDEX_BY_OWNER,
            KeyConditionExpression="owner_id = :o",
            ExpressionAttributeValues={":o": _s(owner_id)},
        )

    def everything(self) -> list[Automation]:
        """Every automation of the installation (at most the limit plus the retired)."""
        return self._query(
            IndexName=INDEX_ALL,
            KeyConditionExpression="all_pk = :a",
            ExpressionAttributeValues={":a": _s(ALL_PK)},
        )

    def subscribed(self, event_type: str) -> list[Automation]:
        """Active automations with an event trigger of this type."""
        found = self._query(
            IndexName=INDEX_BY_EVENT,
            KeyConditionExpression="event_key = :e",
            ExpressionAttributeValues={":e": _s(f"EVENT#{event_type}")},
        )
        return [a for a in found if a.status is Status.ACTIVE and a.trigger == "event"]

    def update(
        self,
        automation: Automation,
        changes: dict[str, Any],
        *,
        expect_status: frozenset[Status],
    ) -> None:
        """Set fields of an automation that is still in one of ``expect_status``.

        A value of ``None`` removes the attribute. Retiring also frees its place in both
        counters, in the same transaction.
        """
        names: dict[str, str] = {}
        values: dict[str, Any] = {":now": _s(_now_iso())}
        sets = ["#updated_at = :now"]
        removes: list[str] = []
        names["#updated_at"] = "updated_at"
        for index, (name, value) in enumerate(sorted(changes.items())):
            names[f"#f{index}"] = name
            if value is None:
                removes.append(f"#f{index}")
            else:
                values[f":v{index}"] = (
                    _s(json.dumps(value, sort_keys=True, separators=(",", ":")))
                    if name == "spec"
                    else _s(str(value))
                )
                sets.append(f"#f{index} = :v{index}")
        statuses = sorted(expect_status)
        for index, status in enumerate(statuses):
            values[f":st{index}"] = _s(status)
        names["#status"] = "status"
        condition = "attribute_exists(PK) AND #status IN ({})".format(
            ", ".join(f":st{i}" for i in range(len(statuses)))
        )
        expression = "SET " + ", ".join(sets) + (" REMOVE " + ", ".join(removes) if removes else "")
        update: dict[str, Any] = {
            "TableName": self._table,
            "Key": {"PK": _s(_pk(automation.automation_id)), "SK": _s(SK_META)},
            "UpdateExpression": expression,
            "ConditionExpression": condition,
            "ExpressionAttributeNames": names,
            "ExpressionAttributeValues": values,
        }
        items: list[Any] = [{"Update": update}]
        if changes.get("status") == Status.RETIRED:
            for key in (_owner_counter(automation.owner_id), _ALL_COUNTER):
                items.append(
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": key,
                            "UpdateExpression": "SET n = n - :one",
                            "ConditionExpression": "n > :zero",
                            "ExpressionAttributeValues": {":one": _n(1), ":zero": _n(0)},
                        }
                    }
                )
        try:
            self._db.transact_write_items(TransactItems=items)
        except ClientError as exc:
            if _conditional(exc):
                raise TaskConflictError from exc
            raise TaskStoreUnavailableError from exc

    def hold(
        self, automation_id: str, run_id: str, *, stale_before: int, allow_paused: bool = False
    ) -> bool:
        """Take the automation for one run: false when a run holds it (and has not outlived its
        turn) or the automation may not run. A paused task still runs when its owner presses
        «Ejecutar ahora» (``allow_paused``); a retired one never does. Not even the same run
        takes it twice: two deliveries of one run never both pass (D81)."""
        statuses = [Status.ACTIVE, Status.PAUSED] if allow_paused else [Status.ACTIVE]
        values: dict[str, Any] = {
            ":r": _s(run_id),
            ":t": _n(int(self._clock())),
            ":stale": _n(stale_before),
            **{f":st{i}": _s(status) for i, status in enumerate(statuses)},
        }
        allowed = ", ".join(f":st{i}" for i in range(len(statuses)))
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": _s(_pk(automation_id)), "SK": _s(SK_META)},
                UpdateExpression="SET running_run = :r, running_since = :t",
                ConditionExpression=(
                    f"#status IN ({allowed}) AND (attribute_not_exists(running_run) OR "
                    "running_since < :stale)"
                ),
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues=values,
            )
        except ClientError as exc:
            if _conditional(exc):
                return False
            raise TaskStoreUnavailableError from exc
        return True

    def release(self, automation_id: str, run_id: str) -> None:
        """Let the next run take the automation; never raises (a stale hold expires)."""
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": _s(_pk(automation_id)), "SK": _s(SK_META)},
                UpdateExpression="REMOVE running_run, running_since",
                ConditionExpression="running_run = :r",
                ExpressionAttributeValues={":r": _s(run_id)},
            )
        except ClientError:
            return

    def count_today(self, automation_id: str, day: str, limit: int) -> bool:
        """Count one more run of the day (``YYYY-MM-DD``, UTC); false once ``limit`` were
        counted. The counter expires with the runs."""
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": _s(_pk(automation_id)), "SK": _s(f"DAY#{day}")},
                UpdateExpression="SET n = if_not_exists(n, :zero) + :one, expires_at = :exp",
                ConditionExpression="attribute_not_exists(n) OR n < :limit",
                ExpressionAttributeValues={
                    ":zero": _n(0),
                    ":one": _n(1),
                    ":limit": _n(limit),
                    ":exp": _n(int(self._clock()) + int(RETENTION.total_seconds())),
                },
            )
        except ClientError as exc:
            if _conditional(exc):
                return False
            raise TaskStoreUnavailableError from exc
        return True

    # --- Runs ---------------------------------------------------------------------------

    def add_run(self, run: Run) -> Run | None:
        """Write a new run with its idempotency mark; ``None`` when it already exists."""
        now = int(self._clock())
        sk = f"RUN#{_MAX_REVERSED - run.queued_at * 1000:013d}#{run.run_id}"
        expires = _n(now + int(RETENTION.total_seconds()))
        item: dict[str, Any] = {
            "PK": _s(_pk(run.automation_id)),
            "SK": _s(sk),
            "run_id": _s(run.run_id),
            "trigger": _s(run.trigger),
            "status": _s(run.status),
            "queued_at": _n(run.queued_at),
            "expires_at": expires,
        }
        if run.scheduled_at:
            item["scheduled_at"] = _s(run.scheduled_at)
        if run.event_ref:
            item["event_ref"] = _s(run.event_ref)
        if run.anomaly_start and run.anomaly_end:
            item["anomaly_start"] = _s(run.anomaly_start)
            item["anomaly_end"] = _s(run.anomaly_end)
            if run.anomaly_id:
                item["anomaly_id"] = _s(run.anomaly_id)
        if run.reason:
            item["reason"] = _s(run.reason)
        if run.ended_at is not None:
            item["ended_at"] = _n(run.ended_at)
        try:
            self._db.transact_write_items(
                TransactItems=[
                    {
                        "Put": {
                            "TableName": self._table,
                            "Item": {
                                "PK": _s(_pk(run.automation_id)),
                                "SK": _s(f"RUNKEY#{run.run_id}"),
                                "run_sk": _s(sk),
                                "expires_at": expires,
                            },
                            "ConditionExpression": "attribute_not_exists(PK)",
                        }
                    },
                    {"Put": {"TableName": self._table, "Item": item}},
                ]
            )
        except ClientError as exc:
            if _conditional(exc):
                return None
            raise TaskStoreUnavailableError from exc
        return Run(**{**run.__dict__, "sk": sk})

    def run(self, automation_id: str, run_id: str) -> Run | None:
        try:
            mark = self._db.get_item(
                TableName=self._table,
                Key={"PK": _s(_pk(automation_id)), "SK": _s(f"RUNKEY#{run_id}")},
                ConsistentRead=True,
            ).get("Item")
            if not mark:
                return None
            item = self._db.get_item(
                TableName=self._table,
                Key={"PK": _s(_pk(automation_id)), "SK": mark["run_sk"]},
                ConsistentRead=True,
            ).get("Item")
        except ClientError as exc:
            raise TaskStoreUnavailableError from exc
        return _run(item) if item else None

    def wait(self, run: Run, wake: str, *, previous: str | None, since: int) -> bool:
        """Hand a queued run to the message ``wake`` (D81): only if it is still queued and its
        wait is still the one ``previous`` names (none for the first). False otherwise: another
        message took the wait, or the run left the queue, and ``wake`` resumes nothing."""
        values: dict[str, Any] = {
            ":w": _s(wake),
            ":since": _n(since),
            ":queued": _s(RunStatus.QUEUED),
        }
        if previous is None:
            same = "attribute_not_exists(wake)"
        else:
            same = "wake = :p"
            values[":p"] = _s(previous)
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": _s(_pk(run.automation_id)), "SK": _s(run.sk)},
                UpdateExpression=(
                    "SET wake = :w, waiting_since = if_not_exists(waiting_since, :since)"
                ),
                ConditionExpression=f"#status = :queued AND {same}",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues=values,
            )
        except ClientError as exc:
            if _conditional(exc):
                return False
            raise TaskStoreUnavailableError from exc
        return True

    def recent_runs(self, automation_id: str, limit: int = RUNS_SHOWN) -> list[Run]:
        try:
            resp = self._db.query(
                TableName=self._table,
                KeyConditionExpression="PK = :p AND begins_with(SK, :r)",
                ExpressionAttributeValues={":p": _s(_pk(automation_id)), ":r": _s("RUN#")},
                Limit=limit,
            )
        except ClientError as exc:
            raise TaskStoreUnavailableError from exc
        return [_run(item) for item in resp.get("Items", [])]

    def update_run(
        self,
        run: Run,
        *,
        status: RunStatus,
        expect: frozenset[RunStatus],
        **fields: Any,
    ) -> bool:
        """Move a run to ``status`` if it is still in one of ``expect``; false otherwise."""
        names = {"#status": "status"}
        values: dict[str, Any] = {":status": _s(status)}
        sets = ["#status = :status"]
        for index, (name, value) in enumerate(sorted(fields.items())):
            if value is None:
                continue
            names[f"#f{index}"] = name
            if isinstance(value, bool):
                raise TypeError("no booleans in a run")
            if isinstance(value, int):
                values[f":v{index}"] = _n(value)
            elif name in {"steps", "report_meta"}:
                # Bounded by the caller (``MAX_STEPS``, the meta of a report): one JSON text.
                values[f":v{index}"] = _s(json.dumps(value, ensure_ascii=False))
            elif isinstance(value, list):
                values[f":v{index}"] = {"L": [_s(str(v)) for v in value]}
            else:
                text = str(value)
                values[f":v{index}"] = _s(text[:MAX_RESULT_CHARS] if name == "result" else text)
            sets.append(f"#f{index} = :v{index}")
        expected = sorted(expect)
        for index, state in enumerate(expected):
            values[f":e{index}"] = _s(state)
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": _s(_pk(run.automation_id)), "SK": _s(run.sk)},
                UpdateExpression="SET " + ", ".join(sets),
                ConditionExpression="#status IN ({})".format(
                    ", ".join(f":e{i}" for i in range(len(expected)))
                ),
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            )
        except ClientError as exc:
            if _conditional(exc):
                return False
            raise TaskStoreUnavailableError from exc
        return True

    def restart_report(self, run: Run, *, now: int, stale_before: int) -> bool:
        """Ask for a run's PDF again («Generar de nuevo», D86): only after ``render``, or a
        generation that outlived its timeout. False when it is in any other state."""
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": _s(_pk(run.automation_id)), "SK": _s(run.sk)},
                UpdateExpression="SET report_status = :g, report_at = :now REMOVE report_reason",
                ConditionExpression=(
                    "(report_status = :f AND report_reason = :render) OR "
                    "(report_status = :g AND report_at < :stale)"
                ),
                ExpressionAttributeValues={
                    ":g": _s("generating"),
                    ":f": _s("failed"),
                    ":render": _s("render"),
                    ":now": _n(now),
                    ":stale": _n(stale_before),
                },
            )
        except ClientError as exc:
            if _conditional(exc):
                return False
            raise TaskStoreUnavailableError from exc
        return True

    def report_failed(self, run: Run, reason: str) -> None:
        """The PDF could not even be asked for (its function did not take the invocation):
        ``render``, so its owner may generate it again. Never raises."""
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": _s(_pk(run.automation_id)), "SK": _s(run.sk)},
                UpdateExpression="SET report_status = :f, report_reason = :r",
                ConditionExpression="report_status = :g",
                ExpressionAttributeValues={
                    ":f": _s("failed"),
                    ":r": _s(reason),
                    ":g": _s("generating"),
                },
            )
        except ClientError:
            return
