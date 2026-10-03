"""Settings table repository (D17): budget limits and the versioned area -> OU mapping.

Item layout (``PK`` / ``SK``):

* ``BUDGETS`` / ``DEFAULTS``: ``user_monthly_usd``, ``agent_monthly_usd`` and ``version``.
  ``version`` is the single optimistic-locking version of the whole budget configuration:
  every budget write (defaults or a per-user limit) bumps it in the same transaction.
* ``BUDGETS`` / ``USER#<sub>``: per-user monthly limit (``limit_usd``).
* ``BU_MAPPING`` / ``CURRENT``: ``units`` (canonical JSON) and ``version``. The partition
  holds only this item, so the connector's ``dynamodb:LeadingKeys`` read grant covers nothing
  else.
* ``BU_CHANGE`` / ``<change_id>``: change requests (proposal, status, decision).

Only mango-api writes to this table (TM-A6); IaC seeds the first values put-if-absent.
"""

from __future__ import annotations

import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_core.business_units import Units, dumps_units, loads_units

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

PK_BUDGETS = "BUDGETS"
SK_DEFAULTS = "DEFAULTS"
USER_PREFIX = "USER#"
PK_MAPPING = "BU_MAPPING"
SK_CURRENT = "CURRENT"
PK_CHANGE = "BU_CHANGE"
CHANGE_LIFETIME = timedelta(days=7)
CHANGE_RETENTION = timedelta(days=90)  # table TTL; the audit trail keeps the evidence
STATUS_PENDING = "pending"
STATUS_APPROVED = "approved"
STATUS_REJECTED = "rejected"
STATUS_WITHDRAWN = "withdrawn"
MAX_PAGES = 20


class VersionConflictError(Exception):
    """The item changed since the caller read it (optimistic locking)."""


class SettingsUnavailableError(Exception):
    """Settings could not be read and nothing usable is cached; callers fail closed."""


@dataclass(frozen=True)
class BudgetDefaults:
    user_monthly_usd: Decimal
    agent_monthly_usd: Decimal
    version: int


@dataclass(frozen=True)
class BusinessUnitMapping:
    units: Units
    version: int


@dataclass(frozen=True)
class ChangeRequest:
    change_id: str
    status: str
    proposed_by: str
    proposed_by_email: str | None
    created_at: datetime
    expires_at: datetime
    base_version: int
    units: Units
    reason: str


def new_change_id() -> str:
    """Random public id (never incremental)."""
    return secrets.token_hex(16)


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds")


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: Decimal | int) -> dict[str, str]:
    return {"N": str(value)}


def _version_condition(version: int) -> tuple[str, dict[str, Any]]:
    """Version 0 means "never written" (IaC seed missing)."""
    if version == 0:
        return "attribute_not_exists(version)", {}
    return "version = :expected", {":expected": _n(version)}


_CONFLICT_REASONS = frozenset({"None", "ConditionalCheckFailed", "TransactionConflict"})


def _conflict_on_cancel(exc: ClientError) -> None:
    """Condition failures and concurrent writers are version conflicts; anything else raises."""
    code = exc.response.get("Error", {}).get("Code")
    if code == "ConditionalCheckFailedException":
        raise VersionConflictError("settings changed") from exc
    if code == "TransactionCanceledException":
        reasons = {str(r.get("Code")) for r in exc.response.get("CancellationReasons", [])}
        if reasons <= _CONFLICT_REASONS:
            raise VersionConflictError("settings changed") from exc
    raise exc


