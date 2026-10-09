"""Uninstall guard (D58, TM-D13, TM-D14): what it deletes, and above all when it does not."""

from __future__ import annotations

import json
from typing import Any

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from mango_provisioner import uninstall
from mango_provisioner.uninstall import GuardSettings, Sweep, handle

BOUNDARIES = frozenset(
    {
        "arn:aws:iam::111111111111:policy/Mango-acme-agent-boundary",
        "arn:aws:iam::111111111111:policy/Mango-acme-mcp-boundary",
    }
)
SETTINGS = GuardSettings(
    "acme",
    "mango-acme-tools-abc123",
    "Mango_acme_Tools-xyz",
    frozenset({"cost-explorer", "ops"}),
    BOUNDARIES,
)
EVENT = {
    "RequestType": "Delete",
    "StackId": "arn:aws:cloudformation:us-east-1:111111111111:stack/Mango-acme-Core/1",
    "RequestId": "r1",
    "LogicalResourceId": "UninstallGuard",
    "ResponseURL": "https://example.invalid/response",
}


def error(code: str, operation: str = "Op", message: str = "x") -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": message}}, operation)


class Paginator:
    def __init__(self, pages: list[dict[str, Any]]) -> None:
        self._pages = pages

    def paginate(self, **_: Any) -> list[dict[str, Any]]:
        return self._pages


class AgentCore:
    """Deletions take effect on the next listing, as in AgentCore."""

    def __init__(self) -> None:
        self.targets = [
            {"name": "cost-explorer", "targetId": "t0"},
            {"name": "aws-pricing", "targetId": "t1"},
        ]
        self.policies = [
            {"name": "Mango_acme_mcp_aws_pricing_0", "policyId": "p1"},
            {"name": "Mango_acme_connector_rule", "policyId": "p0"},
            {"name": "Mango_other_mcp_aws_pricing_0", "policyId": "p2"},
        ]
        self.runtimes = {
            "Mango_acme_mcp_aws_pricing-AAAAAAAAAA": ["DEFAULT", "live"],
            "harness_Mango_acme_a_finops-BBBBBBBBBB": ["DEFAULT"],
            "Mango_other_mcp_aws_pricing-CCCCCCCCCC": ["DEFAULT", "live"],
        }
        self.harness_endpoints = {
            "Mango_acme_a_finops-DDDDDDDDDD": ["DEFAULT", "live"],
            "Mango_other_a_finops-EEEEEEEEEE": ["DEFAULT", "live"],
        }
        # Ids of runtimes and harnesses AgentCore is already deleting.
        self.deleting: set[str] = set()
        self.calls: list[str] = []

    def _status(self, resource_id: str) -> str:
        return "DELETING" if resource_id in self.deleting else "READY"

    def get_paginator(self, operation: str) -> Any:
        guard = self

        class Pages:
            def paginate(self, **arguments: str) -> list[dict[str, Any]]:
                if operation == "list_gateway_targets":
                    return [{"items": list(guard.targets)}]
                if operation == "list_policies":
                    return [{"policies": list(guard.policies)}]
                if operation == "list_agent_runtimes":
                    return [
                        {
                            "agentRuntimes": [
                                {
                                    "agentRuntimeName": i.rsplit("-", 1)[0],
                                    "agentRuntimeId": i,
                                    "status": guard._status(i),
                                }
                                for i in guard.runtimes
                            ]
                        }
                    ]
                if operation == "list_agent_runtime_endpoints":
                    guard.calls.append(f"list-runtime-endpoints:{arguments['agentRuntimeId']}")
                    return [
                        {
                            "runtimeEndpoints": [
                                {"name": n} for n in guard.runtimes[arguments["agentRuntimeId"]]
                            ]
                        }
                    ]
                if operation == "list_harnesses":
                    return [
                        {
                            "harnesses": [
                                {
                                    "harnessName": i.rsplit("-", 1)[0],
                                    "harnessId": i,
                                    "status": guard._status(i),
                                }
                                for i in guard.harness_endpoints
                            ]
                        }
                    ]
                if operation == "list_harness_endpoints":
                    guard.calls.append(f"list-harness-endpoints:{arguments['harnessId']}")
                    return [
                        {
                            "endpoints": [
                                {"endpointName": n}
                                for n in guard.harness_endpoints[arguments["harnessId"]]
                            ]
                        }
                    ]
                raise AssertionError(operation)

        return Pages()

    def delete_gateway_target(self, gatewayIdentifier: str, targetId: str) -> None:  # noqa: N803
        assert gatewayIdentifier == SETTINGS.gateway_id
        self.calls.append(f"target:{targetId}")
        self.targets = [t for t in self.targets if t["targetId"] != targetId]

    def delete_policy(self, policyEngineId: str, policyId: str) -> None:  # noqa: N803
        self.calls.append(f"policy:{policyId}")
        self.policies = [p for p in self.policies if p["policyId"] != policyId]

    def delete_agent_runtime_endpoint(self, agentRuntimeId: str, endpointName: str) -> None:  # noqa: N803
        self.calls.append(f"runtime-endpoint:{agentRuntimeId}:{endpointName}")
        self.runtimes[agentRuntimeId].remove(endpointName)

    def delete_agent_runtime(self, agentRuntimeId: str) -> None:  # noqa: N803
        self.calls.append(f"runtime:{agentRuntimeId}")
        del self.runtimes[agentRuntimeId]

    def delete_harness_endpoint(self, harnessId: str, endpointName: str) -> None:  # noqa: N803
        self.calls.append(f"harness-endpoint:{harnessId}:{endpointName}")
        self.harness_endpoints[harnessId].remove(endpointName)

    def delete_harness(self, harnessId: str) -> None:  # noqa: N803
        self.calls.append(f"harness:{harnessId}")
        del self.harness_endpoints[harnessId]


