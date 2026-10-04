"""Settings > People: the directory, who belongs to which group, invitations and access (D60;
threat model ``people-management-threat-model.md``).

Only administrators reach these routes. What one administrator may do alone and what needs a
second one is decided **here**, never by the client:

* Giving or taking ``mango-admin`` or ``finops-central``, disabling an administrator and
  re-enabling someone who holds one of those two groups are proposed by one administrator and
  approved by a different one (72 h). Everything else is applied at once and audited.
* Nobody decides a change of that kind about their own account, takes one of those groups
  from themselves or disables themselves. Asking for one of them for oneself is a proposal
  like any other: a different administrator approves it.
* The application never leaves fewer than two enabled administrators.
* Bootstrap: while the caller is the only enabled administrator, naming the second one is
  applied without a second approver and the event says so (``bootstrap``).

Listing the directory tells an administrator who has an account. That is an agreed exception
(AGENTS.md, 2026-10-03) to «do not reveal whether a user exists», limited to administrators.

Security notes (security-best-practices, FastAPI):
* Every route declares its Cedar action (``ViewPeople``, ``ManagePeople``,
  ``ApprovePeopleChange``); the decision is audited and ``is_admin`` is re-checked in process.
* Strict bodies; the search prefix and the cursor never reach Cognito unvalidated, and a group
  is only ever one of the system groups or one of the registry (VALID-001). Emails travel in
  bodies, never in a URL.
* Rate limits per administrator on reads, changes, proposals and invitations (LIMITS-001).
* Fail-closed audit: ``requested`` is recorded before any write or Cognito call; a read is
  recorded with counts only, never with the emails or the prefix searched. A refused
  invitation is recorded too: with the domain only while the address is not a person of the
  directory, never with what was typed.
* An invitation may go to any company domain, not only the sign-up ones (decision of
  2026-10-03): public mail providers stay refused, and the event says ``external_domain``.
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
import re
import threading
import time
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Annotated, Any, Literal, NoReturn

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

from mango_api.audit import AuditLog
from mango_api.groups import GroupRegistry, GroupsUnavailableError
from mango_api.mfa_reset import ConflictError, _conflict, _opt, _s, iso, new_change_id
from mango_api.probe import RateLimiter
from mango_api.web import ApiError, Caller, rate_limited
from mango_api.web_session import RevocationCause
from mango_core.agents import USER_ID_PATTERN
from mango_core.groups import (
    GROUP_ADMIN,
    GROUP_AGENT_CREATOR,
    MAX_USER_GROUPS,
    is_group_name,
)
from mango_core.identity import MAX_EMAIL_LENGTH
from mango_core.mail_domains import is_public_mail_domain

if TYPE_CHECKING:
    from mypy_boto3_cognito_idp import CognitoIdentityProviderClient
    from mypy_boto3_dynamodb import DynamoDBClient

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
GROUP_CENTRAL = "finops-central"
SYSTEM_GROUPS = (GROUP_ADMIN, GROUP_AGENT_CREATOR, GROUP_CENTRAL, "bu-lead")
SENSITIVE_GROUPS = frozenset({GROUP_ADMIN, GROUP_CENTRAL})
"""Membership changes that need a second administrator (decision of 2026-10-03, D60)."""
MIN_ADMINS = 2
PAGE_SIZE = 20
MAX_DIRECTORY_USERS = 2000
"""Hard stop of one directory read; beyond it the response says the list is incomplete."""
SNAPSHOT_TTL_SECONDS = 30.0
CHANGE_LIFETIME = timedelta(hours=72)  # D28
CHANGE_RETENTION = timedelta(days=90)  # table TTL; the audit trail keeps the evidence
LIST_WINDOW = timedelta(days=30)
ADMINS_CLAIM = timedelta(minutes=2)
ADMINS_LOCK = "admins"
MAX_PENDING = 20
READS_PER_MINUTE = 120
CHANGES_PER_HOUR = 200
PROPOSALS_PER_HOUR = 20
INVITATIONS_PER_HOUR = 20
MAX_INVITE_GROUPS = 10
PK_CHANGE = "MEMBER_CHANGE"
PK_LOCK = "MEMBER_LOCK"
CHANGE_ID_PATTERN = r"^[0-9a-f]{32}$"
# No quotes, backslashes or spaces: the value goes into a ListUsers filter as is.
_PREFIX_PATTERN = r"^[A-Za-z0-9._%+@-]{1,64}$"
_CURSOR_PATTERN = r"^[0-9]{1,5}$"
# Few at a time: the user pool's read quota is shared with sign-in.
_LOOKUP_WORKERS = 4
_USER_ID_RE = re.compile(USER_ID_PATTERN)
_MAX_LOCAL_LENGTH = 64
# Same shape as the pre sign-up trigger (``functions/pre-sign-up``); a test keeps them equal.
_LOCAL_RE = re.compile(r"^[A-Za-z0-9!#$%&*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&*+/=?^_`{|}~-]+)*$")
_DOMAIN_RE = re.compile(r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")

Kind = Literal["add", "remove", "disable", "enable"]
Status = Literal["pending", "applying", "approved", "rejected", "withdrawn"]
PersonStatus = Literal["active", "invited", "disabled"]
ListFilter = Literal["all", "pending", "invited", "disabled"]
# Cognito statuses of an account whose email was never verified: not a person yet.
_HIDDEN_STATUSES = frozenset({"UNCONFIRMED", "ARCHIVED", "UNKNOWN"})
_INVITED_STATUS = "FORCE_CHANGE_PASSWORD"


def invitation_domain(email: str) -> tuple[str | None, str | None]:
    """``(error code, domain)``: why ``email`` cannot be invited, or ``None`` when it can.

    ``AdminCreateUser`` skips the pre sign-up trigger, so its shape rules are applied here:
    plain ASCII, exactly one ``@``, a well-formed domain. An administrator may invite someone
    of another company (decision of 2026-10-03), so the domain does not have to be one of the
    sign-up domains; a public mail provider is refused always, by the list the trigger uses
    (``mango_core.mail_domains``). The domain is returned only when it is well formed: it is
    what a refusal is audited with.
    """
    if not email.isascii() or email.count("@") != 1:
        return "invalid_email", None
    local, domain = email.split("@")
    if not _DOMAIN_RE.fullmatch(domain):
        return "invalid_email", None
    if not 0 < len(local) <= _MAX_LOCAL_LENGTH or not _LOCAL_RE.fullmatch(local):
        return "invalid_email", domain
    if is_public_mail_domain(domain):
        return "public_domain", domain
    return None, domain


def parse_domains(raw: str) -> frozenset[str]:
    """The installation's sign-up domains; an invalid list is unusable (no domain is its own)."""
    domains = frozenset(d.strip().lower() for d in raw.split(",") if d.strip())
    if not domains or not all(_DOMAIN_RE.fullmatch(d) for d in domains):
        return frozenset()
    return frozenset(d for d in domains if not is_public_mail_domain(d))


