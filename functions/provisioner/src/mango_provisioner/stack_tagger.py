"""Stack tagger: the stack's tags on what CloudFormation cannot tag (D77).

CloudFormation hands a stack's tags to every resource the template declares that takes them.
Three kinds of resource of an installation take tags in AWS and not in CloudFormation: the
customer managed IAM policies (the permissions boundaries, and the policy CDK splits off a role
whose own grew too large), what AWS makes with each VPC (its default security group, default
network ACL and main route table), and the rules of security groups. This function is a custom
resource of the Core stack. On Create, and on every Update (its ``Release`` property changes
with each version), it gives them the tags of the stack they belong to, plus Mango's own, with
the rules of D76: never ``aws:`` or ``mango:`` keys of the stack, in any case.

It only works on the VPCs the template names, and only if each one carries the installation's
``mango:namespace`` and belongs, by CloudFormation's own tag, to this installation's Core or
PackNetwork stack. It never acts while the stack rolls back: an answer that fails there could
leave the stack stuck. Delete does nothing: the stack deletes those resources itself.

A tag that cannot be applied answers FAILED with the operation and the error code, never a tag
or an AWS message (D77 (3)): CloudFormation rolls the stack back instead of leaving a resource
without a tag the customer asked for.
"""

from __future__ import annotations

import logging
import os
import re
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from mango_provisioner.config import ConfigError, stack_id
from mango_provisioner.errors import StepError, error_code
from mango_provisioner.stack_tags import custom_tags, merge
from mango_provisioner.uninstall import respond

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

PHYSICAL_ID = "mango-stack-tags"
_NAMESPACE_RE = re.compile(r"^[a-z0-9]{3,8}$")
_ACCOUNT_RE = re.compile(r"^\d{12}$")
_REGION_RE = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d$")
_VPC_RE = re.compile(r"^vpc-[0-9a-f]{8,17}$")
_STACK_COMPONENTS = {"Core": "core", "PackNetwork": "pack-network"}
"""The stacks of the installation that own a VPC, and their ``mango:component``."""
_ROLLING_BACK = re.compile(r"ROLLBACK")
_BATCH = 100
"""Resources per CreateTags call: EC2 recommends small batches."""
_CLIENT_CONFIG = Config(retries={"mode": "standard", "max_attempts": 5})
_DENIED = frozenset({"AccessDenied", "AccessDeniedException", "UnauthorizedOperation"})
DENIAL_ATTEMPTS = 5
"""The role and its policy are created in the same stack operation, seconds before the function
runs, and IAM takes a while to apply a new policy everywhere: a denial is tried again before it
counts, for about 80 s. Tags are idempotent, so running again is harmless."""
DENIAL_WAIT_SECONDS = 20


@dataclass(frozen=True)
class TaggerSettings:
    namespace: str
    region: str
    account_id: str

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> TaggerSettings:
        env = os.environ if env is None else env
        namespace = env.get("MANGO_NAMESPACE", "")
        region = env.get("AWS_REGION", "")
        account_id = env.get("MANGO_ACCOUNT_ID", "")
        if not (
            _NAMESPACE_RE.fullmatch(namespace)
            and _REGION_RE.fullmatch(region)
            and _ACCOUNT_RE.fullmatch(account_id)
        ):
            raise ValueError("the stack tagger's environment is invalid")
        return TaggerSettings(namespace, region, account_id)

    def stack_name(self, stack: str) -> str:
        return f"Mango-{self.namespace}-{stack}"

    @property
    def policy_prefix(self) -> str:
        return f"arn:aws:iam::{self.account_id}:policy/Mango-{self.namespace}-"


@dataclass(frozen=True)
class Vpc:
    vpc_id: str
    stack_id: str
    component: str


