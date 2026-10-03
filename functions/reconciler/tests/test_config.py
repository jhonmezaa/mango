"""Settings of the reconciler, and that it expects exactly what the provisioner creates."""

from __future__ import annotations

from types import SimpleNamespace
from typing import cast

import pytest

from mango_api import agent_rules
from mango_provisioner import harness as provisioner_harness
from mango_provisioner import role as provisioner_role
from mango_provisioner.config import ENDPOINT_LIVE as PROVISIONER_LIVE
from mango_provisioner.config import ROLE_POLICY_NAME as PROVISIONER_POLICY
from mango_provisioner.config import Settings as ProvisionerSettings
from mango_provisioner.packs import config as pack_config
from mango_provisioner.store import LOCK_TTL
from mango_reconciler import config, inventory
from mango_reconciler.config import ConfigError, Settings

from .conftest import AGENT, ENV

PROVISIONER_ENV = {
    **ENV,
    "SETTINGS_TABLE": "Mango-test-Settings",
    "AUDIT_STREAM": "Mango-test-Audit",
    "AUDIT_INDEX_TABLE": "Mango-test-AuditIndex",
    "GATEWAY_URL": "https://mango-test-tools-abc123.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
    "GUARDRAIL_ID": "gr123456",
    "GUARDRAIL_VERSION": "1",
    "RUNTIME_LOGS_KEY_ARN": "arn:aws:kms:us-east-1:123456789012:key/k",
    "AGENT_SESSION_IDLE_SECONDS": "300",
    "AGENT_SESSION_MAX_SECONDS": "28800",
    "CONNECTOR_CATALOG": "{}",
}


@pytest.mark.parametrize("agent_id", [AGENT, "finops"])
def test_names_and_trust_are_the_provisioner_s(agent_id: str) -> None:
    ours = Settings.from_env(ENV)
    theirs = ProvisionerSettings.from_env(PROVISIONER_ENV)
    assert ours.role_name(agent_id) == theirs.role_name(agent_id)
    assert ours.role_arn(agent_id) == theirs.role_arn(agent_id)
    assert ours.harness_name(agent_id) == theirs.harness_name(agent_id)
    assert ours.runtime_name(agent_id) == theirs.runtime_name(agent_id)
    assert ours.expected_boundary_arn == theirs.expected_boundary_arn
    harness_id = f"{theirs.harness_name(agent_id)}-AbCdEf0123"
    assert theirs.harness_id_pattern(agent_id).fullmatch(harness_id)
    assert ours.agent_of_harness(theirs.harness_name(agent_id), harness_id) == agent_id
    assert ours.harness_arn(harness_id) == theirs.harness_arn(harness_id)
    assert ours.agent_of_role(theirs.role_name(agent_id)) == agent_id
    assert ours.trust_policy(agent_id) == provisioner_role.trust_policy(theirs, agent_id)


def test_constants_are_the_provisioner_s_and_mango_api_s() -> None:
    assert config.ENDPOINT_LIVE == PROVISIONER_LIVE
    assert config.ROLE_POLICY_NAME == PROVISIONER_POLICY
    assert config.AGENTCORE_SERVICE == provisioner_role.AGENTCORE_SERVICE
    assert inventory.ENV_AGENT_ID == provisioner_harness.ENV_AGENT_ID
    assert inventory.ENV_AGENT_VERSION == provisioner_harness.ENV_AGENT_VERSION
    assert inventory.ENV_CONTENT_HASH == provisioner_harness.ENV_CONTENT_HASH
    assert config.MAX_DRAFTS == agent_rules.MAX_DRAFTS
    assert config.MAX_SUBMISSIONS_PER_DAY == agent_rules.MAX_SUBMISSIONS_PER_DAY
    # A version is "stuck" only after any execution that could publish it has lost its lock.
    assert config.LOCK_TTL == LOCK_TTL
    assert config.STUCK_AFTER > LOCK_TTL


@pytest.mark.parametrize("pack_id", ["aws-pricing", "aws-billing"])
def test_pack_runtime_names_and_network_are_the_pack_provisioner_s(pack_id: str) -> None:
    ours = Settings.from_env(ENV)
    # Only the namespace decides the name.
    theirs = cast(pack_config.PackSettings, SimpleNamespace(namespace=ours.namespace))
    name = pack_config.PackSettings.runtime_name(theirs, pack_id)
    assert name.startswith(ours.pack_runtime_prefix)
    assert not ours.runtime_name(AGENT).startswith(ours.pack_runtime_prefix)
    network = pack_config.PackNetwork(("subnet-0a1b2c3d",), {pack_id: "sg-0a1b2c3d"})
    assert network.configuration(pack_id)["networkMode"] == config.PACK_NETWORK_MODE
    assert config.ENDPOINT_LIVE == pack_config.ENDPOINT_LIVE
    assert config.ENDPOINT_DEFAULT == pack_config.ENDPOINT_DEFAULT


def test_names_that_are_not_an_agent_s() -> None:
    settings = Settings.from_env(ENV)
    assert settings.agent_of_role("Mango-test-agent-boundary") == "boundary"  # a valid slug
    assert settings.agent_of_role("Mango-test-agent-") is None
    assert settings.agent_of_role("Mango-test-agent-Has-Hyphen") is None
    assert settings.agent_of_role("Mango-other-agent-finops") is None
    name = settings.harness_name(AGENT)
    assert settings.agent_of_harness(name, f"{name}-short") is None
    assert settings.agent_of_harness(name, f"other-{'0' * 10}") is None
    assert (
        settings.agent_of_harness("Mango_test_a_platform", f"Mango_test_a_platform-{'0' * 10}")
        is None
    )


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("MANGO_NAMESPACE", "Has-Caps"),
        ("MANGO_ACCOUNT_ID", "123"),
        ("AWS_REGION", "nowhere"),
        ("AGENTS_TABLE", "bad name"),
        ("AGENT_BOUNDARY_ARN", "arn:aws:iam::123456789012:policy/Other"),
        ("RELEASE_AGENTS", "not json"),
        ("RELEASE_AGENTS", "[]"),
        ("RELEASE_AGENTS", '{"finops": "abc"}'),
        ("RELEASE_AGENTS", '{"Fin Ops": "' + "a" * 64 + '"}'),
    ],
)
def test_invalid_environment_is_rejected(name: str, value: str) -> None:
    with pytest.raises(ConfigError):
        Settings.from_env({**ENV, name: value})


def test_missing_environment_is_rejected() -> None:
    env = {k: v for k, v in ENV.items() if k != "AGENTS_TABLE"}
    with pytest.raises(ConfigError, match="AGENTS_TABLE"):
        Settings.from_env(env)
