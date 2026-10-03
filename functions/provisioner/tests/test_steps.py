"""The provisioner end to end against moto (DynamoDB, IAM) and the fake AgentCore."""

from __future__ import annotations

import json
import logging
from datetime import timedelta
from typing import Any

import pytest
from botocore.exceptions import ClientError

from mango_core.agents_table import published_key
from mango_provisioner import handler
from mango_provisioner.errors import BusyError, RetryableError, StepError
from mango_provisioner.steps import MAX_WAIT_ATTEMPTS, failure_of, parse_input
from mango_provisioner.store import LOCK_TTL

from .conftest import (
    AGENT,
    AGENTS_TABLE,
    BOUNDARY_ARN,
    DISABLED_MODEL,
    LOGS_KEY_ARN,
    MODEL,
    MODEL_2,
    PROMPT,
    Lab,
    make_definition,
    release_definition,
)


def _s(item: dict[str, Any], name: str) -> str | None:
    value: str | None = item.get(name, {}).get("S")
    return value


def _events(lab: Lab) -> list[tuple[str, str]]:
    return [(r["event"], r["detail"]["outcome"]) for r in lab.firehose.records]


# --- Publishing ---------------------------------------------------------------------------


def test_first_publication_creates_role_harness_endpoint_and_marks_published(lab: Lab) -> None:
    request = lab.approve(make_definition())
    state = lab.run(request)

    assert state["published"] is True
    harness = lab.agentcore.only()
    assert harness["name"] == "Mango_test_a_" + AGENT
    assert harness["endpoint"]["live"] == "1"
    assert harness["tags"] == {
        "mango:namespace": "test",
        "mango:component": "agent",
        "mango:agent": AGENT,
    }

    role = lab.iam.get_role(RoleName=f"Mango-test-agent-{AGENT}")["Role"]
    assert role["PermissionsBoundary"]["PermissionsBoundaryArn"] == BOUNDARY_ARN
    assert lab.role_models() == [
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6",
        f"arn:aws:bedrock:us-east-1:123456789012:inference-profile/{MODEL}",
    ]

    version, meta = lab.version(1), lab.meta()
    assert _s(version, "status") == "published"
    assert _s(meta, "status") == "published"
    assert meta["published_version"]["N"] == "1"
    assert _s(meta, "harness_arn") == state["harness_id"].join(
        ["arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/", ""]
    )
    assert _s(meta, "harness_version") == "1"
    assert "open_version" not in meta
    assert "provision_lock" not in meta

    pointer = lab.item(published_key(AGENT))
    assert pointer["n"]["N"] == "1"
    assert _s(pointer, "content_hash") == request["content_hash"]
    assert _s(pointer, "harness_arn") == _s(meta, "harness_arn")


def test_runtime_log_groups_get_the_key_and_retention(lab: Lab) -> None:
    lab.run(lab.approve(make_definition()))
    runtime_id = lab.agentcore.only()["runtime_id"]
    prefix = f"/aws/bedrock-agentcore/runtimes/{runtime_id}-"
    assert set(lab.logs.groups) == {prefix + "DEFAULT", prefix + "live"}
    for group in lab.logs.groups.values():
        assert group["kms"] == LOGS_KEY_ARN
        assert group["retention"] == 30


def test_log_groups_agentcore_already_created_are_adopted(lab: Lab) -> None:
    request = lab.approve(make_definition())
    state = lab.run(request, fail_at="govern_logs")  # stops right before, then compensates
    assert state["marked"] is True
    # Second attempt: AgentCore has created the groups on its own, unencrypted.
    lab.db.update_item(
        TableName=AGENTS_TABLE,
        Key={"PK": {"S": f"AGENT#{AGENT}"}, "SK": {"S": "VERSION#000001"}},
        UpdateExpression="SET #s = :a",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":a": {"S": "approved"}},
    )
    original = lab.agentcore.create_harness_endpoint

    def create_with_group(**kwargs: Any) -> dict[str, Any]:
        out = original(**kwargs)
        runtime_id = lab.agentcore.only()["runtime_id"]
        lab.logs.groups[f"/aws/bedrock-agentcore/runtimes/{runtime_id}-live"] = {"kms": None}
        return out

    lab.agentcore.create_harness_endpoint = create_with_group  # type: ignore[method-assign]
    lab.run(request, execution="exec-2")
    assert all(g["kms"] == LOGS_KEY_ARN and g["retention"] == 30 for g in lab.logs.groups.values())


