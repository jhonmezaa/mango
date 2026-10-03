"""Execution role of an agent (D10): fixed template, permissions boundary, known name.

Nothing here comes from the agent definition except the list of allowed models, and those are
checked against the installation's model catalog before they reach this module (TM-M1). The
provisioner's own IAM policy only lets it create roles under ``Mango-<ns>-agent-*`` that carry
the boundary, so even a bug here cannot produce a wider role.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_provisioner.config import ROLE_POLICY_NAME, Settings
from mango_provisioner.errors import StepError, aws_error, error_code

if TYPE_CHECKING:
    from mypy_boto3_iam import IAMClient

AGENTCORE_SERVICE = "bedrock-agentcore.amazonaws.com"
# Cross-region inference profiles are named `<geography>.<foundation model id>`.
_PROFILE_GEOGRAPHIES = frozenset({"us", "eu", "apac", "global", "us-gov", "jp", "au", "ca"})
_NOT_FOUND = "NoSuchEntity"


def model_arns(settings: Settings, model_id: str) -> list[str]:
    """Bedrock resources needed to invoke a model of the catalog."""
    geography, _, foundation_model = model_id.partition(".")
    if foundation_model and geography in _PROFILE_GEOGRAPHIES:
        return [
            f"arn:aws:bedrock:{settings.region}:{settings.account_id}:inference-profile/{model_id}",
            # The profile routes to the model in several regions.
            f"arn:aws:bedrock:*::foundation-model/{foundation_model}",
        ]
    return [f"arn:aws:bedrock:{settings.region}::foundation-model/{model_id}"]


def trust_policy(settings: Settings, agent_id: str) -> dict[str, Any]:
    """Only AgentCore, in this account, acting for this agent's harness or its runtime."""
    prefix = f"arn:aws:bedrock-agentcore:{settings.region}:{settings.account_id}"
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {"Service": AGENTCORE_SERVICE},
                "Action": "sts:AssumeRole",
                "Condition": {
                    "StringEquals": {"aws:SourceAccount": settings.account_id},
                    "ArnLike": {
                        "aws:SourceArn": [
                            f"{prefix}:harness/{settings.harness_name(agent_id)}-*",
                            f"{prefix}:runtime/{settings.runtime_name(agent_id)}-*",
                        ]
                    },
                },
            }
        ],
    }


def role_policy(settings: Settings, agent_id: str, models: Iterable[str]) -> dict[str, Any]:
    """Inline policy of an agent role. Same statements for every agent; only models vary."""
    runtime = settings.runtime_name(agent_id)
    agentcore = f"arn:aws:bedrock-agentcore:{settings.region}:{settings.account_id}"
    model_resources = sorted({arn for model in models for arn in model_arns(settings, model)})
    if not model_resources:
        raise StepError("no_models")
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "InvokeAllowedModels",
                "Effect": "Allow",
                "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
                "Resource": model_resources,
            },
            {
                "Sid": "ApplyBaseGuardrail",
                "Effect": "Allow",
                "Action": "bedrock:ApplyGuardrail",
                "Resource": settings.guardrail_arn,
            },
            {
                # Required by the managed harness environment; no resource scope exists.
                "Sid": "ManagedRuntimeImage",
                "Effect": "Allow",
                "Action": ["ecr-public:GetAuthorizationToken", "sts:GetServiceBearerToken"],
                "Resource": "*",
            },
            {
                "Sid": "RuntimeLogs",
                "Effect": "Allow",
                "Action": [
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                    "logs:DescribeLogStreams",
                ],
                "Resource": (
                    f"arn:aws:logs:{settings.region}:{settings.account_id}:log-group:"
                    f"/aws/bedrock-agentcore/runtimes/{runtime}-*"
                ),
            },
            {
                "Sid": "Tracing",
                "Effect": "Allow",
                "Action": ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
                "Resource": "*",
            },
            {
                "Sid": "Metrics",
                "Effect": "Allow",
                "Action": "cloudwatch:PutMetricData",
                "Resource": "*",
                "Condition": {"StringEquals": {"cloudwatch:namespace": "bedrock-agentcore"}},
            },
            {
                "Sid": "WorkloadIdentity",
                "Effect": "Allow",
                "Action": [
                    "bedrock-agentcore:GetWorkloadAccessToken",
                    "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
                ],
                "Resource": [
                    f"{agentcore}:workload-identity-directory/default",
                    f"{agentcore}:workload-identity-directory/default/workload-identity/{runtime}-*",
                ],
            },
        ],
    }


