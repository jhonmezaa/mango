"""Costos (D105, D106, D107; threat model ``costs-threat-model.md``): the spend of a month per
day, agent, model and origin, against moto DynamoDB and the real day counters written by
closing turns."""

from __future__ import annotations

import secrets
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api import costs
from mango_api.audit import AuditLog, AuditQuery
from mango_api.budget import BudgetScope, BudgetService
from mango_api.costs import AgentInfo, CostsDeps
from mango_api.home import HomeData
from mango_api.probe import RateLimiter
from mango_api.settings_store import BudgetLimits, SettingsStore
from mango_api.web import ApiError
from mango_core import usage_days
from mango_core.budget_turns import PendingTurn, TurnPrice
from mango_core.playground import PLAYGROUND_ID

from .test_admin import FakeProbe, _seed, _table
from .test_app import (
    HOST,
    KEY,
    TOKENS,
    FakeBedrock,
    FakeConversations,
    FakeModelCatalog,
    FakePublished,
    FakeVerifier,
    _settings,
)
from .test_approvals import RoleAuthorizer, _h
from .test_audit import FakeFirehose

URL = "/api/costs"
EXP = int(time.time()) + 3600
PEOPLE = {
    "central": {"sub": "user-20", "mango_role": "finops-central", "exp": EXP},
    "creator": {
        "sub": "user-24",
        "mango_email": "creator@example.com",
        "cognito:groups": ["mango-agent-creator"],
        "exp": EXP,
    },
}
PRICE = TurnPrice(Decimal(3), Decimal(15))
SONNET = "us.anthropic.claude-sonnet-4-6"
HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
TODAY = datetime(2026, 11, 20, 15, tzinfo=UTC)


def _turn(
    db: Any,
    *,
    when: datetime,
    cost: str,
    agent: str = "finops",
    model: str = SONNET,
    origin: str = "chat",
    cost_agent: str | None = None,
) -> None:
    """A turn that ran and cost ``cost``: reserved and settled as the chat does."""
    budgets = BudgetService(db, "budgets")
    period = when.strftime("%Y-%m")
    scopes = [BudgetScope("USER#user-1", Decimal(100)), BudgetScope(f"AGENT#{agent}", Decimal(200))]
    pending = PendingTurn.new(
        turn_id=secrets.token_hex(16),
        user_id="user-1",
        agent_id=agent,
        agent_version=1,
        model=model,
        conversation_id="c" * 32,
        period=period,
        scopes=tuple(s.key for s in scopes),
        reserved=Decimal(1),
        price=PRICE,
        started_at=int(when.timestamp()),
        timeout_seconds=60,
        origin=origin,
        cost_agent=cost_agent,
    )
    budgets.reserve(scopes, Decimal(1), period, pending)
    assert budgets.settle_turn(pending, Decimal(cost))


@dataclass
class Counting:
    """mango-api's own client, recording every key it reads."""

    db: Any
    keys: list[str] = field(default_factory=list)
    fail: bool = False

    def query(self, **request: Any) -> Any:
        if self.fail:
            raise RuntimeError("dynamodb down")
        self.keys.append(request["ExpressionAttributeValues"][":pk"]["S"])
        return self.db.query(**request)

    def batch_get_item(self, **request: Any) -> Any:
        for keys in request["RequestItems"].values():
            self.keys.extend(k["PK"]["S"] for k in keys["Keys"])
        return self.db.batch_get_item(**request)

    def scan(self, **_request: Any) -> Any:
        raise AssertionError("Costos never scans the table")


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        for name in ("settings", "budgets", "audit-index"):
            _table(client, name)
        yield client


def _deps(db: Any, **changes: Any) -> CostsDeps:
    values: dict[str, Any] = {
        "table": "budgets",
        "dynamodb": Counting(db),
        "agents": lambda: {
            "finops": AgentInfo("FinOps", "Finanzas", SONNET),
            "legal": AgentInfo("Legal", "", HAIKU),
        },
        "models": lambda: [SONNET, HAIKU],
        "agent_limit": lambda: Decimal(30),
        "default_agent": "finops",
        "clock": lambda: TODAY,
        "limiter": RateLimiter(costs.READS_PER_MINUTE, 60),
    }
    values.update(changes)
    return CostsDeps(**values)


