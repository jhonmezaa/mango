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

from .conftest import OTHER_SESSION, SESSION, START, FakeLogs, span

NOW = START + 300


def _read(*spans: Any, logs: FakeLogs | None = None) -> TraceReading:
    logs = logs or FakeLogs()
    logs.spans = list(spans)
    return Traces(logs, "aws/spans").read(SESSION, START, NOW)  # type: ignore[arg-type]


def test_the_filter_names_one_session_and_the_invocation_spans() -> None:
    assert filter_pattern(SESSION) == (
        "{ ($.attributes.['session.id'] = \"" + SESSION + '") && ($.name = "invoke_agent*") }'
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
        # The same tokens again, as the harness writes them for each model call.
        span(name="chat", span_id="3"),
        span(name="chat us.anthropic.claude-sonnet-4-6", span_id="4"),
        span(name="POST /invocations", span_id="5", tokens=None),
    )
    assert reading == TraceReading(invocations=1, usage=TokenUsage(3030, 250))


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
