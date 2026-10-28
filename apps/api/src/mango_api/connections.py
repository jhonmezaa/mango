"""«Mis conexiones» (D94, D97 (3), D98 (1), (17)): each person connects their own account to a
remote MCP, closes the consent when Microsoft sends them back, and disconnects.

* ``GET /api/me/connections``: the active or disabled registrations of the person's groups
  and whether they are connected. It never calls Microsoft: «Conectado» comes from the
  connection record mango-api keeps in the person's partition of ``Conversations``.
* ``POST /api/me/connections/{reg}/connect``: hands out the person's pending consent if there
  is one; otherwise probes the remote through the Gateway (claim ``cx = connect``). The probe
  either answers (already connected) or the ``RESPONSE`` interceptor stores a consent URL
  under the verified ``sub`` and mango-api hands that one out.
* ``POST /api/me/connections/{reg}/disconnect``: the probe with ``cx = disconnect`` and the
  documented ``forceAuthentication`` ``_meta``, which deletes the person's token from the
  vault. Done only when the Gateway confirms with ``consent_required`` (D97 (3)). It works
  with the app's secret expired: it only takes access away (security review NV-2).
* ``POST /api/oauth/callback``: the return view of the SPA (``/conexiones/vuelta``) posts the
  ``session_id`` Identity added to the URL; mango-api requires a pending consent of this person
  and closes it with ``CompleteResourceTokenAuth`` and the person's own access token (D98 (1)).
  Until the interceptor stores the session's hash (V-3), the session names no consent: with
  more than one pending, none is closed (``consent_ambiguous``, security review F-1).

Security notes (threat model ``remote-mcp``: TM-003, TM-010, TM-014, TM-017;
security-best-practices, FastAPI):
* Every route needs a verified access token, and every route on one registration checks
  ``UseRemoteMcp`` with the groups read from ``REMOTE#<reg>`` (being an administrator is not
  enough, D98 (18)). The list filters with the same decision.
* The pending consent is read under the ``sub`` of the verified token, never a value of the
  request: nobody can read or close another person's consent. Identity checks again that the
  session is this person's (``AccessDeniedException`` → ``consent_not_yours``).
* The consent URL is checked again before it is handed out (``https`` on
  ``bedrock-agentcore.<region>.amazonaws.com``, at most 2048 characters, D94 (2)). The URL, the
  ``session_id``, tokens and what the tool answered never reach a log or the audit trail.
* The callback is a bearer request of the SPA; it also requires the application's own
  ``Origin`` and same-origin fetch metadata, so no other site can post to it from a browser.
* Bodies forbid extra fields; the ``session_id`` must have the shape of an Identity request URI.
  Responses use explicit models. Each route is rate limited per person.
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import hashlib
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Path, Request
from pydantic import BaseModel, ConfigDict, Field

from mango_api.audit import AuditLog
from mango_api.authz import REMOTE_MCP_TYPE, RemoteMcpResource
from mango_api.gateway_mcp import ConnectionOutcome, GatewayConnections
from mango_api.rate_limits import Limiter
from mango_api.remote_mcp import secret_level
from mango_api.remote_mcp_store import (
    ApprovedRemotes,
    Registration,
    RemoteRecordError,
    RemoteRegistrationStatus,
    RemoteStore,
)
from mango_api.remote_release import ReleaseRemote, ReleaseRemotes, RemoteReleaseUnavailableError
from mango_api.web import ApiError, Caller, rate_limited
from mango_core.remote_mcp import (
    CONNECTION_SK_PREFIX,
    REGISTRATION_ID_PATTERN,
    PendingConsent,
    consent_key,
    is_consent_url,
    is_registration_id,
)
from mango_packs.enablement import iso

logger = logging.getLogger(__name__)

CONNECTS_PER_MINUTE = 20
DISCONNECTS_PER_MINUTE = 10
CALLBACKS_PER_MINUTE = 20
SESSION_URI_PATTERN = r"^urn:ietf:params:oauth:request_uri:[A-Za-z0-9._~-]{1,990}$"
"""``sessionUri`` of ``CompleteResourceTokenAuth`` (the pattern of the Identity API)."""

EVENT_CONSENT_STARTED = "mcp_remote.consent_started"
EVENT_CONSENT_COMPLETED = "mcp_remote.consent_completed"
EVENT_CONSENT_FAILED = "mcp_remote.consent_failed"
EVENT_DISCONNECT = "mcp_remote.disconnect"

ConnectionStatus = Literal["not_connected", "connected", "disabled", "secret_expired"]
_LISTED = frozenset({RemoteRegistrationStatus.ACTIVE, RemoteRegistrationStatus.DISABLED})


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ConnectionEmptyIn(_Strict):
    pass


class CallbackIn(_Strict):
    session_id: str = Field(pattern=SESSION_URI_PATTERN, max_length=1024)


class ConnectionOut(_Strict):
    registration_id: str
    profile_id: str
    service: str
    """Name of the service, from the signed profile (``profile_id`` if the release lost it)."""
    provider: str | None
    organization: str
    link_hosts: list[str]
    """Hosts of the service's links, for the web to classify them (design A1)."""
    status: ConnectionStatus
    connected_at: str | None = None
    """When the person connected: with ``connected``, and with ``secret_expired`` if they had."""


