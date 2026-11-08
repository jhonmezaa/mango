"""What the web needs of a turn after R4 (D120, D121 (6), (7)): the turn in flight of a
conversation, a busy conversation that stores nothing, and a code of its own for a turn lost
halfway (TM-TW3, TM-TW6)."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterator
from typing import Any

import boto3
import pytest
from botocore.exceptions import ReadTimeoutError
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api import chat_stream
from mango_api import turns as turns_module
from mango_api.conversations import ConversationRepository
from mango_api.turns_store import DynamoTurnLog, MemoryTurnLog, TurnLog, TurnState

from .test_app import Harness, _auth
from .test_chat_turns import CONVERSATION
from .v1_patches import Applier, feed

USER = "user-1"


@pytest.fixture
def log(monkeypatch: pytest.MonkeyPatch) -> MemoryTurnLog:
    shared = MemoryTurnLog()
    monkeypatch.setattr(app_module, "MemoryTurnLog", lambda: shared)
    return shared


@pytest.fixture
def table(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        db.create_table(
            TableName="conv",
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield db


def _until(check: Callable[[], bool], seconds: float = 5.0) -> None:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return
        time.sleep(0.01)
    raise AssertionError("timed out")


def _turn(client: TestClient, **body: Any) -> str:
    response = client.post("/api/chat/turns", headers=_auth(), json={"message": "hola", **body})
    assert response.status_code == 200, response.text
    return str(response.json()["turn_id"])


def _answer(client: TestClient, turn_id: str) -> dict[str, Any]:
    applier = Applier()
    feed(applier, client.get(f"/api/chat/turns/{turn_id}/stream", headers=_auth()).text)
    assert applier.done
    return dict(applier.channels[0])


def _held(gate: threading.Event) -> Iterator[dict[str, Any]]:
    """An agent that writes, then waits until the test lets it finish."""
    yield {"contentBlockStart": {"contentBlockIndex": 0, "start": {}}}
    yield {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "Hola "}}}
    gate.wait(10)
    yield {"contentBlockStop": {"contentBlockIndex": 0}}
    yield {"messageStop": {"stopReason": "end_turn"}}
    yield {"metadata": {"usage": {"inputTokens": 1000, "outputTokens": 100}}}


def _hold_first_turn(h: Harness, gate: threading.Event) -> None:
    original = h.agentcore.invoke_harness
    calls = {"n": 0}

    def invoke(**request: Any) -> dict[str, Any]:
        calls["n"] += 1
        if calls["n"] == 1:
            h.agentcore.requests.append(request)
            return {"stream": _held(gate)}
        return original(**request)

    h.agentcore.invoke_harness = invoke  # type: ignore[method-assign]


def _no_turn_threads() -> bool:
    return not any(t.name == "chat-turn" for t in threading.enumerate())


# --- The record: one turn in flight per conversation -------------------------------------


@pytest.mark.parametrize("make", ["memory", "dynamo"])
def test_a_conversation_holds_one_turn_until_it_is_released(make: str, table: Any) -> None:
    store: TurnLog = (
        DynamoTurnLog(lambda _u: table, "conv") if make == "dynamo" else MemoryTurnLog()
    )
    later = int(time.time()) + 600
    one, two = "1" * 32, "2" * 32
    assert store.holder(USER, CONVERSATION) is None
    assert store.take(USER, CONVERSATION, one, until=later, replaces=None)
    assert not store.take(USER, CONVERSATION, two, until=later, replaces=None)
    assert store.holder(USER, CONVERSATION) == one
    # Only its own turn frees it.
    store.release(USER, CONVERSATION, two)
    assert store.holder(USER, CONVERSATION) == one
    store.release(USER, CONVERSATION, one)
    assert store.holder(USER, CONVERSATION) is None
    assert store.take(USER, CONVERSATION, two, until=later, replaces=None)
    # A holder known to have ended is replaced; one past its ``until`` frees it by itself.
    assert store.take(USER, CONVERSATION, one, until=0, replaces=two)
    assert store.holder(USER, CONVERSATION) is None
    assert store.take(USER, CONVERSATION, two, until=later, replaces=None)
    # Nothing of another person's conversations.
    assert store.holder("user-2", CONVERSATION) is None


def test_the_holder_stays_in_the_persons_partition_and_expires(table: Any) -> None:
    store = DynamoTurnLog(lambda _u: table, "conv")
    assert store.take(USER, CONVERSATION, "1" * 32, until=int(time.time()) + 600, replaces=None)
    (item,) = table.scan(TableName="conv")["Items"]
    assert item["PK"]["S"] == f"USER#{USER}"
    assert item["SK"]["S"] == f"INFLIGHT#{CONVERSATION}"
    assert 0 < int(item["ttl"]["N"]) - time.time() <= 4 * 3600
    # Released, never deleted: the person's session policy has no DeleteItem.
    store.release(USER, CONVERSATION, "1" * 32)
    (item,) = table.scan(TableName="conv")["Items"]
    assert item["until"]["N"] == "0"


# --- GET /api/conversations/{id}/turn ----------------------------------------------------


def test_the_turn_in_flight_is_told_until_it_ends(log: MemoryTurnLog) -> None:
    h = Harness()
    gate = threading.Event()
    _hold_first_turn(h, gate)
    client = h.client()
    url = f"/api/conversations/{CONVERSATION}/turn"
    assert client.get(url, headers=_auth()).json() == {"turn": None}
    try:
        turn_id = _turn(client, conversation_id=CONVERSATION)
        _until(lambda: any(e.kind == "delta" for e in log.events(USER, turn_id, 0)))
        assert client.get(url, headers=_auth()).json() == {
            "turn": {"turn_id": turn_id, "state": "running"}
        }
    finally:
        gate.set()
    # Read from the start, as a reloaded page does: the whole answer.
    assert _answer(client, turn_id)["status"] == "finished"
    _until(_no_turn_threads)
    assert client.get(url, headers=_auth()).json() == {"turn": None}


def test_the_turn_in_flight_is_only_its_owners_and_audited() -> None:
    h = Harness()
    client = h.client()
    url = f"/api/conversations/{CONVERSATION}/turn"
    assert client.get(url, headers=_auth()).status_code == 200
    decision = [
        d
        for e, d in zip(h.audit.events, h.audit.details, strict=True)
        if e == "policy.decision" and d.get("action") == "OwnConversation"
    ][-1]
    assert (decision["allowed"], decision["read_only"]) == (True, True)
    assert decision["conversation_id"] == CONVERSATION
    # Someone else's (not in the caller's partition), a missing one, a malformed id and a
    # denial: the same 404.
    missing = client.get(f"/api/conversations/{'b' * 32}/turn", headers=_auth())
    malformed = client.get("/api/conversations/NOT-AN-ID/turn", headers=_auth())
    h.authorizer.allow = False
    denied = client.get(url, headers=_auth())
    assert missing.status_code == malformed.status_code == denied.status_code == 404
    assert missing.json() == denied.json() == malformed.json()
    assert client.get(url).status_code == 401


# --- A busy conversation (D121 (6), design round 40 «Otra pestaña») ---------------------


def test_a_turn_sent_while_another_runs_is_busy_and_stores_nothing(log: MemoryTurnLog) -> None:
    h = Harness()
    gate = threading.Event()
    _hold_first_turn(h, gate)
    client = h.client()
    try:
        first = _turn(client, conversation_id=CONVERSATION)
        _until(lambda: any(e.kind == "delta" for e in log.events(USER, first, 0)))
        second = _turn(client, conversation_id=CONVERSATION)
        busy = _answer(client, second)
    finally:
        gate.set()
    assert busy["status"] == "error"
    assert busy["metadata"]["error"] == turns_module.BUSY_REJECTION
    _until(_no_turn_threads)
    # Neither question went out: only the first turn's question and answer are stored, the
    # agent ran once and only one reservation was made.
    assert h.conversations.stored == [(USER, "user", "hola"), (USER, "assistant", "Hola ")]
    assert len(h.agentcore.requests) == 1
    assert len(h.budgets.reserved) == 1
    status = log.status(USER, second)
    assert status is not None
    assert status.state == TurnState.FAILED
    # Once the first one ended, the next question goes.
    assert _answer(client, _turn(client, conversation_id=CONVERSATION))["status"] == "finished"


def test_a_session_that_stays_busy_does_not_store_the_question() -> None:
    h = Harness()
    h.conversations.concurrent_turns = 5
    client = h.client()
    busy = _answer(client, _turn(client, conversation_id=CONVERSATION))
    assert busy["status"] == "error"
    assert busy["metadata"]["error"]["code"] == "conversation_busy"
    assert h.conversations.stored == []
    # The conversation is free again for the next question.
    h.conversations.concurrent_turns = 0
    assert _answer(client, _turn(client, conversation_id=CONVERSATION))["status"] == "finished"


def test_a_holder_whose_worker_died_does_not_block_the_conversation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = MemoryTurnLog()
    services: Any = type("S", (), {"conversations": Harness().conversations})()
    chat_turns = turns_module.ChatTurns(services, store, None, worker="w")  # type: ignore[arg-type]
    dead = "d" * 32
    store.create(USER, CONVERSATION, dead, deadline=0)
    assert store.claim(USER, dead, worker="w", deadline=int(time.time()) - 1)
    assert store.take(USER, CONVERSATION, dead, until=int(time.time()) + 600, replaces=None)
    assert chat_turns._hold(USER, CONVERSATION, "n" * 32)
    status = store.status(USER, dead)
    assert status is not None
    assert status.state == TurnState.INTERRUPTED
    assert store.events(USER, dead, 0)[-1].data == chat_stream.TURN_INTERRUPTED
    assert store.holder(USER, CONVERSATION) == "n" * 32


# --- A turn lost halfway: ``turn_interrupted`` (D121 (7)) -------------------------------


def _cut() -> Iterator[dict[str, Any]]:
    yield {"contentBlockStart": {"contentBlockIndex": 0, "start": {}}}
    yield {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "Hola "}}}
    raise ReadTimeoutError(endpoint_url="https://agentcore.invalid")


def test_a_turn_whose_stream_is_lost_ends_with_its_own_code(log: MemoryTurnLog) -> None:
    h = Harness()
    h.agentcore.invoke_harness = lambda **_r: {"stream": _cut()}  # type: ignore[method-assign]
    client = h.client()
    turn_id = _turn(client, conversation_id=CONVERSATION)
    answer = _answer(client, turn_id)
    assert answer["status"] == "error"
    assert answer["content"]["text"] == "Hola "
    assert answer["metadata"]["error"] == chat_stream.TURN_INTERRUPTED
    # A second one, to see the history keep both cuts.
    _answer(client, _turn(client, conversation_id=CONVERSATION))
    _until(_no_turn_threads)
    # What the person saw is stored, with why it was cut.
    kept = [
        o
        for o, (_u, role, _c) in zip(h.conversations.options, h.conversations.stored, strict=True)
        if role == "assistant"
    ]
    assert [k["stop_code"] for k in kept] == ["turn_interrupted", "turn_interrupted"]
    assert all(k["stopped"] is True for k in kept)


def test_a_stalled_turn_given_up_by_its_reader_says_turn_interrupted() -> None:
    store = MemoryTurnLog()
    harness = Harness()
    services: Any = type("S", (), {"conversations": harness.conversations})()
    chat_turns = turns_module.ChatTurns(services, store, None, worker="w")  # type: ignore[arg-type]
    turn = "e" * 32
    store.create(USER, CONVERSATION, turn, deadline=10**10)
    assert store.claim(USER, turn, worker="w", deadline=10**10)
    store.append(USER, turn, 1, "conversation", {"conversation_id": CONVERSATION})
    store.append(USER, turn, 2, "delta", {"text": "Hola"})
    assert chat_turns.interrupt(USER, turn)
    assert harness.conversations.options[-1]["stop_code"] == "turn_interrupted"
    translator = chat_stream.Translator(turn, CONVERSATION)
    applier = Applier()
    applier.encoding("v1")
    for event in store.events(USER, turn, 0):
        for delta in translator.feed(event):
            applier.delta(delta.full())
    assert applier.channels[0]["status"] == "error"
    assert applier.channels[0]["metadata"]["error"]["code"] == "turn_interrupted"


def test_the_reason_an_answer_was_cut_is_stored_and_read_back(table: Any) -> None:
    repo = ConversationRepository(lambda _u: table, "conv")
    repo.add_message(USER, CONVERSATION, "assistant", "a", [], stopped=True, stop_code="cancelled")
    repo.add_message(
        USER, CONVERSATION, "assistant", "b", [], stopped=True, stop_code="turn_interrupted"
    )
    repo.add_message(USER, CONVERSATION, "assistant", "c", [], stop_code="cancelled")
    repo.add_message(USER, CONVERSATION, "assistant", "d", [], stopped=True)
    codes = [(m.stopped, m.stop_code) for m in repo.messages(USER, CONVERSATION)]
    # Only a cut answer has a reason; an old one (stored before the code) has none.
    assert codes == [(True, "cancelled"), (True, "turn_interrupted"), (False, ""), (True, "")]
    assert app_module._stop_code("turn_interrupted") == "turn_interrupted"
    assert app_module._stop_code("cancelled") == "cancelled"
    assert app_module._stop_code("") is None
    assert app_module._stop_code("anything") is None
