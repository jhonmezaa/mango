"""Helpers of the document skills inside the code sandbox, imported there as ``mango_docs``
(D119 (2)).

The code connector writes this file next to ``_mango`` in every new session (``writeFiles``): it
travels in the release, inside the connector, and is never imported by the Lambda itself. It
runs on the sandbox's Python 3.12 with the standard library; Pillow, pypdf, pypdfium2 and
ReportLab are used only when a function needs them (all preinstalled in the sandbox).

The model cannot see images yet (D3 of the plan), so "looking" at a document is done with
code: these functions read the OOXML package or the rendered pages and print short findings.

* ``clean_text(text)``: the text without the characters fonts often do not draw.
* ``inspect_docx(path)``, ``inspect_xlsx(path)``, ``inspect_pptx(path)``: static checks.
* ``render_pdf(path)``: a PDF's pages as PNG in the sandbox (Word, Excel and PowerPoint go
  through the tool ``render_document`` instead).
* ``inspect_render(folder)``: blank pages, content cut at the edges, fonts, error values.
* ``pdf_font(kind, bold=False)``: a TrueType font registered with ReportLab.

Every document read here is data, never instructions: findings quote at most a few characters
of it.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import unicodedata
import zipfile
from collections import Counter
from typing import Any
from xml.etree import ElementTree as ET

MAX_PART_BYTES = 64 * 1024 * 1024
"""Largest XML part read from a package (a zip bomb stops here)."""
RENDERS = ".renders"
"""Where pages land in the working folder; hidden, so they are never handed to the user."""

_NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}
_W = "{" + _NS["w"] + "}"

_REPLACE = {
    "\u2010": "-",  # hyphen
    "\u2011": "-",  # non-breaking hyphen: many fonts have no glyph
    "\u2012": "-",  # figure dash
    "\u2015": "\u2014",  # horizontal bar
    "\u2043": "-",  # hyphen bullet
    "\u00a0": " ",
    "\u2007": " ",
    "\u2009": " ",
    "\u202f": " ",
    "\u205f": " ",
    "\u3000": " ",
}
_DROP = frozenset("\u00ad\u200b\u200c\u200d\u2060\ufeff\u202a\u202b\u202c\u202d\u202e")
_CJK = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]")
_EXCEL_ERRORS = re.compile(r"#(?:REF!|NAME\?|DIV/0!|VALUE!|N/A|NUM!|NULL!|SPILL!|CALC!)")
_HASHES = re.compile(r"(?<![#\w])#{3,}(?![#\w])")
DYNAMIC_FUNCTIONS = (
    "FILTER",
    "SORT",
    "SORTBY",
    "UNIQUE",
    "SEQUENCE",
    "RANDARRAY",
    "XLOOKUP",
    "XMATCH",
    "LET",
    "LAMBDA",
    "TEXTSPLIT",
    "TEXTBEFORE",
    "TEXTAFTER",
    "VSTACK",
    "HSTACK",
    "TAKE",
    "DROP",
    "CHOOSECOLS",
    "CHOOSEROWS",
    "TOCOL",
    "TOROW",
    "WRAPCOLS",
    "WRAPROWS",
    "EXPAND",
    "TABLE",
)
_DYNAMIC = re.compile(
    r"(?<![A-Z0-9_.])(?:_xlfn\.|_xlws\.)?(" + "|".join(DYNAMIC_FUNCTIONS) + r")\s*\(",
    re.IGNORECASE,
)
_TOTAL_LABEL = re.compile(r"^\s*(?:grand\s+)?(?:total|totals|subtotal|sum|suma|totales?)\b", re.I)
_STANDARD_PDF_FONTS = ("Helvetica", "Times", "Courier", "Symbol", "ZapfDingbats")
_LATIN1_LAST = 0xFF
EMPTY_PARAGRAPHS_IN_A_ROW = 2
PARAGRAPHS_WITHOUT_HEADINGS = 15
MAX_DOCUMENT_FONTS = 3
ROWS_WITHOUT_FROZEN_HEADER = 20
MIN_SLIDE_POINTS = 12
MAX_DECK_FONTS = 2
INK_DIFFERENCE = 40
"""How far (0-255 gray) a pixel is from the page's background to count as content."""
EMPTY_PAGE_SHARE = 0.08