class ConnectionsOut(_Strict):
    connections: list[ConnectionOut]


class ConnectOut(_Strict):
    status: Literal["already_connected", "consent_required"]
    authorization_url: str | None = None
    """Only with ``consent_required``: the AgentCore Identity URL to open, in the same tab."""
    expires_at: str | None = None


class CallbackOut(_Strict):
    status: Literal["connected"]
    registration_id: str
    profile_id: str


# --- Data access ------------------------------------------------------------------------


class ConnectionsUnavailableError(Exception):
    """A table could not be read or written."""


@dataclass(frozen=True)
class ConnectionRecord:
    connected_at: str | None
    generation: int | None


def _s(value: str) -> dict[str, str]:
    return {"S": value}


class ConnectionRecords:
    """``Conversations``: ``USER#<sub>`` / ``REMOTE#<reg>``, written with the person's RLS
    credentials (``dynamodb:LeadingKeys``). A disconnect overwrites the record instead of
    deleting it: the session policy grants no ``DeleteItem``."""

    def __init__(self, clients: Callable[[str], Any], table: str) -> None:
        self._clients = clients
        self._table = table

    @staticmethod
    def _key(user_id: str, registration_id: str) -> dict[str, Any]:
        return {"PK": _s(f"USER#{user_id}"), "SK": _s(CONNECTION_SK_PREFIX + registration_id)}

    def all(self, user_id: str) -> dict[str, ConnectionRecord]:
        try:
            response = self._clients(user_id).query(
                TableName=self._table,
                KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
                ExpressionAttributeValues={
                    ":pk": _s(f"USER#{user_id}"),
                    ":prefix": _s(CONNECTION_SK_PREFIX),
                },
            )
        except (ClientError, BotoCoreError) as exc:
            raise ConnectionsUnavailableError from exc
        records: dict[str, ConnectionRecord] = {}
        for item in response.get("Items", []):
            registration_id = item["SK"]["S"][len(CONNECTION_SK_PREFIX) :]
            if not is_registration_id(registration_id):
                continue
            generation = item.get("generation", {}).get("N")
            records[registration_id] = ConnectionRecord(
                connected_at=item.get("connected_at", {}).get("S"),
                generation=int(generation) if generation is not None else None,
            )
        return records

    def _put(self, user_id: str, item: dict[str, Any]) -> None:
        try:
            self._clients(user_id).put_item(TableName=self._table, Item=item)
        except (ClientError, BotoCoreError) as exc:
            raise ConnectionsUnavailableError from exc

    def connected(self, user_id: str, registration_id: str, generation: int, now: datetime) -> None:
        self._put(
            user_id,
            {
                **self._key(user_id, registration_id),
                "connected_at": _s(iso(now)),
                "generation": {"N": str(generation)},
            },
        )

    def disconnected(self, user_id: str, registration_id: str, now: datetime) -> None:
        self._put(user_id, {**self._key(user_id, registration_id), "disconnected_at": _s(iso(now))})


