"""The helpers of the document skills (``mango_docs``, D119 (2)) on small OOXML packages made
here by hand and on page images drawn with Pillow: no Office library, no AWS."""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from mango_code_interpreter import mango_docs

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'


def _package(path: Path, parts: dict[str, str]) -> str:
    with zipfile.ZipFile(path, "w") as package:
        for name, body in parts.items():
            package.writestr(name, body)
    return str(path)


# --- Text -------------------------------------------------------------------------------------


def test_clean_text_replaces_what_fonts_do_not_draw() -> None:
    assert mango_docs.clean_text("pre\u2011sale\u00a0x\u200b\u00ady") == "pre-sale xy"
    # Ordinary punctuation and accents stay.
    assert mango_docs.clean_text("Año — «cotización» \u2013 5 €") == "Año — «cotización» \u2013 5 €"


# --- Word -------------------------------------------------------------------------------------


def _docx(tmp_path: Path, body: str) -> str:
    return _package(
        tmp_path / "doc.docx",
        {
            "[Content_Types].xml": "<Types/>",
            "word/document.xml": f"<w:document {W}><w:body>{body}</w:body></w:document>",
            "word/styles.xml": (
                f'<w:styles {W}><w:style><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>'
                "</w:rPr></w:style></w:styles>"
            ),
        },
    )


def _p(text: str, style: str = "") -> str:
    ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    return f"<w:p>{ppr}<w:r><w:t>{text}</w:t></w:r></w:p>"


def test_inspect_docx_reports_outline_and_problems(tmp_path: Path) -> None:
    body = _p("Informe", "Title") + _p("Ventas", "Heading1") + _p("pre\u2011venta") + "<w:p/>" * 3
    report = mango_docs.inspect_docx(_docx(tmp_path, body))
    assert "outline: Title: Informe; Heading1: Ventas" in report
    assert "fonts: Calibri" in report
    assert "3 empty paragraphs in a row" in report
    assert "U+2011 NON-BREAKING HYPHEN x1" in report


def test_a_clean_document_has_no_problems(tmp_path: Path) -> None:
    report = mango_docs.inspect_docx(_docx(tmp_path, _p("Informe", "Heading1") + _p("Texto.")))
    assert report.endswith("problems: none found")


def test_cjk_text_is_announced(tmp_path: Path) -> None:
    report = mango_docs.inspect_docx(_docx(tmp_path, _p("報告")))
    assert "CJK text" in report


# --- Excel ------------------------------------------------------------------------------------


def _xlsx(tmp_path: Path, cells: str, *, frozen: bool = False) -> str:
    pane = '<sheetViews><sheetView><pane ySplit="1" state="frozen"/></sheetView></sheetViews>'
    return _package(
        tmp_path / "book.xlsx",
        {
            "[Content_Types].xml": "<Types/>",
            "xl/workbook.xml": (
                f'<workbook {S} {R}><sheets><sheet name="Datos" sheetId="1" r:id="rId1"/>'
                "</sheets></workbook>"
            ),
            "xl/_rels/workbook.xml.rels": (
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
            ),
            "xl/sharedStrings.xml": (
                f"<sst {S}><si><t>Mes</t></si><si><t>Total</t></si><si><t>Valor</t></si></sst>"
            ),
            "xl/worksheets/sheet1.xml": (
                f"<worksheet {S}>{pane if frozen else ''}<sheetData>{cells}</sheetData></worksheet>"
            ),
        },
    )


HEADER = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row>'


def test_inspect_xlsx_flags_dynamic_arrays_and_typed_totals(tmp_path: Path) -> None:
    cells = (
        HEADER
        + '<row r="2"><c r="B2"><v>10</v></c><c r="C2"><f>_xlfn.XLOOKUP(A2,A:A,B:B)</f></c></row>'
        + '<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><v>10</v></c></row>'
    )
    report = mango_docs.inspect_xlsx(_xlsx(tmp_path, cells))
    assert "Datos: XLOOKUP x1" in report
    assert "Datos!row 3 looks like a total but B3 hold typed numbers" in report
    assert "sheet Datos: 3 rows, 1 formulas, 2 typed numbers" in report


def test_a_workbook_with_formulas_for_its_totals_is_clean(tmp_path: Path) -> None:
    cells = (
        HEADER
        + '<row r="2"><c r="B2"><v>10</v></c></row>'
        + '<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><f>SUM(B2:B2)</f></c></row>'
    )
    report = mango_docs.inspect_xlsx(_xlsx(tmp_path, cells, frozen=True))
    assert report.endswith("problems: none found"), report


def test_ordinary_functions_are_not_taken_for_dynamic_ones(tmp_path: Path) -> None:
    cells = HEADER + '<row r="2"><c r="B2"><f>SUMIFS(B:B,A:A,"x")+MYSORT(1)</f></c></row>'
    assert "dynamic array" not in mango_docs.inspect_xlsx(_xlsx(tmp_path, cells))


# --- PowerPoint -------------------------------------------------------------------------------


def _shape(x: int, y: int, cx: int, cy: int, text: str, *, size: int = 1800) -> str:
    return (
        f'<p:sp><p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        f'</p:spPr><p:txBody><a:p><a:r><a:rPr sz="{size}"><a:latin typeface="Calibri"/></a:rPr>'
        f"<a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>"
    )


