"""Pack enablements and their requests in the Settings table (spec §4.4, §8, D19).

Item layout (``PK`` / ``SK``), shared with the pack provisioner through
``mango_packs.enablement``:

* ``MCP#<pack>`` / ``ENABLEMENT``: what was approved last and how its installation goes.
  mango-api writes the approved request (``approved``), a retry and ``disabling``; the
  provisioner writes the rest of the life cycle. ``version`` is mango-api's optimistic lock.
* ``MCP_INSTALLED#<pack>`` / ``CURRENT``: what is installed. Read only here: the provisioner
  is its only writer (IAM denies mango-api), so this is what "enabled" means for agents.
* ``MCP_CHANGE#<pack>`` / ``CHANGE#<id>``: one request (enable, parameters or update) and its
  decision; kept ``CHANGE_RETENTION`` for the history shown to administrators.
* ``MCP_CHANGE#<pack>`` / ``PENDING``: marker of the request that waits for another
  administrator. One per pack: it is created with the request and deleted with the decision,
  in the same transaction.
"""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from botocore.exceptions import ClientError

from mango_packs.enablement import (
    PackStatus,
    approve_item,
    change_partition,
    disable_item,
    enablement_key,
    installed_key,
    iso,
    retry_item,
)
from mango_packs.manifest import DataTier, IdentityMode

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

CHANGE_LIFETIME = timedelta(days=7)
CHANGE_RETENTION = timedelta(days=90)  # table TTL; the audit trail keeps the evidence
SK_PENDING = "PENDING"
SK_CHANGE_PREFIX = "CHANGE#"
MAX_CHANGES_READ = 50
_CONFLICT_REASONS = frozenset({"None", "ConditionalCheckFailed", "TransactionConflict"})


class PackConflictError(Exception):
    """The pack or the request changed since the caller read it (optimistic locking)."""


class PackRecordError(Exception):
    """A stored item is not in the expected layout; callers fail closed."""


class ChangeKind(StrEnum):
    ENABLE = "enable"
    PARAMS = "params"
    UPDATE = "update"


class ChangeStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    WITHDRAWN = "withdrawn"
    CANCELLED = "cancelled"
    """Closed because the pack was disabled while the request waited."""


@dataclass(frozen=True)
class Enablement:
    pack_id: str
    status: PackStatus
    enablement_id: str
    pack_version: str
    config: dict[str, str]
    version: int
    requested_by: str | None = None
    requested_by_email: str | None = None
    requested_at: str | None = None
    approved_by: str | None = None
    approved_by_email: str | None = None
    approved_at: str | None = None
    status_at: str | None = None
    failed_step: str | None = None
    failure: str | None = None
    disabled_by: str | None = None
    disabled_by_email: str | None = None
    disabled_at: str | None = None
    disable_reason: str | None = None
    locked_until: int | None = None
    """Epoch seconds until which a provisioner execution holds the pack."""

    def locked(self, now: datetime) -> bool:
        return self.locked_until is not None and self.locked_until >= int(now.timestamp())


@dataclass(frozen=True)
class Installed:
    """What the provisioner installed last (its pointer)."""

    pack_version: str
    enablement_id: str
    statement_sha256: str
    tools: tuple[str, ...]
    actions: tuple[str, ...]
    config: dict[str, str]
    installed_at: str | None
    data_tier: str = "public"
    identity_mode: str = "service"
    """What the installed version serves and how identity reaches it. The provisioner records
    both; a pointer older than packs over account data is a public ``service`` pack."""


@dataclass(frozen=True)
class PackChange:
    change_id: str
    pack_id: str
    kind: ChangeKind
    status: ChangeStatus
    pack_version: str
    statement_sha256: str
    """Signed statement of the release the request was made for."""
    config: dict[str, str]
    reason: str | None
    base_version: int
    """``version`` of the enablement when the request was made."""
    requested_by: str
    requested_by_email: str | None
    created_at: datetime
    expires_at: datetime
    decided_by: str | None = None
    decided_by_email: str | None = None
    decided_at: str | None = None
    decision_reason: str | None = None


def new_change_id() -> str:
    """Random public id (never incremental)."""
    return secrets.token_hex(16)


def new_enablement_id() -> str:
    """Random id of one approved request; the provisioner's execution input carries it."""
    return secrets.token_hex(16)


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: int) -> dict[str, str]:
    return {"N": str(value)}


