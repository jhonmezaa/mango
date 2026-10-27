"""Registrations of remote MCP servers and their requests in the Settings table (D93, D98 (12)),
the approved catalog the remote provisioner signs, and the Identity providers mango-api keeps.

Item layout (``PK`` / ``SK``; keys from ``mango_core.remote_mcp``):

* ``REMOTE#<reg>`` / ``REGISTRATION``: what was asked and approved last, and its life cycle.
  mango-api writes requests, approvals, retries, rotations and ``disabling``; the remote
  provisioner writes the rest of the life cycle. ``version`` is mango-api's optimistic lock;
  ``approval_id`` names the approved state an execution of the provisioner works on (it is its
  input, like ``enablement_id`` of a pack). Never the secret nor its ARN.
* ``REMOTE_CHANGE#<reg>`` / ``CHANGE#<id>``: one request and its decision, kept 90 days; and
  ``PENDING``, the marker of the one request that waits (created and deleted in the same
  transaction as the request and its decision, D46 (7)).
* ``REMOTE_ORG#<profile>#<org>`` / ``CURRENT``: one registration per profile and organization.
* ``REMOTE_INDEX`` / ``REGISTRATIONS``: the ids of every registration (a string set), so the
  catalog lists them without scanning the table. Only mango-api reads and writes it.
* ``MCP_REMOTE#<reg>`` / ``APPROVED``: read only here, and verified with the public half of
  ``alias/Mango-<ns>-remote-mcp``; IAM denies mango-api every write (D98 (13)).

The client secret only travels from the request to ``CreateOauth2CredentialProvider`` or
``UpdateOauth2CredentialProvider``: AgentCore Identity keeps it in its own Secrets Manager
secret. Nothing here stores, logs or returns it.
"""

from __future__ import annotations

import logging
import re
import secrets
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import StrEnum
from types import MappingProxyType
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from botocore.exceptions import BotoCoreError, ClientError

from mango_core.remote_mcp import (
    ApprovedRemote,
    RemoteNotApprovedError,
    approved_key,
    change_key,
    load_public_key,
    organization_key,
    pending_change_key,
    registration_key,
    target_name,
)
from mango_packs.enablement import iso

if TYPE_CHECKING:
    from cryptography.hazmat.primitives.asymmetric import ec

logger = logging.getLogger(__name__)

CHANGE_LIFETIME = timedelta(days=7)
CHANGE_RETENTION = timedelta(days=90)  # table TTL; the audit trail keeps the evidence
MAX_CHANGES_READ = 50
MAX_REGISTRATIONS = 50
"""Registrations the index may hold, disabled ones included (the live ones are capped lower)."""
INDEX_KEY: dict[str, Any] = {"PK": {"S": "REMOTE_INDEX"}, "SK": {"S": "REGISTRATIONS"}}
APPROVED_CACHE_SECONDS = 30
_CONFLICT_REASONS = frozenset({"None", "ConditionalCheckFailed", "TransactionConflict"})


class RemoteConflictError(Exception):
    """The registration or the request changed since the caller read it."""


class RemoteExistsError(Exception):
    """The organization already has a registration of that profile."""


class RemoteRecordError(Exception):
    """A stored item is not in the expected layout; callers fail closed."""


class RemoteRegistrationStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    CREATING = "creating"
    ACTIVE = "active"
    FAILED = "failed"
    DISABLING = "disabling"
    DISABLED = "disabled"


class RemoteChangeKind(StrEnum):
    ENABLE = "enable"
    REPLACE_APP = "replace_app"
    PARAMS = "params"


class RemoteChangeStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    WITHDRAWN = "withdrawn"
    CANCELLED = "cancelled"
    """Closed because the registration was disabled while the request waited."""


@dataclass(frozen=True)
class Registration:
    registration_id: str
    profile_id: str
    organization: str
    toolsets: tuple[str, ...]
    groups: tuple[str, ...]
    status: RemoteRegistrationStatus
    version: int
    generation: int
    """Generation of the approved Identity provider (0 while nothing was approved)."""
    provider_generations: int
    """Highest generation ever created: a provider name is never used twice (its secret
    may still be scheduled for deletion)."""
    created_at: str
    profile_version: str | None = None
    profile_sha256: str | None = None
    tenant_id: str | None = None
    client_id: str | None = None
    provider_name: str | None = None
    provider_arn: str | None = None
    callback_url: str | None = None
    secret_expires_on: str | None = None
    secret_rotated_at: str | None = None
    requested_by: str | None = None
    requested_by_email: str | None = None
    approved_by: str | None = None
    approved_by_email: str | None = None
    approved_at: str | None = None
    disabled_by: str | None = None
    disabled_by_email: str | None = None
    disabled_at: str | None = None
    disabled_reason: str | None = None
    failure_code: str | None = None
    approval_id: str | None = None
    updated_at: str | None = None


