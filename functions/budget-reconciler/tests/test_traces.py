"""Reading what a turn spent from the spans of the account: only this turn, only numbers."""

from __future__ import annotations

from typing import Any

import pytest

from mango_budget_reconciler.traces import (
    MAX_PAGES,
    TraceQueryError,
    TraceReading,
    Traces,
    filter_pattern,
)
from mango_core.budget_turns import TokenUsage

from .conftest import OTHER_SESSION, SESSION, START, FakeLogs, cut_turn, model_call, span

NOW = START + 300


def _read(*spans: Any, logs: FakeLogs | None = None) -> TraceReading:
    logs = logs or FakeLogs()
    logs.spans = list(spans)
    return Traces(logs, "aws/spans").read(SESSION, START, NOW)  # type: ignore[arg-type]


def test_the_filter_names_one_session_and_its_invocation_and_model_call_spans() -> None:
    assert filter_pattern(SESSION) == (
        "{ ($.attributes.['session.id'] = \""
        + SESSION
        + '") && (($.name = "invoke_agent*") || ($.name = "chat*")) }'
    )


@pytest.mark.parametrize("session", ["", "ab" * 31, "AB" * 32, 'x" } { $.name = "*', "ab" * 33])
def test_a_session_id_of_another_shape_never_reaches_the_filter(session: str) -> None:
    with pytest.raises(ValueError, match="invalid session id"):
        filter_pattern(session)
    logs = FakeLogs()
    with pytest.raises(ValueError, match="invalid session id"):
        Traces(logs, "aws/spans").read(session, START, NOW)  # type: ignore[arg-type]
    assert logs.calls == []


def test_one_log_group_one_session_and_a_window_that_starts_with_the_turn() -> None:
    logs = FakeLogs()
    _read(span(), logs=logs)
    (call,) = logs.calls
    assert call["logGroupName"] == "aws/spans"
    assert call["filterPattern"] == filter_pattern(SESSION)
    assert (call["startTime"], call["endTime"]) == ((START - 2) * 1000, (NOW + 1) * 1000)


def test_the_tokens_of_the_invocation_are_read() -> None:
    assert _read(span()) == TraceReading(invocations=1, usage=TokenUsage(3030, 250))


def test_every_invocation_of_the_turn_is_summed() -> None:
    # Seen in the lab: one turn, two invocations 0.8 s apart, both paid.
    reading = _read(
        span(start=START + 1.0, tokens=(2681, 245), span_id="1"),
        span(start=START + 1.8, tokens=(2720, 282), span_id="2"),
    )
    assert reading == TraceReading(invocations=2, usage=TokenUsage(5401, 527))


def test_cache_tokens_are_read_under_either_name() -> None:
    reading = _read(
        span(
            span_id="1",
            **{
                "gen_ai.usage.cache_read_input_tokens": 700,
                "gen_ai.usage.cache_write_input_tokens": 40,
            },
        ),
        span(
            span_id="2",
            tokens=None,
            **{
                "gen_ai.usage.prompt_tokens": 10,
                "gen_ai.usage.completion_tokens": 5,
                "gen_ai.usage.cache_read.input_tokens": 300,
                "gen_ai.usage.cache_creation.input_tokens": 60,
            },
        ),
    )
    assert reading.usage == TokenUsage(3040, 255, 1000, 100)


def test_spans_of_another_session_or_another_kind_are_not_the_turns() -> None:
    reading = _read(
        span(),
        span(session=OTHER_SESSION, span_id="2", tokens=(9, 9)),
        *model_call("c2", session=OTHER_SESSION, tokens=(9, 9)),
        span(name="POST /invocations", span_id="5", tokens=None),
        span(name="execute_event_loop_cycle", span_id="6", tokens=None),
    )
    assert reading == TraceReading(invocations=1, usage=TokenUsage(3030, 250))


