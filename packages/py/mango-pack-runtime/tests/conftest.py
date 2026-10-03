"""Shared pieces of the pack runtime tests: a throwaway identity key and a fake of AWS that
answers every request with the access key that signed it (no network)."""

from __future__ import annotations

import base64
import json
import re
import time
from collections.abc import Iterator
from typing import Any

import pytest
from botocore.awsrequest import AWSResponse
from botocore.credentials import ReadOnlyCredentials
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

from mango_core import pack_identity
from mango_pack_runtime import credentials
from mango_pack_runtime.config import PackConfig, Statement
from mango_pack_runtime.identity import Caller

PACK = "aws-billing"
TOOL = "cost_explorer"
STATEMENTS = (Statement(actions=("ce:GetCostAndUsage",), resources=("*",)),)
_CREDENTIAL = re.compile(r"Credential=([^/]+)/")


class IdentityKey:
    """Stands for the KMS key of the Gateway interceptor."""

    def __init__(self) -> None:
        self._key = ec.generate_private_key(ec.SECP256R1())
        self.public_der = self._key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )

    def sign_digest(self, digest: bytes) -> bytes:
        return self._key.sign(digest, ec.ECDSA(utils.Prehashed(hashes.SHA256())))

    def assertion(
        self,
        subject: str = "user-1",
        tool: str = TOOL,
        *,
        pack: str = PACK,
        agent: str = "finops",
        central: bool = True,
        ttl: int = pack_identity.TTL_SECONDS,
        now: float | None = None,
    ) -> str:
        """An assertion exactly as the interceptor issues it (``mango_core.pack_identity``)."""
        claims = pack_identity.encode_claims(
            subject=subject,
            pack_id=pack,
            tool=tool,
            agent_id=agent,
            central=central,
            expires_at=int(now if now is not None else time.time()) + ttl,
        )
        return pack_identity.assemble(
            claims, self.sign_digest(pack_identity.signing_digest(claims))
        )

    def raw(self, claims: dict[str, Any]) -> str:
        """An assertion with arbitrary claims, validly signed."""
        encoded = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
        signature = self.sign_digest(pack_identity.signing_digest(encoded))
        return pack_identity.assemble(encoded, signature)


@pytest.fixture(scope="session")
def identity_key() -> IdentityKey:
    return IdentityKey()


def central_config(identity_key: IdentityKey | None = None) -> PackConfig:
    return PackConfig(
        pack_id=PACK,
        version="1.0.0-1",
        tools=frozenset({TOOL, "budgets"}),
        identity_mode="central_only",
        statements=STATEMENTS,
        broker_role_arn="arn:aws:iam::111122223333:role/Mango-test-BillingBroker",
        target_role_arn="arn:aws:iam::999988887777:role/Mango-test-BillingReader",
        identity_public_key=identity_key.public_der if identity_key else None,
        region="us-east-1",
    )


def keys_of(caller: Caller) -> ReadOnlyCredentials:
    """Session "assumed" for a caller: keys that name it, so a mix-up is visible."""
    return ReadOnlyCredentials(f"AKIA-{caller.subject}", "secret", f"token-{caller.subject}")


def echo_signer(client: Any) -> None:
    """Answer every request of ``client`` locally with the access key that signed it."""

    def before_send(request: Any, **_kwargs: Any) -> AWSResponse:
        match = _CREDENTIAL.search(request.headers["Authorization"].decode())
        assert match is not None
        body = (
            "<GetCallerIdentityResponse xmlns='https://sts.amazonaws.com/doc/2011-06-15/'>"
            f"<GetCallerIdentityResult><Arn>{match.group(1)}</Arn><UserId>u</UserId>"
            "<Account>111122223333</Account></GetCallerIdentityResult>"
            "</GetCallerIdentityResponse>"
        ).encode()

        class Raw:
            def stream(self, *_a: Any, **_k: Any) -> Iterator[bytes]:
                yield body

        response = AWSResponse(request.url, 200, {"Content-Type": "text/xml"}, Raw())
        response._content = body
        return response

    client.meta.events.register("before-send.sts.GetCallerIdentity", before_send)


@pytest.fixture
def bound(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """The process as a pack over account data runs: the default chain is the caller's."""
    # What the default chain would find without the patch: the pack role's own keys.
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIA-PACK-ROLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "pack-role-secret")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)
    monkeypatch.delenv("AWS_PROFILE", raising=False)
    credentials.install()
    try:
        yield
    finally:
        credentials.uninstall()
