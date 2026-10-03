"""End-to-end test of Marketplace v1, phase A, against a deployed lab installation.

One administrator creates an agent and sends it to review; the same administrator cannot
approve it; a second administrator reads the diff and approves; the provisioner publishes it;
a user with access chats with it and one without access cannot see it; finally the agent is
retired, no longer takes turns, and the deprovisioner deletes its harness and its role (D48).

Uses only lab e2e users (config ``e2e: true``), like ``smoke.py``. It **creates real
resources**: a version in the Agents table and, once approved, an IAM role and an AgentCore
harness for the agent. Retiring the agent (the default) takes it out of the Marketplace and
removes both; the run waits until they are gone, which takes several minutes. The last step
reads AgentCore, IAM and Step Functions with the operator's AWS credentials
(``docs/runbooks/poc-deploy.md``, «Marketplace: prueba de punta a punta»).

``--dry-run`` only reads (sign-in, ``/api/me``, catalogs, review queue): nothing is created.

Run:
  uv run --no-project --with boto3 --with pycognito --with pyotp --with httpx \
    python tests/e2e/marketplace.py --profile mango-sandbox --secrets <path> \
    --creator <admin email> --approver <another admin email> [--outsider <email>] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import boto3
import httpx
from smoke import load_secrets, save_secrets, sign_in, stack_outputs

ROOT_SUPERVISOR = "platform"
COST_TOOL = "cost-explorer.get_cost_and_usage"
PUBLISH_TIMEOUT_S = 600
# Deleting the `live` endpoint took about 7 minutes in the lab; the harness and the role follow.
DEPROVISION_TIMEOUT_S = 1500
POLL_S = 10


class CheckFailedError(Exception):
    """A step did not behave as the plan says; the run stops and reports it."""


@dataclass
class Api:
    app_url: str
    token: str

    def request(self, method: str, path: str, body: Any = None) -> httpx.Response:
        return httpx.request(
            method,
            f"{self.app_url}/api{path}",
            json=body,
            headers={"Authorization": f"Bearer {self.token}"},
            timeout=60,
        )

    def get(self, path: str) -> httpx.Response:
        return self.request("GET", path)

    def post(self, path: str, body: Any) -> httpx.Response:
        return self.request("POST", path, body)


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


def error_code(response: httpx.Response) -> str | None:
    try:
        code = response.json().get("error", {}).get("code")
    except ValueError:
        return None
    return str(code) if code is not None else None


def expect(report: Report, step: str, response: httpx.Response, status: int) -> Any:
    """The JSON body of a response with the expected status, or the run stops."""
    if response.status_code != status:
        raise report.fail(
            step,
            expected=status,
            status=response.status_code,
            error=error_code(response),
            # Rule codes only: the API never echoes the content of a definition.
            violations=_violations(response),
        )
    return response.json() if response.content else None


def _violations(response: httpx.Response) -> list[str]:
    try:
        return sorted({str(v.get("code")) for v in response.json().get("violations", [])})
    except (ValueError, AttributeError):
        return []


def build_definition(report: Report, creator: Api, name: str) -> dict[str, Any]:
    """A definition that meets the submit rules, built from what the installation offers."""
    models = expect(report, "models", creator.get("/models"), 200)["items"]
    with_tools = [m["id"] for m in models if m["supports_tools"]]
    if not with_tools:
        raise report.fail("models", reason="no enabled model supports tools")
    catalog = expect(report, "catalog", creator.get("/mcp/catalog"), 200)["items"]
    tools = {tool["ref"]: tool for connector in catalog for tool in connector["tools"]}
    if COST_TOOL not in tools:
        raise report.fail("catalog", reason=f"{COST_TOOL} is not in the catalog")
    groups = expect(report, "groups", creator.get("/groups"), 200)["items"]
    central = sorted(g["id"] for g in groups if g["type"] == "central")
    if not central:
        raise report.fail("groups", reason="no central group in the registry")
    report.ok("catalogs", models=len(models), tools=len(tools), groups=len(groups))
    return {
        "name": name,
        "description": "Agente temporal de la prueba de punta a punta. Se retira al terminar.",
        "category": "FinOps",
        "icon": "Money",
        "color": 1,
        "reports_to": ROOT_SUPERVISOR,
        "role": "Prueba E2E",
        "model": with_tools[0],
        "allowed_models": [with_tools[0]],
        "system_prompt": (
            "You are a temporary end-to-end test agent of Mango. Answer in Spanish, briefly. "
            "Use the cost tool only when asked about spend."
        ),
        "tools": [COST_TOOL],
        "approval_tools": [],
        "limits": {
            "max_tokens": 1024,
            "max_iterations": 4,
            "timeout_seconds": 60,
            "max_tokens_per_call": None,
            "temperature": None,
        },
        "groups": [central[0]],
        "users": [],
    }


def chat(api: Api, agent_id: str, question: str) -> dict[str, Any]:
    """One turn with a named agent; the text is counted, not printed."""
    summary: dict[str, Any] = {"tools": [], "chars": 0}
    with httpx.stream(
        "POST",
        f"{api.app_url}/api/chat",
        json={"message": question, "agent_id": agent_id},
        headers={"Authorization": f"Bearer {api.token}"},
        timeout=httpx.Timeout(30.0, read=240.0),
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
                if event == "delta":
                    summary["chars"] += len(data.get("text", ""))
                elif event == "tool":
                    summary["tools"].append(f"{data['name']}:{data['status']}")
                elif event == "error":
                    summary["stream_error"] = data.get("code")
                elif event == "done":
                    summary["done"] = True
    return summary


def wait_published(report: Report, approver: Api, url: str) -> dict[str, Any]:
    """Poll the version until the provisioner publishes it or fails."""
    started = time.monotonic()
    while True:
        version = expect(report, "poll", approver.get(url), 200)
        status = version["status"]
        if status == "published":
            report.ok("published", seconds=round(time.monotonic() - started))
            return dict(version)
        if status != "approved":
            raise report.fail(
                "published",
                status=status,
                failed_step=version.get("failed_step"),
                failure=version.get("failure"),
            )
        if time.monotonic() - started > PUBLISH_TIMEOUT_S:
            raise report.fail("published", status=status, reason="timeout")
        time.sleep(POLL_S)


def use_agent(
    report: Report, creator: Api, outsider: Api | None, agent_id: str, question: str
) -> None:
    """Listed for a member of its group, who gets an answer; hidden from anyone else."""
    listed = expect(report, "marketplace", creator.get("/agents"), 200)["items"]
    if not any(a["id"] == agent_id and a["status"] == "published" for a in listed):
        raise report.fail("marketplace", reason="the published agent is not listed")
    report.ok("marketplace", listed=True)
    turn = chat(creator, agent_id, question)
    if turn.get("status") != 200 or not turn.get("done") or turn["chars"] == 0:
        raise report.fail("chat", **turn)
    report.ok("chat", **turn)

    # A user outside its groups neither sees it nor chats with it.
    if outsider is not None:
        hidden = expect(report, "outsider_list", outsider.get("/agents"), 200)["items"]
        detail = outsider.get(f"/agents/{agent_id}")
        refused = chat(outsider, agent_id, question)
        if (
            any(a["id"] == agent_id for a in hidden)
            or detail.status_code != 403
            or refused.get("status") != 403
        ):
            raise report.fail("outsider", detail=detail.status_code, chat=refused.get("status"))
        report.ok("outsider", listed=False, detail=403, chat=403)


def retire(
    report: Report, creator: Api, approver: Api, published: dict[str, Any], question: str
) -> None:
    """Out of the Marketplace's active agents, and no more turns."""
    agent_id = published["agent_id"]
    lock = published["agent"]["lock_version"]
    retired = expect(
        report,
        "retire",
        approver.post(
            f"/agents/{agent_id}/retire",
            {"lock_version": lock, "reason": "Fin de la prueba de punta a punta"},
        ),
        200,
    )
    # Other API tasks may serve their cached copy for up to 15 s (published.CACHE_SECONDS).
    deadline = time.monotonic() + 20
    after = chat(creator, agent_id, question)
    while after.get("status") == 200 and time.monotonic() < deadline:
        time.sleep(3)
        after = chat(creator, agent_id, question)
    if retired["status"] != "retired" or after.get("status") == 200:
        raise report.fail("retire", status=retired["status"], chat=after.get("status"))
    report.ok("retire", status="retired", chat_after=after.get("status"), agent=agent_id)


