"""Curated views of RDS and Performance Insights answers: allow-listed fields, hard limits.

Nothing here returns an AWS answer as it came. Every view copies the fields it names and
nothing else, so a field AWS adds later (or one that holds credentials, such as
``MasterUserSecret``) never reaches the model. Text is cut to a size, lists to a length and
every answer to a byte budget.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable, Mapping
from datetime import UTC, datetime
from typing import Any

MAX_RESPONSE_BYTES = 256 * 1024
"""Budget of one tool answer, serialized as JSON."""

MAX_TEXT = 1000
"""Default cut of a free text AWS returns (event messages, descriptions)."""

MAX_TAGS = 20
MAX_TAG_VALUE = 256
MAX_LIST = 50
"""Cut of a list inside one item (read replicas, cluster members, endpoints)."""

HIDDEN = "<hidden>"

# Tag keys and parameter names that look like they hold a credential. Their values are never
# returned: a tag is free text anybody with access to the account can write.
_SECRET_NAME = re.compile(
    r"pass(word|wd|phrase)?|pwd|secret|token|credential|private|api[-_]?key|access[-_]?key"
    r"|cookie|connection[-_]?string|dsn",
    re.IGNORECASE,
)
# A long run of base64 or hex with no spaces looks like a key, whatever the tag is called.
_SECRET_VALUE = re.compile(r"^[A-Za-z0-9+/=_\-]{32,}$")


def truncate(text: Any, limit: int = MAX_TEXT) -> str | None:
    """``text`` cut to ``limit`` characters, marked when cut."""
    if text is None:
        return None
    value = str(text)
    if len(value) <= limit:
        return value
    return value[:limit] + f"… [cut, {len(value) - limit} more characters]"


def truncate_bytes(text: str, limit: int) -> tuple[str, bool]:
    """``text`` cut to ``limit`` bytes of UTF-8, never in the middle of a character."""
    data = text.encode("utf-8")
    if len(data) <= limit:
        return text, False
    return data[:limit].decode("utf-8", errors="ignore"), True


def iso(value: Any) -> str | None:
    """A timestamp of botocore (``datetime``) or of RDS (milliseconds) as ISO 8601."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, int | float):
        return datetime.fromtimestamp(value / 1000, tz=UTC).isoformat()
    return str(value)


def pick(source: Mapping[str, Any], fields: Mapping[str, str]) -> dict[str, Any]:
    """Copy ``fields`` (AWS name -> listed name) of ``source`` that are present; dates as ISO."""
    view: dict[str, Any] = {}
    for aws_name, name in fields.items():
        if aws_name not in source or source[aws_name] is None:
            continue
        value = source[aws_name]
        if isinstance(value, datetime):
            value = value.isoformat()
        elif isinstance(value, str):
            value = truncate(value, MAX_TAG_VALUE)
        elif isinstance(value, list | dict):
            # Only scalars are copied by name: a nested value needs its own view.
            continue
        view[name] = value
    return view


def strings(values: Iterable[Any], limit: int = MAX_LIST) -> list[str]:
    """At most ``limit`` short strings."""
    return [truncate(value, MAX_TAG_VALUE) or "" for value in list(values)[:limit]]


def safe_tags(tags: Iterable[Mapping[str, Any]] | None) -> dict[str, str]:
    """Tags as ``{key: value}``, without the ones that look like they hold a credential."""
    kept: dict[str, str] = {}
    for tag in tags or []:
        key = str(tag.get("Key", ""))
        value = str(tag.get("Value", ""))
        if not key or _SECRET_NAME.search(key) or _SECRET_VALUE.match(value):
            continue
        kept[key[:128]] = truncate(value, MAX_TAG_VALUE) or ""
        if len(kept) == MAX_TAGS:
            break
    return kept


def secret_named(name: str) -> bool:
    """Whether a parameter name looks like it holds a credential."""
    return bool(_SECRET_NAME.search(name))


def size(value: Any) -> int:
    return len(json.dumps(value, default=str, ensure_ascii=False).encode("utf-8"))


def fit(answer: dict[str, Any], key: str, limit: int = MAX_RESPONSE_BYTES) -> dict[str, Any]:
    """``answer`` with items of its list ``key`` dropped from the end until it fits ``limit``.

    Dropping items marks the answer ``truncated``; the model is told to narrow the request.
    """
    items = answer[key]
    if size(answer) <= limit:
        return answer
    kept = list(items)
    while kept and size({**answer, key: kept}) > limit:
        kept.pop()
    return {**answer, key: kept, "truncated": True}


def collect(
    call: Callable[..., Mapping[str, Any]],
    key: str,
    *,
    limit: int,
    max_pages: int,
    page_size: int = 100,
    **arguments: Any,
) -> tuple[list[Mapping[str, Any]], bool]:
    """Items of a ``Marker``-paged RDS ``Describe*`` call: at most ``limit`` items read over at
    most ``max_pages`` pages. The flag says whether AWS had more."""
    items: list[Mapping[str, Any]] = []
    marker: str | None = None
    for _ in range(max_pages):
        page = call(**arguments, MaxRecords=page_size, **({"Marker": marker} if marker else {}))
        items.extend(page.get(key) or [])
        marker = page.get("Marker")
        if not marker or len(items) >= limit:
            break
    more = bool(marker) or len(items) > limit
    return items[:limit], more
