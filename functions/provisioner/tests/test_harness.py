"""Harness calls with botocore's Stubber: exact requests, and how AWS answers are read."""

from __future__ import annotations

from typing import Any

import boto3
import pytest
from botocore.stub import ANY, Stubber

from mango_provisioner.config import Settings
from mango_provisioner.errors import RetryableError, StepError
from mango_provisioner.harness import (
    ENV_CONFIG_HASH,
    Harnesses,
    HarnessRef,
    allowed_tools,
    harness_config,
)

from .conftest import AGENT, ENV, make_definition

SETTINGS = Settings.from_env(ENV)
NAME = f"Mango_test_a_{AGENT}"
HID = f"{NAME}-AbCdEf0123"
ARN = f"arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/{HID}"
RUNTIME = f"harness_{NAME}-Zz99887766"
RUNTIME_ARN = f"arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/{RUNTIME}"
CONFIG = harness_config(
    SETTINGS, agent_id=AGENT, version=3, content_hash="a" * 64, definition=make_definition()
)


@pytest.fixture
def stubbed() -> tuple[Harnesses, Stubber]:
    client = boto3.client(
        "bedrock-agentcore-control",
        region_name="us-east-1",
        aws_access_key_id="x",
        aws_secret_access_key="x",
    )
    stubber = Stubber(client)
    stubber.activate()
    return Harnesses(client, SETTINGS), stubber


def _harness(
    status: str = "READY", version: str = "1", env: dict[str, str] | None = None, **extra: Any
) -> dict[str, Any]:
    return {
        "harness": {
            "harnessId": HID,
            "harnessName": NAME,
            "arn": ARN,
            "status": status,
            "harnessVersion": version,
            "executionRoleArn": SETTINGS.role_arn(AGENT),
            "createdAt": "2026-10-01T00:00:00Z",
            "updatedAt": "2026-10-01T00:00:00Z",
            "model": {"bedrockModelConfig": {"modelId": "m"}},
            "systemPrompt": [{"text": "x"}],
            "tools": [],
            "skills": [],
            "allowedTools": [],
            "truncation": {"strategy": "none"},
            "environment": {
                "agentCoreRuntimeEnvironment": {
                    "agentRuntimeArn": RUNTIME_ARN,
                    "agentRuntimeName": f"harness_{NAME}",
                    "agentRuntimeId": RUNTIME,
                    "lifecycleConfiguration": {},
                    "networkConfiguration": {"networkMode": "PUBLIC"},
                }
            },
            "environmentVariables": env or {},
            **extra,
        }
    }


def _summary(name: str, harness_id: str) -> dict[str, Any]:
    return {
        "harnessId": harness_id,
        "harnessName": name,
        "arn": f"arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/{harness_id}",
        "status": "READY",
        "createdAt": "2026-10-01T00:00:00Z",
        "updatedAt": "2026-10-01T00:00:00Z",
    }


def _endpoint(status: str, live: str | None = None, target: str | None = None) -> dict[str, Any]:
    endpoint: dict[str, Any] = {
        "harnessId": HID,
        "harnessName": NAME,
        "endpointName": "live",
        "arn": f"{ARN}/harness-endpoint/live",
        "status": status,
        "createdAt": "2026-10-01T00:00:00Z",
        "updatedAt": "2026-10-01T00:00:00Z",
    }
    if live:
        endpoint["liveVersion"] = live
    if target:
        endpoint["targetVersion"] = target
    return {"endpoint": endpoint}


# --- Configuration --------------------------------------------------------------------------


def test_config_is_complete_and_has_no_builtin_tools() -> None:
    assert CONFIG["executionRoleArn"] == f"arn:aws:iam::123456789012:role/Mango-test-agent-{AGENT}"
    assert CONFIG["tools"] == [
        {
            "type": "remote_mcp",
            "name": "mango",
            "config": {"remoteMcp": {"url": ENV["GATEWAY_URL"]}},
        }
    ]
    assert CONFIG["allowedTools"] == ["@mango/finops___get_cost_and_usage"]
    assert CONFIG["memory"] == {"disabled": {}}
    # D39: the same session lifecycle mango-api assumes.
    assert CONFIG["environment"]["agentCoreRuntimeEnvironment"]["lifecycleConfiguration"] == {
        "idleRuntimeSessionTimeout": 300,
        "maxLifetime": 28800,
    }
    assert CONFIG["model"]["bedrockModelConfig"]["maxTokens"] == 4000
    assert CONFIG["model"]["bedrockModelConfig"]["temperature"] == 0.2
    assert "headers" not in CONFIG["tools"][0]["config"]["remoteMcp"]  # tokens only per invocation


