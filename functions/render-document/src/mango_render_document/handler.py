"""Mango-<ns>-RenderDocument: one Word, Excel or PowerPoint file of the chat to PDF and PNG pages
(D117; threat model ``code-interpreter-threat-model.md``, TM-CI8).

Contract of the event (the caller is the code sandbox connector once it exists, D114/C2; there
is no Gateway target yet). The caller builds every key from the verified identity of the turn,
never from the model (TM-CI8)::

    {
      "bucket": "<the chat files bucket>",           # must be this installation's
      "key_in": "owner/<sub>/<conversation>/<file>",  # a scanned, clean object (D116 (10))
      "key_out_prefix": "owner/<sub>/<conversation>/renders/<render>/",
      "pages_max": 20                                 # optional, 1..50
    }

``<sub>`` is a Cognito subject (UUID); ``<conversation>``, ``<file>`` and ``<render>`` are ids
(ULID or UUID). The output prefix must be under the same owner and conversation as the input,
and under ``renders/``: the role of the function writes nowhere else, so a render never
replaces a file of the person. A new ``<render>`` per call: nothing is overwritten
(``If-None-Match``).

Answer::

    {"status": "ready", "kind": "docx", "pdf_key": "<prefix>document.pdf",
     "page_keys": ["<prefix>page-001.png", …], "pages_total": 31, "pages_rendered": 20,
     "truncated": true}
    {"status": "refused", "reason": "event" | "type" | "macros" | "size" | "not_found"}
    {"status": "failed", "reason": "timeout" | "convert" | "pages" | "raster" | "size"}

The new objects are scanned like every object of the bucket (D116 (2)): they are readable only
once the scan tags them clean.

Only a failure of S3 or KMS raises (the invocation fails, which its alarm counts). Nothing of the
document, its keys or the output of LibreOffice is logged: codes, sizes and times only. The
working folder is deleted after every invocation, so nothing of one person's document stays for
the next invocation in the same container.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import tempfile
import time
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Any

import boto3
from botocore.exceptions import ClientError

from mango_render_document.convert import ConversionError, Pages, render
from mango_render_document.ooxml import NotRenderable, classify

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

logger = logging.getLogger()
logger.setLevel(logging.INFO)

MAX_INPUT_BYTES = 100 * 1024 * 1024
"""The largest chat file (D116 (1))."""
DEFAULT_PAGES = 20
MAX_PAGES = 50
WORK_ROOT = Path(os.environ.get("MANGO_WORK_ROOT", "/tmp"))  # noqa: S108 - Lambda's only writable folder

_ID = r"[0-9A-Za-z][0-9A-Za-z-]{0,63}"
_SUB = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
KEY_IN = re.compile(rf"owner/(?P<owner>{_SUB}/{_ID})/{_ID}")
KEY_OUT = re.compile(rf"owner/(?P<owner>{_SUB}/{_ID})/renders/{_ID}/")

CONTENT_TYPES = {"pdf": "application/pdf", "png": "image/png"}


class Refused(Exception):  # noqa: N818 - a refusal, answered, not a failure
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def parse_event(event: Any, bucket: str) -> tuple[str, str, int]:
    """``(key_in, key_out_prefix, pages_max)`` of a valid event, or ``Refused("event")``."""
    if not isinstance(event, dict) or not set(event) <= {
        "bucket",
        "key_in",
        "key_out_prefix",
        "pages_max",
    }:
        raise Refused("event")
    key_in, prefix = event.get("key_in"), event.get("key_out_prefix")
    pages = event.get("pages_max", DEFAULT_PAGES)
    if event.get("bucket") != bucket or not isinstance(key_in, str) or not isinstance(prefix, str):
        raise Refused("event")
    source, target = KEY_IN.fullmatch(key_in), KEY_OUT.fullmatch(prefix)
    if source is None or target is None or source["owner"] != target["owner"]:
        raise Refused("event")
    if isinstance(pages, bool) or not isinstance(pages, int) or not 1 <= pages <= MAX_PAGES:
        raise Refused("event")
    return key_in, prefix, pages


class Renderer:
    def __init__(self, s3: S3Client, bucket: str) -> None:
        self._s3 = s3
        self._bucket = bucket

    def download(self, key: str, target: Path) -> None:
        """The object, refused before it is read when it is larger than a chat file."""
        try:
            response = self._s3.get_object(Bucket=self._bucket, Key=key)
        except ClientError as error:
            # AccessDenied too: an object the scan has not cleared is denied by the bucket.
            if error.response.get("Error", {}).get("Code") in {"NoSuchKey", "AccessDenied"}:
                raise Refused("not_found") from error
            raise
        body = response["Body"]
        try:
            if response.get("ContentLength", MAX_INPUT_BYTES + 1) > MAX_INPUT_BYTES:
                raise Refused("size")
            written = 0
            with target.open("wb") as file:
                for chunk in iter(lambda: body.read(1024 * 1024), b""):
                    written += len(chunk)
                    if written > MAX_INPUT_BYTES:
                        raise Refused("size")
                    file.write(chunk)
        finally:
            body.close()

    def upload(self, key: str, path: Path) -> None:
        self._s3.put_object(
            Bucket=self._bucket,
            Key=key,
            Body=path.read_bytes(),
            ContentType=CONTENT_TYPES[path.suffix.lstrip(".")],
            # A new render never replaces an object, its own earlier pages included.
            IfNoneMatch="*",
        )

    def handle(self, event: Any) -> dict[str, Any]:
        started = time.monotonic()
        work = Path(tempfile.mkdtemp(prefix=f"lo_{uuid.uuid4().hex}_", dir=WORK_ROOT))
        try:
            key_in, prefix, pages_max = parse_event(event, self._bucket)
            source = work / "source"
            self.download(key_in, source)
            kind = classify(source)
            pages = render(source, kind, work, pages_max)
            answer = self._publish(prefix, kind.name, pages)
        except (Refused, NotRenderable) as refusal:
            answer = {"status": "refused", "reason": refusal.reason}
        except ConversionError as failure:
            answer = {"status": "failed", "reason": failure.reason}
        finally:
            shutil.rmtree(work, ignore_errors=True)
        logger.info(
            "render",
            extra={
                "status": answer["status"],
                "reason": answer.get("reason"),
                "kind": answer.get("kind"),
                "pages_total": answer.get("pages_total"),
                "pages_rendered": answer.get("pages_rendered"),
                "ms": int((time.monotonic() - started) * 1000),
            },
        )
        return answer

    def _publish(self, prefix: str, kind: str, pages: Pages) -> dict[str, Any]:
        pdf_key = f"{prefix}document.pdf"
        self.upload(pdf_key, pages.pdf)
        page_keys = []
        for png in pages.pngs:
            page_keys.append(f"{prefix}{png.name}")
            self.upload(page_keys[-1], png)
        return {
            "status": "ready",
            "kind": kind,
            "pdf_key": pdf_key,
            "page_keys": page_keys,
            "pages_total": pages.total,
            "pages_rendered": len(page_keys),
            "truncated": len(page_keys) < pages.total,
        }


_renderer: Renderer | None = None


def lambda_handler(event: Any, _context: Any) -> dict[str, Any]:
    global _renderer  # noqa: PLW0603 - one client per container
    if _renderer is None:
        _renderer = Renderer(boto3.client("s3"), os.environ["CHAT_FILES_BUCKET"])
    return _renderer.handle(event)
