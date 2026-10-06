"""MCP catalog API (spec §4.4, §7; D19, D26, D36): connectors and packs, and the dual approval
that enables, reconfigures, updates or disables a pack.

mango-api only records decisions and starts the pack provisioner with identifiers; it never
creates the role, the runtime, the Gateway target or the Cedar policies of a pack.

Security notes (threat models ``marketplace-v1`` and ``mcp-pack-provisioner``;
security-best-practices, FastAPI):
* Every route declares an authorization dependency bound to its own Cedar action
  (``ViewMcpCatalog``, ``EnableMcp``, ``ApproveMcp``); the decision is audited and ``is_admin``
  is re-checked in process for the writes (AUTH-001, AUTHZ-001).
* Whoever asks does not approve (D19). Only who asked withdraws; rejecting is someone else's.
* A request carries only parameters of the signed manifest with values of their list
  (422 otherwise). Nothing in a request names IAM, a version, a file or an ARN: the version
  and the statement are the ones the release names, and the approval is refused if the
  release changed since the request (TM-M1, TM-M4).
* Optimistic locking with the enablement ``version``, also as DynamoDB conditions together
  with the expected status and no provisioner execution in progress.
* Bodies forbid extra fields; responses use explicit models. Who asked, why and the failure
  codes are only returned to administrators (RESP-001).
* Each write emits ``requested`` before and ``applied`` or ``rejected`` after; if the first
  cannot be recorded nothing is written (fail closed).
* Writes are rate limited per administrator and the number of enabled packs is capped
  (TM-M9).
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, ConfigDict, Field

from mango_api.agents import AgentsDeps
from mango_api.agents_store import AgentsStore
from mango_api.audit import AuditLog
from mango_api.authz import PLATFORM
from mango_api.mcp_catalog import (
    CatalogSource,
    InvalidCatalogError,
    McpCatalog,
    McpServer,
    PackState,
    required_service,
)
from mango_api.mcp_store import (
    CHANGE_LIFETIME,
    ChangeKind,
    ChangeStatus,
    Enablement,
    PackChange,
    PackConflictError,
    PackRecordError,
    PackStore,
    new_change_id,
    new_enablement_id,
)
from mango_api.probe import RateLimiter
from mango_api.provisioner import PackProvisionerClient, ProvisionerError
from mango_api.rate_limits import Limiter
from mango_api.web import ApiError, Caller, rate_limited
from mango_core.agents import InvalidDefinitionError, VersionStatus
from mango_packs.enablement import MAX_PACK_ID_CHARS, PACK_ID_PATTERN, PackStatus, iso
from mango_packs.manifest import PackManifest

logger = logging.getLogger(__name__)

MAX_ENABLED_PACKS = 10
"""Packs an installation may have enabled or being installed at once (TM-M9)."""
WRITES_PER_MINUTE = 10
STALLED_AFTER = timedelta(minutes=2)
"""An approved request whose execution has not taken the pack by then never started."""
CHANGE_ID_PATTERN = r"^[0-9a-f]{32}$"
_CONFIG_KEY = Field(pattern=r"^[a-z][a-z0-9_]{0,31}$")
_CONFIG_VALUE = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$")
MAX_CONFIG_KEYS = 20

EVENT_PROPOSED = "mcp.pack.request.proposed"
EVENT_APPROVED = "mcp.pack.request.approved"
EVENT_REJECTED = "mcp.pack.request.rejected"
EVENT_WITHDRAWN = "mcp.pack.request.withdrawn"
EVENT_RETRIED = "mcp.pack.retried"
EVENT_DISABLE = "mcp.pack.disable.requested"

PackDisplayStatus = Literal[
    "available", "pending", "installing", "enabled", "error", "disabling", "disabled"
]


# --- Bodies -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


LockVersion = Annotated[int, Field(ge=0, le=1_000_000)]
Config = Annotated[
    dict[Annotated[str, _CONFIG_KEY], Annotated[str, _CONFIG_VALUE]],
    Field(max_length=MAX_CONFIG_KEYS),
]
Reason = Annotated[str, Field(min_length=1, max_length=500)]


class EnableIn(_Strict):
    version: LockVersion
    """``lock_version`` of the pack as the caller saw it (0 if it was never requested)."""
    config: Config = {}
    reason: Reason | None = None


class ParamsIn(_Strict):
    version: LockVersion
    config: Config


class UpdateIn(_Strict):
    version: LockVersion
    config: Config | None = None
    """Parameters for the new version; the installed ones are kept when omitted."""


class RetryIn(_Strict):
    version: LockVersion


class DisableIn(_Strict):
    version: LockVersion
    reason: Reason


class EmptyIn(_Strict):
    pass


class RejectIn(_Strict):
    reason: Reason | None = None
    """Mandatory for a request to enable or update; optional for a change of parameters."""


# --- Responses --------------------------------------------------------------------------


class CatalogTool(_Strict):
    ref: str
    name: str
    description: str
    access: str
    audience: str
    central_groups_only: bool
    enabled: bool = True
    """False for a tool of a pack that is not installed (or that its installed version does
    not serve): it cannot be given to agents."""
    requires_service: str | None = None
    """Name of the AWS service the customer must turn on in the payer account for this tool
    to answer. Mango does not know whether it is on."""


class CatalogAgent(_Strict):
    id: str
    name: str
    category: str


class PackParam(_Strict):
    key: str
    description: str | None
    allowed: list[str]
    default: str
    value: str | None
    """Value in use; ``None`` while the pack is not installed."""


class PackUpdate(_Strict):
    """What moving from the installed version to the release's version changes."""

    version: str
    added_tools: list[str]
    removed_tools: list[str]
    added_permissions: list[str]
    removed_permissions: list[str]


