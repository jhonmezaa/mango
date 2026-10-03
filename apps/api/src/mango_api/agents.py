"""Agents API (Marketplace v1, D18, D22, D30, D33): drafts, review and retirement.

mango-api owns an agent version up to ``approved``; publishing belongs to the provisioner,
which this module only starts with ``{agent_id, version, content_hash}``.

Security notes (threat model ``marketplace-v1-threat-model.md``; security-best-practices,
FastAPI):
* Every route declares an authorization dependency bound to its own Cedar action; the
  decision is audited (AUTH-001). Actions on one agent are decided per object, with the Agent
  entity built from the Agents table and never from the request (AUTHZ-001, D33). Lists are
  filtered with the same ``UseAgent`` policy; an agent the caller cannot use looks exactly
  like one that does not exist (TM-M17).
* Whoever wrote a version cannot approve or reject it; approval names the hash the reviewer
  saw and re-runs every submit rule, because the catalogs and the organization chart may have
  changed while the version waited (TM-M2). The table conditions enforce it again.
* Bodies forbid extra fields and responses use explicit models: ``editors`` and stored items
  never leave as they are (VALID-001, RESP-001). Validation errors name fields and rule
  codes, never the content: a prompt with a secret must not be echoed (TM-M7).
* Creator text (name, description, role, prompt) is returned as plain JSON strings; the SPA
  renders it as text (TM-M8).
* Every write audits ``requested`` before and ``applied`` or ``rejected`` after, fail closed,
  with both subjects and the content hash (TM-M10). Events carry ids, hashes and rule codes,
  never the definition.
* Quotas per creator: drafts held and submissions per day (TM-M9).
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import difflib
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Path, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from mango_api.agent_rules import (
    MAX_DRAFTS,
    MAX_SUBMISSIONS_PER_DAY,
    RuleContext,
    Violation,
    validate_for_review,
)
from mango_api.agents_store import (
    START_STEP,
    AgentConflictError,
    AgentMeta,
    AgentNotFoundError,
    AgentsStore,
    AgentVersion,
    DraftLimitError,
    SelfApprovalError,
    SubmissionLimitError,
)
from mango_api.audit import AuditLog
from mango_api.authz import AGENT_TYPE, PLATFORM, AgentResource, Authorizer
from mango_api.groups import GroupRegistry, GroupsUnavailableError
from mango_api.mcp_catalog import InvalidCatalogError, McpCatalog
from mango_api.model_catalog import ModelCatalogStore, ModelCatalogUnavailableError
from mango_api.provisioner import (
    Cleanups,
    CleanupStatus,
    DeprovisionerClient,
    ProvisionerClient,
    ProvisionerError,
)
from mango_api.published import AgentUnavailableError, PublishedAgents
from mango_api.web import ApiError, Caller
from mango_core.agents import (
    AGENT_ID_PATTERN,
    ROOT_SUPERVISOR,
    AgentDefinition,
    AgentStatus,
    InvalidDefinitionError,
    VersionStatus,
    dumps_definition,
    new_agent_id,
    verify_content,
)
from mango_core.agents import content_hash as hash_content
from mango_core.agents_table import EXPIRED_STEP, MAX_VERSION, iso
from mango_core.identity import UserContext

logger = logging.getLogger(__name__)

HASH_PATTERN = r"^[0-9a-f]{64}$"
MAX_HISTORY = 100
CLEANUP_GRACE = timedelta(minutes=2)
"""A removal that was just started may not be listed yet: until then it counts as running."""
MAX_DIFF_LINES = 800
"""Per side. Longer prompts are shown as replaced: a line diff is quadratic in the worst case."""
_OPEN_STATUSES = frozenset(
    {VersionStatus.DRAFT, VersionStatus.IN_REVIEW, VersionStatus.APPROVED, VersionStatus.FAILED}
)
_HISTORY_STATUSES = (
    VersionStatus.APPROVED,
    VersionStatus.FAILED,
    VersionStatus.PUBLISHED,
    VersionStatus.RETIRED,
)
_SCALAR_FIELDS = ("name", "description", "category", "icon", "color", "reports_to", "role", "model")
_LIMIT_FIELDS = (
    "max_tokens",
    "max_iterations",
    "timeout_seconds",
    "max_tokens_per_call",
    "temperature",
)
_SET_FIELDS = ("allowed_models", "tools", "approval_tools", "groups", "users")


# --- Requests ---------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


Reason = Annotated[str, Field(min_length=1, max_length=500)]
ContentHash = Annotated[str, Field(pattern=HASH_PATTERN)]
Revision = Annotated[int, Field(ge=1, le=1_000_000)]


class EmptyIn(_Strict):
    pass


class CreateAgentIn(_Strict):
    definition: AgentDefinition


class SaveDraftIn(_Strict):
    revision: Revision
    definition: AgentDefinition


class SubmitIn(_Strict):
    revision: Revision


class HashIn(_Strict):
    content_hash: ContentHash


class RejectIn(_Strict):
    reason: Reason


class RetireIn(_Strict):
    lock_version: Annotated[int, Field(ge=1)]
    reason: Reason


# --- Responses --------------------------------------------------------------------------


class LimitsOut(_Strict):
    max_tokens: int
    max_iterations: int
    timeout_seconds: int
    max_tokens_per_call: int | None
    temperature: float | None


class DefinitionOut(_Strict):
    name: str
    description: str
    category: str
    icon: str
    color: int
    reports_to: str | None
    role: str
    model: str | None
    allowed_models: list[str]
    system_prompt: str
    tools: list[str]
    approval_tools: list[str]
    limits: LimitsOut
    groups: list[str]
    users: list[str]


class ViolationOut(_Strict):
    code: str
    field: str
    items: list[str]


class FieldChange(_Strict):
    field: str
    before: str | int | float | None
    after: str | int | float | None


class SetChange(_Strict):
    field: str
    added: list[str]
    removed: list[str]


class PromptLine(_Strict):
    op: Literal["+", "-", " "]
    text: str


class DiffOut(_Strict):
    """Changes of a version against the published one, computed here (never by the SPA)."""

    is_new: bool
    fields: list[FieldChange]
    sets: list[SetChange]
    prompt: list[PromptLine] | None
    """``None`` when the prompt did not change."""
    changes: int


class AgentStateOut(_Strict):
    status: str
    lock_version: int
    """Optimistic lock of the agent, sent back to ``retire``."""
    published_version: int | None
    open_version: int | None
    created_by: str


class VersionOut(_Strict):
    agent_id: str
    version: int
    status: str
    revision: int
    content_hash: str | None
    base_version: int | None
    created_by: str
    created_by_email: str | None
    created_at: str
    updated_at: str
    submitted_by: str | None
    submitted_at: str | None
    approved_by: str | None
    approved_by_email: str | None
    approved_at: str | None
    rejected_by: str | None
    rejected_by_email: str | None
    rejected_at: str | None
    rejection_reason: str | None
    failed_step: str | None
    failure: str | None
    published_at: str | None
    is_author: bool
    """The caller wrote this content and cannot approve or reject it. A hint: the API decides."""
    agent: AgentStateOut
    definition: DefinitionOut
    base: DefinitionOut | None
    """Definition of the published version, when this is a change to a published agent."""
    diff: DiffOut
    violations: list[ViolationOut] | None
    """Submit rules this content breaks now; ``None`` if they could not be evaluated."""


class AgentOut(_Strict):
    """An agent as its users see it: no prompt and no access lists."""

    id: str
    status: str
    version: int
    lock_version: int | None
    """Optimistic lock of the agent for ``retire``; only in the detail."""
    name: str
    description: str
    category: str
    icon: str
    color: int
    role: str
    reports_to: str | None
    model: str
    allowed_models: list[str]
    tools: list[str]
    unavailable_tools: list[str] = []
    """Tools of the version whose MCP pack is not installed now: the agent serves without
    them until it is edited (spec §4.4). Always empty for a retired agent."""
    published_at: str | None
    retired_at: str | None
    retire_reason: str | None
    is_mine: bool = False
    """The caller created this agent and has the creator role, so they may edit it. Only a
    hint for the UI (the API authorizes ``EditAgent``); who created it is never returned."""
    cleanup: CleanupStatus | None = None
    """Administrators only, for a retired agent: how the removal of its AWS resources goes
    (D48). ``None`` when it is not known, and always for everyone else."""


class AgentList(_Strict):
    items: list[AgentOut]


class VersionSummary(_Strict):
    agent_id: str
    version: int
    status: str
    revision: int
    base_version: int | None
    name: str
    description: str
    category: str
    icon: str
    color: int
    created_at: str
    updated_at: str
    submitted_at: str | None
    rejected_at: str | None
    rejection_reason: str | None
    failed_step: str | None


class QuotasOut(_Strict):
    drafts: int
    max_drafts: int
    submissions_today: int
    max_submissions_per_day: int


class MineOut(_Strict):
    items: list[VersionSummary]
    quotas: QuotasOut


class ReviewOut(_Strict):
    agent_id: str
    version: int
    status: str
    kind: Literal["new", "change"]
    name: str
    description: str
    category: str
    icon: str
    color: int
    content_hash: str | None
    created_by: str
    created_by_email: str | None
    submitted_at: str | None
    approved_by: str | None
    approved_by_email: str | None
    approved_at: str | None
    published_at: str | None
    failed_step: str | None
    rejected_by: str | None
    rejected_by_email: str | None
    rejected_at: str | None
    rejection_reason: str | None
    """Set on a draft a reviewer sent back: the history shows it as rejected."""
    retired_by: str | None
    retired_by_email: str | None
    retired_at: str | None
    retire_reason: str | None
    decided_at: str | None
    """When the version reached this state (approved, published, failed, rejected, retired)."""
    changes: int | None
    """Number of changes: against the published version in the queue, against the version it
    started from in the history. ``None`` when that version can no longer be read."""
    retryable: bool
    """``retry`` would be accepted now: the publication failed, or it was approved so long ago
    that nothing is publishing it any more. A hint: the API decides."""
    is_author: bool


class ReviewsOut(_Strict):
    queue: list[ReviewOut]
    history: list[ReviewOut]


class OrgNode(_Strict):
    id: str
    version: int
    """Published version, so the Builder can be opened on it without ``UseAgent`` (D38)."""
    name: str
    role: str
    description: str
    category: str
    icon: str
    color: int
    reports_to: str | None
    """An agent id, the root, or ``None`` when the supervisor is retired or not visible to
    the caller."""


class OrgOut(_Strict):
    root: str
    nodes: list[OrgNode]


class ModelOut(_Strict):
    id: str
    name: str
    provider: str
    supports_tools: bool
    context_tokens: int | None
    """Context size, when the release knows it."""
    input_usd: str
    output_usd: str


class ModelsOut(_Strict):
    version: int
    items: list[ModelOut]


# --- Errors -----------------------------------------------------------------------------


def _violations_out(violations: list[Violation]) -> list[ViolationOut]:
    return [ViolationOut(code=v.code, field=v.field, items=list(v.items)) for v in violations]


class ValidationFailedError(ApiError):
    """The version breaks submit rules: 422 with rule codes, never the content."""

    def __init__(self, violations: list[Violation]) -> None:
        self.violations = violations
        super().__init__(
            422,
            "validation_failed",
            "the version does not meet the review rules",
            extra={"violations": [v.model_dump() for v in _violations_out(violations)]},
        )


def _seconds_to_next_utc_day(now: datetime) -> int:
    tomorrow = datetime.combine(now.astimezone(UTC).date() + timedelta(days=1), time.min, UTC)
    return max(1, int((tomorrow - now).total_seconds()))


def _api_error(exc: Exception, now: datetime) -> ApiError | None:
    """Domain errors of the store and the catalogs as HTTP errors, in one place."""
    error: ApiError | None = None
    if isinstance(exc, ApiError):
        error = exc
    elif isinstance(exc, AgentNotFoundError):
        error = ApiError(404, "not_found", "not found")
    elif isinstance(exc, AgentConflictError):
        error = ApiError(409, "version_conflict", "the agent changed; reload and try again")
    elif isinstance(exc, SelfApprovalError):
        error = ApiError(403, "same_approver", "another administrator must review this version")
    elif isinstance(exc, DraftLimitError):
        error = ApiError(409, "too_many_drafts", "too many drafts; send or delete some first")
    elif isinstance(exc, SubmissionLimitError):
        error = ApiError(
            429,
            "submission_limit",
            "daily limit of versions sent to review reached",
            headers={"Retry-After": str(_seconds_to_next_utc_day(now))},
        )
    elif isinstance(exc, ModelCatalogUnavailableError):
        error = ApiError(503, "models_unavailable", "please try again")
    elif isinstance(exc, GroupsUnavailableError):
        error = ApiError(503, "groups_unavailable", "please try again")
    elif isinstance(exc, InvalidCatalogError):
        error = ApiError(503, "catalog_unavailable", "please try again")
    elif isinstance(exc, InvalidDefinitionError):
        # A stored definition that no longer parses: fail closed, without its content.
        error = ApiError(500, "error", "the agent could not be read")
    return error


# --- Dependencies of the use cases ------------------------------------------------------


@dataclass
class AgentsDeps:
    store: AgentsStore
    audit: AuditLog
    authorizer: Authorizer
    groups: GroupRegistry
    models: ModelCatalogStore
    catalog: Callable[[], McpCatalog]
    """Release catalog; raises ``InvalidCatalogError`` when it cannot be read."""
    provisioner: ProvisionerClient | None
    clock: Callable[[], datetime]
    published: PublishedAgents | None = None
    """What each agent serves (the provisioner's pointer, D40); set in production."""
    deprovisioner: DeprovisionerClient | None = None
    """Removes the harness and the role of a retired agent (D48); set in production."""


class _PendingOrg:
    """Organization chart for approval: published agents, with the changes already approved.

    Two pending versions (A reports to B, B reports to A) each pass against the published
    chart. Approving the second one must see the first, even before it is published.
    """

    def __init__(self, store: AgentsStore) -> None:
        self._store = store
        self._approved = {
            v.agent_id: v.definition.reports_to or ROOT_SUPERVISOR
            for v in store.by_status(VersionStatus.APPROVED)
        }

    def supervisor_of(self, agent_id: str) -> str | None:
        published = self._store.supervisor_of(agent_id)
        # Only published agents are in the chart; an approved change replaces their edge.
        return None if published is None else self._approved.get(agent_id, published)


def _rule_context(deps: AgentsDeps, *, approving: bool = False) -> RuleContext:
    return RuleContext(
        catalog=deps.catalog(),
        models=deps.models.catalog(),
        groups={g.id: g for g in deps.groups.list_groups()},
        org=_PendingOrg(deps.store) if approving else deps.store,
    )


# --- Mapping ----------------------------------------------------------------------------


def _iso(value: datetime | None) -> str | None:
    return iso(value) if value is not None else None


def _definition_out(definition: AgentDefinition) -> DefinitionOut:
    limits = definition.limits
    return DefinitionOut(
        name=definition.name,
        description=definition.description,
        category=definition.category,
        icon=definition.icon,
        color=definition.color,
        reports_to=definition.reports_to,
        role=definition.role,
        model=definition.model,
        allowed_models=list(definition.allowed_models),
        system_prompt=definition.system_prompt,
        tools=list(definition.tools),
        approval_tools=list(definition.approval_tools),
        limits=LimitsOut(
            max_tokens=limits.max_tokens,
            max_iterations=limits.max_iterations,
            timeout_seconds=limits.timeout_seconds,
            max_tokens_per_call=limits.max_tokens_per_call,
            temperature=limits.temperature,
        ),
        groups=list(definition.groups),
        users=list(definition.users),
    )


def _prompt_diff(before: str, after: str) -> list[PromptLine] | None:
    if before == after:
        return None
    old, new = before.split("\n") if before else [], after.split("\n") if after else []
    if len(old) > MAX_DIFF_LINES or len(new) > MAX_DIFF_LINES:
        return [PromptLine(op="-", text=t) for t in old] + [PromptLine(op="+", text=t) for t in new]
    lines: list[PromptLine] = []
    matcher = difflib.SequenceMatcher(None, old, new, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            lines.extend(PromptLine(op=" ", text=t) for t in old[i1:i2])
            continue
        lines.extend(PromptLine(op="-", text=t) for t in old[i1:i2])
        lines.extend(PromptLine(op="+", text=t) for t in new[j1:j2])
    return lines


def diff_definitions(base: AgentDefinition | None, definition: AgentDefinition) -> DiffOut:
    """What a reviewer has to read: every difference with the published version (TM-M2)."""
    fields: list[FieldChange] = []
    if base is not None:
        for name in _SCALAR_FIELDS:
            before, after = getattr(base, name), getattr(definition, name)
            if before != after:
                fields.append(FieldChange(field=name, before=before, after=after))
        for name in _LIMIT_FIELDS:
            before, after = getattr(base.limits, name), getattr(definition.limits, name)
            if before != after:
                fields.append(FieldChange(field=f"limits.{name}", before=before, after=after))
    sets: list[SetChange] = []
    for name in _SET_FIELDS:
        old = set(getattr(base, name)) if base is not None else set()
        new = set(getattr(definition, name))
        if old != new:
            sets.append(SetChange(field=name, added=sorted(new - old), removed=sorted(old - new)))
    prompt = _prompt_diff(base.system_prompt if base else "", definition.system_prompt)
    changes = len(fields) + sum(len(s.added) + len(s.removed) for s in sets) + (prompt is not None)
    return DiffOut(is_new=base is None, fields=fields, sets=sets, prompt=prompt, changes=changes)


def _is_author(version: AgentVersion, user_id: str) -> bool:
    return user_id == version.created_by or user_id in version.editors


def _published(deps: AgentsDeps, meta: AgentMeta) -> AgentVersion | None:
    if meta.published_version is None:
        return None
    return deps.store.version(meta.agent_id, meta.published_version)


def _served_version(deps: AgentsDeps, meta: AgentMeta) -> AgentVersion | None:
    """The version the chat serves for this agent: the one the provisioner's pointer names,
    verified against its hash (D40)."""
    if deps.published is None:
        return _published(deps, meta)
    try:
        served = deps.published.get(meta.agent_id)
    except AgentUnavailableError as exc:
        raise ApiError(503, "agent_unavailable", "please try again") from exc
    return served.record if served else None


def _base_of(deps: AgentsDeps, meta: AgentMeta, version: AgentVersion) -> AgentDefinition | None:
    if meta.published_version is None or meta.published_version == version.number:
        return None
    published = _published(deps, meta)
    return published.definition if published else None


def _display_rules(deps: AgentsDeps, version: AgentVersion) -> list[ViolationOut] | None:
    """Rules for the builder and the reviewer. The ones that count run on submit and approve."""
    if version.status not in _OPEN_STATUSES:
        return []
    try:
        ctx = _rule_context(deps, approving=version.status is VersionStatus.IN_REVIEW)
    except (ModelCatalogUnavailableError, GroupsUnavailableError, InvalidCatalogError) as exc:
        logger.warning("submit rules unavailable: %s", type(exc).__name__)
        return None
    return _violations_out(validate_for_review(version.agent_id, version.definition, ctx))


def _version_out(deps: AgentsDeps, caller: Caller, version: AgentVersion) -> VersionOut:
    meta = deps.store.meta(version.agent_id)
    if meta is None:
        raise AgentNotFoundError("agent not found")
    base = _base_of(deps, meta, version)
    return VersionOut(
        agent_id=version.agent_id,
        version=version.number,
        status=version.status,
        revision=version.revision,
        content_hash=version.content_hash,
        base_version=version.base_version,
        created_by=version.created_by,
        created_by_email=version.created_by_email,
        created_at=iso(version.created_at),
        updated_at=iso(version.updated_at),
        submitted_by=version.submitted_by,
        submitted_at=_iso(version.submitted_at),
        approved_by=version.approved_by,
        approved_by_email=version.approved_by_email,
        approved_at=_iso(version.approved_at),
        rejected_by=version.rejected_by,
        rejected_by_email=version.rejected_by_email,
        rejected_at=_iso(version.rejected_at),
        rejection_reason=version.rejection_reason,
        failed_step=version.failed_step,
        failure=version.failure,
        published_at=_iso(version.published_at),
        is_author=_is_author(version, caller.user.user_id),
        agent=AgentStateOut(
            status=meta.status,
            lock_version=meta.version,
            published_version=meta.published_version,
            open_version=meta.open_version,
            created_by=meta.created_by,
        ),
        definition=_definition_out(version.definition),
        base=_definition_out(base) if base else None,
        diff=diff_definitions(base, version.definition),
        violations=_display_rules(deps, version),
    )


def _packs_catalog(deps: AgentsDeps) -> McpCatalog | None:
    """The catalog, to mark tools of packs that are not installed. Only a hint for the UI:
    without it nothing is marked, and the chat decides on its own (``PublishedAgents``)."""
    try:
        return deps.catalog()
    except InvalidCatalogError:
        return None


def _is_mine(user: UserContext, meta: AgentMeta | None) -> bool:
    return meta is not None and user.is_agent_creator and meta.created_by == user.user_id


def _removals(deps: AgentsDeps, user: UserContext) -> Cleanups | None:
    """How the removals of retired agents went, for administrators. Only a notice for the
    UI: when it cannot be read nothing is said, and the reconciliation still reports what
    is left (D48)."""
    if not user.is_admin or deps.deprovisioner is None:
        return None
    try:
        return deps.deprovisioner.cleanups()
    except ProvisionerError:
        logger.warning("deprovisioner executions could not be read")
        return None


def _cleanup_of(
    meta: AgentMeta | None, removals: Cleanups | None, now: datetime
) -> CleanupStatus | None:
    if removals is None or meta is None or meta.retired_at is None:
        return None
    status = removals.by_agent.get(meta.agent_id)
    if status is None and now - meta.retired_at < CLEANUP_GRACE:
        return "running"
    return status


def _agent_out(
    version: AgentVersion,
    meta: AgentMeta | None = None,
    catalog: McpCatalog | None = None,
    *,
    is_mine: bool = False,
    cleanup: CleanupStatus | None = None,
) -> AgentOut:
    d = version.definition
    served = catalog is not None and version.status is VersionStatus.PUBLISHED
    return AgentOut(
        id=version.agent_id,
        status=version.status,
        version=version.number,
        lock_version=meta.version if meta else None,
        name=d.name,
        description=d.description,
        category=d.category,
        icon=d.icon,
        color=d.color,
        role=d.role,
        reports_to=d.reports_to,
        model=d.model or "",
        allowed_models=list(d.allowed_models),
        tools=list(d.tools),
        unavailable_tools=[t for t in d.tools if catalog.pack_tool_unavailable(t)]
        if served and catalog is not None
        else [],
        published_at=_iso(version.published_at),
        retired_at=_iso(meta.retired_at) if meta else None,
        retire_reason=meta.retire_reason if meta else None,
        is_mine=is_mine,
        cleanup=cleanup,
    )


def _use_resource(version: AgentVersion) -> AgentResource:
    """The Agent entity for ``UseAgent``: groups and users of the published version (D33)."""
    return AgentResource(
        agent_id=version.agent_id,
        groups=frozenset(version.definition.groups),
        users=frozenset(version.definition.users),
    )


# --- Audit ------------------------------------------------------------------------------


def _audited[T](
    deps: AgentsDeps, event: str, caller: Caller, detail: dict[str, Any], write: Callable[[], T]
) -> T:
    """Fail-closed audit around a write, as in Admin v0 (TM-M10).

    ``requested`` is recorded before writing (503 and no write if it cannot be); then
    ``applied``, or ``rejected`` with the error code and, for rule failures, the rule codes.
    """
    actor, user = caller.user.user_id, caller.user
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "requested"}, user)
    except Exception as exc:
        raise ApiError(503, "audit_unavailable", "the change could not be audited; retry") from exc
    try:
        result = write()
    except Exception as exc:
        known = _api_error(exc, deps.clock())
        rejected: dict[str, Any] = {
            **detail,
            "outcome": "rejected",
            "error": known.code if known else "error",
        }
        if isinstance(exc, ValidationFailedError):
            rejected["violations"] = sorted({v.code for v in exc.violations})
        try:
            deps.audit.emit(event, actor, rejected, user)
        except Exception:
            logger.exception("audit emit failed after a rejected write")
        raise
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "applied"}, user)
    except Exception:
        logger.exception("audit emit failed after an applied write")
    return result