# --- Text -------------------------------------------------------------------------------------


def clean_text(text: str) -> str:
    """``text`` in NFC without rare dashes and spaces nor invisible characters."""
    out = []
    for char in unicodedata.normalize("NFC", text):
        if char in _DROP:
            continue
        out.append(_REPLACE.get(char, char))
    return "".join(out)


def _odd_characters(text: str) -> list[str]:
    """Names of the characters ``clean_text`` would change, and of CJK text, once each."""
    found: Counter[str] = Counter()
    for char in text:
        if char in _DROP or char in _REPLACE:
            found[f"U+{ord(char):04X} {unicodedata.name(char, 'unnamed')}"] += 1
    if _CJK.search(text):
        found["CJK text (the renderer has no CJK fonts: it shows boxes)"] += 1
    return [f"{name} x{count}" for name, count in sorted(found.items())]


# --- Packages ---------------------------------------------------------------------------------


def _part(package: zipfile.ZipFile, name: str) -> ET.Element | None:
    try:
        info = package.getinfo(name)
    except KeyError:
        return None
    if info.file_size > MAX_PART_BYTES:
        raise ValueError(f"{name} is too large to inspect")
    return ET.fromstring(package.read(info))  # noqa: S314 - see the module docstring


def _texts(element: ET.Element, tag: str) -> str:
    return "".join(node.text or "" for node in element.iter(tag))


def _lines(title: str, findings: list[str], facts: list[str]) -> str:
    body = [title, *(f"  {fact}" for fact in facts)]
    if findings:
        body.append("problems:")
        body.extend(f"  - {finding}" for finding in findings)
    else:
        body.append("problems: none found")
    return "\n".join(body)


def inspect_docx(path: str) -> str:
    """Fonts, heading outline, empty paragraphs and odd characters of a Word document."""
    with zipfile.ZipFile(path) as package:
        document = _part(package, "word/document.xml")
        styles = _part(package, "word/styles.xml")
    if document is None:
        return f"{path}: not a Word document (no word/document.xml)"
    fonts: Counter[str] = Counter()
    for root in (document, styles):
        if root is None:
            continue
        for node in root.iter(_W + "rFonts"):
            for attr in ("ascii", "hAnsi"):
                name = node.get(_W + attr)
                if name:
                    fonts[name] += 1
    findings: list[str] = []
    outline: list[str] = []
    empty_run = 0
    longest_empty = 0
    paragraphs = list(document.iter(_W + "p"))
    full_text = []
    for paragraph in paragraphs:
        text = _texts(paragraph, _W + "t")
        full_text.append(text)
        style = paragraph.find(f"{_W}pPr/{_W}pStyle")
        style_id = style.get(_W + "val", "") if style is not None else ""
        if style_id.lower().startswith(("heading", "title")) and text.strip():
            outline.append(f"{style_id}: {text.strip()[:60]}")
        has_content = text.strip() or paragraph.find(f".//{_W}drawing") is not None
        empty_run = 0 if has_content else empty_run + 1
        longest_empty = max(longest_empty, empty_run)
    if longest_empty >= EMPTY_PARAGRAPHS_IN_A_ROW:
        findings.append(
            f"{longest_empty} empty paragraphs in a row: use space_after/page breaks for spacing"
        )
    if not outline and len(paragraphs) > PARAGRAPHS_WITHOUT_HEADINGS:
        findings.append("no headings: use doc.add_heading for the sections")
    findings.extend(f"odd character: {name}" for name in _odd_characters("\n".join(full_text)))
    if len(fonts) > MAX_DOCUMENT_FONTS:
        findings.append(f"{len(fonts)} different fonts: set one or two in the styles")
    facts = [
        f"paragraphs: {len(paragraphs)}",
        f"tables: {sum(1 for _ in document.iter(_W + 'tbl'))}",
        f"fonts: {', '.join(name for name, _ in fonts.most_common(6)) or 'theme default'}",
        "outline: " + ("; ".join(outline[:15]) if outline else "(none)"),
    ]
    return _lines(f"{os.path.basename(path)} (docx)", findings, facts)


