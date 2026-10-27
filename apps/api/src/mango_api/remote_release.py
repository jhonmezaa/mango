"""Remote MCP profiles of the release, as mango-api shows and registers them (D93, D98 (14)).

The same rules as the packs of the release (``pack_release``):

* the catalog (``REMOTE_CATALOG``: ``{profile id: sha256 of its signed statement}``) and the
  public key come from the stack, never from a request;
* the signed statement is read from the packs bucket CloudFormation filled, which is untrusted
  storage: the signature is verified before the payload is parsed and the digest must be the
  one the release names. A profile that fails any check is left out (fail closed).

A release is immutable for the life of a task, so verified statements are kept in memory; a
missing or refused one is read again after ``RECHECK_SECONDS``.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import TYPE_CHECKING

from botocore.exceptions import BotoCoreError, ClientError

from mango_core.remote_mcp import PROFILE_ID_PATTERN
from mango_packs.canonical import sha256_hex
from mango_packs.remote import MAX_ENVELOPE_BYTES, RemoteProfile, verify_envelope
from mango_packs.signing import PackSignatureError, load_public_key

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

logger = logging.getLogger(__name__)

RECHECK_SECONDS = 60
_PROFILE_RE = re.compile(PROFILE_ID_PATTERN)
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
_ACCOUNT_RE = re.compile(r"^\d{12}$")
_NOT_FOUND = frozenset({"NoSuchKey", "404", "NotFound"})


class RemoteReleaseUnavailableError(Exception):
    """The release profiles could not be read right now; callers fail closed and may retry."""


@dataclass(frozen=True)
class ReleaseRemote:
    """A remote profile of the release, exactly as the provider signed it."""

    profile: RemoteProfile
    statement_sha256: str


def parse_remote_catalog(raw: str) -> Mapping[str, str]:
    """``REMOTE_CATALOG`` of the stack (``infra/lib/constructs/remote-release.ts``)."""
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError as exc:
        raise ValueError("REMOTE_CATALOG is not JSON") from exc
    if not isinstance(data, dict):
        raise TypeError("REMOTE_CATALOG must be an object")
    for profile_id, digest in data.items():
        if not _PROFILE_RE.fullmatch(profile_id) or not (
            isinstance(digest, str) and _SHA256_RE.fullmatch(digest)
        ):
            raise ValueError("REMOTE_CATALOG has an invalid entry")
    return MappingProxyType(dict(data))


def statement_key(profile_id: str, statement_sha256: str) -> str:
    """Where CloudFormation copies a signed profile (``remote-release.ts``, ``REMOTE_PREFIX``)."""
    return f"remotes/{profile_id}/{statement_sha256}.json"


class ReleaseRemotes:
    def __init__(
        self,
        s3: S3Client,
        *,
        bucket: str,
        bucket_owner: str,
        catalog: Mapping[str, str],
        public_key_pem: str,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if catalog and (
            not _BUCKET_RE.fullmatch(bucket) or not _ACCOUNT_RE.fullmatch(bucket_owner)
        ):
            raise ValueError("invalid packs bucket")
        self._s3 = s3
        self._bucket = bucket
        self._owner = bucket_owner
        self._catalog = catalog
        # Without a key nothing can be verified, so the release has no remote profiles.
        self._key = public_key_pem.encode() if public_key_pem.strip() else None
        if self._key is not None:
            try:
                load_public_key(self._key)
            except PackSignatureError as exc:
                raise ValueError("PACK_SIGNING_PUBLIC_KEY is invalid") from exc
        self._clock = clock
        self._lock = threading.Lock()
        self._verified: dict[str, ReleaseRemote] = {}
        self._refused: dict[str, float] = {}

    def profiles(self) -> tuple[ReleaseRemote, ...]:
        """Verified profiles of the release, by id. Raises when the bucket cannot be read."""
        if self._key is None:
            return ()
        found = (self._remote(profile_id, self._key) for profile_id in sorted(self._catalog))
        return tuple(remote for remote in found if remote is not None)

    def get(self, profile_id: str) -> ReleaseRemote | None:
        if self._key is None or profile_id not in self._catalog:
            return None
        return self._remote(profile_id, self._key)

    def _remote(self, profile_id: str, key: bytes) -> ReleaseRemote | None:
        now = self._clock()
        with self._lock:
            if profile_id in self._verified:
                return self._verified[profile_id]
            refused = self._refused.get(profile_id)
            if refused is not None and now - refused < RECHECK_SECONDS:
                return None
        digest = self._catalog[profile_id]
        remote = self._verify(profile_id, digest, self._envelope(profile_id, digest), key)
        with self._lock:
            if remote is None:
                self._refused[profile_id] = now
            else:
                self._verified[profile_id] = remote
                self._refused.pop(profile_id, None)
        return remote

    def _envelope(self, profile_id: str, digest: str) -> bytes | None:
        try:
            response = self._s3.get_object(
                Bucket=self._bucket,
                Key=statement_key(profile_id, digest),
                ExpectedBucketOwner=self._owner,
            )
            if int(response["ContentLength"]) > MAX_ENVELOPE_BYTES:
                return None
            return response["Body"].read(MAX_ENVELOPE_BYTES + 1)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in _NOT_FOUND:
                return None
            raise RemoteReleaseUnavailableError("the release profiles could not be read") from exc
        except BotoCoreError as exc:
            raise RemoteReleaseUnavailableError("the release profiles could not be read") from exc

    @staticmethod
    def _verify(
        profile_id: str, digest: str, envelope: bytes | None, key: bytes
    ) -> ReleaseRemote | None:
        if envelope is None:
            logger.error("remote profile missing or too large", extra={"profile": profile_id})
            return None
        try:
            statement = verify_envelope(envelope, key)
        except PackSignatureError:
            logger.exception(
                "remote profile not signed by the release key", extra={"profile": profile_id}
            )
            return None
        actual = sha256_hex(statement.payload())
        if actual != digest or statement.profile.id != profile_id:
            # A validly signed profile that is not the one the release names (rollback).
            logger.error(
                "remote profile is not the one of this release", extra={"profile": profile_id}
            )
            return None
        return ReleaseRemote(profile=statement.profile, statement_sha256=actual)
