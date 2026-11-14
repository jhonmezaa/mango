"""Mango entry point of the AWS Application Signals pack for AgentCore Runtime (D51).

The pack reads the member accounts of the organization, so it never acts with its own role:
the common entry point (`mango_pack_runtime`) is loaded before the upstream server is
imported, verifies who is calling on every `tools/call` and signs AWS requests with a session
assumed for that person, through the Read broker, in the member account the call names
(`account_id`, an argument of Mango's that the upstream tool never sees). Only the tools of
the signed manifest are served.

Upstream only speaks stdio; `mango_pack_runtime.server` serves the same server object over
stateless streamable HTTP (0.0.0.0:8000/mcp).

What this file changes of the upstream server:

* no log file and no upstream log records: at import the server opens a loguru file sink in
  the temporary directory, and every audit appends its parameters and the full response to a
  second file named by ``AUDITOR_LOG_PATH`` (D16). That path is ``/dev/null`` here, and every
  loguru sink is removed once the server is imported;
* only the account of the call is read (R6). Through a monitoring account Application
  Signals answers for its linked accounts too, which may not be accounts Mango reads:
  ``include_linked_accounts`` is hidden from the model, every request the server sends goes
  with ``IncludeLinkedAccounts`` false, and a request that names another account
  (``AwsAccountId`` and the like, which the audits and ``list_change_events`` take inside
  their JSON arguments) is refused before it is signed;
* no audit reads logs: ``ListAuditFindings`` always names its auditors, never ``log``
  (no log content, D55 (3));
* every client of the server is built for the installation's Region, the only one the pack
  network reaches, and the ``region`` arguments do not list the Region of the build as their
  default (``tools/list`` must be the same in every installation).
"""

import os

# Read by the server (`AWS_PROFILE`: other credentials; `MCP_*_ENDPOINT`: other endpoints;
# `MCP_RUN_FROM`: its user agent) and by the MCP SDK (its settings) at import time. Nothing
# of the runtime's environment configures either.
for _name in list(os.environ):
    if _name.startswith(("FASTMCP_", "MCP_")) or _name in ("AWS_PROFILE", "AUDITOR_LOG_PATH"):
        del os.environ[_name]

# The server builds its clients at import for AWS_REGION. The Runtime has it, but the
# installation's Region is what the provisioner names: the pack network has no other.
if _region := os.environ.get("MANGO_PACK_REGION"):
    os.environ["AWS_REGION"] = _region
# Where the server's log sink and the audit payloads go: nowhere. Read at import (the sink)
# and on every audit call (the payload file), so it stays set for the life of the process.
os.environ["AUDITOR_LOG_PATH"] = os.devnull
os.environ["MCP_CLOUDWATCH_APPLICATION_SIGNALS_LOG_LEVEL"] = "CRITICAL"

import threading  # noqa: E402
from collections.abc import Iterator, Mapping  # noqa: E402
from typing import Any  # noqa: E402

import boto3  # noqa: E402
from botocore.client import BaseClient  # noqa: E402
from loguru import logger as upstream_logger  # noqa: E402

# Loguru's default sink logs at DEBUG while the server's modules are imported, before the
# server configures its own.
upstream_logger.remove()

from mango_pack_runtime.server import load  # noqa: E402

# Arguments of upstream tools the model must never set. `account_id` and `region` are handled
# by the common entry point itself (member chain).
HIDDEN_ARGUMENTS = ("include_linked_accounts",)

pack = load(hidden_arguments=HIDDEN_ARGUMENTS)  # before importing the server

from awslabs.cloudwatch_applicationsignals_mcp_server import aws_clients  # noqa: E402
from awslabs.cloudwatch_applicationsignals_mcp_server.server import mcp  # noqa: E402

# The server configured its own sinks while it was imported (stderr and the file above).
# Who called what is logged by the common entry point, without arguments or results.
upstream_logger.remove()

# Parameter names that point a request at an account (Application Signals `KeyAttributes`,
# `Entity`, audit targets, `ListServices`; CloudWatch metric queries; SLO owner).
ACCOUNT_KEYS = frozenset({"AwsAccountId", "SloOwnerAwsAccountId", "AccountId"})
LINKED_ACCOUNTS = "IncludeLinkedAccounts"
OTHER_ACCOUNT_MESSAGE = (
    "this pack only reads the account named by account_id: leave out AwsAccountId (or set "
    "it to that account) and call the tool again with account_id set to the other account"
)
_MAX_CACHED_ACCOUNTS = 256

