"""The stream of a turn in ``v1`` deltas (D120), its resumption from any offset, and the
owner's «Detener» (D121 (7)): TM-TW3, TW4, TW6, TW8."""

from __future__ import annotations

import json
import re
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api import chat_stream
from mango_api import turns as turns_module
from mango_api.turns_store import DynamoTurnLog, MemoryTurnLog, TurnEvent, TurnState, TurnStatus

from .test_app import Harness, _auth
from .test_chat_turns import BEFORE_D121, CONVERSATION, QueueDouble
from .v1_patches import Applier, DeltaError, feed, parse

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def log(monkeypatch: pytest.MonkeyPatch) -> MemoryTurnLog:
    shared = MemoryTurnLog()
    monkeypatch.setattr(app_module, "MemoryTurnLog", lambda: shared)
    return shared


def _until(check: Callable[[], bool], seconds: float = 5.0) -> None:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return
        time.sleep(0.01)
    raise AssertionError("timed out")


def _turn(client: TestClient, token: str = "good", **body: Any) -> tuple[str, str]:
    response = client.post(
        "/api/chat/turns", headers=_auth(token), json={"message": "hola", **body}
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert set(data) == {"conversation_id", "turn_id"}
    return str(data["conversation_id"]), str(data["turn_id"])


def _stream(client: TestClient, turn_id: str, after: int = 0, token: str = "good") -> Any:
    return client.get(
        f"/api/chat/turns/{turn_id}/stream", params={"after": after}, headers=_auth(token)
    )


def _documents(body: str) -> Applier:
    applier = Applier()
    feed(applier, body)
    return applier


# --- The stream of a real turn ----------------------------------------------------------


def test_the_v1_stream_reproduces_the_turn_of_the_record() -> None:
    h = Harness()
    client = h.client()
    conversation_id, turn_id = _turn(client)
    response = _stream(client, turn_id)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-store"
    events = parse(response.text)
    assert events[0] == ("delta_encoding", "v1", None)
    assert events[-2][0] == "message_stream_complete"
    assert events[-2][1] == {"conversation_id": conversation_id, "turn_id": turn_id}
    assert events[-1][0] == "[DONE]"
    deltas = [e for e in events if e[0] == "delta"]
    # Numbered by event, from 1, without gaps.
    assert [e[2] for e in deltas] == list(range(1, len(deltas) + 1))

    docs = _documents(response.text)
    answer = docs.channels[0]
    stored = [content for _u, role, content in h.conversations.stored if role == "assistant"]
    assert answer["content"] == {"text": stored[0]} == {"text": "Hola \n\nmundo"}
    assert answer["author"] == {"role": "assistant"}
    assert (answer["recipient"], answer["channel"], answer["content_type"]) == (
        "all",
        "final",
        "text",
    )
    assert answer["status"] == "finished"
    assert answer["metadata"]["conversation_id"] == conversation_id
    assert answer["metadata"]["turn_id"] == turn_id
    # D57: the last phase of the turn, data without text of the model.
    assert answer["metadata"]["phase"] == {"phase": "writing"}
    assert answer["metadata"]["result"] == dict(BEFORE_D121[-1][1])
    call, result = docs.channels[1], docs.channels[2]
    assert call["recipient"] == "get_cost_and_usage"
    assert (call["author"]["role"], call["content_type"], call["status"]) == (
        "assistant",
        "tool_call",
        "finished",
    )
    # D90 (3): what the tool answered never reaches the browser.
    assert result["author"] == {"role": "tool", "name": "get_cost_and_usage"}
    assert (result["content_type"], result["content"], result["status"]) == (
        "tool_result",
        {},
        "finished",
    )
    assert result["metadata"] == {"call_id": call["id"]}
    assert len(docs.channels) == 3


def _translate(events: list[list[Any]]) -> list[chat_stream.Delta]:
    translator = chat_stream.Translator("t" * 32, "c" * 32)
    out: list[chat_stream.Delta] = []
    for seq, (kind, data) in enumerate(events, start=1):
        out.extend(translator.feed(TurnEvent(seq, kind, data)))
    return out


def _all_paths(deltas: list[chat_stream.Delta]) -> set[str]:
    paths = set()
    for delta in deltas:
        paths.add(delta.p)
        if delta.o == "patch":
            paths.update(str(sub["p"]) for sub in delta.v)
    return paths


EVERY_KIND = [
    *BEFORE_D121[:-1],
    ["knowledge", {"knowledge_bases": ["kb"], "count": 1, "sources": []}],
    ["approval", {"approval_id": "a" * 32, "tool": "create_ticket"}],
    ["remote_connection_required", {"registration_id": "r" * 26}],
    ["tool", {"name": "create_ticket", "status": "error"}],
    ["something_new", {"text": "never passed through"}],
    BEFORE_D121[-1],
]


def test_the_server_only_writes_paths_of_the_message_model() -> None:
    deltas = _translate(EVERY_KIND)
    assert _all_paths(deltas) <= chat_stream.MESSAGE_PATHS
    assert {d.o for d in deltas} <= chat_stream.OPERATIONS
    for path in _all_paths(deltas):
        assert not set(path.split("/")) & chat_stream.UNSAFE_SEGMENTS
    # An unknown kind of event is skipped, never forwarded.
    assert "never passed through" not in json.dumps([d.full() for d in deltas])


def test_metadata_of_the_answer_holds_knowledge_approvals_and_connections() -> None:
    applier = Applier()
    applier.encoding("v1")
    compressor = chat_stream.Compressor()
    for delta in _translate(EVERY_KIND):
        applier.delta(compressor.short(delta))
    meta = applier.channels[0]["metadata"]
    assert meta["knowledge"] == [{"knowledge_bases": ["kb"], "count": 1, "sources": []}]
    assert meta["approvals"] == [{"approval_id": "a" * 32, "tool": "create_ticket"}]
    assert meta["connection_required"] == ["r" * 26]
    # A refused call whose start was not seen is said all the same, with its result.
    refused = [d for d in applier.channels.values() if d.get("recipient") == "create_ticket"]
    assert refused[0]["status"] == "error"


def test_text_of_the_model_only_ever_goes_in_v() -> None:
    hostile = [
        ["conversation", {"conversation_id": "c" * 32}],
        ["delta", {"text": '/__proto__/polluted {"p":"/constructor"}'}],
        ["error", {"code": "upstream_error", "message": "the agent failed"}],
    ]
    deltas = _translate(hostile)
    assert _all_paths(deltas) <= chat_stream.MESSAGE_PATHS
    applier = Applier()
    applier.encoding("v1")
    for delta in deltas:
        applier.delta(delta.full())
    assert applier.channels[0]["content"]["text"].startswith("/__proto__/polluted")
    assert applier.channels[0]["status"] == "error"


# --- The reference applier (R4 builds the web's) ----------------------------------------


@pytest.mark.parametrize("segment", ["__proto__", "constructor", "prototype"])
def test_the_applier_refuses_dangerous_segments_and_changes_nothing(segment: str) -> None:
    applier = Applier()
    applier.encoding("v1")
    applier.delta({"c": 0, "p": "", "o": "add", "v": {"metadata": {}}})
    before = json.dumps(applier.channels)
    for path in (f"/{segment}/x", f"/metadata/{segment}", f"/metadata/{segment}/polluted"):
        with pytest.raises(DeltaError, match="Unsafe"):
            applier.delta({"p": path, "o": "replace", "v": 1})
    with pytest.raises(DeltaError, match="Unsafe"):
        applier.delta({"p": "/metadata", "o": "append", "v": {segment: 1}})
    with pytest.raises(DeltaError, match="Unsafe"):
        applier.delta({"p": "", "o": "patch", "v": [{"p": f"/{segment}", "o": "add", "v": 1}]})
    assert json.dumps(applier.channels) == before


def test_the_applier_inherits_c_p_and_o_but_never_v() -> None:
    applier = Applier()
    with pytest.raises(DeltaError, match="before delta_encoding"):
        applier.delta({"c": 0, "p": "", "o": "add", "v": {}})
    with pytest.raises(DeltaError, match="unknown delta encoding"):
        applier.encoding("v2")
    applier.encoding("v1")
    applier.delta({"v": {"content": {"text": ""}, "list": [1, 2, 3]}})
    applier.delta({"p": "/content/text", "o": "append", "v": "Ho"})
    applier.delta({"v": "la"})
    with pytest.raises(DeltaError, match="never inherited"):
        applier.delta({"p": "/content/text"})
    applier.delta({"o": "truncate", "v": 3})
    applier.delta({"p": "/list", "v": 1})
    applier.delta({"o": "add", "p": "/list/0", "v": 0})
    with pytest.raises(DeltaError, match="Unknown"):
        applier.delta({"o": "merge", "v": 1})
    assert applier.channels[0] == {"content": {"text": "Hol"}, "list": [0, 1]}


# --- Resumption -------------------------------------------------------------------------


def test_a_resumed_stream_neither_repeats_nor_loses_a_delta() -> None:
    h = Harness()
    client = h.client()
    _cid, turn_id = _turn(client)
    full = _stream(client, turn_id).text
    reference = _documents(full).channels
    total = len([e for e in parse(full) if e[0] == "delta"])
    assert total > 5
    for after in range(total + 1):
        applier = Applier()
        # What the client had applied before the cut, then a new connection.
        first = full.split(f"id: {after + 1}\n", 1)[0] if after < total else full
        events = feed(applier, first)
        assert applier.last_id == after
        if after < total:
            assert not applier.done
        resumed = _stream(client, turn_id, after=after)
        assert resumed.status_code == 200
        again = feed(applier, resumed.text)
        ids = [e[2] for e in again if e[0] == "delta"]
        assert ids == list(range(after + 1, total + 1))
        # Each connection starts with every field of its first delta.
        deltas = [e[1] for e in again if e[0] == "delta"]
        if deltas:
            assert {"c", "p", "o", "v"} <= set(deltas[0])
        assert applier.channels == reference, after
        assert applier.done
        assert events[0][0] == "delta_encoding"


def test_the_stream_of_a_turn_that_never_started_says_its_error(
    log: MemoryTurnLog,
) -> None:
    h = Harness()
    h.budgets.exceed = True
    client = h.client()
    _cid, turn_id = _turn(client)
    _until(
        lambda: (s := log.status("user-1", turn_id)) is not None and s.state in {TurnState.FAILED}
    )
    docs = _documents(_stream(client, turn_id).text)
    assert docs.done
    answer = docs.channels[0]
    assert answer["status"] == "error"
    assert answer["metadata"]["error"] == {
        "status": 402,
        "code": "budget_exceeded",
        "message": "monthly AI budget exhausted",
    }


def test_a_queued_turn_nobody_takes_is_given_up_by_its_reader(
    log: MemoryTurnLog, monkeypatch: pytest.MonkeyPatch
) -> None:
    h = Harness()
    client = h.client()
    monkeypatch.setattr(turns_module.LocalTurnSender, "send", lambda _self, _body: None)
    monkeypatch.setattr(turns_module, "PICKUP_SECONDS", -1)
    _cid, turn_id = _turn(client)
    docs = _documents(_stream(client, turn_id).text)
    assert docs.channels[0]["metadata"]["error"]["code"] == "agent_unavailable"
    status = log.status("user-1", turn_id)
    assert status is not None
    assert status.state == TurnState.FAILED


# --- Only the owner (TM-TW3) ------------------------------------------------------------


def test_another_person_gets_the_same_404_as_for_a_turn_that_does_not_exist() -> None:
    h = Harness()
    client = h.client()
    _cid, turn_id = _turn(client)
    assert _stream(client, turn_id).status_code == 200
    missing = "0" * 32
    answers = [
        _stream(client, turn_id, token="named"),
        _stream(client, missing),
        _stream(client, "not-a-turn"),
        client.post(f"/api/chat/turns/{turn_id}/cancel", headers=_auth("named")),
        client.post(f"/api/chat/turns/{missing}/cancel", headers=_auth()),
    ]
    assert {r.status_code for r in answers} == {404}
    assert len({r.text for r in answers}) == 1
    assert client.get(f"/api/chat/turns/{turn_id}/stream").status_code == 401


def test_the_owner_is_decided_by_cedar_and_audited_and_a_denial_is_a_404() -> None:
    h = Harness()
    client = h.client()
    conversation_id, turn_id = _turn(client)
    assert _stream(client, turn_id).status_code == 200
    decisions = [
        d
        for e, d in zip(h.audit.events, h.audit.details, strict=True)
        if e == "policy.decision" and d["action"] == "OwnConversation"
    ]
    assert decisions == [
        {
            "action": "OwnConversation",
            "resource": f"Mango::Conversation::{conversation_id}",
            "allowed": True,
            "read_only": True,
            "conversation_id": conversation_id,
            "turn": turn_id,
        }
    ]
    # The owner comes from the turn's record, never from the request.
    owned = h.authorizer.resources[-1]
    assert (owned.conversation_id, owned.owner) == (conversation_id, "user-1")
    h.authorizer.allow = False
    denied = [
        _stream(client, turn_id),
        client.post(f"/api/chat/turns/{turn_id}/cancel", headers=_auth()),
    ]
    assert [r.status_code for r in denied] == [404, 404]
    assert denied[0].text == _stream(client, "0" * 32).text
    last = [
        d for e, d in zip(h.audit.events, h.audit.details, strict=True) if e == "policy.decision"
    ]
    assert [(d["allowed"], d["read_only"]) for d in last[-2:]] == [(False, True), (False, False)]
    assert _stream(client, turn_id, after=-1).status_code == 422


def test_reconnecting_in_a_loop_is_limited_per_person() -> None:
    h = Harness()
    client = h.client()
    _cid, turn_id = _turn(client)
    answers = [_stream(client, turn_id).status_code for _ in range(61)]
    assert answers[:60] == [200] * 60
    assert answers[60] == 429


# --- «Detener» (D121 (7)) ---------------------------------------------------------------


def _held_stream(gate: threading.Event) -> Iterator[dict[str, Any]]:
    yield {"contentBlockStart": {"contentBlockIndex": 0, "start": {}}}
    yield {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "Hola "}}}
    gate.wait(10)
    yield {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "mundo"}}}
    yield {"messageStop": {"stopReason": "end_turn"}}
    yield {"metadata": {"usage": {"inputTokens": 1000, "outputTokens": 100}}}


