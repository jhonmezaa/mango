"""The entry point against the real MCP SDK the awslabs servers are built on (S-M1, S-M3):
tools outside the manifest are gone, and concurrent ``tools/call`` requests over streamable
HTTP run each tool, in its worker thread, with the credentials of its own caller."""

from __future__ import annotations

import asyncio
import socket
import threading
import time
from collections.abc import Iterator
from typing import Any

import boto3
import httpx
import pytest
import uvicorn
from mcp.server.mcpserver import MCPServer

from mango_pack_runtime.guard import CallGuard
from mango_pack_runtime.identity import IdentityVerifier
from mango_pack_runtime.server import REFUSED_MESSAGE, bind, restrict_tools

from .conftest import PACK, IdentityKey, central_config, echo_signer, keys_of

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
}


def _upstream() -> MCPServer:
    """An upstream server with the credential habits of the awslabs ones."""
    mcp = MCPServer("upstream")
    cache: dict[str, Any] = {}

    def who(client: Any) -> str:
        return str(client.get_caller_identity()["Arn"])

    def fresh() -> Any:
        client = boto3.Session(region_name="us-east-1").client("sts")
        echo_signer(client)
        return client

    @mcp.tool()
    def cost_explorer(service: str = "") -> str:
        """Sync tool, a new session per call (Pricing, CloudWatch)."""
        time.sleep(0.01)
        return who(fresh())

    @mcp.tool()
    def budgets() -> str:
        """Sync tool with a client kept across calls."""
        if "client" not in cache:
            cache["client"] = fresh()
        return who(cache["client"])

    @mcp.tool()
    async def anomalies() -> str:
        """Async tool that pushes boto3 to a thread."""
        await asyncio.sleep(0.01)
        return await asyncio.to_thread(lambda: who(fresh()))

    @mcp.tool()
    def read_local_file(path: str) -> str:
        """A tool Mango leaves out of the manifest (R6)."""
        return "never served"

    return mcp


@pytest.fixture
def pack_url(identity_key: IdentityKey, bound: None) -> Iterator[str]:
    mcp = _upstream()
    config = central_config(identity_key)
    config = type(config)(
        **{**config.__dict__, "tools": frozenset({"cost_explorer", "budgets", "anomalies"})}
    )
    restrict_tools(mcp, config.tools)
    bind(
        mcp,
        CallGuard(config, verifier=IdentityVerifier(identity_key.public_der, PACK), assume=keys_of),
    )
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    app = mcp.streamable_http_app(stateless_http=True, json_response=True)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 30  # generous: CI runners are slow
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.02)
    assert server.started
    try:
        yield f"http://127.0.0.1:{port}/mcp"
    finally:
        server.should_exit = True
        thread.join(timeout=10)


async def _rpc(client: httpx.AsyncClient, url: str, method: str, params: dict[str, Any]) -> Any:
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    response = await client.post(url, headers=HEADERS, json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _text(answer: dict[str, Any]) -> tuple[bool, str]:
    result = answer["result"]
    return bool(result.get("isError")), result["content"][0]["text"]


def test_only_manifest_tools_are_listed_without_any_caller(pack_url: str) -> None:
    async def main() -> Any:
        async with httpx.AsyncClient(timeout=30) as client:
            return await _rpc(client, pack_url, "tools/list", {})

    tools = asyncio.run(main())["result"]["tools"]
    assert sorted(t["name"] for t in tools) == ["anomalies", "budgets", "cost_explorer"]
    # The upstream schema is served untouched: it does not learn about `_mango_ctx`.
    assert "_mango_ctx" not in str(tools)


def test_concurrent_callers_over_http_never_cross(pack_url: str, identity_key: IdentityKey) -> None:
    tools = ["cost_explorer", "budgets", "anomalies"]

    async def call(client: httpx.AsyncClient, n: int) -> tuple[str, tuple[bool, str]]:
        subject, tool = f"user-{n % 4}", tools[n % 3]
        arguments = {"_mango_ctx": {"identity": identity_key.assertion(subject, tool)}}
        answer = await _rpc(client, pack_url, "tools/call", {"name": tool, "arguments": arguments})
        return subject, _text(answer)

    async def main() -> list[tuple[str, tuple[bool, str]]]:
        async with httpx.AsyncClient(timeout=30) as client:
            return list(await asyncio.gather(*(call(client, n) for n in range(48))))

    for subject, (is_error, text) in asyncio.run(main()):
        assert (is_error, text) == (False, f"AKIA-{subject}")


def test_calls_without_a_valid_caller_get_one_fixed_refusal(
    pack_url: str, identity_key: IdentityKey
) -> None:
    attempts: list[tuple[str, dict[str, Any]]] = [
        ("cost_explorer", {}),
        ("cost_explorer", {"_mango_ctx": {"identity": "v1.e30.AAAA"}}),
        ("cost_explorer", {"_mango_ctx": {"identity": IdentityKey().assertion("alice")}}),
        ("cost_explorer", {"_mango_ctx": {"identity": identity_key.assertion("alice", "budgets")}}),
        (
            "cost_explorer",
            {"_mango_ctx": {"identity": identity_key.assertion("alice", central=False)}},
        ),
        # Removed from the server: a valid caller does not bring it back.
        (
            "read_local_file",
            {"path": "/etc/passwd", "_mango_ctx": {"identity": identity_key.assertion("alice")}},
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


def test_load_binds_the_process_before_the_upstream_server_is_imported(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch, identity_key: IdentityKey
) -> None:
    import base64  # noqa: PLC0415
    import json  # noqa: PLC0415

    from mango_pack_runtime import credentials  # noqa: PLC0415
    from mango_pack_runtime.credentials import NoCallerError  # noqa: PLC0415
    from mango_pack_runtime.server import load  # noqa: PLC0415

    (tmp_path / "pack.json").write_text(
        json.dumps(
            {
                "id": PACK,
                "version": "1.0.0-1",
                "tools": ["cost_explorer"],
                "identity_mode": "central_only",
                "iam": [{"actions": ["ce:GetCostAndUsage"], "resources": ["*"]}],
            }
        )
    )
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIA-PACK-ROLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "s")
    # No AWS_DEFAULT_REGION: the first hop uses the region the provisioner gave the pack.
    monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
    monkeypatch.delenv("AWS_REGION", raising=False)
    monkeypatch.setenv("MANGO_PACK_REGION", "us-east-1")
    monkeypatch.setenv(
        "MANGO_PACK_BROKER_ROLE_ARN", "arn:aws:iam::111122223333:role/Mango-test-BillingBroker"
    )
    monkeypatch.setenv(
        "MANGO_PACK_TARGET_ROLE_ARN", "arn:aws:iam::999988887777:role/Mango-test-BillingReader"
    )
    monkeypatch.setenv(
        "MANGO_PACK_IDENTITY_PUBLIC_KEY", base64.b64encode(identity_key.public_der).decode()
    )
    try:
        pack = load(tmp_path)
        assert pack.config.can_verify
        # What an upstream module does at import time: it gets no usable credentials.
        client = boto3.client("sts", region_name="us-east-1")
        echo_signer(client)
        with pytest.raises(NoCallerError):
            client.get_caller_identity()
    finally:
        credentials.uninstall()