class PackRequest(_Strict):
    change_id: str
    kind: ChangeKind
    pack_version: str
    config: dict[str, str]
    reason: str | None
    requested_by: str
    requested_by_email: str | None
    created_at: str
    expires_at: str
    own: bool
    """The caller made it: they may withdraw it, never approve or reject it."""


class PackDecision(_Strict):
    change_id: str
    kind: ChangeKind
    decided_by: str | None
    decided_by_email: str | None
    decided_at: str | None
    reason: str | None


class PackOut(_Strict):
    status: PackDisplayStatus
    version: str
    """Version of the release: the one a request installs."""
    installed_version: str | None
    """Version that serves now. With ``status: error`` it is the previous one, still on."""
    lock_version: int
    """Send it back as ``version`` in every write (optimistic locking)."""
    params: list[PackParam]
    update: PackUpdate | None
    # Administrators only (``None`` for everyone else).
    pending: PackRequest | None = None
    last_rejected: PackDecision | None = None
    status_at: str | None = None
    failed_step: str | None = None
    failure: str | None = None
    """Error code of the provisioner, never an AWS message."""
    requested_by: str | None = None
    requested_by_email: str | None = None
    requested_at: str | None = None
    approved_by: str | None = None
    approved_by_email: str | None = None
    approved_at: str | None = None
    disabled_by: str | None = None
    disabled_by_email: str | None = None
    disabled_at: str | None = None
    disable_reason: str | None = None


class CatalogConnector(_Strict):
    id: str
    kind: str
    name: str
    description: str
    provider: str
    data_tier: str
    identity_mode: str
    enabled: bool
    permissions: list[str]
    tools: list[CatalogTool]
    agents: list[CatalogAgent] = []
    """Published agents that use tools of this server."""
    pack: PackOut | None = None
    """Set for ``kind: pack``."""


class CatalogOut(_Strict):
    items: list[CatalogConnector]
    max_enabled_packs: int = MAX_ENABLED_PACKS


# --- Dependencies of the use cases ------------------------------------------------------


@dataclass
class McpDeps:
    catalog: CatalogSource
    agents: AgentsStore
    audit: AuditLog
    clock: Callable[[], datetime]
    store: PackStore | None = None
    """``None`` until the installation has the Settings table of packs wired (503)."""
    provisioner: PackProvisionerClient | None = None
    """Until the pack provisioner is deployed nothing can be approved (503)."""
    rate_limiter: Limiter = field(
        default_factory=lambda: RateLimiter(limit=WRITES_PER_MINUTE, window_seconds=60)
    )

    @staticmethod
    def catalog_only(agents: AgentsDeps) -> "McpDeps":
        """The catalog of connectors without pack administration (every pack write is 503)."""
        return McpDeps(
            catalog=CatalogSource(agents.catalog, None, None),
            agents=agents.store,
            audit=agents.audit,
            clock=agents.clock,
        )


# --- Rules ------------------------------------------------------------------------------


