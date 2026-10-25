"""Construir > Skills (D92): skills of instructions with an approval per version, against moto
DynamoDB and S3 (real conditions, transactions and ``If-None-Match``)."""

from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api.mcp_catalog import McpCatalog
from mango_api.probe import RateLimiter
from mango_api.skills import CHANGE_LIFETIME, SkillsDeps, skill_id_of
from mango_api.skills_store import ConflictError, SkillStore
from mango_core.agents import ROOT_SUPERVISOR, AgentDefinition, VersionStatus
from mango_core.identity import IdentityError
from mango_core.skills import object_key

from .test_admin import RecordingAudit, _code, _h, _table
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

BASE = "/api/skills"
BUCKET = "skills-bucket"
EXP = int(time.time()) + 3600
TOKENS: dict[str, dict[str, Any]] = {
    "admin": {"sub": "admin-1", "mango_admin": "true", "cognito:groups": ["mango-admin"]},
    "admin2": {"sub": "admin-2", "mango_admin": "true", "cognito:groups": ["mango-admin"]},
    "creator": {
        "sub": "creator-1",
        "cognito:groups": ["mango-agent-creator"],
        "mango_email": "c1@example.com",
    },
    "user": {"sub": "user-1", "cognito:groups": ["hr"]},
}


class FakeVerifier:
    def verify(self, token: str) -> dict[str, Any]:
        if token not in TOKENS:
            raise IdentityError("invalid")
        return {**TOKENS[token], "exp": EXP}


@dataclass
class CedarLikeAuthorizer:
    """Mirrors the platform policies of skills (``skills-*.cedar``)."""

    decisions: list[tuple[str, str, bool]] = field(default_factory=list)

    def is_allowed(self, user: Any, action: str, _rt: str, _rid: str, agent: Any = None) -> bool:
        creator = "mango-agent-creator" in user.groups
        allowed = bool(user.is_admin) or (action != "ApproveSkill" and creator)
        self.decisions.append((user.user_id, action, allowed))
        return allowed


@dataclass
class Version:
    agent_id: str
    number: int
    definition: AgentDefinition


def _agent(agent_id: str, name: str, skills: list[str]) -> Version:
    return Version(
        agent_id,
        3,
        AgentDefinition.model_validate(
            {
                "name": name,
                "reports_to": ROOT_SUPERVISOR,
                "role": "Rol",
                "model": SONNET,
                "allowed_models": [SONNET],
                "system_prompt": "Eres un analista.",
                "tools": ["cost-explorer.get_cost_and_usage"],
                "groups": ["finops-central"],
                "skills": skills,
            }
        ),
    )


@dataclass
class FakeAgents:
    published: list[Version] = field(default_factory=list)

    def by_status(self, status: VersionStatus) -> list[Version]:
        return self.published if status is VersionStatus.PUBLISHED else []


