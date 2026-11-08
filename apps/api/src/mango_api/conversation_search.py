"""Buscar conversaciones (D103; threat model ``conversation-search-threat-model.md``): the caller's
own conversations, searched in ``mango-api``.

No index and no copy of content anywhere else: each search walks the person's partition of
``Conversations`` with their row-level security client (``dynamodb:LeadingKeys`` =
``USER#<sub>``), newest conversations first, and filters in memory. The read is bounded (see the
caps below) and the answer says when a cap stopped it (``capped``).

Security notes (security-best-practices, FastAPI):
* The route declares its Cedar action, ``SearchConversations`` (anyone with a session), audited
  as a read; deny by default. Nothing for administrators over other people's conversations
  (D23): there is no parameter that names a person, and the session of STS only reaches the
  caller's partition.
* The search is a ``POST`` with a JSON body so that its terms never reach the access logs of the
  ALB or CloudFront, which keep query strings.
* Every input has a schema (VALID-001): the query (at most 200 characters, 8 terms), the agent
  (``AGENT_ID_PATTERN``), the kind, the date and the order (closed lists) and the offset of the
  person's clock (bounded). The response is an explicit model (RESP-001).
* Stored text is untrusted (titles, messages, agent answers and tool names): the snippets are
  plain text split into parts; the client renders them as text, never as HTML.
* The audit event carries counts only (``conversation.search``): never the query, its terms or
  any content. Logs carry no content either.
* Limited per person across tasks (``conversations.searches``, the ``RateLimits`` table) and the
  read cached for a short time per person.
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from mango_api.audit import AuditLog
from mango_api.authz import ConversationResource
from mango_api.conversations import SearchableConversation, SearchCorpus
from mango_api.rate_limits import Limiter, RateLimitUnavailableError
from mango_api.web import ApiError, Caller, rate_limited
from mango_core.agents import AGENT_ID_PATTERN

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")

SEARCHES_PER_MINUTE = 60
"""Per person, shared by every task (``conversations.searches``). The page asks once per pause
in typing (300 ms) and only from two characters: a fast typist stays well below it."""
MAX_CONVERSATIONS = 200
"""Newest conversations a search reads."""
MAX_MESSAGES = 4000
"""Messages a search reads, over all its conversations."""
MAX_BYTES = 4 * 1024 * 1024
"""Characters of text a search keeps (titles, contents, tool names)."""
MAX_LIST_PAGES = 10
"""Pages of 1 MB of ``CONV#`` items: about 50,000 conversations."""
CACHE_SECONDS = 30.0
"""What a person typed in the last 30 seconds is searched over the same read."""
CACHE_ENTRIES = 16
"""People whose read a task keeps at once: at most 16 times ``MAX_BYTES`` of text."""
MAX_QUERY = 200
MAX_TERMS = 8
MIN_TERM = 2
MAX_RESULTS = 100
"""Conversations in an answer, the best first in the order asked."""
MAX_HITS = 20
"""Hits of one conversation in an answer."""
SNIPPET_BEFORE = 60
SNIPPET_AFTER = 140

Kind = Literal["title", "user", "agent", "tool"]
KindFilter = Literal["all", "title", "user", "agent", "tool"]
When = Literal["all", "today", "yesterday"]
Sort = Literal["relevance", "recent"]


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ConversationSearchParams(_Strict):
    q: Annotated[str, Field(min_length=1, max_length=MAX_QUERY)]
    agent: Annotated[str, Field(pattern=AGENT_ID_PATTERN)] | None = None
    kind: KindFilter = "all"
    when: When = "all"
    sort: Sort = "relevance"
    utc_offset_minutes: Annotated[int, Field(ge=-840, le=840)] = 0
    """The person's clock minus UTC, for «Hoy» and «Desde ayer» (Bogotá: -300)."""


class SearchSnippetPart(_Strict):
    text: str
    hit: bool
    """A term of the query: the page marks it (``<mark>``), always as text."""


class ConversationSearchHit(_Strict):
    kind: Kind
    message_id: str | None
    """``None`` for the title."""
    pre: bool
    """Text was cut before the snippet («…»)."""
    post: bool
    parts: list[SearchSnippetPart]


class ConversationSearchResult(_Strict):
    conversation_id: str
    title: str
    agent_id: str
    updated_at: str
    hits: list[ConversationSearchHit]


class ConversationSearchOut(_Strict):
    results: list[ConversationSearchResult]
    conversations_read: int
    """Conversations the search read, the newest first."""
    capped: bool
    """A cap stopped the read: older conversations were not searched."""
    truncated: bool
    """More conversations matched than ``MAX_RESULTS``: only the best are here."""


# --- Use cases --------------------------------------------------------------------------

_MARKDOWN_RULE = re.compile(r"\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?")
_MARKDOWN_MARKS = re.compile(r"[*`|#_>]")
_SPACES = re.compile(r"\s+")