class PendingConsents:
    """``Settings``: ``MCP_CONSENT#<sub>``, written only by the ``RESPONSE`` interceptor (IAM
    denies mango-api ``PutItem`` and ``UpdateItem`` there, TM-017); mango-api reads and
    deletes. Only the partition of the verified ``sub`` is ever read."""

    def __init__(self, dynamodb: Any, table: str, *, region: str) -> None:
        self._db = dynamodb
        self._table = table
        self._region = region

    def get(self, user_id: str, registration_id: str, now: datetime) -> PendingConsent | None:
        try:
            item = self._db.get_item(
                TableName=self._table,
                Key=consent_key(user_id, registration_id),
                ConsistentRead=True,
            ).get("Item")
        except (ClientError, BotoCoreError) as exc:
            raise ConnectionsUnavailableError from exc
        if item is None:
            return None
        return PendingConsent.from_item(
            item,
            subject=user_id,
            registration_id=registration_id,
            region=self._region,
            now=now.timestamp(),
        )

    def all(self, user_id: str, now: datetime) -> list[PendingConsent]:
        """This person's unexpired pending consents, newest first."""
        partition = consent_key(user_id, "a" * 12)["PK"]
        try:
            items = self._db.query(
                TableName=self._table,
                KeyConditionExpression="PK = :pk",
                ExpressionAttributeValues={":pk": partition},
                ConsistentRead=True,
            ).get("Items", [])
        except (ClientError, BotoCoreError) as exc:
            raise ConnectionsUnavailableError from exc
        found = []
        for item in items:
            registration_id = item["SK"]["S"][len(CONNECTION_SK_PREFIX) :]
            if not is_registration_id(registration_id):
                continue
            consent = PendingConsent.from_item(
                item,
                subject=user_id,
                registration_id=registration_id,
                region=self._region,
                now=now.timestamp(),
            )
            if consent is not None:
                found.append(consent)
        return sorted(found, key=lambda c: c.created_at, reverse=True)

    def delete(self, user_id: str, registration_id: str) -> None:
        try:
            self._db.delete_item(TableName=self._table, Key=consent_key(user_id, registration_id))
        except (ClientError, BotoCoreError) as exc:
            raise ConnectionsUnavailableError from exc


class ConsentError(Exception):
    """``CompleteResourceTokenAuth`` refused; ``code`` is the closed reason shown to the web."""

    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


_NOT_YOURS = frozenset({"AccessDeniedException"})
# An IAM denial names the action and the resource, never the session or a token.
_IAM_DENIAL = re.compile(
    r"is not authorized to perform: (bedrock-agentcore:[A-Za-z0-9]+) on resource: (arn:[\w:/.*-]+)"
)
_EXPIRED = frozenset({"ValidationException", "ResourceNotFoundException"})