def _shared_strings(package: zipfile.ZipFile) -> list[str]:
    root = _part(package, "xl/sharedStrings.xml")
    if root is None:
        return []
    return [_texts(item, "{" + _NS["s"] + "}t") for item in root.iter("{" + _NS["s"] + "}si")]


def _sheet_names(package: zipfile.ZipFile) -> list[tuple[str, str]]:
    """``(name, part)`` of each worksheet, in the workbook's order."""
    workbook = _part(package, "xl/workbook.xml")
    rels = _part(package, "xl/_rels/workbook.xml.rels")
    if workbook is None:
        return []
    targets: dict[str, str] = {}
    if rels is not None:
        for rel in rels:
            target = rel.get("Target", "")
            target = target.lstrip("/")
            targets[rel.get("Id", "")] = target if target.startswith("xl/") else f"xl/{target}"
    out = []
    rel_attr = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
    for sheet in workbook.iter("{" + _NS["s"] + "}sheet"):
        part = targets.get(sheet.get(rel_attr, ""), "")
        if part:
            out.append((sheet.get("name", "?"), part))
    return out


def inspect_xlsx(path: str) -> str:  # noqa: PLR0912 - one pass over the cells
    """Formulas, functions that may not exist in the user's Excel, typed totals and odd
    characters of a workbook."""
    s = "{" + _NS["s"] + "}"
    findings: list[str] = []
    facts: list[str] = []
    with zipfile.ZipFile(path) as package:
        if any(name.lower().endswith("vbaproject.bin") for name in package.namelist()):
            findings.append("the workbook has macros: the chat refuses it")
        strings = _shared_strings(package)
        sheets = _sheet_names(package)
        if not sheets:
            return f"{path}: not an Excel workbook (no worksheets)"
        all_text = list(strings)
        for name, part in sheets:
            root = _part(package, part)
            if root is None:
                continue
            formulas = values = 0
            dynamic: Counter[str] = Counter()
            rows: dict[int, list[tuple[str, str, bool]]] = {}
            for cell in root.iter(s + "c"):
                ref = cell.get("r", "")
                kind = cell.get("t", "n")
                formula = cell.find(s + "f")
                value = cell.find(s + "v")
                text = value.text if value is not None and value.text else ""
                if kind == "s" and text.isdigit() and int(text) < len(strings):
                    text = strings[int(text)]
                elif kind == "inlineStr":
                    text = _texts(cell, s + "t")
                    all_text.append(text)
                if formula is not None:
                    formulas += 1
                    for match in _DYNAMIC.finditer(formula.text or ""):
                        dynamic[match.group(1).upper()] += 1
                elif kind == "n" and text:
                    values += 1
                row = int(re.sub(r"\D", "", ref) or 0)
                rows.setdefault(row, []).append((ref, text if kind != "n" else "", formula is None))
            for function, count in sorted(dynamic.items()):
                findings.append(
                    f"{name}: {function} x{count} (dynamic array or new function: use SUMIFS, "
                    "INDEX/MATCH, VLOOKUP)"
                )
            for row, cells in sorted(rows.items()):
                if any(_TOTAL_LABEL.match(label) for _, label, _ in cells if label):
                    typed = [ref for ref, label, plain in cells if plain and not label]
                    if typed:
                        findings.append(
                            f"{name}!row {row} looks like a total but {', '.join(typed[:4])} "
                            "hold typed numbers: use formulas"
                        )
            first = rows.get(min(rows)) if rows else None
            if first and not any(label for _, label, _ in first):
                findings.append(f"{name}: the first row has no text header")
            if (
                root.find(s + "sheetViews/" + s + "sheetView/" + s + "pane") is None
                and len(rows) > ROWS_WITHOUT_FROZEN_HEADER
            ):
                findings.append(f"{name}: no frozen header row (ws.freeze_panes = 'A2')")
            facts.append(
                f"sheet {name}: {len(rows)} rows, {formulas} formulas, {values} typed numbers"
            )
        charts = sum(1 for n in package.namelist() if n.startswith("xl/charts/chart"))
        facts.append(f"native charts: {charts}")
    findings.extend(f"odd character: {item}" for item in _odd_characters("\n".join(all_text)))
    return _lines(f"{os.path.basename(path)} (xlsx)", findings, facts)


