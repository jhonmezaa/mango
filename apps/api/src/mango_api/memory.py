"""«Memoria»: what the agents remember of each person (D122, ``memory-threat-model.md``).

The installation's AgentCore Memory keeps, per person **and** agent, events (a copy of the
turns, 7 days) and long-term records (preferences, facts, summaries) that its strategies
extract. This module:

* builds the ``actorId`` of every ``InvokeHarness`` (``turn_actor``, ``task_actor``,
  ``SENTINEL_ACTOR``) with the one function of ``mango_core.memory`` (TM-ME1);
* serves the person's own memories: ``GET /api/memory``, ``DELETE /api/memory`` and
  ``DELETE /api/memory/{record_id}`` (Cedar ``OwnMemory``). Nobody else reads them, not even
  an administrator (D23, D122 (5));
* deletes the events of a conversation (``forget_conversation``, for its deletion route when it
  exists) and everything of a person who is disabled, with a sweep the day after
  (``MemorySweeper``, TM-ME5).

Memory is **off** until the M0 test in AWS (D122 (2)): ``Settings.memory_enabled`` is false by
default. Off, every turn names the sentinel actor, the routes answer that there is nothing and
no call reaches AWS.

Security notes (security-best-practices, FastAPI): the actor is never read from a request, only
from the verified token; a record is deleted only after its namespace says it is the caller's,
and «not yours» answers the same 404 as «does not exist» (TM-ME3); the text of a memory is
content of the person (D16, D122 (6)): it reaches only its owner's response, never a log nor
the audit, which keeps counts; the routes are rate limited per person.
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.

import asyncio
import logging
import threading
import time
from collections.abc import Awaitable, Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, Protocol

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Path, Response
from pydantic import BaseModel, ConfigDict

from mango_api.audit import AuditLog
from mango_api.rate_limits import Limiter, RateLimitUnavailableError
from mango_api.web import ApiError, Caller, rate_limited
from mango_core import memory
from mango_core.identity import UserContext
from mango_core.memory import SENTINEL_ACTOR, Kind, MemoryActorError

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
REQUESTS_PER_MINUTE = 30
"""Per person, shared by every task (``memory.requests``): each one lists or deletes in the
memory of the installation, a few calls per agent the person used."""
MAX_RECORDS = 300
"""Records an answer lists, over every agent and strategy of the person."""
MAX_TEXT = 4000
"""Characters of one record shown; a longer one is cut."""
MAX_PAGES = 20
"""Pages of 100 read per listing of the service in a request («Memoria»)."""
SWEEP_PAGES = 2000
"""Pages of 100 the sweep reads of the actors of the memory: 200,000 actors."""
PURGE_ROUNDS = 50
"""Rounds of «list, then delete» a purge makes per actor and strategy until nothing is left."""
PURGE_PK = "MEMORY_PURGE"
"""Settings table: one item per person whose memory has to be purged (``SK`` = ``sub``), and
``SYSTEM_SK`` for the sweep of the sentinel and of the task runs."""
SYSTEM_SK = "#system"
SWEEPS = 2
"""The purge itself and the sweep of the day after (TM-ME5): an extraction that was running
during the first one can still write a record."""
SWEEP_AFTER_SECONDS = 24 * 3600
RETRY_SECONDS = 15 * 60
SYSTEM_EVERY_SECONDS = 3600
LEASE_SECONDS = 15 * 60
SWEEPER_EVERY_SECONDS = 300
PURGE_FAILED_LOG = "memory purge failed;"
"""How the line an alarm reads starts (``MEMORY_PURGE_SIGNAL`` of the operational alarms)."""
SWEEP_FOUND_LOG = "memory purge failed; the sweep found records written after the purge"


# --- Models ---------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MemoryRecordOut(_Strict):
    record_id: str
    agent_id: str
    kind: Literal["preferences", "facts", "summaries"]
    text: str
    """Extracted by a model from the person's conversations: shown as plain text (TM-ME10)."""
    truncated: bool
    created_at: str