def test_harness_stores_the_approved_definition_and_the_d16_environment(lab: Lab) -> None:
    request = lab.approve(make_definition())
    lab.run(request)
    config = lab.agentcore.only()["versions"][0]["config"]
    assert config["systemPrompt"] == [{"text": PROMPT}]
    assert config["allowedTools"] == ["@mango/finops___get_cost_and_usage"]
    assert config["memory"] == {"disabled": {}}
    assert config["model"]["bedrockModelConfig"]["additionalParams"]["guardrailConfig"] == {
        "guardrailIdentifier": "gr123456",
        "guardrailVersion": "1",
        "trace": "disabled",
    }
    env = config["environmentVariables"]
    assert env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] == "false"
    assert env["OTEL_SEMCONV_STABILITY_OPT_IN"] == "gen_ai_unredacted_attributes="
    assert env["OTEL_PYTHON_DISABLED_INSTRUMENTATIONS"] == "urllib3,aws_mcp"
    assert env["MANGO_CONTENT_HASH"] == request["content_hash"]
    assert env["MANGO_AGENT_VERSION"] == "1"


def test_repeating_a_finished_publication_changes_nothing(lab: Lab) -> None:
    request = lab.approve(make_definition())
    lab.run(request)
    calls = list(lab.agentcore.calls)
    records = len(lab.firehose.records)
    meta = lab.meta()

    state = lab.run(request, execution="exec-2")

    assert state["action"] == "noop"
    assert lab.agentcore.calls == calls
    assert len(lab.firehose.records) == records
    assert lab.meta() == meta


def test_every_step_can_be_repeated_without_side_effects(lab: Lab) -> None:
    """Step Functions may run a step twice (retry after a timeout)."""
    p = lab.provisioner
    state = p.load(lab.approve(make_definition()), "exec-1")
    state = p.ensure_role(p.ensure_role(state))
    state = p.ensure_harness(p.ensure_harness(state))
    assert lab.agentcore.calls.count("CreateHarness") == 1  # found by name, same content
    assert len(lab.agentcore.harnesses) == 1
    while not state["ready"]:
        state = p.check_harness(state)
    state = p.point_live(p.point_live(state))
    assert lab.agentcore.calls.count("CreateHarnessEndpoint") == 1
    while not state["ready"]:
        state = p.check_live(state)
    state = p.govern_logs(p.govern_logs(state))
    state = p.publish(state)
    # The transaction went through but the response was lost: the retry finishes the step.
    lab.store.acquire_lock(AGENT, "exec-1", lab.now)
    state = p.publish(state)
    assert state["published"] is True
    assert _events(lab) == [
        ("agent.version.published", "requested"),
        ("agent.version.published", "applied"),
        ("agent.version.published", "applied"),
    ]
    assert "provision_lock" not in lab.meta()


def test_new_version_updates_the_same_harness_and_moves_live(lab: Lab) -> None:
    lab.run(lab.approve(make_definition()))
    second = make_definition(system_prompt="Second prompt", allowed_models=[MODEL, MODEL_2])
    state = lab.run(lab.approve(second, version=2), execution="exec-2")

    assert state["published"] is True
    harness = lab.agentcore.only()
    assert [v["number"] for v in harness["versions"]] == ["1", "2"]
    assert harness["versions"][1]["config"]["systemPrompt"] == [{"text": "Second prompt"}]
    assert harness["endpoint"]["live"] == "2"
    assert _s(lab.version(1), "status") == "superseded"
    assert _s(lab.version(2), "status") == "published"
    assert lab.meta()["published_version"]["N"] == "2"
    assert _s(lab.meta(), "harness_version") == "2"
    assert lab.item(published_key(AGENT))["n"]["N"] == "2"
    assert len(lab.role_models()) == 4


def test_update_sends_the_complete_configuration(lab: Lab) -> None:
    """UpdateHarness keeps what it is not given: a tool removed must really go away."""
    lab.run(lab.approve(make_definition()))
    lab.run(lab.approve(make_definition(tools=[]), version=2), execution="exec-2")
    config = lab.agentcore.only()["versions"][1]["config"]
    assert config["tools"] == []
    assert config["allowedTools"] == []


