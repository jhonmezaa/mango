"""What the remote provisioner accepts as a profile: signed by the provider, named by the release.

The packs bucket is treated as untrusted storage, as with packs (TM-M15): the envelope is
verified with the public key of the template before its content is parsed, and the release
catalog (``REMOTE_CATALOG``) pins one signed statement per profile by digest, so an older
profile, still validly signed, is refused. Everything that becomes the Gateway target comes
from that statement: the host, the scopes, the tool schema and the tools the headers name
(D101). A registration only picks the organization (checked against a constant pattern, D93 (5)) and
a subset of the profile's toolsets.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_core import remote_mcp
from mango_packs.canonical import canonical_json, sha256_hex
from mango_packs.remote import (
    MAX_ENVELOPE_BYTES,
    RemoteProfile,
    RemoteProfileError,
    RemoteProfileStatement,
    forced_headers,
    picked_tools,
    verify_envelope,
)
from mango_packs.signing import PackSignatureError
from mango_provisioner.errors import StepError, aws_error, error_code
from mango_provisioner.remotes.config import RemoteSettings

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

_NOT_FOUND = frozenset({"NoSuchKey", "404", "NotFound"})


@dataclass(frozen=True)
class VerifiedProfile:
    statement: RemoteProfileStatement
    statement_sha256: str

    @property
    def profile(self) -> RemoteProfile:
        return self.statement.profile


@dataclass(frozen=True)
class TargetPlan:
    """What one registration of a verified profile becomes on the Gateway."""

    endpoint: str
    toolsets: tuple[str, ...]
    """The picked toolsets plus those that are always on, sorted."""
    headers: dict[str, str]
    """``X-MCP-Readonly`` and ``X-MCP-Tools`` with exactly ``tools`` (D101)."""
    tools: frozenset[str]
    tool_schema: dict[str, Any]
    """``{"tools": [...]}``: the signed schema cut to ``tools``, in the profile's order."""
    scopes: tuple[str, ...]
    probe_tool: str

    @property
    def inline_schema(self) -> str:
        return json.dumps(self.tool_schema, separators=(",", ":"), ensure_ascii=False)


def release_digest(catalog: Mapping[str, str]) -> str:
    """SHA-256 of ``REMOTE_CATALOG`` as canonical JSON: what names a release to the sweep that
    runs after an install (D101). The stack computes the same (``remoteReleaseDigest``)."""
    return sha256_hex(canonical_json(dict(catalog)))


def plan_target(verified: VerifiedProfile, organization: str, toolsets: list[str]) -> TargetPlan:
    """The target of ``organization`` with ``toolsets``, from the signed profile only."""
    profile = verified.profile
    if not remote_mcp.is_organization(organization):
        # Never reaches the SDK: the organization is the only free part of the URL.
        raise StepError("invalid_organization")
    try:
        headers = forced_headers(profile, toolsets)
        tools = picked_tools(profile, toolsets)
    except RemoteProfileError:
        raise StepError("invalid_toolsets") from None
    picked = {t.id for t in profile.toolsets if t.always or t.id in set(toolsets)}
    schema = {
        "tools": [t for t in verified.statement.tool_schema["tools"] if t.get("name") in tools]
    }
    if profile.probe.tool not in tools or len(schema["tools"]) != len(tools):
        raise StepError("invalid_toolsets")
    host = profile.endpoint.host
    return TargetPlan(
        endpoint=f"https://{host}/{organization}",
        toolsets=tuple(sorted(picked)),
        headers=headers,
        tools=tools,
        tool_schema=schema,
        scopes=tuple(profile.provider.scopes),
        probe_tool=profile.probe.tool,
    )


class RemoteRelease:
    def __init__(self, s3: S3Client, settings: RemoteSettings) -> None:
        self._s3 = s3
        self._settings = settings

    def verified(self, profile_id: str) -> VerifiedProfile:
        """The signed statement of ``profile_id`` the release names, or a ``StepError``."""
        settings = self._settings
        digest = settings.catalog.get(profile_id)
        if digest is None:
            raise StepError("remote_profile_not_in_release")
        if settings.public_key_pem is None:
            raise StepError("signing_key_missing")
        envelope = self._envelope(settings.profile_key(profile_id, digest))
        try:
            statement = verify_envelope(envelope, settings.public_key_pem)
        except PackSignatureError:
            raise StepError("signature_invalid") from None
        actual = sha256_hex(statement.payload())
        if actual != digest or statement.profile.id != profile_id:
            raise StepError("statement_not_in_release")
        return VerifiedProfile(statement=statement, statement_sha256=actual)

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
            raise aws_error("GetRemoteProfile", exc) from None
        except BotoCoreError as exc:
            raise aws_error("GetRemoteProfile", exc) from None