class SettingsStore:
    def __init__(
        self,
        dynamodb: DynamoDBClient,
        table: str,
        fallback_user_usd: Decimal,
        fallback_agent_usd: Decimal,
    ) -> None:
        self._db = dynamodb
        self._table = table
        # Initial values from the installation config, used only while the seed is absent.
        self._fallback = (fallback_user_usd, fallback_agent_usd)

    def _get(self, pk: str, sk: str) -> dict[str, Any] | None:
        item: dict[str, Any] | None = self._db.get_item(
            TableName=self._table,
            Key={"PK": _s(pk), "SK": _s(sk)},
            ConsistentRead=True,
        ).get("Item")
        return item

    # --- Budgets --------------------------------------------------------------------------

    def budget_defaults(self) -> BudgetDefaults:
        item = self._get(PK_BUDGETS, SK_DEFAULTS) or {}
        user = item.get("user_monthly_usd", {}).get("N")
        agent = item.get("agent_monthly_usd", {}).get("N")
        return BudgetDefaults(
            user_monthly_usd=Decimal(user) if user else self._fallback[0],
            agent_monthly_usd=Decimal(agent) if agent else self._fallback[1],
            version=int(item.get("version", {}).get("N", "0")),
        )

    def user_limit(self, user_id: str) -> Decimal | None:
        item = self._get(PK_BUDGETS, USER_PREFIX + user_id)
        return Decimal(item["limit_usd"]["N"]) if item else None

    def user_limits(self) -> dict[str, Decimal]:
        limits: dict[str, Decimal] = {}
        paginator = self._db.get_paginator("query")
        pages = paginator.paginate(
            TableName=self._table,
            KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
            ExpressionAttributeValues={":pk": _s(PK_BUDGETS), ":prefix": _s(USER_PREFIX)},
            ConsistentRead=True,
        )
        for page_number, page in enumerate(pages):
            if page_number >= MAX_PAGES:
                break
            for item in page.get("Items", []):
                limits[item["SK"]["S"].removeprefix(USER_PREFIX)] = Decimal(item["limit_usd"]["N"])
        return limits

    def put_budget_defaults(
        self, version: int, user_usd: Decimal, agent_usd: Decimal, actor: str, now: datetime
    ) -> int:
        condition, values = _version_condition(version)
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": _s(PK_BUDGETS), "SK": _s(SK_DEFAULTS)},
                UpdateExpression=(
                    "SET user_monthly_usd = :u, agent_monthly_usd = :a, version = :new, "
                    "updated_by = :by, updated_at = :at"
                ),
                ConditionExpression=condition,
                ExpressionAttributeValues={
                    **values,
                    ":u": _n(user_usd),
                    ":a": _n(agent_usd),
                    ":new": _n(version + 1),
                    ":by": _s(actor),
                    ":at": _s(iso(now)),
                },
            )
        except ClientError as exc:
            _conflict_on_cancel(exc)
        return version + 1

    def set_user_limit(
        self,
        version: int,
        user_id: str,
        limit: Decimal | None,
        actor: str,
        now: datetime,
    ) -> int:
        """Set or remove a user's own limit and bump the budget version atomically."""
        condition, values = _version_condition(version)
        user_key = {"PK": _s(PK_BUDGETS), "SK": _s(USER_PREFIX + user_id)}
        user_write: Any = (
            {"Delete": {"TableName": self._table, "Key": user_key}}
            if limit is None
            else {
                "Put": {
                    "TableName": self._table,
                    "Item": {
                        **user_key,
                        "limit_usd": _n(limit),
                        "updated_by": _s(actor),
                        "updated_at": _s(iso(now)),
                    },
                }
            }
        )
        defaults_update: Any = {
            "Update": {
                "TableName": self._table,
                "Key": {"PK": _s(PK_BUDGETS), "SK": _s(SK_DEFAULTS)},
                # Keep the defaults complete when the seed is missing (version 0).
                "UpdateExpression": (
                    "SET version = :new, updated_by = :by, updated_at = :at, "
                    "user_monthly_usd = if_not_exists(user_monthly_usd, :u), "
                    "agent_monthly_usd = if_not_exists(agent_monthly_usd, :a)"
                ),
                "ConditionExpression": condition,
                "ExpressionAttributeValues": {
                    **values,
                    ":new": _n(version + 1),
                    ":by": _s(actor),
                    ":at": _s(iso(now)),
                    ":u": _n(self._fallback[0]),
                    ":a": _n(self._fallback[1]),
                },
            }
        }
        try:
            self._db.transact_write_items(TransactItems=[defaults_update, user_write])
        except ClientError as exc:
            _conflict_on_cancel(exc)
        return version + 1

    # --- Area -> OU mapping -----------------------------------------------------------------

    def mapping(self) -> BusinessUnitMapping:
        item = self._get(PK_MAPPING, SK_CURRENT)
        if item is None:
            return BusinessUnitMapping(units={}, version=0)
        return BusinessUnitMapping(
            units=loads_units(item["units"]["S"]), version=int(item["version"]["N"])
        )

    def pending_changes(self, now: datetime) -> list[ChangeRequest]:
        paginator = self._db.get_paginator("query")
        pages = paginator.paginate(
            TableName=self._table,
            KeyConditionExpression="PK = :pk",
            FilterExpression="#s = :pending AND expires_at > :now",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":pk": _s(PK_CHANGE),
                ":pending": _s(STATUS_PENDING),
                ":now": _s(iso(now)),
            },
            ConsistentRead=True,
        )
        changes: list[ChangeRequest] = []
        for page_number, page in enumerate(pages):
            if page_number >= MAX_PAGES:
                break
            changes.extend(self._change_from(item) for item in page.get("Items", []))
        return sorted(changes, key=lambda c: c.created_at)

    def change(self, change_id: str) -> ChangeRequest | None:
        item = self._get(PK_CHANGE, change_id)
        return self._change_from(item) if item else None

    @staticmethod
    def _change_from(item: dict[str, Any]) -> ChangeRequest:
        return ChangeRequest(
            change_id=item["SK"]["S"],
            status=item["status"]["S"],
            proposed_by=item["proposed_by"]["S"],
            proposed_by_email=item.get("proposed_by_email", {}).get("S"),
            created_at=datetime.fromisoformat(item["created_at"]["S"]),
            expires_at=datetime.fromisoformat(item["expires_at"]["S"]),
            base_version=int(item["base_version"]["N"]),
            units=loads_units(item["units"]["S"]),
            reason=item["reason"]["S"],
        )

    def create_change(
        self,
        *,
        change_id: str | None = None,
        base_version: int,
        units: Units,
        reason: str,
        proposed_by: str,
        proposed_by_email: str | None,
        now: datetime,
    ) -> ChangeRequest:
        change = ChangeRequest(
            change_id=change_id or new_change_id(),
            status=STATUS_PENDING,
            proposed_by=proposed_by,
            proposed_by_email=proposed_by_email,
            created_at=now,
            expires_at=now + CHANGE_LIFETIME,
            base_version=base_version,
            units=units,
            reason=reason,
        )
        item: dict[str, Any] = {
            "PK": _s(PK_CHANGE),
            "SK": _s(change.change_id),
            "status": _s(change.status),
            "proposed_by": _s(proposed_by),
            "created_at": _s(iso(change.created_at)),
            "expires_at": _s(iso(change.expires_at)),
            "base_version": _n(base_version),
            "units": _s(dumps_units(units)),
            "reason": _s(reason),
            "ttl": _n(int((now + CHANGE_RETENTION).timestamp())),
        }
        if proposed_by_email:
            item["proposed_by_email"] = _s(proposed_by_email)
        self._db.put_item(
            TableName=self._table, Item=item, ConditionExpression="attribute_not_exists(PK)"
        )
        return change

    def approve_change(self, change: ChangeRequest, approver: str, now: datetime) -> int:
        """Apply the proposal and close it in one transaction (TM-A5).

        The mapping must still be at ``base_version``; the request must still be pending,
        unexpired and proposed by someone else (the API checks these first; the conditions
        close the race window).
        """
        condition, values = _version_condition(change.base_version)
        new_version = change.base_version + 1
        items: Any = [
            {
                "Update": {
                    "TableName": self._table,
                    "Key": {"PK": _s(PK_MAPPING), "SK": _s(SK_CURRENT)},
                    "UpdateExpression": (
                        "SET units = :units, version = :new, change_id = :cid, "
                        "updated_by = :by, updated_at = :at"
                    ),
                    "ConditionExpression": condition,
                    "ExpressionAttributeValues": {
                        **values,
                        ":units": _s(dumps_units(change.units)),
                        ":new": _n(new_version),
                        ":cid": _s(change.change_id),
                        ":by": _s(approver),
                        ":at": _s(iso(now)),
                    },
                }
            },
            {
                "Update": {
                    "TableName": self._table,
                    "Key": {"PK": _s(PK_CHANGE), "SK": _s(change.change_id)},
                    "UpdateExpression": "SET #s = :approved, decided_by = :by, decided_at = :at",
                    "ConditionExpression": (
                        "#s = :pending AND proposed_by <> :by AND expires_at > :at"
                    ),
                    "ExpressionAttributeNames": {"#s": "status"},
                    "ExpressionAttributeValues": {
                        ":approved": _s(STATUS_APPROVED),
                        ":pending": _s(STATUS_PENDING),
                        ":by": _s(approver),
                        ":at": _s(iso(now)),
                    },
                }
            },
        ]
        try:
            self._db.transact_write_items(TransactItems=items)
        except ClientError as exc:
            _conflict_on_cancel(exc)
        return new_version

    def reject_change(
        self, change: ChangeRequest, rejected_by: str, reason: str, now: datetime
    ) -> None:
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": _s(PK_CHANGE), "SK": _s(change.change_id)},
                UpdateExpression=(
                    "SET #s = :rejected, decided_by = :by, decided_at = :at, "
                    "decision_reason = :reason"
                ),
                ConditionExpression="#s = :pending",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":rejected": _s(STATUS_REJECTED),
                    ":pending": _s(STATUS_PENDING),
                    ":by": _s(rejected_by),
                    ":at": _s(iso(now)),
                    ":reason": _s(reason),
                },
            )
        except ClientError as exc:
            _conflict_on_cancel(exc)

    def withdraw_change(self, change: ChangeRequest, proposer: str, now: datetime) -> None:
        """Close a pending change on behalf of its proposer (checked again in the condition)."""
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": _s(PK_CHANGE), "SK": _s(change.change_id)},
                UpdateExpression="SET #s = :withdrawn, decided_by = :by, decided_at = :at",
                ConditionExpression="#s = :pending AND proposed_by = :by",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":withdrawn": _s(STATUS_WITHDRAWN),
                    ":pending": _s(STATUS_PENDING),
                    ":by": _s(proposer),
                    ":at": _s(iso(now)),
                },
            )
        except ClientError as exc:
            _conflict_on_cancel(exc)


