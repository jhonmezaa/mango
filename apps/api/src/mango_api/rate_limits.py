"""Rate limits every mango-api task shares: one sliding window per key, kept in DynamoDB (D70).

``mango-api`` runs on more than one task. A limit kept in the memory of each task
(``probe.RateLimiter``) is multiplied by the number of tasks and starts again when a task
does. The limits that hold an agreed security exception (AGENTS.md: who is in the directory)
or bound abuse or cost are kept here instead, so the documented number is the real one.

Design:

* **Same window as in memory.** A key may record at most ``limit`` hits in any
  ``window_seconds``: the hits of the window are stored with their times and the old ones are
  dropped on each call. There is no fixed window, so there is no burst at its edge.
* **Atomic.** Read (consistent), then a conditional write on a version: two tasks that read
  the same state cannot both write. The loser reads again.
* **Never looser than documented.** A hit is kept ``SKEW_SECONDS`` longer than the window, so
  two tasks whose clocks differ by less than that cannot free a hit early.
* **Fail closed.** When the table cannot be read or written, or the state is not what this
  code writes, the call is refused (the caller answers 429) and the failure is logged with
  the name of the limit, never with the key.
* **One item per limit and key** (``LIMIT#<name>#<key>``): a caller can only spend their own.
  Keys are identifiers the server verified (the ``sub`` of the token), never request content.
  Items expire with the table TTL shortly after their window; nothing is ever scanned.
"""

from __future__ import annotations

import logging
import math
import random
import re
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Protocol

from botocore.exceptions import BotoCoreError, ClientError

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

logger = logging.getLogger(__name__)

SKEW_SECONDS = 1.0
"""Longer than the clocks of two tasks ever differ (Fargate keeps them within milliseconds)."""
ATTEMPTS = 8
"""Conditional writes tried before giving up (and refusing) when the same key is contended."""
UNAVAILABLE_RETRY_SECONDS = 5
"""``Retry-After`` of a call refused because the table did not answer."""
TTL_MARGIN_SECONDS = 60
SK_HITS = "HITS"
_NAME_RE = re.compile(r"^[a-z][a-z_]*(\.[a-z_]+)+$")
_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_HITS_RE = re.compile(r"^\d{1,16}:\d{1,6}(,\d{1,16}:\d{1,6})*$")

Hits = list[tuple[int, int]]
"""``(time in milliseconds, hits recorded then)``, oldest first."""


class Limiter(Protocol):
    """What a route needs from a limit, shared or not."""

    def allow(self, key: str, cost: int = 1) -> bool: ...

    def retry_after(self, key: str, cost: int = 1) -> int: ...


class RateLimitUnavailableError(Exception):
    """The table could not say whether a call fits; the caller refuses the call."""


