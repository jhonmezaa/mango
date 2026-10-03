"""End-to-end test of a pack over the member accounts (``central_only``, ``identity.chain:
member``, D51) against a deployed lab installation. The CloudWatch pack (``aws-cloudwatch``)
by default.

Two administrators enable the pack. An agent with its tools is published for a central
group; a central user asks for the alarms and a metric of each member account given, and the
answers come from the pack, which read CloudWatch **in that account, as that user**, through
``Mango-<ns>-ReadBroker`` and ``Mango-<ns>-ReadOnly``. The same question for the Mango account
and for an account that is no target is refused by the pack. An area lead gets nothing: no
agent, no tool through the Gateway, and no agent of an area group may carry these tools.
CloudTrail of each member account then shows the central user as ``SourceIdentity`` of the
session that read the data, with a session policy, and never the area lead.

Uses only lab e2e users (config ``e2e: true``) and reuses ``account_data_pack.py`` and
``packs.py``. It **creates real resources**: the pack's role, Runtime, Gateway target and
policies, and the role and harness of the test agent. ``cleanup`` retires the agent and leaves
the pack as it was before the run. It changes nothing in the member accounts.

Needs, deployed first (see the PR): Core with the signed pack of this release, and the
``OrgAccess`` stack with the member template of this release (the role's read actions).

``--steps`` picks what to run, in this order:

* ``enable``: request by one administrator, approval by the other, installation.
* ``aws`` (read only, operator credentials): Runtime, target, Cedar policies (central users
  only), a pack role that can only assume the Read broker, the Read broker trust naming that
  role and the Billing broker trust not naming it, a Runtime environment with the role *name*
  and no ARN, the listed schemas (``account_id`` required, no ``profile_name``) and the
  Runtime refusing a ``tools/call`` no interceptor vouched for. With member profiles, the
  role of each member account holds exactly the read actions of this release.
* ``agent``: an agent with the pack's tools for a central group, approved and published.
* ``central``: for each ``--member-profile`` account, a turn that lists its active alarms and
  one that reads a metric; both tools must complete. Then the Mango account and
  ``--outside-account`` (an account of the organization without the role, e.g. management):
  the tool is called and answers the refusal.
* ``area`` (needs ``--area-user``): as in ``account_data_pack.py``.
* ``trail`` (member profiles): CloudTrail of each member account has an ``AssumeRole`` on
  ``Mango-<ns>-ReadOnly`` made by the Read broker for the central user after this run
  started, with a session policy, and none for the area lead; CloudTrail of the Mango account
  has the pack role assuming the broker for the same person. Events take up to 15 minutes.
* ``cleanup``.

Run:
  uv run --no-project --python 3.13 --with boto3 --with pycognito --with pyotp --with httpx \
    --with ./packages/py/mango-packs \
    python tests/e2e/member_data_pack.py --profile mango-sandbox \
    --member-profile <audit account>=mango-audit \
    --member-profile <log archive account>=mango-logarchive \
    --outside-account <management account> \
    --secrets <path> --requester <central admin> --approver <another admin> \
    --area-user <bu-lead email>
"""

from __future__ import annotations

import argparse
import json
import re
import secrets
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import account_data_pack as adp
import boto3
from account_data_pack import Run
from botocore.exceptions import ClientError
from marketplace import Api, CheckFailedError, Report
from smoke import load_secrets, save_secrets, sign_in, stack_outputs

import packs

STEPS = ("enable", "aws", "agent", "central", "area", "trail", "cleanup")
REPO_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_ENVIRONMENT = re.compile(
    r"^MANGO_PACK_(ID|VERSION|STATEMENT_SHA256|BROKER_ROLE_ARN|TARGET_ROLE_NAME|REGION"
    r"|IDENTITY_PUBLIC_KEY|CONFIG_[A-Z0-9_]+)$"
)
HIDDEN_ARGUMENTS = {"profile_name", "account_identifiers", "include_linked_accounts", "_mango_ctx"}
REFUSED = adp.REFUSED
ATTEMPTS = 2
ALARMS_TOOL = "get_active_alarms"
LOG_CONTENT_ACTIONS = {
    "logs:StartQuery",
    "logs:GetQueryResults",
    "logs:GetLogEvents",
    "logs:FilterLogEvents",
}
METRICS_TOOL = "get_metric_data"


