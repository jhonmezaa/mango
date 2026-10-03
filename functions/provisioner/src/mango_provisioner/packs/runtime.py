"""AgentCore Runtime of an MCP pack (D36): the signed zip, deployed as code, speaking MCP.

One runtime per pack. ``UpdateAgentRuntime`` creates an immutable runtime version; the
Gateway target invokes the ``live`` endpoint, which is moved to a new version only after that
version answered ``tools/list`` with exactly the tools the signed manifest pins.

The runtime has no JWT authorizer, so it only accepts SigV4 requests from principals with
``InvokeAgentRuntime`` on it: the Gateway role and, to compare ``tools/list``, this provisioner.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_provisioner.errors import RetryableError, StepError, aws_error, error_code
from mango_provisioner.harness import REDACT_GENAI_CONTENT
from mango_provisioner.packs.config import ENDPOINT_DEFAULT, ENDPOINT_LIVE, PackSettings
from mango_provisioner.packs.release import VerifiedPack

if TYPE_CHECKING:
    from mypy_boto3_bedrock_agentcore import BedrockAgentCoreClient
    from mypy_boto3_bedrock_agentcore_control import BedrockAgentCoreControlClient

logger = logging.getLogger(__name__)

ENV_PACK_ID = "MANGO_PACK_ID"
ENV_PACK_VERSION = "MANGO_PACK_VERSION"
ENV_STATEMENT_HASH = "MANGO_PACK_STATEMENT_SHA256"
ENV_CONFIG_PREFIX = "MANGO_PACK_CONFIG_"
ENV_CONFIG_HASH = "MANGO_PACK_CONFIG_SHA256"
# Read by `mango_pack_runtime.config` inside a pack over account data (D37). No secrets.
ENV_BROKER_ROLE = "MANGO_PACK_BROKER_ROLE_ARN"
ENV_TARGET_ROLE = "MANGO_PACK_TARGET_ROLE_ARN"
ENV_TARGET_ROLE_NAME = "MANGO_PACK_TARGET_ROLE_NAME"
ENV_IDENTITY_KEY = "MANGO_PACK_IDENTITY_PUBLIC_KEY"
ENV_REGION = "MANGO_PACK_REGION"

IDLE_SESSION_SECONDS = 60
"""A pack's microVM stops (and stops billing) this long after its last request (D47).

AgentCore's minimum. Its default (900 s) kept every microVM, and its memory, billed for 15
minutes after one tool call. A call that arrives later starts a new microVM, as before.
"""
MAX_SESSION_SECONDS = 28_800
"""Longest life of one microVM, however busy. AgentCore's default, stated on purpose."""

MAX_TOOLS_RESPONSE_BYTES = 4 * 1024 * 1024
_MCP_PROTOCOL_VERSION = "2025-06-18"
_NOT_FOUND = "ResourceNotFoundException"
_IN_PROGRESS = frozenset({"CREATING", "UPDATING"})
_FAILED = frozenset({"CREATE_FAILED", "UPDATE_FAILED", "DELETE_FAILED"})
READY = "READY"


@dataclass(frozen=True)
class RuntimeRef:
    runtime_id: str
    version: str