class AgentRoles:
    def __init__(self, iam: IAMClient, settings: Settings) -> None:
        self._iam = iam
        self._settings = settings

    def ensure(self, agent_id: str, models: Iterable[str]) -> bool:
        """Create the role if needed and set its policy. Returns whether it was created.

        An existing role is used only if it still carries the boundary and the expected trust:
        the provisioner never repairs a role someone changed (TM-M6), it fails.
        """
        name = self._settings.role_name(agent_id)
        document = role_policy(self._settings, agent_id, models)
        created = False
        role = self._get(name)
        if role is None:
            created = self._create(agent_id, name)
            role = self._get(name)
            if role is None:
                raise StepError("role_not_found")
        self._verify(agent_id, role)
        try:
            self._iam.put_role_policy(
                RoleName=name,
                PolicyName=ROLE_POLICY_NAME,
                PolicyDocument=json.dumps(document, separators=(",", ":")),
            )
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("PutRolePolicy", exc) from None
        return created

    def exists(self, agent_id: str) -> bool:
        return self._get(self._settings.role_name(agent_id)) is not None

    def delete(self, agent_id: str) -> None:
        """Remove the role of an agent that was never published. Missing pieces are fine."""
        name = self._settings.role_name(agent_id)
        if self._get(name) is None:
            # IAM answers AccessDenied, not NoSuchEntity, when the role does not exist: the
            # provisioner may only change the policy of a role that carries the boundary.
            return
        try:
            self._iam.delete_role_policy(RoleName=name, PolicyName=ROLE_POLICY_NAME)
        except ClientError as exc:
            if error_code(exc) != _NOT_FOUND:
                raise aws_error("DeleteRolePolicy", exc) from None
        except BotoCoreError as exc:
            raise aws_error("DeleteRolePolicy", exc) from None
        try:
            self._iam.delete_role(RoleName=name)
        except ClientError as exc:
            if error_code(exc) != _NOT_FOUND:
                raise aws_error("DeleteRole", exc) from None
        except BotoCoreError as exc:
            raise aws_error("DeleteRole", exc) from None

    def _get(self, name: str) -> dict[str, Any] | None:
        try:
            return dict(self._iam.get_role(RoleName=name)["Role"])
        except ClientError as exc:
            if error_code(exc) == _NOT_FOUND:
                return None
            raise aws_error("GetRole", exc) from None
        except BotoCoreError as exc:
            raise aws_error("GetRole", exc) from None

    def _create(self, agent_id: str, name: str) -> bool:
        settings = self._settings
        try:
            self._iam.create_role(
                RoleName=name,
                AssumeRolePolicyDocument=json.dumps(
                    trust_policy(settings, agent_id), separators=(",", ":")
                ),
                PermissionsBoundary=settings.boundary_arn,
                Description="Mango agent execution role (created by the provisioner)",
                Tags=[{"Key": k, "Value": v} for k, v in settings.tags(agent_id).items()],
            )
        except ClientError as exc:
            if error_code(exc) == "EntityAlreadyExists":
                return False
            raise aws_error("CreateRole", exc) from None
        except BotoCoreError as exc:
            raise aws_error("CreateRole", exc) from None
        return True

    def _verify(self, agent_id: str, role: dict[str, Any]) -> None:
        boundary = role.get("PermissionsBoundary", {}).get("PermissionsBoundaryArn")
        if boundary != self._settings.boundary_arn:
            raise StepError("role_without_boundary")
        if role.get("Path") != "/":
            raise StepError("role_path_mismatch")
        trust = role.get("AssumeRolePolicyDocument")
        if isinstance(trust, str):
            trust = json.loads(trust)
        if _canonical(trust) != _canonical(trust_policy(self._settings, agent_id)):
            raise StepError("role_trust_mismatch")


def _canonical(document: Any) -> str:
    return json.dumps(document, sort_keys=True, separators=(",", ":"))
