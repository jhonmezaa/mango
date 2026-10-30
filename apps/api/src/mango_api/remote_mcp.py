"""Remote MCP catalog API (D93, D98 (17)): the profiles of the release and the registrations of
one organization each, asked by an administrator and approved by another.

mango-api creates the Identity provider of a request (it holds the app's secret), records
decisions and starts the remote provisioner with identifiers. It never creates the Gateway
target, its policies nor the signed approved catalog: those are the provisioner's (D25).

Security notes (threat model ``remote-mcp``; security-best-practices, FastAPI):
* Every route declares an authorization dependency bound to its own Cedar action
  (``ViewMcpCatalog``, ``ManageRemoteMcp``, ``ApproveRemoteMcp``), and ``is_admin`` is checked
  again in process for the writes. Whoever asks does not approve; only who asked withdraws.
* The client secret is a ``SecretStr`` of the request body. It goes to Identity and nowhere
  else: not to a response, a log line, the audit trail nor the table (TM-002). Validation
  errors never repeat values (``app.validation_error``).
* A request names a profile of the release, an organization (D93 (5)), Entra GUIDs, toolsets of
  the profile and groups of the registry; nothing names a host, a header, an IAM action or a
  tool. The profile must be the one the release signs, again when it is approved.
* Optimistic locking with the registration ``version``, also as DynamoDB conditions.
* Bodies forbid extra fields; responses use explicit models. Tenant, app, callback URL, who
  asked and failure codes are only returned to administrators. Everyone else only sees the
  registrations they may use (``UseRemoteMcp``).
* Each write emits ``requested`` before and ``applied`` or ``rejected`` after (fail closed).
* Writes are rate limited per administrator; live registrations are capped (TM-M9). With the
  stack parameter ``RemoteMcpEnabled`` off every write answers 409 ``remote_disabled`` (D98 (4)).
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel, ConfigDict, Field, SecretStr, WithJsonSchema

from mango_api.audit import AuditLog
from mango_api.authz import PLATFORM, REMOTE_MCP_TYPE, Authorizer, RemoteMcpResource
from mango_api.groups import GroupRegistry, GroupsUnavailableError
from mango_api.probe import RateLimiter
from mango_api.provisioner import ProvisionerError, RemoteProvisionerClient
from mango_api.rate_limits import Limiter
from mango_api.remote_mcp_store import (
    CHANGE_LIFETIME,
    ApprovedRemotes,
    IdentityError,
    IdentityProviders,
    Registration,
    RemoteChange,
    RemoteChangeKind,
    RemoteChangeStatus,
    RemoteConflictError,
    RemoteExistsError,
    RemoteRecordError,
    RemoteRegistrationStatus,
    RemoteStore,
    StackTagError,
    new_approval_id,
    new_change_id,
)
from mango_api.remote_release import ReleaseRemote, ReleaseRemotes, RemoteReleaseUnavailableError
from mango_api.web import ApiError, Caller, rate_limited
from mango_core.remote_mcp import (
    ORGANIZATION_PATTERN,
    PROFILE_ID_PATTERN,
    REGISTRATION_ID_PATTERN,
    new_registration_id,
    provider_name,
)
from mango_packs.enablement import iso
from mango_packs.remote import RemoteProfile, RemoteProfileError, ToolsetSensitivity, forced_headers

logger = logging.getLogger(__name__)

WRITES_PER_MINUTE = 10
MAX_LIVE_REGISTRATIONS = 10
"""Registrations that are not disabled, at once (TM-M9)."""
MAX_SECRET_DAYS = 730
"""An Entra client secret lives at most two years."""
MAX_HISTORY = 20
CHANGE_ID_PATTERN = r"^[0-9a-f]{32}$"

EVENT_REQUEST = "mcp_remote.request"
EVENT_APPROVE = "mcp_remote.approve"
EVENT_REJECT = "mcp_remote.reject"
EVENT_WITHDRAW = "mcp_remote.withdraw"
EVENT_SECRET_ROTATED = "mcp_remote.secret_rotated"  # noqa: S105 (an event name)
EVENT_DISABLE = "mcp_remote.disable"
EVENT_RETRY = "mcp_remote.retry"

SecretLevel = Literal["ok", "d30", "d7", "expired"]

# --- Bodies -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


LockVersion = Annotated[int, Field(ge=0, le=1_000_000)]
Reason = Annotated[str, Field(min_length=1, max_length=500)]
Organization = Annotated[str, Field(pattern=ORGANIZATION_PATTERN)]
ToolsetId = Annotated[str, Field(pattern=r"^[a-z][a-z0-9-]{0,23}$")]
Toolsets = Annotated[list[ToolsetId], Field(max_length=16)]
GroupId = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{1,63}$")]
Groups = Annotated[list[GroupId], Field(min_length=1, max_length=10)]
# `SecretStr` keeps the value out of every repr and log. Its JSON schema is given without
# `writeOnly`: the generated client would otherwise split every schema in read and write forms.
ClientSecret = Annotated[
    SecretStr,
    Field(min_length=1, max_length=512),
    WithJsonSchema({"type": "string", "format": "password", "minLength": 1, "maxLength": 512}),
]


class _App(_Strict):
    """The Entra app registration a request names (D93 (6))."""

    tenant_id: UUID
    client_id: UUID
    client_secret: ClientSecret
    """Write only: it goes to AgentCore Identity and nowhere else."""
    secret_expires_on: date


class RemoteRegistrationIn(_App):
    organization: Organization
    toolsets: Toolsets
    """Toolsets of the profile; those that are always on are added."""
    groups: Groups
    reason: Reason | None = None


class RemoteReplaceAppIn(_App):
    """A new tenant or app for an active registration: everyone connects again."""

    kind: Literal["replace_app"]
    version: LockVersion
    reason: Reason | None = None


class RemoteReenableIn(_App):
    """«Pedir de nuevo» on a registration that failed or was disabled."""

    kind: Literal["enable"]
    version: LockVersion
    toolsets: Toolsets
    groups: Groups
    reason: Reason | None = None


class RemoteParamsIn(_Strict):
    version: LockVersion
    toolsets: Toolsets
    groups: Groups
    reason: Reason | None = None


class RemoteRotateSecretIn(_Strict):
    version: LockVersion
    client_secret: ClientSecret
    secret_expires_on: date


class RemoteRetryIn(_Strict):
    version: LockVersion


class RemoteDisableIn(_Strict):
    version: LockVersion
    reason: Reason


class RemoteRejectIn(_Strict):
    reason: Reason


class RemoteEmptyIn(_Strict):
    pass


# --- Responses --------------------------------------------------------------------------


class RemoteToolsetOut(_Strict):
    id: str
    label: str
    always: bool
    tools: list[str]
    # From the signed profile (D98 (6)). The web draws the badge of a sensitivity it knows and
    # shows the texts as plain text, as written.
    sensitivity: ToolsetSensitivity | None
    note: str | None
    requirement: str | None


class RemotePermissionOut(_Strict):
    resource: str
    permission: str


class RemoteProfileOut(_Strict):
    id: str
    version: str
    name: str
    operator: str
    provider: str
    host: str
    link_hosts: list[str]
    data_leaves_aws: bool
    needs_tenant: bool
    permissions: list[RemotePermissionOut]
    toolsets: list[RemoteToolsetOut]
    enabled_in_installation: bool
    """``RemoteMcpEnabled`` of the stack (D98 (4)): off, nothing can be registered."""


class RemoteRequestOut(_Strict):
    id: str
    registration_id: str
    kind: RemoteChangeKind
    status: RemoteChangeStatus
    profile_id: str
    profile_version: str
    organization: str
    toolsets: list[str]
    groups: list[str]
    previous_toolsets: list[str] | None
    previous_groups: list[str] | None
    """What a ``params`` request changes from (TM-015)."""
    tenant_id: str | None
    client_id: str | None
    callback_url: str | None
    """Redirect URI of the new provider: the app registration needs it before approving."""
    secret_expires_on: str | None
    reason: str | None
    requested_by: str
    requested_by_email: str | None
    created_at: str
    expires_at: str
    decided_by: str | None
    decided_by_email: str | None
    decided_at: str | None
    decision_reason: str | None
    own: bool
    """The caller made it: they may withdraw it, never approve or reject it."""


class RemoteRegistrationOut(_Strict):
    id: str
    profile_id: str
    profile_in_release: bool
    organization: str
    toolsets: list[str]
    groups: list[str]
    status: RemoteRegistrationStatus
    tools: list[str]
    """Tools the signed approved catalog serves now; empty until it verifies."""
    secret_expires_on: str | None
    secret_level: SecretLevel | None
    disabled_by: str | None
    disabled_at: str | None
    reason: str | None
    version: int
    """Send it back as ``version`` in every write (optimistic locking)."""
    # Administrators only (``None`` for everyone else).
    tenant_id: str | None = None
    client_id: str | None = None
    callback_url: str | None = None
    requested_by: str | None = None
    requested_by_email: str | None = None
    approved_by: str | None = None
    approved_by_email: str | None = None
    approved_at: str | None = None
    failure_code: str | None = None
    pending: RemoteRequestOut | None = None
    history: list[RemoteRequestOut] | None = None


class RemoteCatalogOut(_Strict):
    enabled: bool
    profiles: list[RemoteProfileOut]
    registrations: list[RemoteRegistrationOut]
    max_registrations: int = MAX_LIVE_REGISTRATIONS


# --- Dependencies of the use cases ------------------------------------------------------


@dataclass
class RemoteMcpDeps:
    release: ReleaseRemotes
    store: RemoteStore
    groups: GroupRegistry
    authorizer: Authorizer
    audit: AuditLog
    clock: Callable[[], datetime]
    namespace: str
    enabled: bool = False
    """``RemoteMcpEnabled`` (D98 (4))."""
    identity: IdentityProviders | None = None
    approved: ApprovedRemotes | None = None
    provisioner: RemoteProvisionerClient | None = None
    """Until the remote provisioner is deployed nothing can be approved (503)."""
    rate_limiter: Limiter = field(
        default_factory=lambda: RateLimiter(limit=WRITES_PER_MINUTE, window_seconds=60)
    )


# --- Rules ------------------------------------------------------------------------------


def secret_level(expires_on: str | None, today: date) -> SecretLevel | None:
    """How close the client secret is to expiring (D98 (7)): computed on every read."""
    if not expires_on:
        return None
    try:
        days = (date.fromisoformat(expires_on) - today).days
    except ValueError:
        return None
    if days < 0:
        return "expired"
    return "d7" if days <= 7 else "d30" if days <= 30 else "ok"  # noqa: PLR2004


def _check_expiry(expires_on: date, today: date) -> str:
    if not today < expires_on <= today + timedelta(days=MAX_SECRET_DAYS):
        raise ApiError(
            422, "invalid_secret_expiry", "the expiry must be in the future, two years at most"
        )
    return expires_on.isoformat()


def resolve_toolsets(profile: RemoteProfile, requested: Sequence[str]) -> tuple[str, ...]:
    """Toolsets of a request: only the profile's, with those always on added. At least one
    must be a toolset that is not always on; the server is told their tools (D101)."""
    if len(set(requested)) != len(requested):
        raise ApiError(422, "invalid_toolsets", "a toolset is listed twice")
    picked = set(requested) | {t.id for t in profile.toolsets if t.always}
    try:
        forced_headers(profile, sorted(picked))
    except RemoteProfileError as exc:
        unknown = picked - {t.id for t in profile.toolsets}
        code = "invalid_toolsets" if unknown else "toolsets_required"
        raise ApiError(422, code, "pick toolsets of the profile, one not always on") from exc
    return tuple(sorted(picked))


def _check_groups(deps: RemoteMcpDeps, groups: Sequence[str]) -> tuple[str, ...]:
    if len(set(groups)) != len(groups):
        raise ApiError(422, "duplicate_group", "a group is listed twice")
    try:
        registered = {g.id for g in deps.groups.list_groups()}
    except GroupsUnavailableError as exc:
        raise ApiError(503, "groups_unavailable", "please try again") from exc
    if any(g not in registered for g in groups):
        raise ApiError(422, "group_unknown", "a group is not in the registry")
    return tuple(sorted(groups))


# --- Views ------------------------------------------------------------------------------


def _profile_out(remote: ReleaseRemote, enabled: bool) -> RemoteProfileOut:
    profile = remote.profile
    return RemoteProfileOut(
        id=profile.id,
        version=profile.version,
        name=profile.name,
        operator=profile.operator,
        provider=profile.provider.display_name,
        host=profile.endpoint.host,
        link_hosts=list(profile.link_hosts),
        data_leaves_aws=profile.data_leaves_aws,
        needs_tenant=profile.provider.needs_tenant,
        permissions=[
            RemotePermissionOut(resource=p.resource, permission=p.permission)
            for p in profile.provider.permissions
        ],
        toolsets=[
            RemoteToolsetOut(
                id=t.id,
                label=t.label,
                always=t.always,
                tools=[tool.name for tool in profile.tools if tool.toolset == t.id],
                sensitivity=t.sensitivity,
                note=t.note,
                requirement=t.requirement,
            )
            for t in profile.toolsets
        ],
        enabled_in_installation=enabled,
    )


def _request_out(change: RemoteChange, caller: Caller) -> RemoteRequestOut:
    return RemoteRequestOut(
        id=change.change_id,
        registration_id=change.registration_id,
        kind=change.kind,
        status=change.status,
        profile_id=change.profile_id,
        profile_version=change.profile_version,
        organization=change.organization,
        toolsets=list(change.toolsets),
        groups=list(change.groups),
        previous_toolsets=list(change.previous_toolsets) if change.previous_toolsets else None,
        previous_groups=list(change.previous_groups) if change.previous_groups else None,
        tenant_id=change.tenant_id,
        client_id=change.client_id,
        callback_url=change.callback_url,
        secret_expires_on=change.secret_expires_on,
        reason=change.reason,
        requested_by=change.requested_by,
        requested_by_email=change.requested_by_email,
        created_at=iso(change.created_at),
        expires_at=iso(change.expires_at),
        decided_by=change.decided_by,
        decided_by_email=change.decided_by_email,
        decided_at=change.decided_at,
        decision_reason=change.decision_reason,
        own=change.requested_by == caller.user.user_id,
    )


def _registration_out(
    deps: RemoteMcpDeps,
    caller: Caller,
    registration: Registration,
    in_release: bool,
    now: datetime,
) -> RemoteRegistrationOut:
    approved = deps.approved.get(registration.registration_id) if deps.approved else None
    out = RemoteRegistrationOut(
        id=registration.registration_id,
        profile_id=registration.profile_id,
        profile_in_release=in_release,
        organization=registration.organization,
        toolsets=list(registration.toolsets),
        groups=list(registration.groups),
        status=registration.status,
        tools=sorted(approved.tools) if approved else [],
        secret_expires_on=registration.secret_expires_on,
        secret_level=secret_level(registration.secret_expires_on, now.date()),
        disabled_by=registration.disabled_by,
        disabled_at=registration.disabled_at,
        reason=registration.disabled_reason,
        version=registration.version,
    )
    if not caller.user.is_admin:
        return out
    for name in (
        "tenant_id",
        "client_id",
        "callback_url",
        "requested_by",
        "requested_by_email",
        "approved_by",
        "approved_by_email",
        "approved_at",
        "failure_code",
    ):
        setattr(out, name, getattr(registration, name))
    pending = deps.store.pending(registration.registration_id, now)
    out.pending = _request_out(pending, caller) if pending else None
    out.history = [
        _request_out(c, caller)
        for c in deps.store.changes(registration.registration_id)[:MAX_HISTORY]
        if pending is None or c.change_id != pending.change_id
    ]
    return out


def _may_use(deps: RemoteMcpDeps, caller: Caller, registration: Registration) -> bool:
    return deps.authorizer.is_allowed(
        caller.user,
        "UseRemoteMcp",
        REMOTE_MCP_TYPE,
        registration.registration_id,
        remote=RemoteMcpResource(registration.registration_id, frozenset(registration.groups)),
    )


def catalog_view(deps: RemoteMcpDeps, caller: Caller) -> RemoteCatalogOut:
    profiles = deps.release.profiles()
    in_release = {p.profile.id: p.statement_sha256 for p in profiles}
    now = deps.clock()
    registrations = [
        _registration_out(deps, caller, r, r.profile_id in in_release, now)
        for r in deps.store.registrations()
        # Everyone else only learns of the organizations they may use (D93 (7)).
        if caller.user.is_admin or _may_use(deps, caller, r)
    ]
    return RemoteCatalogOut(
        enabled=deps.enabled,
        profiles=[_profile_out(p, deps.enabled) for p in profiles],
        registrations=registrations,
    )


# --- Audit ------------------------------------------------------------------------------


def _audited[T](
    deps: RemoteMcpDeps, event: str, caller: Caller, detail: dict[str, Any], write: Callable[[], T]
) -> T:
    """Fail-closed audit around a write, as in Admin v0 (TM-A9). ``detail`` never holds the
    secret, a token nor a URL other than the provider's callback (D98 (19))."""
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
            if isinstance(exc, RemoteConflictError)
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


