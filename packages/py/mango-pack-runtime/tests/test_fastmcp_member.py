"""The member chain (D51) on a ``fastmcp`` server, like the awslabs Network server (SRE P1).

What ``mango_pack_runtime.server`` does for the official SDK, here over real stateless
streamable HTTP: ``account_id`` is Mango's, listed as required and never seen by the tool;
``region`` is bounded, defaults to the installation's and loses a literal default; hidden
arguments are neither listed nor passed on; each call runs with the session assumed for its
own caller in its own account."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from typing import Annotated, Any

import boto3
import httpx
import pytest
from botocore.credentials import ReadOnlyCredentials
from fastmcp import FastMCP
from pydantic import Field

from mango_pack_runtime.fastmcp_server import bind, list_schemas, region_tools, restrict_tools
from mango_pack_runtime.guard import ACCOUNT_PATTERN, REGION_PATTERN, CallGuard
from mango_pack_runtime.identity import Caller, IdentityVerifier
from mango_pack_runtime.server import REFUSED_MESSAGE

from .conftest import IdentityKey, echo_signer
from .test_fastmcp_server import _one, _rpc, _text, serve_http
from .test_member import MEMBER, ROLE, member_config

PACK = "aws-network"
TOOLS = frozenset({"find_ip_address", "get_vpc_network_details"})
HIDDEN = ("profile_name", "all_regions")
OTHER_MEMBER = "999988887777"


def _assume(caller: Caller, account: str) -> ReadOnlyCredentials:
    return ReadOnlyCredentials(f"AKIA-{caller.subject}-{account}", "secret", "token")


def _upstream() -> FastMCP[Any]:
    """Tools shaped like the awslabs Network server's (fastmcp 0.0.17)."""
    mcp: FastMCP[Any] = FastMCP(name="upstream")

    def who() -> str:
        client = boto3.Session(region_name="us-east-1").client("sts")
        echo_signer(client)
        return str(client.get_caller_identity()["Arn"])

    @mcp.tool(name="find_ip_address")
    async def find_ip_address(
        ip_address: str,
        region: str | None = None,
        all_regions: bool = False,
        profile_name: str | None = None,
    ) -> dict[str, Any]:
        """Find an IP address."""
        await asyncio.sleep(0.01)
        return {
            "arn": who(),
            "region": region,
            "all_regions": all_regions,
            "profile": profile_name,
        }

    @mcp.tool(name="get_vpc_network_details")
    def get_vpc_network_details(
        vpc_id: str,
        region: Annotated[
            str, Field(description="AWS region. Defaults to us-east-1. Lowercase.")
        ] = "us-east-1",
    ) -> dict[str, Any]:
        """Sync tool with a literal Region default (run in a worker thread)."""
        return {"arn": who(), "region": region}

    @mcp.tool(name="get_cloudwan_routes")
    def get_cloudwan_routes() -> str:
        """Left out of the manifest."""
        return "never served"

    return mcp


def _config(key: IdentityKey) -> Any:
    config = member_config(key)
    return type(config)(**{**config.__dict__, "pack_id": PACK, "tools": TOOLS})


@pytest.fixture
def member_url(identity_key: IdentityKey, bound: None) -> Iterator[str]:
    """What ``serve`` does for a pack of the member chain, before the transport."""
    mcp = _upstream()
    config = _config(identity_key)
    guard = CallGuard(
        config,
        verifier=IdentityVerifier(identity_key.public_der, PACK),
        member_assume=_assume,
        hidden_arguments=HIDDEN,
    )
    restrict_tools(mcp, config.tools)
    guard.default_region_for(region_tools(mcp))
    bind(mcp, guard)
    list_schemas(mcp, config, HIDDEN)
    with serve_http(mcp) as url:
        yield url


def _ctx(key: IdentityKey, subject: str, tool: str) -> dict[str, Any]:
    return {"_mango_ctx": {"identity": key.assertion(subject, tool, pack=PACK)}}


