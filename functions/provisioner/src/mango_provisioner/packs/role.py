"""Execution role of an MCP pack (D19): its signed manifest, a permissions boundary, a known name.

The data permissions of the role are the IAM statements of the signed manifest and nothing
else: no field of an enablement request reaches this module (TM-M1). The statements the
runtime needs for itself (its own logs, traces and metrics) are a fixed template. The
provisioner's own IAM policy only lets it create roles under ``Mango-<ns>-mcp-*`` that carry
the pack boundary, so even a bug here cannot produce a wider role.

A pack over account data (``central_only``, D37) is the exception that proves rule 5: its
role gets **no** data permission. All it may do is assume the installation's broker, which
demands a ``SourceIdentity``; the manifest's statements become the session policy of each
call (``mango_pack_runtime``), never a permission of the role.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError
from pydantic import ValidationError

from mango_packs.manifest import IamStatement, PackManifest
from mango_provisioner.errors import StepError, aws_error, error_code
from mango_provisioner.packs.config import ROLE_POLICY_NAME, PackSettings

if TYPE_CHECKING:
    from mypy_boto3_iam import IAMClient

AGENTCORE_SERVICE = "bedrock-agentcore.amazonaws.com"
_NOT_FOUND = "NoSuchEntity"

Grant = tuple[tuple[str, ...], tuple[str, ...]]
"""``(actions, resources)`` of one IAM statement of a manifest."""


BROKER_ACTIONS = ("sts:AssumeRole", "sts:SetSourceIdentity", "sts:TagSession")
MODE_SERVICE = "service"
MODE_CENTRAL_ONLY = "central_only"


def grants_of(manifest: PackManifest) -> list[Grant]:
    return [(tuple(s.actions), tuple(s.resources)) for s in manifest.iam]


def role_grants(identity_mode: str, grants: Iterable[Grant]) -> list[Grant]:
    """The statements of a manifest that are permissions of the pack's own role: all of them
    for a ``service`` pack, none when the pack acts through the broker."""
    return list(grants) if identity_mode == MODE_SERVICE else []


def grants_to_json(grants: Iterable[Grant]) -> list[dict[str, list[str]]]:
    return [
        {"actions": list(actions), "resources": list(resources)} for actions, resources in grants
    ]


def grants_from_json(raw: object) -> list[Grant]:
    """Grants recorded in the installed pointer, checked with the manifest's own rules."""
    if not isinstance(raw, list):
        raise StepError("installed_record_invalid")
    grants: list[Grant] = []
    for entry in raw:
        try:
            statement = IamStatement.model_validate({**entry, "reason": "recorded"})
        except (ValidationError, TypeError):
            raise StepError("installed_record_invalid") from None
        grants.append((tuple(statement.actions), tuple(statement.resources)))
    return grants


def trust_policy(settings: PackSettings, pack_id: str) -> dict[str, Any]:
    """Only AgentCore, in this account, acting for this pack's runtime."""
    runtime = f"arn:aws:bedrock-agentcore:{settings.region}:{settings.account_id}:runtime"
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {"Service": AGENTCORE_SERVICE},
                "Action": "sts:AssumeRole",
                "Condition": {
                    "StringEquals": {"aws:SourceAccount": settings.account_id},
                    "ArnLike": {"aws:SourceArn": f"{runtime}/{settings.runtime_name(pack_id)}-*"},
                },
            }
        ],
    }


