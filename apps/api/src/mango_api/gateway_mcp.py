"""mango-api as an MCP client of the AgentCore Gateway: the transport and the session.

mango-api calls the Gateway itself in two places, always as the person (their access token,
rule 5) and with an invocation signature that names only the tool of the call (D33):

* the approval executor runs an approved write tool (D27, ``approval_executor``);
* «Mis conexiones» probes or disconnects a remote MCP (D97 (3), D98 (15), ``connections``).

A Gateway with MCP sessions (D47) answers 400 to a ``tools/call`` outside a session, so a call
is ``initialize``, ``notifications/initialized`` and the request with the ``Mcp-Session-Id``
the Gateway issued.

The Gateway URL is the installation's own (configuration, never request data): there is no
user-controlled destination here, and redirects are never followed. Tokens, arguments and
answers are never logged: only the status and the JSON-RPC code of a refusal.
"""

from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol

logger = logging.getLogger(__name__)

TIMEOUT_SECONDS = 60
MAX_RESPONSE_BYTES = 256 * 1024
HTTP_OK = 200
SESSION_HEADER = "Mcp-Session-Id"
# The session id goes back in a request header: visible ASCII only (MCP transport spec).
_SESSION_RE = re.compile(r"^[\x21-\x7e]{1,256}$")
# A notification has no answer of its own: accepted (202), or an empty result.
_NOTIFIED = frozenset({200, 202, 204})


@dataclass(frozen=True)
class Answer:
    status: int
    body: bytes
    session_id: str | None = None
    """``Mcp-Session-Id`` of the answer, when the Gateway keeps MCP sessions (D47)."""


class Transport(Protocol):
    def __call__(self, url: str, headers: dict[str, str], body: bytes) -> Answer: ...


class NotStartedError(Exception):
    """The MCP session could not be opened: the call itself was never sent."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class NoRedirects(urllib.request.HTTPRedirectHandler):
    """The request carries the caller's token and signatures: it is never replayed to
    wherever a redirect points (FASTAPI-SSRF-001)."""

    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


OPENER = urllib.request.build_opener(NoRedirects)


def post(url: str, headers: dict[str, str], body: bytes) -> Answer:
    # https only (checked by the callers), the installation's own Gateway, no redirects.
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")  # noqa: S310
    try:
        with OPENER.open(request, timeout=TIMEOUT_SECONDS) as response:
            return Answer(
                response.status,
                response.read(MAX_RESPONSE_BYTES + 1),
                response.headers.get(SESSION_HEADER),
            )
    except urllib.error.HTTPError as exc:
        return Answer(exc.code, exc.read(MAX_RESPONSE_BYTES + 1), exc.headers.get(SESSION_HEADER))


def rpc_body(raw: bytes) -> dict[str, Any] | None:
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


def rpc(method: str, request_id: str | None = None, params: object = None) -> bytes:
    """A JSON-RPC message; without ``request_id`` it is a notification."""
    message: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
    if request_id is not None:
        message["id"] = request_id
    if params is not None:
        message["params"] = params
    return json.dumps(message, separators=(",", ":")).encode()


def refusal(step: str, answer: Answer, message: dict[str, Any] | None) -> str:
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


def open_session(
    transport: Transport,
    url: str,
    headers: dict[str, str],
    *,
    request_id: str,
    protocol_version: str,
) -> str | None:
    """MCP handshake; the session id to send with the call, or ``None`` from a Gateway
    without sessions. Raises ``NotStartedError``: whatever fails here, the call was not sent."""
    try:
        opened = transport(
            url,
            headers,
            rpc(
                "initialize",
                request_id,
                {
                    "protocolVersion": protocol_version,
                    "capabilities": {},
                    "clientInfo": {"name": "mango-api", "version": "1"},
                },
            ),
        )
        message = rpc_body(opened.body)
        if (
            opened.status != HTTP_OK
            or message is None
            or not isinstance(message.get("result"), dict)
        ):
            raise NotStartedError(refusal("initialize", opened, message))
        session = opened.session_id
        if session is None:
            return None
        if not _SESSION_RE.fullmatch(session):
            raise NotStartedError("gateway_session_invalid")
        ready = transport(
            url, {**headers, SESSION_HEADER: session}, rpc("notifications/initialized")
        )
    except (OSError, ValueError):
        logger.exception("gateway session could not be opened")
        raise NotStartedError("gateway_unreachable") from None
    message = rpc_body(ready.body)
    if ready.status not in _NOTIFIED or isinstance((message or {}).get("error"), dict):
        raise NotStartedError(refusal("notifications/initialized", ready, message))
    return session
