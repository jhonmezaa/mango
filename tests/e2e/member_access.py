"""End-to-end check of the access to member accounts (§4.10, C4) against a deployed lab:
``Mango-<ns>-OrgAccess`` (StackSet), ``Mango-<ns>-Member`` (spoke role) and
``Mango-<ns>-ReadBroker`` (Core).

**Read only:** it creates, changes and deletes nothing. It reads Organizations, CloudFormation,
IAM and CloudTrail, invokes the AdminProbe (which only assumes roles) and attempts role
assumptions that must be refused.

``--steps`` picks what to run, in this order:

* ``org`` (``--admin-profile``): the accounts the StackSet must reach: active accounts under
  the configured targets, minus the excluded ones and the management account.
* ``stackset`` (``--admin-profile``): the StackSet is service-managed with auto-deployment,
  carries the template this release synthesizes, and has one current instance per expected
  account and none elsewhere.
* ``broker`` (``--profile``): ``Mango-<ns>-ReadBroker`` trusts exact role ARNs of the Mango
  account, demands ``SourceIdentity``, and can only assume the spoke role inside the
  organization.
* ``roles`` (``--member-profile <account>=<profile>``, one per account): the spoke role exists
  with the expected trust (the broker only, the organization, ``SourceIdentity`` mandatory)
  and exactly the data actions of the release. Accounts without a profile are reported as
  not checked.
* ``chain`` (``--profile``): for every expected account, the AdminProbe reaches the spoke role
  through the broker with a ``SourceIdentity``, the session is in that account, and the broker
  refuses a session without ``SourceIdentity``. The operator, who is not the broker, is
  refused by the broker and by every spoke role, and the chain reaches no role in the
  management account.
* ``trail`` (member profiles): CloudTrail of each member account shows the ``AssumeRole`` on
  the spoke role with the ``SourceIdentity`` of this run and a session policy. Events take up
  to 15 minutes to appear.

The installation is read from AWS, not from a file: the organization from Organizations, the
targets and exclusions from the parameters of the ``Mango-<ns>-OrgAccess`` stack, and the Mango
account from ``--profile``. ``--templates`` is the directory with the templates of the installed
release (``OrgAccess.template.json`` and ``Member.template.json``), so the deployed ones can be
compared; without it the script looks in ``infra/cdk.out``.

Run:
  uv run --no-project --python 3.13 --with boto3 python tests/e2e/member_access.py \
    --namespace <ns> --profile <mango account> --admin-profile <management account> \
    --templates <release templates dir> \
    --member-profile <account>=<profile> --member-profile <account>=<profile>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import ClientError

STEPS = ("org", "stackset", "broker", "roles", "chain", "trail")
STS_ACTIONS = ["sts:AssumeRole", "sts:SetSourceIdentity", "sts:TagSession"]
SESSION_TAG_KEYS = ["mango_user", "mango_agent", "mango_bu"]
PROBE_CHECKS = ["read_broker", "member_role", "account", "source_identity_required"]
DENIED = {"AccessDenied", "AccessDeniedException"}
TRAIL_POLL_S = 60
REPO_ROOT = Path(__file__).resolve().parents[2]


class CheckFailedError(Exception):
    """A step did not find what the design says; the run stops and reports it."""


@dataclass
class Report:
    steps: list[dict[str, Any]] = field(default_factory=list)

    def ok(self, step: str, **detail: Any) -> None:
        self.steps.append({"step": step, "ok": True, **detail})
        print(json.dumps(self.steps[-1], ensure_ascii=False), flush=True)

    def fail(self, step: str, **detail: Any) -> CheckFailedError:
        self.steps.append({"step": step, "ok": False, **detail})
        print(json.dumps(self.steps[-1], ensure_ascii=False), flush=True)
        return CheckFailedError(step)


@dataclass
class Run:
    report: Report
    args: argparse.Namespace
    config: dict[str, Any]
    #: `SourceIdentity` of this run: what CloudTrail of the member accounts must show.
    actor: str
    started: datetime
    expected: list[str] = field(default_factory=list)

    @property
    def namespace(self) -> str:
        return str(self.config["namespace"])

    @property
    def mango_account(self) -> str:
        return str(self.config["mangoAccountId"])

    @property
    def organization(self) -> str:
        return str(self.config["organizationId"])

    @property
    def spoke_role(self) -> str:
        return f"Mango-{self.namespace}-ReadOnly"

    @property
    def broker_role(self) -> str:
        return f"Mango-{self.namespace}-ReadBroker"

    @property
    def broker_arn(self) -> str:
        return f"arn:aws:iam::{self.mango_account}:role/{self.broker_role}"

    def session(self, profile: str) -> boto3.Session:
        return boto3.Session(profile_name=profile, region_name=str(self.config["region"]))

    def member_sessions(self) -> dict[str, boto3.Session]:
        return {account: self.session(profile) for account, profile in self.args.member_profile}


def _listed(value: Any) -> list[Any]:
    return value if isinstance(value, list) else [value]


def _conditions(statement: dict[str, Any]) -> dict[str, Any]:
    return dict(statement.get("Condition") or {})


# --- org -----------------------------------------------------------------------------------


def accounts_under(org: Any, parent: str) -> list[str]:
    """Active accounts under a root or OU, child OUs included."""
    found = [
        account["Id"]
        for page in org.get_paginator("list_accounts_for_parent").paginate(ParentId=parent)
        for account in page["Accounts"]
        if account["Status"] == "ACTIVE"
    ]
    children = org.get_paginator("list_organizational_units_for_parent").paginate(ParentId=parent)
    for page in children:
        for unit in page["OrganizationalUnits"]:
            found += accounts_under(org, unit["Id"])
    return found


def expected_accounts(run: Run) -> None:
    access = run.config.get("orgAccess")
    if not access:
        raise run.report.fail("org", reason="orgAccess is not configured")
    org = run.session(run.args.admin_profile).client("organizations")
    management = org.describe_organization()["Organization"]["MasterAccountId"]
    excluded = {*access.get("excludedAccountIds", []), management}
    under = {account for target in access["targets"] for account in accounts_under(org, target)}
    run.expected = sorted(under - excluded)
    facts = {
        "targets": access["targets"],
        "excluded": sorted(excluded),
        "expected_accounts": run.expected,
        "mango_account_is_a_target": run.mango_account in run.expected,
    }
    if not run.expected or management != run.config["managementAccountId"]:
        raise run.report.fail("org", **facts)
    run.report.ok("org", **facts)


# --- stackset ------------------------------------------------------------------------------


def _local_template_sha256(templates: Path) -> str | None:
    """sha256 of the spoke template of the release, as the StackSet carries it."""
    path = templates / "OrgAccess.template.json"
    if not path.exists():
        return None
    outputs = json.loads(path.read_text())["Outputs"]
    return str(outputs["MemberTemplateSha256"]["Value"])


def check_stack_set(run: Run) -> None:
    report, access = run.report, run.config["orgAccess"]
    delegated = (
        access.get("adminAccountId", run.config["managementAccountId"])
        != (run.config["managementAccountId"])
    )
    call_as = "DELEGATED_ADMIN" if delegated else "SELF"
    cfn = run.session(run.args.admin_profile).client("cloudformation")
    name = f"Mango-{run.namespace}-Member"
    stack_set = cfn.describe_stack_set(StackSetName=name, CallAs=call_as)["StackSet"]
    deployed = hashlib.sha256(stack_set["TemplateBody"].encode()).hexdigest()
    local = _local_template_sha256(run.args.templates)
    facts = {
        "status": stack_set["Status"],
        "permission_model": stack_set["PermissionModel"],
        "auto_deployment": stack_set.get("AutoDeployment"),
        "capabilities": stack_set.get("Capabilities"),
        "targets": stack_set.get("OrganizationalUnitIds"),
        "template_sha256": deployed,
        "matches_this_release": None if local is None else deployed == local,
    }
    good = (
        facts["status"] == "ACTIVE"
        and facts["permission_model"] == "SERVICE_MANAGED"
        # The API may add keys (e.g. ``DependsOn``); only these two decide the behaviour.
        and (facts["auto_deployment"] or {}).get("Enabled") is True
        and (facts["auto_deployment"] or {}).get("RetainStacksOnAccountRemoval") is False
        and facts["matches_this_release"] is not False
    )
    if not good:
        raise report.fail("stackset", **facts)
    report.ok("stackset", **facts)

    instances = [
        instance
        for page in cfn.get_paginator("list_stack_instances").paginate(
            StackSetName=name, CallAs=call_as
        )
        for instance in page["Summaries"]
    ]
    states = {
        i["Account"]: (i["Region"], i["Status"], i["StackInstanceStatus"]["DetailedStatus"])
        for i in instances
    }
    current = (run.config["region"], "CURRENT", "SUCCEEDED")
    facts = {
        "instances": {account: "/".join(state) for account, state in sorted(states.items())},
        "missing": sorted(set(run.expected) - set(states)),
        "unexpected": sorted(set(states) - set(run.expected)),
        "not_current": sorted(a for a, state in states.items() if state != current),
    }
    if len(instances) != len(states) or facts["missing"] or facts["unexpected"]:
        raise report.fail("stackset_instances", **facts)
    if facts["not_current"]:
        raise report.fail("stackset_instances", **facts)
    report.ok("stackset_instances", **facts)


# --- broker and spoke roles ----------------------------------------------------------------


def _inline_statements(iam: Any, role_name: str) -> list[dict[str, Any]]:
    return [
        statement
        for name in iam.list_role_policies(RoleName=role_name)["PolicyNames"]
        for statement in _listed(
            iam.get_role_policy(RoleName=role_name, PolicyName=name)["PolicyDocument"]["Statement"]
        )
    ]


def _trust_facts(role: dict[str, Any]) -> dict[str, Any]:
    trust = _listed(role["AssumeRolePolicyDocument"]["Statement"])
    assume = [s for s in trust if "sts:AssumeRole" in _listed(s["Action"])]
    tagging = [s for s in trust if "sts:TagSession" in _listed(s["Action"])]
    return {
        "actions": sorted({a for s in trust for a in _listed(s["Action"])}),
        "effects": sorted({s["Effect"] for s in trust}),
        "principals": sorted({json.dumps(s.get("Principal"), sort_keys=True) for s in trust}),
        "callers": sorted(
            {
                arn
                for s in trust
                for arn in _listed(_conditions(s).get("ArnEquals", {}).get("aws:PrincipalArn", []))
            }
        ),
        "every_statement_names_callers": all(
            _conditions(s).get("ArnEquals", {}).get("aws:PrincipalArn") for s in trust
        ),
        "organizations": sorted(
            {str(_conditions(s).get("StringEquals", {}).get("aws:PrincipalOrgID")) for s in trust}
        ),
        "source_identity_required": bool(assume)
        and all(
            _conditions(s).get("Null", {}).get("sts:SourceIdentity") == "false" for s in assume
        ),
        "tag_keys": sorted(
            {
                key
                for s in tagging
                for key in _listed(
                    _conditions(s).get("ForAllValues:StringEquals", {}).get("aws:TagKeys", [])
                )
            }
        ),
        "max_session_seconds": role["MaxSessionDuration"],
    }


def _trust_is_closed(run: Run, facts: dict[str, Any], callers: list[str] | None) -> bool:
    root = json.dumps({"AWS": f"arn:aws:iam::{run.mango_account}:root"}, sort_keys=True)
    return bool(
        facts["actions"] == STS_ACTIONS
        and facts["effects"] == ["Allow"]
        and facts["principals"] == [root]
        and facts["every_statement_names_callers"]
        and not any("*" in arn for arn in facts["callers"])
        and (callers is None or facts["callers"] == callers)
        and facts["organizations"] == [run.organization]
        and facts["source_identity_required"]
        and facts["tag_keys"] == sorted(SESSION_TAG_KEYS)
    )


def check_broker(run: Run) -> None:
    iam = run.session(run.args.profile).client("iam")
    role = iam.get_role(RoleName=run.broker_role)["Role"]
    statements = _inline_statements(iam, run.broker_role)
    spoke = f"arn:aws:iam::*:role/{run.spoke_role}"
    assume = [s for s in statements if "sts:AssumeRole" in _listed(s["Action"])]
    facts = {
        **_trust_facts(role),
        "managed_policies": len(
            iam.list_attached_role_policies(RoleName=run.broker_role)["AttachedPolicies"]
        ),
        "actions_allowed": sorted({a for s in statements for a in _listed(s["Action"])}),
        "resources": sorted({str(r) for s in statements for r in _listed(s["Resource"])}),
        "assume_only_in_organization": bool(assume)
        and all(
            _conditions(s).get("StringEquals", {}).get("aws:ResourceOrgID") == run.organization
            for s in assume
        ),
    }
    in_account = f"arn:aws:iam::{run.mango_account}:role/Mango-{run.namespace}-"
    good = (
        _trust_is_closed(run, facts, None)
        and all(arn.startswith(in_account) for arn in facts["callers"])
        and f"{in_account}AdminProbe" in facts["callers"]
        and facts["managed_policies"] == 0
        and facts["actions_allowed"] == STS_ACTIONS
        and facts["resources"] == [spoke]
        and facts["assume_only_in_organization"]
    )
    if not good:
        raise run.report.fail("broker", **facts)
    run.report.ok("broker", **facts)


def release_data_actions(templates: Path) -> list[str]:
    """Data actions of the spoke role in the template of the release."""
    path = templates / "Member.template.json"
    if not path.exists():
        return []
    resources = json.loads(path.read_text())["Resources"].values()
    return sorted(
        {
            action
            for resource in resources
            if resource["Type"] == "AWS::IAM::Policy"
            for statement in resource["Properties"]["PolicyDocument"]["Statement"]
            for action in _listed(statement["Action"])
        }
    )


def check_roles(run: Run) -> None:
    sessions = run.member_sessions()
    unknown = sorted(set(sessions) - set(run.expected))
    if unknown:
        raise run.report.fail(
            "roles", reason="profile for an account that is no target", accounts=unknown
        )
    allowed = release_data_actions(run.args.templates)
    for account in run.expected:
        if account not in sessions:
            run.report.ok("role", account=account, checked=False, reason="no --member-profile")
            continue
        session = sessions[account]
        actual = session.client("sts").get_caller_identity()["Account"]
        if actual != account:
            raise run.report.fail("role", account=account, profile_account=actual)
        iam = session.client("iam")
        role = iam.get_role(RoleName=run.spoke_role)["Role"]
        statements = _inline_statements(iam, run.spoke_role)
        facts = {
            "account": account,
            "checked": True,
            **_trust_facts(role),
            "managed_policies": len(
                iam.list_attached_role_policies(RoleName=run.spoke_role)["AttachedPolicies"]
            ),
            "actions_allowed": sorted({a for s in statements for a in _listed(s["Action"])}),
            "permissions_boundary": (role.get("PermissionsBoundary") or {}).get(
                "PermissionsBoundaryArn"
            ),
        }
        good = (
            _trust_is_closed(run, facts, [run.broker_arn])
            and facts["managed_policies"] == 0
            and facts["actions_allowed"] == allowed
            and facts["max_session_seconds"] == 3600
        )
        if not good:
            raise run.report.fail("role", **facts)
        run.report.ok("role", **facts)


# --- chain ---------------------------------------------------------------------------------


def probe(run: Run, account: str) -> list[dict[str, str]]:
    function = f"Mango-{run.namespace}-AdminProbe"
    payload = {"operation": "member_access", "actor": run.actor, "account_id": account}
    response = (
        run.session(run.args.profile)
        .client("lambda")
        .invoke(FunctionName=function, Payload=json.dumps(payload).encode())
    )
    body = json.loads(response["Payload"].read())
    if response.get("FunctionError") or "checks" not in body:
        raise run.report.fail("chain", account=account, error=body.get("error", "function_error"))
    return list(body["checks"])


def _refused(sts: Any, role_arn: str, **extra: Any) -> str:
    """``refused`` when STS denies the assumption; anything else is what happened instead."""
    try:
        sts.assume_role(RoleArn=role_arn, RoleSessionName="mango-e2e-refused", **extra)
    except ClientError as exc:
        code = str(exc.response["Error"]["Code"])
        return "refused" if code in DENIED else code
    return "ASSUMED"


def check_chain(run: Run) -> None:
    report = run.report
    for account in run.expected:
        checks = probe(run, account)
        facts = {"account": account, "checks": {c["name"]: c["detail"] for c in checks}}
        if [c["name"] for c in checks] != PROBE_CHECKS or any(c["status"] != "ok" for c in checks):
            raise report.fail("chain", **facts)
        report.ok("chain", source_identity=run.actor, **facts)

    # Outside the targets there is no role to reach: the management account never gets one.
    outside = str(run.config["managementAccountId"])
    checks = probe(run, outside)
    states = {c["name"]: (c["status"], c["detail"]) for c in checks}
    facts = {"account": outside, "checks": {name: detail for name, (_, detail) in states.items()}}
    if states.get("read_broker", ("", ""))[0] != "ok" or states.get("member_role") != (
        "error",
        "access denied",
    ):
        raise report.fail("chain_outside_targets", **facts)
    report.ok("chain_outside_targets", **facts)

    # The operator holds administrator credentials of the Mango account and is still nobody
    # to these roles: only the principals the broker names, and only the broker, get in.
    sts = run.session(run.args.profile).client("sts")
    operator = sts.get_caller_identity()["Arn"]
    attempts = {"broker": _refused(sts, run.broker_arn, SourceIdentity=run.actor)}
    for account in run.expected:
        spoke = f"arn:aws:iam::{account}:role/{run.spoke_role}"
        attempts[f"spoke_{account}"] = _refused(sts, spoke, SourceIdentity=run.actor)
        attempts[f"spoke_{account}_unattributed"] = _refused(sts, spoke)
    facts = {"operator": operator.split("/")[-2] if "/" in operator else operator, **attempts}
    if any(outcome != "refused" for outcome in attempts.values()):
        raise report.fail("chain_direct_access", **facts)
    report.ok("chain_direct_access", **facts)


# --- trail ---------------------------------------------------------------------------------


def assumed_for(trail: Any, role_name: str, since: datetime) -> list[dict[str, Any]]:
    """``AssumeRole`` events on ``role_name`` since ``since``: who they were made for."""
    found = []
    pages = trail.get_paginator("lookup_events").paginate(
        LookupAttributes=[{"AttributeKey": "EventName", "AttributeValue": "AssumeRole"}],
        StartTime=since,
    )
    for page in pages:
        for entry in page["Events"]:
            event = json.loads(entry["CloudTrailEvent"])
            request = event.get("requestParameters") or {}
            if not str(request.get("roleArn", "")).endswith(f":role/{role_name}"):
                continue
            identity = event.get("userIdentity") or {}
            found.append(
                {
                    "source_identity": request.get("sourceIdentity"),
                    "caller_account": identity.get("accountId"),
                    "session_policy": "policy" in request,
                    "error": event.get("errorCode"),
                }
            )
    return found


def check_trail(run: Run) -> None:
    sessions = run.member_sessions()
    pending = {account for account in run.expected if account in sessions}
    for account in sorted(set(run.expected) - pending):
        run.report.ok("trail", account=account, checked=False, reason="no --member-profile")
    since = run.started - timedelta(minutes=1)
    deadline = time.monotonic() + run.args.trail_wait
    while pending:
        for account in sorted(pending):
            events = assumed_for(sessions[account].client("cloudtrail"), run.spoke_role, since)
            # A successful assumption that names nobody would break rule 5.
            anonymous = [e for e in events if not e["error"] and not e["source_identity"]]
            if anonymous:
                raise run.report.fail(
                    "trail", account=account, without_source_identity=len(anonymous)
                )
            mine = [e for e in events if e["source_identity"] == run.actor and not e["error"]]
            if not mine:
                continue
            facts = {
                "account": account,
                "source_identity": run.actor,
                "events": len(mine),
                "caller_accounts": sorted({str(e["caller_account"]) for e in mine}),
                "session_policy": all(e["session_policy"] for e in mine),
            }
            if facts["caller_accounts"] != [run.mango_account] or not facts["session_policy"]:
                raise run.report.fail("trail", **facts)
            run.report.ok("trail", **facts)
            pending.discard(account)
        if pending and time.monotonic() > deadline:
            raise run.report.fail("trail", reason="no event yet", accounts=sorted(pending))
        if pending:
            time.sleep(TRAIL_POLL_S)


# --- main ----------------------------------------------------------------------------------


def _member_profile(value: str) -> tuple[str, str]:
    account, _, profile = value.partition("=")
    if not re.fullmatch(r"\d{12}", account) or not profile:
        raise argparse.ArgumentTypeError("expected <12-digit account>=<profile>")
    return account, profile


def execute(run: Run) -> None:
    steps = {
        "stackset": check_stack_set,
        "broker": check_broker,
        "roles": check_roles,
        "chain": check_chain,
        "trail": check_trail,
    }
    # Every step needs to know which accounts are targets.
    expected_accounts(run)
    for name in STEPS[1:]:
        if name in run.args.steps:
            steps[name](run)


def _parameter_list(parameters: dict[str, str], key: str) -> list[str]:
    return [value.strip() for value in parameters.get(key, "").split(",") if value.strip()]


def load_installation(args: argparse.Namespace) -> dict[str, Any]:
    """The installation as AWS has it: nothing about it is written in the repository."""
    mango = boto3.Session(profile_name=args.profile, region_name=args.region)
    admin = boto3.Session(profile_name=args.admin_profile, region_name=args.region)
    organization = admin.client("organizations").describe_organization()["Organization"]
    stack = admin.client("cloudformation").describe_stacks(
        StackName=f"Mango-{args.namespace}-OrgAccess"
    )["Stacks"][0]
    parameters = {p["ParameterKey"]: p["ParameterValue"] for p in stack.get("Parameters", [])}
    return {
        "namespace": args.namespace,
        "region": args.region,
        "mangoAccountId": mango.client("sts").get_caller_identity()["Account"],
        "managementAccountId": organization["MasterAccountId"],
        "organizationId": organization["Id"],
        "orgAccess": {
            "targets": _parameter_list(parameters, "Targets"),
            "excludedAccountIds": _parameter_list(parameters, "ExcludedAccountIds"),
            "adminAccountId": admin.client("sts").get_caller_identity()["Account"],
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--namespace", required=True, help="namespace of the installation")
    parser.add_argument("--region", default="us-east-1", help="Region of the installation")
    parser.add_argument(
        "--templates",
        type=Path,
        default=REPO_ROOT / "infra/cdk.out",
        help="directory with the templates of the installed release",
    )
    parser.add_argument("--profile", required=True, help="AWS profile of the Mango account")
    parser.add_argument(
        "--admin-profile",
        required=True,
        help="AWS profile of the account that owns the StackSet (management or delegated admin)",
    )
    parser.add_argument(
        "--member-profile",
        action="append",
        default=[],
        type=_member_profile,
        metavar="ACCOUNT=PROFILE",
        help="AWS profile of a member account (steps roles and trail); repeat per account",
    )
    parser.add_argument("--steps", default=",".join(STEPS), help=f"any of: {', '.join(STEPS)}")
    parser.add_argument("--trail-wait", type=int, default=1200, help="seconds to wait for events")
    args = parser.parse_args()
    args.steps = [step for step in args.steps.split(",") if step]
    unknown = sorted(set(args.steps) - set(STEPS))
    if unknown:
        parser.error(f"unknown steps: {', '.join(unknown)}")

    report = Report()
    try:
        run = Run(
            report=report,
            args=args,
            config=load_installation(args),
            actor=f"e2e-member-{secrets.token_hex(6)}",
            started=datetime.now(UTC),
        )
        execute(run)
    except CheckFailedError:
        sys.exit(1)
    except ClientError as exc:
        # Something that should exist does not (nothing deployed yet), or cannot be read.
        error = exc.response["Error"]
        report.fail("aws", operation=exc.operation_name, code=error["Code"])
        sys.exit(1)
    print(json.dumps({"result": "ok", "steps": len(report.steps)}))


if __name__ == "__main__":
    main()
