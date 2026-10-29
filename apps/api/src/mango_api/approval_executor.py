"""Runs an approved write tool call through the AgentCore Gateway (D27, rule 3).

Once a call is confirmed, mango-api does not ask the model again: it calls the Gateway itself
with the arguments it stored, as the person who asked for the action (their access token,
rule 5), with:

* an invocation signature that names only that tool (D33), and
* an approval token signed with a KMS key only mango-api can sign with, bound to
  ``hash(tool, args)`` and valid for one execution (``mango_core.approval``).

The Gateway interceptor and the approval executor each verify the token against the call they
receive.

mango-api is an MCP client of the Gateway like any other. A Gateway with MCP sessions (D47)
answers 400 to a ``tools/call`` outside a session, and only after its interceptor has spent the
approval. So the call is the last of three requests: ``initialize``, ``notifications/initialized``
and ``tools/call`` with the ``Mcp-Session-Id`` the Gateway issued. Only the last one carries the
approval: whatever fails before it, nothing ran and the approval is still unused.

The Gateway URL is the installation's own (configuration, never request data), so
there is no user-controlled destination here. Tokens and arguments are never logged.
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Protocol

from botocore.exceptions import BotoCoreError, ClientError

from mango_api.gateway_mcp import (
    HTTP_OK,
    PROTOCOL_HEADER,
    SESSION_HEADER,
    NotStartedError,
    Transport,
    open_session,
    post,
    refusal,
    rpc,
    rpc_body,
)
from mango_core import approval, invocation

if TYPE_CHECKING:
    from mypy_boto3_kms import KMSClient

logger = logging.getLogger(__name__)

_ERROR_CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
MCP_PROTOCOL_VERSION = "2025-03-26"


class Outcome(StrEnum):
    EXECUTED = "executed"
    """The tool ran and answered without an error."""
    TOOL_ERROR = "tool_error"
    """The tool answered with an error of its own."""
    NOT_RUN = "not_run"
    """The call was refused before the tool: nothing was changed."""
    UNKNOWN = "unknown"
    """No answer that can be trusted: the tool may or may not have run."""


@dataclass(frozen=True)
class Execution:
    outcome: Outcome
    error: str | None = None
    """A short code, from a closed alphabet; never a message from the tool."""


@dataclass(frozen=True)
class ApprovedCall:
    approval_id: str
    subject: str
    """Who asked for the action; the call runs with this person's access token."""
    agent_id: str
    agent_version: int
    gateway_tool: str
    arguments: str
    """Canonical JSON, as stored when the call was shown."""
    args_hash: str


class Executor(Protocol):
    def run(self, call: ApprovedCall, *, access_token: str, token_expires_at: int) -> Execution:
        """Run ``call`` once. Never raises: every failure is an ``Execution``."""
        ...


def _error_code(value: object, default: str) -> str:
    return value if isinstance(value, str) and _ERROR_CODE_RE.fullmatch(value) else default


def _tool_outcome(result: object) -> Execution:
    """What the tool said. Its text is untrusted (TM-W12): only a short error code is kept."""
    if not isinstance(result, dict):
        return Execution(Outcome.UNKNOWN, "invalid_response")
    payload: object = None
    content = result.get("content")
    if isinstance(content, list) and content and isinstance(content[0], dict):
        text = content[0].get("text")
        if isinstance(text, str):
            try:
                payload = json.loads(text)
            except ValueError:
                payload = None
    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict):
        return Execution(Outcome.TOOL_ERROR, _error_code(error.get("code"), "tool_error"))
    if result.get("isError") is True:
        return Execution(Outcome.TOOL_ERROR, "tool_error")
    return Execution(Outcome.EXECUTED)


class GatewayExecutor:
    def __init__(
        self,
        kms: KMSClient,
        *,
        key_arn: str,
        gateway_url: str,
        invocation_key: bytes,
        transport: Transport = post,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if not gateway_url.startswith("https://") or not key_arn:
            raise ValueError("the approval executor needs an https Gateway and a signing key")
        self._kms = kms
        self._key_arn = key_arn
        self._url = gateway_url
        self._invocation_key = invocation_key
        self._transport = transport
        self._now = clock

    def _token(self, call: ApprovedCall, expires_at: int) -> str:
        claims = approval.encode_claims(
            approval_id=call.approval_id,
            subject=call.subject,
            tool=call.gateway_tool,
            args_hash=call.args_hash,
            agent_id=call.agent_id,
            expires_at=expires_at,
        )
        signature: bytes = self._kms.sign(
            KeyId=self._key_arn,
            Message=approval.signing_digest(claims),
            MessageType="DIGEST",
            SigningAlgorithm=approval.SIGNING_ALGORITHM,
        )["Signature"]
        return approval.assemble(claims, signature)

    def run(  # noqa: PLR0911 - each return is one way the call can end
        self, call: ApprovedCall, *, access_token: str, token_expires_at: int
    ) -> Execution:
        now = int(self._now())
        expires_at = min(token_expires_at, now + approval.TTL_SECONDS)
        if expires_at <= now:
            return Execution(Outcome.NOT_RUN, "session_expired")
        try:
            arguments = json.loads(call.arguments)
            token = self._token(call, expires_at)
            signature = invocation.sign(
                self._invocation_key,
                call.subject,
                expires_at,
                agent_id=call.agent_id,
                agent_version=call.agent_version,
                # Only the approved tool: this request can call nothing else.
                tools=[call.gateway_tool],
            )
        except (ClientError, BotoCoreError, ValueError):
            logger.exception("approval token could not be signed")
            return Execution(Outcome.NOT_RUN, "signing_unavailable")
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            PROTOCOL_HEADER: MCP_PROTOCOL_VERSION,
            invocation.HEADER: signature,
        }
        try:
            # These requests carry no approval: whatever fails there, it was not spent.
            session = open_session(
                self._transport,
                self._url,
                headers,
                request_id=call.approval_id,
                protocol_version=MCP_PROTOCOL_VERSION,
            )
        except NotStartedError as not_started:
            return Execution(Outcome.NOT_RUN, not_started.code)
        # Only the call itself carries the approval.
        call_headers = {**headers, approval.HEADER: token}
        if session is not None:
            call_headers[SESSION_HEADER] = session
        body = rpc(
            "tools/call", call.approval_id, {"name": call.gateway_tool, "arguments": arguments}
        )
        try:
            answer = self._transport(self._url, call_headers, body)
        except (OSError, ValueError):
            # Sent, but no answer: the tool may have run.
            logger.exception("gateway call failed")
            return Execution(Outcome.UNKNOWN, "gateway_unreachable")
        message = rpc_body(answer.body)
        if message is None:
            return Execution(Outcome.UNKNOWN, refusal("tools/call", answer, None))
        if isinstance(message.get("error"), dict):
            # Refused by the Gateway, its policy or the interceptor: the tool did not run.
            return Execution(Outcome.NOT_RUN, refusal("tools/call", answer, message))
        if answer.status != HTTP_OK or "result" not in message:
            return Execution(Outcome.UNKNOWN, refusal("tools/call", answer, message))
        return _tool_outcome(message["result"])
