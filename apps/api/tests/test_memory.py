"""«Memoria» (D122; threat model ``memory-threat-model.md``): the actor of each invocation,
isolation between people and agents, fail closed, deletions, the purge and its sweep, and memory
off by default. AgentCore Memory is a fake of its data plane; DynamoDB is moto. Nothing calls
AWS."""

# The fake keeps the argument names of the service (memoryId, actorId…).
# ruff: noqa: N803

from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from mango_api import memory as mem
from mango_api.conversations import ConversationRepository
from mango_api.probe import RateLimiter
from mango_api.turn_worker import worker_settings
from mango_api.web import ApiError, Caller
from mango_core import memory
from mango_core.identity import UserContext
from mango_core.memory import SENTINEL_ACTOR, Kind, MemoryActorError

from .test_admin import _table
from .test_app import FakeAudit, Harness, _auth, _settings

ARN = "arn:aws:bedrock-agentcore:us-east-1:111122223333:memory/Mango_test_memory-abcdefghij"
ANA = UserContext("11111111-1111-4111-8111-111111111111", None, None, is_admin=False)
BEA = UserContext("22222222-2222-4222-8222-222222222222", None, None, is_admin=False)
ADMIN = UserContext("33333333-3333-4333-8333-333333333333", None, None, is_admin=True)
AGENT = "finops"
OTHER_AGENT = "helpdesk"
CONV = "c" * 32


def _caller(user: UserContext) -> Caller:
    return Caller(user, "token", int(time.time()) + 3600)


@dataclass
class FakeMemory:
    """The data plane of one AgentCore Memory: records by namespace, events by actor and
    session. Every call says which memory it names."""

    records: dict[str, dict[str, Any]] = field(default_factory=dict)
    events: dict[tuple[str, str], list[str]] = field(default_factory=dict)
    calls: list[str] = field(default_factory=list)
    fail: bool = False

    def add_record(self, actor: str, kind: Kind, text: str, session: str = "s1") -> str:
        record_id = f"mem-{len(self.records):036d}"
        ns = memory.namespace(kind, actor) + (f"{session}/" if kind is Kind.SUMMARIES else "")
        self.records[record_id] = {
            "memoryRecordId": record_id,
            "content": {"text": text},
            "memoryStrategyId": kind.value,
            "namespaces": [ns],
            "createdAt": f"2026-11-0{len(self.records) % 9 + 1}T00:00:00+00:00",
        }
        return record_id

    def add_event(self, actor: str, session: str) -> None:
        self.events.setdefault((actor, session), []).append(f"{len(self.events)}#abcdef")

    def _call(self, name: str, memory_id: str) -> None:
        assert memory_id == memory.memory_id(ARN)
        self.calls.append(name)
        if self.fail:
            raise ClientError({"Error": {"Code": "ThrottlingException"}}, name)

    def list_memory_records(self, *, memoryId: str, namespace: str, **_: Any) -> dict[str, Any]:
        self._call("ListMemoryRecords", memoryId)
        found = [r for r in self.records.values() if r["namespaces"][0].startswith(namespace)]
        return {"memoryRecordSummaries": found}

    def get_memory_record(self, *, memoryId: str, memoryRecordId: str) -> dict[str, Any]:
        self._call("GetMemoryRecord", memoryId)
        if memoryRecordId not in self.records:
            raise ClientError({"Error": {"Code": "ResourceNotFoundException"}}, "GetMemoryRecord")
        return {"memoryRecord": self.records[memoryRecordId]}

    def delete_memory_record(self, *, memoryId: str, memoryRecordId: str) -> dict[str, Any]:
        self._call("DeleteMemoryRecord", memoryId)
        del self.records[memoryRecordId]
        return {"memoryRecordId": memoryRecordId}

    def batch_delete_memory_records(
        self, *, memoryId: str, records: list[dict[str, str]]
    ) -> dict[str, Any]:
        self._call("BatchDeleteMemoryRecords", memoryId)
        for r in records:
            self.records.pop(r["memoryRecordId"], None)
        return {"successfulRecords": records, "failedRecords": []}

    def list_sessions(self, *, memoryId: str, actorId: str, **_: Any) -> dict[str, Any]:
        self._call("ListSessions", memoryId)
        return {
            "sessionSummaries": [
                {"sessionId": s, "actorId": a}
                for (a, s), ev in self.events.items()
                if a == actorId and ev
            ]
        }

    def list_events(
        self, *, memoryId: str, actorId: str, sessionId: str, **_: Any
    ) -> dict[str, Any]:
        self._call("ListEvents", memoryId)
        return {"events": [{"eventId": e} for e in self.events.get((actorId, sessionId), [])]}

    def delete_event(
        self, *, memoryId: str, actorId: str, sessionId: str, eventId: str
    ) -> dict[str, Any]:
        self._call("DeleteEvent", memoryId)
        self.events[(actorId, sessionId)].remove(eventId)
        return {"eventId": eventId}

    def list_actors(self, *, memoryId: str, **_: Any) -> dict[str, Any]:
        self._call("ListActors", memoryId)
        actors = {memory.owner_of(r["namespaces"][0]) for r in self.records.values()}
        ids = {a.id for a in actors if a is not None} | {
            a for (a, _), ev in self.events.items() if ev
        }
        ids |= {r["namespaces"][0].split("/")[2] for r in self.records.values()}
        return {"actorSummaries": [{"actorId": a} for a in sorted(ids)]}


