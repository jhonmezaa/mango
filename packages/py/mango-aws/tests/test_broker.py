import json
from datetime import UTC, datetime
from typing import Any

import boto3
import pytest
from botocore.stub import ANY, Stubber

from mango_aws import CallerIdentity, CrossAccountSessions, RoleChain, build_session_policy
from mango_aws.broker import _session_name

BROKER = "arn:aws:iam::111111111111:role/Mango-poc-BillingBroker"
TARGET = "arn:aws:iam::222222222222:role/Mango-poc-BillingReader"


def _creds(key: str) -> dict[str, Any]:
    return {
        "Credentials": {
            "AccessKeyId": key,
            "SecretAccessKey": "secret",
            "SessionToken": "token",
            "Expiration": datetime(2030, 1, 1, tzinfo=UTC),
        }
    }


def test_session_policy_is_minimal_and_sorted() -> None:
    policy = json.loads(build_session_policy(["ce:GetCostForecast", "ce:GetCostAndUsage"]))
    statement = policy["Statement"][0]
    assert statement["Action"] == ["ce:GetCostAndUsage", "ce:GetCostForecast"]
    assert statement["Effect"] == "Allow"


@pytest.mark.parametrize("action", ["ce:*", "*", "ce:Get*", "not-an-action"])
def test_session_policy_rejects_wildcards(action: str) -> None:
    with pytest.raises(ValueError, match="action"):
        build_session_policy([action])


def test_session_policy_requires_actions() -> None:
    with pytest.raises(ValueError, match="action"):
        build_session_policy([])


@pytest.mark.parametrize("identity", ["a", "has space", "x" * 65, "semi;colon"])
def test_caller_identity_rejects_invalid_source_identity(identity: str) -> None:
    with pytest.raises(ValueError, match="source_identity"):
        CallerIdentity(source_identity=identity)


def test_caller_identity_rejects_invalid_tag() -> None:
    with pytest.raises(ValueError, match="session tag"):
        CallerIdentity(source_identity="user@example.com", tags={"mango_user": "bad;value"})


def test_role_chain_rejects_invalid_arn() -> None:
    with pytest.raises(ValueError, match="role ARN"):
        RoleChain(broker_role_arn="not-an-arn", target_role_arn=TARGET)


def test_assume_sets_source_identity_tags_and_session_policy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_hop = boto3.client("sts", region_name="us-east-1")
    second_hop = boto3.client("sts", region_name="us-east-1")
    caller = CallerIdentity(
        source_identity="ana@example.com",
        tags={"mango_user": "ana@example.com", "agent_id": "finops"},
    )
    policy = build_session_policy(["ce:GetCostAndUsage"])

    with Stubber(first_hop) as s1, Stubber(second_hop) as s2:
        s1.add_response(
            "assume_role",
            _creds("ASIABROKERKEY0001"),
            {
                "RoleArn": BROKER,
                "RoleSessionName": ANY,
                "DurationSeconds": 900,
                "SourceIdentity": "ana@example.com",
                "Tags": [
                    {"Key": "agent_id", "Value": "finops"},
                    {"Key": "mango_user", "Value": "ana@example.com"},
                ],
                "TransitiveTagKeys": ["agent_id", "mango_user"],
            },
        )
        s2.add_response(
            "assume_role",
            _creds("ASIATARGETKEY0001"),
            {
                "RoleArn": TARGET,
                "RoleSessionName": ANY,
                "DurationSeconds": 900,
                "SourceIdentity": "ana@example.com",
                "Policy": policy,
            },
        )
        sessions = CrossAccountSessions(sts_client=first_hop)
        monkeypatch.setattr(sessions, "_client_from", lambda _creds: second_hop)
        session = sessions.assume(RoleChain(BROKER, TARGET), caller, policy)

    assert session.get_credentials().access_key == "ASIATARGETKEY0001"  # type: ignore[union-attr]


def test_session_name_does_not_leak_identity() -> None:
    name = _session_name(CallerIdentity(source_identity="ana@example.com"))
    assert name.startswith("mango-")
    assert "ana" not in name
    assert len(name) <= 64
