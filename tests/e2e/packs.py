"""End-to-end test of Marketplace v1, phase B (MCP packs), against a deployed lab installation.

One administrator asks to enable a pack of the release and cannot approve the request; a
second administrator approves; the pack provisioner installs it (role, Runtime, Gateway
target, Cedar policies). An agent that uses the pack's tools is created, approved by the other
administrator and published; a chat turn calls a pack tool. The pack is then disabled by one
administrator: the agent keeps answering without those tools (``unavailable_tools``, D46).
Enabling it again, with double approval, gives them back. Finally the agent is retired.

Uses only lab e2e users (config ``e2e: true``), like ``marketplace.py``. It **creates real
resources**: the pack's role, Runtime, Gateway target and policies, and the role and harness
of the test agent. The pack ends as it started (disabled, unless it was enabled before the
run or ``--keep-pack`` is given). Retiring the agent starts the deprovisioner, which deletes its
harness and role within minutes (D48; ``docs/runbooks/poc-deploy.md``, «MCP packs: prueba de
punta a punta»).

``--steps`` picks what to run, in this order: ``enable``, ``aws``, ``agent``, ``measure``,
``disable``, ``reenable``, ``cleanup``. ``aws`` and ``measure`` need the operator's AWS
credentials to read AgentCore and IAM, and ``measure`` to call ``InvokeAgentRuntime`` on the
pack Runtime (SigV4; it is how the cold start is timed without a model in between). With
``--with ./packages/py/mango-packs`` the ``aws`` step also computes the ``tools_hash`` of what
the Runtime serves, to compare with the manifest.

``--dry-run`` only reads (sign-in, ``/api/me``, the catalog): nothing is created.

Run:
  uv run --no-project --with boto3 --with pycognito --with pyotp --with httpx \
    python tests/e2e/packs.py --profile mango-sandbox --secrets <path> \
    --requester <admin email> --approver <another admin email> [--steps enable,aws,...]
"""

from __future__ import annotations

import argparse
import json
import re
import secrets
import statistics
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import boto3
import httpx
from botocore.exceptions import ClientError
from marketplace import (
    ROOT_SUPERVISOR,
    Api,
    CheckFailedError,
    Report,
    error_code,
    expect,
    wait_published,
)
from smoke import load_secrets, save_secrets, sign_in, stack_outputs

try:  # Optional: only to print the hash of the served tools.
    from mango_packs.tools import normalize_tools, tools_hash
except ImportError:
    normalize_tools = tools_hash = None

STEPS = ("enable", "aws", "agent", "measure", "disable", "reenable", "cleanup")
INSTALL_TIMEOUT_S = 1500
DISABLE_TIMEOUT_S = 900
POLL_S = 10
# Other API tasks may serve their cached copy of the installed packs for a few seconds.
CACHE_SETTLE_S = 45
ENDPOINT_LIVE = "live"
MCP_PROTOCOL_VERSION = "2025-06-18"
_PRICE_RE = re.compile(r"\d[.,]\d")


# --- Catalog ------------------------------------------------------------------------------


def pack_item(report: Report, api: Api, pack_id: str) -> dict[str, Any]:
    items = expect(report, "catalog", api.get("/mcp/catalog"), 200)["items"]
    for item in items:
        if item["id"] == pack_id and item["kind"] == "pack":
            return dict(item)
    raise report.fail("catalog", reason=f"{pack_id} is not a pack of the deployed release")


def pack_summary(item: dict[str, Any]) -> dict[str, Any]:
    pack = item["pack"]
    return {
        "status": pack["status"],
        "version": pack["version"],
        "installed_version": pack["installed_version"],
        "lock_version": pack["lock_version"],
        "failed_step": pack["failed_step"],
        "failure": pack["failure"],
    }


def wait_pack(
    report: Report, api: Api, pack_id: str, *, step: str, wanted: str, during: set[str], limit: int
) -> dict[str, Any]:
    """Poll the catalog until the provisioner leaves the pack in ``wanted``."""
    started = time.monotonic()
    while True:
        item = pack_item(report, api, pack_id)
        status = item["pack"]["status"]
        if status == wanted:
            report.ok(step, seconds=round(time.monotonic() - started), **pack_summary(item))
            return item
        if status not in during:
            raise report.fail(step, **pack_summary(item))
        if time.monotonic() - started > limit:
            raise report.fail(step, reason="timeout", **pack_summary(item))
        time.sleep(POLL_S)


