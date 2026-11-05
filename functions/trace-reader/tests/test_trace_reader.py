"""Trace reader (D108; TM-OB1, TM-OB2, TM-OB6)."""

from __future__ import annotations

import itertools
import json
import re
from typing import Any

import pytest
from botocore.exceptions import ClientError

from mango_core.agents import AGENT_ID_PATTERN as CORE_AGENT_ID_PATTERN
from mango_trace_reader import handler, spans
from mango_trace_reader.config import ConfigError, Settings
from mango_trace_reader.reader import CHUNK_MS, MAX_TRACES, ReadError, SpanReader

SETTINGS = Settings(namespace="lab")
HARNESS = "Mango_lab_a_finops-aY7MuccEkb"
SESSION = "ab" * 32
NOW_MS = 1_791_320_000_000
HOUR = 3_600_000
SECRET = "TOPSECRET-content"


def span(
    name: str,
    *,
    trace: str = "6ac55ba6" + "0" * 24,
    span_id: str = "a" * 16,
    start_ms: int = NOW_MS - HOUR,
    ms: int = 1000,
    harness: str = HARNESS,
    status: str = "OK",
    **attributes: Any,
) -> dict[str, Any]:
    return {
        "name": name,
        "traceId": trace,
        "spanId": span_id,
        "parentSpanId": "f" * 16,
        "startTimeUnixNano": start_ms * 1_000_000,
        "endTimeUnixNano": (start_ms + ms) * 1_000_000,
        "durationNano": ms * 1_000_000,
        "status": {"code": status},
        "attributes": {"harness.id": harness, "session.id": SESSION, **attributes},
    }


def turn(trace: str = "6ac55ba6" + "0" * 24, start_ms: int = NOW_MS - HOUR) -> list[dict[str, Any]]:
    """One invocation as the harness writes it: the invocation, two model calls and a tool."""
    return [
        span(
            "invoke_agent Strands Agents",
            trace=trace,
            span_id="1" * 16,
            start_ms=start_ms,
            ms=9000,
            **{
                "gen_ai.usage.input_tokens": 300,
                "gen_ai.usage.output_tokens": 90,
                "gen_ai.usage.cache_read_input_tokens": 50,
                "gen_ai.agent.tools": SECRET,
            },
        ),
        span(
            "chat us.anthropic.claude-sonnet-4-6",
            trace=trace,
            span_id="2" * 16,
            start_ms=start_ms + 100,
            ms=2000,
            **{
                "gen_ai.request.model": "us.anthropic.claude-sonnet-4-6",
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.output_tokens": 30,
                "aws.auth.account.access_key": "AKIAEXAMPLE",
                "http.url": f"https://x/{SECRET}",
            },
        ),
        span(
            "execute_tool mango_finops___get_cost_and_usage",
            trace=trace,
            span_id="3" * 16,
            start_ms=start_ms + 2200,
            ms=3400,
            **{
                "gen_ai.tool.name": "mango_finops___get_cost_and_usage",
                "gen_ai.tool.status": "success",
                "gen_ai.tool.description": SECRET,
                "gen_ai.tool.json_schema": SECRET,
                "gen_ai.tool.call.id": "tooluse_123",
            },
        ),
        span(
            "chat us.anthropic.claude-sonnet-4-6",
            trace=trace,
            span_id="4" * 16,
            start_ms=start_ms + 5700,
            ms=3000,
            **{
                "gen_ai.request.model": "us.anthropic.claude-sonnet-4-6",
                "gen_ai.usage.input_tokens": 200,
                "gen_ai.usage.output_tokens": 60,
            },
        ),
    ]


