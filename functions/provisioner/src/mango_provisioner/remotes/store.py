"""What the remote provisioner reads and writes in the Settings table (D98 (12)).

It reads the registration and the approved request mango-api wrote, and writes only:

* the lifecycle of ``REMOTE#<reg>`` / ``REGISTRATION``: ``creating`` -> ``active`` | ``failed``,
  ``disabling`` -> ``disabled`` | ``failed``, its own lock and the failure code (D98 (12):
  lifecycle only). Every write raises ``version``, mango-api's
  optimistic lock, so a decision taken on what it read before cannot overwrite a transition;
* the approved catalog ``MCP_REMOTE#<reg>`` / ``APPROVED``, which only this role can write.

After an install whose release ships another profile, it also reads the index of
registrations (``REMOTE_INDEX`` / ``REGISTRATIONS``) and takes the lock of an ``active`` one
without changing its status, to sign its catalog again (D101).

Every write is conditioned on the ``approval_id`` the execution was started for: once
mango-api records a new approval or a disable, a stale execution changes nothing. Its IAM
policy limits it to those partitions and attributes (``REMOTE_PROVISIONER_WRITABLE_ATTRIBUTES``
in ``infra/lib/constructs/remote-provisioner.ts``).
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_core import remote_mcp
from mango_provisioner.errors import BusyError, StepError, aws_error, error_code

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

LOCK_TTL = timedelta(minutes=45)
"""Longer than the state machine timeout, so a live execution never loses its lock."""
APPROVAL_ID_PATTERN = r"^[0-9a-f]{32}$"
_APPROVAL_ID_RE = re.compile(APPROVAL_ID_PATTERN)
_CHANGE_ID_RE = re.compile(r"^[0-9A-Za-z]{1,40}$")
_PROFILE_RE = re.compile(remote_mcp.PROFILE_ID_PATTERN)
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_TOOLSET_RE = re.compile(r"^[a-z][a-z0-9-]{0,23}$")
_CONDITION_FAILED = "ConditionalCheckFailedException"
_MAX_ACTOR_CHARS = 256
_MAX_GENERATION = 999_999
INDEX_KEY: dict[str, Any] = {"PK": {"S": "REMOTE_INDEX"}, "SK": {"S": "REGISTRATIONS"}}
"""Ids of every registration, written by mango-api (``mango_api.remote_mcp_store``)."""


class Status(StrEnum):
    """``REGISTRATION.status`` (D98 (12)). mango-api writes the first three and ``disabling``."""

    PENDING = "pending"
    APPROVED = "approved"
    CREATING = "creating"
    ACTIVE = "active"
    FAILED = "failed"
    DISABLING = "disabling"
    DISABLED = "disabled"


class ChangeKind(StrEnum):
    ENABLE = "enable"
    REPLACE_APP = "replace_app"
    PARAMS = "params"


@dataclass(frozen=True)
class Registration:
    registration_id: str
    status: Status
    approval_id: str
    profile_id: str
    organization: str
    generation: int | None
    """As mango-api recorded it. What is live is the signed catalog's (``live``)."""
    toolsets: tuple[str, ...]
    change_id: str | None
    change_kind: ChangeKind | None
    requested_by: str | None
    approved_by: str | None
    lock_owner: str | None


@dataclass(frozen=True)
class ApprovedChange:
    """The approved request a registration is being built from."""

    change_id: str
    kind: ChangeKind
    profile_sha256: str
    toolsets: tuple[str, ...]
    pending_generation: int | None
    """Generation of ``pending_provider_name`` (``enable`` and ``replace_app``)."""


def _s(item: dict[str, Any], name: str) -> str:
    value = item[name]["S"]
    if not isinstance(value, str):
        raise TypeError(name)
    return value


def _opt_s(item: dict[str, Any], name: str) -> str | None:
    value = item.get(name, {}).get("S")
    return value if isinstance(value, str) else None


def _actor(item: dict[str, Any], name: str) -> str | None:
    """Who asked or approved, as mango-api recorded it. It only goes to the audit event."""
    value = _opt_s(item, name)
    if value is not None and not 0 < len(value) <= _MAX_ACTOR_CHARS:
        raise ValueError("actor")
    return value