def enable(report: Report, requester: Api, approver: Api, pack_id: str, *, step: str) -> None:
    """Request with the manifest's default parameters; only another administrator approves."""
    item = pack_item(report, requester, pack_id)
    pack = item["pack"]
    if pack["status"] not in {"available", "disabled"}:
        raise report.fail(step, reason="the pack is not available to enable", **pack_summary(item))
    config = {param["key"]: param["default"] for param in pack["params"]}
    body = {
        "version": pack["lock_version"],
        "config": config,
        "reason": "Prueba de punta a punta de MCP packs",
    }
    asked = expect(
        report, f"{step}_request", requester.post(f"/mcp/{pack_id}/enablements", body), 201
    )
    pending = next(i for i in asked["items"] if i["id"] == pack_id)["pack"]["pending"]
    if not pending or not pending["own"] or pending["kind"] != "enable":
        raise report.fail(f"{step}_request", reason="no pending request of the requester")
    change = pending["change_id"]
    report.ok(f"{step}_request", change=change, config=sorted(config))

    # Whoever asked neither approves nor rejects (D26).
    url = f"/mcp/{pack_id}/enablements/{change}"
    own = requester.post(f"{url}/approve", {})
    if (own.status_code, error_code(own)) != (403, "same_approver"):
        raise report.fail(f"{step}_self_approval", status=own.status_code, error=error_code(own))
    own_reject = requester.post(f"{url}/reject", {"reason": "no debería poder"})
    if own_reject.status_code != 403:
        raise report.fail(f"{step}_self_reject", status=own_reject.status_code)
    report.ok(f"{step}_self_approval", approve=403, reject=403, error="same_approver")

    seen = pack_item(report, approver, pack_id)["pack"]["pending"]
    if not seen or seen["own"] or seen["change_id"] != change:
        raise report.fail(f"{step}_approve", reason="the approver does not see the request")
    expect(report, f"{step}_approve", approver.post(f"{url}/approve", {}), 200)
    report.ok(f"{step}_approve", change=change)
    installed = wait_pack(
        report,
        approver,
        pack_id,
        step=f"{step}_installed",
        wanted="enabled",
        during={"pending", "installing"},
        limit=INSTALL_TIMEOUT_S,
    )
    if not installed["enabled"] or not all(tool["enabled"] for tool in installed["tools"]):
        raise report.fail(f"{step}_installed", reason="enabled but its tools are not")


def disable(report: Report, admin: Api, pack_id: str) -> None:
    """One administrator, with a reason. The provisioner removes what it created."""
    item = pack_item(report, admin, pack_id)
    affected = [agent["id"] for agent in item["agents"]]
    body = {"version": item["pack"]["lock_version"], "reason": "Prueba de punta a punta: baja"}
    no_reason = admin.request("DELETE", f"/mcp/{pack_id}", {"version": body["version"]})
    if no_reason.status_code != 422:
        raise report.fail("disable_without_reason", status=no_reason.status_code)
    expect(report, "disable", admin.request("DELETE", f"/mcp/{pack_id}", body), 200)
    report.ok("disable", affected_agents=affected)
    wait_pack(
        report,
        admin,
        pack_id,
        step="disabled",
        wanted="disabled",
        during={"disabling", "enabled"},
        limit=DISABLE_TIMEOUT_S,
    )


# --- AWS, read only -----------------------------------------------------------------------


def runtime_name(namespace: str, pack_id: str) -> str:
    return f"Mango_{namespace}_mcp_{pack_id.replace('-', '_')}"


def find_runtime(control: Any, namespace: str, pack_id: str) -> dict[str, Any] | None:
    name = runtime_name(namespace, pack_id)
    for page in control.get_paginator("list_agent_runtimes").paginate():
        for summary in page["agentRuntimes"]:
            if summary["agentRuntimeName"] == name:
                return dict(control.get_agent_runtime(agentRuntimeId=summary["agentRuntimeId"]))
    return None


