"""What a document of a knowledge base may be (D88 (9)): what mango-api checks when an upload is
saved and the synchronization when it copies a source (D88 (19)), so both refuse the same.

* The kind is decided by the extension, from a closed list (:data:`TYPES`).
* The bytes must agree with it: ``%PDF-`` for a PDF, a ZIP whose directory names the Word or
  Excel part for DOCX and XLSX, and UTF-8 text without NUL bytes for TXT, MD and CSV.
* At most :data:`MAX_FILE_BYTES`.
* The name shown is only the last component of a path, without invisible characters, and is
  never part of a key.
"""

from __future__ import annotations

import re
import unicodedata

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
HEAD_BYTES = 8192
TAIL_BYTES = 65536
"""A ZIP keeps its central directory at the end; the part names are read from there."""
ZIP_PARTS = {"docx": b"word/document.xml", "xlsx": b"xl/workbook.xml"}
_INVISIBLE = re.compile(
    r"[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]"
)
"""Control characters, zero-width and bidirectional marks: they can disguise a name."""


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
    if kind in ZIP_PARTS:
        return head.startswith(b"PK\x03\x04") and ZIP_PARTS[kind] in tail
    return _is_text(head, size)
