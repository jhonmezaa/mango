"""Limits of the log tools of the AWS CloudWatch pack (`packs/aws-cloudwatch/entrypoint.py`).

The entry point wraps `execute_log_insights_query` and `analyze_log_group` before it serves
them (D55 (3)): a call outside the limits is refused before any AWS request, and what comes
back is bounded. The upstream server is not installed in the workspace: a fake one stands in
for its `CloudWatchLogsTools`, and the wrappers run on the same MCP SDK as the pack.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from mango_pack_runtime.guard import CallGuard
from mango_pack_runtime.server import bind

ENTRYPOINT = Path(__file__).resolve().parents[2] / "packs" / "aws-cloudwatch" / "entrypoint.py"
ACCOUNT = "444455556666"
OTHER = "999988887777"
NOW = datetime(2026, 11, 13, 22, 0, tzinfo=UTC)
GROUP_ARN = f"arn:aws:logs:us-east-1:{ACCOUNT}:log-group:/aws/lambda/orders"


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("aws_cloudwatch_entrypoint", ENTRYPOINT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ep = _load()


def iso(moment: datetime) -> str:
    return moment.isoformat()


# --- Window ---------------------------------------------------------------------------------


def test_window_of_one_hour_passes_with_an_explicit_offset() -> None:
    start, end = ep.check_window(iso(NOW - timedelta(hours=1)), iso(NOW), NOW)
    assert (start, end) == ("2026-11-13T21:00:00+00:00", "2026-11-13T22:00:00+00:00")


def test_window_without_offset_is_read_as_utc() -> None:
    start, _ = ep.check_window("2026-11-13T21:00:00", "2026-11-13T22:00:00", NOW)
    assert start == "2026-11-13T21:00:00+00:00"


def test_window_of_exactly_24_hours_passes_and_one_second_more_does_not() -> None:
    ep.check_window(iso(NOW - timedelta(hours=24)), iso(NOW), NOW)
    with pytest.raises(ep.LimitError, match="at most 24 hours"):
        ep.check_window(iso(NOW - timedelta(hours=24, seconds=1)), iso(NOW), NOW)


def test_window_over_24_hours_counts_offsets() -> None:
    # 20 hours apart on the clock, 25 hours apart in time.
    with pytest.raises(ep.LimitError, match="at most 24 hours"):
        ep.check_window("2026-11-12T22:00:00+00:00", "2026-11-13T18:00:00-05:00", NOW)


def test_window_must_move_forward() -> None:
    for start, end in ((NOW, NOW), (NOW, NOW - timedelta(minutes=1))):
        with pytest.raises(ep.LimitError, match="later than"):
            ep.check_window(iso(start), iso(end), NOW)


def test_window_starts_at_most_30_days_ago() -> None:
    ep.check_window(iso(NOW - timedelta(days=30)), iso(NOW - timedelta(days=29, hours=1)), NOW)
    with pytest.raises(ep.LimitError, match="30 days"):
        ep.check_window(
            iso(NOW - timedelta(days=30, seconds=1)), iso(NOW - timedelta(days=29, hours=1)), NOW
        )


@pytest.mark.parametrize("value", ["yesterday", "", "1731535200", None, 1731535200])
def test_window_takes_only_iso_times(value: object) -> None:
    with pytest.raises(ep.LimitError, match="ISO 8601"):
        ep.check_window(value, iso(NOW), NOW)


# --- Log groups -----------------------------------------------------------------------------


def test_exactly_one_list_of_log_groups() -> None:
    for names, identifiers in ((None, None), ([], []), (["a"], ["b"])):
        with pytest.raises(ep.LimitError, match="exactly one"):
            ep.check_log_groups(names, identifiers, ACCOUNT)


def test_at_most_five_log_groups() -> None:
    five = [f"/app/{n}" for n in range(5)]
    assert ep.check_log_groups(five, None, ACCOUNT) == (five, None)
    with pytest.raises(ep.LimitError, match="at most 5"):
        ep.check_log_groups([*five, "/app/5"], None, ACCOUNT)
    with pytest.raises(ep.LimitError, match="at most 5"):
        ep.check_log_groups(None, [*five, "/app/5"], ACCOUNT)


def test_identifiers_take_names_and_arns_of_the_account_of_the_call() -> None:
    identifiers = ["/app/api", GROUP_ARN, f"{GROUP_ARN}:*"]
    assert ep.check_log_groups(None, identifiers, ACCOUNT) == (None, identifiers)


def test_arns_of_another_account_are_refused() -> None:
    # A monitoring account reads its source accounts through their ARNs (TM-CW5).
    other = f"arn:aws:logs:us-east-1:{OTHER}:log-group:/aws/lambda/orders"
    with pytest.raises(ep.LimitError, match="account named by 'account_id'"):
        ep.check_log_groups(None, ["/app/api", other], ACCOUNT)


@pytest.mark.parametrize(
    "value",
    [
        f"arn:aws:logs:us-east-1:{ACCOUNT}:log-stream:/app",
        f"arn:aws:s3:::{ACCOUNT}",
        f"arn:aws:logs:us-east-1:{ACCOUNT}:log-group:/app:extra",
        "arn:aws:logs:us-east-1:12345:log-group:/app",
        "/app/a b",
        "",
    ],
)
def test_anything_else_with_a_colon_or_odd_characters_is_refused(value: str) -> None:
    with pytest.raises(ep.LimitError):
        ep.check_log_groups(None, [value], ACCOUNT)


def test_names_take_no_arns() -> None:
    with pytest.raises(ep.LimitError, match="not ARNs"):
        ep.check_log_groups([GROUP_ARN], None, ACCOUNT)


def test_analyze_takes_one_arn_of_the_account() -> None:
    assert ep.check_log_group_arn(GROUP_ARN, ACCOUNT) == GROUP_ARN
    for value in (GROUP_ARN.replace(ACCOUNT, OTHER), "/aws/lambda/orders", None):
        with pytest.raises(ep.LimitError):
            ep.check_log_group_arn(value, ACCOUNT)


@pytest.mark.parametrize(
    "query_string",
    [
        "SOURCE logGroups(namePrefix: ['/aws/lambda']) | fields @message",
        "source  LOGGROUPS(accountIdentifiers: ['999988887777']) | limit 5",
    ],
)
def test_a_query_cannot_pick_its_own_log_groups(query_string: str) -> None:
    with pytest.raises(ep.LimitError, match="SOURCE"):
        ep.check_query(query_string)


def test_an_ordinary_query_passes() -> None:
    text = "filter @message like /Exception/ | stats count(*) by bin(1h)"
    assert ep.check_query(text) == text
    for value in ("", "   ", None):
        with pytest.raises(ep.LimitError):
            ep.check_query(value)


# --- Rows, poll time and results ------------------------------------------------------------


def test_rows_are_required_and_at_most_200() -> None:
    assert ep.check_rows(200) == 200
    for value in (None, 0, 201, 10_000, True, "50"):
        with pytest.raises(ep.LimitError, match="'limit' is required"):
            ep.check_rows(value)


def test_poll_time_is_at_most_60_seconds() -> None:
    assert ep.check_timeout(60) == 60
    for value in (0, 61, 300, True, None):
        with pytest.raises(ep.LimitError, match="max_timeout"):
            ep.check_timeout(value)


def test_every_string_is_cut_to_2_kb_without_breaking_a_character() -> None:
    text = "ñ" * 2000  # 4000 bytes
    cut = ep.truncate({"rows": [{"@message": text, "n": 3}], "short": "ok"})
    message = cut["rows"][0]["@message"]
    assert message.endswith(ep.TRUNCATED_MARK)
    assert len(message.removesuffix(ep.TRUNCATED_MARK).encode()) == 2048
    assert cut["rows"][0]["n"] == 3
    assert cut["short"] == "ok"
    assert ep.truncate("x" * 2048) == "x" * 2048


def test_a_query_result_is_bounded() -> None:
    result = {
        "queryId": "q-1",
        "status": "Complete",
        "statistics": {"bytesScanned": 1024.0},
        "results": [{"@message": "m" * 5000} for _ in range(250)],
    }
    bounded = ep.bound_query_result(result, 200, 30)
    assert "queryId" not in bounded
    assert len(bounded["results"]) == 200
    assert bounded["message"] == "Only the first 200 of 250 rows are returned."
    assert all(row["@message"].endswith(ep.TRUNCATED_MARK) for row in bounded["results"])
    assert bounded["statistics"] == {"bytesScanned": 1024.0}


def test_a_timeout_does_not_point_to_a_tool_the_pack_does_not_serve() -> None:
    upstream = {
        "queryId": "q-1",
        "status": "Polling Timeout",
        "message": "Use get_logs_insight_query_results with the returned queryId",
        "results": [],
    }
    bounded = ep.bound_query_result(upstream, 50, 45)
    assert "get_logs_insight_query_results" not in json.dumps(bounded)
    assert "45 s" in bounded["message"]


def test_an_analysis_is_bounded() -> None:
    anomaly = {"patternString": "p" * 3000, "logSamples": [{"message": "s" * 3000}]}
    analysis = {
        "log_anomaly_results": {"anomaly_detectors": [], "anomalies": [anomaly] * 300},
        "top_patterns": {"queryId": "q", "status": "Complete", "results": [{"@pattern": "x"}]},
        "top_patterns_containing_errors": {
            "queryId": "q",
            "status": "Polling Timeout",
            "message": "Use get_logs_insight_query_results",
            "results": [],
        },
    }
    bounded = ep.bound_analysis(analysis, 30)
    anomalies = bounded["log_anomaly_results"]["anomalies"]
    assert len(anomalies) == 200
    assert anomalies[0]["logSamples"][0]["message"].endswith(ep.TRUNCATED_MARK)
    assert "queryId" not in bounded["top_patterns"]
    assert "get_logs_insight_query_results" not in json.dumps(bounded)


# --- The account of the call ----------------------------------------------------------------


class FakeGuard:
    """Stands in for the common guard: removes Mango's argument, or refuses the call."""

    def __init__(self, refuse: bool = False) -> None:
        self.refuse = refuse

    @contextmanager
    def call(self, tool: str, arguments: Mapping[str, Any] | None) -> Iterator[dict[str, Any]]:
        if self.refuse:
            raise ToolError("refused")
        cleaned = dict(arguments or {})
        cleaned.pop("account_id", None)
        cleaned.pop("_mango_ctx", None)
        yield cleaned


