"""AgentCore harness of an agent (D32): one per agent, a version per published definition.

``UpdateHarness`` creates an immutable harness version and only changes the fields it is
given, so every call sends the complete configuration. mango-api invokes the ``live``
endpoint, which is moved to the new version only when that version is ``READY``.

The stored configuration is the approved definition: mango-api still builds each invocation
from the published version (D33), and the reconciliation compares both.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_core.agents import AgentDefinition
from mango_core.harness_tools import GATEWAY_MCP_SERVER, allowed_tool
from mango_packs.enablement import is_pack_id
from mango_provisioner.config import ENDPOINT_LIVE, Settings
from mango_provisioner.errors import RetryableError, StepError, aws_error, error_code

if TYPE_CHECKING:
    from mypy_boto3_bedrock_agentcore_control import BedrockAgentCoreControlClient

logger = logging.getLogger(__name__)

# D16: keep prompts, replies and tool payloads out of the runtime's OTEL logs and spans.
REDACT_GENAI_CONTENT = {
    "OTEL_SEMCONV_STABILITY_OPT_IN": "gen_ai_unredacted_attributes=",
    "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT": "false",
    "OTEL_PYTHON_DISABLED_INSTRUMENTATIONS": "urllib3,aws_mcp",
}
ENV_AGENT_ID = "MANGO_AGENT_ID"
ENV_AGENT_VERSION = "MANGO_AGENT_VERSION"
ENV_CONTENT_HASH = "MANGO_CONTENT_HASH"
ENV_CONFIG_HASH = "MANGO_CONFIG_SHA256"

_NOT_FOUND = "ResourceNotFoundException"
_IN_PROGRESS = frozenset({"CREATING", "UPDATING"})
_FAILED = frozenset({"CREATE_FAILED", "UPDATE_FAILED", "DELETE_FAILED"})
READY = "READY"


@dataclass(frozen=True)
class HarnessRef:
    harness_id: str
    version: str
    created: bool = False


@dataclass(frozen=True)
class HarnessStatus:
    ready: bool
    runtime_id: str | None


PackTools = Callable[[str], frozenset[str] | None]
"""Tools an installed MCP pack serves, by pack id; ``None`` if the pack is not installed."""


def no_packs(_pack_id: str) -> frozenset[str] | None:
    return None


def allowed_tools(
    settings: Settings, definition: AgentDefinition, pack_tools: PackTools = no_packs
) -> list[str]:
    """Allow-list of the definition's tools, checked against what the installation serves.

    A tool is either one of a connector of the release, or one of an MCP pack that is
    installed now (the pointer only the pack provisioner writes). The Gateway target of a
    pack is its id; the pack provisioner only installs packs whose tools are all read-only.

    Write tools need an approval on every call (D27). The Gateway interceptor enforces it for
    the write tools of Mango connectors, so an agent may have those, and only if the version
    marks them in ``approval_tools`` (what its reviewers saw). Anything else that asks for an
    approval (a read tool, a tool of a pack) is not enforced by anything yet: such an agent
    is not published.
    """
    approval = set(definition.approval_tools)
    targets = {connector.target for connector in settings.connectors.values()}
    out: list[str] = []
    for ref in definition.tools:
        server_id, _, tool = ref.partition(".")
        connector = settings.connectors.get(server_id)
        if connector is not None:
            if tool not in connector.tools:
                raise StepError("unknown_tool")
            if (connector.tools[tool] != "read") != (ref in approval):
                # A write tool nobody marked for approval, or a read tool marked for one.
                raise StepError("write_tools_unsupported")
            approval.discard(ref)
            out.append(allowed_tool(connector.target, tool))
            continue
        # A pack never takes the target of a connector (the pack provisioner refuses it too).
        if not is_pack_id(server_id) or server_id in targets:
            raise StepError("unknown_tool")
        served = pack_tools(server_id)
        if served is None or tool not in served:
            raise StepError("unknown_tool")
        out.append(allowed_tool(server_id, tool))
    if approval:
        # Approval asked for a tool of a pack, or for one the version does not have.
        raise StepError("write_tools_unsupported")
    return sorted(out)


def harness_config(
    settings: Settings,
    *,
    agent_id: str,
    version: int,
    content_hash: str,
    definition: AgentDefinition,
    pack_tools: PackTools = no_packs,
) -> dict[str, Any]:
    """Complete harness configuration of one agent version (create and update)."""
    if definition.model is None or definition.model not in definition.allowed_models:
        raise StepError("invalid_model")
    if not definition.system_prompt.strip():
        raise StepError("empty_prompt")
    tools = allowed_tools(settings, definition, pack_tools)
    limits = definition.limits
    model: dict[str, Any] = {"modelId": definition.model}
    # Every model call carries an output cap (D74): without it one call can outrun the turn's
    # budget reservation.
    model["maxTokens"] = limits.call_max_tokens
    if limits.temperature is not None:
        model["temperature"] = limits.temperature
    model["additionalParams"] = {
        "guardrailConfig": {
            "guardrailIdentifier": settings.guardrail_id,
            "guardrailVersion": settings.guardrail_version,
            "trace": "disabled",
        }
    }
    config: dict[str, Any] = {
        "executionRoleArn": settings.role_arn(agent_id),
        "model": {"bedrockModelConfig": model},
        "systemPrompt": [{"text": definition.system_prompt}],
        # The caller's token is added per invocation by mango-api (D13); an empty allow-list
        # also disables the harness built-in shell and file tools.
        "tools": [
            {
                "type": "remote_mcp",
                "name": GATEWAY_MCP_SERVER,
                "config": {"remoteMcp": {"url": settings.gateway_url}},
            }
        ]
        if tools
        else [],
        "allowedTools": tools,
        "memory": {"disabled": {}},
        "maxIterations": limits.max_iterations,
        "maxTokens": limits.max_tokens,
        "timeoutSeconds": limits.timeout_seconds,
        "environment": {
            "agentCoreRuntimeEnvironment": {
                "lifecycleConfiguration": {
                    "idleRuntimeSessionTimeout": settings.session_idle_seconds,
                    "maxLifetime": settings.session_max_seconds,
                }
            }
        },
    }
    environment = {
        **REDACT_GENAI_CONTENT,
        ENV_AGENT_ID: agent_id,
        ENV_AGENT_VERSION: str(version),
        ENV_CONTENT_HASH: content_hash,
    }
    # Fingerprint of everything above: an identical retry reuses the harness version.
    fingerprint = hashlib.sha256(
        json.dumps([config, environment], sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    config["environmentVariables"] = {**environment, ENV_CONFIG_HASH: fingerprint}
    return config


def _client_token(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


class Harnesses:
    def __init__(self, agentcore: BedrockAgentCoreControlClient, settings: Settings) -> None:
        self._ac = agentcore
        self._settings = settings

    # --- Lookup ---------------------------------------------------------------------------

    def find(self, agent_id: str, known_arn: str | None = None) -> dict[str, Any] | None:
        """Latest version of the agent's harness, or ``None``. Only ever by its exact name."""
        pattern = self._settings.harness_id_pattern(agent_id)
        if known_arn:
            harness_id = known_arn.rsplit("/", 1)[-1]
            if known_arn != self._settings.harness_arn(harness_id) or not pattern.fullmatch(
                harness_id
            ):
                raise StepError("harness_reference_invalid")
            found = self._get(harness_id)
            if found is not None:
                return found
        name = self._settings.harness_name(agent_id)
        try:
            for page in self._ac.get_paginator("list_harnesses").paginate():
                for summary in page["harnesses"]:
                    if summary["harnessName"] == name and pattern.fullmatch(summary["harnessId"]):
                        return self._get(summary["harnessId"])
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("ListHarnesses", exc) from None
        return None

    def _get(self, harness_id: str, version: str | None = None) -> dict[str, Any] | None:
        try:
            if version is None:
                return dict(self._ac.get_harness(harnessId=harness_id)["harness"])
            return dict(
                self._ac.get_harness(harnessId=harness_id, harnessVersion=version)["harness"]
            )
        except ClientError as exc:
            if error_code(exc) == _NOT_FOUND:
                return None
            raise aws_error("GetHarness", exc) from None
        except BotoCoreError as exc:
            raise aws_error("GetHarness", exc) from None

    # --- Create or update -----------------------------------------------------------------

    def ensure(
        self,
        agent_id: str,
        config: dict[str, Any],
        *,
        execution: str,
        known_arn: str | None,
        published: bool,
    ) -> HarnessRef:
        """Create the harness, or add a version to it, with exactly ``config``."""
        current = self.find(agent_id, known_arn)
        if current is None:
            return self._create(agent_id, config, execution)
        status = current["status"]
        harness_id = str(current["harnessId"])
        if status == "DELETING":
            raise RetryableError("harness_deleting")
        fingerprint = config["environmentVariables"][ENV_CONFIG_HASH]
        same = (current.get("environmentVariables") or {}).get(ENV_CONFIG_HASH) == fingerprint
        if same and status not in _FAILED:
            # A retry of this step, or of a failed execution with the same content.
            return HarnessRef(harness_id, str(current["harnessVersion"]))
        if status in _IN_PROGRESS:
            raise RetryableError("harness_busy")
        if status in _FAILED and not published:
            # Left over from a failed first publication: start again from a clean harness.
            self.delete(harness_id)
            raise RetryableError("harness_deleting")
        # UpdateHarness wraps the fields that can also be cleared.
        update = {**config, "memory": {"optionalValue": config["memory"]}}
        try:
            updated = self._ac.update_harness(
                harnessId=harness_id,
                clientToken=_client_token(execution, "update", fingerprint),
                **update,
            )["harness"]
        except (ClientError, BotoCoreError) as exc:
            raise self._write_error("UpdateHarness", exc) from None
        return HarnessRef(harness_id, str(updated["harnessVersion"]))

    def _create(self, agent_id: str, config: dict[str, Any], execution: str) -> HarnessRef:
        try:
            created = self._ac.create_harness(
                harnessName=self._settings.harness_name(agent_id),
                clientToken=_client_token(execution, "create"),
                tags=self._settings.tags(agent_id),
                **config,
            )["harness"]
        except (ClientError, BotoCoreError) as exc:
            raise self._write_error("CreateHarness", exc) from None
        harness_id = str(created["harnessId"])
        if not self._settings.harness_id_pattern(agent_id).fullmatch(harness_id):
            raise StepError("harness_reference_invalid")
        return HarnessRef(harness_id, str(created.get("harnessVersion") or "1"), created=True)

    @staticmethod
    def _write_error(operation: str, exc: ClientError | BotoCoreError) -> StepError:
        if isinstance(exc, ClientError):
            code = error_code(exc)
            message = str(exc.response.get("Error", {}).get("Message", ""))
            # A role created seconds ago may not be assumable yet (IAM is eventually
            # consistent); a harness with this name may still be deleting or updating.
            if code == "ValidationException" and "Role validation failed" in message:
                return RetryableError("role_not_ready")
            if code == "ConflictException":
                return RetryableError("harness_conflict")
        return aws_error(operation, exc)

    # --- Status ---------------------------------------------------------------------------

    def status(self, agent_id: str, ref: HarnessRef) -> HarnessStatus:
        harness = self._get(ref.harness_id, ref.version)
        if harness is None:
            raise StepError("harness_not_found")
        status = harness["status"]
        if status in _FAILED:
            # AgentCore's own reason (a service message, no agent content) helps the operator;
            # the version only records the code.
            logger.warning(
                json.dumps(
                    {
                        "event": "provisioner.harness_failed",
                        "harness": ref.harness_id,
                        "status": status,
                        "reason": str(harness.get("failureReason") or "")[:500],
                    }
                )
            )
            raise StepError("harness_failed")
        if status != READY:
            return HarnessStatus(ready=False, runtime_id=None)
        return HarnessStatus(ready=True, runtime_id=self.runtime_id(agent_id, harness))

    def runtime_id(self, agent_id: str, harness: dict[str, Any]) -> str:
        runtime = (harness.get("environment") or {}).get("agentCoreRuntimeEnvironment") or {}
        runtime_id = str(runtime.get("agentRuntimeId") or "")
        if not self._settings.runtime_id_pattern(agent_id).fullmatch(runtime_id):
            raise StepError("runtime_reference_invalid")
        return runtime_id

    # --- `live` endpoint ------------------------------------------------------------------

    def _endpoint(self, harness_id: str) -> dict[str, Any] | None:
        try:
            return dict(
                self._ac.get_harness_endpoint(harnessId=harness_id, endpointName=ENDPOINT_LIVE)[
                    "endpoint"
                ]
            )
        except ClientError as exc:
            if error_code(exc) == _NOT_FOUND:
                return None
            raise aws_error("GetHarnessEndpoint", exc) from None
        except BotoCoreError as exc:
            raise aws_error("GetHarnessEndpoint", exc) from None

    def point_live(self, agent_id: str, harness_id: str, version: str, *, execution: str) -> bool:
        """Make ``live`` serve ``version``. Returns whether anything had to change."""
        endpoint = self._endpoint(harness_id)
        token = _client_token(execution, "endpoint", harness_id, version)
        try:
            if endpoint is None:
                self._ac.create_harness_endpoint(
                    harnessId=harness_id,
                    endpointName=ENDPOINT_LIVE,
                    targetVersion=version,
                    description="Published version served to mango-api",
                    clientToken=token,
                    tags=self._settings.tags(agent_id),
                )
                return True
            status = endpoint["status"]
            if status in _IN_PROGRESS:
                if endpoint.get("targetVersion") == version:
                    return False
                raise RetryableError("endpoint_busy")
            if status == READY and endpoint.get("liveVersion") == version:
                return False
            self._ac.update_harness_endpoint(
                harnessId=harness_id,
                endpointName=ENDPOINT_LIVE,
                targetVersion=version,
                clientToken=token,
            )
        except (ClientError, BotoCoreError) as exc:
            if isinstance(exc, ClientError) and error_code(exc) == "ConflictException":
                raise RetryableError("endpoint_conflict") from None
            raise aws_error("HarnessEndpoint", exc) from None
        return True

    def live_ready(self, harness_id: str, version: str) -> bool:
        endpoint = self._endpoint(harness_id)
        if endpoint is None:
            raise StepError("endpoint_not_found")
        status = endpoint["status"]
        if status in _FAILED:
            raise StepError("endpoint_failed")
        return bool(status == READY and endpoint.get("liveVersion") == version)

    # --- Removal (agents that were never published) ---------------------------------------

    def delete(self, harness_id: str) -> None:
        """Request the deletion of the harness; AgentCore removes its runtime.

        Deletions are asynchronous and the harness cannot go while it has endpoints, so this
        raises ``RetryableError`` until the ``live`` endpoint is gone and the deletion of the
        harness has been accepted. Callers check with ``find`` that it finished.
        """
        endpoint = self._endpoint(harness_id)
        if endpoint is not None:
            if endpoint["status"] != "DELETING":
                try:
                    self._ac.delete_harness_endpoint(
                        harnessId=harness_id, endpointName=ENDPOINT_LIVE
                    )
                except ClientError as exc:
                    if error_code(exc) not in {_NOT_FOUND, "ConflictException"}:
                        raise aws_error("DeleteHarnessEndpoint", exc) from None
                except BotoCoreError as exc:
                    raise aws_error("DeleteHarnessEndpoint", exc) from None
            raise RetryableError("endpoint_deleting")
        try:
            self._ac.delete_harness(harnessId=harness_id)
        except ClientError as exc:
            code = error_code(exc)
            if code == "ConflictException":
                raise RetryableError("harness_delete_conflict") from None
            if code != _NOT_FOUND:
                raise aws_error("DeleteHarness", exc) from None
        except BotoCoreError as exc:
            raise aws_error("DeleteHarness", exc) from None
