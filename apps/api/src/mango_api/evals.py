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
from decimal import ROUND_CEILING, Decimal
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
    EvalRuns,
    EvalStore,
    RequirementChange,
    Run,
    StoredEvalError,
    Suite,
    SuiteKind,
    Trigger,
    cases_done,
    cases_hash,
    dumps_cases,
    new_id,
    new_run_id,
)
from mango_api.model_catalog import ModelCatalog, ModelCatalogUnavailableError
from mango_api.pricing import eval_case_reservation, judge_reservation
from mango_api.rate_limits import Limiter
from mango_api.settings import ModelPrice
from mango_api.web import ApiError, Caller, rate_limited
from mango_core import task_runs
from mango_core.agents import (
    AGENT_ID_PATTERN,
    MODEL_ID_PATTERN,
    AgentStatus,
    VersionStatus,
    content_hash,
)
from mango_core.evals import (
    MAX_CASES,
    MAX_CSV_BYTES,
    MAX_QUESTION_CHARS,
    CsvError,
    EvalCase,
    EvalCases,
    normalize,
    parse_csv,
)

logger = logging.getLogger(__name__)

WRITES_PER_HOUR = 60
RUNS_PER_DAY = 20
"""Runs a person may launch a day (TM-EV6): with 50 cases each, 1,000 turns at most."""
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
_MICRO = Decimal("0.000001")
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


class ActiveRunOut(_Strict):
    """The run that holds the suite now, for its progress («Caso {n} de {total}»)."""

    run_id: str
    status: Literal["queued", "running", "judging"]
    version: int
    cases_done: int
    case_count: int


class LastAttemptOut(_Strict):
    """How the most recent run ended. One that stopped or failed does not count: the score and
    the gate stay with ``last_run``."""

    run_id: str
    status: Literal["passed", "failed", "stopped", "error"]
    stop_reason: str | None
    cases_done: int
    case_count: int
    finished_at: str


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
    active_run: ActiveRunOut | None = None
    last_attempt: LastAttemptOut | None = None
    recent_scores: list[int] = []
    """Scores of the last complete runs, oldest first (at most 6): the trend."""
    completed_runs: int = 0
    can_edit: bool


class SuitesOut(_Strict):
    suites: list[SuiteOut]
    judge_models: list[str] = []
    """The models that may judge in this installation (``models.judges``); the selector of the
    judge only offers these that the catalog also has enabled. Empty while runs do not exist."""


class CaseOut(_Strict):
    question: str
    expected: str
    criterion: Literal["contains", "uses_tool", "no_disclosure", "judge"]
    value: str


class SuiteDetailOut(SuiteOut):
    cases: list[CaseOut]


class StartRunIn(_Strict):
    version: Annotated[int, Field(ge=1, le=1_000_000)]
    revision: Annotated[int, Field(ge=1, le=1_000_000)] | None = None
    """Revision of the draft the person sees; required for a draft."""


class CaseResultOut(_Strict):
    status: Literal["pass", "fail", "judge", "skipped", "pending"]
    reason: str | None


class EvalRunOut(_Strict):
    run_id: str
    version: int
    content_hash: str
    status: Literal["queued", "running", "judging", "passed", "failed", "stopped", "error"]
    trigger: Literal["manual", "on_submit"]
    launched_by_email: str | None
    started_at: str
    finished_at: str | None
    score: int | None
    threshold: int
    stop_reason: str | None
    cases: list[CaseResultOut]


class EvalRunsOut(_Strict):
    runs: list[EvalRunOut]


class EstimateIn(_Strict):
    agent_id: Annotated[str, Field(pattern=AGENT_ID_PATTERN)]
    case_count: Annotated[int, Field(ge=1, le=MAX_CASES)]
    judged: Annotated[int, Field(ge=0, le=MAX_CASES)] = 0
    """Cases decided by the judge; at most ``case_count``."""
    judge_model: JudgeModel | None = None