def resolve_config(manifest: PackManifest, requested: Mapping[str, str]) -> dict[str, str]:
    """Parameters of a request: only keys of the manifest, only values of their list.

    Same rule the provisioner applies again before installing (``invalid_config``).
    """
    params = {param.key: param for param in manifest.config}
    unknown = sorted(set(requested) - set(params))
    if unknown:
        raise ApiError(422, "invalid_config", "unknown parameter", extra={"keys": unknown[:5]})
    resolved: dict[str, str] = {}
    invalid: list[str] = []
    for key, param in params.items():
        value = requested.get(key, param.default)
        if value not in param.allowed:
            invalid.append(key)
        resolved[key] = value
    if invalid:
        raise ApiError(
            422, "invalid_config", "value outside the allowed list", extra={"keys": invalid[:5]}
        )
    return resolved


def _supported(manifest: PackManifest) -> bool:
    """What this installation installs: read-only tools over public data, or over account
    data in ``central_only`` mode (D37). The provisioner refuses the rest with the same rule
    (``data_tier_unsupported``)."""
    return manifest.installable


def _stalled(enablement: Enablement, now: datetime) -> bool:
    """Approved or installing with no execution holding the pack: it never started, or the
    execution was cut off. A retry starts it again with the same request."""
    if enablement.status not in {PackStatus.APPROVED, PackStatus.INSTALLING}:
        return False
    if enablement.locked(now):
        return False
    if enablement.status is PackStatus.INSTALLING or enablement.status_at is None:
        return True
    try:
        since = datetime.fromisoformat(enablement.status_at)
    except ValueError:
        return True
    return now - since >= STALLED_AFTER


_DISPLAY: dict[PackStatus, PackDisplayStatus] = {
    PackStatus.PENDING: "pending",
    PackStatus.APPROVED: "installing",
    PackStatus.INSTALLING: "installing",
    PackStatus.ENABLED: "enabled",
    PackStatus.FAILED: "error",
    PackStatus.DISABLING: "disabling",
    PackStatus.DISABLED: "disabled",
}


def _display_status(
    state: PackState, pending: PackChange | None, now: datetime
) -> PackDisplayStatus:
    enablement = state.enablement
    if enablement is None or enablement.status is PackStatus.DISABLED:
        if pending is not None and pending.kind is ChangeKind.ENABLE:
            return "pending"
        return "available" if enablement is None else "disabled"
    # Approved or installing with nobody working on it is shown as an error to retry.
    return "error" if _stalled(enablement, now) else _DISPLAY[enablement.status]


def _failure(enablement: Enablement | None, now: datetime) -> tuple[str | None, str | None]:
    if enablement is None:
        return None, None
    if enablement.status is PackStatus.FAILED:
        return enablement.failed_step, enablement.failure
    if _stalled(enablement, now):
        return None, "not_started" if enablement.status is PackStatus.APPROVED else "interrupted"
    return None, None


def _update(state: PackState) -> PackUpdate | None:
    installed = state.installed
    release = state.release
    if not state.serving or installed is None:
        return None
    if installed.statement_sha256 == release.statement_sha256:
        return None
    new_tools = release.manifest.tool_names
    old_tools = frozenset(installed.tools)
    new_actions, old_actions = set(release.actions), set(installed.actions)
    return PackUpdate(
        version=release.manifest.version,
        added_tools=sorted(new_tools - old_tools),
        removed_tools=sorted(old_tools - new_tools),
        added_permissions=sorted(new_actions - old_actions),
        removed_permissions=sorted(old_actions - new_actions),
    )


# --- Views ------------------------------------------------------------------------------


def _agents_by_server(deps: McpDeps) -> dict[str, list[CatalogAgent]]:
    """Published agents by the MCP server (connector or pack) whose tools they use."""
    try:
        published = deps.agents.by_status(VersionStatus.PUBLISHED)
    except (ClientError, BotoCoreError, InvalidDefinitionError) as exc:
        # Disabling shows who is affected: without that list nothing is answered.
        raise ApiError(503, "agents_unavailable", "please try again") from exc
    by_server: dict[str, list[CatalogAgent]] = {}
    for version in published:
        definition = version.definition
        agent = CatalogAgent(
            id=version.agent_id, name=definition.name, category=definition.category
        )
        for server_id in {ref.partition(".")[0] for ref in definition.tools}:
            by_server.setdefault(server_id, []).append(agent)
    for agents in by_server.values():
        agents.sort(key=lambda a: (a.name.casefold(), a.id))
    return by_server


