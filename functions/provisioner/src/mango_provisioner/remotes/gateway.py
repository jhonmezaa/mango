"""Gateway side of a remote MCP: its ``remote-<reg>`` target and its Cedar policies (L2).

The target reaches the third-party server with the person's own token from the vault (3LO,
``AUTHORIZATION_CODE``, D93, D94): the provider is always the one this registration's name
and generation give, its ARN is built here, never read from a record. The tool schema is
fixed (``mcpToolSchema``, never ``DYNAMIC``: listing does not work with 3LO and a pinned
schema keeps out whatever else the server serves). Only ``X-MCP-Readonly`` and
``X-MCP-Toolsets`` may pass; the ``REQUEST`` interceptor sets them from the signed catalog.

The policies permit the approved tools to any signed-in user, like a public pack (D33): the
groups of a registration are enforced by mango-api in L1 and in the invocation signature
(D98 (18)). Only the target named ``remote-<reg>`` and the policies ``Mango_<ns>_remote_<reg>_<n>``
are ever touched; a target with that name that this provisioner did not make is refused.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_core import remote_mcp
from mango_provisioner.errors import RetryableError, StepError, aws_error, error_code
from mango_provisioner.remotes.config import RemoteSettings
from mango_provisioner.remotes.release import TargetPlan

if TYPE_CHECKING:
    from mypy_boto3_bedrock_agentcore_control import BedrockAgentCoreControlClient

logger = logging.getLogger(__name__)

MAX_STATEMENT_CHARS = 9_000
"""Below AgentCore's limit for a Cedar statement (10 000 characters)."""
ALLOWED_HEADERS = (remote_mcp.READONLY_HEADER, remote_mcp.TOOLSETS_HEADER)
_NOT_FOUND = "ResourceNotFoundException"
_OAUTH = "OAUTH"
_GRANT = "AUTHORIZATION_CODE"
_AGENTCORE_HEADER_PREFIX = "x-amzn-bedrock-agentcore-"
_TARGET_BUSY = frozenset({"CREATING", "UPDATING", "SYNCHRONIZING"})
_TARGET_FAILED = frozenset({"FAILED", "UPDATE_UNSUCCESSFUL", "SYNCHRONIZE_UNSUCCESSFUL"})
# A target waiting for an administrator's authorization cannot even be deleted (finding of
# 2026-10-25): with a pinned schema it should never happen, so it fails loudly.
_TARGET_PENDING_AUTH = frozenset(
    {"CREATE_PENDING_AUTH", "UPDATE_PENDING_AUTH", "SYNCHRONIZE_PENDING_AUTH"}
)
_POLICY_BUSY = frozenset({"CREATING", "UPDATING"})
_POLICY_FAILED = frozenset({"CREATE_FAILED", "UPDATE_FAILED", "DELETE_FAILED"})


def policy_statements(
    settings: RemoteSettings, registration_id: str, tools: Iterable[str]
) -> list[str]:
    """Cedar ``permit`` statements for the approved tools of one remote target."""
    names = sorted(tools)
    if not names:
        raise StepError("no_tools")
    try:
        actions = [
            f'AgentCore::Action::"{remote_mcp.gateway_tool_name(registration_id, name)}"'
            for name in names
        ]
    except ValueError:
        # Names end up inside a Cedar string: only what a profile may declare.
        raise StepError("invalid_tool_name") from None
    resource = f'AgentCore::Gateway::"{settings.gateway_arn}"'
    statements: list[str] = []
    chunk: list[str] = []

    def flush() -> None:
        statements.append(
            "permit (\n"
            "  principal is AgentCore::OAuthUser,\n"
            f"  action in [{', '.join(chunk)}],\n"
            f"  resource == {resource}\n"
            ");"
        )

    for action in actions:
        if chunk and sum(len(a) + 2 for a in chunk) + len(action) > MAX_STATEMENT_CHARS - 300:
            flush()
            chunk = []
        chunk.append(action)
    flush()
    return statements


