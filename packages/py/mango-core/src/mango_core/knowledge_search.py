"""One search over the knowledge bases a person may use (D88 (14)): what the
``knowledge-retrieve`` tool and «Probar búsqueda» of mango-api share.

The caller decides which knowledge bases are searched, from the registry and the verified
token, never from the model nor the request. Here:

* **No list, no call.** With no knowledge base to search, ``Retrieve`` is not called: Bedrock
  refuses an empty ``in`` (D88 (27)), and a search without that filter would read every base
  of the installation. Nothing turns that refusal into a search without a filter.
* **The filter** is ``andAll[kb_id in <bases>, business_unit in <their areas>]`` (D88 (14));
  the groups of each fragment are not read (D88 (22)).
* **Each fragment is checked again**: one whose ``kb_id`` is not of the bases searched is
  dropped, whatever Bedrock returned.
* **Bounded:** at most ``MAX_FRAGMENTS`` fragments of at most ``MAX_FRAGMENT_CHARS`` each.
  Their text is document content, untrusted (indirect prompt injection): the caller hands it
  on as data, never as instructions.

Errors carry the AWS error code only, never its message.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

logger = logging.getLogger(__name__)

MAX_QUERY_CHARS = 1000
"""Of one query: what ``Retrieve`` accepts in the account (D88 (27))."""
MAX_FRAGMENTS = 8
MAX_FRAGMENT_CHARS = 2000
CHARS_PER_TOKEN = 4
"""To estimate the tokens of a query for its embedding, as the synchronization does."""
CHUNK_ID_KEY = "x-amz-bedrock-kb-chunk-id"
PAGE_KEY = "x-amz-bedrock-kb-document-page-number"
_THROTTLED = frozenset({"ThrottlingException", "TooManyRequestsException"})


class SearchThrottledError(Exception):
    """Bedrock refused the search for the quota of the account (20 per second)."""


class SearchUnavailableError(Exception):
    """Bedrock refused or failed the search for another reason; the error code only."""


@dataclass(frozen=True)
class Searchable:
    """A knowledge base the person may use, as the registry has it now."""

    kb_id: str
    business_unit: str


@dataclass(frozen=True)
class Fragment:
    kb_id: str
    doc_id: str
    text: str
    """Document content: untrusted, never instructions."""
    score: float | None
    page: int | None
    fragment_id: str


def query_tokens(query: str) -> int:
    """Tokens of the embedding of ``query``, estimated by its length."""
    return math.ceil(len(query) / CHARS_PER_TOKEN)


def retrieval_filter(bases: Collection[Searchable]) -> dict[str, Any]:
    """The filter of a search over ``bases``. Never empty: with no base there is no search."""
    if not bases:
        raise ValueError("a search needs at least one knowledge base")
    kb_ids = sorted({base.kb_id for base in bases})
    areas = sorted({base.business_unit for base in bases})
    return {
        "andAll": [
            {"in": {"key": "kb_id", "value": kb_ids}},
            {"in": {"key": "business_unit", "value": areas}},
        ]
    }


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _page(metadata: Mapping[str, Any]) -> int | None:
    raw = metadata.get(PAGE_KEY)
    if isinstance(raw, bool) or not isinstance(raw, int | float):
        return None
    return int(raw) if raw >= 1 else None


def _fragment(result: Mapping[str, Any], allowed: Collection[str]) -> Fragment | None:
    metadata = result.get("metadata")
    if not isinstance(metadata, Mapping):
        return None
    kb_id, doc_id = _text(metadata.get("kb_id")), _text(metadata.get("doc_id"))
    text = _text((result.get("content") or {}).get("text"))
    if kb_id is not None and kb_id not in allowed:
        # The filter should never let it through (TM-K1): dropped, and said, with no content.
        logger.error("knowledge search returned a fragment of a base not searched")
        return None
    if kb_id is None or doc_id is None or text is None:
        # Not one the synchronization indexed: dropped.
        return None
    score = result.get("score")
    return Fragment(
        kb_id=kb_id,
        doc_id=doc_id,
        text=text[:MAX_FRAGMENT_CHARS],
        score=float(score) if isinstance(score, int | float) else None,
        page=_page(metadata),
        fragment_id=_text(metadata.get(CHUNK_ID_KEY)) or "",
    )


def search(
    retrieve: Callable[..., Mapping[str, Any]],
    *,
    knowledge_base_id: str,
    query: str,
    bases: Collection[Searchable],
    max_fragments: int = MAX_FRAGMENTS,
) -> list[Fragment]:
    """Fragments of ``bases`` that answer ``query``, best first.

    ``retrieve`` is ``Retrieve`` of a ``bedrock-agent-runtime`` client. ``bases`` empty: ``[]``,
    and Bedrock is not called. Raises :class:`SearchThrottledError` or
    :class:`SearchUnavailableError`.
    """
    if not bases:
        return []
    if not query or len(query) > MAX_QUERY_CHARS or not 1 <= max_fragments <= MAX_FRAGMENTS:
        raise ValueError("invalid search")
    try:
        response = retrieve(
            knowledgeBaseId=knowledge_base_id,
            retrievalQuery={"text": query},
            retrievalConfiguration={
                "vectorSearchConfiguration": {
                    "numberOfResults": max_fragments,
                    "filter": retrieval_filter(bases),
                }
            },
        )
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in _THROTTLED:
            raise SearchThrottledError(code) from None
        logger.error("knowledge search failed: %s", code)  # noqa: TRY400 - the code, never the message
        raise SearchUnavailableError(code) from None
    except BotoCoreError:
        logger.error("knowledge search failed: no answer")  # noqa: TRY400 - no message to log
        raise SearchUnavailableError("unreachable") from None
    allowed = {base.kb_id for base in bases}
    fragments = [
        fragment
        for result in response.get("retrievalResults") or []
        if isinstance(result, Mapping) and (fragment := _fragment(result, allowed)) is not None
    ]
    return fragments[:max_fragments]
