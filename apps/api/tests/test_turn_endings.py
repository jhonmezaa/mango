"""Every way a chat turn ends: what is charged, what stays held and what is left for the
budget reconciler (D73). The budget is the real ``BudgetService`` on a DynamoDB double.

Rows of the table in ``docs/architecture/decisions/D073-…``:

1. ends well · 2. no budget · 3. cannot start · 4. asks to confirm a write tool ·
5. guardrail · 6. the harness reports an error · 7. mango-api stops reading ·
8. the person leaves · 9. the task dies · 10. the settlement fails · 11. the title.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

import boto3
import pytest
from botocore.exceptions import EventStreamError, ReadTimeoutError
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api import harness as harness_module
from mango_api.budget import BudgetService, current_period
from mango_api.settings import Settings
from mango_core import budget_turns
from mango_core.budget_turns import STATE_HELD, STATE_OPEN, PendingTurn

from .harness_wire import wire_stream
from .test_app import (
    HOST,
    KEY,
    FakeAudit,
    FakeAuthorizer,
    FakeConversations,
    FakeLimits,
    FakeModelCatalog,
    FakePublished,
    FakeVerifier,
    _auth,
    _events,
    _settings,
)
from .test_approvals import GATEWAY_TOOL, write_agent

TABLE = "budgets"
USER, AGENT = "USER#user-1", "AGENT#finops"
CONVERSATION = "a" * 32
# 1000 input and 100 output tokens of the default model (3 and 15 USD per million).
CALL = {"metadata": {"usage": {"inputTokens": 1000, "outputTokens": 100}}}
CALL_COST = Decimal("0.0045")
TEXT = {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "Hola"}}}
END = {"messageStop": {"stopReason": "end_turn"}}
TOOL_USE = {"messageStop": {"stopReason": "tool_use"}}


def _cut(*events: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """A stream mango-api stops reading: 60 s without an event, a dropped connection."""
    yield from events
    raise ReadTimeoutError(endpoint_url="https://agentcore.invalid")


@dataclass
class ScriptedAgentCore:
    stream: Callable[[], Any] = lambda: [TEXT, END, CALL]
    refuse: bool = False
    before: Callable[[], None] = lambda: None
    requests: list[dict[str, Any]] = field(default_factory=list)

    def invoke_harness(self, **request: Any) -> dict[str, Any]:
        self.requests.append(request)
        self.before()
        if self.refuse:
            raise RuntimeError("could not reach AgentCore")
        return {"stream": self.stream()}


@dataclass
class ScriptedBedrock:
    calls: int = 0

    def converse(self, **_kw: Any) -> dict[str, Any]:
        self.calls += 1
        return {
            "output": {"message": {"content": [{"text": "Título"}]}},
            "usage": {"inputTokens": 200, "outputTokens": 10},
        }


@dataclass
class Env:
    db: Any
    budgets: BudgetService
    agentcore: ScriptedAgentCore = field(default_factory=ScriptedAgentCore)
    conversations: FakeConversations = field(default_factory=FakeConversations)
    audit: FakeAudit = field(default_factory=FakeAudit)
    limits: FakeLimits = field(default_factory=FakeLimits)
    published: FakePublished = field(default_factory=FakePublished)
    bedrock: ScriptedBedrock = field(default_factory=ScriptedBedrock)
    """The auxiliary model: only the title of a new conversation calls it."""
    seen: list[PendingTurn] = field(default_factory=list)
    """The pending records as they were when the agent was invoked."""

    def __post_init__(self) -> None:
        self.agentcore.before = lambda: self.seen.extend(self.records())

    def client(self) -> TestClient:
        def factory(settings: Settings) -> app_module.Services:
            return app_module.Services(
                settings=settings,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=FakeAuthorizer(),  # type: ignore[arg-type]
                budgets=self.budgets,
                conversations=self.conversations,  # type: ignore[arg-type]
                audit=self.audit,  # type: ignore[arg-type]
                agentcore=self.agentcore,
                bedrock=self.bedrock,
                settings_store=None,  # type: ignore[arg-type]
                budget_limits=self.limits,  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=self.published,  # type: ignore[arg-type]
                model_catalog=FakeModelCatalog(),  # type: ignore[arg-type]
                invocation_key=KEY,
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        return TestClient(asgi, base_url=f"http://{HOST}", raise_server_exceptions=False)  # type: ignore[arg-type]

    def chat(self, conversation_id: str | None = CONVERSATION) -> Any:
        body = {
            "message": "hola",
            **({"conversation_id": conversation_id} if conversation_id else {}),
        }
        return self.client().post("/api/chat", headers=_auth(), json=body)

    def records(self) -> list[PendingTurn]:
        return [
            PendingTurn.from_item(item)
            for item in self.db.scan(TableName=TABLE)["Items"]
            if item["PK"]["S"].startswith(budget_turns.TURN_PREFIX)
        ]

    def budget(self, scope: str = USER) -> dict[str, Decimal]:
        item = self.db.get_item(
            TableName=TABLE, Key={"PK": {"S": scope}, "SK": {"S": current_period()}}
        ).get("Item", {})
        return {
            name: Decimal(item.get(name, {}).get("N", "0"))
            for name in ("spent", "reserved", "committed", "held")
        }

    def completed(self) -> dict[str, Any]:
        return next(
            detail
            for event, detail in zip(self.audit.events, self.audit.details, strict=True)
            if event == "agent.completed"
        )


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        db.create_table(
            TableName=TABLE,
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
        yield Env(db=db, budgets=BudgetService(db, TABLE, sleep=lambda _s: None))


def _amounts(spent: Decimal, reserved: Decimal, held: Decimal = Decimal(0)) -> dict[str, Decimal]:
    return {"spent": spent, "reserved": reserved, "committed": spent + reserved, "held": held}


def _session_reusable(env: Env) -> bool:
    return env.conversations.sessions[("user-1", CONVERSATION)].used_at > 0


# --- 1. The turn ends well --------------------------------------------------------------


def test_a_turn_that_ends_well_charges_its_usage_and_releases_the_rest(env: Env) -> None:
    assert env.chat().status_code == 200
    (pending,) = env.seen
    # While the agent worked the record was open, with its session and the price reserved.
    assert pending.state == STATE_OPEN
    assert pending.session_id == env.agentcore.requests[0]["runtimeSessionId"]
    assert (pending.price.input, pending.price.output) == (Decimal(3), Decimal(15))
    assert pending.scopes == (USER, AGENT)
    assert pending.reserved > CALL_COST
    assert env.records() == []
    for scope in (USER, AGENT):
        assert env.budget(scope) == _amounts(CALL_COST, Decimal(0))
    assert env.completed()["settlement"] == "final"
    assert env.completed()["cost_usd"] == "0.004500"
    assert _session_reusable(env)


# --- 2. No budget -----------------------------------------------------------------------


def test_a_turn_without_budget_reserves_nothing_and_leaves_no_record(env: Env) -> None:
    env.limits = FakeLimits()
    env.db.put_item(
        TableName=TABLE,
        Item={
            "PK": {"S": USER},
            "SK": {"S": current_period()},
            "committed": {"N": "7"},
            "spent": {"N": "7"},
        },
    )
    assert env.chat().status_code == 402
    assert env.records() == []
    assert env.budget()["reserved"] == 0
    assert env.agentcore.requests == []


# --- 3. The turn cannot start -----------------------------------------------------------


def test_a_turn_that_cannot_start_releases_everything(env: Env) -> None:
    env.conversations.fail_writes = True
    assert env.chat().status_code == 500
    assert env.agentcore.requests == []
    assert env.records() == []
    assert env.budget() == _amounts(Decimal(0), Decimal(0))


def test_a_busy_conversation_releases_everything(env: Env) -> None:
    env.conversations.concurrent_turns = 5
    assert env.chat().status_code == 409
    assert env.records() == []
    assert env.budget() == _amounts(Decimal(0), Decimal(0))


def test_a_turn_refused_before_the_agent_is_called_releases_everything(env: Env) -> None:
    def no_audit(event: str, *_a: Any, **_kw: Any) -> None:
        if event == "agent.invoke":
            raise RuntimeError("audit down")

    env.audit.emit = no_audit  # type: ignore[method-assign]
    env.chat()
    # Without its audit record the agent is never invoked: nothing was spent.
    assert env.agentcore.requests == []
    assert env.records() == []
    assert env.budget() == _amounts(Decimal(0), Decimal(0))


# --- 4 and 5. Mango or the guardrail end the turn ---------------------------------------
# The stream shapes of both (the usage of the last message arrived or not) are in
# ``test_harness.py``; here, what each does to the budget.


def test_a_turn_ended_by_the_guardrail_charges_what_the_harness_reports(env: Env) -> None:
    env.agentcore.stream = lambda: [{"messageStop": {"stopReason": "guardrail_intervened"}}, CALL]
    env.chat()
    assert env.records() == []
    assert env.budget() == _amounts(CALL_COST, Decimal(0))
    assert env.completed()["settlement"] == "final"
    assert not _session_reusable(env)


def test_a_turn_whose_last_message_never_reported_its_usage_is_held(env: Env) -> None:
    # Two model calls; the stream ends before the usage of the second one arrives (a turn
    # closed on a write tool call, or a guardrail stop without its usage).
    env.agentcore.stream = lambda: [TEXT, TOOL_USE, CALL, TEXT, TOOL_USE]
    assert "done" in [kind for kind, _ in _events(env.chat().text)]
    (record,) = env.records()
    assert (record.state, record.charged) == (STATE_HELD, CALL_COST)
    assert env.completed()["settlement"] == "pending"
    assert not _session_reusable(env)


# --- 6. The harness reports an error ----------------------------------------------------
# The error arrives as it does in an installation: the stream is botocore's own
# (``harness_wire``) and the error is the exception it raises while the stream is read. It
# leaves ``harness.run`` and is caught by the chat turn.

HARNESS_ERRORS = ("internalServerException", "validationException", "runtimeClientError")
FAILED = ("error", {"code": "upstream_error", "message": "the agent failed"})
TITLE_COST = Decimal("0.00075")
"""200 and 10 tokens of the auxiliary model (3 and 15 USD per million)."""


def _assistant_rows(env: Env) -> list[tuple[str, str, str]]:
    return [row for row in env.conversations.stored if row[1] == "assistant"]


@pytest.mark.parametrize("code", HARNESS_ERRORS)
def test_an_error_reported_by_the_harness_charges_what_is_known_and_holds_the_rest(
    env: Env, caplog: pytest.LogCaptureFixture, code: str
) -> None:
    # Two model calls; the error comes while the second one writes its answer.
    env.agentcore.stream = lambda: wire_stream(TEXT, TOOL_USE, CALL, TEXT, error=code)
    sent = _events(env.chat().text)
    # The browser: the text that arrived, then the error. No ``done``.
    kinds = [kind for kind, _ in sent]
    assert [data["text"] for kind, data in sent if kind == "delta"] == ["Hola", "Hola"]
    assert sent[-1] == FAILED and kinds.count("error") == 1 and "done" not in kinds
    # Stored: the question. The half answer is not kept.
    assert env.conversations.stored == [("user-1", "user", "hola")]
    # Charged: the call whose usage arrived. Held: the rest of the reservation.
    (record,) = env.records()
    reserved = env.seen[0].reserved
    assert record.state == STATE_HELD
    assert (record.charged, record.retained) == (CALL_COST, reserved - CALL_COST)
    assert (record.usage.input_tokens, record.usage.output_tokens) == (1000, 100)
    for scope in (USER, AGENT):
        # Committed is still the whole reservation: nothing went back to the budget.
        assert env.budget(scope) == _amounts(CALL_COST, reserved - CALL_COST, reserved - CALL_COST)
    completed = env.completed()
    assert (completed["settlement"], completed["cost_usd"]) == ("pending", "0.004500")
    assert completed["held_usd"] == str(reserved - CALL_COST)
    # The audit keeps the stop reason of the last message that ended, not the error.
    assert (completed["stop_reason"], completed["input_tokens"]) == ("tool_use", 1000)
    assert not _session_reusable(env)
    assert "chat turn failed" in caplog.text


@pytest.mark.parametrize("code", HARNESS_ERRORS)
def test_an_error_before_any_usage_holds_the_whole_reservation(env: Env, code: str) -> None:
    env.agentcore.stream = lambda: wire_stream(error=code)
    sent = _events(env.chat().text)
    assert sent[-1] == FAILED and "done" not in [kind for kind, _ in sent]
    assert _assistant_rows(env) == []
    (record,) = env.records()
    reserved = env.seen[0].reserved
    assert (record.state, record.charged, record.retained) == (STATE_HELD, Decimal(0), reserved)
    assert env.budget() == _amounts(Decimal(0), reserved, reserved)
    completed = env.completed()
    assert (completed["settlement"], completed["stop_reason"]) == ("pending", "")
    assert (Decimal(completed["cost_usd"]), completed["held_usd"]) == (0, str(reserved))
    assert not _session_reusable(env)


def test_the_turn_after_an_error_starts_a_session_and_resends_the_history(env: Env) -> None:
    env.agentcore.stream = lambda: wire_stream(TEXT, error="internalServerException")
    env.chat()
    env.agentcore.stream = lambda: [TEXT, END, CALL]
    env.chat()
    first, second = env.agentcore.requests
    assert second["runtimeSessionId"] != first["runtimeSessionId"]
    assert len(second["messages"]) > 1


def _results(monkeypatch: pytest.MonkeyPatch) -> list[harness_module.InvocationResult]:
    """The result each turn was settled with."""
    seen: list[harness_module.InvocationResult] = []
    settle = app_module._settle_turn

    def spy(*args: Any, **kwargs: Any) -> bool:
        seen.append(kwargs["result"])
        return settle(*args, **kwargs)

    monkeypatch.setattr(app_module, "_settle_turn", spy)
    return seen


@pytest.mark.parametrize("code", HARNESS_ERRORS)
def test_failed_stays_false_after_an_error_and_nothing_of_the_turn_reads_it(
    env: Env, monkeypatch: pytest.MonkeyPatch, code: str
) -> None:
    results = _results(monkeypatch)
    env.agentcore.stream = lambda: wire_stream(TEXT, TOOL_USE, CALL, error=code)
    env.chat()
    (result,) = results
    # ``failed`` is only set for an error that arrives as an event: after a real one it
    # stays false. The turn is told to have failed by the exception, not by this flag.
    assert not result.failed
    assert result.started and not result.usage_final and not result.interrupted
    # The settlement goes by ``usage_final``: held. The audit has no field for ``failed``.
    assert env.records()[0].state == STATE_HELD
    assert "failed" not in env.completed()
    # The session goes by the turn having been answered and settled: not continued.
    assert not _session_reusable(env)


def test_a_new_conversation_gets_its_title_although_its_first_turn_failed(env: Env) -> None:
    """The one thing that reads ``failed``: the title is skipped for a failed first turn.
    After a real error the flag is false, so the title is written and charged."""
    env.agentcore.stream = lambda: wire_stream(TEXT, error="internalServerException")
    sent = _events(env.chat(conversation_id=None).text)
    assert sent[-1] == FAILED
    assert env.bedrock.calls == 1
    (record,) = env.records()
    reserved = env.seen[0].reserved
    # The title is charged on top of a turn that is held whole.
    assert (record.state, record.charged, record.retained) == (STATE_HELD, Decimal(0), reserved)
    assert env.budget() == _amounts(TITLE_COST, reserved, reserved)


def test_the_title_is_the_same_for_every_turn_that_fails_with_an_exception(env: Env) -> None:
    # Row 7 has always behaved this way: a cut turn of a new conversation gets its title.
    env.agentcore.stream = lambda: _cut(TEXT)
    env.chat(conversation_id=None)
    assert env.bedrock.calls == 1


def test_an_error_that_came_as_an_event_would_end_the_turn_in_another_way(env: Env) -> None:
    """The shape an installation does not produce, next to the real one above. The budget is
    the same; what the person gets and what is stored are not: with the event the turn goes
    on to store the half answer and to send ``done`` after the error."""
    env.agentcore.stream = lambda: [TEXT, TOOL_USE, CALL, {"internalServerException": {}}]
    sent = _events(env.chat(conversation_id=None).text)
    kinds = [kind for kind, _ in sent]
    assert ("error", {"code": "upstream_error", "message": "agent error"}) in sent
    assert kinds[-1] == "done" and kinds.index("error") < kinds.index("done")
    assert _assistant_rows(env) == [("user-1", "assistant", "Hola")]
    # No title: here ``failed`` is true.
    assert env.bedrock.calls == 0
    (record,) = env.records()
    assert (record.state, record.charged) == (STATE_HELD, CALL_COST)
    assert env.completed()["settlement"] == "pending"


# --- 6, one case out of it: a model call reaches its token cap (D74) --------------------

CAP = {"messageStop": {"stopReason": "max_tokens"}}


def _capped(*events: dict[str, Any], code: str = "runtimeClientError") -> Iterator[dict[str, Any]]:
    """The harness treats the cap as an exception: botocore raises it from the stream, after
    the message and (when it arrived) its usage."""
    yield from events
    message = "Model stopped generating due to maximum token limit."
    raise EventStreamError({"Error": {"Code": code, "Message": message}}, "InvokeHarness")


def test_an_answer_cut_at_its_cap_is_stored_and_settled_at_once(
    env: Env, caplog: pytest.LogCaptureFixture
) -> None:
    env.agentcore.stream = lambda: _capped(TEXT, CAP, CALL)
    events = _events(env.chat().text)
    kinds = [kind for kind, _ in events]
    assert "error" not in kinds
    done = next(data for kind, data in events if kind == "done")
    assert done["stop_reason"] == "max_tokens"
    assert done["usage"] == {"input_tokens": 1000, "output_tokens": 100}
    # The text up to the cut is the stored answer.
    assert ("user-1", "assistant", "Hola") in env.conversations.stored
    assert env.records() == []
    for scope in (USER, AGENT):
        assert env.budget(scope) == _amounts(CALL_COST, Decimal(0))
    completed = env.completed()
    assert (completed["settlement"], completed["stop_reason"]) == ("final", "max_tokens")
    assert (completed["cost_usd"], completed["held_usd"]) == ("0.004500", "0")
    assert "chat turn failed" not in caplog.text


def test_a_cap_in_the_second_call_of_a_turn_charges_every_call(env: Env) -> None:
    env.agentcore.stream = lambda: _capped(TEXT, TOOL_USE, CALL, TEXT, CAP, CALL)
    assert "done" in [kind for kind, _ in _events(env.chat().text)]
    assert env.records() == []
    assert env.budget() == _amounts(2 * CALL_COST, Decimal(0))
    assert env.completed()["settlement"] == "final"


def test_the_turn_after_one_cut_at_its_cap_starts_a_session_and_resends_the_history(
    env: Env,
) -> None:
    env.agentcore.stream = lambda: _capped(TEXT, CAP, CALL)
    env.chat()
    # The harness ended that invocation as an error: its session is not continued.
    assert not _session_reusable(env)
    env.agentcore.stream = lambda: [TEXT, END, CALL]
    env.chat()
    first, second = env.agentcore.requests
    assert second["runtimeSessionId"] != first["runtimeSessionId"]
    assert len(second["messages"]) > 1


@pytest.mark.parametrize(
    ("events", "code", "charged"),
    [
        # The cap, and the usage of that call never arrived.
        ((TEXT, CAP), "runtimeClientError", Decimal(0)),
        ((TEXT, TOOL_USE, CALL, TEXT, CAP), "runtimeClientError", CALL_COST),
        # An error with no cap before it.
        ((TEXT, TOOL_USE, CALL), "runtimeClientError", CALL_COST),
        ((TEXT, END, CALL), "runtimeClientError", CALL_COST),
        # The cap with its usage, and another kind of error.
        ((TEXT, CAP, CALL), "internalServerException", CALL_COST),
    ],
)
def test_any_other_error_of_the_harness_is_held_as_before(
    env: Env,
    caplog: pytest.LogCaptureFixture,
    events: tuple[dict[str, Any], ...],
    code: str,
    charged: Decimal,
) -> None:
    env.agentcore.stream = lambda: _capped(*events, code=code)
    sent = _events(env.chat().text)
    assert ("error", {"code": "upstream_error", "message": "the agent failed"}) in sent
    assert "done" not in [kind for kind, _ in sent]
    assert not [row for row in env.conversations.stored if row[1] == "assistant"]
    (record,) = env.records()
    reserved = env.seen[0].reserved
    assert (record.state, record.charged) == (STATE_HELD, charged)
    assert env.budget() == _amounts(charged, reserved - charged, reserved - charged)
    assert env.completed()["settlement"] == "pending"
    assert not _session_reusable(env)
    assert "chat turn failed" in caplog.text


# --- A tool call cut by the token cap (D74): what is charged and what is stored ----------
# What is asked to confirm, and what would run, is in ``test_approvals.py``.

TEXT_STORED = "Hola\n\n"
"""The text before a tool call is closed as a paragraph."""


def _tool_call(name: str, *pieces: str) -> list[dict[str, Any]]:
    start = {"toolUse": {"toolUseId": "t1", "name": name}}
    return [
        {"contentBlockStart": {"contentBlockIndex": 1, "start": start}},
        *(
            {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": piece}}}}
            for piece in pieces
        ),
    ]


WRITE_CUT = _tool_call(GATEWAY_TOOL, '{"name":"team-a","amo')
READ_CUT = _tool_call("finops___get_cost_and_usage", '{"start":"2026-')


@pytest.fixture
def write_env(env: Env) -> Env:
    env.published = FakePublished(agents={"finops": write_agent()})
    return env


def test_a_write_call_cut_at_the_cap_is_settled_at_once(
    write_env: Env, caplog: pytest.LogCaptureFixture
) -> None:
    env = write_env
    env.agentcore.stream = lambda: wire_stream(
        TEXT, *WRITE_CUT, CAP, CALL, error="runtimeClientError"
    )
    sent = _events(env.chat().text)
    kinds = [kind for kind, _ in sent]
    assert "error" not in kinds and "approval" not in kinds
    done = next(data for kind, data in sent if kind == "done")
    assert done["stop_reason"] == "max_tokens" and done["cost_usd"] == "0.0045"
    # Row 4 of the table: the usage of that message arrived, so the end is known.
    assert env.records() == []
    for scope in (USER, AGENT):
        assert env.budget(scope) == _amounts(CALL_COST, Decimal(0))
    completed = env.completed()
    assert (completed["settlement"], completed["held_usd"]) == ("final", "0")
    assert completed["stop_reason"] == "max_tokens"
    # Stored: the text before the call. Nothing of its input.
    assert _assistant_rows(env) == [("user-1", "assistant", TEXT_STORED)]
    assert not _session_reusable(env)
    assert "chat turn failed" not in caplog.text


def test_a_write_call_cut_at_the_cap_without_its_usage_is_held(write_env: Env) -> None:
    env = write_env
    env.agentcore.stream = lambda: wire_stream(TEXT, *WRITE_CUT, CAP, error="runtimeClientError")
    sent = _events(env.chat().text)
    # Row 6: the error is raised before the usage of that message.
    assert sent[-1] == FAILED and "done" not in [kind for kind, _ in sent]
    assert _assistant_rows(env) == []
    (record,) = env.records()
    reserved = env.seen[0].reserved
    assert (record.state, record.charged, record.retained) == (STATE_HELD, Decimal(0), reserved)
    assert env.completed()["settlement"] == "pending"
    assert not _session_reusable(env)


def test_a_read_call_cut_at_the_cap_is_settled_at_once(
    write_env: Env, caplog: pytest.LogCaptureFixture
) -> None:
    env = write_env
    env.agentcore.stream = lambda: wire_stream(
        TEXT, *READ_CUT, CAP, CALL, error="runtimeClientError"
    )
    sent = _events(env.chat().text)
    kinds = [kind for kind, _ in sent]
    assert "error" not in kinds and "approval" not in kinds
    # The tool is shown as started and never gets a result: it did not run.
    assert [data for kind, data in sent if kind == "tool"] == [
        {"name": "get_cost_and_usage", "status": "started"}
    ]
    assert next(data for kind, data in sent if kind == "done")["stop_reason"] == "max_tokens"
    # The end of D74 (13): known, charged and released.
    assert env.records() == []
    assert env.budget() == _amounts(CALL_COST, Decimal(0))
    completed = env.completed()
    assert (completed["settlement"], completed["stop_reason"]) == ("final", "max_tokens")
    # The audit lists the tool among the ones of the turn although it never ran.
    assert completed["tools"] == ["get_cost_and_usage"]
    assert _assistant_rows(env) == [("user-1", "assistant", TEXT_STORED)]
    assert not _session_reusable(env)
    assert "chat turn failed" not in caplog.text


def test_a_tool_call_cut_at_the_cap_in_a_later_call_charges_every_call(write_env: Env) -> None:
    env = write_env
    for cut in (READ_CUT, WRITE_CUT):
        env.agentcore.stream = lambda cut=cut: wire_stream(  # type: ignore[misc]
            TEXT, TOOL_USE, CALL, *cut, CAP, CALL, error="runtimeClientError"
        )
        env.chat(conversation_id=None)
        assert env.records() == []
    # Two turns of two calls each, and the title of each new conversation.
    assert env.budget() == _amounts(4 * CALL_COST + 2 * TITLE_COST, Decimal(0))


# --- 7. mango-api stops reading ---------------------------------------------------------


def test_a_cut_turn_is_never_settled_as_zero(env: Env) -> None:
    env.agentcore.stream = lambda: _cut(TEXT, TOOL_USE, CALL, TEXT)
    events = _events(env.chat().text)
    assert ("error", {"code": "upstream_error", "message": "the agent failed"}) in events
    (record,) = env.records()
    reserved = env.seen[0].reserved
    # What was already counted is charged, not zero; the rest is not given back.
    assert (record.state, record.charged) == (STATE_HELD, CALL_COST)
    assert env.budget() == _amounts(CALL_COST, reserved - CALL_COST, reserved - CALL_COST)
    assert env.completed()["cost_usd"] == "0.004500"
    assert env.completed()["input_tokens"] == 1000


def test_a_turn_cut_before_any_usage_keeps_its_whole_reservation(env: Env) -> None:
    env.agentcore.stream = _cut
    env.chat()
    (record,) = env.records()
    reserved = env.seen[0].reserved
    assert (record.state, record.charged, record.retained) == (STATE_HELD, Decimal(0), reserved)
    assert env.budget(AGENT) == _amounts(Decimal(0), reserved, reserved)


def test_a_call_to_the_agent_that_fails_is_not_known_to_have_cost_nothing(env: Env) -> None:
    # The request may have reached AgentCore before the error came back.
    env.agentcore.refuse = True
    env.chat()
    (record,) = env.records()
    assert record.state == STATE_HELD
    assert record.retained == record.reserved


def test_cutting_turns_does_not_give_the_budget_back(env: Env) -> None:
    """The abuse the load test found: before, each cut turn returned its reservation and the
    person could repeat it without limit."""
    env.agentcore.stream = _cut
    codes = [env.chat(conversation_id=None).status_code for _ in range(80)]
    cut = codes.count(200)
    reserved = env.seen[0].reserved
    # USD 7 of budget and nothing spent: only as many turns as reservations fit.
    assert cut == int(Decimal(7) / reserved)
    assert set(codes[cut:]) == {402}
    assert len(env.agentcore.requests) == cut
    assert env.budget()["held"] == cut * reserved


def test_the_budget_list_never_shows_a_held_amount_as_available(env: Env) -> None:
    env.agentcore.stream = lambda: _cut(TEXT, TOOL_USE, CALL)
    env.chat()
    reserved = env.seen[0].reserved
    usage = env.budgets.period_usage(current_period())
    assert usage[USER].spent == reserved
    assert usage[AGENT].spent == reserved
    assert set(usage) == {USER, AGENT}


# --- 8. The person leaves ---------------------------------------------------------------
# The turn runs in its own thread and does not depend on the connection: it is row 1. The
# client used here reads the whole response; ``with_heartbeat`` has its own tests.

# --- 9. The task dies with the turn open ------------------------------------------------


def test_a_turn_whose_task_dies_leaves_a_record_the_reconciler_can_close(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A killed task runs nothing more of the turn: neither the ``except`` nor the ``finally``.
    monkeypatch.setattr(app_module, "_settle_turn", lambda *_a, **_kw: False)
    env.chat()
    (record,) = env.records()
    assert record.state == STATE_OPEN
    assert record.session_id == env.agentcore.requests[0]["runtimeSessionId"]
    assert record.retained == record.reserved
    # Due once the turn's time limit (300 s for this agent) and the margin have passed.
    assert record.reconcile_at == record.started_at + 300 + 90
    assert record.charge_at == record.started_at + 300 + 900
    found, _ = budget_turns.due(env.db, TABLE, record.reconcile_at, limit=10)
    assert found == [record]
    assert budget_turns.due(env.db, TABLE, record.reconcile_at - 1, limit=10) == ([], 0)
    assert env.budget() == _amounts(Decimal(0), record.reserved)


# --- 10. The settlement fails -----------------------------------------------------------


def test_a_settlement_that_fails_leaves_the_record_and_the_session_closed(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    def down(*_a: Any, **_kw: Any) -> bool:
        raise budget_turns.TurnConflictError("turn accounting not recorded")

    monkeypatch.setattr(env.budgets, "settle_turn", down)
    events = _events(env.chat().text)
    # The answer was delivered; the accounting is left to the reconciler, all or nothing.
    assert "done" in [kind for kind, _ in events]
    (record,) = env.records()
    assert record.state == STATE_OPEN
    for scope in (USER, AGENT):
        assert env.budget(scope) == _amounts(Decimal(0), record.reserved)
    # Its session is not continued: the traces after this turn started are only its own.
    assert not _session_reusable(env)


def test_a_turn_the_reconciler_closed_first_is_not_charged_again(env: Env) -> None:
    def closed_meanwhile() -> Iterator[dict[str, Any]]:
        yield TEXT
        (record,) = env.records()
        budget_turns.close(
            env.db,
            TABLE,
            record,
            budget_turns.Outcome(budget_turns.BASIS_RESERVATION, reason="no_trace"),
        )
        yield END
        yield CALL

    env.agentcore.stream = closed_meanwhile
    env.chat()
    reserved = env.seen[0].reserved
    assert env.budget() == _amounts(reserved, Decimal(0))
    assert env.completed()["settlement"] == "reconciler"
    assert not _session_reusable(env)


# --- 11. The title of a new conversation ------------------------------------------------


def test_the_title_is_charged_without_a_reservation(env: Env) -> None:
    env.chat(conversation_id=None)
    # 200 and 10 tokens of the auxiliary model on top of the turn; nothing stays reserved.
    budget = env.budget()
    assert budget["spent"] > CALL_COST
    assert budget == _amounts(budget["spent"], Decimal(0))
    assert env.records() == []
