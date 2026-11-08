"""D16, precised 2026-11-08: the log groups of the harnesses already published get the harness
logs key, 7 days and their tags on every update of the stack, and nothing is deleted."""

from __future__ import annotations

from typing import Any

import pytest
from botocore.exceptions import ClientError

from mango_provisioner.config import ConfigError
from mango_provisioner.harness_logs import (
    DENIAL_ATTEMPTS,
    PHYSICAL_ID,
    Governor,
    GovernorSettings,
    handle,
)

from .conftest import ACCOUNT, EVALS_LOGS_KEY_ARN, LOGS_KEY_ARN, NS, REGION, STACK_ID

HARNESS_KEY = f"arn:aws:kms:{REGION}:{ACCOUNT}:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
SETTINGS = GovernorSettings(NS, REGION, ACCOUNT, HARNESS_KEY)
PREFIX = f"/aws/bedrock-agentcore/runtimes/harness_Mango_{NS}_a_"
AGENT_LIVE = f"{PREFIX}abcdefghijklmnop-AbCdE12345-live"
AGENT_DEFAULT = f"{PREFIX}abcdefghijklmnop-AbCdE12345-DEFAULT"
PLAYGROUND = f"{PREFIX}playground-ZyXwV98765-live"
EVALS = f"{PREFIX}evals-QwErT54321-live"
NESTED_ID = (
    f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/Mango-{NS}-Core-TracesNested-ABC/"
    "1f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
)
CORE_TAGS = {"project-id": "mango", "mango:namespace": "evil"}


def _error(code: str, operation: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "SECRET-MESSAGE"}}, operation)


class FakeLogs:
    def __init__(self) -> None:
        self.groups: dict[str, dict[str, Any]] = {
            AGENT_LIVE: {"kms": LOGS_KEY_ARN, "retention": 30},
            AGENT_DEFAULT: {"kms": None, "retention": None},
            PLAYGROUND: {"kms": HARNESS_KEY, "retention": 7},
            EVALS: {"kms": EVALS_LOGS_KEY_ARN, "retention": 30},
            # Not one of the installation's harnesses, though it shares the prefix.
            f"{PREFIX}abcdefghijklmnop-short-live": {"kms": None, "retention": None},
        }
        self.associated: list[str] = []
        self.retention_set: list[str] = []
        self.tagged: dict[str, dict[str, str]] = {}
        self.deleted: list[str] = []
        self.fail: Exception | None = None
        self.fail_times = 10**6
        self.gone: set[str] = set()

    def get_paginator(self, name: str) -> Any:
        assert name == "describe_log_groups"
        outer = self

        class Pages:
            def paginate(self, **kwargs: Any) -> list[dict[str, Any]]:
                prefix = kwargs["logGroupNamePrefix"]
                groups = [
                    {
                        "logGroupName": n,
                        **({"kmsKeyId": g["kms"]} if g["kms"] else {}),
                        **({"retentionInDays": g["retention"]} if g["retention"] else {}),
                    }
                    for n, g in outer.groups.items()
                    if n.startswith(prefix)
                ]
                # Two pages, to read every one of them.
                return [{"logGroups": groups[:2]}, {"logGroups": groups[2:]}]

        return Pages()

    def _check(self, name: str) -> None:
        if self.fail and self.fail_times > 0:
            self.fail_times -= 1
            raise self.fail
        if name in self.gone:
            raise _error("ResourceNotFoundException", "AssociateKmsKey")

    def associate_kms_key(self, **kwargs: Any) -> None:
        self._check(kwargs["logGroupName"])
        self.associated.append(kwargs["logGroupName"])
        self.groups[kwargs["logGroupName"]]["kms"] = kwargs["kmsKeyId"]

    def put_retention_policy(self, **kwargs: Any) -> None:
        self.retention_set.append(kwargs["logGroupName"])
        self.groups[kwargs["logGroupName"]]["retention"] = kwargs["retentionInDays"]

    def tag_resource(self, **kwargs: Any) -> None:
        prefix = f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:"
        assert kwargs["resourceArn"].startswith(prefix)
        self.tagged[kwargs["resourceArn"].removeprefix(prefix)] = dict(kwargs["tags"])

    def delete_log_group(self, **kwargs: Any) -> None:  # pragma: no cover - must never run
        self.deleted.append(kwargs["logGroupName"])


class FakeCloudFormation:
    def __init__(self) -> None:
        self.status = "UPDATE_IN_PROGRESS"

    def describe_stacks(self, **kwargs: Any) -> dict[str, Any]:
        assert kwargs["StackName"] == STACK_ID
        tags = [{"Key": k, "Value": v} for k, v in CORE_TAGS.items()]
        return {"Stacks": [{"StackId": STACK_ID, "StackStatus": self.status, "Tags": tags}]}


def _event(request: str = "Update", core: str = STACK_ID) -> dict[str, Any]:
    return {
        "RequestType": request,
        "StackId": NESTED_ID,
        "ResponseURL": "https://example.invalid/response",
        "RequestId": "r-1",
        "LogicalResourceId": "Resource",
        "ResourceProperties": {"Release": "v1.2.3", "CoreStackId": core},
    }


