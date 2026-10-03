"""Settings > Groups (D26, D35, TM-M13): registry changes with dual approval, against moto
DynamoDB (real conditions and transactions) and a fake Cognito directory."""

from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import boto3
import pytest
from botocore.stub import Stubber
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api.group_admin import (
    CHANGE_LIFETIME,
    MAX_PENDING,
    STALE_CLAIM,
    CognitoGroups,
    ConflictError,
    DirectoryUnavailableError,
    GroupAdminDeps,
    GroupStore,
)
from mango_api.groups import GroupRegistry
from mango_api.mcp_catalog import McpCatalog
from mango_api.probe import RateLimiter
from mango_api.settings_store import SettingsStore
from mango_core.agents import ROOT_SUPERVISOR, AgentDefinition, VersionStatus
from mango_core.identity import IdentityError

from .test_admin import OU_SBX, OU_SEC, RecordingAudit, _code, _h, _table
from .test_agent_rules import SONNET, _connector
from .test_app import (
    HOST,
    FakeAgentCore,
    FakeBedrock,
    FakeConversations,
    FakeLimits,
    FakeModelCatalog,
    FakePublished,
    _settings,
)

CONNECTORS = Path(__file__).parents[3] / "connectors"
BASE = "/api/admin/groups"
EXP = int(time.time()) + 3600
ADMIN = {"mango_admin": "true"}
TOKENS: dict[str, dict[str, Any]] = {
    "admin": {
        "sub": "admin-1",
        **ADMIN,
        "cognito:groups": ["mango-admin"],
        "mango_email": "a1@example.com",
    },
    "admin2": {
        "sub": "admin-2",
        **ADMIN,
        "cognito:groups": ["mango-admin"],
        "mango_email": "a2@example.com",
    },
    # An administrator who is also a member of ``hr`` and of ``platform``.
    "member-admin": {
        "sub": "admin-3",
        **ADMIN,
        "cognito:groups": ["mango-admin", "hr", "platform"],
    },
    "creator": {"sub": "creator-1", "cognito:groups": ["mango-agent-creator"]},
    "user": {"sub": "user-1", "cognito:groups": ["hr"]},
}


class FakeVerifier:
    def verify(self, token: str) -> dict[str, Any]:
        if token not in TOKENS:
            raise IdentityError("invalid")
        return {**TOKENS[token], "exp": EXP}


@dataclass
class CedarLikeAuthorizer:
    """Mirrors the platform policies: the group actions require isAdmin."""

    decisions: list[tuple[str, str, bool]] = field(default_factory=list)

    def is_allowed(self, user: Any, action: str, _rt: str, _rid: str, agent: Any = None) -> bool:
        allowed = bool(user.is_admin)
        self.decisions.append((user.user_id, action, allowed))
        return allowed


@dataclass
class FakeDirectory:
    """Cognito groups of the pool; ``bu-ops`` was created by IaC and is not in the registry."""

    groups: set[str] = field(
        default_factory=lambda: {"finops-central", "bu-lead", "bu-security", "hr", "platform"}
    )
    calls: list[tuple[str, str]] = field(default_factory=list)
    fail: bool = False

    def create(self, name: str, _description: str) -> str:
        self.calls.append(("create", name))
        if self.fail:
            raise DirectoryUnavailableError
        if name in self.groups:
            return "adopted"
        self.groups.add(name)
        return "created"

    def delete(self, name: str) -> str:
        self.calls.append(("delete", name))
        if self.fail:
            raise DirectoryUnavailableError
        if name not in self.groups:
            return "absent"
        self.groups.remove(name)
        return "deleted"


@dataclass
class Version:
    agent_id: str
    definition: AgentDefinition


def _agent(agent_id: str, name: str, groups: list[str], tools: list[str]) -> Version:
    return Version(
        agent_id,
        AgentDefinition.model_validate(
            {
                "name": name,
                "reports_to": ROOT_SUPERVISOR,
                "role": "Rol",
                "model": SONNET,
                "allowed_models": [SONNET],
                "system_prompt": "Eres un analista.",
                "tools": tools,
                "groups": groups,
            }
        ),
    )


@dataclass
class FakeAgents:
    versions: dict[VersionStatus, list[Version]] = field(
        default_factory=lambda: {
            VersionStatus.PUBLISHED: [
                _agent(
                    "finops",
                    "FinOps",
                    ["finops-central", "bu-lead"],
                    ["cost-explorer.get_cost_and_usage"],
                ),
                _agent("a" * 16, "<b>Alarmas</b>", ["platform"], ["cloudwatch.describe_alarms"]),
            ],
            # In review: not listed as a user of the group, but it counts for the rules.
            VersionStatus.IN_REVIEW: [_agent("b" * 16, "Legado", ["ghost"], [])],
        }
    )
    fail: bool = False

    def by_status(self, status: VersionStatus) -> list[Version]:
        if self.fail:
            raise boto3.client("dynamodb", region_name="us-east-1").exceptions.ClientError(
                {"Error": {"Code": "InternalServerError", "Message": "down"}}, "Query"
            )
        return self.versions.get(status, [])


