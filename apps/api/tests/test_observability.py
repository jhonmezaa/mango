"""Observabilidad (D108 (b), D109 (b); threat model ``observability-threat-model.md``): the traces
read by the trace reader, joined with the turn references mango-api writes, against moto DynamoDB
and a fake trace reader."""

from __future__ import annotations

import io
import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import observability as obs
from mango_api.budget import BudgetService
from mango_api.observability_store import PARTITION, TraceRefs
from mango_api.web import ApiError, Caller, error_response
from mango_core.budget_turns import PendingTurn, TurnPrice
from mango_core.identity import UserContext

from .test_admin import _table

NOW = datetime(2026, 11, 5, 15, 0, tzinfo=UTC)
NOW_MS = int(NOW.timestamp() * 1000)
ADMIN = UserContext("admin-1", None, None, True, email="admin@empresa.com")
CENTRAL = UserContext("central-1", "finops-central", None, False)
PERSON = "user-7"
SESSION = "ab" * 32
OTHER_SESSION = "cd" * 32
PRICE = TurnPrice(Decimal(3), Decimal(15))


def trace(
    n: int,
    *,
    session: str | None = SESSION,
    agent: str = "finops",
    ago_s: int = 600,
    ms: int = 4000,
    failed: bool = False,
    tool_failed: bool = False,
) -> dict[str, Any]:
    return {
        "trace_id": f"{n:032x}",
        "session_id": session,
        "agent_id": agent,
        "start_ms": NOW_MS - ago_s * 1000,
        "duration_ms": ms,
        "failed": failed or tool_failed,
        "model": "us.anthropic.claude-sonnet-4-6",
        "tokens": {"input": 1000, "output": 100, "cache_read": 0, "cache_write": 0},
        "model_calls": 2,
        "tool_calls": 1,
        "spans": [
            {
                "kind": "model",
                "name": "us.anthropic.claude-sonnet-4-6",
                "offset_ms": 0,
                "duration_ms": 1000,
                "failed": False,
                "input_tokens": 600,
                "output_tokens": 40,
            },
            {
                "kind": "tool",
                "name": "mango_finops___get_cost_and_usage",
                "offset_ms": 1100,
                "duration_ms": ms // 2,
                "failed": tool_failed,
                "input_tokens": None,
                "output_tokens": None,
            },
        ],
        "more_spans": 0,
    }


@dataclass
class FakeReader:
    traces: list[dict[str, Any]] = field(default_factory=list)
    capped: bool = False
    calls: list[tuple[int, int, str | None]] = field(default_factory=list)
    answer: Any = None

    def read(self, start_ms: int, end_ms: int, agent_id: str | None) -> dict[str, Any]:
        self.calls.append((start_ms, end_ms, agent_id))
        if self.answer is not None:
            return dict(self.answer)
        return {
            "traces": self.traces,
            "capped": self.capped,
            "unreadable": 1,
            "found": {"aws_spans": 3, "runtime": 0},
        }


class AllowAll:
    def allow(self, key: str, cost: int = 1) -> bool:
        return True

    def retry_after(self, key: str, cost: int = 1) -> int:
        return 1


class Nobody(AllowAll):
    def allow(self, key: str, cost: int = 1) -> bool:
        return False


@dataclass
class Env:
    client: TestClient
    reader: FakeReader
    refs: TraceRefs
    deps: obs.ObservabilityDeps
    decisions: list[tuple[str, str, bool]]
    caller: list[UserContext]

    def turn(
        self,
        *,
        session: str = SESSION,
        ago_s: int = 601,
        agent: str = "finops",
        user: str = PERSON,
        cost_agent: str | None = None,
    ) -> PendingTurn:
        started = int(NOW.timestamp()) - ago_s
        pending = PendingTurn.new(
            turn_id=f"t{ago_s}",
            user_id=user,
            agent_id=agent,
            agent_version=3,
            model="us.anthropic.claude-sonnet-4-6",
            conversation_id="c" * 26,
            period="2026-11",
            scopes=(f"USER#{user}",),
            reserved=Decimal("0.5"),
            started_at=started,
            timeout_seconds=120,
            price=PRICE,
            cost_agent=cost_agent,
            origin="playground" if cost_agent else "chat",
        )
        self.refs.record(pending, session)
        return pending

    def get(self, **params: Any) -> Any:
        return self.client.get("/api/observability", params=params)


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "audit-index")
        refs = TraceRefs(db, "audit-index", clock=NOW.timestamp)
        reader = FakeReader()
        deps = obs.ObservabilityDeps(
            traces=reader,
            refs=refs,
            emails=obs.Emails({PERSON: "persona@empresa.com"}.get),
            agent_names=lambda: {"finops": "FinOps"},
            limiter=AllowAll(),
            clock=lambda: NOW,
        )
        decisions: list[tuple[str, str, bool]] = []
        caller = [ADMIN]

        async def current_user() -> Caller:
            return Caller(user=caller[0], token="t", expires_at=0)

        async def authorize(c: Caller, action: str, _t: str, _id: str, **kw: Any) -> None:
            allowed = c.user.is_admin
            decisions.append((action, str(kw.get("read_only")), allowed))
            if not allowed:
                raise ApiError(403, "forbidden", "not allowed")

        app = FastAPI()

        @app.exception_handler(ApiError)
        async def api_error(_r: Request, exc: ApiError) -> JSONResponse:
            return error_response(exc.status, exc.code, exc.message, exc.headers, exc.extra)

        app.include_router(obs.observability_router(deps, current_user, authorize))
        yield Env(TestClient(app), reader, refs, deps, decisions, caller)


