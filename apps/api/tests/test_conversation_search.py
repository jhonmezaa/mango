"""Buscar conversaciones (D103; threat model ``conversation-search-threat-model.md``): the caller's
own conversations, walked with their row-level security client against moto DynamoDB."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import conversation_search as cs
from mango_api.conversations import ConversationRepository, SearchCorpus

from .test_admin import _table
from .test_app import OTHER_AGENT, Harness, _auth

URL = "/api/search/conversations"
CONV_A = "a" * 32
CONV_B = "b" * 32
CONV_OLD = "c" * 32
OTHERS = "d" * 32


@dataclass
class OwnPartition:
    """What the row-level security session of one person allows: their partition only, as STS
    would (``dynamodb:LeadingKeys`` = ``USER#<sub>``)."""

    db: Any
    user_id: str
    queries: list[str] = field(default_factory=list)
    fail: bool = False

    def _check(self, key: str) -> None:
        if key != f"USER#{self.user_id}":
            raise PermissionError(f"AccessDenied: {key}")

    def query(self, **request: Any) -> Any:
        if self.fail:
            raise ClientError({"Error": {"Code": "InternalServerError"}}, "Query")
        self._check(request["ExpressionAttributeValues"][":pk"]["S"])
        self.queries.append(request["ExpressionAttributeValues"][":prefix"]["S"])
        return self.db.query(**request)


def _conv(  # noqa: PLR0917
    db: Any, user: str, cid: str, title: str, updated: datetime, agent: str | None
) -> None:
    item: dict[str, Any] = {
        "PK": {"S": f"USER#{user}"},
        "SK": {"S": f"CONV#{cid}"},
        "title": {"S": title},
        "updated_at": {"S": updated.isoformat(timespec="seconds")},
    }
    if agent:
        item["agent_id"] = {"S": agent}
    db.put_item(TableName="conv", Item=item)


def _msg(  # noqa: PLR0917
    db: Any, user: str, cid: str, n: int, role: str, content: str, tools: list[str] | None = None
) -> None:
    db.put_item(
        TableName="conv",
        Item={
            "PK": {"S": f"USER#{user}"},
            "SK": {"S": f"MSG#{cid}#{n:020d}-0000"},
            "message_id": {"S": f"{cid[:1]}{n:031d}"},
            "role": {"S": role},
            "content": {"S": content},
            "created_at": {"S": "2026-11-03T10:00:00+00:00"},
            "tools": {"S": json.dumps([{"name": t, "status": "ok"} for t in tools or []])},
        },
    )


NOW = datetime(2026, 11, 3, 15, 0, tzinfo=UTC)


@dataclass
class Env:
    h: Harness
    client: TestClient
    db: Any
    sessions: dict[str, OwnPartition]


@pytest.fixture
def env() -> Iterator[Env]:
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "conv")
        _conv(db, "user-1", CONV_A, "Costos de EC2 en marzo", NOW - timedelta(hours=1), "finops")
        _msg(db, "user-1", CONV_A, 1, "user", "¿Cuánto gastamos en **EC2** el mes pasado?")
        _msg(
            db,
            "user-1",
            CONV_A,
            2,
            "assistant",
            "| cuenta | costo |\n|---|---|\n| prod | 1200 |\nEl gasto de EC2 fue <b>alto</b>.",
            ["cost-explorer.get_cost_and_usage"],
        )
        _conv(db, "user-1", CONV_B, "Revisión de seguridad", NOW - timedelta(days=1), OTHER_AGENT)
        _msg(db, "user-1", CONV_B, 1, "user", "Lista los buckets públicos de S3")
        _msg(db, "user-1", CONV_B, 2, "assistant", "Hay dos buckets públicos: logs y media.")
        # Stored before agents were data: it belongs to the release agent.
        _conv(db, "user-1", CONV_OLD, "Hola", NOW - timedelta(days=9), None)
        _msg(db, "user-1", CONV_OLD, 1, "user", "gasto de EC2 en enero")
        # Another person's conversation: never read for user-1.
        _conv(db, "admin-1", OTHERS, "EC2 de otra persona", NOW, "finops")
        _msg(db, "admin-1", OTHERS, 1, "user", "EC2 secreto")

        sessions: dict[str, OwnPartition] = {}

        def for_user(user_id: str) -> Any:
            return sessions.setdefault(user_id, OwnPartition(db, user_id))

        h = Harness()
        h.conversations = ConversationRepository(for_user, "conv")  # type: ignore[assignment]
        client = h.client()
        yield Env(h, client, db, sessions)


def _search(env: Env, token: str = "good", **params: Any) -> Any:
    return env.client.post(URL, json=params, headers=_auth(token))