@dataclass
class Clock:
    now: datetime = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now


@dataclass
class Env:
    client: TestClient
    db: Any
    audit: RecordingAudit
    authorizer: CedarLikeAuthorizer
    directory: FakeDirectory
    agents: FakeAgents
    clock: Clock
    store: GroupStore
    limiter: RateLimiter


def _group(db: Any, group_id: str, kind: str, **extra: str) -> None:
    item = {"PK": {"S": "GROUPS"}, "SK": {"S": group_id}, "type": {"S": kind}}
    item.update({k: {"S": v} for k, v in extra.items()})
    db.put_item(TableName="settings", Item=item)


def _catalog() -> McpCatalog:
    release = McpCatalog.load(CONNECTORS)
    return McpCatalog(
        [
            *release.connectors,
            _connector("cloudwatch", "account_data", "central_only", describe_alarms="read"),
        ]
    )


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "settings")
        # What the IaC seed writes: no ``version`` attribute.
        _group(db, "finops-central", "central", description="FinOps central")
        _group(db, "bu-lead", "general", description="Líderes de área")
        _group(db, "bu-security", "area", area="security", description="Líderes de security")
        _group(db, "hr", "general", description="Personas")
        _group(db, "platform", "central", description="Plataforma")
        db.put_item(
            TableName="settings",
            Item={
                "PK": {"S": "BU_MAPPING"},
                "SK": {"S": "CURRENT"},
                "units": {"S": f'{{"sandbox":["{OU_SBX}"],"security":["{OU_SEC}"]}}'},
                "version": {"N": "1"},
            },
        )
        audit, authorizer = RecordingAudit(), CedarLikeAuthorizer()
        directory, agents, clock = FakeDirectory(), FakeAgents(), Clock()
        store = GroupStore(db, "settings")
        limiter = RateLimiter(limit=50, window_seconds=3600)
        catalog = _catalog()

        def factory(s: Any) -> app_module.Services:
            return app_module.Services(
                settings=s,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=authorizer,  # type: ignore[arg-type]
                budgets=None,  # type: ignore[arg-type]
                conversations=FakeConversations(),  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=FakeAgentCore(),
                bedrock=FakeBedrock(),
                settings_store=None,  # type: ignore[arg-type]
                budget_limits=FakeLimits(),  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=FakePublished(),  # type: ignore[arg-type]
                model_catalog=FakeModelCatalog(),  # type: ignore[arg-type]
                invocation_key=b"k" * 32,
                group_registry=GroupRegistry(db, "settings"),
                group_admin=GroupAdminDeps(
                    store=store,
                    settings=SettingsStore(db, "settings", Decimal(5), Decimal(30)),
                    directory=directory,  # type: ignore[arg-type]
                    agents=agents,  # type: ignore[arg-type]
                    catalog=lambda: catalog,
                    audit=audit,  # type: ignore[arg-type]
                    rate_limiter=limiter,
                    clock=clock,
                ),
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(client, db, audit, authorizer, directory, agents, clock, store, limiter)


def _create(group_id: str = "people", **body: Any) -> dict[str, Any]:
    return {
        "kind": "create",
        "group_id": group_id,
        "type": "general",
        "description": "Personas y Cultura",
        "reason": "Equipo nuevo",
        **body,
    }


def _update(group_id: str, kind: str, base_version: int = 0, **body: Any) -> dict[str, Any]:
    return {
        "kind": "update",
        "group_id": group_id,
        "type": kind,
        "base_version": base_version,
        "reason": "Cambio de alcance",
        **body,
    }


def _delete(group_id: str, base_version: int = 0) -> dict[str, Any]:
    return {"kind": "delete", "group_id": group_id, "base_version": base_version, "reason": "Ya no"}


def _propose(env: Env, body: dict[str, Any], token: str = "admin") -> str:
    response = env.client.post(f"{BASE}/changes", json=body, headers=_h(token))
    assert response.status_code == 201, response.text
    return str(response.json()["change_id"])


def _decide(env: Env, change_id: str, action: str, token: str, body: Any = None) -> Any:
    return env.client.post(
        f"{BASE}/changes/{change_id}/{action}", json=body or {}, headers=_h(token)
    )


def _registry(env: Env) -> dict[str, dict[str, Any]]:
    view = env.client.get(BASE, headers=_h("admin")).json()
    return {g["id"]: g for g in view["items"]}


def _changes(env: Env) -> dict[str, dict[str, Any]]:
    view = env.client.get(BASE, headers=_h("admin")).json()
    return {c["change_id"]: c for c in view["changes"]}


# --- Authorization ------------------------------------------------------------------------

ENDPOINTS: list[tuple[str, str, dict[str, Any] | None, str]] = [
    ("GET", BASE, None, "ViewAdmin"),
    ("POST", f"{BASE}/changes", _create(), "ProposeGroups"),
    ("POST", f"{BASE}/changes/{'a' * 32}/approve", {}, "ApproveGroups"),
    ("POST", f"{BASE}/changes/{'a' * 32}/reject", {"reason": "no"}, "ApproveGroups"),
    ("POST", f"{BASE}/changes/{'a' * 32}/withdraw", {}, "ProposeGroups"),
    ("PUT", f"{BASE}/hr/description", {"version": 0, "description": "x"}, "ProposeGroups"),
]


@pytest.mark.parametrize(("method", "path", "body", "action"), ENDPOINTS)
@pytest.mark.parametrize("token", ["user", "creator"])
def test_every_route_is_for_administrators(  # noqa: PLR0917
    env: Env, method: str, path: str, body: dict[str, Any] | None, action: str, token: str
) -> None:
    response = env.client.request(method, path, json=body, headers=_h(token))
    assert response.status_code == 403
    sub = TOKENS[token]["sub"]
    assert (sub, action, False) in env.authorizer.decisions
    assert env.directory.calls == []
    assert env.audit.named("settings.groups.proposed", None) == []


@pytest.mark.parametrize(("method", "path", "body", "_action"), ENDPOINTS)
def test_every_route_needs_a_token(
    env: Env, method: str, path: str, body: dict[str, Any] | None, _action: str
) -> None:
    assert env.client.request(method, path, json=body).status_code == 401


def test_is_admin_is_rechecked_even_if_cedar_allows(env: Env) -> None:
    env.authorizer.is_allowed = lambda *_a, **_k: True  # type: ignore[method-assign]
    assert env.client.get(BASE, headers=_h("user")).status_code == 403


# --- List ---------------------------------------------------------------------------------


def test_list_shows_types_versions_and_the_agents_that_use_each_group(env: Env) -> None:
    groups = _registry(env)
    assert list(groups) == ["bu-lead", "bu-security", "finops-central", "hr", "platform"]
    assert groups["platform"] == {
        "id": "platform",
        "type": "central",
        "area": None,
        "description": "Plataforma",
        "version": 0,
        "system": False,
        "fixed_type": False,
        # Names are creator content: returned as text, never interpreted.
        "agents": [{"id": "a" * 16, "name": "<b>Alarmas</b>", "account_data": True}],
    }
    assert groups["finops-central"]["system"] is True
    assert groups["finops-central"]["agents"][0]["account_data"] is False
    assert groups["bu-security"]["fixed_type"] is True
    assert groups["bu-security"]["system"] is False
    assert groups["hr"]["agents"] == []


def test_list_fails_closed_without_the_agents_or_with_a_broken_registry(env: Env) -> None:
    env.agents.fail = True
    response = env.client.get(BASE, headers=_h("admin"))
    assert (response.status_code, _code(response)) == (503, "agents_unavailable")
    env.agents.fail = False
    _group(env.db, "broken", "root")
    response = env.client.get(BASE, headers=_h("admin"))
    assert (response.status_code, _code(response)) == (503, "groups_unavailable")


# --- Create -------------------------------------------------------------------------------


def test_create_needs_another_administrator_and_creates_the_cognito_group(env: Env) -> None:
    change_id = _propose(env, _create())
    # Nothing changes until someone else approves.
    assert "people" not in _registry(env)
    assert env.directory.calls == []
    pending = _changes(env)[change_id]
    assert pending["status"] == "pending"
    assert pending["before"] is None
    assert pending["after"] == {
        "type": "general",
        "area": None,
        "description": "Personas y Cultura",
    }
    assert pending["proposed_by_email"] == "a1@example.com"

    own = _decide(env, change_id, "approve", "admin")
    assert (own.status_code, _code(own)) == (403, "same_approver")
    assert env.directory.calls == []

    approved = _decide(env, change_id, "approve", "admin2")
    assert approved.status_code == 200, approved.text
    assert env.directory.calls == [("create", "people")]
    group = _registry(env)["people"]
    assert (group["type"], group["area"], group["version"]) == ("general", None, 1)
    done = _changes(env)[change_id]
    assert (done["status"], done["decided_by"], done["decided_by_email"]) == (
        "approved",
        "admin-2",
        "a2@example.com",
    )
    # The other registry reader sees it too.
    listed = env.client.get("/api/groups", headers=_h("admin")).json()["items"]
    assert {
        "id": "people",
        "type": "general",
        "area": None,
        "description": "Personas y Cultura",
    } in (listed)


def test_create_audit_trail_names_both_administrators(env: Env) -> None:
    change_id = _propose(env, _create())
    _decide(env, change_id, "approve", "admin")
    _decide(env, change_id, "approve", "admin2")
    proposed = env.audit.named("settings.groups.proposed", None)
    assert [d["outcome"] for _, d in proposed] == ["requested", "applied"]
    assert proposed[0][1]["reason"] == "Equipo nuevo"
    refused = env.audit.named("settings.groups.approved", "rejected")
    assert [(u, d["error"]) for u, d in refused] == [("admin-1", "same_approver")]
    applied = env.audit.named("settings.groups.approved")
    assert len(applied) == 1
    user, detail = applied[0]
    assert user == "admin-2"
    assert detail["proposed_by"] == "admin-1"
    assert detail["approved_by"] == "admin-2"
    assert detail["group"] == "people"
    assert detail["directory"] == "created"
    assert detail["after"] == {"type": "general", "area": None, "description": "Personas y Cultura"}


def test_create_adopts_a_group_the_directory_already_has(env: Env) -> None:
    env.directory.groups.add("legal")
    change_id = _propose(env, _create("legal"))
    assert _decide(env, change_id, "approve", "admin2").status_code == 200
    assert env.audit.named("settings.groups.approved")[0][1]["directory"] == "adopted"
    assert "legal" in _registry(env)


@pytest.mark.parametrize(
    ("body", "status", "code"),
    [
        (_create("hr"), 409, "group_exists"),
        (_create("mango-admin"), 422, "reserved_name"),
        (_create("mango-agent-creator"), 422, "reserved_name"),
        (_create("mango-anything"), 422, "reserved_name"),
        # Agents still share with ``ghost``: its new members would inherit them.
        (_create("ghost"), 409, "group_referenced"),
        (_create("leads", type="area", area="marketing"), 422, "unknown_area"),
        # ``bu-<area>`` is what the pre-token trigger reads as the business unit.
        (_create("bu-sandbox"), 422, "fixed_type"),
        (_create("bu-sandbox", type="area", area="security"), 422, "fixed_type"),
        (_create("bu-marketing", type="area", area="marketing"), 422, "unknown_area"),
        (_create("x" * 33), 422, "invalid_request"),
        (_create("Upper"), 422, "invalid_request"),
        (_create("-lead"), 422, "invalid_request"),
        (_create(type="area"), 422, "invalid_request"),
        (_create(area="security"), 422, "invalid_request"),
        (_create(type="root"), 422, "invalid_request"),
        (_create(base_version=0), 422, "invalid_request"),
        (_create(reason=""), 422, "invalid_request"),
        (_create(description="x" * 201), 422, "invalid_request"),
        (_create(description="tab\x00"), 422, "invalid_request"),
        (_create(members=["admin-1"]), 422, "invalid_request"),
        ({"kind": "rename", "group_id": "hr", "reason": "x"}, 422, "invalid_request"),
    ],
)
def test_create_is_validated_by_the_server(
    env: Env, body: dict[str, Any], status: int, code: str
) -> None:
    response = env.client.post(f"{BASE}/changes", json=body, headers=_h("admin"))
    assert (response.status_code, _code(response)) == (status, code)
    assert _changes(env) == {}
    assert env.directory.calls == []


def test_create_an_area_group_named_after_its_area(env: Env) -> None:
    change_id = _propose(env, _create("bu-sandbox", type="area", area="sandbox"))
    assert _decide(env, change_id, "approve", "admin2").status_code == 200
    group = _registry(env)["bu-sandbox"]
    assert (group["type"], group["area"], group["fixed_type"]) == ("area", "sandbox", True)


def test_rules_are_checked_again_when_approving(env: Env) -> None:
    change_id = _propose(env, _create("leads", type="area", area="sandbox"))
    # The area disappears from the mapping while the request waits.
    env.db.put_item(
        TableName="settings",
        Item={
            "PK": {"S": "BU_MAPPING"},
            "SK": {"S": "CURRENT"},
            "units": {"S": f'{{"security":["{OU_SEC}"]}}'},
            "version": {"N": "2"},
        },
    )
    response = _decide(env, change_id, "approve", "admin2")
    assert (response.status_code, _code(response)) == (422, "unknown_area")
    assert env.directory.calls == []
    assert env.audit.named("settings.groups.approved", "rejected")[0][1]["error"] == "unknown_area"


def test_one_open_request_per_group_and_a_cap_on_pending_requests(env: Env) -> None:
    _propose(env, _create())
    again = env.client.post(f"{BASE}/changes", json=_create(), headers=_h("admin2"))
    assert (again.status_code, _code(again)) == (409, "already_pending")
    for index in range(MAX_PENDING - 1):
        _propose(env, _create(f"team-{index}"))
    full = env.client.post(f"{BASE}/changes", json=_create("one-more"), headers=_h("admin"))
    assert (full.status_code, _code(full)) == (409, "too_many_pending")


def test_proposals_are_rate_limited_per_administrator(env: Env) -> None:
    while env.limiter.allow("admin-1"):
        pass
    response = env.client.post(f"{BASE}/changes", json=_create(), headers=_h("admin"))
    assert (response.status_code, _code(response)) == (429, "rate_limited")
    assert int(response.headers["Retry-After"]) >= 1
    assert _changes(env) == {}
    # Another administrator is not affected.
    _propose(env, _create(), token="admin2")


# --- Change of type or area ---------------------------------------------------------------


def test_change_of_type_is_applied_in_one_step_without_touching_cognito(env: Env) -> None:
    change_id = _propose(env, _update("hr", "central"))
    assert _changes(env)[change_id]["before"] == {"type": "general", "area": None}
    assert _registry(env)["hr"]["type"] == "general"
    assert _decide(env, change_id, "approve", "admin2").status_code == 200
    group = _registry(env)["hr"]
    assert (group["type"], group["version"], group["description"]) == ("central", 1, "Personas")
    assert env.directory.calls == []
    detail = env.audit.named("settings.groups.approved")[0][1]
    assert detail["before"] == {"type": "general", "area": None}
    assert detail["after"]["type"] == "central"


def test_change_to_an_area_group_and_back_clears_the_area(env: Env) -> None:
    first = _propose(env, _update("hr", "area", area="sandbox", description="Personas de sandbox"))
    assert _decide(env, first, "approve", "admin2").status_code == 200
    group = _registry(env)["hr"]
    assert (group["type"], group["area"], group["description"]) == (
        "area",
        "sandbox",
        "Personas de sandbox",
    )
    second = _propose(env, _update("hr", "general", base_version=1), token="admin2")
    assert _decide(env, second, "approve", "admin").status_code == 200
    group = _registry(env)["hr"]
    assert (group["type"], group["area"], group["version"]) == ("general", None, 2)


def test_a_central_group_stays_central_while_agents_use_it_with_account_data(env: Env) -> None:
    response = env.client.post(
        f"{BASE}/changes", json=_update("platform", "general"), headers=_h("admin")
    )
    assert (response.status_code, _code(response)) == (409, "central_in_use")
    # Ids only: the UI names the agents from its own list.
    assert response.json()["agents"] == ["a" * 16]
    # FinOps filters by user, so its group is not held central by it... but it is a system group.
    response = env.client.post(
        f"{BASE}/changes", json=_update("finops-central", "general"), headers=_h("admin")
    )
    assert (response.status_code, _code(response)) == (422, "fixed_type")


def test_central_rule_is_checked_again_when_approving(env: Env) -> None:
    env.agents.versions[VersionStatus.PUBLISHED].pop()
    change_id = _propose(env, _update("platform", "general"))
    # An agent with account-data tools is approved for the group while the request waits.
    env.agents.versions[VersionStatus.APPROVED] = [
        _agent("c" * 16, "Alarmas", ["platform"], ["cloudwatch.describe_alarms"])
    ]
    response = _decide(env, change_id, "approve", "admin2")
    assert (response.status_code, _code(response)) == (409, "central_in_use")
    assert _registry(env)["platform"]["type"] == "central"


@pytest.mark.parametrize(
    ("body", "status", "code"),
    [
        (_update("hr", "general"), 422, "invalid_request"),
        (_update("nobody", "central"), 404, "not_found"),
        (_update("hr", "central", base_version=3), 409, "version_conflict"),
        (_update("bu-security", "general"), 422, "fixed_type"),
        (_update("bu-security", "area", area="sandbox"), 422, "fixed_type"),
        (_update("bu-lead", "central"), 422, "fixed_type"),
        (_update("hr", "area", area="marketing"), 422, "unknown_area"),
        (
            {"kind": "update", "group_id": "hr", "type": "central", "reason": "x"},
            422,
            "invalid_request",
        ),
    ],
)
def test_change_of_type_is_validated_by_the_server(
    env: Env, body: dict[str, Any], status: int, code: str
) -> None:
    response = env.client.post(f"{BASE}/changes", json=body, headers=_h("admin"))
    assert (response.status_code, _code(response)) == (status, code)
    assert _changes(env) == {}


def test_nobody_proposes_or_decides_the_type_of_a_group_they_belong_to(env: Env) -> None:
    own = env.client.post(
        f"{BASE}/changes", json=_update("hr", "central"), headers=_h("member-admin")
    )
    assert (own.status_code, _code(own)) == (403, "self_edit")
    assert env.audit.named("settings.groups.proposed", "rejected")[0][1]["error"] == "self_edit"

    change_id = _propose(env, _update("hr", "central"))
    for action, body in (("approve", {}), ("reject", {"reason": "no"})):
        response = _decide(env, change_id, action, "member-admin", body)
        assert (response.status_code, _code(response)) == (403, "self_edit")
    assert _changes(env)[change_id]["status"] == "pending"
    assert _registry(env)["hr"]["type"] == "general"
    # Adopting a directory group they are already in is the same escalation.
    env.directory.groups.add("legal")
    TOKENS["member-admin"]["cognito:groups"].append("legal")
    try:
        created = env.client.post(
            f"{BASE}/changes", json=_create("legal", type="central"), headers=_h("member-admin")
        )
        assert (created.status_code, _code(created)) == (403, "self_edit")
    finally:
        TOKENS["member-admin"]["cognito:groups"].remove("legal")


def test_a_group_changed_meanwhile_cannot_be_approved(env: Env) -> None:
    change_id = _propose(env, _update("hr", "central"))
    # Someone writes the group outside the request (e.g. an operator fixing the registry).
    _group(env.db, "hr", "general", description="Personas")
    env.db.update_item(
        TableName="settings",
        Key={"PK": {"S": "GROUPS"}, "SK": {"S": "hr"}},
        UpdateExpression="SET version = :v",
        ExpressionAttributeValues={":v": {"N": "7"}},
    )
    response = _decide(env, change_id, "approve", "admin2")
    assert (response.status_code, _code(response)) == (409, "version_conflict")
    assert _registry(env)["hr"]["type"] == "general"


def test_the_transaction_itself_refuses_a_stale_version_and_the_proposer(env: Env) -> None:
    change_id = _propose(env, _update("hr", "central"))
    change = env.store.change(change_id)
    assert change is not None
    with pytest.raises(ConflictError):
        env.store.apply(
            change, approver="admin-1", approver_email=None, token=None, now=env.clock()
        )
    assert _registry(env)["hr"]["type"] == "general"
    env.db.update_item(
        TableName="settings",
        Key={"PK": {"S": "GROUPS"}, "SK": {"S": "hr"}},
        UpdateExpression="SET version = :v",
        ExpressionAttributeValues={":v": {"N": "7"}},
    )
    with pytest.raises(ConflictError):
        env.store.apply(
            change, approver="admin-2", approver_email=None, token=None, now=env.clock()
        )
    assert _registry(env)["hr"]["type"] == "general"
    assert _changes(env)[change_id]["status"] == "pending"


# --- Delete -------------------------------------------------------------------------------


def test_delete_removes_the_group_from_the_registry_and_from_cognito(env: Env) -> None:
    change_id = _propose(env, _delete("platform"))
    pending = _changes(env)[change_id]
    assert (pending["kind"], pending["agents"], pending["after"]) == ("delete", 1, None)
    assert _decide(env, change_id, "approve", "admin2").status_code == 200
    assert "platform" not in _registry(env)
    assert env.directory.calls == [("delete", "platform")]
    assert "platform" not in env.directory.groups
    assert env.audit.named("settings.groups.approved")[0][1]["directory"] == "deleted"
    # The name cannot come back while the agent still shares with it.
    again = env.client.post(f"{BASE}/changes", json=_create("platform"), headers=_h("admin"))
    assert (again.status_code, _code(again)) == (409, "group_referenced")


def test_a_member_may_take_part_in_deleting_their_group(env: Env) -> None:
    change_id = _propose(env, _delete("hr"), token="member-admin")
    assert _decide(env, change_id, "approve", "admin").status_code == 200
    assert "hr" not in _registry(env)


@pytest.mark.parametrize("group", ["finops-central", "bu-lead"])
def test_role_groups_cannot_be_deleted(env: Env, group: str) -> None:
    response = env.client.post(f"{BASE}/changes", json=_delete(group), headers=_h("admin"))
    assert (response.status_code, _code(response)) == (422, "system_group")


def test_delete_forbids_fields_of_a_group(env: Env) -> None:
    body = {**_delete("hr"), "type": "general"}
    response = env.client.post(f"{BASE}/changes", json=body, headers=_h("admin"))
    assert (response.status_code, _code(response)) == (422, "invalid_request")


# --- Directory failures and retries -------------------------------------------------------


def test_a_directory_failure_leaves_the_request_pending_and_can_be_retried(env: Env) -> None:
    change_id = _propose(env, _create())
    env.directory.fail = True
    response = _decide(env, change_id, "approve", "admin2")
    assert (response.status_code, _code(response)) == (502, "upstream_error")
    assert "people" not in _registry(env)
    assert _changes(env)[change_id]["status"] == "pending"
    assert (
        env.audit.named("settings.groups.approved", "rejected")[0][1]["error"] == "upstream_error"
    )
    env.directory.fail = False
    assert _decide(env, change_id, "approve", "admin2").status_code == 200
    assert "people" in _registry(env)


def test_an_approval_that_died_halfway_can_be_taken_over_after_a_while(env: Env) -> None:
    change_id = _propose(env, _delete("hr"))
    change = env.store.change(change_id)
    assert change is not None
    # The process died after claiming the request and deleting the Cognito group.
    env.store.claim(change, "admin-2", env.clock())
    env.directory.groups.remove("hr")
    assert _changes(env)[change_id]["status"] == "pending"
    busy = _decide(env, change_id, "approve", "admin2")
    assert (busy.status_code, _code(busy)) == (409, "version_conflict")
    # Rejecting or withdrawing a claimed request is not possible either.
    assert _decide(env, change_id, "withdraw", "admin").status_code == 409
    env.clock.now += STALE_CLAIM + timedelta(seconds=1)
    # Still never the proposer.
    own = _decide(env, change_id, "approve", "admin")
    assert (own.status_code, _code(own)) == (403, "same_approver")
    assert _decide(env, change_id, "approve", "admin2").status_code == 200
    assert "hr" not in _registry(env)
    assert env.audit.named("settings.groups.approved")[0][1]["directory"] == "absent"


def test_a_stale_claim_token_cannot_finish_the_request(env: Env) -> None:
    change_id = _propose(env, _create())
    change = env.store.change(change_id)
    assert change is not None
    stale = env.store.claim(change, "admin-2", env.clock())
    later = env.clock() + STALE_CLAIM + timedelta(seconds=1)
    fresh = env.store.claim(change, "admin-2", later)
    with pytest.raises(ConflictError):
        env.store.apply(change, approver="admin-2", approver_email=None, token=stale, now=later)
    assert "people" not in _registry(env)
    env.store.apply(change, approver="admin-2", approver_email=None, token=fresh, now=later)
    assert "people" in _registry(env)


# --- Reject, withdraw, expiry -------------------------------------------------------------


def test_reject_needs_a_reason_and_another_administrator(env: Env) -> None:
    change_id = _propose(env, _create())
    own = _decide(env, change_id, "reject", "admin", {"reason": "no"})
    assert (own.status_code, _code(own)) == (403, "use_withdraw")
    assert _decide(env, change_id, "reject", "admin2", {}).status_code == 422
    assert _decide(env, change_id, "reject", "admin2", {"reason": "Duplicado"}).status_code == 200
    change = _changes(env)[change_id]
    assert (change["status"], change["note"], change["decided_by"]) == (
        "rejected",
        "Duplicado",
        "admin-2",
    )
    assert env.directory.calls == []
    # The group is free again for a new request.
    _propose(env, _create())
    closed = _decide(env, change_id, "approve", "admin2")
    assert (closed.status_code, _code(closed)) == (409, "version_conflict")


def test_only_the_proposer_withdraws(env: Env) -> None:
    change_id = _propose(env, _create())
    other = _decide(env, change_id, "withdraw", "admin2")
    assert (other.status_code, _code(other)) == (403, "not_proposer")
    assert _decide(env, change_id, "withdraw", "admin").status_code == 200
    assert _changes(env)[change_id]["status"] == "withdrawn"
    assert env.audit.named("settings.groups.withdrawn")[0][0] == "admin-1"
    _propose(env, _create())


def test_an_expired_request_is_not_applied_and_no_longer_blocks(env: Env) -> None:
    change_id = _propose(env, _create())
    env.clock.now += CHANGE_LIFETIME + timedelta(minutes=1)
    assert _changes(env)[change_id]["status"] == "expired"
    response = _decide(env, change_id, "approve", "admin2")
    assert (response.status_code, _code(response)) == (410, "expired")
    assert env.directory.calls == []
    newer = _propose(env, _create(), token="admin2")
    # Closing the expired one must not release the lock the new request holds.
    assert _decide(env, change_id, "withdraw", "admin").status_code == 200
    again = env.client.post(f"{BASE}/changes", json=_create(), headers=_h("admin"))
    assert (again.status_code, _code(again)) == (409, "already_pending")
    assert _changes(env)[newer]["status"] == "pending"


def test_unknown_and_malformed_request_ids(env: Env) -> None:
    missing = _decide(env, "a" * 32, "approve", "admin")
    assert (missing.status_code, _code(missing)) == (404, "not_found")
    assert _decide(env, "not-an-id", "approve", "admin").status_code == 422


# --- Audit fail closed --------------------------------------------------------------------


def test_nothing_is_written_when_the_audit_trail_is_down(env: Env) -> None:
    env.audit.fail_outcomes = {"requested"}
    response = env.client.post(f"{BASE}/changes", json=_create(), headers=_h("admin"))
    assert (response.status_code, _code(response)) == (503, "audit_unavailable")
    assert _changes(env) == {}
    env.audit.fail_outcomes = set()
    change_id = _propose(env, _create())
    env.audit.fail_outcomes = {"requested"}
    response = _decide(env, change_id, "approve", "admin2")
    assert (response.status_code, _code(response)) == (503, "audit_unavailable")
    assert env.directory.calls == []
    assert "people" not in _registry(env)
    response = env.client.put(
        f"{BASE}/hr/description", json={"version": 0, "description": "x"}, headers=_h("admin")
    )
    assert (response.status_code, _code(response)) == (503, "audit_unavailable")
    assert _registry(env)["hr"]["description"] == "Personas"


# --- Description --------------------------------------------------------------------------


def test_one_administrator_edits_the_description(env: Env) -> None:
    response = env.client.put(
        f"{BASE}/hr/description",
        json={"version": 0, "description": "<i>Personas</i> y Cultura"},
        headers=_h("member-admin"),
    )
    assert response.status_code == 200, response.text
    group = _registry(env)["hr"]
    assert (group["description"], group["version"], group["type"]) == (
        "<i>Personas</i> y Cultura",
        1,
        "general",
    )
    detail = env.audit.named("settings.groups.description_updated")[0][1]
    assert detail["before"] == {"description": "Personas"}
    stale = env.client.put(
        f"{BASE}/hr/description", json={"version": 0, "description": "x"}, headers=_h("admin")
    )
    assert (stale.status_code, _code(stale)) == (409, "version_conflict")


def test_description_cannot_change_under_an_open_request(env: Env) -> None:
    _propose(env, _update("hr", "central"))
    response = env.client.put(
        f"{BASE}/hr/description", json={"version": 0, "description": "x"}, headers=_h("admin")
    )
    assert (response.status_code, _code(response)) == (409, "already_pending")
    change = env.store.change(next(iter(_changes(env))))
    assert change is not None
    # The transaction refuses it too, not only the check before it.
    with pytest.raises(ConflictError):
        env.store.set_description("hr", 0, "x", "admin-1", env.clock())


@pytest.mark.parametrize(
    ("path", "body", "status"),
    [
        ("nobody", {"version": 0, "description": "x"}, 404),
        ("hr", {"version": 0, "description": "x" * 201}, 422),
        ("hr", {"version": 0, "description": "bad\x00"}, 422),
        ("hr", {"version": 0, "description": "x", "type": "central"}, 422),
        ("HR", {"version": 0, "description": "x"}, 422),
    ],
)
def test_description_is_validated(env: Env, path: str, body: dict[str, Any], status: int) -> None:
    response = env.client.put(f"{BASE}/{path}/description", json=body, headers=_h("admin"))
    assert response.status_code == status
    assert _registry(env)["hr"] == {
        **_registry(env)["hr"],
        "description": "Personas",
        "type": "general",
    }


# --- Cognito wrapper ----------------------------------------------------------------------


def _cognito() -> tuple[CognitoGroups, Stubber]:
    client = boto3.client(
        "cognito-idp", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x"
    )
    return CognitoGroups(client, "us-east-1_Pool"), Stubber(client)


def test_cognito_groups_are_created_and_deleted_on_the_pool_only() -> None:
    groups, stub = _cognito()
    stub.add_response(
        "create_group",
        {"Group": {"GroupName": "people"}},
        {"UserPoolId": "us-east-1_Pool", "GroupName": "people", "Description": "Personas"},
    )
    stub.add_response("create_group", {}, {"UserPoolId": "us-east-1_Pool", "GroupName": "bare"})
    stub.add_response("delete_group", {}, {"UserPoolId": "us-east-1_Pool", "GroupName": "people"})
    with stub:
        assert groups.create("people", "Personas") == "created"
        assert groups.create("bare", "") == "created"
        assert groups.delete("people") == "deleted"
        stub.assert_no_pending_responses()


def test_cognito_operations_are_idempotent_and_fail_closed() -> None:
    groups, stub = _cognito()
    stub.add_client_error("create_group", "GroupExistsException")
    stub.add_client_error("delete_group", "ResourceNotFoundException")
    stub.add_client_error("create_group", "NotAuthorizedException")
    stub.add_client_error("delete_group", "TooManyRequestsException")
    with stub:
        assert groups.create("people", "") == "adopted"
        assert groups.delete("people") == "absent"
        with pytest.raises(DirectoryUnavailableError):
            groups.create("people", "")
        with pytest.raises(DirectoryUnavailableError):
            groups.delete("people")
    with pytest.raises(ValueError, match="user pool"):
        CognitoGroups(boto3.client("cognito-idp", region_name="us-east-1"), "")