@dataclass
class Clock:
    now: datetime = datetime(2026, 10, 25, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now


@dataclass
class Env:
    client: TestClient
    db: Any
    s3: Any
    audit: RecordingAudit
    agents: FakeAgents
    clock: Clock
    store: SkillStore


def _catalog() -> McpCatalog:
    return McpCatalog(
        [
            _connector("cost-explorer", "account_data", "per_user", get_cost_and_usage="read"),
            _connector("aws-budgets", "write", "service", create_budget="write"),
            _connector("pricing", "public", "service", get_products="read"),
        ]
    )


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        s3 = boto3.client("s3", region_name="us-east-1")
        _table(db, "skills")
        s3.create_bucket(Bucket=BUCKET)
        audit, agents, clock = RecordingAudit(), FakeAgents(), Clock()
        store = SkillStore(db, "skills", s3, BUCKET)
        catalog = _catalog()

        def factory(s: Any) -> app_module.Services:
            return app_module.Services(
                settings=s,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=CedarLikeAuthorizer(),  # type: ignore[arg-type]
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
                skills=SkillsDeps(
                    store=store,
                    agents=agents,  # type: ignore[arg-type]
                    catalog=lambda: catalog,
                    audit=audit,  # type: ignore[arg-type]
                    rate_limiter=RateLimiter(limit=50, window_seconds=3600),
                    clock=clock,
                ),
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(client, db, s3, audit, agents, clock, store)


def _body(**overrides: Any) -> dict[str, Any]:
    return {
        "name": "Cost Analysis",
        "category": "FinOps",
        "description": "Descompone el gasto por cuenta.",
        "instructions": "1. Consulta {{período}} en Cost Explorer.\n2. Resume.",
        "outputs": ["breakdown"],
        "servers": ["cost-explorer"],
        "reason": "Lo pide FinOps",
        **overrides,
    }


def _propose(env: Env, token: str = "creator", **overrides: Any) -> str:
    response = env.client.post(BASE, json=_body(**overrides), headers=_h(token))
    assert response.status_code == 201, response.text
    return str(response.json()["change_id"])


def _decide(env: Env, change_id: str, action: str, token: str, body: Any = None) -> Any:
    return env.client.post(
        f"{BASE}/changes/{change_id}/{action}", json=body or {}, headers=_h(token)
    )


def _approved(env: Env, **overrides: Any) -> str:
    change_id = _propose(env, **overrides)
    assert _decide(env, change_id, "approve", "admin").status_code == 200
    return change_id


def test_the_id_comes_from_the_name() -> None:
    assert skill_id_of("Análisis de Costos (v2)") == "analisis-de-costos-v2"
    assert skill_id_of("  ¡¡  ") == ""
    assert len(skill_id_of("x" * 80)) == 40


def test_only_admins_and_creators_see_and_propose(env: Env) -> None:
    assert env.client.get(BASE, headers=_h("user")).status_code == 403
    assert env.client.post(BASE, json=_body(), headers=_h("user")).status_code == 403
    view = env.client.get(BASE, headers=_h("creator")).json()
    assert view == {
        "items": [],
        "changes": [],
        "categories": ["FinOps", "DevOps", "ERP", "Productivity", "Security", "Data"],
        "max_per_agent": 10,
        "can_approve": False,
    }


def test_a_new_skill_waits_for_another_admin_and_then_writes_its_skill_md(env: Env) -> None:
    change_id = _propose(env)
    view = env.client.get(BASE, headers=_h("admin")).json()
    assert view["items"] == []
    [pending] = view["changes"]
    assert (pending["skill_id"], pending["version"], pending["status"]) == (
        "cost-analysis",
        1,
        "pending",
    )
    assert pending["variables"] == ["período"]
    assert pending["own"] is False
    # Creators never approve; whoever proposed neither.
    assert _code(_decide(env, change_id, "approve", "creator")) == "forbidden"
    response = _decide(env, change_id, "approve", "admin")
    assert response.status_code == 200, response.text
    [item] = response.json()["items"]
    assert (item["id"], item["version"], item["owner"], item["owner_email"]) == (
        "cost-analysis",
        1,
        "creator-1",
        "c1@example.com",
    )
    assert item["data_tier"] == "account_data"
    assert item["available"] is True
    body = env.s3.get_object(Bucket=BUCKET, Key=object_key("cost-analysis", 1))["Body"].read()
    assert body.decode().startswith("---\nname: cost-analysis\n")
    applied = env.audit.named("skills.approved")
    assert applied[0][1]["markdown_sha256"]
    # Nothing of the text goes to the audit.
    assert all("Consulta" not in str(detail) for _, _, detail in env.audit.events)


def test_whoever_proposes_never_approves_nor_rejects(env: Env) -> None:
    change_id = _propose(env, token="admin")
    assert _code(_decide(env, change_id, "approve", "admin")) == "same_approver"
    assert _code(_decide(env, change_id, "reject", "admin", {"reason": "no"})) == "use_withdraw"
    assert env.audit.named("skills.approved", outcome="rejected")
    assert _decide(env, change_id, "withdraw", "admin").status_code == 200
    # The name is free again.
    _propose(env)


def test_reject_needs_a_reason_and_frees_the_name(env: Env) -> None:
    change_id = _propose(env)
    assert _decide(env, change_id, "reject", "admin", {"reason": " "}).status_code in (409, 422)
    response = _decide(env, change_id, "reject", "admin", {"reason": "Falta detalle"})
    assert response.status_code == 200
    [change] = response.json()["changes"]
    assert (change["status"], change["note"], change["decided_by"]) == (
        "rejected",
        "Falta detalle",
        "admin-1",
    )
    _propose(env)


def test_a_name_in_use_or_waiting_is_refused(env: Env) -> None:
    _propose(env)
    response = env.client.post(BASE, json=_body(), headers=_h("admin"))
    assert _code(response) == "skill_exists"


def test_an_expired_request_is_shown_expired_and_cannot_be_approved(env: Env) -> None:
    change_id = _propose(env)
    env.clock.now += CHANGE_LIFETIME + timedelta(minutes=1)
    [change] = env.client.get(BASE, headers=_h("admin")).json()["changes"]
    assert change["status"] == "expired"
    assert _code(_decide(env, change_id, "approve", "admin")) == "expired"
    _propose(env, token="admin")


def test_secrets_and_disabled_servers_are_refused(env: Env) -> None:
    secret = "usa AKIAIOSFODNN7EXAMPLE para entrar"
    response = env.client.post(BASE, json=_body(instructions=secret), headers=_h("creator"))
    assert _code(response) == "secret_detected"
    assert "AKIA" not in response.text
    response = env.client.post(BASE, json=_body(servers=["sap"]), headers=_h("creator"))
    assert _code(response) == "server_not_enabled"
    response = env.client.post(BASE, json=_body(category="Ventas"), headers=_h("creator"))
    assert _code(response) == "invalid_request"
    response = env.client.post(BASE, json=_body(extra=1), headers=_h("creator"))
    assert response.status_code == 422


def test_a_new_version_keeps_agents_on_theirs(env: Env) -> None:
    _approved(env)
    env.agents.published = [
        _agent("aaaaaaaaaaaaaaaa", "Analista", ["cost-analysis@1"]),
        _agent("bbbbbbbbbbbbbbbb", "Otro", []),
    ]
    stale = env.client.post(
        f"{BASE}/cost-analysis/versions",
        json=_body(instructions="v2", base_version=2),
        headers=_h("creator"),
    )
    assert _code(stale) == "version_conflict"
    response = env.client.post(
        f"{BASE}/cost-analysis/versions",
        json=_body(instructions="Nueva {{x}}", base_version=1),
        headers=_h("creator"),
    )
    assert response.status_code == 201, response.text
    second = env.client.post(
        f"{BASE}/cost-analysis/versions",
        json=_body(instructions="Otra", base_version=1),
        headers=_h("admin"),
    )
    assert _code(second) == "already_pending"
    [item] = env.client.get(BASE, headers=_h("admin")).json()["items"]
    assert item["pending"]["version"] == 2
    _decide(env, response.json()["change_id"], "approve", "admin")
    detail = env.client.get(f"{BASE}/cost-analysis", headers=_h("creator")).json()
    assert detail["skill"]["version"] == 2
    assert (detail["skill"]["agents"], detail["skill"]["outdated_agents"]) == (1, 1)
    assert detail["instructions"] == "Nueva {{x}}"
    assert detail["variables"] == ["x"]
    assert [a["skill_version"] for a in detail["agents_using"]] == [1]
    assert [v["version"] for v in detail["versions"]] == [2, 1]
    # Version 1 is still there for the agents that name it.
    env.s3.head_object(Bucket=BUCKET, Key=object_key("cost-analysis", 1))


def test_an_approved_version_is_never_rewritten(env: Env) -> None:
    _approved(env)
    approved = env.store.version("cost-analysis", 1)
    assert approved is not None
    change = env.store.change(approved.change_id)
    assert change is not None
    other = replace(
        change, content=change.content.model_copy(update={"instructions": "Otro texto"})
    )
    with pytest.raises(ConflictError):
        env.store.approve(other, approver="admin-2", approver_email=None, now=env.clock.now)
    body = env.s3.get_object(Bucket=BUCKET, Key=object_key("cost-analysis", 1))["Body"].read()
    assert b"Otro texto" not in body


def test_a_file_no_approved_version_backs_is_replaced(env: Env) -> None:
    # An approval that wrote its file and then lost to a rejection leaves it behind.
    env.s3.put_object(Bucket=BUCKET, Key=object_key("cost-analysis", 1), Body=b"huerfano")
    change_id = _propose(env)
    assert _decide(env, change_id, "approve", "admin").status_code == 200
    body = env.s3.get_object(Bucket=BUCKET, Key=object_key("cost-analysis", 1))["Body"].read()
    assert body.decode().startswith("---\nname: cost-analysis\n")


def test_runs_of_the_last_30_days_are_counted(env: Env) -> None:
    _approved(env)
    env.store.count_run("cost-analysis", env.clock.now - timedelta(days=40))
    env.store.count_run("cost-analysis", env.clock.now - timedelta(days=2))
    env.store.count_run("cost-analysis", env.clock.now)
    [item] = env.client.get(BASE, headers=_h("admin")).json()["items"]
    assert item["runs_30d"] == 2


def test_duplicating_names_an_approved_version(env: Env) -> None:
    _approved(env)
    response = env.client.post(
        BASE,
        json=_body(name="Cost Analysis (copia)", duplicate_of="cost-analysis@3"),
        headers=_h("creator"),
    )
    assert _code(response) == "not_found"
    change_id = _propose(env, name="Cost Analysis (copia)", duplicate_of="cost-analysis@1")
    change = env.store.change(change_id)
    assert change is not None and change.duplicate_of == "cost-analysis@1"


def test_unknown_skill_is_not_found(env: Env) -> None:
    assert env.client.get(f"{BASE}/nada", headers=_h("admin")).status_code == 404
    assert env.client.get(f"{BASE}/Nada", headers=_h("admin")).status_code == 422
    assert _decide(env, "0" * 32, "approve", "admin").status_code == 404