def test_agent_without_tools_gets_an_empty_allow_list() -> None:
    config = harness_config(
        SETTINGS,
        agent_id=AGENT,
        version=1,
        content_hash="a" * 64,
        definition=make_definition(tools=[]),
    )
    # Empty, not absent: an absent allow-list would enable the harness shell and file tools.
    assert config["tools"] == []
    assert config["allowedTools"] == []


def test_a_connector_write_tool_is_published_only_when_marked_for_approval() -> None:
    # The Gateway interceptor refuses it without an approval token (D27).
    write = "tickets.close_ticket"
    marked = make_definition(
        tools=["cost-explorer.get_cost_and_usage", write], approval_tools=[write]
    )
    assert allowed_tools(SETTINGS, marked) == [
        "@mango/finops___get_cost_and_usage",
        "@mango/tickets___close_ticket",
    ]
    for definition in (
        make_definition(tools=[write]),  # a write tool nobody marked
        make_definition(approval_tools=["cost-explorer.get_cost_and_usage"]),  # a read tool
    ):
        with pytest.raises(StepError, match="write_tools_unsupported"):
            allowed_tools(SETTINGS, definition)


def test_fingerprint_follows_the_content() -> None:
    def fingerprint(**overrides: Any) -> str:
        kwargs: dict[str, Any] = {
            "agent_id": AGENT,
            "version": 3,
            "content_hash": "a" * 64,
            "definition": make_definition(),
        }
        return str(
            harness_config(SETTINGS, **{**kwargs, **overrides})["environmentVariables"][
                ENV_CONFIG_HASH
            ]
        )

    base = fingerprint()
    assert base == fingerprint()
    assert base == CONFIG["environmentVariables"][ENV_CONFIG_HASH]
    assert base != fingerprint(version=4)
    assert base != fingerprint(content_hash="b" * 64)
    assert base != fingerprint(definition=make_definition(system_prompt="other"))


# --- Create, update, reuse ------------------------------------------------------------------


def test_create_sends_name_tags_and_config(stubbed: tuple[Harnesses, Stubber]) -> None:
    harnesses, stubber = stubbed
    stubber.add_response(
        "list_harnesses",
        {"harnesses": [_summary("Mango_test_a_other", "Mango_test_a_other-0000000000")]},
    )
    stubber.add_response(
        "create_harness",
        _harness("CREATING"),
        {
            "harnessName": NAME,
            "clientToken": ANY,
            "tags": {"mango:namespace": "test", "mango:component": "agent", "mango:agent": AGENT},
            **CONFIG,
        },
    )
    ref = harnesses.ensure(AGENT, CONFIG, execution="exec-1", known_arn=None, published=False)
    assert ref == HarnessRef(HID, "1", created=True)
    stubber.assert_no_pending_responses()


def test_update_sends_everything_and_wraps_memory(stubbed: tuple[Harnesses, Stubber]) -> None:
    harnesses, stubber = stubbed
    stubber.add_response(
        "get_harness", _harness("READY", "4", {ENV_CONFIG_HASH: "old"}), {"harnessId": HID}
    )
    expected = {**CONFIG, "memory": {"optionalValue": {"disabled": {}}}}
    stubber.add_response(
        "update_harness",
        _harness("UPDATING", "5"),
        {"harnessId": HID, "clientToken": ANY, **expected},
    )
    ref = harnesses.ensure(AGENT, CONFIG, execution="exec-1", known_arn=ARN, published=True)
    assert ref == HarnessRef(HID, "5")
    stubber.assert_no_pending_responses()


def test_same_content_reuses_the_version(stubbed: tuple[Harnesses, Stubber]) -> None:
    harnesses, stubber = stubbed
    env = {ENV_CONFIG_HASH: CONFIG["environmentVariables"][ENV_CONFIG_HASH]}
    stubber.add_response("get_harness", _harness("UPDATING", "5", env), {"harnessId": HID})
    ref = harnesses.ensure(AGENT, CONFIG, execution="exec-2", known_arn=ARN, published=True)
    assert ref == HarnessRef(HID, "5")
    stubber.assert_no_pending_responses()  # no UpdateHarness