# --- Cognito ----------------------------------------------------------------------------


class DirectoryUnavailableError(Exception):
    pass


class UserExistsError(Exception):
    pass


@dataclass(frozen=True)
class PoolUser:
    username: str
    sub: str
    email: str
    status: str
    enabled: bool
    created_at: datetime

    @property
    def visible(self) -> bool:
        return self.status not in _HIDDEN_STATUSES

    @property
    def person_status(self) -> PersonStatus:
        if not self.enabled:
            return "disabled"
        return "invited" if self.status == _INVITED_STATUS else "active"


def _pool_user(user: Any, attributes_key: str) -> PoolUser | None:
    attributes = {a["Name"]: a.get("Value", "") for a in user.get(attributes_key, [])}
    sub, email = attributes.get("sub", ""), attributes.get("email", "")
    created = user.get("UserCreateDate")
    if not _USER_ID_RE.fullmatch(sub) or not 0 < len(email) <= MAX_EMAIL_LENGTH:
        return None
    return PoolUser(
        username=user["Username"],
        sub=sub,
        email=email.lower(),
        status=str(user.get("UserStatus", "UNKNOWN")),
        enabled=bool(user.get("Enabled", False)),
        created_at=created if isinstance(created, datetime) else datetime.fromtimestamp(0, UTC),
    )


def _code(exc: ClientError) -> str:
    return str(exc.response.get("Error", {}).get("Code", ""))


class CognitoPeople:
    """What mango-api may do to the users of one user pool, and nothing else of Cognito.

    Cognito scopes these actions to the pool, not to a group or a user: which group may be
    given and to whom is decided by the use cases below.
    """

    def __init__(self, client: "CognitoIdentityProviderClient", user_pool_id: str) -> None:
        if not user_pool_id:
            raise ValueError("user pool id is required")
        self._client = client
        self._pool = user_pool_id

    def users(self, limit: int = MAX_DIRECTORY_USERS) -> tuple[list[PoolUser], bool]:
        """Every user of the pool up to ``limit``; ``True`` when there were more."""
        found: list[PoolUser] = []
        token: str | None = None
        try:
            while True:
                kwargs: dict[str, Any] = {"UserPoolId": self._pool, "Limit": 60}
                if token:
                    kwargs["PaginationToken"] = token
                resp = self._client.list_users(**kwargs)
                for raw in resp.get("Users", []):
                    user = _pool_user(raw, "Attributes")
                    if user is not None:
                        found.append(user)
                token = resp.get("PaginationToken")
                if not token:
                    return found, False
                if len(found) >= limit:
                    return found[:limit], True
        except (ClientError, BotoCoreError) as exc:
            raise DirectoryUnavailableError from exc

    def members(self, group: str) -> list[PoolUser]:
        """Users of ``group``; empty when the directory does not have the group."""
        found: list[PoolUser] = []
        token: str | None = None
        try:
            while True:
                kwargs: dict[str, Any] = {"UserPoolId": self._pool, "GroupName": group, "Limit": 60}
                if token:
                    kwargs["NextToken"] = token
                resp = self._client.list_users_in_group(**kwargs)
                for raw in resp.get("Users", []):
                    user = _pool_user(raw, "Attributes")
                    if user is not None:
                        found.append(user)
                token = resp.get("NextToken")
                if not token or len(found) >= MAX_DIRECTORY_USERS:
                    return found
        except ClientError as exc:
            if _code(exc) == "ResourceNotFoundException":
                return []
            raise DirectoryUnavailableError from exc
        except BotoCoreError as exc:
            raise DirectoryUnavailableError from exc

    def by_id(self, user_id: str) -> PoolUser | None:
        # Checked here too, next to the filter it goes into: nothing else may reach Cognito.
        if not _USER_ID_RE.fullmatch(user_id):
            return None
        try:
            resp = self._client.list_users(
                UserPoolId=self._pool, Filter=f'sub = "{user_id}"', Limit=1
            )
        except (ClientError, BotoCoreError) as exc:
            raise DirectoryUnavailableError from exc
        for raw in resp.get("Users", []):
            user = _pool_user(raw, "Attributes")
            if user is not None and user.sub == user_id:
                return user
        return None

    def exists(self, email: str) -> bool:
        try:
            # With email as a username attribute, AdminGetUser accepts the email.
            self._client.admin_get_user(UserPoolId=self._pool, Username=email)
        except ClientError as exc:
            if _code(exc) == "UserNotFoundException":
                return False
            raise DirectoryUnavailableError from exc
        except BotoCoreError as exc:
            raise DirectoryUnavailableError from exc
        return True

    def mfa_registered(self, username: str) -> bool | None:
        """Whether the user has a verified TOTP; ``None`` when the user is not in the pool.

        A TOTP registered through the ``MFA_SETUP`` challenge (the only way the SPA has: the
        access token cannot call the self-service APIs) is challenged at every sign-in but is
        not listed in ``UserMFASettingList`` until a preference is set (lab, 2026-10-03). No
        API reads «has a verified TOTP», so an empty list is settled by asking Cognito to
        prefer it: that succeeds only with a verified TOTP, changes nothing of how the user
        signs in, and from then on the list says so. It never turns a factor off.
        """
        try:
            resp = self._client.admin_get_user(UserPoolId=self._pool, Username=username)
            if "SOFTWARE_TOKEN_MFA" in resp.get("UserMFASettingList", []):
                return True
            self._client.admin_set_user_mfa_preference(
                UserPoolId=self._pool,
                Username=username,
                SoftwareTokenMfaSettings={"Enabled": True, "PreferredMfa": True},
            )
        except ClientError as exc:
            # «User does not have delivery config set to turn on SOFTWARE_TOKEN_MFA».
            if _code(exc) == "InvalidParameterException":
                return False
            # Deleted outside Mango after the list was read: one person less, not an outage.
            if _code(exc) == "UserNotFoundException":
                return None
            raise DirectoryUnavailableError from exc
        except BotoCoreError as exc:
            raise DirectoryUnavailableError from exc
        return True

    def groups_of(self, username: str) -> frozenset[str]:
        found: set[str] = set()
        token: str | None = None
        try:
            while True:
                kwargs: dict[str, Any] = {"UserPoolId": self._pool, "Username": username}
                if token:
                    kwargs["NextToken"] = token
                resp = self._client.admin_list_groups_for_user(**kwargs)
                found.update(g["GroupName"] for g in resp.get("Groups", []))
                token = resp.get("NextToken")
                if not token or len(found) > MAX_USER_GROUPS:
                    return frozenset(found)
        except (ClientError, BotoCoreError) as exc:
            raise DirectoryUnavailableError from exc

    def _call(self, operation: Callable[..., Any], **kwargs: Any) -> Any:
        try:
            return operation(UserPoolId=self._pool, **kwargs)
        except (ClientError, BotoCoreError) as exc:
            raise DirectoryUnavailableError from exc

    def add_to_group(self, username: str, group: str) -> None:
        self._call(self._client.admin_add_user_to_group, Username=username, GroupName=group)

    def remove_from_group(self, username: str, group: str) -> None:
        self._call(self._client.admin_remove_user_from_group, Username=username, GroupName=group)

    def disable(self, username: str) -> None:
        self._call(self._client.admin_disable_user, Username=username)

    def enable(self, username: str) -> None:
        self._call(self._client.admin_enable_user, Username=username)

    def sign_out(self, username: str) -> None:
        """Revoke every refresh token. Access tokens already issued live until they expire."""
        self._call(self._client.admin_user_global_sign_out, Username=username)

    def invite(self, email: str) -> PoolUser:
        """Create the user; Cognito emails a temporary password (never seen by mango-api)."""
        try:
            resp = self._client.admin_create_user(
                UserPoolId=self._pool,
                Username=email,
                DesiredDeliveryMediums=["EMAIL"],
                UserAttributes=[
                    {"Name": "email", "Value": email},
                    {"Name": "email_verified", "Value": "true"},
                ],
            )
        except ClientError as exc:
            if _code(exc) == "UsernameExistsException":
                raise UserExistsError from exc
            raise DirectoryUnavailableError from exc
        except BotoCoreError as exc:
            raise DirectoryUnavailableError from exc
        user = _pool_user(resp.get("User", {}), "Attributes")
        if user is None:
            raise DirectoryUnavailableError("created user without sub")
        return user


