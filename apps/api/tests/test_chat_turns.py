"""The chat turn outside the request (D121): what the web receives, the claim, the queue
message, cuts, and the token (TM-TW1, TW2, TW5, TW7, TW9)."""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

import boto3
import pytest
from botocore.exceptions import ReadTimeoutError
from fastapi import HTTPException
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api import turns as turns_module
from mango_api.conversations import ConversationRepository
from mango_api.turns_store import DynamoTurnLog, MemoryTurnLog, TurnLog, TurnState
from mango_api.web import ApiError

from .test_app import HOST, TOKENS, Harness, _auth, _events, served

CONVERSATION = "a" * 32
SECRET = "eyJ-secret-access-token-of-the-person"
"""A token value that must never appear in a log line, an audit event or the table."""

# The events of a turn, as POST /api/chat streamed them before D121 (captured from the code
# that ran the turn inside the request, for the default script of ``FakeAgentCore``).
BEFORE_D121 = [
    ["conversation", {"conversation_id": "<cid>"}],
    ["status", {"phase": "thinking"}],
    ["status", {"phase": "writing"}],
    ["delta", {"text": "Hola "}],
    ["delta", {"text": "\n\n"}],
    ["tool", {"name": "get_cost_and_usage", "status": "started"}],
    ["status", {"phase": "tool", "tool": "get_cost_and_usage"}],
    ["tool", {"name": "get_cost_and_usage", "status": "completed"}],
    ["status", {"phase": "tool_result"}],
    ["status", {"phase": "writing"}],
    ["delta", {"text": "mundo"}],
    [
        "done",
        {
            "message_id": "m" * 32,
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1000, "output_tokens": 100},
            "cost_usd": "0.0045",
            "remote_sources": [],
        },
    ],
]
FAILED_BEFORE_D121 = [
    ["conversation", {"conversation_id": "<cid>"}],
    ["status", {"phase": "thinking"}],
    ["error", {"code": "upstream_error", "message": "the agent failed"}],
]


@dataclass
class QueueDouble:
    """Stands for ``Mango-<ns>-ChatTurns``: keeps every body and hands it to the worker's
    handler in a thread, after ``meanwhile`` (what happens while the turn waits)."""

    deliver: bool = True
    meanwhile: Callable[[], None] = lambda: None
    bodies: list[str] = field(default_factory=list)
    acks: list[str] = field(default_factory=list)
    handler: Callable[[str, Callable[[], None]], None] | None = None

    def bind(self, handler: Callable[[str, Callable[[], None]], None]) -> None:
        self.handler = handler

    def send(self, body: str) -> None:
        self.bodies.append(body)
        if self.deliver:
            threading.Thread(target=self.run, args=(body,), daemon=True).start()

    def run(self, body: str) -> None:
        self.meanwhile()
        assert self.handler is not None
        self.handler(body, lambda: self.acks.append(body))


@pytest.fixture
def queue(monkeypatch: pytest.MonkeyPatch) -> QueueDouble:
    double = QueueDouble()
    monkeypatch.setattr(turns_module, "LocalTurnSender", lambda: double)
    return double


@pytest.fixture
def log(monkeypatch: pytest.MonkeyPatch) -> MemoryTurnLog:
    shared = MemoryTurnLog()
    monkeypatch.setattr(app_module, "MemoryTurnLog", lambda: shared)
    return shared


def _normalized(body: str) -> list[list[Any]]:
    out = []
    for kind, raw in _events(body):
        data = raw
        if kind == "conversation":
            data = {"conversation_id": "<cid>"}
        elif kind == "done":
            # Random, generated before the message is stored (its id goes in ``done`` first).
            assert re.fullmatch(r"[0-9a-f]{32}", raw["message_id"])
            data = {**raw, "message_id": "m" * 32}
        out.append([kind, data])
    return out


def _chat(h: Harness, token: str = "good", **body: Any) -> Any:
    return h.client().post("/api/chat", headers=_auth(token), json={"message": "hola", **body})


def _message(queue: QueueDouble) -> dict[str, Any]:
    return dict(json.loads(queue.bodies[-1]))


# --- What the web receives --------------------------------------------------------------


def test_the_web_receives_exactly_the_events_it_received_before() -> None:
    response = _chat(Harness())
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-store"
    assert _normalized(response.text) == BEFORE_D121


def test_a_failed_turn_ends_with_the_same_events_as_before() -> None:
    h = Harness()
    h.agentcore.fail = True
    assert _normalized(_chat(h).text) == FAILED_BEFORE_D121


def test_the_events_are_numbered_from_one_in_the_turns_record(
    queue: QueueDouble, log: MemoryTurnLog
) -> None:
    response = _chat(Harness())
    turn_id = _message(queue)["turn_id"]
    events = log.events("user-1", turn_id, 0)
    assert [e.seq for e in events] == list(range(1, len(BEFORE_D121) + 1))
    assert [[e.kind, e.data] for e in events] == [[k, d] for k, d in _events(response.text)]
    status = log.status("user-1", turn_id)
    assert status is not None
    assert status.state == TurnState.DONE