def gateway_id(outputs: dict[str, str]) -> str:
    """``https://<gateway id>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp``."""
    return outputs["GatewayUrl"].split("//", 1)[1].split(".", 1)[0]


def check_runtime(report: Report, control: Any, namespace: str, pack_id: str) -> dict[str, Any]:
    """READY, MCP, SigV4 only, with `live` on its latest version and the pack's own role."""
    runtime = find_runtime(control, namespace, pack_id)
    if runtime is None:
        raise report.fail("aws_runtime", reason="no runtime with the pack's name")
    runtime_id = runtime["agentRuntimeId"]
    live = control.get_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName=ENDPOINT_LIVE)
    facts = {
        "runtime": runtime_id,
        "status": runtime["status"],
        "version": runtime["agentRuntimeVersion"],
        "live_status": live["status"],
        "live_version": live.get("liveVersion"),
        "protocol": (runtime.get("protocolConfiguration") or {}).get("serverProtocol"),
        "sigv4_only": not runtime.get("authorizerConfiguration"),
        "role": runtime["roleArn"].rsplit("/", 1)[-1],
        "idle_timeout": (runtime.get("lifecycleConfiguration") or {}).get(
            "idleRuntimeSessionTimeout"
        ),
    }
    good = (
        runtime["status"] == "READY"
        and live["status"] == "READY"
        and live.get("liveVersion") == runtime["agentRuntimeVersion"]
        and facts["protocol"] == "MCP"
        and facts["sigv4_only"]
        and facts["role"] == f"Mango-{namespace}-mcp-{pack_id}"
    )
    if not good:
        raise report.fail("aws_runtime", **facts)
    report.ok("aws_runtime", **facts)
    return runtime


def check_target(report: Report, control: Any, gateway: str, pack_id: str, runtime_id: str) -> str:
    """Gateway target named after the pack, on the runtime's `live` endpoint, with SigV4."""
    target = None
    for page in control.get_paginator("list_gateway_targets").paginate(gatewayIdentifier=gateway):
        for summary in page["items"]:
            if summary["name"] == pack_id:
                target = control.get_gateway_target(
                    gatewayIdentifier=gateway, targetId=summary["targetId"]
                )
    if target is None:
        raise report.fail("aws_target", reason="no gateway target named after the pack")
    endpoint = str(target["targetConfiguration"]["mcp"]["mcpServer"]["endpoint"])
    credentials = [c["credentialProviderType"] for c in target["credentialProviderConfigurations"]]
    metadata = target.get("metadataConfiguration") or {}
    facts = {
        "target": target["targetId"],
        "status": target["status"],
        "credentials": credentials,
        "on_live_endpoint": runtime_id in endpoint.replace("%2F", "/")
        and endpoint.endswith(f"qualifier={ENDPOINT_LIVE}"),
        # What the Gateway forwards from the caller. Never the caller's token (D33).
        "forwarded_headers": sorted(metadata.get("allowedRequestHeaders") or []),
    }
    good = (
        target["status"] == "READY"
        and credentials == ["GATEWAY_IAM_ROLE"]
        and facts["on_live_endpoint"]
        and not any(h.lower() == "authorization" for h in facts["forwarded_headers"])
    )
    if not good:
        raise report.fail("aws_target", **facts)
    report.ok("aws_target", **facts)
    return endpoint


def check_policies(
    report: Report, control: Any, gateway: str, namespace: str, pack_id: str, *, tools: list[str]
) -> None:
    """Cedar policies generated for the pack: active, and permitting exactly its tools."""
    engine = control.get_gateway(gatewayIdentifier=gateway).get("policyEngineConfiguration") or {}
    engine_id = str(engine.get("arn", "")).rsplit("/", 1)[-1]
    prefix = f"{runtime_name(namespace, pack_id)}_"
    policies = []
    for page in control.get_paginator("list_policies").paginate(policyEngineId=engine_id):
        policies += [p for p in page["policies"] if p["name"].startswith(prefix)]
    statements = "\n".join(
        (p.get("definition", {}).get("cedar") or {}).get("statement", "") for p in policies
    )
    permitted = sorted(set(re.findall(rf'"{re.escape(pack_id)}___([A-Za-z0-9_-]+)"', statements)))
    facts = {
        "policies": sorted(p["name"] for p in policies),
        "status": sorted({p["status"] for p in policies}),
        "enforcement": engine.get("mode"),
        "permitted_tools": permitted,
        "only_permit": "forbid" not in statements and statements.count("permit") == len(policies),
    }
    if not policies or facts["status"] != ["ACTIVE"] or permitted != tools:
        raise report.fail("aws_policies", **facts)
    report.ok("aws_policies", **facts)


