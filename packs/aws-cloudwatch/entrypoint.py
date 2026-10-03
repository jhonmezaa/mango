"""Mango entry point of the AWS CloudWatch pack for AgentCore Runtime (D51).

The pack reads the member accounts of the organization, so it never acts with its own role:
the common entry point (`mango_pack_runtime`) is loaded before the upstream server is
imported, verifies who is calling on every `tools/call` and signs AWS requests with a session
assumed for that person, through the Read broker, in the member account the call names
(`account_id`, an argument of Mango's that the upstream tool never sees). Only the tools of
the signed manifest are served.

Upstream only speaks stdio; `mango_pack_runtime.server` serves the same server object over
stateless streamable HTTP (0.0.0.0:8000/mcp).

What this file changes of the upstream server:

* no upstream log records: the server logs arguments, alarm names and the full list of log
  groups and saved queries it reads (D16);
* three arguments of its tools are hidden from the model and never reach a tool: the
  credentials profile and the two that would read other accounts through a monitoring
  account.
"""

import os

# Read by the server (`AWS_PROFILE`: other credentials) and by the MCP SDK (its settings) at
# import time. Nothing of the runtime's environment configures either.
for _name in list(os.environ):
    if _name.startswith(("FASTMCP_", "MCP_")) or _name == "AWS_PROFILE":
        del os.environ[_name]

from loguru import logger as upstream_logger  # noqa: E402

# Who called what is logged by the common entry point, without arguments or results.
upstream_logger.remove()

from mango_pack_runtime.server import load  # noqa: E402

# Arguments of upstream tools the model must never set. `account_id` and `region` are handled
# by the common entry point itself (member chain).
HIDDEN_ARGUMENTS = ("profile_name", "account_identifiers", "include_linked_accounts")

pack = load(hidden_arguments=HIDDEN_ARGUMENTS)  # before importing the server

from awslabs.cloudwatch_mcp_server.server import mcp  # noqa: E402


def main() -> None:
    pack.serve(mcp)


if __name__ == "__main__":
    main()