# --- Repository -------------------------------------------------------------------------


@dataclass(frozen=True)
class MemberChange:
    change_id: str
    kind: Kind
    group: str | None
    status: Status
    target_user: str
    target_email: str
    proposed_by: str
    proposed_by_email: str | None
    reason: str
    created_at: datetime
    expires_at: datetime
    decided_by: str | None = None
    decided_by_email: str | None = None
    decided_at: datetime | None = None
    note: str | None = None

    @property
    def lock(self) -> str:
        return f"{self.target_user}#{self.kind}#{self.group or '-'}"


class MemberChangeStore:
    """Items in the Settings table (only mango-api writes it, TM-A6):

    * ``MEMBER_CHANGE`` / ``<change_id>``: the proposal and its decision.
    * ``MEMBER_LOCK`` / ``<sub>#<kind>#<group>``: the open proposal for that person and
      change, so there is only one; ``MEMBER_LOCK`` / ``admins``: the short claim held
      while a change of who is an administrator is applied.
    """

    def __init__(self, dynamodb: "DynamoDBClient", table: str) -> None:
        self._db = dynamodb
        self._table = table

    @staticmethod
    def _parse(item: dict[str, Any]) -> MemberChange:
        decided_at = _opt(item, "decided_at")
        return MemberChange(
            change_id=item["SK"]["S"],
            kind=item["kind"]["S"],
            group=_opt(item, "group"),
            status=item["status"]["S"],
            target_user=item["target_user"]["S"],
            target_email=item["target_email"]["S"],
            proposed_by=item["proposed_by"]["S"],
            proposed_by_email=_opt(item, "proposed_by_email"),
            reason=item["reason"]["S"],
            created_at=datetime.fromisoformat(item["created_at"]["S"]),
            expires_at=datetime.fromisoformat(item["expires_at"]["S"]),
            decided_by=_opt(item, "decided_by"),
            decided_by_email=_opt(item, "decided_by_email"),
            decided_at=datetime.fromisoformat(decided_at) if decided_at else None,
            note=_opt(item, "note"),
        )

    def get(self, change_id: str) -> MemberChange | None:
        item = self._db.get_item(
            TableName=self._table,
            Key={"PK": _s(PK_CHANGE), "SK": _s(change_id)},
            ConsistentRead=True,
        ).get("Item")
        return self._parse(item) if item else None

    def recent(self, now: datetime) -> list[MemberChange]:
        items: list[MemberChange] = []
        pages = self._db.get_paginator("query").paginate(
            TableName=self._table,
            KeyConditionExpression="PK = :pk",
            ExpressionAttributeValues={":pk": _s(PK_CHANGE)},
            ConsistentRead=True,
        )
        for page_number, page in enumerate(pages):
            if page_number >= 20:  # noqa: PLR2004 - hard stop on a runaway partition
                break
            items.extend(self._parse(i) for i in page.get("Items", []))
        cutoff = now - LIST_WINDOW
        return sorted(
            (c for c in items if c.created_at >= cutoff), key=lambda c: c.created_at, reverse=True
        )

    def create(self, change: MemberChange, now: datetime) -> None:
        item: dict[str, Any] = {
            "PK": _s(PK_CHANGE),
            "SK": _s(change.change_id),
            "kind": _s(change.kind),
            "status": _s("pending"),
            "target_user": _s(change.target_user),
            "target_email": _s(change.target_email),
            "proposed_by": _s(change.proposed_by),
            "reason": _s(change.reason),
            "created_at": _s(iso(change.created_at)),
            "expires_at": _s(iso(change.expires_at)),
            "ttl": {"N": str(int((now + CHANGE_RETENTION).timestamp()))},
        }
        if change.group:
            item["group"] = _s(change.group)
        if change.proposed_by_email:
            item["proposed_by_email"] = _s(change.proposed_by_email)
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
                        # One open proposal per person and change; an expired one no longer
                        # blocks.
                        "Update": {
                            "TableName": self._table,
                            "Key": {"PK": _s(PK_LOCK), "SK": _s(change.lock)},
                            "UpdateExpression": "SET pending = :id, pending_expires_at = :exp",
                            "ConditionExpression": (
                                "attribute_not_exists(pending) OR pending_expires_at < :now"
                            ),
                            "ExpressionAttributeValues": {
                                ":id": _s(change.change_id),
                                ":exp": _s(iso(change.expires_at)),
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
        change: MemberChange,
        *,
        to: Status,
        expected: Status,
        actor: str | None = None,
        actor_email: str | None = None,
        note: str | None = None,
        now: datetime,
    ) -> None:
        """Conditional status change; closing a proposal also releases its lock."""
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
                    "Key": {"PK": _s(PK_CHANGE), "SK": _s(change.change_id)},
                    "UpdateExpression": "SET " + ", ".join(sets),
                    "ConditionExpression": "#status = :expected",
                    "ExpressionAttributeNames": {"#status": "status"},
                    "ExpressionAttributeValues": values,
                }
            }
        ]
        if to in {"approved", "rejected", "withdrawn"} and now < change.expires_at:
            items.append(
                {
                    "Update": {
                        "TableName": self._table,
                        "Key": {"PK": _s(PK_LOCK), "SK": _s(change.lock)},
                        "UpdateExpression": "REMOVE pending, pending_expires_at",
                        "ConditionExpression": "pending = :id",
                        "ExpressionAttributeValues": {":id": _s(change.change_id)},
                    }
                }
            )
        try:
            self._db.transact_write_items(TransactItems=items)
        except ClientError as exc:
            _conflict(exc)

    def claim_admins(self, actor: str, now: datetime) -> None:
        """One change of who is an administrator at a time: two concurrent ones would both
        count the administrators before either had applied (bootstrap, the two-admin floor)."""
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": _s(PK_LOCK), "SK": _s(ADMINS_LOCK)},
                UpdateExpression="SET pending = :by, pending_expires_at = :exp",
                ConditionExpression="attribute_not_exists(pending) OR pending_expires_at < :now",
                ExpressionAttributeValues={
                    ":by": _s(actor),
                    ":exp": _s(iso(now + ADMINS_CLAIM)),
                    ":now": _s(iso(now)),
                },
            )
        except ClientError as exc:
            _conflict(exc)

    def release_admins(self, actor: str) -> None:
        """Best effort: a claim that is not released expires on its own."""
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": _s(PK_LOCK), "SK": _s(ADMINS_LOCK)},
                UpdateExpression="REMOVE pending, pending_expires_at",
                ConditionExpression="pending = :by",
                ExpressionAttributeValues={":by": _s(actor)},
            )
        except ClientError:
            logger.warning("the administrators claim was not released; it expires on its own")


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _normalize(value: object) -> object:
    return value.strip().lower() if isinstance(value, str) else value