def _opt(item: dict[str, Any], name: str) -> str | None:
    value: str | None = item.get(name, {}).get("S")
    return value


def _config(raw: str | None) -> dict[str, str]:
    data = json.loads(raw) if raw else {}
    if not isinstance(data, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in data.items()
    ):
        raise ValueError("config")
    return dict(data)


def _strings(raw: str) -> tuple[str, ...]:
    data = json.loads(raw)
    if not isinstance(data, list) or not all(isinstance(entry, str) for entry in data):
        raise ValueError("not a list of strings")
    return tuple(data)


def _actions(raw: str) -> tuple[str, ...]:
    """IAM actions of the installed manifest (``grants`` of the provisioner's pointer)."""
    data = json.loads(raw)
    if not isinstance(data, list):
        raise TypeError("grants")
    actions: set[str] = set()
    for grant in data:
        actions.update(_strings(json.dumps(grant["actions"])))
    return tuple(sorted(actions))


def _conflict(exc: ClientError) -> None:
    """Condition failures and concurrent writers are conflicts; anything else raises."""
    code = exc.response.get("Error", {}).get("Code")
    if code == "ConditionalCheckFailedException":
        raise PackConflictError("pack changed") from exc
    if code == "TransactionCanceledException":
        reasons = {str(r.get("Code")) for r in exc.response.get("CancellationReasons", [])}
        if reasons <= _CONFLICT_REASONS:
            raise PackConflictError("pack changed") from exc
    raise exc


def _change_from(pack_id: str, item: dict[str, Any]) -> PackChange:
    try:
        return PackChange(
            change_id=item["SK"]["S"].removeprefix(SK_CHANGE_PREFIX),
            pack_id=pack_id,
            kind=ChangeKind(item["kind"]["S"]),
            status=ChangeStatus(item["status"]["S"]),
            pack_version=item["pack_version"]["S"],
            statement_sha256=item["statement_sha256"]["S"],
            config=_config(_opt(item, "config")),
            reason=_opt(item, "reason"),
            base_version=int(item["base_version"]["N"]),
            requested_by=item["requested_by"]["S"],
            requested_by_email=_opt(item, "requested_by_email"),
            created_at=datetime.fromisoformat(item["created_at"]["S"]),
            expires_at=datetime.fromisoformat(item["expires_at"]["S"]),
            decided_by=_opt(item, "decided_by"),
            decided_by_email=_opt(item, "decided_by_email"),
            decided_at=_opt(item, "decided_at"),
            decision_reason=_opt(item, "decision_reason"),
        )
    except (KeyError, ValueError, TypeError) as exc:
        raise PackRecordError("change request unreadable") from exc


