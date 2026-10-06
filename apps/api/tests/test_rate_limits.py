"""Rate limits shared by every mango-api task (D70), against moto DynamoDB.

Two limiters built on the same table stand for two tasks. The clock is injected: no test
waits for time to pass.
"""

from __future__ import annotations

import logging
import random
import threading
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from moto import mock_aws

from mango_api.probe import RateLimiter
from mango_api.rate_limits import (
    ATTEMPTS,
    SK_HITS,
    SKEW_SECONDS,
    TTL_MARGIN_SECONDS,
    UNAVAILABLE_RETRY_SECONDS,
    RateLimitStore,
    SharedRateLimiter,
)

from .test_admin import _table

TABLE = "rate-limits"
T0 = 1_790_000_000.0
"""A wall-clock time; tests move it by hand."""


class Recording:
    """A DynamoDB client that notes the operations it is asked for, one call at a time (as
    the real table applies each call atomically; moto has no lock of its own)."""

    def __init__(self, client: Any) -> None:
        self._client = client
        self._lock = threading.Lock()
        self.calls: list[str] = []
        self.fail: Exception | None = None
        self.before_write: Any = None

    def get_item(self, **kwargs: Any) -> Any:
        with self._lock:
            self.calls.append("GetItem")
            if self.fail:
                raise self.fail
            return self._client.get_item(**kwargs)

    def put_item(self, **kwargs: Any) -> Any:
        hook, self.before_write = self.before_write, None
        if hook:
            hook()
        with self._lock:
            self.calls.append("PutItem")
            if self.fail:
                raise self.fail
            return self._client.put_item(**kwargs)


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> Iterator[Recording]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        _table(client, TABLE)
        yield Recording(client)


def _task(
    db: Recording, clock: list[float], limit: int = 3, window: float = 60, name: str = "test.limit"
) -> SharedRateLimiter:
    """The limiter of one task; build two on the same table for two tasks."""
    return SharedRateLimiter(
        RateLimitStore(db, TABLE),  # type: ignore[arg-type]
        name,
        limit,
        window,
        clock=lambda: clock[0],
        pause=lambda _seconds: None,
    )


def _item(db: Recording, key: str, name: str = "test.limit") -> dict[str, Any]:
    found = db.get_item(
        TableName=TABLE, Key={"PK": {"S": f"LIMIT#{name}#{key}"}, "SK": {"S": SK_HITS}}
    )
    return dict(found["Item"])


# --- The limit ---------------------------------------------------------------------------


def test_allows_the_limit_and_refuses_the_next(db: Recording) -> None:
    clock = [T0]
    limiter = _task(db, clock)
    assert [limiter.allow("user-1") for _ in range(4)] == [True, True, True, False]
    assert limiter.retry_after("user-1") == 60 + SKEW_SECONDS


def test_two_tasks_share_the_count(db: Recording) -> None:
    clock = [T0]
    one, two = _task(db, clock), _task(db, clock)
    assert one.allow("user-1")
    assert two.allow("user-1")
    assert one.allow("user-1")
    # The limit is reached at 3 between both, not at 3 each.
    assert not two.allow("user-1")
    assert not one.allow("user-1")
    assert two.retry_after("user-1") == one.retry_after("user-1") > 0


def test_a_new_task_starts_with_the_count_of_the_others(db: Recording) -> None:
    clock = [T0]
    old = _task(db, clock)
    assert all(old.allow("user-1") for _ in range(3))
    # A restart or a deployment: the new task has no memory of its own.
    assert not _task(db, clock).allow("user-1")


def test_each_key_and_each_limit_has_its_own_count(db: Recording) -> None:
    clock = [T0]
    limiter, other = _task(db, clock), _task(db, clock, name="test.other")
    assert all(limiter.allow("user-1") for _ in range(3))
    assert not limiter.allow("user-1")
    # Nobody spends the limit of someone else, nor another limit of their own.
    assert limiter.allow("user-2")
    assert other.allow("user-1")


def test_cost_is_all_or_nothing(db: Recording) -> None:
    clock = [T0]
    limiter = _task(db, clock, limit=5)
    assert limiter.allow("user-1", 3)
    assert not limiter.allow("user-1", 3)
    assert limiter.retry_after("user-1", 3) == 60 + SKEW_SECONDS
    # The refused call spent nothing.
    assert limiter.allow("user-1", 2)
    assert not limiter.allow("user-1")
    assert not limiter.allow("user-9", 6)
    assert limiter.retry_after("user-9", 6) > 0


