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
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ConfigDict

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
READ_ACTIONS = frozenset(
    {
        "ViewAdmin",
        "ViewAudit",
        "ViewGroups",
        "ViewApprovals",
        "ViewInbox",
        "ViewGovernance",
        "ViewActivity",
        "ViewHome",
    }
)
# Events that record a read and nothing else: reading the directory of the people screen, a
# session recovered from its cookie (every page load leaves one; nothing changes), and an
# agent's search of its knowledge bases (one per turn that searches; the design shows it with
# «Mostrar lecturas»). «Probar búsqueda» (`kb.search`) is not: a person ran it on purpose.
READ_EVENTS = frozenset({"directory.list", "session.renewed", "kb.retrieve"})
# Read-only decisions that only shape the answer of a route the caller may already read, so a
# denial is not a refused access: whose activity the Actividad reads (``ViewAudit``, D90).
# Without this, every read of the Actividad by someone who is not an administrator left a
# denial in the audit trail and in the counts of Gobernanza. A closed list: any other denial
# stays visible.
SCOPE_PURPOSES = frozenset({"activity"})
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
    # Tasks and their runs (D78): the run is the turn, the task is what it belongs to.
    ("task_id", "task"),
    # Knowledge bases (D88): before the agent, which a later event may name too.
    ("kb_id", "knowledge_base"),
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
    """An allowed, read-only authorization decision, a read-only decision that only shapes an
    answer (``SCOPE_PURPOSES``, allowed or not) or a read event (hidden with
    ``exclude=reads``). Still recorded, and listed when reads are asked for."""
    if record.get("event") in READ_EVENTS:
        return True
    detail = record.get("detail")
    if record.get("event") != "policy.decision" or not isinstance(detail, dict):
        return False
    purpose = detail.get("purpose")
    if detail.get("read_only") is True and isinstance(purpose, str) and purpose in SCOPE_PURPOSES:
        return True
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
    events: tuple[str, ...] = ()
    """Several names or prefixes, as ``event``: a record matches any of them (D89)."""
    applied_only: bool = False
    """Leaves out the ``requested`` (and ``rejected``) halves of a fail-closed audit, keeping
    what happened: an outcome of ``applied``, or none (D89)."""

    def matches(self, record: dict[str, Any]) -> bool:
        if self.exclude_reads and is_read(record):
            return False
        if self.applied_only and _outcome(record) not in (None, "applied"):
            return False
        names = (*((self.event,) if self.event is not None else ()), *self.events)
        if not names:
            return True
        name = str(record.get("event", ""))
        return any(name.startswith(n) if n.endswith(".") else name == n for n in names)


def _outcome(record: dict[str, Any]) -> object:
    detail = record.get("detail")
    return detail.get("outcome") if isinstance(detail, dict) else None


