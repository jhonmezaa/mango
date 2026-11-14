"""Mango entry point of the AWS RDS pack for AgentCore Runtime (D51, own-code pack).

The server is Mango's own code (``aws_rds``), built on the official MCP SDK. The common entry
point (``mango_pack_runtime``) is loaded before it is imported: it verifies who is calling on
every ``tools/call``, assumes a session for that person in the member account the call names
(``account_id``, an argument of Mango's the tools never see), fills in the installation's
Region and serves only the tools of the signed manifest over stateless streamable HTTP
(0.0.0.0:8000/mcp).
"""

import os

# Read by the MCP SDK (its settings) at import time. Nothing of the runtime's environment
# configures it, nor picks a credentials profile.
for _name in list(os.environ):
    if _name.startswith(("FASTMCP_", "MCP_")) or _name in ("AWS_PROFILE", "AWS_DEFAULT_PROFILE"):
        del os.environ[_name]

from mango_pack_runtime.server import load  # noqa: E402

pack = load()  # before the server is imported: nothing it creates sees the pack role

from aws_rds.server import mcp  # noqa: E402

pack.serve(mcp)