def _seed_month(db: Any) -> None:
    _turn(db, when=TODAY, cost="2")
    _turn(db, when=TODAY - timedelta(days=3), cost="1", origin="task")
    _turn(db, when=TODAY - timedelta(days=1), cost="0.5", agent="legal", model=HAIKU)
    # A test of the Playground: billed to the Playground, charged to the tested agent.
    _turn(db, when=TODAY, cost="0.25", origin="playground", cost_agent=PLAYGROUND_ID)
    # The month before.
    _turn(db, when=datetime(2026, 10, 5, tzinfo=UTC), cost="4")


# --- What a month reads -----------------------------------------------------------------------


def test_the_month_per_day_with_the_one_before(db: Any) -> None:
    _seed_month(db)
    out = costs.summary(_deps(db), "2026-11")
    assert (out.month, out.previous_month, out.days_in_month) == ("2026-11", "2026-10", 30)
    assert (out.elapsed_days, out.closed) == (20, False)
    assert [d.day for d in out.days][0::19] == ["2026-11-01", "2026-11-20"]
    assert len(out.previous_days) == 31
    assert (out.spent_usd, out.turns) == ("3.75", 4)
    assert (out.previous_usd, out.previous_turns) == ("4.00", 1)
    assert out.counted_since == "2026-10-05"
    # As the design: the pace of 20 days over 30.
    assert out.projected_usd == "5.62"


def test_per_agent_with_the_playground_apart_and_the_budget(db: Any) -> None:
    _seed_month(db)
    agents = costs.summary(_deps(db), "2026-11").agents
    rows = {r.id: r for r in agents.rows}
    assert [r.id for r in agents.rows] == ["finops", "legal", PLAYGROUND_ID]
    finops = rows["finops"]
    assert (finops.name, finops.category, finops.model) == ("FinOps", "Finanzas", SONNET)
    assert (finops.spent_usd, finops.turns, finops.previous_usd) == ("3.00", 2, "4.00")
    # The budget counts the Playground's test of the agent; its day counter does not (D104).
    assert finops.budget is not None
    assert (finops.budget.limit_usd, finops.budget.spent_usd) == ("30.00", "3.25")
    assert rows["legal"].category is None
    playground = rows[PLAYGROUND_ID]
    assert (playground.name, playground.budget) == (None, None)
    assert agents.unattributed_usd == "0.00"


def test_per_model_and_per_origin(db: Any) -> None:
    _seed_month(db)
    out = costs.summary(_deps(db), "2026-11")
    assert [(r.id, r.spent_usd, r.turns) for r in out.models.rows] == [
        (SONNET, "3.25", 3),
        (HAIKU, "0.50", 1),
    ]
    assert out.models.previous_unattributed_usd == "0.00"
    assert [(r.id, r.spent_usd, r.turns) for r in out.sources.rows] == [
        ("chat", "2.50", 2),
        ("task", "1.00", 1),
        ("playground", "0.25", 1),
        ("eval", "0.00", 0),
    ]
    assert out.sources.counted_since == out.models.counted_since == "2026-10-05"


def test_what_was_counted_before_the_breakdown_is_unattributed_never_spread(db: Any) -> None:
    _turn(db, when=TODAY, cost="1")
    # A turn of a version before D106: in the organization and the agent, in no model or origin.
    usage_days_before = usage_days.updates(
        "budgets", ("DAY#ORG", "DAY#AGENT#finops"), "2026-11-02", spent=Decimal(2), turns=1
    )
    for item in usage_days_before:
        db.update_item(**item["Update"])
    out = costs.summary(_deps(db), "2026-11")
    assert out.spent_usd == "3.00"
    assert [(r.id, r.spent_usd) for r in out.models.rows] == [(SONNET, "1.00")]
    assert out.models.unattributed_usd == out.sources.unattributed_usd == "2.00"
    assert out.agents.unattributed_usd == "0.00"
    assert out.counted_since == "2026-11-02"
    assert out.models.counted_since == "2026-11-20"
    # All of it before the counters started: «Sin desglose · Antes del {fecha}».
    assert out.models.before_since_usd == out.sources.before_since_usd == "2.00"
    assert out.agents.before_since_usd == "0.00"


