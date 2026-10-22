"""Knowledge bases (D88): what mango-api, the synchronization and the retrieve tool share.

A knowledge base of Mango creates no AWS resource: it is a record of the ``Knowledge`` table
and a prefix ``kb/<kb_id>/`` of the documents bucket, over the one Bedrock knowledge base of
the installation (D88 (7)). Its ids are ULIDs (D88 (8)): random, never incremental, and
sortable by creation time.
"""

from __future__ import annotations

import re
import secrets
import time
from collections.abc import Iterable
from enum import StrEnum

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
ID_PATTERN = r"^[0-9A-HJKMNP-TV-Z]{26}$"
_ID_RE = re.compile(ID_PATTERN)

BUSINESS_UNIT_ALL = "all"
"""The area of a knowledge base for every area of the installation (D88 (11))."""
CLASSIFICATIONS = ("public", "internal", "confidential", "restricted")
"""Stored on each fragment for a future ACL per document; never used to authorize (D88 (22))."""
SYNC_SCHEDULES = ("manual", "6h", "daily", "weekly")
"""How often a bucket source is synchronized (D88 (11)); uploads are indexed when saved."""
MAX_GROUPS = 20
"""Groups a knowledge base answers to."""


class Status(StrEnum):
    """Of a knowledge base (D88 (8))."""

    PENDING = "pending"
    """Never synchronized."""
    SYNCING = "syncing"
    OK = "ok"
    WARN = "warn"
    """Some document was not indexed."""
    ERROR = "error"
    DELETING = "deleting"
    """Its documents and vectors are being deleted; it stays listed until that is verified."""


class DocumentStatus(StrEnum):
    """Of a document (D88 (8))."""

    UPLOADED = "uploaded"
    """Saved in the knowledge base, not indexed yet."""
    INDEXING = "indexing"
    INDEXED = "indexed"
    FAILED = "failed"
    """Not indexed, with its ``reason``."""
    DELETING = "deleting"


def new_id(now_ms: int | None = None) -> str:
    """A ULID: 48 bits of milliseconds and 80 random bits, in Crockford's base 32."""
    millis = int(time.time() * 1000) if now_ms is None else now_ms
    if not 0 <= millis < 1 << 48:
        raise ValueError("time out of range")
    value = (millis << 80) | secrets.randbits(80)
    return "".join(_CROCKFORD[(value >> shift) & 31] for shift in range(125, -1, -5))


def is_id(value: str) -> bool:
    return bool(_ID_RE.fullmatch(value))


def usable(kb_groups: Iterable[str], user_groups: Iterable[str]) -> bool:
    """Whether a person in ``user_groups`` gets answers from a knowledge base of ``kb_groups``.

    The rule of ``UseKnowledgeBase`` (``policies/cedar/platform/knowledge-use.cedar``): being in
    one of its groups, with the groups of the registry read when asked (D88 (22)). Neither its
    owner nor an administrator uses it for being one (rule 5). For the retrieve tool, which has
    no Verified Permissions of its own; a test of mango-api checks it against the policy.
    """
    return not set(kb_groups).isdisjoint(user_groups)


class SourceStatus(StrEnum):
    """Of a source on an existing bucket (D88 (10), (20))."""

    PENDING = "pending"
    """Proposed; waits for an administrator other than whoever proposed it."""
    APPROVED = "approved"
    """For exactly its bucket and prefix: changing them is a new proposal."""
    REJECTED = "rejected"
    WITHDRAWN = "withdrawn"
    """Taken back before anybody decided."""
    REMOVING = "removing"
    """Removed after its approval: its role and its documents are being deleted."""


ACTIVE_SOURCE_STATUSES = frozenset(
    {SourceStatus.PENDING, SourceStatus.APPROVED, SourceStatus.REMOVING}
)
MAX_SOURCES = 5
"""Sources of one knowledge base that are pending, approved or being removed."""
