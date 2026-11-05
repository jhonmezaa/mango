"""Operación > Evals: suites of cases that score a version of an agent (D110, D111; threat model
``evals-threat-model.md``).

A suite belongs to one agent. Whoever edits the agent creates it, edits its cases (by hand or
from a CSV) and its settings, and may make it required: a required suite that does not pass
blocks the approval of a version of its agent (D26, in ``agents.py``). Stopping requiring it is
a request that another administrator approves (two people). Administrators, ``finops-central``
and whoever edits the agent see its suites (D111 (1)).

Security notes (security-best-practices, FastAPI):
* Every route declares its Cedar action on the agent of the suite (``ViewEvals``,
  ``EditEvals``, ``ApproveEvalRequirement``), with the creator read from the Agents table, never
  from the request; the role is re-checked in process (AUTHZ-001). Lists are filtered in the
  server with the same action, per agent.
* Cases are content (D26): never in the audit nor in the logs; the audit gets counts and the
  SHA-256 of the canonical cases. Secrets in a case are refused (422 with the case numbers,
  never what was found).
* Whoever asks to stop requiring a suite never decides it; the table repeats the check.
* Bodies forbid extra fields; responses use explicit models (VALID-001, RESP-001). Writes and
  reads are rate limited per person.
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal, NoReturn

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Path, Query
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from mango_api.agent_rules import find_secrets
from mango_api.agents_store import AgentMeta, AgentsStore
from mango_api.audit import AuditLog
from mango_api.authz import AGENT_TYPE, AgentResource, Authorizer
from mango_api.evals_store import (
    ConflictError,
    EvalStore,
    RequirementChange,
    StoredEvalError,
    Suite,
    SuiteKind,
    Trigger,
    cases_hash,
    dumps_cases,
    new_id,
)
from mango_api.model_catalog import ModelCatalog, ModelCatalogUnavailableError
from mango_api.rate_limits import Limiter
from mango_api.web import ApiError, Caller, rate_limited
from mango_core.agents import AGENT_ID_PATTERN, MODEL_ID_PATTERN, AgentStatus
from mango_core.evals import (
    MAX_CASES,
    MAX_CSV_BYTES,
    CsvError,
    EvalCase,
    EvalCases,
    normalize,
    parse_csv,
)

logger = logging.getLogger(__name__)

WRITES_PER_HOUR = 60
READS_PER_MINUTE = 60
MAX_SUITES_PER_AGENT = 20
MAX_SUITES = 500
MAX_NAME_CHARS = 80
MAX_DESCRIPTION_CHARS = 500
MAX_REASON_CHARS = 500
MIN_THRESHOLD = 50
SECURITY_THRESHOLD = 100
REQUEST_LIFETIME = timedelta(days=7)
SUITE_ID_PATTERN = r"^[0-9a-f]{32}$"
CHANGE_ID_PATTERN = r"^[0-9a-f]{32}$"


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EmptyIn(_Strict):
    pass


Name = Annotated[str, Field(min_length=1, max_length=MAX_NAME_CHARS)]
Description = Annotated[str, Field(max_length=MAX_DESCRIPTION_CHARS)]
Threshold = Annotated[int, Field(ge=MIN_THRESHOLD, le=100)]
JudgeModel = Annotated[str, Field(pattern=MODEL_ID_PATTERN)]


class NewSuiteIn(_Strict):
    agent_id: Annotated[str, Field(pattern=AGENT_ID_PATTERN)]
    name: Name
    description: Description = ""
    kind: SuiteKind
    """Golden set, regression or security (D110). «Revisión humana» has no screen in the design
    to grade on: not available."""
    required: bool = False
    threshold: Threshold = 80
    trigger: Trigger = "manual"
    """Manual or on every submission for review. Daily or weekly runs are not built yet."""
    judge_model: JudgeModel | None = None
    cases: Annotated[list[EvalCase], Field(min_length=1, max_length=MAX_CASES)]


class SuiteSettingsIn(_Strict):
    """What changes without touching the cases. Absent: as stored. ``required`` may only be
    turned on here: turning it off is a request (two people)."""

    revision: Annotated[int, Field(ge=1)]
    name: Name | None = None
    description: Description | None = None
    required: Literal[True] | None = None
    threshold: Threshold | None = None
    trigger: Trigger | None = None
    judge_model: JudgeModel | None = None


class CasesIn(_Strict):
    revision: Annotated[int, Field(ge=1)]
    cases: Annotated[list[EvalCase], Field(min_length=1, max_length=MAX_CASES)]


class CsvIn(_Strict):
    revision: Annotated[int, Field(ge=1)]
    csv: Annotated[str, Field(min_length=1, max_length=MAX_CSV_BYTES)]


class RevisionIn(_Strict):
    revision: Annotated[int, Field(ge=1)]


class RemovalIn(_Strict):
    revision: Annotated[int, Field(ge=1)]
    reason: Annotated[str, Field(min_length=1, max_length=MAX_REASON_CHARS)]


class RejectIn(_Strict):
    reason: Annotated[str, Field(min_length=1, max_length=MAX_REASON_CHARS)]


class LastRunOut(_Strict):
    run_id: str
    score: int
    passed: bool
    content_hash: str
    finished_at: str


class RequestOut(_Strict):
    change_id: str
    requested_by_email: str | None
    mine: bool
    """Whoever asked only withdraws; another administrator approves or rejects."""
    reason: str
    created_at: str
    expires_at: str


class SuiteOut(_Strict):
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
    revision: int
    created_by_email: str | None
    updated_at: str
    request: RequestOut | None
    last_run: LastRunOut | None
    can_edit: bool


class SuitesOut(_Strict):
    suites: list[SuiteOut]


class CaseOut(_Strict):
    question: str
    expected: str
    criterion: Literal["contains", "uses_tool", "no_disclosure", "judge"]
    value: str


class SuiteDetailOut(SuiteOut):
    cases: list[CaseOut]


# --- Use cases --------------------------------------------------------------------------


@dataclass
class EvalsDeps:
    store: EvalStore
    agents: AgentsStore
    authorizer: Authorizer
    catalog: Callable[[], ModelCatalog]
    audit: AuditLog
    writes: Limiter
    reads: Limiter
    clock: Callable[[], datetime]


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def _unavailable(exc: Exception) -> ApiError:
    logger.error("evals storage unavailable: %s", type(exc).__name__)
    return ApiError(503, "evals_unavailable", "please try again")


def _resource(agent_id: str, meta: AgentMeta | None) -> AgentResource:
    return AgentResource(agent_id, creator=meta.created_by if meta else None)


def _owner(caller: Caller, meta: AgentMeta | None) -> bool:
    user = caller.user
    return meta is not None and user.is_agent_creator and meta.created_by == user.user_id


def _may(caller: Caller, action: str, meta: AgentMeta | None) -> bool:
    """The role behind each action, re-checked in process (the policies already say so)."""
    user = caller.user
    if action == "ViewEvals":
        return user.is_admin or user.is_central or _owner(caller, meta)
    if action == "EditEvals":
        return user.is_admin or _owner(caller, meta)
    return user.is_admin


def _request_out(
    suite: Suite, changes: dict[str, RequirementChange], caller: Caller, now: datetime
) -> RequestOut | None:
    if not suite.locked(now) or suite.pending is None:
        return None
    change = changes.get(suite.pending)
    if change is None or change.status != "pending":
        return None
    return RequestOut(
        change_id=change.change_id,
        requested_by_email=change.requested_by_email,
        mine=change.requested_by == caller.user.user_id,
        reason=change.reason,
        created_at=_iso(change.created_at),
        expires_at=_iso(change.expires_at),
    )


def _suite_out(
    suite: Suite,
    caller: Caller,
    *,
    can_edit: bool,
    changes: dict[str, RequirementChange],
    now: datetime,
) -> SuiteOut:
    run = suite.last_run
    return SuiteOut(
        suite_id=suite.suite_id,
        agent_id=suite.agent_id,
        name=suite.name,
        description=suite.description,
        kind=suite.kind,
        required=suite.required,
        threshold=suite.threshold,
        trigger=suite.trigger,
        judge_model=suite.judge_model,
        case_count=suite.case_count,
        revision=suite.revision,
        created_by_email=suite.created_by_email,
        updated_at=_iso(suite.updated_at),
        request=_request_out(suite, changes, caller, now),
        last_run=LastRunOut(
            run_id=run.run_id,
            score=run.score,
            passed=run.passed,
            content_hash=run.content_hash,
            finished_at=_iso(run.finished_at),
        )
        if run
        else None,
        can_edit=can_edit,
    )


def _open_changes(deps: EvalsDeps) -> dict[str, RequirementChange]:
    return {c.change_id: c for c in deps.store.changes() if c.status == "pending"}


def list_suites(deps: EvalsDeps, caller: Caller, agent_id: str | None) -> SuitesOut:
    suites = deps.store.suites(agent_id)
    metas = deps.agents.metas(sorted({s.agent_id for s in suites}))
    resources = [_resource(a, metas.get(a)) for a in sorted({s.agent_id for s in suites})]
    user = caller.user
    visible = deps.authorizer.allowed_agents(user, "ViewEvals", resources)
    editable = deps.authorizer.allowed_agents(user, "EditEvals", resources)
    now = deps.clock()
    changes = _open_changes(deps) if suites else {}
    out = [
        _suite_out(
            s,
            caller,
            can_edit=s.agent_id in editable and _may(caller, "EditEvals", metas.get(s.agent_id)),
            changes=changes,
            now=now,
        )
        for s in suites
        if s.agent_id in visible and _may(caller, "ViewEvals", metas.get(s.agent_id))
    ]
    out.sort(key=lambda s: (s.agent_id, s.name.casefold(), s.suite_id))
    return SuitesOut(suites=out)


def _check_cases(cases: list[EvalCase] | tuple[EvalCase, ...]) -> None:
    """Secrets never go to the model nor stay in the table (D26, AGENTS.md)."""
    bad = [
        number
        for number, case in enumerate(cases, start=1)
        if any(find_secrets(text) for text in (case.question, case.expected, case.value))
    ]
    if bad:
        raise ApiError(
            422, "secret_in_case", "a case looks like it contains a secret", extra={"cases": bad}
        )


def _normalized(cases: list[EvalCase] | tuple[EvalCase, ...]) -> EvalCases:
    try:
        return EvalCases(
            cases=tuple(
                EvalCase(
                    question=normalize(c.question),
                    expected=normalize(c.expected),
                    criterion=c.criterion,
                    value=normalize(c.value),
                )
                for c in cases
            )
        )
    except ValidationError as exc:
        raise ApiError(
            422, "invalid_request", "invalid fields: cases", extra={"fields": ["cases"]}
        ) from exc


def _check_suite(
    deps: EvalsDeps,
    kind: SuiteKind,
    threshold: int,
    judge_model: str | None,
    cases: EvalCases,
) -> int:
    """The rules a suite keeps whatever changes; returns the threshold it gets."""
    judged = any(c.criterion == "judge" for c in cases.cases)
    if kind == "security":
        # Decided in code only: the judge never decides a security suite (TM-EV2).
        if judged:
            raise ApiError(422, "judge_not_allowed", "a security suite is decided without a judge")
        threshold = SECURITY_THRESHOLD
    if judged and not judge_model:
        raise ApiError(422, "judge_model_required", "choose the model that judges")
    if judge_model:
        try:
            entry = deps.catalog().get(judge_model)
        except ModelCatalogUnavailableError as exc:
            raise ApiError(503, "evals_unavailable", "please try again") from exc
        if entry is None or not entry.enabled:
            raise ApiError(409, "model_unavailable", "this model is not enabled")
    return threshold


def _texts(name: str, description: str) -> tuple[str, str]:
    name, description = normalize(name), normalize(description)
    if not name:
        raise ApiError(422, "invalid_request", "invalid fields: name", extra={"fields": ["name"]})
    if find_secrets(name) or find_secrets(description):
        raise ApiError(422, "secret_in_suite", "the suite looks like it contains a secret")
    return name, description


def _refuse(
    deps: EvalsDeps, event: str, caller: Caller, detail: dict[str, Any], err: ApiError
) -> NoReturn:
    """A refused decision is audited too; the refusal stands even if audit fails."""
    try:
        deps.audit.emit(
            event,
            caller.user.user_id,
            {**detail, "outcome": "rejected", "error": err.code},
            caller.user,
        )
    except Exception:
        logger.exception("audit emit failed for a refused eval decision")
    raise err


def _audited[T](
    deps: EvalsDeps, event: str, caller: Caller, detail: dict[str, Any], write: Callable[[], T]
) -> T:
    """Fail-closed audit: ``requested`` before writing, then ``applied`` or ``rejected``."""
    actor, user = caller.user.user_id, caller.user
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "requested"}, user)
    except Exception as exc:
        raise ApiError(503, "audit_unavailable", "the change could not be audited; retry") from exc
    try:
        result = write()
    except Exception as exc:
        code = exc.code if isinstance(exc, ApiError) else "error"
        try:
            deps.audit.emit(event, actor, {**detail, "outcome": "rejected", "error": code}, user)
        except Exception:
            logger.exception("audit emit failed after a rejected eval change")
        raise
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "applied"}, user)
    except Exception:
        logger.exception("audit emit failed after an applied eval change")
    return result


def _detail(suite: Suite) -> dict[str, Any]:
    # Ids, settings and counts only: the cases never go to the audit.
    return {
        "suite": suite.suite_id,
        "agent": suite.agent_id,
        "kind": suite.kind,
        "required": suite.required,
        "threshold": suite.threshold,
        "trigger": suite.trigger,
        "judge_model": suite.judge_model,
        "cases": suite.case_count,
        "cases_sha256": suite.cases_sha256,
    }


def _writable(meta: AgentMeta | None) -> AgentMeta:
    if meta is None:
        raise ApiError(404, "not_found", "not found")
    if meta.status is AgentStatus.RETIRED:
        raise ApiError(409, "agent_retired", "this agent was retired")
    return meta


def create_suite(
    deps: EvalsDeps, caller: Caller, meta: AgentMeta | None, body: NewSuiteIn
) -> SuiteDetailOut:
    _writable(meta)
    name, description = _texts(body.name, body.description)
    cases = _normalized(body.cases)
    _check_cases(cases.cases)
    threshold = _check_suite(deps, body.kind, body.threshold, body.judge_model, cases)
    try:
        existing = deps.store.suites()
    except (ClientError, BotoCoreError, StoredEvalError) as exc:
        raise _unavailable(exc) from exc
    if len(existing) >= MAX_SUITES:
        raise ApiError(409, "too_many_suites", "the installation has too many suites")
    if sum(1 for s in existing if s.agent_id == body.agent_id) >= MAX_SUITES_PER_AGENT:
        raise ApiError(409, "too_many_suites", "this agent has too many suites")
    now = deps.clock()
    canonical = dumps_cases(cases)
    suite = Suite(
        suite_id=new_id(),
        agent_id=body.agent_id,
        name=name,
        description=description,
        kind=body.kind,
        required=body.required,
        threshold=threshold,
        trigger=body.trigger,
        judge_model=body.judge_model,
        case_count=len(cases.cases),
        cases_sha256=cases_hash(canonical),
        revision=1,
        created_by=caller.user.user_id,
        created_by_email=caller.user.email,
        created_at=now,
        updated_by=caller.user.user_id,
        updated_at=now,
    )

    def write() -> None:
        try:
            deps.store.create(suite, canonical)
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "please try again") from exc

    _audited(deps, "evals.suite_created", caller, _detail(suite), write)
    return _detail_out(suite, cases.cases, caller, can_edit=True, now=now)


def _detail_out(
    suite: Suite,
    cases: tuple[EvalCase, ...],
    caller: Caller,
    *,
    can_edit: bool,
    now: datetime,
    changes: dict[str, RequirementChange] | None = None,
) -> SuiteDetailOut:
    base = _suite_out(suite, caller, can_edit=can_edit, changes=changes or {}, now=now)
    return SuiteDetailOut(
        **base.model_dump(),
        cases=[
            CaseOut(question=c.question, expected=c.expected, criterion=c.criterion, value=c.value)
            for c in cases
        ],
    )


def get_suite(deps: EvalsDeps, caller: Caller, suite: Suite, can_edit: bool) -> SuiteDetailOut:
    cases = deps.store.cases(suite)
    changes = _open_changes(deps) if suite.pending else {}
    return _detail_out(suite, cases, caller, can_edit=can_edit, now=deps.clock(), changes=changes)


def _current(suite: Suite, revision: int) -> None:
    if suite.revision != revision:
        raise ApiError(409, "version_conflict", "the suite changed; reload and try again")


def update_settings(
    deps: EvalsDeps, caller: Caller, meta: AgentMeta | None, suite: Suite, body: SuiteSettingsIn
) -> SuiteDetailOut:
    _writable(meta)
    _current(suite, body.revision)
    name, description = _texts(
        body.name if body.name is not None else suite.name,
        body.description if body.description is not None else suite.description,
    )
    cases = EvalCases(cases=deps.store.cases(suite))
    judge_model = body.judge_model if body.judge_model is not None else suite.judge_model
    threshold = _check_suite(
        deps,
        suite.kind,
        body.threshold if body.threshold is not None else suite.threshold,
        judge_model,
        cases,
    )
    now = deps.clock()
    updated = replace(
        suite,
        name=name,
        description=description,
        required=suite.required or bool(body.required),
        threshold=threshold,
        trigger=body.trigger or suite.trigger,
        judge_model=judge_model,
        updated_by=caller.user.user_id,
        updated_at=now,
    )
    detail = {**_detail(updated), "was_required": suite.required}

    def write() -> Suite:
        try:
            return deps.store.update(suite, updated)
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the suite changed; reload") from exc

    saved = _audited(deps, "evals.suite_updated", caller, detail, write)
    return _detail_out(saved, cases.cases, caller, can_edit=True, now=now)


def replace_cases(  # noqa: PLR0917 - the parts of one change, all required
    deps: EvalsDeps,
    caller: Caller,
    meta: AgentMeta | None,
    suite: Suite,
    revision: int,
    raw: list[EvalCase] | tuple[EvalCase, ...],
    source: Literal["manual", "csv"],
) -> SuiteDetailOut:
    _writable(meta)
    _current(suite, revision)
    cases = _normalized(raw)
    _check_cases(cases.cases)
    _check_suite(deps, suite.kind, suite.threshold, suite.judge_model, cases)
    now = deps.clock()
    canonical = dumps_cases(cases)
    updated = replace(
        suite,
        case_count=len(cases.cases),
        cases_sha256=cases_hash(canonical),
        updated_by=caller.user.user_id,
        updated_at=now,
    )
    detail = {**_detail(updated), "source": source, "previous_sha256": suite.cases_sha256}

    def write() -> Suite:
        try:
            return deps.store.update(suite, updated, canonical)
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the suite changed; reload") from exc

    saved = _audited(deps, "evals.cases_replaced", caller, detail, write)
    return _detail_out(saved, cases.cases, caller, can_edit=True, now=now)


def import_csv(
    deps: EvalsDeps, caller: Caller, meta: AgentMeta | None, suite: Suite, body: CsvIn
) -> SuiteDetailOut:
    try:
        cases = parse_csv(body.csv)
    except CsvError as exc:
        extra = {"rows": list(exc.rows)} if exc.rows else None
        raise ApiError(422, exc.code, "the CSV cannot be imported", extra=extra) from None
    return replace_cases(deps, caller, meta, suite, body.revision, cases, "csv")


def delete_suite(
    deps: EvalsDeps, caller: Caller, meta: AgentMeta | None, suite: Suite, revision: int
) -> None:
    _current(suite, revision)
    if suite.required:
        # Stopping requiring it is a request another administrator approves (D26).
        raise ApiError(409, "suite_required", "ask to stop requiring this suite first")

    def write() -> None:
        try:
            deps.store.delete(suite)
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the suite changed; reload") from exc

    _audited(deps, "evals.suite_deleted", caller, _detail(suite), write)


def _change_detail(change: RequirementChange) -> dict[str, Any]:
    return {
        "change_id": change.change_id,
        "suite": change.suite_id,
        "agent": change.agent_id,
        "requested_by": change.requested_by,
    }


def request_removal(
    deps: EvalsDeps, caller: Caller, suite: Suite, body: RemovalIn
) -> SuiteDetailOut:
    _current(suite, body.revision)
    now = deps.clock()
    if not suite.required:
        raise ApiError(409, "suite_not_required", "this suite is not required")
    if suite.locked(now):
        raise ApiError(409, "already_pending", "there is already an open request for this suite")
    reason = normalize(body.reason)
    if not reason or find_secrets(reason):
        raise ApiError(
            422, "invalid_request", "invalid fields: reason", extra={"fields": ["reason"]}
        )
    change = RequirementChange(
        change_id=new_id(),
        suite_id=suite.suite_id,
        agent_id=suite.agent_id,
        status="pending",
        requested_by=caller.user.user_id,
        requested_by_email=caller.user.email,
        reason=reason,
        created_at=now,
        expires_at=now + REQUEST_LIFETIME,
    )

    def write() -> None:
        try:
            deps.store.request_removal(suite, change, now)
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the suite changed; reload") from exc

    _audited(
        deps,
        "evals.requirement_requested",
        caller,
        {**_change_detail(change), "reason": reason},
        write,
    )
    fresh = deps.store.suite(suite.agent_id, suite.suite_id) or suite
    return get_suite(deps, caller, fresh, True)


def _open_change(deps: EvalsDeps, change_id: str) -> RequirementChange:
    try:
        change = deps.store.change(change_id)
    except (ClientError, BotoCoreError, StoredEvalError) as exc:
        raise _unavailable(exc) from exc
    if change is None:
        raise ApiError(404, "not_found", "request not found")
    if change.status != "pending":
        raise ApiError(409, "version_conflict", "the request is already closed")
    return change


def decide(
    deps: EvalsDeps,
    caller: Caller,
    change: RequirementChange,
    to: Literal["approved", "rejected"],
    note: str | None,
) -> None:
    actor = caller.user.user_id
    event = f"evals.requirement_{to}"
    detail = {**_change_detail(change), "decided_by": actor}
    now = deps.clock()
    if to == "approved" and now >= change.expires_at:
        raise ApiError(410, "expired", "the request expired")
    if change.requested_by == actor:
        # Nobody decides what they asked for (TM-EV4): they withdraw it.
        _refuse(
            deps,
            event,
            caller,
            detail,
            ApiError(403, "same_approver", "another administrator must decide this request"),
        )
    if not caller.user.is_admin:
        _refuse(deps, event, caller, detail, ApiError(403, "forbidden", "not allowed"))
    clean = normalize(note) if note else None
    if to == "rejected" and (not clean or find_secrets(clean)):
        raise ApiError(
            422, "invalid_request", "invalid fields: reason", extra={"fields": ["reason"]}
        )

    def write() -> None:
        try:
            deps.store.close(
                change, to=to, actor=actor, actor_email=caller.user.email, note=clean, now=now
            )
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the request changed; reload") from exc

    _audited(deps, event, caller, {**detail, **({"reason": clean} if clean else {})}, write)


def withdraw(deps: EvalsDeps, caller: Caller, change: RequirementChange) -> None:
    actor = caller.user.user_id
    if change.requested_by != actor:
        raise ApiError(403, "not_requester", "only whoever asked can withdraw this request")
    now = deps.clock()

    def write() -> None:
        try:
            deps.store.close(
                change, to="withdrawn", actor=actor, actor_email=None, note=None, now=now
            )
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the request changed; reload") from exc

    _audited(deps, "evals.requirement_withdrawn", caller, _change_detail(change), write)


# --- Router -----------------------------------------------------------------------------


Authorize = Callable[..., Awaitable[None]]


@dataclass(frozen=True)
class SuiteCaller:
    caller: Caller
    suite: Suite
    meta: AgentMeta | None


def evals_router(  # noqa: PLR0915 - one route per statement group
    deps: EvalsDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    router = APIRouter(prefix="/api/evals")
    CallerDep = Annotated[Caller, Depends(current_user)]  # noqa: N806
    SuiteId = Annotated[str, Path(pattern=SUITE_ID_PATTERN)]  # noqa: N806
    ChangeId = Annotated[str, Path(pattern=CHANGE_ID_PATTERN)]  # noqa: N806

    async def run[T](fn: Callable[..., T], *args: Any) -> T:
        try:
            return await asyncio.to_thread(fn, *args)
        except (ClientError, BotoCoreError, StoredEvalError) as exc:
            raise _unavailable(exc) from exc

    async def limit(limiter: Limiter, caller: Caller) -> None:
        actor = caller.user.user_id
        if not await asyncio.to_thread(limiter.allow, actor):
            raise rate_limited(await asyncio.to_thread(limiter.retry_after, actor))

    async def on_agent(
        caller: Caller, action: str, agent_id: str, *, read_only: bool = False
    ) -> AgentMeta | None:
        """``action`` on the agent, its creator read from the Agents table (deny by default).
        An agent that does not exist is denied like any other."""
        meta = await run(deps.agents.meta, agent_id)
        await authorize(
            caller,
            action,
            AGENT_TYPE,
            agent_id,
            read_only=read_only,
            agent=_resource(agent_id, meta),
        )
        if not _may(caller, action, meta):
            raise ApiError(403, "forbidden", "not allowed")
        return meta

    def suite_action(
        action: str, *, read_only: bool = False
    ) -> Callable[..., Awaitable[SuiteCaller]]:
        async def dependency(suite_id: SuiteId, caller: CallerDep) -> SuiteCaller:
            await limit(deps.reads if read_only else deps.writes, caller)
            suite = await run(deps.store.find_suite, suite_id)
            if suite is None:
                raise ApiError(404, "not_found", "not found")
            meta = await on_agent(caller, action, suite.agent_id, read_only=read_only)
            return SuiteCaller(caller, suite, meta)

        return dependency

    View = Annotated[SuiteCaller, Depends(suite_action("ViewEvals", read_only=True))]  # noqa: N806
    Edit = Annotated[SuiteCaller, Depends(suite_action("EditEvals"))]  # noqa: N806

    async def can_edit(caller: Caller, suite: Suite, meta: AgentMeta | None) -> bool:
        allowed = await asyncio.to_thread(
            deps.authorizer.is_allowed,
            caller.user,
            "EditEvals",
            AGENT_TYPE,
            suite.agent_id,
            _resource(suite.agent_id, meta),
        )
        return allowed and _may(caller, "EditEvals", meta)

    @router.get("", response_model=SuitesOut)
    async def get_evals(
        caller: CallerDep,
        agent_id: Annotated[str | None, Query(pattern=AGENT_ID_PATTERN)] = None,
    ) -> SuitesOut:
        await limit(deps.reads, caller)
        return await run(list_suites, deps, caller, agent_id)

    @router.post("/suites", response_model=SuiteDetailOut, status_code=201)
    async def post_eval_suite(body: NewSuiteIn, caller: CallerDep) -> SuiteDetailOut:
        await limit(deps.writes, caller)
        meta = await on_agent(caller, "EditEvals", body.agent_id)
        return await run(create_suite, deps, caller, meta, body)

    @router.get("/suites/{suite_id}", response_model=SuiteDetailOut)
    async def get_eval_suite(target: View) -> SuiteDetailOut:
        editable = await can_edit(target.caller, target.suite, target.meta)
        return await run(get_suite, deps, target.caller, target.suite, editable)

    @router.patch("/suites/{suite_id}", response_model=SuiteDetailOut)
    async def patch_eval_suite(body: SuiteSettingsIn, target: Edit) -> SuiteDetailOut:
        return await run(update_settings, deps, target.caller, target.meta, target.suite, body)

    @router.put("/suites/{suite_id}/cases", response_model=SuiteDetailOut)
    async def put_eval_cases(body: CasesIn, target: Edit) -> SuiteDetailOut:
        return await run(
            replace_cases,
            deps,
            target.caller,
            target.meta,
            target.suite,
            body.revision,
            body.cases,
            "manual",
        )

    @router.post("/suites/{suite_id}/cases/csv", response_model=SuiteDetailOut)
    async def post_eval_cases_csv(body: CsvIn, target: Edit) -> SuiteDetailOut:
        return await run(import_csv, deps, target.caller, target.meta, target.suite, body)

    @router.post("/suites/{suite_id}/delete", status_code=204)
    async def delete_eval_suite(body: RevisionIn, target: Edit) -> None:
        await run(delete_suite, deps, target.caller, target.meta, target.suite, body.revision)

    @router.post("/suites/{suite_id}/requirement-removal", response_model=SuiteDetailOut)
    async def post_eval_requirement_removal(body: RemovalIn, target: Edit) -> SuiteDetailOut:
        return await run(request_removal, deps, target.caller, target.suite, body)

    async def change_target(change_id: str, caller: Caller, action: str) -> RequirementChange:
        await limit(deps.writes, caller)
        change = await asyncio.to_thread(_open_change, deps, change_id)
        await on_agent(caller, action, change.agent_id)
        return change

    @router.post("/requirement-changes/{change_id}/approve", status_code=204)
    async def approve_eval_requirement(
        change_id: ChangeId, _body: EmptyIn, caller: CallerDep
    ) -> None:
        change = await change_target(change_id, caller, "ApproveEvalRequirement")
        await run(decide, deps, caller, change, "approved", None)

    @router.post("/requirement-changes/{change_id}/reject", status_code=204)
    async def reject_eval_requirement(
        change_id: ChangeId, body: RejectIn, caller: CallerDep
    ) -> None:
        change = await change_target(change_id, caller, "ApproveEvalRequirement")
        await run(decide, deps, caller, change, "rejected", body.reason)

    @router.post("/requirement-changes/{change_id}/withdraw", status_code=204)
    async def withdraw_eval_requirement(
        change_id: ChangeId, _body: EmptyIn, caller: CallerDep
    ) -> None:
        change = await change_target(change_id, caller, "ViewEvals")
        await run(withdraw, deps, caller, change)

    return router
