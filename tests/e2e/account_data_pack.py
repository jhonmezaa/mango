"""End-to-end test of Marketplace v1, phase C: a pack over account data (``central_only``,
D37) against a deployed lab installation. The Billing pack (``aws-billing``) by default.

Two administrators enable the pack. An agent with its tools is published for a central
group; a central user asks about the organization's spend and the answer comes from the
pack, which read Cost Explorer in the payer account **as that user**. An area lead gets
nothing: no agent, no tool through the Gateway, and no agent of an area group may carry these
tools. CloudTrail of the payer account then shows the central user as ``SourceIdentity`` of
the session that read the data, and never the area lead.

Uses only lab e2e users (config ``e2e: true``), like ``packs.py``, whose helpers it reuses.
It **creates real resources**: the pack's role, Runtime, Gateway target and policies, and the
role and harness of the test agent. ``cleanup`` retires the agent and leaves the pack as it
was before the run (see ``docs/runbooks/poc-deploy.md``).

``--steps`` picks what to run, in this order:

* ``enable``: request by one administrator, approval by the other, installation.
* ``aws`` (read only, operator credentials): Runtime, target, Cedar policies (``permit`` and
  ``forbid`` for central users only), a pack role that can only assume the broker, the broker
  trust naming that role, a Runtime environment without secrets, and the Runtime refusing a
  ``tools/call`` that no interceptor vouched for.
* ``agent``: an agent with the pack's tools for a central group, approved and published.
* ``central``: a chat turn of a central user that calls the pack and returns figures. With
  ``--families``, one more turn per tool of the pack, each asking for that tool by name: every
  tool must run. Compute Optimizer and Cost Optimization Hub only answer once the service is
  enrolled in the payer account, which this script reads (``--payer-profile``) and never
  changes: until then their tools are expected to be called and to answer that error.
* ``area`` (needs ``--area-user``): the area lead does not see the agent, cannot chat with it
  and is refused by the Gateway; an agent of an area group with these tools is not accepted
  for review.
* ``trail`` (needs ``--payer-profile``): CloudTrail of the payer account has an ``AssumeRole``
  on the role behind the broker whose ``sourceIdentity`` is the central user, made after this
  run started, and none for the area lead. Events take up to 15 minutes to appear.
* ``cleanup``.

Run:
  uv run --no-project --python 3.13 --with boto3 --with pycognito --with pyotp --with httpx \
    --with ./packages/py/mango-packs \
    python tests/e2e/account_data_pack.py --profile mango-sandbox --payer-profile mango-mgmt \
    --secrets <path> --requester <central admin> --approver <another admin> \
    --area-user <bu-lead email>
"""

from __future__ import annotations

import argparse
import base64
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
from gateway_probe import rpc
from marketplace import Api, CheckFailedError, Report, expect
from smoke import load_secrets, save_secrets, sign_in, stack_outputs

import packs

STEPS = ("enable", "aws", "agent", "central", "area", "trail", "cleanup")
# The closed list the pack provisioner sets (`mango_provisioner.packs.runtime`).
RUNTIME_ENVIRONMENT = re.compile(
    r"^MANGO_PACK_(ID|VERSION|STATEMENT_SHA256|BROKER_ROLE_ARN|TARGET_ROLE_ARN|REGION"
    r"|IDENTITY_PUBLIC_KEY|CONFIG_[A-Z0-9_]+)$"
)
BROKER_ACTIONS = ["sts:AssumeRole", "sts:SetSourceIdentity", "sts:TagSession"]
REFUSED = "the caller could not be verified"
TRAIL_POLL_S = 60
FAMILY_ATTEMPTS = 2
# `--families`: one question per tool of the Billing pack, cheap (one page, one month) and
# naming the tool and the operation so the model has nothing to choose.
FAMILY_QUESTIONS = {
    "cost-explorer": (
        "Usa la herramienta cost-explorer con la operación getDimensionValues y la dimensión "
        "SERVICE para el mes pasado. Dime cuántos servicios devuelve y nombra tres."
    ),
    "cost-anomaly": (
        "Usa la herramienta cost-anomaly para los últimos 30 días y dime cuántas anomalías "
        "de costo devuelve."
    ),
    # Coverage answers in an organization without Savings Plans; the two utilization
    # operations answer DataUnavailableException there, which the tool reports as an error.
    "sp-performance": (
        "Usa la herramienta sp-performance con la operación get_savings_plans_coverage para "
        "el mes pasado, con granularidad MONTHLY, y dime el porcentaje de cobertura."
    ),
    "ri-performance": (
        "Usa la herramienta ri-performance con la operación get_reservation_utilization para "
        "el mes pasado, con granularidad MONTHLY, y dime el porcentaje de utilización."
    ),
    "cost-comparison": (
        "Usa la herramienta cost-comparison con la operación getCostAndUsageComparisons y la "
        "métrica UnblendedCost para comparar el mes pasado con el anterior. Dime la diferencia."
    ),
    "budgets": "Usa la herramienta budgets y dime cuántos presupuestos de AWS Budgets hay.",
    "budget-notifications": (
        "Usa la herramienta budget-notifications sin nombre de presupuesto y dime cuántas "
        "alertas configuradas devuelve."
    ),
    "compute-optimizer": (
        "Usa la herramienta compute-optimizer con la operación get_idle_recommendations y "
        "dime cuántas recomendaciones devuelve."
    ),
    "cost-optimization": (
        "Usa la herramienta cost-optimization con la operación list_recommendation_summaries "
        "agrupando por ResourceType y dime el ahorro mensual estimado."
    ),
}
# Tools of a service that someone must enroll in the payer account first.
OPT_IN_TOOLS = ("compute-optimizer", "cost-optimization")