@dataclass(frozen=True)
class RemoteChange:
    change_id: str
    registration_id: str
    kind: RemoteChangeKind
    status: RemoteChangeStatus
    profile_id: str
    profile_version: str
    profile_sha256: str
    organization: str
    toolsets: tuple[str, ...]
    groups: tuple[str, ...]
    base_version: int
    requested_by: str
    requested_by_email: str | None
    created_at: datetime
    expires_at: datetime
    reason: str | None = None
    tenant_id: str | None = None
    client_id: str | None = None
    secret_expires_on: str | None = None
    previous_toolsets: tuple[str, ...] | None = None
    previous_groups: tuple[str, ...] | None = None
    pending_generation: int | None = None
    pending_provider_name: str | None = None
    pending_provider_arn: str | None = None
    callback_url: str | None = None
    decided_by: str | None = None
    decided_by_email: str | None = None
    decided_at: str | None = None
    decision_reason: str | None = None

    @property
    def creates_provider(self) -> bool:
        return self.pending_provider_name is not None


def new_change_id() -> str:
    """Random public id (never incremental)."""
    return secrets.token_hex(16)


def new_approval_id() -> str:
    """Random id of one approved state; the remote provisioner's execution input carries it."""
    return secrets.token_hex(16)


# --- Item helpers -------------------------------------------------------------------------


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: int) -> dict[str, str]:
    return {"N": str(value)}


def _l(values: Iterable[str]) -> dict[str, Any]:
    return {"L": [_s(v) for v in values]}


def _opt(item: Mapping[str, Any], name: str) -> str | None:
    value: str | None = item.get(name, {}).get("S")
    return value


def _strings(item: Mapping[str, Any], name: str) -> tuple[str, ...]:
    values = item[name]["L"]
    out = tuple(v["S"] for v in values)
    if not all(isinstance(v, str) for v in out):
        raise TypeError(name)
    return out


def _opt_strings(item: Mapping[str, Any], name: str) -> tuple[str, ...] | None:
    return _strings(item, name) if name in item else None


def _conflict(exc: ClientError) -> None:
    """Condition failures and concurrent writers are conflicts; anything else raises."""
    code = exc.response.get("Error", {}).get("Code")
    if code == "ConditionalCheckFailedException":
        raise RemoteConflictError("registration changed") from exc
    if code == "TransactionCanceledException":
        reasons = {str(r.get("Code")) for r in exc.response.get("CancellationReasons", [])}
        if reasons <= _CONFLICT_REASONS:
            raise RemoteConflictError("registration changed") from exc
    raise exc


def _registration_from(registration_id: str, item: Mapping[str, Any]) -> Registration:
    try:
        return Registration(
            registration_id=registration_id,
            profile_id=item["profile_id"]["S"],
            organization=item["organization"]["S"],
            toolsets=_strings(item, "toolsets"),
            groups=_strings(item, "groups"),
            status=RemoteRegistrationStatus(item["status"]["S"]),
            version=int(item["version"]["N"]),
            generation=int(item.get("generation", {}).get("N", "0")),
            provider_generations=int(item.get("provider_generations", {}).get("N", "0")),
            created_at=item["created_at"]["S"],
            **{
                name: _opt(item, name)
                for name in (
                    "profile_version",
                    "profile_sha256",
                    "tenant_id",
                    "client_id",
                    "provider_name",
                    "provider_arn",
                    "callback_url",
                    "secret_expires_on",
                    "secret_rotated_at",
                    "requested_by",
                    "requested_by_email",
                    "approved_by",
                    "approved_by_email",
                    "approved_at",
                    "disabled_by",
                    "disabled_by_email",
                    "disabled_at",
                    "disabled_reason",
                    "failure_code",
                    "approval_id",
                    "updated_at",
                )
            },
        )
    except (KeyError, ValueError, TypeError) as exc:
        raise RemoteRecordError("registration unreadable") from exc


_CHANGE_OPTIONAL = (
    "reason",
    "tenant_id",
    "client_id",
    "secret_expires_on",
    "pending_provider_name",
    "pending_provider_arn",
    "callback_url",
    "decided_by",
    "decided_by_email",
    "decided_at",
    "decision_reason",
)


