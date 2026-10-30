"""Inicio (D102; threat model ``home-threat-model.md``): spend and turns per day for the
organization, an area or the caller, decided by the server, against moto DynamoDB and the
real day counters written by closing turns."""

from __future__ import annotations

import json
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
from mango_api import home
from mango_api.approval_policy import Tier, TierReason
from mango_api.approvals import ApprovalDeps
from mango_api.approvals_store import ApprovalRecord, ApprovalStore, Status
from mango_api.audit import AuditLog, AuditQuery
from mango_api.budget import BudgetScope, BudgetService, current_period
from mango_api.conversations import RlsClientFactory
from mango_api.home import HomeData
from mango_api.mcp_catalog import McpCatalog
from mango_api.settings_store import BudgetLimits, SettingsStore
from mango_api.tool_policies import PolicyStore
from mango_core.budget_turns import PendingTurn, TurnPrice

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
from .test_approvals import (
    CONNECTORS,
    GATEWAY_TOOL,
    TOOL,
    RoleAuthorizer,
    _approvals_table,
    _h,
    write_agent,
)
from .test_audit import FakeFirehose

URL = "/api/home"
EXP = int(time.time()) + 3600
PEOPLE = {
    # Central FinOps without administrator: the organization, and only their own budget.
    "central": {"sub": "user-20", "mango_role": "finops-central", "exp": EXP},
    # The leader of another area.
    "sales": {
        "sub": "user-21",
        "mango_role": "bu-lead",
        "mango_business_unit": "sales",
        "mango_email": "sales@example.com",
        "exp": EXP,
    },
    # A person in a group of no area.
    "plain": {
        "sub": "user-23",
        "mango_email": "plain@example.com",
        "cognito:groups": ["hr"],
        "exp": EXP,
    },
    # A person of the security area who leads nothing: their own numbers only.
    "member": {
        "sub": "user-22",
        "mango_business_unit": "security",
        "mango_email": "member@example.com",
        "cognito:groups": ["bu-security"],
        "exp": EXP,
    },
}
PRICE = TurnPrice(Decimal(3), Decimal(15))


@dataclass
class HomeAuthorizer(RoleAuthorizer):
    """Mirrors ``home-*.cedar`` (``test_cedar_policies.py`` evaluates the real ones)."""

    def is_allowed(self, user: Any, action: str, _rt: str, _rid: str, _agent: Any = None) -> bool:
        if action in ("ViewHome", "ViewOrgUsage", "ViewAreaUsage"):
            allowed = {
                "ViewHome": True,
                "ViewOrgUsage": bool(user.is_admin or user.role == "finops-central"),
                "ViewAreaUsage": user.role == "bu-lead" and bool(user.business_unit),
            }[action]
            self.decisions.append((user.user_id, action, allowed))
            return allowed
        return super().is_allowed(user, action, _rt, _rid, _agent)


@dataclass
class OwnKeys:
    """What the row-level security session of one person allows on the Budgets table: their
    two keys, read only. Any other key is refused, as STS would."""

    db: Any
    user_id: str
    reads: list[str] = field(default_factory=list)

    def _check(self, key: str) -> None:
        self.reads.append(key)
        if key not in (f"USER#{self.user_id}", f"DAY#USER#{self.user_id}"):
            raise PermissionError(f"AccessDenied: {key}")

    def get_item(self, **request: Any) -> Any:
        self._check(request["Key"]["PK"]["S"])
        return self.db.get_item(**request)

    def query(self, **request: Any) -> Any:
        self._check(request["ExpressionAttributeValues"][":pk"]["S"])
        return self.db.query(**request)


@dataclass
class Counting:
    """mango-api's own client, counting the queries of the day counters."""

    db: Any
    queries: list[str] = field(default_factory=list)
    fail: bool = False

    def query(self, **request: Any) -> Any:
        if self.fail:
            raise RuntimeError("dynamodb down")
        self.queries.append(request["ExpressionAttributeValues"][":pk"]["S"])
        return self.db.query(**request)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.db, name)


