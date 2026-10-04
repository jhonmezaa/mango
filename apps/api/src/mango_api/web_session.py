"""Web session that survives a reload: a server cookie that only renews tokens (D63).

The cookie ``__Host-mango_session`` carries a random session id and the Cognito refresh token
encrypted with the data key of KMS. The server keeps the session record (hash of the id, who,
when it started and when it ends) and no secret. The cookie never authenticates a business
endpoint: it only buys a new access token, and the rest of the API keeps verifying Cognito
access tokens in ``Authorization`` (D13). Design: ``docs/specs/session-cookie.md``; threat
model: ``docs/security/threat-models/session-cookie-threat-model.md``.

Security notes (security-best-practices, FastAPI):
* Every route declares its dependencies (AUTH-001): the same-origin guard on the three, and a
  verified access token to create a session. No group is required: a person without one has a
  session too and a reload must not sign them out. Each caller acts on their own session only.
* Cookie attributes (SESS-001): ``HttpOnly``, ``Secure``, ``SameSite=Strict``, ``Path=/`` and
  the ``__Host-`` prefix. The refresh token in it is encrypted server-side, bound by the
  encryption context to the session id and the user (SESS-002).
* CSRF (CSRF-001): a custom header a form cannot send (there is no CORS, so a cross-site
  script cannot either), an exact ``Origin`` match and fetch metadata, on top of
  ``SameSite=Strict``. Only POST and DELETE (TM-S3).
* A session is created only when Cognito renews the refresh token and the result belongs to
  the caller of the access token (TM-S8); the session id is always generated here (TM-S4).
* Disabling a person, taking a sensitive group or resetting MFA writes a mark that ends
  every session started before it (TM-S5), besides the Cognito sign-out. The mark names
  which of the three it was, and ``session.ended`` repeats it.
* Responses are ``no-store`` (TM-S7). Tokens, the cookie and the session id never reach logs
  or the audit trail (TM-S6). The email of the person is kept in the session record only to
  name the actor of ``session.ended``; it goes to the audit trail, never to logs.
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import base64
import hashlib
import logging
import secrets
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Annotated, Any, Literal, Protocol, get_args

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from mango_api.audit import AuditLog
from mango_api.probe import RateLimiter
from mango_api.web import ApiError, rate_limited
from mango_core.identity import IdentityError, UserContext, user_from_claims

if TYPE_CHECKING:
    from mypy_boto3_cognito_idp import CognitoIdentityProviderClient
    from mypy_boto3_dynamodb import DynamoDBClient
    from mypy_boto3_kms import KMSClient

logger = logging.getLogger(__name__)

COOKIE_NAME = "__Host-mango_session"
COOKIE_VERSION = "v1"
CSRF_HEADER = "x-mango-session"
SID_BYTES = 32
SID_LENGTH = 43
"""Length of ``SID_BYTES`` random bytes in unpadded base64url."""
MAX_COOKIE_BYTES = 4000
"""Browsers refuse a cookie over 4096 bytes (name and value); leave room for the name."""
MAX_REFRESH_TOKEN_LENGTH = 4096
"""KMS encrypts up to 4096 bytes directly; a longer token cannot become a session."""
STARTS_PER_USER = 10
RENEWALS_PER_SESSION = 30
"""Per 5 minutes. A tab renews about once an hour and once per reload."""
WINDOW_SECONDS = 300
REVOCATION_MARK_SECONDS = 2 * 24 * 3600
"""Longer than any session (at most 24 h): the mark outlives every session it ends."""

RevocationCause = Literal["disabled", "group_removed", "mfa_reset"]
"""Why an administrator's change ended the sessions of a person; the ``reason`` of
``session.ended``, with the names the audit screen has a text for."""
_REVOCATION_CAUSES: frozenset[str] = frozenset(get_args(RevocationCause))
REVOKED = "revoked"
"""Reason of a session ended by a mark that does not name its cause."""

_NO_STORE = {"Cache-Control": "no-store"}
_CLEAR_COOKIE = f"{COOKIE_NAME}=; HttpOnly; Max-Age=0; Path=/; SameSite=strict; Secure"


class SessionRejectedError(Exception):
    """Cognito refuses the refresh token: revoked, expired, or the user is disabled."""


class SessionUnavailableError(Exception):
    """Cognito, KMS or the sessions table could not be reached."""


@dataclass(frozen=True)
class RenewedTokens:
    access_token: str
    id_token: str
    expires_in: int


@dataclass(frozen=True)
class SessionActor:
    """Who signed in, as the verified token said then: the actor of ``session.ended``."""

    email: str | None
    role: str | None
    is_admin: bool


@dataclass(frozen=True)
class SessionRecord:
    sub: str
    created_at: int
    expires_at: int
    federated: bool
    actor: SessionActor | None = None
    """Missing for a person without a group, and in records written before it existed."""


@dataclass(frozen=True)
class Revocation:
    """The mark of a user: sessions started up to ``before`` are over, and why."""

    before: int
    cause: str | None = None


class TokenRenewer(Protocol):
    def refresh(self, refresh_token: str) -> RenewedTokens: ...
    def revoke(self, refresh_token: str) -> None: ...


class AccessVerifier(Protocol):
    def verify(self, token: str) -> dict[str, Any]: ...


class CognitoTokens:
    """Renews and revokes refresh tokens with the public Cognito API of the web client."""

    def __init__(self, client: "CognitoIdentityProviderClient", client_id: str) -> None:
        self._client = client
        self._client_id = client_id

    def refresh(self, refresh_token: str) -> RenewedTokens:
        try:
            resp = self._client.initiate_auth(
                AuthFlow="REFRESH_TOKEN_AUTH",
                ClientId=self._client_id,
                AuthParameters={"REFRESH_TOKEN": refresh_token},
            )
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code in {"NotAuthorizedException", "UserNotFoundException"}:
                raise SessionRejectedError from None
            raise SessionUnavailableError from None
        except BotoCoreError:
            raise SessionUnavailableError from None
        result = resp.get("AuthenticationResult") or {}
        access, id_token, expires = (
            result.get("AccessToken"),
            result.get("IdToken"),
            result.get("ExpiresIn"),
        )
        if not access or not id_token or not isinstance(expires, int) or expires <= 0:
            raise SessionUnavailableError
        return RenewedTokens(access_token=access, id_token=id_token, expires_in=expires)

    def revoke(self, refresh_token: str) -> None:
        try:
            self._client.revoke_token(Token=refresh_token, ClientId=self._client_id)
        except (ClientError, BotoCoreError):
            raise SessionUnavailableError from None


class TokenCipher:
    """Encrypts the refresh token for the cookie; only this key and this context open it."""

    def __init__(self, client: "KMSClient", key_arn: str) -> None:
        self._client = client
        self._key = key_arn

    @staticmethod
    def _context(sid_hash: str, sub: str) -> dict[str, str]:
        return {"mango:purpose": "web-session", "mango:session": sid_hash, "mango:sub": sub}

    def encrypt(self, refresh_token: str, sid_hash: str, sub: str) -> bytes:
        try:
            resp = self._client.encrypt(
                KeyId=self._key,
                Plaintext=refresh_token.encode(),
                EncryptionContext=self._context(sid_hash, sub),
            )
        except (ClientError, BotoCoreError):
            raise SessionUnavailableError from None
        return resp["CiphertextBlob"]

    def decrypt(self, ciphertext: bytes, sid_hash: str, sub: str) -> str:
        try:
            resp = self._client.decrypt(
                KeyId=self._key,
                CiphertextBlob=ciphertext,
                EncryptionContext=self._context(sid_hash, sub),
            )
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code in {"InvalidCiphertextException", "IncorrectKeyException"}:
                raise SessionRejectedError from None
            raise SessionUnavailableError from None
        except BotoCoreError:
            raise SessionUnavailableError from None
        return resp["Plaintext"].decode()


class SessionStore:
    """Session records and the per-user revocation mark. No secret is stored here."""

    def __init__(self, client: "DynamoDBClient", table: str) -> None:
        self._client = client
        self._table = table

    @staticmethod
    def _session_key(sid_hash: str) -> dict[str, Any]:
        return {"PK": {"S": f"SESSION#{sid_hash}"}, "SK": {"S": "SESSION"}}

    @staticmethod
    def _user_key(sub: str) -> dict[str, Any]:
        return {"PK": {"S": f"USER#{sub}"}, "SK": {"S": "REVOKED"}}

    def put(self, sid_hash: str, record: SessionRecord) -> None:
        item: dict[str, Any] = {
            **self._session_key(sid_hash),
            "sub": {"S": record.sub},
            "created_at": {"N": str(record.created_at)},
            "expires_at": {"N": str(record.expires_at)},
            "federated": {"BOOL": record.federated},
            "ttl": {"N": str(record.expires_at)},
        }
        if record.actor is not None:
            item["actor_is_admin"] = {"BOOL": record.actor.is_admin}
            if record.actor.email:
                item["actor_email"] = {"S": record.actor.email}
            if record.actor.role:
                item["actor_role"] = {"S": record.actor.role}
        try:
            self._client.put_item(
                TableName=self._table,
                Item=item,
                # A session id is never reused.
                ConditionExpression="attribute_not_exists(PK)",
            )
        except (ClientError, BotoCoreError):
            raise SessionUnavailableError from None

    def get(self, sid_hash: str) -> SessionRecord | None:
        try:
            resp = self._client.get_item(
                TableName=self._table, Key=self._session_key(sid_hash), ConsistentRead=True
            )
        except (ClientError, BotoCoreError):
            raise SessionUnavailableError from None
        item = resp.get("Item")
        if not item:
            return None
        try:
            return SessionRecord(
                sub=item["sub"]["S"],
                created_at=int(item["created_at"]["N"]),
                expires_at=int(item["expires_at"]["N"]),
                federated=bool(item["federated"]["BOOL"]),
                actor=self._actor(item),
            )
        except (KeyError, ValueError):
            return None

    @staticmethod
    def _actor(item: dict[str, Any]) -> SessionActor | None:
        if "actor_is_admin" not in item:
            return None
        return SessionActor(
            email=item.get("actor_email", {}).get("S"),
            role=item.get("actor_role", {}).get("S"),
            is_admin=bool(item["actor_is_admin"]["BOOL"]),
        )

    def delete(self, sid_hash: str) -> None:
        try:
            self._client.delete_item(TableName=self._table, Key=self._session_key(sid_hash))
        except (ClientError, BotoCoreError):
            raise SessionUnavailableError from None

    def revoke_user(self, sub: str, now: int, cause: RevocationCause) -> None:
        """End every session of ``sub`` that started up to ``now``.

        One mark per user: a later one replaces it, so a session that two changes ended
        before it came back is reported with the cause of the latest.
        """
        try:
            self._client.put_item(
                TableName=self._table,
                Item={
                    **self._user_key(sub),
                    "revoked_before": {"N": str(now)},
                    "cause": {"S": cause},
                    "ttl": {"N": str(now + REVOCATION_MARK_SECONDS)},
                },
            )
        except (ClientError, BotoCoreError):
            raise SessionUnavailableError from None

    def revocation(self, sub: str) -> Revocation:
        try:
            resp = self._client.get_item(
                TableName=self._table, Key=self._user_key(sub), ConsistentRead=True
            )
        except (ClientError, BotoCoreError):
            raise SessionUnavailableError from None
        item = resp.get("Item") or {}
        try:
            before = int(item["revoked_before"]["N"])
        except (KeyError, ValueError):
            return Revocation(0)
        # A mark written before the cause existed has none.
        return Revocation(before, item.get("cause", {}).get("S"))


class SessionRecords(Protocol):
    def put(self, sid_hash: str, record: SessionRecord) -> None: ...
    def get(self, sid_hash: str) -> SessionRecord | None: ...
    def delete(self, sid_hash: str) -> None: ...
    def revoke_user(self, sub: str, now: int, cause: RevocationCause) -> None: ...
    def revocation(self, sub: str) -> Revocation: ...


class Cipher(Protocol):
    def encrypt(self, refresh_token: str, sid_hash: str, sub: str) -> bytes: ...
    def decrypt(self, ciphertext: bytes, sid_hash: str, sub: str) -> str: ...


@dataclass
class WebSessionDeps:
    store: SessionRecords
    cipher: Cipher
    tokens: TokenRenewer
    verifier: AccessVerifier
    audit: AuditLog
    clock: Callable[[], datetime]
    app_origin: str
    """Public origin of the application (``https://host``): the only ``Origin`` accepted."""
    session_seconds: int
    """Maximum length of a session, from sign-in (the refresh token validity of Cognito)."""
    starts: RateLimiter = field(
        default_factory=lambda: RateLimiter(STARTS_PER_USER, WINDOW_SECONDS)
    )
    renewals: RateLimiter = field(
        default_factory=lambda: RateLimiter(RENEWALS_PER_SESSION, WINDOW_SECONDS)
    )

    def revoke_user(self, sub: str, cause: RevocationCause) -> None:
        """Hook for the flows that sign a person out everywhere (D60, D20)."""
        self.store.revoke_user(sub, int(self.clock().timestamp()), cause)


# --- Schemas ----------------------------------------------------------------------------


class SessionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    refresh_token: str = Field(min_length=1, max_length=MAX_REFRESH_TOKEN_LENGTH, repr=False)
    federated: bool = False
    """Whether the sign-in was SSO: only decides the sign-out redirect of the SPA."""


class RenewedOut(BaseModel):
    access_token: str = Field(repr=False)
    id_token: str = Field(repr=False)
    expires_in: int
    federated: bool


# --- Cookie -----------------------------------------------------------------------------


def _hash(sid: str) -> str:
    return hashlib.sha256(sid.encode()).hexdigest()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _parse_cookie(request: Request) -> tuple[str, bytes] | None:
    """Session id hash and ciphertext of a well-formed cookie; anything else is no session."""
    raw = request.cookies.get(COOKIE_NAME)
    if not raw or len(raw) > MAX_COOKIE_BYTES:
        return None
    version, _, rest = raw.partition(".")
    sid, _, sealed = rest.partition(".")
    if version != COOKIE_VERSION or len(sid) != SID_LENGTH or "." in sealed:
        return None
    try:
        ciphertext = _unb64(sealed)
    except ValueError:
        return None
    return (_hash(sid), ciphertext) if ciphertext else None


class NoSessionError(Exception):
    """The cookie renews nothing: there never was a session, or it is over."""


def _unavailable() -> ApiError:
    return ApiError(503, "session_unavailable", "the session service is unavailable; retry")


def _actor(claims: dict[str, Any]) -> UserContext | None:
    try:
        return user_from_claims(claims)
    except IdentityError:
        # No group yet (or claims the rest of the API would refuse): audited without an actor.
        return None


# --- Use cases --------------------------------------------------------------------------


def _audit(
    deps: WebSessionDeps, event: str, sub: str, detail: dict[str, Any], claims: dict[str, Any]
) -> None:
    deps.audit.emit(event, sub, detail, _actor(claims))


def start(
    deps: WebSessionDeps, claims: dict[str, Any], body: SessionIn, previous: str | None
) -> tuple[str, int]:
    """Create a session for the caller. Returns the cookie value and its max age."""
    sub = str(claims["sub"])
    if not deps.starts.allow(sub):
        raise rate_limited(deps.starts.retry_after(sub))
    try:
        renewed = deps.tokens.refresh(body.refresh_token)
        renewed_claims = deps.verifier.verify(renewed.access_token)
    except (SessionRejectedError, IdentityError):
        _audit(deps, "session.rejected", sub, {"reason": "invalid_refresh_token"}, claims)
        raise ApiError(401, "unauthenticated", "invalid token", headers=_NO_STORE) from None
    except SessionUnavailableError:
        raise _unavailable() from None
    if renewed_claims.get("sub") != sub:
        # A refresh token of somebody else never becomes a session of the caller (TM-S8).
        _audit(deps, "session.rejected", sub, {"reason": "sub_mismatch"}, claims)
        raise ApiError(403, "forbidden", "not allowed", headers=_NO_STORE)

    now = int(deps.clock().timestamp())
    # The limit counts from the sign-in, not from this call: Cognito keeps ``auth_time``
    # across renewals, so creating the session again never makes it longer.
    auth_time = renewed_claims.get("auth_time")
    started = auth_time if isinstance(auth_time, int) and 0 < auth_time <= now else now
    expires_at = started + deps.session_seconds
    if expires_at <= now:
        raise ApiError(401, "unauthenticated", "session expired", headers=_NO_STORE)

    sid = secrets.token_urlsafe(SID_BYTES)
    sid_hash = _hash(sid)
    try:
        ciphertext = deps.cipher.encrypt(body.refresh_token, sid_hash, sub)
    except SessionUnavailableError:
        raise _unavailable() from None
    value = f"{COOKIE_VERSION}.{sid}.{_b64(ciphertext)}"
    if len(COOKIE_NAME) + 1 + len(value) > MAX_COOKIE_BYTES:
        logger.error("the refresh token does not fit in the session cookie")
        raise _unavailable()
    try:
        # Fail closed: no session unless its start is on the audit trail.
        _audit(
            deps,
            "session.started",
            sub,
            {"federated": body.federated, "expires_at": expires_at},
            renewed_claims,
        )
        actor = _actor(renewed_claims)
        deps.store.put(
            sid_hash,
            SessionRecord(
                sub=sub,
                created_at=now,
                expires_at=expires_at,
                federated=body.federated,
                # A session ends without a token (it expired, was revoked, or the person
                # signed out with the cookie alone): its end is audited with this actor.
                actor=SessionActor(actor.email, actor.role, actor.is_admin) if actor else None,
            ),
        )
    except Exception:
        logger.exception("the web session could not be started")
        raise _unavailable() from None
    if previous and previous != sid_hash:
        try:
            deps.store.delete(previous)
        except SessionUnavailableError:
            logger.warning("the previous web session could not be deleted")
    return value, expires_at - now


def _end(deps: WebSessionDeps, sid_hash: str, record: SessionRecord, reason: str) -> None:
    try:
        deps.store.delete(sid_hash)
    except SessionUnavailableError:
        logger.warning("an ended web session could not be deleted")
    actor = (
        UserContext(
            user_id=record.sub,
            role=record.actor.role,
            business_unit=None,
            is_admin=record.actor.is_admin,
            email=record.actor.email,
        )
        if record.actor
        else None
    )
    try:
        deps.audit.emit("session.ended", record.sub, {"reason": reason}, actor)
    except Exception:
        logger.exception("the end of a web session could not be audited")


def _claims_of(deps: WebSessionDeps, renewed: RenewedTokens, sub: str) -> dict[str, Any]:
    """Verified claims of a renewed access token, which must belong to the session's user."""
    claims = deps.verifier.verify(renewed.access_token)
    if claims.get("sub") != sub:
        raise SessionRejectedError
    return claims


def renew(deps: WebSessionDeps, cookie: tuple[str, bytes] | None) -> RenewedOut:
    """New tokens for a live session; ``NoSessionError`` when the cookie renews nothing."""
    if cookie is None:
        raise NoSessionError
    sid_hash, ciphertext = cookie
    try:
        record = deps.store.get(sid_hash)
        if record is None:
            raise NoSessionError
        # Only sessions that exist are counted: made-up ids cannot fill the limiter and
        # push real sessions out of it (TM-S10).
        if not deps.renewals.allow(sid_hash):
            raise rate_limited(deps.renewals.retry_after(sid_hash))
        now = int(deps.clock().timestamp())
        if now >= record.expires_at:
            _end(deps, sid_hash, record, "expired")
            raise NoSessionError
        revocation = deps.store.revocation(record.sub)
        if record.created_at <= revocation.before:
            # Only a cause this code writes is repeated; anything else stays ``revoked``.
            known = revocation.cause in _REVOCATION_CAUSES
            _end(
                deps, sid_hash, record, revocation.cause if known and revocation.cause else REVOKED
            )
            raise NoSessionError
        try:
            refresh_token = deps.cipher.decrypt(ciphertext, sid_hash, record.sub)
            renewed = deps.tokens.refresh(refresh_token)
            claims = _claims_of(deps, renewed, record.sub)
        except (SessionRejectedError, IdentityError):
            # Revoked or expired in Cognito, the person was disabled, or the cookie was
            # tampered with: the session is over. Cognito does not say which, and no mark
            # of this server covers the session, so the reason stays ``rejected``.
            _end(deps, sid_hash, record, "rejected")
            raise NoSessionError from None
    except SessionUnavailableError:
        raise _unavailable() from None
    try:
        _audit(deps, "session.renewed", record.sub, {}, claims)
    except Exception:
        logger.exception("the renewal of a web session could not be audited")
        raise _unavailable() from None
    return RenewedOut(
        access_token=renewed.access_token,
        id_token=renewed.id_token,
        expires_in=renewed.expires_in,
        federated=record.federated,
    )


def end(deps: WebSessionDeps, cookie: tuple[str, bytes] | None) -> None:
    """Sign out: revoke the refresh token and forget the session. Never fails the caller."""
    if cookie is None:
        return
    sid_hash, ciphertext = cookie
    try:
        record = deps.store.get(sid_hash)
        if record is None:
            return
        try:
            deps.tokens.revoke(deps.cipher.decrypt(ciphertext, sid_hash, record.sub))
        except (SessionRejectedError, SessionUnavailableError):
            # The record goes anyway: without it the cookie renews nothing.
            logger.warning("the refresh token of a closed web session was not revoked")
        _end(deps, sid_hash, record, "sign_out")
    except SessionUnavailableError:
        logger.warning("a web session could not be closed")


# --- Router -----------------------------------------------------------------------------


def web_session_router(deps: WebSessionDeps) -> APIRouter:
    async def same_origin(request: Request) -> None:
        """CSRF guard of the cookie endpoints (TM-S3, TM-S4)."""
        headers = request.headers
        fetch_site = headers.get("sec-fetch-site")
        if (
            headers.get(CSRF_HEADER) != "1"
            or headers.get("origin") != deps.app_origin
            or (fetch_site is not None and fetch_site != "same-origin")
        ):
            raise ApiError(403, "forbidden", "not allowed", headers=_NO_STORE)

    async def verified_claims(request: Request) -> dict[str, Any]:
        """Claims of a verified access token. No group needed: see the module notes."""
        scheme, _, token = request.headers.get("authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise ApiError(401, "unauthenticated", "missing bearer token", headers=_NO_STORE)
        try:
            claims = await asyncio.to_thread(deps.verifier.verify, token)
        except IdentityError:
            raise ApiError(401, "unauthenticated", "invalid token", headers=_NO_STORE) from None
        if not isinstance(claims.get("sub"), str) or not claims["sub"]:
            raise ApiError(401, "unauthenticated", "invalid token", headers=_NO_STORE)
        return claims

    router = APIRouter(prefix="/api/session", dependencies=[Depends(same_origin)])
    Claims = Annotated[dict[str, Any], Depends(verified_claims)]  # noqa: N806

    def no_store(response: Response) -> None:
        response.headers["Cache-Control"] = "no-store"

    @router.post("", status_code=204)
    async def start_session(
        body: SessionIn, claims: Claims, request: Request, response: Response
    ) -> None:
        cookie = _parse_cookie(request)
        value, max_age = await asyncio.to_thread(
            start, deps, claims, body, cookie[0] if cookie else None
        )
        no_store(response)
        response.set_cookie(
            COOKIE_NAME,
            value,
            max_age=max_age,
            path="/",
            secure=True,
            httponly=True,
            samesite="strict",
        )

    @router.post(
        "/refresh",
        response_model=RenewedOut,
        responses={204: {"description": "No session: nothing to renew"}},
    )
    async def renew_session(request: Request, response: Response) -> RenewedOut | Response:
        try:
            renewed = await asyncio.to_thread(renew, deps, _parse_cookie(request))
        except NoSessionError:
            # Not an error: every first visit asks. The cookie, if any, is removed.
            return Response(status_code=204, headers={**_NO_STORE, "Set-Cookie": _CLEAR_COOKIE})
        no_store(response)
        return renewed

    @router.delete("", status_code=204)
    async def end_session(request: Request, response: Response) -> None:
        await asyncio.to_thread(end, deps, _parse_cookie(request))
        no_store(response)
        response.headers["Set-Cookie"] = _CLEAR_COOKIE

    return router


__all__ = [
    "COOKIE_NAME",
    "CSRF_HEADER",
    "CognitoTokens",
    "RevocationCause",
    "SessionStore",
    "TokenCipher",
    "WebSessionDeps",
    "web_session_router",
]