def alarms_question(account: str, region: str) -> str:
    return (
        f"Usa la herramienta {ALARMS_TOOL} con account_id {account} y region {region}. "
        "Dime cuántas alarmas activas devuelve."
    )


def metrics_question(account: str, region: str) -> str:
    return (
        f"Usa la herramienta {METRICS_TOOL} con account_id {account}, region {region}, "
        "namespace AWS/Usage, metric_name CallCount, statistic Sum y las últimas 3 horas. "
        "Dime cuántos puntos de datos devuelve."
    )


# --- AWS, read only -----------------------------------------------------------------------


def _listed(value: Any) -> list[Any]:
    return value if isinstance(value, list) else [value]


def _role_names(namespace: str) -> tuple[str, str, str]:
    return (
        f"Mango-{namespace}-ReadBroker",
        f"Mango-{namespace}-ReadOnly",
        f"Mango-{namespace}-BillingBroker",
    )


def check_role(report: Report, iam: Any, namespace: str, pack_id: str) -> str:
    """The pack role holds no data action: all it can do is assume the Read broker."""
    role_name = f"Mango-{namespace}-mcp-{pack_id}"
    role = iam.get_role(RoleName=role_name)["Role"]
    boundary = (role.get("PermissionsBoundary") or {}).get("PermissionsBoundaryArn", "")
    attached = iam.list_attached_role_policies(RoleName=role_name)["AttachedPolicies"]
    statements = [
        statement
        for name in iam.list_role_policies(RoleName=role_name)["PolicyNames"]
        for statement in iam.get_role_policy(RoleName=role_name, PolicyName=name)["PolicyDocument"][
            "Statement"
        ]
    ]
    # The runtime's own logs, traces and metrics (PutMetricData only: no read of CloudWatch).
    own = {
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams",
        "xray:PutTraceSegments",
        "xray:PutTelemetryRecords",
        "cloudwatch:PutMetricData",
    }
    other = [s for s in statements if any(a not in own for a in _listed(s["Action"]))]
    broker = f"arn:aws:iam::{role['Arn'].split(':')[4]}:role/{_role_names(namespace)[0]}"
    facts = {
        "role": role_name,
        "boundary": boundary.rsplit("/", 1)[-1],
        "managed_policies": len(attached),
        "other_actions": sorted({a for s in other for a in _listed(s["Action"])}),
        "other_resources": sorted({str(r) for s in other for r in _listed(s["Resource"])}),
    }
    good = (
        facts["boundary"] == f"Mango-{namespace}-mcp-boundary"
        and not attached
        and facts["other_actions"] == adp.BROKER_ACTIONS
        and facts["other_resources"] == [broker]
    )
    if not good:
        raise report.fail("aws_role", **facts)
    report.ok("aws_role", **facts)
    return str(role["Arn"])


def _callers(role: dict[str, Any]) -> list[list[str]]:
    return [
        _listed((s.get("Condition", {}).get("ArnEquals") or {}).get("aws:PrincipalArn", []))
        for s in role["AssumeRolePolicyDocument"]["Statement"]
    ]


def check_broker_trusts(report: Report, iam: Any, namespace: str, pack_role: str) -> None:
    """The Read broker names the pack role in every statement of its trust, with no wildcard;
    the Billing broker does not know it."""
    read_broker, _, billing_broker = _role_names(namespace)
    read = iam.get_role(RoleName=read_broker)["Role"]
    callers = _callers(read)
    billing = [
        arn for arns in _callers(iam.get_role(RoleName=billing_broker)["Role"]) for arn in arns
    ]
    trust = read["AssumeRolePolicyDocument"]["Statement"]
    facts = {
        "statements": len(trust),
        "callers": sorted({arn.rsplit("/", 1)[-1] for arns in callers for arn in arns}),
        "source_identity_required": any(
            (s.get("Condition", {}).get("Null") or {}).get("sts:SourceIdentity") == "false"
            for s in trust
        ),
        "in_billing_broker_trust": pack_role in billing,
    }
    good = (
        all(pack_role in arns for arns in callers)
        and not any("*" in arn for arns in callers for arn in arns)
        and facts["source_identity_required"]
        and not facts["in_billing_broker_trust"]
    )
    if not good:
        raise report.fail("aws_broker_trust", **facts)
    report.ok("aws_broker_trust", **facts)


