"""Shared fixtures: moto for DynamoDB and IAM, and an in-memory AgentCore control plane.

The fake AgentCore validates every request against the real botocore model, so a wrong
parameter name or shape fails here as it would against AWS. Its asynchronous behaviour
(``CREATING`` -> ``READY``, endpoints, slow deletions) follows what was observed in the lab.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.validate import validate_parameters
from moto import mock_aws

from mango_core.agents import AgentDefinition, content_hash, dumps_definition
from mango_core.agents_table import meta_key, version_key
from mango_provisioner.audit import AuditWriter
from mango_provisioner.config import Settings
from mango_provisioner.harness import Harnesses
from mango_provisioner.role import AgentRoles
from mango_provisioner.runtime_logs import RuntimeLogs
from mango_provisioner.steps import Provisioner
from mango_provisioner.store import ProvisionerStore

REGION = "us-east-1"
ACCOUNT = "123456789012"
NS = "test"
AGENTS_TABLE = "Mango-test-Agents"
SETTINGS_TABLE = "Mango-test-Settings"
AUDIT_TABLE = "Mango-test-AuditIndex"
BOUNDARY_ARN = f"arn:aws:iam::{ACCOUNT}:policy/Mango-{NS}-agent-boundary"
LOGS_KEY_ARN = f"arn:aws:kms:{REGION}:{ACCOUNT}:key/11111111-2222-3333-4444-555555555555"
MODEL = "us.anthropic.claude-sonnet-4-6"
MODEL_2 = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
DISABLED_MODEL = "us.anthropic.retired-model"
AGENT = "abcdefghijklmnop"
NOW = datetime(2026, 10, 1, 15, 0, tzinfo=UTC)
PROMPT = "You are a careful analyst. SECRET-PROMPT-MARKER"

RELEASE_PROMPT = "You are the agent that ships with the release."


def release_definition(**overrides: Any) -> AgentDefinition:
    return make_definition(**{"name": "FinOps", "system_prompt": RELEASE_PROMPT, **overrides})


ENV = {
    "MANGO_NAMESPACE": NS,
    "MANGO_ACCOUNT_ID": ACCOUNT,
    "AWS_REGION": REGION,
    "AGENTS_TABLE": AGENTS_TABLE,
    "SETTINGS_TABLE": SETTINGS_TABLE,
    "AUDIT_STREAM": "Mango-test-Audit",
    "AUDIT_INDEX_TABLE": AUDIT_TABLE,
    "AGENT_BOUNDARY_ARN": BOUNDARY_ARN,
    "GATEWAY_URL": "https://mango-test-tools-abc123.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
    "GUARDRAIL_ID": "gr123456",
    "GUARDRAIL_VERSION": "1",
    "RUNTIME_LOGS_KEY_ARN": LOGS_KEY_ARN,
    "AGENT_SESSION_IDLE_SECONDS": "300",
    "AGENT_SESSION_MAX_SECONDS": "28800",
    "RELEASE_AGENTS": "{}",
    "CONNECTOR_CATALOG": json.dumps(
        {
            "cost-explorer": {
                "target": "finops",
                "tools": {"get_cost_and_usage": "read", "list_accounts_in_scope": "read"},
            },
            "tickets": {"target": "tickets", "tools": {"close_ticket": "write"}},
        }
    ),
}


def make_definition(**overrides: Any) -> AgentDefinition:
    base: dict[str, Any] = {
        "name": "Analista",
        "reports_to": "platform",
        "role": "Costos",
        "model": MODEL,
        "allowed_models": [MODEL],
        "system_prompt": PROMPT,
        "tools": ["cost-explorer.get_cost_and_usage"],
        "groups": ["finops-central"],
        "limits": {"max_tokens_per_call": 4000, "temperature": 0.2},
    }
    return AgentDefinition.model_validate({**base, **overrides})


def _error(code: str, operation: str, message: str = "") -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": message}}, operation)


class FakeAgentCore:
    """Enough of ``bedrock-agentcore-control`` for the provisioner, validated by botocore."""

    def __init__(self) -> None:
        self._model = boto3.client(
            "bedrock-agentcore-control",
            region_name=REGION,
            aws_access_key_id="x",
            aws_secret_access_key="x",
        ).meta.service_model
        self.harnesses: dict[str, dict[str, Any]] = {}
        self.calls: list[str] = []
        self.polls_until_ready = 1
        self.polls_until_deleted = 1
        self.fail_next: dict[str, ClientError] = {}
        self.fail_harness_creation = False
        self.tokens: dict[str, Any] = {}

    def _enter(self, operation: str, kwargs: dict[str, Any]) -> None:
        validate_parameters(kwargs, self._model.operation_model(operation).input_shape)
        self.calls.append(operation)
        if operation in self.fail_next:
            raise self.fail_next.pop(operation)

    def _harness(self, harness_id: str, operation: str) -> dict[str, Any]:
        if harness_id not in self.harnesses:
            raise _error("ResourceNotFoundException", operation)
        return self.harnesses[harness_id]

    @staticmethod
    def _view(harness: dict[str, Any], version: dict[str, Any]) -> dict[str, Any]:
        out = {
            "harnessId": harness["id"],
            "harnessName": harness["name"],
            "arn": f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:harness/{harness['id']}",
            "status": "DELETING" if harness["deleting"] else version["status"],
            "harnessVersion": version["number"],
            **version["config"],
        }
        runtime: dict[str, Any] = {"agentRuntimeName": f"harness_{harness['name']}"}
        if version["status"] == "READY":
            runtime["agentRuntimeId"] = harness["runtime_id"]
        out["environment"] = {"agentCoreRuntimeEnvironment": runtime}
        return out

    def _advance(self, item: dict[str, Any], failed: bool = False) -> None:
        if item["status"] in {"CREATING", "UPDATING"}:
            item["polls"] += 1
            if item["polls"] >= self.polls_until_ready:
                item["status"] = item["status"].replace("ING", "E_FAILED") if failed else "READY"
                if "target" in item and not failed:
                    item["live"], item["target"] = item["target"], None

    # --- Harness ---

    def create_harness(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("CreateHarness", kwargs)
        token = kwargs["clientToken"]
        if token in self.tokens:
            return {"harness": self._view(*self.tokens[token])}
        name = kwargs.pop("harnessName")
        if any(h["name"] == name for h in self.harnesses.values()):
            raise _error("ConflictException", "CreateHarness")
        suffix = f"{len(self.harnesses) + 1:010d}"
        config = {k: v for k, v in kwargs.items() if k not in {"clientToken", "tags"}}
        version = {"number": "1", "status": "CREATING", "polls": 0, "config": config}
        harness = {
            "id": f"{name}-{suffix}",
            "name": name,
            "runtime_id": f"harness_{name}-{suffix}",
            "tags": kwargs["tags"],
            "versions": [version],
            "endpoint": None,
            "extra_endpoints": {},
            "deleting": False,
            "delete_polls": 0,
            "list_polls": 0,
        }
        self.harnesses[harness["id"]] = harness
        self.tokens[token] = (harness, version)
        return {"harness": self._view(harness, version)}

    def update_harness(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("UpdateHarness", kwargs)
        harness = self._harness(kwargs.pop("harnessId"), "UpdateHarness")
        token = kwargs.pop("clientToken")
        if token in self.tokens:
            return {"harness": self._view(*self.tokens[token])}
        if harness["versions"][-1]["status"] in {"CREATING", "UPDATING"}:
            raise _error("ConflictException", "UpdateHarness")
        kwargs["memory"] = kwargs["memory"]["optionalValue"]
        # Fields that are not sent keep their previous value: the provisioner must send all.
        config = {**harness["versions"][-1]["config"], **kwargs}
        version = {
            "number": str(len(harness["versions"]) + 1),
            "status": "UPDATING",
            "polls": 0,
            "config": config,
        }
        harness["versions"].append(version)
        self.tokens[token] = (harness, version)
        return {"harness": self._view(harness, version)}

    def get_harness(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("GetHarness", kwargs)
        harness = self._harness(kwargs["harnessId"], "GetHarness")
        if harness["deleting"]:
            harness["delete_polls"] += 1
            if harness["delete_polls"] > 1:
                del self.harnesses[harness["id"]]
                raise _error("ResourceNotFoundException", "GetHarness")
        number = kwargs.get("harnessVersion")
        version = (
            harness["versions"][-1]
            if number is None
            else next(v for v in harness["versions"] if v["number"] == number)
        )
        self._advance(version, failed=self.fail_harness_creation)
        return {"harness": self._view(harness, version)}

    def delete_harness(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("DeleteHarness", kwargs)
        harness = self._harness(kwargs["harnessId"], "DeleteHarness")
        if harness["endpoint"] is not None or harness["extra_endpoints"]:
            raise _error("ConflictException", "DeleteHarness")
        harness["deleting"] = True
        return {}

    def get_paginator(self, name: str) -> Any:
        assert name in {"list_harnesses", "list_harness_endpoints"}
        fake = self

        class Paginator:
            def paginate(self, **kwargs: Any) -> Iterator[dict[str, Any]]:
                if name == "list_harness_endpoints":
                    yield fake._list_endpoints(kwargs)
                    return
                fake._enter("ListHarnesses", kwargs)
                # Whoever only lists (the deprovisioner) sees a deletion finish too.
                for harness in list(fake.harnesses.values()):
                    if harness["deleting"]:
                        harness["list_polls"] += 1
                        if harness["list_polls"] > fake.polls_until_deleted:
                            del fake.harnesses[harness["id"]]
                yield {
                    "harnesses": [
                        {
                            "harnessId": h["id"],
                            "harnessName": h["name"],
                            "status": "DELETING" if h["deleting"] else h["versions"][-1]["status"],
                        }
                        for h in fake.harnesses.values()
                    ]
                }

        return Paginator()

    def _list_endpoints(self, kwargs: dict[str, Any]) -> dict[str, Any]:
        """``DEFAULT`` (AgentCore's own), ``live`` and any other endpoint of the harness."""
        self._enter("ListHarnessEndpoints", kwargs)
        harness = self._harness(kwargs["harnessId"], "ListHarnessEndpoints")
        named = {**harness["extra_endpoints"]}
        if harness["endpoint"] is not None:
            named["live"] = harness["endpoint"]
        for endpoint_name, endpoint in list(named.items()):
            if endpoint["status"] == "DELETING":
                endpoint["polls"] += 1
                if endpoint["polls"] > self.polls_until_deleted:
                    del named[endpoint_name]
                    if endpoint_name == "live":
                        harness["endpoint"] = None
                    else:
                        del harness["extra_endpoints"][endpoint_name]
        return {
            "endpoints": [
                {"endpointName": "DEFAULT", "status": "READY"},
                *({"endpointName": n, "status": e["status"]} for n, e in sorted(named.items())),
            ]
        }

    # --- `live` endpoint ---

    def _endpoint_view(self, endpoint: dict[str, Any]) -> dict[str, Any]:
        out = {"endpointName": "live", "status": endpoint["status"]}
        if endpoint["live"]:
            out["liveVersion"] = endpoint["live"]
        if endpoint["target"]:
            out["targetVersion"] = endpoint["target"]
        return out

    def get_harness_endpoint(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("GetHarnessEndpoint", kwargs)
        harness = self._harness(kwargs["harnessId"], "GetHarnessEndpoint")
        endpoint = harness["endpoint"]
        if endpoint is None:
            raise _error("ResourceNotFoundException", "GetHarnessEndpoint")
        if endpoint["status"] == "DELETING":
            endpoint["polls"] += 1
            if endpoint["polls"] > 1:
                harness["endpoint"] = None
                raise _error("ResourceNotFoundException", "GetHarnessEndpoint")
        self._advance(endpoint)
        return {"endpoint": self._endpoint_view(endpoint)}

    def create_harness_endpoint(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("CreateHarnessEndpoint", kwargs)
        harness = self._harness(kwargs["harnessId"], "CreateHarnessEndpoint")
        assert kwargs["endpointName"] == "live"
        harness["endpoint"] = {
            "status": "CREATING",
            "live": None,
            "target": kwargs["targetVersion"],
            "polls": 0,
        }
        return {"endpoint": self._endpoint_view(harness["endpoint"])}

    def update_harness_endpoint(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("UpdateHarnessEndpoint", kwargs)
        endpoint = self._harness(kwargs["harnessId"], "UpdateHarnessEndpoint")["endpoint"]
        endpoint.update(status="UPDATING", target=kwargs["targetVersion"], polls=0)
        return {"endpoint": self._endpoint_view(endpoint)}

    def delete_harness_endpoint(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("DeleteHarnessEndpoint", kwargs)
        harness = self._harness(kwargs["harnessId"], "DeleteHarnessEndpoint")
        name = kwargs["endpointName"]
        endpoint = harness["endpoint"] if name == "live" else harness["extra_endpoints"].get(name)
        if endpoint is None:
            raise _error("ResourceNotFoundException", "DeleteHarnessEndpoint")
        endpoint.update(status="DELETING", polls=0)
        return {}

    # --- Test helpers ---

    def only(self) -> dict[str, Any]:
        (harness,) = self.harnesses.values()
        return harness


class FakeLogs:
    def __init__(self) -> None:
        self.groups: dict[str, dict[str, Any]] = {}
        self.deleted: list[str] = []

    def create_log_group(self, **kwargs: Any) -> None:
        name = kwargs["logGroupName"]
        if name in self.groups:
            raise _error("ResourceAlreadyExistsException", "CreateLogGroup")
        self.groups[name] = {"kms": kwargs["kmsKeyId"], "tags": kwargs["tags"]}

    def associate_kms_key(self, **kwargs: Any) -> None:
        self.groups[kwargs["logGroupName"]]["kms"] = kwargs["kmsKeyId"]

    def put_retention_policy(self, **kwargs: Any) -> None:
        self.groups[kwargs["logGroupName"]]["retention"] = kwargs["retentionInDays"]

    def delete_log_group(self, **kwargs: Any) -> None:
        name = kwargs["logGroupName"]
        if name not in self.groups:
            raise _error("ResourceNotFoundException", "DeleteLogGroup")
        del self.groups[name]
        self.deleted.append(name)


class FakeFirehose:
    def __init__(self) -> None:
        self.records: list[dict[str, Any]] = []
        self.fail = False

    def put_record(self, **kwargs: Any) -> None:
        if self.fail:
            raise _error("ServiceUnavailableException", "PutRecord")
        self.records.append(json.loads(kwargs["Record"]["Data"]))


class Lab:
    """Everything a test needs: the provisioner, its fakes and helpers to stage versions."""

    def __init__(self, dynamodb: Any, iam: Any) -> None:
        self.db = dynamodb
        self.iam = iam
        self.settings = Settings.from_env(ENV)
        self.agentcore = FakeAgentCore()
        self.logs = FakeLogs()
        self.firehose = FakeFirehose()
        self.now = NOW
        self.store = ProvisionerStore(dynamodb, AGENTS_TABLE, SETTINGS_TABLE)
        self.provisioner = Provisioner(
            self.settings,
            store=self.store,
            roles=AgentRoles(iam, self.settings),
            harnesses=Harnesses(self.agentcore, self.settings),  # type: ignore[arg-type]
            logs=RuntimeLogs(self.logs, self.settings),  # type: ignore[arg-type]
            audit=AuditWriter(self.firehose, "Mango-test-Audit", dynamodb, AUDIT_TABLE),  # type: ignore[arg-type]
            clock=lambda: self.now,
        )

    # --- What mango-api would have written ---

    def approve(
        self,
        definition: AgentDefinition,
        *,
        agent_id: str = AGENT,
        version: int = 1,
        approved_by: str = "admin-2",
    ) -> dict[str, Any]:
        """Stage ``version`` as approved (and the open one). Returns the execution input."""
        canonical = dumps_definition(definition)
        digest = content_hash(canonical)
        self.db.put_item(
            TableName=AGENTS_TABLE,
            Item={
                **version_key(agent_id, version),
                "agent_id": {"S": agent_id},
                "n": {"N": str(version)},
                "status": {"S": "approved"},
                "definition": {"S": canonical},
                "content_hash": {"S": digest},
                "created_by": {"S": "creator-1"},
                "approved_by": {"S": approved_by},
            },
        )
        if version == 1:
            self.db.put_item(
                TableName=AGENTS_TABLE,
                Item={
                    **meta_key(agent_id),
                    "agent_id": {"S": agent_id},
                    "status": {"S": "draft"},
                    "version": {"N": "1"},
                    "latest_version": {"N": "1"},
                    "open_version": {"N": "1"},
                },
            )
        else:
            self.db.update_item(
                TableName=AGENTS_TABLE,
                Key=meta_key(agent_id),
                UpdateExpression="SET open_version = :n, latest_version = :n",
                ExpressionAttributeValues={":n": {"N": str(version)}},
            )
        return {"agent_id": agent_id, "version": version, "content_hash": digest}

    def ship(self, agents: dict[str, str]) -> None:
        """What the stack says this release ships approved: ``{agent id: content hash}``."""
        self.provisioner._settings = replace(self.settings, release_agents=agents)

    def item(self, key: dict[str, Any]) -> dict[str, Any]:
        return self.db.get_item(TableName=AGENTS_TABLE, Key=key, ConsistentRead=True)["Item"]

    def meta(self, agent_id: str = AGENT) -> dict[str, Any]:
        return self.item(meta_key(agent_id))

    def version(self, number: int, agent_id: str = AGENT) -> dict[str, Any]:
        return self.item(version_key(agent_id, number))

    def role_models(self, agent_id: str = AGENT) -> list[str]:
        document = self.iam.get_role_policy(
            RoleName=self.settings.role_name(agent_id), PolicyName="agent"
        )["PolicyDocument"]
        return list(document["Statement"][0]["Resource"])

    def role_exists(self, agent_id: str = AGENT) -> bool:
        try:
            self.iam.get_role(RoleName=self.settings.role_name(agent_id))
        except ClientError:
            return False
        return True

    # --- The state machine, in Python ---

    def run(
        self, execution_input: dict[str, Any], execution: str = "exec-1", fail_at: str | None = None
    ) -> dict[str, Any]:
        """Run the steps in the order of the state machine, with its failure path."""
        p = self.provisioner
        state: dict[str, Any] = execution_input
        last = "start"

        def call(name: str, step: Any, *args: Any) -> dict[str, Any]:
            if fail_at == name:
                raise RuntimeError("boom")
            return {**step(*args), "last_step": name}

        try:
            state = call("load", p.load, state, execution)
            if state["action"] == "noop":
                return state
            state = call("ensure_role", p.ensure_role, state)
            state = call("ensure_harness", p.ensure_harness, state)
            while not state["ready"]:
                state = call("check_harness", p.check_harness, state)
            state = call("point_live", p.point_live, state)
            while not state["ready"]:
                state = call("check_live", p.check_live, state)
            state = call("govern_logs", p.govern_logs, state)
            return call("publish", p.publish, state)
        except Exception as exc:  # noqa: BLE001 - like the state machine's catch-all
            code = getattr(exc, "code", type(exc).__name__)
            step = fail_at or f"after_{state.get('last_step', last)}"
            cause = json.dumps({"errorMessage": json.dumps({"step": step, "code": code})})
            state = {**state, "execution": execution, "error": {"Error": "X", "Cause": cause}}
            for _ in range(10):
                try:
                    state = p.compensate(state)
                    break
                except Exception as retry:  # noqa: BLE001
                    if type(retry).__name__ != "RetryableError":
                        state = {**state, "compensation_error": {"Error": "X"}}
                        break
            return p.mark_failed(state)


def _table(client: Any, name: str) -> None:
    client.create_table(
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


@pytest.fixture
def aws(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)
    with mock_aws():
        yield


@pytest.fixture
def lab(aws: None) -> Lab:
    dynamodb = boto3.client("dynamodb", region_name=REGION)
    for name in (AGENTS_TABLE, SETTINGS_TABLE, AUDIT_TABLE):
        _table(dynamodb, name)
    models = [
        {"id": MODEL, "enabled": True},
        {"id": MODEL_2, "enabled": True},
        {"id": DISABLED_MODEL, "enabled": False},
    ]
    dynamodb.put_item(
        TableName=SETTINGS_TABLE,
        Item={
            "PK": {"S": "MODELS"},
            "SK": {"S": "CATALOG"},
            "models": {"S": json.dumps(models)},
            "version": {"N": "1"},
        },
    )
    iam = boto3.client("iam", region_name=REGION)
    iam.create_policy(
        PolicyName=f"Mango-{NS}-agent-boundary",
        PolicyDocument=json.dumps(
            {
                "Version": "2012-10-17",
                "Statement": [{"Effect": "Allow", "Action": "bedrock:*", "Resource": "*"}],
            }
        ),
    )
    return Lab(dynamodb, iam)


@pytest.fixture
def packlab(aws: None) -> Any:
    """Lab of the pack provisioner (``pack_lab.PackLab``)."""
    from .pack_lab import make_packlab  # noqa: PLC0415 - pack_lab imports this module

    return make_packlab()
