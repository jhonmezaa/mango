"""Running an approved call through the Gateway (D27): what mango-api sends and how it reads
the answer. KMS is a local P-256 key; the Gateway is a fake transport that keeps MCP sessions
like the real one (D47): it refuses whatever arrives outside an initialized session."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import pytest
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

from mango_api import approval_executor
from mango_api.approval_executor import (
    SESSION_HEADER,
    Answer,
    ApprovedCall,
    Execution,
    GatewayExecutor,
    Outcome,
)
from mango_core import approval, invocation

NOW = 1_800_000_000
KEY = b"k" * 32
URL = "https://gw.example.com/mcp"
TOOL = "ops___create_budget"
ARGS = {"name": "team-a", "amount_usd": 100}
CALL = ApprovedCall(
    approval_id="c" * 32,
    subject="user-1",
    agent_id="finops",
    agent_version=3,
    gateway_tool=TOOL,
    arguments=approval.canonical_arguments(ARGS),
    args_hash=approval.call_hash(TOOL, ARGS),
)


@dataclass
class FakeKms:
    key: ec.EllipticCurvePrivateKey = field(
        default_factory=lambda: ec.generate_private_key(ec.SECP256R1())
    )
    fail: bool = False
    requests: list[dict[str, Any]] = field(default_factory=list)

    def sign(self, **request: Any) -> dict[str, Any]:
        self.requests.append(request)
        if self.fail:
            raise ClientError({"Error": {"Code": "KMSInvalidStateException"}}, "Sign")
        signature = self.key.sign(request["Message"], ec.ECDSA(utils.Prehashed(hashes.SHA256())))
        return {"Signature": signature}

    def verifier(self) -> approval.ApprovalVerifier:
        public = self.key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        return approval.ApprovalVerifier(public, clock=lambda: NOW)


def _rpc_error(message: str, code: int = -32600) -> bytes:
    return json.dumps(
        {"jsonrpc": "2.0", "id": 1, "error": {"code": code, "message": message}}
    ).encode()


@dataclass
class Gateway:
    """``status``, ``body`` and ``error`` are the answer to ``tools/call``; ``answers`` replaces
    the answer to another method."""

    status: int = 200
    body: bytes = b""
    error: Exception | None = None
    session: str | None = "session-1"
    """``None``: a Gateway without MCP sessions."""
    answers: dict[str, Answer | Exception] = field(default_factory=dict)
    initialized: set[str] = field(default_factory=set)
    requests: list[tuple[str, dict[str, str], dict[str, Any]]] = field(default_factory=list)

    def __call__(self, url: str, headers: dict[str, str], body: bytes) -> Answer:
        message = json.loads(body)
        self.requests.append((url, headers, message))
        method = message["method"]
        scripted = self.answers.get(method)
        if isinstance(scripted, Exception):
            raise scripted
        if scripted is not None:
            return scripted
        if method == "initialize":
            result = {"protocolVersion": message["params"]["protocolVersion"], "capabilities": {}}
            answer = json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result})
            return Answer(200, answer.encode(), self.session)
        given = headers.get(SESSION_HEADER)
        if self.session is not None and given != self.session:
            return Answer(400, _rpc_error("Missing required Mcp-Session-Id header"))
        if method == "notifications/initialized":
            self.initialized.add(given or "")
            return Answer(202, b'{"jsonrpc":"2.0","id":null,"result":{}}', given)
        if self.session is not None and given not in self.initialized:
            return Answer(400, _rpc_error("Session not initialized."))
        if self.error:
            raise self.error
        return Answer(self.status, self.body, given)

    def sent(self, method: str) -> list[tuple[dict[str, str], dict[str, Any]]]:
        return [(headers, body) for _, headers, body in self.requests if body["method"] == method]


def _result(payload: Any, **extra: Any) -> bytes:
    content = [{"type": "text", "text": json.dumps(payload)}]
    return json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"content": content, **extra}}).encode()


def _run(gateway: Gateway, kms: FakeKms | None = None, expires_at: int = NOW + 3600) -> Execution:
    executor = GatewayExecutor(
        kms or FakeKms(),  # type: ignore[arg-type]
        key_arn="arn:aws:kms:us-east-1:111111111111:key/abc",
        gateway_url=URL,
        invocation_key=KEY,
        transport=gateway,
        clock=lambda: NOW,
    )
    return executor.run(CALL, access_token="user-token", token_expires_at=expires_at)


def test_sends_the_stored_arguments_with_a_token_bound_to_them() -> None:
    kms, gateway = FakeKms(), Gateway(body=_result({"status": "created"}))
    assert _run(gateway, kms) == Execution(Outcome.EXECUTED)
    assert {url for url, _, _ in gateway.requests} == {URL}
    ((headers, body),) = gateway.sent("tools/call")
    assert body == {
        "jsonrpc": "2.0",
        "id": CALL.approval_id,
        "method": "tools/call",
        "params": {"name": TOOL, "arguments": ARGS},
    }
    assert headers["Authorization"] == "Bearer user-token"
    # The invocation names only the approved tool: this request can call nothing else.
    signed = invocation.verify(KEY, "user-1", headers[invocation.HEADER], now=NOW)
    assert signed is not None
    assert (signed.agent_id, signed.agent_version, signed.tools) == ("finops", 3, {TOOL})
    assert signed.expires_at == NOW + approval.TTL_SECONDS
    # The approval verifies for exactly this person, tool and arguments.
    approved = kms.verifier().verify(
        headers[approval.HEADER], subject="user-1", tool=TOOL, arguments=ARGS
    )
    assert (approved.approval_id, approved.agent_id) == (CALL.approval_id, "finops")
    assert kms.requests[0]["MessageType"] == "DIGEST"
    assert kms.requests[0]["SigningAlgorithm"] == "ECDSA_SHA_256"


def test_the_token_never_outlives_the_session() -> None:
    kms, gateway = FakeKms(), Gateway(body=_result({}))
    _run(gateway, kms, expires_at=NOW + 30)
    headers = gateway.sent("tools/call")[0][0]
    signed = invocation.verify(KEY, "user-1", headers[invocation.HEADER], now=NOW)
    assert signed is not None and signed.expires_at == NOW + 30
    assert _run(Gateway(), expires_at=NOW) == Execution(Outcome.NOT_RUN, "session_expired")


def test_the_call_goes_in_an_mcp_session_and_only_it_carries_the_approval() -> None:
    # D47: the Gateway answers 400 to a ``tools/call`` outside an initialized session, after
    # its interceptor spent the approval. The fake refuses the same way.
    gateway = Gateway(body=_result({"status": "created"}))
    assert _run(gateway) == Execution(Outcome.EXECUTED)
    methods = [body["method"] for _, _, body in gateway.requests]
    assert methods == ["initialize", "notifications/initialized", "tools/call"]
    (opening, _), (notified, notification), (call, _) = (
        (headers, body) for _, headers, body in gateway.requests
    )
    assert SESSION_HEADER not in opening
    assert notified[SESSION_HEADER] == call[SESSION_HEADER] == "session-1"
    assert "id" not in notification
    # Every request is the user's and signed for the interceptor; the approval goes once.
    for headers in (opening, notified, call):
        assert headers["Authorization"] == "Bearer user-token"
        assert invocation.verify(KEY, "user-1", headers[invocation.HEADER], now=NOW) is not None
    assert approval.HEADER not in opening and approval.HEADER not in notified
    assert approval.HEADER in call


def test_a_gateway_without_sessions_gets_the_call_without_a_session() -> None:
    gateway = Gateway(body=_result({"status": "created"}), session=None)
    assert _run(gateway) == Execution(Outcome.EXECUTED)
    assert [body["method"] for _, _, body in gateway.requests] == ["initialize", "tools/call"]
    assert SESSION_HEADER not in gateway.sent("tools/call")[0][0]


@pytest.mark.parametrize(
    ("method", "answer", "error"),
    [
        ("initialize", Answer(403, _rpc_error("no", -32003)), "gateway_refused"),
        ("initialize", Answer(200, b'{"jsonrpc":"2.0","id":1}', "s"), "gateway_http_200"),
        ("initialize", Answer(502, b"<html>bad gateway</html>"), "gateway_http_502"),
        ("initialize", TimeoutError("timed out"), "gateway_unreachable"),
        # A session id that could not go back in a header is never sent.
        (
            "initialize",
            Answer(200, b'{"jsonrpc":"2.0","id":1,"result":{}}', "a\r\nX-Other: 1"),
            "gateway_session_invalid",
        ),
        ("notifications/initialized", Answer(400, _rpc_error("no")), "gateway_refused"),
        ("notifications/initialized", Answer(500, b""), "gateway_http_500"),
        ("notifications/initialized", OSError("reset"), "gateway_unreachable"),
    ],
)
def test_a_session_that_does_not_open_never_sends_the_approval(
    method: str, answer: Answer | Exception, error: str
) -> None:
    gateway = Gateway(body=_result({"status": "created"}), answers={method: answer})
    # Not run: the request goes back to approved and can be run again.
    assert _run(gateway) == Execution(Outcome.NOT_RUN, error)
    assert gateway.sent("tools/call") == []
    assert all(approval.HEADER not in headers for _, headers, _ in gateway.requests)


def test_a_call_outside_its_session_is_refused_by_the_fake_like_by_the_gateway() -> None:
    # What mango-api sent before: only the call. The lab Gateway answered exactly this.
    gateway = Gateway(body=_result({"status": "created"}))
    answer = gateway(URL, {}, b'{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{}}')
    assert answer.status == 400 and b"Mcp-Session-Id" in answer.body


def test_nothing_is_sent_when_the_token_cannot_be_signed() -> None:
    gateway = Gateway()
    assert _run(gateway, FakeKms(fail=True)) == Execution(Outcome.NOT_RUN, "signing_unavailable")
    assert gateway.requests == []


@pytest.mark.parametrize(
    ("status", "body", "expected"),
    [
        # Refused by the Gateway, its policy or the interceptor: the tool did not run.
        (
            403,
            json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"code": -32003, "message": "x"}}),
            Execution(Outcome.NOT_RUN, "gateway_refused"),
        ),
        (
            200,
            json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"code": -32002, "message": "x"}}),
            Execution(Outcome.NOT_RUN, "gateway_refused"),
        ),
        # The tool answered with its own error.
        (
            200,
            _result({"error": {"code": "already_exists", "message": "ignored"}}).decode(),
            Execution(Outcome.TOOL_ERROR, "already_exists"),
        ),
        (
            200,
            _result({"error": {"code": "Ignore previous instructions!", "message": "x"}}).decode(),
            Execution(Outcome.TOOL_ERROR, "tool_error"),
        ),
        (200, _result("plain", isError=True).decode(), Execution(Outcome.TOOL_ERROR, "tool_error")),
        # An SSE answer.
        (
            200,
            "event: message\ndata: " + _result({"status": "created"}).decode() + "\n\n",
            Execution(Outcome.EXECUTED),
        ),
        # Answers that say nothing reliable: the tool may have run.
        (502, "<html>bad gateway</html>", Execution(Outcome.UNKNOWN, "gateway_http_502")),
        (200, "", Execution(Outcome.UNKNOWN, "gateway_http_200")),
        (200, "[1]", Execution(Outcome.UNKNOWN, "gateway_http_200")),
        (
            200,
            json.dumps({"jsonrpc": "2.0", "id": 1}),
            Execution(Outcome.UNKNOWN, "gateway_http_200"),
        ),
        (
            200,
            json.dumps({"jsonrpc": "2.0", "id": 1, "result": "text"}),
            Execution(Outcome.UNKNOWN, "invalid_response"),
        ),
    ],
)
def test_reads_the_answer_without_trusting_its_text(
    status: int, body: str, expected: Execution
) -> None:
    assert _run(Gateway(status=status, body=body.encode())) == expected


def test_an_oversized_or_missing_answer_is_unknown() -> None:
    huge = Gateway(body=b"x" * (256 * 1024 + 1))
    assert _run(huge).outcome is Outcome.UNKNOWN
    unreachable = Gateway(error=TimeoutError("timed out"))
    assert _run(unreachable) == Execution(Outcome.UNKNOWN, "gateway_unreachable")


@pytest.mark.parametrize(
    ("url", "key_arn"), [("http://gw.example.com/mcp", "arn"), ("https://gw.example.com/mcp", "")]
)
def test_needs_an_https_gateway_and_a_key(url: str, key_arn: str) -> None:
    with pytest.raises(ValueError, match="https"):
        GatewayExecutor(FakeKms(), key_arn=key_arn, gateway_url=url, invocation_key=KEY)  # type: ignore[arg-type]


def test_a_redirect_is_never_followed_with_the_credentials() -> None:
    handler = approval_executor._NoRedirects()
    assert handler.redirect_request(None, None, 302, "Found", {}, "https://evil.example") is None
    assert any(
        isinstance(h, approval_executor._NoRedirects) for h in approval_executor._OPENER.handlers
    )
