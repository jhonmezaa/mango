"""Fixtures of the remote MCP provisioner tests.

moto for DynamoDB and S3; an in-memory AgentCore (Gateway targets, Cedar policies, the
Gateway's workload identity and OAuth2 providers) that validates every request against the
real botocore model; a throwaway P-256 key standing for ``alias/Mango-<ns>-remote-mcp``; and
the real Azure DevOps profile of ``remotes/``, signed with a throwaway provider key.
"""

from __future__ import annotations

import base64
import json
import re
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import boto3
import yaml
from botocore.exceptions import ClientError
from botocore.validate import validate_parameters
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import Prehashed

from mango_core import remote_mcp
from mango_packs.canonical import sha256_hex
from mango_packs.remote import PAYLOAD_TYPE, RemoteProfileStatement, build_envelope
from mango_packs.signing import signed_message
from mango_provisioner.audit import AuditWriter
from mango_provisioner.errors import StepError
from mango_provisioner.remotes.config import RemoteSettings
from mango_provisioner.remotes.gateway import RemoteGateway
from mango_provisioner.remotes.identity import RemoteIdentity
from mango_provisioner.remotes.release import RemoteRelease
from mango_provisioner.remotes.signing import CatalogSigner
from mango_provisioner.remotes.steps import RemoteProvisioner
from mango_provisioner.remotes.store import RemoteStore

from .conftest import FakeFirehose

REGION = "us-east-1"
ACCOUNT = "123456789012"
NS = "test"
SETTINGS_TABLE = "Mango-test-Settings"
AUDIT_TABLE = "Mango-test-AuditIndex"
BUCKET = "mango-test-packs"
GATEWAY_ID = "mango-test-tools-abcdefghij"
POLICY_ENGINE_ID = "Mango_test_tools-abcdefghij"
WORKLOAD_IDENTITY = "mango-test-tools-abcdefghij-wi"
WORKLOAD_IDENTITY_ARN = (
    f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:workload-identity-directory/default/"
    f"workload-identity/{WORKLOAD_IDENTITY}"
)
RETURN_URL = "https://d123.cloudfront.net/conexiones/vuelta"
KEY_ALIAS = f"alias/Mango-{NS}-remote-mcp"
KEY_ARN = f"arn:aws:kms:{REGION}:{ACCOUNT}:key/11111111-2222-3333-4444-555555555555"
STACK_ID = (
    f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/Mango-{NS}-Core/"
    "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
)
REG = "abcdefghij23"
APPROVAL = "a" * 32
CHANGE = "01JABCDEFGHJKMNPQRSTVWXYZ0"
ORG = "contoso"
NOW = datetime(2026, 10, 27, 15, 0, tzinfo=UTC)

_REPO = Path(__file__).resolve().parents[3]
PROFILE_DIR = _REPO / "remotes" / "azure-devops"


def profile_data() -> dict[str, Any]:
    return dict(yaml.safe_load((PROFILE_DIR / "profile.yaml").read_text()))


def tool_schema() -> dict[str, Any]:
    return dict(json.loads((PROFILE_DIR / "tool-schema.json").read_text()))


class ProfileSigner:
    """A throwaway P-256 key standing for the provider's signing key."""

    def __init__(self) -> None:
        self._key = ec.generate_private_key(ec.SECP256R1())
        self.public_pem = self._key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        )

    def statement(self, profile: dict[str, Any] | None = None) -> RemoteProfileStatement:
        return RemoteProfileStatement.model_validate(
            {
                "schema_version": 1,
                "profile": profile or profile_data(),
                "tool_schema": tool_schema(),
                "source_revision": "f" * 40,
            }
        )

    def envelope(self, statement: RemoteProfileStatement) -> bytes:
        message = signed_message(statement.payload(), PAYLOAD_TYPE)
        signature = self._key.sign(message, ec.ECDSA(hashes.SHA256()))
        return build_envelope(statement, "alias/mango-provider-signing", signature)


def digest_of(statement: RemoteProfileStatement) -> str:
    return sha256_hex(statement.payload())


