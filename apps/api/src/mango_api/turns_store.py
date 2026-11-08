"""The record of a chat turn that runs outside the request (D121): its state and its events.

Both live in the Conversations table, in the person's own partition (``USER#<sub>``), so the
same row-level security as the rest of the chat applies (``LeadingKeys``): the worker and
every task of mango-api reach them only through a client bound to that person.

* ``TURN#<turn>#STATE``: ``queued`` → ``running`` → ``done`` | ``interrupted`` | ``failed``.
  Every change is conditional on the state it comes from: of two workers that receive the
  same message only one moves it to ``running`` (TM-TW5), and a turn may be marked
  ``interrupted`` from outside the worker (a reader that sees it stalled, or its owner's
  «Detener»: ``POST /api/chat/turns/{turn}/cancel``).
* ``TURN#<turn>#EVT#<seq:08d>``: one item per event of the stream, numbered from 1, written
  once (conditional), read in order.
* ``INFLIGHT#<conversation>``: the turn of the conversation that is queued or running, if any
  (D121 (6): one at a time). Taken with a conditional write when a turn is queued, released
  (``until`` = 0, never deleted: the per-person session policy has no ``DeleteItem``) when it
  ends. ``until`` bounds it: a holder whose worker died never blocks the conversation longer
  than a turn may last. Read by ``GET /api/conversations/{id}/turn`` without a scan.

Every item expires after 4 hours (TTL): the conversation keeps the stored message, these are
only the way to it (TM-TW7). Nothing here ever holds the person's access token.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any, Protocol

from botocore.exceptions import ClientError

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

TTL_SECONDS = 4 * 3600
"""How long the state and the events of a turn are kept (TM-TW7)."""
MAX_EVENTS_PAGE = 200


class TurnState(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    INTERRUPTED = "interrupted"
    FAILED = "failed"


ENDED = frozenset({TurnState.DONE, TurnState.INTERRUPTED, TurnState.FAILED})


@dataclass(frozen=True)
class TurnEvent:
    seq: int
    kind: str
    data: dict[str, Any]


@dataclass(frozen=True)
class TurnStatus:
    state: TurnState
    deadline: int
    """Epoch seconds after which a turn still ``queued`` or ``running`` is stalled."""
    rejection: dict[str, Any] | None = None
    """Why a turn ended before its stream started: the HTTP error the request answers with
    (status, code and message only; never content)."""
    conversation_id: str = ""
    owner: str = ""
    """Who the turn belongs to, as written when it was queued (the subject of the partition;
    empty in records written before R3)."""


class TurnLog(Protocol):
    """Where the worker writes a turn and mango-api reads it."""

    def create(self, user_id: str, conversation_id: str, turn_id: str, *, deadline: int) -> None:
        """The turn, ``queued`` until ``deadline``."""
        ...

    def claim(self, user_id: str, turn_id: str, *, worker: str, deadline: int) -> bool:
        """``queued`` → ``running``; False when the turn is not queued (TM-TW5)."""
        ...

    def end(
        self,
        user_id: str,
        turn_id: str,
        state: TurnState,
        *,
        were: frozenset[TurnState],
        rejection: dict[str, Any] | None = None,
    ) -> bool:
        """Move the turn to ``state`` if it is in one of ``were``; False otherwise."""
        ...

    def append(self, user_id: str, turn_id: str, seq: int, kind: str, data: dict[str, Any]) -> bool:
        """Write event ``seq`` once; False when it already exists."""
        ...

    def events(self, user_id: str, turn_id: str, after: int) -> list[TurnEvent]:
        """The events after ``after``, in order."""
        ...

    def last_seq(self, user_id: str, turn_id: str) -> int:
        """The number of the turn's last event (0 without any)."""
        ...

    def status(self, user_id: str, turn_id: str) -> TurnStatus | None: ...

    def holder(self, user_id: str, conversation_id: str) -> str | None:
        """The turn that holds the conversation (``None`` when free or past its ``until``)."""
        ...

    def take(
        self, user_id: str, conversation_id: str, turn_id: str, *, until: int, replaces: str | None
    ) -> bool:
        """Make ``turn_id`` the holder until ``until`` if the conversation is free, past its
        ``until`` or held by ``replaces`` (a holder known to have ended); False otherwise."""
        ...

    def release(self, user_id: str, conversation_id: str, turn_id: str) -> None:
        """Free the conversation if ``turn_id`` holds it; nothing otherwise."""
        ...

    notifies: bool
    """True when ``wait`` wakes up on a change; otherwise readers poll on their own clock."""

    def wait(self, user_id: str, turn_id: str, seconds: float) -> None:
        """Wait for something new in the turn, at most ``seconds``."""
        ...


