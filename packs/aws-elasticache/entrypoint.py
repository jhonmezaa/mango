"""Mango entry point of the AWS ElastiCache pack for AgentCore Runtime (D51).

The pack reads the member accounts of the organization, so it never acts with its own role:
the common entry point (`mango_pack_runtime`) is loaded before the upstream server is
imported, verifies who is calling on every `tools/call` and signs AWS requests with a session
assumed for that person, through the Read broker, in the member account the call names
(`account_id`, an argument of Mango's that the upstream tool never sees). Only the tools of
the signed manifest are served.

Upstream only speaks stdio; `mango_pack_runtime.server` serves the same server object over
stateless streamable HTTP (0.0.0.0:8000/mcp).

What this file changes of the upstream server:

* its client factory: upstream builds every client from
  `boto3.Session(profile_name=os.environ.get('AWS_PROFILE', 'default'))`, and naming a
  profile, even `default`, fails with `ProfileNotFound` where there is no AWS config file (the
  Runtime has none). Clients are built here without a profile, in the installation's Region
  (the only one the pack network reaches), ignoring endpoint URLs from the environment, and
  only for ElastiCache, the one service the tools served call;
* its read-only switch is on, a second barrier behind the manifest's list of tools (upstream
  marks `test-migration`, a write in IAM, as safe in that mode: the list is what counts);
* no upstream log records (D16).
"""

import os

# Read by the server (credentials profile, retries and timeouts of each client) and by the
# MCP SDK (its settings) at import time. Nothing of the runtime's environment configures
# either. `AWS_ENDPOINT_URL*` would send a client elsewhere.
_UPSTREAM_PREFIXES = (
    "FASTMCP_",
    "MCP_",
    "AWS_ENDPOINT_URL",
    "ELASTICACHE_",
    "EC2_",
    "CLOUDWATCH_",
    "FIREHOSE_",
    "COST_EXPLORER_",
)
for _name in list(os.environ):
    if _name.startswith(_UPSTREAM_PREFIXES) or _name in {"AWS_PROFILE", "AWS_DEFAULT_PROFILE"}:
        del os.environ[_name]

from typing import Any  # noqa: E402

from loguru import logger as upstream_logger  # noqa: E402

# Who called what is logged by the common entry point, without arguments or results.
upstream_logger.remove()

from mango_pack_runtime.server import load  # noqa: E402

# No tool served takes credentials, an account, a Region or an endpoint. `account_id` is
# handled by the common entry point itself (member chain).
pack = load()  # before importing the server

import boto3  # noqa: E402
from awslabs.elasticache_mcp_server import __version__ as upstream_version  # noqa: E402
from awslabs.elasticache_mcp_server.common.connection import BaseConnectionManager  # noqa: E402
from awslabs.elasticache_mcp_server.common.server import mcp  # noqa: E402
from awslabs.elasticache_mcp_server.context import Context  # noqa: E402

# Registers the tools (side effect of importing). Only the packages of the tools served: the
# rest are removed anyway by `pack.serve`.
from awslabs.elasticache_mcp_server.tools import cc, misc, rg, serverless  # noqa: E402, F401
from botocore.config import Config  # noqa: E402

SERVICES = frozenset({"elasticache"})
"""The services the tools served call: the pack's `egress` besides STS."""

CLIENT_CONFIG = Config(
    retries={"max_attempts": 3, "mode": "standard"},
    connect_timeout=5,
    read_timeout=10,
    ignore_configured_endpoint_urls=True,
    user_agent_extra=f"md/awslabs#mcp#elasticache-mcp-server#{upstream_version}",
)
"""Upstream's defaults, fixed: its environment variables are removed above."""


def get_connection(cls: type[BaseConnectionManager]) -> Any:
    """Client of ``cls``'s service, without a profile, in the installation's Region.

    Cached per class like upstream's: it signs with the credentials of the call in progress
    (``mango_pack_runtime`` resolves every session's credentials to the caller's).
    """
    if cls._client is None:
        if cls._service_name not in SERVICES:
            raise RuntimeError("this pack does not call that service")
        region = pack.config.region
        if not region:
            # The build's snapshot runs without the provisioner's settings; no call is served.
            raise RuntimeError("the pack has no Region: it serves no call")
        session = boto3.Session(region_name=region)
        cls._client = session.client(cls._service_name, config=CLIENT_CONFIG)
    return cls._client


BaseConnectionManager.get_connection = classmethod(get_connection)  # type: ignore[method-assign,assignment]
Context.initialize(readonly=True)


def main() -> None:
    pack.serve(mcp)


if __name__ == "__main__":
    main()
