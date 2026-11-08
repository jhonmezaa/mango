"""Tools of remote MCPs in the harness stream (D93, D98 (20)): ``consent_required`` becomes a
``remote_connection_required`` event with the registration only, and the registrations whose
tools answered are kept as the turn's sources."""

from __future__ import annotations

from typing import Any

from mango_api import harness

REG = "abcdefghij23"
OTHER = "zyxwvutsrq23"
TOOL = f"remote-{REG}___core_list_projects"
OTHER_TOOL = f"remote-{OTHER}___wiki"
REMOTES = {TOOL: REG, OTHER_TOOL: OTHER}
CONSENT_ERROR = '{"code":-32001,"message":"consent_required","data":{"mango":"consent_required"}}'


class _Client:
    def __init__(self, stream: list[dict[str, Any]]) -> None:
        self._stream = stream

    def invoke_harness(self, **_request: Any) -> dict[str, Any]:
        return {"stream": self._stream}


def _call(index: int, tool_id: str, name: str) -> list[dict[str, Any]]:
    return [
        {
            "contentBlockStart": {
                "contentBlockIndex": index,
                "start": {"toolUse": {"toolUseId": tool_id, "name": name}},
            }
        },
        {"contentBlockStop": {"contentBlockIndex": index}},
    ]


def _answer(index: int, tool_id: str, text: str, status: str = "success") -> list[dict[str, Any]]:
    return [
        {
            "contentBlockStart": {
                "contentBlockIndex": index,
                "start": {"toolResult": {"toolUseId": tool_id, "status": status}},
            }
        },
        {
            "contentBlockDelta": {
                "contentBlockIndex": index,
                "delta": {"toolResult": [{"text": text[:10]}, {"text": text[10:]}]},
            }
        },
        {"contentBlockStop": {"contentBlockIndex": index}},
    ]


def _turn(
    stream: list[dict[str, Any]], remotes: dict[str, str] | None = REMOTES
) -> tuple[list[harness.StreamEvent], harness.InvocationResult]:
    result = harness.InvocationResult()
    events = list(harness.run(_Client(stream), {}, result, remotes=remotes))  # type: ignore[arg-type]
    return events, result


def _required(events: list[harness.StreamEvent]) -> list[dict[str, Any]]:
    return [e.data for e in events if e.kind == harness.REMOTE_CONNECTION_REQUIRED]


def test_consent_required_names_the_registration_and_never_a_url() -> None:
    stream = [
        *_call(0, "t1", f"mango/{TOOL}"),
        *_answer(1, "t1", CONSENT_ERROR + " https://evil.example/x", status="error"),
        *_call(2, "t2", f"mango/{TOOL}"),
        *_answer(3, "t2", CONSENT_ERROR, status="error"),
    ]
    events, result = _turn(stream)
    assert _required(events) == [{"registration_id": REG}]
    assert result.connection_required == [REG]
    assert result.remote_sources == []
    assert "https" not in str(_required(events))


def test_an_answer_marks_its_registration_as_a_source_once() -> None:
    stream = [
        *_call(0, "t1", f"mango/{TOOL}"),
        *_answer(1, "t1", '{"projects": []}'),
        *_call(2, "t2", TOOL),
        *_answer(3, "t2", "ok"),
        *_call(4, "t3", f"mango/{OTHER_TOOL}"),
        *_answer(5, "t3", CONSENT_ERROR, status="error"),
    ]
    events, result = _turn(stream)
    assert result.remote_sources == [REG]
    assert result.connection_required == [OTHER]
    assert _required(events) == [{"registration_id": OTHER}]


def test_another_error_of_a_remote_tool_is_only_an_error() -> None:
    events, result = _turn([*_call(0, "t1", TOOL), *_answer(1, "t1", "boom", status="error")])
    assert _required(events) == []
    assert (result.connection_required, result.remote_sources) == ([], [])


def test_only_the_invocations_own_remote_tools_count() -> None:
    # A name the model wrote that is not a remote tool of this invocation, even one ending like
    # one after a hyphen, is never read (TM-LP1).
    stream = [
        *_call(0, "t1", f"evil-{TOOL}"),
        *_answer(1, "t1", CONSENT_ERROR, status="error"),
        *_call(2, "t2", "x___t"),
        *_answer(3, "t2", CONSENT_ERROR, status="error"),
    ]
    events, result = _turn(stream)
    assert _required(events) == []
    assert result.connection_required == []
    events, result = _turn([*_call(0, "t1", TOOL), *_answer(1, "t1", CONSENT_ERROR, "error")], None)
    assert _required(events) == []


def test_an_answer_whose_block_never_stopped_is_still_read() -> None:
    stream = [*_call(0, "t1", TOOL), *_answer(1, "t1", CONSENT_ERROR, status="error")[:2]]
    events, _result = _turn(stream)
    assert _required(events) == [{"registration_id": REG}]


def test_only_the_start_of_a_long_error_is_read() -> None:
    text = "x" * harness.MAX_CONSENT_ERROR_CHARS + CONSENT_ERROR
    events, _result = _turn([*_call(0, "t1", TOOL), *_answer(1, "t1", text, status="error")])
    assert _required(events) == []


# --- MCP Apps (D125) ----------------------------------------------------------------------

APP_TOOL = f"remote-{REG}___wit_work_item"


def _call_with_input(index: int, tool_id: str, name: str, arguments: str) -> list[dict[str, Any]]:
    start, stop = _call(index, tool_id, name)
    delta = {
        "contentBlockDelta": {
            "contentBlockIndex": index,
            "delta": {"toolUse": {"input": arguments}},
        }
    }
    return [start, delta, stop]


def _app_turn(stream: list[dict[str, Any]]) -> harness.InvocationResult:
    result = harness.InvocationResult()
    list(
        harness.run(
            _Client(stream),  # type: ignore[arg-type]
            {},
            result,
            remotes={**REMOTES, APP_TOOL: REG},
            apps=frozenset({APP_TOOL}),
        )
    )
    return result


def test_the_calls_of_a_tool_with_an_app_keep_their_input_and_answer() -> None:
    result = _app_turn(
        [
            *_call_with_input(0, "t1", f"mango/{APP_TOOL}", '{"action":"my"}'),
            *_answer(1, "t1", '[{"id":4821,"fields":{}}]'),
            *_call(2, "t2", TOOL),  # no app
            *_answer(3, "t2", "ok"),
        ]
    )
    assert result.app_calls == [
        harness.AppCall(APP_TOOL, '{"action":"my"}', '[{"id":4821,"fields":{}}]')
    ]


def test_a_failed_or_too_large_call_gets_no_app_and_at_most_three_do() -> None:
    big = "x" * (harness.MAX_APP_OUTPUT_CHARS + 1)
    stream = [
        *_call(0, "t0", APP_TOOL),
        *_answer(1, "t0", "boom", status="error"),
        *_call(2, "t1", APP_TOOL),
        *_answer(3, "t1", big),
    ]
    for n in range(5):
        stream += [*_call(10 + 2 * n, f"u{n}", APP_TOOL), *_answer(11 + 2 * n, f"u{n}", f"r{n}")]
    result = _app_turn(stream)
    assert [c.output for c in result.app_calls] == ["r0", "r1", "r2"]


def test_without_apps_nothing_is_kept() -> None:
    _, result = _turn([*_call(0, "t1", APP_TOOL), *_answer(1, "t1", "ok")])
    assert result.app_calls == []
