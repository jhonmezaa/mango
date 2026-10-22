"""Documents of a knowledge base in S3 (D88 (9)): presigned uploads, the check when they are
saved, and the server-side copy to the prefix Bedrock reads.

Key layout of the documents bucket (``infra/lib/constructs/knowledge.ts``):

* ``uploads/<sub>/<upload id>/<doc id>``: what the browser uploads, with a POST that mango-api
  signs for that exact key, its exact size and its exact type, for 15 minutes. The prefix is
  emptied by the bucket after a day.
* ``kb/<kb id>/docs/<doc id>``: a saved document, copied by S3 itself from its upload.

The name a person gave the file is never part of a key: keys are made of the caller's subject
and ULIDs only (TM-K4).

Security notes (security-best-practices, FastAPI, UPLOAD-001):
* The type is decided by the extension, from a closed list, and the bytes must agree with it
  when the document is saved: ``%PDF-`` for a PDF, a ZIP whose directory names the Word or
  Excel part for DOCX and XLSX, and UTF-8 text without NUL bytes for TXT, MD and CSV.
* The size the browser declared is the only one the POST accepts, and it is checked again
  with ``HeadObject`` before the copy.
* Nothing of a document is logged; errors name the S3 error code only.
"""

from __future__ import annotations

import base64
import logging
import re
import unicodedata
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from mango_api.presign import PresignSessions, SigningUnavailableError

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

logger = logging.getLogger(__name__)

UPLOAD_SECONDS = 15 * 60
"""Life of a presigned POST (D88 (9))."""
MAX_FILE_BYTES = 50 * 1024 * 1024
"""Per document (D88 (9)); also the largest text file Bedrock ingests (D88 (27))."""
TYPES: dict[str, str] = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "txt": "text/plain",
    "md": "text/markdown",
    "csv": "text/csv",
}
"""Extension -> the one Content-Type a document of that kind is uploaded and stored with."""
MAX_NAME_LENGTH = 200
_HEAD_BYTES = 8192
_TAIL_BYTES = 65536
"""A ZIP keeps its central directory at the end; the part names are read from there."""
_ZIP_PARTS = {"docx": b"word/document.xml", "xlsx": b"xl/workbook.xml"}
_INVISIBLE = re.compile(
    r"[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]"
)
"""Control characters, zero-width and bidirectional marks: they can disguise a name."""

S3_CONFIG = Config(signature_version="s3v4", s3={"addressing_style": "virtual"})
"""SigV4: the bucket is encrypted with KMS."""


class StorageUnavailableError(Exception):
    """S3 could not be reached or refused mango-api; callers fail closed."""


def display_name(raw: str) -> str | None:
    """The name shown for a document, or ``None`` if nothing visible is left. Only the last
    component of a path; invisible characters out; whitespace collapsed; at most 200."""
    name = unicodedata.normalize("NFC", raw).replace("\\", "/").rsplit("/", 1)[-1]
    name = " ".join(_INVISIBLE.sub("", name).split())
    if not name or name in {".", ".."}:
        return None
    if len(name) > MAX_NAME_LENGTH:
        stem, dot, ext = name.rpartition(".")
        keep = MAX_NAME_LENGTH - len(dot + ext)
        name = (stem[:keep] + dot + ext) if dot and keep > 0 else name[:MAX_NAME_LENGTH]
    return name


def extension(name: str) -> str | None:
    """The kind of document a name says, if it is one of :data:`TYPES`."""
    _, dot, ext = name.rpartition(".")
    ext = ext.lower()
    return ext if dot and ext in TYPES else None


def upload_key(sub: str, upload_id: str, doc_id: str) -> str:
    return f"uploads/{sub}/{upload_id}/{doc_id}"


def document_key(kb_id: str, doc_id: str) -> str:
    return f"kb/{kb_id}/docs/{doc_id}"


def _is_text(head: bytes, size: int) -> bool:
    """UTF-8 without NUL bytes. When ``head`` is only the start of the file, its last
    character may be cut: up to three bytes of it are left out."""
    if b"\x00" in head:
        return False
    text = head.removeprefix(b"\xef\xbb\xbf")
    cuts = range(4) if size > len(head) else range(1)
    for cut in cuts:
        try:
            text[: len(text) - cut].decode("utf-8")
        except UnicodeDecodeError:
            continue
        return True
    return False