def check_environment(report: Report, runtime: dict[str, Any], namespace: str) -> None:
    """The Read broker, the *name* of the member role and the key that verifies callers."""
    environment = runtime.get("environmentVariables") or {}
    names = sorted(name for name in environment if name.startswith("MANGO_"))
    read_broker, member_role, _ = _role_names(namespace)
    facts = {
        "names": names,
        "broker": str(environment.get("MANGO_PACK_BROKER_ROLE_ARN", "")).rsplit("/", 1)[-1],
        "target_role_name": environment.get("MANGO_PACK_TARGET_ROLE_NAME"),
        "target_role_arn_set": "MANGO_PACK_TARGET_ROLE_ARN" in environment,
    }
    good = (
        all(RUNTIME_ENVIRONMENT.fullmatch(name) for name in names)
        and facts["broker"] == read_broker
        and facts["target_role_name"] == member_role
        and not facts["target_role_arn_set"]
        and "MANGO_PACK_IDENTITY_PUBLIC_KEY" in environment
    )
    if not good:
        raise report.fail("aws_runtime_environment", **facts)
    report.ok("aws_runtime_environment", **facts)


def check_schemas(report: Report, served: list[dict[str, Any]]) -> None:
    """What the Gateway validates against: the account is mandatory, the Region is bounded
    and the arguments the entry point hides are not there."""
    bad = []
    for tool in served:
        schema = tool.get("inputSchema") or {}
        properties = schema.get("properties") or {}
        account = properties.get("account_id") or {}
        region = json.dumps(properties.get("region") or {})
        if (
            account.get("pattern") != "^[0-9]{12}$"
            or "account_id" not in (schema.get("required") or [])
            or HIDDEN_ARGUMENTS & set(properties)
            or schema.get("additionalProperties") is False
            or ("region" in properties and '"pattern"' not in region)
        ):
            bad.append(tool["name"])
    if bad:
        raise report.fail("aws_tool_schemas", tools=bad)
    report.ok("aws_tool_schemas", tools=len(served))


def release_member_actions() -> list[str]:
    """Read actions of the member role in the template this checkout synthesized."""
    path = REPO_ROOT / "infra/cdk.out/Member.template.json"
    if not path.exists():
        return []
    return sorted(
        {
            action
            for resource in json.loads(path.read_text())["Resources"].values()
            if resource["Type"] == "AWS::IAM::Policy"
            for statement in resource["Properties"]["PolicyDocument"]["Statement"]
            for action in _listed(statement["Action"])
        }
    )


def check_member_roles(run: Run, item: dict[str, Any]) -> None:
    """Each member account's role allows exactly this release's read actions, which cover
    what the pack's manifest asks for, and nothing that reads log content."""
    report, namespace = run.report, run.args.namespace
    expected = release_member_actions()
    for account, profile in run.args.member_profile:
        session = boto3.Session(profile_name=profile, region_name="us-east-1")
        actual = session.client("sts").get_caller_identity()["Account"]
        if actual != account:
            raise report.fail("member_role", account=account, profile_account=actual)
        iam = session.client("iam")
        role_name = _role_names(namespace)[1]
        statements = [
            statement
            for name in iam.list_role_policies(RoleName=role_name)["PolicyNames"]
            for statement in iam.get_role_policy(RoleName=role_name, PolicyName=name)[
                "PolicyDocument"
            ]["Statement"]
        ]
        actions = sorted({a for s in statements for a in _listed(s["Action"])})
        facts = {
            "account": account,
            "actions": actions,
            "managed_policies": len(
                iam.list_attached_role_policies(RoleName=role_name)["AttachedPolicies"]
            ),
            "matches_release": not expected or actions == expected,
            "reads_log_content": bool(LOG_CONTENT_ACTIONS & set(actions)),
        }
        good = (
            actions
            and facts["managed_policies"] == 0
            and facts["matches_release"]
            and not facts["reads_log_content"]
            and all(re.fullmatch(r"(cloudwatch|logs):(Get|List|Describe)\w+", a) for a in actions)
        )
        if not good:
            raise report.fail("member_role", pack=item["id"], **facts)
        report.ok("member_role", **facts)