def test_role_keeps_the_published_models_until_the_new_version_is_live(lab: Lab) -> None:
    lab.run(lab.approve(make_definition(allowed_models=[MODEL])))
    p = lab.provisioner
    request = lab.approve(make_definition(model=MODEL_2, allowed_models=[MODEL_2]), version=2)
    state = p.ensure_role(p.load(request, "exec-2"))
    assert len(lab.role_models()) == 4  # both, while version 1 still serves
    state = p.ensure_harness(state)
    while not state["ready"]:
        state = p.check_harness(state)
    state = p.point_live(state)
    while not state["ready"]:
        state = p.check_live(state)
    p.publish(p.govern_logs(state))
    assert lab.role_models() == [
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
        f"arn:aws:bedrock:us-east-1:123456789012:inference-profile/{MODEL_2}",
    ]


# --- Refusing to publish ------------------------------------------------------------------


def test_content_changed_after_approval_is_not_deployed(lab: Lab) -> None:
    request = lab.approve(make_definition())
    # Someone rewrites the stored definition after the approval (TM-M2).
    lab.db.update_item(
        TableName=AGENTS_TABLE,
        Key={"PK": {"S": f"AGENT#{AGENT}"}, "SK": {"S": "VERSION#000001"}},
        UpdateExpression="SET #d = :d",
        ExpressionAttributeNames={"#d": "definition"},
        ExpressionAttributeValues={":d": {"S": '{"name":"Evil","system_prompt":"evil"}'}},
    )
    state = lab.run(request)

    assert (state["failed_step"], state["failure"]) == ("after_start", "hash_mismatch")
    assert lab.agentcore.harnesses == {}
    assert not lab.role_exists()
    version = lab.version(1)
    assert _s(version, "status") == "failed"
    assert _s(version, "failed_step") == "after_start"
    assert _s(version, "failure") == "hash_mismatch"
    assert "provision_lock" not in lab.meta()


def test_input_with_another_hash_is_not_deployed(lab: Lab) -> None:
    request = lab.approve(make_definition())
    state = lab.run({**request, "content_hash": "0" * 64})
    assert state["failure"] == "hash_mismatch"
    assert lab.agentcore.harnesses == {}


@pytest.mark.parametrize(
    "bad",
    [
        {"agent_id": AGENT, "version": 1},
        {
            "agent_id": AGENT,
            "version": 1,
            "content_hash": "0" * 64,
            "role_arn": "arn:aws:iam::1:role/x",
        },
        {"agent_id": "../etc", "version": 1, "content_hash": "0" * 64},
        {"agent_id": AGENT, "version": "1", "content_hash": "0" * 64},
        {"agent_id": AGENT, "version": True, "content_hash": "0" * 64},
        {"agent_id": AGENT, "version": 0, "content_hash": "0" * 64},
        {"agent_id": AGENT, "version": 1, "content_hash": "xyz"},
        "not an object",
    ],
)
def test_input_is_exactly_ids_and_hash(bad: object) -> None:
    with pytest.raises(StepError, match="invalid_input"):
        parse_input(bad, "exec-1")


def test_execution_name_must_be_plain() -> None:
    good = {"agent_id": AGENT, "version": 1, "content_hash": "0" * 64}
    with pytest.raises(StepError, match="invalid_input"):
        parse_input(good, "exec 1; drop")
    with pytest.raises(StepError, match="invalid_input"):
        parse_input(good, None)


def test_a_model_that_is_not_enabled_is_not_published(lab: Lab) -> None:
    definition = make_definition(model=DISABLED_MODEL, allowed_models=[DISABLED_MODEL])
    state = lab.run(lab.approve(definition))
    assert state["failure"] == "model_not_enabled"
    assert not lab.role_exists()
    assert lab.agentcore.harnesses == {}