def claims(token: str) -> dict[str, Any]:
    """Claims of an access token Cognito just issued to this script (not verified here)."""
    payload = token.split(".")[1]
    return dict(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))))


def subject(token: str) -> str:
    return str(claims(token)["sub"])


# --- AWS, read only -----------------------------------------------------------------------


def check_policies(
    report: Report, control: Any, gateway: str, namespace: str, pack_id: str, *, tools: list[str]
) -> None:
    """Every statement is limited to central users, and each ``permit`` has its ``forbid``."""
    engine = control.get_gateway(gatewayIdentifier=gateway).get("policyEngineConfiguration") or {}
    engine_id = str(engine.get("arn", "")).rsplit("/", 1)[-1]
    prefix = f"{packs.runtime_name(namespace, pack_id)}_"
    policies = []
    for page in control.get_paginator("list_policies").paginate(policyEngineId=engine_id):
        policies += [p for p in page["policies"] if p["name"].startswith(prefix)]
    statements = [
        str((p.get("definition", {}).get("cedar") or {}).get("statement", "")) for p in policies
    ]
    text = "\n".join(statements)
    facts = {
        "policies": sorted(p["name"] for p in policies),
        "status": sorted({p["status"] for p in policies}),
        "enforcement": engine.get("mode"),
        "permitted_tools": sorted(
            set(re.findall(rf'"{re.escape(pack_id)}___([A-Za-z0-9_-]+)"', text))
        ),
        "permit": sum(s.lstrip().startswith("permit") for s in statements),
        "forbid": sum(s.lstrip().startswith("forbid") for s in statements),
        "all_central_only": bool(statements) and all("mango_central" in s for s in statements),
    }
    good = (
        facts["status"] == ["ACTIVE"]
        and facts["enforcement"] == "ENFORCE"
        and facts["permitted_tools"] == tools
        and facts["permit"] == facts["forbid"] > 0
        and facts["all_central_only"]
    )
    if not good:
        raise report.fail("aws_policies", **facts)
    report.ok("aws_policies", **facts)


def _listed(value: Any) -> list[Any]:
    return value if isinstance(value, list) else [value]


def check_role(report: Report, iam: Any, namespace: str, pack_id: str) -> str:
    """The pack role holds no data action: all it can do is assume the broker (rule 5)."""
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
    own = {"logs", "xray", "cloudwatch"}  # the runtime's own logs, traces and metrics
    other = [s for s in statements if any(a.split(":")[0] not in own for a in _listed(s["Action"]))]
    facts = {
        "role": role_name,
        "boundary": boundary.rsplit("/", 1)[-1],
        "managed_policies": len(attached),
        "other_actions": sorted({a for s in other for a in _listed(s["Action"])}),
        "other_resources": sorted({str(r) for s in other for r in _listed(s["Resource"])}),
        "trusted": sorted(
            str(s.get("Principal", {}).get("Service"))
            for s in role["AssumeRolePolicyDocument"]["Statement"]
        ),
    }
    broker = f"arn:aws:iam::{role['Arn'].split(':')[4]}:role/Mango-{namespace}-BillingBroker"
    good = (
        facts["boundary"] == f"Mango-{namespace}-mcp-boundary"
        and not attached
        and facts["other_actions"] == BROKER_ACTIONS
        and facts["other_resources"] == [broker]
        and facts["trusted"] == ["bedrock-agentcore.amazonaws.com"]
    )
    if not good:
        raise report.fail("aws_role", **facts)
    report.ok("aws_role", **facts)
    return str(role["Arn"])


