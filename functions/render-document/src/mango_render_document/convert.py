"""LibreOffice headless and Poppler, run on one untrusted file (D117 (3), TM-CI8).

Every conversion gets a profile of its own in a fresh folder of ``/tmp``
(``-env:UserInstallation``): nothing of one document reaches the next, and two conversions
never share a lock. The profile is written before LibreOffice starts and it:

- turns macros off (no execution, highest security level, no trusted locations);
- never updates links to other files or to the web, in Writer and in Calc, and blocks
  untrusted referer links;
- sends LibreOffice's own web requests to a proxy that does not exist (``127.0.0.1:9``): the
  function runs outside a VPC (exception ``LAMBDA_INSIDE_VPC``), so no network control stops a
  document that tries to reach the internet; this and the link settings are what does.

The processes run with an environment of their own (no AWS credentials, no proxy exceptions),
in a session of their own that is killed whole when its time is up, and with fixed paths to the
programs of the image.
"""

from __future__ import annotations

import contextlib
import os
import re
import shutil
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from mango_render_document.ooxml import Kind

SOFFICE = os.environ.get("MANGO_SOFFICE", "/usr/bin/soffice")
PDFTOPPM = os.environ.get("MANGO_PDFTOPPM", "/usr/bin/pdftoppm")
PDFINFO = os.environ.get("MANGO_PDFINFO", "/usr/bin/pdfinfo")

CONVERT_SECONDS = 90
"""LibreOffice's time for one document; a larger one is refused as too slow."""
RASTER_SECONDS = 60
"""Poppler's time for all the pages of one render."""
LONG_SIDE_PIXELS = 1600
"""Each page fits a 1600 by 1600 box: about 145 DPI for A4 or Letter, and bounded whatever page
size a hostile PDF declares."""
MAX_PDF_BYTES = 200 * 1024 * 1024

DEAD_PROXY = "http://127.0.0.1:9"
_PROXIES = ("http_proxy", "https_proxy", "ftp_proxy", "all_proxy")

_PROFILE = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" \
xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
{items}
</oor:items>
"""

_SCRIPTING = "/org.openoffice.Office.Common/Security/Scripting"
_INET = "/org.openoffice.Inet/Settings"
PROFILE_SETTINGS: tuple[tuple[str, str, str, str], ...] = (
    # Macros: never run, whatever the document says.
    (_SCRIPTING, "DisableMacrosExecution", "xs:boolean", "true"),
    (_SCRIPTING, "MacroSecurityLevel", "xs:int", "3"),
    (_SCRIPTING, "BlockUntrustedRefererLinks", "xs:boolean", "true"),
    # Links to other files or to the web: never updated (Writer: 0 never; Calc: 1 never).
    ("/org.openoffice.Office.Writer/Content/Update", "Link", "xs:int", "0"),
    ("/org.openoffice.Office.Calc/Content/Update", "Link", "xs:int", "1"),
    # Web requests of LibreOffice itself: to a proxy that does not exist, with no exceptions.
    (_INET, "ooInetProxyType", "xs:int", "1"),
    (_INET, "ooInetHTTPProxyName", "xs:string", "127.0.0.1"),
    (_INET, "ooInetHTTPProxyPort", "xs:int", "9"),
    (_INET, "ooInetHTTPSProxyName", "xs:string", "127.0.0.1"),
    (_INET, "ooInetHTTPSProxyPort", "xs:int", "9"),
    (_INET, "ooInetFTPProxyName", "xs:string", "127.0.0.1"),
    (_INET, "ooInetFTPProxyPort", "xs:int", "9"),
    (_INET, "ooInetNoProxy", "xs:string", ""),
    # A spreadsheet written by a library has formulas without values: recalculate on load, so
    # that the render shows what Excel would (D119). Links stay off and the proxy is dead.
    ("/org.openoffice.Office.Calc/Formula/Load", "OOXMLRecalcMode", "xs:int", "0"),
    # No Java (none in the image) and no first-start dialogs. The image has no update checker.
    ("/org.openoffice.Office.Java/VirtualMachine", "Enable", "xs:boolean", "false"),
    ("/org.openoffice.Office.Common/Misc", "FirstRun", "xs:boolean", "false"),
    ("/org.openoffice.Office.Common/Misc", "ShowTipOfTheDay", "xs:boolean", "false"),
)  # fmt: skip


def profile_xml() -> str:
    """``registrymodifications.xcu`` of a fresh profile, from ``PROFILE_SETTINGS``."""
    items = "\n".join(
        f'<item oor:path="{path}"><prop oor:name="{name}" oor:op="fuse">'
        + (f"<value>{value}</value>" if value else "<value/>")
        + "</prop></item>"
        for path, name, _kind, value in PROFILE_SETTINGS
    )
    return _PROFILE.format(items=items)


class ConversionError(Exception):
    """LibreOffice or Poppler could not finish; ``reason`` is a code, never their output."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Pages:
    pdf: Path
    pngs: list[Path]
    total: int