def _change_detail(change: RemoteChange) -> dict[str, Any]:
    return {
        "registration": change.registration_id,
        "profile": change.profile_id,
        "profile_version": change.profile_version,
        "change_id": change.change_id,
        "kind": change.kind.value,
        "organization": change.organization,
        "tenant_id": change.tenant_id,
        "client_id": change.client_id,
        "toolsets": list(change.toolsets),
        "groups": list(change.groups),
        "provider": change.pending_provider_name,
        "requested_by": change.requested_by,
    }


# --- Use cases --------------------------------------------------------------------------


def _writable(deps: RemoteMcpDeps, caller: Caller) -> None:
    if not deps.enabled:
        raise ApiError(409, "remote_disabled", "remote MCP servers are off in this installation")
    if not deps.rate_limiter.allow(caller.user.user_id):
        raise rate_limited(deps.rate_limiter.retry_after(caller.user.user_id))


def _identity(deps: RemoteMcpDeps) -> IdentityProviders:
    if deps.identity is None:
        raise ApiError(503, "identity_unavailable", "AgentCore Identity is not available")
    return deps.identity


def _release(deps: RemoteMcpDeps, profile_id: str) -> ReleaseRemote:
    remote = deps.release.get(profile_id)
    if remote is None:
        raise ApiError(
            409, "remote_profile_not_in_release", "this service is not in this release of Mango"
        )
    return remote


