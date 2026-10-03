"""Mango entry point of the AWS Billing and Cost Management pack for AgentCore Runtime (D37).

The pack reads account data, so it never acts with its own role: the common entry point
(`mango_pack_runtime`) is loaded before the upstream server is imported, verifies who is
calling on every `tools/call` and signs AWS requests with a session assumed for that person
through the Billing broker. Only the tools of the signed manifest are served.

Upstream is built on `fastmcp` and only speaks stdio; `mango_pack_runtime.fastmcp_server`
serves the same server object over stateless streamable HTTP (0.0.0.0:8000/mcp).

What this file changes of the upstream server, all of it before or right after its import:

* no log file and no upstream log records: the server writes a log file next to its code and
  logs arguments and AWS errors, with the values of local variables in tracebacks (D16);
* no session database: responses over 25 KB would be stored in a SQLite file shared by every
  caller of the process, to be read back with the `session-sql` tool, which is not served.
"""

import os
import sys

# Read by the server and by `fastmcp` at import time. A profile would sign with other
# credentials; the rest would change logging, transport or the session database.
for _name in list(os.environ):
    if (
        _name.startswith(("FASTMCP_", "MCP_", "BCM_MCP_", "STORAGE_LENS_"))
        or _name == "AWS_PROFILE"
    ):
        del os.environ[_name]
# Without this the import creates a `logs` directory inside the package (read-only in the
# build's container). The sink it opens here is removed below.
os.environ["FASTMCP_LOG_FILE"] = os.devnull
# No response is larger than this: nothing is ever moved to the session database.
os.environ["MCP_SQL_THRESHOLD"] = str(sys.maxsize)

from mango_pack_runtime.server import load  # noqa: E402

pack = load()  # before importing the server: nothing it creates will see the pack role

from awslabs.billing_cost_management_mcp_server.server import mcp, setup  # noqa: E402
from awslabs.billing_cost_management_mcp_server.utilities import sql_utils  # noqa: E402
from loguru import logger as upstream_logger  # noqa: E402

from mango_pack_runtime.fastmcp_server import serve  # noqa: E402


def main() -> None:
    # Who called what is logged by the common entry point, without arguments or results.
    upstream_logger.remove()
    if sql_utils.should_convert_to_sql(sys.maxsize):
        raise SystemExit("upstream no longer honours MCP_SQL_THRESHOLD")
    setup()  # mounts every tool server; `serve` leaves only the tools of the manifest
    serve(pack, mcp)


if __name__ == "__main__":
    main()