class PackStore:
    def __init__(self, dynamodb: DynamoDBClient, table: str) -> None:
        self._db = dynamodb
        self._table = table

    def _get(self, key: dict[str, Any]) -> dict[str, Any] | None:
        item: dict[str, Any] | None = self._db.get_item(
            TableName=self._table, Key=key, ConsistentRead=True
        ).get("Item")
        return item

    def _change_key(self, pack_id: str, change_id: str) -> dict[str, Any]:
        return {"PK": _s(change_partition(pack_id)), "SK": _s(SK_CHANGE_PREFIX + change_id)}

    def _pending_key(self, pack_id: str) -> dict[str, Any]:
        return {"PK": _s(change_partition(pack_id)), "SK": _s(SK_PENDING)}

    # --- Reads ----------------------------------------------------------------------------

    def enablement(self, pack_id: str) -> Enablement | None:
        item = self._get(enablement_key(pack_id))
        if item is None:
            return None
        try:
            until = item.get("provision_lock_until", {}).get("N")
            return Enablement(
                pack_id=pack_id,
                status=PackStatus(item["status"]["S"]),
                enablement_id=item["enablement_id"]["S"],
                pack_version=item["pack_version"]["S"],
                config=_config(_opt(item, "config")),
                version=int(item.get("version", {}).get("N", "0")),
                requested_by=_opt(item, "requested_by"),
                requested_by_email=_opt(item, "requested_by_email"),
                requested_at=_opt(item, "requested_at"),
                approved_by=_opt(item, "approved_by"),
                approved_by_email=_opt(item, "approved_by_email"),
                approved_at=_opt(item, "approved_at"),
                status_at=_opt(item, "status_at"),
                failed_step=_opt(item, "failed_step"),
                failure=_opt(item, "failure"),
                disabled_by=_opt(item, "disabled_by"),
                disabled_by_email=_opt(item, "disabled_by_email"),
                disabled_at=_opt(item, "disabled_at"),
                disable_reason=_opt(item, "disable_reason"),
                locked_until=int(until) if until and "provision_lock" in item else None,
            )
        except (KeyError, ValueError, TypeError) as exc:
            raise PackRecordError("enablement unreadable") from exc

    def installed(self, pack_id: str) -> Installed | None:
        item = self._get(installed_key(pack_id))
        if item is None:
            return None
        try:
            return Installed(
                pack_version=item["pack_version"]["S"],
                enablement_id=item["enablement_id"]["S"],
                statement_sha256=item["statement_sha256"]["S"],
                tools=_strings(item["tools"]["S"]),
                actions=_actions(item["grants"]["S"]),
                config=_config(item["config"]["S"]),
                installed_at=_opt(item, "installed_at"),
                data_tier=DataTier(_opt(item, "data_tier") or DataTier.PUBLIC).value,
                identity_mode=IdentityMode(
                    _opt(item, "identity_mode") or IdentityMode.SERVICE
                ).value,
            )
        except (KeyError, ValueError, TypeError) as exc:
            raise PackRecordError("installed pointer unreadable") from exc

    def change(self, pack_id: str, change_id: str) -> PackChange | None:
        item = self._get(self._change_key(pack_id, change_id))
        return _change_from(pack_id, item) if item else None

    def pending(self, pack_id: str, now: datetime) -> PackChange | None:
        """The request that waits for another administrator, if it has not expired."""
        marker = self._get(self._pending_key(pack_id))
        if marker is None:
            return None
        change = self.change(pack_id, marker["change_id"]["S"])
        if change is None or change.status is not ChangeStatus.PENDING or now >= change.expires_at:
            return None
        return change

    def changes(self, pack_id: str) -> list[PackChange]:
        """Requests of the pack, newest first (at most ``MAX_CHANGES_READ``)."""
        items = self._db.query(
            TableName=self._table,
            KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
            ExpressionAttributeValues={
                ":pk": _s(change_partition(pack_id)),
                ":prefix": _s(SK_CHANGE_PREFIX),
            },
            ConsistentRead=True,
            Limit=MAX_CHANGES_READ,
        ).get("Items", [])
        changes = [_change_from(pack_id, item) for item in items]
        changes.sort(key=lambda c: c.created_at, reverse=True)
        return changes

    # --- Requests -------------------------------------------------------------------------

    def create_change(self, change: PackChange) -> None:
        """Store a pending request. Fails (conflict) while another one waits for the pack."""
        now = change.created_at
        item: dict[str, Any] = {
            **self._change_key(change.pack_id, change.change_id),
            "kind": _s(change.kind),
            "status": _s(ChangeStatus.PENDING),
            "pack_version": _s(change.pack_version),
            "statement_sha256": _s(change.statement_sha256),
            "config": _s(json.dumps(change.config, sort_keys=True, separators=(",", ":"))),
            "base_version": _n(change.base_version),
            "requested_by": _s(change.requested_by),
            "created_at": _s(iso(now)),
            "expires_at": _s(iso(change.expires_at)),
            "ttl": _n(int((now + CHANGE_RETENTION).timestamp())),
        }
        if change.reason:
            item["reason"] = _s(change.reason)
        if change.requested_by_email:
            item["requested_by_email"] = _s(change.requested_by_email)
        items: Any = [
            {
                "Put": {
                    "TableName": self._table,
                    "Item": {
                        **self._pending_key(change.pack_id),
                        "change_id": _s(change.change_id),
                        "expires_at": _s(iso(change.expires_at)),
                        "ttl": _n(int((now + CHANGE_RETENTION).timestamp())),
                    },
                    # An expired request no longer blocks the pack.
                    "ConditionExpression": "attribute_not_exists(PK) OR expires_at <= :now",
                    "ExpressionAttributeValues": {":now": _s(iso(now))},
                }
            },
            {
                "Put": {
                    "TableName": self._table,
                    "Item": item,
                    "ConditionExpression": "attribute_not_exists(PK)",
                }
            },
        ]
        try:
            self._db.transact_write_items(TransactItems=items)
        except ClientError as exc:
            _conflict(exc)

    def _close(
        self,
        change: PackChange,
        status: ChangeStatus,
        *,
        by: str,
        by_email: str | None,
        now: datetime,
        reason: str | None = None,
        condition: str = "#s = :pending",
    ) -> list[dict[str, Any]]:
        """Transaction items that close a pending request and free the pack for another."""
        update = "SET #s = :status, decided_by = :by, decided_at = :at"
        values: dict[str, Any] = {
            ":status": _s(status),
            ":pending": _s(ChangeStatus.PENDING),
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
                    "Key": self._change_key(change.pack_id, change.change_id),
                    "UpdateExpression": update,
                    "ConditionExpression": condition,
                    "ExpressionAttributeNames": {"#s": "status"},
                    "ExpressionAttributeValues": values,
                }
            },
            {
                "Delete": {
                    "TableName": self._table,
                    "Key": self._pending_key(change.pack_id),
                    "ConditionExpression": "change_id = :id",
                    "ExpressionAttributeValues": {":id": _s(change.change_id)},
                }
            },
        ]

    def _transact(self, items: list[dict[str, Any]]) -> None:
        try:
            self._db.transact_write_items(TransactItems=items)  # type: ignore[arg-type]
        except ClientError as exc:
            _conflict(exc)

    def approve_change(
        self,
        change: PackChange,
        *,
        enablement_id: str,
        approver: str,
        approver_email: str | None,
        now: datetime,
    ) -> None:
        """Close the request and record it as the approved enablement, in one transaction.

        The conditions close the race window of what the API already checked: the request is
        pending, unexpired and from someone else, and the enablement is still the one the
        request was made on, with no provisioner execution working on it.
        """
        extra = {"requested_at": iso(change.created_at), "approved_at": iso(now)}
        if change.requested_by_email:
            extra["requested_by_email"] = change.requested_by_email
        if approver_email:
            extra["approved_by_email"] = approver_email
        enablement = approve_item(
            self._table,
            pack_id=change.pack_id,
            enablement_id=enablement_id,
            pack_version=change.pack_version,
            config=change.config,
            requested_by=change.requested_by,
            approved_by=approver,
            expected_version=change.base_version,
            now=now,
            extra=extra,
        )
        self._transact(
            [
                *self._close(
                    change,
                    ChangeStatus.APPROVED,
                    by=approver,
                    by_email=approver_email,
                    now=now,
                    condition="#s = :pending AND requested_by <> :by AND expires_at > :at",
                ),
                {"Update": enablement},
            ]
        )

    def reject_change(
        self,
        change: PackChange,
        *,
        by: str,
        by_email: str | None,
        reason: str | None,
        now: datetime,
    ) -> None:
        self._transact(
            self._close(
                change,
                ChangeStatus.REJECTED,
                by=by,
                by_email=by_email,
                now=now,
                reason=reason,
                condition="#s = :pending AND requested_by <> :by",
            )
        )

    def withdraw_change(self, change: PackChange, *, by: str, now: datetime) -> None:
        """Close a pending request on behalf of who made it (checked again in the condition)."""
        self._transact(
            self._close(
                change,
                ChangeStatus.WITHDRAWN,
                by=by,
                by_email=None,
                now=now,
                condition="#s = :pending AND requested_by = :by",
            )
        )

    # --- Enablement -----------------------------------------------------------------------

    def retry(self, enablement: Enablement, now: datetime) -> None:
        """A failed installation goes back to ``approved``; nothing approved changes."""
        try:
            self._db.update_item(
                **retry_item(
                    self._table,
                    pack_id=enablement.pack_id,
                    enablement_id=enablement.enablement_id,
                    expected_version=enablement.version,
                    now=now,
                )
            )
        except ClientError as exc:
            _conflict(exc)

    def disable(
        self,
        enablement: Enablement,
        *,
        by: str,
        by_email: str | None,
        reason: str,
        pending: PackChange | None,
        now: datetime,
    ) -> None:
        """Mark the pack as ``disabling``; a request that was waiting on it is cancelled."""
        items: list[dict[str, Any]] = [
            {
                "Update": disable_item(
                    self._table,
                    pack_id=enablement.pack_id,
                    expected_version=enablement.version,
                    disabled_by=by,
                    disabled_by_email=by_email,
                    reason=reason,
                    now=now,
                )
            }
        ]
        if pending is not None:
            items += self._close(pending, ChangeStatus.CANCELLED, by=by, by_email=by_email, now=now)
        self._transact(items)


def now_utc() -> datetime:
    return datetime.now(UTC)