def _registration(deps: RemoteMcpDeps, registration_id: str, version: int) -> Registration:
    registration = deps.store.registration(registration_id)
    if registration is None:
        raise ApiError(404, "not_found", "registration not found")
    if registration.version != version:
        raise ApiError(409, "version_conflict", "the registration changed; reload and try again")
    return registration


def _status(registration: Registration, allowed: set[RemoteRegistrationStatus]) -> None:
    if registration.status not in allowed:
        busy = registration.status in _IN_PROGRESS
        raise ApiError(
            409, "busy" if busy else "invalid_state", "the registration cannot do that now"
        )


_IN_PROGRESS = frozenset(
    {
        RemoteRegistrationStatus.APPROVED,
        RemoteRegistrationStatus.CREATING,
        RemoteRegistrationStatus.DISABLING,
    }
)
_ENABLE_FROM = {RemoteRegistrationStatus.FAILED, RemoteRegistrationStatus.DISABLED}
_ACTIVE = {RemoteRegistrationStatus.ACTIVE}


def _live_count(deps: RemoteMcpDeps) -> int:
    return sum(
        1 for r in deps.store.registrations() if r.status is not RemoteRegistrationStatus.DISABLED
    )


def _no_pending(deps: RemoteMcpDeps, registration_id: str, now: datetime) -> None:
    if deps.store.pending(registration_id, now) is not None:
        raise ApiError(409, "pending_exists", "another request is waiting for this registration")