def _audit_list(deps: AgentsDeps, user: UserContext, scope: str, visible: int) -> None:
    """One read-only decision for a filtered list, instead of one per agent."""
    deps.audit.emit(
        "policy.decision",
        user.user_id,
        {
            "action": "UseAgent",
            "resource": f"{AGENT_TYPE}::*",
            "allowed": True,
            "read_only": True,
            "scope": scope,
            "visible": visible,
        },
        user,
    )


# --- Use cases: reads -------------------------------------------------------------------


def _require_version(deps: AgentsDeps, agent_id: str, number: int) -> AgentVersion:
    version = deps.store.version(agent_id, number)
    if version is None:
        raise AgentNotFoundError("version not found")
    return version


def list_agents(deps: AgentsDeps, caller: Caller) -> AgentList:
    """Marketplace: published and retired agents the caller may use."""
    versions = [
        *deps.store.by_status(VersionStatus.PUBLISHED),
        *deps.store.by_status(VersionStatus.RETIRED),
    ]
    allowed = deps.authorizer.allowed_agents(
        caller.user, "UseAgent", [_use_resource(v) for v in versions]
    )
    _audit_list(deps, caller.user, "marketplace", len(allowed))
    catalog = _packs_catalog(deps)
    user, now = caller.user, deps.clock()
    visible = [v for v in versions if v.agent_id in allowed]
    retired = any(v.status is VersionStatus.RETIRED for v in visible)
    removals = _removals(deps, user) if retired else None
    items: list[AgentOut] = []
    for v in visible:
        is_retired = v.status is VersionStatus.RETIRED
        # Who created an agent only matters to a creator; everyone else gets `false`.
        meta = deps.store.meta(v.agent_id) if is_retired or user.is_agent_creator else None
        items.append(
            _agent_out(
                v,
                meta if is_retired else None,
                catalog,
                is_mine=_is_mine(user, meta),
                cleanup=_cleanup_of(meta, removals, now) if is_retired else None,
            )
        )
    items.sort(key=lambda a: (a.name.casefold(), a.id))
    return AgentList(items=items)