def _request_out(change: PackChange, caller: Caller) -> PackRequest:
    return PackRequest(
        change_id=change.change_id,
        kind=change.kind,
        pack_version=change.pack_version,
        config=change.config,
        reason=change.reason,
        requested_by=change.requested_by,
        requested_by_email=change.requested_by_email,
        created_at=iso(change.created_at),
        expires_at=iso(change.expires_at),
        own=change.requested_by == caller.user.user_id,
    )


def _pack_out(deps: McpDeps, caller: Caller, state: PackState, now: datetime) -> PackOut:
    manifest = state.release.manifest
    enablement, installed = state.enablement, state.installed
    serving = state.serving and installed is not None
    pending = deps.store.pending(state.pack_id, now) if deps.store else None
    out = PackOut(
        status=_display_status(state, pending, now),
        version=manifest.version,
        installed_version=installed.pack_version if serving and installed else None,
        lock_version=enablement.version if enablement else 0,
        params=[
            PackParam(
                key=param.key,
                description=param.description,
                allowed=list(param.allowed),
                default=param.default,
                value=installed.config.get(param.key) if serving and installed else None,
            )
            for param in manifest.config
        ],
        update=_update(state),
    )
    if not caller.user.is_admin:
        return out
    out.pending = _request_out(pending, caller) if pending else None
    if deps.store is not None:
        rejected = next(
            (c for c in deps.store.changes(state.pack_id) if c.status is ChangeStatus.REJECTED),
            None,
        )
        if rejected is not None and (pending is None or rejected.created_at > pending.created_at):
            out.last_rejected = PackDecision(
                change_id=rejected.change_id,
                kind=rejected.kind,
                decided_by=rejected.decided_by,
                decided_by_email=rejected.decided_by_email,
                decided_at=rejected.decided_at,
                reason=rejected.decision_reason,
            )
    if enablement is not None:
        out.failed_step, out.failure = _failure(enablement, now)
        for name in (
            "status_at",
            "requested_by",
            "requested_by_email",
            "requested_at",
            "approved_by",
            "approved_by_email",
            "approved_at",
            "disabled_by",
            "disabled_by_email",
            "disabled_at",
            "disable_reason",
        ):
            setattr(out, name, getattr(enablement, name))
    return out


def _server_out(
    catalog: McpCatalog,
    server: McpServer,
    agents: dict[str, list[CatalogAgent]],
    pack: PackOut | None,
) -> CatalogConnector:
    tools = catalog.tools_of(server)
    return CatalogConnector(
        id=server.id,
        kind=server.kind,
        name=server.name,
        description=server.description,
        provider=server.provider,
        data_tier=server.data_tier,
        identity_mode=server.identity_mode,
        # A pack counts as enabled while its installed version serves.
        enabled=any(t.enabled for t in tools) if pack else all(t.enabled for t in tools),
        permissions=sorted({a for iam in server.iam for a in iam.actions}),
        tools=[
            CatalogTool(
                ref=tool.ref,
                name=tool.tool.name,
                description=tool.tool.description,
                access=tool.tool.access,
                audience=tool.tool.audience,
                central_groups_only=tool.central_groups_only,
                enabled=tool.enabled,
                requires_service=required_service(tool.ref),
            )
            for tool in tools
        ],
        agents=agents.get(server.id, []),
        pack=pack,
    )


def catalog_view(deps: McpDeps, caller: Caller) -> CatalogOut:
    catalog = deps.catalog.fresh()
    agents = _agents_by_server(deps)
    now = deps.clock()
    items = [_server_out(catalog, connector, agents, None) for connector in catalog.connectors]
    items += [
        _server_out(catalog, state.server, agents, _pack_out(deps, caller, state, now))
        for state in catalog.packs
    ]
    return CatalogOut(items=items)


# --- Audit ------------------------------------------------------------------------------


def _audited[T](
    deps: McpDeps, event: str, caller: Caller, detail: dict[str, Any], write: Callable[[], T]
) -> T:
    """Fail-closed audit around a write, as in Admin v0 (TM-A9)."""
    actor, user = caller.user.user_id, caller.user
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "requested"}, user)
    except Exception as exc:
        raise ApiError(503, "audit_unavailable", "the change could not be audited; retry") from exc
    try:
        result = write()
    except Exception as exc:
        code = (
            "version_conflict"
            if isinstance(exc, PackConflictError)
            else exc.code
            if isinstance(exc, ApiError)
            else "error"
        )
        try:
            deps.audit.emit(event, actor, {**detail, "outcome": "rejected", "error": code}, user)
        except Exception:
            logger.exception("audit emit failed after a rejected write")
        raise
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "applied"}, user)
    except Exception:
        logger.exception("audit emit failed after an applied write")
    return result