def _change_from(registration_id: str, item: Mapping[str, Any]) -> RemoteChange:
    try:
        generation = item.get("pending_generation", {}).get("N")
        return RemoteChange(
            change_id=item["SK"]["S"].removeprefix("CHANGE#"),
            registration_id=registration_id,
            kind=RemoteChangeKind(item["kind"]["S"]),
            status=RemoteChangeStatus(item["status"]["S"]),
            profile_id=item["profile_id"]["S"],
            profile_version=item["profile_version"]["S"],
            profile_sha256=item["profile_sha256"]["S"],
            organization=item["organization"]["S"],
            toolsets=_strings(item, "toolsets"),
            groups=_strings(item, "groups"),
            base_version=int(item["base_version"]["N"]),
            requested_by=item["requested_by"]["S"],
            requested_by_email=_opt(item, "requested_by_email"),
            created_at=datetime.fromisoformat(item["created_at"]["S"]),
            expires_at=datetime.fromisoformat(item["expires_at"]["S"]),
            previous_toolsets=_opt_strings(item, "previous_toolsets"),
            previous_groups=_opt_strings(item, "previous_groups"),
            pending_generation=int(generation) if generation is not None else None,
            **{name: _opt(item, name) for name in _CHANGE_OPTIONAL},
        )
    except (KeyError, ValueError, TypeError) as exc:
        raise RemoteRecordError("remote request unreadable") from exc


def _change_item(change: RemoteChange) -> dict[str, Any]:
    now = change.created_at
    item: dict[str, Any] = {
        **change_key(change.registration_id, change.change_id),
        "kind": _s(change.kind),
        "status": _s(RemoteChangeStatus.PENDING),
        "profile_id": _s(change.profile_id),
        "profile_version": _s(change.profile_version),
        "profile_sha256": _s(change.profile_sha256),
        "organization": _s(change.organization),
        "toolsets": _l(change.toolsets),
        "groups": _l(change.groups),
        "base_version": _n(change.base_version),
        "requested_by": _s(change.requested_by),
        "created_at": _s(iso(now)),
        "expires_at": _s(iso(change.expires_at)),
        "ttl": _n(int((now + CHANGE_RETENTION).timestamp())),
    }
    for name in (
        "reason",
        "requested_by_email",
        "tenant_id",
        "client_id",
        "secret_expires_on",
        "pending_provider_name",
        "pending_provider_arn",
        "callback_url",
    ):
        value = getattr(change, name)
        if value:
            item[name] = _s(value)
    if change.pending_generation is not None:
        item["pending_generation"] = _n(change.pending_generation)
    if change.previous_toolsets is not None:
        item["previous_toolsets"] = _l(change.previous_toolsets)
    if change.previous_groups is not None:
        item["previous_groups"] = _l(change.previous_groups)
    return item


def _status_condition(
    statuses: Iterable[RemoteRegistrationStatus], version: int, prefix: str = ""
) -> tuple[str, dict[str, Any]]:
    names = sorted(statuses)
    keys = [f":{prefix}st{i}" for i in range(len(names))]
    values: dict[str, Any] = {key: _s(name) for key, name in zip(keys, names, strict=True)}
    values[f":{prefix}v"] = _n(version)
    return f"#s IN ({', '.join(keys)}) AND version = :{prefix}v", values


# --- The registrations and their requests -------------------------------------------------