@dataclass
class Env:
    client: TestClient
    db: Any
    audit: AuditLog
    authorizer: HomeAuthorizer
    own: dict[str, OwnKeys]
    counting: Counting
    approvals: ApprovalStore
    now: datetime

    def get(self, token: str, period: str | None = None) -> Any:
        url = URL if period is None else f"{URL}?period={period}"
        return self.client.get(url, headers=_h(token))

    def turn(self, user_id: str, cost: str, area: str | None = None, days_ago: int = 0) -> None:
        """A turn that ran and cost ``cost``: reserved and settled as the chat does."""
        started = int((self.now - timedelta(days=days_ago)).timestamp())
        budgets = BudgetService(self.db, "budgets")
        scopes = [
            BudgetScope(f"USER#{user_id}", Decimal(100)),
            BudgetScope("AGENT#finops", Decimal(200)),
        ]
        pending = PendingTurn.new(
            turn_id=secrets.token_hex(16),
            user_id=user_id,
            agent_id="finops",
            agent_version=3,
            model="m",
            conversation_id="c" * 32,
            period=current_period(),
            scopes=tuple(s.key for s in scopes),
            reserved=Decimal(1),
            price=PRICE,
            started_at=started,
            timeout_seconds=60,
            area=area,
        )
        budgets.reserve(scopes, Decimal(1), current_period(), pending)
        assert budgets.settle_turn(pending, Decimal(cost))


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    for token, claims in PEOPLE.items():
        monkeypatch.setitem(TOKENS, token, claims)
    now = datetime.now(UTC)
    catalog = McpCatalog.load(CONNECTORS)
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        for name in ("settings", "budgets", "audit-index"):
            _table(db, name)
        _approvals_table(db, "approvals")
        _seed(db)
        audit = AuditLog(FakeFirehose(), "audit", db, "audit-index")  # type: ignore[arg-type]
        authorizer = HomeAuthorizer()
        published = FakePublished(agents={"finops": write_agent()})
        approvals = ApprovalStore(db, "approvals")
        settings_store = SettingsStore(db, "settings", Decimal(5), Decimal(30))
        approval_deps = ApprovalDeps(
            store=approvals,
            policies=PolicyStore(db, "settings"),
            catalog=lambda: catalog,
            published=published,  # type: ignore[arg-type]
            audit=audit,
            clock=lambda: now,
        )
        own: dict[str, OwnKeys] = {}
        counting = Counting(db)

        def own_client(user_id: str) -> Any:
            return own.setdefault(user_id, OwnKeys(db, user_id))

        def factory(s: Any) -> app_module.Services:
            return app_module.Services(
                settings=s,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=authorizer,  # type: ignore[arg-type]
                budgets=BudgetService(db, "budgets"),
                conversations=FakeConversations(),  # type: ignore[arg-type]
                audit=audit,
                agentcore=None,
                bedrock=FakeBedrock(),
                settings_store=settings_store,
                budget_limits=BudgetLimits(settings_store),
                probe=FakeProbe(),  # type: ignore[arg-type]
                published=published,  # type: ignore[arg-type]
                model_catalog=FakeModelCatalog(),  # type: ignore[arg-type]
                invocation_key=KEY,
                approvals=approval_deps,
                home=HomeData(table="budgets", dynamodb=counting, own=own_client),  # type: ignore[arg-type]
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(client, db, audit, authorizer, own, counting, approvals, now)


def _total(days: list[dict[str, Any]]) -> tuple[Decimal, int]:
    return sum((Decimal(d["spent_usd"]) for d in days), Decimal(0)), sum(d["turns"] for d in days)


def _seed_turns(env: Env) -> None:
    env.turn("user-1", "1.5", area="security")  # the security lead
    env.turn("user-22", "0.25", area="security")  # a person of security
    env.turn("user-21", "4", area="sales")  # the sales lead
    env.turn("user-23", "0.5")  # nobody's area
    env.turn("user-22", "0.75", area="security", days_ago=40)  # the period before


# --- Who reads what ---------------------------------------------------------------------------


def test_anyone_signed_in_opens_it_and_the_read_is_audited(env: Env) -> None:
    for token in ("admin", "central", "good", "sales", "member", "plain"):
        assert env.get(token).status_code == 200, token
    assert env.client.get(URL).status_code == 401
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
        if r["detail"]["action"] == "ViewHome" and r["user_id"] == "user-22"
    ]
    assert decision["read_only"] is True


def test_administrators_and_central_finops_see_the_organization(env: Env) -> None:
    _seed_turns(env)
    for token in ("admin", "central"):
        body = env.get(token).json()
        assert (body["scope"], body["area"]) == ("org", None)
        assert _total(body["days"]) == (Decimal("6.25"), 4)
        assert _total(body["previous"]) == (Decimal("0.75"), 1)
    # The organization's counter is read with mango-api's own role; a person's session only
    # reads central FinOps' own budget.
    assert set(env.counting.queries) == {"DAY#ORG"}
    assert {user: set(o.reads) for user, o in env.own.items()} == {"user-20": {"USER#user-20"}}