# --- The window --------------------------------------------------------------------------


def test_a_hit_leaves_after_the_window_and_the_skew_margin(db: Recording) -> None:
    clock = [T0]
    one, two = _task(db, clock), _task(db, clock)
    assert all(one.allow("user-1") for _ in range(3))
    clock[0] = T0 + 60
    # At exactly the window a task whose clock runs ahead could free the hit early: not yet.
    assert not two.allow("user-1")
    assert two.retry_after("user-1") == SKEW_SECONDS
    clock[0] = T0 + 60 + SKEW_SECONDS
    assert two.allow("user-1")


def test_no_burst_at_the_edge_of_a_window(db: Recording) -> None:
    """A fixed window would allow the limit just before a minute ends and again just after:
    twice the limit in two seconds. Here the hits of the last window always count."""
    clock = [T0 + 59]
    one, two = _task(db, clock, limit=30), _task(db, clock, limit=30)
    assert all(one.allow("user-1") for _ in range(30))
    clock[0] = T0 + 61
    assert not two.allow("user-1")
    assert two.retry_after("user-1") == 59
    clock[0] = T0 + 59 + 60 + SKEW_SECONDS
    assert two.allow("user-1")


def test_never_more_than_the_limit_in_any_window(db: Recording) -> None:
    """Whatever the task and the moment, no window holds more hits than the limit."""
    rng = random.Random(70)  # noqa: S311 - a reproducible schedule, not a secret
    clock = [T0]
    limit, window = 5, 10.0
    tasks = [_task(db, clock, limit=limit, window=window) for _ in range(3)]
    allowed: list[float] = []
    for _ in range(400):
        clock[0] += rng.choice([0.0, 0.1, 0.5, 1.0, 3.0])
        if rng.choice(tasks).allow("user-1"):
            allowed.append(clock[0])
    assert len(allowed) > limit * 5
    for start in allowed:
        assert sum(1 for at in allowed if start <= at < start + window) <= limit


def test_the_item_expires_with_the_table_ttl(db: Recording) -> None:
    clock = [T0]
    limiter = _task(db, clock)
    assert limiter.allow("user-1")
    item = _item(db, "user-1")
    assert int(item["ttl"]["N"]) == T0 + 60 + SKEW_SECONDS + TTL_MARGIN_SECONDS
    clock[0] = T0 + 30
    assert limiter.allow("user-1")
    # Old hits are dropped from the item as the window moves: it never grows past the limit.
    clock[0] = T0 + 62
    assert limiter.allow("user-1")
    item = _item(db, "user-1")
    assert item["hits"]["S"].count(":") == 2
    assert int(item["ttl"]["N"]) == T0 + 62 + 60 + SKEW_SECONDS + TTL_MARGIN_SECONDS


# --- Concurrency -------------------------------------------------------------------------


def test_a_write_that_lost_the_race_is_read_again(db: Recording) -> None:
    clock = [T0]
    one, two = _task(db, clock, limit=2), _task(db, clock, limit=2)
    assert one.allow("user-1")
    # Both tasks read one hit; the other one writes first.
    db.before_write = lambda: two.allow("user-1")
    # Writing what was read would make two hits of three: the limit would be passed.
    assert not one.allow("user-1")
    assert _item(db, "user-1")["hits"]["S"].count(":") == 2


def test_concurrent_calls_of_two_tasks_never_pass_the_limit(db: Recording) -> None:
    clock = [T0]
    limit = 10
    tasks = [
        SharedRateLimiter(
            RateLimitStore(db, TABLE),  # type: ignore[arg-type]
            "test.limit",
            limit,
            60,
            clock=lambda: clock[0],
        )
        for _ in range(2)
    ]
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda n: tasks[n % 2].allow("user-1"), range(40)))
    assert 0 < sum(results) <= limit
    hits = _item(db, "user-1")["hits"]["S"].split(",")
    assert len(hits) == sum(results)
    # Whoever was left out by contention alone finds room afterwards; then it is full.
    while sum(results) < limit:
        results.append(tasks[0].allow("user-1"))
        assert results[-1]
    assert not tasks[1].allow("user-1")