def verify_aws(run: Run, item: dict[str, Any]) -> None:
    report, session, namespace, pack_id = run.report, run.session, run.args.namespace, item["id"]
    tools = sorted(tool["name"] for tool in item["tools"])
    control = session.client("bedrock-agentcore-control")
    gateway = packs.gateway_id(run.outputs)
    runtime = packs.check_runtime(report, control, namespace, pack_id)
    packs.check_target(report, control, gateway, pack_id, runtime["agentRuntimeId"])
    adp.check_policies(report, control, gateway, namespace, pack_id, tools=tools)
    iam = session.client("iam")
    check_broker_trusts(report, iam, namespace, check_role(report, iam, namespace, pack_id))
    check_environment(report, runtime, namespace)
    adp.check_interceptor(report, session, namespace, pack_id)

    answer = packs.mcp_call(session, runtime["agentRuntimeArn"], "tools/list", {})
    served = answer["body"]["result"]["tools"]
    listing: dict[str, Any] = {"served": sorted(tool["name"] for tool in served)}
    if packs.tools_hash is not None and packs.normalize_tools is not None:
        listing["tools_hash"] = packs.tools_hash(packs.normalize_tools(served))
    if listing["served"] != tools:
        raise report.fail("aws_tools_list", **listing)
    report.ok("aws_tools_list", **listing)
    check_schemas(report, served)
    # Whoever can invoke the Runtime is not a caller, with or without an account.
    adp.check_refusals(report, session, runtime["agentRuntimeArn"], ALARMS_TOOL)
    check_member_roles(run, item)


# --- Agent and central user ---------------------------------------------------------------


def agent_definition(report: Report, creator: Api, item: dict[str, Any]) -> dict[str, Any]:
    definition = packs.agent_definition(report, creator, item)
    definition["name"] = f"E2E CloudWatch {secrets.token_hex(3)}"
    definition["description"] = (
        "Agente temporal de la prueba de packs sobre cuentas miembro. Se retira al terminar."
    )
    definition["system_prompt"] = (
        "You are a temporary end-to-end test agent of Mango. Answer in Spanish, briefly. "
        "For any question about CloudWatch alarms, metrics or log groups call the tool the "
        "question names, with exactly the account_id and region it gives, and answer only "
        "with what the tool returns. If a tool fails or refuses the call, say so and do not "
        "try another account; never answer from memory."
    )
    return definition


def _turn(run: Run, question: str, tool: str, wanted: str) -> dict[str, Any]:
    """Ask until ``tool`` ends as ``wanted`` (``completed`` or ``error``); a model may need a
    second try to follow the question to the letter."""
    assert run.agent_id is not None
    facts: dict[str, Any] = {}
    for _ in range(ATTEMPTS):
        turn = packs.chat(run.requester, run.agent_id, question, show=run.args.show)
        turn.pop("has_price", None)
        outcome = adp.tool_outcome(turn, tool)
        facts = {"tool": tool, "outcome": outcome, "expected": wanted, **turn}
        if turn.get("status") == 200 and turn.get("done") and outcome == wanted:
            facts["good"] = True
            return facts
    facts["good"] = False
    return facts


def central_turns(run: Run) -> None:
    """The central user reads each member account; the pack refuses the others."""
    report, args = run.report, run.args
    if not args.member_profile:
        raise report.fail("central", reason="--member-profile is required for this step")
    # The pack has just been installed: give the agent's first call time to reach the target.
    deadline = time.monotonic() + packs.CACHE_SETTLE_S
    failed = []
    for account, _profile in args.member_profile:
        for tool, question in (
            (ALARMS_TOOL, alarms_question(account, args.region)),
            (METRICS_TOOL, metrics_question(account, args.region)),
        ):
            facts = _turn(run, question, tool, "completed")
            while not facts["good"] and time.monotonic() < deadline:
                time.sleep(5)
                facts = _turn(run, question, tool, "completed")
            good = facts.pop("good")
            if good:
                report.ok("central_member", account=account, user=run.central_subject, **facts)
            else:
                failed.append(f"{account}:{tool}")
                report.fail("central_member", account=account, **facts)
    mango = run.session.client("sts").get_caller_identity()["Account"]
    refused = [("mango", mango)]
    if args.outside_account:
        refused.append(("outside", args.outside_account))
    for label, account in refused:
        facts = _turn(run, alarms_question(account, args.region), ALARMS_TOOL, "error")
        good = facts.pop("good")
        if good:
            report.ok("central_refused", which=label, account=account, **facts)
        else:
            failed.append(f"{label}:{account}")
            report.fail("central_refused", which=label, account=account, **facts)
    if failed:
        raise report.fail("central", failed=failed)
    report.ok("central", accounts=len(args.member_profile), refused=len(refused))