def test_before_the_counters_apart_from_what_no_row_holds_once_they_count(db: Any) -> None:
    _turn(db, when=TODAY, cost="1")
    # Before the agents' counter: only the organization's. Once it counts: a title (no agent).
    for day, spent in (("2026-11-02", "2"), ("2026-11-20", "0.10"), ("2026-10-12", "4")):
        for item in usage_days.updates("budgets", ("DAY#ORG",), day, spent=Decimal(spent), turns=1):
            db.update_item(**item["Update"])
    agents = costs.summary(_deps(db), "2026-11").agents
    assert agents.counted_since == "2026-11-20"
    assert (agents.unattributed_usd, agents.before_since_usd) == ("2.10", "2.00")
    assert (agents.previous_unattributed_usd, agents.previous_before_since_usd) == ("4.00", "4.00")


def test_without_counters_the_whole_month_is_before_them(db: Any) -> None:
    for item in usage_days.updates(
        "budgets", ("DAY#ORG",), "2026-11-03", spent=Decimal(1), turns=1
    ):
        db.update_item(**item["Update"])
    out = costs.summary(_deps(db), "2026-11")
    assert out.agents.counted_since is None
    assert (out.agents.unattributed_usd, out.agents.before_since_usd) == ("1.00", "1.00")


def test_a_closed_month_has_every_day_no_projection_and_no_budget(db: Any) -> None:
    _seed_month(db)
    out = costs.summary(_deps(db), "2026-10")
    assert (out.closed, out.elapsed_days, len(out.days)) == (True, 31, 31)
    assert out.projected_usd is None
    assert (out.spent_usd, out.previous_usd) == ("4.00", "0.00")
    (finops,) = out.agents.rows
    assert (finops.budget, finops.projected_usd) == (None, None)


def test_no_projection_before_five_days(db: Any) -> None:
    early = datetime(2026, 11, 4, 12, tzinfo=UTC)
    _turn(db, when=early, cost="1")
    out = costs.summary(_deps(db, clock=lambda: early), "2026-11")
    assert (out.elapsed_days, out.projected_usd) == (4, None)
    assert out.agents.rows[0].projected_usd is None


def test_before_the_first_turn(db: Any) -> None:
    out = costs.summary(_deps(db), "2026-11")
    assert (out.spent_usd, out.counted_since, out.projected_usd) == ("0.00", None, "0.00")
    assert out.agents.rows == out.models.rows == []
    assert out.agents.counted_since is None
    assert [r.id for r in out.sources.rows] == list(usage_days.ORIGINS)


@pytest.mark.parametrize("month", ["2026-12", "2025-11", "2026-13", "26-11", "2026-1"])
def test_only_the_months_the_counters_keep(db: Any, month: str) -> None:
    deps = _deps(db)
    with pytest.raises(ApiError) as raised:
        costs.summary(deps, month)
    assert (raised.value.status, raised.value.code) == (422, "invalid_month")
    assert deps.dynamodb.keys == []


def test_the_oldest_month_is_eleven_back() -> None:
    assert costs.month_of("2025-12", date(2026, 11, 20)).previous == "2025-11"


# --- What it never reads ----------------------------------------------------------------------


def test_it_reads_no_person_no_area_and_never_scans(db: Any) -> None:
    _seed_month(db)
    deps = _deps(db)
    costs.summary(deps, "2026-11")
    keys = set(deps.dynamodb.keys)
    assert not any(k.startswith(("DAY#USER#", "DAY#AREA#", "USER#")) for k in keys)
    assert {k for k in keys if not k.startswith("DAY#")} == {"AGENT#finops", "AGENT#legal"}


def test_the_keys_come_from_the_catalogs_and_are_bounded(db: Any) -> None:
    many = {f"a{n:04d}": AgentInfo(f"A{n}", "", f"model-{n}") for n in range(700)}
    deps = _deps(db, agents=lambda: many, models=lambda: ["bad/id", SONNET])
    costs.summary(deps, "2026-11")
    agents = {k for k in deps.dynamodb.keys if k.startswith("DAY#AGENT#")}
    models = {k for k in deps.dynamodb.keys if k.startswith("DAY#MODEL#")}
    assert len(agents) == costs.MAX_AGENTS
    assert len(models) == costs.MAX_MODELS
    assert "DAY#MODEL#bad/id" not in models


def test_a_failed_read_is_a_503_without_detail(db: Any) -> None:
    deps = _deps(db, dynamodb=Counting(db, fail=True))
    with pytest.raises(ApiError) as raised:
        costs.summary(deps, "2026-11")
    assert (raised.value.status, raised.value.code) == (503, "costs_unavailable")


