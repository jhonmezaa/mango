"""The Playground's shared test harness (D91), kept by the provisioner's steps."""

from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

import pytest

from mango_core.playground import PlaygroundHarness, provision_input
from mango_provisioner.harness import PLAYGROUND_IDLE_SECONDS, PLAYGROUND_PROMPT

from .conftest import (
    BOUNDARY_ARN,
    DISABLED_MODEL,
    MODEL,
    MODEL_2,
    SETTINGS_TABLE,
    Lab,
    make_definition,
)

RELEASE = "v0.1.0-g1a2b3c4"


def _deployed(lab: Lab) -> PlaygroundHarness:
    item = lab.db.get_item(
        TableName=SETTINGS_TABLE,
        Key={"PK": {"S": "PLAYGROUND"}, "SK": {"S": "HARNESS"}},
        ConsistentRead=True,
    )["Item"]
    return PlaygroundHarness.from_item(item)


def _set_models(lab: Lab, models: list[dict[str, Any]]) -> None:
    lab.db.put_item(
        TableName=SETTINGS_TABLE,
        Item={
            "PK": {"S": "MODELS"},
            "SK": {"S": "CATALOG"},
            "models": {"S": json.dumps(models)},
            "version": {"N": "2"},
        },
    )


def _events(lab: Lab) -> list[tuple[str, str]]:
    return [(r["event"], r["detail"]["outcome"]) for r in lab.firehose.records]


def test_creates_the_role_the_harness_and_live_and_says_where_they_are(lab: Lab) -> None:
    state = lab.run(provision_input(RELEASE))

    assert state["published"] is True
    harness = lab.agentcore.only()
    assert harness["name"] == "Mango_test_a_playground"
    assert harness["endpoint"]["live"] == "1"
    assert harness["tags"] == {
        "mango:namespace": "test",
        "mango:component": "agent",
        "mango:agent": "playground",
    }
    role = lab.iam.get_role(RoleName="Mango-test-agent-playground")["Role"]
    assert role["PermissionsBoundary"]["PermissionsBoundaryArn"] == BOUNDARY_ARN

    deployed = _deployed(lab)
    assert deployed.harness_arn == (
        f"arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/{harness['id']}"
    )
    assert deployed.harness_version == "1"
    # Every enabled model of the catalog, and only those.
    assert deployed.models == tuple(sorted([MODEL, MODEL_2]))
    assert DISABLED_MODEL not in json.dumps(lab.role_models("playground"))
    assert _events(lab) == [("playground.harness", "requested"), ("playground.harness", "applied")]


def test_the_harness_has_no_tools_no_memory_and_no_agent_content(lab: Lab) -> None:
    lab.run(provision_input(RELEASE))
    config = lab.agentcore.only()["versions"][-1]["config"]

    assert config["tools"] == []
    assert config["allowedTools"] == []
    assert config["memory"] == {"disabled": {}}
    assert config["systemPrompt"] == [{"text": PLAYGROUND_PROMPT}]
    assert config["executionRoleArn"].endswith(":role/Mango-test-agent-playground")
    lifecycle = config["environment"]["agentCoreRuntimeEnvironment"]["lifecycleConfiguration"]
    assert lifecycle["idleRuntimeSessionTimeout"] == PLAYGROUND_IDLE_SECONDS
    guardrail = config["model"]["bedrockModelConfig"]["additionalParams"]["guardrailConfig"]
    assert guardrail["guardrailIdentifier"] == "gr123456"
    env = config["environmentVariables"]
    assert env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] == "false"
    assert env["MANGO_AGENT_ID"] == "playground"


def test_another_release_with_the_same_harness_changes_nothing_in_it(lab: Lab) -> None:
    lab.run(provision_input(RELEASE))
    calls = len(lab.agentcore.calls)
    state = lab.run(provision_input("v0.1.0-gffffff1"), execution="exec-2")

    assert state["published"] is True
    harness = lab.agentcore.only()
    assert len(harness["versions"]) == 1
    assert "UpdateHarness" not in lab.agentcore.calls[calls:]
    assert "CreateHarness" not in lab.agentcore.calls[calls:]