def check_broker_trust(report: Report, iam: Any, namespace: str, pack_role: str) -> None:
    """The broker names the pack role in every statement of its trust, with no wildcard."""
    broker = iam.get_role(RoleName=f"Mango-{namespace}-BillingBroker")["Role"]
    trust = broker["AssumeRolePolicyDocument"]["Statement"]
    callers = [
        _listed((s.get("Condition", {}).get("ArnEquals") or {}).get("aws:PrincipalArn", []))
        for s in trust
    ]
    facts = {
        "statements": len(trust),
        "callers": sorted({arn.rsplit("/", 1)[-1] for arns in callers for arn in arns}),
        "source_identity_required": any(
            (s.get("Condition", {}).get("Null") or {}).get("sts:SourceIdentity") == "false"
            for s in trust
        ),
    }
    good = (
        all(pack_role in arns for arns in callers)
        and not any("*" in arn for arns in callers for arn in arns)
        and facts["source_identity_required"]
    )
    if not good:
        raise report.fail("aws_broker_trust", **facts)
    report.ok("aws_broker_trust", **facts)


def check_environment(report: Report, runtime: dict[str, Any]) -> None:
    """Where the broker is and the public key that verifies callers. No secret, no data."""
    environment = runtime.get("environmentVariables") or {}
    names = sorted(environment)
    # D16: the provisioner also sets these on every Runtime, so no prompt or tool payload
    # reaches the OTEL logs and spans. They must keep exactly these values.
    redaction = {
        "OTEL_SEMCONV_STABILITY_OPT_IN": "gen_ai_unredacted_attributes=",
        "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT": "false",
        "OTEL_PYTHON_DISABLED_INSTRUMENTATIONS": "urllib3,aws_mcp",
    }
    if any(environment.get(name) != value for name, value in redaction.items()):
        raise report.fail("aws_runtime_environment", names=names, redaction=False)
    names = [name for name in names if name not in redaction]
    required = {
        "MANGO_PACK_BROKER_ROLE_ARN",
        "MANGO_PACK_TARGET_ROLE_ARN",
        "MANGO_PACK_REGION",
        "MANGO_PACK_IDENTITY_PUBLIC_KEY",
    }
    if not required <= set(names) or not all(RUNTIME_ENVIRONMENT.fullmatch(n) for n in names):
        raise report.fail("aws_runtime_environment", names=names)
    report.ok("aws_runtime_environment", names=names)


def check_refusals(report: Report, session: boto3.Session, runtime_arn: str, tool: str) -> None:
    """Whoever can invoke the Runtime (the operator, here) is not a caller: without an
    assertion of the Gateway interceptor the pack runs no tool and assumes nothing."""
    forged = base64.urlsafe_b64encode(json.dumps({"sub": "someone"}).encode()).decode().rstrip("=")
    attempts = {
        "no_identity": {},
        "token_instead": {"_mango_ctx": {"token": "forged.by.operator"}},
        "forged_identity": {"_mango_ctx": {"identity": f"v1.{forged}.AAAA"}},
    }
    seen: dict[str, Any] = {}
    for label, arguments in attempts.items():
        answer = packs.mcp_call(
            session, runtime_arn, "tools/call", {"name": tool, "arguments": arguments}
        )
        result = answer["body"].get("result") or {}
        text = " ".join(str(part.get("text", "")) for part in result.get("content", []))
        seen[label] = bool(result.get("isError")) and REFUSED in text
    if not all(seen.values()):
        raise report.fail("aws_runtime_refuses", **seen)
    report.ok("aws_runtime_refuses", **seen)