class Iam:
    def __init__(self) -> None:
        agent, pack = sorted(BOUNDARIES)
        self.roles: dict[str, str | None] = {
            "Mango-acme-agent-finops": agent,
            "Mango-acme-mcp-aws-pricing": pack,
            # Same prefix, but not made by a provisioner: no boundary of the installation.
            "Mango-acme-agent-handmade": None,
            "Mango-acme-ApiTask": None,
            "Mango-other-agent-finops": agent,
        }
        self.inline: dict[str, list[str]] = {name: ["agent"] for name in self.roles}
        # Managed policies attached after the provisioner made the role, in pages.
        self.attached: dict[str, list[list[str]]] = {}
        # Roles something else holds (an instance profile): never deletable.
        self.in_instance_profile: set[str] = set()
        self.deleted: list[str] = []
        self.calls: list[str] = []

    def get_paginator(self, operation: str) -> Any:
        iam = self

        class Pages:
            def paginate(self, **arguments: str) -> list[dict[str, Any]]:
                if operation == "list_roles":
                    return [{"Roles": [{"RoleName": name} for name in iam.roles]}]
                name = arguments["RoleName"]
                iam.calls.append(f"{operation}:{name}")
                if operation == "list_role_policies":
                    return [{"PolicyNames": list(iam.inline[name])}]
                if operation == "list_attached_role_policies":
                    return [
                        {
                            "AttachedPolicies": [
                                {"PolicyName": "x", "PolicyArn": arn} for arn in page
                            ]
                        }
                        for page in iam.attached.get(name, [[]])
                    ]
                raise AssertionError(operation)

        return Pages()

    def get_role(self, RoleName: str) -> dict[str, Any]:  # noqa: N803
        boundary = self.roles[RoleName]
        role: dict[str, Any] = {"RoleName": RoleName}
        if boundary:
            role["PermissionsBoundary"] = {"PermissionsBoundaryArn": boundary}
        return {"Role": role}

    def delete_role_policy(self, RoleName: str, PolicyName: str) -> None:  # noqa: N803
        self.calls.append(f"delete_role_policy:{RoleName}:{PolicyName}")
        self.inline[RoleName].remove(PolicyName)

    def detach_role_policy(self, RoleName: str, PolicyArn: str) -> None:  # noqa: N803
        self.calls.append(f"detach_role_policy:{RoleName}:{PolicyArn}")
        for page in self.attached[RoleName]:
            if PolicyArn in page:
                page.remove(PolicyArn)

    def delete_role(self, RoleName: str) -> None:  # noqa: N803
        self.calls.append(f"delete_role:{RoleName}")
        held = self.inline[RoleName] or any(self.attached.get(RoleName, []))
        if held or RoleName in self.in_instance_profile:
            # As IAM answers it, with the role in its message.
            raise error(
                "DeleteConflict",
                "DeleteRole",
                f"Cannot delete entity, must detach all policies first: {RoleName}",
            )
        self.deleted.append(RoleName)
        del self.roles[RoleName]


