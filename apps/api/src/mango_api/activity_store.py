"""Activity of the agents (D90; threat model ``activity-threat-model.md``): what mango-api saw
the agents do, metadata only.

Two copies of every event, because one person's reads must never touch another person's rows:

* **The person's**, in the conversations table under ``PK = USER#<sub>``, ``SK = ACT#<id>``,
  always through the row-level security client of that person (``dynamodb:LeadingKeys``), as
  the Bandeja (D83 (2)). ``scope=mine`` reads only these.
* **Everyone's, for administrators**, in the audit index table under
  ``PK = ACTIVITY#<day>``, ``SK = <ts>#<id>``: the same table and day partitioning as the audit
  index (``audit.py``), which mango-api already writes and administrators already read; the
  audit's own ``DAY#`` partitions are untouched. Only ``scope=all`` (``ViewAudit``) reads them.
  A turn writes these when it ends, each call with its own time (D90 (7), design round 19:
  «lo de otras personas, al terminar cada turno»); a blocked turn, at once.

An event is a tool call (agent, version, tool, ok, milliseconds) or a turn the agent's budget
blocked; with the conversation, or the task and run, it belongs to. Never the input or the
answer of a tool, text of the model or a prompt (D16). The id is the time in milliseconds
followed by 16 random hex characters: newest last, never guessable. Both copies expire after
``RETENTION`` (the tables' TTL).
"""

from __future__ import annotations

import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

RETENTION = timedelta(days=30)
"""Taken by the owner on 2026-10-24 (D90 (6)): as the audit index."""
EVENT_ID_PATTERN = r"^[0-9]{13}[0-9a-f]{16}$"
EVENT_ID_RE = re.compile(EVENT_ID_PATTERN)
_MINE = "ACT#"
_ALL = "ACTIVITY#"
_QUERY_LIMIT = 200
_BATCH = 25
_BATCH_ATTEMPTS = 3
TASK_NAME_MAX_CHARS = 120

Kind = Literal["tool", "budget"]


class ActivityStoreUnavailableError(Exception):
    """The table could not be read or written."""


@dataclass(frozen=True)
class Origin:
    """What a turn belongs to: a conversation, or a run of a task. Ids written by mango-api."""

    user_id: str
    agent_id: str
    agent_version: int
    conversation_id: str | None = None
    task_id: str | None = None
    run_id: str | None = None
    task_name: str | None = None
    """Shown to the task's owner only («Tarea · {nombre}»)."""


@dataclass(frozen=True)
class ActivityRecord:
    event_id: str
    kind: Kind
    at: str
    user_id: str
    agent_id: str
    agent_version: int
    tool: str | None
    ok: bool | None
    ms: int | None
    conversation_id: str | None
    task_id: str | None
    run_id: str | None
    task_name: str | None = None


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _iso(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, UTC).isoformat(timespec="milliseconds")


def _record(item: dict[str, Any], event_id: str) -> ActivityRecord:
    def text(name: str) -> str | None:
        value = item.get(name, {}).get("S")
        return str(value) if value else None

    def number(name: str) -> int | None:
        value = item.get(name, {}).get("N")
        return int(value) if value is not None else None

    ok = item.get("ok", {}).get("BOOL")
    kind = item["kind"]["S"]
    return ActivityRecord(
        event_id=event_id,
        kind="budget" if kind == "budget" else "tool",
        at=item["at"]["S"],
        user_id=item["user_id"]["S"],
        agent_id=item["agent_id"]["S"],
        agent_version=int(item["agent_version"]["N"]),
        tool=text("tool"),
        ok=bool(ok) if ok is not None else None,
        ms=number("ms"),
        conversation_id=text("conversation_id"),
        task_id=text("task_id"),
        run_id=text("run_id"),
        task_name=text("task_name"),
    )