# --- CloudTrail of the member accounts ----------------------------------------------------


def check_trail(run: Run) -> None:
    """Each member account saw the central user, by name, on the session that read its data."""
    report, args = run.report, run.args
    if not args.member_profile:
        raise report.fail("trail", reason="--member-profile is required for this step")
    read_broker, member_role, _ = _role_names(args.namespace)
    since = run.started - timedelta(minutes=1)
    deadline = time.monotonic() + args.trail_wait
    mango_account = run.session.client("sts").get_caller_identity()["Account"]
    # A member account sees the broker as the Mango account plus the broker's role id.
    broker_role_id = run.session.client("iam").get_role(RoleName=read_broker)["Role"]["RoleId"]
    for account, profile in args.member_profile:
        trail = boto3.Session(profile_name=profile, region_name=args.region).client("cloudtrail")
        while True:
            events = adp.assumed_for(trail, member_role, since)
            ours = [
                e
                for e in events
                if e["source_identity"] == run.central_subject
                and e["caller_account"] == mango_account
                and e["caller_role_id"] == broker_role_id
            ]
            if ours:
                break
            if time.monotonic() > deadline:
                raise report.fail(
                    "trail_member", account=account, reason="no AssumeRole for the central user yet"
                )
            time.sleep(adp.TRAIL_POLL_S)
        facts = {
            "account": account,
            "role": member_role,
            "user": run.central_subject,
            "events": len(ours),
            "first": ours[-1],
            "session_policy": all(e["session_policy"] for e in ours),
            "errors": sorted({str(e["error"]) for e in ours if e["error"]}),
        }
        if not facts["session_policy"] or facts["errors"]:
            raise report.fail("trail_member", **facts)
        report.ok("trail_member", **facts)
        if run.area_subject is not None:
            theirs = [
                e
                for e in events
                if run.area_subject in (e["source_identity"], e["caller_source_identity"])
            ]
            if theirs:
                raise report.fail("trail_area", account=account, events=len(theirs))
            report.ok("trail_area", account=account, user=run.area_subject, events=0)

    # First hop, in the Mango account: the pack role assumed the Read broker for that person.
    try:
        first_hop = [
            e
            for e in adp.assumed_for(run.session.client("cloudtrail"), read_broker, since)
            if e["source_identity"] == run.central_subject
            and e["caller"] == f"Mango-{args.namespace}-mcp-{args.pack}"
        ]
    except ClientError as exc:
        raise report.fail("trail_mango", error=exc.response["Error"]["Code"]) from None
    if not first_hop:
        raise report.fail("trail_mango", reason="no AssumeRole of the pack role on the Read broker")
    report.ok("trail_mango", events=len(first_hop), tags=first_hop[-1]["tags"])


# --- Run ----------------------------------------------------------------------------------


def user_steps(run: Run, item: dict[str, Any]) -> None:
    """What a central user reads, what an area lead does not, and what each account saw."""
    report, steps = run.report, run.args.steps
    if "agent" in steps and run.agent_id is None:
        definition = agent_definition(report, run.requester, item)
        run.agent_id = packs.create_agent(report, run.requester, run.approver, item, definition)
    if "central" in steps:
        if run.agent_id is None:
            raise report.fail("central", reason="no agent: run the agent step or pass --agent")
        central_turns(run)
    if "area" in steps:
        if run.area is None:
            raise report.fail("area", reason="--area-user is required for this step")
        adp.area_lead(run, item)
    if "trail" in steps:
        check_trail(run)


def execute(run: Run) -> None:
    report, args = run.report, run.args
    pack_id, steps = args.pack, args.steps
    adp.require_users(run)
    item = packs.pack_item(report, run.requester, pack_id)
    if not all(tool["central_groups_only"] for tool in item["tools"]):
        raise report.fail("catalog", reason="not a pack over account data in central_only mode")
    was_enabled = item["pack"]["status"] == "enabled"
    report.ok(
        "catalog", tools=len(item["tools"]), was_enabled=was_enabled, **packs.pack_summary(item)
    )
    if args.dry_run:
        return
    if "enable" in steps:
        if was_enabled:
            report.ok("enable", skipped="already enabled")
        else:
            packs.enable(report, run.requester, run.approver, pack_id, step="enable")
    item = packs.pack_item(report, run.requester, pack_id)
    if "aws" in steps:
        try:
            verify_aws(run, item)
        except ClientError as exc:
            raise report.fail("aws", error=exc.response["Error"]["Code"]) from None
    user_steps(run, item)
    if "cleanup" in steps:
        adp.cleanup(run, was_enabled=was_enabled)


