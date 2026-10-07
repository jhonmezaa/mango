import contextlib
import json
import socket
import threading
from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from botocore.exceptions import EventStreamError, ReadTimeoutError

from mango_api import harness

from .harness_wire import event_frame, wire_stream


class _Client:
    def __init__(self, stream: list[dict[str, Any]]) -> None:
        self._stream = stream

    def invoke_harness(self, **_request: Any) -> dict[str, Any]:
        return {"stream": self._stream}


def _text(text: str) -> dict[str, Any]:
    return {"contentBlockDelta": {"delta": {"text": text}}}


def _tool(tool_id: str) -> dict[str, Any]:
    return {"contentBlockStart": {"start": {"toolUse": {"toolUseId": tool_id, "name": "x___t"}}}}


def _run(stream: list[dict[str, Any]]) -> tuple[list[str], str]:
    result = harness.InvocationResult()
    events = list(harness.run(_Client(stream), {}, result))  # type: ignore[arg-type]
    return [e.data["text"] for e in events if e.kind == "delta"], result.text


@pytest.mark.parametrize(
    ("text", "separator"),
    [("", ""), ("Hola", "\n\n"), ("Hola\n", "\n"), ("Hola\n\n", "")],
)
def test_paragraph_separator(text: str, separator: str) -> None:
    assert harness.paragraph_separator(text) == separator


def test_no_separator_when_the_turn_starts_with_a_tool() -> None:
    deltas, text = _run([_tool("t1"), _text("Listo")])
    assert deltas == ["Listo"]
    assert text == "Listo"


def test_consecutive_tools_add_a_single_break() -> None:
    deltas, text = _run([_text("Consulto."), _tool("t1"), _tool("t2"), _text("Listo")])
    assert deltas == ["Consulto.", "\n\n", "Listo"]
    assert text == "Consulto.\n\nListo"


def test_text_ending_in_newline_is_completed_to_a_paragraph() -> None:
    _, text = _run([_text("Consulto.\n"), _tool("t1"), _text("Listo")])
    assert text == "Consulto.\n\nListo"


def _tool_result(tool_id: str, status: str = "success") -> dict[str, Any]:
    block = {"toolResult": {"toolUseId": tool_id, "status": status}}
    return {"contentBlockStart": {"start": block}}


def _statuses(stream: list[dict[str, Any]]) -> list[dict[str, str]]:
    result = harness.InvocationResult()
    request = {"allowedTools": ["@mango/x___t"]}
    events = harness.run(_Client(stream), request, result)  # type: ignore[arg-type]
    return [e.data for e in events if e.kind == "status"]


def test_progress_starts_before_the_harness_answers() -> None:
    class _Silent:
        def invoke_harness(self, **_request: Any) -> dict[str, Any]:
            raise AssertionError("not called yet")

    events = harness.run(_Silent(), {}, harness.InvocationResult())  # type: ignore[arg-type]
    first = next(events)
    assert (first.kind, first.data) == ("status", {"phase": "thinking"})


def test_progress_follows_the_agent_loop() -> None:
    stream = [
        _tool("t1"),
        _tool_result("t1"),
        _text("Listo"),
        _text(", aquí está."),
    ]
    assert _statuses(stream) == [
        {"phase": "thinking"},
        {"phase": "tool", "tool": "t"},
        {"phase": "tool_result"},
        {"phase": "writing"},
    ]


def test_progress_waits_for_every_tool_in_flight() -> None:
    stream = [_tool("t1"), _tool("t2"), _tool_result("t1"), _tool_result("t2", "error")]
    # Both calls have the same display name: one status for the two, and the results only
    # count once the last one has answered.
    assert _statuses(stream) == [
        {"phase": "thinking"},
        {"phase": "tool", "tool": "t"},
        {"phase": "tool_result"},
    ]


def test_progress_only_names_tools_of_the_published_version() -> None:
    # The name of a tool call is model output the guardrail does not check: one that is not a
    # tool of the agent is reported without its name.
    invented = {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "t9", "name": "AKIA"}}}}
    assert _statuses([invented]) == [{"phase": "thinking"}, {"phase": "tool"}]


def test_progress_goes_back_to_a_tool_after_text() -> None:
    stream = [_text("Consulto."), _tool("t1"), _tool_result("t1"), _text("Listo")]
    assert [s["phase"] for s in _statuses(stream)] == [
        "thinking",
        "writing",
        "tool",
        "tool_result",
        "writing",
    ]


