"""Directory lookups for sharing an agent with people (Agent Builder > Access, D33).

An agent version stores who it is shared with as user identifiers (the Cognito ``sub``).
Whoever may create agents resolves emails to those identifiers to add people, and the
identifiers back to emails to read a version (Builder and Review).

This endpoint tells its caller whether an email is in the directory. That is an agreed
exception (AGENTS.md, 2026-10-02) to «do not reveal whether a user exists», limited to agent
creators and administrators. Login, sign-up and recovery still never reveal it. Threat model:
``marketplace-v1-threat-model.md`` TM-M24.

Security notes (security-best-practices, FastAPI):
* The route declares its Cedar action (``CreateAgent``, read only); the decision is audited
  and the group is re-checked in process (AUTH-001).
* Strict body: emails and identifiers are validated and normalized before they reach Cognito,
  with a maximum per call (VALID-001). The response carries the identifier and the email of
  each match and the inputs without one, nothing else of the user (RESP-001).
* Rate limits per caller (LIMITS-001): emails per minute (in process, one limit per mango-api
  task) and per day (persisted in the Settings table, shared by all tasks); identifiers per
  minute. Identifiers are random, so they are not an oracle the way emails are.
* Fail-closed audit: nothing is returned unless the lookup was recorded (who, how many emails
  and identifiers, how many matched, and the identifiers matched by email). The emails asked
  for are never written to the audit trail or to operational logs.
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Annotated, Any, Protocol, Self

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends
from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, model_validator

from mango_api.audit import AuditLog
from mango_api.authz import PLATFORM
from mango_api.probe import RateLimiter
from mango_api.web import ApiError, Caller, rate_limited
from mango_core.agents import MAX_USERS, USER_ID_PATTERN
from mango_core.identity import MAX_EMAIL_LENGTH

if TYPE_CHECKING:
    from mypy_boto3_cognito_idp import CognitoIdentityProviderClient
    from mypy_boto3_dynamodb import DynamoDBClient

logger = logging.getLogger(__name__)

MAX_EMAILS_PER_CALL = 20
MAX_IDS_PER_CALL = MAX_USERS
"""A version is shared with at most ``MAX_USERS`` people: one call reads them all."""
EMAILS_PER_MINUTE = 30
EMAILS_PER_DAY = 200
"""Adding people is occasional: 200 emails a day is far above real use and keeps the
directory from being enumerated through this endpoint."""
IDS_PER_MINUTE = 300
"""Opening a version resolves up to ``MAX_USERS`` identifiers; this allows several a minute."""
PK_QUOTA = "DIRECTORY_LOOKUPS"
QUOTA_RETENTION = timedelta(days=2)
EVENT = "directory.lookup"
# No quotes or backslashes: the value never needs escaping, whatever the directory call.
_EMAIL_PATTERN = r"^[^@\s\"\\]{1,64}@[^@\s\"\\]{1,253}$"
# Few at a time: the user pool's read quota is shared with the rest of mango-api.
_LOOKUP_WORKERS = 4
_USER_ID_RE = re.compile(USER_ID_PATTERN)
# Statuses of a user who cannot sign in yet with a verified email.
_UNVERIFIED_STATUSES = frozenset({"UNCONFIRMED", "ARCHIVED", "UNKNOWN"})


# --- Cognito ----------------------------------------------------------------------------


class DirectoryUnavailableError(Exception):
    pass


class Directory(Protocol):
    def id_of(self, email: str) -> str | None: ...

    def email_of(self, user_id: str) -> str | None: ...


class CognitoDirectory:
    """The two reads of users mango-api does to share agents, on one user pool only."""

    def __init__(self, client: "CognitoIdentityProviderClient", user_pool_id: str) -> None:
        if not user_pool_id:
            raise ValueError("user pool id is required")
        self._client = client
        self._pool = user_pool_id

    def id_of(self, email: str) -> str | None:
        """``sub`` of the enabled, confirmed user with that email, if there is one."""
        try:
            # With email as a username attribute, AdminGetUser accepts the email.
            resp = self._client.admin_get_user(UserPoolId=self._pool, Username=email)
        except ClientError as exc:
            # Cognito refuses characters a username cannot have: no user has that email.
            if exc.response.get("Error", {}).get("Code") in {
                "UserNotFoundException",
                "InvalidParameterException",
            }:
                return None
            raise DirectoryUnavailableError from exc
        except BotoCoreError as exc:
            raise DirectoryUnavailableError from exc
        if not resp.get("Enabled", False) or resp.get("UserStatus") in _UNVERIFIED_STATUSES:
            return None
        attributes = {a["Name"]: a.get("Value", "") for a in resp.get("UserAttributes", [])}
        return attributes.get("sub") or None

    def email_of(self, user_id: str) -> str | None:
        """Email of the user with that ``sub``."""
        # Checked here too, next to the filter it goes into: nothing else may reach Cognito.
        if not _USER_ID_RE.fullmatch(user_id):
            return None
        try:
            resp = self._client.list_users(
                UserPoolId=self._pool,
                AttributesToGet=["email"],
                Filter=f'sub = "{user_id}"',
                Limit=1,
            )
        except (ClientError, BotoCoreError) as exc:
            raise DirectoryUnavailableError from exc
        for user in resp.get("Users", []):
            for attribute in user.get("Attributes", []):
                value = attribute.get("Value", "")
                if attribute.get("Name") == "email" and 0 < len(value) <= MAX_EMAIL_LENGTH:
                    return value
        return None


# --- Daily quota ------------------------------------------------------------------------


class QuotaExceededError(Exception):
    pass


class Quota(Protocol):
    def consume(self, user_id: str, count: int, now: datetime) -> None: ...


class LookupQuota:
    """Emails looked up per caller and UTC day, in the Settings table
    (``DIRECTORY_LOOKUPS`` / ``<sub>#<day>``), so every mango-api task shares the count."""

    def __init__(self, dynamodb: "DynamoDBClient", table: str, limit: int = EMAILS_PER_DAY) -> None:
        self._db = dynamodb
        self._table = table
        self._limit = limit

    def consume(self, user_id: str, count: int, now: datetime) -> None:
        if count > self._limit:
            raise QuotaExceededError
        try:
            self._db.update_item(
                TableName=self._table,
                Key={
                    "PK": {"S": PK_QUOTA},
                    "SK": {"S": f"{user_id}#{now.strftime('%Y-%m-%d')}"},
                },
                UpdateExpression="SET #ttl = :ttl ADD emails :count",
                ConditionExpression="attribute_not_exists(emails) OR emails <= :room",
                ExpressionAttributeNames={"#ttl": "ttl"},
                ExpressionAttributeValues={
                    ":count": {"N": str(count)},
                    ":room": {"N": str(self._limit - count)},
                    ":ttl": {"N": str(int((now + QUOTA_RETENTION).timestamp()))},
                },
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                raise QuotaExceededError from exc
            raise


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _normalize_email(value: object) -> object:
    return value.strip().lower() if isinstance(value, str) else value


def _unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))