def _change_detail(change: PackChange) -> dict[str, Any]:
    return {
        "pack": change.pack_id,
        "change_id": change.change_id,
        "kind": change.kind.value,
        "pack_version": change.pack_version,
        "statement_sha256": change.statement_sha256,
        "config": change.config,
        "requested_by": change.requested_by,
    }


# --- Use cases --------------------------------------------------------------------------


def _store(deps: McpDeps) -> PackStore:
    if deps.store is None:
        raise ApiError(503, "packs_unavailable", "MCP packs are not available yet")
    return deps.store


def _limit(deps: McpDeps, caller: Caller) -> None:
    if not deps.rate_limiter.allow(caller.user.user_id):
        raise rate_limited(deps.rate_limiter.retry_after(caller.user.user_id))


def _state(deps: McpDeps, pack_id: str) -> PackState:
    """The pack as the release names it, with its current state; 404 if it is not there."""
    for state in deps.catalog.fresh().packs:
        if state.pack_id == pack_id:
            return state
    raise ApiError(404, "not_found", "MCP pack not found")


def _check_version(enablement: Enablement | None, version: int) -> None:
    if (enablement.version if enablement else 0) != version:
        raise ApiError(409, "version_conflict", "the pack changed; reload and try again")


def _enabled_count(deps: McpDeps) -> int:
    return sum(
        1
        for state in deps.catalog.pack_states()
        if state.enablement is not None and state.enablement.status is not PackStatus.DISABLED
    )


def _check_request(
    deps: McpDeps,
    state: PackState,
    kind: ChangeKind,
    config: Mapping[str, str] | None,
    now: datetime,
) -> dict[str, str]:
    """Whether ``kind`` may be asked (or approved) for the pack as it is now; the parameters
    it would be installed with. Run when the request is made and again when it is approved."""
    manifest = state.release.manifest
    enablement, installed = state.enablement, state.installed
    if not _supported(manifest):
        raise ApiError(409, "pack_unsupported", "this installation cannot install the pack yet")
    if enablement is not None and enablement.locked(now):
        raise ApiError(409, "busy", "the pack is being installed or removed; try again later")
    if kind is ChangeKind.ENABLE:
        if enablement is not None and enablement.status is not PackStatus.DISABLED:
            raise ApiError(409, "invalid_state", "the pack is already enabled or being installed")
        if _enabled_count(deps) >= MAX_ENABLED_PACKS:
            raise ApiError(409, "too_many_packs", "too many enabled packs; disable one first")
        return resolve_config(manifest, config or {})
    if (
        enablement is None
        or installed is None
        or not state.serving
        or enablement.status not in {PackStatus.ENABLED, PackStatus.FAILED}
    ):
        raise ApiError(409, "invalid_state", "the pack is not enabled")
    current = installed.statement_sha256 == state.release.statement_sha256
    if kind is ChangeKind.PARAMS:
        if not current:
            raise ApiError(409, "update_required", "update the pack to change its parameters")
        resolved = resolve_config(manifest, config or {})
        if resolved == resolve_config_or_none(manifest, installed.config):
            raise ApiError(422, "no_change", "the parameters are the ones in use")
        return resolved
    if current:
        raise ApiError(409, "up_to_date", "the installed version is the one of the release")
    if installed.identity_mode != manifest.identity_mode.value:
        # Who may call the tools would change under agents that already have them, and the
        # update summary does not show it: a new enablement shows the pack as what it becomes.
        raise ApiError(
            409,
            "identity_mode_changed",
            "this version changes how the pack reaches data; disable the pack and enable it again",
        )
    if config is None:
        # Keep what is in use, as far as the new version still accepts it.
        params = {param.key: param for param in manifest.config}
        config = {
            key: value
            for key, value in installed.config.items()
            if key in params and value in params[key].allowed
        }
    return resolve_config(manifest, config)


def resolve_config_or_none(
    manifest: PackManifest, config: Mapping[str, str]
) -> dict[str, str] | None:
    try:
        return resolve_config(manifest, config)
    except ApiError:
        return None


