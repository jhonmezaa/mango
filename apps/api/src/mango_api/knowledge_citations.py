"""What the chat shows of the knowledge searches of a turn (D88 (44)).

The answer of ``knowledge___retrieve`` (``connectors/knowledge-retrieve``) carries, for each
fragment, its knowledge base, its document, its page and its text. The chat receives only
the metadata: the name of each knowledge base searched, how many fragments came back and,
for each source, its document and its page. Never the text of a fragment: it went to the
model, and it stays out of the stream and of the stored message.

Everything is plain text. The names come from the registry (a knowledge base and the file
name of a document, both written by people), so control characters are dropped and each one
is cut to ``MAX_NAME_CHARS``; nothing is ever marked up. An answer of another shape, an
error or one too long gives no citations: the answer of a tool is untrusted (TM-LP1).
"""

from __future__ import annotations

import json
import unicodedata
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from mango_core.knowledge_search import MAX_FRAGMENTS

MAX_ANSWER_CHARS = 64 * 1024
"""Of one answer of the tool: ``MAX_FRAGMENTS`` fragments of at most 2,000 characters, their
names and the notice fit with room to spare. A longer one is not read."""
MAX_NAME_CHARS = 200
MAX_PAGE = 100_000
MAX_CITATIONS = 3 * MAX_FRAGMENTS
"""Sources kept on one message, over all its searches."""


@dataclass(frozen=True)
class Source:
    knowledge_base: str
    document: str
    page: int | None

    def out(self) -> dict[str, Any]:
        return {
            "knowledge_base": self.knowledge_base,
            "document": self.document,
            **({"page": self.page} if self.page is not None else {}),
        }


@dataclass(frozen=True)
class Search:
    """One search of the turn: what the ``knowledge`` event of the stream says."""

    count: int
    """Fragments the search returned, as the tool counted them."""
    sources: tuple[Source, ...]
    """Each document and page once, in the order of the fragments."""

    def event(self) -> dict[str, Any]:
        return {
            "knowledge_bases": list(dict.fromkeys(s.knowledge_base for s in self.sources)),
            "count": self.count,
            "sources": [s.out() for s in self.sources],
        }


def _json(text: str) -> Any:
    try:
        return json.loads(text)
    except ValueError:
        return None


def _answer(text: str) -> Mapping[str, Any] | None:
    """The tool's answer: its JSON, or the JSON in its first MCP text block."""
    loaded = _json(text)
    if isinstance(loaded, Mapping) and isinstance(loaded.get("content"), list):
        for block in loaded["content"]:
            if isinstance(block, Mapping) and isinstance(block.get("text"), str):
                loaded = _json(block["text"])
                break
    return loaded if isinstance(loaded, Mapping) else None


def plain(value: object) -> str | None:
    """``value`` as one line of plain text: no control or format characters, at most
    ``MAX_NAME_CHARS``. ``None`` if it is not text or nothing is left."""
    if not isinstance(value, str):
        return None
    kept = "".join(" " if unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp") else c for c in value)
    cleaned = " ".join(kept.split())[:MAX_NAME_CHARS].strip()
    return cleaned or None


def _page(value: object) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= MAX_PAGE:
        return value
    return None


def search_of(text: str) -> Search | None:
    """The citations of one answer of the tool, or ``None`` if it is not one it gives."""
    if len(text) > MAX_ANSWER_CHARS:
        return None
    answer = _answer(text)
    if answer is None or answer.get("status") not in ("ok", "no_results"):
        return None
    fragments = answer.get("fragments")
    if not isinstance(fragments, list):
        return None
    sources: dict[Source, None] = {}
    count = 0
    for fragment in fragments[:MAX_FRAGMENTS]:
        if not isinstance(fragment, Mapping):
            continue
        knowledge_base = plain(fragment.get("knowledge_base"))
        document = plain(fragment.get("document"))
        if knowledge_base is None or document is None:
            continue
        count += 1
        sources[Source(knowledge_base, document, _page(fragment.get("page")))] = None
    return Search(count=count, sources=tuple(sources))


def citations(searches: Iterable[Search]) -> list[dict[str, Any]]:
    """The sources of a message: each one once, over all its searches, at most
    ``MAX_CITATIONS``."""
    seen: dict[Source, None] = {}
    for search in searches:
        for source in search.sources:
            seen.setdefault(source, None)
    return [s.out() for s in list(seen)[:MAX_CITATIONS]]
