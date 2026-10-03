"""The entry point against the real ``fastmcp`` library the Billing server is built on (S-M1,
S-M3): the same isolation as ``test_server.py`` for the official SDK. Tools outside the
manifest, prompts and resources are gone, and concurrent ``tools/call`` requests over
stateless streamable HTTP run each tool, also one of a mounted server, with the credentials
of its own caller."""

from __future__ import annotations

import asyncio
import json
import logging
import socket
import threading
import time
from collections.abc import Iterator
from typing import Any

import boto3
import httpx
import pytest
import uvicorn
from fastmcp import Context, FastMCP
from fastmcp.server.middleware import Middleware

from mango_pack_runtime.fastmcp_server import (
    CLIENT_LOG,
    MCP_PATH,
    bind,
    log_calls,
    open_schemas,
    restrict_tools,
)
from mango_pack_runtime.guard import CallGuard
from mango_pack_runtime.identity import IdentityVerifier
from mango_pack_runtime.server import REFUSED_MESSAGE

from .conftest import PACK, IdentityKey, central_config, echo_signer, keys_of

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
}
TOOLS = frozenset({"cost-explorer", "cost-anomaly", "sp-performance"})


class _Seen(Middleware):
    """An upstream middleware (Billing registers one): what it sees of each call."""

    def __init__(self) -> None:
        self.arguments: list[dict[str, Any]] = []

    async def on_call_tool(self, context: Any, call_next: Any) -> Any:
        self.arguments.append(dict(context.message.arguments or {}))
        return await call_next(context)


def _upstream(seen: _Seen) -> FastMCP[Any]:
    """An upstream server laid out like Billing: one server per tool, mounted on the main
    one by a ``setup`` step, with the credential habits of its tools."""
    main: FastMCP[Any] = FastMCP(name="upstream")
    main.add_middleware(seen)
    cache: dict[str, Any] = {}

    def who(client: Any) -> str:
        return str(client.get_caller_identity()["Arn"])

    def fresh() -> Any:
        client = boto3.Session(region_name="us-east-1").client("sts")
        echo_signer(client)
        return client

    cost_explorer: FastMCP[Any] = FastMCP(name="cost-explorer-tools")

    @cost_explorer.tool(name="cost-explorer")
    async def cost_explorer_tool(ctx: Context, operation: str = "") -> dict[str, Any]:
        """Async tool that calls boto3 in the event loop, a new session per call (Billing)."""
        await ctx.info(f"called with {operation}")
        await ctx.error(f"AWS said no to {operation}")
        await asyncio.sleep(0.01)
        return {"status": "success", "arn": who(fresh())}

    anomaly: FastMCP[Any] = FastMCP(name="cost-anomaly-tools")

    @anomaly.tool(name="cost-anomaly")
    def cost_anomaly_tool() -> dict[str, Any]:
        """Sync tool (run in a worker thread) with a client kept across calls."""
        if "client" not in cache:
            cache["client"] = fresh()
        return {"status": "success", "arn": who(cache["client"])}

    sp: FastMCP[Any] = FastMCP(name="sp-performance-tools")

    @sp.tool(name="sp-performance")
    async def sp_performance_tool() -> dict[str, Any]:
        """Async tool that pushes boto3 to a thread and fans out to tasks."""
        results = await asyncio.gather(*(asyncio.to_thread(lambda: who(fresh())) for _ in range(3)))
        assert len(set(results)) == 1
        return {"status": "success", "arn": results[0]}

    sql: FastMCP[Any] = FastMCP(name="unified-sql-tools")

    @sql.tool(name="session-sql")
    def session_sql_tool(query: str) -> str:
        """A tool Mango leaves out of the manifest: a database shared by every caller."""
        return "never served"

    @main.prompt(name="savings_plans")
    def savings_plans_prompt() -> str:
        return "never served"

    @main.resource("data://sessions")
    def sessions_resource() -> str:
        return "never served"

    for server in (cost_explorer, anomaly, sp, sql):
        main.mount(server)
    return main


def _config(identity_key: IdentityKey) -> Any:
    config = central_config(identity_key)
    return type(config)(**{**config.__dict__, "tools": TOOLS})


@pytest.fixture
def seen() -> _Seen:
    return _Seen()