def organization(deps: AgentsDeps, caller: Caller) -> OrgOut:
    """«Reports to» tree (D30). Administrators and creators see it all; others, the agents
    they may use (D38, TM-M17)."""
    versions = deps.store.by_status(VersionStatus.PUBLISHED)
    full = deps.authorizer.is_allowed(caller.user, "CreateAgent", *PLATFORM)
    visible = (
        frozenset(v.agent_id for v in versions)
        if full
        else deps.authorizer.allowed_agents(
            caller.user, "UseAgent", [_use_resource(v) for v in versions]
        )
    )
    scope = "organization" if full else "organization_filtered"
    _audit_list(deps, caller.user, scope, len(visible))
    nodes: list[OrgNode] = []
    for v in versions:
        if v.agent_id not in visible:
            continue
        supervisor = v.definition.reports_to or ROOT_SUPERVISOR
        shown = supervisor == ROOT_SUPERVISOR or supervisor in visible
        nodes.append(
            OrgNode(
                id=v.agent_id,
                version=v.number,
                name=v.definition.name,
                role=v.definition.role,
                description=v.definition.description,
                category=v.definition.category,
                icon=v.definition.icon,
                color=v.definition.color,
                reports_to=supervisor if shown else None,
            )
        )
    nodes.sort(key=lambda n: (n.name.casefold(), n.id))
    return OrgOut(root=ROOT_SUPERVISOR, nodes=nodes)


