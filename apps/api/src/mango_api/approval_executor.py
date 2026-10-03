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
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Any, Protocol

from botocore.exceptions import BotoCoreError, ClientError

from mango_core import approval, invocation

if TYPE_CHECKING:
    from mypy_boto3_kms import KMSClient

logger = logging.getLogger(__name__)

TIMEOUT_SECONDS = 60
MAX_RESPONSE_BYTES = 256 * 1024
_ERROR_CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
_HTTP_OK = 200
SESSION_HEADER = "Mcp-Session-Id"
MCP_PROTOCOL_VERSION = "2025-03-26"
# The session id goes back in a request header: visible ASCII only (MCP transport spec).
_SESSION_RE = re.compile(r"^[\x21-\x7e]{1,256}$")
# A notification has no answer of its own: accepted (202), or an empty result.
_NOTIFIED = frozenset({200, 202, 204})


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


@dataclass(frozen=True)
class Answer:
    status: int
    body: bytes
    session_id: str | None = None
    """``Mcp-Session-Id`` of the answer, when the Gateway keeps MCP sessions (D47)."""


class Transport(Protocol):
    def __call__(self, url: str, headers: dict[str, str], body: bytes) -> Answer: ...


class _NotStartedError(Exception):
    """The MCP session could not be opened: the approved call was never sent."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """The request carries the caller's token and the approval: it is never replayed to
    wherever a redirect points (FASTAPI-SSRF-001)."""

    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


_OPENER = urllib.request.build_opener(_NoRedirects)


def _post(url: str, headers: dict[str, str], body: bytes) -> Answer:
    # https only (checked at construction), the installation's own Gateway, no redirects.
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")  # noqa: S310
    try:
        with _OPENER.open(request, timeout=TIMEOUT_SECONDS) as response:
            return Answer(
                response.status,
                response.read(MAX_RESPONSE_BYTES + 1),
                response.headers.get(SESSION_HEADER),
            )
    except urllib.error.HTTPError as exc:
        return Answer(exc.code, exc.read(MAX_RESPONSE_BYTES + 1), exc.headers.get(SESSION_HEADER))


def _error_code(value: object, default: str) -> str:
    return value if isinstance(value, str) and _ERROR_CODE_RE.fullmatch(value) else default


def _rpc_body(raw: bytes) -> dict[str, Any] | None:
    """The JSON-RPC message of a Gateway answer (plain JSON or one SSE ``data:`` line)."""
    if len(raw) > MAX_RESPONSE_BYTES:
        return None
    text = raw.decode("utf-8", errors="replace")
    if text.lstrip().startswith(("event:", "data:")):
        data = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
        text = data[-1] if data else ""
    try:
        body = json.loads(text)
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


def _rpc(method: str, request_id: str | None = None, params: object = None) -> bytes:
    """A JSON-RPC message; without ``request_id`` it is a notification."""
    message: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
    if request_id is not None:
        message["id"] = request_id
    if params is not None:
        message["params"] = params
    return json.dumps(message, separators=(",", ":")).encode()


def _refusal(step: str, answer: Answer, message: dict[str, Any] | None) -> str:
    """Code of an answer that is not a result. Logs where the Gateway stopped the call: the
    status and the JSON-RPC code only, never its text, headers or the arguments."""
    error = message.get("error") if message is not None else None
    refused = isinstance(error, dict)
    rpc_code = error.get("code") if isinstance(error, dict) else None
    logger.warning(
        "gateway did not accept %s: status=%d rpc_code=%s",
        step,
        answer.status,
        rpc_code if isinstance(rpc_code, int) else None,
    )
    return "gateway_refused" if refused else f"gateway_http_{answer.status}"[:40]


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
        transport: Transport = _post,
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

    def _open_session(self, call: ApprovedCall, headers: dict[str, str]) -> str | None:
        """MCP handshake; the session id to send with the call, or ``None`` from a Gateway
        without sessions. Raises ``_NotStartedError``: these requests carry no approval, so
        whatever fails here the tool did not run and the approval was not spent."""
        try:
            opened = self._transport(
                self._url,
                headers,
                _rpc(
                    "initialize",
                    call.approval_id,
                    {
                        "protocolVersion": MCP_PROTOCOL_VERSION,
                        "capabilities": {},
                        "clientInfo": {"name": "mango-api", "version": "1"},
                    },
                ),
            )
            message = _rpc_body(opened.body)
            if (
                opened.status != _HTTP_OK
                or message is None
                or not isinstance(message.get("result"), dict)
            ):
                raise _NotStartedError(_refusal("initialize", opened, message))
            session = opened.session_id
            if session is None:
                return None
            if not _SESSION_RE.fullmatch(session):
                raise _NotStartedError("gateway_session_invalid")
            ready = self._transport(
                self._url, {**headers, SESSION_HEADER: session}, _rpc("notifications/initialized")
            )
        except (OSError, ValueError):
            logger.exception("gateway session could not be opened")
            raise _NotStartedError("gateway_unreachable") from None
        message = _rpc_body(ready.body)
        if ready.status not in _NOTIFIED or isinstance((message or {}).get("error"), dict):
            raise _NotStartedError(_refusal("notifications/initialized", ready, message))
        return session

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
            invocation.HEADER: signature,
        }
        try:
            session = self._open_session(call, headers)
        except _NotStartedError as not_started:
            return Execution(Outcome.NOT_RUN, not_started.code)
        # Only the call itself carries the approval.
        call_headers = {**headers, approval.HEADER: token}
        if session is not None:
            call_headers[SESSION_HEADER] = session
        body = _rpc(
            "tools/call", call.approval_id, {"name": call.gateway_tool, "arguments": arguments}
        )
        try:
            answer = self._transport(self._url, call_headers, body)
        except (OSError, ValueError):
            # Sent, but no answer: the tool may have run.
            logger.exception("gateway call failed")
            return Execution(Outcome.UNKNOWN, "gateway_unreachable")
        message = _rpc_body(answer.body)
        if message is None:
            return Execution(Outcome.UNKNOWN, _refusal("tools/call", answer, None))
        if isinstance(message.get("error"), dict):
            # Refused by the Gateway, its policy or the interceptor: the tool did not run.
            return Execution(Outcome.NOT_RUN, _refusal("tools/call", answer, message))
        if answer.status != _HTTP_OK or "result" not in message:
            return Execution(Outcome.UNKNOWN, _refusal("tools/call", answer, message))
        return _tool_outcome(message["result"])
