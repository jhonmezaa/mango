"""The pack side of the caller assertion: only what the interceptor signed, for this call."""

from __future__ import annotations

import time
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from mango_core import pack_identity
from mango_pack_runtime import identity
from mango_pack_runtime.identity import Caller, IdentityError, IdentityVerifier

from .conftest import PACK, TOOL, IdentityKey

NOW = 1_800_000_000


def _verifier(key: IdentityKey, pack: str = PACK) -> IdentityVerifier:
    return IdentityVerifier(key.public_der, pack, clock=lambda: NOW)


def test_accepts_what_the_interceptor_issues(identity_key: IdentityKey) -> None:
    assertion = identity_key.assertion("3f1c-user", now=NOW)
    assert _verifier(identity_key).verify(assertion, TOOL) == Caller(
        subject="3f1c-user", tool=TOOL, agent_id="finops", central=True
    )


def test_both_halves_agree_on_the_format() -> None:
    """``mango_core.pack_identity`` issues, this package verifies: same constants."""
    assert identity.VERSION == pack_identity.VERSION
    assert identity.SIGNING_CONTEXT == pack_identity.SIGNING_CONTEXT
    assert identity.MAX_TTL_SECONDS == pack_identity.TTL_SECONDS
    assert identity.MAX_CHARS == pack_identity.MAX_CHARS


def test_another_key_is_refused(identity_key: IdentityKey) -> None:
    forged = IdentityKey().assertion(now=NOW)
    with pytest.raises(IdentityError):
        _verifier(identity_key).verify(forged, TOOL)


def test_a_changed_claim_is_refused(identity_key: IdentityKey) -> None:
    version, _claims, signature = identity_key.assertion("user-1", now=NOW).split(".")
    other = identity_key.assertion("user-2", now=NOW).split(".")[1]
    with pytest.raises(IdentityError):
        _verifier(identity_key).verify(f"{version}.{other}.{signature}", TOOL)


def test_it_is_for_one_pack_and_one_tool(identity_key: IdentityKey) -> None:
    assertion = identity_key.assertion(now=NOW)
    with pytest.raises(IdentityError):
        _verifier(identity_key).verify(assertion, "budgets")
    with pytest.raises(IdentityError):
        _verifier(identity_key, "aws-cloudwatch").verify(assertion, TOOL)


@pytest.mark.parametrize("ttl", [-1, pack_identity.TTL_SECONDS + 30, 3600])
def test_expired_or_long_lived_assertions_are_refused(identity_key: IdentityKey, ttl: int) -> None:
    with pytest.raises(IdentityError):
        _verifier(identity_key).verify(identity_key.assertion(ttl=ttl, now=NOW), TOOL)


def _claims(**changes: Any) -> dict[str, Any]:
    base = {
        "sub": "user-1",
        "aud": PACK,
        "tool": TOOL,
        "agent": "finops",
        "central": True,
        "exp": NOW + 30,
    }
    return {k: v for k, v in {**base, **changes}.items() if v is not ...}


@pytest.mark.parametrize(
    "claims",
    [
        _claims(sub="x"),  # not a valid SourceIdentity
        _claims(sub="user 1"),
        _claims(sub=123),
        _claims(agent="Not An Agent"),
        _claims(central="true"),
        _claims(central=...),
        _claims(exp=True),
        _claims(exp=str(NOW + 30)),
        _claims(aud=[PACK]),
    ],
)
def test_validly_signed_but_malformed_claims_are_refused(
    identity_key: IdentityKey, claims: dict[str, Any]
) -> None:
    with pytest.raises(IdentityError):
        _verifier(identity_key).verify(identity_key.raw(claims), TOOL)


@pytest.mark.parametrize(
    "value",
    [None, 7, "", "v1", "v1.e30", "v2.e30.AAAA", "v1.!!!.AAAA", "v1.e30.AAAA", "x" * 5000],
)
def test_anything_else_is_refused(identity_key: IdentityKey, value: object) -> None:
    with pytest.raises(IdentityError):
        _verifier(identity_key).verify(value, TOOL)


def test_a_signature_of_the_key_over_something_else_is_not_an_assertion(
    identity_key: IdentityKey,
) -> None:
    """Domain separation: the bare ``v1.<claims>`` signed without the context is refused."""
    import hashlib  # noqa: PLC0415

    from mango_pack_runtime.identity import VERSION  # noqa: PLC0415

    encoded = identity_key.assertion(now=NOW).split(".")[1]
    signature = identity_key.sign_digest(hashlib.sha256(f"{VERSION}.{encoded}".encode()).digest())
    with pytest.raises(IdentityError):
        _verifier(identity_key).verify(pack_identity.assemble(encoded, signature), TOOL)


def test_only_a_p256_key_verifies_callers() -> None:
    def der(key: Any) -> bytes:
        return bytes(
            key.public_key().public_bytes(
                serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
            )
        )

    for key in (
        rsa.generate_private_key(public_exponent=65537, key_size=2048),
        ec.generate_private_key(ec.SECP384R1()),
    ):
        with pytest.raises(ValueError, match="P-256"):
            IdentityVerifier(der(key), PACK)


def test_default_clock_is_the_wall_clock(identity_key: IdentityKey) -> None:
    verifier = IdentityVerifier(identity_key.public_der, PACK)
    assert verifier.verify(identity_key.assertion(now=time.time()), TOOL).subject == "user-1"
