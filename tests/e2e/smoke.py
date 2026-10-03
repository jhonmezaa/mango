"""End-to-end smoke test for the FinOps PoC against a deployed lab installation.

Uses only lab e2e users (config `e2e: true`). Their password is set with the admin API and
their TOTP secret is enrolled on first sign-in; both are kept in a local secrets file outside
the repository (never commit it).

Run:
  uv run --no-project --with boto3 --with pycognito --with pyotp --with httpx \
    python tests/e2e/smoke.py --profile mango-sandbox --secrets <path> --user <email> \
    --question "¿Cuánto gastamos este mes?"
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import stat
import string
import sys
from pathlib import Path
from typing import Any

import boto3
import httpx
import pyotp
from pycognito.aws_srp import AWSSRP


def stack_outputs(session: boto3.Session, stack: str) -> dict[str, str]:
    cfn = session.client("cloudformation")
    outputs = cfn.describe_stacks(StackName=stack)["Stacks"][0]["Outputs"]
    return {o["OutputKey"]: o["OutputValue"] for o in outputs}


def load_secrets(path: Path) -> dict[str, dict[str, str]]:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def save_secrets(path: Path, data: dict[str, dict[str, str]]) -> None:
    path.write_text(json.dumps(data, indent=2))
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def new_password() -> str:
    alphabet = string.ascii_letters + string.digits
    core = "".join(secrets.choice(alphabet) for _ in range(24))
    return f"{core}aA1!"


def sign_in(
    idp: Any, pool_id: str, client_id: str, email: str, store: dict[str, dict[str, str]]
) -> str:
    entry = store.setdefault(email, {})
    if "password" not in entry:
        entry["password"] = new_password()
        idp.admin_set_user_password(
            UserPoolId=pool_id, Username=email, Password=entry["password"], Permanent=True
        )
    srp = AWSSRP(
        username=email,
        password=entry["password"],
        pool_id=pool_id,
        client_id=client_id,
        client=idp,
    )
    resp = idp.initiate_auth(
        AuthFlow="USER_SRP_AUTH", AuthParameters=srp.get_auth_params(), ClientId=client_id
    )
    if resp.get("ChallengeName") == "PASSWORD_VERIFIER":
        resp = idp.respond_to_auth_challenge(
            ClientId=client_id,
            ChallengeName="PASSWORD_VERIFIER",
            ChallengeResponses=srp.process_challenge(
                resp["ChallengeParameters"], srp.get_auth_params()
            ),
        )
    challenge = resp.get("ChallengeName")
    if challenge == "MFA_SETUP":
        assoc = idp.associate_software_token(Session=resp["Session"])
        entry["totp"] = assoc["SecretCode"]
        verified = idp.verify_software_token(
            Session=assoc["Session"], UserCode=pyotp.TOTP(entry["totp"]).now()
        )
        resp = idp.respond_to_auth_challenge(
            ClientId=client_id,
            ChallengeName="MFA_SETUP",
            Session=verified["Session"],
            ChallengeResponses={"USERNAME": email},
        )
    elif challenge == "SOFTWARE_TOKEN_MFA":
        resp = idp.respond_to_auth_challenge(
            ClientId=client_id,
            ChallengeName="SOFTWARE_TOKEN_MFA",
            Session=resp["Session"],
            ChallengeResponses={
                "USERNAME": email,
                "SOFTWARE_TOKEN_MFA_CODE": pyotp.TOTP(entry["totp"]).now(),
            },
        )
    if "AuthenticationResult" not in resp:
        raise SystemExit(f"unexpected challenge: {resp.get('ChallengeName')}")
    return str(resp["AuthenticationResult"]["AccessToken"])


def chat(app_url: str, token: str, question: str, conversation_id: str | None) -> dict[str, Any]:
    body: dict[str, Any] = {"message": question}
    if conversation_id:
        body["conversation_id"] = conversation_id
    summary: dict[str, Any] = {"tools": [], "text": "", "events": 0}
    with httpx.stream(
        "POST",
        f"{app_url}/api/chat",
        json=body,
        headers={"Authorization": f"Bearer {token}"},
        timeout=httpx.Timeout(30.0, read=180.0),
    ) as resp:
        summary["status"] = resp.status_code
        if resp.status_code != 200:
            summary["error"] = resp.read().decode()
            return summary
        event = None
        for line in resp.iter_lines():
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: ") and event:
                data = json.loads(line[6:])
                summary["events"] = summary.get("events", 0) + 1
                if event == "delta":
                    summary["text"] += data["text"]
                elif event == "tool":
                    summary["tools"].append(f"{data['name']}:{data['status']}")
                elif event in {"done", "error", "conversation"}:
                    summary[event] = data
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--stack", default="Mango-poc-Core")
    parser.add_argument("--secrets", required=True, type=Path)
    parser.add_argument("--user", required=True)
    parser.add_argument("--question", action="append", default=[])
    parser.add_argument("--me", action="store_true")
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

    app_url = outputs["AppUrl"]
    if args.me:
        me = httpx.get(f"{app_url}/api/me", headers={"Authorization": f"Bearer {token}"})
        print(json.dumps({"me": me.status_code, "body": me.json()}, ensure_ascii=False))
    conversation_id = None
    for question in args.question:
        result = chat(app_url, token, question, conversation_id)
        conversation_id = (result.get("conversation") or {}).get("conversation_id")
        print(json.dumps({"question": question, **result}, ensure_ascii=False, indent=2))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
