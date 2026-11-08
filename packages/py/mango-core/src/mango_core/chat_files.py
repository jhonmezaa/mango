"""What a file of the chat may be (D116): what a person attaches and what the code sandbox
generates. Shared by mango-api (uploads, downloads), the function that records the malware scan
of each object, and the code connector (C2 of the plan), so all of them refuse the same.

* Closed list of kinds by extension (:data:`TYPES`, D116 (6)): no HTML, SVG, macros nor
  executables. The bytes must agree with the extension (:func:`content_matches`).
* At most :data:`MAX_FILES` files of :data:`MAX_FILE_BYTES` per message, kept
  :data:`RETENTION_DAYS` days (D116 (1)).
* Keys of the bucket ``Mango-<ns>-chat-files`` are made of the owner's subject and ids only,
  never of a file name (TM-CF8): :func:`upload_key`, :func:`owner_key` and :func:`parse_key`.
* The status of an object is the tag GuardDuty leaves on it (D116 (2)); only
  ``NO_THREATS_FOUND`` opens it (:func:`scan_outcome`).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum

from mango_core.knowledge import is_id
from mango_core.knowledge_files import display_name

__all__ = [
    "CLEAN",
    "MAX_FILES",
    "MAX_FILE_BYTES",
    "RETENTION_DAYS",
    "TYPES",
    "FileKind",
    "ParsedKey",
    "ScanOutcome",
    "content_matches",
    "display_name",
    "extension",
    "owner_key",
    "parse_key",
    "scan_outcome",
    "upload_key",
]

MAX_FILES = 20
"""Files per message (D116 (1))."""
MAX_FILE_BYTES = 100 * 1024 * 1024
"""Per file (D116 (1)): what fits in one inline ``writeFiles`` of the Code Interpreter."""
RETENTION_DAYS = 90
"""Life of a file of the chat (D116 (1)); the bucket expires ``owner/`` at the same age."""
HEAD_BYTES = 8192
TAIL_BYTES = 65536
"""A ZIP keeps its central directory at the end; the part names are read from there."""


@dataclass(frozen=True)
class FileKind:
    content_type: str
    """The one ``Content-Type`` the file is uploaded, stored and downloaded with."""
    label: str
    """What the design calls it (the badge of the file card and the composer)."""
    image: bool = False
    """Shown in the chat as a ``blob:`` from the content route (D116 (5))."""


_OOXML = "application/vnd.openxmlformats-officedocument"
TYPES: dict[str, FileKind] = {
    "pdf": FileKind("application/pdf", "PDF"),
    "csv": FileKind("text/csv", "CSV"),
    "txt": FileKind("text/plain", "TXT"),
    "json": FileKind("application/json", "JSON"),
    "xlsx": FileKind(f"{_OOXML}.spreadsheetml.sheet", "Excel"),
    "docx": FileKind(f"{_OOXML}.wordprocessingml.document", "Word"),
    "pptx": FileKind(f"{_OOXML}.presentationml.presentation", "PowerPoint"),
    "png": FileKind("image/png", "Imagen PNG", image=True),
    "jpg": FileKind("image/jpeg", "Imagen JPG", image=True),
    "jpeg": FileKind("image/jpeg", "Imagen JPG", image=True),
}
"""Extension -> kind: the list of the composer of the design («PDF, CSV, TXT, JSON, Excel, Word,
PowerPoint, PNG, JPG»). Macro-enabled Office files (``.xlsm``…) are other extensions: refused."""
_ZIP_PARTS = {
    "docx": b"word/document.xml",
    "xlsx": b"xl/workbook.xml",
    "pptx": b"ppt/presentation.xml",
}
_PNG = b"\x89PNG\r\n\x1a\n"
_JPEG = b"\xff\xd8\xff"
_SUB_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
"""A Cognito subject: what the keys of a person start with."""
_CONVERSATION_RE = re.compile(r"^[0-9a-f]{32}$")
UPLOADS, OWNER = "uploads/", "owner/"


def extension(name: str) -> str | None:
    """The kind a name says, if it is one of :data:`TYPES`."""
    _, dot, ext = name.rpartition(".")
    ext = ext.lower()
    return ext if dot and ext in TYPES else None


def _is_text(head: bytes, size: int) -> bool:
    """UTF-8 without NUL bytes. When ``head`` is only the start of the file, its last
    character may be cut: up to three bytes of it are left out."""
    if b"\x00" in head:
        return False
    text = head.removeprefix(b"\xef\xbb\xbf")
    for cut in range(4) if size > len(head) else range(1):
        try:
            text[: len(text) - cut].decode("utf-8")
        except UnicodeDecodeError:
            continue
        return True
    return False


def content_matches(kind: str, head: bytes, tail: bytes, size: int) -> bool:  # noqa: PLR0911
    """Whether the first (and, for a ZIP, the last) bytes of a file are of ``kind``: the
    signature of a PDF, PNG or JPEG; a ZIP whose directory names the part of its Office kind;
    UTF-8 text without NUL bytes, and for JSON, starting with ``{`` or ``[``."""
    if kind == "pdf":
        return head.startswith(b"%PDF-")
    if kind == "png":
        return head.startswith(_PNG)
    if kind in {"jpg", "jpeg"}:
        return head.startswith(_JPEG)
    if kind in _ZIP_PARTS:
        return head.startswith(b"PK\x03\x04") and _ZIP_PARTS[kind] in tail
    if kind not in TYPES or not _is_text(head, size):
        return False
    if kind == "json":
        return head.removeprefix(b"\xef\xbb\xbf").lstrip()[:1] in {b"{", b"["}
    return True


def needs_tail(kind: str) -> bool:
    return kind in _ZIP_PARTS


# --- Keys -----------------------------------------------------------------------------------


def upload_key(sub: str, upload_id: str, file_id: str) -> str:
    """What the browser posts (D116 (4)); the bucket empties ``uploads/`` after a day."""
    return f"{UPLOADS}{sub}/{upload_id}/{file_id}"


def owner_key(sub: str, conversation_id: str, file_id: str) -> str:
    """A file of a conversation, scanned before anyone reads it (D116 (3))."""
    return f"{OWNER}{sub}/conv/{conversation_id}/{file_id}"


@dataclass(frozen=True)
class ParsedKey:
    area: str
    """``uploads`` or ``owner``."""
    sub: str
    parent: str
    """The upload of an ``uploads/`` key, the conversation of an ``owner/`` one."""
    file_id: str


def parse_key(key: str) -> ParsedKey | None:
    """The parts of a key of the bucket, or ``None`` for anything that is not one of a person's
    files (the scanner's validation object, a key nobody of Mango wrote)."""
    parts = key.split("/")
    if len(parts) == 4 and parts[0] == "uploads":  # noqa: PLR2004 - the layout of the key
        _, sub, upload_id, file_id = parts
        if _SUB_RE.fullmatch(sub) and is_id(upload_id) and is_id(file_id):
            return ParsedKey("uploads", sub, upload_id, file_id)
        return None
    if len(parts) == 5 and parts[0] == "owner" and parts[2] == "conv":  # noqa: PLR2004
        _, sub, _, conversation_id, file_id = parts
        if (
            _SUB_RE.fullmatch(sub)
            and _CONVERSATION_RE.fullmatch(conversation_id)
            and is_id(file_id)
        ):
            return ParsedKey("owner", sub, conversation_id, file_id)
    return None


# --- The malware scan -----------------------------------------------------------------------

CLEAN = "NO_THREATS_FOUND"
SCAN_RESULTS = frozenset({CLEAN, "THREATS_FOUND", "UNSUPPORTED", "ACCESS_DENIED", "FAILED"})
"""What ``GuardDutyMalwareScanStatus`` may say (and ``scanResultStatus`` of its event)."""


class ScanOutcome(StrEnum):
    CLEAN = "clean"
    BLOCKED = "blocked"
    """Infected, or never scanned for good (``UNSUPPORTED``, ``FAILED``, ``ACCESS_DENIED``):
    never delivered (TM-CF3)."""


def scan_outcome(result: str) -> ScanOutcome:
    """Only ``NO_THREATS_FOUND`` opens a file; anything else, unknown values included, blocks
    it."""
    return ScanOutcome.CLEAN if result == CLEAN else ScanOutcome.BLOCKED
