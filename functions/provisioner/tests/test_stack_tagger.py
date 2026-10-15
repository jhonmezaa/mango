"""D77: the stack tagger gives the stack's tags to what CloudFormation cannot tag."""

from __future__ import annotations

from typing import Any

import pytest
from botocore.exceptions import ClientError

from mango_provisioner.stack_tagger import (
    DENIAL_ATTEMPTS,
    PHYSICAL_ID,
    Tagger,
    TaggerSettings,
    handle,
)

from .conftest import ACCOUNT, NS, REGION, STACK_ID

SETTINGS = TaggerSettings(NS, REGION, ACCOUNT)
PACK_STACK = (
    f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/Mango-{NS}-PackNetwork/"
    "1f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
)
CORE_VPC, PACK_VPC = "vpc-0aaaaaaaaaaaaaaa1", "vpc-0bbbbbbbbbbbbbbb2"
POLICIES = [
    f"arn:aws:iam::{ACCOUNT}:policy/Mango-{NS}-agent-boundary",
    f"arn:aws:iam::{ACCOUNT}:policy/Mango-{NS}-mcp-boundary",
    f"arn:aws:iam::{ACCOUNT}:policy/Mango-{NS}-Core-PackProvisionerRoleOverflowPolicy-AbC",
]
CORE_TAGS = {"project-id": "mango", "mango:namespace": "evil", "aws:cloudformation:x": "y"}
PACK_TAGS = {"project-id": "mango", "cost center": "CC-1"}


def _error(code: str, operation: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "SECRET-MESSAGE"}}, operation)


class FakeCloudFormation:
    def __init__(self) -> None:
        self.status = "CREATE_IN_PROGRESS"
        self.tags = {STACK_ID: CORE_TAGS, PACK_STACK: PACK_TAGS}
        self.policies = list(POLICIES)

    def describe_stacks(self, **kwargs: Any) -> dict[str, Any]:
        stack = kwargs["StackName"]
        tags = [{"Key": k, "Value": v} for k, v in self.tags[stack].items()]
        return {"Stacks": [{"StackId": stack, "StackStatus": self.status, "Tags": tags}]}

    def get_paginator(self, name: str) -> Any:
        assert name == "list_stack_resources"
        outer = self

        class Pages:
            def paginate(self, **kwargs: Any) -> list[dict[str, Any]]:
                # The pack network declares no managed policy; Core declares the three.
                policies = outer.policies if kwargs["StackName"] == STACK_ID else []
                summaries = [
                    {"ResourceType": "AWS::IAM::ManagedPolicy", "PhysicalResourceId": arn}
                    for arn in policies
                ]
                summaries.append({"ResourceType": "AWS::IAM::Role", "PhysicalResourceId": "x"})
                return [{"StackResourceSummaries": summaries}]

        return Pages()


class FakeIam:
    def __init__(self) -> None:
        self.tagged: dict[str, dict[str, str]] = {}
        self.fail: Exception | None = None
        self.fail_times = 10**6

    def tag_policy(self, **kwargs: Any) -> None:
        if self.fail and self.fail_times > 0:
            self.fail_times -= 1
            raise self.fail
        self.tagged[kwargs["PolicyArn"]] = {t["Key"]: t["Value"] for t in kwargs["Tags"]}


class FakeEc2:
    def __init__(self, rules_per_group: int = 2) -> None:
        self.vpc_tags = {
            CORE_VPC: {"mango:namespace": NS, "aws:cloudformation:stack-id": STACK_ID},
            PACK_VPC: {"mango:namespace": NS, "aws:cloudformation:stack-id": PACK_STACK},
        }
        self.groups = {
            CORE_VPC: [("sg-default-core", "default"), ("sg-api", "api")],
            PACK_VPC: [
                ("sg-default-pack", "default"),
                ("sg-pack", "pack"),
                ("sg-endpoints", "endpoints"),
            ],
        }
        self.rules_per_group = rules_per_group
        self.tagged: dict[str, dict[str, str]] = {}
        self.calls: list[int] = []
        self._filter_vpc = ""

    def describe_vpcs(self, **kwargs: Any) -> dict[str, Any]:
        vpcs = [v for v in kwargs["VpcIds"] if v in self.vpc_tags]
        return {
            "Vpcs": [
                {"VpcId": v, "Tags": [{"Key": k, "Value": x} for k, x in self.vpc_tags[v].items()]}
                for v in vpcs
            ]
        }

    def get_paginator(self, name: str) -> Any:
        """Each paginated read answers for the VPC in its filter, like EC2."""
        outer = self

        class Pages:
            def paginate(self, **kwargs: Any) -> list[dict[str, Any]]:
                filters = {f["Name"]: f["Values"] for f in kwargs["Filters"]}
                if "vpc-id" in filters:
                    outer._filter_vpc = filters["vpc-id"][0]
                return [getattr(outer, f"_{name}")()]

        return Pages()

    def _describe_security_groups(self) -> dict[str, Any]:
        groups = self.groups[self._filter_vpc]
        return {"SecurityGroups": [{"GroupId": g, "GroupName": n} for g, n in groups]}

    def _describe_network_acls(self) -> dict[str, Any]:
        return {"NetworkAcls": [{"NetworkAclId": f"acl-{self._filter_vpc[-1]}"}]}

    def _describe_route_tables(self) -> dict[str, Any]:
        return {"RouteTables": [{"RouteTableId": f"rtb-{self._filter_vpc[-1]}"}]}

    def _describe_security_group_rules(self) -> dict[str, Any]:
        rules = [
            {"SecurityGroupRuleId": f"sgr-{g}-{i}", "GroupId": g}
            for g, _ in self.groups[self._filter_vpc]
            for i in range(self.rules_per_group)
        ]
        # A rule of a group of another VPC must never be tagged, whatever the filter returned.
        rules.append({"SecurityGroupRuleId": "sgr-foreign", "GroupId": "sg-foreign"})
        return {"SecurityGroupRules": rules}

    def create_tags(self, **kwargs: Any) -> None:
        self.calls.append(len(kwargs["Resources"]))
        for resource in kwargs["Resources"]:
            self.tagged[resource] = {t["Key"]: t["Value"] for t in kwargs["Tags"]}