@pytest.fixture
def pack_logging() -> Iterator[logging.Logger]:
    """``log_calls`` changes process-wide loggers: put them back for the other tests."""
    pack_log, client_log = logging.getLogger("mango.pack"), logging.getLogger(CLIENT_LOG)
    before = (list(pack_log.handlers), pack_log.level, pack_log.propagate, list(client_log.filters))
    pack_log.handlers.clear()
    try:
        yield pack_log
    finally:
        pack_log.handlers[:] = before[0]
        pack_log.setLevel(before[1])
        pack_log.propagate = before[2]
        client_log.filters[:] = before[3]


@pytest.fixture
def pack_url(
    identity_key: IdentityKey, bound: None, seen: _Seen, pack_logging: logging.Logger
) -> Iterator[str]:
    mcp = _upstream(seen)
    config = _config(identity_key)
    restrict_tools(mcp, config.tools)
    bind(
        mcp,
        CallGuard(config, verifier=IdentityVerifier(identity_key.public_der, PACK), assume=keys_of),
    )
    open_schemas(mcp)
    # As `serve` does, before the HTTP server (and its logging setup) exists.
    log_calls()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    app = mcp.http_app(
        path=MCP_PATH, transport="streamable-http", stateless_http=True, json_response=True
    )
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 30  # generous: CI runners are slow
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.02)
    assert server.started
    try:
        yield f"http://127.0.0.1:{port}{MCP_PATH}"
    finally:
        server.should_exit = True
        thread.join(timeout=10)


