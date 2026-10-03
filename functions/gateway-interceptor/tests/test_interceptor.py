import base64
import hashlib
import hmac
import json
import logging
import time
from typing import Any

import pytest
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

from mango_core import approval, approval_use, invocation
from mango_gateway_interceptor.handler import (
    APPROVAL_REQUIRED_MESSAGE,
    Approvals,
    PackIdentities,
    _approvals,
    _context_targets,
    _pack_identities,
    handle,
)
from mango_pack_runtime.identity import IdentityError, IdentityVerifier

KEY = b"k" * 32
TARGETS = frozenset({"finops"})
TOOL = "finops___get_cost_and_usage"


def _token(sub: str = "user-1", **claims: str) -> str:
    body = json.dumps({"sub": sub, **claims}).encode()
    payload = base64.urlsafe_b64encode(body).decode().rstrip("=")
    return f"eyJhbGciOiJSUzI1NiJ9.{payload}.signature"


def _headers(
    sub: str = "user-1",
    signed_for: str | None = None,
    ttl: int = 300,
    tools: tuple[str, ...] = (TOOL,),
) -> dict[str, str]:
    expires = int(time.time()) + ttl
    return {
        "Authorization": f"Bearer {_token(sub)}",
        invocation.HEADER: invocation.sign(
            KEY, signed_for or sub, expires, agent_id="finops", agent_version=1, tools=tools
        ),
    }


def _legacy_headers(sub: str = "user-1") -> dict[str, str]:
    expires = int(time.time()) + 300
    mac = hmac.new(KEY, f"v1|{sub}|{expires}".encode(), hashlib.sha256).hexdigest()
    return {"Authorization": f"Bearer {_token(sub)}", invocation.HEADER: f"v1.{expires}.{mac}"}


def _event(
    method: str, arguments: dict[str, Any], headers: dict[str, str], name: Any = TOOL
) -> dict[str, Any]:
    return {
        "interceptorInputVersion": "1.0",
        "mcp": {
            "gatewayRequest": {
                "path": "/mcp",
                "httpMethod": "POST",
                "headers": headers,
                "body": {
                    "jsonrpc": "2.0",
                    "id": 7,
                    "method": method,
                    "params": {"name": name, "arguments": arguments},
                },
            }
        },
    }


def _args(result: dict[str, Any]) -> dict[str, Any]:
    args: dict[str, Any] = result["mcp"]["transformedGatewayRequest"]["body"]["params"]["arguments"]
    return args


def _denied(result: dict[str, Any]) -> bool:
    return "transformedGatewayResponse" in result["mcp"]


def test_injects_caller_token() -> None:
    result = handle(_event("tools/call", {"start_date": "2026-09-01"}, _headers()), KEY, TARGETS)
    assert _args(result) == {"start_date": "2026-09-01", "_mango_ctx": {"token": _token()}}


def test_overwrites_model_supplied_context() -> None:
    event = _event("tools/call", {"_mango_ctx": {"token": "forged"}, "x": 1}, _headers())
    assert _args(handle(event, KEY, TARGETS))["_mango_ctx"] == {"token": _token()}


def test_denies_without_bearer_token() -> None:
    headers = _headers()
    headers["Authorization"] = "Basic xyz"
    result = handle(_event("tools/call", {}, headers), KEY, TARGETS)
    response = result["mcp"]["transformedGatewayResponse"]
    assert response["statusCode"] == 401
    assert response["body"]["id"] == 7


@pytest.mark.parametrize("method", ["tools/call", "tools/list", "initialize"])
def test_denies_direct_calls_without_mango_invocation(method: str) -> None:
    headers = _headers()
    del headers[invocation.HEADER]
    assert _denied(handle(_event(method, {}, headers), KEY, TARGETS))


def test_denies_invocation_signed_for_another_user() -> None:
    assert _denied(handle(_event("tools/call", {}, _headers(signed_for="user-2")), KEY, TARGETS))


def test_denies_expired_invocation() -> None:
    assert _denied(handle(_event("tools/call", {}, _headers(ttl=-10)), KEY, TARGETS))


