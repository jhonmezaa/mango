"""AgentCore Gateway REQUEST interceptor (D13, D33; TM-I1, TM-M12).

The Gateway has already validated the caller's JWT. For every ``tools/call`` this
interceptor removes any ``_mango_ctx`` the model may have supplied. For a tool of a Mango
connector it then sets it to the bearer token from the ``Authorization`` header, so the
Lambda target can re-verify it. Tools of any other target (MCP packs: third-party servers)
never receive the caller's token (D33, spec §5.3): their schema does not know the argument
and their code must not hold a credential that works against the connectors.
Requests without a bearer token are short-circuited. Headers and bodies are never logged.

A pack over account data (``central_only``, D37) still has to act for the person who asked
(rule 5), without ever seeing the token: for its tools ``_mango_ctx`` carries an assertion
signed with a KMS key only this function can use, naming the user, the pack, the tool and the
agent, valid for one call (``mango_core.pack_identity``). It is issued only to users whose
validated token says ``mango_central``: the pack does not filter by area (TM-M3), so Cedar
L2, this check and the pack's own entry point all refuse anyone else.

Every request must also carry the ``X-Mango-Invocation`` signature issued by mango-api for the
token's subject (audit finding F1): a user's token alone cannot be used to call the Gateway
directly and skip mango-api's authorization, budget and audit. Only v2 signatures are accepted:
they name the agent version in use and its tools, so a ``tools/call`` for any other tool is
rejected, whatever Cedar (L2) would allow that user: the Gateway itself only sees the user,
not the agent.

No write tool runs without a person confirming it (D27, TM-W1). For the write tools of the
release (``APPROVAL_TOOLS``, a closed list) the request must also carry ``X-Mango-Approval``:
a token mango-api signed with a KMS key only it can use, bound to this user, this tool and
the hash of these arguments, which is then spent on the request it names (single use). An
agent calling such a tool on its own has no token and is refused here; mango-api turns that
call into a request for confirmation. Anything that cannot be verified fails closed.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from functools import cache
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from mango_core import approval, approval_use, invocation, pack_identity

logger = logging.getLogger()
logger.setLevel(logging.INFO)

RESERVED_CONTEXT_ARG = "_mango_ctx"
OUTPUT_VERSION = "1.0"
_BEARER = "bearer "
_TARGET_SEPARATOR = "___"
_CONTEXT_TARGETS_ENV = "CONTEXT_TARGETS"
_IDENTITY_TARGETS_ENV = "IDENTITY_TARGETS"
_IDENTITY_KEY_ENV = "PACK_IDENTITY_KEY_ARN"
_APPROVAL_TOOLS_ENV = "APPROVAL_TOOLS"
_APPROVAL_KEY_ENV = "APPROVAL_KEY_ARN"
_APPROVALS_TABLE_ENV = "APPROVALS_TABLE"
_CENTRAL_CLAIM = "mango_central"
APPROVAL_REQUIRED_MESSAGE = (
    "This action changes resources and needs a person's confirmation in Mango. It was NOT "
    "executed. A confirmation request was shown to the user: do not call this tool again; "
    "tell the user to confirm or cancel it there."
)
"""Fixed text the model reads as the tool's answer: no data from the request."""
_UNAUTHENTICATED = -32001
_FORBIDDEN = -32003
_UNAVAILABLE = -32000
# One signature per tool call, inside the Gateway's own time budget for the interceptor.
_KMS_CONFIG = Config(
    retries={"mode": "standard", "max_attempts": 2}, connect_timeout=2, read_timeout=3
)


@dataclass(frozen=True)
class PackIdentities:
    """Issues the caller assertion of packs over account data (D37)."""

    targets: frozenset[str]
    """Gateway targets (pack ids) of the release's ``central_only`` packs."""
    sign: Callable[[bytes], bytes]
    """ECDSA P-256 signature (DER) of a SHA-256 digest, by the pack identity key."""
    clock: Callable[[], float] = time.time

    def assertion(self, *, subject: str, target: str, tool: str, agent_id: str) -> str:
        claims = pack_identity.encode_claims(
            subject=subject,
            pack_id=target,
            tool=tool,
            agent_id=agent_id,
            central=True,
            expires_at=int(self.clock()) + pack_identity.TTL_SECONDS,
        )
        return pack_identity.assemble(claims, self.sign(pack_identity.signing_digest(claims)))


