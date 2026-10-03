import base64
import json
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from mango_packs.signing import (
    FileDigest,
    PackSignatureError,
    PackStatement,
    build_envelope,
    file_digest,
    signed_message,
    verify_envelope,
    verify_file,
)


def _pem(key: ec.EllipticCurvePrivateKey | rsa.RSAPrivateKey) -> bytes:
    return key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )


@pytest.fixture(scope="module")
def key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


@pytest.fixture
def statement(manifest_data: dict[str, Any]) -> PackStatement:
    return PackStatement.model_validate(
        {
            "schema_version": 1,
            "manifest": manifest_data,
            "artifact": {"file": "aws-pricing-1.1.1-1.zip", "sha256": "c" * 64, "size": 10},
            "sbom": {"file": "aws-pricing-1.1.1-1.sbom.cdx.json", "sha256": "d" * 64, "size": 5},
            "lock_sha256": "e" * 64,
            "source_revision": "f" * 40,
        }
    )


def _sign(key: ec.EllipticCurvePrivateKey, statement: PackStatement) -> bytes:
    signature = key.sign(signed_message(statement.payload()), ec.ECDSA(hashes.SHA256()))
    return build_envelope(statement, "arn:aws:kms:us-east-1:111122223333:key/test", signature)


def _edit(envelope: bytes, **changes: Any) -> bytes:
    return json.dumps({**json.loads(envelope), **changes}).encode()


def test_verifies_with_the_trusted_key(
    key: ec.EllipticCurvePrivateKey, statement: PackStatement
) -> None:
    assert verify_envelope(_sign(key, statement), _pem(key)) == statement


def test_rejects_another_key(key: ec.EllipticCurvePrivateKey, statement: PackStatement) -> None:
    other = ec.generate_private_key(ec.SECP256R1())
    with pytest.raises(PackSignatureError, match="does not match the trusted key"):
        verify_envelope(_sign(other, statement), _pem(key))


def test_rejects_a_tampered_payload(
    key: ec.EllipticCurvePrivateKey, statement: PackStatement
) -> None:
    data = statement.model_dump(mode="json")
    data["manifest"]["iam"][0]["actions"].append("iam:PassRole")
    payload = base64.b64encode(PackStatement.model_validate(data).payload())
    with pytest.raises(PackSignatureError, match="does not match the trusted key"):
        verify_envelope(_edit(_sign(key, statement), payload=payload.decode()), _pem(key))


def test_key_id_of_the_envelope_is_not_trusted(
    key: ec.EllipticCurvePrivateKey, statement: PackStatement
) -> None:
    attacker = ec.generate_private_key(ec.SECP256R1())
    envelope = json.loads(_sign(attacker, statement))
    envelope["signature"]["key_id"] = "arn:aws:kms:us-east-1:111122223333:key/the-real-one"
    with pytest.raises(PackSignatureError):
        verify_envelope(json.dumps(envelope).encode(), _pem(key))


def test_rejects_malformed_envelopes(
    key: ec.EllipticCurvePrivateKey, statement: PackStatement
) -> None:
    envelope = _sign(key, statement)
    for bad in (
        b"",
        b"not json",
        b"[]",
        _edit(envelope, payload_type="application/json"),
        _edit(envelope, payload="@@@"),
        _edit(envelope, extra=1),
        _edit(
            envelope, signature={"algorithm": "RSASSA_PSS_SHA_256", "key_id": "k", "value": "AA=="}
        ),
        envelope + b" " * (1024 * 1024),
    ):
        with pytest.raises(PackSignatureError):
            verify_envelope(bad, _pem(key))


def test_rejects_a_signed_statement_that_is_not_canonical_or_valid(
    key: ec.EllipticCurvePrivateKey, statement: PackStatement
) -> None:
    def signed(payload: bytes) -> bytes:
        signature = key.sign(signed_message(payload), ec.ECDSA(hashes.SHA256()))
        return _edit(
            _sign(key, statement),
            payload=base64.b64encode(payload).decode(),
            signature={
                "algorithm": "ECDSA_SHA_256",
                "key_id": "k",
                "value": base64.b64encode(signature).decode(),
            },
        )

    spaced = json.dumps(json.loads(statement.payload()), indent=1).encode()
    with pytest.raises(PackSignatureError, match="canonical"):
        verify_envelope(signed(spaced), _pem(key))
    with pytest.raises(PackSignatureError, match="not a valid pack statement"):
        verify_envelope(signed(b'{"schema_version":1}'), _pem(key))


def test_only_p256_keys_are_trusted(
    key: ec.EllipticCurvePrivateKey, statement: PackStatement
) -> None:
    envelope = _sign(key, statement)
    for other in (
        rsa.generate_private_key(public_exponent=65537, key_size=2048),
        ec.generate_private_key(ec.SECP384R1()),
    ):
        with pytest.raises(PackSignatureError, match="P-256"):
            verify_envelope(envelope, _pem(other))
    with pytest.raises(PackSignatureError, match="not valid PEM"):
        verify_envelope(envelope, b"-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----\n")


def test_signed_files_must_match_byte_for_byte(tmp_path: Path) -> None:
    path = tmp_path / "aws-pricing-1.1.1-1.zip"
    path.write_bytes(b"zip bytes")
    expected = file_digest(path)
    verify_file(expected, path)
    path.write_bytes(b"zip bytez")
    with pytest.raises(PackSignatureError, match="does not match the signed digest"):
        verify_file(expected, path)
    with pytest.raises(PackSignatureError):
        verify_file(FileDigest(file=path.name, sha256=expected.sha256, size=1), path)
    with pytest.raises(FileNotFoundError):
        verify_file(expected, tmp_path / "missing.zip")