GroupId = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{1,63}$")]
Reason = Annotated[str, Field(min_length=1, max_length=500)]
EmailIn = Annotated[
    str, BeforeValidator(_normalize), Field(min_length=3, max_length=MAX_EMAIL_LENGTH)
]


class SearchIn(_Strict):
    prefix: Annotated[str, BeforeValidator(_normalize), Field(pattern=_PREFIX_PATTERN)] | None = (
        None
    )
    filter: ListFilter = "all"
    cursor: Annotated[str, Field(pattern=_CURSOR_PATTERN)] | None = None


class GroupIn(_Strict):
    group: GroupId
    reason: Reason | None = None


class ReasonIn(_Strict):
    reason: Reason


class OptionalReasonIn(_Strict):
    reason: Reason | None = None


class EmptyIn(_Strict):
    pass


class InviteIn(_Strict):
    email: EmailIn
    groups: Annotated[list[GroupId], Field(max_length=MAX_INVITE_GROUPS)] = []


class PersonOut(_Strict):
    user_id: str
    email: str
    status: PersonStatus
    mfa: bool
    groups: list[str]
    created_at: str


class PeopleOut(_Strict):
    items: list[PersonOut]
    next_cursor: str | None
    pending: int
    """People who can sign in and belong to no group."""
    admins: int
    """Enabled administrators."""
    with_access: int
    """Enabled people with a group who are not administrators."""
    incomplete: bool
    """The directory is larger than one read covers: counts and filters are a lower bound."""


class ChangeOut(_Strict):
    change_id: str
    kind: Kind
    group: str | None
    status: Literal["pending", "approved", "rejected", "withdrawn", "expired"]
    target_user: str
    target_email: str
    proposed_by: str
    proposed_by_email: str | None
    reason: str
    created_at: str
    expires_at: str
    decided_by: str | None
    decided_by_email: str | None
    decided_at: str | None
    note: str | None


class ChangeListOut(_Strict):
    items: list[ChangeOut]


class ActionOut(_Strict):
    result: Literal["applied", "proposed", "bootstrap"]
    change_id: str | None = None


class InvitedOut(_Strict):
    user_id: str
    result: Literal["applied", "bootstrap"]


# --- Directory snapshot -----------------------------------------------------------------


@dataclass(frozen=True)
class Snapshot:
    users: tuple[PoolUser, ...]
    groups: dict[str, frozenset[str]]
    """Groups of each user, by ``sub``; only groups Mango manages."""
    incomplete: bool

    def of(self, user: PoolUser) -> frozenset[str]:
        return self.groups.get(user.sub, frozenset())


@dataclass
class DirectoryCache:
    """The directory as one read, shared by the administrators of this task for a few
    seconds: Cognito cannot filter by group membership nor sort, and the list needs both."""

    ttl_seconds: float = SNAPSHOT_TTL_SECONDS
    clock: Callable[[], float] = time.monotonic
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _value: tuple[float, Snapshot] | None = None

    def get(self, load: Callable[[], Snapshot]) -> Snapshot:
        with self._lock:
            now = self.clock()
            if self._value is None or now - self._value[0] >= self.ttl_seconds:
                self._value = (now, load())
            return self._value[1]

    def clear(self) -> None:
        with self._lock:
            self._value = None


# --- Use cases --------------------------------------------------------------------------


@dataclass
class PeopleDeps:
    people: CognitoPeople
    store: MemberChangeStore
    registry: GroupRegistry
    audit: AuditLog
    clock: Callable[[], datetime]
    sign_up_domains: frozenset[str]
    cache: DirectoryCache = field(default_factory=DirectoryCache)
    reads: RateLimiter = field(default_factory=lambda: RateLimiter(READS_PER_MINUTE, 60))
    changes: RateLimiter = field(default_factory=lambda: RateLimiter(CHANGES_PER_HOUR, 3600))
    proposals: RateLimiter = field(default_factory=lambda: RateLimiter(PROPOSALS_PER_HOUR, 3600))
    invitations: RateLimiter = field(
        default_factory=lambda: RateLimiter(INVITATIONS_PER_HOUR, 3600)
    )
    end_sessions: Callable[[str, RevocationCause], None] | None = None
    """Ends the web sessions of a user id (D63), next to the Cognito sign-out, and records
    why: the reason of their ``session.ended``."""


def _directory[T](call: Callable[[], T]) -> T:
    try:
        return call()
    except DirectoryUnavailableError as exc:
        raise ApiError(502, "upstream_error", "the directory could not be reached") from exc


def _assignable(deps: PeopleDeps) -> frozenset[str]:
    """Groups Mango gives to people: the system ones and the registry. Never anything else
    of the pool (Cognito creates its own groups for identity providers)."""
    try:
        registered = {g.id for g in deps.registry.list_groups()}
    except GroupsUnavailableError as exc:
        raise ApiError(503, "groups_unavailable", "please try again") from exc
    return frozenset(g for g in registered | set(SYSTEM_GROUPS) if is_group_name(g))