def content_matches(kind: str, head: bytes, tail: bytes, size: int) -> bool:
    """Whether the first (and, for a ZIP, the last) bytes of a document are of ``kind``."""
    if kind == "pdf":
        return head.startswith(b"%PDF-")
    if kind in _ZIP_PARTS:
        return head.startswith(b"PK\x03\x04") and _ZIP_PARTS[kind] in tail
    return _is_text(head, size)


@dataclass(frozen=True)
class Inspected:
    size: int
    matches: bool
    """Whether its bytes are of the kind its name says."""
    etag: str
    """What was checked: the copy only takes the object if it is still this one."""


@dataclass(frozen=True)
class SignedUpload:
    url: str
    fields: dict[str, str]


class DocumentStorage:
    def __init__(
        self, s3: S3Client, bucket: str, region: str, signer: PresignSessions | None
    ) -> None:
        """``s3`` checks and copies with mango-api's own credentials; ``signer`` signs the
        uploads with the presign role, never with those (``mango_api.presign``)."""
        self._s3 = s3
        self._signer = signer
        self._bucket = bucket
        # The signature of a POST covers its policy, not the host: the URL is always the
        # bucket's regional one, the only host the CSP of the SPA allows.
        self._url = f"https://{bucket}.s3.{region}.amazonaws.com/"

    def sign(self, key: str, size: int, content_type: str, *, user_id: str) -> SignedUpload:
        """A POST that only uploads ``key``, of exactly ``size`` bytes and ``content_type``,
        signed by the presign role for ``user_id``."""
        if self._signer is None:
            raise StorageUnavailableError("no signing role")
        try:
            signed = self._signer.s3_for(user_id).generate_presigned_post(
                Bucket=self._bucket,
                Key=key,
                Fields={"Content-Type": content_type},
                Conditions=[
                    {"bucket": self._bucket},
                    ["eq", "$key", key],
                    {"Content-Type": content_type},
                    ["content-length-range", size, size],
                ],
                ExpiresIn=UPLOAD_SECONDS,
            )
        except SigningUnavailableError as exc:
            raise StorageUnavailableError("signing unavailable") from exc
        except (BotoCoreError, ClientError) as exc:
            raise StorageUnavailableError(type(exc).__name__) from exc
        return SignedUpload(url=self._url, fields=dict(signed["fields"]))

    def _get_range(self, key: str, byte_range: str, etag: str) -> bytes:
        response = self._s3.get_object(Bucket=self._bucket, Key=key, Range=byte_range, IfMatch=etag)
        return response["Body"].read()

    def inspect(self, key: str, kind: str) -> Inspected | None:
        """What an uploaded object is, or ``None`` if it is not there."""
        try:
            head = self._s3.head_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise StorageUnavailableError(exc.response.get("Error", {}).get("Code")) from exc
        except BotoCoreError as exc:
            raise StorageUnavailableError(type(exc).__name__) from exc
        size, etag = int(head["ContentLength"]), str(head["ETag"])
        if size == 0 or size > MAX_FILE_BYTES:
            return Inspected(size, matches=False, etag=etag)
        try:
            first = self._get_range(key, f"bytes=0-{_HEAD_BYTES - 1}", etag)
            last = (
                self._get_range(key, f"bytes=-{_TAIL_BYTES}", etag) if kind in _ZIP_PARTS else b""
            )
        except (BotoCoreError, ClientError) as exc:
            raise StorageUnavailableError(type(exc).__name__) from exc
        return Inspected(size, matches=content_matches(kind, first, last, size), etag=etag)

    def copy(self, source: str, etag: str, destination: str, content_type: str) -> str:
        """Copy within the bucket the object ``inspect`` checked, and only that one: its
        presigned POST lasts 15 minutes and could upload another file meanwhile. S3 computes
        the SHA-256 of the copy, returned in hex; mango-api never reads under ``kb/``."""
        try:
            response = self._s3.copy_object(
                Bucket=self._bucket,
                Key=destination,
                CopySource={"Bucket": self._bucket, "Key": source},
                CopySourceIfMatch=etag,
                MetadataDirective="REPLACE",
                ContentType=content_type,
                ChecksumAlgorithm="SHA256",
            )
        except (BotoCoreError, ClientError) as exc:
            raise StorageUnavailableError(type(exc).__name__) from exc
        checksum: Any = response.get("CopyObjectResult", {}).get("ChecksumSHA256", "")
        return base64.b64decode(checksum).hex() if checksum else ""
