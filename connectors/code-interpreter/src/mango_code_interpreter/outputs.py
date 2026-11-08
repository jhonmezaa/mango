"""What a cell may hand to the person (D116 (6), TM-CI4): a closed list of types, checked by
their bytes, copied to the chat files under a key made of ids only (TM-CF8).

No HTML, SVG, macro-enabled Office files nor executables: a file the model wrote is not
trusted to open safely. An Office file carrying a VBA project is refused whatever its name.
Everything else the cell wrote stays in the sandbox, and the model is told so.
"""

from __future__ import annotations

import hashlib
import io
import json
import posixpath
import secrets
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, cast

Kind = Literal["file", "figure", "chart", "table"]
_KINDS: frozenset[str] = frozenset({"file", "figure", "chart", "table"})

TYPES: dict[str, str] = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "pdf": "application/pdf",
    "csv": "text/csv",
    "tsv": "text/tab-separated-values",
    "txt": "text/plain",
    "md": "text/markdown",
    "json": "application/json",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "parquet": "application/vnd.apache.parquet",
}
"""Extensions a cell may hand out, with the type the server decides (never the sandbox's)."""
MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_CELL_BYTES = 100 * 1024 * 1024
"""What one ``readFiles`` call may bring back (AWS: 100 MB a call)."""
MAX_FILES = 20
"""Files one cell hands out (D116 (1)); the rest stay in the sandbox."""
_TEXT = frozenset({"csv", "tsv", "txt", "md", "json"})
_ZIP = frozenset({"xlsx", "docx", "pptx"})
_MAGIC: dict[str, tuple[bytes, ...]] = {
    "png": (b"\x89PNG\r\n\x1a\n",),
    "jpg": (b"\xff\xd8\xff",),
    "jpeg": (b"\xff\xd8\xff",),
    "gif": (b"GIF87a", b"GIF89a"),
    "pdf": (b"%PDF-",),
    "parquet": (b"PAR1",),
}
_MACROS = ("vbaproject.bin", "vbadata.xml")


@dataclass(frozen=True)
class Candidate:
    """A file the cell wrote, as its report named it."""

    path: str
    size: int
    kind: Kind
    name: str
    extension: str


@dataclass(frozen=True)
class Exported:
    file_id: str
    name: str
    kind: Kind
    mime: str
    size: int
    sha256: str
    key: str


def extension_of(name: str) -> str:
    """``table`` and ``chart`` specs are ``.json``; otherwise the last suffix, lower case."""
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def candidates(
    report_files: object, data_root: str, out_root: str
) -> tuple[list[Candidate], list[str]]:
    """The report's files that may go out, and the names of those that may not (with why)."""
    allowed: list[Candidate] = []
    refused: list[str] = []
    if not isinstance(report_files, list):
        return allowed, refused
    total = 0
    for entry in report_files:
        if not isinstance(entry, dict):
            continue
        path, size, kind = entry.get("path"), entry.get("size"), entry.get("kind")
        if not isinstance(path, str) or not isinstance(size, int) or kind not in _KINDS:
            continue
        root = out_root if kind != "file" else data_root
        normal = posixpath.normpath(path)
        if not normal.startswith(root.rstrip("/") + "/"):
            continue
        name = posixpath.relpath(normal, root) if kind == "file" else posixpath.basename(normal)
        extension = extension_of(name)
        if extension not in TYPES:
            refused.append(f"{name} (type not allowed)")
            continue
        if size > MAX_FILE_BYTES or total + size > MAX_CELL_BYTES:
            refused.append(f"{name} (too large)")
            continue
        if len(allowed) >= MAX_FILES:
            refused.append(f"{name} (more than {MAX_FILES} files)")
            continue
        total += size
        allowed.append(Candidate(normal, size, cast("Kind", kind), name, extension))
    return allowed, refused


def acceptable(extension: str, data: bytes) -> bool:  # noqa: PLR0911 - one check per type
    """The bytes are what the extension says (TM-CI4)."""
    magic = _MAGIC.get(extension)
    if magic is not None:
        return data.startswith(magic)
    if extension == "webp":
        return data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    if extension in _ZIP:
        return _office(data)
    if extension in _TEXT:
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return False
        if extension == "json":
            try:
                json.loads(text)
            except ValueError:
                return False
        return "\x00" not in text
    return False


def _office(data: bytes) -> bool:
    if not data.startswith(b"PK\x03\x04"):
        return False
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = [n.lower() for n in archive.namelist()]
    except (zipfile.BadZipFile, ValueError):
        return False
    return "[content_types].xml" in names and not any(n.endswith(_MACROS) for n in names)


def object_key(user_id: str, conversation_id: str, run_id: str, file_id: str) -> str:
    """Where a generated file lives in the chat files bucket: ids only (TM-CF8)."""
    return f"owner/{user_id}/conv/{conversation_id}/{run_id}/{file_id}"


def export(
    put: Callable[[str, bytes, str], None],
    candidate: Candidate,
    data: bytes,
    *,
    user_id: str,
    conversation_id: str,
    run_id: str,
) -> Exported:
    mime = (
        "application/json" if candidate.kind in ("chart", "table") else TYPES[candidate.extension]
    )
    file_id = secrets.token_hex(16)
    key = object_key(user_id, conversation_id, run_id, file_id)
    put(key, data, mime)
    return Exported(
        file_id=file_id,
        name=candidate.name,
        kind=candidate.kind,
        mime=mime,
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        key=key,
    )
