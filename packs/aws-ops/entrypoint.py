"""Mango entry point of the AWS Operations pack for AgentCore Runtime (D51).

The server is Mango's own code (``aws_ops``, in the signed zip). The common entry point
(``mango_pack_runtime``) is loaded before it is imported: it verifies who is calling on every
``tools/call``, adds Mango's ``account_id``, fills ``region`` with the installation's and signs
AWS requests with a session assumed for that person, through the Read broker, in the member
account the call names. Only the tools of the signed manifest are served.
"""

import os

# Read by the MCP SDK (its settings) and by botocore (other credentials or endpoints) at import
# time. Nothing of the runtime's environment configures either.
for _name in list(os.environ):
    if _name.startswith(("FASTMCP_", "MCP_", "AWS_ENDPOINT_URL")) or _name == "AWS_PROFILE":
        del os.environ[_name]

from mango_pack_runtime.server import load  # noqa: E402

pack = load()  # before importing the server: nothing it creates sees the pack role

from aws_ops.server import mcp  # noqa: E402


def main() -> None:
    pack.serve(mcp)


if __name__ == "__main__":
    main()