@dataclass(frozen=True)
class Approvals:
    """Checks the approval of write tool calls (D27)."""

    tools: frozenset[str]
    """Gateway names of the release's write tools: none runs without an approval."""
    verifier: Callable[[], approval.ApprovalVerifier]
    """Verifies with the public half of the approval key (read once per environment)."""
    claim: Callable[[approval.Approval, int], None]
    """Spends the approval on its request; raises ``ApprovalUsedError`` if it cannot."""
    clock: Callable[[], float] = time.time

    def check(
        self, token: object, *, subject: str, agent_id: str, tool: str, arguments: object
    ) -> None:
        """Raises unless ``token`` approves exactly this call and was not used before."""
        approved = self.verifier().verify(token, subject=subject, tool=tool, arguments=arguments)
        if approved.agent_id != agent_id:
            # Approved for another agent than the one this invocation was signed for.
            raise approval.ApprovalError
        self.claim(approved, int(self.clock()))


def _bearer_token(headers: dict[str, Any]) -> str | None:
    for key, value in headers.items():
        if (
            key.lower() == "authorization"
            and isinstance(value, str)
            and value[: len(_BEARER)].lower() == _BEARER
            and len(value) > len(_BEARER)
        ):
            return value[len(_BEARER) :].strip()
    return None


@cache
def _invocation_key() -> bytes:
    secret = boto3.client("secretsmanager").get_secret_value(
        SecretId=os.environ["INVOCATION_KEY_SECRET_ARN"]
    )
    return str(secret["SecretString"]).encode()


@cache
def _context_targets() -> frozenset[str]:
    """Gateway targets of Mango connectors (stack configuration, a closed list)."""
    targets = json.loads(os.environ[_CONTEXT_TARGETS_ENV])
    if not isinstance(targets, list) or not all(isinstance(t, str) and t for t in targets):
        raise ValueError(f"{_CONTEXT_TARGETS_ENV} must be a list of target names")
    return frozenset(targets)


@cache
def _pack_identities() -> PackIdentities:
    """Packs over account data of the release and the key that signs for them (stack
    configuration). A release without such packs has no targets and never calls KMS."""
    raw = json.loads(os.environ.get(_IDENTITY_TARGETS_ENV, "[]"))
    if not isinstance(raw, list) or not all(isinstance(t, str) and t for t in raw):
        raise ValueError(f"{_IDENTITY_TARGETS_ENV} must be a list of target names")
    targets = frozenset(raw)
    if targets & _context_targets():
        # A target gets the token or an assertion, never both.
        raise ValueError("a target cannot be both a connector and a pack")
    key_arn = os.environ.get(_IDENTITY_KEY_ENV, "")
    if targets and not key_arn:
        raise ValueError(f"{_IDENTITY_KEY_ENV} is required")
    kms = boto3.client("kms", config=_KMS_CONFIG)

    def sign(digest: bytes) -> bytes:
        signature: bytes = kms.sign(
            KeyId=key_arn,
            Message=digest,
            MessageType="DIGEST",
            SigningAlgorithm=pack_identity.SIGNING_ALGORITHM,
        )["Signature"]
        return signature

    return PackIdentities(targets=targets, sign=sign)


