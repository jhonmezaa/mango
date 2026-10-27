"""The calls of «Mis conexiones» through the Gateway (D97 (3), D98 (15)): how an answer is read.
Only the exact ``consent_required`` of the ``RESPONSE`` interceptor, for this target, counts as
one; anything else that is not a plain result is a failure."""

from __future__ import annotations

import json
from typing import Any

import pytest

from mango_api.gateway_mcp import Answer, ConnectionOutcome, GatewayConnections

URL = "https://gw.example.com/mcp"
REG = "abcdefghij23"
KEY = b"k" * 32
NOW = 1_800_000_000


def _gateway(answer: dict[str, Any] | bytes, status: int = 200) -> GatewayConnections:
    body = answer if isinstance(answer, bytes) else json.dumps(answer).encode()

    def transport(_url: str, _headers: dict[str, str], request: bytes) -> Answer:
        method = json.loads(request)["method"]
        if method == "initialize":
            return Answer(200, b'{"jsonrpc":"2.0","id":"1","result":{}}')
        return Answer(status, body)

    return GatewayConnections(
        gateway_url=URL, invocation_key=KEY, transport=transport, clock=lambda: NOW
    )


def _call(gateway: GatewayConnections, expires_at: int = NOW + 3600) -> ConnectionOutcome:
    return gateway.call(
        subject="member-1",
        access_token="tok",
        token_expires_at=expires_at,
        registration_id=REG,
        tool="core_list_projects",
        arguments={},
        connection="connect",
    )


def _consent(target: str = f"remote-{REG}", code: int = -32001) -> dict[str, Any]:
    data = {"mango": "consent_required", "target": target}
    return {
        "jsonrpc": "2.0",
        "id": "1",
        "error": {"code": code, "message": "consent_required", "data": data},
    }


def test_a_plain_result_is_an_answer() -> None:
    assert _call(_gateway({"jsonrpc": "2.0", "id": "1", "result": {"content": []}})) is (
        ConnectionOutcome.ANSWERED
    )


def test_the_interceptors_consent_required_for_this_target() -> None:
    assert _call(_gateway(_consent())) is ConnectionOutcome.CONSENT_REQUIRED


@pytest.mark.parametrize(
    "answer",
    [
        _consent(target="remote-abcdefghij45"),
        _consent(code=-32042),
        {"jsonrpc": "2.0", "id": "1", "result": {"isError": True, "content": []}},
        {"jsonrpc": "2.0", "id": "1", "error": {"code": -32600, "message": "denied"}},
        b"not json",
    ],
)
def test_anything_else_is_a_failure(answer: dict[str, Any] | bytes) -> None:
    assert _call(_gateway(answer)) is ConnectionOutcome.FAILED


def test_a_result_with_an_http_error_is_a_failure() -> None:
    result = {"jsonrpc": "2.0", "id": "1", "result": {"content": []}}
    assert _call(_gateway(result, status=500)) is ConnectionOutcome.FAILED


def test_an_expired_token_sends_nothing() -> None:
    sent: list[bytes] = []

    def transport(_url: str, _headers: dict[str, str], request: bytes) -> Answer:
        sent.append(request)
        return Answer(200, b"{}")

    gateway = GatewayConnections(
        gateway_url=URL, invocation_key=KEY, transport=transport, clock=lambda: NOW
    )
    assert _call(gateway, expires_at=NOW) is ConnectionOutcome.FAILED
    assert sent == []


def test_it_needs_an_https_gateway_and_the_key() -> None:
    with pytest.raises(ValueError, match="https"):
        GatewayConnections(gateway_url="http://gw", invocation_key=KEY)
    with pytest.raises(ValueError, match="https"):
        GatewayConnections(gateway_url=URL, invocation_key=b"")