def test_a_trace_is_joined_with_its_turn_and_shows_the_person(env: Env) -> None:
    env.turn()
    env.reader.traces = [trace(1)]
    resp = env.get(range="1h")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    [t] = body["traces"]
    # Mango's own random id (D108 (3)): the turn's key and the trace's place in the turn.
    assert t["id"] != f"{1:032x}" and len(t["id"]) == 32
    assert f"{1:032x}" not in resp.text
    assert (t["user_id"], t["user_email"], t["matched"]) == (PERSON, "persona@empresa.com", True)
    assert (t["agent_name"], t["agent_version"], t["playground"]) == ("FinOps", 3, False)
    assert t["origin"] == "chat"
    # 1000 in at 3 USD/M and 100 out at 15 USD/M.
    assert t["cost_usd"] == "0.004500"
    assert t["status"] == "ok" and t["tools_failed"] == 0
    assert body["unreadable"] == 1 and body["unmatched"] == 0
    assert env.decisions == [("ViewObservability", "True", True)]


def test_the_response_never_carries_the_session_nor_the_conversation(env: Env) -> None:
    env.turn()
    env.reader.traces = [trace(1)]
    text = env.get(range="1h").text
    assert SESSION not in text
    assert "c" * 26 not in text
    assert "session" not in text


def test_a_trace_without_a_turn_has_no_person_nor_cost(env: Env) -> None:
    env.turn(session=OTHER_SESSION)
    env.reader.traces = [trace(1), trace(2, session=None)]
    body = env.get(range="1h").json()
    assert body["unmatched"] == 2
    for t in body["traces"]:
        assert (t["user_id"], t["user_email"], t["cost_usd"], t["matched"]) == (
            None,
            None,
            None,
            False,
        )


def test_a_trace_joins_the_latest_turn_of_its_session_that_started_before_it(env: Env) -> None:
    env.turn(ago_s=3000, user="user-old")
    env.turn(ago_s=601)
    env.turn(ago_s=100, user="user-later")
    env.reader.traces = [trace(1, ago_s=600)]
    [t] = env.get(range="1h").json()["traces"]
    assert t["user_id"] == PERSON


def test_a_reference_of_another_agent_is_not_believed(env: Env) -> None:
    env.turn(agent="other")
    env.reader.traces = [trace(1)]
    assert env.get(range="1h").json()["traces"][0]["matched"] is False


def test_a_playground_test_joins_the_tested_agents_turn(env: Env) -> None:
    env.turn(agent="finops", cost_agent="playground")
    env.reader.traces = [trace(1, agent="playground")]
    [t] = env.get(range="1h").json()["traces"]
    assert (t["agent_id"], t["playground"], t["matched"]) == ("finops", True, True)
    assert t["origin"] == "playground"


def test_aggregates_are_computed_in_the_server(env: Env) -> None:
    env.reader.traces = [
        *(trace(i, ms=1000 * i, ago_s=60 * i) for i in range(1, 20)),
        trace(20, ms=20_000, ago_s=1200, tool_failed=True),
        trace(21, agent="other", ms=500, ago_s=30, failed=True),
    ]
    body = env.get(range="1h").json()
    s = body["summary"]
    assert (s["traces"], s["agents"], s["failed"], s["failed_by_tool"]) == (21, 2, 2, 1)
    assert s["p50_ms"] == 10_000 and s["p95_ms"] == 19_000
    assert s["error_percent"] == "9.5"
    assert [a["agent_id"] for a in body["by_agent"]] == ["finops", "other"]
    [tool] = body["tools"]
    assert (tool["name"], tool["calls"], tool["failed"]) == (
        "mango_finops___get_cost_and_usage",
        21,
        1,
    )
    assert len(body["hourly"]) == 1 and body["hourly"][0]["error"] == 2


