"""Admin v0 endpoints (D17) against moto DynamoDB: real conditions and transactions."""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api.budget import BudgetScope, BudgetService, current_period
from mango_api.probe import (
    Connectivity,
    MemberAccess,
    MemberAccounts,
    Organization,
    ProbeError,
)
from mango_api.settings_store import BudgetLimits, SettingsStore
from mango_core.identity import IdentityError

from .test_app import (
    HOST,
    FakeAgentCore,
    FakeBedrock,
    FakeConversations,
    FakeModelCatalog,
    FakePublished,
    _settings,
)

OU_SEC = "ou-abcd-22222222"
OU_SBX = "ou-abcd-11111111"
OU_NEW = "ou-abcd-33333333"
EXP = int(time.time()) + 3600
TOKENS: dict[str, dict[str, Any]] = {
    "admin": {"sub": "admin-1", "mango_role": "finops-central", "mango_admin": "true"},
    "admin2": {"sub": "admin-2", "mango_role": "finops-central", "mango_admin": "true"},
    "sec-admin": {
        "sub": "admin-3",
        "mango_role": "bu-lead",
        "mango_business_unit": "security",
        "mango_admin": "true",
        "mango_email": "sec@example.com",
    },
    "user": {"sub": "user-1", "mango_role": "bu-lead", "mango_business_unit": "security"},
}


class FakeVerifier:
    def verify(self, token: str) -> dict[str, Any]:
        if token not in TOKENS:
            raise IdentityError("invalid")
        return {**TOKENS[token], "exp": EXP}


@dataclass
class CedarLikeAuthorizer:
    """Mirrors the platform policies: admin actions require isAdmin."""

    decisions: list[tuple[str, str, bool]] = field(default_factory=list)

    def is_allowed(self, user: Any, action: str, _rt: str, _rid: str) -> bool:
        allowed = bool(user.is_admin)
        self.decisions.append((user.user_id, action, allowed))
        return allowed


@dataclass
class RecordingAudit:
    events: list[tuple[str, str, dict[str, Any]]] = field(default_factory=list)
    actors: list[Any] = field(default_factory=list)
    fail_outcomes: set[str] = field(default_factory=set)

    def emit(self, event: str, user: str, detail: dict[str, Any], actor: Any = None) -> None:
        if detail.get("outcome") in self.fail_outcomes:
            raise RuntimeError("firehose unavailable")
        self.events.append((event, user, detail))
        self.actors.append(actor)

    def named(self, name: str, outcome: str | None = "applied") -> list[tuple[str, dict[str, Any]]]:
        return [
            (u, d)
            for e, u, d in self.events
            if e == name and (outcome is None or d.get("outcome") == outcome)
        ]


MEMBER_CHECK_NAMES = ("read_broker", "member_role", "account", "source_identity_required")


def _member_checks(**failed: str) -> list[dict[str, str]]:
    """The probe's four checks, all ``ok`` except ``failed`` (name -> detail)."""
    return [
        {
            "name": name,
            "status": "error" if name in failed else "ok",
            "detail": failed.get(name, "ok"),
        }
        for name in MEMBER_CHECK_NAMES
    ]


@dataclass
class FakeProbe:
    ous: list[str] = field(default_factory=lambda: [OU_SEC, OU_SBX, OU_NEW])
    fail: bool = False
    calls: list[tuple[str, str]] = field(default_factory=list)
    members: list[tuple[str, str]] = field(default_factory=list)
    truncated: bool = False
    total: int | None = None
    member_checks: dict[str, list[dict[str, str]]] = field(default_factory=dict)
    broken: set[str] = field(default_factory=set)
    member_calls: list[tuple[str, str]] = field(default_factory=list)

    def organization(self, actor: str) -> Organization:
        self.calls.append(("organization", actor))
        if self.fail:
            raise ProbeError("down")
        return Organization.model_validate(
            {
                "ous": [
                    {"id": ou, "name": f"<img src=x>{ou}", "parent_id": "r-abcd", "path": [ou]}
                    for ou in self.ous
                ]
            }
        )

    def connectivity(self, actor: str) -> Connectivity:
        self.calls.append(("connectivity", actor))
        return Connectivity.model_validate(
            {"checks": [{"name": "broker", "status": "ok", "detail": "ok"}]}
        )

    def member_accounts(self, actor: str) -> MemberAccounts:
        self.calls.append(("member_accounts", actor))
        if self.fail:
            raise ProbeError("down")
        return MemberAccounts.model_validate(
            {
                "accounts": [{"id": i, "name": name} for i, name in self.members],
                "truncated": self.truncated,
                **({} if self.total is None else {"total": self.total}),
            }
        )

    def member_access(self, actor: str, account_id: str) -> MemberAccess:
        self.member_calls.append((actor, account_id))
        if account_id in self.broken:
            raise ProbeError("down")
        return MemberAccess.model_validate(
            {"checks": self.member_checks.get(account_id, _member_checks())}
        )