def _event(request: str = "Create", **properties: Any) -> dict[str, Any]:
    return {
        "RequestType": request,
        "StackId": STACK_ID,
        "RequestId": "r-1",
        "LogicalResourceId": "StackTagger",
        "ResponseURL": "https://example.invalid/answer",
        "ResourceProperties": {"Release": "v1", "VpcIds": [CORE_VPC, PACK_VPC], **properties},
    }


class Lab:
    def __init__(self, rules_per_group: int = 2) -> None:
        self.cfn = FakeCloudFormation()
        self.iam = FakeIam()
        self.ec2 = FakeEc2(rules_per_group)
        self.answers: list[tuple[str, str, str]] = []
        self.sleeps: list[float] = []

    def run(self, event: dict[str, Any]) -> tuple[str, str]:
        def answer(_event: Any, status: str, reason: str = "", *, physical_id: str) -> None:
            self.answers.append((status, reason, physical_id))

        handle(
            event,
            settings=SETTINGS,
            tagger=Tagger(SETTINGS, self.cfn, self.iam, self.ec2),
            answer=answer,
            sleep=self.sleeps.append,
        )
        assert len(self.answers) == 1
        status, reason, physical = self.answers[0]
        assert physical == PHYSICAL_ID
        return status, reason


CORE_EXPECTED = {"project-id": "mango", "mango:namespace": NS, "mango:component": "core"}
PACK_EXPECTED = {
    "project-id": "mango",
    "cost center": "CC-1",
    "mango:namespace": NS,
    "mango:component": "pack-network",
}


@pytest.mark.parametrize("request_type", ["Create", "Update"])
def test_everything_cloudformation_cannot_tag_gets_its_stacks_tags(request_type: str) -> None:
    lab = Lab()
    assert lab.run(_event(request_type)) == ("SUCCESS", "")
    assert lab.iam.tagged == dict.fromkeys(POLICIES, CORE_EXPECTED)
    core = ["sg-default-core", "acl-1", "rtb-1"] + [
        f"sgr-{g}-{i}" for g in ("sg-default-core", "sg-api") for i in range(2)
    ]
    pack = ["sg-default-pack", "acl-2", "rtb-2"] + [
        f"sgr-{g}-{i}" for g in ("sg-default-pack", "sg-pack", "sg-endpoints") for i in range(2)
    ]
    assert {r: t for r, t in lab.ec2.tagged.items() if r in core} == dict.fromkeys(
        core, CORE_EXPECTED
    )
    assert {r: t for r, t in lab.ec2.tagged.items() if r in pack} == dict.fromkeys(
        pack, PACK_EXPECTED
    )
    assert set(lab.ec2.tagged) == set(core) | set(pack)
    assert "sgr-foreign" not in lab.ec2.tagged
    # The only non-default group of the VPCs keeps the tags CloudFormation gave it: untouched here.
    assert "sg-api" not in lab.ec2.tagged


def test_delete_and_a_rollback_change_nothing() -> None:
    lab = Lab()
    assert lab.run(_event("Delete")) == ("SUCCESS", "")
    lab = Lab()
    lab.cfn.status = "UPDATE_ROLLBACK_IN_PROGRESS"
    assert lab.run(_event("Update")) == ("SUCCESS", "")
    assert lab.iam.tagged == {} and lab.ec2.tagged == {}


def test_requests_in_batches_ec2_can_take() -> None:
    lab = Lab(rules_per_group=60)
    assert lab.run(_event())[0] == "SUCCESS"
    assert max(lab.ec2.calls) <= 100
    assert sum(lab.ec2.calls) == len(lab.ec2.tagged)