def test_an_error_before_the_stream_is_the_same_http_error_as_before() -> None:
    h = Harness()
    h.budgets.exceed = True
    response = _chat(h)
    assert response.status_code == 402
    assert response.json() == {
        "error": {"code": "budget_exceeded", "message": "monthly AI budget exhausted"}
    }


# --- The queue message ------------------------------------------------------------------


def test_the_message_follows_the_contract_of_phase_one(queue: QueueDouble) -> None:
    _chat(Harness(), conversation_id=CONVERSATION)
    message = _message(queue)
    assert set(message) == {
        "v",
        "turn_id",
        "conversation_id",
        "agent_id",
        "owner_sub",
        "model",
        "message",
        "access_token",
        "token_exp",
        "signature_context",
        "enqueued_at",
    }
    assert message["v"] == 1
    assert (message["conversation_id"], message["owner_sub"]) == (CONVERSATION, "user-1")
    assert message["access_token"] == "good"
    assert message["token_exp"] == TOKENS["good"]["exp"]
    assert message["signature_context"] == {
        "agent_id": "finops",
        "agent_version": 3,
        "tools": ["finops___get_cost_and_usage", "finops___list_accounts_in_scope"],
        "knowledge_bases": [],
    }
    # Deleted once claimed: the token leaves the queue at once (TM-TW1).
    assert queue.acks == queue.bodies


def test_the_token_is_never_shown_by_the_message_model() -> None:
    body = {
        "v": 1,
        "turn_id": "b" * 32,
        "conversation_id": CONVERSATION,
        "agent_id": "finops",
        "owner_sub": "user-1",
        "model": "us.anthropic.claude-sonnet-4-6",
        "message": "hola",
        "access_token": SECRET,
        "token_exp": 1,
        "signature_context": {
            "agent_id": "finops",
            "agent_version": 1,
            "tools": [],
            "knowledge_bases": [],
        },
        "enqueued_at": 1,
    }
    message = turns_module.TurnMessage.model_validate_json(json.dumps(body))
    assert SECRET not in repr(message)
    assert SECRET not in str(message)
    assert SECRET not in message.model_dump_json()


# --- The claim (TM-TW5) -----------------------------------------------------------------


def test_a_message_delivered_twice_runs_its_turn_once(queue: QueueDouble) -> None:
    h = Harness()
    assert _chat(h).status_code == 200
    assert queue.handler is not None
    queue.handler(queue.bodies[0], lambda: queue.acks.append("again"))
    assert len(h.agentcore.requests) == 1
    assert [role for _, role, _ in h.conversations.stored] == ["user", "assistant"]
    assert len(h.budgets.reserved) == 1
    # The second delivery is deleted too: it never runs, never waits for another receive.
    assert queue.acks[-1] == "again"


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