def _harness_exists(control: Any, name: str) -> bool:
    for page in control.get_paginator("list_harnesses").paginate():
        if any(h["harnessName"] == name for h in page["harnesses"]):
            return True
    return False


def _role_exists(iam: Any, name: str) -> bool:
    try:
        iam.get_role(RoleName=name)
    except iam.exceptions.NoSuchEntityException:
        return False
    return True


def _execution(sfn: Any, machine_arn: str, agent_id: str) -> dict[str, Any] | None:
    """The deprovisioner execution mango-api started for this agent (`<id>-retire-<random>`)."""
    for page in sfn.get_paginator("list_executions").paginate(stateMachineArn=machine_arn):
        for execution in page["executions"]:
            if execution["name"].startswith(f"{agent_id}-retire-"):
                return dict(execution)
    return None


def deprovisioned(
    report: Report, session: boto3.Session, outputs: dict[str, str], namespace: str, agent_id: str
) -> None:
    """Retiring started the deprovisioner: the harness and the role of the agent are deleted."""
    machine = outputs.get("AgentDeprovisionerArn")
    if not machine:
        raise report.fail("deprovisioned", reason="the stack has no AgentDeprovisionerArn output")
    control, iam = session.client("bedrock-agentcore-control"), session.client("iam")
    sfn = session.client("stepfunctions")
    harness, role = f"Mango_{namespace}_a_{agent_id}", f"Mango-{namespace}-agent-{agent_id}"
    started = time.monotonic()
    while True:
        execution = _execution(sfn, machine, agent_id)
        status = execution["status"] if execution else None
        left = {"harness": _harness_exists(control, harness), "role": _role_exists(iam, role)}
        if status == "SUCCEEDED" and not any(left.values()):
            report.ok(
                "deprovisioned",
                seconds=round(time.monotonic() - started),
                execution=execution["name"] if execution else None,
                harness=harness,
                role=role,
            )
            return
        if status in {"FAILED", "TIMED_OUT", "ABORTED"}:
            # The reason is in the `agent.deprovision` audit event (`failed_step`, `failure`).
            raise report.fail("deprovisioned", execution=status, left=left)
        if time.monotonic() - started > DEPROVISION_TIMEOUT_S:
            raise report.fail("deprovisioned", execution=status, left=left, reason="timeout")
        time.sleep(POLL_S)