@dataclass
class FakeIndex:
    agents: dict[str, list[str]] = field(default_factory=dict)
    sessions: dict[tuple[str, str], tuple[str, list[str]]] = field(default_factory=dict)
    fail: bool = False

    def note_memory(
        self, user_id: str, agent_id: str, conversation_id: str, session_id: str
    ) -> None:
        if self.fail:
            raise ClientError({"Error": {"Code": "InternalServerError"}}, "UpdateItem")
        if agent_id not in self.agents.setdefault(user_id, []):
            self.agents[user_id].append(agent_id)
        _, known = self.sessions.setdefault((user_id, conversation_id), (agent_id, []))
        known.append(session_id)

    def memory_agents(self, user_id: str) -> list[str]:
        return list(self.agents.get(user_id, []))

    def memory_sessions(self, user_id: str, conversation_id: str) -> tuple[str | None, list[str]]:
        return self.sessions.get((user_id, conversation_id), (None, []))


@pytest.fixture
def fake() -> FakeMemory:
    return FakeMemory()


@pytest.fixture
def deps(fake: FakeMemory) -> mem.MemoryDeps:
    return mem.MemoryDeps(
        store=mem.MemoryStore(fake, ARN),
        index=FakeIndex(),
        audit=FakeAudit(),  # type: ignore[arg-type]
        limiter=RateLimiter(100, 60),
    )


def _remember(deps: mem.MemoryDeps, user: UserContext, agent: str, session: str = "s" * 40) -> str:
    """A chat turn with memory: the worker's actor and the index it notes."""
    return mem.turn_actor(
        enabled=True,
        index=deps.index,
        user=user,
        agent_id=agent,
        agent_memory=True,
        conversation_id=CONV,
        session_id=session,
    )


# --- The actor (TM-ME1) -----------------------------------------------------------------


def test_the_actor_is_the_person_and_the_agent() -> None:
    a = memory.actor_id(ANA.user_id, AGENT)
    assert a == f"m1:{AGENT}:{ANA.user_id}"
    assert memory.parse_actor(a) == memory.Actor(ANA.user_id, AGENT)
    # Another person, another agent: another actor (TM-ME6).
    assert (
        len({a, memory.actor_id(BEA.user_id, AGENT), memory.actor_id(ANA.user_id, OTHER_AGENT)})
        == 3
    )


@pytest.mark.parametrize(
    ("sub", "agent"),
    [
        ("", AGENT),
        (f"{ANA.user_id}:x", AGENT),
        ("a/b", AGENT),
        ("../x", AGENT),
        (ANA.user_id, ""),
        (ANA.user_id, "Finops"),
        (ANA.user_id, f"{AGENT}:{BEA.user_id}"),
        (SENTINEL_ACTOR, "mango-none"),
    ],
)
def test_an_actor_is_never_built_from_anything_but_a_user_id_and_an_agent_id(
    sub: str, agent: str
) -> None:
    with pytest.raises(MemoryActorError):
        memory.actor_id(sub, agent)


