"""Approval tokens (D27): the canonical hash of a call and what a verifier accepts."""

from __future__ import annotations

import base64
import json
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from moto import mock_aws

from mango_core import approval, approval_use

TOOL = "ops___create_budget"
ARGS = {"name": "team-a", "amount_usd": 100}
APPROVAL_ID = "a" * 32
NOW = 1_800_000_000


def _key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


def _public(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )


def _sign(key: ec.EllipticCurvePrivateKey, claims: str) -> bytes:
    """What KMS does with ``MessageType=DIGEST``."""
    return key.sign(approval.signing_digest(claims), ec.ECDSA(utils.Prehashed(hashes.SHA256())))


def _token(key: ec.EllipticCurvePrivateKey, **overrides: Any) -> str:
    fields: dict[str, Any] = {
        "approval_id": APPROVAL_ID,
        "subject": "user-1",
        "tool": TOOL,
        "args_hash": approval.call_hash(TOOL, ARGS),
        "agent_id": "finops",
        "expires_at": NOW + 60,
    }
    claims = approval.encode_claims(**{**fields, **overrides})
    return approval.assemble(claims, _sign(key, claims))


def _verifier(key: ec.EllipticCurvePrivateKey) -> approval.ApprovalVerifier:
    return approval.ApprovalVerifier(_public(key), clock=lambda: NOW)


# --- Canonical form and hash ----------------------------------------------------------------------


def test_the_hash_ignores_key_order_spacing_and_integral_floats() -> None:
    base = approval.call_hash(TOOL, {"name": "team-a", "amount_usd": 100, "account_ids": ["1"]})
    assert base == approval.call_hash(
        TOOL, {"account_ids": ["1"], "amount_usd": 100.0, "name": "team-a"}
    )
    assert approval.canonical_arguments({"b": 1.0, "a": "é"}) == '{"a":"é","b":1}'


@pytest.mark.parametrize(
    "other",
    [
        {"name": "team-a", "amount_usd": 100000},
        {"name": "team-b", "amount_usd": 100},
        {"name": "team-a", "amount_usd": 100, "account_ids": ["123456789012"]},
        {"name": "team-a", "amount_usd": "100"},
        {"name": "team-a", "amount_usd": 100.5},
    ],
)
def test_any_other_arguments_are_another_call(other: dict[str, Any]) -> None:
    assert approval.call_hash(TOOL, other) != approval.call_hash(TOOL, ARGS)


def test_the_hash_names_the_tool() -> None:
    assert approval.call_hash("ops___delete_budget", ARGS) != approval.call_hash(TOOL, ARGS)


@pytest.mark.parametrize(
    "arguments",
    [
        None,
        [1, 2],
        "text",
        {"amount": float("nan")},
        {"amount": float("inf")},
        {1: "x"},
        {"blob": b"x"},
        {"big": "x" * (approval.MAX_ARGUMENT_BYTES + 1)},
    ],
)
def test_arguments_without_a_canonical_form_are_rejected(arguments: Any) -> None:
    with pytest.raises(approval.InvalidArgumentsError):
        approval.call_hash(TOOL, arguments)


def test_arguments_nested_too_deep_are_rejected() -> None:
    nested: Any = {}
    for _ in range(approval.MAX_DEPTH + 2):
        nested = {"x": nested}
    with pytest.raises(approval.InvalidArgumentsError):
        approval.canonical_arguments(nested)


# --- Token ----------------------------------------------------------------------------------------


def test_a_token_approves_exactly_its_call() -> None:
    key = _key()
    approved = _verifier(key).verify(_token(key), subject="user-1", tool=TOOL, arguments=ARGS)
    assert approved == approval.Approval(
        approval_id=APPROVAL_ID,
        subject="user-1",
        tool=TOOL,
        args_hash=approval.call_hash(TOOL, ARGS),
        agent_id="finops",
        expires_at=NOW + 60,
    )


@pytest.mark.parametrize(
    ("subject", "tool", "arguments"),
    [
        ("user-2", TOOL, ARGS),  # someone else's session
        ("user-1", "ops___delete_budget", ARGS),  # another tool
        ("user-1", TOOL, {**ARGS, "amount_usd": 100000}),  # confirm small, run large (TM-W2)
        ("user-1", TOOL, {**ARGS, "extra": True}),
        ("user-1", TOOL, None),
    ],
)
def test_a_token_is_useless_for_any_other_call(subject: str, tool: str, arguments: Any) -> None:
    key = _key()
    with pytest.raises(approval.ApprovalError):
        _verifier(key).verify(_token(key), subject=subject, tool=tool, arguments=arguments)


def test_expired_or_long_lived_tokens_are_refused() -> None:
    key = _key()
    verifier = _verifier(key)
    for expires_at in (NOW - 1, NOW + approval.TTL_SECONDS + approval.CLOCK_SKEW_SECONDS + 1):
        with pytest.raises(approval.ApprovalError):
            verifier.verify(
                _token(key, expires_at=expires_at), subject="user-1", tool=TOOL, arguments=ARGS
            )


def test_a_token_signed_by_another_key_is_refused() -> None:
    with pytest.raises(approval.ApprovalError):
        _verifier(_key()).verify(_token(_key()), subject="user-1", tool=TOOL, arguments=ARGS)


def test_tampered_claims_are_refused() -> None:
    key = _key()
    version, claims, signature = _token(key).split(".")
    forged = json.loads(base64.urlsafe_b64decode(claims + "=" * (-len(claims) % 4)))
    forged["sub"] = "user-2"
    encoded = base64.urlsafe_b64encode(json.dumps(forged).encode()).decode().rstrip("=")
    with pytest.raises(approval.ApprovalError):
        _verifier(key).verify(
            f"{version}.{encoded}.{signature}", subject="user-2", tool=TOOL, arguments=ARGS
        )