class MemoryOut(_Strict):
    enabled: bool
    """``False`` while the installation's memory is off: nothing is remembered (D122)."""
    records: list[MemoryRecordOut]
    complete: bool
    """``False`` when there were more than ``MAX_RECORDS``: delete all to clear the rest."""


class MemoryDeletedOut(_Strict):
    records: int
    events: int


RecordId = Annotated[str, Path(pattern=r"^mem-[a-zA-Z0-9_-]{36,46}$")]


# --- Data access ----------------------------------------------------------------------


class MemoryUnavailableError(Exception):
    """The memory of the installation could not be read or changed."""


class MemoryStore:
    """The data plane of the installation's memory (``bedrock-agentcore``). The role of
    mango-api may list and delete in any namespace (TM-ME3): every use case below names
    the namespaces of the caller's own actors, built here from the verified ``sub``."""

    def __init__(self, client: Any, memory_arn: str) -> None:
        self._client = client
        self._id = memory.memory_id(memory_arn)

    def _pages(
        self,
        call: Callable[..., dict[str, Any]],
        key: str,
        *,
        pages: int = MAX_PAGES,
        **kwargs: Any,
    ) -> Iterator[Any]:
        token: str | None = None
        for _ in range(pages):
            page = call(
                memoryId=self._id,
                maxResults=100,
                **kwargs,
                **({"nextToken": token} if token else {}),
            )
            yield from page.get(key, [])
            token = page.get("nextToken")
            if not token:
                return

    def records(self, namespace: str) -> Iterator[dict[str, Any]]:
        return self._pages(
            self._client.list_memory_records, "memoryRecordSummaries", namespace=namespace
        )

    def record(self, record_id: str) -> dict[str, Any] | None:
        try:
            found: dict[str, Any] = self._client.get_memory_record(
                memoryId=self._id, memoryRecordId=record_id
            )["memoryRecord"]
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
                return None
            raise
        return found

    def delete_record(self, record_id: str) -> None:
        self._client.delete_memory_record(memoryId=self._id, memoryRecordId=record_id)

    def delete_records(self, record_ids: list[str]) -> int:
        deleted = 0
        for start in range(0, len(record_ids), 100):
            batch = record_ids[start : start + 100]
            answer = self._client.batch_delete_memory_records(
                memoryId=self._id, records=[{"memoryRecordId": r} for r in batch]
            )
            if answer.get("failedRecords"):
                raise MemoryUnavailableError("records not deleted")
            deleted += len(batch)
        return deleted

    def sessions(self, actor: str) -> list[str]:
        return [
            str(s["sessionId"])
            for s in self._pages(self._client.list_sessions, "sessionSummaries", actorId=actor)
        ]

    def delete_events(self, actor: str, session: str) -> int:
        events = [
            str(e["eventId"])
            for e in self._pages(
                self._client.list_events,
                "events",
                actorId=actor,
                sessionId=session,
                includePayloads=False,
            )
        ]
        for event in events:
            self._client.delete_event(
                memoryId=self._id, actorId=actor, sessionId=session, eventId=event
            )
        return len(events)

    def actors(self) -> Iterator[str]:
        """Every actor of the memory, for the sweep only: never read in a request."""
        return (
            str(a["actorId"])
            for a in self._pages(self._client.list_actors, "actorSummaries", pages=SWEEP_PAGES)
        )


class MemoryIndex(Protocol):
    """Which agents remembered a person, and which memory sessions each conversation used,
    in the person's own partition of the Conversations table (row-level security): the
    worker writes it **before** a turn with memory runs, so the person can always find what
    was remembered. ``conversations.ConversationRepository`` implements it."""

    def note_memory(
        self, user_id: str, agent_id: str, conversation_id: str, session_id: str
    ) -> None: ...

    def memory_agents(self, user_id: str) -> list[str]: ...

    def memory_sessions(self, user_id: str, conversation_id: str) -> tuple[str | None, list[str]]:
        """The agent of the conversation and its memory sessions."""
        ...


