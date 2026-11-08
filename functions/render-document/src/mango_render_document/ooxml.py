"""What kind of Office file an object is, read from its bytes, never from its name (TM-CI8).

Keys of the chat files are made of ids only (D116, TM-CF8): there is no extension to trust, and
an extension would say nothing anyway. A file is rendered only when it is an OOXML package
(a zip) whose main part is exactly one of the three types of the closed list. Macro-enabled
variants (``.docm``, ``.xlsm``, ``.pptm``), packages that carry a VBA project or ActiveX
controls, and anything else are refused before LibreOffice opens them.

The zip is checked for size before it is read: entry count, total uncompressed size and the
size of ``[Content_Types].xml`` are bounded, so a zip bomb ends here.
"""

from __future__ import annotations

import zipfile
from dataclasses import dataclass
from pathlib import Path

MAX_ENTRIES = 10_000
"""Entries of a package: a real document has tens or hundreds."""
MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
"""Uncompressed size of a package: well above a 100 MB file of images (D116 (1))."""
MAX_CONTENT_TYPES_BYTES = 1024 * 1024
CONTENT_TYPES = "[Content_Types].xml"


@dataclass(frozen=True)
class Kind:
    """One type of the closed list: how LibreOffice is told to read it (no type detection)."""

    name: str
    extension: str
    main_content_type: str
    import_filter: str


KINDS = (
    Kind(
        "docx",
        ".docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        "MS Word 2007 XML",
    ),
    Kind(
        "xlsx",
        ".xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        "Calc MS Excel 2007 XML",
    ),
    Kind(
        "pptx",
        ".pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
        "Impress MS PowerPoint 2007 XML",
    ),
)

_REFUSED_PARTS = ("vbaproject.bin", "vbadata.xml", "/activex/")
"""Parts of a package that carry code: refused whatever the main part says."""
_REFUSED_TYPES = (b"macroenabled", b"vbaproject", b"activex")


class NotRenderable(Exception):  # noqa: N818 - a refusal, not a failure of the function
    """The file is not one of the types the function renders; ``reason`` says why."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def classify(path: Path) -> Kind:
    """The kind of the package at ``path``, or ``NotRenderable``."""
    if not zipfile.is_zipfile(path):
        raise NotRenderable("type")
    try:
        with zipfile.ZipFile(path) as package:
            entries = package.infolist()
            if len(entries) > MAX_ENTRIES:
                raise NotRenderable("size")
            if sum(entry.file_size for entry in entries) > MAX_UNCOMPRESSED_BYTES:
                raise NotRenderable("size")
            names = {entry.filename.lower(): entry for entry in entries}
            if any(part in "/" + name for name in names for part in _REFUSED_PARTS):
                raise NotRenderable("macros")
            entry = names.get(CONTENT_TYPES.lower())
            if entry is None:
                raise NotRenderable("type")
            if entry.file_size > MAX_CONTENT_TYPES_BYTES:
                raise NotRenderable("size")
            content_types = package.read(entry)
    except (zipfile.BadZipFile, OSError, RuntimeError) as error:
        # RuntimeError: an encrypted entry. OSError: a truncated one.
        raise NotRenderable("type") from error
    return _main_kind(content_types)


def _main_kind(content_types: bytes) -> Kind:
    """Exactly one main part of the closed list, and nothing that declares code.

    Read as bytes, not parsed: there is no XML parser to feed a hostile document to, and a
    DOCTYPE (entities) is refused outright.
    """
    lowered = content_types.lower()
    if b"<!doctype" in lowered or b"<!entity" in lowered:
        raise NotRenderable("type")
    if any(marker in lowered for marker in _REFUSED_TYPES):
        raise NotRenderable("macros")
    found = [kind for kind in KINDS if f'"{kind.main_content_type}"'.encode() in lowered]
    if len(found) != 1:
        raise NotRenderable("type")
    return found[0]