EmailIn = Annotated[
    str,
    BeforeValidator(_normalize_email),
    Field(max_length=MAX_EMAIL_LENGTH, pattern=_EMAIL_PATTERN),
]
UserIdIn = Annotated[str, Field(pattern=USER_ID_PATTERN)]


class ResolveIn(_Strict):
    emails: Annotated[
        list[EmailIn], Field(max_length=MAX_EMAILS_PER_CALL), AfterValidator(_unique)
    ] = []
    ids: Annotated[list[UserIdIn], Field(max_length=MAX_IDS_PER_CALL), AfterValidator(_unique)] = []

    @model_validator(mode="after")
    def _something_to_resolve(self) -> Self:
        if not self.emails and not self.ids:
            raise ValueError("emails or ids are required")
        return self


class DirectoryUserOut(_Strict):
    id: str
    email: str


class ResolveOut(_Strict):
    users: list[DirectoryUserOut]
    emails_not_found: list[str]
    ids_not_found: list[str]


# --- Use case ---------------------------------------------------------------------------


@dataclass
class DirectoryDeps:
    directory: Directory
    quota: Quota
    audit: AuditLog
    emails_per_minute: RateLimiter
    ids_per_minute: RateLimiter
    clock: Callable[[], datetime]


def default_limiters() -> tuple[RateLimiter, RateLimiter]:
    """``(emails per minute, identifiers per minute)`` with the documented limits."""
    return (
        RateLimiter(limit=EMAILS_PER_MINUTE, window_seconds=60),
        RateLimiter(limit=IDS_PER_MINUTE, window_seconds=60),
    )