class EstimateOut(_Strict):
    usd: str
    """What one run reserves, in USD (rule 4): every case on the published version of the agent,
    with the longest question, plus the judging of the judged cases."""
    model: str
    """The model of the agent the cases run on."""


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
    runs: EvalRuns | None = None
    """Runs (E2); ``None`` until the evaluator is deployed: suites exist, nothing runs."""
    harnesses: Any = None
    """``evals_runner.EvalsHarnesses``: the evals harness, only once its canary verified it."""
    queue: Any = None
    """The queue of runs (``tasks.RunQueue``), shared with the tasks (D78)."""
    run_limiter: Limiter | None = None
    judge_models: tuple[str, ...] = ()
    price: Callable[[str], ModelPrice] | None = None
    """Price of an enabled model from the catalog (rule 7); ``None`` until runs exist."""
    knowledge_price: Decimal = Decimal(0)
    evaluation_fee: Decimal = Decimal(0)


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


def _active_out(active: Run | None) -> ActiveRunOut | None:
    if active is None or active.status not in ("queued", "running", "judging"):
        return None
    return ActiveRunOut(
        run_id=active.run_id,
        status=active.status,
        version=active.version,
        cases_done=cases_done(active.results),
        case_count=active.case_count,
    )


def _attempt_out(suite: Suite) -> LastAttemptOut | None:
    attempt = suite.last_attempt
    if attempt is None:
        return None
    return LastAttemptOut(
        run_id=attempt.run_id,
        status=attempt.status,  # type: ignore[arg-type]
        stop_reason=attempt.stop_reason,
        cases_done=attempt.cases_done,
        case_count=attempt.case_count,
        finished_at=_iso(attempt.finished_at),
    )


def _active(deps: EvalsDeps, suite: Suite) -> Run | None:
    """The run that holds the suite, read only for a suite that is running."""
    if not suite.running or deps.runs is None:
        return None
    return deps.runs.get(suite.suite_id, suite.running)


def _suite_out(
    suite: Suite,
    caller: Caller,
    *,
    can_edit: bool,
    changes: dict[str, RequirementChange],
    now: datetime,
    active: Run | None = None,
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
        active_run=_active_out(active),
        last_attempt=_attempt_out(suite),
        recent_scores=list(suite.recent_scores),
        completed_runs=suite.completed_runs,
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
            active=_active(deps, s),
        )
        for s in suites
        if s.agent_id in visible and _may(caller, "ViewEvals", metas.get(s.agent_id))
    ]
    out.sort(key=lambda s: (s.agent_id, s.name.casefold(), s.suite_id))
    return SuitesOut(suites=out, judge_models=list(deps.judge_models))


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
    active: Run | None = None,
) -> SuiteDetailOut:
    base = _suite_out(
        suite, caller, can_edit=can_edit, changes=changes or {}, now=now, active=active
    )
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
    return _detail_out(
        suite,
        cases,
        caller,
        can_edit=can_edit,
        now=deps.clock(),
        changes=changes,
        active=_active(deps, suite),
    )


def _current(suite: Suite, revision: int) -> None:
    if suite.revision != revision:
        raise ApiError(409, "version_conflict", "the suite changed; reload and try again")
    if suite.running:
        # Its cases and settings are what the run reads, case by case (TM-EV3).
        raise ApiError(409, "run_in_progress", "the suite is running; wait for it to finish")


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


# --- Runs (E2) ---------------------------------------------------------------------------


def _run_out(run: Run) -> EvalRunOut:
    return EvalRunOut(
        run_id=run.run_id,
        version=run.version,
        content_hash=run.content_hash,
        status=run.status,
        trigger=run.trigger,
        launched_by_email=run.launched_by_email,
        started_at=_iso(run.started_at),
        finished_at=_iso(run.finished_at) if run.finished_at else None,
        score=run.score,
        threshold=run.threshold,
        stop_reason=run.stop_reason,
        cases=[
            CaseResultOut(status=r.status, reason=r.reason)
            if r is not None
            else CaseResultOut(status="pending", reason=None)
            for r in run.results
        ]
        if run.results
        else [CaseResultOut(status="pending", reason=None)] * run.case_count,
    )


def list_runs(deps: EvalsDeps, suite: Suite) -> EvalRunsOut:
    if deps.runs is None:
        return EvalRunsOut(runs=[])
    return EvalRunsOut(runs=[_run_out(r) for r in deps.runs.recent(suite.suite_id)])