def _summary(version: AgentVersion) -> VersionSummary:
    d = version.definition
    return VersionSummary(
        agent_id=version.agent_id,
        version=version.number,
        status=version.status,
        revision=version.revision,
        base_version=version.base_version,
        name=d.name,
        description=d.description,
        category=d.category,
        icon=d.icon,
        color=d.color,
        created_at=iso(version.created_at),
        updated_at=iso(version.updated_at),
        submitted_at=_iso(version.submitted_at),
        rejected_at=_iso(version.rejected_at),
        rejection_reason=version.rejection_reason,
        failed_step=version.failed_step,
    )


def mine(deps: AgentsDeps, caller: Caller) -> MineOut:
    """Versions in progress of the caller, with their quotas."""
    user_id = caller.user.user_id
    versions = [v for v in deps.store.by_creator(user_id) if v.status in _OPEN_STATUSES]
    return MineOut(
        items=[_summary(v) for v in versions],
        quotas=QuotasOut(
            drafts=sum(v.status is VersionStatus.DRAFT for v in versions),
            max_drafts=MAX_DRAFTS,
            submissions_today=deps.store.submissions_today(user_id, deps.clock()),
            max_submissions_per_day=MAX_SUBMISSIONS_PER_DAY,
        ),
    )


def _retryable(version: AgentVersion, now: datetime) -> bool:
    if version.content_hash is None:
        return False
    return version.status is VersionStatus.FAILED or version.approval_expired(now)