def check_interceptor(report: Report, session: boto3.Session, namespace: str, pack_id: str) -> None:
    function = session.client("lambda").get_function_configuration(
        FunctionName=f"Mango-{namespace}-GatewayInterceptor"
    )
    variables = function["Environment"]["Variables"]
    signs_for = json.loads(variables.get("IDENTITY_TARGETS", "[]"))
    gets_token = json.loads(variables.get("CONTEXT_TARGETS", "[]"))
    if pack_id not in signs_for or pack_id in gets_token:
        raise report.fail("aws_interceptor", identity_targets=signs_for, token_targets=gets_token)
    report.ok("aws_interceptor", identity_targets=signs_for, token_targets=gets_token)


def verify_aws(run: Run, item: dict[str, Any]) -> None:
    report, session, namespace, pack_id = run.report, run.session, run.args.namespace, item["id"]
    tools = sorted(tool["name"] for tool in item["tools"])
    control = session.client("bedrock-agentcore-control")
    gateway = packs.gateway_id(run.outputs)
    runtime = packs.check_runtime(report, control, namespace, pack_id)
    packs.check_target(report, control, gateway, pack_id, runtime["agentRuntimeId"])
    check_policies(report, control, gateway, namespace, pack_id, tools=tools)
    iam = session.client("iam")
    check_broker_trust(report, iam, namespace, check_role(report, iam, namespace, pack_id))
    check_environment(report, runtime)
    check_interceptor(report, session, namespace, pack_id)

    # Listing needs no caller: the Runtime answers with exactly the tools of the manifest.
    answer = packs.mcp_call(session, runtime["agentRuntimeArn"], "tools/list", {})
    served = answer["body"]["result"]["tools"]
    listing: dict[str, Any] = {"served": sorted(tool["name"] for tool in served)}
    if packs.tools_hash is not None and packs.normalize_tools is not None:
        # Compare it with `tools_hash` of packs/<id>/manifest.yaml.
        listing["tools_hash"] = packs.tools_hash(packs.normalize_tools(served))
    if listing["served"] != tools:
        raise report.fail("aws_tools_list", **listing)
    report.ok("aws_tools_list", **listing)
    check_refusals(report, session, runtime["agentRuntimeArn"], tools[0])


# --- Agent, central user and area lead ----------------------------------------------------


def agent_definition(report: Report, creator: Api, item: dict[str, Any]) -> dict[str, Any]:
    definition = packs.agent_definition(report, creator, item)
    definition["name"] = f"E2E Billing {secrets.token_hex(3)}"
    definition["description"] = (
        "Agente temporal de la prueba de packs de datos de cuentas. Se retira al terminar."
    )
    definition["system_prompt"] = (
        "You are a temporary end-to-end test agent of Mango. Answer in Spanish, briefly. "
        "For any question about AWS spend, budgets, reservations or recommendations call the "
        "cost tools (the one the question names, if it names one) and answer only with what "
        "they return, with the amounts in USD. If a tool fails or you have none, say that you "
        "cannot look it up right now; never answer from memory."
    )
    return definition


def central_turn(run: Run) -> None:
    """The central user gets figures that came from the pack."""
    assert run.agent_id is not None
    deadline = time.monotonic() + packs.CACHE_SETTLE_S
    while True:
        turn = packs.chat(run.requester, run.agent_id, run.args.question, show=run.args.show)
        called = any(entry.endswith(":completed") for entry in turn["tools"])
        answered = turn.get("status") == 200 and turn.get("done") and turn["chars"] > 0
        if answered and called and turn["has_price"]:
            turn["has_figures"] = turn.pop("has_price")
            run.report.ok("central_chat", user=run.central_subject, **turn)
            return
        if time.monotonic() > deadline:
            raise run.report.fail("central_chat", **turn)
        time.sleep(5)


def enrolled(payer: boto3.Session) -> dict[str, bool]:
    """Whether the payer account is enrolled in the opt-in services. Read only."""
    status = payer.client("compute-optimizer").get_enrollment_status().get("status", "")
    hub = payer.client("cost-optimization-hub").list_enrollment_statuses().get("items", [])
    return {
        "compute-optimizer": str(status).lower() == "active",
        "cost-optimization": any(str(i.get("status", "")).lower() == "active" for i in hub),
    }


def tool_outcome(turn: dict[str, Any], tool: str) -> str | None:
    """``completed`` or ``error`` if the turn called ``tool``; the last status wins."""
    seen = None
    for entry in turn["tools"]:
        name, _, status = entry.rpartition(":")
        if name.rsplit("___", 1)[-1] == tool and status in ("completed", "error"):
            seen = status
    return seen


