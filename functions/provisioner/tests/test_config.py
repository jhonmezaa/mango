"""Settings come only from the stack; names fit AgentCore's and IAM's limits."""

from __future__ import annotations

import re

import pytest

from mango_provisioner.config import ConfigError, Settings

from .conftest import ENV

LONGEST_ID = "a" * 16


def test_settings_from_env() -> None:
    settings = Settings.from_env(ENV)
    assert settings.namespace == "test"
    assert settings.connectors["cost-explorer"].target == "finops"
    assert settings.guardrail_arn == "arn:aws:bedrock:us-east-1:123456789012:guardrail/gr123456"
    assert settings.release_agents == {}
    shipped = Settings.from_env({**ENV, "RELEASE_AGENTS": '{"finops": "' + "a" * 64 + '"}'})
    assert shipped.release_agents == {"finops": "a" * 64}


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("MANGO_NAMESPACE", "Has-Hyphen"),
        ("MANGO_ACCOUNT_ID", "123"),
        ("GATEWAY_URL", "https://evil.example.com/mcp"),
        ("GUARDRAIL_VERSION", "DRAFT"),
        ("AGENT_BOUNDARY_ARN", "arn:aws:iam::aws:policy/AdministratorAccess"),
        ("AGENT_BOUNDARY_ARN", "arn:aws:iam::123456789012:policy/Mango-other-agent-boundary"),
        ("AGENT_SESSION_IDLE_SECONDS", "0"),
        ("AGENT_SESSION_MAX_SECONDS", "forever"),
        ("CONNECTOR_CATALOG", "not json"),
        ("CONNECTOR_CATALOG", "[]"),
        ("CONNECTOR_CATALOG", '{"x": {"target": "bad target", "tools": {}}}'),
        ("CONNECTOR_CATALOG", '{"x": {"target": "t", "tools": {"a": "admin"}}}'),
        ("RELEASE_AGENTS", "not json"),
        ("RELEASE_AGENTS", "[]"),
        ("RELEASE_AGENTS", '{"finops": "abc"}'),
        ("RELEASE_AGENTS", '{"Fin Ops": "' + "a" * 64 + '"}'),
        ("RELEASE_AGENTS", '{"finops": 1}'),
    ],
)
def test_invalid_environment_is_rejected(name: str, value: str) -> None:
    with pytest.raises(ConfigError):
        Settings.from_env({**ENV, name: value})


def test_missing_variable() -> None:
    env = {k: v for k, v in ENV.items() if k != "AGENTS_TABLE"}
    with pytest.raises(ConfigError, match="AGENTS_TABLE"):
        Settings.from_env(env)


def test_names_fit_the_limits_with_the_longest_namespace_and_id() -> None:
    settings = Settings.from_env(
        {
            **ENV,
            "MANGO_NAMESPACE": "abcdefgh",
            "AGENT_BOUNDARY_ARN": "arn:aws:iam::123456789012:policy/Mango-abcdefgh-agent-boundary",
        }
    )
    harness = settings.harness_name(LONGEST_ID)
    assert re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]{0,39}", harness)  # AgentCore: 40, no hyphens
    assert re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]{0,47}", settings.runtime_name(LONGEST_ID))
    assert len(settings.role_name(LONGEST_ID)) <= 64
    assert settings.role_name(LONGEST_ID).startswith("Mango-abcdefgh-agent-")
    assert settings.harness_name("finops") == "Mango_abcdefgh_a_finops"  # release slug


def test_ids_of_harness_and_runtime_are_pinned_to_the_agent() -> None:
    settings = Settings.from_env(ENV)
    pattern = settings.harness_id_pattern("finops")
    assert pattern.fullmatch("Mango_test_a_finops-AbCdEf0123")
    assert not pattern.fullmatch("Mango_test_a_finops2-AbCdEf0123")
    assert not pattern.fullmatch("Mango_test_finops-AbCdEf0123")
    assert not pattern.fullmatch("Mango_test_a_finops-short")
    assert settings.runtime_id_pattern("finops").fullmatch("harness_Mango_test_a_finops-AbCdEf0123")
    assert settings.log_group_names("harness_Mango_test_a_finops-AbCdEf0123") == (
        "/aws/bedrock-agentcore/runtimes/harness_Mango_test_a_finops-AbCdEf0123-DEFAULT",
        "/aws/bedrock-agentcore/runtimes/harness_Mango_test_a_finops-AbCdEf0123-live",
    )