class FakeKms:
    """``kms:Sign`` of the remote key (``DIGEST``) and its public half."""

    def __init__(self) -> None:
        self._key = ec.generate_private_key(ec.SECP256R1())
        self.calls: list[str] = []
        self.signed_with: list[str] = []

    @property
    def public_der(self) -> bytes:
        return self._key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )

    def sign(self, **kwargs: Any) -> dict[str, Any]:
        assert kwargs["MessageType"] == "DIGEST"
        assert kwargs["SigningAlgorithm"] == "ECDSA_SHA_256"
        self.calls.append("Sign")
        self.signed_with.append(kwargs["KeyId"])
        signature = self._key.sign(kwargs["Message"], ec.ECDSA(Prehashed(hashes.SHA256())))
        return {"KeyId": KEY_ARN, "Signature": signature, "SigningAlgorithm": "ECDSA_SHA_256"}

    def get_public_key(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append("GetPublicKey")
        return {
            "KeyId": KEY_ARN,
            "PublicKey": self.public_der,
            "KeySpec": "ECC_NIST_P256",
            "KeyUsage": "SIGN_VERIFY",
        }


def _error(code: str, operation: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": ""}}, operation)


class FakeAgentCore:
    """Control plane of AgentCore, as far as the remote provisioner uses it."""

    def __init__(self) -> None:
        session = boto3.Session(
            region_name=REGION, aws_access_key_id="x", aws_secret_access_key="x"
        )
        self._model = session.client("bedrock-agentcore-control").meta.service_model
        self.calls: list[str] = []
        self.fail_next: dict[str, ClientError] = {}
        self.targets: dict[str, dict[str, Any]] = {}
        self.policies: dict[str, dict[str, Any]] = {}
        self.return_urls: list[str] = ["https://example.invalid/kept"]
        self.workload_identity_arn = WORKLOAD_IDENTITY_ARN
        self.providers: set[str] = set()
        self.polls_until_ready = 1
        self.target_status_when_ready = "READY"
        # What GetGatewayTarget returns may differ from what was sent (AgentCore's defaults).
        self.target_read_back: Callable[[dict[str, Any]], dict[str, Any]] | None = None
        self._clock = datetime(2026, 10, 27, 12, 0, tzinfo=UTC)
        self._ids = 0

    def _enter(self, operation: str, kwargs: dict[str, Any]) -> None:
        validate_parameters(kwargs, self._model.operation_model(operation).input_shape)
        self.calls.append(operation)
        if operation in self.fail_next:
            raise self.fail_next.pop(operation)

    def writes(self) -> list[str]:
        return [c for c in self.calls if c.startswith(("Create", "Update", "Delete"))]

    def _next_id(self) -> str:
        self._ids += 1
        return f"{self._ids:010d}"

    def get_paginator(self, name: str) -> Any:
        fake = self

        class Paginator:
            def paginate(self, **kwargs: Any) -> Iterator[dict[str, Any]]:
                if name == "list_gateway_targets":
                    assert kwargs == {"gatewayIdentifier": GATEWAY_ID}
                    fake.calls.append("ListGatewayTargets")
                    yield {
                        "items": [
                            {"targetId": t["targetId"], "name": t["name"], "status": t["status"]}
                            for t in fake._targets()
                        ]
                    }
                elif name == "list_policies":
                    assert kwargs == {"policyEngineId": POLICY_ENGINE_ID}
                    fake.calls.append("ListPolicies")
                    yield {"policies": [fake._policy_view(p) for p in fake._policies()]}
                else:  # pragma: no cover
                    raise AssertionError(name)

        return Paginator()

    # --- Targets ---

    def _targets(self) -> list[dict[str, Any]]:
        for target in list(self.targets.values()):
            target["polls"] += 1
            if (
                target["status"] in {"CREATING", "UPDATING"}
                and target["polls"] >= self.polls_until_ready
            ):
                target["status"] = self.target_status_when_ready
            elif target["status"] == "DELETING" and target["polls"] > 1:
                del self.targets[target["targetId"]]
        return list(self.targets.values())

    @staticmethod
    def _view(target: dict[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in target.items() if k != "polls"}

    def add_target(self, name: str, **config: Any) -> str:
        target_id = self._next_id()
        self.targets[target_id] = {
            "targetId": target_id,
            "name": name,
            "status": "READY",
            "polls": 0,
            **config,
        }
        return target_id

    def create_gateway_target(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("CreateGatewayTarget", kwargs)
        target_id = self._next_id()
        target = {
            "targetId": target_id,
            "name": kwargs["name"],
            "status": "CREATING",
            "polls": 0,
            "targetConfiguration": kwargs["targetConfiguration"],
            "credentialProviderConfigurations": kwargs["credentialProviderConfigurations"],
            "metadataConfiguration": kwargs["metadataConfiguration"],
        }
        self.targets[target_id] = target
        return self._view(target)

    def get_gateway_target(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("GetGatewayTarget", kwargs)
        target = self.targets.get(kwargs["targetId"])
        if target is None:
            raise _error("ResourceNotFoundException", "GetGatewayTarget")
        view = self._view(target)
        return self.target_read_back(view) if self.target_read_back else view

    def update_gateway_target(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("UpdateGatewayTarget", kwargs)
        target = self.targets[kwargs["targetId"]]
        target.update(
            status="UPDATING",
            polls=0,
            targetConfiguration=kwargs["targetConfiguration"],
            credentialProviderConfigurations=kwargs["credentialProviderConfigurations"],
            metadataConfiguration=kwargs["metadataConfiguration"],
        )
        return self._view(target)

    def delete_gateway_target(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("DeleteGatewayTarget", kwargs)
        target = self.targets[kwargs["targetId"]]
        target.update(status="DELETING", polls=0)
        return {"targetId": kwargs["targetId"], "status": "DELETING"}

    # --- Policies ---

    def _policies(self) -> list[dict[str, Any]]:
        for policy in list(self.policies.values()):
            policy["polls"] += 1
            if policy["status"] in {"CREATING", "UPDATING"}:
                policy["status"] = "ACTIVE"
            elif policy["status"] == "DELETING" and policy["polls"] > 1:
                del self.policies[policy["id"]]
        return list(self.policies.values())

    @staticmethod
    def _policy_view(policy: dict[str, Any]) -> dict[str, Any]:
        return {
            "policyId": policy["id"],
            "name": policy["name"],
            "status": policy["status"],
            "definition": {"cedar": {"statement": policy["statement"]}},
        }

    def add_policy(self, name: str) -> None:
        self.policies[name] = {
            "id": name,
            "name": name,
            "status": "ACTIVE",
            "statement": "permit (principal, action, resource);",
            "polls": 0,
        }

    def create_policy(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("CreatePolicy", kwargs)
        policy = {
            "id": f"{kwargs['name']}-{self._next_id()}",
            "name": kwargs["name"],
            "status": "CREATING",
            "statement": kwargs["definition"]["cedar"]["statement"],
            "polls": 0,
        }
        self.policies[policy["id"]] = policy
        return self._policy_view(policy)

    def update_policy(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("UpdatePolicy", kwargs)
        policy = self.policies[kwargs["policyId"]]
        policy.update(status="UPDATING", statement=kwargs["definition"]["cedar"]["statement"])
        return self._policy_view(policy)

    def delete_policy(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("DeletePolicy", kwargs)
        policy = self.policies[kwargs["policyId"]]
        policy.update(status="DELETING", polls=0)
        return self._policy_view(policy)

    def statements(self, registration_id: str = REG) -> list[str]:
        prefix = remote_mcp.policy_prefix(NS, registration_id)
        return [p["statement"] for p in self.policies.values() if p["name"].startswith(prefix)]

    # --- Identity ---

    def get_gateway(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("GetGateway", kwargs)
        assert kwargs["gatewayIdentifier"] == GATEWAY_ID
        return {
            "gatewayId": GATEWAY_ID,
            "workloadIdentityDetails": {"workloadIdentityArn": self.workload_identity_arn},
        }

    def get_workload_identity(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("GetWorkloadIdentity", kwargs)
        assert kwargs["name"] == WORKLOAD_IDENTITY
        return {
            "name": WORKLOAD_IDENTITY,
            "workloadIdentityArn": WORKLOAD_IDENTITY_ARN,
            "allowedResourceOauth2ReturnUrls": list(self.return_urls),
        }

    def update_workload_identity(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("UpdateWorkloadIdentity", kwargs)
        assert kwargs["name"] == WORKLOAD_IDENTITY
        self.return_urls = list(kwargs["allowedResourceOauth2ReturnUrls"])
        return {"name": WORKLOAD_IDENTITY, "workloadIdentityArn": WORKLOAD_IDENTITY_ARN}

    def delete_oauth2_credential_provider(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("DeleteOauth2CredentialProvider", kwargs)
        if kwargs["name"] not in self.providers:
            raise _error("ResourceNotFoundException", "DeleteOauth2CredentialProvider")
        self.providers.remove(kwargs["name"])
        return {}


def env(signer: ProfileSigner, catalog: dict[str, str]) -> dict[str, str]:
    return {
        "MANGO_NAMESPACE": NS,
        "AWS_REGION": REGION,
        "MANGO_ACCOUNT_ID": ACCOUNT,
        "MANGO_STACK_ID": STACK_ID,
        "SETTINGS_TABLE": SETTINGS_TABLE,
        "AUDIT_STREAM": "Mango-test-Audit",
        "AUDIT_INDEX_TABLE": AUDIT_TABLE,
        "PACKS_BUCKET": BUCKET,
        "REMOTE_CATALOG": json.dumps(catalog),
        "PACK_SIGNING_PUBLIC_KEY": signer.public_pem.decode(),
        "GATEWAY_ID": GATEWAY_ID,
        "POLICY_ENGINE_ID": POLICY_ENGINE_ID,
        "REMOTE_MCP_KEY_ARN": KEY_ARN,
        "REMOTE_RETURN_URL": RETURN_URL,
        "CONNECTOR_TARGETS": json.dumps(["finops", "knowledge"]),
    }


def registration_item(**overrides: Any) -> dict[str, Any]:
    item: dict[str, Any] = {
        **remote_mcp.registration_key(REG),
        "status": {"S": "approved"},
        "approval_id": {"S": APPROVAL},
        "profile_id": {"S": "azure-devops"},
        "organization": {"S": ORG},
        "toolsets": {"L": [{"S": "wit"}, {"S": "wiki"}]},
        "change_id": {"S": CHANGE},
        "change_kind": {"S": "enable"},
        "version": {"N": "3"},
        "requested_by": {"S": "user-a"},
        "approved_by": {"S": "user-b"},
        # What mango-api owns and the provisioner never needs (nor its IAM lets it write).
        "tenant_id": {"S": "00000000-0000-0000-0000-000000000000"},
    }
    item.update(overrides)
    return {k: v for k, v in item.items() if v is not None}


def change_item(digest: str, **overrides: Any) -> dict[str, Any]:
    item: dict[str, Any] = {
        **remote_mcp.change_key(REG, CHANGE),
        "status": {"S": "approved"},
        "kind": {"S": "enable"},
        "profile_sha256": {"S": digest},
        "toolsets": {"L": [{"S": "wit"}, {"S": "wiki"}]},
        "pending_provider_name": {"S": remote_mcp.provider_name(NS, REG, 1)},
    }
    item.update(overrides)
    return {k: v for k, v in item.items() if v is not None}


def make_tables(dynamodb: Any) -> None:
    for name in (SETTINGS_TABLE, AUDIT_TABLE):
        dynamodb.create_table(
            TableName=name,
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )


class Clock:
    def __init__(self) -> None:
        self.now = NOW

    def __call__(self) -> datetime:
        self.now += timedelta(seconds=1)
        return self.now


def decode_payload(item: dict[str, Any]) -> dict[str, Any]:
    text = item["payload"]["S"]
    return dict(json.loads(base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))))


ACTION_RE = re.compile(r'AgentCore::Action::"([^"]+)"')

ENABLE_STEPS = (
    "ensure_return_url",
    ("ensure_target", "check_target"),
    ("ensure_policies", "check_policies"),
    "sign_item",
    "mark_active",
)


class RemoteLab:
    """The remote provisioner over moto and the fakes, with what mango-api would write."""

    def __init__(self) -> None:
        self.db = boto3.client("dynamodb", region_name=REGION)
        make_tables(self.db)
        self.s3 = boto3.client("s3", region_name=REGION)
        self.s3.create_bucket(Bucket=BUCKET)
        self.signer = ProfileSigner()
        self.agentcore = FakeAgentCore()
        self.kms = FakeKms()
        self.firehose = FakeFirehose()
        self.clock = Clock()
        self.statement = self.signer.statement()
        self.digest = self.publish(self.statement)
        self.build({"azure-devops": self.digest})
        self.executions = 0

    def publish(self, statement: RemoteProfileStatement, envelope: bytes | None = None) -> str:
        digest = digest_of(statement)
        self.s3.put_object(
            Bucket=BUCKET,
            Key=f"remotes/{statement.profile.id}/{digest}.json",
            Body=envelope or self.signer.envelope(statement),
        )
        return digest

    def build(self, catalog: dict[str, str], public_key: bytes | None = None) -> None:
        environment = env(self.signer, catalog)
        if public_key is not None:
            environment["PACK_SIGNING_PUBLIC_KEY"] = public_key.decode()
        self.settings = RemoteSettings.from_env(environment)
        self.store = RemoteStore(self.db, SETTINGS_TABLE, NS)
        self.provisioner = RemoteProvisioner(
            self.settings,
            store=self.store,
            release=RemoteRelease(self.s3, self.settings),
            gateway=RemoteGateway(self.agentcore, self.settings),  # type: ignore[arg-type]
            identity=RemoteIdentity(self.agentcore, self.settings),  # type: ignore[arg-type]
            signer=CatalogSigner(self.kms, self.settings),  # type: ignore[arg-type]
            audit=AuditWriter(self.firehose, "Mango-test-Audit", self.db, AUDIT_TABLE),  # type: ignore[arg-type]
            clock=self.clock,
        )

    # --- What mango-api would have written ---

    def put(self, item: dict[str, Any]) -> None:
        self.db.put_item(TableName=SETTINGS_TABLE, Item=item)

    def approve(self, approval_id: str = APPROVAL, **overrides: Any) -> dict[str, Any]:
        self.put(registration_item(approval_id={"S": approval_id}, **overrides))
        return {"registration_id": REG, "approval_id": approval_id}

    def stage_change(self, **overrides: Any) -> None:
        self.put(change_item(self.digest, **overrides))

    def registration(self) -> dict[str, Any]:
        item = self.db.get_item(
            TableName=SETTINGS_TABLE, Key=remote_mcp.registration_key(REG), ConsistentRead=True
        ).get("Item")
        assert item is not None
        return dict(item)

    def approved(self) -> dict[str, Any] | None:
        item = self.db.get_item(
            TableName=SETTINGS_TABLE, Key=remote_mcp.approved_key(REG), ConsistentRead=True
        ).get("Item")
        return dict(item) if item else None

    def events(self) -> list[tuple[str, str]]:
        return [(r["event"], r["detail"]["outcome"]) for r in self.firehose.records]

    # --- The state machine ---

    def _wait(self, ensure: str, check: str, state: dict[str, Any]) -> dict[str, Any]:
        state = getattr(self.provisioner, ensure)(state)
        for _ in range(20):
            state = getattr(self.provisioner, check)(state)
            if state["ready"]:
                return state
        raise AssertionError(f"{check} never ready")

    def _retrying(self, step: str, state: dict[str, Any]) -> dict[str, Any]:
        for _ in range(20):
            try:
                result: dict[str, Any] = getattr(self.provisioner, step)(state)
            except StepError as exc:
                if type(exc).__name__ != "RetryableError":
                    raise
                continue
            return result
        raise AssertionError(f"{step} never finished")

    def run(self, execution_input: dict[str, Any], execution: str | None = None) -> dict[str, Any]:
        """One execution as the state machine runs it, compensation included."""
        self.executions += 1
        execution = execution or f"exec-{self.executions}"
        state: dict[str, Any] = {}
        last = "load"
        try:
            state = self.provisioner.load(execution_input, execution)
            state["execution"] = execution
            if state["action"] == "noop":
                return state
            if state["action"] == "disable":
                last = "remove"
                return self._retrying("remove", state)
            for step in ENABLE_STEPS:
                if isinstance(step, tuple):
                    last = step[1]
                    state = self._wait(*step, state)
                else:
                    last = step
                    state = getattr(self.provisioner, step)(state)
            return state  # noqa: TRY300 - the failure path below needs `state` and `last`
        except StepError as exc:
            message = json.dumps({"step": last, "code": exc.code})
            failed = {
                **execution_input,
                **state,
                "execution": execution,
                "error": {
                    "Error": "ProvisionerStepError",
                    "Cause": json.dumps({"errorMessage": message}),
                },
            }
            try:
                failed = self._retrying("compensate", failed)
            except StepError as compensation:
                # The state machine catches it and still marks the failure.
                failed["compensation_error"] = {"Error": compensation.code}
            return self.provisioner.mark_failed(failed)