def test_non_tool_calls_pass_through_unchanged_when_signed() -> None:
    event = _event("tools/list", {}, _headers())
    result = handle(event, KEY, TARGETS)
    assert (
        result["mcp"]["transformedGatewayRequest"]["body"] == event["mcp"]["gatewayRequest"]["body"]
    )


def test_malformed_request_is_denied() -> None:
    assert _denied(handle({"mcp": {"gatewayRequest": {"body": "not-json"}}}, KEY, TARGETS))


# --- Tools of the agent version (D33, TM-M12) ---------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "finops___get_savings_plans_recommendation",  # allowed to the user, not to this agent
        "other___get_cost_and_usage",
        "get_cost_and_usage",
        "",
        None,
        ["finops___get_cost_and_usage"],
        {"name": TOOL},
    ],
)
def test_tool_outside_the_agent_version_is_denied(name: Any) -> None:
    result = handle(_event("tools/call", {"x": 1}, _headers(), name=name), KEY, TARGETS)
    response = result["mcp"]["transformedGatewayResponse"]
    assert response["statusCode"] == 403
    assert response["body"] == {
        "jsonrpc": "2.0",
        "id": 7,
        "error": {"code": -32003, "message": "tool not allowed for this agent"},
    }


def test_agent_without_tools_can_call_none() -> None:
    assert _denied(handle(_event("tools/call", {}, _headers(tools=())), KEY, TARGETS))


def test_every_tool_of_the_version_is_allowed() -> None:
    headers = _headers(tools=(TOOL, "finops___get_anomalies"))
    for name in (TOOL, "finops___get_anomalies"):
        assert not _denied(handle(_event("tools/call", {}, headers, name=name), KEY, TARGETS))


@pytest.mark.parametrize("method", ["tools/call", "tools/list", "initialize"])
def test_legacy_signature_is_rejected(method: str) -> None:
    # v1 names neither the agent nor its tools (D33).
    result = handle(_event(method, {}, _legacy_headers()), KEY, TARGETS)
    assert result["mcp"]["transformedGatewayResponse"]["statusCode"] == 401


def test_rejections_log_the_reason_and_nothing_else(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO)
    secret_args = {"note": "SECRET-ARGUMENT"}
    handle(_event("tools/call", secret_args, _headers(), name="finops___other_tool"), KEY, TARGETS)
    handle(_event("tools/call", secret_args, _headers(signed_for="user-2")), KEY, TARGETS)
    reasons = [json.loads(r.getMessage())["reason"] for r in caplog.records]
    assert reasons == ["tool_not_in_agent_version", "invalid_invocation"]
    logged = " ".join(r.getMessage() for r in caplog.records)
    assert "SECRET-ARGUMENT" not in logged
    assert _token() not in logged
    assert "finops___other_tool" not in logged


# --- MCP packs: third-party servers never get the caller's token (D43, TM-B9) -------------


@pytest.mark.parametrize(
    "tool",
    [
        "aws-pricing___get_pricing",  # an MCP pack
        "finops-evil___get_cost_and_usage",  # a target that only starts like a connector
        "finops-___get_cost_and_usage",
        "FINOPS___get_cost_and_usage",  # target names are compared exactly
    ],
)
def test_pack_tools_never_get_the_caller_token(tool: str) -> None:
    supplied = {"service_code": "AmazonEC2", "_mango_ctx": {"token": "forged"}}
    event = _event("tools/call", supplied, _headers(tools=(tool,)), name=tool)
    result = handle(event, KEY, TARGETS)
    assert _args(result) == {"service_code": "AmazonEC2"}
    assert _token() not in json.dumps(result)


def test_pack_calls_still_need_a_signed_invocation_that_names_the_tool() -> None:
    tool = "aws-pricing___get_pricing"
    headers = _headers(tools=(tool,))
    del headers[invocation.HEADER]
    assert _denied(handle(_event("tools/call", {}, headers, name=tool), KEY, TARGETS))
    # Signed for an agent version that does not have the pack tool.
    assert _denied(handle(_event("tools/call", {}, _headers(), name=tool), KEY, TARGETS))