def _review_out(
    deps: AgentsDeps, caller: Caller, version: AgentVersion, *, queued: bool
) -> ReviewOut:
    d = version.definition
    # The agent item is only read where it is needed: the history can have a hundred rows.
    meta = (
        deps.store.meta(version.agent_id)
        if queued or version.status is VersionStatus.RETIRED
        else None
    )
    changes: int | None = None
    if queued:
        base = _base_of(deps, meta, version) if meta else None
        changes = diff_definitions(base, d).changes
    elif version.base_version is None:
        changes = diff_definitions(None, d).changes
    else:
        # What the reviewer decided on: the version this one started from.
        started_from = deps.store.version(version.agent_id, version.base_version)
        if started_from is not None:
            changes = diff_definitions(started_from.definition, d).changes
    retired = meta is not None and version.status is VersionStatus.RETIRED
    return ReviewOut(
        agent_id=version.agent_id,
        version=version.number,
        status=version.status,
        kind="new" if version.base_version is None else "change",
        name=d.name,
        description=d.description,
        category=d.category,
        icon=d.icon,
        color=d.color,
        content_hash=version.content_hash,
        created_by=version.created_by,
        created_by_email=version.created_by_email,
        submitted_at=_iso(version.submitted_at),
        approved_by=version.approved_by,
        approved_by_email=version.approved_by_email,
        approved_at=_iso(version.approved_at),
        published_at=_iso(version.published_at),
        failed_step=version.failed_step,
        rejected_by=version.rejected_by,
        rejected_by_email=version.rejected_by_email,
        rejected_at=_iso(version.rejected_at),
        rejection_reason=version.rejection_reason,
        retired_by=meta.retired_by if meta and retired else None,
        retired_by_email=meta.retired_by_email if meta and retired else None,
        retired_at=_iso(meta.retired_at) if meta and retired else None,
        retire_reason=meta.retire_reason if meta and retired else None,
        decided_at=_iso(_decided_at(version)),
        changes=changes,
        retryable=_retryable(version, deps.clock()),
        is_author=_is_author(version, caller.user.user_id),
    )


def _decided_at(version: AgentVersion) -> datetime:
    return version.status_at or version.updated_at


def reviews(deps: AgentsDeps, caller: Caller) -> ReviewsOut:
    """Review queue (oldest first) and what happened to reviewed versions (newest first)."""
    queue = deps.store.by_status(VersionStatus.IN_REVIEW)
    history = [v for status in _HISTORY_STATUSES for v in deps.store.by_status(status)]
    # A rejection sends the version back to draft; it stays listed until it is sent again.
    history.extend(
        v for v in deps.store.rejected() if v.status is VersionStatus.DRAFT and v.rejection_reason
    )
    history.sort(key=_decided_at, reverse=True)
    return ReviewsOut(
        queue=[_review_out(deps, caller, v, queued=True) for v in queue],
        history=[_review_out(deps, caller, v, queued=False) for v in history[:MAX_HISTORY]],
    )


def models_view(deps: AgentsDeps) -> ModelsOut:
    catalog = deps.models.catalog()
    return ModelsOut(
        version=catalog.version,
        items=[
            ModelOut(
                id=m.id,
                name=m.name,
                provider=m.provider,
                supports_tools=m.supports_tools,
                context_tokens=m.context_tokens,
                input_usd=str(m.input_usd),
                output_usd=str(m.output_usd),
            )
            for m in catalog.enabled
        ],
    )


# --- Use cases: drafts ------------------------------------------------------------------


def _ids(agent_id: str, number: int) -> dict[str, Any]:
    return {"agent": agent_id, "version": number}


def create_agent(deps: AgentsDeps, caller: Caller, body: CreateAgentIn) -> VersionOut:
    actor = caller.user.user_id
    # Generated here, never taken from the request; release slugs stay reserved (TM-M16).
    agent_id = new_agent_id()
    version = _audited(
        deps,
        "agent.created",
        caller,
        {
            **_ids(agent_id, 1),
            "created_by": actor,
            "content_hash": hash_content(dumps_definition(body.definition)),
        },
        lambda: deps.store.create_agent(
            body.definition,
            actor=actor,
            actor_email=caller.user.email,
            now=deps.clock(),
            agent_id=agent_id,
        ),
    )
    return _version_out(deps, caller, version)