def test_finds_in_titles_messages_answers_and_tools_of_the_caller_only(env: Env) -> None:
    r = _search(env, q="ec2")
    assert r.status_code == 200, r.text
    body = r.json()
    assert [x["conversation_id"] for x in body["results"]] == [CONV_A, CONV_OLD]
    first = body["results"][0]
    assert first["title"] == "Costos de EC2 en marzo"
    assert first["agent_id"] == "finops"
    assert [h["kind"] for h in first["hits"]] == ["title", "user", "agent"]
    # The release agent for a conversation stored before agents were data.
    assert body["results"][1]["agent_id"] == "finops"
    assert body["conversations_read"] == 3
    assert body["capped"] is False
    assert body["truncated"] is False
    # Only the caller's partition was read, with their own session.
    assert set(env.sessions) == {"user-1"}
    assert "EC2 secreto" not in r.text


def test_the_tool_name_is_searched_as_stored(env: Env) -> None:
    body = _search(env, q="cost-explorer usage").json()
    [result] = body["results"]
    [hit] = result["hits"]
    assert hit["kind"] == "tool"
    assert "".join(p["text"] for p in hit["parts"]) == "cost-explorer.get_cost_and_usage"
    assert [p["text"] for p in hit["parts"] if p["hit"]] == ["cost-explorer", "usage"]


def test_snippets_are_plain_text_with_the_terms_marked(env: Env) -> None:
    body = _search(env, q="EC2 alto", kind="agent").json()
    [hit] = body["results"][0]["hits"]
    text = "".join(p["text"] for p in hit["parts"])
    # Markdown marks and table rules go (``>`` too, as the design); the rest of stored HTML stays
    # as text, for the page to render as text.
    assert text == "cuenta costo prod 1200 El gasto de EC2 fue <b alto</b ."
    assert [p["text"] for p in hit["parts"] if p["hit"]] == ["EC2", "alto"]


def test_every_term_must_be_in_the_same_text(env: Env) -> None:
    assert _search(env, q="buckets marzo").json()["results"] == []
    assert len(_search(env, q="buckets logs").json()["results"]) == 1
    # Words of one character are not terms.
    assert _search(env, q="a e").json()["results"] == []


def test_filters_by_kind_agent_and_date(env: Env) -> None:
    assert [
        x["conversation_id"] for x in _search(env, q="ec2", kind="title").json()["results"]
    ] == [CONV_A]
    assert _search(env, q="buckets", agent="finops").json()["results"] == []
    assert len(_search(env, q="buckets", agent=OTHER_AGENT).json()["results"]) == 1


def test_today_and_since_yesterday_follow_the_persons_clock() -> None:
    corpus = SearchCorpus(
        conversations=tuple(
            cs.SearchableConversation(cid, "ec2", updated, None, ())
            for cid, updated in (
                ("1" * 32, "2026-11-03T06:00:00+00:00"),  # 01:00 in Bogotá, today
                ("2" * 32, "2026-11-03T04:00:00+00:00"),  # 23:00 in Bogotá, yesterday
                ("3" * 32, "2026-11-01T12:00:00+00:00"),
            )
        ),
        capped=False,
        items_read=3,
        bytes_read=9,
    )

    def found(when: Any) -> list[str]:
        params = cs.ConversationSearchParams(q="ec2", when=when, utc_offset_minutes=-300)
        out = cs.search(corpus, params, default_agent="finops", now=NOW).out
        return [r.conversation_id[0] for r in out.results]

    assert found("today") == ["1"]
    assert found("yesterday") == ["1", "2"]
    assert found("all") == ["1", "2", "3"]


def test_orders_by_relevance_or_by_recency(env: Env) -> None:
    _msg(env.db, "user-1", CONV_OLD, 2, "assistant", "EC2 EC2")
    _msg(env.db, "user-1", CONV_OLD, 3, "user", "más EC2")
    _msg(env.db, "user-1", CONV_OLD, 4, "user", "y EC2")
    _msg(env.db, "user-1", CONV_OLD, 5, "user", "otra vez EC2")
    relevance = [x["conversation_id"] for x in _search(env, q="ec2").json()["results"]]
    # CONV_A: three hits and the title (8); CONV_OLD: five hits (5).
    assert relevance == [CONV_A, CONV_OLD]
    recent = [
        x["conversation_id"] for x in _search(env, q="gasto", sort="recent").json()["results"]
    ]
    assert recent == [CONV_A, CONV_OLD]


def test_caps_stop_the_read_and_say_so(env: Env) -> None:
    repo = ConversationRepository(lambda u: OwnPartition(env.db, u), "conv")
    corpus = repo.search_corpus(
        "user-1", max_conversations=2, max_messages=100, max_bytes=10_000, max_list_pages=10
    )
    assert [c.conversation_id for c in corpus.conversations] == [CONV_A, CONV_B]
    assert corpus.capped is True
    corpus = repo.search_corpus(
        "user-1", max_conversations=10, max_messages=3, max_bytes=10_000, max_list_pages=10
    )
    assert sum(len(c.messages) for c in corpus.conversations) == 3
    assert corpus.capped is True
    corpus = repo.search_corpus(
        "user-1", max_conversations=10, max_messages=100, max_bytes=10_000, max_list_pages=10
    )
    assert corpus.capped is False
    assert corpus.items_read == 3 + 5
    assert [c.conversation_id for c in corpus.conversations] == [CONV_A, CONV_B, CONV_OLD]