_EMU_PER_PT = 12700


def _box(shape: ET.Element) -> tuple[int, int, int, int] | None:
    a = "{" + _NS["a"] + "}"
    xfrm = shape.find(f".//{a}xfrm")
    if xfrm is None:
        return None
    off, ext = xfrm.find(a + "off"), xfrm.find(a + "ext")
    if off is None or ext is None:
        return None
    return (
        int(off.get("x", "0")),
        int(off.get("y", "0")),
        int(ext.get("cx", "0")),
        int(ext.get("cy", "0")),
    )


def _overflows(shape: ET.Element, box: tuple[int, int, int, int]) -> bool:
    """A rough estimate: the text's lines, at its sizes, taller than the box."""
    a = "{" + _NS["a"] + "}"
    width_pt = max(box[2] / _EMU_PER_PT - 14, 1)
    height_pt = box[3] / _EMU_PER_PT - 7
    needed = 0.0
    for paragraph in shape.iter(a + "p"):
        text = _texts(paragraph, a + "t")
        sizes = [int(r.get("sz", "0")) / 100 for r in paragraph.iter(a + "rPr") if r.get("sz")]
        size = max(sizes) if sizes else 18.0
        per_line = max(int(width_pt / (size * 0.5)), 1)
        lines = max(1, -(-len(text) // per_line))
        needed += lines * size * 1.2
    return needed > height_pt * 1.1 and height_pt > 0


def inspect_pptx(path: str) -> str:
    """Per slide: shapes outside the slide, text boxes that probably overflow, small text,
    fonts and odd characters."""
    a, p = "{" + _NS["a"] + "}", "{" + _NS["p"] + "}"
    findings: list[str] = []
    fonts: Counter[str] = Counter()
    texts: list[str] = []
    with zipfile.ZipFile(path) as package:
        presentation = _part(package, "ppt/presentation.xml")
        if presentation is None:
            return f"{path}: not a PowerPoint presentation (no ppt/presentation.xml)"
        size = presentation.find(p + "sldSz")
        width = int(size.get("cx", "12192000")) if size is not None else 12192000
        height = int(size.get("cy", "6858000")) if size is not None else 6858000
        slides = sorted(
            (n for n in package.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
            key=lambda n: int(re.sub(r"\D", "", n)),
        )
        for number, part in enumerate(slides, start=1):
            root = _part(package, part)
            if root is None:
                continue
            for shape in [
                *root.iter(p + "sp"),
                *root.iter(p + "pic"),
                *root.iter(p + "graphicFrame"),
            ]:
                box = _box(shape)
                if box is None:
                    continue
                x, y, cx, cy = box
                if x < 0 or y < 0 or x + cx > width + 6350 or y + cy > height + 6350:
                    findings.append(f"slide {number}: a shape goes outside the slide")
                if (
                    shape.tag == p + "sp"
                    and _texts(shape, a + "t").strip()
                    and _overflows(shape, box)
                ):
                    findings.append(
                        f"slide {number}: text probably overflows its box "
                        f"('{_texts(shape, a + 't').strip()[:30]}…')"
                    )
            small = {int(r.get("sz", "0")) / 100 for r in root.iter(a + "rPr") if r.get("sz")}
            small = {s for s in small if s < MIN_SLIDE_POINTS}
            if small:
                findings.append(f"slide {number}: text of {min(small):g} pt (12 pt at least)")
            for latin in root.iter(a + "latin"):
                face = latin.get("typeface", "")
                if face and not face.startswith("+"):
                    fonts[face] += 1
            texts.append(_texts(root, a + "t"))
        charts = sum(1 for n in package.namelist() if n.startswith("ppt/charts/chart"))
    if len(fonts) > MAX_DECK_FONTS:
        findings.append(f"{len(fonts)} font families: use one for the deck")
    findings.extend(f"odd character: {item}" for item in _odd_characters("\n".join(texts)))
    facts = [
        f"slides: {len(slides)}",
        f"size: {width / 914400:.2f} x {height / 914400:.2f} in",
        f"native charts: {charts}",
        f"fonts: {', '.join(name for name, _ in fonts.most_common(4)) or 'theme default'}",
    ]
    return _lines(f"{os.path.basename(path)} (pptx)", list(dict.fromkeys(findings)), facts)


# --- Rendered pages ---------------------------------------------------------------------------


def render_pdf(path: str, dpi: int = 110, pages: int = 20) -> str:
    """The first ``pages`` pages of a PDF as ``page-NNN.png`` in ``.renders/<name>/`` (a copy
    of the PDF goes there too, as ``document.pdf``); returns that folder."""
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "-", os.path.splitext(os.path.basename(path))[0]) or "pdf"
    folder = os.path.join(RENDERS, f"{stem}-pdf")
    shutil.rmtree(folder, ignore_errors=True)
    os.makedirs(folder)
    shutil.copyfile(path, os.path.join(folder, "document.pdf"))
    try:
        import pypdfium2  # type: ignore[import-not-found]  # noqa: PLC0415

        document = pypdfium2.PdfDocument(path)
        for index in range(min(len(document), pages)):
            image = document[index].render(scale=dpi / 72).to_pil()
            image.save(os.path.join(folder, f"page-{index + 1:03d}.png"))
    except ImportError:
        subprocess.run(  # noqa: S603 - fixed program, arguments are paths
            ["pdftoppm", "-png", "-r", str(dpi), "-l", str(pages), path, f"{folder}/page"],  # noqa: S607
            check=True,
            capture_output=True,
            timeout=120,
        )
        for name in os.listdir(folder):
            match = re.fullmatch(r"page-0*(\d+)\.png", name)
            if match:
                os.replace(
                    os.path.join(folder, name),
                    os.path.join(folder, f"page-{int(match.group(1)):03d}.png"),
                )
    return folder


def page_findings(image: Any) -> tuple[list[str], str]:
    """Problems of one page image (Pillow) and a one-line description of it."""
    gray = image.convert("L")
    width, height = gray.size
    border = [gray.getpixel((x, y)) for x in (0, width - 1) for y in range(0, height, 8)]
    border += [gray.getpixel((x, y)) for y in (0, height - 1) for x in range(0, width, 8)]
    background = Counter(border).most_common(1)[0][0]
    ink = gray.point(lambda v: 255 if abs(v - background) > INK_DIFFERENCE else 0)
    box = ink.getbbox()
    if box is None:
        return ["blank page"], "blank"
    histogram = ink.histogram()
    coverage = histogram[255] / (width * height)
    findings = []
    margin = max(2, round(min(width, height) * 0.004))
    edges = [
        side
        for side, touches in (
            ("left", box[0] <= margin),
            ("top", box[1] <= margin),
            ("right", box[2] >= width - margin),
            ("bottom", box[3] >= height - margin),
        )
        if touches
    ]
    if edges:
        findings.append(f"content touches the {'/'.join(edges)} edge (cut off or no margin)")
    used = (box[2] - box[0]) * (box[3] - box[1]) / (width * height)
    if used < EMPTY_PAGE_SHARE:
        findings.append("almost empty page")
    return findings, f"ink {coverage:.0%}, content box {used:.0%} of the page"


def pdf_findings(pages_text: list[str], fonts: list[str]) -> list[str]:
    """Problems found in the text and the fonts of a rendered PDF."""
    findings = []
    for number, text in enumerate(pages_text, start=1):
        errors = Counter(_EXCEL_ERRORS.findall(text))
        if errors:
            listed = ", ".join(f"{e} x{n}" for e, n in sorted(errors.items()))
            findings.append(f"page {number}: error values {listed}: fix those formulas")
        if _HASHES.search(_EXCEL_ERRORS.sub("", text)):
            findings.append(f"page {number}: '###': a column is too narrow for its numbers")
        if _CJK.search(text):
            findings.append(f"page {number}: CJK text, drawn as boxes (no CJK fonts)")
    standard = sorted({f for f in fonts if f.split("-")[0] in _STANDARD_PDF_FONTS})
    if standard and any(ord(c) > _LATIN1_LAST for c in "".join(pages_text)):
        findings.append(
            f"standard fonts ({', '.join(standard)}) with characters beyond Latin-1: they "
            "show as boxes; register a TrueType font (mango_docs.pdf_font)"
        )
    return findings


def _pdf_text_and_fonts(path: str) -> tuple[list[str], list[str]] | None:
    try:
        from pypdf import PdfReader  # type: ignore[import-not-found]  # noqa: PLC0415
    except ImportError:
        return None
    reader = PdfReader(path)
    texts, fonts = [], set()
    for page in reader.pages[:50]:
        texts.append(page.extract_text() or "")
        resources = page.get("/Resources") or {}
        for font in (resources.get("/Font") or {}).values():
            name = str(font.get_object().get("/BaseFont", ""))
            fonts.add(name.lstrip("/").split("+")[-1])
    return texts, sorted(fonts)


def inspect_render(folder: str) -> str:
    """Findings of the pages of a render (``page-NNN.png`` and ``document.pdf`` in
    ``folder``): blank pages, content cut at the edges, error values, fonts."""
    from PIL import Image  # type: ignore[import-not-found, unused-ignore]  # noqa: PLC0415

    names = sorted(n for n in os.listdir(folder) if re.fullmatch(r"page-\d+\.png", n))
    findings: list[str] = []
    facts: list[str] = [f"pages rendered: {len(names)}"]
    for name in names:
        with Image.open(os.path.join(folder, name)) as image:
            found, summary = page_findings(image)
        number = int(re.sub(r"\D", "", name))
        facts.append(f"page {number}: {summary}")
        findings.extend(f"page {number}: {finding}" for finding in found)
    pdf = os.path.join(folder, "document.pdf")
    if os.path.exists(pdf):
        read = _pdf_text_and_fonts(pdf)
        if read is None:
            facts.append("text and fonts: not checked (pypdf is not available)")
        else:
            texts, fonts = read
            facts.append(f"fonts used: {', '.join(fonts) or '(none)'}")
            findings.extend(pdf_findings(texts, fonts))
    return _lines(f"render {folder}", findings, facts)


# --- Fonts for ReportLab ----------------------------------------------------------------------

_FONT_DIRS = ("/usr/share/fonts", "/usr/local/share/fonts", os.path.expanduser("~/.fonts"))
_FONT_FILES = {
    ("sans", False): ("NotoSans-Regular.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf"),
    ("sans", True): ("NotoSans-Bold.ttf", "DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf"),
    ("serif", False): ("NotoSerif-Regular.ttf", "DejaVuSerif.ttf", "LiberationSerif-Regular.ttf"),
    ("serif", True): ("NotoSerif-Bold.ttf", "DejaVuSerif-Bold.ttf", "LiberationSerif-Bold.ttf"),
    ("mono", False): (
        "NotoSansMono-Regular.ttf",
        "DejaVuSansMono.ttf",
        "LiberationMono-Regular.ttf",
    ),
    ("mono", True): ("NotoSansMono-Bold.ttf", "DejaVuSansMono-Bold.ttf", "LiberationMono-Bold.ttf"),
}


def find_font(kind: str = "sans", bold: bool = False) -> str | None:
    """Path of a TrueType font of the sandbox for ``kind`` (sans, serif or mono)."""
    wanted = _FONT_FILES.get((kind, bold))
    if wanted is None:
        raise ValueError("kind is sans, serif or mono")
    found: dict[str, str] = {}
    for base in _FONT_DIRS:
        for root, _, files in os.walk(base):
            for name in files:
                if name in wanted and name not in found:
                    found[name] = os.path.join(root, name)
    for name in wanted:
        if name in found:
            return found[name]
    return None


def pdf_font(kind: str = "sans", bold: bool = False) -> str:
    """A TrueType font registered with ReportLab, by name (``Mango-sans``, ``Mango-sans-bold``…);
    raises ``LookupError`` if the sandbox has none of that kind."""
    from reportlab.pdfbase import pdfmetrics  # type: ignore[import-not-found, unused-ignore]  # noqa: PLC0415
    from reportlab.pdfbase.ttfonts import TTFont  # type: ignore[import-not-found, unused-ignore]  # noqa: PLC0415

    name = f"Mango-{kind}{'-bold' if bold else ''}"
    if name in pdfmetrics.getRegisteredFontNames():
        return name
    path = find_font(kind, bold)
    if path is None:
        raise LookupError(f"no {kind} TrueType font in this sandbox")
    pdfmetrics.registerFont(TTFont(name, path))
    return name