def test_the_owner_stops_a_turn_charged_in_full_and_the_next_one_is_a_new_session(
    log: MemoryTurnLog,
) -> None:
    h = Harness()
    gate = threading.Event()
    original = h.agentcore.invoke_harness
    calls = {"n": 0}

    def invoke(**request: Any) -> dict[str, Any]:
        calls["n"] += 1
        if calls["n"] == 1:
            h.agentcore.requests.append(request)
            return {"stream": _held_stream(gate)}
        return original(**request)

    h.agentcore.invoke_harness = invoke  # type: ignore[method-assign]
    client = h.client()
    _cid, turn_id = _turn(client, conversation_id=CONVERSATION)
    _until(lambda: any(e.kind == "delta" for e in log.events("user-1", turn_id, 0)))
    try:
        stopped = client.post(f"/api/chat/turns/{turn_id}/cancel", headers=_auth())
    finally:
        gate.set()
    assert stopped.status_code == 200
    assert stopped.json() == {"turn_id": turn_id, "state": "interrupted", "cancelled": True}
    # The worker reads its agent to the end and settles what it really cost.
    _until(lambda: bool(h.budgets.settled))
    assert h.budgets.held == []
    assert h.budgets.settled[0][1] > 0
    # Its answer, which the person stopped, is not stored; nothing after «Detener» is written.
    _until(lambda: not any(t.name == "chat-turn" for t in threading.enumerate()))
    assert [role for _u, role, _c in h.conversations.stored] == ["user"]
    kinds = [e.kind for e in log.events("user-1", turn_id, 0)]
    assert kinds[-1] == "error"
    assert "done" not in kinds
    status = log.status("user-1", turn_id)
    assert status is not None
    assert status.state == TurnState.INTERRUPTED

    docs = _documents(_stream(client, turn_id).text)
    answer = docs.channels[0]
    assert answer["status"] == "interrupted"
    assert answer["content"]["text"] == "Hola "
    assert answer["metadata"]["error"] == chat_stream.CANCELLED
    assert docs.done

    # Audited without content.
    audited = [
        d for e, d in zip(h.audit.events, h.audit.details, strict=True) if e == "agent.cancelled"
    ]
    assert audited == [
        {
            "conversation_id": CONVERSATION,
            "turn": turn_id,
            "cancelled": True,
            "state": "interrupted",
        }
    ]
    assert "hola" not in json.dumps(audited).lower()

    # Idempotent, and the next question goes in a new session (D121 (7)).
    again = client.post(f"/api/chat/turns/{turn_id}/cancel", headers=_auth())
    assert again.json() == {"turn_id": turn_id, "state": "interrupted", "cancelled": False}
    _cid, second = _turn(client, conversation_id=CONVERSATION)
    assert _documents(_stream(client, second).text).channels[0]["status"] == "finished"
    one, two = h.agentcore.requests
    assert two["runtimeSessionId"] != one["runtimeSessionId"]


