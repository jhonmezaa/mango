"""Signed pack statement and its offline verification (D19, R5).

The pipeline signs one statement per pack with an asymmetric KMS key of the provider
account. The installation only holds the public key (it ships in the template), so the
provisioner verifies without calling KMS or leaving the account.

The envelope follows DSSE: the signature covers the payload type and the payload bytes, and
the payload is not parsed before the signature is verified.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from pathlib import Path
from typing import Annotated, Final, Literal

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pydantic import Field, StringConstraints, ValidationError

from mango_packs.canonical import canonical_json
from mango_packs.manifest import PackManifest, Sha256Hex, StrictModel

PAYLOAD_TYPE: Final = "application/vnd.mango.pack.v1+json"
ALGORITHM: Final = "ECDSA_SHA_256"
# AgentCore Runtime limit for a zip deployment (S-M2).
MAX_ARTIFACT_BYTES = 250 * 1024 * 1024
MAX_ENVELOPE_BYTES = 1024 * 1024

FileName = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9._-]{0,99}$")]
GitRevision = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{40}$")]
Base64 = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9+/]+={0,2}$")]


class PackSignatureError(Exception):
    """The envelope, its signature or a signed file is not what the trusted key signed."""


class FileDigest(StrictModel):
    file: FileName
    sha256: Sha256Hex
    size: Annotated[int, Field(ge=1, le=MAX_ARTIFACT_BYTES)]


class PackStatement(StrictModel):
    """What the signature vouches for: this manifest goes with exactly these files."""

    schema_version: Literal[1]
    manifest: PackManifest
    artifact: FileDigest
    sbom: FileDigest
    lock_sha256: Sha256Hex
    # Commit of the Mango repository the pack was built from.
    source_revision: GitRevision

    def payload(self) -> bytes:
        return canonical_json(self.model_dump(mode="json"))


class Signature(StrictModel):
    algorithm: Literal["ECDSA_SHA_256"]
    # Informative only: the verifier uses the key it was configured with, never this value.
    key_id: Annotated[str, StringConstraints(min_length=1, max_length=2048)]
    value: Base64


class Envelope(StrictModel):
    payload_type: Literal["application/vnd.mango.pack.v1+json"]
    payload: Base64
    signature: Signature


def signed_message(payload: bytes) -> bytes:
    """DSSE pre-authentication encoding: binds the payload to its type."""
    kind = PAYLOAD_TYPE.encode()
    return b"DSSEv1 %d %b %d %b" % (len(kind), kind, len(payload), payload)


def message_digest(payload: bytes) -> bytes:
    return hashlib.sha256(signed_message(payload)).digest()


def build_envelope(statement: PackStatement, key_id: str, signature: bytes) -> bytes:
    envelope = Envelope(
        payload_type=PAYLOAD_TYPE,
        payload=base64.b64encode(statement.payload()).decode(),
        signature=Signature(
            algorithm=ALGORITHM, key_id=key_id, value=base64.b64encode(signature).decode()
        ),
    )
    return json.dumps(envelope.model_dump(mode="json"), indent=2).encode() + b"\n"


def load_public_key(pem: bytes) -> ec.EllipticCurvePublicKey:
    try:
        key = serialization.load_pem_public_key(pem)
    except (ValueError, TypeError) as error:
        raise PackSignatureError("the pack signing public key is not valid PEM") from error
    if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(key.curve, ec.SECP256R1):
        raise PackSignatureError("the pack signing key must be ECC NIST P-256")
    return key


def verify_envelope(envelope: bytes, public_key_pem: bytes) -> PackStatement:
    """Return the statement only if `public_key_pem` signed it. Fails closed."""
    key = load_public_key(public_key_pem)
    if len(envelope) > MAX_ENVELOPE_BYTES:
        raise PackSignatureError("the envelope is too large")
    try:
        parsed = Envelope.model_validate_json(envelope)
        payload = base64.b64decode(parsed.payload, validate=True)
        signature = base64.b64decode(parsed.signature.value, validate=True)
    except (ValidationError, binascii.Error) as error:
        raise PackSignatureError("the envelope is malformed") from error
    try:
        key.verify(signature, signed_message(payload), ec.ECDSA(hashes.SHA256()))
    except InvalidSignature as error:
        raise PackSignatureError("the signature does not match the trusted key") from error
    try:
        statement = PackStatement.model_validate_json(payload)
    except ValidationError as error:
        raise PackSignatureError("the signed statement is not a valid pack statement") from error
    if statement.payload() != payload:
        raise PackSignatureError("the signed statement is not in canonical form")
    return statement


def file_digest(path: Path) -> FileDigest:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_ARTIFACT_BYTES:
                raise PackSignatureError(f"{path.name} exceeds the size limit")
            digest.update(chunk)
    try:
        return FileDigest(file=path.name, sha256=digest.hexdigest(), size=size)
    except ValidationError as error:
        raise PackSignatureError(f"{path.name} is not a valid pack file") from error


def verify_file(expected: FileDigest, path: Path) -> None:
    """Fail unless `path` is byte for byte the file named in a verified statement."""
    actual = file_digest(path)
    if (actual.sha256, actual.size) != (expected.sha256, expected.size):
        raise PackSignatureError(f"{path.name} does not match the signed digest")