def runtime_environment(
    pack: VerifiedPack,
    config: Mapping[str, str],
    *,
    settings: PackSettings | None = None,
    identity_public_key: str | None = None,
) -> dict[str, str]:
    """Environment of a pack runtime: a closed list, nothing else ever reaches it (TM-P11).

    ``config`` is the output of ``resolve_config``: keys of the signed manifest with a value
    of their enum. They are passed as ``MANGO_PACK_CONFIG_<KEY>``, never under a name the AWS
    SDK or the HTTP stack would read (endpoints, profiles, proxies), and never secrets.

    A pack over account data also learns where the installation's broker is and the public
    key that verifies its callers: values of the stack, never of the request or the pack. A
    pack of the member chain gets the Read broker and the *name* of the role behind it, never
    an ARN: the account is the one each call asks for (D51).
    """
    manifest = pack.manifest
    declared = {param.key: param for param in manifest.config}
    environment = {
        **REDACT_GENAI_CONTENT,  # D16
        ENV_PACK_ID: manifest.id,
        ENV_PACK_VERSION: manifest.version,
        ENV_STATEMENT_HASH: pack.statement_sha256,
    }
    for key, value in sorted(config.items()):
        if key not in declared or value not in declared[key].allowed:
            raise StepError("invalid_config")
        environment[f"{ENV_CONFIG_PREFIX}{key.upper()}"] = value
    if manifest.central_only:
        if settings is None or not identity_public_key:
            raise StepError("identity_unavailable")
        if manifest.member_chain:
            if settings.member_broker_role_arn is None or settings.member_role_name is None:
                raise StepError("identity_unavailable")
            environment[ENV_BROKER_ROLE] = settings.member_broker_role_arn
            environment[ENV_TARGET_ROLE_NAME] = settings.member_role_name
        else:
            if settings.broker_role_arn is None or settings.target_role_arn is None:
                raise StepError("identity_unavailable")
            environment[ENV_BROKER_ROLE] = settings.broker_role_arn
            environment[ENV_TARGET_ROLE] = settings.target_role_arn
        environment[ENV_IDENTITY_KEY] = identity_public_key
        environment[ENV_REGION] = settings.region
    return environment


