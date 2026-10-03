"""End-to-end test of write tools with approval (D27) against a deployed lab installation.

What it proves, with the first write tool (``aws-budgets.create_budget``, payer account):

1. The policy of the tool changes only with two administrators.
2. An agent with the write tool is published only when it marks it for approval.
3. A call below the threshold becomes a request the person who asked confirms: nothing exists
   in AWS Budgets until then, and afterwards exactly the budget of the stored arguments does.
4. The Gateway refuses the tool without an approval, even with a valid session
   (``approval_required``), and a confirmed request cannot be run twice.
5. A call above the threshold needs approvers: who asked cannot sign it, an approver cannot
   run it, and who asked runs it once it is signed.
6. CloudTrail of the payer account names the person (``SourceIdentity``) and the approval
   (session tag) of each ``CreateBudget``: printed for the operator, it takes minutes to show.

Uses only lab e2e users (config ``e2e: true``), like ``marketplace.py``. It **creates real
resources**: an agent (role and harness, retired at the end unless ``--keep``), one policy
proposal, and up to two budgets named ``Mango-<ns>-e2e-…`` in the payer account, which are
deleted at the end with the operator's credentials of that account (``--payer-profile``).
Budgets are free and notify nobody.

Needs the Core and Payer stacks of this release deployed (``docs/runbooks/poc-deploy.md``).

Run:
  uv run --no-project --with boto3 --with pycognito --with pyotp --with httpx \
    python tests/e2e/write_approval.py --profile mango-sandbox --payer-profile mango-mgmt \
    --secrets <path> --requester <central admin> --approver <another central admin>
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
from pathlib import Path
from typing import Any

import boto3
import httpx
from botocore.exceptions import ClientError
from marketplace import (
    Api,
    CheckFailedError,
    Report,
    build_definition,
    error_code,
    expect,
    retire,
    wait_published,
)
from smoke import load_secrets, save_secrets, sign_in, stack_outputs

TOOL = "aws-budgets.create_budget"
GATEWAY_TOOL = "ops___create_budget"
THRESHOLD_USD = "500"
SMALL_USD = 25
LARGE_USD = 2500


def chat_for_approval(api: Api, agent_id: str, question: str) -> dict[str, Any]:
    """One turn; returns the approval request the turn created (the SSE ``approval`` event)."""
    summary: dict[str, Any] = {"approvals": [], "tools": []}
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
                if event == "approval":
                    summary["approvals"].append(data)
                elif event == "tool":
                    summary["tools"].append(f"{data['name']}:{data['status']}")
                elif event == "error":
                    summary["stream_error"] = data.get("code")
    return summary


def budget(payer: Any, account_id: str, name: str) -> dict[str, Any] | None:
    try:
        found: dict[str, Any] = payer.describe_budget(AccountId=account_id, BudgetName=name)[
            "Budget"
        ]
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "NotFoundException":
            return None
        raise
    return found


def ensure_policy(report: Report, proposer: Api, approver: Api) -> None:
    """Up to USD 500 the person who asked confirms; above, one approver. With two admins."""
    view = expect(report, "policies", proposer.get("/approvals/policies"), 200)
    tool = next((t for t in view["tools"] if t["tool"] == TOOL), None)
    if tool is None:
        raise report.fail("policies", reason=f"{TOOL} is not a write tool of this release")
    wanted = {"condition": "amount", "amount_usd": THRESHOLD_USD, "approvers": 1}
    current = tool["policy"]
    if all(str(current.get(k)) == str(v) for k, v in wanted.items()):
        report.ok("policy", already=True, version=tool["version"])
        return
    created = proposer.post(
        f"/approvals/policies/{TOOL}/changes",
        {
            **wanted,
            "expires_hours": 1,
            "base_version": tool["version"],
            "reason": "E2E: small budgets are confirmed by who asks",
        },
    )
    change_id = expect(report, "policy_propose", created, 201)["change_id"]
    own = proposer.post(f"/approvals/policies/changes/{change_id}/approve", {})
    if (own.status_code, error_code(own)) != (403, "same_approver"):
        raise report.fail("policy_self_approval", status=own.status_code, error=error_code(own))
    report.ok("policy_self_approval", status=403, error="same_approver")
    applied = expect(
        report,
        "policy_approve",
        approver.post(f"/approvals/policies/changes/{change_id}/approve", {}),
        200,
    )
    after = next(t for t in applied["tools"] if t["tool"] == TOOL)
    report.ok("policy", version=after["version"], policy=after["policy"])


def publish_agent(report: Report, creator: Api, approver: Api) -> tuple[str, dict[str, Any]]:
    """An agent whose only tool is the write tool, marked for approval."""
    definition = build_definition(report, creator, f"E2E escritura {secrets.token_hex(3)}")
    definition |= {
        "tools": [TOOL],
        "system_prompt": (
            "You are a temporary end-to-end test agent of Mango. When asked to create a "
            "budget, call create_budget once with exactly the name and amount given. Answer "
            "in Spanish, briefly."
        ),
    }
    # A write tool nobody marked for approval never reaches review (submit rules).
    unmarked = creator.post("/agents", {"definition": {**definition, "approval_tools": []}})
    draft = expect(report, "create_unmarked", unmarked, 201)
    url = f"/agents/{draft['agent_id']}/versions/{draft['version']}"
    refused = creator.post(f"{url}/submit", {"revision": draft["revision"]})
    if refused.status_code != 422:
        raise report.fail("unmarked_write_tool", status=refused.status_code)
    report.ok("unmarked_write_tool", status=422, error=error_code(refused))
    creator.request("DELETE", url)

    draft = expect(
        report,
        "create",
        creator.post("/agents", {"definition": {**definition, "approval_tools": [TOOL]}}),
        201,
    )
    agent_id = draft["agent_id"]
    url = f"/agents/{agent_id}/versions/{draft['version']}"
    review = expect(
        report, "submit", creator.post(f"{url}/submit", {"revision": draft["revision"]}), 200
    )
    approved = expect(
        report,
        "approve",
        approver.post(f"{url}/approve", {"content_hash": review["content_hash"]}),
        200,
    )
    if approved["status"] == "failed":
        raise report.fail("approve", failed_step=approved.get("failed_step"))
    return agent_id, wait_published(report, approver, url)


def gateway_refuses(report: Report, gateway_url: str, token: str, name: str) -> None:
    """A valid session alone never reaches the tool: no invocation signature, no approval."""
    response = httpx.post(
        gateway_url,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": GATEWAY_TOOL, "arguments": {"name": name, "amount_usd": 1}},
        },
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json, text/event-stream",
        },
        timeout=60,
    )
    refused = response.status_code in {401, 403} or '"error"' in response.text
    if not refused:
        raise report.fail("gateway_direct_call", status=response.status_code)
    report.ok("gateway_direct_call", status=response.status_code, refused=True)


def one_request(
    report: Report, step: str, requester: Api, agent_id: str, *, name: str, amount: int, tier: str
) -> dict[str, Any]:
    turn = chat_for_approval(
        requester, agent_id, f"Crea un presupuesto llamado {name} de {amount} USD."
    )
    if len(turn["approvals"]) != 1:
        raise report.fail(step, turn={k: v for k, v in turn.items() if k != "approvals"})
    request: dict[str, Any] = turn["approvals"][0]
    arguments = request["arguments"]
    # The tier comes from the stored arguments and the policy, never from the model's text.
    if (
        request["tier"] != tier
        or request["tool"] != TOOL
        or arguments.get("name") != name
        or float(arguments.get("amount_usd", 0)) != float(amount)
    ):
        raise report.fail(step, tier=request["tier"], rule=request["rule"], arguments=arguments)
    report.ok(step, approval=request["approval_id"], tier=tier, rule=request["rule"])
    return request


def run(  # noqa: PLR0912, PLR0915 - one linear scenario, step by step
    report: Report,
    requester: Api,
    approver: Api,
    *,
    payer: Any,
    payer_account: str,
    namespace: str,
    gateway_url: str,
    keep: bool,
    created: list[str],
) -> None:
    """``created`` collects the budgets that exist, so a failed run still cleans them up."""
    ensure_policy(report, requester, approver)
    agent_id, published = publish_agent(report, requester, approver)
    suffix = secrets.token_hex(3)
    small, large = f"e2e-{suffix}-a", f"e2e-{suffix}-b"
    prefix = f"Mango-{namespace}-"

    # --- Below the threshold: the person who asked confirms -----------------------------
    request = one_request(
        report, "self_request", requester, agent_id, name=small, amount=SMALL_USD, tier="self"
    )
    if budget(payer, payer_account, prefix + small) is not None:
        raise report.fail("nothing_before_confirmation", reason="the budget already exists")
    report.ok("nothing_before_confirmation")
    gateway_refuses(report, gateway_url, requester.token, small)
    other = approver.post(f"/approvals/{request['approval_id']}/confirm", {})
    if other.status_code != 404:
        raise report.fail("only_who_asked_confirms", status=other.status_code)
    report.ok("only_who_asked_confirms", status=404)
    done = expect(
        report,
        "self_confirm",
        requester.post(f"/approvals/{request['approval_id']}/confirm", {}),
        200,
    )
    if done["status"] != "executed":
        raise report.fail("self_confirm", status=done["status"], error=done.get("error"))
    created.append(prefix + small)
    found = budget(payer, payer_account, prefix + small)
    if found is None or float(found["BudgetLimit"]["Amount"]) != float(SMALL_USD):
        raise report.fail("budget_created", found=bool(found))
    report.ok("budget_created", name=prefix + small, amount=found["BudgetLimit"]["Amount"])
    again = requester.post(f"/approvals/{request['approval_id']}/confirm", {})
    if again.status_code != 409:
        raise report.fail("single_use", status=again.status_code)
    report.ok("single_use", status=409)

    # --- Above the threshold: another person signs, who asked runs it -------------------
    request = one_request(
        report,
        "approvers_request",
        requester,
        agent_id,
        name=large,
        amount=LARGE_USD,
        tier="approvers",
    )
    approval = f"/approvals/{request['approval_id']}"
    own = requester.post(f"{approval}/approve", {})
    if (own.status_code, error_code(own)) != (403, "own_request"):
        raise report.fail("own_request", status=own.status_code, error=error_code(own))
    early = requester.post(f"{approval}/execute", {})
    if early.status_code != 409:
        raise report.fail("not_before_approval", status=early.status_code)
    report.ok("separation_of_duties", own_request=403, execute_before_approval=409)
    signed = expect(
        report, "approve_call", approver.post(f"{approval}/approve", {"note": "e2e"}), 200
    )
    if signed["status"] != "approved" or budget(payer, payer_account, prefix + large):
        raise report.fail("approve_call", status=signed["status"])
    not_theirs = approver.post(f"{approval}/execute", {})
    if not_theirs.status_code != 404:
        raise report.fail("only_who_asked_runs", status=not_theirs.status_code)
    report.ok("approve_call", status="approved", approver_cannot_run=404)
    ran = expect(report, "execute", requester.post(f"{approval}/execute", {}), 200)
    if ran["status"] != "executed":
        raise report.fail("execute", status=ran["status"], error=ran.get("error"))
    created.append(prefix + large)
    if budget(payer, payer_account, prefix + large) is None:
        raise report.fail("approved_budget_created")
    report.ok("approved_budget_created", name=prefix + large)

    report.ok(
        "cloudtrail_hint",
        note=(
            "In a few minutes, CloudTrail of the payer account shows CreateBudget by role "
            f"Mango-{namespace}-BudgetsOperator with sourceIdentity = the requester's sub."
        ),
    )
    if keep:
        report.ok("retire", skipped=True, agent=agent_id)
    else:
        retire(report, requester, approver, published, "Responde solo: listo.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True, help="Mango account (stack outputs, Cognito)")
    parser.add_argument("--payer-profile", required=True, help="payer account: verify and delete")
    parser.add_argument("--stack", required=True, help="Core stack: Mango-<ns>-Core")
    parser.add_argument("--namespace", help="default: the middle part of the stack name")
    parser.add_argument("--secrets", required=True, type=Path)
    parser.add_argument("--requester", required=True, help="central FinOps administrator (e2e)")
    parser.add_argument("--approver", required=True, help="another central administrator (e2e)")
    parser.add_argument("--keep", action="store_true", help="keep the agent and the budgets")
    args = parser.parse_args()
    args.namespace = args.namespace or args.stack.split("-")[1]

    session = boto3.Session(profile_name=args.profile, region_name="us-east-1")
    payer_session = boto3.Session(profile_name=args.payer_profile, region_name="us-east-1")
    payer = payer_session.client("budgets")
    payer_account = payer_session.client("sts").get_caller_identity()["Account"]
    outputs = stack_outputs(session, args.stack)
    store = load_secrets(args.secrets)
    idp = session.client("cognito-idp")
    report = Report()
    created: list[str] = []
    try:
        tokens = [
            sign_in(idp, outputs["UserPoolId"], outputs["WebClientId"], email, store)
            for email in (args.requester, args.approver)
        ]
        save_secrets(args.secrets, store)
        requester, approver = (Api(outputs["AppUrl"], token) for token in tokens)
        run(
            report,
            requester,
            approver,
            payer=payer,
            payer_account=payer_account,
            namespace=args.namespace,
            gateway_url=outputs["GatewayUrl"],
            keep=args.keep,
            created=created,
        )
    except CheckFailedError:
        sys.exit(1)
    finally:
        if not args.keep:
            # Cleanup by SDK with the operator's credentials of the payer account.
            for name in created:
                try:
                    payer.delete_budget(AccountId=payer_account, BudgetName=name)
                    report.ok("cleanup", deleted=name)
                except ClientError as exc:
                    report.ok("cleanup", failed=name, error=exc.response["Error"]["Code"])


if __name__ == "__main__":
    main()