def plain(text: str) -> str:
    """As the design's ``srPlain``: no table rules or Markdown marks, one space between words."""
    text = _MARKDOWN_RULE.sub(" ", text)
    text = _MARKDOWN_MARKS.sub(" ", text)
    return _SPACES.sub(" ", text).strip()


def _lower(text: str) -> str:
    """Lowercase keeping every index: a character whose lowercase is longer stays as it is."""
    low = text.lower()
    if len(low) == len(text):
        return low
    return "".join(c.lower() if len(c.lower()) == 1 else c for c in text)


def terms_of(query: str) -> list[str]:
    """Distinct words of two characters or more, at most ``MAX_TERMS``."""
    seen: list[str] = []
    for word in _lower(query).split():
        if len(word) >= MIN_TERM and word not in seen:
            seen.append(word)
    return seen[:MAX_TERMS]


def snippet(text: str, low: str, terms: list[str]) -> tuple[bool, bool, list[SearchSnippetPart]]:
    """As the design's ``srSnippet``: from 60 characters before the first term to 140 after,
    every term marked."""
    first = min(i for i in (low.find(t) for t in terms) if i >= 0)
    start = max(0, first - SNIPPET_BEFORE)
    end = min(len(text), first + SNIPPET_AFTER)
    window, window_low = text[start:end], low[start:end]
    parts: list[SearchSnippetPart] = []
    at = 0
    while at < len(window):
        found = [(window_low.find(t, at), t) for t in terms]
        hits = [(i, t) for i, t in found if i >= 0]
        if not hits:
            break
        i, term = min(hits, key=lambda h: (h[0], -len(h[1])))
        if i > at:
            parts.append(SearchSnippetPart(text=window[at:i], hit=False))
        parts.append(SearchSnippetPart(text=window[i : i + len(term)], hit=True))
        at = i + len(term)
    if at < len(window):
        parts.append(SearchSnippetPart(text=window[at:], hit=False))
    return start > 0, end < len(text), parts


def _hit(
    kind: Kind, message_id: str | None, raw: str, terms: list[str]
) -> ConversationSearchHit | None:
    # A word found in the plain text is in the stored text too (plain only takes characters
    # out and a term has no spaces): most texts are discarded without making them plain.
    raw_low = _lower(raw)
    if not all(t in raw_low for t in terms):
        return None
    # Tool names are not Markdown: «get_cost_and_usage» keeps its underscores.
    text = _SPACES.sub(" ", raw).strip() if kind == "tool" else plain(raw)
    low = _lower(text)
    if not all(t in low for t in terms):
        return None
    pre, post, parts = snippet(text, low, terms)
    return ConversationSearchHit(kind=kind, message_id=message_id, pre=pre, post=post, parts=parts)


def _since(when: When, offset_minutes: int, now: datetime) -> datetime | None:
    """Start of the person's today (or yesterday), in UTC."""
    if when == "all":
        return None
    offset = timedelta(minutes=offset_minutes)
    local = (now + offset).replace(hour=0, minute=0, second=0, microsecond=0)
    if when == "yesterday":
        local -= timedelta(days=1)
    return local - offset


