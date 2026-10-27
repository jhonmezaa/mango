"""RESPONSE interceptor (D98 (3), (16); TM-004, TM-011, TM-017)."""

from __future__ import annotations

import json
import logging
from typing import Any

import pytest
from botocore.exceptions import ClientError

from mango_core import invocation, remote_mcp
from mango_gateway_interceptor import response
from mango_gateway_interceptor.response import (
    BINARY_NOTICE,
    CUT_NOTICE,
    MAX_RESULT_CHARS,
    URL_NOTICE,
    Consents,
    handle,
)

from .conftest import CONSENT_URL, KEY, PROBE, REGION, REGISTRATION, TARGET, WIKI, headers

NOW = 1_800_000_000
EVIL = "https://evil.example/login"


class _Table:
    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []
        self.error: Exception | None = None

    def put(self, item: dict[str, Any]) -> None:
        if self.error is not None:
            raise self.error
        self.items.append(item)


def _consents(table: _Table, tasks_client_id: str = "tasks-client") -> Consents:
    return Consents(
        put=table.put, region=REGION, tasks_client_id=tasks_client_id, clock=lambda: NOW
    )


def _event(
    body: Any,
    *,
    name: str = WIKI,
    hdrs: dict[str, str] | None = None,
    method: str = "tools/call",
    status: int | None = 200,
) -> dict[str, Any]:
    gateway_response: dict[str, Any] = {"headers": {"Mcp-Session-Id": "s-1"}, "body": body}
    if status is not None:
        gateway_response["statusCode"] = status
    return {
        "interceptorInputVersion": "1.0",
        "mcp": {
            "gatewayRequest": {
                "headers": hdrs if hdrs is not None else headers(),
                "body": {
                    "jsonrpc": "2.0",
                    "id": 9,
                    "method": method,
                    "params": {"name": name, "arguments": {}},
                },
            },
            "gatewayResponse": gateway_response,
        },
    }


def _consent_error(*urls: Any, code: int = -32042) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": 9,
        "error": {
            "code": code,
            "message": f"Authorization required: {urls[0] if urls else ''}",
            "data": {
                "elicitations": [
                    {"mode": "url", "url": url, "elicitationId": "e-1"} for url in urls
                ]
            },
        },
    }


def _run(event: dict[str, Any], table: _Table | None = None) -> dict[str, Any]:
    return handle(event, KEY, _consents(table if table is not None else _Table()))


