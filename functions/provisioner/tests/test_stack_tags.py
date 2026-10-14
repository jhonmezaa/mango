"""D76: what the provisioners create carries the tags the installation's stack was deployed with."""

from __future__ import annotations

from typing import Any

import pytest
from botocore.exceptions import ClientError

from mango_provisioner.config import ConfigError, Settings
from mango_provisioner.errors import RetryableError, StepError
from mango_provisioner.packs.config import ConfigError as PackConfigError
from mango_provisioner.packs.config import PackSettings
from mango_provisioner.role import AgentRoles
from mango_provisioner.runtime_logs import govern_log_groups
from mango_provisioner.stack_tags import (
    MAX_TAGS,
    REFRESH_SECONDS,
    StackTags,
    custom_tags,
    merge,
)

from .conftest import AGENT, ENV, LOGS_KEY_ARN, MODEL, NS, STACK_ID, FakeLogs, Lab, make_definition
from .pack_lab import PACK, VERSION, PackLab, Signer, env

STACK_TAGS = {
    "project-id": "mango",
    "cost center": "CC-1234 / finanzas",
    # Never copied: Mango's own keys must not be overridden (IAM conditions read them).
    "mango:namespace": "someone-else",
    "mango:component": "core",
}
COPIED = {"project-id": "mango", "cost center": "CC-1234 / finanzas"}
CATALOG = {PACK: {"version": VERSION, "statement_sha256": "a" * 64}}


def _tags(items: list[dict[str, str]]) -> dict[str, str]:
    return {t["Key"]: t["Value"] for t in items}


# --- Which tags are copied --------------------------------------------------------------------


def test_reserved_prefixes_are_never_copied() -> None:
    tags = custom_tags(
        [
            {"Key": "project-id", "Value": "mango"},
            {"Key": "mango:namespace", "Value": "evil"},
            {"Key": "aws:cloudformation:stack-name", "Value": "Mango-test-Core"},
            {"Key": "empty", "Value": ""},
            # IAM matches tag keys without regard to case: these are Mango's and AWS's too.
            {"Key": "Mango:Namespace", "Value": "evil"},
            {"Key": "MANGO:component", "Value": "evil"},
            {"Key": "AWS:anything", "Value": "x"},
        ]
    )
    assert dict(tags) == {"project-id": "mango", "empty": ""}


def test_two_keys_that_differ_only_in_case_are_refused() -> None:
    with pytest.raises(StepError) as raised:
        custom_tags([{"Key": "Proyecto", "Value": "a"}, {"Key": "proyecto", "Value": "b"}])
    assert raised.value.code == "stack_tag_invalid"


@pytest.mark.parametrize(
    "tag",
    [
        {"Key": "Área", "Value": "finanzas"},  # AgentCore takes only ASCII letters
        {"Key": "area", "Value": "Nutrición"},
        {"Key": "proyecto#1", "Value": "x"},
        {"Key": "x" * 129, "Value": "x"},
        {"Key": "x", "Value": "x" * 257},
    ],
)
def test_a_tag_a_service_cannot_take_fails_instead_of_being_left_out(tag: dict[str, str]) -> None:
    with pytest.raises(StepError) as raised:
        custom_tags([tag])
    assert raised.value.code == "stack_tag_invalid"


def test_mango_tags_win_and_the_total_is_capped() -> None:
    own = {"mango:namespace": NS, "mango:component": "agent", "mango:agent": AGENT}
    assert merge(own, {"a": "1"}) == {**own, "a": "1"}
    assert merge(own, {}) == own
    most = {f"k{i}": "v" for i in range(MAX_TAGS - len(own))}
    assert len(merge(own, most)) == MAX_TAGS
    with pytest.raises(StepError) as raised:
        merge(own, {**most, "one-more": "v"})
    assert raised.value.code == "stack_tags_too_many"


# --- Reading the stack ------------------------------------------------------------------------


class _CloudFormation:
    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.calls: list[str] = []

    def describe_stacks(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs["StackName"])
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return {"Stacks": answer}


def _stack(tags: dict[str, str]) -> list[dict[str, Any]]:
    return [{"StackId": STACK_ID, "Tags": [{"Key": k, "Value": v} for k, v in tags.items()]}]


def _error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "m"}}, "DescribeStacks")


def test_the_stack_is_read_once_every_few_minutes() -> None:
    now = [1000.0]
    cfn = _CloudFormation(_stack({"a": "1"}), _stack({"a": "2"}))
    reader = StackTags(cfn, STACK_ID, clock=lambda: now[0])
    assert dict(reader.get()) == {"a": "1"}
    now[0] += REFRESH_SECONDS - 1
    assert dict(reader.get()) == {"a": "1"}
    assert cfn.calls == [STACK_ID]
    now[0] += 1
    assert dict(reader.get()) == {"a": "2"}  # a stack update reaches what is created next
    assert cfn.calls == [STACK_ID, STACK_ID]