def _toolsets(item: dict[str, Any]) -> tuple[str, ...]:
    raw = item.get("toolsets", {}).get("L", [])
    values = tuple(sorted({entry["S"] for entry in raw}))
    if len(values) != len(raw) or not all(_TOOLSET_RE.fullmatch(v) for v in values):
        raise ValueError("toolsets")
    return values


@dataclass(frozen=True)
class LiveCatalog:
    """What the catalog this role signed last vouches for (its own partition, D98 (13))."""

    generation: int
    revision: int
    profile_id: str
    profile_sha256: str
    organization: str
    toolsets: tuple[str, ...]
    tools: frozenset[str]
    probe_tool: str


def _generation(raw: object) -> int:
    value = int(str(raw))
    if not 1 <= value <= _MAX_GENERATION:
        raise ValueError("generation")
    return value


def _organization(value: str) -> str:
    if not remote_mcp.is_organization(value):
        raise ValueError("organization")
    return value


def _checked(pattern: re.Pattern[str], value: str) -> str:
    if not pattern.fullmatch(value):
        raise ValueError("unexpected format")
    return value


def generation_of_provider(namespace: str, registration_id: str, name: str) -> int:
    """The ``n`` of ``Mango-<ns>-remote-<reg>-g<n>``; anything else is refused."""
    prefix = f"{remote_mcp.provider_prefix(namespace)}{registration_id}-g"
    if not name.startswith(prefix):
        raise ValueError("provider of another registration")
    generation = _generation(name[len(prefix) :])
    if remote_mcp.provider_name(namespace, registration_id, generation) != name:
        raise ValueError("provider name not canonical")
    return generation


def _now_text(now: datetime) -> str:
    return now.astimezone(UTC).isoformat(timespec="seconds")