@dataclass(frozen=True)
class Ask:
    """What an administrator asks for a pack."""

    kind: ChangeKind
    version: int
    config: Mapping[str, str] | None = None
    reason: str | None = None


def request_change(deps: McpDeps, caller: Caller, pack_id: str, ask: Ask) -> None:
    store = _store(deps)
    _limit(deps, caller)
    state = _state(deps, pack_id)
    kind, version, reason = ask.kind, ask.version, ask.reason
    _check_version(state.enablement, version)
    now = deps.clock()
    resolved = _check_request(deps, state, kind, ask.config, now)
    if store.pending(pack_id, now) is not None:
        raise ApiError(409, "pending_exists", "another request is waiting for this pack")
    change = PackChange(
        change_id=new_change_id(),
        pack_id=pack_id,
        kind=kind,
        status=ChangeStatus.PENDING,
        pack_version=state.release.manifest.version,
        statement_sha256=state.release.statement_sha256,
        config=resolved,
        reason=reason,
        base_version=version,
        requested_by=caller.user.user_id,
        requested_by_email=caller.user.email,
        created_at=now,
        expires_at=now + CHANGE_LIFETIME,
    )
    _audited(
        deps,
        EVENT_PROPOSED,
        caller,
        {**_change_detail(change), "reason": reason, "base_version": version},
        lambda: store.create_change(change),
    )


def _pending_change(deps: McpDeps, pack_id: str, change_id: str) -> PackChange:
    change = _store(deps).change(pack_id, change_id)
    if change is None:
        raise ApiError(404, "not_found", "request not found")
    if change.status is not ChangeStatus.PENDING:
        raise ApiError(409, "version_conflict", "the request is already closed")
    return change


def _start(deps: McpDeps, pack_id: str, pack_version: str, enablement_id: str) -> None:
    """Start the provisioner for what is stored. The decision is already committed and
    audited: if this fails, an administrator retries (``POST …/retry``)."""
    if deps.provisioner is None:
        raise ApiError(503, "provisioner_unavailable", "the pack provisioner is not available")
    try:
        deps.provisioner.start(pack_id, pack_version, enablement_id)
    except ProvisionerError as exc:
        logger.warning("pack provisioner could not be started")
        raise ApiError(
            503, "provisioner_unavailable", "recorded, but the installation did not start; retry"
        ) from exc


def approve(deps: McpDeps, caller: Caller, pack_id: str, change_id: str) -> None:
    store = _store(deps)
    _limit(deps, caller)
    change = _pending_change(deps, pack_id, change_id)
    now = deps.clock()
    if now >= change.expires_at:
        raise ApiError(410, "expired", "the request expired")
    actor = caller.user.user_id
    if change.requested_by == actor:
        raise ApiError(403, "same_approver", "another administrator must approve this request")
    if deps.provisioner is None:
        raise ApiError(503, "provisioner_unavailable", "the pack provisioner is not available")
    state = _state(deps, pack_id)
    release = state.release
    if (
        release.statement_sha256 != change.statement_sha256
        or release.manifest.version != change.pack_version
    ):
        # The approver would be approving something else than what was asked for.
        raise ApiError(409, "release_changed", "the release changed; ask for it again")
    _check_version(state.enablement, change.base_version)
    if _check_request(deps, state, change.kind, change.config, now) != change.config:
        raise ApiError(409, "release_changed", "the release changed; ask for it again")
    enablement_id = new_enablement_id()
    _audited(
        deps,
        EVENT_APPROVED,
        caller,
        {**_change_detail(change), "approved_by": actor, "enablement_id": enablement_id},
        lambda: store.approve_change(
            change,
            enablement_id=enablement_id,
            approver=actor,
            approver_email=caller.user.email,
            now=now,
        ),
    )
    deps.catalog.invalidate()
    _start(deps, pack_id, change.pack_version, enablement_id)


def reject(deps: McpDeps, caller: Caller, pack_id: str, change_id: str, reason: str | None) -> None:
    store = _store(deps)
    _limit(deps, caller)
    change = _pending_change(deps, pack_id, change_id)
    actor = caller.user.user_id
    if actor == change.requested_by:
        # Who asked withdraws (POST .../withdraw); rejecting is another admin's decision.
        raise ApiError(403, "use_withdraw", "withdraw your own request instead")
    if reason is None and change.kind is not ChangeKind.PARAMS:
        raise ApiError(422, "reason_required", "a reason is required to reject this request")
    _audited(
        deps,
        EVENT_REJECTED,
        caller,
        {**_change_detail(change), "rejected_by": actor, "reason": reason},
        lambda: store.reject_change(
            change, by=actor, by_email=caller.user.email, reason=reason, now=deps.clock()
        ),
    )