# --- The actor of a turn --------------------------------------------------------------


def turn_actor(
    *,
    enabled: bool,
    index: MemoryIndex,
    user: UserContext,
    agent_id: str,
    agent_memory: bool,
    conversation_id: str,
    session_id: str,
) -> str:
    """The ``actorId`` of a chat turn. The person's actor with this agent only while memory is
    on and the served version uses it; the sentinel otherwise. Raises ``MemoryActorError``
    (fail closed, TM-ME1) when the person's actor cannot be built or noted: the turn must not
    run then, neither with memory nor with another actor."""
    if not (enabled and agent_memory):
        return SENTINEL_ACTOR
    actor = memory.actor_id(user.user_id, agent_id)
    try:
        index.note_memory(user.user_id, agent_id, conversation_id, session_id)
    except Exception as exc:
        raise MemoryActorError("the memory of the turn could not be noted") from exc
    return actor


def task_actor(
    *, enabled: bool, user: UserContext, agent_id: str, agent_memory: bool, run_id: str
) -> str:
    """Task runs do not use memory in v1 (D122 (8), TM-ME9): a run on an agent whose harness
    has memory gets a throwaway actor of its own, which the sweep empties."""
    if not (enabled and agent_memory):
        return SENTINEL_ACTOR
    return memory.task_actor_id(user.user_id, agent_id, run_id)


TEST_ACTOR = SENTINEL_ACTOR
"""The Playground and the evals (D91, D110) run on harnesses without memory (TM-ME9)."""


# --- Use cases ------------------------------------------------------------------------


@dataclass
class MemoryDeps:
    store: MemoryStore | None
    """``None`` while memory is off."""
    index: MemoryIndex
    audit: AuditLog
    limiter: Limiter
    sweeper: "MemorySweeper | None" = None


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    return str(value or "")


def _owner(raw: dict[str, Any]) -> memory.Actor | None:
    namespaces = raw.get("namespaces") or []
    return memory.owner_of(str(namespaces[0])) if namespaces else None


def _record_out(raw: dict[str, Any]) -> MemoryRecordOut | None:
    namespaces = raw.get("namespaces") or []
    owner = _owner(raw)
    kind = memory.kind_of(str(namespaces[0])) if namespaces else None
    if owner is None or kind is None:
        return None
    text = str((raw.get("content") or {}).get("text", ""))
    return MemoryRecordOut(
        record_id=str(raw["memoryRecordId"]),
        agent_id=owner.agent_id,
        kind=kind.value,
        text=text[:MAX_TEXT],
        truncated=len(text) > MAX_TEXT,
        created_at=_iso(raw.get("createdAt")),
    )


def _actors(deps: MemoryDeps, sub: str) -> list[str]:
    return [memory.actor_id(sub, agent) for agent in deps.index.memory_agents(sub)]


def list_memory(deps: MemoryDeps, caller: Caller) -> MemoryOut:
    user = caller.user
    if deps.store is None:
        return MemoryOut(enabled=False, records=[], complete=True)
    records: list[MemoryRecordOut] = []
    complete = True
    for actor in _actors(deps, user.user_id):
        for kind in Kind:
            for raw in deps.store.records(memory.namespace(kind, actor)):
                out = _record_out(raw)
                # The namespace asked was the caller's; the record must say so too.
                if out is None or _owner(raw) != memory.parse_actor(actor):
                    continue
                if len(records) >= MAX_RECORDS:
                    complete = False
                    break
                records.append(out)
    records.sort(key=lambda r: r.created_at, reverse=True)
    deps.audit.emit("memory.list", user.user_id, {"records": len(records)}, user)
    return MemoryOut(enabled=True, records=records, complete=complete)


