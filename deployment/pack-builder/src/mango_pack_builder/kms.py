"""Sign a pack statement with the provider's asymmetric KMS key (U10).

The private key never leaves KMS: the pipeline sends a digest and gets a signature back.
The signature is checked against the key's public half before anything is written.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

from cryptography.hazmat.primitives import serialization

from mango_packs.signing import (
    ALGORITHM,
    PackSignatureError,
    PackStatement,
    build_envelope,
    load_public_key,
    message_digest,
    verify_envelope,
)

if TYPE_CHECKING:
    from mypy_boto3_kms import KMSClient

KEY_SPEC = "ECC_NIST_P256"


class Signer(Protocol):
    key_id: str

    def sign_digest(self, digest: bytes) -> bytes: ...

    def public_key_pem(self) -> bytes: ...


class KmsSigner:
    def __init__(self, client: KMSClient, key_id: str) -> None:
        self._client = client
        self.key_id = key_id

    def sign_digest(self, digest: bytes) -> bytes:
        response = self._client.sign(
            KeyId=self.key_id, Message=digest, MessageType="DIGEST", SigningAlgorithm=ALGORITHM
        )
        signature = response["Signature"]
        if not isinstance(signature, bytes):
            raise PackSignatureError("KMS returned no signature")
        return signature

    def public_key_pem(self) -> bytes:
        response = self._client.get_public_key(KeyId=self.key_id)
        der = response["PublicKey"]
        if response.get("KeySpec") != KEY_SPEC or not isinstance(der, bytes):
            raise PackSignatureError(f"the signing key must be {KEY_SPEC}")
        key = serialization.load_der_public_key(der)
        pem = key.public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        load_public_key(pem)
        return pem


def sign_statement(statement: PackStatement, signer: Signer, trusted_public_key: bytes) -> bytes:
    """Return the signed envelope, verified with the key installations will trust."""
    signature = signer.sign_digest(message_digest(statement.payload()))
    envelope = build_envelope(statement, signer.key_id, signature)
    verify_envelope(envelope, trusted_public_key)
    return envelope