class ConsentCompleter:
    """AgentCore Identity (data plane): closes a consent with the person's own access token,
    from credentials that are not the Gateway's (finding of 2026-10-26)."""

    def __init__(self, client: Any) -> None:
        self._client = client

    def complete(self, access_token: str, session_uri: str) -> None:
        try:
            self._client.complete_resource_token_auth(
                userIdentifier={"userToken": access_token}, sessionUri=session_uri
            )
        except ClientError as exc:
            # The code only: the message could echo the request.
            code = str(exc.response.get("Error", {}).get("Code", "error"))
            denied = _IAM_DENIAL.search(str(exc.response.get("Error", {}).get("Message", "")))
            if code in _NOT_YOURS and denied:
                # IAM refused mango-api, not the person: only the action and the resource.
                logger.warning(
                    "identity denied mango-api %s on %s", denied.group(1), denied.group(2)
                )
                raise ConsentError(502, "identity_unavailable") from None
            if code in _NOT_YOURS:
                raise ConsentError(403, "consent_not_yours") from None
            if code in _EXPIRED:
                raise ConsentError(410, "consent_expired") from None
            logger.warning("identity did not complete a consent: %s", code)
            raise ConsentError(502, "identity_unavailable") from None
        except BotoCoreError:
            logger.warning("identity could not be reached to complete a consent")
            raise ConsentError(502, "identity_unavailable") from None


# --- Use cases --------------------------------------------------------------------------


@dataclass
class ConnectionsDeps:
    registrations: RemoteStore
    release: ReleaseRemotes
    records: ConnectionRecords
    consents: PendingConsents
    audit: AuditLog
    clock: Callable[[], datetime]
    region: str
    app_origin: str
    """Public origin of the application: the only ``Origin`` the callback accepts."""
    connects: Limiter
    disconnects: Limiter
    callbacks: Limiter
    enabled: bool = False
    """``RemoteMcpEnabled`` (D98 (4)): off, «Conectar» and the callback answer 409."""
    approved: ApprovedRemotes | None = None
    gateway: GatewayConnections | None = None
    completer: ConsentCompleter | None = None


Authorize = Callable[..., Awaitable[None]]


def _service(remote: ReleaseRemote | None, registration: Registration) -> dict[str, Any]:
    if remote is None:
        return {"service": registration.profile_id, "provider": None, "link_hosts": []}
    profile = remote.profile
    return {
        "service": profile.name,
        "provider": profile.provider.display_name,
        "link_hosts": list(profile.link_hosts),
    }


def _status(
    registration: Registration, record: ConnectionRecord | None, now: datetime
) -> ConnectionStatus:
    if registration.status is not RemoteRegistrationStatus.ACTIVE:
        return "disabled"
    if secret_level(registration.secret_expires_on, now.date()) == "expired":
        return "secret_expired"
    # A connection of another generation of the provider (a new tenant or app) is gone.
    if record and record.connected_at and record.generation == registration.generation:
        return "connected"
    return "not_connected"


def _connection_out(
    deps: ConnectionsDeps,
    registration: Registration,
    record: ConnectionRecord | None,
    now: datetime,
) -> ConnectionOut:
    status = _status(registration, record, now)
    # With the app's secret expired the person may still disconnect an account they connected
    # (D97): the date says there is one (design round 24, «Desconectar» with the secret expired).
    connected = bool(
        record and record.connected_at and record.generation == registration.generation
    )
    return ConnectionOut(
        registration_id=registration.registration_id,
        profile_id=registration.profile_id,
        organization=registration.organization,
        status=status,
        connected_at=(
            record.connected_at
            if record and connected and status in ("connected", "secret_expired")
            else None
        ),
        **_service(deps.release.get(registration.profile_id), registration),
    )


def _resource(registration: Registration) -> RemoteMcpResource:
    return RemoteMcpResource(registration.registration_id, frozenset(registration.groups))


def list_connections(
    deps: ConnectionsDeps,
    caller: Caller,
    may_use: Callable[[Caller, Registration], bool],
) -> ConnectionsOut:
    user_id, now = caller.user.user_id, deps.clock()
    usable = [
        r for r in deps.registrations.registrations() if r.status in _LISTED and may_use(caller, r)
    ]
    records = deps.records.all(user_id) if usable else {}
    return ConnectionsOut(
        connections=[_connection_out(deps, r, records.get(r.registration_id), now) for r in usable]
    )


