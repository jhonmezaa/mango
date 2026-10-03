"""Shared fixtures: moto for DynamoDB and IAM, and an in-memory AgentCore control plane.

``Lab.publish`` stages an agent the way the provisioner leaves it (table items through the
real ``publish_items`` builder, role with boundary and trust, harness with its markers and the
``live`` endpoint), so every test starts from an installation with nothing to report.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.validate import validate_parameters
from moto import mock_aws

from mango_core.agents_table import creator_pk, day_sk, meta_key, publish_items, version_key
from mango_reconciler.checks import Report
from mango_reconciler.config import Settings
from mango_reconciler.handler import Reconciler

REGION = "us-east-1"
ACCOUNT = "123456789012"
NS = "test"
AGENTS_TABLE = "Mango-test-Agents"
BOUNDARY_ARN = f"arn:aws:iam::{ACCOUNT}:policy/Mango-{NS}-agent-boundary"
AGENT = "abcdefghijklmnop"
OTHER = "qrstuvwxyz234567"
NOW = datetime(2026, 10, 2, 7, 0, tzinfo=UTC)
HASH = "a" * 64
PROMPT_MARKER = "SECRET-PROMPT-MARKER"

ENV = {
    "MANGO_NAMESPACE": NS,
    "MANGO_ACCOUNT_ID": ACCOUNT,
    "AWS_REGION": REGION,
    "AGENTS_TABLE": AGENTS_TABLE,
    "AGENT_BOUNDARY_ARN": BOUNDARY_ARN,
    "RELEASE_AGENTS": json.dumps({"finops": "a" * 64}),
}


def _error(code: str, operation: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": ""}}, operation)


class FakeAgentCore:
    """The read side of ``bedrock-agentcore-control``, validated against the botocore model."""

    def __init__(self) -> None:
        self._model = boto3.client(
            "bedrock-agentcore-control",
            region_name=REGION,
            aws_access_key_id="x",
            aws_secret_access_key="x",
        ).meta.service_model
        self.harnesses: dict[str, dict[str, Any]] = {}
        self.runtimes: dict[str, dict[str, Any]] = {}
        self.calls: list[str] = []
        self.fail: dict[str, ClientError] = {}

    def _enter(self, operation: str, kwargs: dict[str, Any]) -> None:
        validate_parameters(kwargs, self._model.operation_model(operation).input_shape)
        self.calls.append(operation)
        if operation in self.fail:
            raise self.fail[operation]

    def add(self, name: str, suffix: str = "0000000001") -> dict[str, Any]:
        harness = {"id": f"{name}-{suffix}", "name": name, "versions": {}, "live": None}
        self.harnesses[harness["id"]] = harness
        return harness

    @staticmethod
    def add_version(
        harness: dict[str, Any], *, role_arn: str, markers: dict[str, str], status: str = "READY"
    ) -> str:
        number = str(len(harness["versions"]) + 1)
        harness["versions"][number] = {
            "status": status,
            "executionRoleArn": role_arn,
            "environmentVariables": {"OTEL_X": "1", **markers},
        }
        return number

    def add_runtime(
        self,
        name: str,
        networks: tuple[str | None, ...] = ("VPC",),
        *,
        live: str | None = "latest",
        suffix: str = "0000000001",
    ) -> dict[str, Any]:
        """A runtime with one version per entry of ``networks`` (``None``: AgentCore reports
        no network). ``live`` is the version its ``live`` endpoint serves: the latest, a
        version number or ``None`` for a runtime without that endpoint."""
        versions = {
            str(number): ({"networkConfiguration": {"networkMode": mode}} if mode else {})
            for number, mode in enumerate(networks, start=1)
        }
        runtime = {
            "id": f"{name}-{suffix}",
            "name": name,
            "versions": versions,
            "live": str(len(versions)) if live == "latest" else live,
        }
        self.runtimes[runtime["id"]] = runtime
        return runtime

    def get_paginator(self, name: str) -> Any:
        assert name in {"list_harnesses", "list_agent_runtimes"}
        fake = self

        class Paginator:
            def paginate(self) -> Iterator[dict[str, Any]]:
                if name == "list_agent_runtimes":
                    fake._enter("ListAgentRuntimes", {})
                    key = "agentRuntimes"
                    items = [
                        {"agentRuntimeId": r["id"], "agentRuntimeName": r["name"]}
                        for r in fake.runtimes.values()
                    ]
                else:
                    fake._enter("ListHarnesses", {})
                    key = "harnesses"
                    items = [
                        {"harnessId": h["id"], "harnessName": h["name"]}
                        for h in fake.harnesses.values()
                    ]
                # Two pages: the reader must follow pagination.
                yield {key: items[:1]}
                yield {key: items[1:]}

        return Paginator()

    def get_agent_runtime(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("GetAgentRuntime", kwargs)
        runtime = self.runtimes.get(kwargs["agentRuntimeId"])
        if runtime is None:
            raise _error("ResourceNotFoundException", "GetAgentRuntime")
        number = kwargs.get("agentRuntimeVersion") or str(len(runtime["versions"]))
        if number not in runtime["versions"]:
            raise _error("ResourceNotFoundException", "GetAgentRuntime")
        return {
            "agentRuntimeId": runtime["id"],
            "agentRuntimeName": runtime["name"],
            "agentRuntimeVersion": number,
            "status": "READY",
            **runtime["versions"][number],
        }

    def get_agent_runtime_endpoint(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("GetAgentRuntimeEndpoint", kwargs)
        assert kwargs["endpointName"] == "live"
        runtime = self.runtimes.get(kwargs["agentRuntimeId"])
        if runtime is None or runtime["live"] is None:
            raise _error("ResourceNotFoundException", "GetAgentRuntimeEndpoint")
        return {"name": "live", "status": "READY", "liveVersion": runtime["live"]}

    def get_harness(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("GetHarness", kwargs)
        harness = self.harnesses.get(kwargs["harnessId"])
        if harness is None:
            raise _error("ResourceNotFoundException", "GetHarness")
        number = kwargs.get("harnessVersion") or str(len(harness["versions"]))
        if number not in harness["versions"]:
            raise _error("ResourceNotFoundException", "GetHarness")
        return {
            "harness": {
                "harnessId": harness["id"],
                "harnessName": harness["name"],
                "harnessVersion": number,
                **harness["versions"][number],
            }
        }

    def get_harness_endpoint(self, **kwargs: Any) -> dict[str, Any]:
        self._enter("GetHarnessEndpoint", kwargs)
        assert kwargs["endpointName"] == "live"
        harness = self.harnesses.get(kwargs["harnessId"])
        if harness is None or harness["live"] is None:
            raise _error("ResourceNotFoundException", "GetHarnessEndpoint")
        return {"endpoint": {"endpointName": "live", **harness["live"]}}


class Lab:
    def __init__(self, dynamodb: Any, iam: Any) -> None:
        self.db = dynamodb
        self.iam = iam
        self.settings = Settings.from_env(ENV)
        self.agentcore = FakeAgentCore()
        self.now = NOW
        self.reconciler = Reconciler(
            self.settings, dynamodb=dynamodb, agentcore=self.agentcore, iam=iam
        )

    def run(self) -> Report:
        return self.reconciler.run(self.now)

    def codes(self) -> list[str]:
        return sorted(f.code for f in self.run().findings)

    # --- What mango-api writes ---

    def put_meta(self, agent_id: str, **attributes: dict[str, str]) -> None:
        self.db.put_item(
            TableName=AGENTS_TABLE,
            Item={
                **meta_key(agent_id),
                "status": {"S": "draft"},
                "version": {"N": "1"},
                "open_version": {"N": "1"},
                **attributes,
            },
        )

    def put_version(
        self,
        agent_id: str,
        number: int,
        status: str,
        *,
        at: datetime | None = None,
        creator: str = "creator-1",
        content_hash: str | None = HASH,
    ) -> None:
        item = {
            **version_key(agent_id, number),
            "n": {"N": str(number)},
            "status": {"S": status},
            "definition": {"S": json.dumps({"system_prompt": PROMPT_MARKER})},
            "created_by": {"S": creator},
            "status_at": {"S": (at or self.now - timedelta(days=2)).isoformat()},
        }
        if content_hash:
            item["content_hash"] = {"S": content_hash}
        self.db.put_item(TableName=AGENTS_TABLE, Item=item)

    def put_submissions(self, creator: str, count: int) -> None:
        self.db.put_item(
            TableName=AGENTS_TABLE,
            Item={
                "PK": {"S": creator_pk(creator)},
                "SK": {"S": day_sk(self.now.date())},
                "submissions": {"N": str(count)},
                "ttl": {"N": "1"},
            },
        )

    def update_meta(
        self,
        agent_id: str,
        expression: str,
        values: dict[str, Any],
        names: dict[str, str] | None = None,
    ) -> None:
        self.db.update_item(
            TableName=AGENTS_TABLE,
            Key=meta_key(agent_id),
            UpdateExpression=expression,
            ExpressionAttributeValues=values,
            **({"ExpressionAttributeNames": names} if names else {}),
        )

    # --- What the provisioner leaves behind ---

    def create_role(self, agent_id: str, *, boundary: str | None = BOUNDARY_ARN) -> str:
        name = self.settings.role_name(agent_id)
        extra = {"PermissionsBoundary": boundary} if boundary else {}
        self.iam.create_role(
            RoleName=name,
            AssumeRolePolicyDocument=json.dumps(self.settings.trust_policy(agent_id)),
            **extra,
        )
        self.iam.put_role_policy(
            RoleName=name,
            PolicyName="agent",
            PolicyDocument=json.dumps(
                {
                    "Version": "2012-10-17",
                    "Statement": [
                        {"Effect": "Allow", "Action": "bedrock:InvokeModel", "Resource": "*"}
                    ],
                }
            ),
        )
        return name

    def markers(self, agent_id: str, version: int, content_hash: str = HASH) -> dict[str, str]:
        return {
            "MANGO_AGENT_ID": agent_id,
            "MANGO_AGENT_VERSION": str(version),
            "MANGO_CONTENT_HASH": content_hash,
            "MANGO_CONFIG_SHA256": "f" * 64,
        }

    def publish(self, agent_id: str = AGENT, version: int = 1) -> dict[str, Any]:
        """A published agent exactly as a successful provisioner execution leaves it."""
        settings = self.settings
        self.put_meta(agent_id)
        self.put_version(agent_id, version, "approved")
        self.create_role(agent_id)
        harness = self.agentcore.add(settings.harness_name(agent_id))
        number = self.agentcore.add_version(
            harness, role_arn=settings.role_arn(agent_id), markers=self.markers(agent_id, version)
        )
        harness["live"] = {"status": "READY", "liveVersion": number}
        self.db.transact_write_items(
            TransactItems=publish_items(
                AGENTS_TABLE,
                agent_id=agent_id,
                version=version,
                content_hash=HASH,
                previous_version=None,
                harness_arn=settings.harness_arn(harness["id"]),
                harness_version=number,
                now=self.now - timedelta(days=1),
            )
        )
        return harness


@pytest.fixture
def lab(monkeypatch: pytest.MonkeyPatch) -> Iterator[Lab]:
    for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(name, "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)
    with mock_aws():
        dynamodb = boto3.client("dynamodb", region_name=REGION)
        dynamodb.create_table(
            TableName=AGENTS_TABLE,
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
            PolicyName=f"Mango-{NS}-agent-boundary",
            PolicyDocument=json.dumps(
                {
                    "Version": "2012-10-17",
                    "Statement": [
                        {"Effect": "Allow", "Action": "bedrock:InvokeModel", "Resource": "*"}
                    ],
                }
            ),
        )
        yield Lab(dynamodb, iam)