def test_the_account_is_visible_only_while_the_call_runs() -> None:
    scope = ep.AccountScope(FakeGuard())
    with scope.call("analyze_log_group", {"account_id": ACCOUNT, "x": 1}) as cleaned:
        assert cleaned == {"x": 1}
        assert ep.current_account() == ACCOUNT
    with pytest.raises(ep.LimitError):
        ep.current_account()


def test_the_scope_offers_what_the_runtime_asks_of_its_guard() -> None:
    # `Pack.serve` calls the guard's own methods (default_region_for since the member chain
    # fills a left-out Region): the scope must answer each of them as the common guard does.
    public = {name for name in vars(CallGuard) if not name.startswith("_")}
    named: list[frozenset[str]] = []

    class RecordingGuard(FakeGuard):
        def default_region_for(self, tools: frozenset[str]) -> None:
            named.append(tools)

    scope = ep.AccountScope(RecordingGuard())
    for name in public:
        assert callable(getattr(scope, name)), name
    scope.default_region_for(frozenset({"execute_log_insights_query"}))
    assert named == [frozenset({"execute_log_insights_query"})]


def test_a_refused_call_leaves_no_account_behind() -> None:
    scope = ep.AccountScope(FakeGuard(refuse=True))
    with pytest.raises(ToolError), scope.call("analyze_log_group", {"account_id": ACCOUNT}):
        pass
    with pytest.raises(ep.LimitError):
        ep.current_account()


