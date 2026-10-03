"""Who is calling a tool of this pack, from the assertion the Gateway interceptor signed.

The verifying half of ``mango_core.pack_identity`` (same format; the pack zip cannot import
``mango_core``). The pack only holds the public key, so its own code, third-party included,
cannot mint an assertion another pack or another installation would accept.

Nothing of the assertion is parsed before its signature is verified, and every failure is the
same ``IdentityError``: the answer never says which check failed.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

VERSION = "v1"
SIGNING_CONTEXT = b"mango-pack-identity."
MAX_TTL_SECONDS = 60
"""Longest life the interceptor gives an assertion; one that claims more is refused."""
CLOCK_SKEW_SECONDS = 5
MAX_CHARS = 2048

_SUBJECT_RE = re.compile(r"^[\w+=,.@-]{2,64}$", re.ASCII)
_AGENT_RE = re.compile(r"^[a-z0-9]{2,16}$")
_PARTS = 3


class IdentityError(Exception):
    """The call is not one this pack serves, or it names no caller the pack can trust."""


@dataclass(frozen=True)
class Caller:
    """The person a tool call is made for, as the Gateway interceptor vouched."""

    subject: str
    """Cognito ``sub`` of the user; it becomes the ``SourceIdentity`` of the AWS session."""
    tool: str
    agent_id: str
    central: bool


def _decode(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


class IdentityVerifier:
    def __init__(
        self,
        public_key_der: bytes,
        pack_id: str,
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        key = serialization.load_der_public_key(public_key_der)
        if not isinstance(key, ec.EllipticCurvePublicKey) or key.curve.name != "secp256r1":
            raise ValueError("the pack identity key must be ECC NIST P-256")
        self._key = key
        self._pack_id = pack_id
        self._now = clock

    def verify(self, assertion: object, tool: str) -> Caller:
        """The caller ``assertion`` names, if it was issued for this pack and this tool."""
        if not isinstance(assertion, str) or not 0 < len(assertion) <= MAX_CHARS:
            raise IdentityError
        parts = assertion.split(".")
        if len(parts) != _PARTS or parts[0] != VERSION:
            raise IdentityError
        _, encoded, signature = parts
        try:
            self._key.verify(
                _decode(signature),
                SIGNING_CONTEXT + f"{VERSION}.{encoded}".encode(),
                ec.ECDSA(hashes.SHA256()),
            )
            claims = json.loads(_decode(encoded))
        except (InvalidSignature, ValueError, binascii.Error):
            raise IdentityError from None
        if not isinstance(claims, dict):
            raise IdentityError
        subject, agent, expires = claims.get("sub"), claims.get("agent"), claims.get("exp")
        now = self._now()
        if (
            not isinstance(subject, str)
            or not _SUBJECT_RE.fullmatch(subject)
            or not isinstance(agent, str)
            or not _AGENT_RE.fullmatch(agent)
            or isinstance(expires, bool)
            or not isinstance(expires, int)
            or expires < now
            or expires > now + MAX_TTL_SECONDS + CLOCK_SKEW_SECONDS
            # Issued for another pack, or for another tool of this one: not this call.
            or claims.get("aud") != self._pack_id
            or claims.get("tool") != tool
            or not isinstance(claims.get("central"), bool)
        ):
            raise IdentityError
        return Caller(subject=subject, tool=tool, agent_id=agent, central=claims["central"])
