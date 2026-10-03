"""What actually exists in AWS under this installation's names: agent harnesses and roles,
and the runtimes of MCP packs.

Read-only calls. Resources are found by listing, not from the table, so one nobody defined
(or one whose agent was deleted) is still seen. Any AWS error propagates: a partial inventory
must never look like a clean installation.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from botocore.exceptions import ClientError

from mango_reconciler.config import ENDPOINT_DEFAULT, ENDPOINT_LIVE, Settings

if TYPE_CHECKING:
    from mypy_boto3_bedrock_agentcore_control import BedrockAgentCoreControlClient
    from mypy_boto3_iam import IAMClient

ENV_AGENT_ID = "MANGO_AGENT_ID"
ENV_AGENT_VERSION = "MANGO_AGENT_VERSION"
ENV_CONTENT_HASH = "MANGO_CONTENT_HASH"
_MARKERS = (ENV_AGENT_ID, ENV_AGENT_VERSION, ENV_CONTENT_HASH)
_NOT_FOUND = "ResourceNotFoundException"


@dataclass(frozen=True)
class HarnessVersion:
    version: str
    status: str
    execution_role_arn: str | None
    markers: dict[str, str]
    """The ``MANGO_*`` variables the provisioner stamps on every version it creates."""


@dataclass(frozen=True)
class LiveEndpoint:
    status: str
    live_version: str | None


@dataclass(frozen=True)
class Harness:
    harness_id: str
    name: str
    arn: str
    agent_id: str | None
    """``None`` when the name is under the prefix but is not one Mango would generate."""
    latest: HarnessVersion
    live: LiveEndpoint | None


@dataclass(frozen=True)
class Role:
    name: str
    agent_id: str | None
    boundary_arn: str | None
    path: str
    trust: Any
    inline_policies: tuple[str, ...]
    attached_policies: tuple[str, ...]


@dataclass(frozen=True)
class RuntimeVersion:
    version: str
    network_mode: str
    """``networkConfiguration.networkMode``; empty when AgentCore reports none."""
    endpoints: tuple[str, ...]
    """Endpoints that serve this version."""


@dataclass(frozen=True)
class PackRuntime:
    runtime_id: str
    name: str
    versions: tuple[RuntimeVersion, ...]
    """The versions that can be invoked: the latest one (``DEFAULT`` always serves it) and
    the one ``live`` serves, which is what the Gateway calls."""


def _not_found(exc: ClientError) -> bool:
    return str(exc.response.get("Error", {}).get("Code")) == _NOT_FOUND


def _version(harness: dict[str, Any]) -> HarnessVersion:
    env = harness.get("environmentVariables") or {}
    return HarnessVersion(
        version=str(harness["harnessVersion"]),
        status=str(harness["status"]),
        execution_role_arn=harness.get("executionRoleArn"),
        markers={k: str(env[k]) for k in _MARKERS if k in env},
    )


class Harnesses:
    def __init__(self, agentcore: BedrockAgentCoreControlClient, settings: Settings) -> None:
        self._ac = agentcore
        self._settings = settings

    def list(self) -> list[Harness]:
        """Every harness under ``Mango_<ns>_a_``, with its latest version and ``live``."""
        prefix = self._settings.harness_prefix
        found: list[Harness] = []
        for page in self._ac.get_paginator("list_harnesses").paginate():
            for summary in page["harnesses"]:
                name = str(summary["harnessName"])
                if not name.startswith(prefix):
                    continue
                harness_id = str(summary["harnessId"])
                try:
                    latest = dict(self._ac.get_harness(harnessId=harness_id)["harness"])
                except ClientError as exc:
                    if _not_found(exc):
                        continue  # Deleted between the listing and the read.
                    raise
                found.append(
                    Harness(
                        harness_id=harness_id,
                        name=name,
                        arn=self._settings.harness_arn(harness_id),
                        agent_id=self._settings.agent_of_harness(name, harness_id),
                        latest=_version(latest),
                        live=self._live(harness_id),
                    )
                )
        return found

    def _live(self, harness_id: str) -> LiveEndpoint | None:
        try:
            endpoint = self._ac.get_harness_endpoint(
                harnessId=harness_id, endpointName=ENDPOINT_LIVE
            )["endpoint"]
        except ClientError as exc:
            if _not_found(exc):
                return None
            raise
        live = endpoint.get("liveVersion")
        return LiveEndpoint(
            status=str(endpoint["status"]), live_version=str(live) if live else None
        )

    def version(self, harness_id: str, version: str) -> HarnessVersion | None:
        """One immutable version of a harness, or ``None`` if it does not exist."""
        try:
            return _version(
                dict(self._ac.get_harness(harnessId=harness_id, harnessVersion=version)["harness"])
            )
        except ClientError as exc:
            if _not_found(exc):
                return None
            raise


class PackRuntimes:
    def __init__(self, agentcore: BedrockAgentCoreControlClient, settings: Settings) -> None:
        self._ac = agentcore
        self._settings = settings

    def list(self) -> list[PackRuntime]:
        """Every runtime under ``Mango_<ns>_mcp_`` with the network of what it serves."""
        prefix = self._settings.pack_runtime_prefix
        found: list[PackRuntime] = []
        for page in self._ac.get_paginator("list_agent_runtimes").paginate():
            for summary in page["agentRuntimes"]:
                name = str(summary["agentRuntimeName"])
                if not name.startswith(prefix):
                    continue
                runtime_id = str(summary["agentRuntimeId"])
                latest = self._network(runtime_id)
                if latest is None:
                    continue  # Deleted between the listing and the read.
                version, mode = latest
                served = {version: (mode, [ENDPOINT_DEFAULT])}
                live = self._live_version(runtime_id)
                if live in served:
                    served[live][1].append(ENDPOINT_LIVE)
                elif live is not None and (other := self._network(runtime_id, live)) is not None:
                    served[live] = (other[1], [ENDPOINT_LIVE])
                found.append(
                    PackRuntime(
                        runtime_id=runtime_id,
                        name=name,
                        versions=tuple(
                            RuntimeVersion(number, network, tuple(endpoints))
                            for number, (network, endpoints) in served.items()
                        ),
                    )
                )
        return found

    def _network(self, runtime_id: str, version: str | None = None) -> tuple[str, str] | None:
        """``(version, network mode)`` of the latest version of a runtime, or of ``version``."""
        try:
            if version is None:
                runtime = dict(self._ac.get_agent_runtime(agentRuntimeId=runtime_id))
            else:
                runtime = dict(
                    self._ac.get_agent_runtime(
                        agentRuntimeId=runtime_id, agentRuntimeVersion=version
                    )
                )
        except ClientError as exc:
            if _not_found(exc):
                return None
            raise
        network: Any = runtime.get("networkConfiguration")
        mode = network.get("networkMode") if isinstance(network, dict) else None
        return str(runtime["agentRuntimeVersion"]), str(mode or "")

    def _live_version(self, runtime_id: str) -> str | None:
        try:
            endpoint = self._ac.get_agent_runtime_endpoint(
                agentRuntimeId=runtime_id, endpointName=ENDPOINT_LIVE
            )
        except ClientError as exc:
            if _not_found(exc):
                return None
            raise
        live = endpoint.get("liveVersion")
        return str(live) if live else None


class Roles:
    def __init__(self, iam: IAMClient, settings: Settings) -> None:
        self._iam = iam
        self._settings = settings

    def list(self) -> list[Role]:
        """Every role under ``Mango-<ns>-agent-`` with what decides its reach."""
        # IAM names are unique regardless of case: a look-alike must not slip through.
        prefix = self._settings.role_prefix.lower()
        names = [
            str(role["RoleName"])
            for page in self._iam.get_paginator("list_roles").paginate()
            for role in page["Roles"]
            if str(role["RoleName"]).lower().startswith(prefix)
        ]
        return [role for name in names if (role := self._read(name)) is not None]

    def _read(self, name: str) -> Role | None:
        try:
            role = self._iam.get_role(RoleName=name)["Role"]
            inline = [
                policy
                for page in self._iam.get_paginator("list_role_policies").paginate(RoleName=name)
                for policy in page["PolicyNames"]
            ]
            attached = [
                str(policy["PolicyArn"])
                for page in self._iam.get_paginator("list_attached_role_policies").paginate(
                    RoleName=name
                )
                for policy in page["AttachedPolicies"]
            ]
        except self._iam.exceptions.NoSuchEntityException:
            return None  # Deleted between the listing and the read.
        trust: Any = role.get("AssumeRolePolicyDocument")
        if isinstance(trust, str):
            trust = json.loads(trust)
        boundary = role.get("PermissionsBoundary", {}).get("PermissionsBoundaryArn")
        return Role(
            name=name,
            agent_id=self._settings.agent_of_role(name),
            boundary_arn=boundary,
            path=str(role.get("Path", "")),
            trust=trust,
            inline_policies=tuple(sorted(inline)),
            attached_policies=tuple(sorted(attached)),
        )
