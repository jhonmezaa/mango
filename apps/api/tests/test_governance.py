"""Gobernanza (D89; threat model ``governance-threat-model.md``): one summary of approvals,
budgets, area changes and the audit trail, each section with the permission of its own screen,
against moto DynamoDB and the release's real connector catalog."""

from __future__ import annotations

import json
import secrets
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api import governance
from mango_api.approval_policy import Tier, TierReason
from mango_api.approvals import ApprovalDeps
from mango_api.approvals_store import ApprovalRecord, ApprovalStore, Signature, Status, iso
from mango_api.audit import AuditAgentOut, AuditLog
from mango_api.budget import BudgetScope, BudgetService, current_period
from mango_api.mcp_catalog import McpCatalog
from mango_api.settings_store import BudgetLimits, SettingsStore
from mango_api.tool_policies import PolicyStore
from mango_core.knowledge import SourceStatus

from .test_admin import OU_SBX, FakeProbe, _seed, _table
from .test_app import (
    HOST,
    KEY,
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

URL = "/api/governance"
REQUESTER, APPROVER, APPROVER2 = "user-10", "user-11", "user-12"


@dataclass
class GovernanceAuthorizer(RoleAuthorizer):
    def is_allowed(self, user: Any, action: str, _rt: str, _rid: str, _agent: Any = None) -> bool:
        if action == "ViewGovernance":
            allowed = bool(user.is_admin or user.role == "finops-central")
            self.decisions.append((user.user_id, action, allowed))
            return allowed
        return super().is_allowed(user, action, _rt, _rid, _agent)


@dataclass
class Env:
    client: TestClient
    db: Any
    approvals: ApprovalStore
    settings: SettingsStore
    audit: AuditLog
    authorizer: GovernanceAuthorizer
    now: datetime
    approvals_deps: ApprovalDeps

    def request(self, by: str = REQUESTER, **changes: Any) -> ApprovalRecord:
        at = changes.pop("at", self.now)
        record = ApprovalRecord(
            approval_id=secrets.token_hex(16),
            status=Status.PENDING,
            tier=changes.pop("tier", Tier.APPROVERS),
            tier_reason=TierReason.ALWAYS,
            tool=TOOL,
            gateway_tool=GATEWAY_TOOL,
            arguments=json.dumps({"amount_usd": 100, "name": "team-a"}, separators=(",", ":")),
            args_hash="h" * 64,
            agent_id="finops",
            agent_version=3,
            conversation_id="c" * 32,
            requested_by=by,
            requested_by_email="r@x.co",
            created_at=at,
            expires_at=changes.pop("expires_at", at + timedelta(hours=24)),
            approvals_needed=changes.pop("approvals_needed", 1),
            rule={"condition": "always", "approvers": 1, "expires_hours": 24},
            **changes,
        )
        self.approvals.create(record, at)
        return record

    def get(self, token: str) -> Any:
        return self.client.get(URL, headers=_h(token))


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    # The summary reads with the real clock (``now_utc``), as the budgets screen.
    now = datetime.now(UTC)
    catalog = McpCatalog.load(CONNECTORS)
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        for name in ("settings", "budgets", "audit-index"):
            _table(db, name)
        _approvals_table(db, "approvals")
        _seed(db)
        audit = AuditLog(FakeFirehose(), "audit", db, "audit-index")  # type: ignore[arg-type]
        authorizer = GovernanceAuthorizer()
        published = FakePublished(agents={"finops": write_agent()})
        approvals = ApprovalStore(db, "approvals")
        settings_store = SettingsStore(db, "settings", Decimal(5), Decimal(30))
        deps = ApprovalDeps(
            store=approvals,
            policies=PolicyStore(db, "settings"),
            catalog=lambda: catalog,
            published=published,  # type: ignore[arg-type]
            audit=audit,
            clock=lambda: now,
        )

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
                approvals=deps,
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(client, db, approvals, settings_store, audit, authorizer, now, deps)


def _spend(env: Env, agent_id: str, spent: str) -> None:
    budgets = BudgetService(env.db, "budgets")
    period = current_period()
    scope = BudgetScope(f"AGENT#{agent_id}", Decimal(200))
    budgets.reserve([scope], Decimal(1), period)
    budgets.charge([scope], Decimal(spent), period)


def _spend_user(env: Env, user_id: str, spent: str, email: str) -> None:
    budgets = BudgetService(env.db, "budgets")
    period = current_period()
    budgets.reserve([BudgetScope(f"USER#{user_id}", Decimal(100), label=email)], Decimal(1), period)
    budgets.charge([BudgetScope(f"USER#{user_id}", Decimal(100))], Decimal(spent), period)


# --- Who reads what ---------------------------------------------------------------------------


def test_only_administrators_and_central_finops_open_it(env: Env) -> None:
    assert env.get("lead").status_code == 403
    assert env.get("nogroup").status_code == 403
    assert env.get("approver").status_code == 200
    assert env.get("admin").status_code == 200
    # The decision is audited as a read, as the other screens' views.
    (decision,) = [
        r["detail"]
        for r in env.audit.page(
            governance.AuditQuery(
                since=env.now - timedelta(minutes=5),
                until=env.now + timedelta(minutes=5),
                limit=50,
                event="policy.decision",
            )
        ).items
        if r["detail"]["action"] == "ViewGovernance" and r["user_id"] == "admin-1"
    ]
    assert decision["read_only"] is True


def test_central_finops_gets_approvals_only(env: Env) -> None:
    body = env.get("approver").json()
    assert body["approvals"] is not None
    # Budgets, area changes and the audit trail are for administrators (D17): left out, null.
    assert (body["budgets"], body["areas"], body["audit"]) == (None, None, None)


def test_an_administrator_gets_every_section(env: Env) -> None:
    body = env.get("admin").json()
    assert set(body) == {"approvals", "budgets", "areas", "audit"}
    assert all(body[k] is not None for k in body)


# --- Approvals ----------------------------------------------------------------------------------


def test_approval_counts_follow_the_approvals_screen(env: Env) -> None:
    mine = env.request()
    soon = env.request(expires_at=env.now + timedelta(minutes=30))
    own = env.request(by=APPROVER)
    signed = env.request(approvals_needed=2)
    env.approvals.sign(signed, Signature(APPROVER, "a1@x.co", env.now.isoformat()), now=env.now)
    env.request(expires_at=env.now - timedelta(minutes=1))  # expired: not pending
    env.request(tier=Tier.SELF)  # confirmed by who asked: never an approver's
    rejected = env.request()
    env.approvals.close(
        rejected, to=Status.REJECTED, actor=APPROVER2, actor_email=None, note="no", now=env.now
    )
    approved = env.request()
    env.approvals.sign(approved, Signature(APPROVER2, None, env.now.isoformat()), now=env.now)

    body = env.get("approver").json()["approvals"]
    # Pending: mine, soon, own and signed (one of two signatures). The approver can sign mine and
    # soon only: own is theirs and signed already carries their signature.
    assert (body["pending"], body["mine"], body["mine_soon"]) == (4, 2, 1)
    assert body["next_expires_at"] == iso(soon.expires_at)
    assert (body["approved_7d"], body["rejected_7d"]) == (1, 1)
    (line,) = body["policies"]
    assert line == {
        "tool": TOOL,
        "server_name": line["server_name"],
        "policy": {
            "condition": "always",
            "amount_usd": None,
            "count": None,
            "environment": None,
            "approvers": 1,
            "expires_hours": 24,
        },
        "pending": 4,
        "total": 7,
    }
    assert body["capped"] is False
    del mine, own


def test_bucket_proposals_count_as_pending_and_as_mine_when_the_caller_decides(env: Env) -> None:
    # D88 (48): the proposals of Aprobaciones for the caller; only pending ones count.
    sources = [
        SimpleNamespace(status=SourceStatus.PENDING, can_decide=True),
        SimpleNamespace(status=SourceStatus.PENDING, can_decide=False),
        SimpleNamespace(status=SourceStatus.APPROVED, can_decide=False),
    ]
    summary = governance.approvals_summary(
        env.approvals_deps,
        APPROVER,
        env.now,
        sources,  # type: ignore[arg-type]
    )
    assert (summary.pending, summary.mine, summary.next_expires_at) == (2, 1, None)


def test_the_summary_carries_no_arguments_conversations_or_emails(env: Env) -> None:
    env.request()
    text = env.get("admin").text
    for leaked in ("team-a", "c" * 32, "r@x.co", "arguments"):
        assert leaked not in text


# --- Budgets and areas --------------------------------------------------------------------------


def test_agents_over_their_threshold_and_pending_area_changes(env: Env) -> None:
    _spend(env, "abcdefghijklmnop", "150")  # 75 %: under the 80 % threshold
    _spend(env, "qrstuvwxyz234567", "210")  # 105 %
    _spend(env, "finops", "170")  # 85 %
    _spend_user(env, "user-1", "20", "lead@example.com")  # the default limit, 20: exhausted
    env.settings.create_change(
        base_version=1,
        units={"sandbox": [OU_SBX]},
        reason="Nueva área",
        proposed_by="admin-2",
        proposed_by_email=None,
        now=env.now,
    )
    body = env.get("admin").json()
    over = body["budgets"]["over_warn"]
    assert [(b["scope"], b["id"], b["exhausted"]) for b in over] == [
        ("agent", "qrstuvwxyz234567", True),
        ("user", "user-1", True),
        ("agent", "finops", False),
    ]
    assert (over[1]["name"], over[2]["spent_usd"]) == ("lead@example.com", "170.00")
    assert body["areas"] == {"pending": 1}


# --- Audit trail --------------------------------------------------------------------------------


def test_audit_count_and_recent_governance_activity(env: Env) -> None:
    env.audit.emit("settings.budget.updated", "admin-2", {"outcome": "requested"})
    env.audit.emit("settings.budget.updated", "admin-2", {"outcome": "applied"})
    env.audit.emit("agent.invoke", "user-1", {"agent": "finops"})
    env.audit.emit("approval.approve", "user-11", {"approval_id": "a" * 32, "outcome": "applied"})
    audit = env.get("admin").json()["audit"]
    assert [e["event"] for e in audit["recent"]] == [
        "approval.approve",
        "settings.budget.updated",
    ]
    # Four events, plus the request's own decision (a read: not counted).
    assert (audit["events_24h"], audit["capped"]) == (4, False)


def test_recent_activity_names_the_agent_of_approved_and_retired_events(env: Env) -> None:
    detail = {"agent": "finops", "version": 3, "created_by": "creator-1", "outcome": "applied"}
    env.audit.emit("agent.version.approved", "admin-2", detail)
    env.audit.emit("approval.approve", "user-11", {"approval_id": "a" * 32, "outcome": "applied"})
    asked: list[tuple[str, int, str | None]] = []

    def lookup(agent: str, version: int, creator: str | None) -> AuditAgentOut:
        asked.append((agent, version, creator))
        return AuditAgentOut(name="FinOps", created_by_email="creator1@example.com")

    later = datetime.now(UTC) + timedelta(seconds=1)
    recent = governance.audit_summary(env.audit, later, lookup).recent
    # Two events of the same millisecond come in the order of their random ids.
    assert {e.event: e.agent for e in recent} == {
        "approval.approve": None,
        "agent.version.approved": AuditAgentOut(
            name="FinOps", created_by_email="creator1@example.com"
        ),
    }
    assert asked == [("finops", 3, "creator-1")]
    # Without the agents table the event goes without it, as before.
    served = env.get("admin").json()["audit"]["recent"]
    assert [e["agent"] for e in served] == [None, None]


# --- Cost and failures --------------------------------------------------------------------------


def test_reloads_are_served_from_a_short_cache(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    assert env.get("approver").json()["approvals"]["pending"] == 0
    env.request()
    assert env.get("approver").json()["approvals"]["pending"] == 0
    monkeypatch.setattr(governance, "CACHE_SECONDS", 0.0)
    env.get("admin")  # another key: the cache is per person and permissions
    env.request()
    assert env.get("approver").json()["approvals"]["pending"] == 2


def test_a_loop_is_rate_limited(env: Env) -> None:
    for _ in range(governance.READS_PER_MINUTE):
        assert env.get("approver").status_code == 200
    refused = env.get("approver")
    assert refused.status_code == 429
    assert int(refused.headers["Retry-After"]) >= 1


def test_a_store_failure_is_503_without_details(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(**_: Any) -> list[ApprovalRecord]:
        raise ClientError({"Error": {"Code": "ProvisionedThroughputExceededException"}}, "Query")

    monkeypatch.setattr(env.approvals, "inbox", broken)
    response = env.get("approver")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "governance_unavailable"