def test_only_one_of_many_workers_claims_a_turn(table: Any) -> None:
    log = DynamoTurnLog(lambda _u: table, "conv")
    log.create("user-1", CONVERSATION, "c" * 32, deadline=int(time.time()) + 30)
    start = threading.Barrier(8)
    won: list[bool] = []

    def claim(n: int) -> None:
        start.wait()
        won.append(log.claim("user-1", "c" * 32, worker=f"w{n}", deadline=0))

    threads = [threading.Thread(target=claim, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(won) == [False] * 7 + [True]
    status = log.status("user-1", "c" * 32)
    assert status is not None
    assert status.state == TurnState.RUNNING


@pytest.mark.parametrize("make", [MemoryTurnLog, "dynamo"])
def test_the_state_only_moves_from_where_it_is(make: Any, table: Any) -> None:
    log: TurnLog = DynamoTurnLog(lambda _u: table, "conv") if make == "dynamo" else make()
    turn = "d" * 32
    log.create("user-1", CONVERSATION, turn, deadline=10)
    running = frozenset({TurnState.RUNNING})
    # Not running yet: neither the worker nor anybody else can end it as a running turn.
    assert not log.end("user-1", turn, TurnState.DONE, were=running)
    assert log.claim("user-1", turn, worker="w", deadline=20)
    assert not log.claim("user-1", turn, worker="w2", deadline=20)
    # From outside the worker (a stalled turn, «Cancelar» in R3).
    assert log.end("user-1", turn, TurnState.INTERRUPTED, were=running)
    # The worker that comes back later does not overwrite it.
    assert not log.end("user-1", turn, TurnState.DONE, were=running)
    status = log.status("user-1", turn)
    assert status is not None
    assert status.state == TurnState.INTERRUPTED
    assert log.append("user-1", turn, 1, "conversation", {"conversation_id": CONVERSATION})
    assert not log.append("user-1", turn, 1, "error", {})
    assert [e.kind for e in log.events("user-1", turn, 0)] == ["conversation"]


def test_the_records_of_a_turn_expire_and_stay_in_the_persons_partition(table: Any) -> None:
    log = DynamoTurnLog(lambda _u: table, "conv")
    log.create("user-1", CONVERSATION, "e" * 32, deadline=1)
    log.append("user-1", "e" * 32, 1, "delta", {"text": "x"})
    items = table.scan(TableName="conv")["Items"]
    assert {i["SK"]["S"] for i in items} == {
        f"TURN#{'e' * 32}#STATE",
        f"TURN#{'e' * 32}#EVT#00000001",
    }
    assert {i["PK"]["S"] for i in items} == {"USER#user-1"}
    for item in items:
        assert 0 < int(item["ttl"]["N"]) - time.time() <= 4 * 3600


def test_a_turn_nobody_takes_in_time_is_given_up_and_never_runs_later(
    queue: QueueDouble, log: MemoryTurnLog, monkeypatch: pytest.MonkeyPatch
) -> None:
    queue.deliver = False
    monkeypatch.setattr(turns_module, "PICKUP_SECONDS", -1)
    h = Harness()
    response = _chat(h)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "agent_unavailable"
    status = log.status("user-1", _message(queue)["turn_id"])
    assert status is not None
    assert status.state == TurnState.FAILED
    # Delivered after all: the request gave it up, so nothing runs and nothing is charged.
    queue.run(queue.bodies[0])
    assert h.agentcore.requests == []
    assert h.budgets.reserved == []


# --- What the worker checks again (TM-TW2, TM-TW9) --------------------------------------


def test_a_token_that_expires_while_the_turn_waits_never_reserves_nor_invokes(
    queue: QueueDouble, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Accepted on receipt; when the worker takes it, 30 s are left for a 300 s turn.
    queue.meanwhile = lambda: monkeypatch.setitem(
        TOKENS, "good", {**TOKENS["good"], "exp": int(time.time()) + 30}
    )
    h = Harness()
    response = _chat(h)
    assert response.status_code == 401
    assert response.json()["error"]["message"] == "token about to expire; sign in again"
    assert h.budgets.reserved == []
    assert h.agentcore.requests == []


def test_a_person_who_loses_the_agent_while_the_turn_waits_is_refused(
    queue: QueueDouble,
) -> None:
    h = Harness()
    queue.meanwhile = lambda: setattr(h.authorizer, "allow", False)
    response = _chat(h)
    assert response.status_code == 403
    assert h.budgets.reserved == []
    assert h.agentcore.requests == []
    decisions = [
        d for e, d in zip(h.audit.events, h.audit.details, strict=True) if e == "policy.decision"
    ]
    assert [d["allowed"] for d in decisions] == [True, False]
    assert decisions[1]["via"] == "turn-worker"
    assert decisions[0]["turn"] == decisions[1]["turn"]


def test_an_agent_changed_while_the_turn_waits_is_not_run(queue: QueueDouble) -> None:
    h = Harness()

    def publish_another_version() -> None:
        h.published.agents["finops"] = served(version=4)

    queue.meanwhile = publish_another_version
    response = _chat(h)
    assert response.status_code == 503
    assert h.agentcore.requests == []
    assert h.budgets.reserved == []


def test_a_message_whose_token_is_not_its_owners_writes_nothing(
    queue: QueueDouble, log: MemoryTurnLog
) -> None:
    h = Harness()
    assert _chat(h).status_code == 200
    forged = {**_message(queue), "turn_id": "f" * 32, "access_token": "named"}
    log.create("user-1", CONVERSATION, "f" * 32, deadline=int(time.time()) + 30)
    queue.run(json.dumps(forged))
    assert len(h.agentcore.requests) == 1
    status = log.status("user-1", "f" * 32)
    assert status is not None
    assert status.state == TurnState.QUEUED
    assert log.status("user-3", "f" * 32) is None


# --- A cut in the middle (D73, D121 (7)) ------------------------------------------------


def _cut() -> Iterator[dict[str, Any]]:
    yield {"contentBlockStart": {"contentBlockIndex": 0, "start": {}}}
    yield {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "Hola "}}}
    raise ReadTimeoutError(endpoint_url="https://agentcore.invalid")


def test_a_turn_cut_in_the_middle_is_interrupted_and_the_next_one_starts_a_new_session(
    queue: QueueDouble, log: MemoryTurnLog
) -> None:
    h = Harness()
    original = h.agentcore.invoke_harness
    calls = {"n": 0}

    def invoke(**request: Any) -> dict[str, Any]:
        calls["n"] += 1
        if calls["n"] == 1:
            h.agentcore.requests.append(request)
            return {"stream": _cut()}
        return original(**request)

    h.agentcore.invoke_harness = invoke  # type: ignore[method-assign]
    first = _chat(h, conversation_id=CONVERSATION)
    kinds = [k for k, _ in _events(first.text)]
    assert kinds[0] == "conversation"
    assert kinds[-1] == "error"
    status = log.status("user-1", _message(queue)["turn_id"])
    assert status is not None
    assert status.state == TurnState.INTERRUPTED
    # The reservation stays held for the reconciler (D73).
    assert h.budgets.held
    assert not h.budgets.settled
    # The session of the cut turn holds an answer nobody saw: never continued.
    second = _chat(h, conversation_id=CONVERSATION)
    assert second.status_code == 200
    one, two = h.agentcore.requests
    assert two["runtimeSessionId"] != one["runtimeSessionId"]
    texts = [m["content"][0]["text"] for m in two["messages"]]
    assert texts == ["hola", "hola"]


def test_a_stalled_turn_is_interrupted_by_its_reader(
    queue: QueueDouble, log: MemoryTurnLog, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The worker died after it started the stream (SIGKILL): the request does not wait for
    ever, and the turn ends interrupted."""
    h = Harness()
    gate = threading.Event()

    def hang(**request: Any) -> dict[str, Any]:
        h.agentcore.requests.append(request)
        gate.wait(10)
        raise RuntimeError("killed")

    h.agentcore.invoke_harness = hang  # type: ignore[method-assign]
    monkeypatch.setattr(turns_module, "MAX_TURN_SECONDS", -2)
    monkeypatch.setattr(turns_module, "SETTLE_SECONDS", 0)
    monkeypatch.setattr(turns_module, "STATE_POLL_SECONDS", 0.05)
    try:
        response = _chat(h)
    finally:
        gate.set()
    events = _events(response.text)
    assert events[-1] == ("error", {"code": "upstream_error", "message": "the agent failed"})
    turn_id = _message(queue)["turn_id"]
    status = log.status("user-1", turn_id)
    assert status is not None
    assert status.state == TurnState.INTERRUPTED


# --- The token is never stored nor logged (TM-TW1, TM-TW7) ------------------------------


def test_the_token_is_never_in_the_table_the_audit_or_the_logs(
    table: Any,
    queue: QueueDouble,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setitem(TOKENS, SECRET, TOKENS["good"])
    monkeypatch.setattr(
        app_module,
        "MemoryTurnLog",
        lambda: DynamoTurnLog(lambda _u: table, "conv", poll_seconds=0.01),
    )
    h = Harness(conversations=ConversationRepository(lambda _u: table, "conv"))  # type: ignore[arg-type]
    caplog.set_level(logging.DEBUG)
    ok = _chat(h, token=SECRET)
    assert ok.status_code == 200
    assert [k for k, _ in _events(ok.text)][-1] == "done"
    h.agentcore.fail = True
    failed = _chat(h, token=SECRET)
    assert [k for k, _ in _events(failed.text)][-1] == "error"
    # A message that does not validate is logged by its field names only.
    assert queue.handler is not None
    queue.handler(json.dumps({**_message(queue), "v": 2}), lambda: None)
    queue.handler(json.dumps({**_message(queue), "message": ""}), lambda: None)

    items = json.dumps(table.scan(TableName="conv")["Items"])
    assert "TURN#" in items
    assert "MSG#" in items
    assert SECRET not in items
    assert SECRET not in json.dumps(h.audit.details, default=str)
    assert SECRET not in caplog.text
    assert "did not validate: message" in caplog.text


# --- Shared by mango-api and the worker -------------------------------------------------


def test_a_rejection_is_raised_as_the_same_error() -> None:
    with pytest.raises(ApiError) as api:
        turns_module.raise_rejection({"status": 409, "code": "conversation_busy", "message": "m"})
    assert (api.value.status, api.value.code) == (409, "conversation_busy")
    with pytest.raises(HTTPException) as http:
        turns_module.raise_rejection({"status": 403, "detail": "not allowed"})
    assert (http.value.status_code, http.value.detail) == (403, "not allowed")
    with pytest.raises(RuntimeError):
        turns_module.raise_rejection(turns_module.INTERNAL_REJECTION)
    with pytest.raises(ApiError):
        turns_module.raise_rejection(None)


def test_cost_reserved_is_released_when_the_turn_cannot_start_in_the_worker() -> None:
    h = Harness()
    h.conversations.fail_writes = True
    client = TestClient(h.client().app, base_url=f"http://{HOST}", raise_server_exceptions=False)
    response = client.post("/api/chat", headers=_auth(), json={"message": "hola"})
    assert response.status_code == 500
    assert h.budgets.settled == [(h.budgets.reserved[0], Decimal(0))]
