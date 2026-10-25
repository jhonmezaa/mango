"""Construir > Skills: skills of instructions only with an approval per version (D92; threat
model ``skills-threat-model.md``).

Administrators and agent creators see the catalog and propose skills and new versions of them;
an administrator **other than** whoever proposed approves each version. An approved version is
immutable: its ``SKILL.md`` is written once to the skills bucket and agents name it by version
(``AgentDefinition.skills``), so a new version reaches an agent with that agent's next approved
version. Skills with scripts are not built (D25, D26): agents never get ``shell``.

Security notes (security-best-practices, FastAPI):
* Every route declares its Cedar action (``ViewSkills``, ``ProposeSkill``, ``ApproveSkill``);
  the role is re-checked in process (AUTH-001, AUTHZ-001).
* Whoever proposes never approves nor rejects (only withdraws); the table repeats the check in
  the approval's condition. Refusals are audited.
* Fail-closed audit: ``requested`` is recorded before any write. The text of a skill never goes
  to the audit or the logs: ids, versions and the hash of its ``SKILL.md`` only.
* The text is checked for secrets (D26) and normalized like a system prompt
  (``mango_core.skills``); the frontmatter of the ``SKILL.md`` is built by mango-api.
* Bodies forbid extra fields and responses use explicit models (VALID-001, RESP-001).
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
import re
import unicodedata
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal, NoReturn, Protocol

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from mango_api.agent_rules import find_secrets
from mango_api.agents_store import AgentVersion
from mango_api.audit import AuditLog
from mango_api.mcp_catalog import InvalidCatalogError, McpCatalog
from mango_api.probe import RateLimiter
from mango_api.rate_limits import Limiter
from mango_api.skills_store import (
    ConflictError,
    SkillChange,
    SkillMeta,
    SkillStore,
    SkillVersion,
    StoredSkillError,
    iso,
    new_change_id,
)
from mango_api.web import ApiError, Caller, rate_limited
from mango_core.agents import InvalidDefinitionError, VersionStatus
from mango_core.skills import (
    CATEGORIES,
    MAX_DESCRIPTION_CHARS,
    MAX_ID_CHARS,
    MAX_INSTRUCTIONS_CHARS,
    MAX_NAME_CHARS,
    MAX_PER_AGENT,
    SKILL_ID_PATTERN,
    SKILL_REF_PATTERN,
    SkillContent,
    is_skill_id,
    parse_ref,
    variables,
)

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
CHANGE_LIFETIME = timedelta(hours=72)  # the design shows 72 h for requests nobody approved
LIST_WINDOW = timedelta(days=30)
"""Closed requests the catalog still shows."""
CHANGE_ID_PATTERN = r"^[0-9a-f]{32}$"
MAX_SKILLS = 200
"""Skills of an installation, approved or waiting for their first approval."""
MAX_PENDING = 20
PROPOSALS_PER_HOUR = 20
"""Per person, counted once across mango-api's tasks (``limits.py``)."""
READS_PER_MINUTE = 60
"""Per person: the catalog reads 30 days of activations on every load."""
MAX_REASON_CHARS = 500

DataTier = Literal["public", "account_data", "write"]
_TIER_RANK: dict[str, int] = {"public": 0, "account_data": 1, "write": 2}


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EmptyIn(_Strict):
    pass