@dataclass(frozen=True)
class AuditCount:
    count: int
    capped: bool
    """The examination stopped at its cap: ``count`` is a floor."""


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
        after = decode_cursor(query.cursor) if query.cursor else None
        items: list[dict[str, Any]] = []
        records = self._scan(query.since, query.until, after, now)
        for examined, (sort_key, record) in enumerate(records, start=1):
            if query.matches(record):
                items.append(record)
            if len(items) >= query.limit or examined >= MAX_EXAMINED:
                return AuditPage(items, encode_cursor(sort_key))
        return AuditPage(items, None)

    def count(self, query: AuditQuery, cap: int, now: datetime | None = None) -> AuditCount:
        """How many events of ``[since, until)`` match ``query``, examining at most ``cap``
        (D89): past it the count is a floor and ``capped`` says so."""
        matched = 0
        records = self._scan(query.since, query.until, None, now)
        for examined, (_sort_key, record) in enumerate(records):
            if examined >= cap:
                return AuditCount(matched, capped=True)
            if query.matches(record):
                matched += 1
        return AuditCount(matched, capped=False)

    def _scan(
        self, since: datetime, until: datetime, after: str | None, now: datetime | None
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        """Records of ``[since, until)``, newest first, strictly before ``after``."""
        now = now or datetime.now(UTC)
        since = max(since, now - INDEX_TTL - timedelta(days=1))
        # Bounded to the index lifetime so the loop over day partitions stays short.
        until = min(until, now + timedelta(minutes=1))
        low = _iso(since)
        high = _iso(until)
        if after is not None and after < high:
            high = after
        if high <= low:
            return
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
                    yield sort_key, json.loads(item["record"]["S"])
                start = resp.get("LastEvaluatedKey")
                if not start:
                    break
            day -= timedelta(days=1)


# --- Output models ---------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AuditResource(_Strict):
    type: str
    id: str


class AuditAgentOut(_Strict):
    """The agent of «Agente aprobado» and «Agente retirado», resolved from the catalog when the
    trail is read: the event keeps ids only. A field that cannot be resolved is ``None``."""

    name: str | None = None
    """The agent's name in that version."""
    created_by_email: str | None = None
    """Email of the ``created_by`` of the event, as the token said when they created it."""


AgentLookup = Callable[[str, int, str | None], AuditAgentOut | None]
"""``(agent_id, version, created_by)`` -> what the catalog knows; ``None`` when it does not."""
AGENT_EVENTS = frozenset({"agent.version.approved", "agent.retired"})
MAX_AGENT_LOOKUPS = 20
"""Distinct agent versions one read resolves; the events beyond them go without names."""


class AuditEventOut(_Strict):
    event_id: str
    ts: str
    event: str
    user_id: str | None
    actor_email: str | None = None
    actor_role: str | None = None
    actor_is_admin: bool | None = None
    resource: AuditResource | None = None
    detail: dict[str, Any]
    hash: str
    agent: AuditAgentOut | None = None
    """Only on ``AGENT_EVENTS``, when the catalog resolved it."""


def _audit_resource(value: object) -> AuditResource | None:
    if not isinstance(value, dict):
        return None
    kind, ident = value.get("type"), value.get("id")
    return (
        AuditResource(type=kind, id=ident)
        if isinstance(kind, str) and isinstance(ident, str)
        else None
    )


def audit_event_out(record: dict[str, Any], agent: AuditAgentOut | None = None) -> AuditEventOut:
    """Known fields only: events written before a field existed simply lack it."""
    resource = record.get("resource")
    email = record.get("actor_email")
    role = record.get("actor_role")
    is_admin = record.get("actor_is_admin")
    return AuditEventOut(
        event_id=str(record.get("event_id", "")),
        ts=str(record.get("ts", "")),
        event=str(record.get("event", "")),
        user_id=record.get("user_id") if isinstance(record.get("user_id"), str) else None,
        actor_email=email if isinstance(email, str) else None,
        actor_role=role if isinstance(role, str) else None,
        actor_is_admin=is_admin if isinstance(is_admin, bool) else None,
        resource=_audit_resource(resource),
        detail=record["detail"] if isinstance(record.get("detail"), dict) else {},
        hash=str(record.get("hash", "")),
        agent=agent,
    )


def _agent_key(record: dict[str, Any]) -> tuple[str, int, str | None] | None:
    detail = record.get("detail")
    if record.get("event") not in AGENT_EVENTS or not isinstance(detail, dict):
        return None
    agent, version, creator = detail.get("agent"), detail.get("version"), detail.get("created_by")
    if not isinstance(agent, str) or type(version) is not int:
        return None
    return agent, version, creator if isinstance(creator, str) else None


def audit_events_out(
    records: Iterable[dict[str, Any]], agents: AgentLookup | None = None
) -> list[AuditEventOut]:
    """The output of ``records``, with the agent of ``AGENT_EVENTS`` resolved by ``agents``
    (at most ``MAX_AGENT_LOOKUPS`` distinct versions). A lookup that fails leaves the event
    without it: the trail is still answered."""
    resolved: dict[tuple[str, int, str | None], AuditAgentOut | None] = {}
    out: list[AuditEventOut] = []
    for record in records:
        key = _agent_key(record) if agents is not None else None
        fresh = key is not None and key not in resolved
        if agents is not None and key is not None and fresh and len(resolved) < MAX_AGENT_LOOKUPS:
            try:
                resolved[key] = agents(*key)
            except Exception:
                logger.exception("agent of an audit event not resolved")
                resolved[key] = None
        out.append(audit_event_out(record, resolved.get(key) if key is not None else None))
    return out