def test_status_comes_before_the_text_it_announces() -> None:
    result = harness.InvocationResult()
    events = list(harness.run(_Client([_text("Hola")]), {}, result))  # type: ignore[arg-type]
    assert [e.kind for e in events] == ["status", "status", "delta"]


def test_reasoning_of_the_model_is_never_forwarded() -> None:
    # The guardrail does not check reasoning content (D39): it must not reach the client nor
    # the stored answer, whatever the model or the harness configuration.
    secret = "razonamiento sin revisar"
    stream = [
        {"contentBlockDelta": {"delta": {"reasoningContent": {"text": secret}}}},
        {"contentBlockDelta": {"delta": {"reasoningContent": {"signature": "sig"}}}},
        _text("Hola"),
    ]
    result = harness.InvocationResult()
    events = list(harness.run(_Client(stream), {}, result))  # type: ignore[arg-type]
    assert result.text == "Hola"
    assert all(secret not in value for e in events for value in e.data.values())
    assert [e.data for e in events if e.kind == "status"] == [
        {"phase": "thinking"},
        {"phase": "writing"},
    ]


# --- Write tool calls are reported with their input (D27) -----------------------------------

WRITE = "ops___create_budget"


def _tool_start(index: int, name: str, tool_id: str = "t1") -> dict[str, Any]:
    return {
        "contentBlockStart": {
            "contentBlockIndex": index,
            "start": {"toolUse": {"toolUseId": tool_id, "name": name}},
        }
    }


def _input(index: int, piece: str) -> dict[str, Any]:
    return {
        "contentBlockDelta": {"contentBlockIndex": index, "delta": {"toolUse": {"input": piece}}}
    }


def _stop(index: int) -> dict[str, Any]:
    return {"contentBlockStop": {"contentBlockIndex": index}}


def _write_calls(
    stream: list[dict[str, Any]], capture: frozenset[str] = frozenset({WRITE})
) -> list[dict[str, str]]:
    result = harness.InvocationResult()
    events = harness.run(_Client(stream), {}, result, capture)  # type: ignore[arg-type]
    return [e.data for e in events if e.kind == harness.WRITE_CALL]


@pytest.mark.parametrize("name", [WRITE, f"mango___{WRITE}", f"@mango/{WRITE}", f"mango.{WRITE}"])
def test_a_write_call_is_reported_once_its_input_is_complete(name: str) -> None:
    stream = [
        _tool_start(1, name),
        _input(1, '{"name":"a",'),
        _input(1, '"amount_usd":5}'),
        _stop(1),
    ]
    assert _write_calls(stream) == [{"tool": WRITE, "arguments": '{"name":"a","amount_usd":5}'}]


def test_inputs_of_parallel_calls_do_not_mix() -> None:
    stream = [
        _tool_start(1, WRITE, "t1"),
        _tool_start(2, WRITE, "t2"),
        _input(2, '{"n":2}'),
        _input(1, '{"n":1}'),
        {"messageStop": {"stopReason": "tool_use"}},
    ]
    assert sorted(c["arguments"] for c in _write_calls(stream)) == ['{"n":1}', '{"n":2}']


def test_a_call_without_a_stop_is_reported_before_its_result() -> None:
    stream = [
        _tool_start(1, WRITE),
        _input(1, "{}"),
        {"contentBlockStart": {"start": {"toolResult": {"toolUseId": "t1", "status": "error"}}}},
    ]
    assert _write_calls(stream) == [{"tool": WRITE, "arguments": "{}"}]


@pytest.mark.parametrize(
    "name",
    ["finops___get_cost_and_usage", f"evil{WRITE}", f"mango___evil-{WRITE}", "create_budget"],
)
def test_other_tools_are_not_reported(name: str) -> None:
    assert _write_calls([_tool_start(1, name), _input(1, "{}"), _stop(1)]) == []


def test_nothing_is_reported_for_an_agent_without_write_tools() -> None:
    stream = [_tool_start(1, WRITE), _input(1, "{}"), _stop(1)]
    assert _write_calls(stream, frozenset()) == []