def test_audits_counts_only(env: Env) -> None:
    _search(env, q="buckets públicos", agent=OTHER_AGENT)
    i = env.h.audit.events.index("conversation.search")
    detail = env.h.audit.details[i]
    assert detail == {
        "query_length": len("buckets públicos"),
        "terms": 2,
        "hits": 2,
        "conversations_found": 1,
        "conversations_read": 3,
        "capped": False,
        "cached": False,
        "filtered": True,
    }
    decision = env.h.audit.details[env.h.audit.events.index("policy.decision")]
    assert decision["action"] == "SearchConversations"
    assert decision["read_only"] is True
    assert "buckets" not in json.dumps(env.h.audit.details)


def test_the_read_is_cached_briefly_per_person(env: Env) -> None:
    _search(env, q="ec2")
    queries = len(env.sessions["user-1"].queries)
    _search(env, q="buckets")
    assert len(env.sessions["user-1"].queries) == queries
    assert env.h.audit.details[-1]["cached"] is True
    # Another person gets their own read, never the cached one of user-1.
    body = _search(env, token="admin", q="ec2").json()
    assert [x["conversation_id"] for x in body["results"]] == [OTHERS]


def test_the_cache_expires() -> None:
    clock = [0.0]
    reads: list[str] = []

    def read(user_id: str) -> SearchCorpus:
        reads.append(user_id)
        return SearchCorpus((), False, 0, 0)

    deps = cs.SearchDeps(
        read=read,
        owned=lambda _caller, _found: frozenset(),
        audit=None,
        limiter=None,
        default_agent="x",
        monotonic=lambda: clock[0],  # type: ignore[arg-type]
    )
    deps.corpus("u")
    clock[0] = cs.CACHE_SECONDS - 1
    deps.corpus("u")
    clock[0] = cs.CACHE_SECONDS + 1
    deps.corpus("u")
    assert reads == ["u", "u"]


def test_inputs_are_validated(env: Env) -> None:
    for params in (
        {"q": "x" * (cs.MAX_QUERY + 1)},
        {"q": ""},
        {"q": "ec2", "agent": "../x"},
        {"q": "ec2", "kind": "html"},
        {"q": "ec2", "when": "lastyear"},
        {"q": "ec2", "sort": "random"},
        {"q": "ec2", "utc_offset_minutes": 10_000},
        # No input names a person.
        {"q": "ec2", "user": "admin-1"},
    ):
        assert _search(env, **params).status_code == 422, params
    assert "user-1" not in env.sessions


def test_terms_are_bounded() -> None:
    assert cs.terms_of(" ".join(f"w{i}" for i in range(20))) == [f"w{i}" for i in range(8)]
    assert cs.terms_of("EC2 ec2 Ec2") == ["ec2"]


def test_denied_by_cedar(env: Env) -> None:
    env.h.authorizer.allow = False
    assert _search(env, q="ec2").status_code == 403
    assert "user-1" not in env.sessions


def test_rate_limited_per_person(env: Env) -> None:
    for _ in range(cs.SEARCHES_PER_MINUTE):
        assert _search(env, q="ec2").status_code == 200
    r = _search(env, q="ec2")
    assert r.status_code == 429
    assert int(r.headers["Retry-After"]) >= 1


def test_a_failed_read_is_unavailable(env: Env) -> None:
    env.sessions["user-1"] = OwnPartition(env.db, "user-1", fail=True)
    r = _search(env, q="ec2")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "search_unavailable"


def test_snippet_window_and_ellipses() -> None:
    text = "a" * 100 + " clave " + "b" * 200
    pre, post, parts = cs.snippet(text, text, ["clave"])
    assert pre is True and post is True
    assert [p.text for p in parts if p.hit] == ["clave"]
    assert len("".join(p.text for p in parts)) == cs.SNIPPET_BEFORE + cs.SNIPPET_AFTER


def test_results_are_decided_own_conversation_for_the_partition_they_were_read_from(
    env: Env,
) -> None:
    # TM-TW3: one batch for the results, its owner read from the partition (USER#<sub>).
    body = _search(env, q="ec2").json()
    assert {x["conversation_id"] for x in body["results"]} == {CONV_A, CONV_OLD}
    decision = next(
        d
        for e, d in zip(env.h.audit.events, env.h.audit.details, strict=True)
        if e == "policy.decision" and d.get("action") == "OwnConversation"
    )
    assert (decision["scope"], decision["visible"], decision["denied"]) == ("search", 2, 0)
    # What Cedar does not allow is left out, as if it did not exist (fail closed).
    env.h.authorizer.allowed_conversations = lambda *_a: frozenset()  # type: ignore[method-assign]
    body = _search(env, q="buckets").json()
    assert body["results"] == []
    assert env.h.audit.details[-1]["conversations_found"] == 0
    assert env.h.audit.details[-1]["hits"] == 0