def test_harness_is_found_by_exact_name_only(stubbed: tuple[Harnesses, Stubber]) -> None:
    harnesses, stubber = stubbed
    stubber.add_response(
        "list_harnesses",
        {
            "harnesses": [
                _summary(f"{NAME}x", f"{NAME}x-AbCdEf0123"),
                _summary("Mango_poc_finops", "Mango_poc_finops-AbCdEf0123"),
                _summary(NAME, HID),
            ]
        },
    )
    stubber.add_response("get_harness", _harness(), {"harnessId": HID})
    found = harnesses.find(AGENT)
    assert found is not None
    assert found["harnessId"] == HID


@pytest.mark.parametrize(
    "arn",
    [
        "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/Mango_poc_finops-AbCdEf0123",
        f"arn:aws:bedrock-agentcore:us-east-1:999999999999:harness/{HID}",
        f"arn:aws:bedrock-agentcore:eu-west-1:123456789012:harness/{HID}",
    ],
)
def test_a_stored_arn_of_another_harness_is_never_used(
    stubbed: tuple[Harnesses, Stubber], arn: str
) -> None:
    harnesses, stubber = stubbed
    with pytest.raises(StepError, match="harness_reference_invalid"):
        harnesses.find(AGENT, arn)
    stubber.assert_no_pending_responses()


def test_role_not_assumable_yet_is_retried(stubbed: tuple[Harnesses, Stubber]) -> None:
    harnesses, stubber = stubbed
    stubber.add_response("list_harnesses", {"harnesses": []})
    stubber.add_client_error(
        "create_harness",
        "ValidationException",
        "Role validation failed for 'arn:aws:iam::1:role/x'.",
    )
    with pytest.raises(RetryableError, match="role_not_ready"):
        harnesses.ensure(AGENT, CONFIG, execution="exec-1", known_arn=None, published=False)


def test_other_validation_errors_are_final(stubbed: tuple[Harnesses, Stubber]) -> None:
    harnesses, stubber = stubbed
    stubber.add_response("list_harnesses", {"harnesses": []})
    stubber.add_client_error("create_harness", "ValidationException", "Invalid model")
    with pytest.raises(StepError, match="CreateHarness:ValidationException") as error:
        harnesses.ensure(AGENT, CONFIG, execution="exec-1", known_arn=None, published=False)
    assert not isinstance(error.value, RetryableError)


@pytest.mark.parametrize(
    ("status", "code"), [("UPDATING", "harness_busy"), ("DELETING", "harness_deleting")]
)
def test_busy_harness_is_retried(
    stubbed: tuple[Harnesses, Stubber], status: str, code: str
) -> None:
    harnesses, stubber = stubbed
    stubber.add_response(
        "get_harness", _harness(status, "4", {ENV_CONFIG_HASH: "old"}), {"harnessId": HID}
    )
    with pytest.raises(RetryableError, match=code):
        harnesses.ensure(AGENT, CONFIG, execution="exec-1", known_arn=ARN, published=True)


def test_throttling_is_retried(stubbed: tuple[Harnesses, Stubber]) -> None:
    harnesses, stubber = stubbed
    stubber.add_client_error("get_harness", "ThrottlingException")
    with pytest.raises(RetryableError, match="GetHarness:ThrottlingException"):
        harnesses.find(AGENT, ARN)


# --- Status -----------------------------------------------------------------------------------


def test_status_reads_the_requested_version(stubbed: tuple[Harnesses, Stubber]) -> None:
    harnesses, stubber = stubbed
    stubber.add_response(
        "get_harness", _harness("UPDATING", "5"), {"harnessId": HID, "harnessVersion": "5"}
    )
    assert harnesses.status(AGENT, HarnessRef(HID, "5")).ready is False
    stubber.add_response(
        "get_harness", _harness("READY", "5"), {"harnessId": HID, "harnessVersion": "5"}
    )
    status = harnesses.status(AGENT, HarnessRef(HID, "5"))
    assert (status.ready, status.runtime_id) == (True, RUNTIME)


def test_failed_harness_logs_the_service_reason_but_raises_only_a_code(
    stubbed: tuple[Harnesses, Stubber], caplog: pytest.LogCaptureFixture
) -> None:
    harnesses, stubber = stubbed
    stubber.add_response(
        "get_harness",
        _harness("UPDATE_FAILED", "5", failureReason="quota exceeded"),
        {"harnessId": HID, "harnessVersion": "5"},
    )
    with pytest.raises(StepError, match=r"^harness_failed$"):
        harnesses.status(AGENT, HarnessRef(HID, "5"))
    assert "quota exceeded" in caplog.text


