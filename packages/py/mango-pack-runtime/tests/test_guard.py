"""The call guard and the broker chain: who a tool call runs as, and what it refuses."""

from __future__ import annotations

import base64
import json
import logging
from pathlib import Path
from typing import Any

import boto3
import pytest
from botocore.stub import ANY, Stubber

from mango_pack_runtime import credentials
from mango_pack_runtime.config import PackConfig, PackConfigError, Statement
from mango_pack_runtime.guard import CallGuard, broker_assume, build_guard, session_policy
from mango_pack_runtime.identity import Caller, IdentityError, IdentityVerifier

from .conftest import PACK, STATEMENTS, TOOL, IdentityKey, central_config, keys_of


def _guard(key: IdentityKey) -> CallGuard:
    return CallGuard(
        central_config(key), verifier=IdentityVerifier(key.public_der, PACK), assume=keys_of
    )


def _ctx(assertion: str) -> dict[str, Any]:
    return {"_mango_ctx": {"identity": assertion}}


def test_the_tool_runs_as_the_caller_and_never_sees_the_context(identity_key: IdentityKey) -> None:
    arguments = {"service": "AmazonEC2", **_ctx(identity_key.assertion("alice"))}
    with _guard(identity_key).call(TOOL, arguments) as cleaned:
        assert cleaned == {"service": "AmazonEC2"}
        caller = credentials.current_caller()
        assert caller == Caller(subject="alice", tool=TOOL, agent_id="finops", central=True)
    assert credentials.current_caller() is None
    assert "_mango_ctx" in arguments  # the caller's own dict is not mutated


@pytest.mark.parametrize(
    "context",
    [
        None,
        "v1.x.y",
        {},
        {"token": "eyJ.a.b"},  # what connectors get: not an identity for a pack
        {"identity": None},
        {"identity": {"sub": "alice"}},
    ],
)
def test_without_a_signed_caller_nothing_runs(identity_key: IdentityKey, context: object) -> None:
    arguments = {"service": "AmazonEC2"}
    if context is not None:
        arguments["_mango_ctx"] = context  # type: ignore[assignment]
    with pytest.raises(IdentityError), _guard(identity_key).call(TOOL, arguments):
        pytest.fail("the tool ran")


def test_a_user_who_is_not_central_is_refused_by_the_pack_itself(
    identity_key: IdentityKey,
) -> None:
    arguments = _ctx(identity_key.assertion("area-user", central=False))
    with pytest.raises(IdentityError), _guard(identity_key).call(TOOL, arguments):
        pytest.fail("the tool ran")


def test_an_assertion_for_another_tool_is_refused(identity_key: IdentityKey) -> None:
    arguments = _ctx(identity_key.assertion("alice", "budgets"))
    with pytest.raises(IdentityError), _guard(identity_key).call(TOOL, arguments):
        pytest.fail("the tool ran")


def test_a_tool_outside_the_manifest_is_refused(identity_key: IdentityKey) -> None:
    arguments = _ctx(identity_key.assertion("alice", "delete_budget"))
    with pytest.raises(IdentityError), _guard(identity_key).call("delete_budget", arguments):
        pytest.fail("the tool ran")


def test_a_service_pack_only_loses_the_reserved_argument() -> None:
    config = PackConfig(PACK, "1.0.0-1", frozenset({TOOL}), "service", ())
    with CallGuard(config).call(TOOL, {"a": 1, "_mango_ctx": {"token": "forged"}}) as cleaned:
        assert cleaned == {"a": 1}
        assert credentials.current_caller() is None
    with CallGuard(config).call(TOOL, None) as cleaned:
        assert cleaned == {}


def test_a_pack_that_cannot_verify_callers_serves_no_call(identity_key: IdentityKey) -> None:
    """The build runs the zip with an empty environment to list its tools."""
    locked = build_guard(central_config(None))
    try:
        arguments = _ctx(identity_key.assertion("alice"))
        with pytest.raises(IdentityError), locked.call(TOOL, arguments):
            pytest.fail("the tool ran")
    finally:
        credentials.uninstall()


def test_calls_are_logged_without_arguments(
    identity_key: IdentityKey, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="mango.pack")
    guard = _guard(identity_key)
    assertion = identity_key.assertion("alice")
    with guard.call(TOOL, {"note": "SECRET-ARGUMENT", **_ctx(assertion)}):
        pass
    with pytest.raises(IdentityError), guard.call(TOOL, {"note": "SECRET-ARGUMENT"}):
        pass
    with pytest.raises(RuntimeError), guard.call(TOOL, _ctx(identity_key.assertion("alice"))):
        raise RuntimeError("upstream failed")
    events = [json.loads(r.getMessage()) for r in caplog.records]
    assert [(e["user"], e["outcome"]) for e in events] == [
        ("alice", "ok"),
        (None, "rejected"),
        ("alice", "error"),
    ]
    assert all(e["pack"] == PACK and e["tool"] == TOOL for e in events)
    assert "SECRET-ARGUMENT" not in caplog.text and assertion not in caplog.text


# --- Broker chain (D10, D37) -----------------------------------------------------------------


def test_session_policy_is_exactly_the_manifest_statements() -> None:
    policy = json.loads(
        session_policy(
            (
                Statement(("ce:GetCostAndUsage", "ce:GetCostForecast"), ("*",)),
                Statement(("budgets:ViewBudget",), ("arn:aws:budgets::111122223333:budget/*",)),
            )
        )
    )
    assert policy["Statement"] == [
        {
            "Effect": "Allow",
            "Action": ["ce:GetCostAndUsage", "ce:GetCostForecast"],
            "Resource": ["*"],
        },
        {
            "Effect": "Allow",
            "Action": ["budgets:ViewBudget"],
            "Resource": ["arn:aws:budgets::111122223333:budget/*"],
        },
    ]
    with pytest.raises(ValueError, match="wildcard"):
        session_policy((Statement(("ce:*",), ("*",)),))
    with pytest.raises(ValueError, match="statement"):
        session_policy(())


