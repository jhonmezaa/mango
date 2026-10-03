"""How an agent's tools are named inside its AgentCore harness (D13, D33).

Every tool is reached through the Mango Gateway, registered in the harness as one MCP server.
The Gateway exposes a tool as ``<target>___<tool>``; the harness allow-list addresses it as
``@<server>/<target>___<tool>``. The provisioner stores these names in the harness and
mango-api sends the same ones on each invocation, so both sides must build them here.
"""

from __future__ import annotations

GATEWAY_MCP_SERVER = "mango"
"""Name of the Gateway MCP server in a harness (``remote_mcp`` tool)."""
_TARGET_SEPARATOR = "___"


def gateway_tool_name(target: str, tool: str) -> str:
    """Name of a tool as the Gateway exposes it."""
    return f"{target}{_TARGET_SEPARATOR}{tool}"


def allowed_tool(target: str, tool: str) -> str:
    """``allowedTools`` entry for exactly one Gateway tool (no globs)."""
    return f"@{GATEWAY_MCP_SERVER}/{gateway_tool_name(target, tool)}"
