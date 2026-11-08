"""A Canvas document (Markdown) as a Word file, for «Exportar» (D124 (3)).

The Markdown is parsed with ``markdown-it-py`` (CommonMark with tables and strikethrough) with
raw HTML **off**: an HTML tag in the text stays text, it is never interpreted. What it draws is
written with ``python-docx`` into a new document of its default template:

* headings 1 to 6, paragraphs, bold, italics, strikethrough, inline code and code blocks
  (monospace), block quotes, bullet and numbered lists (nested), tables and rules;
* a link keeps its text and gets its address after it in brackets (no hyperlink is written:
  a file of the chat never carries a live link the model chose);
* an image is written as its alternative text only: nothing is fetched (no network here, and
  never a URL the model chose).

The PDF is this same Word file rendered by ``Mango-<ns>-RenderDocument`` (D117), so both
exports look alike. Nothing of the document is logged.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from typing import Any

from docx import Document
from docx.enum.text import WD_BREAK
from docx.shared import Pt
from markdown_it import MarkdownIt
from markdown_it.token import Token

MONO = "Courier New"
MAX_TABLE_COLUMNS = 30
_LIST_STYLES = {"bullet": "List Bullet", "ordered": "List Number"}


def _parser() -> MarkdownIt:
    # ``commonmark`` with ``html`` off: tags stay text. GFM tables and strikethrough on.
    return MarkdownIt("commonmark", {"html": False, "linkify": False, "typographer": False}).enable(
        ["table", "strikethrough"]
    )


@dataclass
class _Run:
    bold: int = 0
    italic: int = 0
    strike: int = 0
    links: list[str] = field(default_factory=list)


def _inline(  # noqa: PLR0912 - one branch per inline token
    paragraph: Any, children: list[Token], *, mono: bool = False
) -> None:
    """The inline tokens of a block into ``paragraph``, as runs."""
    state = _Run()
    for token in children:
        kind = token.type
        if kind == "text":
            _text(paragraph, token.content, state, mono=mono)
        elif kind == "code_inline":
            run = paragraph.add_run(token.content)
            run.font.name = MONO
            run.bold = state.bold > 0
            run.italic = state.italic > 0
        elif kind in {"softbreak", "hardbreak"}:
            if kind == "hardbreak":
                paragraph.add_run().add_break(WD_BREAK.LINE)
            else:
                _text(paragraph, " ", state, mono=mono)
        elif kind == "strong_open":
            state.bold += 1
        elif kind == "strong_close":
            state.bold = max(0, state.bold - 1)
        elif kind == "em_open":
            state.italic += 1
        elif kind == "em_close":
            state.italic = max(0, state.italic - 1)
        elif kind == "s_open":
            state.strike += 1
        elif kind == "s_close":
            state.strike = max(0, state.strike - 1)
        elif kind == "link_open":
            state.links.append(str(token.attrGet("href") or ""))
        elif kind == "link_close":
            href = state.links.pop() if state.links else ""
            if href:
                _text(paragraph, f" ({href})", state, mono=mono)
        elif kind == "image":
            # Its alternative text only: nothing is fetched.
            alt = "".join(c.content for c in token.children or [])
            if alt:
                _text(paragraph, f"[{alt}]", state, mono=mono)


def _text(paragraph: Any, text: str, state: _Run, *, mono: bool) -> None:
    run = paragraph.add_run(text)
    run.bold = state.bold > 0
    run.italic = state.italic > 0
    run.font.strike = state.strike > 0
    if mono:
        run.font.name = MONO


def _code_block(document: Any, text: str) -> None:
    paragraph = document.add_paragraph()
    for n, line in enumerate(text.rstrip("\n").split("\n")):
        if n:
            paragraph.add_run().add_break(WD_BREAK.LINE)
        run = paragraph.add_run(line)
        run.font.name = MONO
        run.font.size = Pt(9)


def _table(document: Any, tokens: list[Token], start: int) -> int:
    """The table that opens at ``tokens[start]``; returns the index after it."""
    rows: list[list[list[Token]]] = []
    header_rows = 0
    i = start + 1
    in_head = False
    while i < len(tokens) and tokens[i].type != "table_close":
        token = tokens[i]
        if token.type == "thead_open":
            in_head = True
        elif token.type == "thead_close":
            in_head = False
        elif token.type == "tr_open":
            rows.append([])
            if in_head:
                header_rows += 1
        elif token.type == "inline" and rows:
            rows[-1].append(token.children or [])
        i += 1
    columns = min(max((len(r) for r in rows), default=0), MAX_TABLE_COLUMNS)
    if rows and columns:
        table = document.add_table(rows=len(rows), cols=columns)
        table.style = "Table Grid"
        for r, row in enumerate(rows):
            for c, cell in enumerate(row[:columns]):
                paragraph = table.cell(r, c).paragraphs[0]
                _inline(paragraph, cell)
                if r < header_rows:
                    for run in paragraph.runs:
                        run.bold = True
    return i + 1


def markdown_to_docx(markdown: str, title: str) -> bytes:  # noqa: PLR0912, PLR0915 - one branch per block
    """The Word file of a Canvas document: its title as the document's title (core property)
    and its Markdown drawn as described in the module."""
    document = Document()
    document.core_properties.title = title[:255]
    tokens = _parser().parse(markdown)
    lists: list[str] = []
    quote = 0
    i = 0
    while i < len(tokens):
        token = tokens[i]
        kind = token.type
        if kind == "heading_open":
            level = int(token.tag[1:]) if token.tag[1:].isdigit() else 1
            heading = document.add_heading(level=min(max(level, 1), 6))
            _inline(heading, tokens[i + 1].children or [])
            i += 3
            continue
        if kind == "paragraph_open":
            inline = tokens[i + 1]
            if lists:
                style = _LIST_STYLES[lists[-1]]
                depth = len(lists)
                if depth > 1:
                    style = f"{style} {min(depth, 3)}"
                paragraph = document.add_paragraph(style=style)
            elif quote:
                paragraph = document.add_paragraph(style="Quote")
            else:
                paragraph = document.add_paragraph()
            _inline(paragraph, inline.children or [])
            i += 3
            continue
        if kind == "bullet_list_open":
            lists.append("bullet")
        elif kind == "ordered_list_open":
            lists.append("ordered")
        elif kind in {"bullet_list_close", "ordered_list_close"}:
            if lists:
                lists.pop()
        elif kind == "blockquote_open":
            quote += 1
        elif kind == "blockquote_close":
            quote = max(0, quote - 1)
        elif kind in {"fence", "code_block"}:
            _code_block(document, token.content)
        elif kind == "hr":
            document.add_paragraph("―" * 20)
        elif kind == "table_open":
            i = _table(document, tokens, i)
            continue
        i += 1
    out = io.BytesIO()
    document.save(out)
    return out.getvalue()