def withdraw(deps: McpDeps, caller: Caller, pack_id: str, change_id: str) -> None:
    """Who asked closes their own pending request; nothing about the pack changes."""
    store = _store(deps)
    _limit(deps, caller)
    change = _pending_change(deps, pack_id, change_id)
    actor = caller.user.user_id
    if actor != change.requested_by:
        raise ApiError(403, "not_requester", "only who asked can withdraw this request")
    _audited(
        deps,
        EVENT_WITHDRAWN,
        caller,
        _change_detail(change),
        lambda: store.withdraw_change(change, by=actor, now=deps.clock()),
    )


def _enablement(deps: McpDeps, pack_id: str, version: int) -> Enablement:
    enablement = _store(deps).enablement(pack_id)
    if enablement is None:
        raise ApiError(404, "not_found", "MCP pack not found")
    _check_version(enablement, version)
    return enablement


def retry(deps: McpDeps, caller: Caller, pack_id: str, version: int) -> None:
    """Start again an installation that failed or never started. One administrator is enough:
    nothing that was approved changes (same request, version and parameters)."""
    store = _store(deps)
    _limit(deps, caller)
    enablement = _enablement(deps, pack_id, version)
    now = deps.clock()
    failed = enablement.status is PackStatus.FAILED
    if not failed and not _stalled(enablement, now):
        code = "busy" if enablement.status in _IN_PROGRESS else "invalid_state"
        raise ApiError(409, code, "there is no failed installation to retry")
    if enablement.locked(now):
        raise ApiError(409, "busy", "the pack is being installed or removed; try again later")
    if deps.provisioner is None:
        raise ApiError(503, "provisioner_unavailable", "the pack provisioner is not available")
    entry = deps.catalog.release_entry(pack_id)
    if entry is None or entry.version != enablement.pack_version:
        # The provisioner only installs the version the release names.
        raise ApiError(409, "release_changed", "the release changed; ask for an update instead")
    _audited(
        deps,
        EVENT_RETRIED,
        caller,
        {
            "pack": pack_id,
            "pack_version": enablement.pack_version,
            "enablement_id": enablement.enablement_id,
            "from_status": enablement.status.value,
            "base_version": version,
        },
        lambda: store.retry(enablement, now) if failed else None,
    )
    deps.catalog.invalidate()
    _start(deps, pack_id, enablement.pack_version, enablement.enablement_id)


_IN_PROGRESS = frozenset({PackStatus.APPROVED, PackStatus.INSTALLING, PackStatus.DISABLING})


def disable(deps: McpDeps, caller: Caller, pack_id: str, body: DisableIn) -> None:
    """Ask the provisioner to remove the pack. One administrator, with a reason (spec §4.4).

    It reads the enablement directly, so a pack a newer release no longer names can still be
    removed. Repeating it while the pack is ``disabling`` starts the removal again.
    """
    store = _store(deps)
    _limit(deps, caller)
    enablement = _enablement(deps, pack_id, body.version)
    now = deps.clock()
    if enablement.locked(now):
        raise ApiError(409, "busy", "the pack is being installed or removed; try again later")
    again = enablement.status is PackStatus.DISABLING
    if not again and enablement.status not in {PackStatus.ENABLED, PackStatus.FAILED}:
        code = "busy" if enablement.status in _IN_PROGRESS else "invalid_state"
        raise ApiError(409, code, "the pack is not enabled")
    if deps.provisioner is None:
        raise ApiError(503, "provisioner_unavailable", "the pack provisioner is not available")
    actor = caller.user.user_id
    pending = store.pending(pack_id, now)
    _audited(
        deps,
        EVENT_DISABLE,
        caller,
        {
            "pack": pack_id,
            "pack_version": enablement.pack_version,
            "enablement_id": enablement.enablement_id,
            "disabled_by": actor,
            "reason": body.reason,
            "base_version": body.version,
            "cancelled_change": pending.change_id if pending and not again else None,
        },
        lambda: (
            None
            if again
            else store.disable(
                enablement,
                by=actor,
                by_email=caller.user.email,
                reason=body.reason,
                pending=pending,
                now=now,
            )
        ),
    )
    deps.catalog.invalidate()
    _start(deps, pack_id, enablement.pack_version, enablement.enablement_id)


