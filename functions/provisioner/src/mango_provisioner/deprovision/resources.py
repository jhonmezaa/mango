"""The AWS resources of a retired agent: its harness (with its endpoints) and its role.

Both are found by the name the provisioner derives from the agent id, never from anything
stored: a wrong reference cannot make this module delete something else. Deletions in
AgentCore are asynchronous, so every method here is safe to repeat and callers poll.

The harness is only ever listed (``ListHarnesses``, ``ListHarnessEndpoints``): this module
never reads a harness, so the prompt it stores is not requested.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_provisioner.deprovision.config import ENDPOINT_DEFAULT, DeprovisionSettings
from mango_provisioner.errors import StepError, aws_error, error_code

if TYPE_CHECKING:
    from mypy_boto3_bedrock_agentcore_control import BedrockAgentCoreControlClient
    from mypy_boto3_iam import IAMClient

DELETING = "DELETING"
_HARNESS_NOT_FOUND = "ResourceNotFoundException"
_ROLE_NOT_FOUND = "NoSuchEntity"
_CONFLICT = "ConflictException"


@dataclass(frozen=True)
class HarnessSummary:
    harness_id: str
    status: str


class RetiredHarnesses:
    def __init__(
        self, agentcore: BedrockAgentCoreControlClient, settings: DeprovisionSettings
    ) -> None:
        self._ac = agentcore
        self._settings = settings

    def find(self, agent_id: str) -> HarnessSummary | None:
        """The agent's harness, or ``None``. Only ever by its exact name and id shape."""
        name = self._settings.harness_name(agent_id)
        pattern = self._settings.harness_id_pattern(agent_id)
        try:
            for page in self._ac.get_paginator("list_harnesses").paginate():
                for summary in page["harnesses"]:
                    if summary["harnessName"] == name and pattern.fullmatch(summary["harnessId"]):
                        return HarnessSummary(summary["harnessId"], str(summary["status"]))
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("ListHarnesses", exc) from None
        return None

    def _endpoints(self, harness_id: str) -> list[dict[str, Any]]:
        """Endpoints of the harness other than ``DEFAULT`` (which AgentCore owns)."""
        found: list[dict[str, Any]] = []
        try:
            pages = self._ac.get_paginator("list_harness_endpoints").paginate(harnessId=harness_id)
            for page in pages:
                found.extend(
                    dict(endpoint)
                    for endpoint in page["endpoints"]
                    if endpoint["endpointName"] != ENDPOINT_DEFAULT
                )
        except ClientError as exc:
            if error_code(exc) == _HARNESS_NOT_FOUND:
                return []
            raise aws_error("ListHarnessEndpoints", exc) from None
        except BotoCoreError as exc:
            raise aws_error("ListHarnessEndpoints", exc) from None
        return found

    def delete_endpoints(self, harness_id: str) -> int:
        """Request the deletion of every endpoint but ``DEFAULT``.

        Returns how many are still there (being deleted): the harness cannot be deleted until
        this is zero.
        """
        endpoints = self._endpoints(harness_id)
        for endpoint in endpoints:
            if endpoint["status"] == DELETING:
                continue
            try:
                self._ac.delete_harness_endpoint(
                    harnessId=harness_id, endpointName=endpoint["endpointName"]
                )
            except ClientError as exc:
                # Gone meanwhile, or AgentCore is still working on it: the next poll decides.
                if error_code(exc) not in {_HARNESS_NOT_FOUND, _CONFLICT}:
                    raise aws_error("DeleteHarnessEndpoint", exc) from None
            except BotoCoreError as exc:
                raise aws_error("DeleteHarnessEndpoint", exc) from None
        return len(endpoints)

    def delete(self, harness_id: str) -> None:
        """Request the deletion of the harness; AgentCore removes its managed runtime.

        AgentCore answers ``ConflictException`` while an endpoint is still going away (seen in
        the lab, for minutes): that is not an error, the caller polls again.
        """
        try:
            self._ac.delete_harness(harnessId=harness_id)
        except ClientError as exc:
            if error_code(exc) not in {_HARNESS_NOT_FOUND, _CONFLICT}:
                raise aws_error("DeleteHarness", exc) from None
        except BotoCoreError as exc:
            raise aws_error("DeleteHarness", exc) from None


class RetiredRoles:
    def __init__(self, iam: IAMClient, settings: DeprovisionSettings) -> None:
        self._iam = iam
        self._settings = settings

    def exists(self, agent_id: str) -> bool:
        return self._get(self._settings.role_name(agent_id)) is not None

    def delete(self, agent_id: str) -> None:
        """Delete the agent's role: its inline policies first, then the role.

        Only a role that carries the agent permissions boundary is one the provisioner
        created; anything else under that name is left alone and reported. A role with managed
        policies attached was changed outside Mango: IAM refuses to delete it and so does this.
        """
        name = self._settings.role_name(agent_id)
        role = self._get(name)
        if role is None:
            return
        boundary = role.get("PermissionsBoundary", {}).get("PermissionsBoundaryArn")
        if boundary != self._settings.boundary_arn or role.get("Path") != "/":
            raise StepError("role_without_boundary")
        try:
            policies = [
                policy
                for page in self._iam.get_paginator("list_role_policies").paginate(RoleName=name)
                for policy in page["PolicyNames"]
            ]
            for policy in policies:
                self._iam.delete_role_policy(RoleName=name, PolicyName=policy)
        except ClientError as exc:
            if error_code(exc) != _ROLE_NOT_FOUND:
                raise aws_error("DeleteRolePolicy", exc) from None
        except BotoCoreError as exc:
            raise aws_error("DeleteRolePolicy", exc) from None
        try:
            self._iam.delete_role(RoleName=name)
        except ClientError as exc:
            if error_code(exc) != _ROLE_NOT_FOUND:
                raise aws_error("DeleteRole", exc) from None
        except BotoCoreError as exc:
            raise aws_error("DeleteRole", exc) from None

    def _get(self, name: str) -> dict[str, Any] | None:
        try:
            return dict(self._iam.get_role(RoleName=name)["Role"])
        except ClientError as exc:
            if error_code(exc) == _ROLE_NOT_FOUND:
                return None
            raise aws_error("GetRole", exc) from None
        except BotoCoreError as exc:
            raise aws_error("GetRole", exc) from None
