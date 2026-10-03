"""Fixtures of the pack provisioner tests: moto for DynamoDB, IAM and S3, a signed pack made
with a throwaway key, and an in-memory AgentCore (runtimes, Gateway targets and policies).

The fake AgentCore validates every request against the real botocore model. Its asynchronous
behaviour (``CREATING`` -> ``READY``, the ``DEFAULT`` endpoint following the latest version,
slow deletions, the Gateway reading ``tools/list`` when a target is created or synchronized,
and the policy engine rejecting an action the Gateway does not know) follows what was observed
in the lab.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
from botocore.exceptions import ClientError
from botocore.validate import validate_parameters
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from mango_packs.canonical import sha256_hex
from mango_packs.enablement import enablement_key, installed_key
from mango_packs.signing import PackStatement, build_envelope, signed_message
from mango_packs.tools import normalize_tools, tools_hash
from mango_provisioner.audit import AuditWriter
from mango_provisioner.packs.config import PackSettings
from mango_provisioner.packs.gateway import PackGateway
from mango_provisioner.packs.identity import IdentityKey
from mango_provisioner.packs.release import PackRelease
from mango_provisioner.packs.role import PackRoles
from mango_provisioner.packs.runtime import PackRuntimes
from mango_provisioner.packs.steps import PackProvisioner
from mango_provisioner.packs.store import PackStore

from .conftest import ACCOUNT, AUDIT_TABLE, LOGS_KEY_ARN, NOW, NS, REGION, FakeFirehose, FakeLogs

SETTINGS_TABLE = "Mango-test-Settings"
BUCKET = "mango-test-packs"
PACK = "aws-pricing"
VERSION = "1.1.1-1"
BOUNDARY_ARN = f"arn:aws:iam::{ACCOUNT}:policy/Mango-{NS}-mcp-boundary"
GATEWAY_ID = "mango-test-tools-abcde12345"
GATEWAY_ARN = f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:gateway/{GATEWAY_ID}"
POLICY_ENGINE_ID = "Mango_test_Tools-abcde12345"
ALLOWED_ACTIONS = ["pricing:DescribeServices", "pricing:GetAttributeValues", "pricing:GetProducts"]
BROKER_ARN = f"arn:aws:iam::{ACCOUNT}:role/Mango-{NS}-BillingBroker"
TARGET_ARN = f"arn:aws:iam::999988887777:role/Mango-{NS}-BillingReader"
BROKERED_ACTIONS = ["ce:GetCostAndUsage", "ce:GetCostForecast"]
MEMBER_BROKER_ARN = f"arn:aws:iam::{ACCOUNT}:role/Mango-{NS}-ReadBroker"
MEMBER_ROLE_NAME = f"Mango-{NS}-ReadOnly"
MEMBER_ACTIONS = ["cloudwatch:DescribeAlarms", "cloudwatch:GetMetricData"]
SUBNETS = ["subnet-0aaaaaaaaaaaaaaa1", "subnet-0aaaaaaaaaaaaaaa2"]
PACK_SECURITY_GROUP = "sg-0bbbbbbbbbbbbbbb1"
NETWORK: dict[str, Any] = {"subnets": SUBNETS, "security_groups": {PACK: PACK_SECURITY_GROUP}}
IDENTITY_KEY_ARN = f"arn:aws:kms:{REGION}:{ACCOUNT}:key/11111111-2222-3333-4444-555555555555"
ZIP = b"PK-not-really-a-zip" * 100
SBOM = b'{"bomFormat":"CycloneDX"}'

TOOLS: list[dict[str, Any]] = [
    {
        "name": "get_pricing",
        "description": "Prices of a service.",
        "inputSchema": {"type": "object", "properties": {"service_code": {"type": "string"}}},
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "get_pricing_service_codes",
        "description": "Service codes.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def manifest_data(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "schema_version": 1,
        "id": PACK,
        "version": VERSION,
        "name": "AWS Pricing",
        "description": "Public AWS list prices.",
        "source": {
            "package": "awslabs.aws-pricing-mcp-server",
            "version": "1.1.1",
            "sha256": "a" * 64,
            "exclude_newer": "2026-09-24T00:00:00Z",
        },
        "data_tier": "public",
        "identity_mode": "service",
        "iam": [
            {
                "actions": ["pricing:GetProducts", "pricing:DescribeServices"],
                "resources": ["*"],
                "reason": "The Price List API does not accept ARNs.",
            }
        ],
        "egress": {"aws": ["pricing"]},
        "tools": [{"name": tool["name"], "access": "read"} for tool in TOOLS],
        "tools_hash": tools_hash(normalize_tools(TOOLS)),
        "config": [
            {"key": "region", "allowed": ["us-east-1", "eu-central-1"], "default": "us-east-1"}
        ],
    }
    return {**base, **overrides}


class Signer:
    """A throwaway P-256 key standing for the provider's KMS key."""

    def __init__(self) -> None:
        self._key = ec.generate_private_key(ec.SECP256R1())
        self.public_pem = self._key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        )

    def statement(
        self, manifest: dict[str, Any] | None = None, *, revision: str = "f" * 40
    ) -> PackStatement:
        data = manifest or manifest_data()
        return PackStatement.model_validate(
            {
                "schema_version": 1,
                "manifest": data,
                "artifact": {
                    "file": f"{data['id']}-{data['version']}.zip",
                    "sha256": hashlib.sha256(ZIP).hexdigest(),
                    "size": len(ZIP),
                },
                "sbom": {
                    "file": f"{data['id']}-{data['version']}.sbom.cdx.json",
                    "sha256": hashlib.sha256(SBOM).hexdigest(),
                    "size": len(SBOM),
                },
                "lock_sha256": "e" * 64,
                "source_revision": revision,
            }
        )

    def envelope(self, statement: PackStatement) -> bytes:
        signature = self._key.sign(signed_message(statement.payload()), ec.ECDSA(hashes.SHA256()))
        return build_envelope(statement, "arn:aws:kms:us-east-1:111122223333:key/test", signature)