def test_a_lead_sees_their_area_and_nothing_of_another(env: Env) -> None:
    _seed_turns(env)
    security = env.get("good").json()
    assert (security["scope"], security["area"]) == ("area", "security")
    assert _total(security["days"]) == (Decimal("1.75"), 2)
    sales = env.get("sales").json()
    assert (sales["scope"], sales["area"]) == ("area", "sales")
    assert _total(sales["days"]) == (Decimal("4"), 1)
    # Each lead reads their own area's counter and the first day of the organization's.
    assert [q for q in env.counting.queries if q != "DAY#ORG"] == [
        "DAY#AREA#security",
        "DAY#AREA#sales",
    ]


def test_a_person_sees_only_their_own_through_row_level_security(env: Env) -> None:
    _seed_turns(env)
    body = env.get("member").json()
    # In an area group, but not its leader: their own numbers, not the area's.
    assert (body["scope"], body["area"]) == ("mine", None)
    assert _total(body["days"]) == (Decimal("0.25"), 1)
    assert _total(body["previous"]) == (Decimal("0.75"), 1)
    # Only their two keys, and only through their own session.
    assert set(env.own["user-22"].reads) == {"DAY#USER#user-22", "USER#user-22"}
    assert not any(q.startswith(("DAY#USER#", "DAY#AREA#")) for q in env.counting.queries)
    nobody = env.get("plain").json()
    assert nobody["scope"] == "mine"
    assert _total(nobody["days"]) == (Decimal("0.5"), 1)
    assert set(env.own["user-23"].reads) == {"DAY#USER#user-23", "USER#user-23"}


def test_without_an_allow_the_scope_falls_back_to_the_callers_own(env: Env) -> None:
    _seed_turns(env)

    def deny(user: Any, action: str, *args: Any, **kwargs: Any) -> bool:
        return action == "ViewHome"

    env.authorizer.is_allowed = deny  # type: ignore[method-assign]
    body = env.get("admin").json()
    assert (body["scope"], body["budgets_scope"]) == ("mine", "mine")
    assert set(env.own["admin-1"].reads) == {"DAY#USER#admin-1", "USER#admin-1"}


def test_a_lead_without_their_area_in_the_token_gets_their_own(env: Env) -> None:
    def no_area(user: Any, action: str, *args: Any, **kwargs: Any) -> bool:
        # Even if a policy allowed it, an area the token does not name is never read.
        return action in ("ViewHome", "ViewAreaUsage")

    env.authorizer.is_allowed = no_area  # type: ignore[method-assign]
    assert env.get("plain").json()["scope"] == "mine"


# --- Budgets and approvals ------------------------------------------------------------------


def test_administrators_get_the_agents_closest_to_their_limit(env: Env) -> None:
    budgets = BudgetService(env.db, "budgets")
    period = current_period()
    for index, spent in enumerate(("10", "150", "60", "199", "5")):
        scope = BudgetScope(f"AGENT#agent{index}", Decimal(200))
        budgets.reserve([scope], Decimal(1), period)
        budgets.charge([scope], Decimal(spent), period)
    body = env.get("admin").json()
    assert body["budgets_scope"] == "agents"
    assert [b["spent_usd"] for b in body["budgets"]] == ["199.00", "150.00", "60.00", "10.00"]
    assert {b["scope"] for b in body["budgets"]} == {"agent"}


def test_anyone_else_gets_only_their_own_budget(env: Env) -> None:
    env.turn("user-22", "3.25", area="security")
    env.turn("user-21", "9", area="sales")
    for token, user_id, spent in (("member", "user-22", "3.25"), ("central", "user-20", "0.00")):
        body = env.get(token).json()
        assert body["budgets_scope"] == "mine"
        (own,) = body["budgets"]
        assert (own["scope"], own["id"], own["spent_usd"]) == ("user", user_id, spent)
        # The default limit of the settings seed.
        assert own["limit_usd"] == "20.00"