def test_context_targets_come_from_the_stack(monkeypatch: pytest.MonkeyPatch) -> None:
    _context_targets.cache_clear()
    monkeypatch.setenv("CONTEXT_TARGETS", '["finops"]')
    assert _context_targets() == frozenset({"finops"})
    _context_targets.cache_clear()
    # Fail closed on a missing or malformed list: the function errors, the Gateway denies.
    monkeypatch.setenv("CONTEXT_TARGETS", '"finops"')
    with pytest.raises(ValueError, match="CONTEXT_TARGETS"):
        _context_targets()
    _context_targets.cache_clear()
    monkeypatch.delenv("CONTEXT_TARGETS")
    with pytest.raises(KeyError):
        _context_targets()
    _context_targets.cache_clear()


# --- Packs over account data: a signed caller, never the token (D37, TM-M3) ---------------

PACK = "aws-billing"
PACK_TOOL = f"{PACK}___cost_explorer"
_IDENTITY_KEY = ec.generate_private_key(ec.SECP256R1())
_IDENTITY_PUBLIC = _IDENTITY_KEY.public_key().public_bytes(
    serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
)


def _kms_sign(digest: bytes) -> bytes:
    """What KMS does with ``MessageType=DIGEST`` and ``ECDSA_SHA_256``."""
    return _IDENTITY_KEY.sign(digest, ec.ECDSA(utils.Prehashed(hashes.SHA256())))


PACKS = PackIdentities(targets=frozenset({PACK}), sign=_kms_sign)


