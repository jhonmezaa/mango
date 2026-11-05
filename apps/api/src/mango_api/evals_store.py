"""Evals table (D110, D111; threat model ``evals-threat-model.md``).

Item layout in ``Mango-<ns>-Evals`` (``PK`` / ``SK``), which only mango-api writes:

* ``SUITES`` / ``<agent id>#<suite id>``: a suite as the lists show it: its agent, name, kind,
  whether it is required, threshold, trigger, judge model, how many cases it has, its revision
  (optimistic lock), the open request to stop requiring it (``pending``) and its last run.
  One partition for the installation: the lists read it whole (``MAX_SUITES`` items).
* ``SUITE#<suite id>`` / ``CASES``: every case of the suite as canonical JSON. They are content
  (questions and expected answers, D26): written with the suite in one transaction, deleted
  with it, never in logs nor in the audit (only their count and hash).
* ``SUITE#<suite id>`` / ``RUN#<started at>#<run id>``: a run and its result per case (verdict
  and a fixed reason code; never the agent's answer nor the judge's explanation). Kept
  ``RUN_RETENTION`` (TTL).
* ``CHANGES`` / ``<change id>``: a request to stop requiring a suite and its decision. Kept 90
  days after it closes (TTL). The table's condition repeats that whoever asked never decides.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal

from botocore.exceptions import ClientError
from pydantic import ValidationError

from mango_core.evals import EvalCase, EvalCases

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

PK_SUITES = "SUITES"
PK_CHANGES = "CHANGES"
SK_CASES = "CASES"
CHANGE_RETENTION = timedelta(days=90)
RUN_RETENTION = timedelta(days=180)
MAX_PAGES = 10
SuiteKind = Literal["golden", "regression", "security"]
Trigger = Literal["manual", "on_submit"]
ChangeStatus = Literal["pending", "approved", "rejected", "withdrawn"]


class ConflictError(Exception):
    """A condition failed: someone else changed the suite or the request first."""


class StoredEvalError(Exception):
    """A stored item does not satisfy the schema; readers fail closed."""


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _when(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: int) -> dict[str, str]:
    return {"N": str(value)}


def _opt(item: dict[str, Any], key: str) -> str | None:
    value = item.get(key, {}).get("S")
    return value if isinstance(value, str) else None


def _int(item: dict[str, Any], key: str) -> int:
    try:
        return int(item[key]["N"])
    except (KeyError, TypeError, ValueError):
        raise StoredEvalError(f"invalid {key}") from None


def new_id() -> str:
    """Random public id (never incremental)."""
    return secrets.token_hex(16)


def dumps_cases(cases: EvalCases) -> str:
    return json.dumps(
        cases.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )


def loads_cases(raw: str) -> EvalCases:
    try:
        return EvalCases.model_validate_json(raw)
    except ValidationError as exc:
        # The error detail may quote a case: keep only the count.
        raise StoredEvalError(f"invalid cases ({exc.error_count()} errors)") from None


def cases_hash(canonical: str) -> str:
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class LastRun:
    run_id: str
    score: int
    """Percentage of cases that passed, 0 to 100."""
    passed: bool
    content_hash: str
    """Of the version it ran on: the gate of D26 only counts a run of the version reviewed."""
    finished_at: datetime


@dataclass(frozen=True)
class LastAttempt:
    """How the most recent run of the suite ended, whatever it was: a run that stopped or failed
    never becomes the last run (it does not count), but the view says why it ended."""

    run_id: str
    status: str
    """``passed``, ``failed``, ``stopped`` or ``error``."""
    stop_reason: str | None
    cases_done: int
    """Cases that ran (a case skipped for budget did not)."""
    case_count: int
    finished_at: datetime


@dataclass(frozen=True)
class Suite:
    suite_id: str
    agent_id: str
    name: str
    description: str
    kind: SuiteKind
    required: bool
    threshold: int
    trigger: Trigger
    judge_model: str | None
    case_count: int
    cases_sha256: str
    revision: int
    created_by: str
    created_by_email: str | None
    created_at: datetime
    updated_by: str
    updated_at: datetime
    pending: str | None = None
    pending_expires_at: datetime | None = None
    last_run: LastRun | None = None
    running: str | None = None
    """The run that holds the suite (one at a time, TM-EV6)."""
    last_attempt: LastAttempt | None = None
    recent_scores: tuple[int, ...] = ()
    """Scores of the last complete runs, oldest first (at most ``MAX_RECENT_SCORES``)."""
    completed_runs: int = 0
    """Runs that ran to the end and scored: what counts as a run."""

    def locked(self, now: datetime) -> bool:
        """An open request to stop requiring it: until it closes or expires."""
        return self.pending is not None and (
            self.pending_expires_at is None or self.pending_expires_at > now
        )


@dataclass(frozen=True)
class RequirementChange:
    change_id: str
    suite_id: str
    agent_id: str
    status: ChangeStatus
    requested_by: str
    requested_by_email: str | None
    reason: str
    created_at: datetime
    expires_at: datetime
    decided_by: str | None = None
    decided_by_email: str | None = None
    decided_at: datetime | None = None
    note: str | None = None


def _suite_key(agent_id: str, suite_id: str) -> dict[str, Any]:
    return {"PK": _s(PK_SUITES), "SK": _s(f"{agent_id}#{suite_id}")}


def _cases_key(suite_id: str) -> dict[str, Any]:
    return {"PK": _s(f"SUITE#{suite_id}"), "SK": _s(SK_CASES)}


def _suite_item(suite: Suite) -> dict[str, Any]:
    item: dict[str, Any] = {
        **_suite_key(suite.agent_id, suite.suite_id),
        "suite_id": _s(suite.suite_id),
        "agent_id": _s(suite.agent_id),
        "name": _s(suite.name),
        "description": _s(suite.description),
        "kind": _s(suite.kind),
        "required": {"BOOL": suite.required},
        "threshold": _n(suite.threshold),
        "trigger": _s(suite.trigger),
        "case_count": _n(suite.case_count),
        "cases_sha256": _s(suite.cases_sha256),
        "revision": _n(suite.revision),
        "created_by": _s(suite.created_by),
        "created_at": _s(iso(suite.created_at)),
        "updated_by": _s(suite.updated_by),
        "updated_at": _s(iso(suite.updated_at)),
    }
    if suite.created_by_email:
        item["created_by_email"] = _s(suite.created_by_email)
    if suite.judge_model:
        item["judge_model"] = _s(suite.judge_model)
    if suite.pending:
        item["pending"] = _s(suite.pending)
    if suite.pending_expires_at:
        item["pending_expires_at"] = _s(iso(suite.pending_expires_at))
    if suite.running:
        item["running"] = _s(suite.running)
    if suite.last_run:
        run = suite.last_run
        item["last_run"] = {
            "M": {
                "run_id": _s(run.run_id),
                "score": _n(run.score),
                "passed": {"BOOL": run.passed},
                "content_hash": _s(run.content_hash),
                "finished_at": _s(iso(run.finished_at)),
            }
        }
    if suite.last_attempt:
        item["last_attempt"] = _attempt_item(suite.last_attempt)
    if suite.recent_scores:
        item["recent_scores"] = {"L": [_n(score) for score in suite.recent_scores]}
    if suite.completed_runs:
        item["completed_runs"] = _n(suite.completed_runs)
    return item


def _scores(raw: Any) -> tuple[int, ...]:
    if raw is None:
        return ()
    try:
        return tuple(int(value["N"]) for value in raw["L"])
    except (KeyError, TypeError, ValueError):
        raise StoredEvalError("invalid recent scores") from None


def _attempt_item(attempt: LastAttempt) -> dict[str, Any]:
    out: dict[str, Any] = {
        "run_id": _s(attempt.run_id),
        "status": _s(attempt.status),
        "cases_done": _n(attempt.cases_done),
        "case_count": _n(attempt.case_count),
        "finished_at": _s(iso(attempt.finished_at)),
    }
    if attempt.stop_reason:
        out["stop_reason"] = _s(attempt.stop_reason)
    return {"M": out}


def _last_attempt(raw: Any) -> LastAttempt | None:
    if raw is None:
        return None
    try:
        m = raw["M"]
        status = m["status"]["S"]
        if status not in ("passed", "failed", "stopped", "error"):
            raise StoredEvalError("invalid last attempt")
        return LastAttempt(
            run_id=m["run_id"]["S"],
            status=status,
            stop_reason=_opt(m, "stop_reason"),
            cases_done=int(m["cases_done"]["N"]),
            case_count=int(m["case_count"]["N"]),
            finished_at=_when(m["finished_at"]["S"]),
        )
    except (KeyError, TypeError, ValueError):
        raise StoredEvalError("invalid last attempt") from None


def _last_run(raw: Any) -> LastRun | None:
    if raw is None:
        return None
    try:
        m = raw["M"]
        return LastRun(
            run_id=m["run_id"]["S"],
            score=int(m["score"]["N"]),
            passed=bool(m["passed"]["BOOL"]),
            content_hash=m["content_hash"]["S"],
            finished_at=_when(m["finished_at"]["S"]),
        )
    except (KeyError, TypeError, ValueError):
        raise StoredEvalError("invalid last run") from None


def suite_from_item(item: dict[str, Any]) -> Suite:
    try:
        kind = item["kind"]["S"]
        trigger = item["trigger"]["S"]
        if kind not in ("golden", "regression", "security") or trigger not in (
            "manual",
            "on_submit",
        ):
            raise StoredEvalError("invalid suite kind or trigger")
        pending_expires = _opt(item, "pending_expires_at")
        return Suite(
            suite_id=item["suite_id"]["S"],
            agent_id=item["agent_id"]["S"],
            name=item["name"]["S"],
            description=item["description"]["S"],
            kind=kind,
            required=bool(item["required"]["BOOL"]),
            threshold=_int(item, "threshold"),
            trigger=trigger,
            judge_model=_opt(item, "judge_model"),
            case_count=_int(item, "case_count"),
            cases_sha256=item["cases_sha256"]["S"],
            revision=_int(item, "revision"),
            created_by=item["created_by"]["S"],
            created_by_email=_opt(item, "created_by_email"),
            created_at=_when(item["created_at"]["S"]),
            updated_by=item["updated_by"]["S"],
            updated_at=_when(item["updated_at"]["S"]),
            pending=_opt(item, "pending"),
            pending_expires_at=_when(pending_expires) if pending_expires else None,
            last_run=_last_run(item.get("last_run")),
            running=_opt(item, "running") or None,
            last_attempt=_last_attempt(item.get("last_attempt")),
            recent_scores=_scores(item.get("recent_scores")),
            completed_runs=_int(item, "completed_runs") if "completed_runs" in item else 0,
        )
    except (KeyError, TypeError, ValueError):
        raise StoredEvalError("invalid suite") from None


def _change_item(change: RequirementChange) -> dict[str, Any]:
    item: dict[str, Any] = {
        "PK": _s(PK_CHANGES),
        "SK": _s(change.change_id),
        "change_id": _s(change.change_id),
        "suite_id": _s(change.suite_id),
        "agent_id": _s(change.agent_id),
        "status": _s(change.status),
        "requested_by": _s(change.requested_by),
        "reason": _s(change.reason),
        "created_at": _s(iso(change.created_at)),
        "expires_at": _s(iso(change.expires_at)),
    }
    if change.requested_by_email:
        item["requested_by_email"] = _s(change.requested_by_email)
    return item


def change_from_item(item: dict[str, Any]) -> RequirementChange:
    try:
        status = item["status"]["S"]
        if status not in ("pending", "approved", "rejected", "withdrawn"):
            raise StoredEvalError("invalid change status")
        decided_at = _opt(item, "decided_at")
        return RequirementChange(
            change_id=item["change_id"]["S"],
            suite_id=item["suite_id"]["S"],
            agent_id=item["agent_id"]["S"],
            status=status,
            requested_by=item["requested_by"]["S"],
            requested_by_email=_opt(item, "requested_by_email"),
            reason=item["reason"]["S"],
            created_at=_when(item["created_at"]["S"]),
            expires_at=_when(item["expires_at"]["S"]),
            decided_by=_opt(item, "decided_by"),
            decided_by_email=_opt(item, "decided_by_email"),
            decided_at=_when(decided_at) if decided_at else None,
            note=_opt(item, "note"),
        )
    except (KeyError, TypeError, ValueError):
        raise StoredEvalError("invalid change") from None


def _conditional(exc: ClientError) -> bool:
    code = exc.response.get("Error", {}).get("Code")
    if code == "ConditionalCheckFailedException":
        return True
    if code == "TransactionCanceledException":
        reasons = exc.response.get("CancellationReasons") or []
        return any(r.get("Code") == "ConditionalCheckFailed" for r in reasons)
    return False


class EvalStore:
    def __init__(self, client: DynamoDBClient, table: str) -> None:
        self._db = client
        self._table = table

    @property
    def client(self) -> DynamoDBClient:
        return self._db

    @property
    def table(self) -> str:
        return self._table

    # --- Reads ---------------------------------------------------------------------------

    def suites(self, agent_id: str | None = None) -> list[Suite]:
        """Every suite of the installation, or of one agent."""
        out: list[Suite] = []
        kwargs: dict[str, Any] = {
            "TableName": self._table,
            "KeyConditionExpression": "PK = :pk"
            + (" AND begins_with(SK, :agent)" if agent_id else ""),
            "ExpressionAttributeValues": {
                ":pk": _s(PK_SUITES),
                **({":agent": _s(f"{agent_id}#")} if agent_id else {}),
            },
            "ConsistentRead": True,
        }
        for _ in range(MAX_PAGES):
            page = self._db.query(**kwargs)
            out.extend(suite_from_item(item) for item in page.get("Items", []))
            last = page.get("LastEvaluatedKey")
            if not last:
                return out
            kwargs["ExclusiveStartKey"] = last
        raise StoredEvalError("too many suites")

    def suite(self, agent_id: str, suite_id: str) -> Suite | None:
        item = self._db.get_item(
            TableName=self._table, Key=_suite_key(agent_id, suite_id), ConsistentRead=True
        ).get("Item")
        return suite_from_item(item) if item else None

    def find_suite(self, suite_id: str) -> Suite | None:
        """The suite with that id, from the cases item that names its agent."""
        item = self._db.get_item(
            TableName=self._table, Key=_cases_key(suite_id), ConsistentRead=True
        ).get("Item")
        agent_id = _opt(item or {}, "agent_id")
        return self.suite(agent_id, suite_id) if agent_id else None

    def cases(self, suite: Suite) -> tuple[EvalCase, ...]:
        item = self._db.get_item(
            TableName=self._table, Key=_cases_key(suite.suite_id), ConsistentRead=True
        ).get("Item")
        if item is None:
            raise StoredEvalError("suite without cases")
        raw = item.get("cases", {}).get("S")
        if not isinstance(raw, str) or cases_hash(raw) != suite.cases_sha256:
            raise StoredEvalError("cases do not match their suite")
        return loads_cases(raw).cases

    def change(self, change_id: str) -> RequirementChange | None:
        item = self._db.get_item(
            TableName=self._table,
            Key={"PK": _s(PK_CHANGES), "SK": _s(change_id)},
            ConsistentRead=True,
        ).get("Item")
        return change_from_item(item) if item else None

    def changes(self) -> list[RequirementChange]:
        out: list[RequirementChange] = []
        kwargs: dict[str, Any] = {
            "TableName": self._table,
            "KeyConditionExpression": "PK = :pk",
            "ExpressionAttributeValues": {":pk": _s(PK_CHANGES)},
        }
        for _ in range(MAX_PAGES):
            page = self._db.query(**kwargs)
            out.extend(change_from_item(item) for item in page.get("Items", []))
            last = page.get("LastEvaluatedKey")
            if not last:
                return out
            kwargs["ExclusiveStartKey"] = last
        raise StoredEvalError("too many changes")

    # --- Writes --------------------------------------------------------------------------

    def _cases_put(self, suite: Suite, canonical: str) -> dict[str, Any]:
        return {
            "Put": {
                "TableName": self._table,
                "Item": {
                    **_cases_key(suite.suite_id),
                    "agent_id": _s(suite.agent_id),
                    "cases": _s(canonical),
                },
            }
        }

    def create(self, suite: Suite, canonical: str) -> None:
        cases_put: dict[str, Any] = self._cases_put(suite, canonical)["Put"]
        items: list[Any] = [
            {
                "Put": {
                    "TableName": self._table,
                    "Item": _suite_item(suite),
                    "ConditionExpression": "attribute_not_exists(PK)",
                }
            },
            {"Put": {**cases_put, "ConditionExpression": "attribute_not_exists(PK)"}},
        ]
        try:
            self._db.transact_write_items(TransactItems=items)
        except ClientError as exc:
            if _conditional(exc):
                raise ConflictError from None
            raise

    def update(self, base: Suite, updated: Suite, canonical: str | None = None) -> Suite:
        """Write ``updated`` over ``base`` if nobody changed it since (``revision``). The open
        request is kept as stored: only the request routes change it."""
        new = replace(
            updated,
            revision=base.revision + 1,
            pending=base.pending,
            pending_expires_at=base.pending_expires_at,
        )
        put: dict[str, Any] = {
            "Put": {
                "TableName": self._table,
                "Item": _suite_item(new),
                "ConditionExpression": "#rev = :rev",
                "ExpressionAttributeNames": {"#rev": "revision"},
                "ExpressionAttributeValues": {":rev": _n(base.revision)},
            }
        }
        items: list[Any] = [put]
        if canonical is not None:
            items.append(self._cases_put(new, canonical))
        try:
            self._db.transact_write_items(TransactItems=items)
        except ClientError as exc:
            if _conditional(exc):
                raise ConflictError from None
            raise
        return new

    def delete(self, suite: Suite) -> None:
        try:
            self._db.transact_write_items(
                TransactItems=[
                    {
                        "Delete": {
                            "TableName": self._table,
                            "Key": _suite_key(suite.agent_id, suite.suite_id),
                            "ConditionExpression": "#rev = :rev AND #req = :false",
                            "ExpressionAttributeNames": {"#rev": "revision", "#req": "required"},
                            "ExpressionAttributeValues": {
                                ":rev": _n(suite.revision),
                                ":false": {"BOOL": False},
                            },
                        }
                    },
                    {"Delete": {"TableName": self._table, "Key": _cases_key(suite.suite_id)}},
                ]
            )
        except ClientError as exc:
            if _conditional(exc):
                raise ConflictError from None
            raise

    def request_removal(self, suite: Suite, change: RequirementChange, now: datetime) -> None:
        """Open the request and lock the suite to it, if no other request is open."""
        try:
            self._db.transact_write_items(
                TransactItems=[
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": _suite_key(suite.agent_id, suite.suite_id),
                            "UpdateExpression": "SET #p = :id, #pe = :exp",
                            "ConditionExpression": (
                                "#rev = :rev AND #req = :true AND "
                                "(attribute_not_exists(#p) OR #pe <= :now)"
                            ),
                            "ExpressionAttributeNames": {
                                "#p": "pending",
                                "#pe": "pending_expires_at",
                                "#rev": "revision",
                                "#req": "required",
                            },
                            "ExpressionAttributeValues": {
                                ":id": _s(change.change_id),
                                ":exp": _s(iso(change.expires_at)),
                                ":rev": _n(suite.revision),
                                ":true": {"BOOL": True},
                                ":now": _s(iso(now)),
                            },
                        }
                    },
                    {
                        "Put": {
                            "TableName": self._table,
                            "Item": _change_item(change),
                            "ConditionExpression": "attribute_not_exists(PK)",
                        }
                    },
                ]
            )
        except ClientError as exc:
            if _conditional(exc):
                raise ConflictError from None
            raise

    def close(
        self,
        change: RequirementChange,
        *,
        to: Literal["approved", "rejected", "withdrawn"],
        actor: str,
        actor_email: str | None,
        note: str | None,
        now: datetime,
    ) -> None:
        """Close an open request. ``approved`` also stops requiring the suite; the table refuses
        it when the approver is whoever asked (TM-EV4)."""
        names: dict[str, str] = {
            "#st": "status",
            "#by": "decided_by",
            "#at": "decided_at",
            "#ttl": "ttl",
        }
        values: dict[str, Any] = {
            ":to": _s(to),
            ":pending": _s("pending"),
            ":actor": _s(actor),
            ":now": _s(iso(now)),
            ":ttl": _n(int((now + CHANGE_RETENTION).timestamp())),
        }
        sets = ["#st = :to", "#by = :actor", "#at = :now", "#ttl = :ttl"]
        if actor_email:
            names["#bye"] = "decided_by_email"
            values[":bye"] = _s(actor_email)
            sets.append("#bye = :bye")
        if note:
            names["#note"] = "note"
            values[":note"] = _s(note)
            sets.append("#note = :note")
        condition = "#st = :pending"
        if to == "approved":
            names["#rq"] = "requested_by"
            names["#exp"] = "expires_at"
            condition += " AND #rq <> :actor AND #exp > :now"
        elif to == "withdrawn":
            names["#rq"] = "requested_by"
            condition += " AND #rq = :actor"
        suite_update: Any = {
            "TableName": self._table,
            "Key": _suite_key(change.agent_id, change.suite_id),
            "UpdateExpression": "REMOVE #p, #pe ADD #rev :one"
            + (" SET #req = :false" if to == "approved" else ""),
            "ConditionExpression": "#p = :id",
            "ExpressionAttributeNames": {
                "#p": "pending",
                "#pe": "pending_expires_at",
                "#rev": "revision",
                **({"#req": "required"} if to == "approved" else {}),
            },
            "ExpressionAttributeValues": {
                ":id": _s(change.change_id),
                ":one": _n(1),
                **({":false": {"BOOL": False}} if to == "approved" else {}),
            },
        }
        try:
            self._db.transact_write_items(
                TransactItems=[
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": {"PK": _s(PK_CHANGES), "SK": _s(change.change_id)},
                            "UpdateExpression": "SET " + ", ".join(sets),
                            "ConditionExpression": condition,
                            "ExpressionAttributeNames": names,
                            "ExpressionAttributeValues": values,
                        }
                    },
                    {"Update": suite_update},
                ]
            )
        except ClientError as exc:
            if _conditional(exc):
                raise ConflictError from None
            raise


# --- Runs (E2) ------------------------------------------------------------------------------

RunStatus = Literal["queued", "running", "judging", "passed", "failed", "stopped", "error"]
CaseStatus = Literal["pass", "fail", "judge", "skipped"]
FINISHED: frozenset[str] = frozenset({"passed", "failed", "stopped", "error"})
MAX_RECENT_SCORES = 6
"""What the trend of a suite shows (design: «Últimas 6 ejecuciones»)."""
MAX_RUNS_LISTED = 20


def new_run_id(now: datetime) -> str:
    """32 hex characters: the start time first (8), so runs sort by time under ``RUN#``, then 96
    random bits: still never guessable nor incremental."""
    return f"{int(now.timestamp()):08x}"[-8:] + secrets.token_hex(12)


@dataclass(frozen=True)
class CaseResult:
    status: CaseStatus
    reason: str | None = None
    """A fixed code (``missing_text``, ``tool_not_used``, ``disclosed``, ``judge_low``,
    ``no_answer``, ``budget``, ``judge_failed``, ``no_trace``); never content."""
    session_id: str | None = None
    """Only while a judge case waits for its traces; its runtime session (an opaque digest)."""
    started_at: int | None = None


@dataclass(frozen=True)
class Run:
    run_id: str
    suite_id: str
    agent_id: str
    version: int
    content_hash: str
    launched_by: str
    launched_by_email: str | None
    trigger: Literal["manual", "on_submit"]
    status: RunStatus
    case_count: int
    threshold: int
    judge_model: str | None
    started_at: datetime
    finished_at: datetime | None = None
    results: tuple[CaseResult | None, ...] = ()
    score: int | None = None
    stop_reason: str | None = None


def cases_done(results: tuple[CaseResult | None, ...]) -> int:
    """Cases of a run that ran: a case skipped for budget never reached the agent."""
    return sum(1 for r in results if r is not None and r.status != "skipped")


def _run_key(suite_id: str, run_id: str) -> dict[str, Any]:
    return {"PK": _s(f"SUITE#{suite_id}"), "SK": _s(f"RUN#{run_id}")}


def _result_item(result: CaseResult) -> dict[str, Any]:
    out: dict[str, Any] = {"status": _s(result.status)}
    if result.reason:
        out["reason"] = _s(result.reason)
    if result.session_id:
        out["session_id"] = _s(result.session_id)
    if result.started_at is not None:
        out["started_at"] = _n(result.started_at)
    return {"M": out}


def _result_from(raw: Any) -> CaseResult:
    try:
        m = raw["M"]
        status = m["status"]["S"]
        if status not in ("pass", "fail", "judge", "skipped"):
            raise StoredEvalError("invalid case result")
        started = m.get("started_at", {}).get("N")
        return CaseResult(
            status=status,
            reason=_opt(m, "reason"),
            session_id=_opt(m, "session_id"),
            started_at=int(started) if started is not None else None,
        )
    except (KeyError, TypeError, ValueError):
        raise StoredEvalError("invalid case result") from None


def run_from_item(item: dict[str, Any]) -> Run:
    try:
        count = _int(item, "case_count")
        results_map = item.get("results", {}).get("M", {})
        results = tuple(
            _result_from(results_map[f"c{i}"]) if f"c{i}" in results_map else None
            for i in range(count)
        )
        finished = _opt(item, "finished_at")
        score = item.get("score", {}).get("N")
        trigger = item["trigger"]["S"]
        status = item["status"]["S"]
        if trigger not in ("manual", "on_submit") or status not in (
            "queued",
            "running",
            "judging",
            "passed",
            "failed",
            "stopped",
            "error",
        ):
            raise StoredEvalError("invalid run")
        return Run(
            run_id=item["run_id"]["S"],
            suite_id=item["suite_id"]["S"],
            agent_id=item["agent_id"]["S"],
            version=_int(item, "version"),
            content_hash=item["content_hash"]["S"],
            launched_by=item["launched_by"]["S"],
            launched_by_email=_opt(item, "launched_by_email"),
            trigger=trigger,
            status=status,
            case_count=count,
            threshold=_int(item, "threshold"),
            judge_model=_opt(item, "judge_model"),
            started_at=_when(item["started_at"]["S"]),
            finished_at=_when(finished) if finished else None,
            results=results,
            score=int(score) if score is not None else None,
            stop_reason=_opt(item, "stop_reason"),
        )
    except (KeyError, TypeError, ValueError):
        raise StoredEvalError("invalid run") from None


class EvalRuns:
    """The runs of a suite and the lock that keeps one at a time per suite (TM-EV6)."""

    def __init__(self, client: DynamoDBClient, table: str) -> None:
        self._db = client
        self._table = table

    def start(self, suite: Suite, run: Run) -> None:
        """Write the run and take the suite's lock, if no other run holds it."""
        ttl = int((run.started_at + RUN_RETENTION).timestamp())
        item: dict[str, Any] = {
            **_run_key(run.suite_id, run.run_id),
            "run_id": _s(run.run_id),
            "suite_id": _s(run.suite_id),
            "agent_id": _s(run.agent_id),
            "version": _n(run.version),
            "content_hash": _s(run.content_hash),
            "launched_by": _s(run.launched_by),
            "trigger": _s(run.trigger),
            "status": _s(run.status),
            "case_count": _n(run.case_count),
            "threshold": _n(run.threshold),
            "started_at": _s(iso(run.started_at)),
            "results": {"M": {}},
            "ttl": _n(ttl),
        }
        if run.launched_by_email:
            item["launched_by_email"] = _s(run.launched_by_email)
        if run.judge_model:
            item["judge_model"] = _s(run.judge_model)
        try:
            self._db.transact_write_items(
                TransactItems=[
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": _suite_key(suite.agent_id, suite.suite_id),
                            # The revision moves: an edit that read the suite before conflicts.
                            "UpdateExpression": "SET #running = :run ADD #rev :one",
                            "ConditionExpression": (
                                "#rev = :rev AND "
                                "(attribute_not_exists(#running) OR #running = :none)"
                            ),
                            "ExpressionAttributeNames": {"#running": "running", "#rev": "revision"},
                            "ExpressionAttributeValues": {
                                ":run": _s(run.run_id),
                                ":rev": _n(suite.revision),
                                ":none": _s(""),
                                ":one": _n(1),
                            },
                        }
                    },
                    {
                        "Put": {
                            "TableName": self._table,
                            "Item": item,
                            "ConditionExpression": "attribute_not_exists(PK)",
                        }
                    },
                ]
            )
        except ClientError as exc:
            if _conditional(exc):
                raise ConflictError from None
            raise

    def get(self, suite_id: str, run_id: str) -> Run | None:
        item = self._db.get_item(
            TableName=self._table, Key=_run_key(suite_id, run_id), ConsistentRead=True
        ).get("Item")
        return run_from_item(item) if item else None

    def recent(self, suite_id: str, limit: int = MAX_RUNS_LISTED) -> list[Run]:
        page = self._db.query(
            TableName=self._table,
            KeyConditionExpression="PK = :pk AND begins_with(SK, :run)",
            ExpressionAttributeValues={":pk": _s(f"SUITE#{suite_id}"), ":run": _s("RUN#")},
            ScanIndexForward=False,
            Limit=limit,
        )
        return [run_from_item(item) for item in page.get("Items", [])]

    def record(self, run: Run, index: int, result: CaseResult, status: RunStatus) -> None:
        """The result of one case, while the run is not finished."""
        self._db.update_item(
            TableName=self._table,
            Key=_run_key(run.suite_id, run.run_id),
            UpdateExpression="SET #results.#case = :result, #status = :status",
            ConditionExpression="NOT #status IN (:passed, :failed, :stopped, :error)",
            ExpressionAttributeNames={
                "#results": "results",
                "#case": f"c{index}",
                "#status": "status",
            },
            ExpressionAttributeValues={
                ":result": _result_item(result),
                ":status": _s(status),
                ":passed": _s("passed"),
                ":failed": _s("failed"),
                ":stopped": _s("stopped"),
                ":error": _s("error"),
            },
        )

    def finish(
        self,
        suite: Suite,
        run: Run,
        *,
        status: Literal["passed", "failed", "stopped", "error"],
        score: int | None,
        now: datetime,
        stop_reason: str | None = None,
    ) -> None:
        """Close the run, release the suite's lock and, for a run that scored, make it the
        suite's last run (what the gate of D26 reads). Once only."""
        names: dict[str, str] = {"#status": "status", "#finished": "finished_at"}
        values: dict[str, Any] = {
            ":status": _s(status),
            ":now": _s(iso(now)),
            ":passed": _s("passed"),
            ":failed": _s("failed"),
            ":stopped": _s("stopped"),
            ":error": _s("error"),
        }
        sets = ["#status = :status", "#finished = :now"]
        if score is not None:
            names["#score"] = "score"
            values[":score"] = _n(score)
            sets.append("#score = :score")
        if stop_reason:
            names["#stop"] = "stop_reason"
            values[":stop"] = _s(stop_reason)
            sets.append("#stop = :stop")
        attempt = LastAttempt(
            run_id=run.run_id,
            status=status,
            stop_reason=stop_reason or None,
            cases_done=cases_done(run.results),
            case_count=run.case_count,
            finished_at=now,
        )
        suite_update: Any = {
            "TableName": self._table,
            "Key": _suite_key(suite.agent_id, suite.suite_id),
            "UpdateExpression": "REMOVE #running SET #attempt = :attempt ADD #rev :one",
            "ConditionExpression": "#running = :run",
            "ExpressionAttributeNames": {
                "#running": "running",
                "#rev": "revision",
                "#attempt": "last_attempt",
            },
            "ExpressionAttributeValues": {
                ":run": _s(run.run_id),
                ":one": _n(1),
                ":attempt": _attempt_item(attempt),
            },
        }
        if status in ("passed", "failed") and score is not None:
            # The trend keeps the last scores, written with the run that scored: the condition
            # on ``running`` makes it once per run.
            scores = (*suite.recent_scores, score)[-MAX_RECENT_SCORES:]
            suite_update["UpdateExpression"] = (
                "REMOVE #running SET #last = :last, #attempt = :attempt, #scores = :scores "
                "ADD #rev :one, #completed :one"
            )
            suite_update["ExpressionAttributeNames"]["#scores"] = "recent_scores"
            suite_update["ExpressionAttributeNames"]["#completed"] = "completed_runs"
            suite_update["ExpressionAttributeValues"][":scores"] = {
                "L": [_n(value) for value in scores]
            }
            suite_update["ExpressionAttributeNames"]["#last"] = "last_run"
            suite_update["ExpressionAttributeValues"][":last"] = {
                "M": {
                    "run_id": _s(run.run_id),
                    "score": _n(score),
                    "passed": {"BOOL": status == "passed"},
                    "content_hash": _s(run.content_hash),
                    "finished_at": _s(iso(now)),
                }
            }
        try:
            self._db.transact_write_items(
                TransactItems=[
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": _run_key(run.suite_id, run.run_id),
                            "UpdateExpression": "SET " + ", ".join(sets),
                            "ConditionExpression": (
                                "NOT #status IN (:passed, :failed, :stopped, :error)"
                            ),
                            "ExpressionAttributeNames": names,
                            "ExpressionAttributeValues": values,
                        }
                    },
                    {"Update": suite_update},
                ]
            )
        except ClientError as exc:
            if _conditional(exc):
                raise ConflictError from None
            raise
