from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from moto import mock_aws

from mango_pre_token import handler
from mango_pre_token.handler import claims_for_groups, lambda_handler


@pytest.mark.parametrize(
    ("groups", "expected"),
    [
        (["finops-central"], {"mango_role": "finops-central"}),
        (["bu-lead", "bu-security"], {"mango_role": "bu-lead", "mango_business_unit": "security"}),
        (["bu-lead", "finops-central"], {"mango_role": "finops-central"}),
        (["bu-lead", "bu-a1", "bu-b2"], {"mango_role": "bu-lead"}),
        (["mango-admin"], {"mango_admin": "true"}),
        (["random", "bu-X"], {}),
        # Access and creator groups reach Mango in ``cognito:groups``; they grant no role.
        (["mango-agent-creator"], {}),
        (["mango-agent-creator", "hr"], {}),
        (["mango-agent-creator", "mango-admin"], {"mango_admin": "true"}),
        (["bu-security"], {"mango_business_unit": "security"}),
        ([], {}),
    ],
)
def test_claims_for_groups(groups: list[str], expected: dict[str, str]) -> None:
    assert claims_for_groups(groups) == expected


def test_handler_sets_access_and_id_token_claims() -> None:
    event: dict[str, Any] = {
        "version": "2",
        "triggerSource": "TokenGeneration_HostedAuth",
        "request": {
            "userAttributes": {"custom:role": "finops-central"},
            "groupConfiguration": {"groupsToOverride": ["bu-lead", "bu-sandbox"]},
        },
        "response": {},
    }
    result = lambda_handler(event, None)
    details = result["response"]["claimsAndScopeOverrideDetails"]
    expected = {"mango_role": "bu-lead", "mango_business_unit": "sandbox"}
    assert details["accessTokenGeneration"]["claimsToAddOrOverride"] == expected
    assert details["accessTokenGeneration"]["scopesToSuppress"] == ["aws.cognito.signin.user.admin"]
    assert details["idTokenGeneration"]["claimsToAddOrOverride"] == expected


def test_access_token_carries_email_for_display() -> None:
    event: dict[str, Any] = {
        "request": {
            "userAttributes": {"email": "ana@example.com"},
            "groupConfiguration": {"groupsToOverride": ["finops-central"]},
        },
        "response": {},
    }
    details = lambda_handler(event, None)["response"]["claimsAndScopeOverrideDetails"]
    assert details["accessTokenGeneration"]["claimsToAddOrOverride"] == {
        "mango_role": "finops-central",
        "mango_email": "ana@example.com",
    }
    assert details["idTokenGeneration"]["claimsToAddOrOverride"] == {"mango_role": "finops-central"}


@pytest.mark.parametrize("email", [None, "", 42, "a" * 255 + "@example.com"])
def test_invalid_email_is_not_added(email: object) -> None:
    event: dict[str, Any] = {"request": {"userAttributes": {"email": email}}, "response": {}}
    details = lambda_handler(event, None)["response"]["claimsAndScopeOverrideDetails"]
    assert "mango_email" not in details["accessTokenGeneration"]["claimsToAddOrOverride"]


@pytest.mark.parametrize(
    "trigger",
    [
        "TokenGeneration_Authentication",
        "TokenGeneration_RefreshTokens",
        "TokenGeneration_HostedAuth",
        "TokenGeneration_NewPasswordChallenge",
        "TokenGeneration_AuthenticateDevice",
    ],
)
def test_self_service_scope_is_always_suppressed(trigger: str) -> None:
    # Users without groups too: the scope must never reach an access token (TM-L2).
    event: dict[str, Any] = {"triggerSource": trigger, "request": {}, "response": {}}
    details = lambda_handler(event, None)["response"]["claimsAndScopeOverrideDetails"]
    assert details["accessTokenGeneration"]["scopesToSuppress"] == ["aws.cognito.signin.user.admin"]
    assert "scopesToAdd" not in details["accessTokenGeneration"]


def test_access_token_carries_display_name() -> None:
    event: dict[str, Any] = {
        "request": {"userAttributes": {"email": "u@example.com", "name": "  Usuario   1 "}},
        "response": {},
    }
    details = lambda_handler(event, None)["response"]["claimsAndScopeOverrideDetails"]
    assert details["accessTokenGeneration"]["claimsToAddOrOverride"]["mango_name"] == "Usuario 1"
    # The name is display-only and never reaches authorization claims.
    assert "mango_name" not in details["idTokenGeneration"]["claimsToAddOrOverride"]


@pytest.mark.parametrize("name", [None, "", "   ", 7, "a" * 129, "bad\x00name", "tab\u200bzero"])
def test_invalid_name_is_not_added(name: object) -> None:
    event: dict[str, Any] = {"request": {"userAttributes": {"name": name}}, "response": {}}
    details = lambda_handler(event, None)["response"]["claimsAndScopeOverrideDetails"]
    assert "mango_name" not in details["accessTokenGeneration"]["claimsToAddOrOverride"]