class BudgetLimits:
    """Effective monthly limits for the chat path, cached in process (≤ 30 s).

    Read failures fall back to a recent value (at most ``max_stale_seconds`` old); with
    nothing usable cached the caller gets ``SettingsUnavailableError`` and must deny the turn.
    """

    MAX_ENTRIES = 10_000

    def __init__(
        self,
        store: SettingsStore,
        ttl_seconds: float = 30,
        max_stale_seconds: float = 300,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._store = store
        self._ttl = min(ttl_seconds, 30)
        self._max_stale = max_stale_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[float, Any]] = {}

    def _cached(self, key: str, load: Callable[[], Any]) -> Any:
        now = self._clock()
        with self._lock:
            entry = self._entries.get(key)
        if entry is not None and now - entry[0] <= self._ttl:
            return entry[1]
        try:
            value = load()
        except (ClientError, BotoCoreError, ArithmeticError, ValueError, KeyError) as exc:
            if entry is not None and now - entry[0] <= self._max_stale:
                return entry[1]
            raise SettingsUnavailableError("budget settings unavailable") from exc
        with self._lock:
            if len(self._entries) >= self.MAX_ENTRIES:
                self._entries.clear()
            self._entries[key] = (now, value)
        return value

    def for_user(self, user_id: str) -> tuple[Decimal, Decimal]:
        """Return ``(user limit, agent limit)`` in USD per month."""
        defaults: BudgetDefaults = self._cached(SK_DEFAULTS, self._store.budget_defaults)
        own: Decimal | None = self._cached(
            USER_PREFIX + user_id, lambda: self._store.user_limit(user_id)
        )
        return (own if own is not None else defaults.user_monthly_usd), defaults.agent_monthly_usd

    def invalidate(self) -> None:
        with self._lock:
            self._entries.clear()
