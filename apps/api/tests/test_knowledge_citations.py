import json
from typing import Any

import pytest

from mango_api import knowledge_citations
from mango_api.knowledge_citations import MAX_CITATIONS, MAX_NAME_CHARS, Search, Source


def _answer(*fragments: dict[str, Any]) -> str:
    return json.dumps({"status": "ok", "notice": "datos", "fragments": list(fragments)})


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("Vacaciones 2026.pdf", "Vacaciones 2026.pdf"),
        # Line breaks, control and bidirectional format characters never reach the screen.
        ("Plan\nde\r\nvacaciones", "Plan de vacaciones"),
        ("a\x00b\x1b[31m", "a b [31m"),
        ("factura\N{RIGHT-TO-LEFT OVERRIDE}gnp.exe", "factura gnp.exe"),
        ("<b>negrita</b>", "<b>negrita</b>"),
        ("   ", None),
        (12, None),
        (None, None),
    ],
)
def test_names_are_one_line_of_plain_text(value: object, expected: str | None) -> None:
    assert knowledge_citations.plain(value) == expected


def test_a_long_name_is_cut() -> None:
    assert knowledge_citations.plain("x" * 500) == "x" * MAX_NAME_CHARS


@pytest.mark.parametrize(
    ("page", "kept"),
    [(1, 1), (0, None), (-3, None), (True, None), ("4", None), (10**9, None), (2.5, None)],
)
def test_only_a_plausible_page_is_kept(page: object, kept: int | None) -> None:
    search = knowledge_citations.search_of(
        _answer({"knowledge_base": "KB", "document": "a.pdf", "page": page, "text": "x"})
    )
    assert search is not None and search.sources == (Source("KB", "a.pdf", kept),)


def test_a_fragment_without_its_names_is_not_counted() -> None:
    search = knowledge_citations.search_of(
        _answer(
            {"knowledge_base": "KB", "text": "x"},
            {"document": "a.pdf", "text": "x"},
            "no es un fragmento",
            {"knowledge_base": "KB", "document": "a.pdf", "text": "x"},
        )
    )
    assert search == Search(count=1, sources=(Source("KB", "a.pdf", None),))


def test_the_event_names_each_knowledge_base_once() -> None:
    search = knowledge_citations.search_of(
        _answer(
            {"knowledge_base": "RH", "document": "a.pdf", "page": 2, "text": "x"},
            {"knowledge_base": "Legal", "document": "b.pdf", "text": "x"},
            {"knowledge_base": "RH", "document": "c.pdf", "text": "x"},
        )
    )
    assert search is not None
    assert search.event() == {
        "knowledge_bases": ["RH", "Legal"],
        "count": 3,
        "sources": [
            {"knowledge_base": "RH", "document": "a.pdf", "page": 2},
            {"knowledge_base": "Legal", "document": "b.pdf"},
            {"knowledge_base": "RH", "document": "c.pdf"},
        ],
    }


def test_the_message_keeps_each_source_once_up_to_its_cap() -> None:
    first = Search(2, (Source("RH", "a.pdf", 1), Source("RH", "b.pdf", None)))
    again = Search(1, (Source("RH", "a.pdf", 1),))
    many = Search(40, tuple(Source("RH", f"{n}.pdf", None) for n in range(40)))
    assert knowledge_citations.citations([first, again]) == [
        {"knowledge_base": "RH", "document": "a.pdf", "page": 1},
        {"knowledge_base": "RH", "document": "b.pdf"},
    ]
    assert len(knowledge_citations.citations([first, many])) == MAX_CITATIONS