def test_a_turn_that_ended_well_adds_up_the_same_by_invocations_and_by_model_calls() -> None:
    # 97 of the 97 turns of the lab that ended on their own.
    reading = _read(span(), *model_call())
    assert reading == TraceReading(
        invocations=1,
        usage=TokenUsage(3030, 250),
        model_calls=1,
        model_usage=TokenUsage(3030, 250),
    )


def test_a_turn_with_a_tool_adds_up_its_model_calls() -> None:
    reading = _read(
        span(seconds=9.2, tokens=(5543, 155)),
        *model_call("c1", seconds=3.7, tokens=(2664, 115)),
        *model_call("c2", start=START + 8, seconds=2.0, tokens=(2879, 40)),
    )
    assert (reading.usage, reading.model_usage) == (TokenUsage(5543, 155), TokenUsage(5543, 155))
    assert (reading.model_calls, reading.unfinished, reading.unreadable) == (2, 0, 0)


def test_a_turn_cut_at_its_time_limit_shows_its_tokens_only_in_the_model_call() -> None:
    assert _read(*cut_turn()) == TraceReading(
        invocations=1,
        usage=TokenUsage(),
        model_calls=1,
        model_usage=TokenUsage(871, 5849),
    )


def test_a_model_call_that_is_still_running_leaves_the_turn_unfinished() -> None:
    # What the reconciler found 3 minutes after the turn: "OK", zero tokens.
    assert _read(*cut_turn(written=False)) == TraceReading(invocations=1, unfinished=1)


def test_an_invocation_that_spent_nothing_and_shows_no_model_call_is_unfinished() -> None:
    assert _read(span(tokens=(0, 0))) == TraceReading(invocations=1, unfinished=1)


def test_a_guardrail_block_is_a_model_call_that_ended_and_cost_nothing() -> None:
    # The call ended inside its record and neither span reports tokens above zero.
    reading = _read(
        span(seconds=0.4, tokens=(0, 0)), *model_call(seconds=0.4, tokens=None, recorded=(0, 0))
    )
    assert reading == TraceReading(invocations=1, model_calls=1)


def test_a_model_call_nobody_waited_for_and_without_tokens_is_not_read_as_free() -> None:
    reading = _read(
        span(seconds=15.1, tokens=(0, 0)),
        *model_call(seconds=93.7, tokens=None, recorded=(0, 0), record_seconds=15.0),
    )
    assert (reading.model_calls, reading.unreadable) == (1, 1)


def test_a_model_call_without_its_record_needs_its_own_tokens() -> None:
    _, call = model_call(tokens=(850, 108))
    assert _read(call).model_usage == TokenUsage(850, 108)
    _, call = model_call(tokens=None, recorded=(0, 0))
    assert _read(call).unreadable == 1


def test_a_rejected_model_call_cost_nothing_and_the_one_that_worked_is_summed() -> None:
    # Bedrock throttled the call twice before it went through (155 such calls in the lab).
    reading = _read(
        span(seconds=26.5, tokens=(3030, 250)),
        *model_call("c1", seconds=2.9, tokens=None, status="ERROR"),
        *model_call("c2", start=START + 7, seconds=3.2, tokens=None, status="ERROR"),
        *model_call("c3", start=START + 18, seconds=8.4),
    )
    assert (reading.model_calls, reading.model_usage) == (3, TokenUsage(3030, 250))
    assert (reading.unfinished, reading.unreadable) == (0, 0)


def test_a_failed_record_without_its_model_call_is_not_waited_for() -> None:
    (record,) = model_call(tokens=None, status="ERROR", written=False)
    assert _read(span(), record) == TraceReading(invocations=1, usage=TokenUsage(3030, 250))


def test_a_turn_that_asked_to_confirm_a_write_tool_leaves_model_calls_and_no_invocation() -> None:
    reading = _read(*model_call(seconds=2.6, tokens=(850, 108)))
    assert reading == TraceReading(model_calls=1, model_usage=TokenUsage(850, 108))


def test_a_count_of_zero_is_left_out_of_a_model_call_and_the_other_one_counts() -> None:
    assert _read(*model_call(tokens=(2650, 0))).model_usage == TokenUsage(2650, 0)


