"""Uninstall guard: removes what Mango created by API before the stack deletes the rest (D58).

Agents and MCP packs are created at runtime by the provisioners, outside CloudFormation
(D25, D32): their harnesses, runtimes, Gateway targets, Cedar policies and execution roles.
Those roles carry permissions boundaries of the stack, so a stack deletion fails while any of
them exists. This function is a custom resource of the Core stack that everything else is
created before, and therefore deleted after: on ``Delete`` it sweeps those resources, by the
installation's name prefixes only, and waits until they are gone.

It deletes **only while the stack itself is being deleted** (TM-D13): a ``Delete`` event that
comes from replacing the custom resource in an update, or from anyone invoking the function,
finds the stack in another state and changes nothing.

AgentCore deletions are asynchronous and one invocation may not be enough: the function then
invokes itself again with the same event, a bounded number of times, and answers
CloudFormation at the end. Nothing of an agent or a pack is logged: only names and counts.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from mango_provisioner.errors import error_code

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_NS_RE = re.compile(r"^[a-z0-9]{3,8}$")
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
_ARN_RE = re.compile(r"^arn:aws:iam::[0-9]{12}:policy/[A-Za-z0-9+=,.@_-]{1,128}$")
_OPERATION_RE = re.compile(r"^[A-Za-z0-9]{1,64}$")
_GONE = frozenset({"ResourceNotFoundException", "NoSuchEntity", "NoSuchEntityException"})
_BUSY = frozenset({"ConflictException", "DeleteConflict", "DeleteConflictException"})
_DEFAULT_ENDPOINT = "DEFAULT"
_LOG_GROUP_PREFIX = "/aws/bedrock-agentcore/runtimes/"
DELETING_STACK = "DELETE_IN_PROGRESS"
# One invocation polls for this long, then hands over to the next one. Four of them stay
# inside the hour CloudFormation waits for a custom resource.
POLL_SECONDS = 20
INVOCATION_BUDGET_SECONDS = 780
MAX_INVOCATIONS = 4


@dataclass(frozen=True)
class GuardSettings:
    namespace: str
    gateway_id: str
    policy_engine_id: str
    # Gateway targets the stack itself declares (connectors): never touched here.
    connector_targets: frozenset[str]
    # Only roles that carry one of these boundaries were made by a provisioner.
    boundaries: frozenset[str]

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> GuardSettings:
        env = os.environ if env is None else env
        namespace = env["MANGO_NAMESPACE"]
        gateway_id = env["GATEWAY_ID"]
        engine = env["POLICY_ENGINE_ID"]
        boundaries = frozenset(env["ROLE_BOUNDARY_ARNS"].split(","))
        if not _NS_RE.fullmatch(namespace):
            raise ValueError("MANGO_NAMESPACE")
        if not _ID_RE.fullmatch(gateway_id) or not _ID_RE.fullmatch(engine):
            raise ValueError("GATEWAY_ID or POLICY_ENGINE_ID")
        if not boundaries or not all(_ARN_RE.fullmatch(arn) for arn in boundaries):
            raise ValueError("ROLE_BOUNDARY_ARNS")
        targets = frozenset(t for t in env.get("CONNECTOR_TARGETS", "").split(",") if t)
        return GuardSettings(namespace, gateway_id, engine, targets, boundaries)

    @property
    def harness_prefix(self) -> str:
        return f"Mango_{self.namespace}_a_"

    @property
    def pack_prefix(self) -> str:
        """Pack runtimes and their Cedar policies."""
        return f"Mango_{self.namespace}_mcp_"

    @property
    def role_prefixes(self) -> tuple[str, str]:
        return (f"Mango-{self.namespace}-agent-", f"Mango-{self.namespace}-mcp-")


def _attempt(call: Callable[..., Any], **arguments: str) -> None:
    """A deletion request: already gone or still busy is not an error, the next poll decides."""
    try:
        call(**arguments)
    except ClientError as exc:
        if error_code(exc) not in _GONE | _BUSY:
            raise


class Sweep:
    """Everything a provisioner created for this installation, found by name prefix."""

    def __init__(self, settings: GuardSettings, agentcore: Any, iam: Any, logs: Any) -> None:
        self._s = settings
        self._ac = agentcore
        self._iam = iam
        self._logs = logs

    def _pages(self, operation: str, key: str, **arguments: str) -> list[dict[str, Any]]:
        pages = self._ac.get_paginator(operation).paginate(**arguments)
        return [dict(item) for page in pages for item in page[key]]

    def pack_targets(self) -> int:
        targets = [
            target
            for target in self._pages(
                "list_gateway_targets", "items", gatewayIdentifier=self._s.gateway_id
            )
            if target["name"] not in self._s.connector_targets
        ]
        for target in targets:
            if target.get("status") != "DELETING":
                _attempt(
                    self._ac.delete_gateway_target,
                    gatewayIdentifier=self._s.gateway_id,
                    targetId=target["targetId"],
                )
        return len(targets)

    def pack_policies(self) -> int:
        policies = [
            policy
            for policy in self._pages(
                "list_policies", "policies", policyEngineId=self._s.policy_engine_id
            )
            if str(policy["name"]).startswith(self._s.pack_prefix)
        ]
        for policy in policies:
            if policy.get("status") != "DELETING":
                _attempt(
                    self._ac.delete_policy,
                    policyEngineId=self._s.policy_engine_id,
                    policyId=policy["policyId"],
                )
        return len(policies)

    def pack_runtimes(self) -> int:
        runtimes = [
            runtime
            for runtime in self._pages("list_agent_runtimes", "agentRuntimes")
            if str(runtime["agentRuntimeName"]).startswith(self._s.pack_prefix)
        ]
        for runtime in runtimes:
            runtime_id = runtime["agentRuntimeId"]
            endpoints = [
                endpoint
                for endpoint in self._pages(
                    "list_agent_runtime_endpoints", "runtimeEndpoints", agentRuntimeId=runtime_id
                )
                if endpoint["name"] != _DEFAULT_ENDPOINT
            ]
            for endpoint in endpoints:
                if endpoint.get("status") != "DELETING":
                    _attempt(
                        lambda runtime_id=runtime_id, endpoint=endpoint: (
                            self._ac.delete_agent_runtime_endpoint(
                                agentRuntimeId=runtime_id, endpointName=endpoint["name"]
                            )
                        )
                    )
            # A runtime cannot go while it has an endpoint of its own.
            if not endpoints:
                _attempt(self._ac.delete_agent_runtime, agentRuntimeId=runtime_id)
        return len(runtimes)

    def harnesses(self) -> int:
        harnesses = [
            harness
            for harness in self._pages("list_harnesses", "harnesses")
            if str(harness["harnessName"]).startswith(self._s.harness_prefix)
        ]
        for harness in harnesses:
            harness_id = harness["harnessId"]
            endpoints = [
                endpoint
                for endpoint in self._pages(
                    "list_harness_endpoints", "endpoints", harnessId=harness_id
                )
                if endpoint["endpointName"] != _DEFAULT_ENDPOINT
            ]
            for endpoint in endpoints:
                if endpoint.get("status") != "DELETING":
                    _attempt(
                        lambda harness_id=harness_id, endpoint=endpoint: (
                            self._ac.delete_harness_endpoint(
                                harnessId=harness_id, endpointName=endpoint["endpointName"]
                            )
                        )
                    )
            if not endpoints:
                _attempt(self._ac.delete_harness, harnessId=harness_id)
        return len(harnesses)

    def roles(self) -> int:
        """Execution roles of agents and packs: by name prefix **and** permissions boundary."""
        remaining = 0
        for page in self._iam.get_paginator("list_roles").paginate():
            for role in page["Roles"]:
                name = str(role["RoleName"])
                if not name.startswith(self._s.role_prefixes):
                    continue
                # ListRoles does not return the boundary.
                detail = self._iam.get_role(RoleName=name)["Role"]
                boundary = detail.get("PermissionsBoundary", {}).get("PermissionsBoundaryArn")
                if boundary not in self._s.boundaries:
                    continue
                remaining += 1
                policies = self._iam.get_paginator("list_role_policies").paginate(RoleName=name)
                for policy in [p for policy_page in policies for p in policy_page["PolicyNames"]]:
                    _attempt(self._iam.delete_role_policy, RoleName=name, PolicyName=policy)
                _attempt(self._iam.delete_role, RoleName=name)
        return remaining

    def log_groups(self) -> None:
        """Log groups AgentCore made for those runtimes; nothing else deletes them."""
        marks = (self._s.harness_prefix, self._s.pack_prefix)
        pages = self._logs.get_paginator("describe_log_groups").paginate(
            logGroupNamePrefix=_LOG_GROUP_PREFIX
        )
        for page in pages:
            for group in page["logGroups"]:
                name = str(group["logGroupName"])
                if any(mark in name for mark in marks):
                    _attempt(self._logs.delete_log_group, logGroupName=name)

    def run(self) -> dict[str, int]:
        """One pass. Returns what is still there, by kind; all zeros when the sweep is done."""
        remaining = {
            "pack_targets": self.pack_targets(),
            "pack_policies": self.pack_policies(),
            "pack_runtimes": self.pack_runtimes(),
            "harnesses": self.harnesses(),
        }
        # Roles go last: a runtime that is still being deleted may need its role.
        remaining["roles"] = self.roles() if not any(remaining.values()) else -1
        if not any(remaining.values()):
            self.log_groups()
        return remaining


def failed_call(exc: Exception) -> tuple[str, str]:
    """The API operation that failed and its error code, and nothing else of the call.

    Never arguments, identifiers or the AWS message, which may quote ARNs or content. The
    operation is what tells a missing permission apart without searching CloudTrail.
    """
    if not isinstance(exc, ClientError):
        return "-", type(exc).__name__
    operation = str(getattr(exc, "operation_name", ""))
    return (operation if _OPERATION_RE.fullmatch(operation) else "-"), error_code(exc)


def stack_is_being_deleted(cloudformation: Any, stack_id: str) -> bool:
    stacks = cloudformation.describe_stacks(StackName=stack_id)["Stacks"]
    return len(stacks) == 1 and stacks[0]["StackStatus"] == DELETING_STACK


def respond(event: Mapping[str, Any], status: str, reason: str = "") -> None:
    """Answer CloudFormation at the pre-signed URL of the request."""
    body = json.dumps(
        {
            "Status": status,
            "Reason": reason[:400] or "See the function's log group",
            "PhysicalResourceId": event.get("PhysicalResourceId") or "mango-uninstall-guard",
            "StackId": event["StackId"],
            "RequestId": event["RequestId"],
            "LogicalResourceId": event["LogicalResourceId"],
        }
    ).encode()
    url = str(event["ResponseURL"])
    if not url.startswith("https://"):
        raise ValueError("ResponseURL")
    request = urllib.request.Request(  # noqa: S310 - https only, checked above
        url, data=body, method="PUT", headers={"Content-Type": "", "Content-Length": str(len(body))}
    )
    with urllib.request.urlopen(request, timeout=30):  # noqa: S310
        pass


def handle(
    event: dict[str, Any],
    *,
    sweep: Sweep,
    cloudformation: Any,
    reinvoke: Callable[[dict[str, Any]], None],
    answer: Callable[[Mapping[str, Any], str, str], None] = respond,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    if event.get("RequestType") != "Delete":
        answer(event, "SUCCESS", "")
        return
    try:
        if not stack_is_being_deleted(cloudformation, str(event["StackId"])):
            # The resource is being replaced or removed by an update: the installation stays.
            logger.info("uninstall_guard skipped: the stack is not being deleted")
            answer(event, "SUCCESS", "")
            return
        deadline = clock() + INVOCATION_BUDGET_SECONDS
        while True:
            remaining = sweep.run()
            logger.info("uninstall_guard remaining=%s", json.dumps(remaining, sort_keys=True))
            if not any(remaining.values()):
                answer(event, "SUCCESS", "")
                return
            if clock() >= deadline:
                break
            sleep(POLL_SECONDS)
        invocation = int(event.get("MangoInvocation", 1))
        if invocation < MAX_INVOCATIONS:
            reinvoke({**event, "MangoInvocation": invocation + 1})
            return
        left = ", ".join(f"{kind}={count}" for kind, count in sorted(remaining.items()) if count)
        answer(
            event,
            "FAILED",
            f"Agents or packs are still being deleted ({left}). Delete the stack again.",
        )
    except (ClientError, BotoCoreError, KeyError, ValueError) as exc:
        operation, code = failed_call(exc)
        # The operation and the code only: AWS messages may quote ARNs or content.
        logger.error("uninstall_guard failed: operation=%s code=%s", operation, code)  # noqa: TRY400
        failure = code if operation == "-" else f"{operation}: {code}"
        answer(event, "FAILED", f"Uninstall guard failed ({failure}). Delete the stack again.")


def lambda_handler(event: dict[str, Any], context: Any) -> None:
    settings = GuardSettings.from_env()
    function = boto3.client("lambda")

    def reinvoke(next_event: dict[str, Any]) -> None:
        function.invoke(
            FunctionName=context.invoked_function_arn,
            InvocationType="Event",
            Payload=json.dumps(next_event).encode(),
        )

    handle(
        event,
        sweep=Sweep(
            settings,
            boto3.client("bedrock-agentcore-control"),
            boto3.client("iam"),
            boto3.client("logs"),
        ),
        cloudformation=boto3.client("cloudformation"),
        reinvoke=reinvoke,
    )
