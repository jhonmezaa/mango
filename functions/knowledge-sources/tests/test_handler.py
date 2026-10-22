"""The role of an approved source (D88 (10), (20); TM-K2, TM-K7), against moto IAM and DynamoDB."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import boto3
import pytest
from moto import mock_aws

from mango_knowledge_sources.handler import (
    POLICY_NAME,
    Settings,
    Sources,
    handle,
    role_policy,
    trust_policy,
)

ACCOUNT = "123456789012"
KB = "01JABCDEFGHJKMNPQRSTVWXYZ0"
SRC = "01JABCDEFGHJKMNPQRSTVWXYZ1"
WHOLE = "01JABCDEFGHJKMNPQRSTVWXYZ2"


@dataclass
class Env:
    sources: Sources
    iam: Any
    db: Any
    settings: Settings


def _source(db: Any, src_id: str, status: str, prefix: str = "politicas/") -> None:
    item: dict[str, Any] = {
        "PK": {"S": f"KB#{KB}"},
        "SK": {"S": f"SRC#{src_id}"},
        "kb_id": {"S": KB},
        "src_id": {"S": src_id},
        "bucket": {"S": "docs-rrhh"},
        "status": {"S": status},
    }
    if prefix:
        item["prefix"] = {"S": prefix}
    db.put_item(TableName="knowledge", Item=item)


def _stored(db: Any, src_id: str = SRC) -> dict[str, Any]:
    item: dict[str, Any] = db.get_item(
        TableName="knowledge", Key={"PK": {"S": f"KB#{KB}"}, "SK": {"S": f"SRC#{src_id}"}}
    )["Item"]
    return item


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        iam = boto3.client("iam", region_name="us-east-1")
        db = boto3.client("dynamodb", region_name="us-east-1")
        db.create_table(
            TableName="knowledge",
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
        boundary = iam.create_policy(
            PolicyName="Mango-poc-kbsrc-boundary",
            PolicyDocument=json.dumps(
                {
                    "Version": "2012-10-17",
                    "Statement": [{"Effect": "Allow", "Action": "s3:GetObject", "Resource": "*"}],
                }
            ),
        )["Policy"]["Arn"]
        settings = Settings(
            namespace="poc",
            account_id=ACCOUNT,
            table="knowledge",
            boundary_arn=boundary,
            sync_role_arn=f"arn:aws:iam::{ACCOUNT}:role/Mango-poc-KnowledgeSync",
        )
        yield Env(Sources(settings, iam, db), iam, db, settings)


def _ensure(env: Env, src_id: str = SRC) -> dict[str, Any]:
    return handle({"op": "ensure", "kb_id": KB, "src_id": src_id}, env.sources)


def _delete(env: Env, src_id: str = SRC) -> dict[str, Any]:
    return handle({"op": "delete", "kb_id": KB, "src_id": src_id}, env.sources)


def test_an_approved_source_gets_a_role_of_its_bucket_and_prefix(env: Env) -> None:
    _source(env.db, SRC, "approved")
    result = _ensure(env)
    assert result["outcome"] == "created"
    role = env.iam.get_role(RoleName=f"Mango-poc-kbsrc-{SRC}")["Role"]
    assert result["role_arn"] == role["Arn"]
    assert role["PermissionsBoundary"]["PermissionsBoundaryArn"] == env.settings.boundary_arn
    trust = role["AssumeRolePolicyDocument"]
    trust = json.loads(trust) if isinstance(trust, str) else trust
    assert trust == trust_policy(env.settings)
    policy = env.iam.get_role_policy(RoleName=f"Mango-poc-kbsrc-{SRC}", PolicyName=POLICY_NAME)
    document = policy["PolicyDocument"]
    document = json.loads(document) if isinstance(document, str) else document
    assert document["Statement"] == [
        {
            "Sid": "ListThePrefix",
            "Effect": "Allow",
            "Action": "s3:ListBucket",
            "Resource": "arn:aws:s3:::docs-rrhh",
            "Condition": {"StringLike": {"s3:prefix": ["politicas/*"]}},
        },
        {
            "Sid": "ReadThePrefix",
            "Effect": "Allow",
            "Action": "s3:GetObject",
            "Resource": "arn:aws:s3:::docs-rrhh/politicas/*",
        },
    ]
    assert _stored(env.db)["role_arn"]["S"] == role["Arn"]
    # Again: the same role, the same policy.
    assert _ensure(env)["outcome"] == "exists"


def test_only_the_synchronization_assumes_it_and_only_as_someone(env: Env) -> None:
    statements = trust_policy(env.settings)["Statement"]
    for statement in statements:
        assert statement["Principal"] == {"AWS": f"arn:aws:iam::{ACCOUNT}:root"}
        assert statement["Condition"]["ArnEquals"] == {
            "aws:PrincipalArn": env.settings.sync_role_arn
        }
    assert statements[0]["Condition"]["Null"] == {"sts:SourceIdentity": "false"}


def test_a_whole_bucket_lists_without_a_prefix_condition(env: Env) -> None:
    _source(env.db, WHOLE, "approved", prefix="")
    [listing, reading] = role_policy(env.sources.load(KB, WHOLE))["Statement"]
    assert "Condition" not in listing
    assert reading["Resource"] == "arn:aws:s3:::docs-rrhh/*"


@pytest.mark.parametrize("status", ["pending", "rejected", "withdrawn", "removing"])
def test_nothing_is_created_for_a_source_that_is_not_approved(env: Env, status: str) -> None:
    _source(env.db, SRC, status)
    assert _ensure(env) == {"error": "source_not_approved"}
    assert env.iam.list_roles()["Roles"] == []


def test_a_role_someone_changed_is_never_repaired(env: Env) -> None:
    _source(env.db, SRC, "approved")
    _ensure(env)
    env.iam.update_assume_role_policy(
        RoleName=f"Mango-poc-kbsrc-{SRC}",
        PolicyDocument=json.dumps(
            {
                "Version": "2012-10-17",
                "Statement": [
                    {"Effect": "Allow", "Principal": {"AWS": "*"}, "Action": "sts:AssumeRole"}
                ],
            }
        ),
    )
    assert _ensure(env) == {"error": "role_trust_mismatch"}
    env.iam.delete_role_permissions_boundary(RoleName=f"Mango-poc-kbsrc-{SRC}")
    assert _ensure(env) == {"error": "role_without_boundary"}


def test_a_removed_source_loses_its_role(env: Env) -> None:
    _source(env.db, SRC, "approved")
    _ensure(env)
    # Not while it is approved.
    assert _delete(env) == {"error": "source_not_removed"}
    env.db.update_item(
        TableName="knowledge",
        Key={"PK": {"S": f"KB#{KB}"}, "SK": {"S": f"SRC#{SRC}"}},
        UpdateExpression="SET #s = :r",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":r": {"S": "removing"}},
    )
    assert _delete(env) == {"outcome": "deleted"}
    assert env.iam.list_roles()["Roles"] == []
    assert "role_arn" not in _stored(env.db)
    # Already gone is fine.
    assert _delete(env) == {"outcome": "absent"}


def test_the_event_names_ids_only(env: Env, caplog: pytest.LogCaptureFixture) -> None:
    for event in (
        {"op": "ensure", "kb_id": KB},
        {"op": "drop", "kb_id": KB, "src_id": SRC},
        {"op": "ensure", "kb_id": KB, "src_id": "docs-rrhh"},
        {"op": "ensure", "kb_id": KB, "src_id": SRC, "bucket": "otro"},
    ):
        result = handle(event, env.sources)
        assert result.get("error") in {"invalid_event", "source_not_found"}
    # The bucket of a source never comes from the event.
    _source(env.db, SRC, "approved")
    handle({"op": "ensure", "kb_id": KB, "src_id": SRC, "bucket": "otro"}, env.sources)
    policy = env.iam.get_role_policy(RoleName=f"Mango-poc-kbsrc-{SRC}", PolicyName=POLICY_NAME)
    assert "otro" not in json.dumps(policy["PolicyDocument"])
    assert "docs-rrhh" not in caplog.text


def test_a_source_that_does_not_exist(env: Env) -> None:
    assert _ensure(env) == {"error": "source_not_found"}