@cache
def _approvals() -> Approvals:
    """Write tools of the release and how their approvals are checked (stack configuration).
    A release without write tools has an empty list and never calls KMS or DynamoDB."""
    raw = json.loads(os.environ.get(_APPROVAL_TOOLS_ENV, "[]"))
    if not isinstance(raw, list) or not all(isinstance(t, str) and t for t in raw):
        raise ValueError(f"{_APPROVAL_TOOLS_ENV} must be a list of tool names")
    tools = frozenset(raw)
    key_arn = os.environ.get(_APPROVAL_KEY_ENV, "")
    table = os.environ.get(_APPROVALS_TABLE_ENV, "")
    if tools and not (key_arn and table):
        raise ValueError(f"{_APPROVAL_KEY_ENV} and {_APPROVALS_TABLE_ENV} are required")
    kms = boto3.client("kms", config=_KMS_CONFIG)
    dynamodb = boto3.client("dynamodb", config=_KMS_CONFIG)

    @cache
    def verifier() -> approval.ApprovalVerifier:
        return approval.ApprovalVerifier(kms.get_public_key(KeyId=key_arn)["PublicKey"])

    def claim(approved: approval.Approval, now: int) -> None:
        approval_use.claim(dynamodb, table, approved, mark=approval_use.GATEWAY_MARK, now=now)

    return Approvals(tools=tools, verifier=verifier, claim=claim)


def _target_of(tool: str) -> tuple[str, str]:
    """``(target, tool)`` of a Gateway tool name (``<target>___<tool>``)."""
    target, separator, name = tool.partition(_TARGET_SEPARATOR)
    return (target, name) if separator else ("", "")


def _claims(token: str) -> dict[str, Any]:
    """Claims of a token the Gateway has already validated (signature checked upstream)."""
    try:
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (IndexError, ValueError, binascii.Error):
        return {}
    return claims if isinstance(claims, dict) else {}


def _subject(token: str) -> str | None:
    sub = _claims(token).get("sub")
    return sub if isinstance(sub, str) and sub else None


def _header(headers: dict[str, Any], name: str) -> str | None:
    wanted = name.lower()
    for key, value in headers.items():
        if key.lower() == wanted and isinstance(value, str):
            return value
    return None


def _invocation(headers: dict[str, Any], token: str, key: bytes) -> invocation.Invocation | None:
    subject = _subject(token)
    signature = _header(headers, invocation.HEADER)
    if not subject or not signature:
        return None
    return invocation.verify(key, subject, signature)


def _reject(request_id: Any, status: int, code: int, message: str, reason: str) -> dict[str, Any]:
    # The reason only: never headers, tokens, tool names or arguments (they are user content).
    logger.info(json.dumps({"event": "gateway.rejected", "reason": reason}))
    return {
        "interceptorOutputVersion": OUTPUT_VERSION,
        "mcp": {
            "transformedGatewayResponse": {
                "statusCode": status,
                "body": {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": code, "message": message},
                },
            }
        },
    }


class _RefusedError(Exception):
    def __init__(self, status: int, code: int, message: str, reason: str) -> None:
        super().__init__(message)
        self.status, self.code, self.reason = status, code, reason


def _signed_tool(name: object, signed: invocation.Invocation) -> str:
    """Only the tools of the agent version mango-api signed for (TM-M12). Deny by default: a
    call without a tool name is not in any list."""
    if not isinstance(name, str) or name not in signed.tools:
        raise _RefusedError(
            403, _FORBIDDEN, "tool not allowed for this agent", "tool_not_in_agent_version"
        )
    return name


def _context(
    name: str,
    token: str,
    signed: invocation.Invocation,
    context_targets: frozenset[str],
    packs: PackIdentities | None,
) -> dict[str, str] | None:
    """What a tool learns about its caller: the token (Mango connectors), a signed assertion
    (packs over account data) or nothing (every other pack)."""
    target, tool = _target_of(name)
    if target and target in context_targets:
        return {"token": token}
    if packs is None or target not in packs.targets:
        return None
    if _claims(token).get(_CENTRAL_CLAIM) != "true":
        raise _RefusedError(
            403, _FORBIDDEN, "tool not allowed for this user", "account_data_for_non_central_user"
        )
    try:
        assertion = packs.assertion(
            subject=signed.subject, target=target, tool=tool, agent_id=signed.agent_id
        )
    except (ClientError, BotoCoreError, ValueError):
        # Without a signed caller the pack would refuse the call anyway: fail here.
        logger.exception("pack identity could not be signed")
        raise _RefusedError(
            503, _UNAVAILABLE, "the tool is temporarily unavailable", "pack_identity_unavailable"
        ) from None
    # Never the token: only who is calling this tool of this pack (TM-B9).
    return {"identity": assertion}