def test_an_input_too_large_to_show_is_dropped() -> None:
    piece = "x" * (harness.MAX_TOOL_INPUT_CHARS // 2 + 1)
    stream = [_tool_start(1, WRITE), _input(1, piece), _input(1, piece), _input(1, "}"), _stop(1)]
    assert _write_calls(stream) == []


def test_write_calls_are_still_shown_as_tools_and_never_as_text() -> None:
    result = harness.InvocationResult()
    stream = [_tool_start(1, WRITE), _input(1, '{"secret":1}'), _stop(1)]
    events = list(harness.run(_Client(stream), {}, result, frozenset({WRITE})))  # type: ignore[arg-type]
    # Progress events (`status`) carry phases and tool names of the version, never input.
    assert [e.kind for e in events if e.kind != "status"] == ["tool", harness.WRITE_CALL]
    assert all("secret" not in json.dumps(e.data) for e in events if e.kind != harness.WRITE_CALL)
    assert result.text == "" and result.tools == [{"name": "create_budget", "status": "started"}]


# --- A turn ends with the message that calls a write tool -----------------------------------


class _HangingStream:
    """A harness that never gets past the Gateway's refusal: reading beyond the events it
    sent times out, as the real stream does."""

    def __init__(self, events: list[dict[str, Any]]) -> None:
        self._events = events
        self.read = 0
        self.closed = False

    def __iter__(self) -> Iterator[dict[str, Any]]:
        for event in self._events:
            self.read += 1
            yield event
        raise TimeoutError("The read operation timed out")

    def close(self) -> None:
        self.closed = True


def _usage(tokens: int) -> dict[str, Any]:
    return {"metadata": {"usage": {"inputTokens": tokens, "outputTokens": 1}}}


def _turn(
    events: list[dict[str, Any]],
) -> tuple[list[harness.StreamEvent], harness.InvocationResult, _HangingStream]:
    stream, result = _HangingStream(events), harness.InvocationResult()
    client = _Client(stream)  # type: ignore[arg-type]
    return list(harness.run(client, {}, result, frozenset({WRITE}))), result, stream  # type: ignore[arg-type]


def test_the_turn_ends_with_the_message_that_calls_a_write_tool() -> None:
    events, result, stream = _turn(
        [
            _text("Lo preparo."),
            _tool_start(1, f"mango___{WRITE}"),
            _input(1, '{"n":1}'),
            _stop(1),
            {"messageStop": {"stopReason": "tool_use"}},
            _usage(100),
        ]
    )
    # Nothing is read after the usage of that message, and the connection is dropped.
    assert stream.read == 6 and stream.closed
    assert [e.data for e in events if e.kind == harness.WRITE_CALL] == [
        {"tool": WRITE, "arguments": '{"n":1}'}
    ]
    assert (result.text, result.stop_reason) == ("Lo preparo.\n\n", "tool_use")
    assert result.interrupted and not result.failed
    assert result.usage.input_tokens == 100
    # The call is shown as refused, not left running.
    assert [e.data for e in events if e.kind == "tool"] == [
        {"name": WRITE, "status": "started"},
        {"name": WRITE, "status": "error"},
    ]
    assert "error" not in [e.kind for e in events]


def test_every_write_call_of_the_message_is_reported_before_the_turn_ends() -> None:
    events, result, _ = _turn(
        [
            _tool_start(1, WRITE, "t1"),
            _tool_start(2, WRITE, "t2"),
            _input(1, '{"n":1}'),
            _input(2, '{"n":2}'),
            {"messageStop": {"stopReason": "tool_use"}},
            _usage(7),
        ]
    )
    calls = [e.data["arguments"] for e in events if e.kind == harness.WRITE_CALL]
    assert sorted(calls) == ['{"n":1}', '{"n":2}']
    assert result.interrupted and result.usage.input_tokens == 7


def test_the_write_tool_is_not_tried_again_in_the_turn() -> None:
    # Whatever the harness would send next (the refusal, another attempt) is never read.
    events, result, stream = _turn(
        [
            _tool_start(1, WRITE),
            _input(1, "{}"),
            _stop(1),
            {"messageStop": {"stopReason": "tool_use"}},
            _usage(5),
            {"contentBlockStart": {"start": {"toolResult": {"toolUseId": "t1"}}}},
            _tool_start(1, WRITE, "t2"),
            _input(1, "{}"),
            _stop(1),
            {"messageStop": {"stopReason": "tool_use"}},
            _usage(5),
        ]
    )
    assert stream.read == 5 and stream.closed
    assert len([e for e in events if e.kind == harness.WRITE_CALL]) == 1
    assert result.usage.input_tokens == 5


def test_the_usage_of_earlier_model_calls_is_kept() -> None:
    _, result, _ = _turn(
        [
            _tool_start(0, "finops___get_cost_and_usage", "r1"),
            _stop(0),
            {"messageStop": {"stopReason": "tool_use"}},
            _usage(10),
            {"contentBlockStart": {"start": {"toolResult": {"toolUseId": "r1"}}}},
            _tool_start(1, WRITE),
            _input(1, "{}"),
            _stop(1),
            {"messageStop": {"stopReason": "tool_use"}},
            _usage(20),
        ]
    )
    assert result.interrupted and result.usage.input_tokens == 30


def test_a_turn_without_write_calls_is_read_to_its_end() -> None:
    stream = [
        _tool_start(0, "finops___get_cost_and_usage", "r1"),
        _stop(0),
        {"messageStop": {"stopReason": "tool_use"}},
        _usage(10),
        {"contentBlockStart": {"start": {"toolResult": {"toolUseId": "r1"}}}},
        _text("Listo"),
        {"messageStop": {"stopReason": "end_turn"}},
        _usage(10),
    ]
    result = harness.InvocationResult()
    events = list(harness.run(_Client(stream), {}, result, frozenset({WRITE})))  # type: ignore[arg-type]
    assert (result.stop_reason, result.interrupted) == ("end_turn", False)
    assert result.text.endswith("Listo") and result.usage.input_tokens == 20
    assert [e.data["status"] for e in events if e.kind == "tool"] == ["started", "completed"]


# --- The client of a turn ---------------------------------------------------------------


def test_the_read_timeout_of_a_turn_client_follows_the_limit_of_the_turn() -> None:
    seen: list[tuple[str, Any]] = []

    def factory(region: str, config: Any) -> Any:
        seen.append((region, config))
        return object()

    clients = harness.TurnClients("us-east-1", factory=factory)
    default, long = clients.for_turn(120), clients.for_turn(600)
    assert default is not long
    # One client per limit, reused: its connections are what a pool is for.
    assert clients.for_turn(120) is default
    assert [region for region, _ in seen] == ["us-east-1", "us-east-1"]
    for turn_seconds, (_, config) in zip((120, 600), seen, strict=True):
        # botocore's 60 s cut turns that still had time left.
        assert config.read_timeout == turn_seconds + harness.READ_MARGIN_SECONDS
        assert config.connect_timeout == harness.CONNECT_TIMEOUT_SECONDS
        assert config.retries == {"total_max_attempts": 1, "mode": "standard"}
        # More than the 10 of botocore: 20 turns at once in a task filled it.
        assert config.max_pool_connections == harness.POOL_CONNECTIONS >= 66


def test_turn_clients_are_bounded() -> None:
    made: list[int] = []

    def factory(_region: str, config: Any) -> Any:
        made.append(config.read_timeout)
        return object()

    clients = harness.TurnClients("us-east-1", factory=factory)
    limits = list(range(10, 10 + harness.MAX_TURN_CLIENTS + 3))
    for seconds in limits:
        clients.for_turn(seconds)
    assert len(made) == len(limits)
    # The last ones are still there; the three oldest were dropped and are made again.
    for seconds in limits[-harness.MAX_TURN_CLIENTS :]:
        clients.for_turn(seconds)
    assert len(made) == len(limits)
    clients.for_turn(limits[0])
    assert len(made) == len(limits) + 1


def test_a_turn_whose_answer_does_not_arrive_is_not_sent_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Against a real socket: the harness accepts the invocation and stays silent."""
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")
    monkeypatch.delenv("AWS_PROFILE", raising=False)
    server = socket.create_server(("127.0.0.1", 0))
    server.settimeout(0.2)
    stop = threading.Event()
    connections: list[socket.socket] = []

    def accept() -> None:
        while not stop.is_set():
            try:
                connections.append(server.accept()[0])
            except TimeoutError:
                continue

    thread = threading.Thread(target=accept, daemon=True)
    thread.start()
    port = server.getsockname()[1]

    def factory(region: str, config: Any) -> Any:
        return boto3.client(
            "bedrock-agentcore",
            region_name=region,
            config=config,
            endpoint_url=f"http://127.0.0.1:{port}",
        )

    clients = harness.TurnClients("us-east-1", read_margin_seconds=0, factory=factory)
    try:
        with pytest.raises(ReadTimeoutError):
            clients.for_turn(1).invoke_harness(
                harnessArn="arn:aws:bedrock-agentcore:us-east-1:111122223333:harness/a-0123456789",
                runtimeSessionId="s" * 40,
                messages=[{"role": "user", "content": [{"text": "hi"}]}],
            )
        # Time for a retry to show up, if the SDK made one.
        stop.wait(0.5)
    finally:
        stop.set()
        thread.join()
        for connection in connections:
            connection.close()
        server.close()
    assert len(connections) == 1


# --- Is the usage everything the turn cost? (D73) ---------------------------------------


def _final(events: list[dict[str, Any]], *, fail: bool = False) -> harness.InvocationResult:
    class _Stream(list[dict[str, Any]]):
        def close(self) -> None: ...

    class _Refusing:
        def invoke_harness(self, **_request: Any) -> dict[str, Any]:
            raise RuntimeError("no answer")

    result = harness.InvocationResult()
    client = _Refusing() if fail else _Client(_Stream(events))  # type: ignore[arg-type]
    with contextlib.suppress(RuntimeError):
        list(harness.run(client, {}, result, frozenset({WRITE})))  # type: ignore[arg-type]
    return result


def test_usage_is_final_when_every_model_call_reported_it() -> None:
    result = _final(
        [
            _text("a"),
            {"messageStop": {"stopReason": "tool_use"}},
            _usage(100),
            _text("b"),
            {"messageStop": {"stopReason": "end_turn"}},
            _usage(200),
        ]
    )
    assert result.started and result.usage_final
    assert result.usage.input_tokens == 300


def test_a_turn_closed_on_a_write_tool_is_final_once_its_usage_arrived() -> None:
    call = [_tool_start(1, WRITE), _stop(1), {"messageStop": {"stopReason": "tool_use"}}]
    assert _final([*call, _usage(100)]).usage_final
    # The stream moved on, or ended, without the usage of that message.
    assert not _final([*call, _text("x")]).usage_final
    assert not _final(call).usage_final


def test_a_guardrail_stop_is_final_only_with_its_usage() -> None:
    stop = {"messageStop": {"stopReason": "guardrail_intervened"}}
    assert _final([stop, _usage(50)]).usage_final
    assert not _final([stop]).usage_final


@pytest.mark.parametrize(
    "events",
    [
        [],
        [_text("a")],
        [_text("a"), {"messageStop": {"stopReason": "end_turn"}}],
    ],
)
def test_usage_is_not_final_when_a_call_did_not_report(events: list[dict[str, Any]]) -> None:
    result = _final(events)
    assert result.started and not result.usage_final


def test_a_call_that_raises_started_the_turn_and_knows_nothing() -> None:
    result = _final([], fail=True)
    assert result.started and not result.usage_final


def test_nothing_started_before_the_harness_is_called() -> None:
    assert not harness.InvocationResult().started


# --- A model call that reaches its token cap (D74) --------------------------------------

CAP = {"messageStop": {"stopReason": "max_tokens"}}
END_TURN = {"messageStop": {"stopReason": "end_turn"}}


def _harness_error(code: str = "runtimeClientError") -> EventStreamError:
    """The error as botocore raises it from the stream: the harness treats the cap as an
    exception after delivering the message and its usage."""
    message = "Model stopped generating due to maximum token limit."
    return EventStreamError({"Error": {"Code": code, "Message": message}}, "InvokeHarness")


def _raising(*events: dict[str, Any], error: Exception) -> Iterator[dict[str, Any]]:
    yield from events
    raise error


def _capped(
    *events: dict[str, Any], error: Exception | None = None
) -> tuple[list[harness.StreamEvent], harness.InvocationResult]:
    result = harness.InvocationResult()
    client = _Client(_raising(*events, error=error or _harness_error()))  # type: ignore[arg-type]
    return list(harness.run(client, {}, result)), result  # type: ignore[arg-type]


def test_a_message_cut_at_its_cap_with_its_usage_ends_the_turn_as_known() -> None:
    events, result = _capped(_text("Una guía larga que se cor"), CAP, _usage(10_169))
    assert (result.text, result.stop_reason) == ("Una guía larga que se cor", "max_tokens")
    assert result.usage_final and not result.failed and not result.interrupted
    assert result.usage.input_tokens == 10_169
    assert "error" not in [event.kind for event in events]


def test_a_cap_in_a_later_call_of_a_turn_with_tools_keeps_the_usage_of_the_earlier_ones() -> None:
    _sent, result = _capped(
        _tool("t1"),
        {"messageStop": {"stopReason": "tool_use"}},
        _usage(100),
        _tool_result("t1"),
        _text("b"),
        CAP,
        _usage(200),
    )
    assert result.usage_final
    assert (result.usage.input_tokens, result.usage.output_tokens) == (300, 2)


@pytest.mark.parametrize(
    ("events", "code"),
    [
        # The cap, and the error before the usage of that message.
        ([_text("a"), CAP], "runtimeClientError"),
        # An error with no cap before it, with and without usage.
        ([_text("a"), END_TURN, _usage(1)], "runtimeClientError"),
        ([{"messageStop": {"stopReason": "tool_use"}}, _usage(1)], "runtimeClientError"),
        ([_text("a")], "runtimeClientError"),
        ([], "runtimeClientError"),
        # The cap with its usage, and another kind of error.
        ([_text("a"), CAP, _usage(1)], "internalServerException"),
        ([_text("a"), CAP, _usage(1)], "validationException"),
        # The cap with its usage, and the harness went on before failing.
        ([_text("a"), CAP, _usage(1), _text("b")], "runtimeClientError"),
        ([CAP, _usage(1), {"messageStop": {"stopReason": "max_tokens"}}], "runtimeClientError"),
        # A usage that belongs to no message.
        ([CAP, _usage(1), _usage(1)], "runtimeClientError"),
    ],
)
def test_any_other_error_of_the_harness_is_still_a_failure(
    events: list[dict[str, Any]], code: str
) -> None:
    result = harness.InvocationResult()
    client = _Client(_raising(*events, error=_harness_error(code)))  # type: ignore[arg-type]
    with pytest.raises(EventStreamError):
        list(harness.run(client, {}, result))  # type: ignore[arg-type]
    assert result.started and not result.usage_final


def test_the_text_of_the_error_does_not_decide_the_end() -> None:
    error = EventStreamError({"Error": {"Code": "runtimeClientError"}}, "InvokeHarness")
    assert _capped(_text("a"), CAP, _usage(1), error=error)[1].usage_final
    # The same words with no cap before them are a failure.
    with pytest.raises(EventStreamError):
        _capped(_text("a"), END_TURN, _usage(1))


def test_the_cap_error_as_an_event_of_the_stream_ends_the_turn_the_same_way() -> None:
    # The shape an installation does not produce (see the last section of this file).
    cut = _final([_text("a"), CAP, _usage(7), {"runtimeClientError": {"message": "x"}}])
    assert cut.usage_final and not cut.failed
    for events in (
        [_text("a"), CAP, {"runtimeClientError": {}}],
        [_text("a"), CAP, _usage(7), {"internalServerException": {}}],
        [END_TURN, _usage(7), {"runtimeClientError": {}}],
    ):
        failed = _final(events)
        assert failed.failed and not failed.usage_final


def test_a_write_call_cut_at_the_cap_still_ends_the_turn_on_that_message() -> None:
    # Unchanged: the turn closes on the message that calls a write tool, before any error.
    _sent, result, stream = _turn([_tool_start(1, WRITE), CAP, _usage(5), _text("never")])
    assert result.interrupted and result.usage_final and stream.closed


# --- The error of the harness as it arrives in an installation ------------------------------
# From here on the stream is botocore's own, read from event-stream frames (``harness_wire``):
# the error is the exception botocore raises, never a dictionary a test wrote.

ERROR_CODES = ("internalServerException", "validationException", "runtimeClientError")
TOOL_USE = {"messageStop": {"stopReason": "tool_use"}}
READ = "finops___get_cost_and_usage"
ARGUMENTS = '{"name":"team-a","amount_usd":100}'


def _wired(
    *events: dict[str, Any], error: str | None = None, frames: bytes = b""
) -> tuple[list[harness.StreamEvent], harness.InvocationResult, EventStreamError | None]:
    """A turn over the real stream: what was sent to the chat before it ended, the result,
    and the error ``harness.run`` let out (``None`` when it ended on its own)."""
    result = harness.InvocationResult()
    client = _Client(wire_stream(*events, error=error, frames=frames))
    request = {"allowedTools": [f"@mango/{READ}", f"@mango/{WRITE}"]}
    sent: list[harness.StreamEvent] = []
    raised: EventStreamError | None = None
    try:
        for event in harness.run(client, request, result, frozenset({WRITE})):  # type: ignore[arg-type]
            sent.append(event)
    except EventStreamError as caught:
        raised = caught
    return sent, result, raised


@pytest.mark.parametrize("code", ERROR_CODES)
def test_the_service_model_declares_the_errors_of_the_stream_as_exceptions(code: str) -> None:
    client = boto3.client("bedrock-agentcore", region_name="us-east-1")
    stream = client.meta.service_model.operation_model("InvokeHarness").output_shape.members[
        "stream"
    ]
    assert stream.members[code].metadata.get("exception") is True
    assert set(ERROR_CODES) == {
        name for name, member in stream.members.items() if member.metadata.get("exception")
    }


@pytest.mark.parametrize("code", ERROR_CODES)
def test_an_error_of_the_harness_is_raised_and_never_arrives_as_an_event(code: str) -> None:
    sent, result, raised = _wired(_text("a"), TOOL_USE, _usage(7), _text("b"), error=code)
    assert raised is not None and raised.response["Error"]["Code"] == code
    # ``harness.run`` sends no error of its own: the chat's is written by whoever catches it.
    assert "error" not in [event.kind for event in sent]
    assert [event.data["text"] for event in sent if event.kind == "delta"] == ["a", "b"]
    # What is known when it is raised: the text and the usage counted so far, not final.
    assert (result.text, result.usage.input_tokens) == ("ab", 7)
    assert result.started and not result.usage_final
    # ``failed`` is only set by the branch for errors that arrive as events.
    assert not result.failed and not result.interrupted


@pytest.mark.parametrize("code", ERROR_CODES)
def test_an_error_before_anything_else_leaves_an_empty_result(code: str) -> None:
    sent, result, raised = _wired(error=code)
    assert raised is not None and raised.response["Error"]["Code"] == code
    assert [event.kind for event in sent] == ["status"]
    assert (result.text, result.stop_reason) == ("", "")
    assert (result.usage.input_tokens, result.usage.output_tokens) == (0, 0)
    assert result.started and not result.usage_final and not result.failed


def test_the_cap_end_over_the_real_stream() -> None:
    sent, result, raised = _wired(_text("a"), CAP, _usage(7), error="runtimeClientError")
    assert raised is None and "error" not in [event.kind for event in sent]
    assert result.usage_final and not result.failed and result.stop_reason == "max_tokens"


@pytest.mark.parametrize("code", ERROR_CODES)
def test_the_branch_for_errors_as_events_needs_a_frame_the_service_does_not_send(
    code: str,
) -> None:
    """``harness.run`` has a branch for an error that arrives as an event of the stream. It
    only runs if the service framed the error as an event (``:message-type: event``); the
    service model declares it an exception, and that is what was seen in an installation.
    This pins what the branch does, so whoever removes or keeps it knows what changes."""
    sent, result, raised = _wired(_text("a"), frames=event_frame({code: {"message": "x"}}))
    assert raised is None
    assert result.failed and not result.usage_final
    assert sent[-1].kind == "error" and sent[-1].data["code"] == "upstream_error"


@pytest.mark.parametrize(
    "events",
    [
        [{"messageStop": {"stopReason": "tool_use"}}, _usage(1), {"internalServerException": {}}],
        [{"validationException": {}}],
    ],
)
def test_usage_is_not_final_after_an_error_that_came_as_an_event(
    events: list[dict[str, Any]],
) -> None:
    # The shape an installation does not produce: kept while the branch exists.
    result = _final(events)
    assert result.started and result.failed and not result.usage_final


# --- A tool call cut by the token cap (D74) -------------------------------------------------
# The cap may fall while the model writes the input of a tool call: the pieces of ``toolUse``
# stop short, the message ends with ``max_tokens``, its usage arrives and the harness ends
# the invocation with its error.


def _cut_call(
    *pieces: str, name: str = WRITE, stop: bool = True, index: int = 1
) -> list[dict[str, Any]]:
    block = [_tool_start(index, name, f"t{index}"), *(_input(index, piece) for piece in pieces)]
    return [*block, *([_stop(index)] if stop else [])]


def _write_call_events(sent: list[harness.StreamEvent]) -> list[dict[str, str]]:
    return [event.data for event in sent if event.kind == harness.WRITE_CALL]


@pytest.mark.parametrize("stop", [True, False])
@pytest.mark.parametrize("cut", [1, 9, len(ARGUMENTS) // 2, len(ARGUMENTS) - 1])
def test_a_write_call_cut_at_the_cap_is_reported_with_the_input_that_arrived(
    cut: int, stop: bool
) -> None:
    pieces = (ARGUMENTS[: cut // 2], ARGUMENTS[cut // 2 : cut])
    sent, result, raised = _wired(
        _text("Lo preparo."),
        *_cut_call(*pieces, stop=stop),
        CAP,
        _usage(100),
        error="runtimeClientError",
    )
    # The turn ends on that message, as with any write call: the error is never read.
    assert raised is None and "error" not in [event.kind for event in sent]
    assert result.interrupted and result.usage_final and not result.failed
    assert (result.stop_reason, result.usage.input_tokens) == ("max_tokens", 100)
    # The input is reported as it arrived, cut: it is not valid JSON, and ``harness.run``
    # does not judge it (``request_call`` does).
    (call,) = _write_call_events(sent)
    assert call == {"tool": WRITE, "arguments": ARGUMENTS[:cut]}
    with pytest.raises(json.JSONDecodeError):
        json.loads(call["arguments"])
    # The chat is told the tool started and failed; the input never goes to it.
    assert [event.data for event in sent if event.kind == "tool"] == [
        {"name": "create_budget", "status": "started"},
        {"name": "create_budget", "status": "error"},
    ]
    assert result.text == "Lo preparo.\n\n"


@pytest.mark.parametrize("stop", [True, False])
def test_a_write_call_cut_before_its_input_is_reported_with_an_empty_input(stop: bool) -> None:
    sent, result, raised = _wired(
        *_cut_call(stop=stop), CAP, _usage(100), error="runtimeClientError"
    )
    assert raised is None and result.interrupted and result.usage_final
    # Indistinguishable here from a call the model made with no arguments, but for the stop
    # reason of the message.
    assert _write_call_events(sent) == [{"tool": WRITE, "arguments": ""}]
    assert result.stop_reason == "max_tokens"


def test_a_whole_write_call_and_a_cut_one_in_the_same_message() -> None:
    sent, result, raised = _wired(
        *_cut_call(ARGUMENTS, index=1),
        *_cut_call(ARGUMENTS[:12], index=2, stop=False),
        CAP,
        _usage(100),
        error="runtimeClientError",
    )
    assert raised is None and result.interrupted and result.usage_final
    assert _write_call_events(sent) == [
        {"tool": WRITE, "arguments": ARGUMENTS},
        {"tool": WRITE, "arguments": ARGUMENTS[:12]},
    ]


def test_a_write_call_cut_at_the_cap_whose_usage_never_arrives_is_not_a_known_end() -> None:
    sent, result, raised = _wired(*_cut_call(ARGUMENTS[:12]), CAP, error="runtimeClientError")
    # The call was already reported when the error is raised: the turn fails after it.
    assert raised is not None
    assert _write_call_events(sent) == [{"tool": WRITE, "arguments": ARGUMENTS[:12]}]
    assert result.interrupted and not result.usage_final


@pytest.mark.parametrize("pieces", [(), ('{"start":"2026-',), ('{"start":"2026-09-01"}',)])
def test_a_read_call_cut_at_the_cap_ends_the_turn_as_a_known_end(pieces: tuple[str, ...]) -> None:
    sent, result, raised = _wired(
        _text("Lo consulto."),
        *_cut_call(*pieces, name=READ),
        CAP,
        _usage(100),
        error="runtimeClientError",
    )
    # No write tool: the stream is read to the error, which is the cap end (D74 (13)).
    assert raised is None and "error" not in [event.kind for event in sent]
    assert _write_call_events(sent) == []
    assert result.usage_final and not result.interrupted and not result.failed
    assert (result.stop_reason, result.usage.input_tokens) == ("max_tokens", 100)
    # The tool never ran (the harness stops at the cap): it is left as started, with no
    # result. Nothing of its input is kept or sent.
    assert result.tools == [{"name": "get_cost_and_usage", "status": "started"}]
    assert [event.data for event in sent if event.kind == "tool"] == result.tools
    assert all("2026" not in json.dumps(event.data) for event in sent)
    assert [event.data for event in sent if event.kind == "status"][-1] == {
        "phase": "tool",
        "tool": "get_cost_and_usage",
    }


def test_a_read_call_cut_at_the_cap_whose_usage_never_arrives_is_a_failure() -> None:
    _sent, result, raised = _wired(
        *_cut_call('{"start"', name=READ), CAP, error="runtimeClientError"
    )
    assert raised is not None and not result.usage_final and not result.failed