def test_missing_model_catalog_fails_closed(lab: Lab) -> None:
    lab.db.delete_item(
        TableName="Mango-test-Settings", Key={"PK": {"S": "MODELS"}, "SK": {"S": "CATALOG"}}
    )
    state = lab.run(lab.approve(make_definition()))
    assert state["failure"] == "model_catalog_unavailable"
    assert not lab.role_exists()


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"tools": ["unknown.tool"]}, "unknown_tool"),
        ({"tools": ["cost-explorer.not_a_tool"]}, "unknown_tool"),
        ({"tools": ["tickets.close_ticket"]}, "write_tools_unsupported"),
        (
            {
                "tools": ["cost-explorer.get_cost_and_usage"],
                "approval_tools": ["cost-explorer.get_cost_and_usage"],
            },
            "write_tools_unsupported",
        ),
        ({"system_prompt": "  "}, "empty_prompt"),
        ({"model": MODEL_2}, "invalid_model"),
        ({"model": None}, "invalid_model"),
    ],
)
def test_definitions_the_provisioner_refuses(
    lab: Lab, overrides: dict[str, Any], code: str
) -> None:
    state = lab.run(lab.approve(make_definition(**overrides)))
    assert state["failure"] == code
    assert _s(lab.version(1), "status") == "failed"
    assert lab.agentcore.harnesses == {}
    assert not lab.role_exists()


# --- Agents the release ships approved (D34, TM-M16) ---------------------------------------

RELEASE = "release@0.1.0"


def test_release_agent_is_published_when_the_stack_ships_exactly_that_content(lab: Lab) -> None:
    execution_input = lab.approve(release_definition(), agent_id="finops", approved_by=RELEASE)
    lab.ship({"finops": execution_input["content_hash"]})
    result = lab.run(execution_input)
    assert result["published"] is True
    assert lab.version(1, "finops")["status"]["S"] == "published"
    assert lab.agentcore.only()["name"] == "Mango_test_a_finops"
    # The audit trail says who approved it: the release, not a person.
    applied = [e for e in lab.firehose.records if e["detail"]["outcome"] == "applied"]
    assert applied[0]["detail"]["approved_by"] == RELEASE


@pytest.mark.parametrize(
    "shipped",
    [
        {},  # the release ships no such agent
        {"finops": "0" * 64},  # the release ships other content under that id
        {"other": None},  # the hash belongs to another agent of the release
    ],
)
def test_release_approval_is_refused_for_anything_the_release_does_not_ship(
    lab: Lab, shipped: dict[str, Any]
) -> None:
    execution_input = lab.approve(release_definition(), agent_id="finops", approved_by=RELEASE)
    lab.ship({k: v or execution_input["content_hash"] for k, v in shipped.items()})
    result = lab.run(execution_input)
    assert (result["failed_step"], result["failure"]) == ("after_start", "release_approval_invalid")
    assert lab.version(1, "finops")["status"]["S"] == "failed"
    assert lab.agentcore.harnesses == {}
    assert not lab.role_exists("finops")


def test_an_agent_made_in_the_app_cannot_pass_as_approved_by_the_release(lab: Lab) -> None:
    # Whoever can write the table outside mango-api does not get around D18 with this (TM-M16).
    execution_input = lab.approve(make_definition(), approved_by=RELEASE)
    lab.ship({"finops": execution_input["content_hash"]})
    result = lab.run(execution_input)
    assert result["failure"] == "release_approval_invalid"
    assert lab.agentcore.harnesses == {}


def test_a_person_approves_a_later_version_of_a_release_agent(lab: Lab) -> None:
    first = lab.approve(release_definition(), agent_id="finops", approved_by=RELEASE)
    lab.ship({"finops": first["content_hash"]})
    assert lab.run(first)["published"] is True
    # Changes made in the installation follow D18: a person approved this one.
    second = lab.approve(
        release_definition(system_prompt="Changed in the installation."),
        agent_id="finops",
        version=2,
    )
    assert lab.run(second, "exec-2")["published"] is True
    assert lab.meta("finops")["published_version"]["N"] == "2"


def test_versions_that_are_not_approved_are_left_alone(lab: Lab) -> None:
    request = lab.approve(make_definition())
    lab.db.update_item(
        TableName=AGENTS_TABLE,
        Key={"PK": {"S": f"AGENT#{AGENT}"}, "SK": {"S": "VERSION#000001"}},
        UpdateExpression="SET #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": {"S": "in_review"}},
    )
    state = lab.run(request)
    assert state["failure"] == "not_approved"
    assert state["marked"] is False
    assert _s(lab.version(1), "status") == "in_review"
    assert lab.firehose.records == []
    assert "provision_lock" not in lab.meta()