class Tagger:
    """Applies the tags; every read and write goes through the clients it is given."""

    def __init__(self, settings: TaggerSettings, cloudformation: Any, iam: Any, ec2: Any) -> None:
        self._s = settings
        self._cfn = cloudformation
        self._iam = iam
        self._ec2 = ec2

    def stack_status(self, stack: str) -> str:
        return str(self._cfn.describe_stacks(StackName=stack)["Stacks"][0]["StackStatus"])

    def tags_of(self, stack: str, component: str) -> dict[str, str]:
        stacks = self._cfn.describe_stacks(StackName=stack)["Stacks"]
        own = {"mango:namespace": self._s.namespace, "mango:component": component}
        return merge(own, custom_tags(stacks[0].get("Tags") or []))

    def vpcs(self, vpc_ids: Iterable[str]) -> list[Vpc]:
        """The named VPCs, each checked to be this installation's and to say whose it is."""
        wanted = sorted(set(vpc_ids))
        found = self._ec2.describe_vpcs(VpcIds=wanted)["Vpcs"]
        if sorted(str(v["VpcId"]) for v in found) != wanted:
            raise StepError("vpc_not_found")
        vpcs = []
        for vpc in found:
            tags = {t["Key"]: t["Value"] for t in vpc.get("Tags", [])}
            owner = tags.get("aws:cloudformation:stack-id", "")
            stack = next(
                (n for n in _STACK_COMPONENTS if f":stack/{self._s.stack_name(n)}/" in owner),
                None,
            )
            if tags.get("mango:namespace") != self._s.namespace or stack is None:
                raise StepError("vpc_not_of_this_installation")
            vpcs.append(Vpc(str(vpc["VpcId"]), owner, _STACK_COMPONENTS[stack]))
        return vpcs

    def managed_policies(self, stack: str) -> list[str]:
        pages = self._cfn.get_paginator("list_stack_resources").paginate(StackName=stack)
        arns = [
            str(r["PhysicalResourceId"])
            for page in pages
            for r in page["StackResourceSummaries"]
            if r["ResourceType"] == "AWS::IAM::ManagedPolicy" and r.get("PhysicalResourceId")
        ]
        if any(not arn.startswith(self._s.policy_prefix) for arn in arns):
            raise StepError("policy_not_of_this_installation")
        return arns

    def network_resources(self, vpc_id: str) -> tuple[list[str], list[str]]:
        """The defaults AWS made with the VPC, and the rules of every security group in it."""
        on_vpc = [{"Name": "vpc-id", "Values": [vpc_id]}]
        groups = self._all("describe_security_groups", "SecurityGroups", Filters=on_vpc)
        defaults = [str(g["GroupId"]) for g in groups if g.get("GroupName") == "default"]
        acls = self._all(
            "describe_network_acls",
            "NetworkAcls",
            Filters=[*on_vpc, {"Name": "default", "Values": ["true"]}],
        )
        tables = self._all(
            "describe_route_tables",
            "RouteTables",
            Filters=[*on_vpc, {"Name": "association.main", "Values": ["true"]}],
        )
        defaults += [str(a["NetworkAclId"]) for a in acls]
        defaults += [str(t["RouteTableId"]) for t in tables]
        group_ids = {str(g["GroupId"]) for g in groups}
        rules: list[str] = []
        if group_ids:
            found = self._all(
                "describe_security_group_rules",
                "SecurityGroupRules",
                Filters=[{"Name": "group-id", "Values": sorted(group_ids)}],
            )
            # Only rules of this VPC's groups, whatever the filter returned.
            rules = [str(r["SecurityGroupRuleId"]) for r in found if r.get("GroupId") in group_ids]
        return defaults, rules

    def _all(self, operation: str, key: str, **kwargs: Any) -> list[dict[str, Any]]:
        pages = self._ec2.get_paginator(operation).paginate(**kwargs)
        return [item for page in pages for item in page[key]]

    def tag_network(self, ids: list[str], tags: Mapping[str, str]) -> None:
        pairs = [{"Key": k, "Value": v} for k, v in tags.items()]
        for start in range(0, len(ids), _BATCH):
            self._ec2.create_tags(Resources=ids[start : start + _BATCH], Tags=pairs)

    def run(self, core_stack: str, vpc_ids: Iterable[str]) -> dict[str, int]:
        """Reads and checks everything first, then writes: a refusal leaves no tag half put."""
        vpcs = self.vpcs(vpc_ids)
        components = {core_stack: "core", **{v.stack_id: v.component for v in vpcs}}
        tags = {stack: self.tags_of(stack, component) for stack, component in components.items()}
        policies = {stack: self.managed_policies(stack) for stack in components}
        network = {vpc.vpc_id: self.network_resources(vpc.vpc_id) for vpc in vpcs}
        counts = {"policies": 0, "defaults": 0, "rules": 0}
        for stack, arns in policies.items():
            pairs = [{"Key": k, "Value": v} for k, v in tags[stack].items()]
            for arn in arns:
                self._iam.tag_policy(PolicyArn=arn, Tags=pairs)
                counts["policies"] += 1
        for vpc in vpcs:
            defaults, rules = network[vpc.vpc_id]
            self.tag_network(defaults + rules, tags[vpc.stack_id])
            counts["defaults"] += len(defaults)
            counts["rules"] += len(rules)
        return counts