def _member_profile(value: str) -> tuple[str, str]:
    account, _, profile = value.partition("=")
    if not re.fullmatch(r"\d{12}", account) or not profile:
        raise argparse.ArgumentTypeError("expected <12-digit account>=<profile>")
    return account, profile


def _account(value: str) -> str:
    if not re.fullmatch(r"\d{12}", value):
        raise argparse.ArgumentTypeError("expected a 12-digit account id")
    return value


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True, help="AWS profile of the Mango account")
    parser.add_argument(
        "--member-profile",
        action="append",
        default=[],
        type=_member_profile,
        metavar="ACCOUNT=PROFILE",
        help="AWS profile of a member account the central user reads; repeat per account",
    )
    parser.add_argument(
        "--outside-account",
        type=_account,
        help="an account of the organization without the member role (e.g. management)",
    )
    parser.add_argument("--region", default="us-east-1", help="Region the questions name")
    parser.add_argument("--stack", required=True, help="Core stack: Mango-<ns>-Core")
    parser.add_argument("--namespace", help="default: the middle part of the stack name")
    parser.add_argument("--secrets", required=True, type=Path)
    parser.add_argument("--requester", required=True, help="a central administrator (e2e user)")
    parser.add_argument("--approver", required=True, help="another administrator (e2e user)")
    parser.add_argument("--area-user", help="an area lead who is not central (e2e user)")
    parser.add_argument("--pack", default="aws-cloudwatch")
    parser.add_argument("--steps", default=",".join(STEPS), help=f"any of: {', '.join(STEPS)}")
    parser.add_argument("--agent", help="use this published agent instead of creating one")
    parser.add_argument(
        "--since",
        help="ISO time the central turns were made at, to run `trail` alone (default: now)",
    )
    parser.add_argument("--trail-wait", type=int, default=1200, help="seconds to wait for events")
    parser.add_argument("--show", action="store_true", help="print the start of each answer")
    parser.add_argument("--keep-pack", action="store_true", help="leave the pack enabled")
    parser.add_argument("--dry-run", action="store_true", help="only read; create nothing")
    args = parser.parse_args()
    if len({args.requester, args.approver, args.area_user}) != 3:
        raise SystemExit("--requester, --approver and --area-user must be different users")
    args.steps = [step for step in args.steps.split(",") if step]
    unknown = sorted(set(args.steps) - set(STEPS))
    if unknown:
        raise SystemExit(f"unknown steps: {unknown}")
    args.namespace = args.namespace or args.stack.split("-")[1]
    # `account_data_pack.area_lead` asks the agent this; an area lead is refused before it.
    args.question = alarms_question("000000000000", args.region)
    return args


def main() -> None:
    args = _arguments()

    session = boto3.Session(profile_name=args.profile, region_name="us-east-1")
    outputs = stack_outputs(session, args.stack)
    store = load_secrets(args.secrets)
    idp = session.client("cognito-idp")
    emails = [email for email in (args.requester, args.approver, args.area_user) if email]
    try:
        tokens = {
            email: sign_in(idp, outputs["UserPoolId"], outputs["WebClientId"], email, store)
            for email in emails
        }
    finally:
        save_secrets(args.secrets, store)

    app_url = outputs["AppUrl"]
    area_token = tokens.get(args.area_user) if args.area_user else None
    report = Report()
    run = Run(
        report=report,
        requester=Api(app_url, tokens[args.requester]),
        approver=Api(app_url, tokens[args.approver]),
        area=Api(app_url, area_token) if area_token else None,
        session=session,
        outputs=outputs,
        args=args,
        central_subject=adp.subject(tokens[args.requester]),
        area_subject=adp.subject(area_token) if area_token else None,
        agent_id=args.agent,
    )
    if args.since:
        run.started = datetime.fromisoformat(args.since).astimezone(UTC)
    report.ok("run", started=run.started.isoformat(timespec="seconds"))
    try:
        execute(run)
    except CheckFailedError as failed:
        print(json.dumps({"result": "failed", "step": str(failed)}), flush=True)
        sys.exit(1)
    print(json.dumps({"result": "ok", "steps": len(report.steps)}), flush=True)


if __name__ == "__main__":
    main()
