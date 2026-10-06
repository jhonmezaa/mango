"""The lists of agents (marketplace and organization chart): what they cost and who may loop.

Three things keep them cheap and bounded: the versions they show are kept a few seconds in
each task (``ListedVersions``), the agent records of a list are read in one call
(``AgentsStore.metas``), and a person may ask for a list a number of times a minute. None of
them decides access: every request still gets its own ``UseAgent`` decision.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

import pytest
from botocore.exceptions import ClientError

from mango_api.agents_store import (
    BATCH_GET_ATTEMPTS,
    BATCH_GET_KEYS,
    LISTED_CACHE_SECONDS,
    AgentsStore,
    AgentsUnavailableError,
    ListedVersions,
)
from mango_api.limits import LIMITS, Limits
from mango_core.agents import VersionStatus
from mango_core.agents_table import meta_key

from .test_agents_api import (  # noqa: F401
    TOKENS,
    Env,
    _code,
    _h,
    _published,
    _retire,
    admin_in_hr,
    env,
)

LISTS = ("/api/agents", "/api/agents/org")


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _count_calls(db: Any) -> Counter[str]:
    """Operations sent to DynamoDB from now on, by name."""
    calls: Counter[str] = Counter()

    def record(model: Any, **_kwargs: Any) -> None:
        calls[model.name] += 1

    db.meta.events.register("before-call.dynamodb", record)
    return calls


def _cached(env: Env) -> _Clock:  # noqa: F811 - the fixture
    clock = _Clock()
    env.deps.listed = ListedVersions(env.deps.store, clock)
    return clock


def _ids(env: Env, token: str, path: str = "/api/agents") -> set[str]:  # noqa: F811
    response = env.client.get(path, headers=_h(token))
    assert response.status_code == 200, response.text
    body = response.json()
    return {item["id"] for item in body["items" if "items" in body else "nodes"]}


# --- The copy of the versions -------------------------------------------------------------


class _Store:
    """``by_status`` of a store, counted; fails while ``broken``."""

    def __init__(self) -> None:
        self.reads = 0
        self.broken = False
        self.versions: list[Any] = ["v1"]
        self.on_read: Any = None

    def by_status(self, _status: VersionStatus) -> list[Any]:
        self.reads += 1
        if self.on_read is not None:
            self.on_read()
        if self.broken:
            raise ClientError({"Error": {"Code": "InternalServerError"}}, "Query")
        return list(self.versions)


def test_the_copy_is_read_again_only_when_it_expires() -> None:
    store, clock = _Store(), _Clock()
    listed = ListedVersions(store, clock)  # type: ignore[arg-type]
    assert listed.get(VersionStatus.PUBLISHED) == ("v1",)
    store.versions = ["v1", "v2"]
    clock.now += LISTED_CACHE_SECONDS - 0.1
    assert listed.get(VersionStatus.PUBLISHED) == ("v1",)
    assert store.reads == 1
    clock.now += 0.1
    assert listed.get(VersionStatus.PUBLISHED) == ("v1", "v2")
    # Each status has its own copy.
    listed.get(VersionStatus.RETIRED)
    assert store.reads == 3


def test_a_failed_read_keeps_nothing_and_no_older_copy_answers_for_it() -> None:
    store, clock = _Store(), _Clock()
    listed = ListedVersions(store, clock)  # type: ignore[arg-type]
    listed.get(VersionStatus.PUBLISHED)
    clock.now += LISTED_CACHE_SECONDS
    store.broken = True
    for _ in range(2):
        with pytest.raises(ClientError):
            listed.get(VersionStatus.PUBLISHED)
    # Nothing was kept: neither an empty list nor the copy that had expired.
    store.broken = False
    store.versions = ["v3"]
    assert listed.get(VersionStatus.PUBLISHED) == ("v3",)
    assert store.reads == 4


def test_a_read_in_flight_does_not_bring_back_what_was_dropped() -> None:
    store, clock = _Store(), _Clock()
    listed = ListedVersions(store, clock)  # type: ignore[arg-type]
    # The table is read, then this task retires an agent before the read is kept.
    store.on_read = listed.invalidate
    assert listed.get(VersionStatus.PUBLISHED) == ("v1",)
    store.on_read = None
    store.versions = []
    assert listed.get(VersionStatus.PUBLISHED) == ()


def test_two_people_get_their_own_list_from_the_same_copy(env: Env) -> None:  # noqa: F811
    _cached(env)
    for_hr = _published(env)["agent_id"]
    for_ops = _published(env, name="Operaciones", groups=["ops"])["agent_id"]
    calls = _count_calls(env.db)
    decisions = len(env.audit.events)

    assert _ids(env, "member") == {for_hr}
    assert _ids(env, "outsider") == {for_ops}
    assert _ids(env, "member", "/api/agents/org") == {for_hr}
    # One read of each status for the three requests, and a decision of its own for each.
    assert calls["Query"] == 2
    events = env.audit.events[decisions:]
    assert [(name, user) for name, user, _detail in events] == [
        ("policy.decision", "member-1"),
        ("policy.decision", "out-1"),
        ("policy.decision", "member-1"),
    ]


def test_a_change_of_groups_does_not_wait_for_the_copy(
    env: Env,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _cached(env)
    agent_id = _published(env)["agent_id"]
    assert _ids(env, "member") == {agent_id}
    # The next token no longer carries the group: the same copy, another decision.
    monkeypatch.setitem(TOKENS["member"], "cognito:groups", ["ops"])
    assert _ids(env, "member") == set()


@pytest.mark.usefixtures("admin_in_hr")
def test_what_this_task_retires_shows_in_the_next_read(env: Env) -> None:  # noqa: F811
    _cached(env)
    live = _published(env, "admin")
    listed = env.client.get("/api/agents", headers=_h("admin")).json()["items"]
    assert [(item["id"], item["status"]) for item in listed] == [(live["agent_id"], "published")]

    assert _retire(env, live).status_code == 200
    listed = env.client.get("/api/agents", headers=_h("admin")).json()["items"]
    assert [(item["id"], item["status"]) for item in listed] == [(live["agent_id"], "retired")]
    assert _ids(env, "admin", "/api/agents/org") == set()


def test_a_publication_shows_when_the_copy_expires(env: Env) -> None:  # noqa: F811
    """The provisioner publishes, not mango-api: no request of this task knows when. The
    marketplace lists the new agent once the copy expires, at most ``LISTED_CACHE_SECONDS``
    after the publication (which already takes the provisioner minutes)."""
    clock = _cached(env)
    assert _ids(env, "member") == set()
    agent_id = _published(env)["agent_id"]
    assert _ids(env, "member") == set()
    clock.now += LISTED_CACHE_SECONDS
    assert _ids(env, "member") == {agent_id}
    assert _ids(env, "member", "/api/agents/org") == {agent_id}


def test_a_list_that_cannot_be_read_fails_and_the_next_one_reads_again(
    env: Env,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _cached(env)
    agent_id = _published(env)["agent_id"]
    by_status = env.deps.store.by_status

    def broken(_status: VersionStatus) -> list[Any]:
        raise ClientError({"Error": {"Code": "InternalServerError"}}, "Query")

    monkeypatch.setattr(env.deps.store, "by_status", broken)
    with pytest.raises(ClientError):
        env.client.get("/api/agents", headers=_h("member"))
    monkeypatch.setattr(env.deps.store, "by_status", by_status)
    assert _ids(env, "member") == {agent_id}


# --- Agent records in one call -------------------------------------------------------------


@pytest.mark.usefixtures("env")
def test_a_list_reads_the_records_of_its_agents_in_one_call(env: Env) -> None:  # noqa: F811
    first = _published(env)
    second = _published(env, name="Otro")
    retired = _published(env, name="Viejo")
    assert _retire(env, retired).status_code == 200
    everyone = {first["agent_id"], second["agent_id"], retired["agent_id"]}
    _cached(env)

    for path, expected in (
        ("/api/agents", everyone),
        ("/api/agents/org", everyone - {retired["agent_id"]}),
    ):
        calls = _count_calls(env.db)
        assert _ids(env, "creator", path) == expected
        assert calls["BatchGetItem"] == 1, path
        assert calls["GetItem"] == 0, path

    # Who is not a creator and sees no retired agent reads none.
    assert _retire(env, first).status_code == 200
    calls = _count_calls(env.db)
    env.client.get("/api/agents/org", headers=_h("member"))
    assert calls["BatchGetItem"] == 0
    assert calls["GetItem"] == 0


def test_the_flags_of_the_list_are_the_same_read_together(env: Env) -> None:  # noqa: F811
    mine = _published(env)["agent_id"]
    other = _published(env, "admin", name="Ajeno")
    assert _retire(env, other).status_code == 200
    items = {
        item["id"]: item
        for item in env.client.get("/api/agents", headers=_h("creator")).json()["items"]
    }
    assert items[mine]["is_mine"] is True
    assert items[mine]["retired_at"] is None
    assert items[other["agent_id"]]["is_mine"] is False
    assert items[other["agent_id"]]["retire_reason"] == "Duplicado"


class _BatchDb:
    """``batch_get_item`` that leaves ``unprocessed`` keys out of each of its answers."""

    def __init__(self, unprocessed: int = 0, heals_after: int | None = None) -> None:
        self.requests: list[list[Any]] = []
        self._unprocessed = unprocessed
        self._heals_after = heals_after

    def batch_get_item(self, RequestItems: dict[str, Any]) -> dict[str, Any]:  # noqa: N803
        ((table, request),) = RequestItems.items()
        assert request["ConsistentRead"] is True
        keys = request["Keys"]
        self.requests.append(keys)
        healed = self._heals_after is not None and len(self.requests) > self._heals_after
        left = [] if healed else keys[: self._unprocessed]
        served = [key for key in keys if key not in left]
        items = [
            {
                **key,
                "agent_id": {"S": key["PK"]["S"].removeprefix("AGENT#")},
                "status": {"S": "published"},
                "version": {"N": "1"},
                "latest_version": {"N": "1"},
                "created_by": {"S": "creator-1"},
                "created_at": {"S": "2026-10-01T15:00:00+00:00"},
                "updated_at": {"S": "2026-10-01T15:00:00+00:00"},
            }
            for key in served
        ]
        answer: dict[str, Any] = {"Responses": {table: items}}
        if left:
            answer["UnprocessedKeys"] = {table: {"Keys": left}}
        return answer


def _agent_ids(count: int) -> list[str]:
    return [f"agent{n:011d}" for n in range(count)]


def test_records_are_asked_for_in_groups_of_what_one_call_takes() -> None:
    db = _BatchDb()
    store = AgentsStore(db, "agents")  # type: ignore[arg-type]
    ids = _agent_ids(BATCH_GET_KEYS + 5)
    # Repeated and malformed ids are not asked for.
    found = store.metas([*ids, ids[0], "Not an id"])
    assert set(found) == set(ids)
    assert [len(keys) for keys in db.requests] == [BATCH_GET_KEYS, 5]
    assert db.requests[0][0] == meta_key(ids[0])
    assert store.metas([]) == {}
    assert len(db.requests) == 2


def test_keys_left_unprocessed_are_asked_again() -> None:
    db, waits = _BatchDb(unprocessed=2, heals_after=1), []
    store = AgentsStore(db, "agents", sleep=waits.append)  # type: ignore[arg-type]
    ids = _agent_ids(5)
    assert set(store.metas(ids)) == set(ids)
    assert [len(keys) for keys in db.requests] == [5, 2]
    assert len(waits) == 1


def test_records_that_stay_unprocessed_fail_the_read(env: Env) -> None:  # noqa: F811
    db, waits = _BatchDb(unprocessed=1), []
    store = AgentsStore(db, "agents", sleep=waits.append)  # type: ignore[arg-type]
    with pytest.raises(AgentsUnavailableError):
        store.metas(_agent_ids(3))
    assert len(db.requests) == BATCH_GET_ATTEMPTS
    assert len(waits) == BATCH_GET_ATTEMPTS - 1

    # The list answers 503 instead of showing those agents as nobody's.
    _published(env)
    env.deps.store = store_with_failing_batch(env)
    response = env.client.get("/api/agents", headers=_h("creator"))
    assert response.status_code == 503
    assert _code(response) == "agent_unavailable"


def store_with_failing_batch(env: Env) -> AgentsStore:  # noqa: F811
    class _Failing(AgentsStore):
        def metas(self, agent_ids: Any) -> dict[str, Any]:
            raise AgentsUnavailableError("agents not read")

    return _Failing(env.db, "agents")


# --- The limit per person ------------------------------------------------------------------


def _limited(env: Env) -> _Clock:  # noqa: F811
    clock = _Clock()
    env.deps.list_limiter = Limits(clock=clock).limiter("agents.lists")
    return clock


def test_a_person_may_ask_for_thirty_lists_a_minute_between_both_routes(
    env: Env,  # noqa: F811
) -> None:
    spec = LIMITS["agents.lists"]
    assert (spec.limit, spec.window_seconds, spec.shared) == (30, 60, False)
    clock = _limited(env)
    _published(env)
    for n in range(spec.limit):
        clock.now += 1
        assert env.client.get(LISTS[n % 2], headers=_h("member")).status_code == 200

    audited = len(env.audit.events)
    calls = _count_calls(env.db)
    for path in LISTS:
        response = env.client.get(path, headers=_h("member"))
        assert response.status_code == 429
        assert _code(response) == "rate_limited"
        # The first of the thirty leaves the window in 31 seconds.
        assert response.headers["Retry-After"] == "31"
    # A refused call reads nothing and writes nothing.
    assert not calls
    assert len(env.audit.events) == audited

    # Nobody spends the limit of someone else, and the window slides.
    assert env.client.get("/api/agents", headers=_h("creator")).status_code == 200
    clock.now += 31
    assert env.client.get("/api/agents", headers=_h("member")).status_code == 200


def test_the_limit_counts_only_the_lists(env: Env) -> None:  # noqa: F811
    _limited(env)
    live = _published(env)
    for _ in range(LIMITS["agents.lists"].limit):
        env.client.get("/api/agents", headers=_h("member"))
    assert env.client.get("/api/agents", headers=_h("member")).status_code == 429
    # One agent, the rest of the API and the chat's own check are not behind it.
    assert (
        env.client.get(f"/api/agents/{live['agent_id']}", headers=_h("member")).status_code == 200
    )
    assert env.client.get("/api/me", headers=_h("member")).status_code == 200


def test_a_request_without_a_session_does_not_reach_the_limit(env: Env) -> None:  # noqa: F811
    _limited(env)
    for _ in range(LIMITS["agents.lists"].limit + 1):
        assert env.client.get("/api/agents").status_code == 401


def test_the_worst_case_of_the_page_fits(env: Env) -> None:  # noqa: F811
    """Signing in asks once, opening the marketplace once more, and while an agent is being
    removed the page asks every 15 seconds: seven tabs doing that at once still fit."""
    clock = _limited(env)
    _published(env)
    tabs = 7
    for _second in range(0, 120, 15):
        for _tab in range(tabs):
            assert env.client.get("/api/agents", headers=_h("member")).status_code == 200
        clock.now += 15
