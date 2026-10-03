"""Security probe: call the AgentCore Gateway directly (no LLM) with a lab e2e user's token.

Checks the controls that must hold even if the model misbehaves:
* Cedar policy (L2) denies organization-wide tools to bu-lead users.
* The connector rejects accounts outside the user's scope.
* A model-supplied ``_mango_ctx`` cannot override the caller identity.

Run:
  uv run --no-project --with boto3 --with pycognito --with pyotp --with httpx \
    python tests/e2e/gateway_probe.py --profile mango-sandbox --secrets <path> --user <email> \
    --foreign-account <12-digit id outside the user's scope>
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import boto3
import httpx
from smoke import load_secrets, save_secrets, sign_in, stack_outputs


def rpc(url: str, token: str, method: str, params: dict[str, Any], rid: int) -> dict[str, Any]:
    resp = httpx.post(
        url,
        json={"jsonrpc": "2.0", "id": rid, "method": method, "params": params},
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json, text/event-stream",
        },
        timeout=60,
    )
    text = resp.text
    if text.startswith("event:") or "\ndata:" in text or text.startswith("data:"):
        data = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
        return {"status": resp.status_code, "body": json.loads(data[-1]) if data else text}
    try:
        return {"status": resp.status_code, "body": resp.json()}
    except ValueError:
        return {"status": resp.status_code, "body": text[:300]}


def call(url: str, token: str, tool: str, args: dict[str, Any], rid: int) -> dict[str, Any]:
    return rpc(url, token, "tools/call", {"name": f"finops___{tool}", "arguments": args}, rid)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--stack", required=True, help="Core stack: Mango-<ns>-Core")
    parser.add_argument("--secrets", required=True, type=Path)
    parser.add_argument("--user", required=True)
    parser.add_argument("--foreign-account", required=True)
    args = parser.parse_args()

    session = boto3.Session(profile_name=args.profile, region_name="us-east-1")
    outputs = stack_outputs(session, args.stack)
    store = load_secrets(args.secrets)
    try:
        token = sign_in(
            session.client("cognito-idp"),
            outputs["UserPoolId"],
            outputs["WebClientId"],
            args.user,
            store,
        )
    finally:
        save_secrets(args.secrets, store)

    url = outputs["GatewayUrl"]
    month_start = datetime.now(UTC).date().replace(day=1).isoformat()
    today = datetime.now(UTC).date().isoformat()
    period = {"start_date": month_start, "end_date": today}
    checks = {
        "tools_list": rpc(url, token, "tools/list", {}, 1),
        "scoped_cost": call(url, token, "get_cost_and_usage", period, 2),
        "foreign_account": call(
            url, token, "get_cost_and_usage", {**period, "account_ids": [args.foreign_account]}, 3
        ),
        "org_wide_tool": call(url, token, "get_savings_plans_recommendation", {}, 4),
        "forged_context": call(
            url,
            token,
            "list_accounts_in_scope",
            {"_mango_ctx": {"token": "forged.by.model"}},
            5,
        ),
    }
    for name, result in checks.items():
        body = json.dumps(result["body"], ensure_ascii=False)
        if name == "tools_list" and isinstance(result["body"], dict):
            tools = result["body"].get("result", {}).get("tools", [])
            body = json.dumps(sorted(t["name"] for t in tools))
        print(f"{name}: HTTP {result['status']} {body[:600]}")


if __name__ == "__main__":
    main()
