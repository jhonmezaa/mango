"""Gateway side of an MCP pack: its ``mcpServer`` target and its Cedar policies (L2).

Every tool goes through the Gateway (rule 3). The target reaches the pack runtime with SigV4
of the Gateway role, never with the caller's token. Pack tools are denied by default; the
policies written here are generated from the signed manifest, with no free text: they permit
the pack's own tools on this installation's Gateway and nothing else (TM-M5).

The provisioner only ever touches the target named after the pack and the policies named
``Mango_<ns>_mcp_<pack>_<n>``: never a connector's.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections.abc import Iterable
from datetime import datetime
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_core.harness_tools import gateway_tool_name
from mango_provisioner.errors import RetryableError, StepError, aws_error, error_code
from mango_provisioner.packs.config import PackSettings

if TYPE_CHECKING:
    from mypy_boto3_bedrock_agentcore_control import BedrockAgentCoreControlClient

logger = logging.getLogger(__name__)

MAX_STATEMENT_CHARS = 9_000
"""Below AgentCore's limit for a Cedar statement (10 000 characters)."""
_NOT_FOUND = "ResourceNotFoundException"
_TARGET_BUSY = frozenset({"CREATING", "UPDATING", "SYNCHRONIZING"})
_TARGET_FAILED = frozenset({"FAILED", "UPDATE_UNSUCCESSFUL", "SYNCHRONIZE_UNSUCCESSFUL"})
_POLICY_BUSY = frozenset({"CREATING", "UPDATING"})
_POLICY_FAILED = frozenset({"CREATE_FAILED", "UPDATE_FAILED", "DELETE_FAILED"})
_TOOL_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
_IAM_CREDENTIALS = "GATEWAY_IAM_ROLE"
_SIGV4_SERVICE = "bedrock-agentcore"


CENTRAL_CLAIM = "mango_central"
"""Claim of the access token the pre-token trigger sets for users of a central group (D35,
D44); the Gateway exposes token claims to Cedar as tags of the principal."""
_IS_CENTRAL = (
    f'principal.hasTag("{CENTRAL_CLAIM}") && principal.getTag("{CENTRAL_CLAIM}") == "true"'
)


def policy_statements(
    settings: PackSettings, pack_id: str, tools: Iterable[str], *, central: bool = False
) -> list[str]:
    """Cedar statements for the read tools of a pack, generated from its signed manifest.

    A public pack has no audience restriction (spec §4.3): any signed-in user, on an
    invocation mango-api signed. A pack over account data that does not filter by area
    (``central``, D35, D37) is permitted only to users whose token says ``mango_central``,
    and the same limit is written a second time as a ``forbid ... unless``: Cedar evaluates
    ``forbid`` over any ``permit``, so no other policy of the engine can open these tools to
    anyone else, whatever tools an agent was given (TM-M3).

    Tools are split over several policies when they would not fit in one statement.
    """
    target = settings.target_name(pack_id)
    names = sorted(tools)
    if not names:
        raise StepError("no_tools")
    if not all(_TOOL_RE.fullmatch(name) for name in names):
        # Names end up inside a Cedar string: only what a manifest may declare.
        raise StepError("invalid_tool_name")
    actions = [f'AgentCore::Action::"{gateway_tool_name(target, name)}"' for name in names]
    resource = f'AgentCore::Gateway::"{settings.gateway_arn}"'
    statements: list[str] = []
    chunk: list[str] = []

    def head(effect: str) -> str:
        return (
            f"{effect} (\n"
            "  principal is AgentCore::OAuthUser,\n"
            f"  action in [{', '.join(chunk)}],\n"
            f"  resource == {resource}\n"
            ")"
        )

    def flush() -> None:
        if central:
            statements.append(f"{head('permit')} when {{ {_IS_CENTRAL} }};")
            statements.append(f"{head('forbid')} unless {{ {_IS_CENTRAL} }};")
        else:
            statements.append(f"{head('permit')};")

    for action in actions:
        if chunk and sum(len(a) + 2 for a in chunk) + len(action) > MAX_STATEMENT_CHARS - 300:
            flush()
            chunk = []
        chunk.append(action)
    flush()
    return statements