class RateLimitStore:
    """The two calls a shared limit makes: ``GetItem`` and a conditional ``PutItem``."""

    def __init__(self, dynamodb: DynamoDBClient, table: str) -> None:
        if not table:
            raise ValueError("the rate limits table is required")
        self._db = dynamodb
        self._table = table

    def read(self, partition: str) -> tuple[Hits, int]:
        """Hits and version of ``partition`` (``([], 0)`` when it has none)."""
        try:
            item = self._db.get_item(
                TableName=self._table,
                Key={"PK": {"S": partition}, "SK": {"S": SK_HITS}},
                ConsistentRead=True,
            ).get("Item")
        except (ClientError, BotoCoreError) as exc:
            raise RateLimitUnavailableError from exc
        if item is None:
            return [], 0
        try:
            encoded, version = item["hits"]["S"], int(item["v"]["N"])
        except (KeyError, TypeError, ValueError) as exc:
            raise RateLimitUnavailableError from exc
        if encoded and not _HITS_RE.fullmatch(encoded):
            raise RateLimitUnavailableError
        hits = [
            (int(at), int(count))
            for at, _, count in (entry.partition(":") for entry in encoded.split(",") if entry)
        ]
        return hits, version

    def write(self, partition: str, hits: Hits, version: int, expires_at: int) -> bool:
        """Replace the hits of ``partition`` if nobody wrote since ``version`` was read."""
        try:
            self._db.put_item(
                TableName=self._table,
                Item={
                    "PK": {"S": partition},
                    "SK": {"S": SK_HITS},
                    "hits": {"S": ",".join(f"{at}:{count}" for at, count in hits)},
                    "v": {"N": str(version + 1)},
                    "ttl": {"N": str(expires_at)},
                },
                ConditionExpression="attribute_not_exists(PK) OR v = :v",
                ExpressionAttributeValues={":v": {"N": str(version)}},
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return False
            raise RateLimitUnavailableError from exc
        except BotoCoreError as exc:
            raise RateLimitUnavailableError from exc
        return True


class SharedRateLimiter:
    """Sliding window per key, shared by every mango-api task (same contract as
    ``probe.RateLimiter``). ``clock`` is wall time in seconds: tasks must agree on it."""

    def __init__(
        self,
        store: RateLimitStore,
        name: str,
        limit: int,
        window_seconds: float,
        *,
        clock: Callable[[], float] = time.time,
        pause: Callable[[float], None] = time.sleep,
    ) -> None:
        if not _NAME_RE.fullmatch(name):
            raise ValueError("invalid limit name")
        self._store = store
        self._name = name
        self._limit = limit
        self._kept_ms = round((window_seconds + SKEW_SECONDS) * 1000)
        self._clock = clock
        self._pause = pause

    def _partition(self, key: str) -> str:
        # Keys are verified identifiers; anything else never reaches the table.
        if not _KEY_RE.fullmatch(key):
            raise RateLimitUnavailableError
        return f"LIMIT#{self._name}#{key}"

    def _live(self, hits: Hits, now_ms: int) -> Hits:
        return [(at, count) for at, count in hits if now_ms - at < self._kept_ms]

    def _refused(self) -> None:
        logger.error("rate limit store unavailable; a call of %s is refused", self._name)

    def allow(self, key: str, cost: int = 1) -> bool:
        """Record ``cost`` hits for ``key`` when all of them fit in the window (all or nothing).
        ``False`` too when the table cannot say (fail closed)."""
        if cost > self._limit:
            return False
        try:
            partition = self._partition(key)
            for attempt in range(ATTEMPTS):
                if attempt:
                    # Another call of the same key wrote first: let it finish, read again.
                    self._pause(random.uniform(0.005, 0.02) * attempt)  # noqa: S311 - jitter
                stored, version = self._store.read(partition)
                now_ms = round(self._clock() * 1000)
                hits = self._live(stored, now_ms)
                if sum(count for _, count in hits) + cost > self._limit:
                    return False
                hits.append((now_ms, cost))
                expires_at = math.ceil((now_ms + self._kept_ms) / 1000) + TTL_MARGIN_SECONDS
                if self._store.write(partition, hits, version, expires_at):
                    return True
        except RateLimitUnavailableError:
            self._refused()
            return False
        self._refused()
        return False

    def retry_after(self, key: str, cost: int = 1) -> int:
        """Whole seconds until ``key`` may record ``cost`` hits (0 when it already may)."""
        try:
            stored, _ = self._store.read(self._partition(key))
        except RateLimitUnavailableError:
            return UNAVAILABLE_RETRY_SECONDS
        now_ms = round(self._clock() * 1000)
        hits = self._live(stored, now_ms)
        excess = sum(count for _, count in hits) + cost - self._limit
        if excess <= 0:
            return 0
        # The call fits once the oldest hits that add up to ``excess`` have left the window.
        for at, count in hits:
            excess -= count
            if excess <= 0:
                return max(0, math.ceil((self._kept_ms - (now_ms - at)) / 1000))
        # ``cost`` is over the limit: it never fits.
        return math.ceil(self._kept_ms / 1000)