def test_stopping_a_turn_that_already_ended_changes_nothing() -> None:
    h = Harness()
    client = h.client()
    _cid, turn_id = _turn(client)
    assert _documents(_stream(client, turn_id).text).channels[0]["status"] == "finished"
    response = client.post(f"/api/chat/turns/{turn_id}/cancel", headers=_auth())
    assert response.status_code == 200
    assert response.json() == {"turn_id": turn_id, "state": "done", "cancelled": False}
    assert _documents(_stream(client, turn_id).text).channels[0]["status"] == "finished"


def test_a_turn_stopped_while_queued_never_runs(
    log: MemoryTurnLog, monkeypatch: pytest.MonkeyPatch
) -> None:
    queue = QueueDouble(deliver=False)
    monkeypatch.setattr(turns_module, "LocalTurnSender", lambda: queue)
    h = Harness()
    client = h.client()
    _cid, turn_id = _turn(client)
    response = client.post(f"/api/chat/turns/{turn_id}/cancel", headers=_auth())
    assert response.json() == {"turn_id": turn_id, "state": "interrupted", "cancelled": True}
    # Delivered after all: the turn is not queued any more, so nothing runs nor is charged.
    queue.run(queue.bodies[0])
    assert h.agentcore.requests == []
    assert h.budgets.reserved == []
    docs = _documents(_stream(client, turn_id).text)
    assert docs.channels[0]["status"] == "interrupted"
    assert docs.channels[0]["content"]["text"] == ""