def test_contention_that_never_ends_refuses(
    db: Recording, caplog: pytest.LogCaptureFixture
) -> None:
    clock = [T0]
    limiter = _task(db, clock, limit=100)
    rival = _task(db, clock, limit=100)

    def always_first() -> None:
        rival.allow("user-1")
        db.before_write = always_first

    db.before_write = always_first
    with caplog.at_level(logging.ERROR):
        assert not limiter.allow("user-1")
    assert db.calls.count("GetItem") >= ATTEMPTS
    assert "test.limit" in caplog.text


# --- Fail closed -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "error",
    [
        ClientError({"Error": {"Code": "ProvisionedThroughputExceededException"}}, "GetItem"),
        ClientError({"Error": {"Code": "AccessDeniedException"}}, "GetItem"),
        EndpointConnectionError(endpoint_url="https://dynamodb.example"),
    ],
)
def test_refuses_when_the_table_does_not_answer(
    db: Recording, caplog: pytest.LogCaptureFixture, error: Exception
) -> None:
    clock = [T0]
    limiter = _task(db, clock)
    db.fail = error
    with caplog.at_level(logging.ERROR):
        assert not limiter.allow("user-1")
    assert limiter.retry_after("user-1") == UNAVAILABLE_RETRY_SECONDS
    # The log names the limit, never who was refused.
    assert "test.limit" in caplog.text
    assert "user-1" not in caplog.text
    db.fail = None
    assert limiter.allow("user-1")


def test_refuses_when_the_write_fails(db: Recording) -> None:
    clock = [T0]
    limiter = _task(db, clock)

    def break_table() -> None:
        db.fail = ClientError({"Error": {"Code": "InternalServerError"}}, "PutItem")

    db.before_write = break_table
    assert not limiter.allow("user-1")


@pytest.mark.parametrize(
    "item",
    [
        {"hits": {"S": "not-a-list"}, "v": {"N": "1"}},
        {"hits": {"S": "1:1"}},
        {"hits": {"N": "3"}, "v": {"N": "1"}},
        {"hits": {"S": "1:1,"}, "v": {"N": "1"}},
    ],
)
def test_refuses_a_state_it_did_not_write(db: Recording, item: dict[str, Any]) -> None:
    clock = [T0]
    limiter = _task(db, clock)
    db._client.put_item(
        TableName=TABLE,
        Item={"PK": {"S": "LIMIT#test.limit#user-1"}, "SK": {"S": SK_HITS}, **item},
    )
    assert not limiter.allow("user-1")
    assert limiter.retry_after("user-1") == UNAVAILABLE_RETRY_SECONDS


@pytest.mark.parametrize("key", ["", "a b", "user#1", "x" * 129, "user/1"])
def test_refuses_a_key_that_is_not_an_identifier(db: Recording, key: str) -> None:
    limiter = _task(db, [T0])
    assert not limiter.allow(key)
    assert db.calls == []


# --- What it asks of the table -----------------------------------------------------------


def test_reads_and_writes_by_key_only(db: Recording) -> None:
    clock = [T0]
    limiter = _task(db, clock, limit=2)
    assert limiter.allow("user-1")
    assert db.calls == ["GetItem", "PutItem"]
    assert limiter.allow("user-1")
    assert not limiter.allow("user-1")
    limiter.retry_after("user-1")
    # A refusal writes nothing. No Query, no Scan: the task role has neither.
    assert db.calls == ["GetItem", "PutItem"] * 2 + ["GetItem", "GetItem"]


def test_rejects_a_limit_without_a_table_or_a_name() -> None:
    with pytest.raises(ValueError, match="table"):
        RateLimitStore(None, "")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="name"):
        SharedRateLimiter(RateLimitStore(None, TABLE), "Not a name", 1, 60)  # type: ignore[arg-type]


def test_same_answers_as_the_limiter_in_memory(db: Recording) -> None:
    """One task alone behaves as before, except for the skew margin on when a hit leaves."""
    rng = random.Random(7)  # noqa: S311 - a reproducible schedule, not a secret
    clock = [T0]
    shared = _task(db, clock, limit=4, window=10 - SKEW_SECONDS)
    local = RateLimiter(4, 10, clock=lambda: clock[0])
    for _ in range(200):
        clock[0] += rng.choice([0.0, 0.25, 1.0, 2.0, 6.0])
        cost = rng.choice([1, 1, 2])
        assert shared.allow("user-1", cost) == local.allow("user-1", cost)
        assert shared.retry_after("user-1", cost) == local.retry_after("user-1", cost)