class SkillContentIn(_Strict):
    name: Annotated[str, Field(min_length=1, max_length=MAX_NAME_CHARS * 2)]
    category: Annotated[str, Field(max_length=24)]
    description: Annotated[str, Field(max_length=MAX_DESCRIPTION_CHARS * 2)] = ""
    instructions: Annotated[str, Field(min_length=1, max_length=MAX_INSTRUCTIONS_CHARS * 2)]
    outputs: Annotated[list[Annotated[str, Field(max_length=80)]], Field(max_length=10)] = []
    servers: Annotated[
        list[Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{0,47}$")]],
        Field(min_length=1, max_length=10),
    ]
    reason: Annotated[str, Field(min_length=1, max_length=MAX_REASON_CHARS)]


class NewSkillIn(SkillContentIn):
    duplicate_of: Annotated[str, Field(pattern=SKILL_REF_PATTERN)] | None = None
    """``<id>@<version>`` of the approved version it copies («Duplicar como instrucciones»)."""


class NewVersionIn(SkillContentIn):
    base_version: Annotated[int, Field(ge=1, le=9999)]
    """Approved version the proposal starts from (optimistic locking)."""


class RejectIn(_Strict):
    reason: Annotated[str, Field(min_length=1, max_length=MAX_REASON_CHARS)]


class SkillServerOut(_Strict):
    id: str
    name: str | None
    """``None``: the server is not in the catalog."""
    enabled: bool
    data_tier: DataTier | None
    tools: int
    writes: bool
    """It has write tools: each use asks for confirmation or approval."""


class SkillChangeOut(_Strict):
    change_id: str
    skill_id: str
    version: int
    status: Literal["pending", "approved", "rejected", "withdrawn", "expired"]
    name: str
    category: str
    description: str
    instructions: str
    outputs: list[str]
    servers: list[str]
    variables: list[str]
    reason: str
    proposed_by: str
    proposed_by_email: str | None
    created_at: str
    expires_at: str
    duplicate_of: str | None
    decided_by: str | None
    decided_by_email: str | None
    decided_at: str | None
    note: str | None
    own: bool
    """The caller proposed it: they may withdraw it, never approve or reject it."""


class SkillOut(_Strict):
    id: str
    name: str
    category: str
    description: str
    version: int
    servers: list[SkillServerOut]
    data_tier: DataTier
    """The highest of its servers (``public`` without any known)."""
    writes: bool
    available: bool
    """Every server it relies on is enabled."""
    agents: int
    """Published agents that use it."""
    outdated_agents: int
    """Of those, the ones that use an earlier version."""
    runs_30d: int
    owner: str | None
    owner_email: str | None
    updated_by: str | None
    updated_by_email: str | None
    updated_at: str | None
    pending: SkillChangeOut | None


class SkillsOut(_Strict):
    items: list[SkillOut]
    changes: list[SkillChangeOut]
    """Requests of the last 30 days, newest first (new skills and new versions)."""
    categories: list[str]
    max_per_agent: int
    can_approve: bool


class SkillAgentOut(_Strict):
    id: str
    name: str
    agent_version: int
    skill_version: int


class SkillVersionOut(_Strict):
    version: int
    proposed_by: str
    proposed_by_email: str | None
    approved_by: str
    approved_by_email: str | None
    approved_at: str
    markdown_sha256: str


class SkillDetailOut(_Strict):
    skill: SkillOut
    instructions: str
    outputs: list[str]
    variables: list[str]
    agents_using: list[SkillAgentOut]
    versions: list[SkillVersionOut]
    changes: list[SkillChangeOut]


class ChangeCreatedOut(_Strict):
    skill_id: str
    change_id: str


# --- Use cases --------------------------------------------------------------------------


class LiveAgents(Protocol):
    def by_status(self, status: VersionStatus) -> list[AgentVersion]: ...


@dataclass
class SkillsDeps:
    store: SkillStore
    agents: LiveAgents
    catalog: Callable[[], McpCatalog]
    audit: AuditLog
    rate_limiter: Limiter
    clock: Callable[[], datetime]
    reads: Limiter = field(default_factory=lambda: RateLimiter(READS_PER_MINUTE, 60))


def _require_role(caller: Caller) -> None:
    """Defense in depth: the Cedar policies already require it."""
    if not (caller.user.is_admin or caller.user.is_agent_creator):
        raise ApiError(403, "forbidden", "not allowed")


def _unavailable(exc: Exception) -> ApiError:
    logger.warning("skills storage failed: %s", type(exc).__name__)
    return ApiError(503, "skills_unavailable", "please try again")


def _catalog(deps: SkillsDeps) -> McpCatalog:
    try:
        return deps.catalog()
    except (ClientError, BotoCoreError, InvalidCatalogError) as exc:
        raise ApiError(503, "catalog_unavailable", "please try again") from exc


def _published(deps: SkillsDeps) -> list[AgentVersion]:
    try:
        return deps.agents.by_status(VersionStatus.PUBLISHED)
    except (ClientError, BotoCoreError, InvalidDefinitionError) as exc:
        raise ApiError(503, "agents_unavailable", "please try again") from exc


def _servers(catalog: McpCatalog, server_ids: tuple[str, ...]) -> list[SkillServerOut]:
    out: list[SkillServerOut] = []
    for server_id in server_ids:
        server = catalog.server(server_id)
        if server is None:
            out.append(
                SkillServerOut(
                    id=server_id, name=None, enabled=False, data_tier=None, tools=0, writes=False
                )
            )
            continue
        tools = catalog.tools_of(server)
        out.append(
            SkillServerOut(
                id=server_id,
                name=server.name,
                enabled=catalog.server_enabled(server_id),
                data_tier=server.data_tier.value,
                tools=len(tools),
                writes=any(t.is_write for t in tools),
            )
        )
    return out


def _tier(servers: list[SkillServerOut]) -> DataTier:
    tier: DataTier = "public"
    for server in servers:
        if server.data_tier is not None and _TIER_RANK[server.data_tier] > _TIER_RANK[tier]:
            tier = server.data_tier
    return tier


def _change_out(change: SkillChange, caller: Caller, now: datetime) -> SkillChangeOut:
    status: Any = (
        "expired" if change.status == "pending" and now >= change.expires_at else change.status
    )
    content = change.content
    return SkillChangeOut(
        change_id=change.change_id,
        skill_id=change.skill_id,
        version=change.version,
        status=status,
        name=content.name,
        category=content.category,
        description=content.description,
        instructions=content.instructions,
        outputs=list(content.outputs),
        servers=list(content.servers),
        variables=variables(content.instructions),
        reason=change.reason,
        proposed_by=change.proposed_by,
        proposed_by_email=change.proposed_by_email,
        created_at=iso(change.created_at),
        expires_at=iso(change.expires_at),
        duplicate_of=change.duplicate_of,
        decided_by=change.decided_by,
        decided_by_email=change.decided_by_email,
        decided_at=iso(change.decided_at) if change.decided_at else None,
        note=change.note,
        own=change.proposed_by == caller.user.user_id,
    )


def _usage(published: list[AgentVersion]) -> dict[str, list[tuple[AgentVersion, int]]]:
    """Published agents by skill id, with the version of the skill each one uses."""
    by_skill: dict[str, list[tuple[AgentVersion, int]]] = {}
    for agent in published:
        for ref in agent.definition.skills:
            skill_id, number = parse_ref(ref)
            by_skill.setdefault(skill_id, []).append((agent, number))
    return by_skill


def _skill_out(
    meta: SkillMeta,
    *,
    catalog: McpCatalog,
    using: list[tuple[AgentVersion, int]],
    runs: int,
    pending: SkillChange | None,
    caller: Caller,
    now: datetime,
) -> SkillOut:
    servers = _servers(catalog, meta.servers)
    return SkillOut(
        id=meta.skill_id,
        name=meta.name,
        category=meta.category,
        description=meta.description,
        version=meta.version,
        servers=servers,
        data_tier=_tier(servers),
        writes=any(s.writes for s in servers),
        available=all(s.enabled for s in servers),
        agents=len(using),
        outdated_agents=sum(1 for _, number in using if number < meta.version),
        runs_30d=runs,
        owner=meta.owner,
        owner_email=meta.owner_email,
        updated_by=meta.updated_by,
        updated_by_email=meta.updated_by_email,
        updated_at=iso(meta.updated_at) if meta.updated_at else None,
        pending=_change_out(pending, caller, now) if pending else None,
    )


def _open(change: SkillChange, now: datetime) -> bool:
    return change.status == "pending" and now < change.expires_at


def _read(deps: SkillsDeps, caller: Caller) -> None:
    actor = caller.user.user_id
    if not deps.reads.allow(actor):
        raise rate_limited(deps.reads.retry_after(actor))


def list_skills(deps: SkillsDeps, caller: Caller) -> SkillsOut:
    now = deps.clock()
    catalog = _catalog(deps)
    usage = _usage(_published(deps))
    try:
        metas = [m for m in deps.store.catalog() if m.version > 0]
        changes = [c for c in deps.store.changes() if c.created_at >= now - LIST_WINDOW]
        runs = deps.store.runs(now)
    except (ClientError, BotoCoreError, StoredSkillError) as exc:
        raise _unavailable(exc) from exc
    pending = {c.skill_id: c for c in changes if _open(c, now) and not c.is_new}
    return SkillsOut(
        items=[
            _skill_out(
                meta,
                catalog=catalog,
                using=usage.get(meta.skill_id, []),
                runs=runs.get(meta.skill_id, 0),
                pending=pending.get(meta.skill_id),
                caller=caller,
                now=now,
            )
            for meta in sorted(metas, key=lambda m: (m.name.casefold(), m.skill_id))
        ],
        changes=[_change_out(c, caller, now) for c in changes],
        categories=list(CATEGORIES),
        max_per_agent=MAX_PER_AGENT,
        can_approve=caller.user.is_admin,
    )


def get_skill(deps: SkillsDeps, caller: Caller, skill_id: str) -> SkillDetailOut:
    now = deps.clock()
    try:
        meta = deps.store.meta(skill_id)
        if meta is None or meta.version == 0:
            raise ApiError(404, "not_found", "skill not found")
        versions = deps.store.versions(skill_id)
        changes = [
            c
            for c in deps.store.changes()
            if c.skill_id == skill_id and c.created_at >= now - LIST_WINDOW
        ]
        runs = deps.store.runs(now).get(skill_id, 0)
    except (ClientError, BotoCoreError, StoredSkillError) as exc:
        raise _unavailable(exc) from exc
    current = next((v for v in versions if v.version == meta.version), None)
    if current is None:
        raise _unavailable(StoredSkillError("approved version missing"))
    using = _usage(_published(deps)).get(skill_id, [])
    pending = next((c for c in changes if _open(c, now)), None)
    skill = _skill_out(
        meta,
        catalog=_catalog(deps),
        using=using,
        runs=runs,
        pending=pending,
        caller=caller,
        now=now,
    )
    return SkillDetailOut(
        skill=skill,
        instructions=current.content.instructions,
        outputs=list(current.content.outputs),
        variables=variables(current.content.instructions),
        agents_using=[
            SkillAgentOut(
                id=agent.agent_id,
                name=agent.definition.name,
                agent_version=agent.number,
                skill_version=number,
            )
            for agent, number in sorted(using, key=lambda u: u[0].definition.name.casefold())
        ],
        versions=[
            SkillVersionOut(
                version=v.version,
                proposed_by=v.proposed_by,
                proposed_by_email=v.proposed_by_email,
                approved_by=v.approved_by,
                approved_by_email=v.approved_by_email,
                approved_at=iso(v.approved_at),
                markdown_sha256=v.markdown_sha256,
            )
            for v in reversed(versions)
        ],
        changes=[_change_out(c, caller, now) for c in changes],
    )


def skill_id_of(name: str) -> str:
    """Id of a new skill, from its name (the design's rule): no accents, lowercase, runs of
    anything else become one hyphen, at most 40 characters."""
    folded = unicodedata.normalize("NFD", name)
    plain = "".join(ch for ch in folded if unicodedata.category(ch) != "Mn").lower()
    slug = re.sub(r"[^a-z0-9]+", "-", plain).strip("-")[:MAX_ID_CHARS]
    return slug.strip("-")


def _content(body: SkillContentIn) -> SkillContent:
    if not body.reason.strip():
        raise ApiError(
            422, "invalid_request", "invalid fields: reason", extra={"fields": ["reason"]}
        )
    try:
        return SkillContent(
            name=body.name,
            category=body.category,
            description=body.description,
            instructions=body.instructions,
            outputs=tuple(body.outputs),
            servers=tuple(body.servers),
        )
    except ValidationError as exc:
        fields = sorted({str(error["loc"][0]) for error in exc.errors() if error["loc"]})
        raise ApiError(
            422, "invalid_request", "invalid fields: " + ", ".join(fields), extra={"fields": fields}
        ) from None


def _check_content(content: SkillContent, catalog: McpCatalog) -> None:
    """Secrets (D26) and the MCP servers it relies on: they exist and are enabled now."""
    texts = {
        "name": content.name,
        "description": content.description,
        "instructions": content.instructions,
        "outputs": "\n".join(content.outputs),
    }
    found = {field: kinds for field, text in texts.items() if (kinds := find_secrets(text))}
    if found:
        # Only the field and the kind of credential: never the match.
        raise ApiError(
            422,
            "secret_detected",
            "a possible secret was found; remove it",
            extra={
                "fields": sorted(found),
                "kinds": sorted({k for v in found.values() for k in v}),
            },
        )
    off = [s for s in content.servers if not catalog.server_enabled(s)]
    if off:
        raise ApiError(
            422, "server_not_enabled", "an MCP server is not enabled", extra={"servers": off}
        )


def _refuse(
    deps: SkillsDeps, event: str, caller: Caller, detail: dict[str, Any], err: ApiError
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
        logger.exception("audit emit failed for a refused skill decision")
    raise err


def _audited[T](
    deps: SkillsDeps, event: str, caller: Caller, detail: dict[str, Any], write: Callable[[], T]
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
            logger.exception("audit emit failed after a rejected skill change")
        raise
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "applied"}, user)
    except Exception:
        logger.exception("audit emit failed after an applied skill change")
    return result


def _detail(change: SkillChange) -> dict[str, Any]:
    # Ids and versions only: the text of a skill never goes to the audit.
    detail: dict[str, Any] = {
        "change_id": change.change_id,
        "skill": change.skill_id,
        "version": change.version,
        "proposed_by": change.proposed_by,
        "servers": list(change.content.servers),
    }
    if change.duplicate_of:
        detail["duplicate_of"] = change.duplicate_of
    return detail


def _propose(
    deps: SkillsDeps,
    caller: Caller,
    *,
    skill_id: str,
    version: int,
    content: SkillContent,
    reason: str,
    duplicate_of: str | None,
) -> ChangeCreatedOut:
    now = deps.clock()
    change = SkillChange(
        change_id=new_change_id(),
        skill_id=skill_id,
        version=version,
        content=content,
        status="pending",
        proposed_by=caller.user.user_id,
        proposed_by_email=caller.user.email,
        reason=reason.strip(),
        created_at=now,
        expires_at=now + CHANGE_LIFETIME,
        duplicate_of=duplicate_of,
    )

    def write() -> None:
        try:
            deps.store.propose(change, base_version=version - 1, now=now)
        except ConflictError as exc:
            if change.is_new:
                raise ApiError(409, "skill_exists", "a skill with that name exists") from exc
            raise ApiError(
                409, "already_pending", "the skill changed or has an open request"
            ) from exc

    _audited(deps, "skills.proposed", caller, {**_detail(change), "reason": change.reason}, write)
    return ChangeCreatedOut(skill_id=skill_id, change_id=change.change_id)


def _limits(deps: SkillsDeps, caller: Caller, now: datetime) -> list[SkillChange]:
    actor = caller.user.user_id
    if not deps.rate_limiter.allow(actor):
        raise rate_limited(deps.rate_limiter.retry_after(actor))
    try:
        changes = deps.store.changes()
    except (ClientError, BotoCoreError, StoredSkillError) as exc:
        raise _unavailable(exc) from exc
    if sum(1 for c in changes if _open(c, now)) >= MAX_PENDING:
        raise ApiError(409, "too_many_pending", "too many pending requests; resolve some first")
    return changes


def propose_skill(deps: SkillsDeps, caller: Caller, body: NewSkillIn) -> ChangeCreatedOut:
    _require_role(caller)
    content = _content(body)
    skill_id = skill_id_of(content.name)
    if not is_skill_id(skill_id):
        raise ApiError(422, "invalid_request", "invalid fields: name", extra={"fields": ["name"]})
    now = deps.clock()
    changes = _limits(deps, caller, now)
    _check_content(content, _catalog(deps))
    try:
        metas = deps.store.catalog()
        if body.duplicate_of is not None:
            source_id, source_version = parse_ref(body.duplicate_of)
            if deps.store.version(source_id, source_version) is None:
                raise ApiError(404, "not_found", "the skill to duplicate was not found")
    except (ClientError, BotoCoreError, StoredSkillError) as exc:
        raise _unavailable(exc) from exc
    if any(m.skill_id == skill_id and (m.version > 0 or m.locked(now)) for m in metas):
        raise ApiError(409, "skill_exists", "a skill with that name exists")
    waiting = {c.skill_id for c in changes if c.is_new and _open(c, now)}
    if len({m.skill_id for m in metas if m.version > 0} | waiting) >= MAX_SKILLS:
        raise ApiError(409, "too_many_skills", "the installation has too many skills")
    return _propose(
        deps,
        caller,
        skill_id=skill_id,
        version=1,
        content=content,
        reason=body.reason,
        duplicate_of=body.duplicate_of,
    )


def propose_version(
    deps: SkillsDeps, caller: Caller, skill_id: str, body: NewVersionIn
) -> ChangeCreatedOut:
    _require_role(caller)
    content = _content(body)
    now = deps.clock()
    _limits(deps, caller, now)
    try:
        meta = deps.store.meta(skill_id)
    except (ClientError, BotoCoreError, StoredSkillError) as exc:
        raise _unavailable(exc) from exc
    if meta is None or meta.version == 0:
        raise ApiError(404, "not_found", "skill not found")
    if meta.version != body.base_version:
        raise ApiError(409, "version_conflict", "the skill changed; reload and try again")
    if meta.locked(now):
        raise ApiError(409, "already_pending", "there is already an open request for this skill")
    _check_content(content, _catalog(deps))
    return _propose(
        deps,
        caller,
        skill_id=skill_id,
        version=meta.version + 1,
        content=content,
        reason=body.reason,
        duplicate_of=None,
    )


def _open_change(deps: SkillsDeps, change_id: str) -> SkillChange:
    try:
        change = deps.store.change(change_id)
    except (ClientError, BotoCoreError, StoredSkillError) as exc:
        raise _unavailable(exc) from exc
    if change is None:
        raise ApiError(404, "not_found", "request not found")
    if change.status != "pending":
        raise ApiError(409, "version_conflict", "the request is already closed")
    return change


def approve(deps: SkillsDeps, caller: Caller, change_id: str) -> SkillVersion:
    actor = caller.user.user_id
    event = "skills.approved"
    change = _open_change(deps, change_id)
    detail = {**_detail(change), "approved_by": actor}
    now = deps.clock()
    if now >= change.expires_at:
        raise ApiError(410, "expired", "the request expired")
    if change.proposed_by == actor:
        _refuse(
            deps,
            event,
            caller,
            detail,
            ApiError(403, "same_approver", "another administrator must approve this request"),
        )
    if not caller.user.is_admin:
        _refuse(deps, event, caller, detail, ApiError(403, "forbidden", "not allowed"))

    def write() -> SkillVersion:
        # The catalog may have changed while the request waited.
        _check_content(change.content, _catalog(deps))
        try:
            approved = deps.store.approve(
                change, approver=actor, approver_email=caller.user.email, now=now
            )
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the request changed; reload") from exc
        except (ClientError, BotoCoreError, StoredSkillError) as exc:
            raise _unavailable(exc) from exc
        detail["markdown_sha256"] = approved.markdown_sha256
        return approved

    return _audited(deps, event, caller, detail, write)


def reject(deps: SkillsDeps, caller: Caller, change_id: str, reason: str) -> None:
    actor = caller.user.user_id
    event = "skills.rejected"
    if not reason.strip():
        raise ApiError(
            422, "invalid_request", "invalid fields: reason", extra={"fields": ["reason"]}
        )
    change = _open_change(deps, change_id)
    detail = {**_detail(change), "rejected_by": actor, "reason": reason}
    if change.proposed_by == actor:
        # The proposer withdraws; rejecting is another administrator's decision.
        raise ApiError(403, "use_withdraw", "withdraw your own request instead")
    if not caller.user.is_admin:
        _refuse(deps, event, caller, detail, ApiError(403, "forbidden", "not allowed"))
    now = deps.clock()

    def write() -> None:
        try:
            deps.store.close(
                change,
                to="rejected",
                actor=actor,
                actor_email=caller.user.email,
                note=reason.strip(),
                now=now,
            )
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the request changed; reload") from exc

    _audited(deps, event, caller, detail, write)


def withdraw(deps: SkillsDeps, caller: Caller, change_id: str) -> None:
    actor = caller.user.user_id
    change = _open_change(deps, change_id)
    if change.proposed_by != actor:
        raise ApiError(403, "not_proposer", "only the proposer can withdraw this request")
    now = deps.clock()

    def write() -> None:
        try:
            deps.store.close(
                change, to="withdrawn", actor=actor, actor_email=None, note=None, now=now
            )
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the request changed; reload") from exc

    _audited(deps, "skills.withdrawn", caller, _detail(change), write)


# --- Routes -----------------------------------------------------------------------------


Authorize = Callable[..., Awaitable[None]]


def skills_router(
    deps: SkillsDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    router = APIRouter(prefix="/api/skills")

    def platform_action(
        action: str, *, read_only: bool = False
    ) -> Callable[[Caller], Awaitable[Caller]]:
        async def dependency(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
            await authorize(caller, action, *PLATFORM, read_only=read_only)
            _require_role(caller)
            return caller

        return dependency

    View = Annotated[Caller, Depends(platform_action("ViewSkills", read_only=True))]  # noqa: N806
    Propose = Annotated[Caller, Depends(platform_action("ProposeSkill"))]  # noqa: N806
    Approve = Annotated[Caller, Depends(platform_action("ApproveSkill"))]  # noqa: N806
    SkillId = Annotated[str, Path(pattern=SKILL_ID_PATTERN, max_length=MAX_ID_CHARS)]  # noqa: N806
    ChangeId = Annotated[str, Path(pattern=CHANGE_ID_PATTERN)]  # noqa: N806

    async def run[T](fn: Callable[..., T], *args: Any) -> T:
        try:
            return await asyncio.to_thread(fn, *args)
        except (ClientError, BotoCoreError, StoredSkillError) as exc:
            raise _unavailable(exc) from exc

    @router.get("", response_model=SkillsOut)
    async def get_skills(caller: View) -> SkillsOut:
        _read(deps, caller)
        return await run(list_skills, deps, caller)

    @router.get("/{skill_id}", response_model=SkillDetailOut)
    async def get_skill_detail(skill_id: SkillId, caller: View) -> SkillDetailOut:
        _read(deps, caller)
        return await run(get_skill, deps, caller, skill_id)

    @router.post("", response_model=ChangeCreatedOut, status_code=201)
    async def post_skill(body: NewSkillIn, caller: Propose) -> ChangeCreatedOut:
        return await run(propose_skill, deps, caller, body)

    @router.post("/{skill_id}/versions", response_model=ChangeCreatedOut, status_code=201)
    async def post_skill_version(
        skill_id: SkillId, body: NewVersionIn, caller: Propose
    ) -> ChangeCreatedOut:
        return await run(propose_version, deps, caller, skill_id, body)

    @router.post("/changes/{change_id}/approve", response_model=SkillsOut)
    async def approve_skill_change(
        change_id: ChangeId, _body: EmptyIn, caller: Approve
    ) -> SkillsOut:
        await run(approve, deps, caller, change_id)
        return await run(list_skills, deps, caller)

    @router.post("/changes/{change_id}/reject", response_model=SkillsOut)
    async def reject_skill_change(
        change_id: ChangeId, body: RejectIn, caller: Approve
    ) -> SkillsOut:
        await run(reject, deps, caller, change_id, body.reason)
        return await run(list_skills, deps, caller)

    @router.post("/changes/{change_id}/withdraw", response_model=SkillsOut)
    async def withdraw_skill_change(
        change_id: ChangeId, _body: EmptyIn, caller: Propose
    ) -> SkillsOut:
        await run(withdraw, deps, caller, change_id)
        return await run(list_skills, deps, caller)

    return router