# --- The route ---------------------------------------------------------------------------------


@dataclass
class CostsAuthorizer(RoleAuthorizer):
    """Mirrors ``costs-view.cedar`` (``test_cedar_policies.py`` evaluates the real one)."""

    def is_allowed(self, user: Any, action: str, _rt: str, _rid: str, _agent: Any = None) -> bool:
        if action == "ViewCosts":
            allowed = bool(user.is_admin or user.role == "finops-central")
            self.decisions.append((user.user_id, action, allowed))
            return allowed
        return super().is_allowed(user, action, _rt, _rid, _agent)


@dataclass
class Env:
    client: TestClient
    db: Any
    audit: AuditLog
    now: datetime

    def get(self, token: str, month: str | None = None) -> Any:
        url = URL if month is None else f"{URL}?month={month}"
        return self.client.get(url, headers=_h(token))


@pytest.fixture
def env(db: Any, monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for token, claims in PEOPLE.items():
        monkeypatch.setitem(TOKENS, token, claims)
    _seed(db)
    audit = AuditLog(FakeFirehose(), "audit", db, "audit-index")  # type: ignore[arg-type]
    settings_store = SettingsStore(db, "settings", Decimal(5), Decimal(30))

    def factory(s: Any) -> app_module.Services:
        return app_module.Services(
            settings=s,
            verifier=FakeVerifier(),  # type: ignore[arg-type]
            authorizer=CostsAuthorizer(),  # type: ignore[arg-type]
            budgets=BudgetService(db, "budgets"),
            conversations=FakeConversations(),  # type: ignore[arg-type]
            audit=audit,
            agentcore=None,
            bedrock=FakeBedrock(),
            settings_store=settings_store,
            budget_limits=BudgetLimits(settings_store),
            probe=FakeProbe(),  # type: ignore[arg-type]
            published=FakePublished(),  # type: ignore[arg-type]
            model_catalog=FakeModelCatalog(),  # type: ignore[arg-type]
            invocation_key=KEY,
            home=HomeData(table="budgets", dynamodb=db, own=lambda _u: db),
        )

    asgi = app_module.create_app(_settings(), services_factory=factory)
    client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
    yield Env(client, db, audit, datetime.now(UTC))


def test_administrators_and_central_finops_see_the_same(env: Env) -> None:
    _turn(env.db, when=env.now, cost="1.5")
    admin, central = env.get("admin"), env.get("central")
    assert admin.status_code == central.status_code == 200
    assert admin.json() == central.json()
    body = admin.json()
    assert body["month"] == env.now.strftime("%Y-%m")
    # The budgets of the agents, for central FinOps too (D105 (c)).
    (finops,) = [r for r in body["agents"]["rows"] if r["id"] == "finops"]
    assert finops["budget"]["spent_usd"] == "1.50"


@pytest.mark.parametrize("token", ["good", "creator", "nogroup", "noarea"])
def test_anyone_else_is_refused(env: Env, token: str) -> None:
    response = env.get(token)
    assert response.status_code == 403
    assert "agents" not in response.text


def test_without_a_session_it_is_401(env: Env) -> None:
    assert env.client.get(URL).status_code == 401


def test_the_read_is_audited_as_a_read(env: Env) -> None:
    assert env.get("central").status_code == 200
    (decision,) = [
        r["detail"]
        for r in env.audit.page(
            AuditQuery(
                since=env.now - timedelta(minutes=5),
                until=env.now + timedelta(minutes=5),
                limit=100,
                event="policy.decision",
            )
        ).items
        if r["detail"]["action"] == "ViewCosts"
    ]
    assert (decision["allowed"], decision["read_only"]) == (True, True)


@pytest.mark.parametrize("month", ["2026-1", "next", "2026-11-01"])
def test_a_month_that_is_not_one_is_refused(env: Env, month: str) -> None:
    assert env.get("admin", month).status_code == 422


def test_a_month_out_of_range_is_refused(env: Env) -> None:
    response = env.get("admin", f"{env.now.year + 1}-01")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_month"


def test_reloads_are_cached_and_limited(env: Env) -> None:
    first = env.get("admin").json()
    _turn(env.db, when=env.now, cost="9")
    # The same answer for 30 seconds.
    assert env.get("admin").json() == first
    statuses = [env.get("admin").status_code for _ in range(costs.READS_PER_MINUTE)]
    assert statuses[-1] == 429
