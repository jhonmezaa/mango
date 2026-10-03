from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa, utils

from mango_pack_builder.cli import main
from mango_pack_builder.kms import KmsSigner, sign_statement
from mango_packs.signing import (
    PackSignatureError,
    PackStatement,
    file_digest,
    verify_envelope,
)

from .conftest import TOOLS, manifest_for

KEY_ARN = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000"


class FakeKms:
    """KMS `Sign` and `GetPublicKey` backed by a local key: no AWS calls in tests."""

    def __init__(self, key: ec.EllipticCurvePrivateKey | rsa.RSAPrivateKey, spec: str) -> None:
        self._key = key
        self._spec = spec
        self.requests: list[dict[str, Any]] = []

    def sign(self, **request: Any) -> dict[str, object]:
        self.requests.append(request)
        assert isinstance(self._key, ec.EllipticCurvePrivateKey)
        prehashed = ec.ECDSA(utils.Prehashed(hashes.SHA256()))
        return {"Signature": self._key.sign(request["Message"], prehashed)}

    def get_public_key(self, **request: Any) -> dict[str, object]:
        der = self._key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        return {"PublicKey": der, "KeySpec": self._spec}


@pytest.fixture
def kms() -> FakeKms:
    return FakeKms(ec.generate_private_key(ec.SECP256R1()), "ECC_NIST_P256")


@pytest.fixture
def statement() -> PackStatement:
    return PackStatement.model_validate(
        {
            "schema_version": 1,
            "manifest": manifest_for(TOOLS[:1]),
            "artifact": {"file": "fake-pack-1.0.0-1.zip", "sha256": "c" * 64, "size": 10},
            "sbom": {"file": "fake-pack-1.0.0-1.sbom.cdx.json", "sha256": "d" * 64, "size": 5},
            "lock_sha256": "e" * 64,
            "source_revision": "f" * 40,
        }
    )


def test_signs_a_digest_and_verifies_offline(kms: FakeKms, statement: PackStatement) -> None:
    signer = KmsSigner(kms, KEY_ARN)
    public_key = signer.public_key_pem()
    envelope = sign_statement(statement, signer, public_key)
    assert verify_envelope(envelope, public_key) == statement
    assert kms.requests == [
        {
            "KeyId": KEY_ARN,
            "Message": kms.requests[0]["Message"],
            "MessageType": "DIGEST",
            "SigningAlgorithm": "ECDSA_SHA_256",
        }
    ]
    assert len(kms.requests[0]["Message"]) == 32


def test_refuses_to_publish_a_signature_the_trusted_key_rejects(
    kms: FakeKms, statement: PackStatement
) -> None:
    other = KmsSigner(FakeKms(ec.generate_private_key(ec.SECP256R1()), "ECC_NIST_P256"), KEY_ARN)
    with pytest.raises(PackSignatureError, match="does not match the trusted key"):
        sign_statement(statement, KmsSigner(kms, KEY_ARN), other.public_key_pem())


def test_rejects_keys_that_are_not_p256() -> None:
    weak = FakeKms(rsa.generate_private_key(public_exponent=65537, key_size=2048), "RSA_2048")
    with pytest.raises(PackSignatureError, match="ECC_NIST_P256"):
        KmsSigner(weak, KEY_ARN).public_key_pem()


def _statement_files(tmp_path: Path, pack_dir: Path) -> Path:
    (tmp_path / "fake-pack-1.0.0-1.zip").write_bytes(b"zip")
    (tmp_path / "fake-pack-1.0.0-1.sbom.cdx.json").write_bytes(b"{}")
    out = tmp_path / "fake-pack-1.0.0-1.statement.json"
    code = main(
        [
            "statement", str(pack_dir),
            "--artifact", str(tmp_path / "fake-pack-1.0.0-1.zip"),
            "--sbom", str(tmp_path / "fake-pack-1.0.0-1.sbom.cdx.json"),
            "--revision", "f" * 40,
            "--out", str(out),
        ]
    )  # fmt: skip
    assert code == 0
    return out


def test_cli_statement_sign_verify(
    kms: FakeKms, pack_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("mango_pack_builder.cli.boto3.client", lambda service: kms)
    statement = _statement_files(tmp_path, pack_dir)
    signed = PackStatement.model_validate_json(statement.read_bytes())
    assert signed.artifact == file_digest(tmp_path / "fake-pack-1.0.0-1.zip")
    assert signed.manifest.id == "fake-pack"

    public_key = tmp_path / "key.pem"
    envelope = tmp_path / "fake-pack-1.0.0-1.pack.json"
    assert main(["public-key", "--key-id", KEY_ARN, "--out", str(public_key)]) == 0
    sign = ["sign", "--statement", str(statement), "--key-id", KEY_ARN]
    sign += ["--public-key", str(public_key), "--out", str(envelope)]
    assert main(sign) == 0
    verify = ["verify", "--envelope", str(envelope), "--public-key", str(public_key)]
    assert main(verify) == 0

    # The zip is replaced after signing: verification fails, and so does signing it again.
    (tmp_path / "fake-pack-1.0.0-1.zip").write_bytes(b"zap")
    assert main(verify) == 1
    assert main(sign) == 1


def test_cli_statement_requires_the_artifact_of_this_pack(pack_dir: Path, tmp_path: Path) -> None:
    (tmp_path / "other.zip").write_bytes(b"zip")
    (tmp_path / "sbom.json").write_bytes(b"{}")
    arguments = ["statement", str(pack_dir), "--artifact", str(tmp_path / "other.zip")]
    arguments += ["--sbom", str(tmp_path / "sbom.json"), "--revision", "f" * 40]
    assert main([*arguments, "--out", str(tmp_path / "s.json")]) == 1
    assert not (tmp_path / "s.json").exists()