def test_retired_agent_is_not_published(lab: Lab) -> None:
    request = lab.approve(make_definition())
    lab.db.update_item(
        TableName=AGENTS_TABLE,
        Key={"PK": {"S": f"AGENT#{AGENT}"}, "SK": {"S": "META"}},
        UpdateExpression="SET #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": {"S": "retired"}},
    )
    state = lab.run(request)
    assert state["failure"] == "agent_retired"
    assert lab.agentcore.harnesses == {}


def test_unknown_version(lab: Lab) -> None:
    state = lab.run({"agent_id": AGENT, "version": 1, "content_hash": "0" * 64})
    assert state["failure"] == "version_not_found"
    assert state["marked"] is False


def test_audit_failure_stops_the_publication_before_anything_is_created(lab: Lab) -> None:
    lab.firehose.fail = True
    request = lab.approve(make_definition())
    with pytest.raises(RetryableError, match="Audit:"):
        lab.provisioner.load(request, "exec-1")
    assert lab.agentcore.harnesses == {}
    assert not lab.role_exists()

    # The failure is audited too: the lock is kept until that event is written.
    cause = json.dumps({"errorMessage": json.dumps({"step": "load", "code": "Audit:Unavailable"})})
    state = {**request, "execution": "exec-1", "error": {"Error": "X", "Cause": cause}}
    with pytest.raises(RetryableError, match="Audit:"):
        lab.provisioner.mark_failed(lab.provisioner.compensate(state))
    assert _s(lab.version(1), "status") == "failed"
    assert _s(lab.meta(), "provision_lock") == "exec-1"

    lab.firehose.fail = False
    result = lab.provisioner.mark_failed(state)
    assert result["marked"] is True
    assert _events(lab) == [("agent.version.published", "rejected")]
    assert "provision_lock" not in lab.meta()


# --- One execution per agent ----------------------------------------------------------------


def test_second_execution_for_the_same_agent_is_busy_and_touches_nothing(lab: Lab) -> None:
    request = lab.approve(make_definition())
    p = lab.provisioner
    first = p.ensure_harness(p.ensure_role(p.load(request, "exec-1")))

    with pytest.raises(BusyError):
        p.load(request, "exec-2")
    # The failure path of the second execution must not undo the first one's work.
    cause = json.dumps({"errorMessage": json.dumps({"step": "load", "code": "busy"})})
    state = p.mark_failed(
        p.compensate({**request, "execution": "exec-2", "error": {"Cause": cause}})
    )
    assert state["compensated"] is False
    assert state["marked"] is False
    assert len(lab.agentcore.harnesses) == 1
    assert lab.role_exists()
    assert _s(lab.version(1), "status") == "approved"
    assert _s(lab.meta(), "provision_lock") == "exec-1"

    with pytest.raises(BusyError):
        p.ensure_role({**first, "execution": "exec-2"})


def test_an_abandoned_lock_expires(lab: Lab) -> None:
    request = lab.approve(make_definition())
    lab.provisioner.load(request, "exec-1")  # never finishes
    lab.now += LOCK_TTL + timedelta(seconds=1)
    state = lab.run(request, execution="exec-2")
    assert state["published"] is True


# --- Compensation ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "fail_at",
    ["ensure_harness", "check_harness", "point_live", "check_live", "govern_logs", "publish"],
)
def test_failed_first_publication_leaves_nothing_behind(lab: Lab, fail_at: str) -> None:
    state = lab.run(lab.approve(make_definition()), fail_at=fail_at)

    assert state["compensated"] is True
    assert (state["failed_step"], state["failure"]) == (fail_at, "RuntimeError")
    assert lab.agentcore.harnesses == {}
    assert lab.logs.groups == {}
    assert not lab.role_exists()
    version = lab.version(1)
    assert _s(version, "status") == "failed"
    assert _s(version, "failed_step") == fail_at
    assert "published_version" not in lab.meta()
    assert "provision_lock" not in lab.meta()
    assert _events(lab) == [
        ("agent.version.published", "requested"),
        ("agent.version.published", "rejected"),
    ]
    rejected = lab.firehose.records[-1]["detail"]
    assert rejected["failed_step"] == fail_at
    assert rejected["created_by"] == "creator-1"
    assert rejected["approved_by"] == "admin-2"