def check_role(report: Report, iam: Any, namespace: str, item: dict[str, Any]) -> None:
    """This installation's pack boundary, AgentCore as the only principal, and no data
    action beyond the ones of the manifest."""
    role_name = f"Mango-{namespace}-mcp-{item['id']}"
    role = iam.get_role(RoleName=role_name)["Role"]
    boundary = (role.get("PermissionsBoundary") or {}).get("PermissionsBoundaryArn", "")
    inline = iam.list_role_policies(RoleName=role_name)["PolicyNames"]
    attached = iam.list_attached_role_policies(RoleName=role_name)["AttachedPolicies"]
    actions: set[str] = set()
    for name in inline:
        document = iam.get_role_policy(RoleName=role_name, PolicyName=name)["PolicyDocument"]
        for statement in document["Statement"]:
            listed = statement.get("Action", [])
            actions.update([listed] if isinstance(listed, str) else listed)
    own = {"logs", "xray", "cloudwatch"}  # the runtime's own logs, traces and metrics
    data_actions = sorted(a for a in actions if a.split(":")[0] not in own)
    facts = {
        "role": role_name,
        "boundary": boundary.rsplit("/", 1)[-1],
        "inline_policies": inline,
        "managed_policies": len(attached),
        "data_actions": data_actions,
        "trusted": sorted(
            str(s.get("Principal", {}).get("Service"))
            for s in role["AssumeRolePolicyDocument"]["Statement"]
        ),
    }
    good = (
        facts["boundary"] == f"Mango-{namespace}-mcp-boundary"
        and not attached
        and data_actions == sorted(item["permissions"])
        and facts["trusted"] == ["bedrock-agentcore.amazonaws.com"]
    )
    if not good:
        raise report.fail("aws_role", **facts)
    report.ok("aws_role", **facts)


def verify_aws(
    report: Report,
    session: boto3.Session,
    outputs: dict[str, str],
    namespace: str,
    item: dict[str, Any],
) -> None:
    """What the provisioner must have left: Runtime, target, policies and a bounded role."""
    pack_id = item["id"]
    tools = sorted(tool["name"] for tool in item["tools"])
    control = session.client("bedrock-agentcore-control")
    gateway = gateway_id(outputs)
    runtime = check_runtime(report, control, namespace, pack_id)
    endpoint = check_target(report, control, gateway, pack_id, runtime["agentRuntimeId"])
    check_policies(report, control, gateway, namespace, pack_id, tools=tools)
    check_role(report, session.client("iam"), namespace, item)

    # The Runtime answers `tools/list` with exactly the tools of the signed manifest.
    answer = mcp_call(session, runtime["agentRuntimeArn"], "tools/list", {})
    served = answer["body"]["result"]["tools"]
    listing: dict[str, Any] = {
        "served": sorted(tool["name"] for tool in served),
        "seconds": answer["seconds"],
    }
    if tools_hash is not None and normalize_tools is not None:
        # Compare it with `tools_hash` of packs/<id>/manifest.yaml.
        listing["tools_hash"] = tools_hash(normalize_tools(served))
    if listing["served"] != tools:
        raise report.fail("aws_tools_list", **listing)
    report.ok("aws_tools_list", **listing)

    # Without SigV4 the Runtime refuses the call (S-M2).
    unsigned = httpx.post(
        endpoint,
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
        headers={"Accept": "application/json, text/event-stream"},
        timeout=60,
    )
    if unsigned.status_code not in {401, 403}:
        raise report.fail("aws_unsigned_call", status=unsigned.status_code)
    report.ok("aws_unsigned_call", status=unsigned.status_code)


# --- Direct calls to the pack Runtime (measurements) --------------------------------------