def _approved(
    name: str,
    arguments: dict[str, Any],
    headers: dict[str, Any],
    signed: invocation.Invocation,
    approvals: Approvals | None,
) -> str | None:
    """The approval token of a write tool call, once verified and spent; ``None`` for a tool
    that needs none. A write tool without a valid approval is refused (TM-W1 to TM-W3)."""
    if approvals is None or name not in approvals.tools:
        return None
    token = _header(headers, approval.HEADER)
    if not token:
        # An agent calling the tool on its own: mango-api asks a person to confirm it.
        raise _RefusedError(403, _FORBIDDEN, APPROVAL_REQUIRED_MESSAGE, "approval_required")
    try:
        approvals.check(
            token,
            subject=signed.subject,
            agent_id=signed.agent_id,
            tool=name,
            arguments=arguments,
        )
    except approval.ApprovalError:
        raise _RefusedError(
            403, _FORBIDDEN, "the approval does not match this call", "approval_mismatch"
        ) from None
    except approval_use.ApprovalUsedError:
        raise _RefusedError(
            403, _FORBIDDEN, "the approval was already used or expired", "approval_used"
        ) from None
    except (ClientError, BotoCoreError, ValueError):
        # Without the key or the table nothing can be verified: fail closed.
        logger.exception("approval could not be verified")
        raise _RefusedError(
            503, _UNAVAILABLE, "the tool is temporarily unavailable", "approval_unavailable"
        ) from None
    return token


def _deny(request_id: Any, reason: str) -> dict[str, Any]:
    return _reject(request_id, 401, _UNAUTHENTICATED, "unauthenticated", reason)


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    return handle(event, _invocation_key(), _context_targets(), _pack_identities(), _approvals())


def handle(
    event: dict[str, Any],
    key: bytes,
    context_targets: frozenset[str],
    packs: PackIdentities | None = None,
    approvals: Approvals | None = None,
) -> dict[str, Any]:
    request = (event.get("mcp") or {}).get("gatewayRequest") or {}
    body = request.get("body")
    if not isinstance(body, dict):
        return _deny(None, "malformed_request")
    headers = request.get("headers") or {}
    token = _bearer_token(headers)
    if token is None:
        return _deny(body.get("id"), "no_bearer_token")
    signed = _invocation(headers, token, key)
    if signed is None:
        return _deny(body.get("id"), "invalid_invocation")
    if body.get("method") != "tools/call":
        return {
            "interceptorOutputVersion": OUTPUT_VERSION,
            "mcp": {"transformedGatewayRequest": {"body": body}},
        }

    raw_params = body.get("params")
    params: dict[str, Any] = raw_params if isinstance(raw_params, dict) else {}
    raw_arguments = params.get("arguments")
    supplied: dict[str, Any] = raw_arguments if isinstance(raw_arguments, dict) else {}
    arguments = {k: v for k, v in supplied.items() if k != RESERVED_CONTEXT_ARG}
    try:
        name = _signed_tool(params.get("name"), signed)
        context = _context(name, token, signed, context_targets, packs)
        # Last: the approval is spent only on a call that would otherwise go through.
        approval_token = _approved(name, arguments, headers, signed, approvals)
    except _RefusedError as refused:
        return _reject(body.get("id"), refused.status, refused.code, str(refused), refused.reason)
    if approval_token is not None:
        # The approval executor verifies it again (it trusts neither the Gateway nor this).
        context = {**(context or {}), "approval": approval_token}
    if context is not None:
        arguments[RESERVED_CONTEXT_ARG] = context
    transformed = {**body, "params": {**params, "arguments": arguments}}
    return {
        "interceptorOutputVersion": OUTPUT_VERSION,
        "mcp": {"transformedGatewayRequest": {"body": transformed}},
    }