# --- The reader's polling and keep-alive ------------------------------------------------


def test_the_reader_backs_off_to_a_second_without_losing_the_start() -> None:
    now = [0.0]
    backoff = turns_module.ReadBackoff(clock=lambda: now[0])
    # The first seconds always at the shortest wait.
    assert [backoff.wait() for _ in range(5)] == [0.25] * 5
    now[0] = 2.5
    waits = [backoff.wait() for _ in range(6)]
    assert waits[0] == 0.25
    assert waits == sorted(waits)
    assert waits[-1] == turns_module.READ_POLL_MAX_SECONDS == 1.0
    backoff.seen()
    assert backoff.wait() == 0.25


def test_the_heartbeat_is_below_the_read_timeout_of_the_api_origin() -> None:
    edge = (ROOT / "infra/lib/constructs/edge.ts").read_text()
    origin = edge[edge.index("VpcOrigin.withApplicationLoadBalancer") :]
    read_timeout = int(re.search(r"readTimeout: Duration\.seconds\((\d+)\)", origin)[1])  # type: ignore[index]
    assert read_timeout >= turns_module.HEARTBEAT_SECONDS * 2


# --- The record (moto) ------------------------------------------------------------------


@pytest.fixture
def table() -> Iterator[Any]:
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


def test_the_record_knows_its_last_event_and_its_conversation(table: Any) -> None:
    log = DynamoTurnLog(lambda _u: table, "conv")
    turn = "b" * 32
    log.create("user-1", CONVERSATION, turn, deadline=10)
    assert log.last_seq("user-1", turn) == 0
    for seq in range(1, 12):
        assert log.append("user-1", turn, seq, "delta", {"text": str(seq)})
    log.create("user-1", CONVERSATION, "c" * 32, deadline=10)
    log.append("user-1", "c" * 32, 40, "delta", {"text": "other turn"})
    assert log.last_seq("user-1", turn) == 11
    status = log.status("user-1", turn)
    assert status == TurnStatus(TurnState.QUEUED, 10, None, CONVERSATION, "user-1")
    # Nothing of another person's partition.
    assert log.last_seq("user-2", turn) == 0
    assert log.status("user-2", turn) is None
