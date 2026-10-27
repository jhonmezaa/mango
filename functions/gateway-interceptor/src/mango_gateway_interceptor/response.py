"""AgentCore Gateway RESPONSE interceptor (D93, D94, D98 (16); TM-004, TM-011, TM-017).

It sees every answer of the Gateway and changes only those of a ``tools/call`` to a remote MCP
target (``remote-<registration>``); every other answer goes back as it came.

- **Consent.** The Gateway answers ``-32042`` (``-32021`` on protocol ``2026-07-28``) when the
  person has no token in the vault yet, with the consent URL in ``error.data.elicitations``.
  The URL never reaches the model or the caller (P3: the model repeats it): the answer becomes
  ``consent_required`` with the target only. If the invocation signature verifies, the URL is
  kept for mango-api as the pending consent ``MCP_CONSENT#<sub>``, under the ``sub`` of that
  signature, and only if it is ``https`` on ``bedrock-agentcore.<region>.amazonaws.com``. A
  disconnect (claim ``cx = disconnect``, D97 (3)) writes nothing: the person did not ask to
  connect.
- **Results.** Each text is cut to ``MAX_RESULT_CHARS`` and binary content becomes a notice
  (TM-011).
- **Errors.** Every URL is removed from the error of a remote server.

Logs carry the shape only: code, whether there was a URL and its host. Never headers, tokens,
arguments, results or the URL itself.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from functools import cache
from typing import Any
from urllib.parse import urlsplit

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from mango_core import invocation, remote_mcp

from .handler import (
    _KMS_CONFIG,
    OUTPUT_VERSION,
    _bearer_token,
    _claims,
    _invocation,
    _invocation_key,
)

logger = logging.getLogger()
logger.setLevel(logging.INFO)

CONSENT_CODES = frozenset({-32042, -32021})
CONSENT_REQUIRED = "consent_required"
_CONSENT_ERROR_CODE = -32001
MAX_RESULT_CHARS = 65536
"""``max_result_chars`` of the Azure DevOps profile (D98 (14)): one limit for every remote."""
CUT_NOTICE = "\n[recortado por Mango]"
BINARY_NOTICE = "[contenido binario omitido por Mango]"
URL_NOTICE = "[enlace omitido por Mango]"
_URL_RE = re.compile(r"(?i)\b(?:https?|ftp)://[^\s\"'<>]*")
_HOST_RE = re.compile(r"^[a-z0-9.-]{1,253}$")
_MAX_LOGGED_HOSTS = 5
_SETTINGS_TABLE_ENV = "SETTINGS_TABLE"
_TASKS_CLIENT_ENV = "TASKS_CLIENT_ID"


@dataclass(frozen=True)
class Consents:
    """Writes the pending consent of one person (D98 (3))."""

    put: Callable[[dict[str, Any]], None]
    """``PutItem`` of a typed item in ``Settings``; a new consent replaces the previous one."""
    region: str
    tasks_client_id: str = ""
    """Client of the task runs (D78): a consent asked by a run comes from a task."""
    clock: Callable[[], float] = time.time


@cache
def _consents() -> Consents:
    table = os.environ[_SETTINGS_TABLE_ENV]
    dynamodb = boto3.client("dynamodb", config=_KMS_CONFIG)

    def put(item: dict[str, Any]) -> None:
        dynamodb.put_item(TableName=table, Item=item)

    return Consents(
        put=put,
        region=os.environ["AWS_REGION"],
        tasks_client_id=os.environ.get(_TASKS_CLIENT_ENV, ""),
    )


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    # What the Gateway does with the answer of an interceptor that fails is not documented:
    # this one never fails. Without the key nothing is verified nor written (TM-017); on any
    # other error the answer loses every URL, so a consent URL never reaches the model (TM-004).
    try:
        key: bytes | None = _invocation_key()
    except (ClientError, BotoCoreError, KeyError):
        logger.exception("invocation key could not be read")
        key = None
    try:
        return handle(event, key, _consents())
    except Exception:
        logger.exception("response could not be inspected")
        response = (event.get("mcp") or {}).get("gatewayResponse")
        response = response if isinstance(response, dict) else {}
        return _respond(response, _strip_urls(response.get("body")))


def _respond(response: Mapping[str, Any], body: Any) -> dict[str, Any]:
    """The answer with ``body``, keeping the status and the headers of the Gateway (the MCP
    session id among them, D47)."""
    transformed: dict[str, Any] = {"statusCode": response.get("statusCode") or 200, "body": body}
    headers = response.get("headers")
    if isinstance(headers, dict):
        transformed["headers"] = headers
    return {
        "interceptorOutputVersion": OUTPUT_VERSION,
        "mcp": {"transformedGatewayResponse": transformed},
    }


def _log(event: str, **fields: Any) -> None:
    logger.info(json.dumps({"event": event, **fields}))


def _hosts(value: Any) -> list[str]:
    """Host names of the URLs in ``value``, only well-formed ones and a few: never paths."""
    hosts: set[str] = set()
    for match in _URL_RE.findall(json.dumps(value)):
        try:
            host = urlsplit(match).hostname or ""
        except ValueError:
            host = ""
        hosts.add(host if _HOST_RE.fullmatch(host) else "other")
    return sorted(hosts)[:_MAX_LOGGED_HOSTS]


def _strip_urls(value: Any) -> Any:
    """``value`` with every URL of every string (keys included) replaced by a notice."""
    if isinstance(value, str):
        return _URL_RE.sub(URL_NOTICE, value)
    if isinstance(value, list):
        return [_strip_urls(item) for item in value]
    if isinstance(value, dict):
        return {_strip_urls(key): _strip_urls(item) for key, item in value.items()}
    return value


def _consent_urls(error: Mapping[str, Any]) -> list[object]:
    data = error.get("data")
    elicitations = data.get("elicitations") if isinstance(data, dict) else None
    if not isinstance(elicitations, list):
        return []
    return [e.get("url") for e in elicitations if isinstance(e, dict)]


def _cut_text(text: str) -> tuple[str, bool]:
    if len(text) <= MAX_RESULT_CHARS:
        return text, False
    return text[:MAX_RESULT_CHARS] + CUT_NOTICE, True


def _cut_item(item: Any) -> tuple[Any, int, bool]:
    """One content item: text cut, binary (``data`` or a resource ``blob``) replaced."""
    if not isinstance(item, dict):
        return item, 0, False
    if isinstance(item.get("data"), str):
        return {"type": "text", "text": BINARY_NOTICE}, len(item["data"]), True
    if isinstance(item.get("text"), str):
        text, cut = _cut_text(item["text"])
        return {**item, "text": text}, len(item["text"]), cut
    resource = item.get("resource")
    if isinstance(resource, dict):
        if isinstance(resource.get("blob"), str):
            return {"type": "text", "text": BINARY_NOTICE}, len(resource["blob"]), True
        if isinstance(resource.get("text"), str):
            text, cut = _cut_text(resource["text"])
            return {**item, "resource": {**resource, "text": text}}, len(resource["text"]), cut
    return item, 0, False


def _cut(result: dict[str, Any]) -> tuple[dict[str, Any], int, bool]:
    """``result`` within the limits (TM-011), its original size and whether anything changed."""
    content = result.get("content")
    total, cut, out = 0, False, result
    if isinstance(content, list):
        items = []
        for item in content:
            new, size, changed = _cut_item(item)
            items.append(new)
            total += size
            cut = cut or changed
        out = {**result, "content": items}
    structured = result.get("structuredContent")
    if structured is not None:
        size = len(json.dumps(structured, ensure_ascii=False, default=str))
        total += size
        if size > MAX_RESULT_CHARS:
            # The text carries the same data, cut; the copy would pass the limit whole.
            out = {k: v for k, v in out.items() if k != "structuredContent"}
            cut = True
    return out, total, cut


def _verified(headers: Mapping[str, Any], key: bytes | None) -> invocation.Invocation | None:
    token = _bearer_token(dict(headers))
    if key is None or token is None:
        return None
    return _invocation(dict(headers), token, key)


def _source(
    signed: invocation.Invocation, headers: Mapping[str, Any], consents: Consents
) -> remote_mcp.ConsentSource:
    if signed.connection == "connect":
        return "connect"
    if signed.playground:
        return "playground"
    token = _bearer_token(dict(headers)) or ""
    if consents.tasks_client_id and _claims(token).get("client_id") == consents.tasks_client_id:
        return "task"
    return "chat"


def _keep_consent(
    urls: list[object],
    *,
    tool: str,
    registration: str,
    headers: Mapping[str, Any],
    key: bytes | None,
    consents: Consents,
) -> str:
    """Writes the pending consent and says what happened (for the log only)."""
    signed = _verified(headers, key)
    if signed is None or tool not in signed.tools:
        # The sub could not come from a verified signature (TM-017): nothing is written.
        return "unverified"
    if signed.connection == "disconnect":
        return "disconnect"
    url = next((u for u in urls if remote_mcp.is_consent_url(u, consents.region)), None)
    if not isinstance(url, str):
        return "url_rejected"
    try:
        consent = remote_mcp.PendingConsent.new(
            registration,
            url,
            _source(signed, headers, consents),
            now=int(consents.clock()),
            region=consents.region,
        )
        consents.put(consent.to_item(signed.subject))
    except ValueError:
        return "invalid"
    except (ClientError, BotoCoreError):
        # The person asks again from «Mis conexiones»: the answer stays consent_required.
        logger.exception("pending consent could not be written")
        return "write_failed"
    return "written"


def handle(event: dict[str, Any], key: bytes | None, consents: Consents) -> dict[str, Any]:
    """``key``: the invocation key; ``None`` if it could not be read (nothing is written)."""
    mcp = event.get("mcp") or {}
    request = mcp.get("gatewayRequest") or {}
    response = mcp.get("gatewayResponse") or {}
    if not isinstance(response, dict):
        response = {}
    body = response.get("body")
    request_body = request.get("body") if isinstance(request, dict) else None
    params = request_body.get("params") if isinstance(request_body, dict) else None
    tool = params.get("name") if isinstance(params, dict) else None
    target = tool.partition(remote_mcp.TOOL_SEPARATOR)[0] if isinstance(tool, str) else ""
    registration = remote_mcp.registration_of_target(target)
    if (
        not isinstance(request_body, dict)
        or request_body.get("method") != "tools/call"
        or not isinstance(tool, str)
        or registration is None
    ):
        # Not a remote server's answer: as it came.
        return _respond(response, body)
    raw_headers = request.get("headers")
    headers: Mapping[str, Any] = raw_headers if isinstance(raw_headers, dict) else {}
    return _respond(
        *_remote_answer(
            response,
            body,
            tool=tool,
            registration=registration,
            headers=headers,
            key=key,
            consents=consents,
        )
    )


def _remote_answer(
    response: dict[str, Any],
    body: Any,
    *,
    tool: str,
    registration: str,
    headers: Mapping[str, Any],
    key: bytes | None,
    consents: Consents,
) -> tuple[dict[str, Any], Any]:
    """The Gateway response (status and headers) and the body a remote ``tools/call`` gets."""
    if not isinstance(body, dict):
        _log("gateway.remote_response", kind="no_body")
        return response, _strip_urls(body)
    error = body.get("error")
    if isinstance(error, dict):
        code = error.get("code")
        hosts = _hosts(error)
        if code in CONSENT_CODES:
            outcome = _keep_consent(
                _consent_urls(error),
                tool=tool,
                registration=registration,
                headers=headers,
                key=key,
                consents=consents,
            )
            _log(
                "gateway.remote_response",
                kind="consent",
                code=code,
                had_url=bool(hosts),
                url_hosts=hosts,
                consent=outcome,
            )
            return {**response, "statusCode": 200}, {
                "jsonrpc": "2.0",
                "id": body.get("id"),
                "error": {
                    "code": _CONSENT_ERROR_CODE,
                    "message": CONSENT_REQUIRED,
                    "data": {
                        "mango": CONSENT_REQUIRED,
                        "target": remote_mcp.target_name(registration),
                    },
                },
            }
        _log(
            "gateway.remote_response",
            kind="error",
            code=code if isinstance(code, int) else None,
            had_url=bool(hosts),
            url_hosts=hosts,
        )
        return response, {**body, "error": _strip_urls(error)}
    result = body.get("result")
    if not isinstance(result, dict):
        return response, _strip_urls(body)
    is_error = bool(result.get("isError"))
    trimmed, size, cut = _cut(result)
    hosts = _hosts(result) if is_error else []
    _log(
        "gateway.remote_response",
        kind="tool_error" if is_error else "result",
        chars=size,
        cut=cut,
        had_url=bool(hosts) if is_error else None,
        url_hosts=hosts,
    )
    return response, {**body, "result": _strip_urls(trimmed) if is_error else trimmed}