def _client_token(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


class PackGateway:
    def __init__(self, agentcore: BedrockAgentCoreControlClient, settings: PackSettings) -> None:
        self._ac = agentcore
        self._settings = settings

    # --- Target ---------------------------------------------------------------------------

    def find_target(self, pack_id: str) -> dict[str, Any] | None:
        """The pack's target, by its exact name, or ``None``.

        A target with that name that does not point at a runtime of this pack was not made
        by this provisioner (a connector the stack added, something made by hand): it is
        never updated or deleted, the step fails.
        """
        settings = self._settings
        name = settings.target_name(pack_id)
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
                        if not self._ours(target, pack_id):
                            raise StepError("foreign_target")
                        return target
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("ListGatewayTargets", exc) from None
        return None

    def _target_configuration(self, runtime_id: str) -> dict[str, Any]:
        return {
            "targetConfiguration": {
                "mcp": {"mcpServer": {"endpoint": self._settings.runtime_url(runtime_id)}}
            },
            # SigV4 with the Gateway role: the runtime never sees the caller's token.
            "credentialProviderConfigurations": [
                {
                    "credentialProviderType": _IAM_CREDENTIALS,
                    "credentialProvider": {
                        "iamCredentialProvider": {
                            "service": _SIGV4_SERVICE,
                            "region": self._settings.region,
                        }
                    },
                }
            ],
        }

    def _ours(self, target: dict[str, Any], pack_id: str) -> bool:
        """Whether a target is an MCP server target on some runtime of this pack."""
        mcp = (target.get("targetConfiguration") or {}).get("mcp") or {}
        endpoint = (mcp.get("mcpServer") or {}).get("endpoint")
        if not isinstance(endpoint, str):
            return False
        settings = self._settings
        prefix, _, rest = settings.runtime_url(settings.runtime_name(pack_id)).partition(
            settings.runtime_name(pack_id)
        )
        # `<prefix><runtime name>-<10 characters><rest>`
        middle = endpoint[len(prefix) : len(endpoint) - len(rest)]
        return bool(
            endpoint.startswith(prefix)
            and endpoint.endswith(rest)
            and settings.runtime_id_pattern(pack_id).fullmatch(middle)
        )

    def _matches(self, target: dict[str, Any], runtime_id: str) -> bool:
        """Whether a target points at the pack runtime's ``live`` endpoint with SigV4."""
        mcp = (target.get("targetConfiguration") or {}).get("mcp") or {}
        endpoint = (mcp.get("mcpServer") or {}).get("endpoint")
        credentials = target.get("credentialProviderConfigurations") or []
        provider = (credentials[0].get("credentialProvider") or {}) if credentials else {}
        return bool(
            endpoint == self._settings.runtime_url(runtime_id)
            and len(credentials) == 1
            and credentials[0].get("credentialProviderType") == _IAM_CREDENTIALS
            and (provider.get("iamCredentialProvider") or {}).get("service") == _SIGV4_SERVICE
        )

    def ensure_target(
        self, pack_id: str, runtime_id: str, live_since: datetime, *, execution: str
    ) -> None:
        """Create the target, or make the Gateway read the tools of what ``live`` serves now.

        The Gateway reads ``tools/list`` when the target is created or synchronized and keeps
        that catalog; a target last synchronized before ``live`` moved is synchronized again.
        """
        settings = self._settings
        desired = self._target_configuration(runtime_id)
        target = self.find_target(pack_id)
        try:
            if target is None:
                self._ac.create_gateway_target(
                    gatewayIdentifier=settings.gateway_id,
                    name=settings.target_name(pack_id),
                    description=f"Mango MCP pack {pack_id}",
                    clientToken=_client_token(execution, "target", runtime_id),
                    **desired,
                )
                return
            status = target["status"]
            if status in _TARGET_BUSY:
                return
            if status == "DELETING":
                raise RetryableError("target_deleting")
            if not self._matches(target, runtime_id):
                # Not what this provisioner creates: converge it (the update synchronizes).
                self._ac.update_gateway_target(
                    gatewayIdentifier=settings.gateway_id,
                    targetId=target["targetId"],
                    name=settings.target_name(pack_id),
                    description=f"Mango MCP pack {pack_id}",
                    **desired,
                )
                return
            synchronized = target.get("lastSynchronizedAt")
            if (
                status in _TARGET_FAILED
                or not isinstance(synchronized, datetime)
                or synchronized < live_since
            ):
                self._ac.synchronize_gateway_targets(
                    gatewayIdentifier=settings.gateway_id, targetIdList=[target["targetId"]]
                )
        except (ClientError, BotoCoreError) as exc:
            if isinstance(exc, ClientError) and error_code(exc) == "ConflictException":
                raise RetryableError("target_conflict") from None
            raise aws_error("GatewayTarget", exc) from None

    def target_ready(self, pack_id: str, runtime_id: str, live_since: datetime) -> str | None:
        """Id of the target once it is ready with the tools ``live`` serves, else ``None``."""
        target = self.find_target(pack_id)
        if target is None:
            raise StepError("target_not_found")
        status = target["status"]
        if status in _TARGET_FAILED:
            logger.warning(
                json.dumps(
                    {
                        "event": "pack_provisioner.target_failed",
                        "target": target["targetId"],
                        "status": status,
                        "reasons": [str(r)[:300] for r in target.get("statusReasons") or []][:5],
                    }
                )
            )
            raise StepError("target_failed")
        synchronized = target.get("lastSynchronizedAt")
        if (
            status != "READY"
            or not self._matches(target, runtime_id)
            or not isinstance(synchronized, datetime)
            or synchronized < live_since
        ):
            return None
        return str(target["targetId"])

    def delete_target(self, pack_id: str) -> bool:
        """Request the deletion of the pack's target. True once it no longer exists."""
        target = self.find_target(pack_id)
        if target is None:
            return True
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

    def _policies(self, pack_id: str) -> dict[str, dict[str, Any]]:
        """Policies of the pack by name. Only names this provisioner generates."""
        pattern = self._settings.policy_name_pattern(pack_id)
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

    def _desired(self, pack_id: str, tools: Iterable[str], central: bool) -> dict[str, str]:
        statements = policy_statements(self._settings, pack_id, tools, central=central)
        return {
            self._settings.policy_name(pack_id, index): statement
            for index, statement in enumerate(statements, start=1)
        }

    def ensure_policies(self, pack_id: str, tools: Iterable[str], *, central: bool = False) -> None:
        """Make the pack's policies exactly the generated ones (create, replace, remove).

        Policy names are unique in the engine, so a repeated creation conflicts instead of
        duplicating; no client token is sent because a failed policy is deleted and created
        again under the same name.
        """
        engine = self._settings.policy_engine_id
        desired = self._desired(pack_id, tools, central)
        existing = self._policies(pack_id)
        try:
            for name, policy in existing.items():
                status = policy["status"]
                statement = (policy.get("definition", {}).get("cedar") or {}).get("statement")
                if status in _POLICY_BUSY or status == "DELETING":
                    continue
                if name not in desired or status in _POLICY_FAILED:
                    # A failed policy is replaced: delete now, create on the next pass.
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
                    description=f"Mango MCP pack {pack_id}: generated from its signed manifest",
                    definition={"cedar": {"statement": statement}},
                    # The engine checks every action against the tools the Gateway cached
                    # for the target: a tool the pack does not serve fails the policy.
                    validationMode="FAIL_ON_ANY_FINDINGS",
                )
        except (ClientError, BotoCoreError) as exc:
            if isinstance(exc, ClientError) and error_code(exc) == "ConflictException":
                raise RetryableError("policy_conflict") from None
            raise aws_error("Policy", exc) from None

    def policies_ready(self, pack_id: str, tools: Iterable[str], *, central: bool = False) -> bool:
        """Whether the pack's policies are exactly the generated ones, and active."""
        desired = self._desired(pack_id, tools, central)
        existing = self._policies(pack_id)
        if set(existing) != set(desired):
            return False
        for name, policy in existing.items():
            status = policy["status"]
            if status in _POLICY_FAILED:
                logger.warning(
                    json.dumps(
                        {
                            "event": "pack_provisioner.policy_failed",
                            "policy": policy["policyId"],
                            "status": status,
                            # The engine's findings quote the generated statement only.
                            "reasons": [str(r)[:300] for r in policy.get("statusReasons") or []][
                                :3
                            ],
                        }
                    )
                )
                raise StepError("policy_failed")
            statement = (policy.get("definition", {}).get("cedar") or {}).get("statement")
            if status != "ACTIVE" or statement != desired[name]:
                return False
        return True

    def delete_policies(self, pack_id: str) -> bool:
        """Request the deletion of every policy of the pack. True once none exists."""
        existing = self._policies(pack_id)
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