class RemoteGateway:
    def __init__(self, agentcore: BedrockAgentCoreControlClient, settings: RemoteSettings) -> None:
        self._ac = agentcore
        self._settings = settings

    # --- Target ---------------------------------------------------------------------------

    def desired(self, registration_id: str, generation: int, plan: TargetPlan) -> dict[str, Any]:
        settings = self._settings
        return {
            "targetConfiguration": {
                "mcp": {
                    "mcpServer": {
                        "endpoint": plan.endpoint,
                        "mcpToolSchema": {"inlinePayload": plan.inline_schema},
                    }
                }
            },
            "credentialProviderConfigurations": [
                {
                    "credentialProviderType": _OAUTH,
                    "credentialProvider": {
                        "oauthCredentialProvider": {
                            "providerArn": settings.provider_arn(registration_id, generation),
                            "scopes": list(plan.scopes),
                            "grantType": _GRANT,
                            "defaultReturnUrl": settings.return_url,
                        }
                    },
                }
            ],
            "metadataConfiguration": {"allowedRequestHeaders": list(ALLOWED_HEADERS)},
        }

    def _ours(self, target: dict[str, Any], registration_id: str) -> bool:
        """An MCP server target whose credentials are a provider of this registration."""
        credentials = target.get("credentialProviderConfigurations") or []
        if len(credentials) != 1 or credentials[0].get("credentialProviderType") != _OAUTH:
            return False
        oauth = (credentials[0].get("credentialProvider") or {}).get("oauthCredentialProvider")
        arn = (oauth or {}).get("providerArn")
        prefix = self._settings.provider_arn(registration_id, 1)[: -len("1")]
        mcp = (target.get("targetConfiguration") or {}).get("mcp") or {}
        return (
            isinstance(arn, str)
            and arn.startswith(prefix)
            and re.fullmatch(r"[1-9][0-9]{0,5}", arn[len(prefix) :]) is not None
            and isinstance((mcp.get("mcpServer") or {}).get("endpoint"), str)
        )

    def find_target(self, registration_id: str) -> dict[str, Any] | None:
        settings = self._settings
        name = remote_mcp.target_name(registration_id)
        if name in settings.connector_targets:
            raise StepError("reserved_target")
        try:
            pages = self._ac.get_paginator("list_gateway_targets").paginate(
                gatewayIdentifier=settings.gateway_id
            )
            for page in pages:
                for summary in page["items"]:
                    if summary["name"] == name:
                        target = dict(
                            self._ac.get_gateway_target(
                                gatewayIdentifier=settings.gateway_id,
                                targetId=summary["targetId"],
                            )
                        )
                        if not self._ours(target, registration_id):
                            raise StepError("foreign_target")
                        return target
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("ListGatewayTargets", exc) from None
        return None

    @staticmethod
    def _differences(target: dict[str, Any], desired: dict[str, Any]) -> list[str]:
        """The fields Mango sets that the target does not hold. AgentCore may return more than
        it was sent (defaults such as ``customParameters``), so only these are compared."""
        mcp = ((target.get("targetConfiguration") or {}).get("mcp") or {}).get("mcpServer") or {}
        wanted = desired["targetConfiguration"]["mcp"]["mcpServer"]
        schema = (mcp.get("mcpToolSchema") or {}).get("inlinePayload")
        try:
            same_schema = isinstance(schema, str) and json.loads(schema) == json.loads(
                wanted["mcpToolSchema"]["inlinePayload"]
            )
        except ValueError:
            same_schema = False
        credentials = target.get("credentialProviderConfigurations") or []
        oauth: dict[str, Any] = {}
        if len(credentials) == 1 and credentials[0].get("credentialProviderType") == _OAUTH:
            oauth = (credentials[0].get("credentialProvider") or {}).get(
                "oauthCredentialProvider"
            ) or {}
        want = desired["credentialProviderConfigurations"][0]["credentialProvider"][
            "oauthCredentialProvider"
        ]
        # Header names are case-insensitive. AgentCore adds its own to a Gateway with a policy
        # engine (``x-amzn-bedrock-agentcore-policy-session-id``, seen on 2026-10-28): only
        # those may come on top of Mango's.
        headers = {
            str(h).lower()
            for h in (target.get("metadataConfiguration") or {}).get("allowedRequestHeaders") or []
        }
        ours = {h.lower() for h in ALLOWED_HEADERS}
        checks = {
            "endpoint": mcp.get("endpoint") == wanted["endpoint"],
            "schema": same_schema,
            "provider": oauth.get("providerArn") == want["providerArn"],
            "scopes": sorted(oauth.get("scopes") or []) == sorted(want["scopes"]),
            "grant": oauth.get("grantType") == want["grantType"],
            "return_url": oauth.get("defaultReturnUrl") == want["defaultReturnUrl"],
            "headers": ours <= headers
            and all(h.startswith(_AGENTCORE_HEADER_PREFIX) for h in headers - ours),
        }
        return [name for name, same in checks.items() if not same]

    @classmethod
    def _matches(cls, target: dict[str, Any], desired: dict[str, Any]) -> bool:
        return not cls._differences(target, desired)

    def ensure_target(
        self, registration_id: str, generation: int, plan: TargetPlan, *, execution: str
    ) -> None:
        """Create the target, or converge it to the approved configuration."""
        settings = self._settings
        desired = self.desired(registration_id, generation, plan)
        name = remote_mcp.target_name(registration_id)
        description = f"Mango remote MCP {name}"
        target = self.find_target(registration_id)
        try:
            if target is None:
                self._ac.create_gateway_target(
                    gatewayIdentifier=settings.gateway_id,
                    name=name,
                    description=description,
                    clientToken=hashlib.sha256(f"{execution}|target".encode()).hexdigest(),
                    **desired,
                )
                return
            status = target["status"]
            if status in _TARGET_BUSY:
                return
            if status == "DELETING":
                raise RetryableError("target_deleting")
            if status in _TARGET_PENDING_AUTH:
                raise StepError("target_pending_auth")
            if status in _TARGET_FAILED or not self._matches(target, desired):
                self._ac.update_gateway_target(
                    gatewayIdentifier=settings.gateway_id,
                    targetId=target["targetId"],
                    name=name,
                    description=description,
                    **desired,
                )
        except (ClientError, BotoCoreError) as exc:
            if isinstance(exc, ClientError) and error_code(exc) == "ConflictException":
                raise RetryableError("target_conflict") from None
            raise aws_error("GatewayTarget", exc) from None

    def target_ready(self, registration_id: str, generation: int, plan: TargetPlan) -> bool:
        """Whether the target is ``READY`` with exactly the approved configuration."""
        target = self.find_target(registration_id)
        if target is None:
            raise StepError("target_not_found")
        status = target["status"]
        if status in _TARGET_FAILED or status in _TARGET_PENDING_AUTH:
            logger.warning(
                json.dumps(
                    {
                        "event": "remote_provisioner.target_failed",
                        "target": target["targetId"],
                        "status": status,
                        "reasons": [str(r)[:300] for r in target.get("statusReasons") or []][:5],
                    }
                )
            )
            raise StepError(
                "target_pending_auth" if status in _TARGET_PENDING_AUTH else "target_failed"
            )
        if status != "READY":
            return False
        differences = self._differences(target, self.desired(registration_id, generation, plan))
        if not differences:
            return True
        # Ready, but not what was approved: only the field names, never what the target holds.
        logger.warning(
            json.dumps(
                {
                    "event": "remote_provisioner.target_differs",
                    "target": target["targetId"],
                    "differences": differences,
                }
            )
        )
        return False

    def delete_target(self, registration_id: str) -> bool:
        """Request the deletion of the target. True once it no longer exists."""
        target = self.find_target(registration_id)
        if target is None:
            return True
        if target["status"] in _TARGET_PENDING_AUTH:
            raise StepError("target_pending_auth")
        if target["status"] != "DELETING":
            try:
                self._ac.delete_gateway_target(
                    gatewayIdentifier=self._settings.gateway_id, targetId=target["targetId"]
                )
            except ClientError as exc:
                code = error_code(exc)
                if code == _NOT_FOUND:
                    return True
                if code != "ConflictException":
                    raise aws_error("DeleteGatewayTarget", exc) from None
            except BotoCoreError as exc:
                raise aws_error("DeleteGatewayTarget", exc) from None
        return False

    # --- Cedar policies -------------------------------------------------------------------

    def _policies(self, registration_id: str) -> dict[str, dict[str, Any]]:
        prefix = remote_mcp.policy_prefix(self._settings.namespace, registration_id)
        pattern = re.compile(rf"^{re.escape(prefix)}[1-9][0-9]?$")
        found: dict[str, dict[str, Any]] = {}
        try:
            pages = self._ac.get_paginator("list_policies").paginate(
                policyEngineId=self._settings.policy_engine_id
            )
            for page in pages:
                for policy in page["policies"]:
                    if pattern.fullmatch(policy["name"]):
                        found[policy["name"]] = dict(policy)
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("ListPolicies", exc) from None
        return found

    def _desired_policies(self, registration_id: str, tools: Iterable[str]) -> dict[str, str]:
        statements = policy_statements(self._settings, registration_id, tools)
        return {
            remote_mcp.policy_name(self._settings.namespace, registration_id, index): statement
            for index, statement in enumerate(statements, start=1)
        }

    def ensure_policies(self, registration_id: str, tools: Iterable[str]) -> None:
        """Make the target's policies exactly the generated ones (create, replace, remove)."""
        engine = self._settings.policy_engine_id
        desired = self._desired_policies(registration_id, tools)
        existing = self._policies(registration_id)
        try:
            for name, policy in existing.items():
                status = policy["status"]
                statement = (policy.get("definition", {}).get("cedar") or {}).get("statement")
                if status in _POLICY_BUSY or status == "DELETING":
                    continue
                if name not in desired or status in _POLICY_FAILED:
                    self._ac.delete_policy(policyEngineId=engine, policyId=policy["policyId"])
                elif statement != desired[name]:
                    self._ac.update_policy(
                        policyEngineId=engine,
                        policyId=policy["policyId"],
                        definition={"cedar": {"statement": desired[name]}},
                        validationMode="FAIL_ON_ANY_FINDINGS",
                    )
            for name, statement in desired.items():
                if name in existing:
                    continue
                self._ac.create_policy(
                    policyEngineId=engine,
                    name=name,
                    description="Mango remote MCP: generated from its signed profile",
                    definition={"cedar": {"statement": statement}},
                    # Every action must be a tool the Gateway has for the target.
                    validationMode="FAIL_ON_ANY_FINDINGS",
                )
        except (ClientError, BotoCoreError) as exc:
            if isinstance(exc, ClientError) and error_code(exc) == "ConflictException":
                raise RetryableError("policy_conflict") from None
            raise aws_error("Policy", exc) from None

    def policies_ready(self, registration_id: str, tools: Iterable[str]) -> bool:
        desired = self._desired_policies(registration_id, tools)
        existing = self._policies(registration_id)
        if set(existing) != set(desired):
            return False
        for name, policy in existing.items():
            status = policy["status"]
            if status in _POLICY_FAILED:
                logger.warning(
                    json.dumps(
                        {
                            "event": "remote_provisioner.policy_failed",
                            "policy": policy["policyId"],
                            "status": status,
                        }
                    )
                )
                raise StepError("policy_failed")
            statement = (policy.get("definition", {}).get("cedar") or {}).get("statement")
            if status != "ACTIVE" or statement != desired[name]:
                return False
        return True

    def delete_policies(self, registration_id: str) -> bool:
        """Request the deletion of every policy of the target. True once none exists."""
        existing = self._policies(registration_id)
        for policy in existing.values():
            if policy["status"] in {"DELETING", *_POLICY_BUSY}:
                continue
            try:
                self._ac.delete_policy(
                    policyEngineId=self._settings.policy_engine_id, policyId=policy["policyId"]
                )
            except ClientError as exc:
                if error_code(exc) not in {_NOT_FOUND, "ConflictException"}:
                    raise aws_error("DeletePolicy", exc) from None
            except BotoCoreError as exc:
                raise aws_error("DeletePolicy", exc) from None
        return not existing
