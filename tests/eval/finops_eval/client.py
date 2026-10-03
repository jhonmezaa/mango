"""Sign-in (Cognito SRP + TOTP) and the real ``/api/chat`` SSE stream.

Tokens and secrets stay in memory: nothing here logs or stores them. The secrets file is
only read; e2e users are enrolled with ``tests/e2e/smoke.py``.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx
from botocore.exceptions import ClientError

from finops_eval.model import ChatResult

if TYPE_CHECKING:
    from mypy_boto3_cognito_idp import CognitoIdentityProviderClient

TOTP_STEP_SECONDS = 30
CONNECT_TIMEOUT = 30.0
READ_TIMEOUT = 330.0  # just above the agent's own timeout
MAX_ERROR_CHARS = 200


class SignInError(Exception):
    """Sign-in failed; the message never contains credentials."""


@dataclass(frozen=True, repr=False)
class Credentials:
    """E2E user credentials; ``repr`` is disabled so they cannot end up in a log."""

    email: str
    password: str
    totp: str


def load_credentials(path: Path, email: str) -> Credentials:
    entry = json.loads(path.read_text()).get(email)
    if not isinstance(entry, dict) or "password" not in entry or "totp" not in entry:
        raise SignInError(f"no e2e credentials for {email}; enroll the user with smoke.py first")
    return Credentials(email, str(entry["password"]), str(entry["totp"]))


def _wait_for_next_totp_step() -> None:
    time.sleep(TOTP_STEP_SECONDS - (time.time() % TOTP_STEP_SECONDS) + 1)


def sign_in(
    idp: CognitoIdentityProviderClient, pool_id: str, client_id: str, credentials: Credentials
) -> str:
    """Return an access token. A TOTP code is valid once, so a rejected code waits for the
    next 30 s step and retries a single time."""
    import pyotp  # noqa: PLC0415 - only needed for a live run
    from pycognito.aws_srp import AWSSRP  # noqa: PLC0415

    email, password, totp_secret = credentials.email, credentials.password, credentials.totp
    for attempt in range(2):
        srp = AWSSRP(
            username=email, password=password, pool_id=pool_id, client_id=client_id, client=idp
        )
        resp: Any = idp.initiate_auth(
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
        if resp.get("ChallengeName") == "SOFTWARE_TOKEN_MFA":
            try:
                resp = idp.respond_to_auth_challenge(
                    ClientId=client_id,
                    ChallengeName="SOFTWARE_TOKEN_MFA",
                    Session=resp["Session"],
                    ChallengeResponses={
                        "USERNAME": email,
                        "SOFTWARE_TOKEN_MFA_CODE": pyotp.TOTP(totp_secret).now(),
                    },
                )
            except ClientError as exc:
                code = exc.response.get("Error", {}).get("Code")
                if attempt == 0 and code in {"CodeMismatchException", "ExpiredCodeException"}:
                    _wait_for_next_totp_step()
                    continue
                raise SignInError(f"MFA rejected for {email}: {code}") from None
        if "AuthenticationResult" in resp:
            return str(resp["AuthenticationResult"]["AccessToken"])
        challenge = resp.get("ChallengeName")
        if challenge == "MFA_SETUP":
            raise SignInError(f"{email} has no MFA enrolled; enroll it with tests/e2e/smoke.py")
        raise SignInError(f"unexpected challenge for {email}: {challenge}")
    raise SignInError(f"could not sign in {email}")


def _decimal(value: object) -> Decimal:
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return Decimal(0)


def _apply(result: ChatResult, event: str, data: dict[str, Any], elapsed: float) -> None:
    if event == "delta":
        text = str(data.get("text", ""))
        if text.strip() and result.first_token_seconds is None:
            result.first_token_seconds = elapsed
        result.text += text
    elif event == "tool":
        result.tools.append(f"{data.get('name')}:{data.get('status')}")
    elif event == "done":
        usage = data.get("usage") or {}
        result.input_tokens = int(usage.get("input_tokens", 0))
        result.output_tokens = int(usage.get("output_tokens", 0))
        result.cost_usd = _decimal(data.get("cost_usd", "0"))
        result.stop_reason = str(data.get("stop_reason", ""))
    elif event == "error":
        result.error_code = str(data.get("code", "error"))


def ask(client: httpx.Client, app_url: str, token: str, question: str) -> ChatResult:
    """Ask one question in a new conversation. Never retries (a 402 must be reported)."""
    started = time.monotonic()
    result = ChatResult(status=0)
    try:
        with client.stream(
            "POST",
            f"{app_url}/api/chat",
            json={"message": question},
            headers={"Authorization": f"Bearer {token}"},
        ) as resp:
            result.status = resp.status_code
            if resp.status_code != httpx.codes.OK:
                result.error_code = _error_code(resp.read())
                return result
            event: str | None = None
            for line in resp.iter_lines():
                if line.startswith("event: "):
                    event = line[7:]
                elif line.startswith("data: ") and event:
                    _apply(result, event, json.loads(line[6:]), time.monotonic() - started)
    except httpx.HTTPError as exc:
        # Only the exception type: messages may echo the request.
        result.error_code = f"transport:{type(exc).__name__}"
    finally:
        result.total_seconds = time.monotonic() - started
    return result


def _error_code(body: bytes) -> str:
    try:
        payload = json.loads(body)
    except ValueError:
        return "http_error"
    error = payload.get("error") if isinstance(payload, dict) else None
    code = error.get("code") if isinstance(error, dict) else None
    return str(code or payload.get("detail") or "http_error")[:MAX_ERROR_CHARS]


def http_client() -> httpx.Client:
    # The URL comes from the stack outputs or the operator, never from an answer; redirects
    # are not followed so the bearer token cannot be forwarded to another host.
    return httpx.Client(
        timeout=httpx.Timeout(CONNECT_TIMEOUT, read=READ_TIMEOUT), follow_redirects=False
    )