def forget_record(deps: MemoryDeps, caller: Caller, record_id: str) -> None:
    user = caller.user
    if deps.store is None:
        raise ApiError(404, "not_found", "memory not found")
    raw = deps.store.record(record_id)
    owner = _owner(raw) if raw is not None else None
    # The same answer for «does not exist» and «not yours» (TM-ME3). A record of a task run
    # (owner.run_id) is not shown, and not deleted one by one either: the sweep does.
    if owner is None or owner.sub != user.user_id or owner.run_id is not None:
        raise ApiError(404, "not_found", "memory not found")
    deps.store.delete_record(record_id)
    deps.audit.emit("memory.delete", user.user_id, {"records": 1, "agent": owner.agent_id}, user)


def purge_actor(store: MemoryStore, actor: str) -> tuple[int, int]:
    """Every record and every event of one actor: ``(records, events)``. Lists and deletes
    until a listing comes back empty: a listing is capped, a purge is not (TM-ME5)."""
    records = 0
    for kind in Kind:
        for _ in range(PURGE_ROUNDS):
            ids = [
                str(raw["memoryRecordId"]) for raw in store.records(memory.namespace(kind, actor))
            ]
            if not ids:
                break
            records += store.delete_records(ids)
        else:
            raise MemoryUnavailableError("records left after the purge")
    events = sum(store.delete_events(actor, session) for session in store.sessions(actor))
    return records, events


def person_actors(store: MemoryStore, sub: str) -> list[str]:
    """Every actor of a person, chat and task runs, read from the memory itself: what the
    index says is not enough for a purge (TM-ME5)."""
    return [a for a in store.actors() if (parsed := memory.parse_actor(a)) and parsed.sub == sub]


def purge_person(store: MemoryStore, sub: str) -> tuple[int, int]:
    records = events = 0
    for actor in person_actors(store, sub):
        r, e = purge_actor(store, actor)
        records, events = records + r, events + e
    return records, events


def forget_all(deps: MemoryDeps, caller: Caller) -> MemoryDeletedOut:
    user = caller.user
    if deps.store is None:
        return MemoryDeletedOut(records=0, events=0)
    # The actors of the index now, in the request; every actor of the person (task runs too),
    # read from the whole memory, by the sweep in the background, and again the day after for
    # what an extraction that was running writes: the request never walks the whole memory.
    records = events = 0
    for actor in _actors(deps, user.user_id):
        r, e = purge_actor(deps.store, actor)
        records, events = records + r, events + e
    if deps.sweeper is not None:
        deps.sweeper.schedule(user.user_id)
    deps.audit.emit("memory.delete_all", user.user_id, {"records": records, "events": events}, user)
    return MemoryDeletedOut(records=records, events=events)


def forget_conversation(deps: MemoryDeps, user: UserContext, conversation_id: str) -> int:
    """The events of one conversation (D122 (8)): the records already extracted stay, and are
    seen and deleted in «Memoria». For the route that deletes a conversation, when it exists
    (D116 (9)). Returns how many events were deleted."""
    if deps.store is None:
        return 0
    agent_id, sessions = deps.index.memory_sessions(user.user_id, conversation_id)
    if agent_id is None or not sessions:
        return 0
    actor = memory.actor_id(user.user_id, agent_id)
    events = sum(deps.store.delete_events(actor, session) for session in sessions)
    deps.audit.emit(
        "memory.forget_conversation",
        user.user_id,
        {"conversation_id": conversation_id, "events": events},
        user,
    )
    return events


# --- Purge of a person and the sweep (TM-ME5) -----------------------------------------