@pytest.mark.parametrize("token", [None, "", "v1.a", "v2.a.b", "v1.!!.!!", "x" * 3000, 7])
def test_malformed_tokens_are_refused(token: Any) -> None:
    with pytest.raises(approval.ApprovalError):
        _verifier(_key()).verify(token, subject="user-1", tool=TOOL, arguments=ARGS)


def test_a_signature_is_not_valid_as_a_pack_identity() -> None:
    """Domain separation: the same bytes signed for another purpose do not verify."""
    key = _key()
    claims = approval.encode_claims(
        approval_id=APPROVAL_ID,
        subject="user-1",
        tool=TOOL,
        args_hash=approval.call_hash(TOOL, ARGS),
        agent_id="finops",
        expires_at=NOW + 60,
    )
    other = key.sign(b"mango-pack-identity." + f"v1.{claims}".encode(), ec.ECDSA(hashes.SHA256()))
    with pytest.raises(approval.ApprovalError):
        _verifier(key).verify(
            approval.assemble(claims, other), subject="user-1", tool=TOOL, arguments=ARGS
        )


@pytest.mark.parametrize(
    "overrides",
    [
        {"approval_id": "APR-1"},
        {"subject": "bad subject"},
        {"tool": "create_budget"},
        {"args_hash": "abc"},
        {"agent_id": "Bad Agent"},
    ],
)
def test_claims_with_invalid_values_are_never_issued(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValueError, match="invalid approval"):
        _token(_key(), **overrides)


def test_only_a_p256_key_verifies() -> None:
    other = ec.generate_private_key(ec.SECP384R1())
    with pytest.raises(ValueError, match="P-256"):
        approval.ApprovalVerifier(_public(other))


# --- Single use -----------------------------------------------------------------------------------


def _approved() -> approval.Approval:
    return approval.Approval(
        approval_id=APPROVAL_ID,
        subject="user-1",
        tool=TOOL,
        args_hash=approval.call_hash(TOOL, ARGS),
        agent_id="finops",
        expires_at=NOW + 60,
    )


def _item(db: Any, **overrides: Any) -> None:
    approved = _approved()
    item = {
        "PK": {"S": f"APPROVAL#{APPROVAL_ID}"},
        "SK": {"S": "META"},
        "status": {"S": "executing"},
        "args_hash": {"S": approved.args_hash},
        "requested_by": {"S": "user-1"},
        "gateway_tool": {"S": TOOL},
        "expires_epoch": {"N": str(NOW + 3600)},
    }
    db.put_item(TableName="approvals", Item={**item, **overrides})


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> Any:
    for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(name, "testing")
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        client.create_table(
            TableName="approvals",
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield client


def _claim(db: Any, mark: str, after: str | None = None) -> None:
    approval_use.claim(db, "approvals", _approved(), mark=mark, after=after, now=NOW)


def test_an_approval_is_spent_once_per_enforcement_point(db: Any) -> None:
    _item(db)
    _claim(db, approval_use.GATEWAY_MARK)
    with pytest.raises(approval_use.ApprovalUsedError):
        _claim(db, approval_use.GATEWAY_MARK)
    _claim(db, approval_use.EXECUTOR_MARK, after=approval_use.GATEWAY_MARK)
    with pytest.raises(approval_use.ApprovalUsedError):
        _claim(db, approval_use.EXECUTOR_MARK, after=approval_use.GATEWAY_MARK)


def test_the_executor_only_runs_what_the_gateway_let_through(db: Any) -> None:
    _item(db)
    with pytest.raises(approval_use.ApprovalUsedError):
        _claim(db, approval_use.EXECUTOR_MARK, after=approval_use.GATEWAY_MARK)


def test_the_claim_names_only_the_key_and_the_marks(db: Any) -> None:
    """Whatever a claim names, IAM would also let a compromised enforcement point rewrite: it
    must never touch what mango-api decides with (status, hash, who asked, expiry) (TM-W7)."""
    _item(db)
    requests: list[dict[str, Any]] = []
    db.meta.events.register(
        "provide-client-params.dynamodb.UpdateItem",
        lambda params, **_: requests.append(dict(params)),
    )
    _claim(db, approval_use.GATEWAY_MARK)
    _claim(db, approval_use.EXECUTOR_MARK, after=approval_use.GATEWAY_MARK)
    named = {name for request in requests for name in request["ExpressionAttributeNames"].values()}
    assert named == {approval_use.GATEWAY_MARK, approval_use.EXECUTOR_MARK}
    for request in requests:
        expression = request["ConditionExpression"] + request["UpdateExpression"]
        for attribute in ("status", "args_hash", "requested_by", "expires_epoch", "signers"):
            assert attribute not in expression
        assert request["ReturnValues"] == "NONE"
    stored = db.get_item(
        TableName="approvals", Key={"PK": {"S": f"APPROVAL#{APPROVAL_ID}"}, "SK": {"S": "META"}}
    )["Item"]
    assert stored["status"] == {"S": "executing"}


def test_a_missing_request_cannot_be_spent(db: Any) -> None:
    with pytest.raises(approval_use.ApprovalUsedError):
        _claim(db, approval_use.GATEWAY_MARK)


def test_other_errors_propagate_so_callers_fail_closed(db: Any) -> None:
    with pytest.raises(ClientError):
        approval_use.claim(
            db, "missing-table", _approved(), mark=approval_use.GATEWAY_MARK, now=NOW
        )