def _snapshot(deps: PeopleDeps) -> Snapshot:
    def load() -> Snapshot:
        users, incomplete = deps.people.users()
        memberships: dict[str, set[str]] = {}
        groups = sorted(_assignable(deps))
        with ThreadPoolExecutor(max_workers=_LOOKUP_WORKERS) as pool:
            for group, members in zip(groups, pool.map(deps.people.members, groups), strict=True):
                for member in members:
                    memberships.setdefault(member.sub, set()).add(group)
        return Snapshot(
            users=tuple(u for u in users if u.visible),
            groups={sub: frozenset(found) for sub, found in memberships.items()},
            incomplete=incomplete,
        )

    return _directory(lambda: deps.cache.get(load))


def _waiting(snapshot: Snapshot, user: PoolUser) -> bool:
    """Signed up, can sign in, and belongs to no group."""
    return user.person_status == "active" and not snapshot.of(user)


def search(deps: PeopleDeps, caller: Caller, body: SearchIn) -> PeopleOut:
    actor = caller.user.user_id
    if not deps.reads.allow(actor):
        raise rate_limited(deps.reads.retry_after(actor))
    snapshot = _snapshot(deps)
    rows = [
        u
        for u in snapshot.users
        if (body.prefix is None or u.email.startswith(body.prefix))
        and (
            body.filter == "all"
            or (body.filter == "pending" and _waiting(snapshot, u))
            or (body.filter != "pending" and u.person_status == body.filter)
        )
    ]
    # People waiting for access first, then the newest.
    rows.sort(key=lambda u: (not _waiting(snapshot, u), -u.created_at.timestamp(), u.email))
    start = int(body.cursor or "0")
    page = rows[start : start + PAGE_SIZE]
    with ThreadPoolExecutor(max_workers=_LOOKUP_WORKERS) as pool:
        mfa = _directory(
            lambda: list(pool.map(lambda u: deps.people.mfa_registered(u.username), page))
        )
    if None in mfa:
        # The snapshot still lists someone the pool no longer has (deleted with the AWS
        # console or CLI): they are left out and the next read starts from Cognito again.
        deps.cache.clear()
    admins = sum(1 for u in snapshot.users if u.enabled and GROUP_ADMIN in snapshot.of(u))
    out = PeopleOut(
        items=[
            PersonOut(
                user_id=u.sub,
                email=u.email,
                status=u.person_status,
                mfa=registered,
                groups=sorted(snapshot.of(u)),
                created_at=iso(u.created_at),
            )
            for u, registered in zip(page, mfa, strict=True)
            if registered is not None
        ],
        next_cursor=str(start + PAGE_SIZE) if start + PAGE_SIZE < len(rows) else None,
        pending=sum(1 for u in snapshot.users if _waiting(snapshot, u)),
        admins=admins,
        with_access=sum(
            1
            for u in snapshot.users
            if u.enabled and snapshot.of(u) and GROUP_ADMIN not in snapshot.of(u)
        ),
        incomplete=snapshot.incomplete,
    )
    try:
        # Who read the directory and how much of it; never the emails or the prefix.
        deps.audit.emit(
            "directory.list",
            actor,
            {
                "filter": body.filter,
                "searched": body.prefix is not None,
                "returned": len(out.items),
                "outcome": "applied",
            },
            caller.user,
        )
    except Exception as exc:
        raise ApiError(503, "audit_unavailable", "the read could not be audited; retry") from exc
    return out


def _change_out(change: MemberChange, now: datetime) -> ChangeOut:
    status = "pending" if change.status == "applying" else change.status
    shown: Any = "expired" if status == "pending" and now >= change.expires_at else status
    return ChangeOut(
        change_id=change.change_id,
        kind=change.kind,
        group=change.group,
        status=shown,
        target_user=change.target_user,
        target_email=change.target_email,
        proposed_by=change.proposed_by,
        proposed_by_email=change.proposed_by_email,
        reason=change.reason,
        created_at=iso(change.created_at),
        expires_at=iso(change.expires_at),
        decided_by=change.decided_by,
        decided_by_email=change.decided_by_email,
        decided_at=iso(change.decided_at) if change.decided_at else None,
        note=change.note,
    )


def changes_view(deps: PeopleDeps) -> ChangeListOut:
    now = deps.clock()
    return ChangeListOut(items=[_change_out(c, now) for c in deps.store.recent(now)])


_EVENTS: dict[Kind, str] = {
    "add": "directory.group_add",
    "remove": "directory.group_remove",
    "disable": "directory.disable",
    "enable": "directory.enable",
}


def _refuse(
    deps: PeopleDeps, event: str, caller: Caller, detail: dict[str, Any], err: ApiError
) -> NoReturn:
    """A refused change is audited too; the refusal stands even if audit fails."""
    try:
        deps.audit.emit(
            event,
            caller.user.user_id,
            {**detail, "outcome": "rejected", "error": err.code},
            caller.user,
        )
    except Exception:
        logger.exception("audit emit failed for a refused people change")
    raise err


def _audited[T](
    deps: PeopleDeps, event: str, caller: Caller, detail: dict[str, Any], write: Callable[[], T]
) -> T:
    """Fail-closed audit: ``requested`` before writing, then ``applied`` or ``rejected``."""
    actor = caller.user.user_id
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "requested"}, caller.user)
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
            deps.audit.emit(
                event, actor, {**detail, "outcome": "rejected", "error": code}, caller.user
            )
        except Exception:
            logger.exception("audit emit failed after a rejected people change")
        raise
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "applied"}, caller.user)
    except Exception:
        logger.exception("audit emit failed after an applied people change")
    deps.cache.clear()
    return result


@dataclass(frozen=True)
class _Target:
    user: PoolUser
    groups: frozenset[str]

    @property
    def is_admin(self) -> bool:
        return self.user.enabled and GROUP_ADMIN in self.groups


def _target(deps: PeopleDeps, user_id: str) -> _Target:
    user = _directory(lambda: deps.people.by_id(user_id))
    if user is None or not user.visible:
        raise ApiError(404, "user_not_found", "that person is not in the directory")
    return _Target(user, _directory(lambda: deps.people.groups_of(user.username)))


def _enabled_admins(deps: PeopleDeps) -> list[PoolUser]:
    """Read from the directory at the moment of the decision, never from the cache."""
    return [u for u in _directory(lambda: deps.people.members(GROUP_ADMIN)) if u.enabled]


def _require_current_admin(deps: PeopleDeps, caller: Caller, event: str) -> None:
    """The token says administrator for up to an hour after the directory stopped saying so
    (TM-P10). Whoever changes people must be an enabled administrator **now**."""
    if any(u.sub == caller.user.user_id for u in _enabled_admins(deps)):
        return
    _refuse(deps, event, caller, {}, ApiError(403, "forbidden", "not allowed"))