def role_policy(
    settings: PackSettings,
    pack_id: str,
    grants: Iterable[Grant],
    *,
    broker: bool = False,
    member: bool = False,
) -> dict[str, Any]:
    """Inline policy of a pack role: the manifest's statements (``service`` packs) or the
    right to assume the broker of its chain (``broker``; the Read broker when ``member``),
    plus the runtime's own needs."""
    statements: list[dict[str, Any]] = []
    for actions, resources in sorted(set(grants)):
        if not set(actions) <= settings.allowed_actions:
            raise StepError("action_outside_boundary")
        statements.append(
            {
                "Sid": f"Manifest{len(statements) + 1}",
                "Effect": "Allow",
                "Action": sorted(actions),
                "Resource": sorted(resources),
            }
        )
    if broker:
        # One broker per pack: the one of its chain, never both.
        broker_arn = settings.broker_for(member=member)
        if broker_arn is None:
            raise StepError("identity_unavailable")
        statements.append(
            {
                "Sid": "AssumeBroker",
                "Effect": "Allow",
                "Action": list(BROKER_ACTIONS),
                "Resource": broker_arn,
            }
        )
    logs = (
        f"arn:aws:logs:{settings.region}:{settings.account_id}:log-group:"
        f"/aws/bedrock-agentcore/runtimes/{settings.runtime_name(pack_id)}-*"
    )
    statements += [
        {
            "Sid": "RuntimeLogs",
            "Effect": "Allow",
            "Action": [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "logs:DescribeLogStreams",
            ],
            "Resource": [logs, f"{logs}:log-stream:*"],
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
    ]
    return {"Version": "2012-10-17", "Statement": statements}


class PackRoles:
    def __init__(self, iam: IAMClient, settings: PackSettings) -> None:
        self._iam = iam
        self._settings = settings

    def ensure(
        self,
        pack_id: str,
        grants: Iterable[Grant],
        *,
        broker: bool = False,
        member: bool = False,
    ) -> bool:
        """Create the role if needed and set its policy. Returns whether it was created.

        An existing role is used only if it still carries the boundary and the expected trust:
        the provisioner never repairs a role someone changed (TM-M6), it fails.
        """
        name = self._settings.role_name(pack_id)
        document = role_policy(self._settings, pack_id, grants, broker=broker, member=member)
        created = False
        role = self._get(name)
        if role is None:
            created = self._create(pack_id, name)
            role = self._get(name)
            if role is None:
                raise StepError("role_not_found")
        self._verify(pack_id, role)
        try:
            self._iam.put_role_policy(
                RoleName=name,
                PolicyName=ROLE_POLICY_NAME,
                PolicyDocument=json.dumps(document, separators=(",", ":")),
            )
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("PutRolePolicy", exc) from None
        return created

    def exists(self, pack_id: str) -> bool:
        return self._get(self._settings.role_name(pack_id)) is not None

    def delete(self, pack_id: str) -> None:
        """Remove the role of a pack that is no longer installed. Missing pieces are fine."""
        name = self._settings.role_name(pack_id)
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

    def _create(self, pack_id: str, name: str) -> bool:
        settings = self._settings
        try:
            self._iam.create_role(
                RoleName=name,
                AssumeRolePolicyDocument=json.dumps(
                    trust_policy(settings, pack_id), separators=(",", ":")
                ),
                PermissionsBoundary=settings.boundary_arn,
                Description="Mango MCP pack execution role (created by the provisioner)",
                Tags=[{"Key": k, "Value": v} for k, v in settings.tags(pack_id).items()],
            )
        except ClientError as exc:
            if error_code(exc) == "EntityAlreadyExists":
                return False
            raise aws_error("CreateRole", exc) from None
        except BotoCoreError as exc:
            raise aws_error("CreateRole", exc) from None
        return True

    def _verify(self, pack_id: str, role: dict[str, Any]) -> None:
        boundary = role.get("PermissionsBoundary", {}).get("PermissionsBoundaryArn")
        if boundary != self._settings.boundary_arn:
            raise StepError("role_without_boundary")
        if role.get("Path") != "/":
            raise StepError("role_path_mismatch")
        trust = role.get("AssumeRolePolicyDocument")
        if isinstance(trust, str):
            trust = json.loads(trust)
        if _canonical(trust) != _canonical(trust_policy(self._settings, pack_id)):
            raise StepError("role_trust_mismatch")


def _canonical(document: Any) -> str:
    return json.dumps(document, sort_keys=True, separators=(",", ":"))