class MemorySweeper:
    """Purges in the background of mango-api, from items of the Settings table: the purge of a
    disabled person (now, and again the day after), and every hour the sentinel actor and the
    actors of task runs. A purge that fails stays pending and is retried; each failure writes
    the line the alarm reads (``PURGE_FAILED_LOG``). Several tasks run it: an item is leased
    with a conditional write before it is worked on."""

    def __init__(
        self,
        db: Any,
        table: str,
        store: MemoryStore,
        audit: AuditLog,
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._db = db
        self._table = table
        self._store = store
        self._audit = audit
        self._clock = clock
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def schedule(self, sub: str, *, sweeps: int = SWEEPS, delay: int = 0) -> None:
        """Purge everything of ``sub`` after ``delay`` seconds, ``sweeps`` times a day apart."""
        if not memory.is_user_id(sub):
            raise MemoryActorError("not a verified user id")
        self._db.put_item(
            TableName=self._table,
            Item={
                "PK": {"S": PURGE_PK},
                "SK": {"S": sub},
                "due": {"N": str(int(self._clock()) + delay)},
                "sweeps": {"N": str(sweeps)},
                "lease": {"N": "0"},
                "failures": {"N": "0"},
            },
        )

    def cancel(self, sub: str) -> None:
        """A person enabled again keeps what they remember from now on: the sweep of the day
        after would delete it. The first purge already ran with the disabling."""
        self._db.delete_item(TableName=self._table, Key={"PK": {"S": PURGE_PK}, "SK": {"S": sub}})

    def _pending(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {
            "TableName": self._table,
            "KeyConditionExpression": "PK = :pk",
            "ExpressionAttributeValues": {":pk": {"S": PURGE_PK}},
            "ConsistentRead": True,
        }
        for _ in range(MAX_PAGES):
            page = self._db.query(**kwargs)
            items.extend(page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        return items

    def _lease(self, sk: str, now: int) -> bool:
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": {"S": PURGE_PK}, "SK": {"S": sk}},
                UpdateExpression="SET lease = :l",
                ConditionExpression="attribute_not_exists(lease) OR lease < :now",
                ExpressionAttributeValues={
                    ":l": {"N": str(now + LEASE_SECONDS)},
                    ":now": {"N": str(now)},
                },
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return False
            raise
        return True

    def run_once(self) -> None:
        now = int(self._clock())
        items = {i["SK"]["S"]: i for i in self._pending()}
        items.setdefault(
            SYSTEM_SK, {"due": {"N": "0"}, "sweeps": {"N": "1"}, "failures": {"N": "0"}}
        )
        for sk, item in items.items():
            if int(item.get("due", {}).get("N", "0")) > now or not self._lease(sk, now):
                continue
            if sk == SYSTEM_SK:
                self._sweep_system(now)
            else:
                self._purge(sk, item, now)

    def _sweep_system(self, now: int) -> None:
        try:
            found = 0
            for actor in self._store.actors():
                parsed = memory.parse_actor(actor)
                if actor == SENTINEL_ACTOR or (parsed is not None and parsed.run_id is not None):
                    records, _ = purge_actor(self._store, actor)
                    found += records if actor == SENTINEL_ACTOR else 0
            if found:
                # No invocation should ever have reached the sentinel with memory (TM-ME1).
                logger.error("%s the sentinel actor had %d records", PURGE_FAILED_LOG, found)
        except (ClientError, BotoCoreError, MemoryUnavailableError) as exc:
            logger.error("%s system sweep: %s", PURGE_FAILED_LOG, type(exc).__name__)  # noqa: TRY400 - the type only, no traceback
        self._db.put_item(
            TableName=self._table,
            Item={
                "PK": {"S": PURGE_PK},
                "SK": {"S": SYSTEM_SK},
                "due": {"N": str(now + SYSTEM_EVERY_SECONDS)},
                "sweeps": {"N": "1"},
                "lease": {"N": "0"},
                "failures": {"N": "0"},
            },
        )

    def _purge(self, sub: str, item: dict[str, Any], now: int) -> None:
        sweeps = int(item.get("sweeps", {}).get("N", "1"))
        key = {"PK": {"S": PURGE_PK}, "SK": {"S": sub}}
        try:
            records, events = purge_person(self._store, sub)
        except (ClientError, BotoCoreError, MemoryUnavailableError) as exc:
            failures = int(item.get("failures", {}).get("N", "0")) + 1
            # The type only, no traceback: it could carry a namespace.
            logger.error(  # noqa: TRY400
                "%s person purge (attempt %d): %s", PURGE_FAILED_LOG, failures, type(exc).__name__
            )
            self._db.update_item(
                TableName=self._table,
                Key=key,
                UpdateExpression="SET due = :d, failures = :f, lease = :z",
                ExpressionAttributeValues={
                    ":d": {"N": str(now + RETRY_SECONDS)},
                    ":f": {"N": str(failures)},
                    ":z": {"N": "0"},
                },
            )
            return
        last = sweeps <= 1
        if last and records and sweeps < SWEEPS:
            logger.error("%s (%d)", SWEEP_FOUND_LOG, records)
        self._audit.emit(
            "memory.purge",
            sub,
            {"records": records, "events": events, "sweep": SWEEPS - sweeps + 1},
        )
        if last:
            self._db.delete_item(TableName=self._table, Key=key)
            return
        self._db.update_item(
            TableName=self._table,
            Key=key,
            UpdateExpression="SET due = :d, sweeps = :s, lease = :z, failures = :z",
            ExpressionAttributeValues={
                ":d": {"N": str(now + SWEEP_AFTER_SECONDS)},
                ":s": {"N": str(sweeps - 1)},
                ":z": {"N": "0"},
            },
        )

    # --- Background ---

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name="memory-sweeper", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=10)

    def _loop(self) -> None:
        while not self._stop.wait(SWEEPER_EVERY_SECONDS):
            try:
                self.run_once()
            except Exception:
                logger.exception("the memory sweeper could not run")


@dataclass(frozen=True)
class PersonMemory:
    """What the people flow (D60) does with memory (D122 (4), TM-ME5): disabling a person
    purges all their memory, now and the day after; enabling them again cancels the sweep
    still pending. Only while memory is on."""

    sweeper: MemorySweeper

    def disabled(self, sub: str) -> None:
        self.sweeper.schedule(sub)

    def enabled(self, sub: str) -> None:
        self.sweeper.cancel(sub)


# --- Routes ---------------------------------------------------------------------------


Authorize = Callable[[Caller, str, str, str], Awaitable[None]]


def _limited[T](deps: MemoryDeps, caller: Caller, work: Callable[[], T]) -> T:
    user_id = caller.user.user_id
    try:
        allowed = deps.limiter.allow(user_id)
    except RateLimitUnavailableError as exc:
        raise ApiError(503, "rate_limit_unavailable", "please try again") from exc
    if not allowed:
        raise rate_limited(deps.limiter.retry_after(user_id))
    try:
        return work()
    except (ClientError, BotoCoreError, MemoryUnavailableError) as exc:
        # The type only: never a namespace, a record or its text.
        logger.error("memory unavailable: %s", type(exc).__name__)  # noqa: TRY400 - the type only, no traceback
        raise ApiError(503, "memory_unavailable", "please try again") from exc


def memory_router(
    deps: MemoryDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    router = APIRouter(prefix="/api/memory")

    async def owner(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        # Only the person's own memory: no route takes another person (D23, D122 (5)).
        await authorize(caller, "OwnMemory", *PLATFORM)
        return caller

    @router.get("", response_model=MemoryOut)
    async def get_memory(
        caller: Annotated[Caller, Depends(owner)], response: Response
    ) -> MemoryOut:
        response.headers["Cache-Control"] = "no-store"
        return await asyncio.to_thread(_limited, deps, caller, lambda: list_memory(deps, caller))

    @router.delete("", response_model=MemoryDeletedOut)
    async def delete_memory(caller: Annotated[Caller, Depends(owner)]) -> MemoryDeletedOut:
        return await asyncio.to_thread(_limited, deps, caller, lambda: forget_all(deps, caller))

    @router.delete("/{record_id}", status_code=204)
    async def delete_memory_record(
        caller: Annotated[Caller, Depends(owner)], record_id: RecordId
    ) -> Response:
        await asyncio.to_thread(
            _limited, deps, caller, lambda: forget_record(deps, caller, record_id)
        )
        return Response(status_code=204)

    return router