def runtime_config(
    settings: PackSettings,
    pack: VerifiedPack,
    *,
    artifact_key: str,
    artifact_version_id: str,
    config: Mapping[str, str],
    identity_public_key: str | None = None,
) -> dict[str, Any]:
    """Complete runtime configuration of one pack version (create and update)."""
    manifest = pack.manifest
    try:
        network = settings.network.configuration(manifest.id)
    except KeyError:
        raise StepError("egress_unavailable") from None
    request: dict[str, Any] = {
        "agentRuntimeArtifact": {
            "codeConfiguration": {
                # The very object version whose digest was checked against the signature.
                "code": {
                    "s3": {
                        "bucket": settings.packs_bucket,
                        "prefix": artifact_key,
                        "versionId": artifact_version_id,
                    }
                },
                "runtime": manifest.runtime.python,
                "entryPoint": [manifest.runtime.entrypoint],
            }
        },
        "roleArn": settings.role_arn(manifest.id),
        # R6: the pack VPC has no internet gateway and no NAT. The pack's security group only
        # reaches the VPC endpoints of the AWS APIs its signed manifest declares.
        "networkConfiguration": network,
        "protocolConfiguration": {"serverProtocol": manifest.runtime.protocol},
        "lifecycleConfiguration": {
            "idleRuntimeSessionTimeout": IDLE_SESSION_SECONDS,
            "maxLifetime": MAX_SESSION_SECONDS,
        },
        "description": f"Mango MCP pack {manifest.id} {manifest.version}",
    }
    environment = runtime_environment(
        pack, config, settings=settings, identity_public_key=identity_public_key
    )
    # Fingerprint of everything above: an identical retry reuses the runtime version.
    fingerprint = hashlib.sha256(
        json.dumps([request, environment], sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    request["environmentVariables"] = {**environment, ENV_CONFIG_HASH: fingerprint}
    return request


def _client_token(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


def decode_tools(raw: bytes, content_type: str) -> list[Any]:
    """The ``tools`` array of a ``tools/list`` answer. The answer is third-party output."""
    if len(raw) > MAX_TOOLS_RESPONSE_BYTES:
        raise StepError("tools_response_too_large")
    try:
        text = raw.decode("utf-8")
        if content_type.startswith("text/event-stream"):
            data = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
            text = data[-1] if data else ""
        message = json.loads(text)
    except ValueError:
        raise StepError("tools_response_invalid") from None
    result = message.get("result") if isinstance(message, dict) else None
    if not isinstance(result, dict):
        raise StepError("tools_response_invalid")
    tools = result.get("tools")
    # A paginated listing would hide tools from the comparison.
    if not isinstance(tools, list) or result.get("nextCursor"):
        raise StepError("tools_response_invalid")
    return tools


class PackRuntimes:
    def __init__(
        self,
        control: BedrockAgentCoreControlClient,
        data: BedrockAgentCoreClient,
        settings: PackSettings,
    ) -> None:
        self._ac = control
        self._data = data
        self._settings = settings

    # --- Lookup ---------------------------------------------------------------------------

    def find(self, pack_id: str, known_id: str | None = None) -> dict[str, Any] | None:
        """Latest version of the pack's runtime, or ``None``. Only ever by its exact name."""
        pattern = self._settings.runtime_id_pattern(pack_id)
        if known_id:
            if not pattern.fullmatch(known_id):
                raise StepError("runtime_reference_invalid")
            found = self._get(known_id)
            if found is not None:
                return found
        name = self._settings.runtime_name(pack_id)
        try:
            for page in self._ac.get_paginator("list_agent_runtimes").paginate():
                for summary in page["agentRuntimes"]:
                    runtime_id = summary["agentRuntimeId"]
                    if summary["agentRuntimeName"] == name and pattern.fullmatch(runtime_id):
                        return self._get(runtime_id)
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("ListAgentRuntimes", exc) from None
        return None

    def _get(self, runtime_id: str, version: str | None = None) -> dict[str, Any] | None:
        try:
            if version is None:
                return dict(self._ac.get_agent_runtime(agentRuntimeId=runtime_id))
            return dict(
                self._ac.get_agent_runtime(agentRuntimeId=runtime_id, agentRuntimeVersion=version)
            )
        except ClientError as exc:
            if error_code(exc) == _NOT_FOUND:
                return None
            raise aws_error("GetAgentRuntime", exc) from None
        except BotoCoreError as exc:
            raise aws_error("GetAgentRuntime", exc) from None

    # --- Create or update -----------------------------------------------------------------

    def ensure(
        self,
        pack_id: str,
        config: dict[str, Any],
        *,
        execution: str,
        known_id: str | None,
        installed: bool,
    ) -> RuntimeRef:
        """Create the runtime, or add a version to it, with exactly ``config``."""
        current = self.find(pack_id, known_id)
        if current is None:
            return self._create(pack_id, config, execution)
        status = current["status"]
        runtime_id = str(current["agentRuntimeId"])
        if status == "DELETING":
            raise RetryableError("runtime_deleting")
        if current.get("authorizerConfiguration"):
            # Pack runtimes only accept SigV4. One with a token authorizer was not made by
            # this provisioner, and an update would keep that authorizer: never adopt it.
            raise StepError("runtime_not_ours")
        fingerprint = config["environmentVariables"][ENV_CONFIG_HASH]
        same = (current.get("environmentVariables") or {}).get(ENV_CONFIG_HASH) == fingerprint
        if same and status not in _FAILED:
            # A retry of this step, or of a failed execution with the same content.
            return RuntimeRef(runtime_id, str(current["agentRuntimeVersion"]))
        if status in _IN_PROGRESS:
            raise RetryableError("runtime_busy")
        if status in _FAILED and not installed:
            # Left over from a failed first installation: start again from a clean runtime.
            self.delete(runtime_id)
            raise RetryableError("runtime_deleting")
        try:
            updated = self._ac.update_agent_runtime(
                agentRuntimeId=runtime_id,
                clientToken=_client_token(execution, "update", fingerprint),
                **config,
            )
        except (ClientError, BotoCoreError) as exc:
            raise self._write_error("UpdateAgentRuntime", exc) from None
        return RuntimeRef(runtime_id, str(updated["agentRuntimeVersion"]))

    def _create(self, pack_id: str, config: dict[str, Any], execution: str) -> RuntimeRef:
        try:
            created = self._ac.create_agent_runtime(
                agentRuntimeName=self._settings.runtime_name(pack_id),
                clientToken=_client_token(execution, "create"),
                tags=self._settings.tags(pack_id),
                **config,
            )
        except (ClientError, BotoCoreError) as exc:
            raise self._write_error("CreateAgentRuntime", exc) from None
        runtime_id = str(created["agentRuntimeId"])
        if not self._settings.runtime_id_pattern(pack_id).fullmatch(runtime_id):
            raise StepError("runtime_reference_invalid")
        return RuntimeRef(runtime_id, str(created.get("agentRuntimeVersion") or "1"))

    @staticmethod
    def _write_error(operation: str, exc: ClientError | BotoCoreError) -> StepError:
        if isinstance(exc, ClientError):
            code = error_code(exc)
            message = str(exc.response.get("Error", {}).get("Message", ""))
            # A role created seconds ago may not be assumable yet (IAM is eventually
            # consistent); a runtime with this name may still be deleting or updating.
            if code == "ValidationException" and "Role validation failed" in message:
                return RetryableError("role_not_ready")
            if code == "ConflictException":
                return RetryableError("runtime_conflict")
        return aws_error(operation, exc)

    # --- Status ---------------------------------------------------------------------------

    def ready(self, pack_id: str, ref: RuntimeRef) -> bool:
        runtime = self._get(ref.runtime_id, ref.version)
        if runtime is None:
            raise StepError("runtime_not_found")
        if not self._on_pack_network(pack_id, runtime):
            # Nothing is exposed from a version that runs anywhere else (R6): a version on
            # the `PUBLIC` network, or with another security group, could reach the internet.
            raise StepError("runtime_network_mismatch")
        status = runtime["status"]
        if status in _FAILED:
            # AgentCore's own reason (a service message, no pack content) helps the operator;
            # the enablement only records the code.
            logger.warning(
                json.dumps(
                    {
                        "event": "pack_provisioner.runtime_failed",
                        "runtime": ref.runtime_id,
                        "status": status,
                        "reason": str(runtime.get("failureReason") or "")[:500],
                    }
                )
            )
            raise StepError("runtime_failed")
        return bool(status == READY)

    def _on_pack_network(self, pack_id: str, runtime: Mapping[str, Any]) -> bool:
        """Whether the runtime version has exactly the network the stack gives the pack."""
        try:
            expected = self._settings.network.configuration(pack_id)
        except KeyError:
            return False
        actual = runtime.get("networkConfiguration")
        if not isinstance(actual, dict) or actual.get("networkMode") != expected["networkMode"]:
            return False
        mode, wanted = actual.get("networkModeConfig"), expected["networkModeConfig"]
        if not isinstance(mode, dict) or not isinstance(wanted, dict):
            return False
        return sorted(mode.get("subnets") or []) == sorted(wanted["subnets"]) and sorted(
            mode.get("securityGroups") or []
        ) == sorted(wanted["securityGroups"])

    # --- tools/list -----------------------------------------------------------------------

    def tools(self, ref: RuntimeRef) -> list[Any]:
        """``tools/list`` of exactly ``ref.version``, before anything else can reach it.

        ``DEFAULT`` always serves the latest runtime version; ``live`` still serves the
        installed one, so the new version is checked before it is exposed.
        """
        endpoint = self._endpoint(ref.runtime_id, ENDPOINT_DEFAULT)
        if (
            endpoint is None
            or endpoint["status"] != READY
            or endpoint.get("liveVersion") != ref.version
        ):
            raise RetryableError("default_endpoint_not_ready")
        request = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
        try:
            response = self._data.invoke_agent_runtime(
                agentRuntimeArn=self._settings.runtime_arn(ref.runtime_id),
                qualifier=ENDPOINT_DEFAULT,
                contentType="application/json",
                accept="application/json, text/event-stream",
                mcpProtocolVersion=_MCP_PROTOCOL_VERSION,
                payload=json.dumps(request).encode(),
            )
            raw = response["response"].read(MAX_TOOLS_RESPONSE_BYTES + 1)
        except ClientError as exc:
            # The server answers once its microVM has started; AgentCore reports a server
            # that is not up yet as a runtime client error.
            if error_code(exc) in {"RuntimeClientError", "ServiceQuotaExceededException"}:
                raise RetryableError("tools_list_not_ready") from None
            raise aws_error("ToolsList", exc) from None
        except BotoCoreError as exc:
            raise aws_error("ToolsList", exc) from None
        return decode_tools(raw, str(response.get("contentType") or ""))

    # --- `live` endpoint ------------------------------------------------------------------

    def _endpoint(self, runtime_id: str, name: str = ENDPOINT_LIVE) -> dict[str, Any] | None:
        try:
            return dict(
                self._ac.get_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName=name)
            )
        except ClientError as exc:
            if error_code(exc) == _NOT_FOUND:
                return None
            raise aws_error("GetAgentRuntimeEndpoint", exc) from None
        except BotoCoreError as exc:
            raise aws_error("GetAgentRuntimeEndpoint", exc) from None

    def point_live(self, pack_id: str, ref: RuntimeRef, *, execution: str) -> bool:
        """Make ``live`` serve ``ref.version``. Returns whether anything had to change."""
        endpoint = self._endpoint(ref.runtime_id)
        token = _client_token(execution, "endpoint", ref.runtime_id, ref.version)
        try:
            if endpoint is None:
                self._ac.create_agent_runtime_endpoint(
                    agentRuntimeId=ref.runtime_id,
                    name=ENDPOINT_LIVE,
                    agentRuntimeVersion=ref.version,
                    description="Verified pack version served to the Gateway",
                    clientToken=token,
                    tags=self._settings.tags(pack_id),
                )
                return True
            status = endpoint["status"]
            if status in _IN_PROGRESS:
                if endpoint.get("targetVersion") == ref.version:
                    return False
                raise RetryableError("endpoint_busy")
            if status == READY and endpoint.get("liveVersion") == ref.version:
                return False
            self._ac.update_agent_runtime_endpoint(
                agentRuntimeId=ref.runtime_id,
                endpointName=ENDPOINT_LIVE,
                agentRuntimeVersion=ref.version,
                clientToken=token,
            )
        except (ClientError, BotoCoreError) as exc:
            if isinstance(exc, ClientError) and error_code(exc) == "ConflictException":
                raise RetryableError("endpoint_conflict") from None
            raise aws_error("RuntimeEndpoint", exc) from None
        return True

    def live(self, ref: RuntimeRef) -> datetime | None:
        """When ``live`` started serving ``ref.version``, or ``None`` while it does not yet."""
        endpoint = self._endpoint(ref.runtime_id)
        if endpoint is None:
            raise StepError("endpoint_not_found")
        status = endpoint["status"]
        if status in _FAILED:
            raise StepError("endpoint_failed")
        if status != READY or endpoint.get("liveVersion") != ref.version:
            return None
        updated = endpoint.get("lastUpdatedAt") or endpoint.get("createdAt")
        if not isinstance(updated, datetime):
            raise StepError("endpoint_record_invalid")
        return updated

    # --- Removal --------------------------------------------------------------------------

    def delete(self, runtime_id: str) -> None:
        """Request the deletion of the runtime (its ``DEFAULT`` endpoint goes with it).

        Deletions are asynchronous and the runtime cannot go while it has the ``live``
        endpoint, so this raises ``RetryableError`` until that endpoint is gone and the
        deletion of the runtime has been accepted. Callers check with ``find`` that it
        finished.
        """
        endpoint = self._endpoint(runtime_id)
        if endpoint is not None:
            if endpoint["status"] != "DELETING":
                try:
                    self._ac.delete_agent_runtime_endpoint(
                        agentRuntimeId=runtime_id, endpointName=ENDPOINT_LIVE
                    )
                except ClientError as exc:
                    if error_code(exc) not in {_NOT_FOUND, "ConflictException"}:
                        raise aws_error("DeleteAgentRuntimeEndpoint", exc) from None
                except BotoCoreError as exc:
                    raise aws_error("DeleteAgentRuntimeEndpoint", exc) from None
            raise RetryableError("endpoint_deleting")
        try:
            self._ac.delete_agent_runtime(agentRuntimeId=runtime_id)
        except ClientError as exc:
            code = error_code(exc)
            if code == "ConflictException":
                raise RetryableError("runtime_delete_conflict") from None
            if code != _NOT_FOUND:
                raise aws_error("DeleteAgentRuntime", exc) from None
        except BotoCoreError as exc:
            raise aws_error("DeleteAgentRuntime", exc) from None