def _table(db: Any, name: str) -> None:
    db.create_table(
        TableName=name,
        KeySchema=[
            {"AttributeName": "PK", "KeyType": "HASH"},
            {"AttributeName": "SK", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "PK", "AttributeType": "S"},
            {"AttributeName": "SK", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )


@dataclass
class Env:
    client: TestClient
    db: Any
    store: SettingsStore
    audit: RecordingAudit
    authorizer: CedarLikeAuthorizer
    probe: FakeProbe


def _seed(db: Any) -> None:
    # What the IaC seed custom resource writes (put-if-absent).
    db.put_item(
        TableName="settings",
        Item={
            "PK": {"S": "BUDGETS"},
            "SK": {"S": "DEFAULTS"},
            "user_monthly_usd": {"N": "20"},
            "agent_monthly_usd": {"N": "200"},
            "version": {"N": "1"},
        },
    )
    db.put_item(
        TableName="settings",
        Item={
            "PK": {"S": "BU_MAPPING"},
            "SK": {"S": "CURRENT"},
            "units": {"S": f'{{"sandbox":["{OU_SBX}"],"security":["{OU_SEC}"]}}'},
            "version": {"N": "1"},
        },
    )


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "settings")
        _table(db, "budgets")
        _seed(db)
        settings = _settings()
        store = SettingsStore(db, "settings", Decimal(5), Decimal(30))
        audit, authorizer, probe = RecordingAudit(), CedarLikeAuthorizer(), FakeProbe()
        budgets = BudgetService(db, "budgets")

        def factory(s: Any) -> app_module.Services:
            return app_module.Services(
                settings=s,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=authorizer,  # type: ignore[arg-type]
                budgets=budgets,
                conversations=FakeConversations(),  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=FakeAgentCore(),
                bedrock=FakeBedrock(),
                settings_store=store,
                budget_limits=BudgetLimits(store),
                probe=probe,  # type: ignore[arg-type]
                published=FakePublished(),  # type: ignore[arg-type]
                model_catalog=FakeModelCatalog(),  # type: ignore[arg-type]
                invocation_key=b"k" * 32,
            )

        asgi = app_module.create_app(settings, services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(client, db, store, audit, authorizer, probe)


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _code(response: Any) -> str:
    return str(response.json()["error"]["code"])


ENDPOINTS: list[tuple[str, str, dict[str, Any] | None, str]] = [
    ("GET", "/api/admin/budgets", None, "ViewAdmin"),
    (
        "PUT",
        "/api/admin/budgets/defaults",
        {"version": 1, "user_monthly_usd": "1", "agent_monthly_usd": "1"},
        "ManageBudgets",
    ),
    ("PUT", "/api/admin/budgets/users/u9", {"version": 1, "limit_usd": "1"}, "ManageBudgets"),
    ("GET", "/api/admin/business-units", None, "ViewAdmin"),
    (
        "POST",
        "/api/admin/business-units/changes",
        {"base_version": 1, "units": {"sandbox": [OU_NEW]}, "reason": "x"},
        "ProposeBusinessUnits",
    ),
    ("POST", f"/api/admin/business-units/changes/{'a' * 32}/approve", {}, "ApproveBusinessUnits"),
    (
        "POST",
        f"/api/admin/business-units/changes/{'a' * 32}/reject",
        {"reason": "no"},
        "ApproveBusinessUnits",
    ),
    (
        "POST",
        f"/api/admin/business-units/changes/{'a' * 32}/withdraw",
        {},
        "ProposeBusinessUnits",
    ),
    ("GET", "/api/admin/organization", None, "ViewAdmin"),
    ("POST", "/api/admin/connectivity-check", {}, "ViewAdmin"),
    ("POST", "/api/admin/member-access-check", {}, "ViewAdmin"),
]


@pytest.mark.parametrize(("method", "path", "body", "action"), ENDPOINTS)
def test_every_endpoint_requires_its_admin_action(
    env: Env, method: str, path: str, body: dict[str, Any] | None, action: str
) -> None:
    assert env.client.request(method, path, json=body).status_code == 401
    response = env.client.request(method, path, json=body, headers=_h("user"))
    assert response.status_code == 403
    assert env.authorizer.decisions == [("user-1", action, False)]
    assert ("policy.decision", "user-1") in [(e, u) for e, u, _ in env.audit.events]
    # Nothing was written or probed.
    assert [e for e, _, _ in env.audit.events] == ["policy.decision"]
    assert env.probe.calls == []
    assert env.probe.member_calls == []


# --- Budgets ----------------------------------------------------------------------------


def _usage(env: Env, user: str, spent: str, email: str | None) -> None:
    budgets = BudgetService(env.db, "budgets")
    period = current_period()
    budgets.reserve([BudgetScope(f"USER#{user}", Decimal(100), label=email)], Decimal(1), period)
    budgets.settle([BudgetScope(f"USER#{user}", Decimal(100))], Decimal(1), Decimal(spent), period)


def test_get_budgets_lists_defaults_agents_and_users(env: Env) -> None:
    _usage(env, "user-1", "1.5", "lead@example.com")
    body = env.client.get("/api/admin/budgets", headers=_h("admin")).json()
    assert body["period"] == current_period()
    assert body["version"] == 1
    assert body["defaults"] == {"user_monthly_usd": "20.00", "agent_monthly_usd": "200.00"}
    assert body["agents"] == [
        {"agent_id": "finops", "name": None, "limit_usd": "200.00", "spent_usd": "0.00"}
    ]
    assert body["users"] == [
        {
            "user_id": "user-1",
            "email": "lead@example.com",
            "limit_usd": "20.00",
            "override": False,
            "spent_usd": "1.50",
        }
    ]


def test_get_budgets_lists_every_agent_with_spend(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    budgets = BudgetService(env.db, "budgets")
    period = current_period()
    for key, spent in (
        ("AGENT#abcdefghijklmnop", "3.25"),
        ("AGENT#qrstuvwxyz234567", "0.5"),
        # Not an agent id: never listed, whatever wrote it.
        ("AGENT#<img src=x>", "9"),
    ):
        budgets.reserve([BudgetScope(key, Decimal(200))], Decimal(1), period)
        budgets.settle([BudgetScope(key, Decimal(200))], Decimal(1), Decimal(spent), period)
    names = {"qrstuvwxyz234567": "Ahorros", "finops": "FinOps"}
    monkeypatch.setattr(app_module, "_agent_names", lambda _services: names)

    agents = env.client.get("/api/admin/budgets", headers=_h("admin")).json()["agents"]
    # The release agent first, then by name; an agent without a known name shows its id.
    assert agents == [
        {"agent_id": "finops", "name": "FinOps", "limit_usd": "200.00", "spent_usd": "0.00"},
        {
            "agent_id": "abcdefghijklmnop",
            "name": None,
            "limit_usd": "200.00",
            "spent_usd": "3.25",
        },
        {
            "agent_id": "qrstuvwxyz234567",
            "name": "Ahorros",
            "limit_usd": "200.00",
            "spent_usd": "0.50",
        },
    ]


def test_budgets_are_listed_without_agent_names_when_they_cannot_be_read(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(_services: Any) -> dict[str, str]:
        raise RuntimeError("agents table unavailable")

    monkeypatch.setattr(app_module, "_agent_names", broken)
    agents = env.client.get("/api/admin/budgets", headers=_h("admin")).json()["agents"]
    assert agents == [
        {"agent_id": "finops", "name": None, "limit_usd": "200.00", "spent_usd": "0.00"}
    ]


def test_put_defaults_updates_version_limits_and_audits(env: Env) -> None:
    response = env.client.put(
        "/api/admin/budgets/defaults",
        headers=_h("admin"),
        json={"version": 1, "user_monthly_usd": "25.50", "agent_monthly_usd": "300"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["version"] == 2
    assert body["defaults"] == {"user_monthly_usd": "25.50", "agent_monthly_usd": "300.00"}
    [(actor, detail)] = env.audit.named("settings.budget.updated")
    assert actor == "admin-1"
    assert detail["before"] == {"user_monthly_usd": "20", "agent_monthly_usd": "200"}
    assert detail["after"] == {"user_monthly_usd": "25.50", "agent_monthly_usd": "300"}
    # The chat path sees the new limits right away (cache invalidated in process).
    services_limits = BudgetLimits(env.store)
    assert services_limits.for_user("x") == (Decimal("25.50"), Decimal(300))


def test_put_defaults_with_stale_version_conflicts(env: Env) -> None:
    body = {"version": 1, "user_monthly_usd": "10", "agent_monthly_usd": "10"}
    assert env.client.put("/api/admin/budgets/defaults", headers=_h("admin"), json=body).is_success
    response = env.client.put("/api/admin/budgets/defaults", headers=_h("admin2"), json=body)
    assert response.status_code == 409
    assert _code(response) == "version_conflict"
    assert len(env.audit.named("settings.budget.updated")) == 1


@pytest.mark.parametrize(
    "amount", ["0", "-1", "1000000.01", "abc", "1e3", "1.234", 12, None, " 1", "NaN"]
)
def test_budget_amounts_are_validated(env: Env, amount: Any) -> None:
    response = env.client.put(
        "/api/admin/budgets/defaults",
        headers=_h("admin"),
        json={"version": 1, "user_monthly_usd": amount, "agent_monthly_usd": "1"},
    )
    assert response.status_code == 422


def test_budget_body_forbids_extra_fields(env: Env) -> None:
    response = env.client.put(
        "/api/admin/budgets/users/user-1",
        headers=_h("admin"),
        json={"version": 1, "limit_usd": "5", "user_id": "admin-1"},
    )
    assert response.status_code == 422


def test_user_override_set_and_removed(env: Env) -> None:
    response = env.client.put(
        "/api/admin/budgets/users/user-1",
        headers=_h("admin"),
        json={"version": 1, "limit_usd": "1000000"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["version"] == 2
    assert body["users"] == [
        {
            "user_id": "user-1",
            "email": None,
            "limit_usd": "1000000.00",
            "override": True,
            "spent_usd": "0.00",
        }
    ]
    assert BudgetLimits(env.store).for_user("user-1") == (Decimal(1000000), Decimal(200))
    response = env.client.put(
        "/api/admin/budgets/users/user-1",
        headers=_h("admin"),
        json={"version": 2, "limit_usd": None},
    )
    assert response.json()["users"] == []
    events = env.audit.named("settings.budget.updated")
    assert [d["after"] for _, d in events] == [{"limit_usd": "1000000"}, {"limit_usd": None}]
    assert events[1][1]["before"] == {"limit_usd": "1000000"}
    assert events[1][1]["target_user"] == "user-1"


def test_user_override_requires_limit_field(env: Env) -> None:
    response = env.client.put(
        "/api/admin/budgets/users/user-1", headers=_h("admin"), json={"version": 1}
    )
    assert response.status_code == 422


def test_user_override_version_conflict(env: Env) -> None:
    response = env.client.put(
        "/api/admin/budgets/users/user-1",
        headers=_h("admin"),
        json={"version": 7, "limit_usd": "1"},
    )
    assert response.status_code == 409
    assert _code(response) == "version_conflict"
    assert env.store.user_limit("user-1") is None


def test_admin_cannot_edit_own_budget(env: Env) -> None:
    response = env.client.put(
        "/api/admin/budgets/users/admin-1",
        headers=_h("admin"),
        json={"version": 1, "limit_usd": "999"},
    )
    assert response.status_code == 403
    assert _code(response) == "self_edit"
    assert env.store.user_limit("admin-1") is None
    assert env.audit.named("settings.budget.updated") == []


def test_user_id_path_is_validated(env: Env) -> None:
    response = env.client.put(
        "/api/admin/budgets/users/a%23b", headers=_h("admin"), json={"version": 1, "limit_usd": "1"}
    )
    assert response.status_code == 422


# --- Area -> OU mapping -----------------------------------------------------------------


def _propose(env: Env, token: str, units: dict[str, list[str]], base: int = 1) -> Any:
    return env.client.post(
        "/api/admin/business-units/changes",
        headers=_h(token),
        json={"base_version": base, "units": units, "reason": "reorg"},
    )


NEW_UNITS = {"sandbox": [OU_SBX, OU_NEW], "security": [OU_SEC]}


def test_dual_approval_flow(env: Env) -> None:
    response = _propose(env, "admin", NEW_UNITS)
    assert response.status_code == 201
    change_id = response.json()["change_id"]
    assert len(change_id) == 32

    listing = env.client.get("/api/admin/business-units", headers=_h("admin2")).json()
    assert listing["version"] == 1
    [pending] = listing["pending"]
    assert pending["change_id"] == change_id
    assert pending["proposed_by"] == "admin-1"
    assert pending["units"] == {"sandbox": sorted([OU_SBX, OU_NEW]), "security": [OU_SEC]}
    assert pending["base_version"] == 1
    created = datetime.fromisoformat(pending["created_at"])
    assert datetime.fromisoformat(pending["expires_at"]) - created == timedelta(days=7)

    response = env.client.post(
        f"/api/admin/business-units/changes/{change_id}/approve", headers=_h("admin2"), json={}
    )
    assert response.status_code == 200
    body = response.json()
    assert body == {"version": 2, "units": pending["units"], "pending": []}

    [(_, proposed)] = env.audit.named("settings.bu_mapping.proposed")
    assert proposed["areas_changed"] == ["sandbox"]
    [(actor, approved)] = env.audit.named("settings.bu_mapping.approved")
    assert actor == "admin-2"
    assert approved["proposed_by"] == "admin-1"
    assert approved["approved_by"] == "admin-2"
    assert approved["change_id"] == change_id
    assert approved["before"]["sandbox"] == [OU_SBX]
    # The organization was read with the proposer's identity.
    assert env.probe.calls == [("organization", "admin-1")]


def test_proposer_cannot_approve(env: Env) -> None:
    change_id = _propose(env, "admin", NEW_UNITS).json()["change_id"]
    response = env.client.post(
        f"/api/admin/business-units/changes/{change_id}/approve", headers=_h("admin"), json={}
    )
    assert response.status_code == 403
    assert _code(response) == "same_approver"
    assert env.store.mapping().version == 1


def test_cannot_propose_changes_to_own_area(env: Env) -> None:
    for units in (
        {"sandbox": [OU_SBX], "security": [OU_SEC, OU_NEW]},  # changed
        {"sandbox": [OU_SBX]},  # removed
    ):
        response = _propose(env, "sec-admin", units)
        assert response.status_code == 403
        assert _code(response) == "self_edit"
    # Other areas are fine.
    assert _propose(env, "sec-admin", NEW_UNITS).status_code == 201


def test_cannot_approve_changes_to_own_area(env: Env) -> None:
    change_id = _propose(env, "admin", {"sandbox": [OU_SBX], "security": [OU_SEC, OU_NEW]}).json()[
        "change_id"
    ]
    response = env.client.post(
        f"/api/admin/business-units/changes/{change_id}/approve", headers=_h("sec-admin"), json={}
    )
    assert response.status_code == 403
    assert _code(response) == "self_edit"


def test_cannot_add_own_area(env: Env) -> None:
    env.store.approve_change(
        env.store.create_change(
            base_version=1,
            units={"sandbox": (OU_SBX,)},
            reason="drop security",
            proposed_by="admin-1",
            proposed_by_email=None,
            now=datetime.now(UTC),
        ),
        "admin-2",
        datetime.now(UTC),
    )
    response = _propose(env, "sec-admin", {"sandbox": [OU_SBX], "security": [OU_NEW]}, base=2)
    assert response.status_code == 403
    assert _code(response) == "self_edit"


def test_stale_proposal_cannot_be_approved(env: Env) -> None:
    first = _propose(env, "admin", NEW_UNITS).json()["change_id"]
    second = _propose(env, "admin", {"sandbox": [OU_NEW], "security": [OU_SEC]}).json()["change_id"]
    ok = env.client.post(
        f"/api/admin/business-units/changes/{first}/approve", headers=_h("admin2"), json={}
    )
    assert ok.status_code == 200
    response = env.client.post(
        f"/api/admin/business-units/changes/{second}/approve", headers=_h("admin2"), json={}
    )
    assert response.status_code == 409
    assert _code(response) == "version_conflict"
    assert env.store.mapping().units["sandbox"] == tuple(sorted([OU_SBX, OU_NEW]))


def test_transaction_rejects_stale_base_even_if_checks_raced(env: Env) -> None:
    change = env.store.create_change(
        base_version=1,
        units={"sandbox": (OU_NEW,)},
        reason="x",
        proposed_by="admin-1",
        proposed_by_email=None,
        now=datetime.now(UTC),
    )
    stale = type(change)(**{**change.__dict__, "base_version": 0})
    from mango_api.settings_store import VersionConflictError  # noqa: PLC0415

    with pytest.raises(VersionConflictError):
        env.store.approve_change(stale, "admin-2", datetime.now(UTC))
    with pytest.raises(VersionConflictError):
        env.store.approve_change(change, "admin-1", datetime.now(UTC))  # same approver
    assert env.store.mapping().version == 1
    assert env.store.change(change.change_id).status == "pending"  # type: ignore[union-attr]


def test_proposal_with_stale_base_version_conflicts(env: Env) -> None:
    response = _propose(env, "admin", NEW_UNITS, base=0)
    assert response.status_code == 409
    assert _code(response) == "version_conflict"


def test_expired_proposal_cannot_be_approved(env: Env) -> None:
    change = env.store.create_change(
        base_version=1,
        units={"sandbox": (OU_NEW,), "security": (OU_SEC,)},
        reason="old",
        proposed_by="admin-1",
        proposed_by_email=None,
        now=datetime.now(UTC) - timedelta(days=8),
    )
    listing = env.client.get("/api/admin/business-units", headers=_h("admin2")).json()
    assert listing["pending"] == []
    response = env.client.post(
        f"/api/admin/business-units/changes/{change.change_id}/approve",
        headers=_h("admin2"),
        json={},
    )
    assert response.status_code == 410
    assert _code(response) == "expired"
    assert env.store.mapping().version == 1


def test_unknown_ou_is_rejected(env: Env) -> None:
    response = _propose(env, "admin", {"sandbox": ["ou-abcd-99999999"], "security": [OU_SEC]})
    assert response.status_code == 400
    assert _code(response) == "unknown_ou"
    assert env.audit.named("settings.bu_mapping.proposed") == []


@pytest.mark.parametrize(
    "units",
    [
        {"Sandbox": [OU_SBX]},
        {"s": [OU_SBX]},
        {"sandbox": []},
        {"sandbox": ["ou-x"]},
        {"sandbox": [f"ou-abcd-{i:08d}" for i in range(16)]},
        {f"area-{i:02d}": [OU_SBX] for i in range(21)},
        {"sandbox": "ou-abcd-11111111"},
    ],
)
def test_mapping_validation(env: Env, units: Any) -> None:
    assert _propose(env, "admin", units).status_code == 422


@pytest.mark.parametrize("reason", ["", "x" * 501])
def test_reason_length(env: Env, reason: str) -> None:
    response = env.client.post(
        "/api/admin/business-units/changes",
        headers=_h("admin"),
        json={"base_version": 1, "units": NEW_UNITS, "reason": reason},
    )
    assert response.status_code == 422


def test_no_op_proposal_is_rejected(env: Env) -> None:
    response = _propose(env, "admin", {"sandbox": [OU_SBX], "security": [OU_SEC]})
    assert response.status_code == 422


def test_approve_body_forbids_extra_fields(env: Env) -> None:
    change_id = _propose(env, "admin", NEW_UNITS).json()["change_id"]
    response = env.client.post(
        f"/api/admin/business-units/changes/{change_id}/approve",
        headers=_h("admin2"),
        json={"approver": "admin-9"},
    )
    assert response.status_code == 422


def test_reject_closes_the_request(env: Env) -> None:
    change_id = _propose(env, "admin", NEW_UNITS).json()["change_id"]
    response = env.client.post(
        f"/api/admin/business-units/changes/{change_id}/reject",
        headers=_h("admin2"),
        json={"reason": "not now"},
    )
    assert response.status_code == 200
    assert response.json()["pending"] == []
    [(actor, detail)] = env.audit.named("settings.bu_mapping.rejected")
    assert (actor, detail["reason"], detail["proposed_by"]) == ("admin-2", "not now", "admin-1")
    again = env.client.post(
        f"/api/admin/business-units/changes/{change_id}/approve", headers=_h("admin2"), json={}
    )
    assert again.status_code == 409


def test_unknown_change_is_not_found(env: Env) -> None:
    response = env.client.post(
        f"/api/admin/business-units/changes/{'b' * 32}/approve", headers=_h("admin2"), json={}
    )
    assert response.status_code == 404


# --- Organization and connectivity ------------------------------------------------------


def test_organization_is_cached(env: Env) -> None:
    for _ in range(3):
        response = env.client.get("/api/admin/organization", headers=_h("admin"))
        assert response.status_code == 200
    assert env.probe.calls == [("organization", "admin-1")]
    ou = response.json()["ous"][0]
    assert ou["name"].startswith("<img")  # returned as data; the SPA renders it as text


def test_organization_probe_failure_is_generic(env: Env) -> None:
    env.probe.fail = True
    response = env.client.get("/api/admin/organization", headers=_h("admin"))
    assert response.status_code == 502
    assert response.json()["error"] == {
        "code": "upstream_error",
        "message": "the organization could not be read",
    }


def test_connectivity_is_rate_limited_per_admin(env: Env) -> None:
    for _ in range(5):
        response = env.client.post("/api/admin/connectivity-check", headers=_h("admin"), json={})
        assert response.status_code == 200
    body = response.json()
    assert body["checks"] == [{"name": "broker", "status": "ok", "detail": "ok"}]
    datetime.fromisoformat(body["checked_at"])
    limited = env.client.post("/api/admin/connectivity-check", headers=_h("admin"), json={})
    assert limited.status_code == 429
    assert _code(limited) == "rate_limited"
    # Seconds until the oldest call leaves the one-minute window.
    assert 1 <= int(limited.headers["Retry-After"]) <= 60
    # Another admin has its own window; only the verified sub reaches the probe.
    assert env.client.post(
        "/api/admin/connectivity-check", headers=_h("admin2"), json={}
    ).is_success
    assert {actor for _, actor in env.probe.calls} == {"admin-1", "admin-2"}


# --- Member accounts (D51) ---------------------------------------------------------------

PROD, DATA, STAGING = "210987654321", "310987654321", "410987654321"


def _member_check(env: Env, who: str = "admin") -> Any:
    return env.client.post("/api/admin/member-access-check", headers=_h(who), json={})


def test_member_access_reports_one_fixed_status_per_target_account(env: Env) -> None:
    env.probe.members = [(PROD, "<img src=x>prod"), (DATA, "prod-data"), (STAGING, "staging")]
    env.probe.member_checks = {
        DATA: _member_checks(member_role="access denied", account="skipped"),
        STAGING: _member_checks(source_identity_required="accepted without source identity"),
    }
    response = _member_check(env)
    assert response.status_code == 200
    body = response.json()
    datetime.fromisoformat(body["checked_at"])
    # Only id, name and a closed status: no probe detail, role name or ARN.
    assert body == {
        "checked_at": body["checked_at"],
        "accounts": [
            {"account_id": PROD, "name": "<img src=x>prod", "status": "ok"},
            {"account_id": DATA, "name": "prod-data", "status": "role_missing"},
            {"account_id": STAGING, "name": "staging", "status": "identity_not_required"},
        ],
        "truncated": False,
        "total": 3,
        # One acceptance of a session without a person is the broker's answer for every account.
        "identity_required": False,
    }
    # The accounts are the configured targets; only the verified sub reaches the probe.
    assert env.probe.calls == [("member_accounts", "admin-1")]
    assert sorted(env.probe.member_calls) == [("admin-1", a) for a in (PROD, DATA, STAGING)]


def test_member_access_puts_a_missing_role_before_the_identity_check(env: Env) -> None:
    env.probe.members = [(PROD, "prod")]
    env.probe.member_checks = {
        PROD: _member_checks(
            member_role="access denied",
            account="skipped",
            source_identity_required="accepted without source identity",
        )
    }
    body = _member_check(env).json()
    assert body["accounts"][0]["status"] == "role_missing"
    # The account without the role still says what the broker does.
    assert body["identity_required"] is False


def test_member_access_reports_the_identity_check_once_for_all_accounts(env: Env) -> None:
    env.probe.members = [(PROD, "prod"), (DATA, "data")]
    env.probe.member_checks = {DATA: _member_checks(member_role="access denied", account="skipped")}
    body = _member_check(env).json()
    assert [a["status"] for a in body["accounts"]] == ["ok", "role_missing"]
    assert body["identity_required"] is True


def test_member_access_does_not_guess_the_identity_check(env: Env) -> None:
    # No account has the role and none could tell what the broker demands.
    env.probe.members = [(PROD, "prod")]
    env.probe.member_checks = {
        PROD: _member_checks(
            member_role="access denied", account="skipped", source_identity_required="unavailable"
        )
    }
    response = _member_check(env)
    assert response.status_code == 502
    assert _code(response) == "upstream_error"


def test_member_access_without_targets_checks_nothing(env: Env) -> None:
    body = _member_check(env).json()
    assert (body["accounts"], body["truncated"], body["total"]) == ([], False, 0)
    assert body["identity_required"] is None
    assert env.probe.member_calls == []


def test_member_access_says_when_there_are_more_accounts_than_it_checks(env: Env) -> None:
    env.probe.members, env.probe.truncated, env.probe.total = [(PROD, "prod")], True, 63
    body = _member_check(env).json()
    assert (body["truncated"], body["total"]) == (True, 63)


def test_member_access_counts_what_it_listed_for_a_probe_without_the_total(env: Env) -> None:
    env.probe.members, env.probe.truncated = [(PROD, "prod"), (DATA, "data")], True
    body = _member_check(env).json()
    assert (body["truncated"], body["total"]) == (True, 2)
    # A total below what was listed is not believed.
    env.probe.total = 1
    assert _member_check(env).json()["total"] == 2


@pytest.mark.parametrize(
    "checks",
    [
        _member_checks(read_broker="access denied", member_role="skipped", account="skipped"),
        _member_checks(member_role="unavailable", account="skipped"),
        _member_checks(account="unexpected account"),
        _member_checks(source_identity_required="unavailable"),
        _member_checks()[:3],
    ],
)
def test_member_access_does_not_guess_when_a_check_is_inconclusive(
    env: Env, checks: list[dict[str, str]]
) -> None:
    env.probe.members = [(PROD, "prod"), (DATA, "data")]
    env.probe.member_checks = {DATA: checks}
    response = _member_check(env)
    assert response.status_code == 502
    assert response.json()["error"] == {
        "code": "upstream_error",
        "message": "the member account check could not run",
    }


def test_member_access_probe_failure_is_generic(env: Env) -> None:
    env.probe.members, env.probe.broken = [(PROD, "prod")], {PROD}
    assert _member_check(env).status_code == 502
    env.probe.fail = True
    response = _member_check(env)
    assert response.status_code == 502
    assert "down" not in response.text


def test_member_access_has_its_own_rate_limit_per_admin(env: Env) -> None:
    for _ in range(5):
        assert _member_check(env).status_code == 200
    limited = _member_check(env)
    assert limited.status_code == 429
    assert _code(limited) == "rate_limited"
    assert 1 <= int(limited.headers["Retry-After"]) <= 60
    # It does not use up the connectivity checks, nor another admin's window.
    assert env.client.post("/api/admin/connectivity-check", headers=_h("admin"), json={}).is_success
    assert _member_check(env, "admin2").is_success


# --- Review findings (2026-09-29-admin-v0) -----------------------------------------------


def test_audit_requested_is_emitted_before_the_write(env: Env) -> None:
    """ADM-01: requested -> applied, with the same before/after."""
    env.client.put(
        "/api/admin/budgets/defaults",
        headers=_h("admin"),
        json={"version": 1, "user_monthly_usd": "30", "agent_monthly_usd": "300"},
    )
    events = env.audit.named("settings.budget.updated", outcome=None)
    assert [d["outcome"] for _, d in events] == ["requested", "applied"]
    assert (
        events[0][1]["after"]
        == events[1][1]["after"]
        == {
            "user_monthly_usd": "30",
            "agent_monthly_usd": "300",
        }
    )


def _audit_down(env: Env) -> None:
    env.audit.fail_outcomes = {"requested"}


def test_no_budget_write_without_audit(env: Env) -> None:
    """ADM-01: if the requested event cannot be recorded, nothing is written."""
    _audit_down(env)
    response = env.client.put(
        "/api/admin/budgets/defaults",
        headers=_h("admin"),
        json={"version": 1, "user_monthly_usd": "30", "agent_monthly_usd": "300"},
    )
    assert response.status_code == 503
    assert _code(response) == "audit_unavailable"
    assert env.store.budget_defaults().version == 1
    response = env.client.put(
        "/api/admin/budgets/users/user-1",
        headers=_h("admin"),
        json={"version": 1, "limit_usd": "9"},
    )
    assert response.status_code == 503
    assert env.store.user_limit("user-1") is None


def test_no_mapping_change_without_audit(env: Env) -> None:
    """ADM-01: propose, approve and reject write nothing when audit is down."""
    change_id = _propose(env, "admin", NEW_UNITS).json()["change_id"]
    _audit_down(env)
    assert _propose(env, "admin2", NEW_UNITS).status_code == 503
    assert len(env.store.pending_changes(datetime.now(UTC))) == 1
    for action, body in (("approve", {}), ("reject", {"reason": "no"})):
        response = env.client.post(
            f"/api/admin/business-units/changes/{change_id}/{action}",
            headers=_h("admin2"),
            json=body,
        )
        assert response.status_code == 503
    assert env.store.mapping().version == 1
    assert env.store.change(change_id).status == "pending"  # type: ignore[union-attr]


def test_failed_write_is_audited_as_rejected(env: Env) -> None:
    """ADM-01: a conflicting write leaves requested + rejected with the error code."""
    response = env.client.put(
        "/api/admin/budgets/defaults",
        headers=_h("admin"),
        json={"version": 5, "user_monthly_usd": "30", "agent_monthly_usd": "300"},
    )
    assert response.status_code == 409
    events = env.audit.named("settings.budget.updated", outcome=None)
    assert [(d["outcome"], d.get("error")) for _, d in events] == [
        ("requested", None),
        ("rejected", "version_conflict"),
    ]


def test_applied_audit_failure_does_not_hide_the_committed_change(env: Env) -> None:
    env.audit.fail_outcomes = {"applied"}
    response = env.client.put(
        "/api/admin/budgets/defaults",
        headers=_h("admin"),
        json={"version": 1, "user_monthly_usd": "30", "agent_monthly_usd": "300"},
    )
    assert response.status_code == 200
    assert [d["outcome"] for _, d in env.audit.named("settings.budget.updated", None)] == [
        "requested"
    ]


SECURITY_CHANGE = {"sandbox": [OU_SBX], "security": [OU_SEC, OU_NEW]}


def test_cannot_reject_changes_to_own_area(env: Env) -> None:
    """ADM-03: no veto over your own area."""
    change_id = _propose(env, "admin", SECURITY_CHANGE).json()["change_id"]
    response = env.client.post(
        f"/api/admin/business-units/changes/{change_id}/reject",
        headers=_h("sec-admin"),
        json={"reason": "keep my scope"},
    )
    assert response.status_code == 403
    assert _code(response) == "self_edit"
    assert env.store.change(change_id).status == "pending"  # type: ignore[union-attr]
    assert env.audit.named("settings.bu_mapping.rejected", outcome=None) == []


def test_can_reject_changes_to_other_areas(env: Env) -> None:
    change_id = _propose(env, "admin", NEW_UNITS).json()["change_id"]
    response = env.client.post(
        f"/api/admin/business-units/changes/{change_id}/reject",
        headers=_h("sec-admin"),
        json={"reason": "no"},
    )
    assert response.status_code == 200


def _withdraw(env: Env, token: str, change_id: str, body: Any = None) -> Any:
    return env.client.post(
        f"/api/admin/business-units/changes/{change_id}/withdraw",
        headers=_h(token),
        json={} if body is None else body,
    )


def test_proposer_withdraws_own_proposal(env: Env) -> None:
    change_id = _propose(env, "admin", SECURITY_CHANGE).json()["change_id"]
    response = _withdraw(env, "admin", change_id)
    assert response.status_code == 200
    assert response.json()["pending"] == []
    assert env.store.change(change_id).status == "withdrawn"  # type: ignore[union-attr]
    assert env.store.mapping().version == 1
    events = env.audit.named("settings.bu_mapping.withdrawn", outcome=None)
    assert [(actor, d["outcome"]) for actor, d in events] == [
        ("admin-1", "requested"),
        ("admin-1", "applied"),
    ]
    assert events[0][1] == {
        "change_id": change_id,
        "proposed_by": "admin-1",
        "outcome": "requested",
    }
    assert env.authorizer.decisions[-1] == ("admin-1", "ProposeBusinessUnits", True)
    # Closed: neither a second withdrawal nor an approval applies.
    assert _withdraw(env, "admin", change_id).status_code == 409


def test_only_the_proposer_withdraws(env: Env) -> None:
    change_id = _propose(env, "admin", NEW_UNITS).json()["change_id"]
    response = _withdraw(env, "admin2", change_id)
    assert response.status_code == 403
    assert _code(response) == "not_proposer"
    assert env.store.change(change_id).status == "pending"  # type: ignore[union-attr]
    assert env.audit.named("settings.bu_mapping.withdrawn", outcome=None) == []


def test_withdraw_takes_no_reason(env: Env) -> None:
    change_id = _propose(env, "admin", NEW_UNITS).json()["change_id"]
    assert _withdraw(env, "admin", change_id, {"reason": "x"}).status_code == 422
    assert _withdraw(env, "admin", "b" * 32).status_code == 404


def test_withdraw_writes_nothing_without_audit(env: Env) -> None:
    change_id = _propose(env, "admin", NEW_UNITS).json()["change_id"]
    _audit_down(env)
    response = _withdraw(env, "admin", change_id)
    assert response.status_code == 503
    assert _code(response) == "audit_unavailable"
    assert env.store.change(change_id).status == "pending"  # type: ignore[union-attr]


def test_store_withdraw_requires_the_proposer(env: Env) -> None:
    """The DynamoDB condition re-checks the proposer, not only the use case."""
    from mango_api.settings_store import VersionConflictError  # noqa: PLC0415

    change_id = _propose(env, "admin", NEW_UNITS).json()["change_id"]
    change = env.store.change(change_id)
    assert change is not None
    with pytest.raises(VersionConflictError):
        env.store.withdraw_change(change, "admin-2", datetime.now(UTC))


def test_proposer_cannot_reject_own_proposal(env: Env) -> None:
    """Rejecting is another admin's decision; the proposer uses withdraw."""
    change_id = _propose(env, "admin", NEW_UNITS).json()["change_id"]
    response = env.client.post(
        f"/api/admin/business-units/changes/{change_id}/reject",
        headers=_h("admin"),
        json={"reason": "withdrawn"},
    )
    assert response.status_code == 403
    assert _code(response) == "use_withdraw"
    assert env.store.change(change_id).status == "pending"  # type: ignore[union-attr]


def test_admin_writes_record_the_actor(env: Env) -> None:
    """Audit events carry the verified caller (email, role, admin flag) when emitted."""
    env.client.put(
        "/api/admin/budgets/users/user-1",
        headers=_h("sec-admin"),
        json={"version": 1, "limit_usd": "9"},
    )
    actors = [
        a
        for (e, _, _), a in zip(env.audit.events, env.audit.actors, strict=True)
        if e == "settings.budget.updated"
    ]
    assert {(a.user_id, a.email, a.role, a.is_admin) for a in actors} == {
        ("admin-3", "sec@example.com", "bu-lead", True)
    }


def test_pending_proposals_are_capped(env: Env) -> None:
    """ADM-06: at most 10 open proposals."""
    for _ in range(10):
        assert _propose(env, "admin", NEW_UNITS).status_code == 201
    response = _propose(env, "admin2", NEW_UNITS)
    assert response.status_code == 409
    assert _code(response) == "too_many_pending"


def test_largest_valid_proposal_fits_the_body_limit(env: Env) -> None:
    """ADM-08: schema limits and the request size limit are consistent."""
    from mango_core.business_units import MAX_AREAS, MAX_OUS_PER_AREA  # noqa: PLC0415

    units = {
        f"{i:02d}".ljust(32, "a"): [
            f"ou-{'a' * 30}{i:02d}-{'b' * 30}{j:02d}" for j in range(MAX_OUS_PER_AREA)
        ]
        for i in range(MAX_AREAS)
    }
    # Astral characters count once but are sent as 12-byte JSON escapes.
    body = {"base_version": 1, "units": units, "reason": "\U0001f600" * 500}
    raw = json.dumps(body).encode()
    assert len(raw) < app_module.MAX_BODY_BYTES
    response = env.client.post(
        "/api/admin/business-units/changes",
        headers={**_h("admin"), "Content-Type": "application/json"},
        content=raw,
    )
    # Accepted by size and schema; rejected only because the OUs do not exist.
    assert response.status_code == 400
    assert _code(response) == "unknown_ou"