def _state_key(user_id: str, turn_id: str) -> dict[str, Any]:
    return {"PK": {"S": f"USER#{user_id}"}, "SK": {"S": f"TURN#{turn_id}#STATE"}}


def _holder_key(user_id: str, conversation_id: str) -> dict[str, Any]:
    return {"PK": {"S": f"USER#{user_id}"}, "SK": {"S": f"INFLIGHT#{conversation_id}"}}


def _event_sk(turn_id: str, seq: int) -> str:
    return f"TURN#{turn_id}#EVT#{seq:08d}"


def _conditional_failed(exc: ClientError) -> bool:
    return exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException"


class DynamoTurnLog:
    """``TurnLog`` on the Conversations table, through the person's RLS client.

    Reads are strongly consistent: a reader must never see event 5 before event 4.
    """

    notifies = False

    def __init__(
        self,
        clients: Callable[[str], DynamoDBClient],
        table: str,
        *,
        poll_seconds: float = 0.25,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._clients = clients
        self._table = table
        self._poll = poll_seconds
        self._clock = clock

    def _ttl(self) -> dict[str, str]:
        return {"N": str(int(self._clock()) + TTL_SECONDS)}

    def create(self, user_id: str, conversation_id: str, turn_id: str, *, deadline: int) -> None:
        self._clients(user_id).put_item(
            TableName=self._table,
            Item={
                **_state_key(user_id, turn_id),
                "state": {"S": TurnState.QUEUED.value},
                "conversation_id": {"S": conversation_id},
                "owner": {"S": user_id},
                "deadline": {"N": str(deadline)},
                "ttl": self._ttl(),
            },
            ConditionExpression="attribute_not_exists(PK)",
        )

    def claim(self, user_id: str, turn_id: str, *, worker: str, deadline: int) -> bool:
        try:
            self._clients(user_id).update_item(
                TableName=self._table,
                Key=_state_key(user_id, turn_id),
                UpdateExpression="SET #s = :running, #w = :w, deadline = :d",
                ConditionExpression="#s = :queued",
                ExpressionAttributeNames={"#s": "state", "#w": "worker"},
                ExpressionAttributeValues={
                    ":running": {"S": TurnState.RUNNING.value},
                    ":queued": {"S": TurnState.QUEUED.value},
                    ":w": {"S": worker[:100]},
                    ":d": {"N": str(deadline)},
                },
            )
        except ClientError as exc:
            if _conditional_failed(exc):
                return False
            raise
        return True

    def end(
        self,
        user_id: str,
        turn_id: str,
        state: TurnState,
        *,
        were: frozenset[TurnState],
        rejection: dict[str, Any] | None = None,
    ) -> bool:
        names = {f":w{i}": {"S": s.value} for i, s in enumerate(sorted(were))}
        values: dict[str, Any] = {":s": {"S": state.value}, **names}
        update = "SET #s = :s"
        if rejection is not None:
            update += ", rejection = :r"
            values[":r"] = {"S": json.dumps(rejection, separators=(",", ":"))}
        try:
            self._clients(user_id).update_item(
                TableName=self._table,
                Key=_state_key(user_id, turn_id),
                UpdateExpression=update,
                ConditionExpression=f"#s IN ({', '.join(names)})",
                ExpressionAttributeNames={"#s": "state"},
                ExpressionAttributeValues=values,
            )
        except ClientError as exc:
            if _conditional_failed(exc):
                return False
            raise
        return True

    def append(self, user_id: str, turn_id: str, seq: int, kind: str, data: dict[str, Any]) -> bool:
        try:
            self._clients(user_id).put_item(
                TableName=self._table,
                Item={
                    "PK": {"S": f"USER#{user_id}"},
                    "SK": {"S": _event_sk(turn_id, seq)},
                    "kind": {"S": kind},
                    "data": {"S": json.dumps(data, separators=(",", ":"), ensure_ascii=False)},
                    "ttl": self._ttl(),
                },
                ConditionExpression="attribute_not_exists(SK)",
            )
        except ClientError as exc:
            if _conditional_failed(exc):
                return False
            raise
        return True

    def events(self, user_id: str, turn_id: str, after: int) -> list[TurnEvent]:
        resp = self._clients(user_id).query(
            TableName=self._table,
            KeyConditionExpression="PK = :pk AND SK BETWEEN :from AND :to",
            ExpressionAttributeValues={
                ":pk": {"S": f"USER#{user_id}"},
                ":from": {"S": _event_sk(turn_id, after + 1)},
                ":to": {"S": _event_sk(turn_id, 99_999_999)},
            },
            ConsistentRead=True,
            Limit=MAX_EVENTS_PAGE,
        )
        return [
            TurnEvent(
                seq=int(item["SK"]["S"].rsplit("#", 1)[1]),
                kind=item["kind"]["S"],
                data=json.loads(item["data"]["S"]),
            )
            for item in resp.get("Items", [])
        ]

    def last_seq(self, user_id: str, turn_id: str) -> int:
        resp = self._clients(user_id).query(
            TableName=self._table,
            KeyConditionExpression="PK = :pk AND SK BETWEEN :from AND :to",
            ExpressionAttributeValues={
                ":pk": {"S": f"USER#{user_id}"},
                ":from": {"S": _event_sk(turn_id, 1)},
                ":to": {"S": _event_sk(turn_id, 99_999_999)},
            },
            ConsistentRead=True,
            ScanIndexForward=False,
            Limit=1,
            ProjectionExpression="SK",
        )
        items = resp.get("Items", [])
        return int(items[0]["SK"]["S"].rsplit("#", 1)[1]) if items else 0

    def status(self, user_id: str, turn_id: str) -> TurnStatus | None:
        item = (
            self._clients(user_id)
            .get_item(TableName=self._table, Key=_state_key(user_id, turn_id), ConsistentRead=True)
            .get("Item")
        )
        if item is None:
            return None
        raw = item.get("rejection", {}).get("S")
        return TurnStatus(
            state=TurnState(item["state"]["S"]),
            deadline=int(item.get("deadline", {}).get("N", "0")),
            rejection=json.loads(raw) if raw else None,
            conversation_id=item.get("conversation_id", {}).get("S", ""),
            owner=item.get("owner", {}).get("S", ""),
        )

    def holder(self, user_id: str, conversation_id: str) -> str | None:
        item = (
            self._clients(user_id)
            .get_item(
                TableName=self._table,
                Key=_holder_key(user_id, conversation_id),
                ConsistentRead=True,
            )
            .get("Item")
        )
        if item is None or int(item.get("until", {}).get("N", "0")) < int(self._clock()):
            return None
        turn_id = item.get("turn_id", {}).get("S", "")
        return turn_id or None

    def take(
        self, user_id: str, conversation_id: str, turn_id: str, *, until: int, replaces: str | None
    ) -> bool:
        condition = "attribute_not_exists(SK) OR #until < :now"
        values: dict[str, Any] = {
            ":t": {"S": turn_id},
            ":until": {"N": str(until)},
            ":now": {"N": str(int(self._clock()))},
            ":ttl": self._ttl(),
        }
        if replaces is not None:
            condition += " OR turn_id = :old"
            values[":old"] = {"S": replaces}
        try:
            self._clients(user_id).update_item(
                TableName=self._table,
                Key=_holder_key(user_id, conversation_id),
                UpdateExpression="SET turn_id = :t, #until = :until, #ttl = :ttl",
                ConditionExpression=condition,
                ExpressionAttributeNames={"#until": "until", "#ttl": "ttl"},
                ExpressionAttributeValues=values,
            )
        except ClientError as exc:
            if _conditional_failed(exc):
                return False
            raise
        return True

    def release(self, user_id: str, conversation_id: str, turn_id: str) -> None:
        try:
            self._clients(user_id).update_item(
                TableName=self._table,
                Key=_holder_key(user_id, conversation_id),
                UpdateExpression="SET #until = :zero",
                ConditionExpression="turn_id = :t",
                ExpressionAttributeNames={"#until": "until"},
                ExpressionAttributeValues={":zero": {"N": "0"}, ":t": {"S": turn_id}},
            )
        except ClientError as exc:
            if not _conditional_failed(exc):
                raise

    def wait(self, user_id: str, turn_id: str, seconds: float) -> None:
        # Two tasks share nothing but the table (D70): the reader polls it.
        time.sleep(min(seconds, self._poll))


@dataclass
class _MemoryTurn:
    state: TurnState
    deadline: int
    conversation_id: str = ""
    rejection: dict[str, Any] | None = None
    events: dict[int, TurnEvent] = field(default_factory=dict)


class MemoryTurnLog:
    """``TurnLog`` inside one process: for a mango-api whose turns run in its own task (no
    queue configured) in tests and local runs. Waits wake up as soon as the turn changes."""

    notifies = True

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._turns: dict[tuple[str, str], _MemoryTurn] = {}
        self._holders: dict[tuple[str, str], tuple[str, int]] = {}
        self._changed = threading.Condition()
        self._clock = clock

    def create(self, user_id: str, conversation_id: str, turn_id: str, *, deadline: int) -> None:
        with self._changed:
            if (user_id, turn_id) in self._turns:
                raise ValueError("turn exists")
            self._turns[(user_id, turn_id)] = _MemoryTurn(
                TurnState.QUEUED, deadline, conversation_id
            )
            self._changed.notify_all()

    def claim(self, user_id: str, turn_id: str, *, worker: str, deadline: int) -> bool:
        with self._changed:
            turn = self._turns.get((user_id, turn_id))
            if turn is None or turn.state != TurnState.QUEUED:
                return False
            turn.state, turn.deadline = TurnState.RUNNING, deadline
            self._changed.notify_all()
            return True

    def end(
        self,
        user_id: str,
        turn_id: str,
        state: TurnState,
        *,
        were: frozenset[TurnState],
        rejection: dict[str, Any] | None = None,
    ) -> bool:
        with self._changed:
            turn = self._turns.get((user_id, turn_id))
            if turn is None or turn.state not in were:
                return False
            turn.state = state
            if rejection is not None:
                turn.rejection = dict(rejection)
            self._changed.notify_all()
            return True

    def append(self, user_id: str, turn_id: str, seq: int, kind: str, data: dict[str, Any]) -> bool:
        with self._changed:
            turn = self._turns.get((user_id, turn_id))
            if turn is None or seq in turn.events:
                return False
            # A copy, as the table would store it: later changes of ``data`` do not leak in.
            turn.events[seq] = TurnEvent(seq, kind, json.loads(json.dumps(data)))
            self._changed.notify_all()
            return True

    def events(self, user_id: str, turn_id: str, after: int) -> list[TurnEvent]:
        with self._changed:
            turn = self._turns.get((user_id, turn_id))
            if turn is None:
                return []
            return [turn.events[s] for s in sorted(turn.events) if s > after][:MAX_EVENTS_PAGE]

    def status(self, user_id: str, turn_id: str) -> TurnStatus | None:
        with self._changed:
            turn = self._turns.get((user_id, turn_id))
            if turn is None:
                return None
            return TurnStatus(
                turn.state, turn.deadline, turn.rejection, turn.conversation_id, user_id
            )

    def last_seq(self, user_id: str, turn_id: str) -> int:
        with self._changed:
            turn = self._turns.get((user_id, turn_id))
            return max(turn.events, default=0) if turn is not None else 0

    def holder(self, user_id: str, conversation_id: str) -> str | None:
        with self._changed:
            held = self._holders.get((user_id, conversation_id))
            if held is None or held[1] < int(self._clock()):
                return None
            return held[0]

    def take(
        self, user_id: str, conversation_id: str, turn_id: str, *, until: int, replaces: str | None
    ) -> bool:
        with self._changed:
            held = self._holders.get((user_id, conversation_id))
            free = (
                held is None
                or held[1] < int(self._clock())
                or (replaces is not None and held[0] == replaces)
            )
            if not free:
                return False
            self._holders[(user_id, conversation_id)] = (turn_id, until)
            return True

    def release(self, user_id: str, conversation_id: str, turn_id: str) -> None:
        with self._changed:
            held = self._holders.get((user_id, conversation_id))
            if held is not None and held[0] == turn_id:
                self._holders[(user_id, conversation_id)] = (turn_id, 0)

    def wait(self, user_id: str, turn_id: str, seconds: float) -> None:
        with self._changed:
            self._changed.wait(timeout=seconds)