def test_groups_are_not_overridden() -> None:
    # Cognito writes ``cognito:groups`` itself; the trigger must not replace it.
    event: dict[str, Any] = {
        "request": {"groupConfiguration": {"groupsToOverride": ["mango-agent-creator", "hr"]}},
        "response": {},
    }
    details = lambda_handler(event, None)["response"]["claimsAndScopeOverrideDetails"]
    assert "groupOverrideDetails" not in details
    for token in ("accessTokenGeneration", "idTokenGeneration"):
        assert "cognito:groups" not in details[token]["claimsToAddOrOverride"]


# --- mango_central (D35, TM-M13) ----------------------------------------------------------


def _event(groups: list[str]) -> dict[str, Any]:
    return {"request": {"groupConfiguration": {"groupsToOverride": groups}}, "response": {}}


def _claims(groups: list[str]) -> tuple[dict[str, str], dict[str, str]]:
    details = lambda_handler(_event(groups), None)["response"]["claimsAndScopeOverrideDetails"]
    return (
        details["accessTokenGeneration"]["claimsToAddOrOverride"],
        details["idTokenGeneration"]["claimsToAddOrOverride"],
    )


@pytest.fixture
def registry(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("SETTINGS_TABLE", "settings")
    handler._dynamodb.cache_clear()
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        db.create_table(
            TableName="settings",
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
        for group, kind in (
            ("finops-central", "central"),
            ("platform", "central"),
            ("bu-lead", "general"),
            ("bu-security", "area"),
            ("hr", "general"),
            ("shouting", "CENTRAL"),
        ):
            db.put_item(
                TableName="settings",
                Item={"PK": {"S": "GROUPS"}, "SK": {"S": group}, "type": {"S": kind}},
            )
        # Other partitions never make anyone central, whatever they hold.
        db.put_item(
            TableName="settings",
            Item={"PK": {"S": "GROUP_CHANGE"}, "SK": {"S": "hr"}, "type": {"S": "central"}},
        )
        yield db
    handler._dynamodb.cache_clear()


@pytest.mark.parametrize(
    ("groups", "central"),
    [
        (["finops-central"], True),
        (["platform", "hr"], True),
        (["hr"], False),
        (["bu-lead", "bu-security"], False),
        (["mango-admin"], False),
        (["mango-agent-creator", "hr"], False),
        # Not in the registry, or typed with anything other than exactly ``central``.
        (["unregistered"], False),
        (["shouting"], False),
        # Names that are not Mango groups are never looked up.
        (["us-east-1_AbCdEfGhI_Okta", "PLATFORM"], False),
        ([], False),
    ],
)
def test_central_claim_comes_from_the_registry(
    registry: Any, groups: list[str], central: bool
) -> None:
    access, identity = _claims(groups)
    for claims in (access, identity):
        assert claims.get("mango_central") == ("true" if central else None)


def test_central_claim_follows_a_type_change(registry: Any) -> None:
    assert _claims(["platform"])[0]["mango_central"] == "true"
    registry.put_item(
        TableName="settings",
        Item={"PK": {"S": "GROUPS"}, "SK": {"S": "platform"}, "type": {"S": "general"}},
    )
    assert "mango_central" not in _claims(["platform"])[0]


def test_central_claim_ignores_user_attributes(registry: Any) -> None:
    event = _event(["hr"])
    event["request"]["userAttributes"] = {"custom:mango_central": "true", "mango_central": "true"}
    details = lambda_handler(event, None)["response"]["claimsAndScopeOverrideDetails"]
    assert "mango_central" not in details["accessTokenGeneration"]["claimsToAddOrOverride"]


def test_registry_failure_withholds_the_claim_but_not_the_token(
    registry: Any, caplog: pytest.LogCaptureFixture
) -> None:
    registry.delete_table(TableName="settings")
    access, _ = _claims(["finops-central"])
    # Fail closed for account data; the rest of the token is still issued.
    assert access == {"mango_role": "finops-central"}
    assert "mango_central withheld" in caplog.text
    assert "finops-central" not in caplog.text


def test_missing_configuration_withholds_the_claim(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SETTINGS_TABLE", raising=False)
    assert "mango_central" not in _claims(["finops-central"])[0]


def test_users_without_mango_groups_do_not_read_the_registry() -> None:
    def boom() -> frozenset[str]:
        raise AssertionError("the registry must not be read")

    assert handler.is_central([], boom) is False
    assert handler.is_central(["us-east-1_AbCdEfGhI_Okta"], boom) is False


def test_an_oversized_registry_is_not_trusted(registry: Any) -> None:
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(handler, "_MAX_PAGES", 0)
        assert "mango_central" not in _claims(["finops-central"])[0]