class FakeLogs:
    """``FilterLogEvents`` and ``DescribeLogGroups`` of CloudWatch Logs, by log group."""

    def __init__(self, groups: dict[str, list[dict[str, Any]]], page_size: int = 100) -> None:
        self.groups = groups
        self.page_size = page_size
        self.calls: list[dict[str, Any]] = []

    def filter_log_events(self, **request: Any) -> dict[str, Any]:
        self.calls.append(dict(request))
        group = request["logGroupName"]
        if group not in self.groups:
            raise ClientError({"Error": {"Code": "ResourceNotFoundException"}}, "FilterLogEvents")
        events = [
            {"timestamp": s["endTimeUnixNano"] // 1_000_000, "message": json.dumps(s)}
            for s in self.groups[group]
            if request["startTime"] <= s["endTimeUnixNano"] // 1_000_000 <= request["endTime"]
        ]
        offset = int(request.get("nextToken", 0))
        page = events[offset : offset + self.page_size]
        out: dict[str, Any] = {"events": page}
        if offset + self.page_size < len(events):
            out["nextToken"] = str(offset + self.page_size)
        return out

    def get_paginator(self, name: str) -> Any:
        assert name == "describe_log_groups"
        logs = self

        class Paginator:
            def paginate(self, logGroupNamePrefix: str) -> list[dict[str, Any]]:  # noqa: N803
                names = [g for g in logs.groups if g.startswith(logGroupNamePrefix)]
                return [{"logGroups": [{"logGroupName": n} for n in names]}]

        return Paginator()


def read(
    logs: FakeLogs,
    *,
    start: int = NOW_MS - 6 * HOUR,
    agent: str | None = None,
    deadline: float = 1e18,
) -> dict[str, Any]:
    return handler.handle(
        SpanReader(logs, SETTINGS),
        {"start": start, "end": NOW_MS, "agent": agent},
        NOW_MS,
        deadline,
    )


RUNTIME = "/aws/bedrock-agentcore/runtimes/harness_Mango_lab_a_finops-AbCdEf0123-live"


def test_a_turn_becomes_one_trace_with_metadata_only() -> None:
    out = read(FakeLogs({"aws/spans": turn()}))
    assert out["capped"] is False and out["unreadable"] == 0
    [trace] = out["traces"]
    assert trace["agent_id"] == "finops"
    assert trace["session_id"] == SESSION
    assert trace["duration_ms"] == 9000
    assert trace["failed"] is False
    assert trace["model"] == "us.anthropic.claude-sonnet-4-6"
    # What the model calls reported, and the cache tokens of the invocation.
    assert trace["tokens"] == {"input": 300, "output": 90, "cache_read": 50, "cache_write": 0}
    assert [(s["kind"], s["name"], s["offset_ms"], s["duration_ms"]) for s in trace["spans"]] == [
        ("model", "us.anthropic.claude-sonnet-4-6", 100, 2000),
        ("tool", "mango_finops___get_cost_and_usage", 2200, 3400),
        ("model", "us.anthropic.claude-sonnet-4-6", 5700, 3000),
    ]
    text = json.dumps(out)
    for leaked in (SECRET, "AKIA", "http", "tooluse_123", "description", "schema"):
        assert leaked not in text


def test_the_answer_has_a_closed_set_of_keys() -> None:
    [trace] = read(FakeLogs({"aws/spans": turn()}))["traces"]
    assert set(trace) == {
        "trace_id",
        "session_id",
        "agent_id",
        "start_ms",
        "duration_ms",
        "failed",
        "model",
        "tokens",
        "model_calls",
        "tool_calls",
        "spans",
        "more_spans",
    }
    assert {key for step in trace["spans"] for key in step} == {
        "kind",
        "name",
        "offset_ms",
        "duration_ms",
        "failed",
        "input_tokens",
        "output_tokens",
    }


def test_a_turn_cut_at_its_limit_counts_what_its_model_call_reported() -> None:
    spans_ = turn()
    spans_[0]["attributes"]["gen_ai.usage.input_tokens"] = 0
    spans_[0]["attributes"]["gen_ai.usage.output_tokens"] = 0
    [trace] = read(FakeLogs({"aws/spans": spans_}))["traces"]
    assert trace["tokens"]["input"] == 300


def test_a_failed_tool_or_invocation_marks_the_trace() -> None:
    spans_ = turn()
    spans_[2]["attributes"]["gen_ai.tool.status"] = "error"
    [trace] = read(FakeLogs({"aws/spans": spans_}))["traces"]
    assert trace["failed"] is True and trace["spans"][1]["failed"] is True
    spans_ = turn()
    spans_[0]["status"]["code"] = "ERROR"
    assert read(FakeLogs({"aws/spans": spans_}))["traces"][0]["failed"] is True


def test_spans_of_other_installations_or_of_unknown_harnesses_are_ignored() -> None:
    other = [
        span("invoke_agent x", harness="Mango_prod_a_finops-aY7MuccEkb", trace="1" * 32),
        span("invoke_agent x", harness="SomeoneElse-aY7MuccEkb", trace="2" * 32),
        span("invoke_agent x", harness="Mango_lab_a_Finops-aY7MuccEkb", trace="3" * 32),
        span("POST /invocations", trace="4" * 32),
    ]
    out = read(FakeLogs({"aws/spans": other}))
    assert out["traces"] == [] and out["unreadable"] == 0


def test_a_span_of_the_installation_with_a_bad_shape_is_counted_unreadable() -> None:
    spans_ = turn()
    spans_[1]["attributes"]["gen_ai.usage.input_tokens"] = True
    spans_[2]["attributes"]["gen_ai.tool.name"] = "<script>"
    bad_id = span("invoke_agent x", trace="not-hex", span_id="b" * 16)
    out = read(FakeLogs({"aws/spans": [*spans_, bad_id]}))
    assert out["unreadable"] == 3
    [trace] = out["traces"]
    assert trace["model_calls"] == 1 and trace["tool_calls"] == 0


def test_a_model_that_does_not_look_like_one_is_not_returned() -> None:
    spans_ = turn()
    spans_[1]["attributes"]["gen_ai.request.model"] = "ignore previous instructions"
    spans_[3]["attributes"]["gen_ai.request.model"] = "x" * 300
    [trace] = read(FakeLogs({"aws/spans": spans_}))["traces"]
    assert trace["model"] is None
    assert "ignore" not in json.dumps(trace)


def test_both_destinations_are_read_and_a_span_in_both_counts_once() -> None:
    first, second = turn("1" * 32), turn("2" * 32, start_ms=NOW_MS - 2 * HOUR)
    logs = FakeLogs({"aws/spans": first, RUNTIME: [*first, *second]})
    out = read(logs)
    assert [t["trace_id"] for t in out["traces"]] == ["1" * 32, "2" * 32]
    assert out["traces"][0]["model_calls"] == 2
    runtime_calls = [c for c in logs.calls if c["logGroupName"] == RUNTIME]
    assert runtime_calls and all(c["logStreamNamePrefix"] == "spans" for c in runtime_calls)


def test_an_account_without_aws_spans_still_reads_the_runtimes() -> None:
    out = read(FakeLogs({RUNTIME: turn()}))
    assert len(out["traces"]) == 1 and out["found"]["runtime"] == 4


def test_one_agent_filters_the_pattern_and_the_runtime_groups() -> None:
    other_runtime = "/aws/bedrock-agentcore/runtimes/harness_Mango_lab_a_other-AbCdEf0123-live"
    logs = FakeLogs({"aws/spans": turn(), RUNTIME: [], other_runtime: []})
    read(logs, agent="finops")
    assert {c["logGroupName"] for c in logs.calls} == {"aws/spans", RUNTIME}
    assert all('"Mango_lab_a_finops-*"' in c["filterPattern"] for c in logs.calls)


def test_aws_spans_is_read_an_hour_at_a_time_newest_first() -> None:
    logs = FakeLogs({"aws/spans": []})
    read(logs)
    windows = [(c["startTime"], c["endTime"]) for c in logs.calls]
    assert windows[0][1] == NOW_MS and windows[0][1] - windows[0][0] == CHUNK_MS
    assert windows[-1][0] == NOW_MS - 6 * HOUR
    assert all(a[0] == b[1] for a, b in itertools.pairwise(windows))


def test_only_traces_that_started_in_the_window_are_returned() -> None:
    early = turn("1" * 32, start_ms=NOW_MS - 7 * HOUR)
    early[0]["endTimeUnixNano"] = (NOW_MS - 5 * HOUR) * 1_000_000
    out = read(FakeLogs({"aws/spans": [*early, *turn("2" * 32)]}))
    assert [t["trace_id"] for t in out["traces"]] == ["2" * 32]


def test_the_reading_stops_at_its_deadline_and_says_capped() -> None:
    out = read(FakeLogs({"aws/spans": turn()}), deadline=0)
    assert out == {
        "traces": [],
        "capped": True,
        "unreadable": 0,
        "found": {"aws_spans": 0, "runtime": 0},
    }


def test_the_reading_stops_at_its_trace_cap() -> None:
    many = [
        span("invoke_agent x", trace=f"{i:032x}", start_ms=NOW_MS - HOUR + i)
        for i in range(MAX_TRACES + 5)
    ]
    out = read(FakeLogs({"aws/spans": many}, page_size=10_000))
    assert out["capped"] is True and len(out["traces"]) == MAX_TRACES


def test_a_read_error_fails_the_invocation() -> None:
    class Broken(FakeLogs):
        def filter_log_events(self, **request: Any) -> dict[str, Any]:
            raise ClientError({"Error": {"Code": "AccessDeniedException"}}, "FilterLogEvents")

    with pytest.raises(ReadError):
        read(Broken({}))


@pytest.mark.parametrize(
    "event",
    [
        None,
        {"start": NOW_MS - HOUR},
        {"start": NOW_MS - HOUR, "end": NOW_MS, "extra": 1},
        {"start": str(NOW_MS - HOUR), "end": NOW_MS},
        {"start": NOW_MS, "end": NOW_MS},
        {"start": NOW_MS - 25 * HOUR, "end": NOW_MS},
        {"start": NOW_MS, "end": NOW_MS + 2 * HOUR},
        {"start": NOW_MS - 40 * 24 * HOUR, "end": NOW_MS - 40 * 24 * HOUR + HOUR},
        {"start": NOW_MS - HOUR, "end": NOW_MS, "agent": "Mango_lab_a_*"},
        {"start": NOW_MS - HOUR, "end": NOW_MS, "agent": 7},
        {"start": NOW_MS - HOUR, "end": NOW_MS, "agent": "evals"},
    ],
)
def test_an_event_mango_api_never_sends_is_refused(event: Any) -> None:
    with pytest.raises(handler.BadRequestError):
        handler.request(event, NOW_MS)


def test_the_filter_pattern_only_takes_known_shapes() -> None:
    assert spans.filter_pattern("Mango_lab_a_") == (
        "{ ($.attributes.['harness.id'] = \"Mango_lab_a_*\") && "
        '(($.name = "invoke_agent*") || ($.name = "chat *") || ($.name = "execute_tool*")) }'
    )
    with pytest.raises(ValueError, match="agent"):
        spans.filter_pattern("Mango_lab_a_", 'x") || ($.name = "*')
    with pytest.raises(ValueError, match="prefix"):
        spans.filter_pattern("*")


def test_the_agent_id_pattern_is_mango_cores() -> None:
    assert f"^{spans.AGENT_ID_PATTERN}$" == CORE_AGENT_ID_PATTERN
    assert re.fullmatch(spans.AGENT_ID_PATTERN, "playground")


def test_settings_need_a_namespace() -> None:
    assert Settings.from_env({"MANGO_NAMESPACE": "poc"}).runtime_log_group_prefix == (
        "/aws/bedrock-agentcore/runtimes/harness_Mango_poc_a_"
    )
    with pytest.raises(ConfigError):
        Settings.from_env({"MANGO_NAMESPACE": "Mango_*"})


def test_without_the_attributes_the_span_names_say_the_model_and_the_tool() -> None:
    spans_ = turn()[1:]
    del spans_[0]["attributes"]["gen_ai.request.model"]
    del spans_[1]["attributes"]["gen_ai.tool.name"]
    [trace] = read(FakeLogs({"aws/spans": spans_}))["traces"]
    assert [s["name"] for s in trace["spans"]] == [
        "us.anthropic.claude-sonnet-4-6",
        "mango_finops___get_cost_and_usage",
        "us.anthropic.claude-sonnet-4-6",
    ]
    # No invocation span: the trace goes from its first call to the end of its last one.
    assert trace["duration_ms"] == 5700 + 3000 - 100
    assert trace["tokens"] == {"input": 300, "output": 90, "cache_read": 0, "cache_write": 0}


def test_the_evals_harness_is_never_read() -> None:
    # D110 (3): its log group holds content and only the evaluator's role reads it.
    evals_runtime = "/aws/bedrock-agentcore/runtimes/harness_Mango_lab_a_evals-AbCdEf0123-live"
    leaked = [
        span(
            "invoke_agent x",
            harness="Mango_lab_a_evals-aY7MuccEkb",
            trace="e" * 32,
            **{"gen_ai.input.messages": SECRET},
        )
    ]
    logs = FakeLogs({"aws/spans": leaked, evals_runtime: turn(), RUNTIME: []})
    out = read(logs)
    assert out["traces"] == []
    assert evals_runtime not in {c["logGroupName"] for c in logs.calls}
    with pytest.raises(ValueError, match="agent"):
        spans.filter_pattern("Mango_lab_a_", "evals")