def digest_of(statement: PackStatement) -> str:
    return sha256_hex(statement.payload())


def account_data_manifest(**overrides: Any) -> dict[str, Any]:
    """The same pack as a server over account data that does not filter by area (D37)."""
    return manifest_data(
        **{
            "data_tier": "account_data",
            "identity_mode": "central_only",
            "iam": [
                {
                    "actions": ["ce:GetCostAndUsage"],
                    "resources": ["*"],
                    "reason": "Cost Explorer does not accept ARNs.",
                }
            ],
            "egress": {"aws": ["sts", "ce"]},
            **overrides,
        }
    )


class FakeKms:
    """The interceptor's signing key, as far as the provisioner reads it."""

    def __init__(self) -> None:
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.key_spec = "ECC_NIST_P256"
        self.calls: list[str] = []

    @property
    def public_der(self) -> bytes:
        return self.key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )

    def get_public_key(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs["KeyId"])
        return {"PublicKey": self.public_der, "KeySpec": self.key_spec, "KeyUsage": "SIGN_VERIFY"}


def env(
    public_key: bytes | None,
    catalog: dict[str, Any],
    *,
    broker: bool = True,
    network: dict[str, Any] | None = None,
) -> dict[str, str]:
    return {
        "PACK_NETWORK": json.dumps(NETWORK if network is None else network),
        "PACK_BROKER_ROLE_ARN": BROKER_ARN if broker else "",
        "PACK_TARGET_ROLE_ARN": TARGET_ARN if broker else "",
        "PACK_BROKERED_ACTIONS": json.dumps(BROKERED_ACTIONS if broker else []),
        "PACK_IDENTITY_KEY_ARN": IDENTITY_KEY_ARN if broker else "",
        "PACK_MEMBER_BROKER_ROLE_ARN": MEMBER_BROKER_ARN if broker else "",
        "PACK_MEMBER_ROLE_NAME": MEMBER_ROLE_NAME if broker else "",
        "PACK_MEMBER_ACTIONS": json.dumps(MEMBER_ACTIONS if broker else []),
        "MANGO_NAMESPACE": NS,
        "MANGO_ACCOUNT_ID": ACCOUNT,
        "AWS_REGION": REGION,
        "SETTINGS_TABLE": SETTINGS_TABLE,
        "AUDIT_STREAM": "Mango-test-Audit",
        "AUDIT_INDEX_TABLE": AUDIT_TABLE,
        "PACK_BOUNDARY_ARN": BOUNDARY_ARN,
        "PACK_ALLOWED_ACTIONS": json.dumps(ALLOWED_ACTIONS),
        "PACKS_BUCKET": BUCKET,
        "PACK_SIGNING_PUBLIC_KEY": public_key.decode() if public_key else "",
        "PACK_CATALOG": json.dumps(catalog),
        "GATEWAY_ID": GATEWAY_ID,
        "POLICY_ENGINE_ID": POLICY_ENGINE_ID,
        "RUNTIME_LOGS_KEY_ARN": LOGS_KEY_ARN,
        "CONNECTOR_TARGETS": json.dumps(["finops"]),
    }


def _error(code: str, operation: str, message: str = "") -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": message}}, operation)