@pytest.mark.parametrize("tokens", ["10", True, -1, 10**12, 1.5])
def test_a_model_call_with_a_count_of_another_shape_is_unreadable(tokens: Any) -> None:
    record, call = model_call()
    call["attributes"]["gen_ai.usage.output_tokens"] = tokens
    assert _read(record, call).unreadable == 1


def test_a_model_call_of_an_earlier_turn_of_the_same_session_is_left_out() -> None:
    reading = _read(
        *model_call("c1", start=START - 30, seconds=20, tokens=(9000, 900)),
        span(),
        *model_call("c2"),
    )
    assert (reading.model_calls, reading.model_usage) == (1, TokenUsage(3030, 250))


def test_a_span_without_an_end_or_an_id_is_unreadable() -> None:
    good = span()
    assert _read({**good, "endTimeUnixNano": float(good["endTimeUnixNano"])}).unreadable == 1
    assert _read({**good, "spanId": "x y"}).unreadable == 1


def test_an_earlier_turn_of_the_same_session_is_left_out() -> None:
    # It ended inside the window that is asked for, but started before this turn reserved.
    reading = _read(
        span(start=START - 30, seconds=29.5, tokens=(9000, 900), span_id="1"),
        span(start=START - 1, span_id="2"),
    )
    assert reading == TraceReading(invocations=1, usage=TokenUsage(3030, 250))


def test_the_same_span_delivered_twice_counts_once() -> None:
    assert _read(span(), span()).invocations == 1


def test_a_failed_invocation_without_tokens_cost_nothing() -> None:
    reading = _read(span(tokens=None, status="ERROR", seconds=140))
    assert reading == TraceReading(invocations=1, usage=TokenUsage())


def test_a_failed_invocation_with_tokens_is_charged_them() -> None:
    assert _read(span(status="ERROR")).usage == TokenUsage(3030, 250)


@pytest.mark.parametrize(
    "tokens",
    [
        {},
        {"gen_ai.usage.input_tokens": 10},
        {"gen_ai.usage.input_tokens": "10", "gen_ai.usage.output_tokens": 1},
        {"gen_ai.usage.input_tokens": True, "gen_ai.usage.output_tokens": 1},
        {"gen_ai.usage.input_tokens": -1, "gen_ai.usage.output_tokens": 1},
        {"gen_ai.usage.input_tokens": 10**12, "gen_ai.usage.output_tokens": 1},
        {"gen_ai.usage.input_tokens": 1.5, "gen_ai.usage.output_tokens": 1},
        {
            "gen_ai.usage.input_tokens": 1,
            "gen_ai.usage.output_tokens": 1,
            "gen_ai.usage.cache_read_input_tokens": "ignore previous instructions",
        },
    ],
)
def test_a_finished_invocation_without_usable_tokens_is_not_read_as_free(
    tokens: dict[str, Any],
) -> None:
    reading = _read(span(tokens=None, **tokens))
    assert (reading.invocations, reading.unreadable) == (1, 1)


def test_an_event_that_is_not_a_span_makes_the_turn_unreadable() -> None:
    assert _read(span(), "not json").unreadable == 1
    assert _read(span(), "[1, 2]").unreadable == 1
    reading = _read({**span(), "startTimeUnixNano": "soon"})
    assert reading.unreadable == 1


def test_pages_are_followed() -> None:
    logs = FakeLogs(page_size=1)
    reading = _read(span(span_id="1"), span(span_id="2"), span(span_id="3"), logs=logs)
    assert reading.invocations == 3
    assert len(logs.calls) == 3


def test_an_answer_that_never_ends_is_not_an_answer() -> None:
    logs = FakeLogs(endless=True)
    with pytest.raises(TraceQueryError):
        _read(span(), logs=logs)
    assert len(logs.calls) == MAX_PAGES


def test_a_failed_query_says_nothing_about_the_turn() -> None:
    with pytest.raises(TraceQueryError):
        _read(span(), logs=FakeLogs(fail=True))