def _enabled(registration: Registration) -> None:
    if registration.status is not RemoteRegistrationStatus.ACTIVE:
        raise ApiError(409, "remote_disabled", "an administrator disabled this service")


def _active(deps: ConnectionsDeps, registration: Registration) -> None:
    _enabled(registration)
    if secret_level(registration.secret_expires_on, deps.clock().date()) == "expired":
        raise ApiError(409, "secret_expired", "the service cannot be connected for now")


def _limit(limiter: Limiter, caller: Caller) -> None:
    if not limiter.allow(caller.user.user_id):
        raise rate_limited(limiter.retry_after(caller.user.user_id))


def _probe(
    deps: ConnectionsDeps, caller: Caller, registration: Registration, connection: Any
) -> ConnectionOutcome:
    """The probe tool of the signed catalog, with the arguments of the signed profile."""
    approved = deps.approved.get(registration.registration_id) if deps.approved else None
    remote = deps.release.get(registration.profile_id)
    if approved is None or remote is None or deps.gateway is None:
        raise ApiError(503, "gateway_unavailable", "please try again in a few minutes")
    probe = remote.profile.probe
    arguments = dict(probe.arguments) if probe.tool == approved.probe_tool else {}
    return deps.gateway.call(
        subject=caller.user.user_id,
        access_token=caller.token,
        token_expires_at=caller.expires_at,
        registration_id=registration.registration_id,
        tool=approved.probe_tool,
        arguments=arguments,
        connection=connection,
    )


def _handed_out(deps: ConnectionsDeps, caller: Caller, consent: PendingConsent) -> ConnectOut:
    # The interceptor checked it when it stored it; checked again before it leaves (D94 (2)).
    if not is_consent_url(consent.authorization_url, deps.region):
        raise ApiError(503, "gateway_unavailable", "please try again in a few minutes")
    try:
        deps.audit.emit(
            EVENT_CONSENT_STARTED,
            caller.user.user_id,
            {"registration": consent.registration_id, "source": consent.source},
            caller.user,
        )
    except Exception as exc:
        # No URL leaves without its trail (fail closed, TM-A9).
        raise ApiError(503, "audit_unavailable", "please try again") from exc
    return ConnectOut(
        status="consent_required",
        authorization_url=consent.authorization_url,
        expires_at=iso(datetime.fromtimestamp(consent.expires_at, tz=UTC)),
    )


def connect(deps: ConnectionsDeps, caller: Caller, registration: Registration) -> ConnectOut:
    user_id = caller.user.user_id
    pending = deps.consents.get(user_id, registration.registration_id, deps.clock())
    if pending is not None:
        return _handed_out(deps, caller, pending)
    outcome = _probe(deps, caller, registration, "connect")
    if outcome is ConnectionOutcome.ANSWERED:
        # The vault already had the person's token: Microsoft is not opened (design A6).
        deps.records.connected(
            user_id, registration.registration_id, registration.generation, deps.clock()
        )
        return ConnectOut(status="already_connected")
    if outcome is ConnectionOutcome.CONSENT_REQUIRED:
        # The RESPONSE interceptor stored the URL under the verified sub before answering.
        pending = deps.consents.get(user_id, registration.registration_id, deps.clock())
        if pending is not None:
            return _handed_out(deps, caller, pending)
        logger.warning("consent required but no pending consent was stored")
    raise ApiError(503, "gateway_unavailable", "please try again in a few minutes")


def disconnect(deps: ConnectionsDeps, caller: Caller, registration: Registration) -> ConnectionOut:
    user_id, reg = caller.user.user_id, registration.registration_id
    outcome = _probe(deps, caller, registration, "disconnect")
    if outcome is ConnectionOutcome.ANSWERED:
        # The tool answered with the token: the vault still has it (D97 (3)).
        raise ApiError(502, "disconnect_not_confirmed", "the connection could not be removed")
    if outcome is not ConnectionOutcome.CONSENT_REQUIRED:
        raise ApiError(503, "gateway_unavailable", "please try again in a few minutes")
    now = deps.clock()
    deps.consents.delete(user_id, reg)
    deps.records.disconnected(user_id, reg, now)
    try:
        deps.audit.emit(EVENT_DISCONNECT, user_id, {"registration": reg}, caller.user)
    except Exception:
        # The token is already gone: the answer says so even if the trail could not.
        logger.exception("audit emit failed after a disconnect")
    return _connection_out(deps, registration, None, now)


