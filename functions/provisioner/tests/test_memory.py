"""The agents' memory in the provisioner (D122 (8) as precised on 2026-11-08;
``memory-threat-model.md`` TM-ME1, ME2, ME8, ME9): the harness never has a memory of its own,
whatever the version or the installation says, and the agent role never reaches the memory.
The turn worker recalls and writes, with its own role."""

from __future__ import annotations

from mango_provisioner.config import Settings
from mango_provisioner.harness import evals_config, harness_config, playground_config
from mango_provisioner.role import role_policy

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


def test_a_harness_never_has_memory_even_with_memory_on() -> None:
    settings = Settings.from_env(ON)
    models = frozenset({MODEL})
    for config in (
        _config(settings, memory=True),
        _config(settings, memory=False),
        playground_config(settings, models),
        evals_config(settings, models),
    ):
        assert config["memory"] == {"disabled": {}}
        # Never the managed memory a harness gets when nothing is said (TM-ME8).
        assert "MemoryConfiguration" not in str(config)


def test_the_agent_role_never_reaches_the_memory() -> None:
    settings = Settings.from_env(ON)
    for policy in (
        role_policy(settings, AGENT, [MODEL]),
        role_policy(settings, AGENT, [MODEL], all_skills=True),
    ):
        text = str(policy)
        actions = [
            a
            for s in policy["Statement"]
            for a in ([s["Action"]] if isinstance(s["Action"], str) else s["Action"])
        ]
        assert not [a for a in actions if "Memory" in a or a.endswith("Event")]
        assert MEMORY_ARN not in text
        assert KEY_ARN not in text
