"""Serve an upstream server built with the ``fastmcp`` library (``FastMCP``) as a Mango pack.

The counterpart of ``mango_pack_runtime.server`` for the awslabs servers that do not use the
official MCP SDK (Billing and Cost Management). The pack's own ``entrypoint.py`` still loads
the pack **before** it imports the upstream server::

    from mango_pack_runtime.server import load

    pack = load()

    from awslabs.some_mcp_server.server import mcp, setup  # noqa: E402

    from mango_pack_runtime.fastmcp_server import serve  # noqa: E402

    setup()
    serve(pack, mcp)

``serve`` leaves only the tools of the signed manifest visible (an allowlist: every other
tool, prompt and resource of the server and of the servers mounted on it is hidden and cannot
be called), puts the call guard in front of every ``tools/call`` and starts stateless
streamable HTTP, the contract of AgentCore Runtime for MCP (``0.0.0.0:8000/mcp``, S-M3).

The Gateway validates the arguments of a ``tools/call`` against the schema the target listed,
**after** its interceptor added the caller assertion in ``_mango_ctx``. ``fastmcp`` lists
closed schemas (``additionalProperties: false``), which made the Gateway refuse every call of
a pack over account data. So such a pack lists its schemas without that keyword
(``open_schemas``): the Gateway lets the reserved argument through, and nothing else changes,
because the server still validates the arguments of the tool itself once the guard has
removed ``_mango_ctx``.

The guard is a ``fastmcp`` middleware, the first of the chain: ``on_call_tool`` awaits the
rest of the chain and the tool inside the guard, in the task of the request, so the caller is
bound in the very task that runs the tool, also for a tool of a mounted server.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from collections.abc import Sequence
from typing import Any

import mcp_types
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.middleware import CallNext, Middleware, MiddlewareContext
from fastmcp.tools import Tool, ToolResult

from mango_pack_runtime.guard import CallGuard, RegionError
from mango_pack_runtime.guard import logger as pack_logger
from mango_pack_runtime.identity import IdentityError
from mango_pack_runtime.server import REFUSED_MESSAGE, REGION_MESSAGE, Pack

MCP_PATH = "/mcp"
CLIENT_LOG = "fastmcp.server.context.to_client"
"""Logger ``fastmcp`` writes the messages for the client to (a tool's ``ctx.info``)."""


class GuardMiddleware(Middleware):
    """The call guard as the outermost step of every ``tools/call``."""

    def __init__(self, guard: CallGuard) -> None:
        self._guard = guard

    async def on_call_tool(
        self,
        context: MiddlewareContext[mcp_types.CallToolRequestParams],
        call_next: CallNext[mcp_types.CallToolRequestParams, ToolResult],
    ) -> ToolResult:
        message = context.message
        try:
            with self._guard.call(message.name, message.arguments) as cleaned:
                # Everything after this point (other middleware, the upstream tool and its
                # schema validation) sees the arguments without `_mango_ctx`.
                return await call_next(
                    context.copy(message=message.model_copy(update={"arguments": cleaned}))
                )
        except RegionError as error:
            raise ToolError(REGION_MESSAGE.format(region=error.allowed)) from None
        except IdentityError:
            # One fixed message: the model learns nothing about which check failed.
            raise ToolError(REFUSED_MESSAGE) from None


class OpenSchemas(Middleware):
    """List every tool with a schema that does not forbid undeclared arguments."""

    async def on_list_tools(
        self,
        context: MiddlewareContext[mcp_types.ListToolsRequest],
        call_next: CallNext[mcp_types.ListToolsRequest, Sequence[Tool]],
    ) -> Sequence[Tool]:
        return [_open(tool) for tool in await call_next(context)]


def _open(tool: Tool) -> Tool:
    if tool.parameters.get("additionalProperties") is not False:
        return tool
    parameters = {k: v for k, v in tool.parameters.items() if k != "additionalProperties"}
    # A copy: the tool the server runs keeps its own schema and validation.
    return tool.model_copy(update={"parameters": parameters})


def open_schemas(mcp: FastMCP[Any]) -> None:
    """Let the Gateway pass ``_mango_ctx`` to the tools of a pack that needs a caller.

    Only what ``tools/list`` answers changes. Arguments the tool does not declare are still
    refused by the server, after the guard removed the reserved one.
    """
    mcp.add_middleware(OpenSchemas())


def _tool_names(mcp: FastMCP[Any]) -> set[str]:
    return {tool.name for tool in asyncio.run(mcp.list_tools(run_middleware=False))}


def restrict_tools(mcp: FastMCP[Any], allowed: frozenset[str]) -> None:
    """Leave only the tools of the manifest; refuse to start if the result is anything else."""
    missing = allowed - _tool_names(mcp)
    if missing:
        raise SystemExit(f"upstream no longer provides: {sorted(missing)}")
    # Allowlist mode: it first hides every component (tools, prompts, resources and
    # templates, mounted servers included) and then shows the tools named here.
    mcp.enable(names=set(allowed), components={"tool"}, only=True)
    if _tool_names(mcp) != allowed:
        raise SystemExit("the server still lists tools outside the manifest")
    prompts = asyncio.run(mcp.list_prompts(run_middleware=False))
    resources = asyncio.run(mcp.list_resources(run_middleware=False))
    templates = asyncio.run(mcp.list_resource_templates(run_middleware=False))
    if prompts or resources or templates:
        # They do not go through the call guard, so a pack serves none of them.
        raise SystemExit("the server still lists prompts or resources")


def bind(mcp: FastMCP[Any], guard: CallGuard) -> None:
    """Put ``guard`` in front of every tool call of ``mcp``, before any other middleware."""
    mcp.middleware.insert(0, GuardMiddleware(guard))


class _Drop(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return False


def log_calls() -> None:
    """What the pack writes to its log: who called what, never arguments or results (D16).

    ``fastmcp`` copies every message a tool sends to the client (``ctx.info``, ``ctx.error``)
    to the server log, whatever the log level, and tools put arguments and AWS errors in
    them: that logger drops every record. And it only configures its own logger, so without
    a handler the guard's ``pack.call`` records would be dropped by the root logger.
    """
    client_log = logging.getLogger(CLIENT_LOG)
    if not any(isinstance(existing, _Drop) for existing in client_log.filters):
        # A filter, not `disabled`: uvicorn's logging setup enables every existing logger.
        client_log.addFilter(_Drop())
    if pack_logger.handlers:
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(message)s"))
    pack_logger.addHandler(handler)
    pack_logger.setLevel(logging.INFO)
    pack_logger.propagate = False


def serve(pack: Pack, mcp: FastMCP[Any]) -> None:
    if pack.config.member_chain or pack.hidden_arguments:
        # Only `mango_pack_runtime.server` lists `account_id` and hides arguments.
        raise SystemExit("the fastmcp adapter does not serve packs of the member chain")
    restrict_tools(mcp, pack.config.tools)
    bind(mcp, pack.guard)
    if pack.config.needs_caller:
        open_schemas(mcp)
    log_calls()
    mcp.run(
        transport="streamable-http",
        host=os.environ.get("MANGO_PACK_HOST", "0.0.0.0"),  # noqa: S104 - Runtime contract
        port=int(os.environ.get("MANGO_PACK_PORT", "8000")),
        path=MCP_PATH,
        stateless_http=True,
        json_response=True,
        # No banner: it checks PyPI for a newer release.
        show_banner=False,
    )