def mcp_call(
    session: boto3.Session,
    runtime_arn: str,
    method: str,
    params: dict[str, Any],
    *,
    mcp_session: str | None = None,
) -> dict[str, Any]:
    """One MCP request to the pack Runtime's ``live`` endpoint, signed as the operator.

    AgentCore keeps one microVM per MCP session: a request without ``Mcp-Session-Id`` starts
    a new one, and a request that repeats the id of an earlier answer reaches the same one.
    """
    client = session.client("bedrock-agentcore")
    request: dict[str, Any] = {
        "agentRuntimeArn": runtime_arn,
        "qualifier": ENDPOINT_LIVE,
        "contentType": "application/json",
        "accept": "application/json, text/event-stream",
        "mcpProtocolVersion": MCP_PROTOCOL_VERSION,
        "payload": json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}),
    }
    if mcp_session:
        request["mcpSessionId"] = mcp_session
    started = time.monotonic()
    response = client.invoke_agent_runtime(**request)
    raw = response["response"].read().decode()
    seconds = round(time.monotonic() - started, 2)
    if str(response.get("contentType") or "").startswith("text/event-stream"):
        data = [line[5:].strip() for line in raw.splitlines() if line.startswith("data:")]
        raw = data[-1] if data else "{}"
    return {
        "seconds": seconds,
        "body": json.loads(raw),
        "mcp_session": response.get("mcpSessionId"),
    }


def _stats(samples: list[float]) -> dict[str, float]:
    return {
        "n": len(samples),
        "min": round(min(samples), 2),
        "median": round(statistics.median(samples), 2),
        "max": round(max(samples), 2),
    }


def measure(
    report: Report, session: boto3.Session, namespace: str, item: dict[str, Any], *, calls: int
) -> None:
    """Latency of the pack Runtime without a model in between (S-M5).

    ``cold``: a request without an MCP session, so AgentCore starts a microVM for it. That is
    what every call through the Gateway pays while the Gateway keeps no session with the
    target. ``warm``: requests that repeat the session of an earlier answer. ``tools/list``
    touches no AWS API; the tool call adds the upstream server's own work.
    """
    control = session.client("bedrock-agentcore-control")
    runtime = find_runtime(control, namespace, item["id"])
    if runtime is None:
        raise report.fail("measure", reason="no runtime with the pack's name")
    arn = runtime["agentRuntimeArn"]
    tool = {"name": "get_pricing_service_codes", "arguments": {"filter": "bedrock"}}

    def one(method: str, params: dict[str, Any], mcp_session: str | None = None) -> dict[str, Any]:
        answer = mcp_call(session, arn, method, params, mcp_session=mcp_session)
        if "error" in answer["body"] or (answer["body"].get("result") or {}).get("isError"):
            raise report.fail("measure", method=method, error="the runtime answered an error")
        return answer

    cold_list = [one("tools/list", {}) for _ in range(calls)]
    report.ok("measure_cold_tools_list", **_stats([a["seconds"] for a in cold_list]))
    cold_call = [one("tools/call", tool)["seconds"] for _ in range(calls)]
    report.ok("measure_cold_tool_call", **_stats(cold_call))

    warm_session = cold_list[-1]["mcp_session"]
    if not warm_session:
        raise report.fail("measure", reason="the runtime returned no MCP session id")
    warm_list = [one("tools/list", {}, warm_session)["seconds"] for _ in range(calls)]
    report.ok("measure_warm_tools_list", **_stats(warm_list))
    warm_call = [one("tools/call", tool, warm_session)["seconds"] for _ in range(calls)]
    report.ok("measure_warm_tool_call", **_stats(warm_call))


# --- Agent --------------------------------------------------------------------------------