def _is_self(caller: Caller, user: PoolUser) -> bool:
    own_email = (caller.user.email or "").lower()
    return caller.user.user_id == user.sub or bool(own_email and own_email == user.email)


def _detail(target: _Target, kind: Kind, group: str | None) -> dict[str, Any]:
    detail: dict[str, Any] = {
        "target_user": target.user.sub,
        "target_email": target.user.email,
        "kind": kind,
    }
    if group:
        detail["group"] = group
    return detail


def _needs_approval(kind: Kind, target: _Target, group: str | None) -> bool:
    """Whether a second administrator has to approve (D60). Decided by the server only."""
    if kind in {"add", "remove"}:
        return group in SENSITIVE_GROUPS
    if kind == "disable":
        return target.is_admin
    return bool(target.groups & SENSITIVE_GROUPS)


def _validate(deps: PeopleDeps, kind: Kind, target: _Target, group: str | None) -> None:
    """The state rules of a change; checked when it is asked for and again when applied."""
    user, groups = target.user, target.groups
    if kind in {"add", "remove"}:
        if group is None or group not in _assignable(deps):
            raise ApiError(422, "unknown_group", "that group cannot be given to people")
        if not user.enabled:
            raise ApiError(409, "user_disabled", "re-enable the person before changing groups")
        if kind == "add":
            if group in groups:
                raise ApiError(409, "already_member", "the person already has that group")
            if len(groups) >= MAX_USER_GROUPS:
                raise ApiError(409, "too_many_groups", "the person has too many groups")
        elif group not in groups:
            raise ApiError(409, "not_member", "the person does not have that group")
    elif kind == "disable":
        if not user.enabled:
            raise ApiError(409, "already_disabled", "the person is already disabled")
    elif user.enabled:
        raise ApiError(409, "already_enabled", "the person is already enabled")
    removes_admin = (kind == "remove" and group == GROUP_ADMIN) or kind == "disable"
    if removes_admin and target.is_admin and len(_enabled_admins(deps)) <= MIN_ADMINS:
        raise ApiError(409, "last_admins", "name another administrator first")


def _touches_admins(kind: Kind, target: _Target, group: str | None) -> bool:
    return group == GROUP_ADMIN or (kind in {"disable", "enable"} and GROUP_ADMIN in target.groups)


def _apply(
    deps: PeopleDeps, actor: str, kind: Kind, target: _Target, group: str | None, *, bootstrap: bool
) -> None:
    """Change the directory. Whatever changes who is an administrator is applied one at a
    time, and the count it depends on is read again once the claim is held."""
    if not _touches_admins(kind, target, group):
        _write(deps, kind, target, group)
        return
    try:
        deps.store.claim_admins(actor, deps.clock())
    except ConflictError as exc:
        raise ApiError(409, "version_conflict", "another change is in progress; retry") from exc
    try:
        admins = _enabled_admins(deps)
        if bootstrap and [u.sub for u in admins] != [actor]:
            raise ApiError(409, "version_conflict", "the administrators changed; reload")
        reduces = kind == "disable" or (kind == "remove" and group == GROUP_ADMIN)
        if reduces and target.is_admin and len(admins) <= MIN_ADMINS:
            raise ApiError(409, "last_admins", "name another administrator first")
        _write(deps, kind, target, group)
    finally:
        deps.store.release_admins(actor)


def _sign_out(deps: PeopleDeps, target: _Target, cause: RevocationCause) -> None:
    """No session survives: the server ones (D63) and every refresh token in Cognito."""
    if deps.end_sessions is not None:
        try:
            deps.end_sessions(target.user.sub, cause)
        except Exception as exc:
            raise DirectoryUnavailableError from exc
    deps.people.sign_out(target.user.username)


def _write(deps: PeopleDeps, kind: Kind, target: _Target, group: str | None) -> None:
    username = target.user.username
    try:
        if kind == "add" and group:
            deps.people.add_to_group(username, group)
        elif kind == "remove" and group:
            deps.people.remove_from_group(username, group)
            if group in SENSITIVE_GROUPS:
                _sign_out(deps, target, "group_removed")
        elif kind == "disable":
            deps.people.disable(username)
            _sign_out(deps, target, "disabled")
        elif kind == "enable":
            deps.people.enable(username)
    except DirectoryUnavailableError as exc:
        raise ApiError(502, "upstream_error", "the directory could not be changed; retry") from exc


def _is_bootstrap(deps: PeopleDeps, caller: Caller, group: str | None) -> bool:
    """The caller is the only enabled administrator and is naming the second one."""
    if group != GROUP_ADMIN:
        return False
    admins = _enabled_admins(deps)
    return len(admins) == 1 and admins[0].sub == caller.user.user_id


def change(
    deps: PeopleDeps,
    caller: Caller,
    user_id: str,
    kind: Kind,
    *,
    group: str | None = None,
    reason: str | None = None,
) -> ActionOut:
    """Apply a change to a person, or propose it when a second administrator must approve."""
    actor = caller.user.user_id
    if not deps.changes.allow(actor):
        raise rate_limited(deps.changes.retry_after(actor))
    event = _EVENTS[kind]
    _require_current_admin(deps, caller, event)
    target = _target(deps, user_id)
    detail = _detail(target, kind, group)
    if reason:
        detail["reason"] = reason
    own = _is_self(caller, target.user)
    if own and kind == "disable":
        _refuse(
            deps,
            event,
            caller,
            detail,
            ApiError(403, "self_change", "you cannot disable your own account"),
        )
    _validate(deps, kind, target, group)
    bootstrap = kind == "add" and not own and _is_bootstrap(deps, caller, group)
    if _needs_approval(kind, target, group) and not bootstrap:
        # Asking for a sensitive group for oneself is allowed (another administrator
        # approves it; with two administrators there is no third one to ask). Giving one up
        # alone is not: it goes through another administrator from the start.
        if own and kind == "remove":
            _refuse(
                deps,
                "directory.member_propose",
                caller,
                detail,
                ApiError(403, "self_change", "another administrator must ask for this change"),
            )
        if not reason:
            raise ApiError(422, "reason_required", "a reason is required")
        return _propose(deps, caller, target, kind, group=group, reason=reason)
    if kind == "disable" and not reason:
        raise ApiError(422, "reason_required", "a reason is required")
    if bootstrap:
        detail["bootstrap"] = True
    _audited(
        deps,
        event,
        caller,
        detail,
        lambda: _apply(deps, actor, kind, target, group, bootstrap=bootstrap),
    )
    return ActionOut(result="bootstrap" if bootstrap else "applied")