def _tested_version(deps: EvalsDeps, suite: Suite, body: StartRunIn) -> tuple[int, str]:
    """The stored version a run tests: the open draft at the revision the person sees, one in
    review, or the published one (the provisioner's pointer). Its hash is what the gate of D26
    compares with the version an approver approves."""
    version = deps.agents.version(suite.agent_id, body.version)
    if version is None:
        raise ApiError(404, "not_found", "not found")
    if version.status is VersionStatus.DRAFT:
        if body.revision != version.revision:
            raise ApiError(409, "version_conflict", "the draft changed; reload and try again")
    elif version.status is VersionStatus.PUBLISHED:
        pointer = deps.agents.published_pointer(suite.agent_id)
        if pointer is None or pointer.version != version.number:
            raise ApiError(
                409, "version_not_testable", "only a draft, one in review or the published version"
            )
    elif version.status is not VersionStatus.IN_REVIEW:
        raise ApiError(
            409, "version_not_testable", "only a draft, one in review or the published version"
        )
    return version.number, content_hash(version.canonical)


def start_run(  # noqa: PLR0917 - the parts of one run, all required
    deps: EvalsDeps,
    caller: Caller,
    meta: AgentMeta | None,
    suite: Suite,
    body: StartRunIn,
    trigger: Literal["manual", "on_submit"] = "manual",
) -> EvalRunOut:
    """Queue a run of ``suite`` on a version of its agent (D110, D111 (2)): one at a time per
    suite, and only once the canary verified the evals harness (D110 (8))."""
    if deps.runs is None or deps.queue is None or deps.harnesses is None:
        raise ApiError(503, "evals_unavailable", "evals cannot run in this installation yet")
    _writable(meta)
    if suite.running:
        raise ApiError(409, "run_in_progress", "the suite is already running")
    if deps.harnesses.get() is None:
        raise ApiError(503, "evals_unavailable", "evals cannot run yet; please try again later")
    judged = suite.judge_model is not None and any(
        c.criterion == "judge" for c in deps.store.cases(suite)
    )
    if judged and suite.judge_model not in deps.judge_models:
        raise ApiError(409, "judge_unavailable", "this model cannot judge in this installation")
    number, digest = _tested_version(deps, suite, body)
    now = deps.clock()
    run = Run(
        run_id=new_run_id(now),
        suite_id=suite.suite_id,
        agent_id=suite.agent_id,
        version=number,
        content_hash=digest,
        launched_by=caller.user.user_id,
        launched_by_email=caller.user.email,
        trigger=trigger,
        status="queued",
        case_count=suite.case_count,
        threshold=suite.threshold,
        judge_model=suite.judge_model if judged else None,
        started_at=now,
    )
    detail = {
        **_detail(suite),
        "run": run.run_id,
        "version": number,
        "content_hash": digest,
        "trigger": trigger,
    }

    def write() -> None:
        try:
            deps.runs.start(suite, run)  # type: ignore[union-attr]
        except ConflictError as exc:
            raise ApiError(409, "run_in_progress", "the suite is already running") from exc
        deps.queue.send(task_runs.eval_message(suite.suite_id, run.run_id, 0))

    _audited(deps, "evals.run_started", caller, detail, write)
    return _run_out(run)


