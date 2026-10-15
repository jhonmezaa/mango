"""The identity of a task run: a Cognito access token of its owner, issued for one run (D78).

A task runs as the person who created it (D26, rule 5), and that person is not there to sign
in. The user pool has a client of its own for runs, ``Mango-<ns>-tasks``, that allows a single
flow, ``CUSTOM_AUTH``. To get a token for one run, mango-api starts that flow for the owner
(``AdminInitiateAuth``, signed with IAM) and answers the one challenge with an assertion
signed by a KMS key that only its task role can use: this owner, this run, the nonce of this
challenge, valid for a minute. The challenge Lambda checks it with the public key, and Cognito
issues the owner's access token as it would at a sign-in: the pre-token trigger adds the
groups the person has now. A disabled or deleted person gets nothing, so the run is skipped
and the task pauses (D26).

Everything downstream sees the owner, with the same checks as a chat turn (the Gateway, the
interceptor, Cedar L2, the connectors and ``SourceIdentity`` in CloudTrail). What the token of
this client cannot do is enforced elsewhere: mango-api accepts it on no route, and no approval
token is ever issued for it, so a run cannot write (A3, D56).

Format of the answer: ``v1.<base64url(JSON claims)>.<base64url(DER ECDSA P-256 signature)>``.
The signature covers ``SIGNING_CONTEXT + "v1." + <encoded claims>`` exactly as sent, so nothing
is parsed before it is verified, and every failure is the same ``TaskIdentityError``.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

VERSION: Final = "v1"
SIGNING_CONTEXT: Final = b"mango-task-identity."
"""Domain separation: a signature of this key is never valid as anything else."""
SIGNING_ALGORITHM: Final = "ECDSA_SHA_256"
CHALLENGE_NAME: Final = "CUSTOM_CHALLENGE"
NONCE_PARAMETER: Final = "nonce"
TTL_SECONDS: Final = 60
"""One answer to one challenge. Verifiers refuse one that is expired or claims to live longer."""
CLOCK_SKEW_SECONDS: Final = 5
MAX_CHARS: Final = 1024
NONCE_PATTERN: Final = r"^[A-Za-z0-9_-]{32,64}$"
_NONCE_RE = re.compile(NONCE_PATTERN)
_SUBJECT_RE = re.compile(r"^[\w+=,.@-]{2,64}$", re.ASCII)
_RUN_RE = re.compile(r"^[0-9a-f]{32}$")
_CLIENT_RE = re.compile(r"^[A-Za-z0-9]{1,128}$")
_PARTS = 3


class TaskIdentityError(Exception):
    """The answer is not one the challenge can trust. Never says which check failed."""


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _decode(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


# --- Answering (mango-api) ----------------------------------------------------------------


def encode_claims(*, subject: str, run_id: str, nonce: str, client_id: str, expires_at: int) -> str:
    """Encoded claims of one answer: the owner of the task, the run, the nonce the challenge
    sent and the client the flow was started on."""
    if (
        not _SUBJECT_RE.fullmatch(subject)
        or not _RUN_RE.fullmatch(run_id)
        or not _NONCE_RE.fullmatch(nonce)
        or not _CLIENT_RE.fullmatch(client_id)
    ):
        raise ValueError("invalid task identity")
    claims = {"sub": subject, "run": run_id, "nonce": nonce, "client": client_id, "exp": expires_at}
    return _b64(json.dumps(claims, separators=(",", ":"), sort_keys=True).encode())


def signing_input(encoded_claims: str) -> bytes:
    return SIGNING_CONTEXT + f"{VERSION}.{encoded_claims}".encode()


def signing_digest(encoded_claims: str) -> bytes:
    """What KMS signs (``MessageType=DIGEST``)."""
    return hashlib.sha256(signing_input(encoded_claims)).digest()


def assemble(encoded_claims: str, signature: bytes) -> str:
    value = f"{VERSION}.{encoded_claims}.{_b64(signature)}"
    if len(value) > MAX_CHARS:
        raise ValueError("task identity answer too large")
    return value


# --- Verifying (the challenge Lambda) -----------------------------------------------------


@dataclass(frozen=True)
class TaskIdentity:
    """What a verified answer vouches for."""

    subject: str
    run_id: str
    client_id: str
    expires_at: int


class TaskIdentityVerifier:
    def __init__(self, public_key_der: bytes, *, clock: Callable[[], float] = time.time) -> None:
        key = serialization.load_der_public_key(public_key_der)
        if not isinstance(key, ec.EllipticCurvePublicKey) or key.curve.name != "secp256r1":
            raise ValueError("the task identity key must be ECC NIST P-256")
        self._key = key
        self._now = clock

    def verify(self, answer: object, *, subject: str, nonce: str, client_id: str) -> TaskIdentity:
        """The run ``answer`` vouches for, if it was signed for exactly this challenge: this
        person, this nonce and this client."""
        if not isinstance(answer, str) or not 0 < len(answer) <= MAX_CHARS:
            raise TaskIdentityError
        parts = answer.split(".")
        if len(parts) != _PARTS or parts[0] != VERSION:
            raise TaskIdentityError
        _, encoded, signature = parts
        try:
            self._key.verify(_decode(signature), signing_input(encoded), ec.ECDSA(hashes.SHA256()))
            claims = json.loads(_decode(encoded))
        except (InvalidSignature, ValueError, binascii.Error):
            raise TaskIdentityError from None
        if not isinstance(claims, dict):
            raise TaskIdentityError
        run_id, expires = claims.get("run"), claims.get("exp")
        now = self._now()
        if (
            not isinstance(run_id, str)
            or not _RUN_RE.fullmatch(run_id)
            or isinstance(expires, bool)
            or not isinstance(expires, int)
            or expires < now
            or expires > now + TTL_SECONDS + CLOCK_SKEW_SECONDS
            # Signed for another person, another challenge or another client: not this one.
            or not _NONCE_RE.fullmatch(nonce)
            or claims.get("sub") != subject
            or claims.get("nonce") != nonce
            or claims.get("client") != client_id
        ):
            raise TaskIdentityError
        return TaskIdentity(subject=subject, run_id=run_id, client_id=client_id, expires_at=expires)
