"""Audit events: immutable copy to Firehose -> S3 Object Lock, plus a short-lived index for the
admin UI. Events carry identifiers and decisions, never prompts, tokens or tool arguments."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import logging
import re
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient
    from mypy_boto3_firehose import FirehoseClient

    from mango_core.identity import UserContext

logger = logging.getLogger(__name__)
INDEX_TTL = timedelta(days=30)
MAX_PAGE = 200
# Items examined per request when filters skip most of them; the cursor resumes from there.
MAX_EXAMINED = 2000
_QUERY_LIMIT = 200
# Allowed read-only authorization decisions (``exclude=reads``). Events emitted since the
# ``read_only`` flag exists carry it; older ones are recognized by their action.
READ_ACTIONS = frozenset({"ViewAdmin", "ViewAudit", "ViewGroups", "ViewApprovals"})
# Events that record a read and nothing else: reading the directory of the people screen, and
# a session recovered from its cookie (every page load leaves one; nothing changes).
READ_EVENTS = frozenset({"directory.list", "session.renewed"})
_SK_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00#[0-9a-f]{32}$")
_CURSOR_MAX = 128


class InvalidCursorError(ValueError):
    """The pagination cursor is not one this API issued."""


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds")


def encode_cursor(sort_key: str) -> str:
    return base64.urlsafe_b64encode(sort_key.encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> str:
    """Opaque cursor -> index sort key (``<ts>#<event_id>``); anything else is rejected."""
    if len(cursor) > _CURSOR_MAX:
        raise InvalidCursorError("invalid cursor")
    try:
        value = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
    except (binascii.Error, UnicodeDecodeError) as exc:
        raise InvalidCursorError("invalid cursor") from exc
    if not _SK_RE.fullmatch(value):
        raise InvalidCursorError("invalid cursor")
    return value


_GENERIC_RESOURCES = (
    ("approval_id", "approval"),
    # Same resource the pack provisioner writes for its own events (``mcp.pack.*``).
    ("pack", "mcp_pack"),
    ("change_id", "change"),
    ("group", "group"),
    ("target_user", "user"),
    ("conversation_id", "conversation"),
    ("agent", "agent"),
    ("model", "model"),
)


def resource_of(event: str, detail: dict[str, Any]) -> dict[str, str] | None:
    """Normalized ``{type, id}`` of what the event is about, derived when it is written."""
    if event == "policy.decision":
        kind, _, ident = str(detail.get("resource", "")).rpartition("::")
        return {"type": kind, "id": ident} if kind and ident else None
    if event == "settings.budget.updated":
        if detail.get("scope") == "defaults":
            return {"type": "budget_defaults", "id": "defaults"}
        target = detail.get("target_user")
        return {"type": "user_budget", "id": target} if isinstance(target, str) else None
    if event.startswith("settings.bu_mapping."):
        change = detail.get("change_id")
        return {"type": "bu_change", "id": change} if isinstance(change, str) else None
    for key, kind in _GENERIC_RESOURCES:
        value = detail.get(key)
        if isinstance(value, str) and value:
            return {"type": kind, "id": value}
    return None


def is_read(record: dict[str, Any]) -> bool:
    """An allowed, read-only authorization decision or a read event (hidden with
    ``exclude=reads``). Still recorded, and listed when reads are asked for."""
    if record.get("event") in READ_EVENTS:
        return True
    detail = record.get("detail")
    if record.get("event") != "policy.decision" or not isinstance(detail, dict):
        return False
    return detail.get("allowed") is True and (
        detail.get("read_only") is True or detail.get("action") in READ_ACTIONS
    )


@dataclass(frozen=True)
class AuditQuery:
    since: datetime
    until: datetime
    limit: int
    cursor: str | None = None
    exclude_reads: bool = False
    event: str | None = None
    """Exact event name, or a prefix when it ends with ``.`` (e.g. ``settings.``)."""

    def matches(self, record: dict[str, Any]) -> bool:
        if self.exclude_reads and is_read(record):
            return False
        if self.event is None:
            return True
        name = str(record.get("event", ""))
        return name.startswith(self.event) if self.event.endswith(".") else name == self.event


@dataclass(frozen=True)
class AuditPage:
    items: list[dict[str, Any]]
    next_cursor: str | None


class AuditLog:
    def __init__(
        self, firehose: FirehoseClient, stream: str, dynamodb: DynamoDBClient, index_table: str
    ) -> None:
        self._firehose = firehose
        self._stream = stream
        self._db = dynamodb
        self._index = index_table

    def emit(
        self,
        event: str,
        user_id: str,
        detail: dict[str, Any],
        actor: UserContext | None = None,
    ) -> None:
        """Write one event. ``actor`` adds who acted as the verified token said at that moment
        (display email, role and admin flag), so the log never needs a lookup per event."""
        now = datetime.now(UTC)
        record: dict[str, Any] = {
            "event_id": secrets.token_hex(16),
            "ts": _iso(now),
            "event": event,
            "user_id": user_id,
            "detail": detail,
        }
        if actor is not None:
            record["actor_email"] = actor.email
            record["actor_role"] = actor.role
            record["actor_is_admin"] = actor.is_admin
        resource = resource_of(event, detail)
        if resource is not None:
            record["resource"] = resource
        body = json.dumps(record, separators=(",", ":"), sort_keys=True)
        record["hash"] = hashlib.sha256(body.encode()).hexdigest()
        line = json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n"
        try:
            self._firehose.put_record(
                DeliveryStreamName=self._stream, Record={"Data": line.encode()}
            )
            self._db.put_item(
                TableName=self._index,
                Item={
                    "PK": {"S": f"DAY#{now.strftime('%Y-%m-%d')}"},
                    "SK": {"S": f"{record['ts']}#{record['event_id']}"},
                    "record": {"S": line},
                    "ttl": {"N": str(int((now + INDEX_TTL).timestamp()))},
                },
            )
        except Exception:
            # Audit failures must be visible to operators, without leaking the payload.
            logger.exception("audit emit failed", extra={"audit_event": event})
            raise

    def page(self, query: AuditQuery, now: datetime | None = None) -> AuditPage:
        """Newest first within ``[since, until)``, resuming strictly before ``cursor``.

        The index is partitioned by day and kept ``INDEX_TTL``: the range is clamped to it.
        Filters run here, so a page can hold fewer than ``limit`` items while ``next_cursor``
        is set (at most ``MAX_EXAMINED`` items are read per request).
        """
        now = now or datetime.now(UTC)
        since = max(query.since, now - INDEX_TTL - timedelta(days=1))
        # Bounded to the index lifetime so the loop over day partitions stays short.
        until = min(query.until, now + timedelta(minutes=1))
        low = _iso(since)
        high = _iso(until)
        after = decode_cursor(query.cursor) if query.cursor else None
        if after is not None and after < high:
            high = after
        if high <= low:
            return AuditPage([], None)
        items: list[dict[str, Any]] = []
        examined = 0
        day = datetime.fromisoformat(high.split("#", 1)[0]).date()
        while day >= since.date():
            start: dict[str, Any] | None = None
            while True:
                request: dict[str, Any] = {
                    "TableName": self._index,
                    "KeyConditionExpression": "PK = :pk AND SK BETWEEN :low AND :high",
                    "ExpressionAttributeValues": {
                        ":pk": {"S": f"DAY#{day.isoformat()}"},
                        ":low": {"S": low},
                        ":high": {"S": high},
                    },
                    "ScanIndexForward": False,
                    "Limit": _QUERY_LIMIT,
                }
                if start:
                    request["ExclusiveStartKey"] = start
                resp = self._db.query(**request)
                for item in resp.get("Items", []):
                    sort_key = item["SK"]["S"]
                    if sort_key == after:
                        continue
                    examined += 1
                    record = json.loads(item["record"]["S"])
                    if query.matches(record):
                        items.append(record)
                    if len(items) >= query.limit or examined >= MAX_EXAMINED:
                        return AuditPage(items, encode_cursor(sort_key))
                start = resp.get("LastEvaluatedKey")
                if not start:
                    break
            day -= timedelta(days=1)
        return AuditPage(items, None)
