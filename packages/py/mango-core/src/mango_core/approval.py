"""Approval of one write tool call (D27, TM-W1 to TM-W3).

No write tool runs without a person confirming it. What that person saw and what runs must be
the same call, so everything hangs from one value: ``sha256`` of the tool and its arguments in
a canonical form. mango-api stores the arguments, shows them, and once the call is confirmed
signs a short token naming the request, who asked, the tool and that hash. The Gateway
interceptor and the approval executor each verify the token against the call they actually
received; neither can sign (they only hold the public key).

Format: ``v1.<base64url(JSON claims)>.<base64url(DER ECDSA P-256 signature)>``. The signature
covers ``SIGNING_CONTEXT + "v1." + <encoded claims>`` exactly as sent, so nothing is parsed
before it is verified, and every failure is the same ``ApprovalError``.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Final

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

HEADER = "X-Mango-Approval"
VERSION = "v1"
SIGNING_CONTEXT = b"mango-approval."
"""Domain separation: a signature of this key is never valid as anything else."""
HASH_CONTEXT = b"mango-approval-call.v1\n"
SIGNING_ALGORITHM: Final = "ECDSA_SHA_256"
TTL_SECONDS = 120
"""One execution. Verifiers refuse a token that is expired or claims to live longer."""
CLOCK_SKEW_SECONDS = 5
MAX_CHARS = 2048
MAX_ARGUMENT_BYTES = 8 * 1024
MAX_DEPTH = 8

APPROVAL_ID_PATTERN = r"^[0-9a-f]{32}$"
_ID_RE = re.compile(APPROVAL_ID_PATTERN)
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_SUBJECT_RE = re.compile(r"^[\w+=,.@-]{2,64}$", re.ASCII)
"""IAM's rule for ``SourceIdentity``: the subject is used as one."""
_TOOL_RE = re.compile(r"^[A-Za-z0-9-]{1,48}___[A-Za-z0-9_-]{1,64}$")
_AGENT_RE = re.compile(r"^[a-z0-9]{2,16}$")
_PARTS = 3


class ApprovalError(Exception):
    """The call carries no approval a verifier can trust. Never says which check failed."""


class InvalidArgumentsError(ValueError):
    """Arguments that have no canonical form (not an object, too large, non-finite numbers)."""