class RemoteStore:
    def __init__(self, dynamodb: Any, table: str) -> None:
        self._db = dynamodb
        self._table = table

    def _get(self, key: Mapping[str, Any]) -> dict[str, Any] | None:
        item: dict[str, Any] | None = self._db.get_item(
            TableName=self._table, Key=key, ConsistentRead=True
        ).get("Item")
        return item

    def _transact(self, items: list[dict[str, Any]]) -> None:
        try:
            self._db.transact_write_items(TransactItems=items)
        except ClientError as exc:
            _conflict(exc)

    # --- Reads ----------------------------------------------------------------------------

    def registration(self, registration_id: str) -> Registration | None:
        item = self._get(registration_key(registration_id))
        return _registration_from(registration_id, item) if item else None

    def registration_ids(self) -> list[str]:
        item = self._get(INDEX_KEY)
        if item is None:
            return []
        if "ids" not in item:
            return []  # DynamoDB removes a set when its last element goes
        try:
            ids = item["ids"]["SS"]
        except (KeyError, TypeError) as exc:
            raise RemoteRecordError("registration index unreadable") from exc
        return sorted(ids)

    def registrations(self) -> list[Registration]:
        """Every registration the index names (a deleted one is left out)."""
        found = (self.registration(reg) for reg in self.registration_ids())
        return [r for r in found if r is not None]

    def organization_taken(self, profile_id: str, organization: str) -> bool:
        return self._get(organization_key(profile_id, organization)) is not None

    def change(self, registration_id: str, change_id: str) -> RemoteChange | None:
        item = self._get(change_key(registration_id, change_id))
        return _change_from(registration_id, item) if item else None

    def pending(self, registration_id: str, now: datetime) -> RemoteChange | None:
        """The request that waits for another administrator, if it has not expired."""
        marker = self._get(pending_change_key(registration_id))
        if marker is None:
            return None
        change = self.change(registration_id, marker["change_id"]["S"])
        if (
            change is None
            or change.status is not RemoteChangeStatus.PENDING
            or now >= change.expires_at
        ):
            return None
        return change

    def expired(self, registration_id: str, now: datetime) -> RemoteChange | None:
        """The request the marker still names although it expired: nobody decided it."""
        marker = self._get(pending_change_key(registration_id))
        if marker is None:
            return None
        change = self.change(registration_id, marker["change_id"]["S"])
        if (
            change is None
            or change.status is not RemoteChangeStatus.PENDING
            or now < change.expires_at
        ):
            return None
        return change

    def close_expired(self, change: RemoteChange, now: datetime) -> None:
        """Close a request that expired undecided (``cancelled``, by ``system:expiry``)."""
        try:
            self._db.update_item(
                TableName=self._table,
                Key=change_key(change.registration_id, change.change_id),
                UpdateExpression="SET #s = :cancelled, decided_by = :by, decided_at = :at",
                ConditionExpression="#s = :pending AND expires_at <= :at",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":cancelled": _s(RemoteChangeStatus.CANCELLED),
                    ":pending": _s(RemoteChangeStatus.PENDING),
                    ":by": _s("system:expiry"),
                    ":at": _s(iso(now)),
                },
            )
        except ClientError as exc:
            _conflict(exc)

    def changes(self, registration_id: str) -> list[RemoteChange]:
        """Requests of a registration, newest first (at most ``MAX_CHANGES_READ``)."""
        key = change_key(registration_id, "0")
        items = self._db.query(
            TableName=self._table,
            KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
            ExpressionAttributeValues={":pk": key["PK"], ":prefix": _s("CHANGE#")},
            ConsistentRead=True,
            Limit=MAX_CHANGES_READ,
        ).get("Items", [])
        changes = [_change_from(registration_id, item) for item in items]
        changes.sort(key=lambda c: c.created_at, reverse=True)
        return changes

    # --- Requests -------------------------------------------------------------------------

    def _pending_put(self, change: RemoteChange) -> dict[str, Any]:
        now = change.created_at
        return {
            "Put": {
                "TableName": self._table,
                "Item": {
                    **pending_change_key(change.registration_id),
                    "change_id": _s(change.change_id),
                    "expires_at": _s(iso(change.expires_at)),
                    "ttl": _n(int((now + CHANGE_RETENTION).timestamp())),
                },
                # An expired request no longer blocks the registration.
                "ConditionExpression": "attribute_not_exists(PK) OR expires_at <= :now",
                "ExpressionAttributeValues": {":now": _s(iso(now))},
            }
        }

    def _change_put(self, change: RemoteChange) -> dict[str, Any]:
        return {
            "Put": {
                "TableName": self._table,
                "Item": _change_item(change),
                "ConditionExpression": "attribute_not_exists(PK)",
            }
        }

    def create_registration(self, change: RemoteChange) -> None:
        """A new registration, ``pending``, with its first request (``enable``).

        Raises ``RemoteExistsError`` if the organization already has one of that profile.
        """
        now = iso(change.created_at)
        item: dict[str, Any] = {
            **registration_key(change.registration_id),
            "profile_id": _s(change.profile_id),
            "profile_version": _s(change.profile_version),
            "profile_sha256": _s(change.profile_sha256),
            "organization": _s(change.organization),
            "toolsets": _l(change.toolsets),
            "groups": _l(change.groups),
            "status": _s(RemoteRegistrationStatus.PENDING),
            "version": _n(0),
            "generation": _n(0),
            "provider_generations": _n(change.pending_generation or 0),
            "requested_by": _s(change.requested_by),
            "requested_at": _s(now),
            "created_at": _s(now),
            "updated_at": _s(now),
        }
        if change.requested_by_email:
            item["requested_by_email"] = _s(change.requested_by_email)
        org = organization_key(change.profile_id, change.organization)
        items: list[dict[str, Any]] = [
            {
                "Put": {
                    "TableName": self._table,
                    "Item": item,
                    "ConditionExpression": "attribute_not_exists(PK)",
                }
            },
            {
                "Put": {
                    "TableName": self._table,
                    "Item": {**org, "registration_id": _s(change.registration_id)},
                    "ConditionExpression": "attribute_not_exists(PK)",
                }
            },
            {
                "Update": {
                    "TableName": self._table,
                    "Key": INDEX_KEY,
                    "UpdateExpression": "ADD ids :id",
                    "ConditionExpression": "attribute_not_exists(ids) OR size(ids) < :max",
                    "ExpressionAttributeValues": {
                        ":id": {"SS": [change.registration_id]},
                        ":max": _n(MAX_REGISTRATIONS),
                    },
                }
            },
            self._change_put(change),
            self._pending_put(change),
        ]
        try:
            self._db.transact_write_items(TransactItems=items)
        except ClientError as exc:
            reasons = exc.response.get("CancellationReasons", [])
            if len(reasons) > 1 and reasons[1].get("Code") == "ConditionalCheckFailed":
                raise RemoteExistsError("organization already registered") from exc
            _conflict(exc)

    def request_change(
        self,
        change: RemoteChange,
        registration: Registration,
        allowed: set[RemoteRegistrationStatus],
    ) -> None:
        """A request on an existing registration, which must still be as the caller saw it.
        A request that creates a provider records its generation, so it is never reused."""
        condition, values = _status_condition(allowed, change.base_version)
        guard: dict[str, Any] = {
            "TableName": self._table,
            "Key": registration_key(registration.registration_id),
            "ConditionExpression": condition,
            "ExpressionAttributeNames": {"#s": "status"},
            "ExpressionAttributeValues": values,
        }
        if change.pending_generation is not None:
            values[":gen"] = _n(change.pending_generation)
            values[":seen"] = _n(registration.provider_generations)
            guard["ConditionExpression"] = (
                f"{condition} AND (attribute_not_exists(provider_generations)"
                " OR provider_generations = :seen)"
            )
            guard["UpdateExpression"] = "SET provider_generations = :gen"
            first: dict[str, Any] = {"Update": guard}
        else:
            first = {"ConditionCheck": guard}
        self._transact([first, self._change_put(change), self._pending_put(change)])

    def _close(
        self,
        change: RemoteChange,
        status: RemoteChangeStatus,
        *,
        by: str,
        by_email: str | None,
        now: datetime,
        reason: str | None = None,
        condition: str = "#s = :pending",
    ) -> list[dict[str, Any]]:
        """Transaction items that close a pending request and free the registration."""
        update = "SET #s = :status, decided_by = :by, decided_at = :at"
        values: dict[str, Any] = {
            ":status": _s(status),
            ":pending": _s(RemoteChangeStatus.PENDING),
            ":by": _s(by),
            ":at": _s(iso(now)),
        }
        if by_email:
            update += ", decided_by_email = :email"
            values[":email"] = _s(by_email)
        if reason:
            update += ", decision_reason = :reason"
            values[":reason"] = _s(reason)
        return [
            {
                "Update": {
                    "TableName": self._table,
                    "Key": change_key(change.registration_id, change.change_id),
                    "UpdateExpression": update,
                    "ConditionExpression": condition,
                    "ExpressionAttributeNames": {"#s": "status"},
                    "ExpressionAttributeValues": values,
                }
            },
            {
                "Delete": {
                    "TableName": self._table,
                    "Key": pending_change_key(change.registration_id),
                    "ConditionExpression": "change_id = :id",
                    "ExpressionAttributeValues": {":id": _s(change.change_id)},
                }
            },
        ]

    def _forget(self, change: RemoteChange) -> list[dict[str, Any]]:
        """Items that remove a registration that never got past ``pending``: only its
        history stays (D98 (12))."""
        return [
            {
                "Delete": {
                    "TableName": self._table,
                    "Key": registration_key(change.registration_id),
                    "ConditionExpression": "#s = :never",
                    "ExpressionAttributeNames": {"#s": "status"},
                    "ExpressionAttributeValues": {":never": _s(RemoteRegistrationStatus.PENDING)},
                }
            },
            {
                "Delete": {
                    "TableName": self._table,
                    "Key": organization_key(change.profile_id, change.organization),
                    "ConditionExpression": "registration_id = :reg",
                    "ExpressionAttributeValues": {":reg": _s(change.registration_id)},
                }
            },
            {
                "Update": {
                    "TableName": self._table,
                    "Key": INDEX_KEY,
                    "UpdateExpression": "DELETE ids :id",
                    "ExpressionAttributeValues": {":id": {"SS": [change.registration_id]}},
                }
            },
        ]

    def approve(
        self,
        change: RemoteChange,
        *,
        allowed: set[RemoteRegistrationStatus],
        approval_id: str,
        approver: str,
        approver_email: str | None,
        now: datetime,
    ) -> None:
        """Close the request and record it as the approved state of the registration, in one
        transaction. The conditions close the race window of what the API already checked."""
        condition, values = _status_condition(allowed, change.base_version, "r")
        sets: dict[str, dict[str, Any]] = {
            "#s": _s(RemoteRegistrationStatus.APPROVED),
            "version": _n(change.base_version + 1),
            "profile_version": _s(change.profile_version),
            "profile_sha256": _s(change.profile_sha256),
            "toolsets": _l(change.toolsets),
            "groups": _l(change.groups),
            "approval_id": _s(approval_id),
            "change_id": _s(change.change_id),
            "change_kind": _s(change.kind),
            "approved_by": _s(approver),
            "approved_at": _s(iso(now)),
            "updated_at": _s(iso(now)),
        }
        if approver_email:
            sets["approved_by_email"] = _s(approver_email)
        if change.creates_provider:
            sets |= {
                "generation": _n(change.pending_generation or 0),
                "provider_name": _s(change.pending_provider_name or ""),
                "provider_arn": _s(change.pending_provider_arn or ""),
                "callback_url": _s(change.callback_url or ""),
                "tenant_id": _s(change.tenant_id or ""),
                "client_id": _s(change.client_id or ""),
                "secret_expires_on": _s(change.secret_expires_on or ""),
                "requested_by": _s(change.requested_by),
                "requested_at": _s(iso(change.created_at)),
            }
            if change.requested_by_email:
                sets["requested_by_email"] = _s(change.requested_by_email)
        assignments = ", ".join(f"{name} = :set{i}" for i, name in enumerate(sets))
        values |= {f":set{i}": value for i, value in enumerate(sets.values())}
        registration = {
            "Update": {
                "TableName": self._table,
                "Key": registration_key(change.registration_id),
                "UpdateExpression": (
                    f"SET {assignments} REMOVE failure_code, disabled_by, disabled_by_email, "
                    "disabled_at, disabled_reason"
                ),
                "ConditionExpression": condition,
                "ExpressionAttributeNames": {"#s": "status"},
                "ExpressionAttributeValues": values,
            }
        }
        self._transact(
            [
                *self._close(
                    change,
                    RemoteChangeStatus.APPROVED,
                    by=approver,
                    by_email=approver_email,
                    now=now,
                    condition="#s = :pending AND requested_by <> :by AND expires_at > :at",
                ),
                registration,
            ]
        )

    def reject(
        self,
        change: RemoteChange,
        *,
        by: str,
        by_email: str | None,
        reason: str | None,
        forget: bool,
        now: datetime,
    ) -> None:
        items = self._close(
            change,
            RemoteChangeStatus.REJECTED,
            by=by,
            by_email=by_email,
            now=now,
            reason=reason,
            condition="#s = :pending AND requested_by <> :by",
        )
        self._transact(items + (self._forget(change) if forget else []))

    def withdraw(self, change: RemoteChange, *, by: str, forget: bool, now: datetime) -> None:
        """Close a pending request on behalf of who made it (checked again in the condition)."""
        items = self._close(
            change,
            RemoteChangeStatus.WITHDRAWN,
            by=by,
            by_email=None,
            now=now,
            condition="#s = :pending AND requested_by = :by",
        )
        self._transact(items + (self._forget(change) if forget else []))

    # --- Registration ---------------------------------------------------------------------

    def _update(
        self,
        registration: Registration,
        allowed: set[RemoteRegistrationStatus],
        sets: dict[str, dict[str, Any]],
        remove: str = "",
    ) -> dict[str, Any]:
        condition, values = _status_condition(allowed, registration.version)
        sets = {**sets, "version": _n(registration.version + 1)}
        assignments = ", ".join(f"{name} = :set{i}" for i, name in enumerate(sets))
        values |= {f":set{i}": value for i, value in enumerate(sets.values())}
        return {
            "TableName": self._table,
            "Key": registration_key(registration.registration_id),
            "UpdateExpression": f"SET {assignments}" + (f" REMOVE {remove}" if remove else ""),
            "ConditionExpression": condition,
            "ExpressionAttributeNames": {"#s": "status"},
            "ExpressionAttributeValues": values,
        }

    def retry(self, registration: Registration, now: datetime) -> None:
        """A failed registration goes back to ``approved``; nothing approved changes."""
        update = self._update(
            registration,
            {RemoteRegistrationStatus.FAILED},
            {"#s": _s(RemoteRegistrationStatus.APPROVED), "updated_at": _s(iso(now))},
            "failure_code",
        )
        self._transact([{"Update": update}])

    def disable(
        self,
        registration: Registration,
        *,
        approval_id: str,
        by: str,
        by_email: str | None,
        reason: str,
        pending: RemoteChange | None,
        now: datetime,
    ) -> None:
        """Mark the registration ``disabling``; a request that waited on it is cancelled."""
        sets = {
            "#s": _s(RemoteRegistrationStatus.DISABLING),
            "approval_id": _s(approval_id),
            "disabled_by": _s(by),
            "disabled_at": _s(iso(now)),
            "disabled_reason": _s(reason),
            "updated_at": _s(iso(now)),
        }
        if by_email:
            sets["disabled_by_email"] = _s(by_email)
        update = self._update(
            registration,
            {RemoteRegistrationStatus.ACTIVE, RemoteRegistrationStatus.FAILED},
            sets,
            "failure_code" if by_email else "failure_code, disabled_by_email",
        )
        items: list[dict[str, Any]] = [{"Update": update}]
        if pending is not None:
            items += self._close(
                pending, RemoteChangeStatus.CANCELLED, by=by, by_email=by_email, now=now
            )
        self._transact(items)

    def secret_rotated(self, registration: Registration, expires_on: str, now: datetime) -> None:
        update = self._update(
            registration,
            {RemoteRegistrationStatus.ACTIVE, RemoteRegistrationStatus.FAILED},
            {
                "secret_expires_on": _s(expires_on),
                "secret_rotated_at": _s(iso(now)),
                "updated_at": _s(iso(now)),
            },
        )
        self._transact([{"Update": update}])