def _identity_failed(exc: IdentityError | StackTagError) -> ApiError:
    if isinstance(exc, StackTagError):
        if exc.code == "stack_unavailable":
            return ApiError(503, "stack_unavailable", "please try again")
        return ApiError(409, exc.code, "a tag of the installation's stack cannot be copied")
    logger.warning("identity provider call failed: %s", exc)
    return ApiError(502, "identity_unavailable", "AgentCore Identity did not answer; retry")


def _with_provider(
    deps: RemoteMcpDeps, change: RemoteChange, body: _App, record: Callable[[RemoteChange], None]
) -> None:
    """Create the change's provider with the secret, then ``record``; if recording fails the
    provider goes away again, so a refused request leaves nothing holding the secret."""
    identity = _identity(deps)
    name = change.pending_provider_name or ""
    try:
        created = identity.create(
            name,
            registration_id=change.registration_id,
            tenant_id=str(body.tenant_id),
            client_id=str(body.client_id),
            client_secret=body.client_secret.get_secret_value(),
        )
    except (IdentityError, StackTagError) as exc:
        raise _identity_failed(exc) from None
    try:
        record(replace(change, pending_provider_arn=created.arn, callback_url=created.callback_url))
    except BaseException:
        _drop_provider(deps, name)
        raise


def _drop_provider(deps: RemoteMcpDeps, name: str | None) -> None:
    """Delete a provider nobody will use. A failure is logged: uninstalling deletes every
    ``Mango-<ns>-remote-*`` provider anyway."""
    if not name or deps.identity is None:
        return
    try:
        deps.identity.delete(name)
    except IdentityError as exc:
        logger.error("unused identity provider could not be deleted: %s (%s)", name, exc)  # noqa: TRY400