class _AmbiguousConsentError(Exception):
    """More than one pending consent without a hash: the session names none of them."""


def _pick(consents: list[PendingConsent], session_uri: str) -> PendingConsent | None:
    """The pending consent this session closes. With the session's hash (live check V-3) it
    must match; without it, the person's only pending consent. With several and no hash the
    session could close any of them, so none is taken (security review F-1)."""
    digest = hashlib.sha256(session_uri.encode()).hexdigest()
    for consent in consents:
        if consent.session_sha256 == digest:
            return consent
    unhashed = [c for c in consents if c.session_sha256 is None]
    if len(unhashed) > 1:
        raise _AmbiguousConsentError
    return unhashed[0] if unhashed else None


def _consent_failed(
    deps: ConnectionsDeps, caller: Caller, registration_id: str | None, reason: str
) -> None:
    try:
        deps.audit.emit(
            EVENT_CONSENT_FAILED,
            caller.user.user_id,
            {"registration": registration_id, "reason": reason},
            caller.user,
        )
    except Exception:
        logger.exception("audit emit failed after a failed consent")


def _close(deps: ConnectionsDeps, access_token: str, session_uri: str) -> None:
    if deps.completer is None:
        raise ConsentError(502, "identity_unavailable")
    deps.completer.complete(access_token, session_uri)


def _registered(registration: Registration | None) -> Registration:
    if registration is None:
        raise ApiError(409, "remote_disabled", "an administrator disabled this service")
    return registration


def pending_for(deps: ConnectionsDeps, caller: Caller, session_uri: str) -> PendingConsent:
    """The person's pending consent this session closes, read under the verified ``sub``."""
    try:
        consent = _pick(deps.consents.all(caller.user.user_id, deps.clock()), session_uri)
    except _AmbiguousConsentError:
        # Nothing is marked, deleted or closed: the person asks for the connection again.
        _consent_failed(deps, caller, None, "consent_ambiguous")
        raise ApiError(409, "consent_ambiguous", "ask for the connection again") from None
    if consent is None:
        _consent_failed(deps, caller, None, "consent_expired")
        raise ApiError(410, "consent_expired", "the link expired; ask for the connection again")
    return consent


def complete(
    deps: ConnectionsDeps,
    caller: Caller,
    consent: PendingConsent,
    registration: Registration,
    session_uri: str,
) -> CallbackOut:
    """Close the consent with the person's own access token (``UseRemoteMcp`` was checked)."""
    user_id, reg = caller.user.user_id, registration.registration_id
    try:
        _active(deps, registration)
        _close(deps, caller.token, session_uri)
    except ConsentError as exc:
        _consent_failed(deps, caller, reg, exc.code)
        raise ApiError(exc.status, exc.code, "the connection could not be completed") from None
    except ApiError as exc:
        _consent_failed(deps, caller, reg, exc.code)
        raise
    deps.consents.delete(user_id, reg)
    deps.records.connected(user_id, reg, registration.generation, deps.clock())
    try:
        deps.audit.emit(
            EVENT_CONSENT_COMPLETED,
            user_id,
            {"registration": reg, "source": consent.source},
            caller.user,
        )
    except Exception:
        # Identity already holds the token: the answer says so even if the trail could not.
        logger.exception("audit emit failed after a completed consent")
    return CallbackOut(status="connected", registration_id=reg, profile_id=registration.profile_id)