def create_version(deps: AgentsDeps, caller: Caller, meta: AgentMeta) -> VersionOut:
    """New draft with the content of the published version; the published one keeps serving."""
    published = _published(deps, meta)
    if meta.status is not AgentStatus.PUBLISHED or published is None:
        raise ApiError(409, "version_conflict", "only a published agent gets a new version")
    actor = caller.user.user_id
    version = _audited(
        deps,
        "agent.version.created",
        caller,
        {
            **_ids(meta.agent_id, meta.latest_version + 1),
            "created_by": actor,
            "base_version": published.number,
        },
        lambda: deps.store.create_version(
            meta.agent_id,
            published.definition,
            actor=actor,
            actor_email=caller.user.email,
            now=deps.clock(),
        ),
    )
    return _version_out(deps, caller, version)


def get_version(deps: AgentsDeps, caller: Caller, agent_id: str, number: int) -> VersionOut:
    return _version_out(deps, caller, _require_version(deps, agent_id, number))


def _require_draft(version: AgentVersion, revision: int) -> None:
    if version.status is not VersionStatus.DRAFT:
        raise ApiError(409, "version_conflict", "only drafts can be changed")
    if version.revision != revision:
        raise ApiError(409, "version_conflict", "the draft changed; reload and try again")


def save_draft(
    deps: AgentsDeps, caller: Caller, agent_id: str, number: int, body: SaveDraftIn
) -> VersionOut:
    _require_draft(_require_version(deps, agent_id, number), body.revision)
    actor = caller.user.user_id
    _audited(
        deps,
        "agent.version.saved",
        caller,
        {
            **_ids(agent_id, number),
            "edited_by": actor,
            "revision": body.revision,
            "content_hash": hash_content(dumps_definition(body.definition)),
        },
        lambda: deps.store.save_draft(
            agent_id,
            number,
            revision=body.revision,
            definition=body.definition,
            actor=actor,
            now=deps.clock(),
        ),
    )
    return _version_out(deps, caller, _require_version(deps, agent_id, number))


def discard_draft(
    deps: AgentsDeps, caller: Caller, agent_id: str, number: int, revision: int
) -> None:
    version = _require_version(deps, agent_id, number)
    _require_draft(version, revision)
    _audited(
        deps,
        "agent.version.discarded",
        caller,
        {
            **_ids(agent_id, number),
            "created_by": version.created_by,
            "discarded_by": caller.user.user_id,
            "revision": revision,
        },
        lambda: deps.store.discard_draft(agent_id, number, revision=revision, now=deps.clock()),
    )


def submit(
    deps: AgentsDeps, caller: Caller, agent_id: str, number: int, body: SubmitIn
) -> VersionOut:
    """Validate the draft revision the caller saw and freeze exactly that content."""
    draft = _require_version(deps, agent_id, number)
    _require_draft(draft, body.revision)
    actor = caller.user.user_id

    def write() -> AgentVersion:
        violations = validate_for_review(agent_id, draft.definition, _rule_context(deps))
        if violations:
            raise ValidationFailedError(violations)
        # The store freezes ``revision`` only if the stored content is still ``draft``'s.
        return deps.store.submit(
            agent_id, number, revision=body.revision, actor=actor, now=deps.clock()
        )

    frozen = _audited(
        deps,
        "agent.version.submitted",
        caller,
        {
            **_ids(agent_id, number),
            "created_by": draft.created_by,
            "submitted_by": actor,
            "content_hash": hash_content(draft.canonical),
        },
        write,
    )
    return _version_out(deps, caller, frozen)


def reopen(deps: AgentsDeps, caller: Caller, agent_id: str, number: int) -> VersionOut:
    """A version whose publication failed goes back to draft to be corrected (spec §3)."""
    version = _require_version(deps, agent_id, number)
    if version.status is not VersionStatus.FAILED:
        raise ApiError(409, "version_conflict", "only a failed version can be reopened")
    _audited(
        deps,
        "agent.version.reopened",
        caller,
        {
            **_ids(agent_id, number),
            "reopened_by": caller.user.user_id,
            "content_hash": version.content_hash,
            "failed_step": version.failed_step,
        },
        lambda: deps.store.reopen_failed(agent_id, number, now=deps.clock()),
    )
    return _version_out(deps, caller, _require_version(deps, agent_id, number))


# --- Use cases: review ------------------------------------------------------------------


def _require_provisioner(deps: AgentsDeps) -> ProvisionerClient:
    if deps.provisioner is None:
        # Nothing is approved that could not be published afterwards.
        raise ApiError(503, "provisioner_unavailable", "publishing is not available yet")
    return deps.provisioner


def _start_provisioner(
    deps: AgentsDeps,
    caller: Caller,
    provisioner: ProvisionerClient,
    *,
    agent_id: str,
    number: int,
    content_hash: str,
) -> None:
    """Start publishing an approved version. If that fails the version becomes ``failed``
    (retryable by an administrator) instead of staying approved with nothing running."""
    actor, user = caller.user.user_id, caller.user
    detail = {**_ids(agent_id, number), "content_hash": content_hash}
    try:
        execution = provisioner.start(agent_id, number, content_hash)
    except ProvisionerError:
        logger.exception("provisioner start failed")
        deps.store.fail_start(agent_id, number, now=deps.clock())
        event, extra = "agent.version.failed", {"failed_step": START_STEP}
    else:
        event, extra = "agent.provisioner.started", {"execution": execution}
    try:
        deps.audit.emit(event, actor, {**detail, **extra}, user)
    except Exception:
        logger.exception("audit emit failed after starting the provisioner")


def approve(
    deps: AgentsDeps, caller: Caller, agent_id: str, number: int, body: HashIn
) -> VersionOut:
    version = _require_version(deps, agent_id, number)
    if version.status is not VersionStatus.IN_REVIEW:
        raise ApiError(409, "version_conflict", "the version is not in review")
    if version.content_hash != body.content_hash:
        raise ApiError(409, "version_conflict", "the version changed; review it again")
    provisioner = _require_provisioner(deps)
    actor = caller.user.user_id

    def write() -> None:
        if _is_author(version, actor):
            raise ApiError(403, "same_approver", "another administrator must review this version")
        if not verify_content(version.canonical, body.content_hash):
            raise ApiError(409, "version_conflict", "the stored content does not match its hash")
        violations = validate_for_review(
            agent_id, version.definition, _rule_context(deps, approving=True)
        )
        if violations:
            raise ValidationFailedError(violations)
        deps.store.approve(
            agent_id,
            number,
            content_hash=body.content_hash,
            approver=actor,
            approver_email=caller.user.email,
            now=deps.clock(),
        )

    _audited(
        deps,
        "agent.version.approved",
        caller,
        {
            **_ids(agent_id, number),
            "created_by": version.created_by,
            "submitted_by": version.submitted_by,
            "approved_by": actor,
            "content_hash": body.content_hash,
        },
        write,
    )
    _start_provisioner(
        deps,
        caller,
        provisioner,
        agent_id=agent_id,
        number=number,
        content_hash=body.content_hash,
    )
    return _version_out(deps, caller, _require_version(deps, agent_id, number))