# --- The served tools -----------------------------------------------------------------------


class Analysis:
    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    def model_dump(self) -> dict[str, Any]:
        return self._data


class FakeUpstream:
    """The methods of upstream's `CloudWatchLogsTools` the wrappers call."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def execute_log_insights_query(self, ctx: Any, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("execute", kwargs))
        return {
            "queryId": "q-1",
            "status": "Complete",
            "statistics": {"bytesScanned": 10.0},
            "results": [{"@message": "m" * 3000}] * 300,
        }

    async def analyze_log_group(self, ctx: Any, **kwargs: Any) -> Analysis:
        self.calls.append(("analyze", kwargs))
        return Analysis(
            {
                "log_anomaly_results": {"anomaly_detectors": [], "anomalies": []},
                "top_patterns": {"queryId": "q", "status": "Complete", "results": []},
                "top_patterns_containing_errors": {"status": "Complete", "results": []},
            }
        )


def served() -> tuple[MCPServer, FakeUpstream]:
    mcp = MCPServer("test")

    # What upstream registers under these names: replaced, never called.
    @mcp.tool(name="execute_log_insights_query")
    def unbounded_query(query_string: str, limit: int | None = None) -> str:
        raise AssertionError("the upstream tool must not be served")

    @mcp.tool(name="analyze_log_group")
    def unbounded_analysis(log_group_arn: str) -> str:
        raise AssertionError("the upstream tool must not be served")

    upstream = FakeUpstream()
    ep.bound_log_tools(mcp, upstream, now=lambda: NOW)
    bind(mcp, ep.AccountScope(FakeGuard()))
    return mcp, upstream


def schemas(mcp: MCPServer) -> dict[str, dict[str, Any]]:
    return {tool.name: tool.input_schema for tool in asyncio.run(mcp.list_tools())}


def call(mcp: MCPServer, tool: str, arguments: dict[str, Any]) -> Any:
    return asyncio.run(mcp.call_tool(tool, {"account_id": ACCOUNT, **arguments}))


def query(**overrides: Any) -> dict[str, Any]:
    return {
        "log_group_names": ["/aws/lambda/orders"],
        "start_time": iso(NOW - timedelta(hours=1)),
        "end_time": iso(NOW),
        "query_string": "fields @timestamp, @message | sort @timestamp desc",
        "limit": 50,
        **overrides,
    }


def test_the_listed_schemas_carry_the_limits() -> None:
    mcp, _ = served()
    listed = schemas(mcp)
    execute = listed["execute_log_insights_query"]
    props = execute["properties"]
    assert set(execute["required"]) == {"start_time", "end_time", "query_string", "limit"}
    assert props["limit"]["maximum"] == 200
    assert props["max_timeout"]["maximum"] == 60
    for name in ("log_group_names", "log_group_identifiers"):
        assert props[name]["anyOf"][0]["maxItems"] == 5
    assert "profile_name" not in props
    analyze = listed["analyze_log_group"]
    assert set(analyze["required"]) == {"log_group_arn", "start_time", "end_time"}
    assert "profile_name" not in analyze["properties"]


def test_a_query_inside_the_limits_reaches_upstream_and_comes_back_bounded() -> None:
    mcp, upstream = served()
    result = call(mcp, "execute_log_insights_query", query())
    assert not result.is_error
    [(kind, kwargs)] = upstream.calls
    assert kind == "execute"
    assert kwargs == {
        "log_group_names": ["/aws/lambda/orders"],
        "log_group_identifiers": None,
        "start_time": "2026-11-13T21:00:00+00:00",
        "end_time": "2026-11-13T22:00:00+00:00",
        "query_string": "fields @timestamp, @message | sort @timestamp desc",
        "limit": 50,
        "max_timeout": 30,
        "region": None,
        "profile_name": None,
    }
    body = result.structured_content
    assert "queryId" not in body
    assert len(body["results"]) == 50
    assert body["results"][0]["@message"].endswith(ep.TRUNCATED_MARK)


@pytest.mark.parametrize(
    "overrides",
    [
        {"start_time": iso(NOW - timedelta(hours=25))},
        {
            "start_time": iso(NOW - timedelta(days=31)),
            "end_time": iso(NOW - timedelta(days=31) + timedelta(hours=1)),
        },
        {"limit": 201},
        {"limit": None},
        {"max_timeout": 61},
        {"log_group_names": [f"/g/{n}" for n in range(6)]},
        {"log_group_names": None, "log_group_identifiers": [GROUP_ARN.replace(ACCOUNT, OTHER)]},
        {"log_group_names": None},
        {"query_string": "SOURCE logGroups(namePrefix: ['/']) | fields @message"},
    ],
)
def test_a_query_outside_the_limits_never_reaches_upstream(overrides: dict[str, Any]) -> None:
    mcp, upstream = served()
    arguments = {key: value for key, value in query(**overrides).items() if value is not None}
    with pytest.raises(ToolError):
        call(mcp, "execute_log_insights_query", arguments)
    assert upstream.calls == []


def test_an_analysis_inside_the_limits_reaches_upstream() -> None:
    mcp, upstream = served()
    result = call(
        mcp,
        "analyze_log_group",
        {
            "log_group_arn": GROUP_ARN,
            "start_time": iso(NOW - timedelta(hours=1)),
            "end_time": iso(NOW),
        },
    )
    assert not result.is_error
    [(kind, kwargs)] = upstream.calls
    assert kind == "analyze"
    assert kwargs["log_group_arn"] == GROUP_ARN
    assert kwargs["profile_name"] is None
    assert "queryId" not in result.structured_content["top_patterns"]


@pytest.mark.parametrize(
    "overrides",
    [
        {"log_group_arn": GROUP_ARN.replace(ACCOUNT, OTHER)},
        {"start_time": iso(NOW - timedelta(hours=30))},
    ],
)
def test_an_analysis_outside_the_limits_never_reaches_upstream(overrides: dict[str, Any]) -> None:
    mcp, upstream = served()
    arguments = {
        "log_group_arn": GROUP_ARN,
        "start_time": iso(NOW - timedelta(hours=1)),
        "end_time": iso(NOW),
        **overrides,
    }
    with pytest.raises(ToolError):
        call(mcp, "analyze_log_group", arguments)
    assert upstream.calls == []