def test_removal_waits_for_the_harness_before_deleting_the_role(lab: Lab) -> None:
    request = lab.approve(make_definition())
    p = lab.provisioner
    state = p.ensure_harness(p.ensure_role(p.load(request, "exec-1")))
    while not state["ready"]:
        state = p.check_harness(state)
    state = p.point_live(state)

    with pytest.raises(RetryableError, match="endpoint_deleting"):
        p.compensate(state)
    assert lab.role_exists()  # the harness still exists: its role stays
    for _ in range(6):
        try:
            p.compensate(state)
            break
        except RetryableError:
            assert lab.role_exists()
    assert lab.agentcore.harnesses == {}
    assert not lab.role_exists()


@pytest.mark.parametrize("fail_at", ["ensure_harness", "point_live", "govern_logs", "publish"])
def test_failed_update_keeps_the_published_version_serving(lab: Lab, fail_at: str) -> None:
    lab.run(lab.approve(make_definition(allowed_models=[MODEL])))
    second = make_definition(system_prompt="Second", model=MODEL_2, allowed_models=[MODEL_2])
    state = lab.run(lab.approve(second, version=2), execution="exec-2", fail_at=fail_at)

    assert state["compensated"] is True
    harness = lab.agentcore.only()
    endpoint = harness["endpoint"]
    assert (endpoint["target"] or endpoint["live"]) == "1"
    assert lab.role_models() == [
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6",
        f"arn:aws:bedrock:us-east-1:123456789012:inference-profile/{MODEL}",
    ]
    assert _s(lab.version(1), "status") == "published"
    assert _s(lab.version(2), "status") == "failed"
    assert lab.meta()["published_version"]["N"] == "1"
    assert lab.item(published_key(AGENT))["n"]["N"] == "1"
    assert set(lab.logs.groups)  # log groups of a published agent are never deleted


def test_tampered_meta_cannot_make_compensation_delete_a_published_agent(lab: Lab) -> None:
    """What is live is decided by the pointer only the provisioner writes, not by META."""
    lab.run(lab.approve(make_definition()))
    request = lab.approve(make_definition(system_prompt="Second"), version=2)
    # A defect in mango-api (or its role) drops the publication fields of META.
    lab.db.update_item(
        TableName=AGENTS_TABLE,
        Key={"PK": {"S": f"AGENT#{AGENT}"}, "SK": {"S": "META"}},
        UpdateExpression="REMOVE published_version, harness_arn, harness_version",
    )
    state = lab.run(request, execution="exec-2", fail_at="publish")

    assert state["compensated"] is True
    harness = lab.agentcore.only()  # still there, not recreated
    assert [v["number"] for v in harness["versions"]] == ["1", "2"]
    endpoint = harness["endpoint"]
    assert (endpoint["target"] or endpoint["live"]) == "1"
    assert lab.role_exists()
    assert set(lab.logs.groups)


def test_retry_of_a_failed_update_reuses_the_harness_version(lab: Lab) -> None:
    lab.run(lab.approve(make_definition()))
    request = lab.approve(make_definition(system_prompt="Second"), version=2)
    lab.run(request, execution="exec-2", fail_at="publish")
    assert len(lab.agentcore.only()["versions"]) == 2
    # mango-api's retry puts the same content back to `approved`.
    lab.db.update_item(
        TableName=AGENTS_TABLE,
        Key={"PK": {"S": f"AGENT#{AGENT}"}, "SK": {"S": "VERSION#000002"}},
        UpdateExpression="SET #s = :a",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":a": {"S": "approved"}},
    )
    state = lab.run(request, execution="exec-3")
    assert state["published"] is True
    assert len(lab.agentcore.only()["versions"]) == 2
    assert lab.agentcore.only()["endpoint"]["live"] == "2"


def test_harness_that_fails_to_create_is_removed(lab: Lab) -> None:
    lab.agentcore.fail_harness_creation = True
    state = lab.run(lab.approve(make_definition()))
    assert (state["failed_step"], state["failure"]) == ("after_ensure_harness", "harness_failed")
    assert lab.agentcore.harnesses == {}
    assert not lab.role_exists()


def test_waiting_gives_up(lab: Lab) -> None:
    lab.agentcore.polls_until_ready = 10_000
    p = lab.provisioner
    state = p.ensure_harness(p.ensure_role(p.load(lab.approve(make_definition()), "exec-1")))
    for _ in range(MAX_WAIT_ATTEMPTS):
        state = p.check_harness(state)
    with pytest.raises(StepError, match="harness_timeout"):
        p.check_harness(state)


