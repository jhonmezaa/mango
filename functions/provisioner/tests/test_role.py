"""Agent roles against moto IAM: fixed template, boundary, and no repair of altered roles."""

from __future__ import annotations

import json
from typing import Any

import pytest

from mango_provisioner.config import Settings
from mango_provisioner.errors import StepError
from mango_provisioner.role import AgentRoles, model_arns, role_policy, trust_policy

from .conftest import AGENT, BOUNDARY_ARN, ENV, MODEL, MODEL_2, Lab

SETTINGS = Settings.from_env(ENV)
ROLE = f"Mango-test-agent-{AGENT}"


def _roles(lab: Lab) -> AgentRoles:
    return AgentRoles(lab.iam, lab.settings)


def test_role_is_created_with_boundary_trust_and_tags(lab: Lab) -> None:
    assert _roles(lab).ensure(AGENT, [MODEL]) is True
    role = lab.iam.get_role(RoleName=ROLE)["Role"]
    assert role["PermissionsBoundary"]["PermissionsBoundaryArn"] == BOUNDARY_ARN
    assert role["Path"] == "/"
    assert role["AssumeRolePolicyDocument"] == trust_policy(SETTINGS, AGENT)
    tags = {t["Key"]: t["Value"] for t in lab.iam.list_role_tags(RoleName=ROLE)["Tags"]}
    assert tags == {"mango:namespace": "test", "mango:component": "agent", "mango:agent": AGENT}
    assert lab.iam.list_role_policies(RoleName=ROLE)["PolicyNames"] == ["agent"]
    assert lab.iam.list_attached_role_policies(RoleName=ROLE)["AttachedPolicies"] == []


def test_repeating_changes_nothing_and_new_models_replace_the_policy(lab: Lab) -> None:
    roles = _roles(lab)
    roles.ensure(AGENT, [MODEL])
    before = lab.iam.get_role_policy(RoleName=ROLE, PolicyName="agent")["PolicyDocument"]
    assert roles.ensure(AGENT, [MODEL]) is False
    assert lab.iam.get_role_policy(RoleName=ROLE, PolicyName="agent")["PolicyDocument"] == before
    roles.ensure(AGENT, [MODEL_2])
    resources = lab.role_models()
    assert all("haiku" in r for r in resources)


def test_trust_is_only_agentcore_for_this_agent() -> None:
    (statement,) = trust_policy(SETTINGS, AGENT)["Statement"]
    assert statement["Principal"] == {"Service": "bedrock-agentcore.amazonaws.com"}
    assert statement["Action"] == "sts:AssumeRole"
    assert statement["Condition"]["StringEquals"] == {"aws:SourceAccount": "123456789012"}
    assert statement["Condition"]["ArnLike"]["aws:SourceArn"] == [
        f"arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/Mango_test_a_{AGENT}-*",
        f"arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/harness_Mango_test_a_{AGENT}-*",
    ]


def test_policy_is_the_fixed_template() -> None:
    policy = role_policy(SETTINGS, AGENT, [MODEL])
    by_sid = {s["Sid"]: s for s in policy["Statement"]}
    assert set(by_sid) == {
        "InvokeAllowedModels",
        "ApplyBaseGuardrail",
        "ManagedRuntimeImage",
        "RuntimeLogs",
        "Tracing",
        "Metrics",
        "WorkloadIdentity",
    }
    assert all(s["Effect"] == "Allow" for s in policy["Statement"])
    actions = {
        a
        for s in policy["Statement"]
        for a in ([s["Action"]] if isinstance(s["Action"], str) else s["Action"])
    }
    assert not any(a.endswith("*") for a in actions)
    assert not any(
        a.startswith(("iam:", "sts:Assume", "dynamodb:", "s3:", "lambda:")) for a in actions
    )
    # Wildcard resources only where the API has no resource scope.
    wildcard = {s["Sid"] for s in policy["Statement"] if s["Resource"] == "*"}
    assert wildcard == {"ManagedRuntimeImage", "Tracing", "Metrics"}
    assert by_sid["Metrics"]["Condition"] == {
        "StringEquals": {"cloudwatch:namespace": "bedrock-agentcore"}
    }
    assert (
        by_sid["ApplyBaseGuardrail"]["Resource"]
        == "arn:aws:bedrock:us-east-1:123456789012:guardrail/gr123456"
    )
    assert by_sid["RuntimeLogs"]["Resource"].endswith(f"/runtimes/harness_Mango_test_a_{AGENT}-*")
    assert by_sid["WorkloadIdentity"]["Resource"][1].endswith(
        f"/workload-identity/harness_Mango_test_a_{AGENT}-*"
    )