def reject(
    deps: AgentsDeps, caller: Caller, agent_id: str, number: int, body: RejectIn
) -> VersionOut:
    version = _require_version(deps, agent_id, number)
    if version.status is not VersionStatus.IN_REVIEW:
        raise ApiError(409, "version_conflict", "the version is not in review")
    actor = caller.user.user_id

    def write() -> None:
        if _is_author(version, actor):
            raise ApiError(403, "same_approver", "another administrator must review this version")
        deps.store.reject(
            agent_id,
            number,
            rejected_by=actor,
            rejected_by_email=caller.user.email,
            reason=body.reason,
            now=deps.clock(),
        )

    _audited(
        deps,
        "agent.version.rejected",
        caller,
        {
            **_ids(agent_id, number),
            "created_by": version.created_by,
            "submitted_by": version.submitted_by,
            "rejected_by": actor,
            "content_hash": version.content_hash,
            "reason": body.reason,
        },
        write,
    )
    return _version_out(deps, caller, _require_version(deps, agent_id, number))


def retry(deps: AgentsDeps, caller: Caller, agent_id: str, number: int, body: HashIn) -> VersionOut:
    """Publish again a failed version: same content, same approver (spec §3).

    An ``approved`` version nothing is publishing any more (the execution timed out or was
    never started) is given up on first, so it does not stay approved forever.
    """
    version = _require_version(deps, agent_id, number)
    expired = version.approval_expired(deps.clock())
    if version.status is not VersionStatus.FAILED and not expired:
        raise ApiError(409, "version_conflict", "only a failed version can be retried")
    if version.content_hash != body.content_hash:
        raise ApiError(409, "version_conflict", "the version changed; review it again")
    provisioner = _require_provisioner(deps)

    def write() -> None:
        if expired:
            deps.store.expire_approved(
                agent_id, number, content_hash=body.content_hash, now=deps.clock()
            )
        deps.store.retry_failed(agent_id, number, content_hash=body.content_hash, now=deps.clock())

    _audited(
        deps,
        "agent.version.retried",
        caller,
        {
            **_ids(agent_id, number),
            "approved_by": version.approved_by,
            "retried_by": caller.user.user_id,
            "content_hash": body.content_hash,
            "failed_step": EXPIRED_STEP if expired else version.failed_step,
        },
        write,
    )
    _start_provisioner(
        deps,
        caller,
        provisioner,
        agent_id=agent_id,
        number=number,
        content_hash=body.content_hash,
    )
    return _version_out(deps, caller, _require_version(deps, agent_id, number))


def _start_deprovisioner(
    deps: AgentsDeps, caller: Caller, agent_id: str, number: int
) -> CleanupStatus | None:
    """Start deleting the harness and the role of an agent that was just retired (D48).

    The retirement is already committed and audited, and the agent no longer takes turns: a
    start that fails does not undo it. What is left in AWS is then reported by the daily
    reconciliation until an operator starts the execution again.
    """
    if deps.deprovisioner is None:
        return None
    actor, user = caller.user.user_id, caller.user
    status: CleanupStatus
    try:
        execution = deps.deprovisioner.start(agent_id)
    except ProvisionerError:
        logger.exception("deprovisioner start failed")
        event, extra, status = "agent.deprovisioner.start_failed", {}, "failed"
    else:
        event, extra, status = "agent.deprovisioner.started", {"execution": execution}, "running"
    try:
        deps.audit.emit(event, actor, {**_ids(agent_id, number), **extra}, user)
    except Exception:
        logger.exception("audit emit failed after starting the deprovisioner")
    return status


def retire(deps: AgentsDeps, caller: Caller, meta: AgentMeta, body: RetireIn) -> AgentOut:
    if meta.status is not AgentStatus.PUBLISHED or meta.published_version is None:
        raise ApiError(409, "version_conflict", "only a published agent can be retired")
    actor = caller.user.user_id
    _audited(
        deps,
        "agent.retired",
        caller,
        {
            **_ids(meta.agent_id, meta.published_version),
            "created_by": meta.created_by,
            "retired_by": actor,
            "reason": body.reason,
        },
        lambda: deps.store.retire(
            meta.agent_id,
            version=body.lock_version,
            actor=actor,
            actor_email=caller.user.email,
            reason=body.reason,
            now=deps.clock(),
        ),
    )
    # This task stops serving it at once; the others within ``published.CACHE_SECONDS``.
    if deps.published is not None:
        deps.published.invalidate(meta.agent_id)
    cleanup = _start_deprovisioner(deps, caller, meta.agent_id, meta.published_version)
    retired = _require_version(deps, meta.agent_id, meta.published_version)
    return _agent_out(
        retired,
        deps.store.meta(meta.agent_id),
        is_mine=_is_mine(caller.user, meta),
        # Only administrators retire (`RetireAgent`), so this never reaches anyone else.
        cleanup=cleanup if caller.user.is_admin else None,
    )


# --- Routes -----------------------------------------------------------------------------


Authorize = Callable[..., Awaitable[None]]


@dataclass(frozen=True)
class AgentCaller:
    """A caller already authorized for an action on an existing agent."""

    caller: Caller
    meta: AgentMeta