def _new_change(
    deps: RemoteMcpDeps,
    caller: Caller,
    *,
    registration_id: str,
    kind: RemoteChangeKind,
    remote: ReleaseRemote,
    organization: str,
    toolsets: tuple[str, ...],
    groups: tuple[str, ...],
    base_version: int,
    reason: str | None,
    now: datetime,
    app: _App | None = None,
    generation: int | None = None,
    previous: Registration | None = None,
) -> RemoteChange:
    return RemoteChange(
        change_id=new_change_id(),
        registration_id=registration_id,
        kind=kind,
        status=RemoteChangeStatus.PENDING,
        profile_id=remote.profile.id,
        profile_version=remote.profile.version,
        profile_sha256=remote.statement_sha256,
        organization=organization,
        toolsets=toolsets,
        groups=groups,
        base_version=base_version,
        requested_by=caller.user.user_id,
        requested_by_email=caller.user.email,
        created_at=now,
        expires_at=now + CHANGE_LIFETIME,
        reason=reason,
        tenant_id=str(app.tenant_id) if app else None,
        client_id=str(app.client_id) if app else None,
        secret_expires_on=_check_expiry(app.secret_expires_on, now.date()) if app else None,
        previous_toolsets=previous.toolsets if previous else None,
        previous_groups=previous.groups if previous else None,
        pending_generation=generation,
        pending_provider_name=(
            provider_name(deps.namespace, registration_id, generation) if generation else None
        ),
    )


def request_registration(
    deps: RemoteMcpDeps, caller: Caller, profile_id: str, body: RemoteRegistrationIn
) -> None:
    """A new registration of ``profile_id`` for one organization, waiting for approval."""
    _writable(deps, caller)
    remote = _release(deps, profile_id)
    toolsets = resolve_toolsets(remote.profile, body.toolsets)
    groups = _check_groups(deps, body.groups)
    now = deps.clock()
    if deps.store.organization_taken(profile_id, body.organization):
        raise ApiError(409, "remote_exists", "this organization is already registered")
    if _live_count(deps) >= MAX_LIVE_REGISTRATIONS:
        raise ApiError(409, "too_many_remotes", "too many registrations; disable one first")
    change = _new_change(
        deps,
        caller,
        registration_id=new_registration_id(),
        kind=RemoteChangeKind.ENABLE,
        remote=remote,
        organization=body.organization,
        toolsets=toolsets,
        groups=groups,
        base_version=0,
        reason=body.reason,
        now=now,
        app=body,
        generation=1,
    )

    def record(created: RemoteChange) -> None:
        try:
            deps.store.create_registration(created)
        except RemoteExistsError as exc:
            raise ApiError(409, "remote_exists", "this organization is already registered") from exc

    _audited(
        deps,
        EVENT_REQUEST,
        caller,
        {**_change_detail(change), "reason": body.reason, "base_version": 0},
        lambda: _with_provider(deps, change, body, record),
    )


def request_on_registration(
    deps: RemoteMcpDeps,
    caller: Caller,
    registration_id: str,
    body: RemoteReplaceAppIn | RemoteReenableIn,
) -> None:
    """A new tenant or app (``replace_app``), or «Pedir de nuevo» (``enable``)."""
    _writable(deps, caller)
    registration = _registration(deps, registration_id, body.version)
    replace = isinstance(body, RemoteReplaceAppIn)
    allowed = _ACTIVE if replace else _ENABLE_FROM
    _status(registration, allowed)
    remote = _release(deps, registration.profile_id)
    if isinstance(body, RemoteReenableIn):
        toolsets = resolve_toolsets(remote.profile, body.toolsets)
        groups = _check_groups(deps, body.groups)
    else:
        toolsets = resolve_toolsets(remote.profile, registration.toolsets)
        groups = registration.groups
    now = deps.clock()
    _no_pending(deps, registration_id, now)
    expired = deps.store.expired(registration_id, now)
    if (
        not replace
        and registration.status is RemoteRegistrationStatus.DISABLED
        and _live_count(deps) >= MAX_LIVE_REGISTRATIONS
    ):
        raise ApiError(409, "too_many_remotes", "too many registrations; disable one first")
    change = _new_change(
        deps,
        caller,
        registration_id=registration_id,
        kind=RemoteChangeKind.REPLACE_APP if replace else RemoteChangeKind.ENABLE,
        remote=remote,
        organization=registration.organization,
        toolsets=toolsets,
        groups=groups,
        base_version=registration.version,
        reason=body.reason,
        now=now,
        app=body,
        # A provider name is never used twice.
        generation=max(registration.generation, registration.provider_generations) + 1,
    )
    _audited(
        deps,
        EVENT_REQUEST,
        caller,
        {**_change_detail(change), "reason": body.reason, "base_version": body.version},
        lambda: _with_provider(
            deps, change, body, lambda c: deps.store.request_change(c, registration, allowed)
        ),
    )
    _close_expired(deps, expired, now)