def _pack_event(central: str | None, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
    claims = {} if central is None else {"mango_central": central}
    headers = _headers(tools=(PACK_TOOL,))
    headers["Authorization"] = f"Bearer {_token(**claims)}"
    return _event("tools/call", arguments or {"service": "AmazonEC2"}, headers, name=PACK_TOOL)


def test_account_data_pack_gets_a_signed_caller_and_never_the_token() -> None:
    supplied = {"service": "AmazonEC2", "_mango_ctx": {"identity": "forged", "token": "forged"}}
    result = handle(_pack_event("true", supplied), KEY, TARGETS, PACKS)
    args = _args(result)
    assert set(args) == {"service", "_mango_ctx"}
    assert set(args["_mango_ctx"]) == {"identity"}
    assert _token(mango_central="true") not in json.dumps(result)
    # The pack's own verifier accepts it: for this pack, this tool and this user only.
    caller = IdentityVerifier(_IDENTITY_PUBLIC, PACK).verify(
        args["_mango_ctx"]["identity"], "cost_explorer"
    )
    assert (caller.subject, caller.agent_id, caller.central) == ("user-1", "finops", True)
    with pytest.raises(IdentityError):
        IdentityVerifier(_IDENTITY_PUBLIC, "other-pack").verify(
            args["_mango_ctx"]["identity"], "cost_explorer"
        )
    with pytest.raises(IdentityError):
        IdentityVerifier(_IDENTITY_PUBLIC, PACK).verify(args["_mango_ctx"]["identity"], "budgets")


@pytest.mark.parametrize("central", [None, "false", "TRUE", "1", ""])
def test_account_data_pack_is_refused_to_users_who_are_not_central(central: str | None) -> None:
    # Cedar L2 denies it too; the agent having the tool does not matter (TM-M3).
    result = handle(_pack_event(central), KEY, TARGETS, PACKS)
    assert result["mcp"]["transformedGatewayResponse"]["statusCode"] == 403


def test_account_data_pack_fails_closed_when_the_caller_cannot_be_signed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def broken(_digest: bytes) -> bytes:
        raise ClientError({"Error": {"Code": "KMSInvalidStateException"}}, "Sign")

    packs = PackIdentities(targets=frozenset({PACK}), sign=broken)
    result = handle(_pack_event("true"), KEY, TARGETS, packs)
    assert result["mcp"]["transformedGatewayResponse"]["statusCode"] == 503
    assert "transformedGatewayRequest" not in result["mcp"]
    assert _token(mango_central="true") not in caplog.text


def test_other_packs_get_nothing_even_for_central_users() -> None:
    tool = "aws-pricing___get_pricing"
    headers = _headers(tools=(tool,))
    headers["Authorization"] = f"Bearer {_token(mango_central='true')}"
    event = _event("tools/call", {"_mango_ctx": {"identity": "forged"}}, headers, name=tool)
    assert _args(handle(event, KEY, TARGETS, PACKS)) == {}


def test_identity_targets_come_from_the_stack(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("CONTEXT_TARGETS", '["finops"]')
    for cached in (_context_targets, _pack_identities):
        cached.cache_clear()
    # A release without account-data packs: no targets, no key needed.
    monkeypatch.delenv("IDENTITY_TARGETS", raising=False)
    assert _pack_identities().targets == frozenset()
    _pack_identities.cache_clear()
    monkeypatch.setenv("IDENTITY_TARGETS", '["aws-billing"]')
    with pytest.raises(ValueError, match="PACK_IDENTITY_KEY_ARN"):
        _pack_identities()
    _pack_identities.cache_clear()
    monkeypatch.setenv("PACK_IDENTITY_KEY_ARN", "arn:aws:kms:us-east-1:111122223333:key/abc")
    assert _pack_identities().targets == frozenset({"aws-billing"})
    _pack_identities.cache_clear()
    # A target is a connector (token) or a pack (assertion), never both.
    monkeypatch.setenv("IDENTITY_TARGETS", '["finops"]')
    with pytest.raises(ValueError, match="both"):
        _pack_identities()
    for cached in (_context_targets, _pack_identities):
        cached.cache_clear()


# --- Write tools need an approval (D27, TM-W1 to TM-W3) -------------------------------------

WRITE_TOOL = "ops___create_budget"
WRITE_TARGETS = frozenset({"finops", "ops"})
WRITE_ARGS = {"name": "team-a", "amount_usd": 100}
APPROVAL_ID = "a" * 32
APPROVAL_KEY = ec.generate_private_key(ec.SECP256R1())


class _Spent:
    """The request items the interceptor marks, in memory."""

    def __init__(self, fail: Exception | None = None) -> None:
        self.used: list[str] = []
        self.fail = fail

    def __call__(self, approved: approval.Approval, _now: int) -> None:
        if self.fail is not None:
            raise self.fail
        if approved.approval_id in self.used:
            raise approval_use.ApprovalUsedError
        self.used.append(approved.approval_id)


def _approvals_for(spent: _Spent, key: ec.EllipticCurvePrivateKey = APPROVAL_KEY) -> Approvals:
    public = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return Approvals(
        tools=frozenset({WRITE_TOOL}),
        verifier=lambda: approval.ApprovalVerifier(public),
        claim=spent,
    )


def _approval_token(
    arguments: dict[str, Any] = WRITE_ARGS,
    *,
    subject: str = "user-1",
    tool: str = WRITE_TOOL,
    agent_id: str = "finops",
    ttl: int = 60,
    key: ec.EllipticCurvePrivateKey = APPROVAL_KEY,
) -> str:
    claims = approval.encode_claims(
        approval_id=APPROVAL_ID,
        subject=subject,
        tool=tool,
        args_hash=approval.call_hash(tool, arguments),
        agent_id=agent_id,
        expires_at=int(time.time()) + ttl,
    )
    signature = key.sign(
        approval.signing_digest(claims), ec.ECDSA(utils.Prehashed(hashes.SHA256()))
    )
    return approval.assemble(claims, signature)


def _write_call(
    arguments: dict[str, Any],
    token: str | None,
    spent: _Spent,
    *,
    sub: str = "user-1",
) -> dict[str, Any]:
    headers = _headers(sub, tools=(WRITE_TOOL, TOOL))
    if token is not None:
        headers[approval.HEADER] = token
    event = _event("tools/call", arguments, headers, name=WRITE_TOOL)
    return handle(event, KEY, WRITE_TARGETS, None, _approvals_for(spent))


def _refusal(result: dict[str, Any]) -> tuple[int, str]:
    response = result["mcp"]["transformedGatewayResponse"]
    return response["statusCode"], response["body"]["error"]["message"]


def test_a_write_tool_without_an_approval_is_refused_and_nothing_is_spent() -> None:
    spent = _Spent()
    status, message = _refusal(_write_call(dict(WRITE_ARGS), None, spent))
    assert (status, message) == (403, APPROVAL_REQUIRED_MESSAGE)
    assert spent.used == []
    # The model reads a fixed text: nothing of the request is echoed back.
    assert "team-a" not in message


def test_an_approved_call_goes_through_once_with_its_token_for_the_executor() -> None:
    spent = _Spent()
    token = _approval_token()
    result = _write_call(dict(WRITE_ARGS), token, spent)
    assert _args(result) == {
        **WRITE_ARGS,
        "_mango_ctx": {"token": _token(), "approval": token},
    }
    assert spent.used == [APPROVAL_ID]
    # The same token again (TM-W3).
    assert _refusal(_write_call(dict(WRITE_ARGS), token, spent))[0] == 403


def test_a_model_supplied_context_never_carries_an_approval() -> None:
    spent = _Spent()
    forged = {**WRITE_ARGS, "_mango_ctx": {"token": "forged", "approval": _approval_token()}}
    assert _refusal(_write_call(forged, None, spent))[0] == 403
    assert spent.used == []


@pytest.mark.parametrize(
    ("arguments", "token_kwargs"),
    [
        ({**WRITE_ARGS, "amount_usd": 100000}, {}),  # confirm small, run large (TM-W2)
        ({**WRITE_ARGS, "account_ids": ["123456789012"]}, {}),
        (WRITE_ARGS, {"subject": "user-2"}),  # approved for someone else
        (WRITE_ARGS, {"tool": "ops___delete_budget"}),
        (WRITE_ARGS, {"agent_id": "other"}),  # approved for another agent
        (WRITE_ARGS, {"ttl": -5}),
        (WRITE_ARGS, {"key": ec.generate_private_key(ec.SECP256R1())}),  # not mango-api's key
    ],
)
def test_an_approval_for_any_other_call_is_refused(
    arguments: dict[str, Any], token_kwargs: dict[str, Any]
) -> None:
    spent = _Spent()
    token = _approval_token(WRITE_ARGS, **token_kwargs)
    result = _write_call(dict(arguments), token, spent)
    assert _refusal(result)[0] == 403
    assert spent.used == []


def test_the_approval_survives_the_gateway_reordering_the_arguments() -> None:
    spent = _Spent()
    reordered = {"amount_usd": 100.0, "name": "team-a"}
    assert not _denied(_write_call(reordered, _approval_token(), spent))


def test_a_write_tool_still_needs_to_be_in_the_signed_invocation() -> None:
    spent = _Spent()
    headers = _headers()  # signed for an agent version without the write tool
    headers[approval.HEADER] = _approval_token()
    event = _event("tools/call", dict(WRITE_ARGS), headers, name=WRITE_TOOL)
    assert _denied(handle(event, KEY, WRITE_TARGETS, None, _approvals_for(spent)))
    assert spent.used == []


def test_fails_closed_when_the_approval_cannot_be_checked(caplog: pytest.LogCaptureFixture) -> None:
    error = ClientError({"Error": {"Code": "ProvisionedThroughputExceededException"}}, "UpdateItem")
    spent = _Spent(fail=error)
    with caplog.at_level(logging.INFO):
        status, _message = _refusal(_write_call(dict(WRITE_ARGS), _approval_token(), spent))
    assert status == 503
    logged = " ".join(r.getMessage() for r in caplog.records)
    assert "approval_unavailable" in logged
    assert "team-a" not in logged and _approval_token() not in logged


def test_read_tools_need_no_approval() -> None:
    spent = _Spent()
    event = _event("tools/call", {"start_date": "2026-09-01"}, _headers())
    result = handle(event, KEY, WRITE_TARGETS, None, _approvals_for(spent))
    assert _args(result)["_mango_ctx"] == {"token": _token()}


def test_approval_tools_come_from_the_stack(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    _approvals.cache_clear()
    # A release without write tools: nothing to check, no key or table needed.
    monkeypatch.delenv("APPROVAL_TOOLS", raising=False)
    assert _approvals().tools == frozenset()
    _approvals.cache_clear()
    monkeypatch.setenv("APPROVAL_TOOLS", '["ops___create_budget"]')
    with pytest.raises(ValueError, match="APPROVAL_KEY_ARN"):
        _approvals()
    _approvals.cache_clear()
    monkeypatch.setenv("APPROVAL_KEY_ARN", "arn:aws:kms:us-east-1:111122223333:key/abc")
    monkeypatch.setenv("APPROVALS_TABLE", "Mango-poc-Approvals")
    assert _approvals().tools == frozenset({WRITE_TOOL})
    _approvals.cache_clear()
