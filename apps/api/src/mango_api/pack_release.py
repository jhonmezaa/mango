"""MCP packs of the release, as mango-api shows them (D19, D36).

mango-api never installs anything: it lists what the pack provisioner would install, so it
reads the same data with the same checks (``mango_provisioner.packs.release``):

* the release catalog and the public key come from the stack (environment), never from a
  request. The catalog pins one signed statement per pack by digest;
* the statement is read from the packs bucket CloudFormation filled, which is treated as
  untrusted storage: the signature is verified before the payload is parsed, and the digest
  must be the one the release names. A pack that fails any check is left out (fail closed);
* only the statement (JSON) is read. The zip is the provisioner's business.

A release is immutable for the life of a task, so verified statements are kept in memory.
A read error is not cached: the next call tries again. A statement that is missing or does not
verify is only remembered for ``RECHECK_SECONDS``: a task may start before CloudFormation has
copied the packs of a stack update, and that must not hide a pack until the task is replaced.
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

from mango_packs.canonical import sha256_hex
from mango_packs.enablement import is_pack_id
from mango_packs.manifest import PackManifest
from mango_packs.signing import (
    MAX_ENVELOPE_BYTES,
    PackSignatureError,
    load_public_key,
    verify_envelope,
)

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

logger = logging.getLogger(__name__)

PACK_VERSION_PATTERN = r"^[0-9]+(\.[0-9]+){1,3}-[1-9][0-9]{0,3}$"
_VERSION_RE = re.compile(PACK_VERSION_PATTERN)
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
_ACCOUNT_RE = re.compile(r"^\d{12}$")
_NOT_FOUND = frozenset({"NoSuchKey", "404", "NotFound"})
RECHECK_SECONDS = 60
"""How long a pack that failed verification is left out before it is read again."""


class PackReleaseUnavailableError(Exception):
    """The release packs could not be read right now; callers fail closed and may retry."""


@dataclass(frozen=True)
class CatalogEntry:
    """The only signed statement of a pack this release installs."""

    version: str
    statement_sha256: str


@dataclass(frozen=True)
class ReleasePack:
    """A pack of the release: its manifest, exactly as the provider signed it."""

    manifest: PackManifest
    statement_sha256: str

    @property
    def actions(self) -> tuple[str, ...]:
        """IAM actions the pack role would get (sorted, without duplicates)."""
        return tuple(sorted({a for statement in self.manifest.iam for a in statement.actions}))


def parse_catalog(raw: str) -> Mapping[str, CatalogEntry]:
    """``PACK_CATALOG`` of the stack: ``{pack id: {version, statement_sha256}}``."""
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError as exc:
        raise ValueError("PACK_CATALOG is not JSON") from exc
    if not isinstance(data, dict):
        raise TypeError("PACK_CATALOG must be an object")
    catalog: dict[str, CatalogEntry] = {}
    for pack_id, entry in data.items():
        version = entry.get("version") if isinstance(entry, dict) else None
        digest = entry.get("statement_sha256") if isinstance(entry, dict) else None
        if (
            not is_pack_id(pack_id)
            or not isinstance(version, str)
            or not _VERSION_RE.fullmatch(version)
            or not isinstance(digest, str)
            or not _SHA256_RE.fullmatch(digest)
        ):
            raise ValueError("PACK_CATALOG has an invalid entry")
        catalog[pack_id] = CatalogEntry(version=version, statement_sha256=digest)
    return MappingProxyType(catalog)


def envelope_key(pack_id: str, version: str) -> str:
    """Where CloudFormation copies the signed statement of a pack version (D36).

    Keep in sync with ``mango_provisioner.packs.config.PackSettings.envelope_key``.
    """
    return f"packs/{pack_id}/{version}/{pack_id}-{version}.pack.json"


class ReleasePacks:
    def __init__(
        self,
        s3: S3Client,
        *,
        bucket: str,
        bucket_owner: str,
        catalog: Mapping[str, CatalogEntry],
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
        # Without a key nothing can be verified, so the release has no packs (U10).
        self._key = public_key_pem.encode() if public_key_pem.strip() else None
        if self._key is not None:
            try:
                load_public_key(self._key)
            except PackSignatureError as exc:
                raise ValueError("PACK_SIGNING_PUBLIC_KEY is invalid") from exc
        self._clock = clock
        self._lock = threading.Lock()
        self._verified: dict[str, ReleasePack] = {}
        self._refused: dict[str, float] = {}

    @property
    def catalog(self) -> Mapping[str, CatalogEntry]:
        return self._catalog

    def packs(self) -> tuple[ReleasePack, ...]:
        """Verified packs of the release, by id. Raises when the bucket cannot be read."""
        if self._key is None:
            return ()
        out: list[ReleasePack] = []
        for pack_id in sorted(self._catalog):
            pack = self._pack(pack_id, self._key)
            if pack is not None:
                out.append(pack)
        return tuple(out)

    def get(self, pack_id: str) -> ReleasePack | None:
        if self._key is None or pack_id not in self._catalog:
            return None
        return self._pack(pack_id, self._key)

    def _pack(self, pack_id: str, key: bytes) -> ReleasePack | None:
        now = self._clock()
        with self._lock:
            if pack_id in self._verified:
                return self._verified[pack_id]
            refused = self._refused.get(pack_id)
            if refused is not None and now - refused < RECHECK_SECONDS:
                return None
        entry = self._catalog[pack_id]
        pack = self._verify(pack_id, entry, self._envelope(pack_id, entry), key)
        with self._lock:
            if pack is None:
                self._refused[pack_id] = now
            else:
                self._verified[pack_id] = pack
                self._refused.pop(pack_id, None)
        return pack

    def _envelope(self, pack_id: str, entry: CatalogEntry) -> bytes | None:
        try:
            response = self._s3.get_object(
                Bucket=self._bucket,
                Key=envelope_key(pack_id, entry.version),
                ExpectedBucketOwner=self._owner,
            )
            if int(response["ContentLength"]) > MAX_ENVELOPE_BYTES:
                return None
            return response["Body"].read(MAX_ENVELOPE_BYTES + 1)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in _NOT_FOUND:
                return None
            raise PackReleaseUnavailableError("the release packs could not be read") from exc
        except BotoCoreError as exc:
            raise PackReleaseUnavailableError("the release packs could not be read") from exc

    @staticmethod
    def _verify(
        pack_id: str, entry: CatalogEntry, envelope: bytes | None, key: bytes
    ) -> ReleasePack | None:
        if envelope is None:
            logger.error("pack statement missing or too large", extra={"pack": pack_id})
            return None
        try:
            statement = verify_envelope(envelope, key)
        except PackSignatureError:
            logger.exception(
                "pack statement not signed by the release key", extra={"pack": pack_id}
            )
            return None
        digest = sha256_hex(statement.payload())
        manifest = statement.manifest
        if (
            digest != entry.statement_sha256
            or manifest.id != pack_id
            or manifest.version != entry.version
        ):
            # A validly signed statement that is not the one the release names (rollback).
            logger.error("pack statement is not the one of this release", extra={"pack": pack_id})
            return None
        return ReleasePack(manifest=manifest, statement_sha256=digest)