# --- The approved catalog (D98 (13)) ------------------------------------------------------


class ApprovedRemotes:
    """What the remote provisioner signed for each registration, verified before it is used.

    The public key is read once (``kms:GetPublicKey`` on ``alias/Mango-<ns>-remote-mcp``).
    Anything that does not verify counts as not approved: callers show no tools for it.
    """

    def __init__(
        self,
        dynamodb: Any,
        table: str,
        kms: Any,
        *,
        key_id: str,
        gateway_id: str,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._db = dynamodb
        self._table = table
        self._kms = kms
        self._key_id = key_id
        self._gateway_id = gateway_id
        self._clock = clock
        self._lock = threading.Lock()
        self._key: ec.EllipticCurvePublicKey | None = None
        self._cache: dict[str, tuple[float, ApprovedRemote | None]] = {}

    def _public_key(self) -> ec.EllipticCurvePublicKey:
        with self._lock:
            if self._key is not None:
                return self._key
        response = self._kms.get_public_key(KeyId=self._key_id)
        key = load_public_key(response["PublicKey"])
        with self._lock:
            self._key = key
        return key

    def get(self, registration_id: str) -> ApprovedRemote | None:
        now = self._clock()
        with self._lock:
            cached = self._cache.get(registration_id)
            if cached is not None and now - cached[0] < APPROVED_CACHE_SECONDS:
                return cached[1]
        approved = self._read(registration_id)
        with self._lock:
            self._cache[registration_id] = (now, approved)
        return approved

    def _read(self, registration_id: str) -> ApprovedRemote | None:
        if not self._key_id or not self._gateway_id:
            return None
        try:
            item = self._db.get_item(
                TableName=self._table, Key=approved_key(registration_id), ConsistentRead=True
            ).get("Item")
            if item is None:
                return None
            fields = {name: value.get("S") for name, value in item.items()}
            return ApprovedRemote.verify(
                self._public_key(),
                fields,
                target=target_name(registration_id),
                gateway_id=self._gateway_id,
            )
        except RemoteNotApprovedError:
            # Not an exception trace: the signature check says nothing more than this.
            logger.error(  # noqa: TRY400
                "approved remote catalog does not verify", extra={"remote": registration_id}
            )
            return None
        except (ClientError, BotoCoreError, KeyError, ValueError):
            logger.warning("approved remote catalog unreadable", extra={"remote": registration_id})
            return None


def gateway_id_of(gateway_url: str) -> str:
    """``<gateway id>.gateway.bedrock-agentcore.<region>.amazonaws.com`` → the id."""
    host = urlsplit(gateway_url).hostname or ""
    return host.split(".", 1)[0]


# --- Identity providers (D93 (6), (7)) ----------------------------------------------------

VENDOR = "MicrosoftOauth2"
_ARN_RE = re.compile(r"^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:[\x21-\x7e]{1,300}$")
_CALLBACK_RE = re.compile(r"^https://[\x21-\x7e]{1,2000}$")
_NOT_FOUND = frozenset({"ResourceNotFoundException"})


class IdentityError(Exception):
    """AgentCore Identity refused or failed; the message never holds the secret."""


@dataclass(frozen=True)
class CreatedProvider:
    name: str
    arn: str
    callback_url: str
    """The redirect URI the administrator registers in Entra (D93 (6))."""


@dataclass
class IdentityProviders:
    """The OAuth2 providers of remote registrations: ``Mango-<ns>-remote-<reg>-g<n>``."""

    client: Any
    stack_tags: StackTags
    namespace: str

    @staticmethod
    def _config(tenant_id: str, client_id: str, client_secret: str) -> dict[str, Any]:
        return {
            "microsoftOauth2ProviderConfig": {
                "clientId": client_id,
                "clientSecret": client_secret,
                "tenantId": tenant_id,
            }
        }

    def create(
        self,
        name: str,
        *,
        registration_id: str,
        tenant_id: str,
        client_id: str,
        client_secret: str,
    ) -> CreatedProvider:
        own = {
            "mango:namespace": self.namespace,
            "mango:component": "remote-mcp",
            "mango:remote": registration_id,
        }
        tags = merge_tags(own, self.stack_tags.get())
        try:
            response = self.client.create_oauth2_credential_provider(
                name=name,
                credentialProviderVendor=VENDOR,
                oauth2ProviderConfigInput=self._config(tenant_id, client_id, client_secret),
                tags=tags,
            )
        except (ClientError, BotoCoreError) as exc:
            raise IdentityError(_code(exc)) from None
        arn, callback = response.get("credentialProviderArn"), response.get("callbackUrl")
        if not (isinstance(arn, str) and _ARN_RE.fullmatch(arn)) or not (
            isinstance(callback, str) and _CALLBACK_RE.fullmatch(callback)
        ):
            # Created, but not in a shape to record: remove it rather than leave it behind.
            self.delete(name)
            raise IdentityError("unexpected_response")
        return CreatedProvider(name=name, arn=arn, callback_url=callback)

    def update_secret(
        self, name: str, *, tenant_id: str, client_id: str, client_secret: str
    ) -> None:
        try:
            self.client.update_oauth2_credential_provider(
                name=name,
                credentialProviderVendor=VENDOR,
                oauth2ProviderConfigInput=self._config(tenant_id, client_id, client_secret),
            )
        except (ClientError, BotoCoreError) as exc:
            raise IdentityError(_code(exc)) from None

    def delete(self, name: str) -> None:
        """Delete a provider (and the secret Identity keeps for it); a missing one is fine."""
        try:
            self.client.delete_oauth2_credential_provider(name=name)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in _NOT_FOUND:
                return
            raise IdentityError(_code(exc)) from None
        except BotoCoreError as exc:
            raise IdentityError(_code(exc)) from None


def _code(exc: Exception) -> str:
    """The error code of an AWS call, never its message (it could echo the request)."""
    if isinstance(exc, ClientError):
        return str(exc.response.get("Error", {}).get("Code", "error"))
    return type(exc).__name__


# --- Tags of the installation's stack (D76) -----------------------------------------------
# The same rules as ``mango_provisioner.stack_tags``: keep the two in step.

RESERVED_TAG_PREFIXES = ("aws:", "mango:")
MAX_TAGS = 50
TAGS_REFRESH_SECONDS = 300
_TAG_KEY_RE = re.compile(r"^[A-Za-z0-9 ._:/=+@-]{1,128}$")
_TAG_VALUE_RE = re.compile(r"^[A-Za-z0-9 ._:/=+@-]{0,256}$")


class StackTagError(Exception):
    """A tag of the stack cannot go on an AgentCore resource, or the stack cannot be read."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def custom_tags(stack_tags: Iterable[Mapping[str, Any]]) -> Mapping[str, str]:
    """The stack's tags that are copied: every one outside the reserved prefixes, any case."""
    tags: dict[str, str] = {}
    seen: set[str] = set()
    for tag in stack_tags:
        key, value = str(tag.get("Key", "")), str(tag.get("Value", ""))
        if key.lower().startswith(RESERVED_TAG_PREFIXES):
            continue
        if (
            not _TAG_KEY_RE.fullmatch(key)
            or not _TAG_VALUE_RE.fullmatch(value)
            or key.lower() in seen
        ):
            raise StackTagError("stack_tag_invalid")
        seen.add(key.lower())
        tags[key] = value
    return MappingProxyType(tags)


def merge_tags(own: Mapping[str, str], custom: Mapping[str, str]) -> dict[str, str]:
    """Mango's tags of a resource plus the stack's; Mango's keys can never be overridden."""
    if len(own) + len(custom) > MAX_TAGS:
        raise StackTagError("stack_tags_too_many")
    return {**custom, **own}


@dataclass
class StackTags:
    """Reads the tags of the installation's stack, at most once every few minutes."""

    cloudformation: Any
    stack_id: str
    clock: Callable[[], float] = time.monotonic
    _tags: Mapping[str, str] | None = field(default=None, init=False)
    _read_at: float = field(default=0.0, init=False)

    def get(self) -> Mapping[str, str]:
        if self._tags is not None and self.clock() - self._read_at < TAGS_REFRESH_SECONDS:
            return self._tags
        if not self.stack_id:
            raise StackTagError("stack_unavailable")
        try:
            stacks = self.cloudformation.describe_stacks(StackName=self.stack_id)["Stacks"]
        except (ClientError, BotoCoreError) as exc:
            raise StackTagError("stack_unavailable") from exc
        if len(stacks) != 1:
            raise StackTagError("stack_unavailable")
        self._tags = custom_tags(stacks[0].get("Tags") or [])
        self._read_at = self.clock()
        return self._tags