def test_a_task_run_gets_a_throwaway_actor_that_names_its_owner() -> None:
    a = memory.task_actor_id(ANA.user_id, AGENT, "01JABCDEF")
    assert memory.parse_actor(a) == memory.Actor(ANA.user_id, AGENT, "01JABCDEF")
    assert a != memory.actor_id(ANA.user_id, AGENT)
    with pytest.raises(MemoryActorError):
        memory.task_actor_id(ANA.user_id, AGENT, "a:b")


def test_the_sentinel_and_foreign_ids_are_nobodys() -> None:
    assert memory.parse_actor(SENTINEL_ACTOR) is None
    assert memory.parse_actor(ANA.user_id) is None
    assert memory.parse_actor(f"m2:{AGENT}:{ANA.user_id}") is None
    assert memory.owner_of(f"/other/{memory.actor_id(ANA.user_id, AGENT)}/facts/") is None
    assert memory.owner_of(f"/mango/{memory.actor_id(ANA.user_id, AGENT)}/secrets/") is None


def test_memory_off_every_turn_names_the_sentinel_and_notes_nothing() -> None:
    index = FakeIndex()
    for enabled, agent_memory in ((False, False), (False, True), (True, False)):
        actor = mem.turn_actor(
            enabled=enabled,
            index=index,
            user=ANA,
            agent_id=AGENT,
            agent_memory=agent_memory,
            conversation_id=CONV,
            session_id="s" * 40,
        )
        assert actor == SENTINEL_ACTOR
        assert (
            mem.task_actor(
                enabled=enabled, user=ANA, agent_id=AGENT, agent_memory=agent_memory, run_id="r1"
            )
            == SENTINEL_ACTOR
        )
    assert index.agents == {}


def test_a_turn_with_memory_fails_closed_without_its_actor(deps: mem.MemoryDeps) -> None:
    deps.index.fail = True  # type: ignore[attr-defined]
    with pytest.raises(MemoryActorError):
        _remember(deps, ANA, AGENT)
    deps.index.fail = False  # type: ignore[attr-defined]
    with pytest.raises(MemoryActorError):
        _remember(deps, UserContext("not a sub", None, None, is_admin=False), AGENT)
    assert _remember(deps, ANA, AGENT) == memory.actor_id(ANA.user_id, AGENT)
    assert deps.index.memory_agents(ANA.user_id) == [AGENT]


def test_tests_of_the_playground_and_the_evals_name_the_sentinel() -> None:
    assert mem.TEST_ACTOR == SENTINEL_ACTOR


def test_the_harness_names_the_installations_memory_with_the_sentinel_or_none() -> None:
    assert memory.harness_memory(None) == {"disabled": {}}
    assert memory.harness_memory("") == {"disabled": {}}
    config = memory.harness_memory(ARN)
    assert list(config) == ["agentCoreMemoryConfiguration"]  # never the managed one (TM-ME8)
    inner = config["agentCoreMemoryConfiguration"]
    assert inner["arn"] == ARN
    assert inner["actorId"] == SENTINEL_ACTOR
    assert set(inner["retrievalConfig"]) == {
        memory.NAMESPACE_TEMPLATES[Kind.PREFERENCES],
        memory.NAMESPACE_TEMPLATES[Kind.FACTS],
    }
    for template in memory.NAMESPACE_TEMPLATES.values():
        assert template.startswith("/mango/{actorId}/")


# --- «Memoria» of the person (TM-ME3) ---------------------------------------------------


def test_a_person_sees_only_their_own_memories(deps: mem.MemoryDeps, fake: FakeMemory) -> None:
    ana, bea = _remember(deps, ANA, AGENT), _remember(deps, BEA, AGENT)
    ana_other = _remember(deps, ANA, OTHER_AGENT)
    fake.add_record(ana, Kind.PREFERENCES, "prefiere tablas")
    fake.add_record(ana_other, Kind.FACTS, "trabaja en seguridad")
    fake.add_record(ana, Kind.SUMMARIES, "resumen")
    fake.add_record(bea, Kind.FACTS, "secreto de Bea")
    # A record of Ana's actor under a namespace of Bea's must not leak either way.
    fake.add_record(memory.task_actor_id(ANA.user_id, AGENT, "r1"), Kind.FACTS, "de una tarea")

    out = mem.list_memory(deps, _caller(ANA))
    assert out.enabled
    assert sorted(r.text for r in out.records) == [
        "prefiere tablas",
        "resumen",
        "trabaja en seguridad",
    ]
    assert {r.agent_id for r in out.records} == {AGENT, OTHER_AGENT}
    assert "secreto de Bea" not in str(mem.list_memory(deps, _caller(ANA)))
    assert [r.text for r in mem.list_memory(deps, _caller(BEA)).records] == ["secreto de Bea"]
    # The audit keeps counts, never the text (D16, D122 (6)).
    assert deps.audit.events[-1] == "memory.list"  # type: ignore[attr-defined]
    assert "secreto" not in str(deps.audit.details)  # type: ignore[attr-defined]