def _pptx(tmp_path: Path, *slides: str) -> str:
    parts = {
        "[Content_Types].xml": "<Types/>",
        "ppt/presentation.xml": f'<p:presentation {P}><p:sldSz cx="12192000" cy="6858000"/>'
        "</p:presentation>",
    }
    for number, shapes in enumerate(slides, start=1):
        parts[f"ppt/slides/slide{number}.xml"] = (
            f"<p:sld {P} {A}><p:cSld><p:spTree>{shapes}</p:spTree></p:cSld></p:sld>"
        )
    return _package(tmp_path / "deck.pptx", parts)


def test_inspect_pptx_flags_shapes_outside_overflow_and_small_text(tmp_path: Path) -> None:
    deck = _pptx(
        tmp_path,
        _shape(457200, 457200, 11277600, 1143000, "Resultados del trimestre"),
        _shape(11000000, 457200, 2000000, 914400, "Fuera")
        + _shape(457200, 1600200, 3000000, 457200, "palabra " * 60)
        + _shape(457200, 5000000, 3000000, 457200, "nota", size=900),
    )
    report = mango_docs.inspect_pptx(deck)
    assert "slides: 2" in report
    assert "size: 13.33 x 7.50 in" in report
    assert "slide 2: a shape goes outside the slide" in report
    assert "slide 2: text probably overflows its box" in report
    assert "slide 2: text of 9 pt" in report
    assert "slide 1:" not in report


# --- Rendered pages ---------------------------------------------------------------------------


def _page(
    path: Path, box: tuple[int, int, int, int] | None, background: str = "white", ink: str = "black"
) -> None:
    image = Image.new("RGB", (400, 560), background)
    if box is not None:
        ImageDraw.Draw(image).rectangle(box, fill=ink)
    image.save(path)


def test_inspect_render_finds_blank_and_cut_pages(tmp_path: Path) -> None:
    _page(tmp_path / "page-001.png", (40, 40, 360, 520))
    _page(tmp_path / "page-002.png", None)
    _page(tmp_path / "page-003.png", (300, 40, 399, 300))
    report = mango_docs.inspect_render(str(tmp_path))
    assert "pages rendered: 3" in report
    assert "page 1:" not in report.split("problems:", 1)[1]
    assert "page 2: blank page" in report
    assert "page 3: content touches the right edge" in report


def test_a_full_bleed_background_is_not_content(tmp_path: Path) -> None:
    _page(tmp_path / "page-001.png", (60, 60, 340, 300), background="navy", ink="white")
    found, _ = mango_docs.page_findings(Image.open(tmp_path / "page-001.png"))
    assert found == []


def test_pdf_findings_read_error_values_narrow_columns_and_fonts() -> None:
    found = mango_docs.pdf_findings(
        ["Total #REF! 12 #DIV/0!", "Ventas ######## 3", "Ok"], ["Carlito", "Helvetica"]
    )
    assert found[0] == "page 1: error values #DIV/0! x1, #REF! x1: fix those formulas"
    assert found[1] == "page 2: '###': a column is too narrow for its numbers"
    assert len(found) == 2
    beyond = mango_docs.pdf_findings(["Āa"], ["Helvetica"])
    assert "register a TrueType font" in beyond[0]


def test_render_pdf_puts_the_pages_in_a_hidden_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[list[str]] = []

    def fake_run(args: list[str], **_: object) -> None:
        calls.append(args)
        _page(Path(f"{args[-1]}-1.png"), (40, 40, 360, 520))

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(mango_docs.subprocess, "run", fake_run)
    monkeypatch.setitem(__import__("sys").modules, "pypdfium2", None)
    (tmp_path / "Informe final.pdf").write_bytes(b"%PDF-1.7")
    folder = mango_docs.render_pdf("Informe final.pdf", pages=3)
    assert folder == ".renders/Informe-final-pdf"
    assert sorted(p.name for p in (tmp_path / folder).iterdir()) == ["document.pdf", "page-001.png"]
    assert calls[0][:2] == ["pdftoppm", "-png"]


def test_find_font_prefers_noto_then_dejavu(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "dejavu").mkdir()
    (tmp_path / "dejavu" / "DejaVuSans.ttf").write_bytes(b"")
    monkeypatch.setattr(mango_docs, "_FONT_DIRS", (str(tmp_path),))
    assert mango_docs.find_font("sans") == str(tmp_path / "dejavu" / "DejaVuSans.ttf")
    (tmp_path / "NotoSans-Regular.ttf").write_bytes(b"")
    assert mango_docs.find_font("sans") == str(tmp_path / "NotoSans-Regular.ttf")
    assert mango_docs.find_font("serif") is None
    with pytest.raises(ValueError, match="sans, serif or mono"):
        mango_docs.find_font("script")


def test_every_helper_the_skills_name_exists() -> None:
    import re  # noqa: PLC0415

    from mango_core import document_skills  # noqa: PLC0415

    named = {
        name
        for skill_id in document_skills.IDS
        for name in re.findall(r"mango_docs\.([a-z_]+)", document_skills.text(skill_id))
    }
    assert named >= {"clean_text", "inspect_render", "render_pdf", "pdf_font"}
    assert all(callable(getattr(mango_docs, name, None)) for name in named), named