class ActivityStore:
    def __init__(
        self,
        clients: Callable[[str], DynamoDBClient],
        table: str,
        index: DynamoDBClient,
        index_table: str,
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._clients = clients
        self._table = table
        self._index = index
        self._index_table = index_table
        self._clock = clock

    def _call[T](self, fn: Callable[[], T]) -> T:
        try:
            return fn()
        except Exception as exc:
            raise ActivityStoreUnavailableError from exc

    def _query(self, client: DynamoDBClient, request: dict[str, Any]) -> dict[str, Any]:
        try:
            return dict(client.query(**request))
        except Exception as exc:
            raise ActivityStoreUnavailableError from exc

    # --- Writes ---------------------------------------------------------------------------

    def add(
        self,
        origin: Origin,
        kind: Kind,
        *,
        tool: str | None = None,
        ok: bool | None = None,
        ms: int | None = None,
        everyone_now: bool = True,
    ) -> tuple[ActivityRecord, dict[str, Any]]:
        """Write one event in the person's partition and, unless ``everyone_now`` is false, in
        the day's partition. Returns the record and the item of the day's partition, which a
        turn writes with ``add_everyone`` once it ends (D90 (7))."""
        now = self._clock()
        event_id = f"{int(now * 1000):013d}{secrets.token_hex(8)}"
        at = _iso(now)
        fields: dict[str, Any] = {
            "kind": _s(kind),
            "at": _s(at),
            "user_id": _s(origin.user_id),
            "agent_id": _s(origin.agent_id),
            "agent_version": {"N": str(origin.agent_version)},
            "ttl": {"N": str(int(now + RETENTION.total_seconds()))},
        }
        for name, value in (
            ("tool", tool),
            ("conversation_id", origin.conversation_id),
            ("task_id", origin.task_id),
            ("run_id", origin.run_id),
        ):
            if value:
                fields[name] = _s(value)
        if ok is not None:
            fields["ok"] = {"BOOL": ok}
        if ms is not None:
            fields["ms"] = {"N": str(ms)}
        mine = {"PK": _s(f"USER#{origin.user_id}"), "SK": _s(f"{_MINE}{event_id}"), **fields}
        if origin.task_name:
            # The person's own copy only: the name of a task is what its owner wrote.
            mine["task_name"] = _s(origin.task_name[:TASK_NAME_MAX_CHARS])
        every = {"PK": _s(f"{_ALL}{at[:10]}"), "SK": _s(f"{at}#{event_id}"), **fields}
        self._call(
            lambda: self._clients(origin.user_id).put_item(
                TableName=self._table, Item=mine, ConditionExpression="attribute_not_exists(SK)"
            )
        )
        if everyone_now:
            self.add_everyone([every])
        return _record(mine, event_id), every

    def add_everyone(self, items: list[dict[str, Any]]) -> None:
        """Write items of the day's partitions, 25 at a time, retrying what DynamoDB leaves
        unprocessed a few times."""
        for first in range(0, len(items), _BATCH):
            pending: list[Any] = [
                {"PutRequest": {"Item": i}} for i in items[first : first + _BATCH]
            ]
            for _ in range(_BATCH_ATTEMPTS):
                if not pending:
                    break
                try:
                    resp = self._index.batch_write_item(RequestItems={self._index_table: pending})
                except Exception as exc:
                    raise ActivityStoreUnavailableError from exc
                pending = list(resp.get("UnprocessedItems", {}).get(self._index_table, []))
            if pending:
                raise ActivityStoreUnavailableError("unprocessed activity items")

    # --- Reads ----------------------------------------------------------------------------

    def mine(
        self, user_id: str, *, since: datetime, until: datetime, limit: int
    ) -> tuple[list[ActivityRecord], bool]:
        """The person's events in ``[since, until)``, newest first, and whether more were left
        out. Only ever with that person's own client."""
        low = f"{_MINE}{int(since.timestamp() * 1000):013d}"
        high = f"{_MINE}{int(until.timestamp() * 1000):013d}"
        client = self._clients(user_id)
        items: list[ActivityRecord] = []
        request: dict[str, Any] = {
            "TableName": self._table,
            "KeyConditionExpression": "PK = :pk AND SK BETWEEN :low AND :high",
            "ExpressionAttributeValues": {
                ":pk": _s(f"USER#{user_id}"),
                ":low": _s(low),
                ":high": _s(high),
            },
            "ScanIndexForward": False,
            "Limit": _QUERY_LIMIT,
        }
        while True:
            resp = self._query(client, request)
            for item in resp.get("Items", []):
                event_id = item["SK"]["S"].removeprefix(_MINE)
                if not EVENT_ID_RE.fullmatch(event_id):
                    continue
                if len(items) >= limit:
                    return items, True
                items.append(_record(item, event_id))
            start = resp.get("LastEvaluatedKey")
            if not start:
                return items, False
            request["ExclusiveStartKey"] = start

    def everyone(
        self, *, since: datetime, until: datetime, limit: int
    ) -> tuple[list[ActivityRecord], bool]:
        """Everyone's events in ``[since, until)``, newest first, day by day."""
        low = since.astimezone(UTC).isoformat(timespec="milliseconds")
        high = until.astimezone(UTC).isoformat(timespec="milliseconds")
        items: list[ActivityRecord] = []
        day = until.astimezone(UTC).date()
        while day >= since.astimezone(UTC).date():
            request: dict[str, Any] = {
                "TableName": self._index_table,
                "KeyConditionExpression": "PK = :pk AND SK BETWEEN :low AND :high",
                "ExpressionAttributeValues": {
                    ":pk": _s(f"{_ALL}{day.isoformat()}"),
                    ":low": _s(low),
                    ":high": _s(high),
                },
                "ScanIndexForward": False,
                "Limit": _QUERY_LIMIT,
            }
            while True:
                resp = self._query(self._index, request)
                for item in resp.get("Items", []):
                    event_id = item["SK"]["S"].rpartition("#")[2]
                    if not EVENT_ID_RE.fullmatch(event_id):
                        continue
                    if len(items) >= limit:
                        return items, True
                    items.append(_record(item, event_id))
                start = resp.get("LastEvaluatedKey")
                if not start:
                    break
                request["ExclusiveStartKey"] = start
            day -= timedelta(days=1)
        return items, False