def _updated(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


@dataclass(frozen=True)
class Found:
    conversation: SearchableConversation
    agent_id: str
    hits: list[ConversationSearchHit]
    score: int
    order: int
    """Position among the conversations read: 0 is the newest."""


def _matches(
    conversation: SearchableConversation, terms: list[str], kind: KindFilter
) -> list[ConversationSearchHit]:
    hits: list[ConversationSearchHit] = []

    def test(k: Kind, message_id: str | None, text: str) -> None:
        if kind not in ("all", k) or not text:
            return
        hit = _hit(k, message_id, text, terms)
        if hit is not None:
            hits.append(hit)

    test("title", None, conversation.title)
    for m in conversation.messages:
        if m.role == "user":
            test("user", m.message_id, m.content)
        elif m.role == "assistant":
            test("agent", m.message_id, m.content)
            test("tool", m.message_id, " ".join(m.tools))
    return hits


@dataclass(frozen=True)
class Outcome:
    out: ConversationSearchOut
    hits: int
    terms: int


def search(
    corpus: SearchCorpus,
    params: ConversationSearchParams,
    *,
    default_agent: str,
    now: datetime,
) -> Outcome:
    terms = terms_of(params.q)
    since = _since(params.when, params.utc_offset_minutes, now)
    found: list[Found] = []
    for order, conversation in enumerate(corpus.conversations):
        # Conversations stored before agents were data belong to the release agent.
        agent_id = conversation.agent_id or default_agent
        if params.agent is not None and agent_id != params.agent:
            continue
        if since is not None:
            updated = _updated(conversation.updated_at)
            if updated is None or updated < since:
                continue
        hits = _matches(conversation, terms, params.kind) if terms else []
        if not hits:
            continue
        # As the design: more hits rank higher, a hit in the title most of all.
        score = len(hits) + (5 if hits[0].kind == "title" else 0)
        found.append(Found(conversation, agent_id, hits, score, order))
    if params.sort == "relevance":
        found.sort(key=lambda f: (-f.score, f.order))
    shown = found[:MAX_RESULTS]
    return Outcome(
        out=ConversationSearchOut(
            results=[
                ConversationSearchResult(
                    conversation_id=f.conversation.conversation_id,
                    title=f.conversation.title,
                    agent_id=f.agent_id,
                    updated_at=f.conversation.updated_at,
                    hits=f.hits[:MAX_HITS],
                )
                for f in shown
            ],
            conversations_read=len(corpus.conversations),
            capped=corpus.capped,
            truncated=len(found) > MAX_RESULTS,
        ),
        hits=sum(min(len(f.hits), MAX_HITS) for f in shown),
        terms=len(terms),
    )


@dataclass
class SearchDeps:
    read: Callable[[str], SearchCorpus]
    """The caller's corpus, read with their row-level security client within the caps."""
    owned: Callable[[Caller, list[ConversationResource]], frozenset[str]]
    """The results the caller owns: Cedar ``OwnConversation`` on them in one batch, with the
    owner of the partition they were read from, audited once (TM-TW3)."""
    audit: AuditLog
    limiter: Limiter
    default_agent: str
    clock: Callable[[], datetime] = lambda: datetime.now(UTC)
    monotonic: Callable[[], float] = time.monotonic
    _cache: "OrderedDict[str, tuple[float, SearchCorpus]]" = field(default_factory=OrderedDict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def corpus(self, user_id: str) -> tuple[SearchCorpus, bool]:
        """The person's read and whether it came from the cache. Only ever stored under, and
        returned for, the person it was read for."""
        now = self.monotonic()
        with self._lock:
            entry = self._cache.get(user_id)
            if entry is not None and now - entry[0] < CACHE_SECONDS:
                return entry[1], True
        corpus = self.read(user_id)
        with self._lock:
            self._cache.pop(user_id, None)
            self._cache[user_id] = (now, corpus)
            while len(self._cache) > CACHE_ENTRIES:
                self._cache.popitem(last=False)
        return corpus, False


def run(
    deps: SearchDeps, caller: Caller, params: ConversationSearchParams
) -> ConversationSearchOut:
    user = caller.user
    corpus, cached = deps.corpus(user.user_id)
    outcome = search(corpus, params, default_agent=deps.default_agent, now=deps.clock())
    found = outcome.out.results
    # The row-level security already read only the caller's partition; Cedar decides as well,
    # and a result it does not allow is left out as if it did not exist (fail closed).
    owned = (
        deps.owned(caller, [ConversationResource(r.conversation_id, corpus.owner) for r in found])
        if found
        else frozenset()
    )
    results = [r for r in found if r.conversation_id in owned]
    out = outcome.out.model_copy(update={"results": results})
    # Counts only: never the query, its terms or any content (D103 (5)).
    deps.audit.emit(
        "conversation.search",
        user.user_id,
        {
            "query_length": len(params.q),
            "terms": outcome.terms,
            "hits": sum(len(r.hits) for r in results),
            "conversations_found": len(results),
            "conversations_read": out.conversations_read,
            "capped": out.capped,
            "cached": cached,
            "filtered": params.agent is not None or params.kind != "all" or params.when != "all",
        },
        user,
    )
    return out


def _unavailable(exc: Exception) -> ApiError:
    # The type only: never the query or content.
    logger.error("conversation search unavailable: %s", type(exc).__name__)
    return ApiError(503, "search_unavailable", "please try again")


def limited_run(
    deps: SearchDeps, caller: Caller, params: ConversationSearchParams
) -> ConversationSearchOut:
    user_id = caller.user.user_id
    try:
        allowed = deps.limiter.allow(user_id)
    except RateLimitUnavailableError as exc:
        raise ApiError(503, "rate_limit_unavailable", "please try again") from exc
    if not allowed:
        raise rate_limited(deps.limiter.retry_after(user_id))
    try:
        return run(deps, caller, params)
    except (ClientError, BotoCoreError) as exc:
        raise _unavailable(exc) from exc


# --- Routes -----------------------------------------------------------------------------

Authorize = Callable[[Caller, str, str, str], Awaitable[None]]


def conversation_search_router(
    deps: SearchDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    router = APIRouter(prefix="/api/search")

    async def searcher(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        await authorize(caller, "SearchConversations", *PLATFORM)
        return caller

    # POST with a JSON body, not GET: the ALB's access logs keep the whole request line, query
    # string included, and the terms of a search must never reach a log (D103 (5)).
    @router.post("/conversations", response_model=ConversationSearchOut)
    async def search_conversations(
        caller: Annotated[Caller, Depends(searcher)],
        params: ConversationSearchParams,
    ) -> ConversationSearchOut:
        return await asyncio.to_thread(limited_run, deps, caller, params)

    return router