def test_status_filters_and_pages_read_the_same_reading(env: Env) -> None:
    env.reader.traces = [
        trace(i, ms=1000 * i, ago_s=60 * i, failed=i % 5 == 0) for i in range(1, 51)
    ]
    first = env.get(range="1h").json()
    assert first["total"] == 50 and len(first["traces"]) == 40
    second = env.get(range="1h", offset=40).json()
    assert [t["duration_ms"] for t in second["traces"]] == [1000 * i for i in range(41, 51)]
    errors = env.get(range="1h", status="error").json()
    assert errors["total"] == 10
    slow = env.get(range="1h", status="slow").json()
    assert all(t["duration_ms"] >= first["summary"]["p95_ms"] for t in slow["traces"])
    assert len(env.reader.calls) == 1


def test_the_reading_is_cached_a_minute_per_range_and_agent(env: Env) -> None:
    clock = [0.0]
    env.deps.monotonic = lambda: clock[0]
    env.get(range="1h")
    env.get(range="1h")
    env.get(range="6h")
    env.get(range="1h", agent="finops")
    clock[0] = obs.CACHE_SECONDS + 1
    env.get(range="1h")
    assert [(e - s, a) for s, e, a in env.reader.calls] == [
        (3_600_000, None),
        (6 * 3_600_000, None),
        (3_600_000, "finops"),
        (3_600_000, None),
    ]


def test_the_window_is_asked_of_the_reader(env: Env) -> None:
    env.get(range="24h", agent="finops")
    assert env.reader.calls == [(NOW_MS - 24 * 3_600_000, NOW_MS, "finops")]


@pytest.mark.parametrize(
    "params",
    [
        {"range": "7d"},
        {"status": "approval"},
        {"agent": "Mango_*"},
        {"limit": 500},
        {"offset": -1},
        {"agent": "x" * 40},
    ],
)
def test_parameters_are_closed(env: Env, params: dict[str, Any]) -> None:
    assert env.get(**params).status_code == 422
    assert env.reader.calls == []


def test_the_evals_harness_is_not_asked_for(env: Env) -> None:
    assert env.get(agent="evals").status_code == 422
    assert env.reader.calls == []


def test_only_administrators_read_it(env: Env) -> None:
    env.caller[0] = CENTRAL
    assert env.get().status_code == 403
    assert env.reader.calls == []


def test_a_non_admin_allowed_by_policy_is_still_refused(env: Env) -> None:
    # Defense in depth: is_admin again in process (D109 (b)).
    async def allow(*_a: Any, **_k: Any) -> None:
        return None

    app = FastAPI()

    @app.exception_handler(ApiError)
    async def api_error(_r: Request, exc: ApiError) -> JSONResponse:
        return error_response(exc.status, exc.code, exc.message)

    async def central() -> Caller:
        return Caller(user=CENTRAL, token="t", expires_at=0)

    app.include_router(obs.observability_router(env.deps, central, allow))
    assert TestClient(app).get("/api/observability").status_code == 403


def test_the_limit_answers_429(env: Env) -> None:
    env.deps.limiter = Nobody()
    resp = env.get()
    assert resp.status_code == 429 and "retry-after" in resp.headers


@pytest.mark.parametrize(
    "answer",
    [
        {"traces": [], "capped": False},
        {"traces": [{**trace(1), "prompt": "hola"}], "capped": False, "unreadable": 0, "found": {}},
        {
            "traces": [{**trace(1), "session_id": "x"}],
            "capped": False,
            "unreadable": 0,
            "found": {},
        },
        {
            "traces": [{**trace(1), "model": "<b>x</b>"}],
            "capped": False,
            "unreadable": 0,
            "found": {},
        },
    ],
)
def test_an_unexpected_answer_of_the_reader_is_503(env: Env, answer: dict[str, Any]) -> None:
    env.reader.answer = answer
    resp = env.get()
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "observability_unavailable"
    assert "hola" not in resp.text


def test_capped_says_the_window_was_cut(env: Env) -> None:
    env.reader.capped = True
    assert env.get().json()["capped"] is True


