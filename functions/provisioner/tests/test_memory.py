"""The agents' memory in the provisioner (D122; ``memory-threat-model.md`` TM-ME1, ME8, ME9):
off by default, the installation's memory by ARN with the sentinel actor, never the managed
memory, and the agent role's permissions only for a version with memory."""

from __future__ import annotations

import pytest

from mango_core.memory import SENTINEL_ACTOR
from mango_provisioner.config import ConfigError, Settings
from mango_provisioner.harness import evals_config, harness_config, playground_config
from mango_provisioner.role import MEMORY_ACTIONS, role_policy

from .conftest import ACCOUNT, AGENT, ENV, MODEL, REGION, make_definition

MEMORY_ARN = f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:memory/Mango_test_memory-AbCdEf0123"
KEY_ARN = f"arn:aws:kms:{REGION}:{ACCOUNT}:key/11111111-2222-3333-4444-666666666666"
ON = {
    **ENV,
    "AGENT_MEMORY_ENABLED": "true",
    "AGENT_MEMORY_ARN": MEMORY_ARN,
    "AGENT_MEMORY_KEY_ARN": KEY_ARN,
}


def _config(settings: Settings, *, memory: bool) -> dict[str, object]:
    return harness_config(
        settings,
        agent_id=AGENT,
        version=1,
        content_hash="a" * 64,
        definition=make_definition(memory=memory),
    )


def test_memory_is_off_by_default_whatever_the_version_says() -> None:
    settings = Settings.from_env(
        {**ENV, "AGENT_MEMORY_ARN": MEMORY_ARN, "AGENT_MEMORY_KEY_ARN": KEY_ARN}
    )
    assert settings.memory_arn == ""
    assert _config(settings, memory=True)["memory"] == {"disabled": {}}
    assert not [
        s
        for s in role_policy(settings, AGENT, [MODEL], memory=True)["Statement"]
        if "Memory" in s["Sid"]
    ]


def test_on_a_version_with_memory_names_the_installations_memory_with_the_sentinel() -> None:
    settings = Settings.from_env(ON)
    memory = _config(settings, memory=True)["memory"]
    assert memory == {
        "agentCoreMemoryConfiguration": {
            "arn": MEMORY_ARN,
            "actorId": SENTINEL_ACTOR,
            "messagesCount": 0,
            "retrievalConfig": {
                "/mango/{actorId}/preferences/": {"topK": 5, "relevanceScore": 0.5},
                "/mango/{actorId}/facts/": {"topK": 5, "relevanceScore": 0.5},
            },
        }
    }
    # A version without memory keeps it off, and the harness configurations of the tests too
    # (TM-ME9): never the managed memory a harness gets when nothing is said (TM-ME8).
    assert _config(settings, memory=False)["memory"] == {"disabled": {}}
    models = frozenset({MODEL})
    assert playground_config(settings, models)["memory"] == {"disabled": {}}
    assert evals_config(settings, models)["memory"] == {"disabled": {}}
    for config in (_config(settings, memory=True), _config(settings, memory=False)):
        assert "managedMemoryConfiguration" not in str(config)


def test_the_role_of_an_agent_with_memory_stores_and_recalls_on_this_memory_only() -> None:
    settings = Settings.from_env(ON)
    without = {s["Sid"] for s in role_policy(settings, AGENT, [MODEL])["Statement"]}
    assert "AgentMemory" not in without
    statements = {
        s["Sid"]: s for s in role_policy(settings, AGENT, [MODEL], memory=True)["Statement"]
    }
    assert statements["AgentMemory"]["Action"] == list(MEMORY_ACTIONS)
    assert statements["AgentMemory"]["Resource"] == MEMORY_ARN
    assert not [a for a in MEMORY_ACTIONS if "Delete" in a or a.endswith("*")]
    assert statements["AgentMemoryKey"]["Resource"] == KEY_ARN
    assert statements["AgentMemoryKey"]["Condition"] == {
        "StringEquals": {"kms:ViaService": f"bedrock-agentcore.{REGION}.amazonaws.com"}
    }


@pytest.mark.parametrize(
    "arn",
    [
        "",
        f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:memory/Mango_other_memory-AbCdEf0123",
        f"arn:aws:bedrock-agentcore:{REGION}:999999999999:memory/Mango_test_memory-AbCdEf0123",
        f"arn:aws:bedrock-agentcore:us-west-2:{ACCOUNT}:memory/Mango_test_memory-AbCdEf0123",
        f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:memory/Mango_test_memory_x-AbCdEf0123",
    ],
)
def test_only_this_installations_memory_is_accepted(arn: str) -> None:
    with pytest.raises(ConfigError):
        Settings.from_env({**ON, "AGENT_MEMORY_ARN": arn})


def test_its_key_must_be_of_this_account() -> None:
    with pytest.raises(ConfigError):
        Settings.from_env(
            {
                **ON,
                "AGENT_MEMORY_KEY_ARN": KEY_ARN.replace(ACCOUNT, "999999999999"),
            }
        )