def request_params(
    deps: RemoteMcpDeps, caller: Caller, registration_id: str, body: RemoteParamsIn
) -> None:
    """Change the toolsets or the groups of an active registration (D98 (8)); the provider
    stays, so nobody has to connect again."""
    _writable(deps, caller)
    registration = _registration(deps, registration_id, body.version)
    _status(registration, _ACTIVE)
    remote = _release(deps, registration.profile_id)
    toolsets = resolve_toolsets(remote.profile, body.toolsets)
    groups = _check_groups(deps, body.groups)
    if toolsets == registration.toolsets and groups == registration.groups:
        raise ApiError(422, "no_change", "the toolsets and groups are the ones in use")
    now = deps.clock()
    _no_pending(deps, registration_id, now)
    expired = deps.store.expired(registration_id, now)
    change = _new_change(
        deps,
        caller,
        registration_id=registration_id,
        kind=RemoteChangeKind.PARAMS,
        remote=remote,
        organization=registration.organization,
        toolsets=toolsets,
        groups=groups,
        base_version=registration.version,
        reason=body.reason,
        now=now,
        previous=registration,
    )
    _audited(
        deps,
        EVENT_REQUEST,
        caller,
        {
            **_change_detail(change),
            "previous_toolsets": list(registration.toolsets),
            "previous_groups": list(registration.groups),
            "reason": body.reason,
            "base_version": body.version,
        },
        lambda: deps.store.request_change(change, registration, _ACTIVE),
    )
    _close_expired(deps, expired, now)


def _close_expired(deps: RemoteMcpDeps, expired: RemoteChange | None, now: datetime) -> None:
    """A newer request replaced one that expired undecided: close it and delete its provider,
    so no secret outlives its request. Best effort: the new request is already recorded."""
    if expired is None:
        return
    try:
        deps.store.close_expired(expired, now)
    except Exception:
        logger.exception("expired remote request could not be closed")
        return
    _drop_provider(deps, expired.pending_provider_name)


def _pending_change(deps: RemoteMcpDeps, registration_id: str, change_id: str) -> RemoteChange:
    change = deps.store.change(registration_id, change_id)
    if change is None:
        raise ApiError(404, "not_found", "request not found")
    if change.status is not RemoteChangeStatus.PENDING:
        raise ApiError(409, "version_conflict", "the request is already closed")
    return change


def _allowed_for(change: RemoteChange) -> set[RemoteRegistrationStatus]:
    if change.kind is RemoteChangeKind.ENABLE:
        return {RemoteRegistrationStatus.PENDING, *_ENABLE_FROM}
    return set(_ACTIVE)


def _start(deps: RemoteMcpDeps, registration_id: str, approval_id: str) -> None:
    """Start the provisioner for what is stored. The decision is already committed and
    audited: if this fails, an administrator retries."""
    if deps.provisioner is None:
        raise ApiError(503, "provisioner_unavailable", "the remote provisioner is not available")
    try:
        deps.provisioner.start(registration_id, approval_id)
    except ProvisionerError as exc:
        logger.warning("remote provisioner could not be started")
        raise ApiError(
            503, "provisioner_unavailable", "recorded, but the provisioner did not start; retry"
        ) from exc


def approve(deps: RemoteMcpDeps, caller: Caller, registration_id: str, change_id: str) -> None:
    _writable(deps, caller)
    change = _pending_change(deps, registration_id, change_id)
    now = deps.clock()
    if now >= change.expires_at:
        raise ApiError(410, "expired", "the request expired")
    actor = caller.user.user_id
    if change.requested_by == actor:
        raise ApiError(403, "same_approver", "another administrator must approve this request")
    if deps.provisioner is None:
        raise ApiError(503, "provisioner_unavailable", "the remote provisioner is not available")
    remote = deps.release.get(change.profile_id)
    if remote is None or remote.statement_sha256 != change.profile_sha256:
        # The approver would be approving something else than what was asked for.
        raise ApiError(409, "release_changed", "the release changed; ask for it again")
    registration = deps.store.registration(registration_id)
    if registration is None:
        raise ApiError(404, "not_found", "registration not found")
    if registration.version != change.base_version:
        raise ApiError(409, "version_conflict", "the registration changed; ask for it again")
    allowed = _allowed_for(change)
    _status(registration, allowed)
    approval_id = new_approval_id()
    _audited(
        deps,
        EVENT_APPROVE,
        caller,
        {**_change_detail(change), "approved_by": actor, "approval_id": approval_id},
        lambda: deps.store.approve(
            change,
            allowed=allowed,
            approval_id=approval_id,
            approver=actor,
            approver_email=caller.user.email,
            now=now,
        ),
    )
    _start(deps, registration_id, approval_id)