def _vpc_ids(event: Mapping[str, Any]) -> list[str]:
    ids = event.get("ResourceProperties", {}).get("VpcIds", [])
    valid = isinstance(ids, list) and all(isinstance(i, str) and _VPC_RE.fullmatch(i) for i in ids)
    if not valid or not ids:
        raise StepError("vpc_ids_invalid")
    return [str(i) for i in ids]


def _what_failed(exc: Exception) -> str:
    """What failed, as a code: never a tag, an ARN or a message of AWS."""
    if isinstance(exc, StepError):
        return exc.code
    if isinstance(exc, ClientError):
        operation = str(getattr(exc, "operation_name", "") or "-")
        operation = operation if re.fullmatch(r"[A-Za-z]{1,64}", operation) else "-"
        return f"{operation}: {error_code(exc)}"
    return type(exc).__name__


def _run_with_patience(
    tagger: Tagger, core: str, vpc_ids: list[str], sleep: Callable[[float], None]
) -> dict[str, int]:
    """Runs the tagger, trying a denial again for a while (see DENIAL_ATTEMPTS)."""
    for attempt in range(1, DENIAL_ATTEMPTS):
        try:
            return tagger.run(core, vpc_ids)
        except ClientError as exc:
            if error_code(exc) not in _DENIED:
                raise
            logger.info("stack_tagger denied (attempt %d): waiting for IAM", attempt)
            sleep(DENIAL_WAIT_SECONDS)
    return tagger.run(core, vpc_ids)


def handle(
    event: Mapping[str, Any],
    *,
    settings: TaggerSettings,
    tagger: Tagger,
    answer: Callable[..., None] = respond,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    def reply(status: str, reason: str = "") -> None:
        answer(event, status, reason, physical_id=PHYSICAL_ID)

    if event.get("RequestType") not in ("Create", "Update"):
        reply("SUCCESS")
        return
    try:
        core = stack_id(
            str(event.get("StackId", "")),
            region=settings.region,
            account_id=settings.account_id,
            namespace=settings.namespace,
        )
        if _ROLLING_BACK.search(tagger.stack_status(core)):
            logger.info("stack_tagger skipped: the stack is rolling back")
            reply("SUCCESS")
            return
        counts = _run_with_patience(tagger, core, _vpc_ids(event), sleep)
    except ConfigError:
        logger.error("stack_tagger refused: the request is not for this installation's Core stack")  # noqa: TRY400
        reply("FAILED", "The stack tagger only tags the Core stack of its own installation.")
        return
    except Exception as exc:  # noqa: BLE001 - CloudFormation must always get an answer
        what = _what_failed(exc)
        logger.error("stack_tagger failed: %s", what)  # noqa: TRY400
        reply("FAILED", _reason(what))
        return
    logger.info(
        "stack_tagger tagged policies=%d defaults=%d rules=%d",
        counts["policies"],
        counts["defaults"],
        counts["rules"],
    )
    reply("SUCCESS")


def _reason(what: str) -> str:
    return (
        f"The stack's tags could not be given to what CloudFormation cannot tag ({what}), so "
        "the stack rolls back. Fix the cause, a tag of the stack or a permission, and create or "
        "update the stack again. See the installation runbook, known problems."
    )


def lambda_handler(event: dict[str, Any], _context: Any) -> None:
    settings = TaggerSettings.from_env()
    handle(
        event,
        settings=settings,
        tagger=Tagger(
            settings,
            boto3.client("cloudformation", config=_CLIENT_CONFIG),
            boto3.client("iam", config=_CLIENT_CONFIG),
            boto3.client("ec2", config=_CLIENT_CONFIG),
        ),
    )