def test_a_catalog_change_rewrites_the_models_of_the_role(lab: Lab) -> None:
    lab.run(provision_input(RELEASE))
    _set_models(lab, [{"id": MODEL, "enabled": True}, {"id": MODEL_2, "enabled": False}])
    lab.run(provision_input("models-1793000000"), execution="exec-2")

    assert _deployed(lab).models == (MODEL,)
    assert "haiku" not in json.dumps(lab.role_models("playground"))


def test_without_enabled_models_nothing_is_created(lab: Lab) -> None:
    _set_models(lab, [{"id": MODEL, "enabled": False}])
    state = lab.run(provision_input(RELEASE))

    assert state["failure"] == "model_not_enabled"
    assert lab.agentcore.harnesses == {}
    assert not lab.role_exists("playground")
    assert _events(lab) == [("playground.harness", "rejected")]


def test_a_failure_leaves_the_harness_that_serves_tests(lab: Lab) -> None:
    lab.run(provision_input(RELEASE))
    before = _deployed(lab)
    state = lab.run(provision_input("v0.1.0-g2b3c4d5"), execution="exec-2", fail_at="point_live")

    assert state["marked"] is True
    assert state["failed_step"] == "point_live"
    assert lab.agentcore.only()["endpoint"]["live"] == "1"
    assert lab.role_exists("playground")
    assert _deployed(lab) == before
    assert _events(lab)[-1] == ("playground.harness", "rejected")


@pytest.mark.parametrize(
    "bad",
    [
        {"playground": "ensure"},
        {"playground": "delete", "release": RELEASE},
        {"playground": "ensure", "release": "../etc"},
        {"playground": "ensure", "release": RELEASE, "agent_id": "abcdefghijklmnop"},
        {"playground": True, "release": RELEASE},
    ],
)
def test_input_is_exactly_the_action_and_a_release(lab: Lab, bad: dict[str, Any]) -> None:
    state = lab.run(bad)

    assert state["failure"] == "invalid_input"
    assert lab.agentcore.harnesses == {}
    assert not lab.role_exists("playground")
    # The rejection is audited, without echoing an input that was not valid.
    (record,) = lab.firehose.records
    assert record["detail"]["outcome"] == "rejected"
    if bad.get("release") != RELEASE or set(bad) != {"playground", "release"}:
        assert "../etc" not in json.dumps(record)


def test_an_agent_publication_still_works_next_to_it(lab: Lab) -> None:
    lab.run(provision_input(RELEASE))
    state = lab.run(lab.approve(make_definition()), execution="exec-2")

    assert state["published"] is True
    assert len(lab.agentcore.harnesses) == 2
    assert _deployed(lab).harness_version == "1"


def _policy(lab: Lab) -> dict[str, Any]:
    document: dict[str, Any] = lab.iam.get_role_policy(
        RoleName="Mango-test-agent-playground", PolicyName="agent"
    )["PolicyDocument"]
    return document


def test_the_role_reads_every_approved_skill_version(lab: Lab) -> None:
    """D91 (12): the tested version's skills come in the invocation; the role reads them all,
    and only under ``skills/``."""
    key = "arn:aws:kms:us-east-1:123456789012:key/22222222-3333-4444-5555-666666666666"
    settings = replace(lab.settings, skills_bucket="mango-test-skills", skills_key_arn=key)
    # The installation has a skills bucket: what the steps and the roles read.
    lab.provisioner._playground._settings = settings
    lab.provisioner._roles._settings = settings
    lab.run(provision_input(RELEASE))

    statements = {s["Sid"]: s for s in _policy(lab)["Statement"]}
    assert statements["ReadSkills"]["Action"] == "s3:GetObject"
    assert statements["ReadSkills"]["Resource"] == "arn:aws:s3:::mango-test-skills/skills/*"
    assert statements["ListSkills"]["Condition"] == {
        "StringLike": {"s3:prefix": ["skills/", "skills/*"]}
    }
    assert statements["SkillsKey"]["Resource"] == key
    assert _deployed(lab).skills is True
    # None of its own: an update keeps the skills it is not given.
    assert lab.agentcore.only()["versions"][-1]["config"]["skills"] == []


def test_without_a_skills_bucket_the_role_reads_none_and_says_so(lab: Lab) -> None:
    lab.run(provision_input(RELEASE))
    assert not {"ReadSkills", "ListSkills", "SkillsKey"} & {
        s["Sid"] for s in _policy(lab)["Statement"]
    }
    assert _deployed(lab).skills is False
