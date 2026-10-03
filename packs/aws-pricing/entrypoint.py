"""Mango entry point of the AWS Pricing pack for AgentCore Runtime (D19, S-M3).

Upstream only speaks stdio. This file serves the same server object over stateless
streamable HTTP, which is the Runtime contract for MCP (0.0.0.0:8000/mcp), and keeps only
the tools the signed manifest allows: anything else upstream registers is removed before
the server starts, and a missing allowed tool stops the start.
"""

import asyncio
import json
import os
from pathlib import Path

# The server reads these at import time. A profile or a custom endpoint would send the
# role's signed requests somewhere else, so neither is ever taken from the environment.
for _name in ("AWS_PROFILE", "PRICING_ENDPOINT"):
    os.environ.pop(_name, None)

from awslabs.aws_pricing_mcp_server.server import mcp  # noqa: E402


def allowed_tools() -> frozenset[str]:
    pack = json.loads((Path(__file__).parent / "pack.json").read_text())
    return frozenset(pack["tools"])


def main() -> None:
    allowed = allowed_tools()
    registered = {tool.name for tool in asyncio.run(mcp.list_tools())}
    missing = allowed - registered
    if missing:
        raise SystemExit(f"upstream no longer provides: {sorted(missing)}")
    for name in registered - allowed:
        mcp.remove_tool(name)
    mcp.run(
        transport="streamable-http",
        host=os.environ.get("MANGO_PACK_HOST", "0.0.0.0"),  # noqa: S104 - Runtime contract
        port=int(os.environ.get("MANGO_PACK_PORT", "8000")),
        stateless_http=True,
        json_response=True,
    )


if __name__ == "__main__":
    main()