def estimate(deps: EvalsDeps, body: EstimateIn) -> EstimateOut:
    """What one run of ``body.case_count`` cases reserves (rule 4, D111 (3)), with the same
    reservations the runner makes: each case is a turn of the published version of the agent,
    counted with the longest question; each judged case adds its judging. Never falls short."""
    if deps.price is None:
        raise ApiError(503, "evals_unavailable", "evals cannot run in this installation yet")
    if body.judged > body.case_count:
        raise ApiError(
            422, "invalid_request", "invalid fields: judged", extra={"fields": ["judged"]}
        )
    pointer = deps.agents.published_pointer(body.agent_id)
    version = deps.agents.version(body.agent_id, pointer.version) if pointer else None
    model = version.definition.model if version else None
    if version is None or not model:
        raise ApiError(409, "version_not_testable", "the agent has no published version")
    limits = version.definition.limits
    per_case = eval_case_reservation(
        deps.price(model),
        MAX_QUESTION_CHARS,
        limits.max_iterations,
        limits.reserved_output_tokens,
        deps.knowledge_price if version.definition.knowledge_bases else None,
    )
    total = per_case * body.case_count
    if body.judged:
        if not body.judge_model:
            raise ApiError(422, "judge_model_required", "choose the model that judges")
        if body.judge_model not in deps.judge_models:
            raise ApiError(409, "judge_unavailable", "this model cannot judge in this installation")
        total += judge_reservation(deps.price(body.judge_model), deps.evaluation_fee) * body.judged
    return EstimateOut(usd=str(total.quantize(_MICRO, rounding=ROUND_CEILING)), model=model)


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

    @router.post("/estimate", response_model=EstimateOut)
    async def post_eval_estimate(body: EstimateIn, caller: CallerDep) -> EstimateOut:
        await limit(deps.reads, caller)
        await on_agent(caller, "ViewEvals", body.agent_id, read_only=True)
        return await run(estimate, deps, body)

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

    @router.get("/suites/{suite_id}/runs", response_model=EvalRunsOut)
    async def get_eval_runs(target: View) -> EvalRunsOut:
        return await run(list_runs, deps, target.suite)

    @router.post("/suites/{suite_id}/runs", response_model=EvalRunOut, status_code=202)
    async def post_eval_run(body: StartRunIn, target: Edit) -> EvalRunOut:
        if deps.run_limiter is not None:
            await limit(deps.run_limiter, target.caller)
        return await run(start_run, deps, target.caller, target.meta, target.suite, body)

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


# --- The gate of the review (D26, E3) --------------------------------------------------------


@dataclass(frozen=True)
class GateSuite:
    suite_id: str
    name: str
    state: Literal["passed", "failed", "running", "not_run", "other_version"]


class EvalGate:
    """What the review of a version asks of the evals (D26): a required suite that has not passed
    on exactly that content blocks its approval, in the server (TM-EV3). Sending a version to
    review starts its required suites, and those marked to run on every submission, on it."""

    def __init__(self, deps: EvalsDeps) -> None:
        self._deps = deps

    def state(self, agent_id: str, digest: str) -> list[GateSuite]:
        """The required suites of the agent and where each stands for ``digest``. Raises when
        the suites cannot be read: the caller fails closed."""
        out: list[GateSuite] = []
        for suite in self._deps.store.suites(agent_id):
            if not suite.required:
                continue
            run = suite.last_run
            state: Literal["passed", "failed", "running", "not_run", "other_version"]
            if suite.running:
                state = "running"
            elif run is None:
                state = "not_run"
            elif run.content_hash != digest:
                state = "other_version"
            else:
                state = "passed" if run.passed else "failed"
            out.append(GateSuite(suite.suite_id, suite.name, state))
        return out

    def blocking(self, agent_id: str, digest: str) -> list[GateSuite]:
        return [s for s in self.state(agent_id, digest) if s.state != "passed"]

    def on_submit(self, caller: Caller, agent_id: str, number: int) -> list[str]:
        """Start the suites that run on a submission; never fails the submission. Returns the
        ids of the runs started."""
        deps = self._deps
        started: list[str] = []
        try:
            suites = [
                s for s in deps.store.suites(agent_id) if s.required or s.trigger == "on_submit"
            ]
            meta = deps.agents.meta(agent_id)
        except (ClientError, BotoCoreError, StoredEvalError):
            logger.exception("the suites to run on submission could not be read")
            return started
        for suite in suites:
            try:
                run = start_run(deps, caller, meta, suite, StartRunIn(version=number), "on_submit")
            except ApiError as exc:
                # Audited by start_run when it got that far; the review shows «sin ejecutar».
                logger.warning("a suite did not start on submission: %s", exc.code)
                continue
            except (ClientError, BotoCoreError, StoredEvalError):
                logger.exception("a suite did not start on submission")
                continue
            started.append(run.run_id)
        return started
