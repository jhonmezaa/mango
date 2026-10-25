"""La Actividad (D90; threat model ``activity-threat-model.md``): who sees whose activity, what
an event carries and what it never does, against moto DynamoDB."""

from __future__ import annotations

import json
import secrets
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api.activity import ActivityDeps, AgentView, TurnActivity
from mango_api.activity_store import RETENTION, ActivityStore, Origin
from mango_api.approval_policy import Tier, TierReason
from mango_api.approvals_store import ApprovalRecord, ApprovalStore, Status
from mango_api.budget import BudgetExceededError, BudgetScope, BudgetService
from mango_api.harness import ToolCall

from .test_admin import RecordingAudit, _table
from .test_app import (
    HOST,
    KEY,
    FakeBedrock,
    FakeBudgets,
    FakeConversations,
    FakeLimits,
    FakeModelCatalog,
    FakePublished,
    FakeVerifier,
    _settings,
)
from .test_approvals import _approvals_table, _h

URL = "/api/activity"
USER, ADMIN, OTHER = "user-1", "admin-1", "user-3"
TOKEN = {USER: "good", ADMIN: "admin", OTHER: "named"}


@dataclass
class ActivityAuthorizer:
    deny_activity: bool = False
    decisions: list[tuple[str, str, bool]] = field(default_factory=list)

    def is_allowed(self, user: Any, action: str, _rt: str, _rid: str, _agent: Any = None) -> bool:
        allowed = not self.deny_activity if action == "ViewActivity" else bool(user.is_admin)
        self.decisions.append((user.user_id, action, allowed))
        return allowed


@dataclass
class Clients:
    """The RLS client factory: records whose partition each call was bound to."""

    db: Any
    users: list[str] = field(default_factory=list)

    def __call__(self, user_id: str) -> Any:
        self.users.append(user_id)
        return self.db


AGENTS = {
    "finops": ("FinOps", frozenset({USER, ADMIN})),
    "security": ("Security", frozenset({ADMIN})),
}