def test_model_arns() -> None:
    assert model_arns(SETTINGS, "us.anthropic.claude-sonnet-4-6") == [
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6",
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6",
    ]
    assert (
        model_arns(SETTINGS, "global.anthropic.claude-x")[1]
        == "arn:aws:bedrock:*::foundation-model/anthropic.claude-x"
    )
    assert model_arns(SETTINGS, "amazon.nova-pro-v1:0") == [
        "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0"
    ]


def test_no_models_is_an_error() -> None:
    with pytest.raises(StepError, match="no_models"):
        role_policy(SETTINGS, AGENT, [])


def _create_raw(lab: Lab, trust: dict[str, Any], **kwargs: Any) -> None:
    lab.iam.create_role(RoleName=ROLE, AssumeRolePolicyDocument=json.dumps(trust), **kwargs)


def test_existing_role_without_boundary_is_refused_and_left_untouched(lab: Lab) -> None:
    _create_raw(lab, trust_policy(SETTINGS, AGENT))
    with pytest.raises(StepError, match="role_without_boundary"):
        _roles(lab).ensure(AGENT, [MODEL])
    assert lab.iam.list_role_policies(RoleName=ROLE)["PolicyNames"] == []


def test_existing_role_with_another_boundary_is_refused(lab: Lab) -> None:
    other = lab.iam.create_policy(
        PolicyName="other",
        PolicyDocument=json.dumps(
            {
                "Version": "2012-10-17",
                "Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}],
            }
        ),
    )["Policy"]["Arn"]
    _create_raw(lab, trust_policy(SETTINGS, AGENT), PermissionsBoundary=other)
    with pytest.raises(StepError, match="role_without_boundary"):
        _roles(lab).ensure(AGENT, [MODEL])


def test_existing_role_with_a_changed_trust_is_refused(lab: Lab) -> None:
    trust = trust_policy(SETTINGS, AGENT)
    trust["Statement"][0]["Principal"] = {"AWS": "arn:aws:iam::123456789012:root"}
    _create_raw(lab, trust, PermissionsBoundary=BOUNDARY_ARN)
    with pytest.raises(StepError, match="role_trust_mismatch"):
        _roles(lab).ensure(AGENT, [MODEL])


def test_delete_removes_policy_and_role_and_tolerates_absence(lab: Lab) -> None:
    roles = _roles(lab)
    roles.ensure(AGENT, [MODEL])
    roles.delete(AGENT)
    assert not roles.exists(AGENT)
    roles.delete(AGENT)  # nothing left: still fine


def test_names_are_only_built_from_valid_agent_ids(lab: Lab) -> None:
    for bad in ("x", "ABC", "a/../b", "agent*", "platform"):
        with pytest.raises(ValueError, match="invalid agent id"):
            _roles(lab).ensure(bad, [MODEL])


def test_deleting_a_role_that_does_not_exist_makes_no_write(lab: Lab) -> None:
    """IAM answers AccessDenied (not NoSuchEntity) to a policy change on a missing role,
    because the provisioner may only change roles that carry the boundary: a compensation
    that never created the role must not try."""
    calls: list[str] = []
    lab.iam.meta.events.register("before-call.iam", lambda model, **_: calls.append(model.name))
    _roles(lab).delete(AGENT)
    assert calls == ["GetRole"]
