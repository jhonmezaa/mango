"""The evals harness (D110), kept by the provisioner's steps like the Playground's."""

from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

import pytest

from mango_core.evals_harness import Capture, EvalsHarness, provision_input
from mango_core.playground import provision_input as playground_input
from mango_provisioner.harness import EVALS_PROMPT, REDACT_GENAI_CONTENT

from .conftest import EVALS_LOGS_KEY_ARN, LOGS_KEY_ARN, MODEL, MODEL_2, SETTINGS_TABLE, Lab

RELEASE = "v0.1.0-g1a2b3c4"


def _item(lab: Lab, sk: str) -> dict[str, Any] | None:
    item: dict[str, Any] | None = lab.db.get_item(
        TableName=SETTINGS_TABLE,
        Key={"PK": {"S": "EVALS"}, "SK": {"S": sk}},
        ConsistentRead=True,
    ).get("Item")
    return item


def _events(lab: Lab) -> list[tuple[str, str]]:
    return [(r["event"], r["detail"]["outcome"]) for r in lab.firehose.records]


def _harness(lab: Lab, name: str) -> dict[str, Any]:
    (harness,) = [h for h in lab.agentcore.harnesses.values() if h["name"] == name]
    return harness


def test_creates_the_evals_harness_with_content_and_its_own_log_key(lab: Lab) -> None:
    state = lab.run(provision_input(RELEASE))

    assert state["published"] is True
    harness = _harness(lab, "Mango_test_a_evals")
    config = harness["versions"][-1]["config"]
    env = config["environmentVariables"]
    # D110 (3): the redaction of D16 is left out, and only here.
    assert not set(REDACT_GENAI_CONTENT) - {"OTEL_PYTHON_DISABLED_INSTRUMENTATIONS"} & set(env)
    assert "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT" not in env
    assert "OTEL_SEMCONV_STABILITY_OPT_IN" not in env
    assert "AWS_REDACT_SPAN_ATTRIBUTES" not in env
    # D110 (8): spans with their content to its own log group, never to aws/spans.
    assert env["UNIFIED_TRACES_DESTINATION_ENABLED"] == "true"
    assert env["MANGO_AGENT_ID"] == "evals"
    assert config["tools"] == []
    assert config["allowedTools"] == []
    assert config["systemPrompt"] == [{"text": EVALS_PROMPT}]
    assert config["executionRoleArn"].endswith(":role/Mango-test-agent-evals")
    # Its runtime log groups get the evals key, never the shared runtime logs key.
    groups = {n: g for n, g in lab.logs.groups.items() if "Mango_test_a_evals" in n}
    assert len(groups) == 2
    assert {g["kms"] for g in groups.values()} == {EVALS_LOGS_KEY_ARN}
    assert {g["retention"] for g in groups.values()} == {30}
    assert _events(lab) == [("evals.harness", "requested"), ("evals.harness", "applied")]


def test_the_capture_is_pending_until_the_canary_and_the_canary_is_asked(lab: Lab) -> None:
    lab.run(provision_input(RELEASE))

    harness = _item(lab, "HARNESS")
    capture = _item(lab, "CAPTURE")
    assert harness is not None and capture is not None
    evals = EvalsHarness.from_item(harness)
    deployed = evals.deployed
    assert evals.runtime_id.startswith("harness_Mango_test_a_evals-")
    assert deployed.models == tuple(sorted([MODEL, MODEL_2]))
    found = Capture.from_item(capture)
    assert found.status == "pending"
    assert found.harness_version == deployed.harness_version
    assert not found.verified_for(deployed.harness_version)
    (call,) = lab.judge.invocations
    assert call["FunctionName"] == "Mango-test-EvalJudge"
    assert call["InvocationType"] == "Event"
    assert call["Payload"] == {"action": "canary", "harness_version": deployed.harness_version}


def test_the_role_may_set_the_trace_destination_of_its_own_log_groups_only(lab: Lab) -> None:
    lab.run(provision_input(RELEASE))
    policy = lab.iam.get_role_policy(RoleName="Mango-test-agent-evals", PolicyName="agent")
    statements = {s["Sid"]: s for s in policy["PolicyDocument"]["Statement"]}
    unified = statements["UnifiedTracesDestination"]
    assert unified["Action"] == ["logs:PutResourcePolicy", "logs:DescribeResourcePolicies"]
    assert unified["Resource"] == (
        "arn:aws:logs:us-east-1:123456789012:log-group:"
        "/aws/bedrock-agentcore/runtimes/harness_Mango_test_a_evals-*"
    )


def test_the_playground_and_the_agents_keep_the_redaction(lab: Lab) -> None:
    lab.run(provision_input(RELEASE))
    lab.run(playground_input(RELEASE), execution="exec-2")

    playground = _harness(lab, "Mango_test_a_playground")
    env = playground["versions"][-1]["config"]["environmentVariables"]
    assert env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] == "false"
    assert "UNIFIED_TRACES_DESTINATION_ENABLED" not in env
    assert {g["kms"] for n, g in lab.logs.groups.items() if "Mango_test_a_playground" in n} == {
        LOGS_KEY_ARN
    }
    policy = lab.iam.get_role_policy(RoleName="Mango-test-agent-playground", PolicyName="agent")
    assert "UnifiedTracesDestination" not in json.dumps(policy["PolicyDocument"])


def test_without_the_evaluator_the_evals_harness_is_not_created(lab: Lab) -> None:
    settings = replace(lab.settings, eval_judge_function="")
    lab.provisioner._evals._settings = settings
    state = lab.run(provision_input(RELEASE))

    assert state["failure"] == "evals_unavailable"
    assert lab.agentcore.harnesses == {}
    assert lab.judge.invocations == []
    assert _events(lab) == [("evals.harness", "rejected")]