# --- Routes -----------------------------------------------------------------------------


Authorize = Callable[..., Awaitable[None]]


def mcp_router(
    deps: McpDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    router = APIRouter(prefix="/api/mcp")

    def action(
        name: str, *, read_only: bool = False, admin: bool = True
    ) -> Callable[[Caller], Awaitable[Caller]]:
        async def dependency(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
            await authorize(caller, name, *PLATFORM, read_only=read_only)
            # Defense in depth: the Cedar policies already require isAdmin.
            if admin and not caller.user.is_admin:
                raise ApiError(403, "forbidden", "not allowed")
            return caller

        return dependency

    View = Annotated[  # noqa: N806
        Caller, Depends(action("ViewMcpCatalog", read_only=True, admin=False))
    ]
    Enable = Annotated[Caller, Depends(action("EnableMcp"))]  # noqa: N806
    Approve = Annotated[Caller, Depends(action("ApproveMcp"))]  # noqa: N806
    PackId = Annotated[  # noqa: N806
        str, Path(pattern=PACK_ID_PATTERN, max_length=MAX_PACK_ID_CHARS)
    ]
    ChangeId = Annotated[str, Path(pattern=CHANGE_ID_PATTERN)]  # noqa: N806

    async def run[T](fn: Callable[..., T], *args: Any) -> T:
        try:
            return await asyncio.to_thread(fn, *args)
        except PackConflictError as exc:
            raise ApiError(409, "version_conflict", "the pack changed; reload and retry") from exc
        except (InvalidCatalogError, PackRecordError) as exc:
            raise ApiError(503, "catalog_unavailable", "please try again") from exc

    async def view(caller: Caller) -> CatalogOut:
        return await run(catalog_view, deps, caller)

    @router.get("/catalog", response_model=CatalogOut)
    async def get_catalog(caller: View) -> CatalogOut:
        return await view(caller)

    @router.post("/{pack}/enablements", response_model=CatalogOut, status_code=201)
    async def request_pack_enablement(pack: PackId, body: EnableIn, caller: Enable) -> CatalogOut:
        ask = Ask(ChangeKind.ENABLE, body.version, body.config, body.reason)
        await run(request_change, deps, caller, pack, ask)
        return await view(caller)

    @router.post("/{pack}/params", response_model=CatalogOut, status_code=201)
    async def request_pack_params(pack: PackId, body: ParamsIn, caller: Enable) -> CatalogOut:
        await run(
            request_change, deps, caller, pack, Ask(ChangeKind.PARAMS, body.version, body.config)
        )
        return await view(caller)

    @router.post("/{pack}/update", response_model=CatalogOut, status_code=201)
    async def request_pack_update(pack: PackId, body: UpdateIn, caller: Enable) -> CatalogOut:
        await run(
            request_change, deps, caller, pack, Ask(ChangeKind.UPDATE, body.version, body.config)
        )
        return await view(caller)

    @router.post("/{pack}/enablements/{change_id}/approve", response_model=CatalogOut)
    async def approve_pack_request(
        pack: PackId, change_id: ChangeId, _body: EmptyIn, caller: Approve
    ) -> CatalogOut:
        await run(approve, deps, caller, pack, change_id)
        return await view(caller)

    @router.post("/{pack}/enablements/{change_id}/reject", response_model=CatalogOut)
    async def reject_pack_request(
        pack: PackId, change_id: ChangeId, body: RejectIn, caller: Approve
    ) -> CatalogOut:
        await run(reject, deps, caller, pack, change_id, body.reason)
        return await view(caller)

    @router.post("/{pack}/enablements/{change_id}/withdraw", response_model=CatalogOut)
    async def withdraw_pack_request(
        pack: PackId, change_id: ChangeId, _body: EmptyIn, caller: Enable
    ) -> CatalogOut:
        await run(withdraw, deps, caller, pack, change_id)
        return await view(caller)

    @router.post("/{pack}/retry", response_model=CatalogOut)
    async def retry_pack(pack: PackId, body: RetryIn, caller: Enable) -> CatalogOut:
        await run(retry, deps, caller, pack, body.version)
        return await view(caller)

    @router.delete("/{pack}", response_model=CatalogOut)
    async def disable_pack(pack: PackId, body: DisableIn, caller: Enable) -> CatalogOut:
        await run(disable, deps, caller, pack, body)
        return await view(caller)

    return router
