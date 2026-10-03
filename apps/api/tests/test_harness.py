import json
from collections.abc import Iterator
from typing import Any

import pytest

from mango_api import harness


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