def expected_outcomes(tool: str, opted: dict[str, bool]) -> set[str]:
    """A tool must complete, unless its service is not enrolled in the payer account: then
    it must still be called and answer the service's error."""
    if tool not in OPT_IN_TOOLS:
        return {"completed"}
    if tool not in opted:  # no view of the payer account: either answer is a call that ran
        return {"completed", "error"}
    return {"completed"} if opted[tool] else {"error"}


def family_turns(run: Run, item: dict[str, Any]) -> None:
    """One turn per tool of the pack: the central user reaches every tool family."""
    assert run.agent_id is not None
    report, args = run.report, run.args
    tools = sorted(tool["name"] for tool in item["tools"])
    carried = {ref.rsplit(".", 1)[-1] for ref in agent_tools(report, run.requester, run.agent_id)}
    unknown = sorted(set(tools) - set(FAMILY_QUESTIONS))
    missing = sorted(set(tools) - carried)
    if unknown or missing:
        # An agent published before the pack grew keeps its old tools: create a new one.
        raise report.fail("central_families", without_question=unknown, agent_lacks=missing)
    opted: dict[str, bool] = {}
    if args.payer_profile:
        try:
            payer = boto3.Session(profile_name=args.payer_profile, region_name="us-east-1")
            opted = enrolled(payer)
        except ClientError as exc:
            raise report.fail("payer_enrollment", error=exc.response["Error"]["Code"]) from None
        report.ok("payer_enrollment", **opted)
    failed = []
    for tool in tools:
        wanted = expected_outcomes(tool, opted)
        turn: dict[str, Any] = {}
        good = False
        for _ in range(FAMILY_ATTEMPTS):
            turn = packs.chat(run.requester, run.agent_id, FAMILY_QUESTIONS[tool], show=args.show)
            turn.pop("has_price", None)
            answered = turn.get("status") == 200 and turn.get("done")
            good = bool(answered) and tool_outcome(turn, tool) in wanted
            if good:
                break
        facts = {
            "tool": tool,
            "outcome": tool_outcome(turn, tool),
            "expected": sorted(wanted),
            **turn,
        }
        if good:
            report.ok("central_family", **facts)
        else:
            failed.append(tool)
            report.fail("central_family", **facts)
    if failed:
        raise report.fail("central_families", failed=failed)
    report.ok("central_families", tools=len(tools), user=run.central_subject)


def agent_tools(report: Report, api: Api, agent_id: str) -> list[str]:
    return [str(ref) for ref in packs.agent_detail(report, api, agent_id).get("tools", [])]


def area_lead(run: Run, item: dict[str, Any]) -> None:
    """No agent, no tool and no way to be given one."""
    report, area = run.report, run.area
    assert area is not None
    if run.agent_id is not None:
        listed = expect(report, "area_marketplace", area.get("/agents"), 200)["items"]
        detail = area.get(f"/agents/{run.agent_id}")
        refused = packs.chat(area, run.agent_id, run.args.question, show=False)
        facts = {
            "listed": any(a["id"] == run.agent_id for a in listed),
            "detail": detail.status_code,
            "chat": refused.get("status"),
            "tools": refused["tools"],
        }
        if facts["listed"] or detail.status_code != 403 or refused.get("status") != 403:
            raise report.fail("area_agent", **facts)
        report.ok("area_agent", **facts)

    # Straight to the Gateway with the area lead's own token, as a tampered client would.
    tool = sorted(tool["name"] for tool in item["tools"])[0]
    name = f"{item['id']}___{tool}"
    answer = rpc(
        run.outputs["GatewayUrl"],
        area.token,
        "tools/call",
        {"name": name, "arguments": {"operation": "getCostAndUsage"}},
        1,
    )
    body = answer["body"] if isinstance(answer["body"], dict) else {}
    result = body.get("result") or {}
    error = body.get("error") or {}
    served = answer["status"] == 200 and "result" in body and not result.get("isError")
    facts = {
        "status": answer["status"],
        "error": error.get("code"),
        "message": error.get("message"),
    }
    if served:
        raise report.fail("area_gateway", **facts)
    report.ok("area_gateway", **facts)

    # Nobody can hand these tools to an area group: the version is not accepted for review.
    groups = expect(report, "groups", run.requester.get("/groups"), 200)["items"]
    areas = sorted(g["id"] for g in groups if g["type"] != "central")
    if not areas:
        report.ok("area_group_refused", skipped="no area group in the registry")
        return
    definition = {**agent_definition(report, run.requester, item), "groups": [areas[0]]}
    draft = expect(
        report, "area_draft", run.requester.post("/agents", {"definition": definition}), 201
    )
    url = f"/agents/{draft['agent_id']}/versions/{draft['version']}"
    try:
        submitted = run.requester.post(f"{url}/submit", {"revision": draft["revision"]})
        violations = sorted(
            {str(v.get("code")) for v in submitted.json().get("violations", [])}
            if submitted.status_code == 422
            else []
        )
        if "account_data_for_non_central_group" not in violations:
            raise report.fail(
                "area_group_refused", status=submitted.status_code, violations=violations
            )
        report.ok("area_group_refused", status=422, violations=violations)
    finally:
        deleted = run.requester.request("DELETE", url)
        report.ok("area_draft_deleted", status=deleted.status_code)