def chat(api: Api, agent_id: str, question: str, *, show: bool) -> dict[str, Any]:
    """One turn. Times every tool call as the client sees it (model → Gateway → Runtime)."""
    summary: dict[str, Any] = {"tools": [], "tool_seconds": [], "chars": 0}
    text = ""
    started = time.monotonic()
    running: dict[str, float] = {}
    with httpx.stream(
        "POST",
        f"{api.app_url}/api/chat",
        json={"message": question, "agent_id": agent_id},
        headers={"Authorization": f"Bearer {api.token}"},
        timeout=httpx.Timeout(30.0, read=300.0),
    ) as response:
        summary["status"] = response.status_code
        if response.status_code != 200:
            response.read()
            summary["error"] = error_code(response)
            return summary
        event = None
        for line in response.iter_lines():
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: ") and event:
                data = json.loads(line[6:])
                now = time.monotonic()
                if event == "delta":
                    if "first_text_seconds" not in summary and data.get("text", "").strip():
                        summary["first_text_seconds"] = round(now - started, 2)
                    text += data.get("text", "")
                elif event == "tool":
                    name, status = data["name"], data["status"]
                    summary["tools"].append(f"{name}:{status}")
                    if status == "started":
                        running[name] = now
                    elif name in running:
                        summary["tool_seconds"].append(round(now - running.pop(name), 2))
                elif event == "error":
                    summary["stream_error"] = data.get("code")
                elif event == "done":
                    summary["done"] = True
    summary["seconds"] = round(time.monotonic() - started, 2)
    summary["chars"] = len(text)
    summary["has_price"] = bool(_PRICE_RE.search(text))
    if show:
        # Public list prices only: the question is the script's own.
        summary["answer"] = text[:1200]
    return summary


def agent_definition(report: Report, creator: Api, item: dict[str, Any]) -> dict[str, Any]:
    models = expect(report, "models", creator.get("/models"), 200)["items"]
    with_tools = [m["id"] for m in models if m["supports_tools"]]
    if not with_tools:
        raise report.fail("models", reason="no enabled model supports tools")
    groups = expect(report, "groups", creator.get("/groups"), 200)["items"]
    central = sorted(g["id"] for g in groups if g["type"] == "central")
    if not central:
        raise report.fail("groups", reason="no central group in the registry")
    return {
        "name": f"E2E Pricing {secrets.token_hex(3)}",
        "description": "Agente temporal de la prueba de MCP packs. Se retira al terminar.",
        "category": "FinOps",
        "icon": "Money",
        "color": 1,
        "reports_to": ROOT_SUPERVISOR,
        "role": "Prueba E2E",
        "model": with_tools[0],
        "allowed_models": [with_tools[0]],
        "system_prompt": (
            "You are a temporary end-to-end test agent of Mango. Answer in Spanish, briefly. "
            "For any question about AWS prices call the pricing tools and answer only with "
            "what they return, quoting the unit price in USD. If you have no pricing tool, "
            "say that you cannot look prices up right now; never answer from memory."
        ),
        "tools": [tool["ref"] for tool in item["tools"]],
        "approval_tools": [],
        "limits": {
            "max_tokens": 4096,
            "max_iterations": 8,
            "timeout_seconds": 180,
            "max_tokens_per_call": None,
            "temperature": None,
        },
        "groups": [central[0]],
        "users": [],
    }


def create_agent(
    report: Report,
    creator: Api,
    approver: Api,
    item: dict[str, Any],
    definition: dict[str, Any] | None = None,
) -> str:
    """An agent with every tool of the pack, approved by the other administrator."""
    definition = definition or agent_definition(report, creator, item)
    draft = expect(report, "agent_create", creator.post("/agents", {"definition": definition}), 201)
    agent_id, number = draft["agent_id"], draft["version"]
    url = f"/agents/{agent_id}/versions/{number}"
    review = expect(
        report, "agent_submit", creator.post(f"{url}/submit", {"revision": draft["revision"]}), 200
    )
    content_hash = review["content_hash"]
    report.ok("agent_submit", agent=agent_id, tools=len(definition["tools"]))
    own = creator.post(f"{url}/approve", {"content_hash": content_hash})
    if (own.status_code, error_code(own)) != (403, "same_approver"):
        raise report.fail("agent_self_approval", status=own.status_code, error=error_code(own))
    approved = expect(
        report,
        "agent_approve",
        approver.post(f"{url}/approve", {"content_hash": content_hash}),
        200,
    )
    if approved["status"] == "failed":
        raise report.fail("agent_approve", failed_step=approved.get("failed_step"))
    report.ok("agent_approve", status=approved["status"])
    wait_published(report, approver, url)
    return str(agent_id)


def agent_detail(report: Report, api: Api, agent_id: str) -> dict[str, Any]:
    return dict(expect(report, "agent_detail", api.get(f"/agents/{agent_id}"), 200))