def test_publication_conflict_restores_and_does_not_publish(lab: Lab) -> None:
    """The agent is retired while its new version is being deployed."""
    lab.run(lab.approve(make_definition()))
    p = lab.provisioner
    state = p.ensure_harness(
        p.ensure_role(p.load(lab.approve(make_definition(system_prompt="2"), version=2), "exec-2"))
    )
    while not state["ready"]:
        state = p.check_harness(state)
    state = p.point_live(state)
    while not state["ready"]:
        state = p.check_live(state)
    state = p.govern_logs(state)
    lab.db.update_item(
        TableName=AGENTS_TABLE,
        Key={"PK": {"S": f"AGENT#{AGENT}"}, "SK": {"S": "META"}},
        UpdateExpression="REMOVE open_version",
    )
    with pytest.raises(StepError, match="not_approved"):
        p.publish(state)
    assert _s(lab.version(2), "status") == "approved"
    assert lab.item(published_key(AGENT))["n"]["N"] == "1"


# --- What leaves the function -----------------------------------------------------------------


def test_failure_of_reads_step_errors_and_anything_else() -> None:
    cause = json.dumps(
        {"errorMessage": json.dumps({"step": "ensure_role", "code": "role_without_boundary"})}
    )
    assert failure_of({"Error": "ProvisionerStepError", "Cause": cause}, "load") == (
        "ensure_role",
        "role_without_boundary",
    )
    assert failure_of({"Error": "States.Timeout", "Cause": ""}, "ensure_role") == (
        "after_ensure_role",
        "States.Timeout",
    )
    assert failure_of({"Error": "Lambda.Unknown", "Cause": "not json"}, None) == (
        "unknown",
        "Lambda.Unknown",
    )
    assert failure_of(None, None) == ("unknown", "unknown")
    hostile = json.dumps(
        {"errorMessage": json.dumps({"step": "Bad Step!", "code": "a b\n<script>"})}
    )
    assert failure_of({"Error": "X", "Cause": hostile}, "load") == ("after_load", "a_b__script_")


def test_handler_passes_the_execution_name_from_the_context_not_the_state(lab: Lab) -> None:
    request = lab.approve(make_definition())
    state = handler.handle(
        {"step": "load", "state": request, "execution": "exec-1"}, lab.provisioner
    )
    assert state["last_step"] == "load"
    # A forged owner inside the state is ignored: the context decides.
    forged = {**state, "execution": "exec-1"}
    with pytest.raises(handler.ProvisionerStepError) as error:
        handler.handle(
            {"step": "ensure_role", "state": forged, "execution": "exec-2"}, lab.provisioner
        )
    assert json.loads(str(error.value)) == {"step": "ensure_role", "code": "busy"}


def test_handler_reports_retryable_errors_with_their_own_type(lab: Lab) -> None:
    request = lab.approve(make_definition())
    lab.agentcore.fail_next["CreateHarness"] = ClientError(
        {"Error": {"Code": "ValidationException", "Message": "Role validation failed for 'arn'"}},
        "CreateHarness",
    )
    state = handler.handle(
        {"step": "load", "state": request, "execution": "exec-1"}, lab.provisioner
    )
    state = handler.handle(
        {"step": "ensure_role", "state": state, "execution": "exec-1"}, lab.provisioner
    )
    with pytest.raises(handler.RetryableStepError) as error:
        handler.handle(
            {"step": "ensure_harness", "state": state, "execution": "exec-1"}, lab.provisioner
        )
    assert json.loads(str(error.value)) == {"step": "ensure_harness", "code": "role_not_ready"}


def test_handler_rejects_unknown_steps(lab: Lab) -> None:
    for event in ({"step": "delete_everything", "state": {}}, {"state": {}}, "x", None):
        with pytest.raises(handler.ProvisionerStepError, match="invalid_step"):
            handler.handle(event, lab.provisioner)