# --- Router -----------------------------------------------------------------------------


def connections_router(
    deps: ConnectionsDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
    may_use: Callable[[Caller, Registration], bool],
) -> APIRouter:
    """``authorize`` is the audited Cedar check of ``app.py``; ``may_use`` the same decision
    without a trail, to filter the list."""
    router = APIRouter()
    CallerDep = Annotated[Caller, Depends(current_user)]  # noqa: N806
    RegId = Annotated[str, Path(pattern=REGISTRATION_ID_PATTERN)]  # noqa: N806

    async def run[T](fn: Callable[..., T], *args: Any) -> T:
        try:
            return await asyncio.to_thread(fn, *args)
        except (
            ConnectionsUnavailableError,
            RemoteRecordError,
            RemoteReleaseUnavailableError,
        ) as exc:
            raise ApiError(503, "connections_unavailable", "please try again") from exc

    async def usable(caller: Caller, registration: Registration) -> None:
        try:
            await authorize(
                caller,
                "UseRemoteMcp",
                REMOTE_MCP_TYPE,
                registration.registration_id,
                remote=_resource(registration),
            )
        except Exception as exc:
            raise ApiError(403, "remote_not_usable", "not enabled for your groups") from exc

    async def registration_for(caller: Caller, reg: str) -> Registration:
        registration = await run(deps.registrations.registration, reg)
        if registration is None:
            raise ApiError(404, "not_found", "no such service")
        await usable(caller, registration)
        return registration

    async def same_origin(request: Request) -> None:
        """The SPA's own page posts the callback; nothing else from a browser (TM-003)."""
        headers = request.headers
        fetch_site = headers.get("sec-fetch-site")
        if (
            not deps.app_origin
            or headers.get("origin") != deps.app_origin
            or (fetch_site is not None and fetch_site != "same-origin")
        ):
            raise ApiError(403, "forbidden", "not allowed")

    @router.get("/api/me/connections", response_model=ConnectionsOut)
    async def list_my_connections(caller: CallerDep) -> ConnectionsOut:
        return await run(list_connections, deps, caller, may_use)

    @router.post("/api/me/connections/{reg}/connect", response_model=ConnectOut)
    async def connect_my_account(
        reg: RegId, _body: ConnectionEmptyIn, caller: CallerDep
    ) -> ConnectOut:
        if not deps.enabled:
            raise ApiError(
                409, "remote_disabled", "remote MCP servers are off in this installation"
            )
        _limit(deps.connects, caller)
        registration = await registration_for(caller, reg)
        _active(deps, registration)
        return await run(connect, deps, caller, registration)

    @router.post("/api/me/connections/{reg}/disconnect", response_model=ConnectionOut)
    async def disconnect_my_account(
        reg: RegId, _body: ConnectionEmptyIn, caller: CallerDep
    ) -> ConnectionOut:
        _limit(deps.disconnects, caller)
        registration = await registration_for(caller, reg)
        # Only an active registration still has its target; an expired secret does not stop
        # a disconnect, which only takes access away (security review NV-2).
        _enabled(registration)
        return await run(disconnect, deps, caller, registration)

    @router.post(
        "/api/oauth/callback",
        response_model=CallbackOut,
        dependencies=[Depends(same_origin)],
    )
    async def complete_consent(body: CallbackIn, caller: CallerDep) -> CallbackOut:
        if not deps.enabled:
            raise ApiError(
                409, "remote_disabled", "remote MCP servers are off in this installation"
            )
        _limit(deps.callbacks, caller)
        consent = await run(pending_for, deps, caller, body.session_id)
        registration = await run(deps.registrations.registration, consent.registration_id)
        try:
            await usable(caller, _registered(registration))
        except ApiError as exc:
            await run(_consent_failed, deps, caller, consent.registration_id, exc.code)
            raise
        return await run(
            complete, deps, caller, consent, _registered(registration), body.session_id
        )

    return router