_AGENTCORE = f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}"
_ACTION_RE = re.compile(r'AgentCore::Action::"([^"]+)"')
_QUALIFIER_RE = re.compile(r"\?qualifier=(\w+)$")


class FakeAgentCore:
    """Control and data plane of AgentCore, as far as the pack provisioner uses them."""

    def __init__(self) -> None:
        session = boto3.Session(
            region_name=REGION, aws_access_key_id="x", aws_secret_access_key="x"
        )
        self._models = {
            name: session.client(name).meta.service_model
            for name in ("bedrock-agentcore-control", "bedrock-agentcore")
        }
        self.calls: list[str] = []
        self.fail_next: dict[str, ClientError] = {}
        self.tokens: dict[str, Any] = {}
        self.polls_until_ready = 1
        self._clock = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
        self.runtimes: dict[str, dict[str, Any]] = {}
        self.targets: dict[str, dict[str, Any]] = {}
        self.policies: dict[str, dict[str, Any]] = {}
        self.fail_runtime = False
        self.role_not_ready_once = False
        # What a runtime version answers to `tools/list` (default: the manifest's tools).
        self.tools_by_version: dict[str, list[dict[str, Any]]] = {}
        self.tool_calls = 0
        self.fail_policy_reason: str | None = None

    # --- Plumbing ---

    def _tick(self) -> datetime:
        self._clock += timedelta(seconds=1)
        return self._clock

    def _enter(self, operation: str, kwargs: dict[str, Any], model: str | None = None) -> None:
        service = self._models[model or "bedrock-agentcore-control"]
        validate_parameters(kwargs, service.operation_model(operation).input_shape)
        self.calls.append(operation)
        if operation in self.fail_next:
            raise self.fail_next.pop(operation)

    def writes(self) -> list[str]:
        prefixes = ("Create", "Update", "Delete", "Synchronize")
        return [c for c in self.calls if c.startswith(prefixes)]

    def get_paginator(self, name: str) -> Any:
        fake = self

        class Paginator:
            def paginate(self, **kwargs: Any) -> Iterator[dict[str, Any]]:
                if name == "list_agent_runtimes":
                    fake.calls.append("ListAgentRuntimes")
                    yield {"agentRuntimes": [fake._runtime_summary(r) for r in fake._runtimes()]}
                elif name == "list_gateway_targets":
                    assert kwargs == {"gatewayIdentifier": GATEWAY_ID}
                    fake.calls.append("ListGatewayTargets")
                    yield {"items": [fake._target_view(t) for t in fake._targets()]}
                elif name == "list_policies":
                    assert kwargs == {"policyEngineId": POLICY_ENGINE_ID}
                    fake.calls.append("ListPolicies")
                    yield {"policies": [fake._policy_view(p) for p in fake._policies()]}
                else:  # pragma: no cover - a paginator the provisioner should not use
                    raise AssertionError(name)

        return Paginator()

    # --- Runtimes ---

    def _runtimes(self) -> list[dict[str, Any]]:
        for runtime in list(self.runtimes.values()):
            if runtime["deleting"]:
                runtime["delete_polls"] += 1
                if runtime["delete_polls"] > 1:
                    del self.runtimes[runtime["id"]]
        return list(self.runtimes.values())

    def _runtime(self, runtime_id: str, operation: str) -> dict[str, Any]:
        self._runtimes()
        if runtime_id not in self.runtimes:
            raise _error("ResourceNotFoundException", operation)
        return self.runtimes[runtime_id]

    def _advance_version(self, version: dict[str, Any]) -> None:
        if version["status"] in {"CREATING", "UPDATING"}:
            version["polls"] += 1
            if version["polls"] >= self.polls_until_ready:
                failed = version["status"].replace("ING", "E_FAILED")
                version["status"] = failed if self.fail_runtime else "READY"
                version["ready_at"] = self._tick()

    def _runtime_summary(self, runtime: dict[str, Any]) -> dict[str, Any]:
        version = runtime["versions"][-1]
        return {
            "agentRuntimeArn": f"{_AGENTCORE}:runtime/{runtime['id']}",
            "agentRuntimeId": runtime["id"],
            "agentRuntimeName": runtime["name"],
            "agentRuntimeVersion": version["number"],
            "status": "DELETING" if runtime["deleting"] else version["status"],
        }

    def _runtime_view(self, runtime: dict[str, Any], version: dict[str, Any]) -> dict[str, Any]:
        return {
            **self._runtime_summary(runtime),
            "agentRuntimeVersion": version["number"],
            "status": "DELETING" if runtime["deleting"] else version["status"],
            **version["config"],
        }

    def create_agent_runtime(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("CreateAgentRuntime", kwargs)
        token = kwargs["clientToken"]
        if token in self.tokens:
            return self._runtime_view(*self.tokens[token])
        if self.role_not_ready_once:
            self.role_not_ready_once = False
            raise _error(
                "ValidationException",
                "CreateAgentRuntime",
                "Role validation failed for 'arn:aws:iam::…'. Please verify that the role exists",
            )
        name = kwargs.pop("agentRuntimeName")
        if any(r["name"] == name for r in self.runtimes.values()):
            raise _error("ConflictException", "CreateAgentRuntime")
        suffix = f"{len(self.tokens) + 1:010d}"
        config = {k: v for k, v in kwargs.items() if k not in {"clientToken", "tags"}}
        version = {"number": "1", "status": "CREATING", "polls": 0, "config": config}
        runtime = {
            "id": f"{name}-{suffix}",
            "name": name,
            "tags": kwargs["tags"],
            "versions": [version],
            "live": None,
            "deleting": False,
            "delete_polls": 0,
        }
        self.runtimes[runtime["id"]] = runtime
        self.tokens[token] = (runtime, version)
        return self._runtime_view(runtime, version)

    def update_agent_runtime(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("UpdateAgentRuntime", kwargs)
        runtime = self._runtime(kwargs.pop("agentRuntimeId"), "UpdateAgentRuntime")
        token = kwargs.pop("clientToken")
        if token in self.tokens:
            return self._runtime_view(*self.tokens[token])
        if runtime["versions"][-1]["status"] in {"CREATING", "UPDATING"}:
            raise _error("ConflictException", "UpdateAgentRuntime")
        version = {
            "number": str(len(runtime["versions"]) + 1),
            "status": "UPDATING",
            "polls": 0,
            "config": kwargs,
        }
        runtime["versions"].append(version)
        self.tokens[token] = (runtime, version)
        return self._runtime_view(runtime, version)

    def get_agent_runtime(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("GetAgentRuntime", kwargs)
        runtime = self._runtime(kwargs["agentRuntimeId"], "GetAgentRuntime")
        number = kwargs.get("agentRuntimeVersion")
        version = (
            runtime["versions"][-1]
            if number is None
            else next(v for v in runtime["versions"] if v["number"] == number)
        )
        self._advance_version(version)
        return self._runtime_view(runtime, version)

    def delete_agent_runtime(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("DeleteAgentRuntime", kwargs)
        runtime = self._runtime(kwargs["agentRuntimeId"], "DeleteAgentRuntime")
        if runtime["live"] is not None:
            raise _error("ConflictException", "DeleteAgentRuntime")
        runtime["deleting"] = True
        return {"status": "DELETING"}

    # --- Runtime endpoints ---

    def _advance_endpoint(self, endpoint: dict[str, Any]) -> None:
        if endpoint["status"] in {"CREATING", "UPDATING"}:
            endpoint["polls"] += 1
            if endpoint["polls"] >= self.polls_until_ready:
                endpoint.update(status="READY", live=endpoint["target"], updated=self._tick())

    def get_agent_runtime_endpoint(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("GetAgentRuntimeEndpoint", kwargs)
        runtime = self._runtime(kwargs["agentRuntimeId"], "GetAgentRuntimeEndpoint")
        if kwargs["endpointName"] == "DEFAULT":
            # `DEFAULT` follows the latest version once that version is ready.
            ready = [v for v in runtime["versions"] if v["status"] == "READY"]
            latest = runtime["versions"][-1]
            out = {
                "name": "DEFAULT",
                "status": "READY" if latest["status"] == "READY" else "UPDATING",
            }
            if ready:
                out["liveVersion"] = ready[-1]["number"]
                out["lastUpdatedAt"] = ready[-1]["ready_at"]
            return out
        endpoint = runtime["live"]
        if endpoint is None:
            raise _error("ResourceNotFoundException", "GetAgentRuntimeEndpoint")
        if endpoint["status"] == "DELETING":
            endpoint["polls"] += 1
            if endpoint["polls"] > 1:
                runtime["live"] = None
                raise _error("ResourceNotFoundException", "GetAgentRuntimeEndpoint")
        self._advance_endpoint(endpoint)
        out = {"name": "live", "status": endpoint["status"], "createdAt": endpoint["created"]}
        if endpoint["live"]:
            out["liveVersion"] = endpoint["live"]
            out["lastUpdatedAt"] = endpoint["updated"]
        if endpoint["status"] != "READY":
            out["targetVersion"] = endpoint["target"]
        return out

    def create_agent_runtime_endpoint(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("CreateAgentRuntimeEndpoint", kwargs)
        runtime = self._runtime(kwargs["agentRuntimeId"], "CreateAgentRuntimeEndpoint")
        assert kwargs["name"] == "live"
        runtime["live"] = {
            "status": "CREATING",
            "live": None,
            "target": kwargs["agentRuntimeVersion"],
            "polls": 0,
            "created": self._tick(),
            "updated": None,
        }
        return {"status": "CREATING"}

    def update_agent_runtime_endpoint(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("UpdateAgentRuntimeEndpoint", kwargs)
        runtime = self._runtime(kwargs["agentRuntimeId"], "UpdateAgentRuntimeEndpoint")
        runtime["live"].update(status="UPDATING", target=kwargs["agentRuntimeVersion"], polls=0)
        return {"status": "UPDATING"}

    def delete_agent_runtime_endpoint(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("DeleteAgentRuntimeEndpoint", kwargs)
        runtime = self._runtime(kwargs["agentRuntimeId"], "DeleteAgentRuntimeEndpoint")
        runtime["live"].update(status="DELETING", polls=0)
        return {"status": "DELETING"}

    # --- Data plane: tools/list ---

    def _served_tools(self, runtime: dict[str, Any], version: str) -> list[dict[str, Any]]:
        return self.tools_by_version.get(version, TOOLS)

    def invoke_agent_runtime(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("InvokeAgentRuntime", kwargs, "bedrock-agentcore")
        runtime_id = kwargs["agentRuntimeArn"].rsplit("/", 1)[-1]
        runtime = self._runtime(runtime_id, "InvokeAgentRuntime")
        assert kwargs["qualifier"] == "DEFAULT"
        request = json.loads(kwargs["payload"])
        assert request["method"] == "tools/list"
        ready = [v for v in runtime["versions"] if v["status"] == "READY"]
        self.tool_calls += 1
        result = {"tools": self._served_tools(runtime, ready[-1]["number"])}
        body = json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}).encode()
        return {"response": io.BytesIO(body), "contentType": "application/json", "statusCode": 200}

    # --- Gateway targets ---

    def _targets(self) -> list[dict[str, Any]]:
        for target in list(self.targets.values()):
            if target["status"] == "DELETING":
                target["polls"] += 1
                if target["polls"] > 1:
                    del self.targets[target["id"]]
            elif target["status"] in {"CREATING", "UPDATING", "SYNCHRONIZING"}:
                target["polls"] += 1
                if target["polls"] >= self.polls_until_ready:
                    self._synchronize(target)
        return list(self.targets.values())

    def _synchronize(self, target: dict[str, Any]) -> None:
        """The Gateway reads `tools/list` through the `live` endpoint and keeps the catalog."""
        endpoint = target["config"]["targetConfiguration"]["mcp"]["mcpServer"]["endpoint"]
        match = _QUALIFIER_RE.search(endpoint)
        assert match and match.group(1) == "live", endpoint
        runtime = next(r for r in self.runtimes.values() if r["id"] in endpoint.replace("%2F", "/"))
        live = runtime["live"]["live"]
        target.update(
            status="READY",
            synchronized=self._tick(),
            tools=[t["name"] for t in self._served_tools(runtime, live)],
        )

    def _target_view(self, target: dict[str, Any]) -> dict[str, Any]:
        out = {
            "targetId": target["id"],
            "name": target["name"],
            "status": target["status"],
            **target["config"],
        }
        if target["synchronized"]:
            out["lastSynchronizedAt"] = target["synchronized"]
        return out

    def _target(self, target_id: str, operation: str) -> dict[str, Any]:
        self._targets()
        if target_id not in self.targets:
            raise _error("ResourceNotFoundException", operation)
        return self.targets[target_id]

    def add_connector_target(self, name: str = "finops") -> str:
        """A target the stack created for a Mango connector."""
        target_id = f"CONNECTOR{len(self.targets)}"
        self.targets[target_id] = {
            "id": target_id,
            "name": name,
            "status": "READY",
            "polls": 0,
            "config": {"targetConfiguration": {"mcp": {"lambda": {}}}},
            "synchronized": self._tick(),
            "tools": ["get_cost_and_usage"],
        }
        return target_id

    def create_gateway_target(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("CreateGatewayTarget", kwargs)
        assert kwargs["gatewayIdentifier"] == GATEWAY_ID
        if any(t["name"] == kwargs["name"] for t in self.targets.values()):
            raise _error("ConflictException", "CreateGatewayTarget")
        target_id = f"TARGET{len(self.tokens) + len(self.targets):04d}"
        self.targets[target_id] = {
            "id": target_id,
            "name": kwargs["name"],
            "status": "CREATING",
            "polls": 0,
            "config": {
                "targetConfiguration": kwargs["targetConfiguration"],
                "credentialProviderConfigurations": kwargs["credentialProviderConfigurations"],
            },
            "synchronized": None,
            "tools": [],
        }
        return {"targetId": target_id, "status": "CREATING"}

    def get_gateway_target(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("GetGatewayTarget", kwargs)
        return self._target_view(self.targets[kwargs["targetId"]])

    def update_gateway_target(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("UpdateGatewayTarget", kwargs)
        target = self._target(kwargs["targetId"], "UpdateGatewayTarget")
        target["config"] = {
            "targetConfiguration": kwargs["targetConfiguration"],
            "credentialProviderConfigurations": kwargs["credentialProviderConfigurations"],
        }
        target.update(status="UPDATING", polls=0)
        return {"status": "UPDATING"}

    def synchronize_gateway_targets(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("SynchronizeGatewayTargets", kwargs)
        (target_id,) = kwargs["targetIdList"]
        self._target(target_id, "SynchronizeGatewayTargets").update(status="SYNCHRONIZING", polls=0)
        return {"targets": []}

    def delete_gateway_target(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("DeleteGatewayTarget", kwargs)
        self._target(kwargs["targetId"], "DeleteGatewayTarget").update(status="DELETING", polls=0)
        return {"status": "DELETING"}

    # --- Cedar policies ---

    def _known_actions(self) -> set[str]:
        return {
            f"{target['name']}___{tool}"
            for target in self.targets.values()
            if target["status"] == "READY"
            for tool in target["tools"]
        }

    def _policies(self) -> list[dict[str, Any]]:
        for policy in list(self.policies.values()):
            status = policy["status"]
            if status == "DELETING":
                policy["polls"] += 1
                if policy["polls"] > 1:
                    del self.policies[policy["id"]]
            elif status in {"CREATING", "UPDATING"}:
                policy["polls"] += 1
                if policy["polls"] >= self.polls_until_ready:
                    actions = set(_ACTION_RE.findall(policy["statement"]))
                    reason = self.fail_policy_reason
                    if not actions <= self._known_actions():
                        reason = "unrecognized action"
                    if reason:
                        policy.update(status=status.replace("ING", "E_FAILED"), reasons=[reason])
                    else:
                        policy["status"] = "ACTIVE"
        return list(self.policies.values())

    @staticmethod
    def _policy_view(policy: dict[str, Any]) -> dict[str, Any]:
        return {
            "policyId": policy["id"],
            "name": policy["name"],
            "status": policy["status"],
            "definition": {"cedar": {"statement": policy["statement"]}},
            "statusReasons": policy["reasons"],
        }

    def add_connector_policy(self, name: str = "Mango_test_FinopsRead") -> str:
        policy_id = f"{name}-connector0"
        self.policies[policy_id] = {
            "id": policy_id,
            "name": name,
            "status": "ACTIVE",
            "polls": 0,
            "statement": "permit (principal, action, resource) when { false };" + " " * 20,
            "reasons": [],
        }
        return policy_id

    def create_policy(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("CreatePolicy", kwargs)
        assert kwargs["policyEngineId"] == POLICY_ENGINE_ID
        assert "clientToken" not in kwargs  # a failed policy is recreated under its name
        if any(p["name"] == kwargs["name"] for p in self.policies.values()):
            raise _error("ConflictException", "CreatePolicy")
        policy = {
            "id": f"{kwargs['name']}-{self._tick().strftime('p%H%M%S')}abc",
            "name": kwargs["name"],
            "status": "CREATING",
            "polls": 0,
            "statement": kwargs["definition"]["cedar"]["statement"],
            "reasons": [],
        }
        self.policies[policy["id"]] = policy
        return self._policy_view(policy)

    def update_policy(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("UpdatePolicy", kwargs)
        policy = self.policies[kwargs["policyId"]]
        policy.update(
            status="UPDATING", polls=0, statement=kwargs["definition"]["cedar"]["statement"]
        )
        return self._policy_view(policy)

    def delete_policy(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("DeletePolicy", kwargs)
        if kwargs["policyId"] not in self.policies:
            raise _error("ResourceNotFoundException", "DeletePolicy")
        self.policies[kwargs["policyId"]].update(status="DELETING", polls=0)
        return self._policy_view(self.policies[kwargs["policyId"]])

    # --- Test helpers ---

    def runtime(self) -> dict[str, Any]:
        (runtime,) = self.runtimes.values()
        return runtime

    def pack_policies(self) -> dict[str, dict[str, Any]]:
        return {p["name"]: p for p in self._policies() if "_mcp_" in p["name"]}

    def pack_target(self) -> dict[str, Any] | None:
        targets = [t for t in self.targets.values() if t["name"] == PACK]
        return targets[0] if targets else None


class PackLab:
    """Everything a test needs: the provisioner, its fakes and what mango-api would stage."""

    def __init__(self, dynamodb: Any, iam: Any, s3: Any) -> None:
        self.db = dynamodb
        self.iam = iam
        self.s3 = s3
        self.signer = Signer()
        self.agentcore = FakeAgentCore()
        self.logs = FakeLogs()
        self.firehose = FakeFirehose()
        self.kms = FakeKms()
        self.broker = True
        self.network: dict[str, Any] = NETWORK
        self.now = NOW
        self.statement = self.signer.statement()
        self.provisioner = self.build(self.publish(self.statement))

    # --- The release: what CloudFormation copied and what the template pins ---

    def put(self, name: str, body: bytes, version: str = VERSION, pack_id: str = PACK) -> str:
        key = f"packs/{pack_id}/{version}/{name}"
        return str(self.s3.put_object(Bucket=BUCKET, Key=key, Body=body).get("VersionId"))

    def publish(self, statement: PackStatement, *, envelope: bytes | None = None) -> dict[str, Any]:
        """Copy a signed pack to the bucket. Returns the catalog that names it."""
        manifest = statement.manifest
        self.put(
            f"{manifest.id}-{manifest.version}.pack.json",
            envelope or self.signer.envelope(statement),
            manifest.version,
            manifest.id,
        )
        self.put(statement.artifact.file, ZIP, manifest.version, manifest.id)
        self.put(statement.sbom.file, SBOM, manifest.version, manifest.id)
        return {
            manifest.id: {"version": manifest.version, "statement_sha256": digest_of(statement)}
        }

    def build(
        self, catalog: dict[str, Any], *, public_key: bytes | bool | None = True
    ) -> PackProvisioner:
        """The provisioner as the stack of a release would configure it."""
        key = self.signer.public_pem if public_key is True else (public_key or None)
        self.settings = PackSettings.from_env(
            env(key, catalog, broker=self.broker, network=self.network)
        )
        self.store = PackStore(self.db, SETTINGS_TABLE)
        self.provisioner = PackProvisioner(
            self.settings,
            store=self.store,
            release=PackRelease(self.s3, self.settings),
            roles=PackRoles(self.iam, self.settings),
            runtimes=PackRuntimes(self.agentcore, self.agentcore, self.settings),  # type: ignore[arg-type]
            gateway=PackGateway(self.agentcore, self.settings),  # type: ignore[arg-type]
            identity=IdentityKey(self.kms, self.settings),  # type: ignore[arg-type]
            logs=self.logs,  # type: ignore[arg-type]
            audit=AuditWriter(self.firehose, "Mango-test-Audit", self.db, AUDIT_TABLE),  # type: ignore[arg-type]
            clock=lambda: self.now,
        )
        return self.provisioner

    def release(self, statement: PackStatement) -> None:
        """A stack update to a release that ships ``statement`` for the pack."""
        self.statement = statement
        self.build(self.publish(statement))

    # --- What mango-api would have written ---

    def approve(
        self,
        enablement_id: str = "enablement-0001",
        *,
        status: str = "approved",
        version: str = VERSION,
        config: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Stage an approved enablement. Returns the execution input."""
        self.db.put_item(
            TableName=SETTINGS_TABLE,
            Item={
                **enablement_key(PACK),
                "status": {"S": status},
                "enablement_id": {"S": enablement_id},
                "pack_version": {"S": version},
                "config": {"S": json.dumps(config or {})},
                "requested_by": {"S": "admin-1"},
                "approved_by": {"S": "admin-2"},
                "version": {"N": "1"},
            },
        )
        return {"pack_id": PACK, "pack_version": version, "enablement_id": enablement_id}

    def disable(self, enablement_id: str = "enablement-0001") -> dict[str, Any]:
        return self.approve(enablement_id, status="disabling")

    def enablement(self) -> dict[str, Any]:
        return self._item(enablement_key(PACK)) or {}

    def installed(self) -> dict[str, Any] | None:
        return self._item(installed_key(PACK))

    def _item(self, key: dict[str, Any]) -> dict[str, Any] | None:
        item = self.db.get_item(TableName=SETTINGS_TABLE, Key=key, ConsistentRead=True).get("Item")
        if item is None:
            return None
        return {name: next(iter(value.values())) for name, value in item.items()}

    def installed_zip_version(self) -> str:
        """Current S3 version of the pack zip."""
        key = f"packs/{PACK}/{VERSION}/{PACK}-{VERSION}.zip"
        return str(self.s3.head_object(Bucket=BUCKET, Key=key)["VersionId"])

    def role_document(self) -> dict[str, Any]:
        document: dict[str, Any] = self.iam.get_role_policy(
            RoleName=self.settings.role_name(PACK), PolicyName="pack"
        )["PolicyDocument"]
        return document

    def role_actions(self) -> list[str]:
        """Data actions of the pack role (the statements that come from a manifest)."""
        return sorted(
            action
            for statement in self.role_document()["Statement"]
            if statement["Sid"].startswith("Manifest")
            for action in statement["Action"]
        )

    def role_exists(self) -> bool:
        try:
            self.iam.get_role(RoleName=self.settings.role_name(PACK))
        except ClientError:
            return False
        return True

    def audit(self) -> list[tuple[str, str]]:
        return [(r["event"], r["detail"]["outcome"]) for r in self.firehose.records]

    # --- The state machine, in Python ---

    def run(
        self,
        execution_input: dict[str, Any],
        execution: str = "exec-1",
        *,
        fail_at: str | None = None,
    ) -> dict[str, Any]:
        """Run the steps in the order of the state machine, with its retries and failure path."""
        p = self.provisioner
        state: dict[str, Any] = execution_input

        def call(name: str, step: Any, *args: Any) -> dict[str, Any]:
            if fail_at == name:
                error = RuntimeError("boom")
                error.step = name  # type: ignore[attr-defined]
                raise error
            for attempt in range(40):
                try:
                    return {**step(*args), "last_step": name}
                except Exception as exc:
                    # Step Functions retries a transient error, then gives up and catches it.
                    if type(exc).__name__ != "RetryableError" or attempt == 39:
                        exc.step = name  # type: ignore[attr-defined]
                        raise
            raise AssertionError("unreachable")

        def wait(name: str, step: Any, current: dict[str, Any]) -> dict[str, Any]:
            while not current["ready"]:
                current = call(name, step, current)
            return current

        try:
            state = call("load", p.load, state, execution)
            if state["action"] == "noop":
                return state
            if state["action"] == "disable":
                return call("remove", p.remove, state)
            state = call("ensure_role", p.ensure_role, state)
            state = wait(
                "check_runtime", p.check_runtime, call("ensure_runtime", p.ensure_runtime, state)
            )
            state = call("verify_tools", p.verify_tools, state)
            state = wait("check_live", p.check_live, call("point_live", p.point_live, state))
            state = call("govern_logs", p.govern_logs, state)
            state = wait(
                "check_target", p.check_target, call("ensure_target", p.ensure_target, state)
            )
            state = wait(
                "check_policies",
                p.check_policies,
                call("ensure_policies", p.ensure_policies, state),
            )
            return call("finish", p.finish, state)
        except Exception as exc:  # noqa: BLE001 - like the state machine's catch-all
            code = getattr(exc, "code", type(exc).__name__)
            step = getattr(exc, "step", "unknown")
            cause = json.dumps({"errorMessage": json.dumps({"step": step, "code": code})})
            state = {**state, "execution": execution, "error": {"Error": "X", "Cause": cause}}
            for _ in range(40):
                try:
                    state = p.compensate(state)
                    break
                except Exception as retry:  # noqa: BLE001
                    if type(retry).__name__ != "RetryableError":
                        state = {**state, "compensation_error": {"Error": "X"}}
                        break
            return p.mark_failed(state)


def make_packlab() -> PackLab:
    """Tables, the boundary policy, a versioned bucket and the lab (inside ``mock_aws``)."""
    dynamodb = boto3.client("dynamodb", region_name=REGION)
    for name in (SETTINGS_TABLE, AUDIT_TABLE):
        dynamodb.create_table(
            TableName=name,
            BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
            ],
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
        )
    iam = boto3.client("iam", region_name=REGION)
    iam.create_policy(
        PolicyName=f"Mango-{NS}-mcp-boundary",
        PolicyDocument=json.dumps(
            {
                "Version": "2012-10-17",
                "Statement": [{"Effect": "Allow", "Action": ALLOWED_ACTIONS, "Resource": "*"}],
            }
        ),
    )
    s3 = boto3.client("s3", region_name=REGION)
    s3.create_bucket(Bucket=BUCKET)
    s3.put_bucket_versioning(Bucket=BUCKET, VersioningConfiguration={"Status": "Enabled"})
    return PackLab(dynamodb, iam, s3)