# Audits: the `log` auditor of ListAuditFindings reads the service's logs.
LIST_AUDIT_FINDINGS = "ListAuditFindings"
AUDITORS = "Auditors"
LOG_AUDITOR = "log"
AUDITORS_WITHOUT_LOG = frozenset(
    {"slo", "operation_metric", "trace", "dependency_metric", "top_contributor", "service_quota"}
)
LOG_AUDITOR_MESSAGE = (
    "this pack does not run the 'log' auditor (it reads log content): choose other auditors"
)


class OutOfScopeError(Exception):
    """A request of the server is outside what the pack reads: another account, or logs."""


class _CallAccounts:
    """Account of the session each call signs with, asked to STS only when a request names
    an account. Keyed by the session's access key: every call assumes its own session."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._accounts: dict[str, str] = {}

    def current(self) -> str:
        session = boto3.Session(region_name=os.environ.get("AWS_REGION"))
        credentials = session.get_credentials()
        if credentials is None:
            raise OutOfScopeError(OTHER_ACCOUNT_MESSAGE)
        access_key = str(credentials.get_frozen_credentials().access_key)
        with self._lock:
            cached = self._accounts.get(access_key)
        if cached is not None:
            return cached
        # GetCallerIdentity needs no permission and no session policy can deny it.
        account = str(session.client("sts").get_caller_identity()["Account"])
        with self._lock:
            if len(self._accounts) >= _MAX_CACHED_ACCOUNTS:
                self._accounts.clear()
            self._accounts[access_key] = account
        return account


_call_accounts = _CallAccounts()


def named_accounts(value: object) -> Iterator[object]:
    """Every value of an account key anywhere in request parameters (maps, lists, nesting)."""
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key in ACCOUNT_KEYS:
                yield item
            yield from named_accounts(item)
    elif isinstance(value, list | tuple):
        for item in value:
            yield from named_accounts(item)


def without_log_auditor(params: dict[str, Any]) -> None:
    """``ListAuditFindings`` never runs the ``log`` auditor (no log content, D55 (3)).

    Upstream leaves ``Auditors`` out to mean all of them; here they are always named."""
    requested = params.get(AUDITORS) or sorted(AUDITORS_WITHOUT_LOG | {LOG_AUDITOR})
    kept = [auditor for auditor in requested if auditor != LOG_AUDITOR]
    if not kept:
        raise OutOfScopeError(LOG_AUDITOR_MESSAGE)
    params[AUDITORS] = kept


def only_the_call_account(params: dict[str, Any], model: Any, **_: Any) -> None:
    """``before-parameter-build`` handler: the request reads the call's account and no other,
    and no audit reads logs."""
    input_shape = getattr(model, "input_shape", None)
    if input_shape is not None and LINKED_ACCOUNTS in input_shape.members:
        params[LINKED_ACCOUNTS] = False
    if getattr(model, "name", None) == LIST_AUDIT_FINDINGS:
        without_log_auditor(params)
    named = set(named_accounts(params))
    if named and named != {_call_accounts.current()}:
        raise OutOfScopeError(OTHER_ACCOUNT_MESSAGE)


def hold_to_the_call_account() -> None:
    """Put ``only_the_call_account`` in front of every request of every client of the server,
    and of any client it creates later from the default session."""
    clients = [value for value in vars(aws_clients).values() if isinstance(value, BaseClient)]
    if not clients:
        raise SystemExit("upstream no longer builds its AWS clients in aws_clients")
    for client in clients:
        client.meta.events.register("before-parameter-build", only_the_call_account)
    boto3.setup_default_session(region_name=os.environ.get("AWS_REGION"))
    boto3.DEFAULT_SESSION.events.register("before-parameter-build", only_the_call_account)  # type: ignore[union-attr]


hold_to_the_call_account()

# Arguments whose listed default would be the Region of the process that lists them.
REGION_ARG = "region"


def unlisted_region_default(mcp_server: Any) -> None:
    """``tools/list`` without the default of ``region``: the tool still falls back to the
    installation's Region, but what the Gateway and the model read (and ``tools_hash``) does
    not depend on where the pack runs."""
    original = mcp_server.list_tools

    async def list_tools() -> list[Any]:
        listed = []
        for tool in await original():
            schema = tool.input_schema
            region = (schema.get("properties") or {}).get(REGION_ARG)
            if isinstance(region, dict) and "default" in region:
                properties = {**schema["properties"]}
                properties[REGION_ARG] = {k: v for k, v in region.items() if k != "default"}
                schema = {**schema, "properties": properties}
                listed.append(tool.model_copy(update={"input_schema": schema}))
            else:
                listed.append(tool)
        return listed

    mcp_server.list_tools = list_tools


unlisted_region_default(mcp)


def main() -> None:
    pack.serve(mcp)


if __name__ == "__main__":
    main()