@dataclass
class Env:
    client: TestClient
    db: Any
    clients: Clients
    store: ActivityStore
    approvals: ApprovalStore
    authorizer: ActivityAuthorizer
    audit: RecordingAudit
    now: list[float]

    def turn(
        self, user: str = USER, agent: str = "finops", task_id: str | None = None
    ) -> TurnActivity:
        origin = Origin(
            user,
            agent,
            3,
            conversation_id=None if task_id else "c" * 32,
            task_id=task_id,
            run_id="r" * 32 if task_id else None,
            task_name="Revisión diaria" if task_id else None,
        )
        return TurnActivity(self.store, origin)

    def call(self, user: str = USER, agent: str = "finops", **changes: Any) -> None:
        """One turn with one tool call, ended."""
        turn = self.turn(user, agent, task_id=changes.pop("task_id", None))
        self.now[0] += 1
        turn.call(
            ToolCall(
                name=changes.pop("tool", "cost_explorer"),
                ok=changes.pop("ok", True),
                ms=changes.pop("ms", 420),
            )
        )
        turn.end()

    def request(self, by: str, tier: Tier = Tier.APPROVERS) -> ApprovalRecord:
        at = datetime.fromtimestamp(self.now[0], UTC)
        record = ApprovalRecord(
            approval_id=secrets.token_hex(16),
            status=Status.PENDING,
            tier=tier,
            tier_reason=TierReason.ALWAYS,
            tool="create_budget",
            gateway_tool="cost-explorer___create_budget",
            arguments=json.dumps({"amount_usd": 100}),
            args_hash="h" * 64,
            agent_id="finops",
            agent_version=3,
            conversation_id="d" * 32,
            requested_by=by,
            requested_by_email="r@x.co",
            created_at=at,
            expires_at=at + timedelta(hours=24),
            approvals_needed=1,
            rule={"condition": "always", "approvers": 1, "expires_hours": 24},
        )
        self.approvals.create(record, at)
        return record

    def get(self, user: str = USER, **params: str) -> Any:
        return self.client.get(URL, headers=_h(TOKEN[user]), params=params)


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    start = datetime(2026, 10, 24, 12, tzinfo=UTC)
    now = [start.timestamp()]
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "conv")
        _table(db, "index")
        _approvals_table(db, "approvals")
        audit, authorizer = RecordingAudit(), ActivityAuthorizer()
        clients = Clients(db)
        store = ActivityStore(clients, "conv", db, "index", clock=lambda: now[0])
        approvals = ApprovalStore(db, "approvals")

        def agents(caller: Any, everyone: bool) -> list[AgentView]:
            return [
                AgentView(
                    agent_id=agent_id,
                    name=name,
                    icon="Bot",
                    color=1,
                    published=True,
                )
                for agent_id, (name, users) in AGENTS.items()
                if everyone or caller.user.user_id in users
            ]

        deps = ActivityDeps(
            store=store,
            agents=agents,
            approvals=approvals,
            clock=lambda: datetime.fromtimestamp(now[0], UTC),
        )

        def factory(s: Any) -> app_module.Services:
            return app_module.Services(
                settings=s,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=authorizer,  # type: ignore[arg-type]
                budgets=FakeBudgets(),  # type: ignore[arg-type]
                conversations=FakeConversations(),  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=None,
                bedrock=FakeBedrock(),
                settings_store=None,  # type: ignore[arg-type]
                budget_limits=FakeLimits(),  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=FakePublished(agents={}),  # type: ignore[arg-type]
                model_catalog=FakeModelCatalog(),  # type: ignore[arg-type]
                invocation_key=KEY,
                activity=deps,
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(client, db, clients, store, approvals, authorizer, audit, now)


# --- Who sees what (D90 (1)) ------------------------------------------------------------------


def test_a_person_sees_only_their_own_activity(env: Env) -> None:
    env.call(USER, tool="cost_explorer")
    env.call(OTHER, tool="list_findings", agent="security")
    page = env.get(USER).json()
    assert page["scope"] == "mine"
    tools = [e for e in page["events"] if e["kind"] in ("tool", "error")]
    assert [(e["agent_id"], e["tool"], e["ms"], e["ok"]) for e in tools] == [
        ("finops", "cost_explorer", 420, True)
    ]
    # Their own conversation is linked; nothing names the person.
    assert (tools[0]["conversation_id"], tools[0]["mine"]) == ("c" * 32, True)
    assert "user_id" not in tools[0]
    # Every read of a person went through their own row-level security client.
    assert set(env.clients.users) == {USER, OTHER}
    env.clients.users.clear()
    env.get(OTHER)
    assert env.clients.users == [OTHER]


def test_an_administrator_sees_everyone_without_their_conversations(env: Env) -> None:
    env.call(USER)
    env.call(OTHER, agent="security", ok=False, task_id="t" * 32)
    env.clients.users.clear()
    page = env.get(ADMIN).json()
    assert page["scope"] == "all"
    tools = [e for e in page["events"] if e["kind"] in ("tool", "error")]
    assert [(e["agent_id"], e["kind"], e["tool"], e["ms"]) for e in tools] == [
        ("security", "error", "cost_explorer", 420),
        ("finops", "tool", "cost_explorer", 420),
    ]
    # Not theirs: the agent, the tool, the result and the time; nothing to open (D23).
    for event in tools:
        assert not event["mine"]
        assert (event["conversation_id"], event["task_id"], event["run_id"]) == (None,) * 3
        assert event["task_name"] is None
    # Everyone's comes from the day partitions, never from someone's partition.
    assert env.clients.users == []
    # The decision that shaped the answer is audited as a read.
    assert (ADMIN, "ViewAudit", True) in env.authorizer.decisions


def test_a_person_never_gets_everyone_s_activity(env: Env) -> None:
    env.call(OTHER, agent="security")
    page = env.get(USER).json()
    assert page["scope"] == "mine"
    assert page["events"] == [] or all(e["agent_id"] == "finops" for e in page["events"])
    assert (USER, "ViewAudit", False) in env.authorizer.decisions


def test_without_view_activity_nothing_is_read(env: Env) -> None:
    env.authorizer.deny_activity = True
    assert env.get(USER).status_code == 403
    assert env.clients.users == []


def test_an_unknown_range_or_a_naive_since_is_refused(env: Env) -> None:
    assert env.get(USER, range="30d").status_code == 422
    assert env.get(USER, since="2026-10-24T12:00:00").status_code == 422
    assert env.get(USER, scope="all").status_code == 200  # unknown fields are ignored: no scope


# --- What an event carries ------------------------------------------------------------------


def test_an_event_never_carries_the_input_or_the_answer_of_a_tool(env: Env) -> None:
    env.call(USER)
    items = env.db.scan(TableName="conv")["Items"] + env.db.scan(TableName="index")["Items"]
    stored = {key for item in items for key in item}
    assert stored <= {
        "PK",
        "SK",
        "kind",
        "at",
        "user_id",
        "agent_id",
        "agent_version",
        "tool",
        "ok",
        "ms",
        "conversation_id",
        "task_id",
        "run_id",
        "ttl",
    }
    ttl = int(items[0]["ttl"]["N"])
    assert ttl == int(env.now[0] + RETENTION.total_seconds())


def test_approvals_follow_the_rule_of_the_approvals_screen(env: Env) -> None:
    own = env.request(USER, Tier.SELF)
    others = env.request(OTHER)
    env.request(OTHER, Tier.SELF)
    mine = {e["approval_id"] for e in env.get(USER).json()["events"] if e["kind"] == "approval"}
    assert mine == {own.approval_id}
    # An administrator: their own and those that need approvers, never someone's self tier.
    everyone = {
        e["approval_id"] for e in env.get(ADMIN).json()["events"] if e["kind"] == "approval"
    }
    assert everyone == {others.approval_id}
    event = next(e for e in env.get(USER).json()["events"] if e["kind"] == "approval")
    assert (event["tool"], event["approval_status"], event["conversation_id"]) == (
        "create_budget",
        "pending",
        None,
    )


def test_the_agents_of_the_scope_and_the_retention(env: Env) -> None:
    page = env.get(USER).json()
    assert [a["id"] for a in page["agents"]] == ["finops"]
    assert page["retention_days"] == 30
    # An administrator counts every published agent («de {n} publicados»).
    assert {a["id"] for a in env.get(ADMIN).json()["agents"]} == {"finops", "security"}


def test_the_owner_s_task_is_named_and_linked(env: Env) -> None:
    env.call(USER, task_id="t" * 32)
    (event,) = env.get(USER).json()["events"]
    assert (event["task_id"], event["run_id"], event["task_name"]) == (
        "t" * 32,
        "r" * 32,
        "Revisión diaria",
    )
    assert event["conversation_id"] is None
    # Never in the copy an administrator reads.
    assert all("task_name" not in i for i in env.db.scan(TableName="index")["Items"])


def test_someone_else_s_turn_reaches_an_administrator_once_it_ends(env: Env) -> None:
    turn = env.turn(OTHER, "security")
    turn.call(ToolCall(name="list_findings", ok=True, ms=300))
    # The person sees it at once; an administrator, not yet.
    assert [e["tool"] for e in env.get(OTHER).json()["events"]] == ["list_findings"]
    assert env.get(ADMIN).json()["events"] == []
    turn.end()
    (event,) = env.get(ADMIN).json()["events"]
    assert (event["tool"], event["at"]) == (
        "list_findings",
        env.get(OTHER).json()["events"][0]["at"],
    )


def test_the_range_and_the_live_mode(env: Env) -> None:
    env.call(USER, tool="old")
    env.now[0] += 2 * 3600
    env.call(USER, tool="new")
    hour = [e["tool"] for e in env.get(USER, range="1h").json()["events"] if e["kind"] == "tool"]
    assert hour == ["new"]
    day = env.get(USER).json()["events"]
    last = next(e for e in day if e["tool"] == "new")["at"]
    env.call(USER, tool="newer")
    live = env.get(USER, since=last).json()["events"]
    assert [e["tool"] for e in live] == ["newer"]


def test_the_answer_is_bounded(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    from mango_api import activity  # noqa: PLC0415

    monkeypatch.setattr(activity, "MAX_EVENTS", 2)
    for _ in range(3):
        env.call(USER)
    page = env.get(USER).json()
    assert (len(page["events"]), page["truncated"]) == (2, True)


def test_a_loop_of_reads_is_limited(env: Env) -> None:
    for _ in range(60):
        assert env.get(USER).status_code == 200
    refused = env.get(USER)
    assert refused.status_code == 429
    assert "Retry-After" in refused.headers


def test_a_failure_to_write_never_breaks_the_turn(caplog: pytest.LogCaptureFixture) -> None:
    class Broken:
        def put_item(self, **_kwargs: Any) -> None:
            raise RuntimeError("secret-input")

    store = ActivityStore(lambda _u: Broken(), "conv", Broken(), "index")  # type: ignore[arg-type]
    turn = TurnActivity(store, Origin(USER, "finops", 3))
    turn.call(ToolCall(name="t", ok=True, ms=1))
    turn.budget_blocked()
    turn.end()
    assert "an activity event could not be written" in caplog.text


# --- The budget that stopped a turn (D90 (4)) -----------------------------------------------


def test_the_scope_that_ran_out_is_known() -> None:
    from decimal import Decimal  # noqa: PLC0415

    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "budgets")
        service = BudgetService(db, "budgets")
        scopes = [
            BudgetScope(f"USER#{USER}", Decimal(10)),
            BudgetScope("AGENT#finops", Decimal(10)),
        ]
        service.reserve(scopes, Decimal(9), "2026-10")
        # The person still has room; the agent does too, until another person spends it.
        service.reserve([BudgetScope("AGENT#finops", Decimal(10))], Decimal("0.5"), "2026-10")
        with pytest.raises(BudgetExceededError) as raised:
            service.reserve(
                [BudgetScope(f"USER#{OTHER}", Decimal(10)), scopes[1]], Decimal(1), "2026-10"
            )
        assert raised.value.scope == "AGENT#finops"
        with pytest.raises(BudgetExceededError) as precheck:
            service.reserve(scopes, Decimal(11), "2026-10")
        assert precheck.value.scope == f"USER#{USER}"


# --- Wiring: the turns of the chat write what the agents do ----------------------------------


@dataclass
class AgentBudgetOut(FakeBudgets):
    def reserve(self, *_args: Any, **_kwargs: Any) -> None:
        raise BudgetExceededError("AGENT#finops")


@pytest.mark.parametrize("blocked", [False, True])
def test_a_chat_turn_records_its_tool_calls_and_its_agent_budget(
    monkeypatch: pytest.MonkeyPatch, blocked: bool
) -> None:
    from .test_app import FakeAgentCore, FakeAudit, FakeAuthorizer  # noqa: PLC0415

    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "conv")
        _table(db, "index")
        store = ActivityStore(Clients(db), "conv", db, "index")
        audit = FakeAudit()

        def factory(s: Any) -> app_module.Services:
            return app_module.Services(
                settings=s,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=FakeAuthorizer(),  # type: ignore[arg-type]
                budgets=AgentBudgetOut() if blocked else FakeBudgets(),  # type: ignore[arg-type]
                conversations=FakeConversations(),  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=FakeAgentCore(),
                bedrock=FakeBedrock(),
                settings_store=None,  # type: ignore[arg-type]
                budget_limits=FakeLimits(),  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=FakePublished(),  # type: ignore[arg-type]
                model_catalog=FakeModelCatalog(),  # type: ignore[arg-type]
                invocation_key=KEY,
                activity=ActivityDeps(
                    store=store,
                    agents=lambda _c, _e: [],
                    approvals=None,
                    clock=lambda: datetime.now(UTC),
                ),
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        response = client.post("/api/chat", headers=_h("good"), json={"message": "hola"})
        assert response.status_code == (402 if blocked else 200)
        records, _ = store.mine(
            USER,
            since=datetime.now(UTC) - timedelta(minutes=1),
            until=datetime.now(UTC) + timedelta(minutes=1),
            limit=10,
        )
        (record,) = records
        if blocked:
            assert (record.kind, record.tool, record.agent_id) == ("budget", None, "finops")
            detail = next(
                d
                for e, d in zip(audit.events, audit.details, strict=True)
                if e == "budget.exceeded"
            )
            assert detail["scope"] == "agent"
        else:
            assert (record.kind, record.tool, record.ok) == ("tool", "get_cost_and_usage", True)
            assert record.conversation_id is not None


def test_a_since_in_the_future_is_an_empty_answer(env: Env) -> None:
    env.call(USER)
    for user in (USER, ADMIN):
        response = env.get(user, since="2030-01-01T00:00:00+00:00")
        assert (response.status_code, response.json()["events"]) == (200, [])