def _normalized(value: Any, depth: int) -> Any:
    if depth > MAX_DEPTH:
        raise InvalidArgumentsError("arguments too deep")
    if value is None or isinstance(value, (bool, str, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise InvalidArgumentsError("non-finite number")
        # 10 and 10.0 are the same call, whoever serialized it.
        return int(value) if value.is_integer() else value
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise InvalidArgumentsError("non-string key")
        return {key: _normalized(item, depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalized(item, depth + 1) for item in value]
    raise InvalidArgumentsError("unsupported value")


def canonical_arguments(arguments: object) -> str:
    """The one JSON text of a tool's arguments: sorted keys, no spaces, integral floats as
    integers. Raises ``InvalidArgumentsError`` for anything that is not a JSON object."""
    if not isinstance(arguments, Mapping):
        raise InvalidArgumentsError("arguments must be an object")
    text = json.dumps(
        _normalized(arguments, 0),
        separators=(",", ":"),
        sort_keys=True,
        ensure_ascii=False,
        allow_nan=False,
    )
    if len(text.encode()) > MAX_ARGUMENT_BYTES:
        raise InvalidArgumentsError("arguments too large")
    return text


def call_hash(tool: str, arguments: object) -> str:
    """``hash(tool, args)``: what an approval is bound to. ``tool`` is the Gateway name."""
    if not _TOOL_RE.fullmatch(tool):
        raise InvalidArgumentsError("invalid tool")
    body = HASH_CONTEXT + tool.encode() + b"\n" + canonical_arguments(arguments).encode()
    return hashlib.sha256(body).hexdigest()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _decode(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


# --- Issuing (mango-api) ----------------------------------------------------------------


def encode_claims(
    *,
    approval_id: str,
    subject: str,
    tool: str,
    args_hash: str,
    agent_id: str,
    expires_at: int,
) -> str:
    """Encoded claims of one execution. ``subject`` is who asked for the action: the only
    person whose session can run it."""
    if (
        not _ID_RE.fullmatch(approval_id)
        or not _SUBJECT_RE.fullmatch(subject)
        or not _TOOL_RE.fullmatch(tool)
        or not _HASH_RE.fullmatch(args_hash)
        or not _AGENT_RE.fullmatch(agent_id)
    ):
        raise ValueError("invalid approval")
    claims = {
        "jti": approval_id,
        "sub": subject,
        "tool": tool,
        "args": args_hash,
        "agent": agent_id,
        "exp": expires_at,
    }
    return _b64(json.dumps(claims, separators=(",", ":"), sort_keys=True).encode())


def signing_input(encoded_claims: str) -> bytes:
    return SIGNING_CONTEXT + f"{VERSION}.{encoded_claims}".encode()


def signing_digest(encoded_claims: str) -> bytes:
    """What KMS signs (``MessageType=DIGEST``)."""
    return hashlib.sha256(signing_input(encoded_claims)).digest()


def assemble(encoded_claims: str, signature: bytes) -> str:
    value = f"{VERSION}.{encoded_claims}.{_b64(signature)}"
    if len(value) > MAX_CHARS:
        raise ValueError("approval token too large")
    return value


# --- Verifying (Gateway interceptor, approval executor) ---------------------------------


@dataclass(frozen=True)
class Approval:
    """What a verified token vouches for."""

    approval_id: str
    subject: str
    tool: str
    args_hash: str
    agent_id: str
    expires_at: int


class ApprovalVerifier:
    def __init__(self, public_key_der: bytes, *, clock: Callable[[], float] = time.time) -> None:
        key = serialization.load_der_public_key(public_key_der)
        if not isinstance(key, ec.EllipticCurvePublicKey) or key.curve.name != "secp256r1":
            raise ValueError("the approval key must be ECC NIST P-256")
        self._key = key
        self._now = clock

    def verify(self, token: object, *, subject: str, tool: str, arguments: object) -> Approval:
        """The approval ``token`` carries, if it was issued for exactly this call: this
        person, this tool and these arguments."""
        if not isinstance(token, str) or not 0 < len(token) <= MAX_CHARS:
            raise ApprovalError
        parts = token.split(".")
        if len(parts) != _PARTS or parts[0] != VERSION:
            raise ApprovalError
        _, encoded, signature = parts
        try:
            self._key.verify(_decode(signature), signing_input(encoded), ec.ECDSA(hashes.SHA256()))
            claims = json.loads(_decode(encoded))
            expected = call_hash(tool, arguments)
        except (InvalidSignature, ValueError, binascii.Error):
            raise ApprovalError from None
        if not isinstance(claims, dict):
            raise ApprovalError
        approval_id, agent, expires = claims.get("jti"), claims.get("agent"), claims.get("exp")
        now = self._now()
        if (
            not isinstance(approval_id, str)
            or not _ID_RE.fullmatch(approval_id)
            or not isinstance(agent, str)
            or not _AGENT_RE.fullmatch(agent)
            or isinstance(expires, bool)
            or not isinstance(expires, int)
            or expires < now
            or expires > now + TTL_SECONDS + CLOCK_SKEW_SECONDS
            # Issued for someone else, another tool or other arguments: not this call.
            or claims.get("sub") != subject
            or claims.get("tool") != tool
            or claims.get("args") != expected
        ):
            raise ApprovalError
        return Approval(
            approval_id=approval_id,
            subject=subject,
            tool=tool,
            args_hash=expected,
            agent_id=agent,
            expires_at=expires,
        )