def _propose(
    deps: PeopleDeps, caller: Caller, target: _Target, kind: Kind, *, group: str | None, reason: str
) -> ActionOut:
    actor = caller.user.user_id
    if not deps.proposals.allow(actor):
        raise rate_limited(deps.proposals.retry_after(actor))
    now = deps.clock()
    if sum(1 for c in deps.store.recent(now) if _change_out(c, now).status == "pending") >= (
        MAX_PENDING
    ):
        raise ApiError(409, "too_many_pending", "too many pending changes; resolve some first")
    proposal = MemberChange(
        change_id=new_change_id(),
        kind=kind,
        group=group,
        status="pending",
        target_user=target.user.sub,
        target_email=target.user.email,
        proposed_by=actor,
        proposed_by_email=caller.user.email,
        reason=reason,
        created_at=now,
        expires_at=now + CHANGE_LIFETIME,
    )

    def write() -> None:
        try:
            deps.store.create(proposal, now)
        except ConflictError as exc:
            raise ApiError(409, "already_pending", "that change is already waiting") from exc

    detail = {**_detail(target, kind, group), "reason": reason, "change_id": proposal.change_id}
    _audited(deps, "directory.member_propose", caller, detail, write)
    return ActionOut(result="proposed", change_id=proposal.change_id)


def _open_change(deps: PeopleDeps, change_id: str) -> MemberChange:
    found = deps.store.get(change_id)
    if found is None:
        raise ApiError(404, "not_found", "change not found")
    if found.status != "pending":
        raise ApiError(409, "version_conflict", "the change is already closed")
    return found


def _change_detail(found: MemberChange) -> dict[str, Any]:
    detail: dict[str, Any] = {
        "change_id": found.change_id,
        "target_user": found.target_user,
        "target_email": found.target_email,
        "kind": found.kind,
        "proposed_by": found.proposed_by,
    }
    if found.group:
        detail["group"] = found.group
    return detail


def _decides_own(caller: Caller, found: MemberChange) -> bool:
    own_email = (caller.user.email or "").lower()
    return caller.user.user_id == found.target_user or bool(
        own_email and own_email == found.target_email
    )


def approve(deps: PeopleDeps, caller: Caller, change_id: str) -> None:
    actor = caller.user.user_id
    event = "directory.member_approve"
    _require_current_admin(deps, caller, event)
    found = _open_change(deps, change_id)
    detail = {**_change_detail(found), "approved_by": actor}
    now = deps.clock()
    if now >= found.expires_at:
        raise ApiError(410, "expired", "the change expired")
    if found.proposed_by == actor:
        _refuse(
            deps,
            event,
            caller,
            detail,
            ApiError(403, "same_approver", "another administrator must approve this change"),
        )
    if _decides_own(caller, found):
        _refuse(
            deps,
            event,
            caller,
            detail,
            ApiError(403, "self_change", "another administrator must decide on your account"),
        )
    # The state may have moved since the proposal: every rule is checked again.
    target = _target(deps, found.target_user)
    _validate(deps, found.kind, target, found.group)

    def write() -> None:
        try:
            # Claim first: a concurrent approval or rejection loses here, before Cognito.
            deps.store.transition(found, to="applying", expected="pending", now=now)
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the change moved; reload") from exc
        try:
            _apply(deps, actor, found.kind, target, found.group, bootstrap=False)
        except ApiError:
            deps.store.transition(found, to="pending", expected="applying", now=now)
            raise
        deps.store.transition(
            found,
            to="approved",
            expected="applying",
            actor=actor,
            actor_email=caller.user.email,
            now=now,
        )

    _audited(deps, event, caller, detail, write)
    try:
        deps.audit.emit(
            _EVENTS[found.kind],
            actor,
            {**_change_detail(found), "approved_by": actor, "outcome": "applied"},
            caller.user,
        )
    except Exception:
        # The immutable approve/requested and approve/applied records already exist.
        logger.exception("audit emit failed after an approved people change")


def reject(deps: PeopleDeps, caller: Caller, change_id: str, reason: str) -> None:
    actor = caller.user.user_id
    event = "directory.member_reject"
    _require_current_admin(deps, caller, event)
    found = _open_change(deps, change_id)
    detail = {**_change_detail(found), "rejected_by": actor, "reason": reason}
    if found.proposed_by == actor:
        raise ApiError(403, "same_approver", "withdraw your own change instead")
    if _decides_own(caller, found):
        _refuse(
            deps,
            event,
            caller,
            detail,
            ApiError(403, "self_change", "another administrator must decide on your account"),
        )
    now = deps.clock()

    def write() -> None:
        try:
            deps.store.transition(
                found,
                to="rejected",
                expected="pending",
                actor=actor,
                actor_email=caller.user.email,
                note=reason,
                now=now,
            )
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the change moved; reload") from exc

    _audited(deps, event, caller, detail, write)


def withdraw(deps: PeopleDeps, caller: Caller, change_id: str) -> None:
    actor = caller.user.user_id
    found = _open_change(deps, change_id)
    if found.proposed_by != actor:
        raise ApiError(403, "forbidden", "only the proposer can withdraw a change")
    now = deps.clock()

    def write() -> None:
        try:
            deps.store.transition(found, to="withdrawn", expected="pending", actor=actor, now=now)
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the change moved; reload") from exc

    _audited(deps, "directory.member_withdraw", caller, _change_detail(found), write)


def invite(deps: PeopleDeps, caller: Caller, body: InviteIn) -> InvitedOut:
    actor = caller.user.user_id
    if not deps.invitations.allow(actor):
        raise rate_limited(deps.invitations.retry_after(actor))
    event = "directory.invite"
    _require_current_admin(deps, caller, event)
    groups = list(dict.fromkeys(body.groups))
    refused, domain = invitation_domain(body.email)
    if refused:
        # Not a person of the directory: the address typed is not recorded, only its domain
        # (a public provider, or none when the address is not even well formed).
        attempt: dict[str, Any] = {"groups": len(groups)}
        if domain:
            attempt["target_domain"] = domain
        _refuse(
            deps, event, caller, attempt, ApiError(422, refused, "that email cannot be invited")
        )
    detail: dict[str, Any] = {"target_email": body.email, "groups": groups}
    # Someone of another company (decision of 2026-10-03): allowed, and said in the trail.
    if domain not in deps.sign_up_domains:
        detail["external_domain"] = True
    assignable = _assignable(deps)
    if any(g not in assignable for g in groups):
        _refuse(
            deps,
            event,
            caller,
            detail,
            ApiError(422, "unknown_group", "that group cannot be given to people"),
        )
    bootstrap = GROUP_ADMIN in groups and _is_bootstrap(deps, caller, GROUP_ADMIN)
    allowed_sensitive = {GROUP_ADMIN} if bootstrap else set()
    if any(g in SENSITIVE_GROUPS and g not in allowed_sensitive for g in groups):
        _refuse(
            deps,
            event,
            caller,
            detail,
            ApiError(422, "sensitive_group", "ask for that group after the invitation"),
        )
    # Told to administrators only (exception agreed on 2026-10-03).
    if _directory(lambda: deps.people.exists(body.email)):
        _refuse(
            deps,
            event,
            caller,
            detail,
            ApiError(409, "already_exists", "that email is already in the directory"),
        )
    if bootstrap:
        detail["bootstrap"] = True

    def write() -> PoolUser:
        try:
            user = deps.people.invite(body.email)
        except UserExistsError as exc:
            raise ApiError(409, "already_exists", "that email is already in the directory") from exc
        except DirectoryUnavailableError as exc:
            raise ApiError(502, "upstream_error", "the invitation could not be sent") from exc
        # A group that fails here leaves the person invited without it: the administrator
        # sees them in the list and adds it there.
        invited = _Target(user, frozenset())
        for group in groups:
            _apply(deps, actor, "add", invited, group, bootstrap=bootstrap)
        return user

    created = _audited(deps, "directory.invite", caller, detail, write)
    return InvitedOut(user_id=created.sub, result="bootstrap" if bootstrap else "applied")