def ask(
    report: Report,
    api: Api,
    agent_id: str,
    question: str,
    *,
    step: str,
    with_tools: bool,
    show: bool,
) -> dict[str, Any]:
    """A turn that must (or must not) reach the pack. Retries while caches settle."""
    deadline = time.monotonic() + CACHE_SETTLE_S
    while True:
        turn = chat(api, agent_id, question, show=show)
        called = any(entry.endswith(":completed") for entry in turn["tools"])
        answered = turn.get("status") == 200 and turn.get("done") and turn["chars"] > 0
        good = answered and ((called and turn["has_price"]) if with_tools else not turn["tools"])
        if good:
            report.ok(step, **turn)
            return turn
        if time.monotonic() > deadline:
            raise report.fail(step, **turn)
        time.sleep(5)


def expect_unavailable(
    report: Report, api: Api, agent_id: str, wanted: list[str], *, step: str
) -> None:
    deadline = time.monotonic() + CACHE_SETTLE_S
    while True:
        detail = agent_detail(report, api, agent_id)
        if detail["status"] == "published" and detail["unavailable_tools"] == wanted:
            report.ok(step, status=detail["status"], unavailable_tools=len(wanted))
            return
        if time.monotonic() > deadline:
            raise report.fail(
                step, status=detail["status"], unavailable_tools=detail["unavailable_tools"]
            )
        time.sleep(5)


def retire(report: Report, admin: Api, agent_id: str) -> None:
    detail = agent_detail(report, admin, agent_id)
    retired = expect(
        report,
        "agent_retire",
        admin.post(
            f"/agents/{agent_id}/retire",
            {"lock_version": detail["lock_version"], "reason": "Fin de la prueba de MCP packs"},
        ),
        200,
    )
    report.ok("agent_retire", agent=agent_id, status=retired["status"])


# --- Run ----------------------------------------------------------------------------------


@dataclass
class Run:
    report: Report
    requester: Api
    approver: Api
    session: boto3.Session
    outputs: dict[str, str]
    args: argparse.Namespace
    agent_id: str | None = None

    def ask(self, step: str, *, with_tools: bool) -> None:
        assert self.agent_id is not None
        ask(
            self.report,
            self.requester,
            self.agent_id,
            self.args.question,
            step=step,
            with_tools=with_tools,
            show=self.args.show,
        )

    def tools_unavailable(self, step: str, wanted: list[str]) -> None:
        assert self.agent_id is not None
        expect_unavailable(self.report, self.requester, self.agent_id, wanted, step=step)


def agent_step(run: Run, item: dict[str, Any]) -> None:
    if run.agent_id is None:
        run.agent_id = create_agent(run.report, run.requester, run.approver, item)
    run.tools_unavailable("agent_tools_available", [])
    run.ask("chat", with_tools=True)


def measure_step(run: Run, item: dict[str, Any]) -> None:
    args, report = run.args, run.report
    try:
        measure(report, run.session, args.namespace, item, calls=args.calls)
    except ClientError as exc:
        raise report.fail("measure", error=exc.response["Error"]["Code"]) from None
    if run.agent_id is None:
        return
    # The same call as the model makes it: harness -> Gateway (policy, interceptor) -> Runtime.
    turns = [
        chat(run.requester, run.agent_id, args.question, show=False) for _ in range(args.calls)
    ]
    seconds = [s for turn in turns for s in turn["tool_seconds"]]
    if seconds:
        report.ok("measure_chat_tool_call", **_stats(seconds))


def disable_step(run: Run, refs: list[str]) -> None:
    disable(run.report, run.requester, run.args.pack)
    if run.agent_id is not None:
        # D46: the agent keeps serving, with fewer tools than approved, never more.
        run.tools_unavailable("agent_tools_unavailable", refs)
        run.ask("chat_without_pack", with_tools=False)


def reenable_step(run: Run) -> None:
    enable(run.report, run.requester, run.approver, run.args.pack, step="reenable")
    if run.agent_id is not None:
        run.tools_unavailable("agent_tools_restored", [])
        run.ask("chat_after_reenable", with_tools=True)