def test_a_stack_without_tags_adds_nothing() -> None:
    reader = StackTags(_CloudFormation([{"StackId": STACK_ID}]), STACK_ID)
    assert dict(reader.get()) == {}


def test_throttling_is_retried_and_a_denial_is_final() -> None:
    with pytest.raises(RetryableError) as retried:
        StackTags(_CloudFormation(_error("Throttling")), STACK_ID).get()
    assert retried.value.code == "DescribeStacks:Throttling"
    with pytest.raises(StepError) as denied:
        StackTags(_CloudFormation(_error("AccessDenied")), STACK_ID).get()
    assert not isinstance(denied.value, RetryableError)
    assert denied.value.code == "DescribeStacks:AccessDenied"


def test_an_invalid_tag_is_not_remembered() -> None:
    cfn = _CloudFormation(_stack({"Área": "x"}), _stack({"area": "x"}))
    reader = StackTags(cfn, STACK_ID)
    with pytest.raises(StepError):
        reader.get()
    assert dict(reader.get()) == {"area": "x"}  # fixed on the stack: the next step goes on


# --- The stack id comes from the template ----------------------------------------------------


@pytest.mark.parametrize(
    "value",
    [
        STACK_ID.replace("Mango-test-Core", "Mango-other-Core"),
        STACK_ID.replace("Mango-test-Core", "Mango-test-PackNetwork"),
        STACK_ID.replace("123456789012", "999988887777"),
        STACK_ID.replace("us-east-1", "us-west-2"),
        "Mango-test-Core",
        STACK_ID + "x",
    ],
)
def test_only_the_installations_core_stack_is_accepted(value: str) -> None:
    with pytest.raises(ConfigError, match="MANGO_STACK_ID"):
        Settings.from_env({**ENV, "MANGO_STACK_ID": value})
    with pytest.raises(PackConfigError, match="MANGO_STACK_ID"):
        PackSettings.from_env({**env(Signer().public_pem, CATALOG), "MANGO_STACK_ID": value})


def test_settings_without_a_reader_keep_only_mangos_tags() -> None:
    settings = Settings.from_env(ENV)
    assert settings.stack_id == STACK_ID
    assert settings.tags(AGENT) == {
        "mango:namespace": NS,
        "mango:component": "agent",
        "mango:agent": AGENT,
    }


# --- Agents -----------------------------------------------------------------------------------


@pytest.mark.parametrize("lab", [STACK_TAGS], indirect=True)
def test_an_agent_carries_the_stack_tags_everywhere(lab: Lab) -> None:
    lab.run(lab.approve(make_definition()))
    mango = {"mango:namespace": NS, "mango:component": "agent", "mango:agent": AGENT}
    expected = {**COPIED, **mango}

    role = lab.iam.list_role_tags(RoleName=lab.settings.role_name(AGENT))["Tags"]
    assert _tags(role) == expected
    harness = lab.agentcore.only()
    assert harness["tags"] == expected
    assert harness["endpoint"]["tags"] == expected
    assert lab.logs.groups
    for group in lab.logs.groups.values():
        assert group["tags"] == expected


@pytest.mark.parametrize("lab", [{"Área": "finanzas"}], indirect=True)
def test_an_agent_is_not_created_with_a_tag_left_out(lab: Lab) -> None:
    with pytest.raises(StepError) as raised:
        AgentRoles(lab.iam, lab.settings).ensure(AGENT, [MODEL])
    assert raised.value.code == "stack_tag_invalid"
    assert lab.iam.list_roles(PathPrefix="/")["Roles"] == []


def test_an_adopted_log_group_gets_the_same_tags() -> None:
    logs = FakeLogs()
    name = "/aws/bedrock-agentcore/runtimes/harness_Mango_test_a_x-0000000001-DEFAULT"
    logs.groups[name] = {"kms": None, "tags": {}}  # AgentCore created it first
    tags = {**COPIED, "mango:namespace": NS}
    settings = Settings.from_env(ENV)
    govern_log_groups(logs, [name], LOGS_KEY_ARN, tags, settings.log_group_arn)  # type: ignore[arg-type]
    assert logs.groups[name]["tags"] == tags
    assert logs.groups[name]["kms"] == LOGS_KEY_ARN


# --- MCP packs --------------------------------------------------------------------------------


@pytest.mark.parametrize("packlab", [STACK_TAGS], indirect=True)
def test_a_pack_carries_the_stack_tags_everywhere(packlab: PackLab) -> None:
    lab = packlab
    assert lab.run(lab.approve())["enabled"] is True
    mango = {"mango:namespace": NS, "mango:component": "mcp-pack", "mango:pack": PACK}
    expected = {**COPIED, **mango}

    role = lab.iam.list_role_tags(RoleName=lab.settings.role_name(PACK))["Tags"]
    assert _tags(role) == expected
    (runtime,) = lab.agentcore.runtimes.values()
    assert runtime["tags"] == expected
    assert runtime["live"]["tags"] == expected
    assert lab.logs.groups
    for group in lab.logs.groups.values():
        assert group["tags"] == expected