def test_the_list_shows_the_most_recent_and_says_how_many_there_are(
    deps: mem.MemoryDeps, fake: FakeMemory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Design round 41: «Se muestran tus 300 recuerdos más recientes de {n}»."""
    monkeypatch.setattr(mem, "MAX_RECORDS", 3)
    ana = _remember(deps, ANA, AGENT)
    for day in (1, 5, 2, 4, 3):
        rid = fake.add_record(ana, Kind.FACTS, f"día {day}")
        fake.records[rid]["createdAt"] = f"2026-11-0{day}T00:00:00+00:00"
    out = mem.list_memory(deps, _caller(ANA))
    assert [r.text for r in out.records] == ["día 5", "día 4", "día 3"]
    assert (out.complete, out.total) == (False, 5)
    monkeypatch.setattr(mem, "MAX_RECORDS", 5)
    out = mem.list_memory(deps, _caller(ANA))
    assert (len(out.records), out.complete, out.total) == (5, True, 5)


def test_an_administrator_has_no_memory_but_their_own(
    deps: mem.MemoryDeps, fake: FakeMemory
) -> None:
    fake.add_record(_remember(deps, ANA, AGENT), Kind.FACTS, "de Ana")
    assert mem.list_memory(deps, _caller(ADMIN)).records == []


def test_a_person_deletes_their_record_and_never_anothers(
    deps: mem.MemoryDeps, fake: FakeMemory
) -> None:
    mine = fake.add_record(_remember(deps, ANA, AGENT), Kind.FACTS, "mío")
    theirs = fake.add_record(_remember(deps, BEA, AGENT), Kind.FACTS, "de Bea")
    task = fake.add_record(memory.task_actor_id(ANA.user_id, AGENT, "r1"), Kind.FACTS, "tarea")
    for record_id in (theirs, task, "mem-" + "9" * 36):
        with pytest.raises(ApiError) as err:
            mem.forget_record(deps, _caller(ANA), record_id)
        # «Not yours» and «does not exist» answer the same.
        assert (err.value.status, err.value.code) == (404, "not_found")
    assert theirs in fake.records
    mem.forget_record(deps, _caller(ANA), mine)
    assert mine not in fake.records
    assert deps.audit.details[-1] == {"records": 1, "agent": AGENT}  # type: ignore[attr-defined]


def test_deleting_all_purges_every_actor_of_the_person_only(
    deps: mem.MemoryDeps, fake: FakeMemory, settings_table: Any
) -> None:
    assert deps.store is not None
    deps.sweeper = mem.MemorySweeper(settings_table, "settings", deps.store, deps.audit)
    ana, bea = _remember(deps, ANA, AGENT), _remember(deps, BEA, AGENT)
    run = memory.task_actor_id(ANA.user_id, OTHER_AGENT, "r1")
    for actor in (ana, run, bea):
        fake.add_record(actor, Kind.FACTS, f"de {actor}")
        fake.add_event(actor, "s1")
    # The request purges the actors of the index, without walking the whole memory.
    out = mem.forget_all(deps, _caller(ANA))
    assert (out.records, out.events) == (1, 1)
    assert "ListActors" not in fake.calls
    # The sweep, in the background, purges every other actor of hers (her task runs).
    deps.sweeper.run_once()
    assert [r["namespaces"][0].split("/")[2] for r in fake.records.values()] == [bea]
    assert not fake.events[(run, "s1")]
    assert fake.events[(bea, "s1")]


def test_a_purge_deletes_beyond_one_listing(deps: mem.MemoryDeps, fake: FakeMemory) -> None:
    """A listing is capped (MAX_PAGES), a purge is not."""
    assert deps.store is not None
    ana = _remember(deps, ANA, AGENT)
    for n in range(5):
        fake.add_record(ana, Kind.FACTS, f"r{n}")
    real = fake.list_memory_records

    def two_at_a_time(**kwargs: Any) -> dict[str, Any]:
        return {"memoryRecordSummaries": real(**kwargs)["memoryRecordSummaries"][:2]}

    fake.list_memory_records = two_at_a_time  # type: ignore[method-assign]
    assert mem.purge_actor(deps.store, ana) == (5, 0)
    assert fake.records == {}


def test_deleting_a_conversation_deletes_its_events_not_the_records(
    deps: mem.MemoryDeps, fake: FakeMemory
) -> None:
    ana = _remember(deps, ANA, AGENT, session="a" * 40)
    _remember(deps, ANA, AGENT, session="b" * 40)
    fake.add_event(ana, "a" * 40)
    fake.add_event(ana, "b" * 40)
    fake.add_event(ana, "other-conversation")
    fake.add_record(ana, Kind.FACTS, "se queda")
    assert mem.forget_conversation(deps, ANA, CONV) == 2
    assert fake.events[(ana, "other-conversation")]
    assert len(fake.records) == 1
    # Another person's conversation with the same id finds nothing of Ana's.
    assert mem.forget_conversation(deps, BEA, CONV) == 0


def test_memory_off_answers_nothing_without_calling_aws(fake: FakeMemory) -> None:
    off = mem.MemoryDeps(
        store=None, index=FakeIndex(), audit=FakeAudit(), limiter=RateLimiter(100, 60)
    )  # type: ignore[arg-type]
    assert mem.list_memory(off, _caller(ANA)) == mem.MemoryOut(
        enabled=False, records=[], complete=True, total=0
    )
    assert mem.forget_all(off, _caller(ANA)) == mem.MemoryDeletedOut(records=0, events=0)
    assert mem.forget_conversation(off, ANA, CONV) == 0
    with pytest.raises(ApiError):
        mem.forget_record(off, _caller(ANA), "mem-" + "0" * 36)
    assert fake.calls == []


def test_memory_is_off_by_default() -> None:
    env = {
        "MODEL_PRICES": "{}",
        "MANGO_NAMESPACE": "test",
        "COGNITO_ISSUER": "https://issuer.example.com",
        "COGNITO_CLIENT_ID": "client",
        "GATEWAY_URL": "https://gw.example.com/mcp",
        "AGENT_ID": AGENT,
        "AGENT_MODEL": "m",
        "AUXILIARY_MODEL": "a",
        "POLICY_STORE_ID": "ps",
        "CONVERSATIONS_TABLE": "conv",
        "CONVERSATIONS_TABLE_ARN": "arn:aws:dynamodb:us-east-1:111122223333:table/conv",
        "DATA_KEY_ARN": "arn:aws:kms:us-east-1:111122223333:key/k",
        "DATA_ACCESS_ROLE_ARN": "arn:aws:iam::111122223333:role/data",
        "BUDGETS_TABLE": "budgets",
        "AUDIT_STREAM": "audit",
        "AUDIT_INDEX_TABLE": "audit-index",
        "USER_MONTHLY_BUDGET_USD": "5",
        "AGENT_MONTHLY_BUDGET_USD": "30",
        "INVOCATION_KEY_SECRET_ARN": "arn:aws:secretsmanager:us-east-1:111122223333:secret:k",
        "SETTINGS_TABLE": "settings",
        "AGENTS_TABLE": "agents",
        "GUARDRAIL_ID": "gr",
        "GUARDRAIL_VERSION": "1",
        "RATE_LIMITS_TABLE": "rate-limits",
        # The ARN alone does not turn it on.
        "AGENT_MEMORY_ARN": ARN,
    }
    assert not worker_settings(env).memory_enabled
    assert not worker_settings({**env, "AGENT_MEMORY_ENABLED": "false"}).memory_enabled
    on = worker_settings({**env, "AGENT_MEMORY_ENABLED": "true"})
    assert on.memory_enabled
    assert on.memory_arn == ARN


def test_the_routes_answer_that_nothing_is_remembered_while_memory_is_off() -> None:
    client = Harness().client()
    assert not _settings().memory_enabled
    got = client.get("/api/memory", headers=_auth())
    assert got.status_code == 200, got.text
    assert got.json() == {"enabled": False, "records": [], "complete": True, "total": 0}
    assert got.headers["cache-control"] == "no-store"
    assert client.delete("/api/memory", headers=_auth()).json() == {"records": 0, "events": 0}
    assert client.delete(f"/api/memory/mem-{'0' * 36}", headers=_auth()).status_code == 404
    # The id of a record is checked before anything else.
    assert client.delete("/api/memory/not-a-record", headers=_auth()).status_code == 422
    assert client.get("/api/memory").status_code == 401


def test_the_routes_declare_their_cedar_action() -> None:
    harness = Harness()
    harness.authorizer.allow = False
    client = harness.client()
    assert client.get("/api/memory", headers=_auth()).status_code == 403


# --- The index in the person's partition ------------------------------------------------


@pytest.fixture
def conversations() -> Iterator[tuple[Any, ConversationRepository]]:
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "conv")
        yield db, ConversationRepository(lambda _user: db, "conv")


def test_the_index_notes_agents_and_sessions_in_the_persons_partition(
    conversations: tuple[Any, ConversationRepository],
) -> None:
    db, repo = conversations
    repo.upsert_conversation(ANA.user_id, CONV, "t", AGENT)
    repo.note_memory(ANA.user_id, AGENT, CONV, "a" * 40)
    repo.note_memory(ANA.user_id, AGENT, CONV, "b" * 40)
    repo.note_memory(ANA.user_id, AGENT, CONV, "a" * 40)
    assert repo.memory_agents(ANA.user_id) == [AGENT]
    assert repo.memory_agents(BEA.user_id) == []
    assert repo.memory_sessions(ANA.user_id, CONV) == (AGENT, ["a" * 40, "b" * 40])
    assert repo.memory_sessions(BEA.user_id, CONV) == (None, [])
    # The index never lists among the conversations.
    assert [c["conversation_id"] for c in repo.list_conversations(ANA.user_id)] == [CONV]
    keys = {i["PK"]["S"] for i in db.scan(TableName="conv")["Items"]}
    assert keys == {f"USER#{ANA.user_id}"}


# --- The purge of a person and its sweep (TM-ME5) ---------------------------------------


@pytest.fixture
def settings_table() -> Iterator[Any]:
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "settings")
        yield db


def test_disabling_a_person_purges_now_and_sweeps_the_day_after(
    deps: mem.MemoryDeps, fake: FakeMemory, settings_table: Any, caplog: pytest.LogCaptureFixture
) -> None:
    now = [1_000_000.0]
    assert deps.store is not None
    sweeper = mem.MemorySweeper(
        settings_table, "settings", deps.store, deps.audit, clock=lambda: now[0]
    )
    ana, bea = _remember(deps, ANA, AGENT), _remember(deps, BEA, AGENT)
    run = memory.task_actor_id(ANA.user_id, AGENT, "r1")
    for actor in (ana, run, bea):
        fake.add_record(actor, Kind.FACTS, "x")
        fake.add_event(actor, "s1")

    mem.PersonMemory(sweeper).disabled(ANA.user_id)
    sweeper.run_once()
    left = {r["namespaces"][0].split("/")[2] for r in fake.records.values()}
    assert left == {bea}
    assert not fake.events[(ana, "s1")]
    assert not fake.events[(run, "s1")]
    assert fake.events[(bea, "s1")]

    # An extraction that was running writes after the purge: the sweep of the day after finds
    # it, deletes it, and says so for the alarm.
    fake.add_record(ana, Kind.PREFERENCES, "tarde")
    now[0] += 3600
    sweeper.run_once()
    assert any(r["namespaces"][0].startswith(f"/mango/{ana}/") for r in fake.records.values())
    now[0] += mem.SWEEP_AFTER_SECONDS
    sweeper.run_once()
    assert not any(r["namespaces"][0].startswith(f"/mango/{ana}/") for r in fake.records.values())
    assert any(mem.SWEEP_FOUND_LOG in r.getMessage() for r in caplog.records)
    pending = settings_table.query(
        TableName="settings",
        KeyConditionExpression="PK = :pk",
        ExpressionAttributeValues={":pk": {"S": mem.PURGE_PK}},
    )["Items"]
    assert [i["SK"]["S"] for i in pending] == [mem.SYSTEM_SK]


def test_a_purge_that_fails_stays_pending_and_is_retried(
    deps: mem.MemoryDeps, fake: FakeMemory, settings_table: Any, caplog: pytest.LogCaptureFixture
) -> None:
    now = [1_000_000.0]
    assert deps.store is not None
    sweeper = mem.MemorySweeper(
        settings_table, "settings", deps.store, deps.audit, clock=lambda: now[0]
    )
    fake.add_record(_remember(deps, ANA, AGENT), Kind.FACTS, "x")
    sweeper.schedule(ANA.user_id)
    fake.fail = True
    sweeper.run_once()
    assert any(r.getMessage().startswith(mem.PURGE_FAILED_LOG) for r in caplog.records)
    assert "x" not in caplog.text
    fake.fail = False
    sweeper.run_once()  # not due yet: retried in 15 minutes
    assert len(fake.records) == 1
    now[0] += mem.RETRY_SECONDS
    sweeper.run_once()
    assert fake.records == {}


def test_enabling_a_person_again_cancels_the_sweep(
    deps: mem.MemoryDeps, fake: FakeMemory, settings_table: Any
) -> None:
    assert deps.store is not None
    sweeper = mem.MemorySweeper(settings_table, "settings", deps.store, deps.audit)
    person = mem.PersonMemory(sweeper)
    person.disabled(ANA.user_id)
    person.enabled(ANA.user_id)
    sweeper.run_once()
    fake.add_record(_remember(deps, ANA, AGENT), Kind.FACTS, "nuevo")
    sweeper.run_once()
    assert len(fake.records) == 1


def test_the_sweep_empties_the_sentinel_and_the_task_runs(
    deps: mem.MemoryDeps, fake: FakeMemory, settings_table: Any, caplog: pytest.LogCaptureFixture
) -> None:
    assert deps.store is not None
    sweeper = mem.MemorySweeper(settings_table, "settings", deps.store, deps.audit)
    ana = _remember(deps, ANA, AGENT)
    fake.add_record(ana, Kind.FACTS, "de Ana")
    fake.add_record(memory.task_actor_id(ANA.user_id, AGENT, "r1"), Kind.FACTS, "tarea")
    fake.records[fake.add_record(ana, Kind.FACTS, "x")]["namespaces"] = [
        f"/mango/{SENTINEL_ACTOR}/facts/"
    ]
    sweeper.run_once()
    assert [r["content"]["text"] for r in fake.records.values()] == ["de Ana"]
    # Nothing should ever reach the sentinel: it is reported.
    assert any("sentinel" in r.getMessage() for r in caplog.records)


def test_a_purge_is_only_scheduled_for_a_user_id(settings_table: Any, deps: mem.MemoryDeps) -> None:
    assert deps.store is not None
    sweeper = mem.MemorySweeper(settings_table, "settings", deps.store, deps.audit)
    with pytest.raises(MemoryActorError):
        sweeper.schedule("a:b")


def test_a_version_turns_memory_on_and_the_review_shows_it() -> None:
    """TM-ME6: memory is turned on in a version, through its approval. Now that the Builder and
    the review show it (M3), a version may set it; it counts in the approved hash and in the
    diff the reviewer reads, and the installation's memory still decides (D122 (2))."""
    from mango_api.agents import (  # noqa: PLC0415
        CreateAgentIn,
        SaveDraftIn,
        _definition_out,
        diff_definitions,
    )
    from mango_core.agents import content_hash, dumps_definition  # noqa: PLC0415

    on = CreateAgentIn.model_validate({"definition": {"name": "A", "memory": True}}).definition
    off = CreateAgentIn.model_validate({"definition": {"name": "A"}}).definition
    assert on.memory and not off.memory
    assert SaveDraftIn.model_validate(
        {"revision": 1, "definition": {"name": "A", "memory": True}}
    ).definition.memory
    assert content_hash(dumps_definition(on)) != content_hash(dumps_definition(off))
    diff = diff_definitions(off, on)
    assert [(f.field, f.before, f.after) for f in diff.fields] == [("memory", False, True)]
    assert diff.changes == 1
    assert _definition_out(on).memory and not _definition_out(off).memory