def test_a_failure_before_publishing_asks_no_canary(lab: Lab) -> None:
    state = lab.run(provision_input(RELEASE), fail_at="govern_logs")

    assert state["marked"] is True
    assert _item(lab, "HARNESS") is None
    assert lab.judge.invocations == []


@pytest.mark.parametrize(
    "bad",
    [
        {"evals": "ensure"},
        {"evals": "delete", "release": RELEASE},
        {"evals": "ensure", "release": RELEASE, "playground": "ensure"},
    ],
)
def test_input_is_exactly_the_action_and_a_release(lab: Lab, bad: dict[str, Any]) -> None:
    state = lab.run(bad)

    assert state["failure"] == "invalid_input"
    assert lab.agentcore.harnesses == {}


def _agentcore_creates_the_log_groups(lab: Lab) -> None:
    """AgentCore creates the runtime's log groups on its own, unencrypted, and sets the unified
    span destination up on them, seconds before the provisioner governs them (2026-11-06)."""
    original = lab.agentcore.create_harness_endpoint

    def create_with_groups(**kwargs: Any) -> dict[str, Any]:
        out = original(**kwargs)
        for harness in lab.agentcore.harnesses.values():
            runtime_id = harness["runtime_id"]
            for suffix in ("DEFAULT", "live"):
                name = f"/aws/bedrock-agentcore/runtimes/{runtime_id}-{suffix}"
                lab.logs.groups.setdefault(name, {"kms": None})
        return out

    lab.agentcore.create_harness_endpoint = create_with_groups  # type: ignore[method-assign]


def _evals_groups(lab: Lab) -> set[str]:
    return {n for n in lab.logs.groups if "Mango_test_a_evals" in n}


def test_adopted_evals_log_groups_get_their_key_bound_again_while_not_verified(lab: Lab) -> None:
    _agentcore_creates_the_log_groups(lab)
    lab.run(provision_input(RELEASE))

    groups = _evals_groups(lab)
    assert len(groups) == 2
    # D110 (9): taken off and associated again, since no eval may run yet (capture pending).
    assert sorted(lab.logs.disassociated) == sorted(groups)
    assert {lab.logs.groups[n]["kms"] for n in groups} == {EVALS_LOGS_KEY_ARN}


def test_a_failed_capture_gets_the_key_bound_again_on_the_next_release(lab: Lab) -> None:
    _agentcore_creates_the_log_groups(lab)
    lab.run(provision_input(RELEASE))
    version = Capture.from_item(_item(lab, "CAPTURE") or {}).harness_version
    lab.db.put_item(
        TableName=SETTINGS_TABLE,
        Item=Capture("failed", version, "2026-11-06T15:20:00+00:00", "no_spans_delivered").item(),
    )
    lab.logs.disassociated.clear()
    lab.run(provision_input("v0.1.1-g1a2b3c4"), execution="exec-2")

    assert sorted(lab.logs.disassociated) == sorted(_evals_groups(lab))
    assert {lab.logs.groups[n]["kms"] for n in _evals_groups(lab)} == {EVALS_LOGS_KEY_ARN}


def test_a_verified_capture_leaves_the_key_alone(lab: Lab) -> None:
    _agentcore_creates_the_log_groups(lab)
    lab.run(provision_input(RELEASE))
    version = Capture.from_item(_item(lab, "CAPTURE") or {}).harness_version
    lab.db.put_item(
        TableName=SETTINGS_TABLE,
        Item=Capture("verified", version, "2026-11-06T15:20:00+00:00").item(),
    )
    lab.logs.disassociated.clear()
    lab.logs.associated.clear()
    lab.run(provision_input("v0.1.1-g1a2b3c4"), execution="exec-2")

    # Evals may be running: the content never goes a moment without its key.
    assert lab.logs.disassociated == []
    # Nor is the same key associated again: a write that changes nothing is left out.
    assert lab.logs.associated == []
    assert {lab.logs.groups[n]["kms"] for n in _evals_groups(lab)} == {EVALS_LOGS_KEY_ARN}


def test_a_release_that_changes_nothing_rewrites_neither_the_role_nor_the_retention(
    lab: Lab,
) -> None:
    """A turn of the evals harness seconds after a release rewrote its role and its log groups'
    retention, unchanged, got no span at all (2026-11-06, D110 (9))."""
    _agentcore_creates_the_log_groups(lab)
    lab.run(provision_input(RELEASE))
    version = Capture.from_item(_item(lab, "CAPTURE") or {}).harness_version
    lab.db.put_item(
        TableName=SETTINGS_TABLE,
        Item=Capture("verified", version, "2026-11-06T15:20:00+00:00").item(),
    )
    writes: list[str] = []
    real = lab.iam.put_role_policy

    def put_role_policy(**kwargs: Any) -> Any:
        writes.append(kwargs["RoleName"])
        return real(**kwargs)

    lab.iam.put_role_policy = put_role_policy  # type: ignore[method-assign]
    lab.logs.retention_set.clear()
    lab.run(provision_input("v0.1.1-g1a2b3c4"), execution="exec-2")

    assert writes == []
    assert lab.logs.retention_set == []
    assert {lab.logs.groups[n]["retention"] for n in _evals_groups(lab)} == {30}


def test_the_playground_never_gets_its_key_taken_off(lab: Lab) -> None:
    _agentcore_creates_the_log_groups(lab)
    lab.run(playground_input(RELEASE))

    assert lab.logs.disassociated == []
    assert {g["kms"] for n, g in lab.logs.groups.items() if "Mango_test_a_playground" in n} == {
        LOGS_KEY_ARN
    }