def test_aws_messages_never_reach_the_error(lab: Lab) -> None:
    request = lab.approve(make_definition())
    lab.agentcore.fail_next["CreateHarness"] = ClientError(
        {
            "Error": {
                "Code": "AccessDeniedException",
                "Message": "User arn:aws:sts::1:assumed-role/secret is not authorized",
            }
        },
        "CreateHarness",
    )
    state = handler.handle(
        {"step": "load", "state": request, "execution": "exec-1"}, lab.provisioner
    )
    state = handler.handle(
        {"step": "ensure_role", "state": state, "execution": "exec-1"}, lab.provisioner
    )
    with pytest.raises(handler.ProvisionerStepError) as error:
        handler.handle(
            {"step": "ensure_harness", "state": state, "execution": "exec-1"}, lab.provisioner
        )
    assert json.loads(str(error.value)) == {
        "step": "ensure_harness",
        "code": "CreateHarness:AccessDeniedException",
    }


def test_definition_never_travels_in_state_logs_or_audit(
    lab: Lab, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    request = lab.approve(make_definition())
    state: dict[str, Any] = request
    seen: list[dict[str, Any]] = []
    for step in (
        "load",
        "ensure_role",
        "ensure_harness",
        "check_harness",
        "point_live",
        "check_live",
        "govern_logs",
        "publish",
    ):
        state = handler.handle(
            {"step": step, "state": state, "execution": "exec-1"}, lab.provisioner
        )
        seen.append(state)
        while step.startswith("check") and not state["ready"]:
            state = handler.handle(
                {"step": step, "state": state, "execution": "exec-1"}, lab.provisioner
            )
    assert state["published"] is True
    marker = "SECRET-PROMPT-MARKER"
    assert marker not in json.dumps(seen)
    assert marker not in caplog.text
    assert marker not in json.dumps(lab.firehose.records)
    assert set(state) <= {
        "agent_id",
        "version",
        "content_hash",
        "execution",
        "action",
        "harness_id",
        "harness_version",
        "runtime_id",
        "ready",
        "attempts",
        "published",
        "last_step",
    }


# --- Tools of MCP packs (Marketplace v1, B3) -------------------------------------------------


def _install_pack(lab: Lab, pack_id: str, tools: object) -> None:
    """The pointer the pack provisioner writes when a pack is enabled."""
    lab.db.put_item(
        TableName="Mango-test-Settings",
        Item={
            "PK": {"S": f"MCP_INSTALLED#{pack_id}"},
            "SK": {"S": "CURRENT"},
            "pack_version": {"S": "1.1.1-1"},
            "tools": {"S": json.dumps(tools)},
        },
    )


def test_tools_of_an_installed_pack_are_allowed_with_the_pack_as_target(lab: Lab) -> None:
    _install_pack(lab, "aws-pricing", ["get_pricing", "get_pricing_service_codes"])
    definition = make_definition(
        tools=["cost-explorer.get_cost_and_usage", "aws-pricing.get_pricing"]
    )
    state = lab.run(lab.approve(definition))

    assert state["published"] is True
    assert lab.agentcore.only()["versions"][-1]["config"]["allowedTools"] == [
        "@mango/aws-pricing___get_pricing",
        "@mango/finops___get_cost_and_usage",
    ]


@pytest.mark.parametrize(
    ("installed", "tool"),
    [
        (None, "aws-pricing.get_pricing"),  # the pack is not installed
        (["get_pricing_service_codes"], "aws-pricing.get_pricing"),  # not a tool it serves
        (["get_pricing"], "finops.get_pricing"),  # a pack never takes a connector's target
        (["get_pricing"], "9pricing.get_pricing"),  # not a pack id
    ],
)
def test_pack_tools_the_installation_does_not_serve_are_refused(
    lab: Lab, installed: list[str] | None, tool: str
) -> None:
    if installed is not None:
        _install_pack(lab, "aws-pricing", installed)
        _install_pack(lab, "finops", installed)
    state = lab.run(lab.approve(make_definition(tools=[tool])))
    assert state["failure"] == "unknown_tool"
    assert not lab.role_exists()


@pytest.mark.parametrize("tools", ["not json", {"get_pricing": "read"}, [1, 2]])
def test_unreadable_installed_pointer_fails_closed(lab: Lab, tools: object) -> None:
    lab.db.put_item(
        TableName="Mango-test-Settings",
        Item={
            "PK": {"S": "MCP_INSTALLED#aws-pricing"},
            "SK": {"S": "CURRENT"},
            "tools": {"S": tools if isinstance(tools, str) else json.dumps(tools)},
        },
    )
    state = lab.run(lab.approve(make_definition(tools=["aws-pricing.get_pricing"])))
    assert state["failure"] == "installed_pack_invalid"
    assert not lab.role_exists()