def _out(result: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = result["mcp"]["transformedGatewayResponse"]
    return out


@pytest.mark.parametrize("code", [-32042, -32021])
def test_a_consent_error_becomes_consent_required_without_any_url(code: int) -> None:
    out = _out(_run(_event(_consent_error(CONSENT_URL, code=code))))
    assert out["statusCode"] == 200
    assert out["headers"] == {"Mcp-Session-Id": "s-1"}
    assert out["body"] == {
        "jsonrpc": "2.0",
        "id": 9,
        "error": {
            "code": -32001,
            "message": "consent_required",
            "data": {"mango": "consent_required", "target": TARGET},
        },
    }
    assert "http" not in json.dumps(out)


def test_the_pending_consent_is_written_under_the_signed_subject() -> None:
    table = _Table()
    # The token's sub and the signature's agree; the body of the answer names nobody.
    _run(_event(_consent_error(CONSENT_URL), hdrs=headers(sub="person-a")), table)
    [item] = table.items
    assert item == remote_mcp.PendingConsent.new(
        REGISTRATION, CONSENT_URL, "chat", now=NOW, region=REGION
    ).to_item("person-a")
    assert set(item) <= {
        "PK",
        "SK",
        "authorization_url",
        "source",
        "created_at",
        "expires_at",
        "ttl",
        "session_sha256",
    }


@pytest.mark.parametrize(
    ("hdrs", "source"),
    [
        (headers((PROBE,), connection="connect"), "connect"),
        (headers(playground=True), "playground"),
        (headers(client_id="tasks-client"), "task"),
        (headers(client_id="web-client"), "chat"),
    ],
)
def test_the_source_of_the_consent(hdrs: dict[str, str], source: str) -> None:
    table = _Table()
    _run(_event(_consent_error(CONSENT_URL), name=PROBE, hdrs=hdrs), table)
    assert table.items[0]["source"] == {"S": source}


def test_a_disconnect_writes_nothing() -> None:
    table = _Table()
    out = _out(
        _run(
            _event(
                _consent_error(CONSENT_URL),
                name=PROBE,
                hdrs=headers((PROBE,), connection="disconnect"),
            ),
            table,
        )
    )
    assert table.items == []
    assert out["body"]["error"]["message"] == "consent_required"


@pytest.mark.parametrize(
    "hdrs",
    [
        {},
        {"Authorization": headers()["Authorization"]},
        {**headers(), invocation.HEADER: "v2.forged.mac"},
        # Signed for another person than the token's.
        {**headers(sub="person-b"), "Authorization": headers(sub="person-a")["Authorization"]},
        # Signed for another tool.
        headers((PROBE,)),
    ],
    ids=["no-headers", "no-signature", "forged", "another-person", "another-tool"],
)
def test_without_a_verified_signature_it_only_strips(hdrs: dict[str, str]) -> None:
    table = _Table()
    out = _out(_run(_event(_consent_error(CONSENT_URL), hdrs=hdrs), table))
    assert table.items == []
    assert "http" not in json.dumps(out)


@pytest.mark.parametrize(
    "url",
    [
        EVIL,
        f"http://bedrock-agentcore.{REGION}.amazonaws.com/x",
        "https://bedrock-agentcore.eu-west-1.amazonaws.com/x",
        f"https://bedrock-agentcore.{REGION}.amazonaws.com.evil.example/x",
        f"https://user@bedrock-agentcore.{REGION}.amazonaws.com/x",
        None,
        42,
    ],
)
def test_only_an_identity_url_of_this_region_is_kept(url: Any) -> None:
    table = _Table()
    out = _out(_run(_event(_consent_error(url)), table))
    assert table.items == []
    assert "evil" not in json.dumps(out)


def test_the_first_valid_url_is_kept() -> None:
    table = _Table()
    _run(_event(_consent_error(EVIL, CONSENT_URL)), table)
    assert table.items[0]["authorization_url"] == {"S": CONSENT_URL}


def test_a_failed_write_still_answers_consent_required(caplog: pytest.LogCaptureFixture) -> None:
    table = _Table()
    table.error = ClientError({"Error": {"Code": "AccessDeniedException"}}, "PutItem")
    with caplog.at_level(logging.INFO):
        out = _out(_run(_event(_consent_error(CONSENT_URL)), table))
    assert out["body"]["error"]["message"] == "consent_required"
    assert CONSENT_URL not in caplog.text


def test_logs_the_shape_of_a_consent_only(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO):
        _run(_event(_consent_error(CONSENT_URL)))
    assert json.loads(caplog.records[-1].getMessage()) == {
        "event": "gateway.remote_response",
        "kind": "consent",
        "code": -32042,
        "had_url": True,
        "url_hosts": [f"bedrock-agentcore.{REGION}.amazonaws.com"],
        "consent": "written",
    }
    assert "request_uri" not in caplog.text and "Bearer" not in caplog.text


def test_long_texts_are_cut_and_binary_content_replaced() -> None:
    long = "a" * (MAX_RESULT_CHARS + 10)
    result = {
        "content": [
            {"type": "text", "text": long},
            {"type": "text", "text": "short"},
            {"type": "image", "data": "aGVsbG8=", "mimeType": "image/png"},
            {"type": "resource", "resource": {"uri": "x://a", "blob": "aGVsbG8="}},
            {"type": "resource", "resource": {"uri": "x://b", "text": long}},
        ],
        "structuredContent": {"items": [long]},
    }
    out = _out(_run(_event({"jsonrpc": "2.0", "id": 9, "result": result})))["body"]["result"]
    content = out["content"]
    assert content[0]["text"] == "a" * MAX_RESULT_CHARS + CUT_NOTICE
    assert content[1]["text"] == "short"
    assert content[2] == {"type": "text", "text": BINARY_NOTICE}
    assert content[3] == {"type": "text", "text": BINARY_NOTICE}
    assert content[4]["resource"]["text"] == "a" * MAX_RESULT_CHARS + CUT_NOTICE
    assert "structuredContent" not in out


def test_a_normal_result_keeps_its_links() -> None:
    # Links of the service are data (the web classifies them, A1); only errors lose them.
    result = {"content": [{"type": "text", "text": "See https://dev.azure.com/contoso/p/_wiki"}]}
    out = _out(_run(_event({"jsonrpc": "2.0", "id": 9, "result": result})))
    assert out["body"]["result"] == result


def test_a_tool_error_loses_every_url() -> None:
    result = {
        "isError": True,
        "content": [{"type": "text", "text": f"Sign in at {EVIL} or http://x.example"}],
    }
    out = _out(_run(_event({"jsonrpc": "2.0", "id": 9, "result": result})))
    assert out["body"]["result"]["content"][0]["text"] == f"Sign in at {URL_NOTICE} or {URL_NOTICE}"


def test_any_other_error_loses_every_url() -> None:
    body = {
        "jsonrpc": "2.0",
        "id": 9,
        "error": {"code": -32603, "message": f"go to {EVIL}", "data": {EVIL: [EVIL]}},
    }
    out = _out(_run(_event(body)))
    assert "evil" not in json.dumps(out)
    assert out["body"]["error"]["code"] == -32603


def test_answers_of_other_targets_go_back_as_they_came() -> None:
    body = _consent_error(EVIL)
    event = _event(body, name="finops___get_cost_and_usage")
    out = _out(_run(event))
    assert out == {"statusCode": 200, "headers": {"Mcp-Session-Id": "s-1"}, "body": body}


@pytest.mark.parametrize("method", ["tools/list", "initialize", "notifications/initialized"])
def test_other_methods_go_back_as_they_came(method: str) -> None:
    body = {"jsonrpc": "2.0", "id": 9, "result": {"tools": [{"name": WIKI, "description": EVIL}]}}
    assert _out(_run(_event(body, method=method)))["body"] == body


def test_a_streamed_event_without_status_keeps_working() -> None:
    out = _out(_run(_event(_consent_error(CONSENT_URL), status=None)))
    assert out["body"]["error"]["message"] == "consent_required"


@pytest.mark.parametrize(
    "event", [{}, {"mcp": {}}, {"mcp": {"gatewayRequest": "x", "gatewayResponse": []}}]
)
def test_a_malformed_event_never_raises(event: dict[str, Any]) -> None:
    assert _run(event)["interceptorOutputVersion"] == "1.0"


def test_consents_come_from_the_stack(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []

    class _Client:
        def put_item(self, **kwargs: Any) -> None:
            calls.append(kwargs)

    monkeypatch.setattr(response.boto3, "client", lambda *_, **__: _Client())
    monkeypatch.setenv("SETTINGS_TABLE", "Settings")
    monkeypatch.setenv("AWS_REGION", REGION)
    monkeypatch.delenv("TASKS_CLIENT_ID", raising=False)
    response._consents.cache_clear()
    try:
        consents = response._consents()
        consents.put({"PK": {"S": "x"}})
    finally:
        response._consents.cache_clear()
    assert consents.region == REGION and consents.tasks_client_id == ""
    assert calls == [{"TableName": "Settings", "Item": {"PK": {"S": "x"}}}]


def test_without_the_invocation_key_it_strips_and_writes_nothing() -> None:
    table = _Table()
    out = _out(handle(_event(_consent_error(CONSENT_URL)), None, _consents(table)))
    assert table.items == []
    assert out["body"]["error"]["message"] == "consent_required"


def test_the_handler_never_fails_and_strips_on_any_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(*_: Any) -> Consents:
        raise RuntimeError("boom")

    def no_key() -> bytes:
        raise ClientError({"Error": {"Code": "AccessDeniedException"}}, "GetSecretValue")

    monkeypatch.setattr(response, "_invocation_key", no_key)
    monkeypatch.setattr(response, "_consents", broken)
    out = _out(response.lambda_handler(_event(_consent_error(CONSENT_URL)), None))
    assert "http" not in json.dumps(out)
    assert out["headers"] == {"Mcp-Session-Id": "s-1"}