def _run(event: dict[str, Any], logs: FakeLogs, cfn: FakeCloudFormation) -> list[tuple[str, str]]:
    answers: list[tuple[str, str]] = []

    def answer(_event: Any, status: str, reason: str = "", *, physical_id: str) -> None:
        assert physical_id == PHYSICAL_ID
        answers.append((status, reason))

    handle(
        event,
        settings=SETTINGS,
        governor=Governor(SETTINGS, logs, cfn),
        answer=answer,
        sleep=lambda _s: None,
    )
    return answers


def test_published_harnesses_get_the_key_seven_days_and_their_tags() -> None:
    logs = FakeLogs()
    assert _run(_event(), logs, FakeCloudFormation()) == [("SUCCESS", "")]
    for name in (AGENT_LIVE, AGENT_DEFAULT, PLAYGROUND):
        assert logs.groups[name] == {"kms": HARNESS_KEY, "retention": 7}
    assert logs.tagged[AGENT_LIVE] == {
        "project-id": "mango",
        "mango:namespace": NS,
        "mango:component": "agent",
        "mango:agent": "abcdefghijklmnop",
    }
    assert logs.tagged[PLAYGROUND]["mango:agent"] == "playground"
    assert logs.deleted == []


def test_what_already_has_the_key_or_the_retention_is_not_written_again() -> None:
    logs = FakeLogs()
    _run(_event(), logs, FakeCloudFormation())
    assert PLAYGROUND not in logs.associated
    assert PLAYGROUND not in logs.retention_set
    logs.associated.clear()
    logs.retention_set.clear()
    _run(_event(), logs, FakeCloudFormation())
    assert logs.associated == []
    assert logs.retention_set == []


def test_the_evals_harness_and_names_that_are_not_a_harness_are_left_alone() -> None:
    logs = FakeLogs()
    _run(_event(), logs, FakeCloudFormation())
    assert logs.groups[EVALS] == {"kms": EVALS_LOGS_KEY_ARN, "retention": 30}
    untouched = f"{PREFIX}abcdefghijklmnop-short-live"
    assert logs.groups[untouched] == {"kms": None, "retention": None}
    assert EVALS not in logs.tagged and untouched not in logs.tagged


def test_a_log_group_that_disappears_meanwhile_is_skipped() -> None:
    logs = FakeLogs()
    logs.gone.add(AGENT_DEFAULT)
    assert _run(_event(), logs, FakeCloudFormation()) == [("SUCCESS", "")]
    assert logs.groups[AGENT_LIVE]["kms"] == HARNESS_KEY


@pytest.mark.parametrize("request_type", ["Delete"])
def test_delete_does_nothing(request_type: str) -> None:
    logs = FakeLogs()
    assert _run(_event(request_type), logs, FakeCloudFormation()) == [("SUCCESS", "")]
    assert logs.associated == [] and logs.retention_set == [] and logs.tagged == {}


def test_nothing_happens_while_the_stack_rolls_back() -> None:
    logs, cfn = FakeLogs(), FakeCloudFormation()
    cfn.status = "UPDATE_ROLLBACK_IN_PROGRESS"
    assert _run(_event(), logs, cfn) == [("SUCCESS", "")]
    assert logs.associated == []


def test_another_stack_is_refused() -> None:
    other = STACK_ID.replace(f"Mango-{NS}-Core", "Mango-other-Core")
    answers = _run(_event(core=other), FakeLogs(), FakeCloudFormation())
    assert answers[0][0] == "FAILED"


def test_a_failure_rolls_back_with_a_code_and_no_aws_message() -> None:
    logs = FakeLogs()
    logs.fail = _error("ThrottlingException", "AssociateKmsKey")
    [(status, reason)] = _run(_event(), logs, FakeCloudFormation())
    assert status == "FAILED"
    assert "AssociateKmsKey: ThrottlingException" in reason
    assert "SECRET-MESSAGE" not in reason and PREFIX not in reason


def test_a_denial_is_tried_again_while_iam_applies_the_new_policy() -> None:
    logs = FakeLogs()
    logs.fail = _error("AccessDeniedException", "AssociateKmsKey")
    logs.fail_times = DENIAL_ATTEMPTS - 1
    assert _run(_event(), logs, FakeCloudFormation()) == [("SUCCESS", "")]
    assert logs.groups[AGENT_LIVE]["kms"] == HARNESS_KEY


def test_settings_refuse_a_key_of_another_account() -> None:
    env = {
        "MANGO_NAMESPACE": NS,
        "AWS_REGION": REGION,
        "MANGO_ACCOUNT_ID": ACCOUNT,
        "HARNESS_LOGS_KEY_ARN": HARNESS_KEY.replace(ACCOUNT, "210987654321"),
    }
    with pytest.raises(ConfigError):
        GovernorSettings.from_env(env)
    assert GovernorSettings.from_env({**env, "HARNESS_LOGS_KEY_ARN": HARNESS_KEY}) == SETTINGS