@pytest.mark.parametrize(
    ("change", "code"),
    [
        (
            lambda lab: lab.ec2.vpc_tags[PACK_VPC].update({"mango:namespace": "other"}),
            "vpc_not_of_this_installation",
        ),
        (
            lambda lab: lab.ec2.vpc_tags[PACK_VPC].update(
                {"aws:cloudformation:stack-id": PACK_STACK.replace("PackNetwork", "Elsewhere")}
            ),
            "vpc_not_of_this_installation",
        ),
        (lambda lab: lab.ec2.vpc_tags.pop(PACK_VPC), "vpc_not_found"),
        (lambda lab: lab.cfn.tags.update({STACK_ID: {"Área": "x"}}), "stack_tag_invalid"),
        (
            lambda lab: lab.cfn.policies.append(f"arn:aws:iam::{ACCOUNT}:policy/SomeoneElses"),
            "policy_not_of_this_installation",
        ),
    ],
)
def test_nothing_is_tagged_when_something_is_not_this_installations(change: Any, code: str) -> None:
    lab = Lab()
    change(lab)
    status, reason = lab.run(_event())
    assert status == "FAILED"
    assert f"({code})" in reason and "rolls back" in reason
    assert lab.iam.tagged == {} and lab.ec2.tagged == {}


def test_a_denial_that_lasts_fails_with_the_operation_and_code_only() -> None:
    lab = Lab()
    lab.iam.fail = _error("AccessDenied", "TagPolicy")
    status, reason = lab.run(_event())
    assert status == "FAILED"
    assert "(TagPolicy: AccessDenied)" in reason
    assert "SECRET-MESSAGE" not in reason and "mango" not in reason.split("(")[1]
    # IAM may not have applied the brand-new policy yet: the whole run was tried again.
    assert len(lab.sleeps) == DENIAL_ATTEMPTS - 1


def test_a_denial_that_passes_is_waited_for() -> None:
    lab = Lab()
    lab.iam.fail = _error("AccessDenied", "TagPolicy")
    lab.iam.fail_times = 2
    assert lab.run(_event()) == ("SUCCESS", "")
    assert len(lab.sleeps) == 2
    assert lab.iam.tagged == dict.fromkeys(POLICIES, CORE_EXPECTED)


def test_other_errors_are_not_waited_for_and_any_error_gets_an_answer() -> None:
    lab = Lab()
    lab.iam.fail = _error("NoSuchEntity", "TagPolicy")
    status, reason = lab.run(_event())
    assert status == "FAILED" and "(TagPolicy: NoSuchEntity)" in reason
    assert lab.sleeps == []
    lab = Lab()
    lab.iam.fail = TypeError("boom")
    status, reason = lab.run(_event())
    assert status == "FAILED" and "(TypeError)" in reason and "boom" not in reason


def test_a_refusal_found_late_leaves_nothing_tagged() -> None:
    # The pack network declaring a policy that is not the installation's is only found after
    # Core's policies were read: nothing is written before everything was checked.
    lab = Lab()
    original = lab.cfn.get_paginator

    def with_foreign_pack_policy(name: str) -> Any:
        pages = original(name)

        class Pages:
            def paginate(self, **kwargs: Any) -> list[dict[str, Any]]:
                out = pages.paginate(**kwargs)
                if kwargs["StackName"] == PACK_STACK:
                    out[0]["StackResourceSummaries"].append(
                        {
                            "ResourceType": "AWS::IAM::ManagedPolicy",
                            "PhysicalResourceId": f"arn:aws:iam::{ACCOUNT}:policy/Foreign",
                        }
                    )
                return out

        return Pages()

    lab.cfn.get_paginator = with_foreign_pack_policy  # type: ignore[method-assign]
    status, reason = lab.run(_event())
    assert status == "FAILED" and "(policy_not_of_this_installation)" in reason
    assert lab.iam.tagged == {} and lab.ec2.tagged == {}


@pytest.mark.parametrize(
    "properties",
    [{"VpcIds": []}, {"VpcIds": "vpc-0aaaaaaaaaaaaaaa1"}, {"VpcIds": ["subnet-0aaaaaaaaaaaaaaa1"]}],
)
def test_vpc_ids_come_only_in_their_shape(properties: dict[str, Any]) -> None:
    status, reason = Lab().run(_event(**properties))
    assert status == "FAILED" and "(vpc_ids_invalid)" in reason


def test_a_request_for_another_stack_is_refused() -> None:
    event = _event()
    event["StackId"] = STACK_ID.replace(f"Mango-{NS}-Core", "Mango-other-Core")
    lab = Lab()
    status, _ = lab.run(event)
    assert status == "FAILED"
    assert lab.iam.tagged == {} and lab.ec2.tagged == {}