class Logs:
    def __init__(self) -> None:
        self.groups = [
            "/aws/bedrock-agentcore/runtimes/Mango_acme_mcp_aws_pricing-AAAAAAAAAA-DEFAULT",
            "/aws/bedrock-agentcore/runtimes/harness_Mango_acme_a_finops-BBBBBBBBBB-DEFAULT",
            "/aws/bedrock-agentcore/runtimes/Mango_other_mcp_aws_pricing-CCCCCCCCCC-DEFAULT",
        ]

    def get_paginator(self, _: str) -> Paginator:
        return Paginator([{"logGroups": [{"logGroupName": name} for name in self.groups]}])

    def delete_log_group(self, logGroupName: str) -> None:  # noqa: N803
        self.groups.remove(logGroupName)


class CloudFormation:
    def __init__(self, status: str) -> None:
        self.status = status

    def describe_stacks(self, StackName: str) -> dict[str, Any]:  # noqa: N803
        assert StackName == EVENT["StackId"]
        return {"Stacks": [{"StackStatus": self.status}]}


class Run:
    def __init__(
        self,
        status: str = "DELETE_IN_PROGRESS",
        iam: Iam | None = None,
        agentcore: AgentCore | None = None,
        **event: Any,
    ) -> None:
        self.agentcore, self.iam, self.logs = agentcore or AgentCore(), iam or Iam(), Logs()
        self.answers: list[tuple[str, str]] = []
        self.reinvoked: list[dict[str, Any]] = []
        self.emitted: list[str] = []
        self.now = 0.0
        handle(
            {**EVENT, **event},
            sweep=Sweep(SETTINGS, self.agentcore, self.iam, self.logs),
            cloudformation=CloudFormation(status),
            reinvoke=self.reinvoked.append,
            answer=lambda _event, status, reason: self.answers.append((status, reason)),
            clock=lambda: self.now,
            sleep=self._sleep,
            emit=self._emit,
            now=lambda: 1_700_000_000.5,
        )

    def _sleep(self, seconds: float) -> None:
        self.now += seconds

    def _emit(self, line: str) -> None:
        # The metric is written after the answer, never instead of it.
        assert [status for status, _ in self.answers] == ["FAILED"]
        self.emitted.append(line)


def test_removes_every_agent_and_pack_of_the_installation_and_nothing_else() -> None:
    run = Run()
    assert run.answers == [("SUCCESS", "")]
    ac = run.agentcore
    # Connector targets and policies of the stack, and everything of another installation, stay.
    assert [t["name"] for t in ac.targets] == ["cost-explorer"]
    assert [p["policyId"] for p in ac.policies] == ["p0", "p2"]
    assert sorted(ac.runtimes) == [
        "Mango_other_mcp_aws_pricing-CCCCCCCCCC",
        "harness_Mango_acme_a_finops-BBBBBBBBBB",
    ]
    assert list(ac.harness_endpoints) == ["Mango_other_a_finops-EEEEEEEEEE"]
    assert sorted(run.iam.deleted) == ["Mango-acme-agent-finops", "Mango-acme-mcp-aws-pricing"]
    assert run.logs.groups == [
        "/aws/bedrock-agentcore/runtimes/Mango_other_mcp_aws_pricing-CCCCCCCCCC-DEFAULT"
    ]