def agents_router(  # noqa: PLR0915 - router factory registering route closures
    deps: AgentsDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    router = APIRouter(prefix="/api")
    CallerDep = Annotated[Caller, Depends(current_user)]  # noqa: N806
    AgentId = Annotated[str, Path(pattern=AGENT_ID_PATTERN)]  # noqa: N806
    Number = Annotated[int, Path(ge=1, le=MAX_VERSION)]  # noqa: N806

    async def run[T](fn: Callable[..., T], *args: Any) -> T:
        try:
            return await asyncio.to_thread(fn, *args)
        except Exception as exc:
            error = _api_error(exc, deps.clock())
            if error is None or error is exc:
                raise
            raise error from exc

    def platform_action(
        action: str, *, read_only: bool = False
    ) -> Callable[..., Awaitable[Caller]]:
        async def dependency(caller: CallerDep) -> Caller:
            await authorize(caller, action, *PLATFORM, read_only=read_only)
            user = caller.user
            # Defense in depth: the Cedar policies already require these.
            permitted = user.is_admin or (action != "ApproveAgent" and user.is_agent_creator)
            if not permitted:
                raise ApiError(403, "forbidden", "not allowed")
            return caller

        return dependency

    def agent_action(
        action: str, *, read_only: bool = False, or_review: bool = False
    ) -> Callable[..., Awaitable[AgentCaller]]:
        """Authorization on one agent. The Agent entity comes from the table; an agent that
        does not exist is denied like any other to whoever could not act on it."""

        async def dependency(agent_id: AgentId, caller: CallerDep) -> AgentCaller:
            meta = await run(deps.store.meta, agent_id)
            resource = AgentResource(agent_id, creator=meta.created_by if meta else None)
            user = caller.user
            chosen = action
            if or_review and not await asyncio.to_thread(
                deps.authorizer.is_allowed, user, action, AGENT_TYPE, agent_id, resource
            ):
                # Reviewers read what they review without being able to edit it.
                chosen = "ApproveAgent"
            await authorize(
                caller, chosen, AGENT_TYPE, agent_id, read_only=read_only, agent=resource
            )
            # Defense in depth: the Cedar policies already require these.
            owner = meta is not None and user.is_agent_creator and meta.created_by == user.user_id
            if not (user.is_admin or (chosen == "EditAgent" and owner)):
                raise ApiError(403, "forbidden", "not allowed")
            if meta is None:
                raise ApiError(404, "not_found", "not found")
            return AgentCaller(caller, meta)

        return dependency

    Create = Annotated[Caller, Depends(platform_action("CreateAgent"))]  # noqa: N806
    CreateRead = Annotated[  # noqa: N806
        Caller, Depends(platform_action("CreateAgent", read_only=True))
    ]
    ReviewQueue = Annotated[  # noqa: N806
        Caller, Depends(platform_action("ApproveAgent", read_only=True))
    ]
    Edit = Annotated[AgentCaller, Depends(agent_action("EditAgent"))]  # noqa: N806
    Read = Annotated[  # noqa: N806
        AgentCaller, Depends(agent_action("EditAgent", read_only=True, or_review=True))
    ]
    Approve = Annotated[AgentCaller, Depends(agent_action("ApproveAgent"))]  # noqa: N806
    Retire = Annotated[AgentCaller, Depends(agent_action("RetireAgent"))]  # noqa: N806

    # Fixed paths first: `mine`, `reviews` and `org` would also match `{agent_id}`, so no
    # release agent may use those slugs.

    @router.get("/agents", response_model=AgentList)
    async def get_agents(caller: CallerDep) -> AgentList:
        return await run(list_agents, deps, caller)

    @router.get("/agents/mine", response_model=MineOut)
    async def get_mine(caller: CreateRead) -> MineOut:
        return await run(mine, deps, caller)

    @router.get("/agents/reviews", response_model=ReviewsOut)
    async def get_reviews(caller: ReviewQueue) -> ReviewsOut:
        return await run(reviews, deps, caller)

    @router.get("/agents/org", response_model=OrgOut)
    async def get_org(caller: CallerDep) -> OrgOut:
        return await run(organization, deps, caller)

    @router.post("/agents", response_model=VersionOut, status_code=201)
    async def post_agent(body: CreateAgentIn, caller: Create) -> VersionOut:
        return await run(create_agent, deps, caller, body)

    @router.get("/agents/{agent_id}", response_model=AgentOut)
    async def get_agent(agent_id: AgentId, caller: CallerDep) -> AgentOut:
        # Same permission as chatting with it, on the same version the chat serves. Unknown,
        # unpublished and forbidden agents all get the same 403: the Agent entity then has no
        # attributes and nobody matches.
        meta = await run(deps.store.meta, agent_id)
        published = await run(_served_version, deps, meta) if meta else None
        resource = _use_resource(published) if published else AgentResource(agent_id)
        await authorize(caller, "UseAgent", AGENT_TYPE, agent_id, read_only=True, agent=resource)
        if meta is None or published is None:
            raise ApiError(404, "not_found", "not found")
        return _agent_out(
            published,
            meta,
            await run(_packs_catalog, deps),
            is_mine=_is_mine(caller.user, meta),
        )

    @router.post("/agents/{agent_id}/versions", response_model=VersionOut, status_code=201)
    async def post_version(_body: EmptyIn, who: Edit) -> VersionOut:
        return await run(create_version, deps, who.caller, who.meta)

    @router.get("/agents/{agent_id}/versions/{version}", response_model=VersionOut)
    async def read_version(version: Number, who: Read) -> VersionOut:
        return await run(get_version, deps, who.caller, who.meta.agent_id, version)

    @router.put("/agents/{agent_id}/versions/{version}", response_model=VersionOut)
    async def put_version(version: Number, body: SaveDraftIn, who: Edit) -> VersionOut:
        return await run(save_draft, deps, who.caller, who.meta.agent_id, version, body)

    @router.delete("/agents/{agent_id}/versions/{version}", status_code=204)
    async def delete_version(
        version: Number, revision: Annotated[int, Query(ge=1, le=1_000_000)], who: Edit
    ) -> Response:
        await run(discard_draft, deps, who.caller, who.meta.agent_id, version, revision)
        return Response(status_code=204)

    @router.post("/agents/{agent_id}/versions/{version}/submit", response_model=VersionOut)
    async def submit_version(version: Number, body: SubmitIn, who: Edit) -> VersionOut:
        return await run(submit, deps, who.caller, who.meta.agent_id, version, body)

    @router.post("/agents/{agent_id}/versions/{version}/reopen", response_model=VersionOut)
    async def reopen_version(version: Number, _body: EmptyIn, who: Edit) -> VersionOut:
        return await run(reopen, deps, who.caller, who.meta.agent_id, version)

    @router.post("/agents/{agent_id}/versions/{version}/approve", response_model=VersionOut)
    async def approve_version(version: Number, body: HashIn, who: Approve) -> VersionOut:
        return await run(approve, deps, who.caller, who.meta.agent_id, version, body)

    @router.post("/agents/{agent_id}/versions/{version}/reject", response_model=VersionOut)
    async def reject_version(version: Number, body: RejectIn, who: Approve) -> VersionOut:
        return await run(reject, deps, who.caller, who.meta.agent_id, version, body)

    @router.post("/agents/{agent_id}/versions/{version}/retry", response_model=VersionOut)
    async def retry_version(version: Number, body: HashIn, who: Approve) -> VersionOut:
        return await run(retry, deps, who.caller, who.meta.agent_id, version, body)

    @router.post("/agents/{agent_id}/retire", response_model=AgentOut)
    async def retire_agent(body: RetireIn, who: Retire) -> AgentOut:
        return await run(retire, deps, who.caller, who.meta, body)

    @router.get("/models", response_model=ModelsOut)
    async def get_models(_caller: CreateRead) -> ModelsOut:
        return await run(models_view, deps)

    return router