async def _rpc(client: httpx.AsyncClient, url: str, method: str, params: dict[str, Any]) -> Any:
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    response = await client.post(url, headers=HEADERS, json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _one(url: str, method: str, params: dict[str, Any]) -> Any:
    async def main() -> Any:
        async with httpx.AsyncClient(timeout=30) as client:
            return await _rpc(client, url, method, params)

    return asyncio.run(main())


def _text(answer: dict[str, Any]) -> tuple[bool, str]:
    result = answer["result"]
    return bool(result.get("isError")), result["content"][0]["text"]


def test_only_manifest_tools_are_listed_without_any_caller(pack_url: str) -> None:
    tools = _one(pack_url, "tools/list", {})["result"]["tools"]
    assert {t["name"] for t in tools} == TOOLS
    # The schema does not learn about `_mango_ctx`...
    assert "_mango_ctx" not in str(tools)
    for tool in tools:
        # ...but it must not forbid it either: the Gateway validates the arguments against
        # this schema after its interceptor added the caller.
        assert "additionalProperties" not in tool["inputSchema"]
        assert tool["inputSchema"]["type"] == "object"
    explorer = next(tool for tool in tools if tool["name"] == "cost-explorer")
    assert set(explorer["inputSchema"]["properties"]) == {"operation"}


def test_fastmcp_lists_closed_schemas_unless_opened(seen: _Seen) -> None:
    """Why `open_schemas` exists: this is what the Gateway refused in the lab."""
    mcp = _upstream(seen)
    restrict_tools(mcp, TOOLS)
    assert all(
        tool.parameters["additionalProperties"] is False for tool in asyncio.run(mcp.list_tools())
    )
    open_schemas(mcp)
    assert not any(
        "additionalProperties" in tool.parameters for tool in asyncio.run(mcp.list_tools())
    )


def test_prompts_and_resources_are_not_served(pack_url: str) -> None:
    # They would not go through the call guard.
    assert _one(pack_url, "prompts/list", {})["result"]["prompts"] == []
    assert _one(pack_url, "resources/list", {})["result"]["resources"] == []
    assert "error" in _one(pack_url, "prompts/get", {"name": "savings_plans"})
    assert "error" in _one(pack_url, "resources/read", {"uri": "data://sessions"})


def test_concurrent_callers_over_http_never_cross(
    pack_url: str, identity_key: IdentityKey, seen: _Seen
) -> None:
    tools = sorted(TOOLS)

    async def call(client: httpx.AsyncClient, n: int) -> tuple[str, tuple[bool, str]]:
        subject, tool = f"user-{n % 4}", tools[n % 3]
        arguments = {"_mango_ctx": {"identity": identity_key.assertion(subject, tool)}}
        answer = await _rpc(client, pack_url, "tools/call", {"name": tool, "arguments": arguments})
        return subject, _text(answer)

    async def main() -> list[tuple[str, tuple[bool, str]]]:
        async with httpx.AsyncClient(timeout=30) as client:
            return list(await asyncio.gather(*(call(client, n) for n in range(48))))

    for subject, (is_error, text) in asyncio.run(main()):
        assert is_error is False
        assert json.loads(text) == {"status": "success", "arn": f"AKIA-{subject}"}
    # The guard runs first: no other middleware, and no tool, ever sees the assertion.
    assert len(seen.arguments) == 48
    assert all("_mango_ctx" not in arguments for arguments in seen.arguments)


def test_calls_without_a_valid_caller_get_one_fixed_refusal(
    pack_url: str, identity_key: IdentityKey, seen: _Seen
) -> None:
    tool = "cost-explorer"
    attempts: list[tuple[str, dict[str, Any]]] = [
        (tool, {}),
        (tool, {"_mango_ctx": {"identity": "v1.e30.AAAA"}}),
        (tool, {"_mango_ctx": {"identity": IdentityKey().assertion("alice", tool)}}),
        (tool, {"_mango_ctx": {"identity": identity_key.assertion("alice", "cost-anomaly")}}),
        (tool, {"_mango_ctx": {"identity": identity_key.assertion("alice", tool, central=False)}}),
        # Hidden from the server: a valid caller does not bring it back.
        (
            "session-sql",
            {
                "query": "SELECT 1",
                "_mango_ctx": {"identity": identity_key.assertion("alice", "session-sql")},
            },
        ),
    ]

    async def main() -> list[Any]:
        async with httpx.AsyncClient(timeout=30) as client:
            return [
                await _rpc(client, pack_url, "tools/call", {"name": n, "arguments": a})
                for n, a in attempts
            ]

    for answer in asyncio.run(main()):
        is_error, text = _text(answer)
        assert is_error and REFUSED_MESSAGE in text
        assert "AKIA" not in str(answer)
    # Refused before anything else of the server ran.
    assert seen.arguments == []


def test_the_server_still_refuses_arguments_the_tool_does_not_declare(
    pack_url: str, identity_key: IdentityKey
) -> None:
    """An open schema in the listing does not open the tool: the server validates the call
    itself, and that error is not the identity refusal."""
    arguments = {
        "nope": 1,
        "_mango_ctx": {"identity": identity_key.assertion("alice", "cost-anomaly")},
    }
    answer = _one(pack_url, "tools/call", {"name": "cost-anomaly", "arguments": arguments})
    is_error, text = _text(answer)
    assert is_error and REFUSED_MESSAGE not in text


def test_what_a_tool_tells_the_client_is_not_written_to_the_server_log(
    pack_url: str, identity_key: IdentityKey
) -> None:
    records: list[str] = []

    class Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record.getMessage())

    handler = Collect(level=logging.DEBUG)
    fastmcp_logger = logging.getLogger("fastmcp")
    fastmcp_logger.addHandler(handler)
    try:
        arguments = {
            "operation": "secret-filter",
            "_mango_ctx": {"identity": identity_key.assertion("alice", "cost-explorer")},
        }
        answer = _one(pack_url, "tools/call", {"name": "cost-explorer", "arguments": arguments})
        assert _text(answer)[0] is False
    finally:
        fastmcp_logger.removeHandler(handler)
    assert not [message for message in records if "secret-filter" in message]


def test_a_hidden_tool_cannot_be_called_even_without_the_guard(seen: _Seen) -> None:
    mcp = _upstream(seen)
    restrict_tools(mcp, TOOLS)
    with pytest.raises(Exception, match="Unknown tool"):
        asyncio.run(mcp.call_tool("session-sql", {"query": "SELECT 1"}))


def test_a_missing_manifest_tool_stops_the_start(seen: _Seen) -> None:
    with pytest.raises(SystemExit, match="budgets"):
        restrict_tools(_upstream(seen), TOOLS | {"budgets"})


def test_call_records_reach_stderr_once(
    pack_logging: logging.Logger, capsys: pytest.CaptureFixture[str]
) -> None:
    log_calls()
    log_calls()
    pack_logging.info('{"event": "pack.call"}')
    assert capsys.readouterr().err == '{"event": "pack.call"}\n'
    assert len(logging.getLogger(CLIENT_LOG).filters) == 2  # fastmcp's clamp and the drop
