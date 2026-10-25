"""Rate limits every mango-api task shares: one sliding window per key, kept in DynamoDB (D70).

Here so that a function of the release can keep a limit in the same table too: the
``knowledge-retrieve`` tool limits the searches of each person (D88 (14)). ``mango_api``
re-exports it with its own logger, which the alarm of D71 reads.

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
import threading
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
STORE_UNAVAILABLE_LOG = "rate limit store unavailable;"
"""How the log line of a call refused because the table could not say starts. A metric filter
counts these lines for the alarm ``Api-rate-limit-store-unavailable`` (D71): it reads the level,
the name of this logger and these words, in the places the log format of ``app.main`` gives them."""
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
        log: logging.Logger = logger,
    ) -> None:
        if not _NAME_RE.fullmatch(name):
            raise ValueError("invalid limit name")
        self._store = store
        self._name = name
        self._limit = limit
        self._kept_ms = round((window_seconds + SKEW_SECONDS) * 1000)
        self._clock = clock
        self._pause = pause
        self._log = log

    def _partition(self, key: str) -> str:
        # Keys are verified identifiers; anything else never reaches the table.
        if not _KEY_RE.fullmatch(key):
            raise RateLimitUnavailableError
        return f"LIMIT#{self._name}#{key}"

    def _live(self, hits: Hits, now_ms: int) -> Hits:
        return [(at, count) for at, count in hits if now_ms - at < self._kept_ms]

    def _refused(self) -> None:
        # The name of the limit and nothing of the caller: the alarm counts these lines.
        self._log.error("%s a call of %s is refused", STORE_UNAVAILABLE_LOG, self._name)

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


# --- Leases: how many at a time ------------------------------------------------------------


class Leases(Protocol):
    def acquire(self, key: str) -> int | None:
        """A lease for ``key``, or ``None`` when ``key`` already holds the most it may (or the
        store cannot say: fail closed)."""
        ...

    def release(self, key: str, lease: int) -> None:
        """End ``lease``; never raises (it ends on its own at its deadline)."""
        ...


_MAX_LEASE_ID = 999_999


class SharedLeases:
    """At most ``limit`` leases per key at once, counted by every mango-api task (D70).

    Same item and store as a shared limit (``LIMIT#<name>#<key>``): each entry is a lease, as
    ``(deadline in milliseconds, lease id)``. A lease ends when it is released or at its
    deadline, so a task that died never holds one for longer than ``ttl_seconds``.
    """

    def __init__(
        self,
        store: RateLimitStore,
        name: str,
        limit: int,
        ttl_seconds: float,
        *,
        clock: Callable[[], float] = time.time,
        pause: Callable[[float], None] = time.sleep,
        log: logging.Logger = logger,
    ) -> None:
        if not _NAME_RE.fullmatch(name):
            raise ValueError("invalid limit name")
        self._store = store
        self._name = name
        self._limit = limit
        self._ttl_ms = round((ttl_seconds + SKEW_SECONDS) * 1000)
        self._clock = clock
        self._pause = pause
        self._log = log

    def _partition(self, key: str) -> str:
        if not _KEY_RE.fullmatch(key):
            raise RateLimitUnavailableError
        return f"LIMIT#{self._name}#{key}"

    def _refused(self) -> None:
        self._log.error("%s a call of %s is refused", STORE_UNAVAILABLE_LOG, self._name)

    def _update(self, key: str, change: Callable[[Hits, int], Hits | None]) -> Hits | None:
        """Apply ``change`` to the live leases of ``key`` with a conditional write; ``None``
        when ``change`` refused, ``RateLimitUnavailableError`` when the store cannot say."""
        partition = self._partition(key)
        for attempt in range(ATTEMPTS):
            if attempt:
                self._pause(random.uniform(0.005, 0.02) * attempt)  # noqa: S311 - jitter
            stored, version = self._store.read(partition)
            now_ms = round(self._clock() * 1000)
            live = [(deadline, lease) for deadline, lease in stored if deadline > now_ms]
            changed = change(live, now_ms)
            if changed is None:
                return None
            latest = max((deadline for deadline, _ in changed), default=now_ms)
            expires_at = math.ceil(latest / 1000) + TTL_MARGIN_SECONDS
            if self._store.write(partition, changed, version, expires_at):
                return changed
        raise RateLimitUnavailableError

    def acquire(self, key: str) -> int | None:
        lease = random.randint(1, _MAX_LEASE_ID)  # noqa: S311 - an id, not a secret

        def take(live: Hits, now_ms: int) -> Hits | None:
            if len(live) >= self._limit:
                return None
            return [*live, (now_ms + self._ttl_ms, lease)]

        try:
            return lease if self._update(key, take) is not None else None
        except RateLimitUnavailableError:
            self._refused()
            return None

    def release(self, key: str, lease: int) -> None:
        try:
            self._update(key, lambda live, _now: [e for e in live if e[1] != lease])
        except RateLimitUnavailableError:
            # It ends at its deadline anyway.
            self._refused()


class MemoryLeases:
    """``SharedLeases`` in the memory of one process (tests, and limits counted per task)."""

    def __init__(
        self, limit: int, ttl_seconds: float, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._limit = limit
        self._ttl = ttl_seconds
        self._clock = clock
        self._held: dict[str, dict[int, float]] = {}
        self._lock = threading.Lock()
        self._next = 0

    def acquire(self, key: str) -> int | None:
        with self._lock:
            now = self._clock()
            held = {k: v for k, v in self._held.get(key, {}).items() if v > now}
            if len(held) >= self._limit:
                self._held[key] = held
                return None
            self._next += 1
            held[self._next] = now + self._ttl
            self._held[key] = held
            return self._next

    def release(self, key: str, lease: int) -> None:
        with self._lock:
            self._held.get(key, {}).pop(lease, None)
