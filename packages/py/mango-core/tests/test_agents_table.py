"""Provisioner side of the Agents table: lock, published pointer (moto DynamoDB)."""

from __future__ import annotations

import re
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from mango_core.agents_table import (
    PUBLISHED_PREFIX,
    lock_item,
    meta_key,
    publish_items,
    published_key,
    release_key,
    release_version_items,
    unlock_item,
    version_key,
)
from mango_core.harness_tools import GATEWAY_MCP_SERVER, allowed_tool, gateway_tool_name

TABLE = "Mango-test-Agents"
AGENT = "abcdefghijklmnop"
NOW = datetime(2026, 10, 1, 15, 0, tzinfo=UTC)
TTL = timedelta(minutes=30)
HASH = "a" * 64
HARNESS = "arn:aws:bedrock-agentcore:us-east-1:111111111111:harness/Mango_test_a_x-0123456789"


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        client.create_table(
            TableName=TABLE,
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
        client.put_item(
            TableName=TABLE,
            Item={
                **meta_key(AGENT),
                "status": {"S": "draft"},
                "version": {"N": "1"},
                "open_version": {"N": "1"},
            },
        )
        client.put_item(
            TableName=TABLE,
            Item={
                **version_key(AGENT, 1),
                "status": {"S": "approved"},
                "content_hash": {"S": HASH},
                "definition": {"S": "{}"},
            },
        )
        yield client


def _lock(db: Any, owner: str, now: datetime = NOW, agent_id: str = AGENT) -> None:
    db.update_item(**lock_item(TABLE, agent_id=agent_id, owner=owner, now=now, ttl=TTL))


def _conflict(call: Any) -> None:
    with pytest.raises(ClientError) as error:
        call()
    assert error.value.response["Error"]["Code"] == "ConditionalCheckFailedException"


def test_lock_is_exclusive_reentrant_and_expires(db: Any) -> None:
    _lock(db, "exec-1")
    _lock(db, "exec-1")  # the same execution may take it again (step retry)
    _conflict(lambda: _lock(db, "exec-2"))
    _conflict(lambda: _lock(db, "exec-2", NOW + TTL - timedelta(seconds=1)))
    _lock(db, "exec-2", NOW + TTL + timedelta(seconds=1))
    item = db.get_item(TableName=TABLE, Key=meta_key(AGENT))["Item"]
    assert item["provision_lock"]["S"] == "exec-2"
    # The lock does not touch mango-api's optimistic lock of the item.
    assert item["version"]["N"] == "1"


def test_lock_needs_an_existing_agent(db: Any) -> None:
    _conflict(lambda: _lock(db, "exec-1", agent_id="zzzzzzzzzzzzzzzz"))
    assert "Item" not in db.get_item(TableName=TABLE, Key=meta_key("zzzzzzzzzzzzzzzz"))


def test_only_the_owner_releases_the_lock(db: Any) -> None:
    _lock(db, "exec-1")
    _conflict(lambda: db.update_item(**unlock_item(TABLE, agent_id=AGENT, owner="exec-2")))
    db.update_item(**unlock_item(TABLE, agent_id=AGENT, owner="exec-1"))
    item = db.get_item(TableName=TABLE, Key=meta_key(AGENT))["Item"]
    assert "provision_lock" not in item
    assert "provision_lock_until" not in item
    _lock(db, "exec-2")


def _publish(db: Any, **overrides: Any) -> None:
    arguments: dict[str, Any] = {
        "agent_id": AGENT,
        "version": 1,
        "content_hash": HASH,
        "previous_version": None,
        "harness_arn": HARNESS,
        "harness_version": "1",
        "now": NOW,
    }
    db.transact_write_items(TransactItems=publish_items(TABLE, **{**arguments, **overrides}))


def test_publishing_writes_the_pointer_in_the_same_transaction(db: Any) -> None:
    _publish(db)
    pointer = db.get_item(TableName=TABLE, Key=published_key(AGENT))["Item"]
    assert pointer["PK"]["S"] == f"{PUBLISHED_PREFIX}{AGENT}"
    assert pointer["SK"]["S"] == "CURRENT"
    assert pointer["n"]["N"] == "1"
    assert pointer["content_hash"]["S"] == HASH
    assert pointer["harness_arn"]["S"] == HARNESS
    assert pointer["harness_version"]["S"] == "1"
    assert pointer["published_at"]["S"] == "2026-10-01T15:00:00+00:00"


def test_no_pointer_when_the_publication_is_refused(db: Any) -> None:
    with pytest.raises(ClientError):
        _publish(db, content_hash="b" * 64)  # not the approved content
    assert "Item" not in db.get_item(TableName=TABLE, Key=published_key(AGENT))


def test_pointer_follows_the_next_published_version(db: Any) -> None:
    _publish(db)
    db.put_item(
        TableName=TABLE,
        Item={
            **version_key(AGENT, 2),
            "status": {"S": "approved"},
            "content_hash": {"S": "c" * 64},
        },
    )
    db.update_item(
        TableName=TABLE,
        Key=meta_key(AGENT),
        UpdateExpression="SET open_version = :n",
        ExpressionAttributeValues={":n": {"N": "2"}},
    )
    _publish(db, version=2, content_hash="c" * 64, previous_version=1, harness_version="2")
    pointer = db.get_item(TableName=TABLE, Key=published_key(AGENT))["Item"]
    assert (pointer["n"]["N"], pointer["content_hash"]["S"], pointer["harness_version"]["S"]) == (
        "2",
        "c" * 64,
        "2",
    )


def test_tool_names_in_a_harness() -> None:
    assert GATEWAY_MCP_SERVER == "mango"
    assert gateway_tool_name("finops", "get_cost_and_usage") == "finops___get_cost_and_usage"
    assert allowed_tool("finops", "get_cost_and_usage") == "@mango/finops___get_cost_and_usage"


# --- Next version of a release agent (D80) ------------------------------------------------

# Keep in sync with RELEASE_VERSION_ATTRIBUTES and RELEASE_META_ATTRIBUTES
# (infra/lib/constructs/provisioner.ts): IAM only lets the provisioner name these.
RELEASE_VERSION_ATTRIBUTES = {
    "PK",
    "SK",
    "agent_id",
    "n",
    "status",
    "status_index",
    "status_at",
    "revision",
    "definition",
    "content_hash",
    "created_by",
    "editors",
    "created_at",
    "updated_at",
    "submitted_by",
    "submitted_at",
    "approved_by",
    "approved_at",
    "base_version",
}
RELEASE_META_ATTRIBUTES = {
    "PK",
    "SK",
    "status",
    "latest_version",
    "open_version",
    "updated_at",
    "version",
    "provision_lock",
}
RELEASE = "release@0.1.0"


def _release_items(**overrides: Any) -> list[dict[str, Any]]:
    args: dict[str, Any] = {
        "agent_id": AGENT,
        "number": 2,
        "definition": "{}",
        "content_hash": "b" * 64,
        "approver": RELEASE,
        "meta_version": 2,
        "base_version": 1,
        "owner": "exec-1",
        "now": NOW,
    }
    return release_version_items(TABLE, **{**args, **overrides})


def _names(update: dict[str, Any]) -> set[str]:
    text = f"{update['UpdateExpression']} {update.get('ConditionExpression', '')}"
    for alias, name in update.get("ExpressionAttributeNames", {}).items():
        text = text.replace(alias, name)
    words = set(re.findall(r"(?<![:#\w])[a-z_]+(?![\w(])", text))
    return words - {"attribute_not_exists", "attribute_exists"}


def test_release_version_names_only_what_iam_allows() -> None:
    put, update = _release_items()
    assert set(put["Put"]["Item"]) <= RELEASE_VERSION_ATTRIBUTES
    assert _names(update["Update"]) | set(update["Update"]["Key"]) <= RELEASE_META_ATTRIBUTES
    item = put["Put"]["Item"]
    assert {item[k]["S"] for k in ("created_by", "submitted_by", "approved_by")} == {RELEASE}
    assert item["status"]["S"] == "approved"
    assert release_key(AGENT, "b" * 64)["SK"]["S"] == "RELEASE#" + "b" * 64


def _published_agent(db: Any) -> None:
    """Version 1 published, nothing open, and this execution holding the lock."""
    db.update_item(
        TableName=TABLE,
        Key=meta_key(AGENT),
        UpdateExpression="SET latest_version = :one, version = :two REMOVE open_version",
        ExpressionAttributeValues={":one": {"N": "1"}, ":two": {"N": "2"}},
    )
    _lock(db, "exec-1")


def _transact(db: Any, items: list[dict[str, Any]]) -> None:
    db.transact_write_items(TransactItems=items)


def test_release_version_opens_the_next_version(db: Any) -> None:
    _published_agent(db)
    _transact(db, _release_items())
    meta = db.get_item(TableName=TABLE, Key=meta_key(AGENT))["Item"]
    assert (meta["latest_version"]["N"], meta["open_version"]["N"], meta["version"]["N"]) == (
        "2",
        "2",
        "3",
    )


@pytest.mark.parametrize(
    "overrides",
    [
        {"number": 1},  # an existing version: never overwritten
        {"meta_version": 1},  # the agent changed since it was read
        {"owner": "exec-2"},  # without the provisioner lock
    ],
)
def test_release_version_writes_nothing_on_a_conflict(db: Any, overrides: dict[str, Any]) -> None:
    _published_agent(db)
    before = db.get_item(TableName=TABLE, Key=version_key(AGENT, 1))["Item"]
    with pytest.raises(ClientError) as error:
        _transact(db, _release_items(**overrides))
    assert error.value.response["Error"]["Code"] == "TransactionCanceledException"
    assert db.get_item(TableName=TABLE, Key=version_key(AGENT, 1))["Item"] == before
    assert "Item" not in db.get_item(TableName=TABLE, Key=version_key(AGENT, 2))


def test_release_version_waits_for_the_open_one(db: Any) -> None:
    _lock(db, "exec-1")  # version 1 is still open
    with pytest.raises(ClientError):
        _transact(db, _release_items(meta_version=1))