def test_deletes_endpoints_before_what_holds_them_and_roles_last() -> None:
    calls = Run().agentcore.calls
    assert calls.index("harness-endpoint:Mango_acme_a_finops-DDDDDDDDDD:live") < calls.index(
        "harness:Mango_acme_a_finops-DDDDDDDDDD"
    )
    assert calls.index("runtime-endpoint:Mango_acme_mcp_aws_pricing-AAAAAAAAAA:live") < calls.index(
        "runtime:Mango_acme_mcp_aws_pricing-AAAAAAAAAA"
    )
    assert not any("DEFAULT" in call for call in calls)


AWS_MANAGED = "arn:aws:iam::aws:policy/ReadOnlyAccess"
OF_THE_ORGANIZATION = "arn:aws:iam::111111111111:policy/org-guardrail"
FINOPS = "Mango-acme-agent-finops"


def test_detaches_the_managed_policies_of_a_role_and_then_deletes_it() -> None:
    # D58 (22): attached by hand or by the organization, after the provisioner made the role.
    iam = Iam()
    iam.attached[FINOPS] = [[AWS_MANAGED, OF_THE_ORGANIZATION]]
    run = Run(iam=iam)
    assert run.answers == [("SUCCESS", "")]
    assert sorted(iam.deleted) == [FINOPS, "Mango-acme-mcp-aws-pricing"]
    # In the order IAM asks for: inline policies, attached ones, the role. Once each.
    assert [call for call in iam.calls if call.endswith(FINOPS) or f":{FINOPS}:" in call] == [
        f"list_role_policies:{FINOPS}",
        f"delete_role_policy:{FINOPS}:agent",
        f"list_attached_role_policies:{FINOPS}",
        f"detach_role_policy:{FINOPS}:{AWS_MANAGED}",
        f"detach_role_policy:{FINOPS}:{OF_THE_ORGANIZATION}",
        f"delete_role:{FINOPS}",
    ]


def test_detaches_every_page_of_attached_policies() -> None:
    iam = Iam()
    pages = [
        [f"arn:aws:iam::111111111111:policy/p{page}{i}" for i in range(3)] for page in range(4)
    ]
    iam.attached[FINOPS] = [list(page) for page in pages]
    run = Run(iam=iam)
    assert run.answers == [("SUCCESS", "")]
    detached = [call.rsplit(":policy/", 1)[1] for call in iam.calls if "detach_role_policy" in call]
    assert detached == [arn.rsplit("/", 1)[1] for page in pages for arn in page]
    assert FINOPS in iam.deleted


def test_a_policy_someone_else_detached_first_is_not_an_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def gone(self: Iam, RoleName: str, PolicyArn: str) -> None:  # noqa: N803
        self.attached[RoleName] = [[]]
        raise error("NoSuchEntity", "DetachRolePolicy")

    monkeypatch.setattr(Iam, "detach_role_policy", gone)
    iam = Iam()
    iam.attached[FINOPS] = [[AWS_MANAGED]]
    run = Run(iam=iam)
    assert run.answers == [("SUCCESS", "")]
    assert FINOPS in iam.deleted