def cleanup_step(run: Run, *, was_enabled: bool) -> None:
    report, pack_id = run.report, run.args.pack
    if run.agent_id is not None:
        retire(report, run.approver, run.agent_id)
    now = pack_item(report, run.requester, pack_id)["pack"]["status"]
    if run.args.keep_pack or was_enabled or now != "enabled":
        report.ok("cleanup_pack", left=now)
    else:
        disable(report, run.requester, pack_id)


def require_admins(run: Run) -> None:
    for name, api in (("requester", run.requester), ("approver", run.approver)):
        me = expect(run.report, "me", api.get("/me"), 200)
        if "mango-admin" not in me.get("groups", []):
            raise run.report.fail("me", reason=f"the {name} is not an administrator")


def execute(run: Run) -> None:
    report, args = run.report, run.args
    pack_id, steps = args.pack, args.steps
    require_admins(run)
    item = pack_item(report, run.requester, pack_id)
    was_enabled = item["pack"]["status"] == "enabled"
    report.ok("catalog", tools=len(item["tools"]), was_enabled=was_enabled, **pack_summary(item))
    if args.dry_run:
        return

    if "enable" in steps:
        if was_enabled:
            report.ok("enable", skipped="already enabled")
        else:
            enable(report, run.requester, run.approver, pack_id, step="enable")
    item = pack_item(report, run.requester, pack_id)
    if "aws" in steps:
        try:
            verify_aws(report, run.session, run.outputs, args.namespace, item)
        except ClientError as exc:
            raise report.fail("aws", error=exc.response["Error"]["Code"]) from None
    if "agent" in steps:
        agent_step(run, item)
    if "measure" in steps:
        measure_step(run, item)
    if "disable" in steps:
        disable_step(run, sorted(tool["ref"] for tool in item["tools"]))
    if "reenable" in steps:
        reenable_step(run)
    if "cleanup" in steps:
        cleanup_step(run, was_enabled=was_enabled)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--stack", default="Mango-poc-Core")
    parser.add_argument("--namespace", help="default: the middle part of the stack name")
    parser.add_argument("--secrets", required=True, type=Path)
    parser.add_argument("--requester", required=True, help="an administrator (e2e user)")
    parser.add_argument("--approver", required=True, help="another administrator (e2e user)")
    parser.add_argument("--pack", default="aws-pricing")
    parser.add_argument("--steps", default=",".join(STEPS), help=f"any of: {', '.join(STEPS)}")
    parser.add_argument("--agent", help="use this published agent instead of creating one")
    parser.add_argument(
        "--question",
        default=(
            "¿Cuál es el precio on-demand por hora de una instancia EC2 m5.large con Linux "
            "en us-east-1? Consulta la herramienta de precios."
        ),
    )
    parser.add_argument("--calls", type=int, default=5, help="samples per measurement")
    parser.add_argument("--show", action="store_true", help="print the start of each answer")
    parser.add_argument("--keep-pack", action="store_true", help="leave the pack enabled")
    parser.add_argument("--dry-run", action="store_true", help="only read; create nothing")
    args = parser.parse_args()
    if args.requester == args.approver:
        raise SystemExit("--requester and --approver must be different administrators")
    args.steps = [step for step in args.steps.split(",") if step]
    unknown = sorted(set(args.steps) - set(STEPS))
    if unknown:
        raise SystemExit(f"unknown steps: {unknown}")
    args.namespace = args.namespace or args.stack.split("-")[1]

    session = boto3.Session(profile_name=args.profile, region_name="us-east-1")
    outputs = stack_outputs(session, args.stack)
    store = load_secrets(args.secrets)
    idp = session.client("cognito-idp")
    try:
        tokens = {
            email: sign_in(idp, outputs["UserPoolId"], outputs["WebClientId"], email, store)
            for email in (args.requester, args.approver)
        }
    finally:
        save_secrets(args.secrets, store)

    app_url = outputs["AppUrl"]
    requester, approver = Api(app_url, tokens[args.requester]), Api(app_url, tokens[args.approver])
    report = Report()
    try:
        execute(Run(report, requester, approver, session, outputs, args, agent_id=args.agent))
    except CheckFailedError as failed:
        print(json.dumps({"result": "failed", "step": str(failed)}), flush=True)
        sys.exit(1)
    print(json.dumps({"result": "ok", "steps": len(report.steps)}), flush=True)


if __name__ == "__main__":
    main()