def test_runtime_of_another_harness_is_refused(stubbed: tuple[Harnesses, Stubber]) -> None:
    harnesses, _ = stubbed
    harness = _harness()["harness"]
    harness["environment"]["agentCoreRuntimeEnvironment"]["agentRuntimeId"] = (
        "harness_Mango_poc_finops-0cKvXa7FYa"
    )
    with pytest.raises(StepError, match="runtime_reference_invalid"):
        harnesses.runtime_id(AGENT, harness)


# --- `live` endpoint ----------------------------------------------------------------------------


def test_live_is_created_when_missing(stubbed: tuple[Harnesses, Stubber]) -> None:
    harnesses, stubber = stubbed
    stubber.add_client_error("get_harness_endpoint", "ResourceNotFoundException")
    stubber.add_response(
        "create_harness_endpoint",
        _endpoint("CREATING", target="1"),
        {
            "harnessId": HID,
            "endpointName": "live",
            "targetVersion": "1",
            "description": ANY,
            "clientToken": ANY,
            "tags": {"mango:namespace": "test", "mango:component": "agent", "mango:agent": AGENT},
        },
    )
    assert harnesses.point_live(AGENT, HID, "1", execution="exec-1") is True
    stubber.assert_no_pending_responses()


def test_live_is_moved_to_the_new_version(stubbed: tuple[Harnesses, Stubber]) -> None:
    harnesses, stubber = stubbed
    stubber.add_response("get_harness_endpoint", _endpoint("READY", live="4"))
    stubber.add_response(
        "update_harness_endpoint",
        _endpoint("UPDATING", live="4", target="5"),
        {"harnessId": HID, "endpointName": "live", "targetVersion": "5", "clientToken": ANY},
    )
    assert harnesses.point_live(AGENT, HID, "5", execution="exec-1") is True
    stubber.assert_no_pending_responses()


def test_live_already_there_or_on_its_way_is_left_alone(stubbed: tuple[Harnesses, Stubber]) -> None:
    harnesses, stubber = stubbed
    stubber.add_response("get_harness_endpoint", _endpoint("READY", live="5"))
    assert harnesses.point_live(AGENT, HID, "5", execution="exec-1") is False
    stubber.add_response("get_harness_endpoint", _endpoint("UPDATING", live="4", target="5"))
    assert harnesses.point_live(AGENT, HID, "5", execution="exec-1") is False
    stubber.add_response("get_harness_endpoint", _endpoint("UPDATING", live="4", target="6"))
    with pytest.raises(RetryableError, match="endpoint_busy"):
        harnesses.point_live(AGENT, HID, "5", execution="exec-1")
    stubber.assert_no_pending_responses()


def test_live_ready_needs_the_exact_version(stubbed: tuple[Harnesses, Stubber]) -> None:
    harnesses, stubber = stubbed
    stubber.add_response("get_harness_endpoint", _endpoint("READY", live="4"))
    assert harnesses.live_ready(HID, "5") is False
    stubber.add_response("get_harness_endpoint", _endpoint("UPDATING", live="4", target="5"))
    assert harnesses.live_ready(HID, "5") is False
    stubber.add_response("get_harness_endpoint", _endpoint("READY", live="5"))
    assert harnesses.live_ready(HID, "5") is True
    stubber.add_response("get_harness_endpoint", _endpoint("UPDATE_FAILED", live="4"))
    with pytest.raises(StepError, match="endpoint_failed"):
        harnesses.live_ready(HID, "5")


# --- Removal --------------------------------------------------------------------------------------


def test_delete_removes_the_endpoint_first(stubbed: tuple[Harnesses, Stubber]) -> None:
    harnesses, stubber = stubbed
    stubber.add_response("get_harness_endpoint", _endpoint("READY", live="1"))
    stubber.add_response(
        "delete_harness_endpoint", _endpoint("DELETING"), {"harnessId": HID, "endpointName": "live"}
    )
    with pytest.raises(RetryableError, match="endpoint_deleting"):
        harnesses.delete(HID)
    stubber.add_response("get_harness_endpoint", _endpoint("DELETING"))
    with pytest.raises(RetryableError, match="endpoint_deleting"):
        harnesses.delete(HID)  # no second delete call while it is going
    stubber.add_client_error("get_harness_endpoint", "ResourceNotFoundException")
    stubber.add_response("delete_harness", {}, {"harnessId": HID})
    harnesses.delete(HID)
    stubber.assert_no_pending_responses()