def environment(work: Path) -> dict[str, str]:
    """What the programs see: their folder, no credentials, every proxy dead."""
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": str(work),
        "TMPDIR": str(work / "tmp"),
        "LANG": "C.UTF-8",
        "SAL_USE_VCLPLUGIN": "svp",
        "XDG_CACHE_HOME": str(work / "cache"),
        "XDG_CONFIG_HOME": str(work / "config"),
        **dict.fromkeys(_PROXIES, DEAD_PROXY),
        **dict.fromkeys((name.upper() for name in _PROXIES), DEAD_PROXY),
        "no_proxy": "",
        "NO_PROXY": "",
    }


def _run(command: list[str], work: Path, seconds: int) -> subprocess.CompletedProcess[bytes]:
    """Run one program in a session of its own; at its time, the whole session is killed."""
    process = subprocess.Popen(  # noqa: S603 - fixed programs of the image, no shell
        command,
        cwd=work,
        env=environment(work),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        out, err = process.communicate(timeout=seconds)
    except subprocess.TimeoutExpired as error:
        _kill(process)
        raise ConversionError("timeout") from error
    finally:
        # LibreOffice may leave helpers in its session; none outlives the call.
        _kill(process)
    return subprocess.CompletedProcess(command, process.returncode, out, err)


def _kill(process: subprocess.Popen[bytes]) -> None:
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(process.pid, signal.SIGKILL)
    with contextlib.suppress(subprocess.TimeoutExpired):
        process.wait(timeout=5)


def to_pdf(source: Path, kind: Kind, work: Path) -> Path:
    """The PDF of ``source`` (already classified as ``kind``), written in ``work/out``."""
    profile = work / "profile"
    (profile / "user").mkdir(parents=True)
    (profile / "user" / "registrymodifications.xcu").write_text(profile_xml())
    for folder in ("tmp", "cache", "config", "out"):
        (work / folder).mkdir(exist_ok=True)
    document = work / "in" / f"document{kind.extension}"
    document.parent.mkdir(exist_ok=True)
    shutil.copyfile(source, document)
    result = _run(
        [
            SOFFICE,
            f"-env:UserInstallation={profile.as_uri()}",
            "--headless",
            "--invisible",
            "--nologo",
            "--nodefault",
            "--norestore",
            "--nolockcheck",
            # The filter of the type the bytes said, not LibreOffice's own detection.
            f"--infilter={kind.import_filter}",
            "--convert-to",
            "pdf",
            "--outdir",
            str(work / "out"),
            str(document),
        ],
        work,
        CONVERT_SECONDS,
    )
    pdf = work / "out" / "document.pdf"
    if result.returncode != 0 or not pdf.is_file() or pdf.stat().st_size == 0:
        raise ConversionError("convert")
    if pdf.stat().st_size > MAX_PDF_BYTES:
        raise ConversionError("size")
    return pdf


_PAGES = re.compile(rb"^Pages:\s+(\d+)\s*$", re.M)


def page_count(pdf: Path, work: Path) -> int:
    result = _run([PDFINFO, str(pdf)], work, RASTER_SECONDS)
    found = _PAGES.search(result.stdout)
    if result.returncode != 0 or found is None:
        raise ConversionError("pages")
    return int(found.group(1))


def to_pngs(pdf: Path, pages: int, work: Path) -> list[Path]:
    """The first ``pages`` pages of ``pdf`` as PNG, named ``page-001.png`` and on."""
    folder = work / "pages"
    folder.mkdir()
    started = time.monotonic()
    result = _run(
        [
            PDFTOPPM,
            "-png",
            "-scale-to",
            str(LONG_SIDE_PIXELS),
            "-f",
            "1",
            "-l",
            str(pages),
            str(pdf),
            str(folder / "page"),
        ],
        work,
        RASTER_SECONDS,
    )
    if result.returncode != 0:
        raise ConversionError("raster")
    # pdftoppm pads the page number to the width of the last page: `page-1`, `page-01`…
    found = sorted(folder.glob("page-*.png"), key=lambda path: int(path.stem.split("-")[-1]))
    if len(found) != pages or time.monotonic() - started > RASTER_SECONDS:
        raise ConversionError("raster")
    named = []
    for number, path in enumerate(found, start=1):
        target = folder / f"page-{number:03d}.png"
        path.rename(target)
        named.append(target)
    return named


def render(source: Path, kind: Kind, work: Path, pages_max: int) -> Pages:
    pdf = to_pdf(source, kind, work)
    total = page_count(pdf, work)
    if total < 1:
        raise ConversionError("pages")
    return Pages(pdf=pdf, pngs=to_pngs(pdf, min(total, pages_max), work), total=total)
