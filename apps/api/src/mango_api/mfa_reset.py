"""Reset a user's MFA with dual approval (D20; threat model ``login-threat-model.md`` TM-L6,
TM-L14).

An administrator proposes resetting another user's TOTP after verifying their identity out of
band; a **different** administrator approves it. When applied, ``AdminDeleteSoftwareToken``
deletes the user's registered TOTP and ``AdminUserGlobalSignOut`` revokes their refresh tokens:
their next sign-in falls into MFA enrollment (``MFA_SETUP``). ``AdminSetUserMFAPreference`` is
not enough: it only changes the preference and Cognito keeps challenging the old TOTP when MFA is
required (found in the lab, 2026-09-30). Access tokens already issued stay valid
until they expire (at most 60 minutes).

Security notes (security-best-practices, FastAPI):
* Every route declares its Cedar action (``ViewAdmin``, ``ProposeMfaReset``,
  ``ApproveMfaReset``); the decision is audited and ``is_admin`` is re-checked in process.
* Nobody resets their own MFA, proposes and approves the same request, or decides on a request
  about themselves. A refused attempt is audited (``outcome: rejected``).
* Fail-closed audit: ``requested`` is recorded before any write or Cognito call.
* Rate limits: proposals per administrator (in process), one open request per user and a
  cooldown after a reset (both persisted in the Settings table).
* The target is identified by email only to look it up; everything afterwards uses the Cognito
  ``sub`` and username returned by ``AdminGetUser``.
* Bodies forbid extra fields and responses use explicit models (VALID-001, RESP-001).
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Annotated, Any, Literal, NoReturn

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

from mango_api.audit import AuditLog
from mango_api.probe import RateLimiter
from mango_api.web import ApiError, Caller

if TYPE_CHECKING:
    from mypy_boto3_cognito_idp import CognitoIdentityProviderClient
    from mypy_boto3_dynamodb import DynamoDBClient

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
PK_REQUEST = "MFA_RESET"
PK_TARGET = "MFA_RESET_TARGET"
REQUEST_LIFETIME = timedelta(hours=72)  # D28; the design shows 72 h
RESET_COOLDOWN = timedelta(hours=24)
REQUEST_RETENTION = timedelta(days=90)  # table TTL; the audit trail keeps the evidence
LIST_WINDOW = timedelta(days=30)
MAX_PENDING = 10
PROPOSALS_PER_HOUR = 5
CHANGE_ID_PATTERN = r"^[0-9a-f]{32}$"
_EMAIL_PATTERN = r"^[^@\s]{1,64}@[^@\s]{1,253}$"

Status = Literal["pending", "applying", "approved", "rejected", "withdrawn"]


# --- Cognito ----------------------------------------------------------------------------


class UserNotFoundError(Exception):
    pass


class CognitoUnavailableError(Exception):
    pass


@dataclass(frozen=True)
class DirectoryUser:
    username: str
    sub: str
    email: str | None
    federated: bool


class CognitoUsers:
    """The two Cognito operations mango-api may perform on users, on one user pool only."""

    def __init__(self, client: "CognitoIdentityProviderClient", user_pool_id: str) -> None:
        if not user_pool_id:
            raise ValueError("user pool id is required")
        self._client = client
        self._pool = user_pool_id

    def lookup(self, email: str) -> DirectoryUser:
        try:
            # With email as a username attribute, AdminGetUser accepts the email.
            resp = self._client.admin_get_user(UserPoolId=self._pool, Username=email)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "UserNotFoundException":
                raise UserNotFoundError from exc
            raise CognitoUnavailableError from exc
        except BotoCoreError as exc:
            raise CognitoUnavailableError from exc
        attributes = {a["Name"]: a.get("Value", "") for a in resp.get("UserAttributes", [])}
        sub = attributes.get("sub", "")
        if not sub:
            raise CognitoUnavailableError("user without sub")
        return DirectoryUser(
            username=resp["Username"],
            sub=sub,
            email=attributes.get("email") or None,
            federated=resp.get("UserStatus") == "EXTERNAL_PROVIDER",
        )

    def reset_mfa(self, username: str) -> None:
        """Delete the registered TOTP, then revoke every refresh token of the user.

        Idempotent: a user without a TOTP registration (never enrolled, or a retry after the
        token was already deleted) makes Cognito answer ``ResourceNotFoundException``.
        """
        try:
            try:
                self._client.admin_delete_software_token(UserPoolId=self._pool, Username=username)
            except ClientError as exc:
                if exc.response.get("Error", {}).get("Code") != "ResourceNotFoundException":
                    raise
            self._client.admin_user_global_sign_out(UserPoolId=self._pool, Username=username)
        except (ClientError, BotoCoreError) as exc:
            raise CognitoUnavailableError from exc


# --- Repository -------------------------------------------------------------------------


class ConflictError(Exception):
    """A concurrent change or an open request for the same user (optimistic locking)."""


@dataclass(frozen=True)
class ResetRequest:
    change_id: str
    status: Status
    target_user: str
    target_username: str
    target_email: str | None
    proposed_by: str
    proposed_by_email: str | None
    reason: str
    created_at: datetime
    expires_at: datetime
    # The proposer declared an out-of-band identity check (D20). Always true for new requests.
    identity_verified: bool = False
    decided_by: str | None = None
    decided_by_email: str | None = None
    decided_at: datetime | None = None
    note: str | None = None


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds")


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _opt(item: dict[str, Any], key: str) -> str | None:
    value = item.get(key, {}).get("S")
    return str(value) if value else None


def _conflict(exc: ClientError) -> None:
    code = exc.response.get("Error", {}).get("Code")
    if code in {"ConditionalCheckFailedException", "TransactionCanceledException"}:
        raise ConflictError from exc
    raise exc


class ResetStore:
    """Items in the Settings table (only mango-api writes it, TM-A6):

    * ``MFA_RESET`` / ``<change_id>``: the request and its decision.
    * ``MFA_RESET_TARGET`` / ``<sub>``: ``pending`` (open request id and its expiry) and
      ``last_reset_at``, so there is one open request per user and a cooldown after a reset.
    """

    def __init__(self, dynamodb: "DynamoDBClient", table: str) -> None:
        self._db = dynamodb
        self._table = table

    @staticmethod
    def _parse(item: dict[str, Any]) -> ResetRequest:
        decided_at = _opt(item, "decided_at")
        return ResetRequest(
            change_id=item["SK"]["S"],
            status=item["status"]["S"],
            target_user=item["target_user"]["S"],
            target_username=item["target_username"]["S"],
            target_email=_opt(item, "target_email"),
            proposed_by=item["proposed_by"]["S"],
            proposed_by_email=_opt(item, "proposed_by_email"),
            reason=item["reason"]["S"],
            created_at=datetime.fromisoformat(item["created_at"]["S"]),
            expires_at=datetime.fromisoformat(item["expires_at"]["S"]),
            identity_verified=bool(item.get("identity_verified", {}).get("BOOL", False)),
            decided_by=_opt(item, "decided_by"),
            decided_by_email=_opt(item, "decided_by_email"),
            decided_at=datetime.fromisoformat(decided_at) if decided_at else None,
            note=_opt(item, "note"),
        )

    def get(self, change_id: str) -> ResetRequest | None:
        item = self._db.get_item(
            TableName=self._table,
            Key={"PK": _s(PK_REQUEST), "SK": _s(change_id)},
            ConsistentRead=True,
        ).get("Item")
        return self._parse(item) if item else None

    def recent(self, now: datetime) -> list[ResetRequest]:
        items: list[ResetRequest] = []
        paginator = self._db.get_paginator("query")
        pages = paginator.paginate(
            TableName=self._table,
            KeyConditionExpression="PK = :pk",
            ExpressionAttributeValues={":pk": _s(PK_REQUEST)},
            ConsistentRead=True,
        )
        for page_number, page in enumerate(pages):
            if page_number >= 20:  # noqa: PLR2004 - hard stop on a runaway partition
                break
            items.extend(self._parse(i) for i in page.get("Items", []))
        cutoff = now - LIST_WINDOW
        items = [r for r in items if r.created_at >= cutoff]
        return sorted(items, key=lambda r: r.created_at, reverse=True)

    def target_state(self, sub: str, now: datetime) -> tuple[bool, datetime | None]:
        """``(has_open_request, last_reset_at)`` for a user at ``now``."""
        item = (
            self._db.get_item(
                TableName=self._table,
                Key={"PK": _s(PK_TARGET), "SK": _s(sub)},
                ConsistentRead=True,
            ).get("Item")
            or {}
        )
        pending_until = _opt(item, "pending_expires_at")
        last = _opt(item, "last_reset_at")
        open_request = bool(pending_until and datetime.fromisoformat(pending_until) > now)
        return open_request, datetime.fromisoformat(last) if last else None

    def create(self, request: ResetRequest, now: datetime) -> None:
        item: dict[str, Any] = {
            "PK": _s(PK_REQUEST),
            "SK": _s(request.change_id),
            "status": _s("pending"),
            "target_user": _s(request.target_user),
            "target_username": _s(request.target_username),
            "proposed_by": _s(request.proposed_by),
            "reason": _s(request.reason),
            "created_at": _s(iso(request.created_at)),
            "expires_at": _s(iso(request.expires_at)),
            "identity_verified": {"BOOL": request.identity_verified},
            "ttl": {"N": str(int((now + REQUEST_RETENTION).timestamp()))},
        }
        if request.target_email:
            item["target_email"] = _s(request.target_email)
        if request.proposed_by_email:
            item["proposed_by_email"] = _s(request.proposed_by_email)
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
                        # One open request per user; an expired one no longer blocks.
                        "Update": {
                            "TableName": self._table,
                            "Key": {"PK": _s(PK_TARGET), "SK": _s(request.target_user)},
                            "UpdateExpression": "SET pending = :id, pending_expires_at = :exp",
                            "ConditionExpression": (
                                "attribute_not_exists(pending) OR pending_expires_at < :now"
                            ),
                            "ExpressionAttributeValues": {
                                ":id": _s(request.change_id),
                                ":exp": _s(iso(request.expires_at)),
                                ":now": _s(iso(now)),
                            },
                        }
                    },
                ]
            )
        except ClientError as exc:
            _conflict(exc)

    def transition(
        self,
        request: ResetRequest,
        *,
        to: Status,
        expected: Status,
        actor: str | None = None,
        actor_email: str | None = None,
        note: str | None = None,
        now: datetime,
    ) -> None:
        """Conditional status change; closing a request also releases the user's lock.

        An expired request no longer holds the lock (a new request may have taken it), so
        closing it leaves the lock alone.
        """
        names = {"#status": "status"}
        values: dict[str, Any] = {":to": _s(to), ":expected": _s(expected)}
        sets = ["#status = :to"]
        if actor:
            sets += ["decided_by = :by", "decided_at = :at"]
            values |= {":by": _s(actor), ":at": _s(iso(now))}
        if actor_email:
            sets.append("decided_by_email = :by_email")
            values[":by_email"] = _s(actor_email)
        if note:
            sets.append("note = :note")
            values[":note"] = _s(note)
        items: list[Any] = [
            {
                "Update": {
                    "TableName": self._table,
                    "Key": {"PK": _s(PK_REQUEST), "SK": _s(request.change_id)},
                    "UpdateExpression": "SET " + ", ".join(sets),
                    "ConditionExpression": "#status = :expected",
                    "ExpressionAttributeNames": names,
                    "ExpressionAttributeValues": values,
                }
            }
        ]
        if to in {"approved", "rejected", "withdrawn"} and now < request.expires_at:
            release: dict[str, Any] = {
                "TableName": self._table,
                "Key": {"PK": _s(PK_TARGET), "SK": _s(request.target_user)},
                "UpdateExpression": "REMOVE pending, pending_expires_at",
                "ConditionExpression": "pending = :id",
                "ExpressionAttributeValues": {":id": _s(request.change_id)},
            }
            if to == "approved":
                release["UpdateExpression"] += " SET last_reset_at = :at"
                release["ExpressionAttributeValues"][":at"] = _s(iso(now))
            items.append({"Update": release})
        try:
            self._db.transact_write_items(TransactItems=items)
        except ClientError as exc:
            _conflict(exc)


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _normalize_email(value: object) -> object:
    return value.strip().lower() if isinstance(value, str) else value


def _only_json_true(value: object) -> object:
    if value is not True:
        raise ValueError("must be true")
    return value


EmailIn = Annotated[
    str, BeforeValidator(_normalize_email), Field(max_length=254, pattern=_EMAIL_PATTERN)
]
Reason = Annotated[str, Field(min_length=1, max_length=500)]


class ProposeIn(_Strict):
    email: EmailIn
    reason: Reason
    # D20: the proposer must declare that they verified the user's identity through another
    # channel (call, video call, in person). Required by the server, not only the UI; strict so
    # that only a JSON ``true`` counts (not ``1`` or ``"true"``).
    identity_verified: Annotated[Literal[True], BeforeValidator(_only_json_true)]


class EmptyIn(_Strict):
    pass


class RejectIn(_Strict):
    reason: Reason


class ResetOut(_Strict):
    change_id: str
    status: Literal["pending", "approved", "rejected", "withdrawn", "expired"]
    target_user: str
    target_email: str | None
    proposed_by: str
    proposed_by_email: str | None
    reason: str
    identity_verified: bool
    created_at: str
    expires_at: str
    decided_by: str | None
    decided_by_email: str | None
    decided_at: str | None
    note: str | None


class ResetListOut(_Strict):
    items: list[ResetOut]


class ResetCreatedOut(_Strict):
    change_id: str


# --- Use cases --------------------------------------------------------------------------


@dataclass
class MfaResetDeps:
    store: ResetStore
    users: CognitoUsers
    audit: AuditLog
    rate_limiter: RateLimiter
    clock: Callable[[], datetime]
    end_sessions: Callable[[str], None] | None = None
    """Ends the web sessions of a user id (D63), next to the Cognito sign-out."""


def new_change_id() -> str:
    """Random public id (never incremental)."""
    return secrets.token_hex(16)


def _out(request: ResetRequest, now: datetime) -> ResetOut:
    status = request.status
    if status == "applying":
        status = "pending"
    shown: Any = "expired" if status == "pending" and now >= request.expires_at else status
    return ResetOut(
        change_id=request.change_id,
        status=shown,
        target_user=request.target_user,
        target_email=request.target_email,
        proposed_by=request.proposed_by,
        proposed_by_email=request.proposed_by_email,
        reason=request.reason,
        identity_verified=request.identity_verified,
        created_at=iso(request.created_at),
        expires_at=iso(request.expires_at),
        decided_by=request.decided_by,
        decided_by_email=request.decided_by_email,
        decided_at=iso(request.decided_at) if request.decided_at else None,
        note=request.note,
    )


def list_view(deps: MfaResetDeps) -> ResetListOut:
    now = deps.clock()
    return ResetListOut(items=[_out(r, now) for r in deps.store.recent(now)])


def _refuse(
    deps: MfaResetDeps, event: str, actor: str, detail: dict[str, Any], err: ApiError
) -> NoReturn:
    """A refused MFA change is audited too (D20); the refusal stands even if audit fails."""
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "rejected", "error": err.code})
    except Exception:
        logger.exception("audit emit failed for a refused MFA reset")
    raise err


def _audited[T](
    deps: MfaResetDeps, event: str, actor: str, detail: dict[str, Any], write: Callable[[], T]
) -> T:
    """Fail-closed audit: ``requested`` before writing, then ``applied`` or ``rejected``."""
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "requested"})
    except Exception as exc:
        raise ApiError(503, "audit_unavailable", "the change could not be audited; retry") from exc
    try:
        result = write()
    except Exception as exc:
        code = (
            exc.code
            if isinstance(exc, ApiError)
            else "version_conflict"
            if isinstance(exc, ConflictError)
            else "error"
        )
        try:
            deps.audit.emit(event, actor, {**detail, "outcome": "rejected", "error": code})
        except Exception:
            logger.exception("audit emit failed after a rejected MFA reset step")
        raise
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "applied"})
    except Exception:
        logger.exception("audit emit failed after an applied MFA reset step")
    return result


def _is_self(caller: Caller, sub: str, email: str | None) -> bool:
    own_email = (caller.user.email or "").lower()
    return caller.user.user_id == sub or bool(own_email and email and own_email == email.lower())


def propose(deps: MfaResetDeps, caller: Caller, body: ProposeIn) -> str:
    actor = caller.user.user_id
    event = "account.mfa_reset_propose"
    if not deps.rate_limiter.allow(actor):
        raise ApiError(429, "rate_limited", "too many requests; try again later")
    base = {"reason": body.reason, "identity_verified": body.identity_verified}
    if body.email == (caller.user.email or "").lower():
        _refuse(
            deps, event, actor, base, ApiError(403, "self_reset", "you cannot reset your own MFA")
        )
    try:
        target = deps.users.lookup(body.email)
    except UserNotFoundError as exc:
        raise ApiError(404, "user_not_found", "that email is not in the directory") from exc
    except CognitoUnavailableError as exc:
        raise ApiError(502, "upstream_error", "the directory could not be read") from exc
    detail = {**base, "target_user": target.sub, "target_email": target.email}
    if _is_self(caller, target.sub, target.email):
        _refuse(
            deps, event, actor, detail, ApiError(403, "self_reset", "you cannot reset your own MFA")
        )
    if target.federated:
        raise ApiError(422, "federated_user", "the MFA of SSO users is managed by their provider")
    now = deps.clock()
    open_request, last_reset = deps.store.target_state(target.sub, now)
    if open_request:
        raise ApiError(409, "already_pending", "there is already an open request for this user")
    if last_reset and now - last_reset < RESET_COOLDOWN:
        raise ApiError(429, "rate_limited", "this user's MFA was reset recently")
    if sum(1 for r in deps.store.recent(now) if _out(r, now).status == "pending") >= MAX_PENDING:
        raise ApiError(409, "too_many_pending", "too many pending requests; resolve some first")
    request = ResetRequest(
        change_id=new_change_id(),
        status="pending",
        target_user=target.sub,
        target_username=target.username,
        target_email=target.email,
        proposed_by=actor,
        proposed_by_email=caller.user.email,
        reason=body.reason,
        created_at=now,
        expires_at=now + REQUEST_LIFETIME,
        identity_verified=body.identity_verified,
    )

    def write() -> None:
        try:
            deps.store.create(request, now)
        except ConflictError as exc:
            raise ApiError(409, "already_pending", "there is already an open request") from exc

    _audited(deps, event, actor, {**detail, "change_id": request.change_id}, write)
    return request.change_id


def _open_request(deps: MfaResetDeps, change_id: str) -> ResetRequest:
    request = deps.store.get(change_id)
    if request is None:
        raise ApiError(404, "not_found", "request not found")
    if request.status != "pending":
        raise ApiError(409, "version_conflict", "the request is already closed")
    return request


def _detail(request: ResetRequest) -> dict[str, Any]:
    return {
        "change_id": request.change_id,
        "target_user": request.target_user,
        "target_email": request.target_email,
        "proposed_by": request.proposed_by,
        "identity_verified": request.identity_verified,
    }


def approve(deps: MfaResetDeps, caller: Caller, change_id: str) -> None:
    actor = caller.user.user_id
    event = "account.mfa_reset_approve"
    request = _open_request(deps, change_id)
    detail = {**_detail(request), "approved_by": actor}
    now = deps.clock()
    if now >= request.expires_at:
        raise ApiError(410, "expired", "the request expired")
    if request.proposed_by == actor:
        _refuse(
            deps,
            event,
            actor,
            detail,
            ApiError(403, "same_approver", "another administrator must approve this request"),
        )
    if _is_self(caller, request.target_user, request.target_email):
        _refuse(
            deps, event, actor, detail, ApiError(403, "self_reset", "you cannot reset your own MFA")
        )

    def write() -> None:
        try:
            # Claim first: a concurrent approval or rejection loses here, before Cognito.
            deps.store.transition(request, to="applying", expected="pending", now=now)
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the request changed; reload") from exc
        try:
            if deps.end_sessions is not None:
                try:
                    deps.end_sessions(request.target_user)
                except Exception as exc:
                    raise CognitoUnavailableError from exc
            deps.users.reset_mfa(request.target_username)
        except CognitoUnavailableError as exc:
            deps.store.transition(request, to="pending", expected="applying", now=now)
            raise ApiError(502, "upstream_error", "the MFA could not be reset; retry") from exc
        deps.store.transition(
            request,
            to="approved",
            expected="applying",
            actor=actor,
            actor_email=caller.user.email,
            now=now,
        )

    _audited(deps, event, actor, detail, write)
    try:
        deps.audit.emit(
            "account.mfa_reset",
            actor,
            {
                **_detail(request),
                "approved_by": actor,
                "sessions_revoked": True,
                "outcome": "applied",
            },
        )
    except Exception:
        # The immutable approve/requested and approve/applied records already exist.
        logger.exception("audit emit failed after an MFA reset")


def reject(deps: MfaResetDeps, caller: Caller, change_id: str, reason: str) -> None:
    actor = caller.user.user_id
    event = "account.mfa_reset_reject"
    request = _open_request(deps, change_id)
    detail = {**_detail(request), "rejected_by": actor, "reason": reason}
    if request.proposed_by == actor:
        raise ApiError(403, "same_approver", "withdraw your own request instead")
    if _is_self(caller, request.target_user, request.target_email):
        _refuse(
            deps,
            event,
            actor,
            detail,
            ApiError(403, "self_reset", "another administrator must decide on your MFA"),
        )
    now = deps.clock()

    def write() -> None:
        try:
            deps.store.transition(
                request,
                to="rejected",
                expected="pending",
                actor=actor,
                actor_email=caller.user.email,
                note=reason,
                now=now,
            )
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the request changed; reload") from exc

    _audited(deps, event, actor, detail, write)


def withdraw(deps: MfaResetDeps, caller: Caller, change_id: str) -> None:
    actor = caller.user.user_id
    request = _open_request(deps, change_id)
    if request.proposed_by != actor:
        raise ApiError(403, "forbidden", "only the proposer can withdraw a request")
    now = deps.clock()

    def write() -> None:
        try:
            deps.store.transition(request, to="withdrawn", expected="pending", actor=actor, now=now)
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the request changed; reload") from exc

    _audited(deps, "account.mfa_reset_withdraw", actor, _detail(request), write)


# --- Routes -----------------------------------------------------------------------------


Authorize = Callable[[Caller, str, str, str], Awaitable[None]]


def mfa_reset_router(
    deps: MfaResetDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    router = APIRouter(prefix="/api/admin/mfa-resets")

    def admin_action(action: str) -> Callable[[Caller], Awaitable[Caller]]:
        async def dependency(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
            await authorize(caller, action, *PLATFORM)
            # Defense in depth: the Cedar policies already require isAdmin.
            if not caller.user.is_admin:
                raise ApiError(403, "forbidden", "not allowed")
            return caller

        return dependency

    View = Annotated[Caller, Depends(admin_action("ViewAdmin"))]  # noqa: N806
    Propose = Annotated[Caller, Depends(admin_action("ProposeMfaReset"))]  # noqa: N806
    Approve = Annotated[Caller, Depends(admin_action("ApproveMfaReset"))]  # noqa: N806
    ChangeId = Annotated[str, Path(pattern=CHANGE_ID_PATTERN)]  # noqa: N806

    async def run[T](fn: Callable[..., T], *args: Any) -> T:
        return await asyncio.to_thread(fn, *args)

    @router.get("", response_model=ResetListOut)
    async def get_requests(_caller: View) -> ResetListOut:
        return await run(list_view, deps)

    @router.post("", response_model=ResetCreatedOut, status_code=201)
    async def post_request(body: ProposeIn, caller: Propose) -> ResetCreatedOut:
        return ResetCreatedOut(change_id=await run(propose, deps, caller, body))

    @router.post("/{change_id}/approve", response_model=ResetListOut)
    async def approve_request(change_id: ChangeId, _body: EmptyIn, caller: Approve) -> ResetListOut:
        await run(approve, deps, caller, change_id)
        return await run(list_view, deps)

    @router.post("/{change_id}/reject", response_model=ResetListOut)
    async def reject_request(change_id: ChangeId, body: RejectIn, caller: Approve) -> ResetListOut:
        await run(reject, deps, caller, change_id, body.reason)
        return await run(list_view, deps)

    @router.post("/{change_id}/withdraw", response_model=ResetListOut)
    async def withdraw_request(
        change_id: ChangeId, _body: EmptyIn, caller: Propose
    ) -> ResetListOut:
        await run(withdraw, deps, caller, change_id)
        return await run(list_view, deps)

    return router