# --- Routes -----------------------------------------------------------------------------


Authorize = Callable[..., Awaitable[None]]


def people_router(
    deps: PeopleDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    router = APIRouter(prefix="/api/admin/people")

    def admin_action(action: str, read_only: bool = False) -> Callable[[Caller], Awaitable[Caller]]:
        async def dependency(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
            await authorize(caller, action, *PLATFORM, read_only=read_only)
            # Defense in depth: the Cedar policies already require isAdmin.
            if not caller.user.is_admin:
                raise ApiError(403, "forbidden", "not allowed")
            return caller

        return dependency

    View = Annotated[Caller, Depends(admin_action("ViewPeople", read_only=True))]  # noqa: N806
    Manage = Annotated[Caller, Depends(admin_action("ManagePeople"))]  # noqa: N806
    Approve = Annotated[Caller, Depends(admin_action("ApprovePeopleChange"))]  # noqa: N806
    UserId = Annotated[str, Path(pattern=USER_ID_PATTERN)]  # noqa: N806
    ChangeId = Annotated[str, Path(pattern=CHANGE_ID_PATTERN)]  # noqa: N806

    async def run[T](fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        return await asyncio.to_thread(fn, *args, **kwargs)

    # POST although it only reads: the email prefix must not travel in a URL (access logs).
    @router.post("/search", response_model=PeopleOut)
    async def search_people(body: SearchIn, caller: View) -> PeopleOut:
        return await run(search, deps, caller, body)

    @router.post("/invitations", response_model=InvitedOut, status_code=201)
    async def invite_person(body: InviteIn, caller: Manage) -> InvitedOut:
        return await run(invite, deps, caller, body)

    @router.get("/changes", response_model=ChangeListOut)
    async def get_member_changes(_caller: View) -> ChangeListOut:
        return await run(changes_view, deps)

    @router.post("/changes/{change_id}/approve", response_model=ChangeListOut)
    async def approve_member_change(
        change_id: ChangeId, _body: EmptyIn, caller: Approve
    ) -> ChangeListOut:
        await run(approve, deps, caller, change_id)
        return await run(changes_view, deps)

    @router.post("/changes/{change_id}/reject", response_model=ChangeListOut)
    async def reject_member_change(
        change_id: ChangeId, body: ReasonIn, caller: Approve
    ) -> ChangeListOut:
        await run(reject, deps, caller, change_id, body.reason)
        return await run(changes_view, deps)

    @router.post("/changes/{change_id}/withdraw", response_model=ChangeListOut)
    async def withdraw_member_change(
        change_id: ChangeId, _body: EmptyIn, caller: Manage
    ) -> ChangeListOut:
        await run(withdraw, deps, caller, change_id)
        return await run(changes_view, deps)

    @router.post("/{user_id}/groups", response_model=ActionOut)
    async def add_group(user_id: UserId, body: GroupIn, caller: Manage) -> ActionOut:
        return await run(change, deps, caller, user_id, "add", group=body.group, reason=body.reason)

    @router.post("/{user_id}/groups/remove", response_model=ActionOut)
    async def remove_group(user_id: UserId, body: GroupIn, caller: Manage) -> ActionOut:
        return await run(
            change, deps, caller, user_id, "remove", group=body.group, reason=body.reason
        )

    @router.post("/{user_id}/disable", response_model=ActionOut)
    async def disable_person(user_id: UserId, body: ReasonIn, caller: Manage) -> ActionOut:
        return await run(change, deps, caller, user_id, "disable", reason=body.reason)

    @router.post("/{user_id}/enable", response_model=ActionOut)
    async def enable_person(user_id: UserId, body: OptionalReasonIn, caller: Manage) -> ActionOut:
        return await run(change, deps, caller, user_id, "enable", reason=body.reason)

    return router


# --- Installation -----------------------------------------------------------------------


class InstallationOut(_Strict):
    """What was given when Mango was installed. Read only: whoever runs AWS changes it."""

    name: str
    version: str | None
    release: str | None
    """Label of the release that was installed (``v0.1.0-g1a2b3c4``): what tells two builds
    of one version apart."""
    organization_id: str | None
    management_account_id: str | None
    alerts_emails: list[str]
    sign_up_domains: list[str]
    first_admins: list[str]


@dataclass(frozen=True)
class Installation:
    name: str
    version: str = ""
    release: str = ""
    organization_id: str = ""
    management_account_id: str = ""
    alerts_email: str = ""
    sign_up_domains: str = ""
    first_admin_emails: str = ""


def _listed(raw: str) -> list[str]:
    return [value.strip() for value in raw.split(",") if value.strip()]


def installation_router(
    installation: Installation,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    """Account ids and mailboxes of the installation are for administrators only: they are
    served here, not in the public runtime configuration of the SPA (TM-P13)."""
    router = APIRouter(prefix="/api/admin")

    async def view_admin(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        await authorize(caller, "ViewAdmin", *PLATFORM)
        if not caller.user.is_admin:
            raise ApiError(403, "forbidden", "not allowed")
        return caller

    @router.get("/installation", response_model=InstallationOut)
    async def get_installation(_caller: Annotated[Caller, Depends(view_admin)]) -> InstallationOut:
        return InstallationOut(
            name=installation.name,
            version=installation.version or None,
            release=installation.release or None,
            organization_id=installation.organization_id or None,
            management_account_id=installation.management_account_id or None,
            alerts_emails=_listed(installation.alerts_email),
            sign_up_domains=_listed(installation.sign_up_domains),
            first_admins=_listed(installation.first_admin_emails),
        )

    return router