def _credentials(key: str) -> dict[str, Any]:
    return {
        "Credentials": {
            "AccessKeyId": f"ASIA{key:0>16}",
            "SecretAccessKey": "s" * 40,
            "SessionToken": "t" * 40,
            "Expiration": "2026-10-01T12:00:00Z",
        }
    }


def test_every_hop_carries_the_user_as_source_identity(
    identity_key: IdentityKey, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = central_config(identity_key)
    sts = boto3.client(
        "sts", region_name="us-east-1", aws_access_key_id="a", aws_secret_access_key="b"
    )
    subject = "0d6e4079-e1ba-4a0c-9c1c-1f2f6b7e0a11"
    with Stubber(sts) as stub:
        stub.add_response(
            "assume_role",
            _credentials("BROKER"),
            {
                "RoleArn": config.broker_role_arn,
                "RoleSessionName": ANY,
                "DurationSeconds": 900,
                "SourceIdentity": subject,
                "Tags": [
                    {"Key": "mango_agent", "Value": "finops"},
                    {"Key": "mango_bu", "Value": "central"},
                    {"Key": "mango_user", "Value": subject},
                ],
                "TransitiveTagKeys": ["mango_agent", "mango_bu", "mango_user"],
            },
        )
        second_hop: dict[str, Any] = {}

        class BrokerSts:
            class meta:  # noqa: N801 - mimics a boto3 client
                region_name = "us-east-1"

            def assume_role(self, **kwargs: Any) -> dict[str, Any]:
                second_hop.update(kwargs)
                return _credentials("TARGET")

        monkeypatch.setattr(
            "mango_aws.broker.CrossAccountSessions._client_from", lambda _self, _c: BrokerSts()
        )
        frozen = broker_assume(config, sts)(
            Caller(subject=subject, tool=TOOL, agent_id="finops", central=True)
        )
        stub.assert_no_pending_responses()
    assert frozen.access_key == "ASIA0000000000TARGET"
    assert second_hop["RoleArn"] == config.target_role_arn
    assert second_hop["SourceIdentity"] == subject
    # The session can do what the signed manifest lists and nothing else of the target role.
    assert json.loads(second_hop["Policy"]) == json.loads(session_policy(STATEMENTS))


def test_a_pack_without_broker_cannot_assume() -> None:
    config = PackConfig(PACK, "1.0.0-1", frozenset({TOOL}), "central_only", STATEMENTS)
    with pytest.raises(ValueError, match="broker"):
        broker_assume(config)


# --- pack.json and the runtime's environment -------------------------------------------------


def _pack_json(directory: Path, **content: Any) -> Path:
    base = {"id": PACK, "version": "1.0.0-1", "tools": [TOOL]}
    (directory / "pack.json").write_text(json.dumps({**base, **content}))
    return directory


CENTRAL = {
    "identity_mode": "central_only",
    "iam": [{"actions": ["ce:GetCostAndUsage"], "resources": ["*"]}],
}


def test_a_service_pack_needs_nothing_from_the_environment(tmp_path: Path) -> None:
    config = PackConfig.load(_pack_json(tmp_path), {})
    assert (config.needs_caller, config.identity_mode) == (False, "service")
    assert config.tools == frozenset({TOOL})


def test_an_account_data_pack_reads_the_broker_and_the_key(
    tmp_path: Path, identity_key: IdentityKey
) -> None:
    env = {
        "MANGO_PACK_BROKER_ROLE_ARN": "arn:aws:iam::111122223333:role/Mango-test-BillingBroker",
        "MANGO_PACK_TARGET_ROLE_ARN": "arn:aws:iam::999988887777:role/Mango-test-BillingReader",
        "MANGO_PACK_IDENTITY_PUBLIC_KEY": base64.b64encode(identity_key.public_der).decode(),
        "MANGO_PACK_REGION": "us-east-1",
    }
    config = PackConfig.load(_pack_json(tmp_path, **CENTRAL), env)
    assert config.needs_caller and config.can_verify
    assert config.statements == STATEMENTS
    assert config.identity_public_key == identity_key.public_der
    # Incomplete settings: the pack starts locked instead of guessing.
    for missing in env:
        partial = {k: v for k, v in env.items() if k != missing}
        assert PackConfig.load(tmp_path, partial).can_verify is False
    with pytest.raises(PackConfigError, match="base64"):
        PackConfig.load(tmp_path, {**env, "MANGO_PACK_IDENTITY_PUBLIC_KEY": "not base64!"})


@pytest.mark.parametrize(
    "content",
    [
        {"identity_mode": "per_user_adapter", "iam": CENTRAL["iam"]},  # no code for it
        {"identity_mode": "central_only"},  # no statements: nothing to limit a session to
        {"identity_mode": "central_only", "iam": [{"actions": [], "resources": ["*"]}]},
        {"tools": []},
        {"tools": ["bad tool"]},
        {"id": "Bad_Id"},
    ],
)
def test_a_pack_json_the_runtime_does_not_understand_stops_the_start(
    tmp_path: Path, content: dict[str, Any]
) -> None:
    with pytest.raises(PackConfigError):
        PackConfig.load(_pack_json(tmp_path, **content), {})


def test_a_missing_pack_json_stops_the_start(tmp_path: Path) -> None:
    with pytest.raises(PackConfigError):
        PackConfig.load(tmp_path, {})