def test_a_denied_detach_fails_like_any_other_call_and_names_no_role_or_policy(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def denied(self: Iam, RoleName: str, PolicyArn: str) -> None:  # noqa: N803
        raise error(
            "AccessDenied",
            "DetachRolePolicy",
            f"User is not authorized to perform iam:DetachRolePolicy on role {RoleName} "
            f"with policy {PolicyArn}",
        )

    monkeypatch.setattr(Iam, "detach_role_policy", denied)
    iam = Iam()
    iam.attached[FINOPS] = [[OF_THE_ORGANIZATION]]
    with caplog.at_level("INFO", logger=uninstall.logger.name):
        run = Run(iam=iam)
    assert run.answers == [
        (
            "FAILED",
            "Uninstall guard failed (DetachRolePolicy: AccessDenied). The rest of the stack "
            "was not deleted and the application still works. Deleting the stack again fails "
            "the same way until the role Mango-acme-UninstallGuard is allowed that operation. "
            "Some agents or packs may already be gone. See step 5 (uninstall) of the "
            "installation runbook.",
        )
    ]
    assert caplog.records[-1].getMessage() == (
        "uninstall_guard failed: operation=DetachRolePolicy code=AccessDenied"
    )
    said = caplog.text + run.answers[0][1]
    for leaked in (OF_THE_ORGANIZATION, "org-guardrail", FINOPS, "111111111111", "not authorized"):
        assert leaked not in said
    # It stopped there: the role is still there, and so is its policy.
    assert iam.deleted == []
    assert iam.attached[FINOPS] == [[OF_THE_ORGANIZATION]]
    assert [json.loads(line)["DeletionFailed"] for line in run.emitted] == [1]


def test_a_role_without_a_boundary_of_the_installation_keeps_its_attached_policies() -> None:
    iam = Iam()
    for name in ("Mango-acme-agent-handmade", "Mango-acme-ApiTask", "Mango-other-agent-finops"):
        iam.attached[name] = [[AWS_MANAGED]]
    run = Run(iam=iam)
    assert run.answers == [("SUCCESS", "")]
    # Not even listed: neither its inline policies nor its attached ones.
    touched = {call.split(":")[1] for call in iam.calls}
    assert touched == {FINOPS, "Mango-acme-mcp-aws-pricing"}
    assert sorted(iam.roles) == [
        "Mango-acme-ApiTask",
        "Mango-acme-agent-handmade",
        "Mango-other-agent-finops",
    ]
    assert all(pages == [[AWS_MANAGED]] for pages in iam.attached.values())


def test_a_role_still_held_with_its_policies_removed_fails_in_a_few_passes_and_says_so(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # D58 (22): an instance profile holds the role and the guard may not look at it.
    iam = Iam()
    iam.attached[FINOPS] = [[AWS_MANAGED]]
    iam.in_instance_profile.add(FINOPS)
    with caplog.at_level("INFO", logger=uninstall.logger.name):
        run = Run(iam=iam)
    assert run.reinvoked == []
    assert run.answers == [
        (
            "FAILED",
            "Uninstall guard failed (DeleteRole: DeleteConflict). The rest of the stack was not "
            "deleted and the application still works. 1 role(s) of agents or packs cannot be "
            "deleted with their policies removed: something else holds them, such as an "
            "instance profile. Deleting the stack again fails the same way until it is "
            "removed. See step 5 (uninstall) of the installation runbook.",
        )
    ]
    assert len(run.answers[0][1]) <= 400
    # Three passes over the roles, 20 seconds apart, after the two AgentCore took: not the hour.
    assert iam.calls.count(f"delete_role:{FINOPS}") == uninstall.HELD_ROLE_PASSES == 3
    assert run.now == 4 * uninstall.POLL_SECONDS
    # The policy was detached once; the other role went on the first pass.
    assert [call for call in iam.calls if "detach_role_policy" in call] == [
        f"detach_role_policy:{FINOPS}:{AWS_MANAGED}"
    ]
    assert iam.deleted == ["Mango-acme-mcp-aws-pricing"]
    messages = [record.getMessage() for record in caplog.records]
    assert "uninstall_guard roles: detached_policies=1 held=1" in messages
    assert messages[-1] == "uninstall_guard failed: operation=DeleteRole code=DeleteConflict held=1"
    said = caplog.text + run.answers[0][1]
    for leaked in (FINOPS, AWS_MANAGED, "ReadOnlyAccess", "must detach"):
        assert leaked not in said
    assert [json.loads(line)["DeletionFailed"] for line in run.emitted] == [1]


def test_a_role_that_goes_on_a_later_pass_is_not_a_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    # IAM may take a moment to see a policy as detached: one conflict, then the role goes.
    iam = Iam()
    iam.in_instance_profile.add(FINOPS)
    sleep = Run._sleep

    def released(self: Run, seconds: float) -> None:
        if f"delete_role:{FINOPS}" in iam.calls:
            iam.in_instance_profile.clear()
        sleep(self, seconds)

    monkeypatch.setattr(Run, "_sleep", released)
    run = Run(iam=iam)
    assert run.answers == [("SUCCESS", "")]
    assert iam.calls.count(f"delete_role:{FINOPS}") == 2
    assert run.emitted == []


def test_a_failure_of_delete_role_that_is_not_a_conflict_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def denied(self: Iam, RoleName: str) -> None:  # noqa: N803
        raise error("AccessDenied", "DeleteRole")

    monkeypatch.setattr(Iam, "delete_role", denied)
    [(status, reason)] = Run().answers
    assert status == "FAILED"
    assert reason.startswith("Uninstall guard failed (DeleteRole: AccessDenied).")


@pytest.mark.parametrize(
    "status",
    [
        "UPDATE_IN_PROGRESS",
        "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
        "CREATE_COMPLETE",
        "UPDATE_ROLLBACK_IN_PROGRESS",
    ],
)
def test_changes_nothing_unless_the_stack_itself_is_being_deleted(status: str) -> None:
    run = Run(status)
    assert run.answers == [("SUCCESS", "")]
    assert run.agentcore.calls == []
    assert run.iam.deleted == []
    # Nothing of IAM at all: no policy is listed or detached outside a stack deletion.
    assert run.iam.calls == []
    assert len(run.logs.groups) == 3


@pytest.mark.parametrize("request_type", ["Create", "Update"])
def test_create_and_update_do_nothing(request_type: str) -> None:
    run = Run(RequestType=request_type)
    assert run.answers == [("SUCCESS", "")]
    assert run.agentcore.calls == []


def test_hands_over_to_another_invocation_when_deletions_take_long(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(AgentCore, "delete_harness", lambda self, harnessId: None)  # noqa: N803
    run = Run()
    assert run.answers == []
    assert [event["MangoInvocation"] for event in run.reinvoked] == [2]
    assert run.now >= uninstall.INVOCATION_BUDGET_SECONDS
    # Roles wait for the harness: none was deleted.
    assert run.iam.deleted == []


def test_fails_the_deletion_with_what_is_left_after_the_last_invocation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(AgentCore, "delete_harness", lambda self, harnessId: None)  # noqa: N803
    run = Run(MangoInvocation=uninstall.MAX_INVOCATIONS)
    assert run.reinvoked == []
    [(status, reason)] = run.answers
    assert status == "FAILED"
    assert reason == (
        "Agents or packs are still being deleted (harnesses=1, roles=-1). The rest of the "
        "stack was not deleted and the application still works. Delete the stack again: it "
        "goes on from where it stopped."
    )


def test_busy_or_gone_is_not_an_error_and_anything_else_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def busy(self: AgentCore, harnessId: str) -> None:  # noqa: N803
        raise error("ConflictException")

    monkeypatch.setattr(AgentCore, "delete_harness", busy)
    assert Run().reinvoked  # still polling, not failed

    def denied(self: AgentCore, harnessId: str) -> None:  # noqa: N803
        raise error("AccessDeniedException")

    monkeypatch.setattr(AgentCore, "delete_harness", denied)
    [(status, reason)] = Run().answers
    assert status == "FAILED"
    assert "AccessDeniedException" in reason


def test_a_denied_call_is_named_by_operation_and_code_and_nothing_else(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    arn = "arn:aws:bedrock-agentcore:us-east-1:111111111111:gateway/mango-acme-tools-abc123"
    message = f"User is not authorized to perform ManageResourceScopedPolicy on {arn}"

    def denied(self: AgentCore, policyEngineId: str, policyId: str) -> None:  # noqa: N803
        raise error("AccessDeniedException", "DeletePolicy", message)

    monkeypatch.setattr(AgentCore, "delete_policy", denied)
    with caplog.at_level("ERROR", logger=uninstall.logger.name):
        run = Run()
    # D58 (16): what is left, that deleting again does not help, and on which role to fix it.
    assert run.answers == [
        (
            "FAILED",
            "Uninstall guard failed (DeletePolicy: AccessDeniedException). The rest of the stack "
            "was not deleted and the application still works. Deleting the stack again fails "
            "the same way until the role Mango-acme-UninstallGuard is allowed that operation. "
            "Some agents or packs may already be gone. See step 5 (uninstall) of the "
            "installation runbook.",
        )
    ]
    assert [record.getMessage() for record in caplog.records] == [
        "uninstall_guard failed: operation=DeletePolicy code=AccessDeniedException"
    ]
    # Neither the message of AWS nor any identifier: not the Gateway, the policy or the account.
    said = caplog.text + run.answers[0][1]
    for leaked in (arn, "mango-acme-tools-abc123", "p1", "111111111111", "not authorized"):
        assert leaked not in said
    # It stopped there: nothing after the policy was touched.
    assert run.iam.deleted == []


@pytest.mark.parametrize(
    "code", ["ThrottlingException", "ServiceUnavailableException", "InternalServerException"]
)
def test_a_failure_that_may_pass_says_to_delete_the_stack_again(
    monkeypatch: pytest.MonkeyPatch, code: str
) -> None:
    def failing(self: AgentCore, harnessId: str) -> None:  # noqa: N803
        raise error(code, "DeleteHarness")

    monkeypatch.setattr(AgentCore, "delete_harness", failing)
    [(status, reason)] = Run().answers
    assert status == "FAILED"
    assert reason == (
        f"Uninstall guard failed (DeleteHarness: {code}). The rest of the stack was not "
        "deleted and the application still works. The failure may pass: delete the stack "
        "again. If it repeats: See step 5 (uninstall) of the installation runbook."
    )


def test_a_connection_failure_may_pass_too(monkeypatch: pytest.MonkeyPatch) -> None:
    def unreachable(self: AgentCore, harnessId: str) -> None:  # noqa: N803
        raise EndpointConnectionError(endpoint_url="https://example.invalid")

    monkeypatch.setattr(AgentCore, "delete_harness", unreachable)
    [(status, reason)] = Run().answers
    assert status == "FAILED"
    assert reason.startswith("Uninstall guard failed (EndpointConnectionError). The rest of")
    assert "The failure may pass: delete the stack again." in reason
    assert "example.invalid" not in reason


def test_any_other_failure_never_promises_that_deleting_again_works(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def invalid(self: AgentCore, harnessId: str) -> None:  # noqa: N803
        raise error("ValidationException", "DeleteHarness")

    monkeypatch.setattr(AgentCore, "delete_harness", invalid)
    [(status, reason)] = Run().answers
    assert status == "FAILED"
    assert reason == (
        "Uninstall guard failed (DeleteHarness: ValidationException). The rest of the stack "
        "was not deleted and the application still works. Deleting the stack again may fail "
        "the same way: look at the function's log group first. Some agents or packs may "
        "already be gone. See step 5 (uninstall) of the installation runbook."
    )


def test_every_failure_fits_in_what_cloudformation_shows() -> None:
    # `respond` cuts the reason at 400 characters: the instruction must not be what is cut.
    longest_operation = "DeleteAgentRuntimeEndpoint"
    for code in ("AccessDeniedException", "ThrottlingException", "ResourceLimitExceededException"):
        reason = uninstall.failure_reason(
            error(code, longest_operation), "Mango-abcd1234-UninstallGuard"
        )
        assert len(reason) <= 400
        assert reason.endswith("runbook.")
    held = uninstall.held_reason(9999)
    assert len(held) <= 400
    assert held.endswith("runbook.")


def test_a_failure_that_is_not_an_aws_call_names_only_its_kind() -> None:
    assert uninstall.failed_call(KeyError("Stacks")) == ("-", "KeyError")
    assert uninstall.failed_call(error("ThrottlingException", "arn:aws:iam::1:role/x")) == (
        "-",
        "ThrottlingException",
    )


def test_every_failed_answer_counts_once_in_the_metric_and_says_nothing_of_the_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def denied(self: AgentCore, policyEngineId: str, policyId: str) -> None:  # noqa: N803
        raise error("AccessDeniedException", "DeletePolicy", f"not authorized on {policyId}")

    record = {
        "_aws": {
            "Timestamp": 1_700_000_000_500,
            "CloudWatchMetrics": [
                {
                    "Namespace": "Mango/UninstallGuard",
                    "Dimensions": [["Installation"]],
                    "Metrics": [{"Name": "DeletionFailed", "Unit": "Count"}],
                }
            ],
        },
        "Installation": "acme",
        "DeletionFailed": 1,
    }
    with monkeypatch.context() as patch:
        patch.setattr(AgentCore, "delete_policy", denied)
        stopped = Run()
    assert [status for status, _ in stopped.answers] == ["FAILED"]
    assert [json.loads(line) for line in stopped.emitted] == [record]

    # AgentCore did not finish within the hour: the stack ends in DELETE_FAILED just the same.
    monkeypatch.setattr(AgentCore, "delete_harness", lambda self, harnessId: None)  # noqa: N803
    late = Run(MangoInvocation=uninstall.MAX_INVOCATIONS)
    assert [status for status, _ in late.answers] == ["FAILED"]
    assert [json.loads(line) for line in late.emitted] == [record]


@pytest.mark.parametrize(
    "event",
    [
        {},
        {"RequestType": "Create"},
        {"RequestType": "Update"},
    ],
)
def test_a_deletion_that_works_and_a_request_that_deletes_nothing_write_no_metric(
    event: dict[str, Any],
) -> None:
    run = Run(**event)
    assert run.answers == [("SUCCESS", "")]
    assert run.emitted == []
    assert Run("UPDATE_IN_PROGRESS").emitted == []


def test_waiting_for_the_next_invocation_is_not_a_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(AgentCore, "delete_harness", lambda self, harnessId: None)  # noqa: N803
    run = Run()
    assert run.reinvoked
    assert run.emitted == []


def test_a_metric_that_cannot_be_written_neither_fails_the_guard_nor_changes_its_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def denied(self: AgentCore, harnessId: str) -> None:  # noqa: N803
        raise error("AccessDeniedException", "DeleteHarness")

    def closed(self: Run, line: str) -> None:
        raise OSError("stdout")

    monkeypatch.setattr(AgentCore, "delete_harness", denied)
    monkeypatch.setattr(Run, "_emit", closed)
    [(status, reason)] = Run().answers
    assert status == "FAILED"
    assert reason.startswith("Uninstall guard failed (DeleteHarness: AccessDeniedException).")


def test_settings_reject_anything_but_well_formed_names() -> None:
    env = {
        "MANGO_NAMESPACE": "acme",
        "GATEWAY_ID": "mango-acme-tools-abc123",
        "POLICY_ENGINE_ID": "Mango_acme_Tools-xyz",
        "ROLE_BOUNDARY_ARNS": ",".join(sorted(BOUNDARIES)),
        "CONNECTOR_TARGETS": "cost-explorer,ops",
    }
    settings = GuardSettings.from_env(env)
    assert settings.connector_targets == frozenset({"cost-explorer", "ops"})
    assert settings.role_prefixes == ("Mango-acme-agent-", "Mango-acme-mcp-")
    for key, bad in [
        ("MANGO_NAMESPACE", "*"),
        ("GATEWAY_ID", "a b"),
        ("ROLE_BOUNDARY_ARNS", "arn:aws:iam::1:policy/x"),
    ]:
        with pytest.raises(ValueError, match=key.split("_")[0]):
            GuardSettings.from_env({**env, key: bad})