def test_a_reference_holds_metadata_only_and_expires(env: Env) -> None:
    env.turn()
    db = boto3.client("dynamodb", region_name="us-east-1")
    [item] = db.scan(TableName="audit-index")["Items"]
    assert item["PK"]["S"] == f"{PARTITION}2026-11-05"
    assert item["SK"]["S"].startswith(SESSION + "#")
    assert set(item) == {
        "PK",
        "SK",
        "user_id",
        "agent_id",
        "agent_version",
        "model",
        "conversation_id",
        "playground",
        "origin",
        "price_input",
        "price_output",
        "price_cache_read",
        "price_cache_write",
        "trace_key",
        "ttl",
    }
    assert int(item["ttl"]["N"]) == int(NOW.timestamp() + timedelta(days=30).total_seconds())


def test_writing_a_reference_never_breaks_the_turn(caplog: pytest.LogCaptureFixture) -> None:
    class Broken:
        def put_item(self, **_kw: Any) -> None:
            raise ClientError({"Error": {"Code": "ProvisionedThroughputExceededException"}}, "Put")

    refs = TraceRefs(Broken(), "audit-index")  # type: ignore[arg-type]
    pending = PendingTurn.new(
        turn_id="t1",
        user_id=PERSON,
        agent_id="finops",
        agent_version=1,
        model="m",
        conversation_id="c",
        period="2026-11",
        scopes=(),
        reserved=Decimal(1),
        started_at=1,
        timeout_seconds=60,
        price=PRICE,
        origin="chat",
    )
    refs.record(pending, SESSION)
    refs.record(pending, "not-a-session")
    assert PERSON not in caplog.text and SESSION not in caplog.text


def test_binding_a_session_writes_the_reference(env: Env) -> None:
    seen: list[str] = []
    budgets = BudgetService(object(), "budgets", on_bind=lambda _t, s: seen.append(s))  # type: ignore[arg-type]

    class Db:
        def update_item(self, **_kw: Any) -> None:
            return None

    budgets._db = Db()  # type: ignore[assignment]
    pending = env.turn()
    budgets.bind_session(pending, SESSION)
    assert seen == [SESSION]


def test_the_lambda_source_invokes_synchronously_and_fails_closed() -> None:
    class Client:
        def __init__(self, error: str | None) -> None:
            self.error = error
            self.kwargs: dict[str, Any] = {}

        def invoke(self, **kwargs: Any) -> dict[str, Any]:
            self.kwargs = kwargs
            out: dict[str, Any] = {"Payload": io.BytesIO(b'{"traces": []}')}
            if self.error:
                out["FunctionError"] = self.error
            return out

    ok = Client(None)
    assert obs.LambdaTraceSource(ok, "Mango-lab-TraceReader").read(1, 2, None) == {"traces": []}
    assert ok.kwargs["InvocationType"] == "RequestResponse"
    assert json.loads(ok.kwargs["Payload"]) == {"start": 1, "end": 2, "agent": None}
    with pytest.raises(obs.TracesUnavailableError):
        obs.LambdaTraceSource(Client("Unhandled"), "f").read(1, 2, None)


def test_emails_are_looked_up_once_and_bounded() -> None:
    calls: list[str] = []
    emails = obs.Emails(lambda sub: calls.append(sub) or f"{sub}@x.co", monotonic=lambda: 0.0)
    ids = [f"u{i}" for i in range(obs.MAX_EMAIL_LOOKUPS + 10)]
    assert len(emails.of(ids)) == obs.MAX_EMAIL_LOOKUPS
    emails.of(ids[:5])
    assert len(calls) == obs.MAX_EMAIL_LOOKUPS


def test_percentile_is_nearest_rank() -> None:
    assert obs.percentile([], 0.5) is None
    assert obs.percentile([5], 0.95) == 5
    assert obs.percentile(list(range(1, 101)), 0.95) == 95


def test_a_turn_keeps_the_ids_of_its_traces_and_a_trace_without_one_does_not(env: Env) -> None:
    env.turn()
    env.reader.traces = [trace(1), trace(2, ago_s=590), trace(3, session=None, ago_s=500)]
    env.deps.monotonic = iter([0.0, 1000.0]).__next__
    first = {t["started_at"]: t for t in env.get(range="1h").json()["traces"]}
    again = {t["started_at"]: t for t in env.get(range="1h").json()["traces"]}
    turn_ids = sorted(t["id"] for t in first.values() if t["matched"])
    assert turn_ids == sorted(t["id"] for t in again.values() if t["matched"])
    assert turn_ids[0][:30] == turn_ids[1][:30] and turn_ids[0] != turn_ids[1]
    [lone] = [t for t in first.values() if not t["matched"]]
    assert lone["id"] not in {t["id"] for t in again.values()}