def _forgets(deps: RemoteMcpDeps, change: RemoteChange) -> bool:
    """Closing the first request of a registration that never got approved removes it."""
    if change.kind is not RemoteChangeKind.ENABLE:
        return False
    registration = deps.store.registration(change.registration_id)
    return registration is not None and registration.status is RemoteRegistrationStatus.PENDING


def reject(
    deps: RemoteMcpDeps, caller: Caller, registration_id: str, change_id: str, reason: str
) -> None:
    _writable(deps, caller)
    change = _pending_change(deps, registration_id, change_id)
    actor = caller.user.user_id
    if actor == change.requested_by:
        # Who asked withdraws (POST .../withdraw); rejecting is another admin's decision.
        raise ApiError(403, "use_withdraw", "withdraw your own request instead")
    forget = _forgets(deps, change)

    def write() -> None:
        deps.store.reject(
            change,
            by=actor,
            by_email=caller.user.email,
            reason=reason,
            forget=forget,
            now=deps.clock(),
        )
        _drop_provider(deps, change.pending_provider_name)

    _audited(
        deps,
        EVENT_REJECT,
        caller,
        {**_change_detail(change), "rejected_by": actor, "reason": reason},
        write,
    )


def withdraw(deps: RemoteMcpDeps, caller: Caller, registration_id: str, change_id: str) -> None:
    """Who asked closes their own pending request; the registration does not change."""
    _writable(deps, caller)
    change = _pending_change(deps, registration_id, change_id)
    actor = caller.user.user_id
    if actor != change.requested_by:
        raise ApiError(403, "not_requester", "only who asked can withdraw this request")
    forget = _forgets(deps, change)

    def write() -> None:
        deps.store.withdraw(change, by=actor, forget=forget, now=deps.clock())
        _drop_provider(deps, change.pending_provider_name)

    _audited(deps, EVENT_WITHDRAW, caller, _change_detail(change), write)


def rotate_secret(
    deps: RemoteMcpDeps, caller: Caller, registration_id: str, body: RemoteRotateSecretIn
) -> None:
    """A new secret of the same app, without approval (D93 (7)): what was approved stays."""
    _writable(deps, caller)
    registration = _registration(deps, registration_id, body.version)
    allowed = {RemoteRegistrationStatus.ACTIVE, RemoteRegistrationStatus.FAILED}
    _status(registration, allowed)
    if not (registration.provider_name and registration.tenant_id and registration.client_id):
        raise ApiError(409, "invalid_state", "the registration has no app yet")
    now = deps.clock()
    expires_on = _check_expiry(body.secret_expires_on, now.date())
    identity = _identity(deps)

    def write() -> None:
        try:
            identity.update_secret(
                registration.provider_name or "",
                tenant_id=registration.tenant_id or "",
                client_id=registration.client_id or "",
                client_secret=body.client_secret.get_secret_value(),
            )
        except IdentityError as exc:
            raise _identity_failed(exc) from None
        deps.store.secret_rotated(registration, expires_on, now)

    _audited(
        deps,
        EVENT_SECRET_ROTATED,
        caller,
        {
            "registration": registration_id,
            "provider": registration.provider_name,
            "secret_expires_on": expires_on,
            "base_version": body.version,
        },
        write,
    )


def retry(deps: RemoteMcpDeps, caller: Caller, registration_id: str, version: int) -> None:
    """Start again a registration whose provisioning failed. One administrator is enough:
    nothing that was approved changes (same approval, profile and toolsets)."""
    _writable(deps, caller)
    registration = _registration(deps, registration_id, version)
    _status(registration, {RemoteRegistrationStatus.FAILED})
    if deps.provisioner is None:
        raise ApiError(503, "provisioner_unavailable", "the remote provisioner is not available")
    remote = deps.release.get(registration.profile_id)
    if (
        remote is None
        or remote.statement_sha256 != registration.profile_sha256
        or not registration.approval_id
    ):
        # The provisioner only installs the profile the release names.
        raise ApiError(409, "release_changed", "the release changed; ask for it again")
    approval_id = registration.approval_id
    _audited(
        deps,
        EVENT_RETRY,
        caller,
        {"registration": registration_id, "approval_id": approval_id, "base_version": version},
        lambda: deps.store.retry(registration, deps.clock()),
    )
    _start(deps, registration_id, approval_id)


def disable(
    deps: RemoteMcpDeps, caller: Caller, registration_id: str, body: RemoteDisableIn
) -> None:
    """Ask the provisioner to remove the target and the provider (D93 (7)). One administrator,
    with a reason. Repeating it while ``disabling`` starts the removal again."""
    _writable(deps, caller)
    registration = _registration(deps, registration_id, body.version)
    again = registration.status is RemoteRegistrationStatus.DISABLING
    if not again:
        _status(registration, {RemoteRegistrationStatus.ACTIVE, RemoteRegistrationStatus.FAILED})
    if deps.provisioner is None:
        raise ApiError(503, "provisioner_unavailable", "the remote provisioner is not available")
    now = deps.clock()
    actor = caller.user.user_id
    pending = None if again else deps.store.pending(registration_id, now)
    approval_id = registration.approval_id if again else new_approval_id()
    if not approval_id:
        raise ApiError(409, "invalid_state", "the registration cannot do that now")

    def write() -> None:
        if again:
            return
        deps.store.disable(
            registration,
            approval_id=approval_id,
            by=actor,
            by_email=caller.user.email,
            reason=body.reason,
            pending=pending,
            now=now,
        )
        if pending is not None:
            _drop_provider(deps, pending.pending_provider_name)

    _audited(
        deps,
        EVENT_DISABLE,
        caller,
        {
            "registration": registration_id,
            "profile": registration.profile_id,
            "organization": registration.organization,
            "disabled_by": actor,
            "reason": body.reason,
            "approval_id": approval_id,
            "base_version": body.version,
            "cancelled_change": pending.change_id if pending else None,
        },
        write,
    )
    _start(deps, registration_id, approval_id)