# --- CloudTrail of the payer account ------------------------------------------------------


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
            caller = identity.get("arn", "")
            found.append(
                {
                    "time": event.get("eventTime"),
                    "source_identity": request.get("sourceIdentity"),
                    "caller_source_identity": (
                        (event.get("userIdentity") or {}).get("sessionContext") or {}
                    ).get("sourceIdentity"),
                    "caller": str(caller).split(":assumed-role/")[-1].split("/")[0],
                    # A caller from another account shows only its account and role id.
                    "caller_account": identity.get("accountId"),
                    "caller_role_id": str(identity.get("principalId", "")).split(":")[0],
                    "session_policy": "policy" in request,
                    "tags": sorted(
                        str(tag.get("key")) for tag in request.get("tags") or [] if tag.get("key")
                    ),
                    "error": event.get("errorCode"),
                }
            )
    return found


def check_trail(run: Run) -> None:
    """The payer account saw the central user, by name, on the session that read the data."""
    report, args = run.report, run.args
    payer = boto3.Session(profile_name=args.payer_profile, region_name="us-east-1")
    trail = payer.client("cloudtrail")
    reader, broker = (
        f"Mango-{args.namespace}-BillingReader",
        f"Mango-{args.namespace}-BillingBroker",
    )
    since = run.started - timedelta(minutes=1)
    deadline = time.monotonic() + args.trail_wait
    # The payer sees the broker as the Mango account plus the broker's role id (no ARN, no
    # session context): CloudTrail logs a cross-account caller that way.
    mango_account = run.session.client("sts").get_caller_identity()["Account"]
    broker_role_id = run.session.client("iam").get_role(RoleName=broker)["Role"]["RoleId"]
    while True:
        events = assumed_for(trail, reader, since)
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
            raise report.fail("trail_payer", reason="no AssumeRole for the central user yet")
        time.sleep(TRAIL_POLL_S)
    facts = {
        "role": reader,
        "user": run.central_subject,
        "events": len(ours),
        "first": ours[-1],
        # The second hop carries the person and is limited by the manifest's actions; the
        # first hop (same person on the broker session) is checked in the Mango account below.
        "same_identity_on_both_hops": all(
            e["caller_source_identity"] in (None, run.central_subject) for e in ours
        ),
        "session_policy": all(e["session_policy"] for e in ours),
        "errors": sorted({str(e["error"]) for e in ours if e["error"]}),
    }
    if not facts["same_identity_on_both_hops"] or not facts["session_policy"] or facts["errors"]:
        raise report.fail("trail_payer", **facts)
    report.ok("trail_payer", **facts)

    if run.area_subject is not None:
        theirs = [
            e
            for e in events
            if run.area_subject in (e["source_identity"], e["caller_source_identity"])
        ]
        if theirs:
            raise report.fail("trail_area", user=run.area_subject, events=len(theirs))
        report.ok("trail_area", user=run.area_subject, events=0)

    # First hop, in the Mango account: the pack role assumed the broker for the same person.
    try:
        first_hop = [
            e
            for e in assumed_for(run.session.client("cloudtrail"), broker, since)
            if e["source_identity"] == run.central_subject
            and e["caller"] == f"Mango-{args.namespace}-mcp-{args.pack}"
        ]
    except ClientError as exc:
        raise report.fail("trail_mango", error=exc.response["Error"]["Code"]) from None
    if not first_hop:
        raise report.fail("trail_mango", reason="no AssumeRole of the pack role on the broker")
    report.ok("trail_mango", events=len(first_hop), tags=first_hop[-1]["tags"])


