"""What the provisioner accepts as a pack: signed by the provider and named by the release.

The installation bucket is filled by CloudFormation when the stack is installed or updated
(D36), but it is treated as untrusted storage (TM-M15):

* the envelope is verified offline with the public key of the template, before its content
  is parsed (``mango_packs.signing``). No key configured means nothing is installed;
* the release catalog pins **one signed statement per pack** by digest. An older statement,
  still validly signed, is not that statement, so a rollback is refused (TM-P6);
* the zip is read at one S3 object version and compared with the signed digest and size; the
  runtime is then created from that same version, so the object cannot change in between.

On top of the signature, the installation applies its own limits to the signed manifest:
read-only tools, over public data with the pack's own role or over account data as the calling
user (``central_only``, D37), only IAM actions from the closed list of that mode, and only on
the pack network of the stack, which reaches nothing but the AWS endpoints the manifest
declares (R6).
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING

from botocore.exceptions import BotoCoreError, ClientError

from mango_packs.canonical import sha256_hex
from mango_packs.manifest import PackManifest
from mango_packs.signing import (
    MAX_ENVELOPE_BYTES,
    PackSignatureError,
    PackStatement,
    verify_envelope,
)
from mango_provisioner.errors import StepError, aws_error, error_code
from mango_provisioner.packs.config import CatalogEntry, PackSettings

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

_CHUNK = 1024 * 1024
_NOT_FOUND = frozenset({"NoSuchKey", "NoSuchVersion", "404", "NotFound"})


@dataclass(frozen=True)
class VerifiedPack:
    """A statement signed by the provider that is exactly the one the release names."""

    statement: PackStatement
    statement_sha256: str

    @property
    def manifest(self) -> PackManifest:
        return self.statement.manifest


def check_manifest(settings: PackSettings, manifest: PackManifest) -> None:
    """Limits of this installation on a signed manifest. They fail closed."""
    # Write tools need an approval on every call (D27) and `per_user_adapter` is not
    # validated (S-M1): neither exists yet.
    if manifest.egress.hosts:
        # The pack network only reaches VPC endpoints: no host outside AWS can be allowed.
        raise StepError("external_egress_unsupported")
    if not manifest.installable:
        raise StepError("data_tier_unsupported")
    if manifest.id in settings.connector_targets:
        raise StepError("reserved_target")
    if manifest.id not in settings.network.security_groups:
        # The stack builds one security group per pack of the release, from its signed
        # `egress`. Without it there is no network to run the pack on: never `PUBLIC` (R6).
        raise StepError("egress_unavailable")
    if manifest.central_only:
        # The pack's own role gets none of these actions: they limit the session assumed
        # through the broker for each call, and the role behind the broker must allow them.
        member = manifest.member_chain
        if not (settings.can_broker_members if member else settings.can_broker):
            raise StepError("identity_unavailable")
        # Each chain has its own role behind the broker, and so its own ceiling (D51).
        brokered = settings.member_actions if member else settings.brokered_actions
        allowed, code = brokered, "action_outside_broker"
    else:
        # The boundary would silently void the permission: refuse instead (TM-M1).
        allowed, code = settings.allowed_actions, "action_outside_boundary"
    for statement in manifest.iam:
        if not set(statement.actions) <= allowed:
            raise StepError(code)


def resolve_config(manifest: PackManifest, requested: Mapping[str, str]) -> dict[str, str]:
    """Parameters of an enablement: only keys of the manifest, only values of their enum."""
    params = {param.key: param for param in manifest.config}
    if not set(requested) <= set(params):
        raise StepError("invalid_config")
    resolved: dict[str, str] = {}
    for key, param in params.items():
        value = requested.get(key, param.default)
        if value not in param.allowed:
            raise StepError("invalid_config")
        resolved[key] = value
    return resolved


class PackRelease:
    def __init__(self, s3: S3Client, settings: PackSettings) -> None:
        self._s3 = s3
        self._settings = settings

    def entry(self, pack_id: str, pack_version: str) -> CatalogEntry:
        entry = self._settings.catalog.get(pack_id)
        if entry is None:
            raise StepError("pack_not_in_release")
        if entry.version != pack_version:
            raise StepError("version_not_in_release")
        return entry

    def verified(self, pack_id: str, pack_version: str) -> VerifiedPack:
        """The signed statement of ``pack_id`` the release names, or a ``StepError``."""
        settings = self._settings
        entry = self.entry(pack_id, pack_version)
        if settings.public_key_pem is None:
            raise StepError("signing_key_missing")
        envelope = self._envelope(settings.envelope_key(pack_id, pack_version))
        try:
            statement = verify_envelope(envelope, settings.public_key_pem)
        except PackSignatureError:
            raise StepError("signature_invalid") from None
        digest = sha256_hex(statement.payload())
        manifest = statement.manifest
        if (
            digest != entry.statement_sha256
            or manifest.id != pack_id
            or manifest.version != pack_version
        ):
            raise StepError("statement_not_in_release")
        check_manifest(settings, manifest)
        return VerifiedPack(statement=statement, statement_sha256=digest)

    def _envelope(self, key: str) -> bytes:
        settings = self._settings
        try:
            response = self._s3.get_object(
                Bucket=settings.packs_bucket, Key=key, ExpectedBucketOwner=settings.account_id
            )
            if int(response["ContentLength"]) > MAX_ENVELOPE_BYTES:
                raise StepError("envelope_too_large")
            return response["Body"].read(MAX_ENVELOPE_BYTES + 1)
        except ClientError as exc:
            if error_code(exc) in _NOT_FOUND:
                raise StepError("envelope_not_found") from None
            raise aws_error("GetEnvelope", exc) from None
        except BotoCoreError as exc:
            raise aws_error("GetEnvelope", exc) from None

    def artifact_key(self, pack: VerifiedPack) -> str:
        manifest = pack.manifest
        prefix = self._settings.artifact_prefix(manifest.id, manifest.version)
        return f"{prefix}{pack.statement.artifact.file}"

    def verified_artifact(self, pack: VerifiedPack, version_id: str | None = None) -> str:
        """S3 version id of the zip, after checking that version against the signed digest.

        Without ``version_id`` the current version is taken; later steps pass the id back so
        they keep working on the very object that was verified.
        """
        settings = self._settings
        key = self.artifact_key(pack)
        expected = pack.statement.artifact
        try:
            if version_id is None:
                head = self._s3.head_object(
                    Bucket=settings.packs_bucket, Key=key, ExpectedBucketOwner=settings.account_id
                )
                version_id = head.get("VersionId")
                if not version_id or version_id == "null":
                    # An unversioned object can be replaced in place after this check.
                    raise StepError("artifact_not_versioned")
            response = self._s3.get_object(
                Bucket=settings.packs_bucket,
                Key=key,
                VersionId=version_id,
                ExpectedBucketOwner=settings.account_id,
            )
            if int(response["ContentLength"]) != expected.size:
                raise StepError("artifact_mismatch")
            digest = hashlib.sha256()
            size = 0
            for chunk in response["Body"].iter_chunks(_CHUNK):
                size += len(chunk)
                if size > expected.size:
                    raise StepError("artifact_mismatch")
                digest.update(chunk)
        except ClientError as exc:
            if error_code(exc) in _NOT_FOUND:
                raise StepError("artifact_not_found") from None
            raise aws_error("GetArtifact", exc) from None
        except BotoCoreError as exc:
            raise aws_error("GetArtifact", exc) from None
        if size != expected.size or digest.hexdigest() != expected.sha256:
            raise StepError("artifact_mismatch")
        return version_id