def test_approvals_count_what_waits_for_the_callers_signature(env: Env) -> None:
    for requested_by in ("user-10", "admin-1"):
        env.approvals.create(
            ApprovalRecord(
                approval_id=secrets.token_hex(16),
                status=Status.PENDING,
                tier=Tier.APPROVERS,
                tier_reason=TierReason.ALWAYS,
                tool=TOOL,
                gateway_tool=GATEWAY_TOOL,
                arguments=json.dumps({"amount_usd": 100}),
                args_hash="h" * 64,
                agent_id="finops",
                agent_version=3,
                conversation_id="c" * 32,
                requested_by=requested_by,
                requested_by_email="r@x.co",
                created_at=env.now,
                expires_at=env.now + timedelta(hours=24),
                approvals_needed=1,
                rule={"condition": "always", "approvers": 1, "expires_hours": 24},
            ),
            env.now,
        )
    # Never what they asked for themselves.
    assert env.get("admin").json()["approvals"] == 1
    assert env.get("central").json()["approvals"] == 2
    # Who may not sign gets what they may decide, nothing of the approvers' requests.
    assert env.get("member").json()["approvals"] == 0


# --- Period, limits and cache -----------------------------------------------------------------


@pytest.mark.parametrize("period", ["7d", "30d", "90d", "180d"])
def test_every_day_of_the_period_and_the_one_before(env: Env, period: str) -> None:
    body = env.get("admin", period).json()
    count = int(period.removesuffix("d"))
    assert body["period"] == period
    assert len(body["days"]) == len(body["previous"]) == count
    today = env.now.date()
    assert body["days"][-1]["day"] == today.isoformat()
    assert date.fromisoformat(body["previous"][-1]["day"]) == today - timedelta(days=count)
    assert all(d == {"day": d["day"], "spent_usd": "0.000000", "turns": 0} for d in body["days"])
    # Only one query for both periods.
    assert env.counting.queries.count("DAY#ORG") == 2  # the series and the first day


def test_the_period_is_a_closed_list(env: Env) -> None:
    for bad in ("365d", "1d", "30", "' OR 1=1"):
        response = env.get("admin", bad)
        assert response.status_code == 422, bad
    assert env.get("admin").json()["period"] == "30d"


def test_counted_since_is_the_first_day_of_the_organizations_counter(env: Env) -> None:
    assert env.get("admin").json()["counted_since"] is None
    env.turn("user-23", "0.5", days_ago=3)
    # The cache is per person and period: another period reads again.
    body = env.get("admin", "7d").json()
    assert body["counted_since"] == (env.now.date() - timedelta(days=3)).isoformat()


def test_reads_are_limited_per_person(env: Env) -> None:
    for _ in range(home.READS_PER_MINUTE):
        assert env.get("member").status_code == 200
    limited = env.get("member")
    assert limited.status_code == 429
    assert "Retry-After" in limited.headers
    assert env.get("good").status_code == 200


def test_a_reload_is_served_from_the_cache_per_person_and_period(env: Env) -> None:
    env.get("admin")
    env.get("admin")
    assert env.counting.queries.count("DAY#ORG") == 2
    env.get("admin", "7d")
    assert env.counting.queries.count("DAY#ORG") == 4


def test_a_failure_is_a_503_without_details(env: Env) -> None:
    env.counting.fail = True
    response = env.get("admin")
    assert response.status_code == 503
    assert response.json() == {"error": {"code": "home_unavailable", "message": "please try again"}}


# --- Row-level security session ---------------------------------------------------------------


def test_the_session_policy_reads_only_the_persons_budget_keys() -> None:
    factory = RlsClientFactory(
        boto3.client("sts", region_name="us-east-1"),
        role_arn="arn:aws:iam::111122223333:role/Mango-test-ConversationData",
        table_arn="arn:aws:dynamodb:us-east-1:111122223333:table/Mango-test-Conversations",
        key_arn="arn:aws:kms:us-east-1:111122223333:key/1",
        region="us-east-1",
        budgets_table_arn="arn:aws:dynamodb:us-east-1:111122223333:table/Mango-test-Budgets",
    )
    statements = json.loads(factory.session_policy("user-22"))["Statement"]
    (budgets,) = [s for s in statements if s["Resource"].endswith("table/Mango-test-Budgets")]
    assert sorted(budgets["Action"]) == ["dynamodb:GetItem", "dynamodb:Query"]
    assert budgets["Condition"] == {
        "ForAllValues:StringEquals": {"dynamodb:LeadingKeys": ["USER#user-22", "DAY#USER#user-22"]}
    }
    assert (
        app_module._sibling_table_arn(
            "arn:aws:dynamodb:us-east-1:111122223333:table/Mango-test-Conversations",
            "Mango-test-Budgets",
        )
        == "arn:aws:dynamodb:us-east-1:111122223333:table/Mango-test-Budgets"
    )