# --- Run ----------------------------------------------------------------------------------


@dataclass
class Run:
    report: Report
    requester: Api
    approver: Api
    area: Api | None
    session: boto3.Session
    outputs: dict[str, str]
    args: argparse.Namespace
    central_subject: str
    area_subject: str | None
    agent_id: str | None = None
    started: datetime = field(default_factory=lambda: datetime.now(UTC))


def require_users(run: Run) -> None:
    """Two administrators, the requester central (the claim the Gateway decides with), and an
    area lead who is not."""
    report = run.report
    for name, api in (("requester", run.requester), ("approver", run.approver)):
        me = expect(report, "me", api.get("/me"), 200)
        if "mango-admin" not in me.get("groups", []):
            raise report.fail("me", reason=f"the {name} is not an administrator")
    central = central_claim(run.requester.token)
    area = central_claim(run.area.token) if run.area is not None else None
    if central != "true" or area == "true":
        raise report.fail("me", requester_central=central, area_user_central=area)
    report.ok("users", requester_central=central, area_user_central=area)


def central_claim(token: str) -> str | None:
    """``mango_central`` of the access token: what Cedar L2 and the interceptor decide with."""
    value = claims(token).get("mango_central")
    return str(value) if value is not None else None


def user_steps(run: Run, item: dict[str, Any]) -> None:
    """What a central user gets, what an area lead does not, and what the payer saw."""
    report, args, steps = run.report, run.args, run.args.steps
    if "agent" in steps and run.agent_id is None:
        definition = agent_definition(report, run.requester, item)
        run.agent_id = packs.create_agent(report, run.requester, run.approver, item, definition)
    if "central" in steps:
        if run.agent_id is None:
            raise report.fail("central_chat", reason="no agent: run the agent step or pass --agent")
        central_turn(run)
        if args.families:
            family_turns(run, item)
    if "area" in steps:
        if run.area is None:
            raise report.fail("area", reason="--area-user is required for this step")
        area_lead(run, item)
    if "trail" in steps:
        if not args.payer_profile:
            raise report.fail("trail", reason="--payer-profile is required for this step")
        check_trail(run)


def cleanup(run: Run, *, was_enabled: bool) -> None:
    report, pack_id = run.report, run.args.pack
    if run.agent_id is not None:
        packs.retire(report, run.approver, run.agent_id)
    now = packs.pack_item(report, run.requester, pack_id)["pack"]["status"]
    if run.args.keep_pack or was_enabled or now != "enabled":
        report.ok("cleanup_pack", left=now)
    else:
        packs.disable(report, run.requester, pack_id)


def execute(run: Run) -> None:
    report, args = run.report, run.args
    pack_id, steps = args.pack, args.steps
    require_users(run)
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
        cleanup(run, was_enabled=was_enabled)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True, help="AWS profile of the Mango account")
    parser.add_argument("--payer-profile", help="AWS profile of the payer account (trail step)")
    parser.add_argument("--stack", default="Mango-poc-Core")
    parser.add_argument("--namespace", help="default: the middle part of the stack name")
    parser.add_argument("--secrets", required=True, type=Path)
    parser.add_argument("--requester", required=True, help="a central administrator (e2e user)")
    parser.add_argument("--approver", required=True, help="another administrator (e2e user)")
    parser.add_argument("--area-user", help="an area lead who is not central (e2e user)")
    parser.add_argument("--pack", default="aws-billing")
    parser.add_argument("--steps", default=",".join(STEPS), help=f"any of: {', '.join(STEPS)}")
    parser.add_argument("--agent", help="use this published agent instead of creating one")
    parser.add_argument(
        "--question",
        default=(
            "¿Cuánto gastó la organización el mes pasado en total y cuáles fueron los tres "
            "servicios con más gasto? Consulta la herramienta de costos."
        ),
    )
    parser.add_argument(
        "--since",
        help="ISO time the central turn was made at, to run `trail` alone (default: now)",
    )
    parser.add_argument("--trail-wait", type=int, default=1200, help="seconds to wait for events")
    parser.add_argument(
        "--families",
        action="store_true",
        help="central step: one more turn per tool of the pack; every tool must run",
    )
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
        central_subject=subject(tokens[args.requester]),
        area_subject=subject(area_token) if area_token else None,
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