class RemoteStore:
    def __init__(self, dynamodb: DynamoDBClient, settings_table: str, namespace: str) -> None:
        self._db = dynamodb
        self._table = settings_table
        self._ns = namespace

    def _get(self, key: dict[str, Any]) -> dict[str, Any] | None:
        try:
            item = self._db.get_item(TableName=self._table, Key=key, ConsistentRead=True).get(
                "Item"
            )
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("GetItem", exc) from None
        return dict(item) if item else None

    def registration(self, registration_id: str) -> Registration | None:
        item = self._get(remote_mcp.registration_key(registration_id))
        if item is None:
            return None
        try:
            kind = _opt_s(item, "change_kind")
            generation = item.get("generation", {}).get("N")
            organization = _organization(_s(item, "organization"))
            change_id = _opt_s(item, "change_id")
            return Registration(
                registration_id=registration_id,
                status=Status(_s(item, "status")),
                approval_id=_checked(_APPROVAL_ID_RE, _s(item, "approval_id")),
                profile_id=_checked(_PROFILE_RE, _s(item, "profile_id")),
                organization=organization,
                generation=None if generation is None else _generation(generation),
                toolsets=_toolsets(item),
                change_id=None if change_id is None else _checked(_CHANGE_ID_RE, change_id),
                change_kind=None if kind is None else ChangeKind(kind),
                requested_by=_actor(item, "requested_by"),
                approved_by=_actor(item, "approved_by"),
                lock_owner=_opt_s(item, "provision_lock"),
            )
        except (KeyError, ValueError, TypeError):
            raise StepError("registration_record_invalid") from None

    def registration_ids(self) -> list[str]:
        """Every registration mango-api indexed; an id of another shape is left out."""
        item = self._get(INDEX_KEY)
        raw = (item or {}).get("ids", {}).get("SS", [])
        return sorted(r for r in raw if remote_mcp.is_registration_id(r))

    def change(self, registration_id: str, change_id: str) -> ApprovedChange:
        """The approved request ``change_id``, or a ``StepError``."""
        item = self._get(remote_mcp.change_key(registration_id, change_id))
        if item is None:
            raise StepError("change_not_found")
        try:
            if _s(item, "status") != "approved":
                raise StepError("change_not_approved")
            kind = ChangeKind(_s(item, "kind"))
            pending = _opt_s(item, "pending_provider_name")
            return ApprovedChange(
                change_id=change_id,
                kind=kind,
                profile_sha256=_checked(_SHA256_RE, _s(item, "profile_sha256")),
                toolsets=_toolsets(item),
                pending_generation=(
                    None
                    if pending is None
                    else generation_of_provider(self._ns, registration_id, pending)
                ),
            )
        except (KeyError, ValueError, TypeError):
            raise StepError("change_record_invalid") from None

    # --- Lock and transitions -------------------------------------------------------------

    def _update(self, **request: Any) -> bool:
        try:
            self._db.update_item(TableName=self._table, **request)
        except ClientError as exc:
            if error_code(exc) == _CONDITION_FAILED:
                return False
            raise aws_error("UpdateItem", exc) from None
        except BotoCoreError as exc:
            raise aws_error("UpdateItem", exc) from None
        return True

    def begin(
        self, registration_id: str, approval_id: str, owner: str, now: datetime, *, disable: bool
    ) -> None:
        """Take the registration for ``owner`` (``approved`` -> ``creating`` when enabling)."""
        status = Status.DISABLING if disable else Status.CREATING
        allowed = [Status.DISABLING] if disable else [Status.APPROVED, Status.CREATING]
        ok = self._update(
            Key=remote_mcp.registration_key(registration_id),
            UpdateExpression=(
                "SET #status = :status, provision_lock = :owner, provision_lock_until = :until, "
                "updated_at = :at ADD #version :one"
            ),
            ConditionExpression=(
                "approval_id = :approval AND #status IN ("
                + ", ".join(f":a{i}" for i in range(len(allowed)))
                + ") AND (attribute_not_exists(provision_lock) OR provision_lock = :owner "
                "OR provision_lock_until < :now)"
            ),
            ExpressionAttributeNames={"#status": "status", "#version": "version"},
            ExpressionAttributeValues={
                ":status": {"S": status.value},
                ":owner": {"S": owner},
                ":until": {"N": str(int((now + LOCK_TTL).timestamp()))},
                ":now": {"N": str(int(now.timestamp()))},
                ":at": {"S": _now_text(now)},
                ":one": {"N": "1"},
                ":approval": {"S": approval_id},
                **{f":a{i}": {"S": s.value} for i, s in enumerate(allowed)},
            },
        )
        if not ok:
            raise BusyError

    def _finish(
        self,
        registration_id: str,
        *,
        approval_id: str,
        owner: str,
        now: datetime,
        sets: dict[str, dict[str, Any]],
        removes: tuple[str, ...] = (),
    ) -> bool:
        """A transition under this execution's lock. The lock stays until ``release_lock``:
        a retry whose audit event did not get through still owns the registration."""
        assignments = ", ".join(f"#{name} = :{name}" for name in sets)
        removed = f" REMOVE {', '.join(removes)}" if removes else ""
        return self._update(
            Key=remote_mcp.registration_key(registration_id),
            UpdateExpression=f"SET {assignments}, updated_at = :at{removed} ADD #version :one",
            ConditionExpression="approval_id = :approval AND provision_lock = :owner",
            ExpressionAttributeNames={
                **{f"#{name}": name for name in sets},
                "#version": "version",
            },
            ExpressionAttributeValues={
                **{f":{name}": value for name, value in sets.items()},
                ":at": {"S": _now_text(now)},
                ":one": {"N": "1"},
                ":approval": {"S": approval_id},
                ":owner": {"S": owner},
            },
        )

    def active(self, registration_id: str, approval_id: str, owner: str, now: datetime) -> None:
        ok = self._finish(
            registration_id,
            approval_id=approval_id,
            owner=owner,
            now=now,
            sets={"status": {"S": Status.ACTIVE.value}},
            removes=("failure_code", "failed_step"),
        )
        if not ok:
            raise StepError("state_conflict")

    def disabled(self, registration_id: str, approval_id: str, owner: str, now: datetime) -> None:
        ok = self._finish(
            registration_id,
            approval_id=approval_id,
            owner=owner,
            now=now,
            sets={"status": {"S": Status.DISABLED.value}},
            removes=("failure_code", "failed_step"),
        )
        if not ok:
            raise StepError("state_conflict")

    def failed(
        self,
        registration_id: str,
        approval_id: str,
        owner: str,
        now: datetime,
        *,
        failed_step: str,
        failure: str,
    ) -> bool:
        """Record the failure. False if the execution no longer owns the registration."""
        return self._finish(
            registration_id,
            approval_id=approval_id,
            owner=owner,
            now=now,
            sets={
                "status": {"S": Status.FAILED.value},
                "failure_code": {"S": failure},
                "failed_step": {"S": failed_step},
            },
        )

    def lock_active(
        self, registration_id: str, approval_id: str, owner: str, now: datetime
    ) -> None:
        """Take an ``active`` registration for ``owner`` without changing its status: what a
        release converges is what was approved (D101)."""
        ok = self._update(
            Key=remote_mcp.registration_key(registration_id),
            UpdateExpression=(
                "SET provision_lock = :owner, provision_lock_until = :until, updated_at = :at "
                "ADD #version :one"
            ),
            ConditionExpression=(
                "approval_id = :approval AND #status = :active AND (attribute_not_exists("
                "provision_lock) OR provision_lock = :owner OR provision_lock_until < :now)"
            ),
            ExpressionAttributeNames={"#status": "status", "#version": "version"},
            ExpressionAttributeValues={
                ":owner": {"S": owner},
                ":until": {"N": str(int((now + LOCK_TTL).timestamp()))},
                ":now": {"N": str(int(now.timestamp()))},
                ":at": {"S": _now_text(now)},
                ":one": {"N": "1"},
                ":approval": {"S": approval_id},
                ":active": {"S": Status.ACTIVE.value},
            },
        )
        if not ok:
            raise BusyError

    def release_lock(self, registration_id: str, owner: str) -> None:
        self._update(
            Key=remote_mcp.registration_key(registration_id),
            UpdateExpression="REMOVE provision_lock, provision_lock_until",
            ConditionExpression="provision_lock = :owner",
            ExpressionAttributeValues={":owner": {"S": owner}},
        )

    # --- The approved catalog (D98 (13)) --------------------------------------------------

    def put_approved(self, registration_id: str, fields: dict[str, Any]) -> None:
        try:
            self._db.put_item(
                TableName=self._table,
                Item={**remote_mcp.approved_key(registration_id), **fields},
            )
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("PutItem", exc) from None

    def delete_approved(self, registration_id: str) -> None:
        try:
            self._db.delete_item(
                TableName=self._table, Key=remote_mcp.approved_key(registration_id)
            )
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("DeleteItem", exc) from None

    def live_catalog(self, registration_id: str) -> LiveCatalog | None:
        """The claims of the catalog this role signed last, of any payload version."""
        item = self._get(remote_mcp.approved_key(registration_id))
        try:
            text = item["payload"]["S"] if item else None
            if not isinstance(text, str):
                return None
            claims = json.loads(base64.urlsafe_b64decode(text + "=" * (-len(text) % 4)))
            tools, toolsets = claims["tools"], claims["toolsets"]
            if not all(isinstance(t, str) for t in [*tools, *toolsets]):
                return None
            return LiveCatalog(
                generation=_generation(claims["generation"]),
                revision=_generation(claims["revision"]),
                profile_id=_checked(_PROFILE_RE, claims["profile_id"]),
                profile_sha256=_checked(_SHA256_RE, claims["profile_sha256"]),
                organization=_organization(claims["organization"]),
                toolsets=tuple(toolsets),
                tools=frozenset(tools),
                probe_tool=str(claims["probe_tool"]),
            )
        except (KeyError, ValueError, TypeError, binascii.Error):
            return None

    def live(self, registration_id: str) -> tuple[int, int] | None:
        """``(generation, revision)`` of the catalog this role signed last, if any.

        Only this role writes the partition (IAM), so it says what is live: the provider
        generation the target serves with, and the number of the next signing.
        """
        item = self._get(remote_mcp.approved_key(registration_id))
        try:
            text = item["payload"]["S"] if item else None
            if not isinstance(text, str):
                return None
            claims = json.loads(base64.urlsafe_b64decode(text + "=" * (-len(text) % 4)))
            return _generation(claims["generation"]), _generation(claims["revision"])
        except (KeyError, ValueError, TypeError, binascii.Error):
            return None