def test_listed_schemas_ask_for_the_account_bound_the_region_and_hide_the_rest(
    member_url: str,
) -> None:
    tools = {t["name"]: t for t in _one(member_url, "tools/list", {})["result"]["tools"]}
    assert set(tools) == TOOLS
    for tool in tools.values():
        schema = tool["inputSchema"]
        assert schema["properties"]["account_id"]["pattern"] == ACCOUNT_PATTERN
        assert schema["required"][0] == "account_id"
        assert not set(HIDDEN) & set(schema["properties"])
        assert "additionalProperties" not in schema
        assert "_mango_ctx" not in json.dumps(schema)
    ip_region = tools["find_ip_address"]["inputSchema"]["properties"]["region"]
    assert {"type": "string", "pattern": REGION_PATTERN} in ip_region["anyOf"]
    vpc_region = tools["get_vpc_network_details"]["inputSchema"]["properties"]["region"]
    assert vpc_region["pattern"] == REGION_PATTERN
    assert "default" not in vpc_region
    assert "us-east-1" not in vpc_region["description"]


def test_concurrent_callers_read_their_own_account_without_mangos_arguments(
    member_url: str, identity_key: IdentityKey
) -> None:
    async def call(client: httpx.AsyncClient, n: int) -> tuple[str, str, dict[str, Any]]:
        subject, account = f"user-{n % 4}", (MEMBER, OTHER_MEMBER)[n % 2]
        tool = sorted(TOOLS)[n % 2]
        arguments = {
            **_ctx(identity_key, subject, tool),
            "account_id": account,
            "ip_address": "10.0.0.1",
            "vpc_id": "vpc-1",
            "profile_name": "admin",
            "all_regions": True,
        }
        if tool == "find_ip_address":
            arguments = {k: v for k, v in arguments.items() if k != "vpc_id"}
        else:
            arguments = {
                k: v
                for k, v in arguments.items()
                if k not in {"ip_address", "profile_name", "all_regions"}
            }
        answer = await _rpc(
            client, member_url, "tools/call", {"name": tool, "arguments": arguments}
        )
        is_error, text = _text(answer)
        assert is_error is False, text
        return subject, account, json.loads(text)

    async def main() -> list[tuple[str, str, dict[str, Any]]]:
        async with httpx.AsyncClient(timeout=30) as client:
            return list(await asyncio.gather(*(call(client, n) for n in range(32))))

    for subject, account, result in asyncio.run(main()):
        assert result["arn"] == f"AKIA-{subject}-{account}"
        # Left out: the installation's Region, also over a literal upstream default.
        assert result["region"] == "us-east-1"
        # Hidden: the tool's own defaults, whatever the model sent.
        assert result.get("profile") is None
        assert result.get("all_regions", False) is False


def test_refusals_are_the_same_and_another_region_is_told(
    member_url: str, identity_key: IdentityKey
) -> None:
    tool = "find_ip_address"
    ctx = _ctx(identity_key, "alice", tool)
    for bad in (
        {"ip_address": "10.0.0.1"},
        {"ip_address": "10.0.0.1", "account_id": "111122223333"},  # the Mango account
        {"ip_address": "10.0.0.1", "account_id": "12"},
        {"ip_address": "10.0.0.1", "account_id": MEMBER, "region": "x.y/z"},
    ):
        is_error, text = _text(
            _one(member_url, "tools/call", {"name": tool, "arguments": {**ctx, **bad}})
        )
        assert is_error and REFUSED_MESSAGE in text
    is_error, text = _text(
        _one(
            member_url,
            "tools/call",
            {
                "name": tool,
                "arguments": {
                    **ctx,
                    "ip_address": "10.0.0.1",
                    "account_id": MEMBER,
                    "region": "eu-west-1",
                },
            },
        )
    )
    assert is_error and "only reads the Region us-east-1" in text


def test_an_upstream_tool_with_its_own_account_id_stops_the_start(
    identity_key: IdentityKey,
) -> None:
    mcp: FastMCP[Any] = FastMCP(name="upstream")

    @mcp.tool(name="find_ip_address")
    def find_ip_address(account_id: str) -> str:
        """Clashes with Mango's argument."""
        return account_id

    with pytest.raises(SystemExit, match="account_id"):
        list_schemas(mcp, _config(identity_key), HIDDEN)


def test_the_role_is_always_mangos(identity_key: IdentityKey) -> None:
    assert _config(identity_key).target_role_name == ROLE