def _seconds_to_next_utc_day(now: datetime) -> int:
    tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return int((tomorrow - now).total_seconds())


def _refuse(deps: DirectoryDeps, caller: Caller, counts: dict[str, Any], retry: int) -> ApiError:
    """A refused lookup is audited too (it is how enumeration shows up); best effort."""
    try:
        deps.audit.emit(
            EVENT,
            caller.user.user_id,
            {**counts, "outcome": "rejected", "error": "rate_limited"},
            caller.user,
        )
    except Exception:
        logger.exception("audit emit failed for a refused directory lookup")
    return rate_limited(retry)


def resolve(deps: DirectoryDeps, caller: Caller, body: ResolveIn) -> ResolveOut:
    actor = caller.user.user_id
    counts: dict[str, Any] = {"emails": len(body.emails), "ids": len(body.ids)}
    now = deps.clock()
    # Identifiers first: a refusal must not have spent the caller's emails of the day.
    if body.ids and not deps.ids_per_minute.allow(actor, len(body.ids)):
        raise _refuse(deps, caller, counts, deps.ids_per_minute.retry_after(actor, len(body.ids)))
    if body.emails:
        if not deps.emails_per_minute.allow(actor, len(body.emails)):
            retry = deps.emails_per_minute.retry_after(actor, len(body.emails))
            raise _refuse(deps, caller, counts, retry)
        try:
            deps.quota.consume(actor, len(body.emails), now)
        except QuotaExceededError:
            raise _refuse(deps, caller, counts, _seconds_to_next_utc_day(now)) from None
    try:
        with ThreadPoolExecutor(max_workers=_LOOKUP_WORKERS) as pool:
            by_email = list(pool.map(deps.directory.id_of, body.emails))
            by_id = list(pool.map(deps.directory.email_of, body.ids))
    except DirectoryUnavailableError as exc:
        raise ApiError(502, "upstream_error", "the directory could not be read") from exc
    users: dict[str, str] = {}
    emails_not_found: list[str] = []
    ids_not_found: list[str] = []
    found_by_email: list[str] = []
    for email, user_id in zip(body.emails, by_email, strict=True):
        if user_id is None:
            emails_not_found.append(email)
        else:
            users[user_id] = email
            found_by_email.append(user_id)
    for user_id, found in zip(body.ids, by_id, strict=True):
        if found is None:
            ids_not_found.append(user_id)
        else:
            users.setdefault(user_id, found)
    try:
        deps.audit.emit(
            EVENT,
            actor,
            {
                **counts,
                "emails_found": len(found_by_email),
                "ids_found": len(body.ids) - len(ids_not_found),
                # Who the caller learned is in the directory; never the emails asked for.
                "found_users": sorted(set(found_by_email)),
                "outcome": "applied",
            },
            caller.user,
        )
    except Exception as exc:
        raise ApiError(503, "audit_unavailable", "the lookup could not be audited; retry") from exc
    return ResolveOut(
        users=[DirectoryUserOut(id=user_id, email=email) for user_id, email in users.items()],
        emails_not_found=emails_not_found,
        ids_not_found=ids_not_found,
    )


# --- Routes -----------------------------------------------------------------------------


Authorize = Callable[..., Awaitable[None]]


def directory_router(
    deps: DirectoryDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    router = APIRouter(prefix="/api/directory")

    async def can_create_agents(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        await authorize(caller, "CreateAgent", *PLATFORM, read_only=True)
        # Defense in depth: the Cedar policy already requires the group or isAdmin.
        if not (caller.user.is_admin or caller.user.is_agent_creator):
            raise ApiError(403, "forbidden", "not allowed")
        return caller

    Creator = Annotated[Caller, Depends(can_create_agents)]  # noqa: N806

    # POST although it only reads: emails must not travel in a URL (they end up in access logs).
    @router.post("/users/resolve", response_model=ResolveOut)
    async def resolve_users(body: ResolveIn, caller: Creator) -> ResolveOut:
        return await asyncio.to_thread(resolve, deps, caller, body)

    return router