def dry_run(report: Report, creator: Api, approver: Api) -> None:
    me = expect(report, "me", creator.get("/me"), 200)
    if not me.get("can", {}).get("create_agent"):
        raise report.fail("me", reason="the creator cannot create agents")
    build_definition(report, creator, "dry-run")
    reviews = expect(report, "reviews", approver.get("/agents/reviews"), 200)
    report.ok("reviews", queue=len(reviews["queue"]), history=len(reviews["history"]))
    agents = expect(report, "marketplace", creator.get("/agents"), 200)["items"]
    report.ok("marketplace", agents=len(agents))


def run(
    report: Report,
    creator: Api,
    approver: Api,
    outsider: Api | None,
    *,
    question: str,
    keep: bool,
    session: boto3.Session,
    outputs: dict[str, str],
    namespace: str,
) -> None:
    me = expect(report, "me", creator.get("/me"), 200)
    if not me.get("can", {}).get("create_agent"):
        raise report.fail("me", reason="the creator cannot create agents")
    name = f"E2E {secrets.token_hex(3)}"
    definition = build_definition(report, creator, name)

    # 1. Create and send to review.
    draft = expect(report, "create", creator.post("/agents", {"definition": definition}), 201)
    agent_id, number = draft["agent_id"], draft["version"]
    url = f"/agents/{agent_id}/versions/{number}"
    report.ok("create", agent=agent_id, version=number, status=draft["status"])
    review = expect(
        report, "submit", creator.post(f"{url}/submit", {"revision": draft["revision"]}), 200
    )
    content_hash = review["content_hash"]
    report.ok("submit", status=review["status"], content_hash=content_hash)

    # 2. Its author cannot approve it (D18).
    own = creator.post(f"{url}/approve", {"content_hash": content_hash})
    if (own.status_code, error_code(own)) != (403, "same_approver"):
        raise report.fail("self_approval", status=own.status_code, error=error_code(own))
    report.ok("self_approval", status=403, error="same_approver")

    # 3. Before it is published nobody can use it.
    unpublished = creator.get(f"/agents/{agent_id}")
    if unpublished.status_code not in {403, 404}:
        raise report.fail("not_usable_before_approval", status=unpublished.status_code)
    report.ok("not_usable_before_approval", status=unpublished.status_code)

    # 4. Another administrator reviews and approves the hash they read.
    queue = expect(report, "queue", approver.get("/agents/reviews"), 200)["queue"]
    if not any(item["agent_id"] == agent_id for item in queue):
        raise report.fail("queue", reason="the version is not in the review queue")
    seen = expect(report, "read_for_review", approver.get(url), 200)
    if seen["is_author"] or seen["content_hash"] != content_hash:
        raise report.fail("read_for_review", is_author=seen["is_author"])
    report.ok("read_for_review", changes=seen["diff"]["changes"], violations=seen["violations"])
    approved = expect(
        report, "approve", approver.post(f"{url}/approve", {"content_hash": content_hash}), 200
    )
    report.ok("approve", status=approved["status"], approved_by=approved["approved_by"])
    if approved["status"] == "failed":
        raise report.fail("approve", failed_step=approved.get("failed_step"))

    # 5. The provisioner publishes it.
    published = wait_published(report, approver, url)

    use_agent(report, creator, outsider, agent_id, question)
    if keep:
        report.ok("retire", skipped=True, agent=agent_id)
        return
    retire(report, creator, approver, published, question)
    deprovisioned(report, session, outputs, namespace, agent_id)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--stack", required=True, help="Core stack: Mango-<ns>-Core")
    parser.add_argument("--secrets", required=True, type=Path)
    parser.add_argument("--creator", required=True, help="an administrator (e2e user)")
    parser.add_argument("--approver", required=True, help="another administrator (e2e user)")
    parser.add_argument("--outsider", help="an e2e user outside the central groups")
    parser.add_argument("--question", default="Responde solo: listo.")
    parser.add_argument("--keep", action="store_true", help="do not retire the agent")
    parser.add_argument("--dry-run", action="store_true", help="only read; create nothing")
    args = parser.parse_args()
    if args.creator == args.approver:
        raise SystemExit("--creator and --approver must be different administrators")

    session = boto3.Session(profile_name=args.profile, region_name="us-east-1")
    outputs = stack_outputs(session, args.stack)
    store = load_secrets(args.secrets)
    idp = session.client("cognito-idp")
    try:
        tokens = {
            email: sign_in(idp, outputs["UserPoolId"], outputs["WebClientId"], email, store)
            for email in (args.creator, args.approver, args.outsider)
            if email
        }
    finally:
        save_secrets(args.secrets, store)

    app_url = outputs["AppUrl"]
    creator, approver = Api(app_url, tokens[args.creator]), Api(app_url, tokens[args.approver])
    outsider = Api(app_url, tokens[args.outsider]) if args.outsider else None
    report = Report()
    try:
        if args.dry_run:
            dry_run(report, creator, approver)
        else:
            run(
                report,
                creator,
                approver,
                outsider,
                question=args.question,
                keep=args.keep,
                session=session,
                outputs=outputs,
                # `Mango-<ns>-Core`.
                namespace=args.stack.split("-")[1],
            )
    except CheckFailedError as failed:
        print(json.dumps({"result": "failed", "step": str(failed)}), flush=True)
        sys.exit(1)
    print(json.dumps({"result": "ok", "steps": len(report.steps)}), flush=True)


if __name__ == "__main__":
    main()
