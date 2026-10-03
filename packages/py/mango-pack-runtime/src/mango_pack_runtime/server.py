"""Serve an upstream server built with the official MCP SDK (``MCPServer``) as a Mango pack.

The pack's own ``entrypoint.py`` loads the pack **before** it imports the upstream server,
so nothing the server creates at import time ever resolves the pack role's credentials::

    from mango_pack_runtime.server import load

    pack = load()

    from awslabs.some_mcp_server.server import mcp  # noqa: E402

    pack.serve(mcp)

``serve`` keeps only the tools of the signed manifest, puts the call guard in front of every
``tools/call`` and starts stateless streamable HTTP, the contract of AgentCore Runtime for
MCP (``0.0.0.0:8000/mcp``, S-M3).

What ``tools/list`` answers is rewritten to match what the guard does with a call
(``list_schemas``): arguments the entry point hides are not listed, a pack over account data
lists open schemas (the Gateway validates after its interceptor added ``_mango_ctx``), and a
pack of the member chain lists Mango's ``account_id`` as a required argument of every tool
and ``region`` with a closed pattern.

The guard wraps ``MCPServer.call_tool``, the public method the ``tools/call`` handler awaits:
the caller is bound in the very task that runs the tool, so it does not depend on how the
transport moves a request between tasks.
"""

from __future__ import annotations

import asyncio
import copy
import importlib
import logging
import os
import sys
from collections.abc import Collection
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from mango_pack_runtime.config import PackConfig
from mango_pack_runtime.guard import (
    ACCOUNT_ARG,
    ACCOUNT_PATTERN,
    REGION_ARG,
    REGION_PATTERN,
    CallGuard,
    RegionError,
    build_guard,
)
from mango_pack_runtime.guard import logger as pack_logger
from mango_pack_runtime.identity import IdentityError

REFUSED_MESSAGE = "this call is not allowed: the caller could not be verified"
REGION_MESSAGE = (
    "this pack only reads the Region {region}: leave 'region' out or set it to {region}"
)
"""A pack runtime only reaches the AWS endpoints of the installation's own Region (R6)."""


def restrict_tools(mcp: Any, allowed: frozenset[str]) -> None:
    """Remove every tool the manifest does not list; refuse to start if one is missing."""
    registered = {tool.name for tool in asyncio.run(mcp.list_tools())}
    missing = allowed - registered
    if missing:
        raise SystemExit(f"upstream no longer provides: {sorted(missing)}")
    for name in registered - allowed:
        mcp.remove_tool(name)


def bind(mcp: Any, guard: CallGuard) -> None:
    """Put ``guard`` in front of every tool call of ``mcp``."""
    original = mcp.call_tool
    tool_error: type[Exception] = importlib.import_module(
        "mcp.server.mcpserver.exceptions"
    ).ToolError

    async def call_tool(name: str, arguments: dict[str, Any], context: Any = None) -> Any:
        try:
            with guard.call(name, arguments) as cleaned:
                return await original(name, cleaned, context)
        except RegionError as error:
            raise tool_error(REGION_MESSAGE.format(region=error.allowed)) from None
        except IdentityError:
            # One fixed message: the model learns nothing about which check failed.
            raise tool_error(REFUSED_MESSAGE) from None

    mcp.call_tool = call_tool


ACCOUNT_SCHEMA = {
    "type": "string",
    "pattern": ACCOUNT_PATTERN,
    "description": (
        "12-digit id of the AWS member account to read. Required: every call reads exactly "
        "one account."
    ),
}


def _bounded_region(schema: Any) -> Any:
    """``schema`` of a ``region`` argument, with every string it accepts held to a Region name."""
    if not isinstance(schema, dict):
        return schema
    if schema.get("type") == "string":
        return {**schema, "pattern": REGION_PATTERN}
    if isinstance(schema.get("anyOf"), list):
        return {**schema, "anyOf": [_bounded_region(option) for option in schema["anyOf"]]}
    return schema


def listed_schema(schema: dict[str, Any], config: PackConfig, hidden: Collection[str]) -> Any:
    """The input schema of one tool as the Gateway and the model see it."""
    listed = copy.deepcopy(schema)
    properties = dict(listed.get("properties") or {})
    for name in hidden:
        properties.pop(name, None)
    required = [name for name in listed.get("required") or [] if name not in hidden]
    if config.needs_caller and listed.get("additionalProperties") is False:
        # Only the listing: the tool still validates its own arguments, without `_mango_ctx`.
        del listed["additionalProperties"]
    if config.member_chain:
        if ACCOUNT_ARG in properties:
            # The guard removes this argument: an upstream tool can never receive its own.
            raise SystemExit(f"an upstream tool already takes {ACCOUNT_ARG!r}")
        properties[ACCOUNT_ARG] = dict(ACCOUNT_SCHEMA)
        required = [ACCOUNT_ARG, *required]
        if REGION_ARG in properties:
            properties[REGION_ARG] = _bounded_region(properties[REGION_ARG])
    listed["properties"] = properties
    if required:
        listed["required"] = required
    else:
        listed.pop("required", None)
    return listed


def list_schemas(mcp: Any, config: PackConfig, hidden: Collection[str] = ()) -> None:
    """Make ``tools/list`` answer the schemas the guard enforces. Calls are not affected: the
    upstream tool keeps its own schema and validates what the guard lets through."""
    original = mcp.list_tools

    async def list_tools() -> list[Any]:
        return [
            tool.model_copy(
                update={"input_schema": listed_schema(tool.input_schema, config, hidden)}
            )
            for tool in await original()
        ]

    asyncio.run(list_tools())  # fail at start, not on the first listing
    mcp.list_tools = list_tools


def log_calls() -> None:
    """Send the guard's ``pack.call`` records (who called what, D16) to stderr, whatever
    logging the upstream server configured."""
    if pack_logger.handlers:
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(message)s"))
    pack_logger.addHandler(handler)
    pack_logger.setLevel(logging.INFO)
    pack_logger.propagate = False


@dataclass(frozen=True)
class Pack:
    config: PackConfig
    guard: CallGuard
    hidden_arguments: frozenset[str] = frozenset()

    def serve(self, mcp: Any) -> None:
        restrict_tools(mcp, self.config.tools)
        bind(mcp, self.guard)
        if self.config.needs_caller or self.hidden_arguments:
            list_schemas(mcp, self.config, self.hidden_arguments)
            log_calls()
        mcp.run(
            transport="streamable-http",
            host=os.environ.get("MANGO_PACK_HOST", "0.0.0.0"),  # noqa: S104 - Runtime contract
            port=int(os.environ.get("MANGO_PACK_PORT", "8000")),
            stateless_http=True,
            json_response=True,
        )


def load(directory: Path | None = None, *, hidden_arguments: Collection[str] = ()) -> Pack:
    """Read ``pack.json`` next to the entry point and, for a pack over account data, make the
    caller's credentials the only ones this process resolves from here on.

    ``hidden_arguments`` are arguments of upstream tools the model must never set (a
    credentials profile, other accounts): they are not listed and never reach the tool.
    """
    config = PackConfig.load(directory or Path(sys.argv[0]).resolve().parent)
    hidden = frozenset(hidden_arguments)
    return Pack(config=config, guard=build_guard(config, hidden), hidden_arguments=hidden)
