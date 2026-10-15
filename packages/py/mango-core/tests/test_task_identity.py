"""The answer to the challenge of a task run (D78): what the challenge Lambda accepts."""

from __future__ import annotations

import hashlib
from typing import Any

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

from mango_core import task_identity

NOW = 1_800_000_000
NONCE = "n" * 43
RUN = "b" * 32
CLIENT = "tasksclient123"


def _key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


def _public(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )


def _answer(key: ec.EllipticCurvePrivateKey, **overrides: Any) -> str:
    fields: dict[str, Any] = {
        "subject": "user-1",
        "run_id": RUN,
        "nonce": NONCE,
        "client_id": CLIENT,
        "expires_at": NOW + 30,
    }
    claims = task_identity.encode_claims(**{**fields, **overrides})
    digest = task_identity.signing_digest(claims)
    return task_identity.assemble(
        claims, key.sign(digest, ec.ECDSA(utils.Prehashed(hashes.SHA256())))
    )


def _verifier(key: ec.EllipticCurvePrivateKey) -> task_identity.TaskIdentityVerifier:
    return task_identity.TaskIdentityVerifier(_public(key), clock=lambda: NOW)


def test_a_signed_answer_for_this_challenge_is_accepted() -> None:
    key = _key()
    identity = _verifier(key).verify(_answer(key), subject="user-1", nonce=NONCE, client_id=CLIENT)
    assert identity == task_identity.TaskIdentity("user-1", RUN, CLIENT, NOW + 30)


@pytest.mark.parametrize(
    ("subject", "nonce", "client"),
    [("user-2", NONCE, CLIENT), ("user-1", "m" * 43, CLIENT), ("user-1", NONCE, "webclient")],
)
def test_an_answer_for_another_person_challenge_or_client_is_refused(
    subject: str, nonce: str, client: str
) -> None:
    key = _key()
    with pytest.raises(task_identity.TaskIdentityError):
        _verifier(key).verify(_answer(key), subject=subject, nonce=nonce, client_id=client)


@pytest.mark.parametrize("expires_at", [NOW - 1, NOW + task_identity.TTL_SECONDS + 10])
def test_an_expired_or_too_long_answer_is_refused(expires_at: int) -> None:
    key = _key()
    with pytest.raises(task_identity.TaskIdentityError):
        _verifier(key).verify(
            _answer(key, expires_at=expires_at), subject="user-1", nonce=NONCE, client_id=CLIENT
        )


def test_an_answer_signed_by_another_key_is_refused() -> None:
    with pytest.raises(task_identity.TaskIdentityError):
        _verifier(_key()).verify(_answer(_key()), subject="user-1", nonce=NONCE, client_id=CLIENT)


def test_a_tampered_answer_is_refused() -> None:
    key = _key()
    version, claims, signature = _answer(key).split(".")
    other = task_identity.encode_claims(
        subject="user-1", run_id="c" * 32, nonce=NONCE, client_id=CLIENT, expires_at=NOW + 30
    )
    for value in (f"{version}.{other}.{signature}", f"v2.{claims}.{signature}", "garbage", 7, ""):
        with pytest.raises(task_identity.TaskIdentityError):
            _verifier(key).verify(value, subject="user-1", nonce=NONCE, client_id=CLIENT)


def test_an_approval_signature_is_never_an_answer() -> None:
    """Domain separation: the same key signing another kind of message proves nothing here."""
    key = _key()
    claims = task_identity.encode_claims(
        subject="user-1", run_id=RUN, nonce=NONCE, client_id=CLIENT, expires_at=NOW + 30
    )
    other = hashlib.sha256(b"mango-approval.v1." + claims.encode()).digest()
    forged = task_identity.assemble(
        claims, key.sign(other, ec.ECDSA(utils.Prehashed(hashes.SHA256())))
    )
    with pytest.raises(task_identity.TaskIdentityError):
        _verifier(key).verify(forged, subject="user-1", nonce=NONCE, client_id=CLIENT)


@pytest.mark.parametrize(
    "overrides",
    [{"subject": "a b"}, {"run_id": "x"}, {"nonce": "short"}, {"client_id": "with space"}],
)
def test_invalid_claims_are_never_signed(overrides: dict[str, str]) -> None:
    fields: dict[str, Any] = {
        "subject": "user-1",
        "run_id": RUN,
        "nonce": NONCE,
        "client_id": CLIENT,
        "expires_at": NOW,
    }
    with pytest.raises(ValueError, match="invalid"):
        task_identity.encode_claims(**{**fields, **overrides})