# --- Routes -----------------------------------------------------------------------------


Authorize = Callable[..., Awaitable[None]]


def remote_mcp_router(
    deps: RemoteMcpDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    """Registered before the packs router: ``remotes`` is never a pack id."""
    router = APIRouter(prefix="/api/mcp/remotes")

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
    Manage = Annotated[Caller, Depends(action("ManageRemoteMcp"))]  # noqa: N806
    Approve = Annotated[Caller, Depends(action("ApproveRemoteMcp"))]  # noqa: N806
    ProfileId = Annotated[str, Path(pattern=PROFILE_ID_PATTERN)]  # noqa: N806
    RegId = Annotated[str, Path(pattern=REGISTRATION_ID_PATTERN)]  # noqa: N806
    ChangeId = Annotated[str, Path(pattern=CHANGE_ID_PATTERN)]  # noqa: N806
    RequestBody = Annotated[  # noqa: N806
        RemoteReplaceAppIn | RemoteReenableIn, Body(discriminator="kind")
    ]

    async def run[T](fn: Callable[..., T], *args: Any) -> T:
        try:
            return await asyncio.to_thread(fn, *args)
        except RemoteConflictError as exc:
            raise ApiError(409, "version_conflict", "the registration changed; reload") from exc
        except (RemoteRecordError, RemoteReleaseUnavailableError) as exc:
            raise ApiError(503, "catalog_unavailable", "please try again") from exc

    async def view(caller: Caller) -> RemoteCatalogOut:
        return await run(catalog_view, deps, caller)

    @router.get("", response_model=RemoteCatalogOut)
    async def get_remote_catalog(caller: View) -> RemoteCatalogOut:
        return await view(caller)

    @router.post("/{profile}/registrations", response_model=RemoteCatalogOut, status_code=201)
    async def request_remote_registration(
        profile: ProfileId, body: RemoteRegistrationIn, caller: Manage
    ) -> RemoteCatalogOut:
        await run(request_registration, deps, caller, profile, body)
        return await view(caller)

    @router.post("/registrations/{reg}/requests", response_model=RemoteCatalogOut, status_code=201)
    async def request_remote_change(
        reg: RegId, body: RequestBody, caller: Manage
    ) -> RemoteCatalogOut:
        await run(request_on_registration, deps, caller, reg, body)
        return await view(caller)

    @router.post("/registrations/{reg}/params", response_model=RemoteCatalogOut, status_code=201)
    async def request_remote_params(
        reg: RegId, body: RemoteParamsIn, caller: Manage
    ) -> RemoteCatalogOut:
        await run(request_params, deps, caller, reg, body)
        return await view(caller)

    @router.post(
        "/registrations/{reg}/requests/{change_id}/approve", response_model=RemoteCatalogOut
    )
    async def approve_remote_request(
        reg: RegId, change_id: ChangeId, _body: RemoteEmptyIn, caller: Approve
    ) -> RemoteCatalogOut:
        await run(approve, deps, caller, reg, change_id)
        return await view(caller)

    @router.post(
        "/registrations/{reg}/requests/{change_id}/reject", response_model=RemoteCatalogOut
    )
    async def reject_remote_request(
        reg: RegId, change_id: ChangeId, body: RemoteRejectIn, caller: Approve
    ) -> RemoteCatalogOut:
        await run(reject, deps, caller, reg, change_id, body.reason)
        return await view(caller)

    @router.post(
        "/registrations/{reg}/requests/{change_id}/withdraw", response_model=RemoteCatalogOut
    )
    async def withdraw_remote_request(
        reg: RegId, change_id: ChangeId, _body: RemoteEmptyIn, caller: Manage
    ) -> RemoteCatalogOut:
        await run(withdraw, deps, caller, reg, change_id)
        return await view(caller)

    @router.post("/registrations/{reg}/secret", response_model=RemoteCatalogOut)
    async def rotate_remote_secret(
        reg: RegId, body: RemoteRotateSecretIn, caller: Manage
    ) -> RemoteCatalogOut:
        await run(rotate_secret, deps, caller, reg, body)
        return await view(caller)

    @router.post("/registrations/{reg}/retry", response_model=RemoteCatalogOut)
    async def retry_remote(reg: RegId, body: RemoteRetryIn, caller: Manage) -> RemoteCatalogOut:
        await run(retry, deps, caller, reg, body.version)
        return await view(caller)

    @router.delete("/registrations/{reg}", response_model=RemoteCatalogOut)
    async def disable_remote(reg: RegId, body: RemoteDisableIn, caller: Manage) -> RemoteCatalogOut:
        await run(disable, deps, caller, reg, body)
        return await view(caller)

    return router
