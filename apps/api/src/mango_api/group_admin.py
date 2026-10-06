"""Settings > Groups: changes to the registry of access groups with dual approval (D26, D35;
marketplace threat model TM-M13).

An administrator proposes creating a group, changing its type or area, or deleting it; a
**different** administrator approves. When a creation or a deletion is applied the Cognito
group is created or deleted too, so the registry and the directory name the same groups.
Membership is never changed here: members are assigned in the directory. Only the description
is edited by a single administrator, because it grants nothing.

Item layout in the Settings table (``PK`` / ``SK``):

* ``GROUPS`` / ``<group id>``: the registry (``mango_api.groups``), plus ``version`` for
  optimistic locking. Items seeded by IaC have no ``version`` yet (read as 0). The partition
  holds nothing else: the pre-token trigger may read it and only it.
* ``GROUP_CHANGE`` / ``<change id>``: a change request and its decision.
* ``GROUP_LOCK`` / ``<group id>``: the open request of a group (one at a time) and its expiry.

Security notes (security-best-practices, FastAPI):
* Every route declares its Cedar action (``ViewAdmin``, ``ProposeGroups``, ``ApproveGroups``);
  the decision is audited and ``is_admin`` is re-checked in process (AUTH-001, AUTHZ-001).
* Whoever proposes never approves, and nobody proposes or decides a creation or a change of
  type of a group they belong to (it would raise their own access). Refusals are audited.
* Fail-closed audit: ``requested`` is recorded before any write or Cognito call.
* Optimistic locking: a change carries the version of the group it was proposed on and is
  applied in one conditional transaction; the request is claimed before Cognito is called.
* A group stays central while an agent uses it with account-data tools, and a name agents
  still reference cannot be created again (it would hand those agents to new members).
* Names that mean something to the platform keep their meaning: ``mango-*`` is reserved and
  ``finops-central``, ``bu-lead`` and ``bu-<area>`` only exist as what the pre-token trigger
  reads them as.
* Bodies forbid extra fields and responses use explicit models (VALID-001, RESP-001).
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
import re
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Annotated, Any, Literal, NoReturn, Protocol, Self, cast

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, ConfigDict, Field, model_validator

from mango_api.agents_store import AgentVersion
from mango_api.audit import AuditLog
from mango_api.groups import PK_GROUPS
from mango_api.mcp_catalog import InvalidCatalogError, McpCatalog
from mango_api.rate_limits import Limiter
from mango_api.settings_store import SettingsStore
from mango_api.web import ApiError, Caller, rate_limited
from mango_core.agents import InvalidDefinitionError, VersionStatus
from mango_core.business_units import InvalidMappingError
from mango_core.groups import (
    MAX_DESCRIPTION_LENGTH,
    MAX_GROUPS,
    NEW_GROUP_NAME_PATTERN,
    ROLE_GROUPS,
    TYPE_AREA,
    TYPE_CENTRAL,
    GroupDef,
    InvalidGroupError,
    fixed_shape,
    is_reserved_name,
)

if TYPE_CHECKING:
    from mypy_boto3_cognito_idp import CognitoIdentityProviderClient
    from mypy_boto3_dynamodb import DynamoDBClient

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
PK_CHANGE = "GROUP_CHANGE"
PK_LOCK = "GROUP_LOCK"
CHANGE_LIFETIME = timedelta(hours=72)  # the design shows 72 h for requests nobody approved
CHANGE_RETENTION = timedelta(days=90)  # table TTL; the audit trail keeps the evidence
LIST_WINDOW = timedelta(days=30)
# A request claimed by an approval that never finished (the process died between Cognito and
# the registry) may be approved again after this long; every step is idempotent.
STALE_CLAIM = timedelta(minutes=5)
MAX_PENDING = 10
PROPOSALS_PER_HOUR = 20
MAX_PAGES = 20
GROUP_ID_PATTERN = r"^[a-z0-9][a-z0-9-]{1,63}$"
CHANGE_ID_PATTERN = r"^[0-9a-f]{32}$"
# Stricter than the registry: only IaC may have seeded longer names.
_NEW_GROUP_NAME_RE = re.compile(NEW_GROUP_NAME_PATTERN)
# Versions that are live or about to be: they are what a change of a group affects.
_LIVE = (VersionStatus.PUBLISHED, VersionStatus.APPROVED, VersionStatus.IN_REVIEW)

Kind = Literal["create", "update", "delete"]
Status = Literal["pending", "applying", "approved", "rejected", "withdrawn"]
GroupType = Literal["central", "area", "general"]
Directory = Literal["created", "adopted", "deleted", "absent"]


# --- Cognito ----------------------------------------------------------------------------


class DirectoryUnavailableError(Exception):
    pass


class CognitoGroups:
    """The two Cognito operations mango-api may perform on groups, on one user pool only.

    Both are idempotent, so an approval that failed halfway can be repeated.
    """

    def __init__(self, client: "CognitoIdentityProviderClient", user_pool_id: str) -> None:
        if not user_pool_id:
            raise ValueError("user pool id is required")
        self._client = client
        self._pool = user_pool_id

    def create(self, name: str, description: str) -> Directory:
        """``adopted`` when the directory already had the group (e.g. created by IaC)."""
        try:
            if description:
                self._client.create_group(
                    UserPoolId=self._pool, GroupName=name, Description=description
                )
            else:
                self._client.create_group(UserPoolId=self._pool, GroupName=name)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "GroupExistsException":
                return "adopted"
            raise DirectoryUnavailableError from exc
        except BotoCoreError as exc:
            raise DirectoryUnavailableError from exc
        return "created"

    def delete(self, name: str) -> Directory:
        try:
            self._client.delete_group(UserPoolId=self._pool, GroupName=name)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
                return "absent"
            raise DirectoryUnavailableError from exc
        except BotoCoreError as exc:
            raise DirectoryUnavailableError from exc
        return "deleted"


# --- Repository -------------------------------------------------------------------------


class ConflictError(Exception):
    """A concurrent change, a stale version or an open request for the same group."""


class RegistryInvalidError(Exception):
    """The registry holds an entry that breaks the schema; callers fail closed."""


@dataclass(frozen=True)
class StoredGroup:
    group: GroupDef
    version: int


@dataclass(frozen=True)
class GroupChange:
    change_id: str
    kind: Kind
    group_id: str
    status: Status
    base_version: int
    """Version of the group the change was proposed on (0 for a creation)."""
    before_type: str | None
    before_area: str | None
    type: str | None
    area: str | None
    description: str | None
    agents: int
    """Published agents that used the group when the change was proposed."""
    proposed_by: str
    proposed_by_email: str | None
    reason: str
    created_at: datetime
    expires_at: datetime
    decided_by: str | None = None
    decided_by_email: str | None = None
    decided_at: datetime | None = None
    note: str | None = None


def new_change_id() -> str:
    """Random public id (never incremental)."""
    return secrets.token_hex(16)


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds")


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: int) -> dict[str, str]:
    return {"N": str(value)}


def _opt(item: dict[str, Any], key: str) -> str | None:
    value = item.get(key, {}).get("S")
    return str(value) if value else None


def _conflict(exc: ClientError) -> None:
    code = exc.response.get("Error", {}).get("Code")
    if code in {"ConditionalCheckFailedException", "TransactionCanceledException"}:
        raise ConflictError from exc
    raise exc


def _version_condition(version: int) -> tuple[str, dict[str, Any]]:
    """The group still exists at ``version``; seeded items have no version yet (0)."""
    if version == 0:
        return "attribute_exists(PK) AND attribute_not_exists(version)", {}
    return "version = :expected", {":expected": _n(version)}


def _stored_group(item: dict[str, Any]) -> StoredGroup:
    try:
        return StoredGroup(
            group=GroupDef(
                id=item["SK"]["S"],
                type=item["type"]["S"],
                area=item.get("area", {}).get("S"),
                description=item.get("description", {}).get("S", ""),
            ),
            version=int(item.get("version", {}).get("N", "0")),
        )
    except (InvalidGroupError, KeyError, TypeError, AttributeError, ValueError) as exc:
        raise RegistryInvalidError("invalid group registry") from exc


def _change_from(item: dict[str, Any]) -> GroupChange:
    decided_at = _opt(item, "decided_at")
    return GroupChange(
        change_id=item["SK"]["S"],
        kind=item["kind"]["S"],
        group_id=item["group_id"]["S"],
        status=item["status"]["S"],
        base_version=int(item["base_version"]["N"]),
        before_type=_opt(item, "before_type"),
        before_area=_opt(item, "before_area"),
        type=_opt(item, "type"),
        area=_opt(item, "area"),
        description=item.get("description", {}).get("S"),
        agents=int(item.get("agents", {}).get("N", "0")),
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


class GroupStore:
    """Registry and change requests in the Settings table (only mango-api writes it, TM-A6)."""

    def __init__(self, dynamodb: "DynamoDBClient", table: str) -> None:
        self._db = dynamodb
        self._table = table

    def _partition(self, pk: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        pages = self._db.get_paginator("query").paginate(
            TableName=self._table,
            KeyConditionExpression="PK = :pk",
            ExpressionAttributeValues={":pk": _s(pk)},
            ConsistentRead=True,
        )
        for page_number, page in enumerate(pages):
            if page_number >= MAX_PAGES:  # hard stop on a runaway partition
                break
            items.extend(page.get("Items", []))
        return items

    def _get(self, pk: str, sk: str) -> dict[str, Any] | None:
        item: dict[str, Any] | None = self._db.get_item(
            TableName=self._table, Key={"PK": _s(pk), "SK": _s(sk)}, ConsistentRead=True
        ).get("Item")
        return item

    # --- Reads ----------------------------------------------------------------------------

    def groups(self) -> list[StoredGroup]:
        return sorted(
            (_stored_group(item) for item in self._partition(PK_GROUPS)), key=lambda g: g.group.id
        )

    def group(self, group_id: str) -> StoredGroup | None:
        item = self._get(PK_GROUPS, group_id)
        return _stored_group(item) if item else None

    def change(self, change_id: str) -> GroupChange | None:
        item = self._get(PK_CHANGE, change_id)
        return _change_from(item) if item else None

    def recent(self, now: datetime) -> list[GroupChange]:
        cutoff = now - LIST_WINDOW
        changes = [_change_from(item) for item in self._partition(PK_CHANGE)]
        return sorted(
            (c for c in changes if c.created_at >= cutoff),
            key=lambda c: c.created_at,
            reverse=True,
        )

    def locked(self, group_id: str, now: datetime) -> bool:
        """Whether the group has an open request."""
        until = _opt(self._get(PK_LOCK, group_id) or {}, "pending_expires_at")
        return bool(until and datetime.fromisoformat(until) > now)

    # --- Writes ---------------------------------------------------------------------------

    def create_change(self, change: GroupChange, now: datetime) -> None:
        item: dict[str, Any] = {
            "PK": _s(PK_CHANGE),
            "SK": _s(change.change_id),
            "kind": _s(change.kind),
            "group_id": _s(change.group_id),
            "status": _s("pending"),
            "base_version": _n(change.base_version),
            "agents": _n(change.agents),
            "proposed_by": _s(change.proposed_by),
            "reason": _s(change.reason),
            "created_at": _s(iso(change.created_at)),
            "expires_at": _s(iso(change.expires_at)),
            "ttl": _n(int((now + CHANGE_RETENTION).timestamp())),
        }
        optional = {
            "before_type": change.before_type,
            "before_area": change.before_area,
            "type": change.type,
            "area": change.area,
            "proposed_by_email": change.proposed_by_email,
        }
        item.update({key: _s(value) for key, value in optional.items() if value})
        if change.description is not None:
            item["description"] = _s(change.description)
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
                        # One open request per group; an expired one no longer blocks.
                        "Update": {
                            "TableName": self._table,
                            "Key": {"PK": _s(PK_LOCK), "SK": _s(change.group_id)},
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

    def _release(self, change: GroupChange) -> dict[str, Any]:
        return {
            "Update": {
                "TableName": self._table,
                "Key": {"PK": _s(PK_LOCK), "SK": _s(change.group_id)},
                "UpdateExpression": "REMOVE pending, pending_expires_at",
                "ConditionExpression": "pending = :id",
                "ExpressionAttributeValues": {":id": _s(change.change_id)},
            }
        }

    def claim(self, change: GroupChange, approver: str, now: datetime) -> str:
        """Take the request before calling Cognito; a concurrent decision loses here.

        The conditions repeat what the API checked (pending, unexpired, another proposer). A
        claim older than ``STALE_CLAIM`` belongs to an approval that never finished and may be
        taken over. Returns the token the final transaction must present.
        """
        token = secrets.token_hex(16)
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": _s(PK_CHANGE), "SK": _s(change.change_id)},
                UpdateExpression="SET #s = :applying, applying_at = :at, applying_token = :token",
                ConditionExpression=(
                    "(#s = :pending OR (#s = :applying AND applying_at < :stale)) "
                    "AND proposed_by <> :by AND expires_at > :at"
                ),
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":applying": _s("applying"),
                    ":pending": _s("pending"),
                    ":at": _s(iso(now)),
                    ":stale": _s(iso(now - STALE_CLAIM)),
                    ":token": _s(token),
                    ":by": _s(approver),
                },
            )
        except ClientError as exc:
            _conflict(exc)
        return token

    def unclaim(self, change: GroupChange, token: str) -> None:
        """Give the request back after a failed step, so it can be approved again."""
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": _s(PK_CHANGE), "SK": _s(change.change_id)},
                UpdateExpression="SET #s = :pending REMOVE applying_at, applying_token",
                ConditionExpression="#s = :applying AND applying_token = :token",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":pending": _s("pending"),
                    ":applying": _s("applying"),
                    ":token": _s(token),
                },
            )
        except ClientError as exc:
            _conflict(exc)

    def _registry_write(self, change: GroupChange, approver: str, now: datetime) -> dict[str, Any]:
        key = {"PK": _s(PK_GROUPS), "SK": _s(change.group_id)}
        stamp = {"updated_by": _s(approver), "updated_at": _s(iso(now))}
        if change.kind == "create":
            item: dict[str, Any] = {
                **key,
                **stamp,
                "type": _s(change.type or ""),
                "description": _s(change.description or ""),
                "version": _n(1),
                "change_id": _s(change.change_id),
            }
            if change.area:
                item["area"] = _s(change.area)
            return {
                "Put": {
                    "TableName": self._table,
                    "Item": item,
                    "ConditionExpression": "attribute_not_exists(PK)",
                }
            }
        condition, values = _version_condition(change.base_version)
        if change.kind == "delete":
            delete: dict[str, Any] = {
                "TableName": self._table,
                "Key": key,
                "ConditionExpression": condition,
            }
            if values:
                delete["ExpressionAttributeValues"] = values
            return {"Delete": delete}
        names = {"#type": "type", "#area": "area"}
        sets = ["#type = :type", "version = :new", "change_id = :cid", "updated_by = :by"]
        sets.append("updated_at = :at")
        values |= {
            ":type": _s(change.type or ""),
            ":new": _n(change.base_version + 1),
            ":cid": _s(change.change_id),
            ":by": stamp["updated_by"],
            ":at": stamp["updated_at"],
        }
        if change.area:
            sets.append("#area = :area")
            values[":area"] = _s(change.area)
        if change.description is not None:
            names["#description"] = "description"
            sets.append("#description = :description")
            values[":description"] = _s(change.description)
        expression = "SET " + ", ".join(sets) + ("" if change.area else " REMOVE #area")
        return {
            "Update": {
                "TableName": self._table,
                "Key": key,
                "UpdateExpression": expression,
                "ConditionExpression": condition,
                "ExpressionAttributeNames": names,
                "ExpressionAttributeValues": values,
            }
        }

    def apply(
        self,
        change: GroupChange,
        *,
        approver: str,
        approver_email: str | None,
        token: str | None,
        now: datetime,
    ) -> None:
        """Write the registry, close the request and release the group in one transaction.

        With ``token`` the request was claimed first (Cognito was called in between); without
        it the request must still be pending, unexpired and proposed by someone else.
        """
        values: dict[str, Any] = {
            ":approved": _s("approved"),
            ":by": _s(approver),
            ":at": _s(iso(now)),
        }
        sets = ["#s = :approved", "decided_by = :by", "decided_at = :at"]
        if approver_email:
            sets.append("decided_by_email = :email")
            values[":email"] = _s(approver_email)
        if token is None:
            condition = "#s = :pending AND proposed_by <> :by AND expires_at > :at"
            values[":pending"] = _s("pending")
        else:
            condition = "#s = :applying AND applying_token = :token"
            values |= {":applying": _s("applying"), ":token": _s(token)}
        close = {
            "Update": {
                "TableName": self._table,
                "Key": {"PK": _s(PK_CHANGE), "SK": _s(change.change_id)},
                "UpdateExpression": (
                    "SET " + ", ".join(sets) + " REMOVE applying_at, applying_token"
                ),
                "ConditionExpression": condition,
                "ExpressionAttributeNames": {"#s": "status"},
                "ExpressionAttributeValues": values,
            }
        }
        items: Any = [self._registry_write(change, approver, now), close, self._release(change)]
        try:
            self._db.transact_write_items(TransactItems=items)
        except ClientError as exc:
            _conflict(exc)

    def close(
        self,
        change: GroupChange,
        *,
        to: Literal["rejected", "withdrawn"],
        actor: str,
        actor_email: str | None,
        note: str | None,
        now: datetime,
    ) -> None:
        """Reject or withdraw a pending request; the registry is not touched.

        An expired request no longer holds the group (a new request may have taken it), so
        closing it leaves the lock alone.
        """
        values: dict[str, Any] = {
            ":to": _s(to),
            ":pending": _s("pending"),
            ":by": _s(actor),
            ":at": _s(iso(now)),
        }
        sets = ["#s = :to", "decided_by = :by", "decided_at = :at"]
        if actor_email:
            sets.append("decided_by_email = :email")
            values[":email"] = _s(actor_email)
        if note:
            sets.append("note = :note")
            values[":note"] = _s(note)
        # Only the proposer withdraws; only someone else rejects.
        who = "proposed_by = :by" if to == "withdrawn" else "proposed_by <> :by"
        items: Any = [
            {
                "Update": {
                    "TableName": self._table,
                    "Key": {"PK": _s(PK_CHANGE), "SK": _s(change.change_id)},
                    "UpdateExpression": "SET " + ", ".join(sets),
                    "ConditionExpression": f"#s = :pending AND {who}",
                    "ExpressionAttributeNames": {"#s": "status"},
                    "ExpressionAttributeValues": values,
                }
            }
        ]
        if now < change.expires_at:
            items.append(self._release(change))
        try:
            self._db.transact_write_items(TransactItems=items)
        except ClientError as exc:
            _conflict(exc)

    def set_description(
        self, group_id: str, version: int, description: str, actor: str, now: datetime
    ) -> None:
        """Edit the description of a group that has no open request (which pins its version)."""
        condition, values = _version_condition(version)
        items: Any = [
            {
                "Update": {
                    "TableName": self._table,
                    "Key": {"PK": _s(PK_GROUPS), "SK": _s(group_id)},
                    "UpdateExpression": (
                        "SET #description = :description, version = :new, "
                        "updated_by = :by, updated_at = :at"
                    ),
                    "ConditionExpression": condition,
                    "ExpressionAttributeNames": {"#description": "description"},
                    "ExpressionAttributeValues": {
                        **values,
                        ":description": _s(description),
                        ":new": _n(version + 1),
                        ":by": _s(actor),
                        ":at": _s(iso(now)),
                    },
                }
            },
            {
                "ConditionCheck": {
                    "TableName": self._table,
                    "Key": {"PK": _s(PK_LOCK), "SK": _s(group_id)},
                    "ConditionExpression": (
                        "attribute_not_exists(pending) OR pending_expires_at < :now"
                    ),
                    "ExpressionAttributeValues": {":now": _s(iso(now))},
                }
            },
        ]
        try:
            self._db.transact_write_items(TransactItems=items)
        except ClientError as exc:
            _conflict(exc)


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


Reason = Annotated[str, Field(min_length=1, max_length=500)]
Description = Annotated[str, Field(max_length=MAX_DESCRIPTION_LENGTH)]
AreaName = Annotated[str, Field(pattern=r"^[a-z0-9-]{2,32}$")]


class ProposeIn(_Strict):
    kind: Kind
    group_id: Annotated[str, Field(pattern=GROUP_ID_PATTERN)]
    type: GroupType | None = None
    area: AreaName | None = None
    description: Description | None = None
    base_version: Annotated[int, Field(ge=0)] | None = None
    """Version of the group being changed or deleted; never sent for a creation."""
    reason: Reason

    @model_validator(mode="after")
    def _shape(self) -> Self:
        if self.kind == "delete":
            if self.type is not None or self.area is not None or self.description is not None:
                raise ValueError("a deletion carries no type, area or description")
        elif self.type is None:
            raise ValueError("type is required")
        elif (self.type == TYPE_AREA) != (self.area is not None):
            raise ValueError("area is required for area groups only")
        if (self.kind == "create") != (self.base_version is None):
            raise ValueError("base_version is required to change or delete a group only")
        if self.description is not None and not self.description.isprintable():
            raise ValueError("invalid description")
        return self


class DescriptionIn(_Strict):
    version: Annotated[int, Field(ge=0)]
    description: Description

    @model_validator(mode="after")
    def _printable(self) -> Self:
        if not self.description.isprintable():
            raise ValueError("invalid description")
        return self


class EmptyIn(_Strict):
    pass


class RejectIn(_Strict):
    reason: Reason


class GroupAgentOut(_Strict):
    id: str
    name: str
    account_data: bool
    """The agent uses tools that only central groups may reach."""


class GroupAdminOut(_Strict):
    id: str
    type: GroupType
    area: str | None
    description: str
    version: int
    system: bool
    """A FinOps role group: it cannot be deleted."""
    fixed_type: bool
    """The name fixes the type and the area (role groups and ``bu-<area>``)."""
    agents: list[GroupAgentOut]


class GroupShapeOut(_Strict):
    type: GroupType
    area: str | None


class GroupTargetOut(GroupShapeOut):
    description: str | None


class GroupChangeOut(_Strict):
    change_id: str
    kind: Kind
    group_id: str
    status: Literal["pending", "approved", "rejected", "withdrawn", "expired"]
    before: GroupShapeOut | None
    after: GroupTargetOut | None
    agents: int
    proposed_by: str
    proposed_by_email: str | None
    reason: str
    created_at: str
    expires_at: str
    decided_by: str | None
    decided_by_email: str | None
    decided_at: str | None
    note: str | None


class GroupsAdminOut(_Strict):
    items: list[GroupAdminOut]
    changes: list[GroupChangeOut]


class ChangeCreatedOut(_Strict):
    change_id: str


# --- Use cases --------------------------------------------------------------------------


class LiveAgents(Protocol):
    def by_status(self, status: VersionStatus) -> list[AgentVersion]: ...


@dataclass
class GroupAdminDeps:
    store: GroupStore
    settings: SettingsStore
    """Area -> OU mapping: an area group names one of its areas."""
    directory: CognitoGroups
    agents: LiveAgents
    catalog: Callable[[], McpCatalog]
    audit: AuditLog
    rate_limiter: Limiter
    clock: Callable[[], datetime]


@dataclass(frozen=True)
class _Using:
    agent_id: str
    name: str
    account_data: bool
    published: bool


def _usage(deps: GroupAdminDeps) -> dict[str, list[_Using]]:
    """Live agent versions by each group they are shared with.

    A change of type or a deletion shows who is affected: without that list nothing is
    answered (fail closed).
    """
    try:
        catalog = deps.catalog()
        versions = [(status, v) for status in _LIVE for v in deps.agents.by_status(status)]
    except (ClientError, BotoCoreError, InvalidDefinitionError, InvalidCatalogError) as exc:
        raise ApiError(503, "agents_unavailable", "please try again") from exc
    by_group: dict[str, list[_Using]] = {}
    for status, version in versions:
        definition = version.definition
        account_data = any(
            (tool := catalog.tool(ref)) is not None and tool.central_groups_only
            for ref in definition.tools
        )
        using = _Using(
            agent_id=version.agent_id,
            name=definition.name,
            account_data=account_data,
            published=status is VersionStatus.PUBLISHED,
        )
        for group_id in definition.groups:
            by_group.setdefault(group_id, []).append(using)
    return by_group


def _published(using: list[_Using]) -> list[_Using]:
    return sorted((u for u in using if u.published), key=lambda u: (u.name.casefold(), u.agent_id))


def _groups(deps: GroupAdminDeps) -> list[StoredGroup]:
    try:
        return deps.store.groups()
    except RegistryInvalidError as exc:
        logger.warning("group registry read failed: %s", exc)
        raise ApiError(503, "groups_unavailable", "please try again") from exc


def _group(deps: GroupAdminDeps, group_id: str) -> StoredGroup | None:
    try:
        return deps.store.group(group_id)
    except RegistryInvalidError as exc:
        logger.warning("group registry read failed: %s", exc)
        raise ApiError(503, "groups_unavailable", "please try again") from exc


def _shape(kind: str | None, area: str | None) -> GroupShapeOut | None:
    return GroupShapeOut(type=cast(GroupType, kind), area=area) if kind else None


def _change_out(change: GroupChange, now: datetime) -> GroupChangeOut:
    status = "pending" if change.status == "applying" else change.status
    shown: Any = "expired" if status == "pending" and now >= change.expires_at else status
    return GroupChangeOut(
        change_id=change.change_id,
        kind=change.kind,
        group_id=change.group_id,
        status=shown,
        before=_shape(change.before_type, change.before_area),
        after=(
            GroupTargetOut(
                type=cast(GroupType, change.type),
                area=change.area,
                description=change.description,
            )
            if change.type
            else None
        ),
        agents=change.agents,
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


def list_view(deps: GroupAdminDeps) -> GroupsAdminOut:
    now = deps.clock()
    usage = _usage(deps)
    return GroupsAdminOut(
        items=[
            GroupAdminOut(
                id=stored.group.id,
                type=cast(GroupType, stored.group.type),
                area=stored.group.area,
                description=stored.group.description,
                version=stored.version,
                system=stored.group.id in ROLE_GROUPS,
                fixed_type=fixed_shape(stored.group.id) is not None,
                agents=[
                    GroupAgentOut(id=u.agent_id, name=u.name, account_data=u.account_data)
                    for u in _published(usage.get(stored.group.id, []))
                ],
            )
            for stored in _groups(deps)
        ],
        changes=[_change_out(c, now) for c in deps.store.recent(now)],
    )


def _refuse(
    deps: GroupAdminDeps, event: str, caller: Caller, detail: dict[str, Any], err: ApiError
) -> NoReturn:
    """A refused decision on a group is audited too; the refusal stands even if audit fails."""
    try:
        deps.audit.emit(
            event,
            caller.user.user_id,
            {**detail, "outcome": "rejected", "error": err.code},
            caller.user,
        )
    except Exception:
        logger.exception("audit emit failed for a refused group change")
    raise err


def _audited[T](
    deps: GroupAdminDeps,
    event: str,
    caller: Caller,
    detail: dict[str, Any],
    write: Callable[[], T],
) -> T:
    """Fail-closed audit: ``requested`` before writing, then ``applied`` or ``rejected``.

    ``detail`` is read again after the write, so the write may add what it learned (what
    happened in the directory).
    """
    actor, user = caller.user.user_id, caller.user
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "requested"}, user)
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
            deps.audit.emit(event, actor, {**detail, "outcome": "rejected", "error": code}, user)
        except Exception:
            logger.exception("audit emit failed after a rejected group change")
        raise
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "applied"}, user)
    except Exception:
        logger.exception("audit emit failed after an applied group change")
    return result


def _detail(change: GroupChange) -> dict[str, Any]:
    return {
        "change_id": change.change_id,
        "kind": change.kind,
        "group": change.group_id,
        "proposed_by": change.proposed_by,
        "base_version": change.base_version,
        "before": (
            {"type": change.before_type, "area": change.before_area} if change.before_type else None
        ),
        "after": (
            {"type": change.type, "area": change.area, "description": change.description}
            if change.type
            else None
        ),
    }


def _raises_own_access(caller: Caller, change: GroupChange) -> bool:
    """Creating a group or changing its type decides what its members may reach."""
    return change.kind != "delete" and change.group_id in caller.user.groups


def _areas(deps: GroupAdminDeps) -> frozenset[str]:
    try:
        return frozenset(deps.settings.mapping().units)
    except (ClientError, BotoCoreError, InvalidMappingError, KeyError, ValueError) as exc:
        raise ApiError(503, "settings_unavailable", "please try again") from exc


def _ids(using: list[_Using]) -> dict[str, Any]:
    return {"agents": sorted({u.agent_id for u in using})[:20]}


def _check_target(
    deps: GroupAdminDeps, change: GroupChange, current: StoredGroup | None, usage: list[_Using]
) -> None:
    """The type and area a creation or a change asks for."""
    target = (change.type, change.area)
    fixed = fixed_shape(change.group_id)
    if fixed is not None and target != fixed:
        raise ApiError(422, "fixed_type", "the name of this group fixes its type and area")
    if change.area is not None and change.area not in _areas(deps):
        raise ApiError(422, "unknown_area", "that area is not in the area mapping")
    if current is None:
        return
    if target == (current.group.type, current.group.area):
        raise ApiError(422, "invalid_request", "the proposal does not change the group")
    if current.group.type == TYPE_CENTRAL and change.type != TYPE_CENTRAL:
        blocking = [u for u in usage if u.account_data]
        if blocking:
            raise ApiError(
                409,
                "central_in_use",
                "agents use this group with account-data tools",
                extra=_ids(blocking),
            )


def _check(
    deps: GroupAdminDeps, change: GroupChange, current: StoredGroup | None, usage: list[_Using]
) -> None:
    """Rules of a change against the registry as it is now.

    Run when it is proposed and again when it is approved: the registry, the areas and the
    agents may have changed while it waited.
    """
    if change.kind == "create":
        if current is not None:
            raise ApiError(409, "group_exists", "a group with that name already exists")
        if usage:
            # Agents kept the name of a deleted group: its new members would inherit them.
            raise ApiError(
                409,
                "group_referenced",
                "agents still reference that name; use another one",
                extra=_ids(usage),
            )
    elif current is None:
        raise ApiError(404, "not_found", "group not found")
    elif current.version != change.base_version:
        raise ApiError(409, "version_conflict", "the group changed; reload and try again")
    if change.kind != "delete":
        _check_target(deps, change, current, usage)
    elif change.group_id in ROLE_GROUPS:
        raise ApiError(422, "system_group", "system groups cannot be deleted")


def propose(deps: GroupAdminDeps, caller: Caller, body: ProposeIn) -> str:
    actor = caller.user.user_id
    event = "settings.groups.proposed"
    if not deps.rate_limiter.allow(actor):
        raise rate_limited(deps.rate_limiter.retry_after(actor))
    if is_reserved_name(body.group_id):
        raise ApiError(422, "reserved_name", "that name is reserved for the platform")
    current = _group(deps, body.group_id)
    if body.kind == "create" and not _NEW_GROUP_NAME_RE.fullmatch(body.group_id):
        raise ApiError(422, "invalid_request", "invalid fields: group_id")
    now = deps.clock()
    usage = _usage(deps).get(body.group_id, [])
    change = GroupChange(
        change_id=new_change_id(),
        kind=body.kind,
        group_id=body.group_id,
        status="pending",
        base_version=body.base_version or 0,
        before_type=current.group.type if current else None,
        before_area=current.group.area if current else None,
        type=body.type,
        area=body.area,
        # A new group always has a description; a change keeps the current one unless it
        # brings another.
        description=(body.description or "") if body.kind == "create" else body.description,
        agents=len(_published(usage)),
        proposed_by=actor,
        proposed_by_email=caller.user.email,
        reason=body.reason,
        created_at=now,
        expires_at=now + CHANGE_LIFETIME,
    )
    detail = {**_detail(change), "reason": body.reason, "agents": change.agents}
    if _raises_own_access(caller, change):
        _refuse(
            deps,
            event,
            caller,
            detail,
            ApiError(403, "self_edit", "you cannot change a group you belong to"),
        )
    _check(deps, change, current, usage)
    if deps.store.locked(change.group_id, now):
        raise ApiError(409, "already_pending", "there is already an open request for this group")
    recent = [_change_out(c, now) for c in deps.store.recent(now)]
    pending = [c for c in recent if c.status == "pending"]
    if len(pending) >= MAX_PENDING:
        raise ApiError(409, "too_many_pending", "too many pending requests; resolve some first")
    creating = sum(1 for c in pending if c.kind == "create")
    if change.kind == "create" and len(_groups(deps)) + creating >= MAX_GROUPS:
        raise ApiError(409, "too_many_groups", "the registry is full")

    def write() -> None:
        try:
            deps.store.create_change(change, now)
        except ConflictError as exc:
            raise ApiError(409, "already_pending", "there is already an open request") from exc

    _audited(deps, event, caller, detail, write)
    return change.change_id


def _open_change(deps: GroupAdminDeps, change_id: str, *, resumable: bool = False) -> GroupChange:
    change = deps.store.change(change_id)
    if change is None:
        raise ApiError(404, "not_found", "request not found")
    if change.status != "pending" and not (resumable and change.status == "applying"):
        raise ApiError(409, "version_conflict", "the request is already closed")
    return change


def approve(deps: GroupAdminDeps, caller: Caller, change_id: str) -> None:
    actor = caller.user.user_id
    event = "settings.groups.approved"
    # An approval that never finished stays ``applying``: the store decides whether its claim
    # is old enough to be taken over.
    change = _open_change(deps, change_id, resumable=True)
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
    if _raises_own_access(caller, change):
        _refuse(
            deps,
            event,
            caller,
            detail,
            ApiError(403, "self_edit", "you cannot decide on a group you belong to"),
        )

    def write() -> None:
        _check(deps, change, _group(deps, change.group_id), _usage(deps).get(change.group_id, []))
        email = caller.user.email
        if change.kind == "update":
            # Nothing outside the table: one transaction decides.
            try:
                deps.store.apply(change, approver=actor, approver_email=email, token=None, now=now)
            except ConflictError as exc:
                raise ApiError(409, "version_conflict", "the request changed; reload") from exc
            return
        try:
            # Claim first: a concurrent approval or rejection loses here, before Cognito.
            token = deps.store.claim(change, actor, now)
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the request changed; reload") from exc
        try:
            if change.kind == "create":
                detail["directory"] = deps.directory.create(
                    change.group_id, change.description or ""
                )
            else:
                detail["directory"] = deps.directory.delete(change.group_id)
            deps.store.apply(change, approver=actor, approver_email=email, token=token, now=now)
        except Exception as exc:
            # Both steps can be repeated, so the request goes back to pending.
            try:
                deps.store.unclaim(change, token)
            except Exception:
                logger.exception("could not release a claimed group change")
            if isinstance(exc, DirectoryUnavailableError):
                raise ApiError(
                    502, "upstream_error", "the directory could not be updated; retry"
                ) from exc
            if isinstance(exc, ConflictError):
                raise ApiError(409, "version_conflict", "the group changed; reload") from exc
            raise

    _audited(deps, event, caller, detail, write)


def reject(deps: GroupAdminDeps, caller: Caller, change_id: str, reason: str) -> None:
    actor = caller.user.user_id
    event = "settings.groups.rejected"
    change = _open_change(deps, change_id)
    detail = {**_detail(change), "rejected_by": actor, "reason": reason}
    if change.proposed_by == actor:
        # The proposer withdraws; rejecting is another administrator's decision.
        raise ApiError(403, "use_withdraw", "withdraw your own request instead")
    if _raises_own_access(caller, change):
        # Rejecting is a decision too: no veto over a group you belong to.
        _refuse(
            deps,
            event,
            caller,
            detail,
            ApiError(403, "self_edit", "you cannot decide on a group you belong to"),
        )
    now = deps.clock()

    def write() -> None:
        try:
            deps.store.close(
                change,
                to="rejected",
                actor=actor,
                actor_email=caller.user.email,
                note=reason,
                now=now,
            )
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the request changed; reload") from exc

    _audited(deps, event, caller, detail, write)


def withdraw(deps: GroupAdminDeps, caller: Caller, change_id: str) -> None:
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

    _audited(deps, "settings.groups.withdrawn", caller, _detail(change), write)


def update_description(
    deps: GroupAdminDeps, caller: Caller, group_id: str, body: DescriptionIn
) -> None:
    current = _group(deps, group_id)
    if current is None:
        raise ApiError(404, "not_found", "group not found")
    if current.version != body.version:
        raise ApiError(409, "version_conflict", "the group changed; reload and try again")
    now = deps.clock()
    if deps.store.locked(group_id, now):
        raise ApiError(409, "already_pending", "there is an open request for this group")
    # Validated with the registry's own rules before it is stored.
    try:
        replace(current.group, description=body.description)
    except InvalidGroupError as exc:
        raise ApiError(422, "invalid_request", "invalid fields: description") from exc
    actor = caller.user.user_id

    def write() -> None:
        try:
            deps.store.set_description(group_id, body.version, body.description, actor, now)
        except ConflictError as exc:
            raise ApiError(409, "version_conflict", "the group changed; reload") from exc

    _audited(
        deps,
        "settings.groups.description_updated",
        caller,
        {
            "group": group_id,
            "base_version": body.version,
            "before": {"description": current.group.description},
            "after": {"description": body.description},
        },
        write,
    )


# --- Routes -----------------------------------------------------------------------------


Authorize = Callable[[Caller, str, str, str], Awaitable[None]]


def group_admin_router(
    deps: GroupAdminDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    router = APIRouter(prefix="/api/admin/groups")

    def admin_action(action: str) -> Callable[[Caller], Awaitable[Caller]]:
        async def dependency(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
            await authorize(caller, action, *PLATFORM)
            # Defense in depth: the Cedar policies already require isAdmin.
            if not caller.user.is_admin:
                raise ApiError(403, "forbidden", "not allowed")
            return caller

        return dependency

    View = Annotated[Caller, Depends(admin_action("ViewAdmin"))]  # noqa: N806
    Propose = Annotated[Caller, Depends(admin_action("ProposeGroups"))]  # noqa: N806
    Approve = Annotated[Caller, Depends(admin_action("ApproveGroups"))]  # noqa: N806
    ChangeId = Annotated[str, Path(pattern=CHANGE_ID_PATTERN)]  # noqa: N806
    GroupId = Annotated[str, Path(pattern=GROUP_ID_PATTERN)]  # noqa: N806

    async def run[T](fn: Callable[..., T], *args: Any) -> T:
        try:
            return await asyncio.to_thread(fn, *args)
        except (ClientError, BotoCoreError) as exc:
            logger.warning("group settings storage failed: %s", type(exc).__name__)
            raise ApiError(503, "groups_unavailable", "please try again") from exc

    @router.get("", response_model=GroupsAdminOut)
    async def get_admin_groups(_caller: View) -> GroupsAdminOut:
        return await run(list_view, deps)

    @router.post("/changes", response_model=ChangeCreatedOut, status_code=201)
    async def post_group_change(body: ProposeIn, caller: Propose) -> ChangeCreatedOut:
        return ChangeCreatedOut(change_id=await run(propose, deps, caller, body))

    @router.post("/changes/{change_id}/approve", response_model=GroupsAdminOut)
    async def approve_group_change(
        change_id: ChangeId, _body: EmptyIn, caller: Approve
    ) -> GroupsAdminOut:
        await run(approve, deps, caller, change_id)
        return await run(list_view, deps)

    @router.post("/changes/{change_id}/reject", response_model=GroupsAdminOut)
    async def reject_group_change(
        change_id: ChangeId, body: RejectIn, caller: Approve
    ) -> GroupsAdminOut:
        await run(reject, deps, caller, change_id, body.reason)
        return await run(list_view, deps)

    @router.post("/changes/{change_id}/withdraw", response_model=GroupsAdminOut)
    async def withdraw_group_change(
        change_id: ChangeId, _body: EmptyIn, caller: Propose
    ) -> GroupsAdminOut:
        await run(withdraw, deps, caller, change_id)
        return await run(list_view, deps)

    @router.put("/{group_id}/description", response_model=GroupsAdminOut)
    async def put_group_description(
        group_id: GroupId, body: DescriptionIn, caller: Propose
    ) -> GroupsAdminOut:
        await run(update_description, deps, caller, group_id, body)
        return await run(list_view, deps)

    return router
