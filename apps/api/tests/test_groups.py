"""Groups in the identity (Marketplace A1): /api/me, the registry and the L1 user entity."""

from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api.authz import Authorizer
from mango_api.groups import GroupRegistry
from mango_core.identity import IdentityError, user_from_claims

from .test_admin import RecordingAudit, _table
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

EXP = int(time.time()) + 3600
TOKENS: dict[str, dict[str, Any]] = {
    "admin": {
        "sub": "admin-1",
        "mango_role": "finops-central",
        "mango_admin": "true",
        "cognito:groups": ["finops-central", "mango-admin"],
    },
    "admin-only": {"sub": "admin-2", "mango_admin": "true", "cognito:groups": ["mango-admin"]},
    "creator": {"sub": "creator-1", "cognito:groups": ["mango-agent-creator", "hr"]},
    "member": {"sub": "member-1", "cognito:groups": ["hr"]},
    "lead": {
        "sub": "lead-1",
        "mango_role": "bu-lead",
        "mango_business_unit": "security",
        "cognito:groups": ["bu-lead", "bu-security"],
    },
    "nogroup": {"sub": "new-1"},
    "federated-only": {"sub": "new-2", "cognito:groups": ["us-east-1_AbCdEfGhI_Okta"]},
}


class FakeVerifier:
    def verify(self, token: str) -> dict[str, Any]:
        if token not in TOKENS:
            raise IdentityError("invalid")
        return {**TOKENS[token], "exp": EXP}


@dataclass
class CedarLikeAuthorizer:
    """Mirrors the platform policies that matter here."""

    decisions: list[tuple[str, str, bool]] = field(default_factory=list)

    def is_allowed(self, user: Any, action: str, _rt: str, _rid: str, agent: Any = None) -> bool:
        if action in ("ViewGroups", "CreateAgent"):
            allowed = bool(user.is_admin or "mango-agent-creator" in user.groups)
        elif action == "UseAgent":
            # By the groups of the agent's published version (D33).
            allowed = agent is not None and bool(agent.groups & user.groups)
        else:
            allowed = bool(user.is_admin)
        self.decisions.append((user.user_id, action, allowed))
        return allowed


def _group(db: Any, group_id: str, kind: str, **extra: str) -> None:
    item = {"PK": {"S": "GROUPS"}, "SK": {"S": group_id}, "type": {"S": kind}}
    item.update({k: {"S": v} for k, v in extra.items()})
    db.put_item(TableName="settings", Item=item)


@dataclass
class Env:
    client: TestClient
    db: Any
    audit: RecordingAudit
    authorizer: CedarLikeAuthorizer
    agentcore: FakeAgentCore


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "settings")
        # What the IaC seed writes, plus an unrelated partition that must never be listed.
        _group(db, "finops-central", "central", description="FinOps central")
        _group(db, "bu-security", "area", area="security", description="Líderes de security")
        _group(db, "hr", "general")
        db.put_item(TableName="settings", Item={"PK": {"S": "BUDGETS"}, "SK": {"S": "DEFAULTS"}})
        audit, authorizer, agentcore = RecordingAudit(), CedarLikeAuthorizer(), FakeAgentCore()

        def factory(s: Any) -> app_module.Services:
            return app_module.Services(
                settings=s,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=authorizer,  # type: ignore[arg-type]
                budgets=None,  # type: ignore[arg-type]
                conversations=FakeConversations(),  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=agentcore,
                bedrock=FakeBedrock(),
                settings_store=None,  # type: ignore[arg-type]
                budget_limits=FakeLimits(),  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=FakePublished(),  # type: ignore[arg-type]
                model_catalog=FakeModelCatalog(),  # type: ignore[arg-type]
                invocation_key=b"k" * 32,
                group_registry=GroupRegistry(db, "settings"),
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(client, db, audit, authorizer, agentcore)


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# --- GET /api/me ------------------------------------------------------------------------


def test_creator_without_finops_role_gets_in_and_can_create_agents(env: Env) -> None:
    assert env.client.get("/api/me", headers=_h("creator")).json() == {
        "user_id": "creator-1",
        "email": None,
        "name": None,
        "role": None,
        "business_unit": None,
        "is_admin": False,
        "groups": ["hr", "mango-agent-creator"],
        "can": {"create_agent": True},
    }


@pytest.mark.parametrize(
    ("token", "role", "create_agent"),
    [
        ("admin", "finops-central", True),
        ("admin-only", None, True),
        ("member", None, False),
        ("lead", "bu-lead", False),
    ],
)
def test_me_reports_role_groups_and_hints(
    env: Env, token: str, role: str | None, create_agent: bool
) -> None:
    body = env.client.get("/api/me", headers=_h(token)).json()
    assert body["role"] == role
    assert body["groups"] == sorted(TOKENS[token]["cognito:groups"])
    assert body["can"] == {"create_agent": create_agent}


@pytest.mark.parametrize("token", ["nogroup", "federated-only"])
def test_user_without_a_mango_group_still_has_no_access(env: Env, token: str) -> None:
    for method, path, body in (
        ("GET", "/api/me", None),
        ("GET", "/api/groups", None),
        ("GET", "/api/conversations", None),
        ("POST", "/api/chat", {"message": "hola"}),
    ):
        response = env.client.request(method, path, headers=_h(token), json=body)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "no_group"
    assert env.authorizer.decisions == []
    assert env.agentcore.requests == []


def test_a_group_alone_does_not_open_the_finops_agent(env: Env) -> None:
    for token in ("creator", "member", "admin-only"):
        chat = env.client.post("/api/chat", headers=_h(token), json={"message": "hola"})
        assert chat.status_code == 403
        assert chat.json()["error"]["code"] == "forbidden"
    assert env.agentcore.requests == []


# --- GET /api/groups --------------------------------------------------------------------


@pytest.mark.parametrize("token", ["admin", "admin-only", "creator"])
def test_admins_and_creators_list_the_registry(env: Env, token: str) -> None:
    response = env.client.get("/api/groups", headers=_h(token))
    assert response.status_code == 200
    assert response.json() == {
        "items": [
            {
                "id": "bu-security",
                "type": "area",
                "area": "security",
                "description": "Líderes de security",
            },
            {
                "id": "finops-central",
                "type": "central",
                "area": None,
                "description": "FinOps central",
            },
            {"id": "hr", "type": "general", "area": None, "description": ""},
        ]
    }


@pytest.mark.parametrize("token", ["member", "lead"])
def test_other_users_cannot_list_groups(env: Env, token: str) -> None:
    response = env.client.get("/api/groups", headers=_h(token))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


def test_listing_groups_requires_a_token(env: Env) -> None:
    assert env.client.get("/api/groups").status_code == 401
    assert env.client.get("/api/groups", headers=_h("forged")).status_code == 401


def test_group_listing_decision_is_audited_as_a_read(env: Env) -> None:
    env.client.get("/api/groups", headers=_h("creator"))
    env.client.get("/api/groups", headers=_h("member"))
    decisions = env.audit.named("policy.decision", outcome=None)
    assert [(user, d["action"], d["allowed"], d["read_only"]) for user, d in decisions] == [
        ("creator-1", "ViewGroups", True, True),
        ("member-1", "ViewGroups", False, True),
    ]


@pytest.mark.parametrize(
    "item",
    [
        {"type": {"S": "owner"}},
        {"type": {"S": "area"}},  # area group without its area
        {"type": {"S": "general"}, "area": {"S": "security"}},
        {"type": {"S": "general"}, "description": {"S": "x" * 201}},
        {"description": {"S": "no type"}},
        {"type": {"N": "1"}},
    ],
)
def test_invalid_registry_fails_closed(env: Env, item: dict[str, Any]) -> None:
    env.db.put_item(
        TableName="settings", Item={"PK": {"S": "GROUPS"}, "SK": {"S": "broken"}, **item}
    )
    response = env.client.get("/api/groups", headers=_h("admin"))
    assert response.status_code == 503
    assert response.json() == {
        "error": {"code": "groups_unavailable", "message": "please try again"}
    }


def test_registry_read_failure_fails_closed(env: Env) -> None:
    env.db.delete_table(TableName="settings")
    response = env.client.get("/api/groups", headers=_h("admin"))
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "groups_unavailable"


def test_groups_endpoint_rejects_writes(env: Env) -> None:
    for method in ("POST", "PUT", "DELETE"):
        response = env.client.request(method, "/api/groups", headers=_h("admin"), json={})
        assert response.status_code == 405


# --- L1 user entity and UI hints --------------------------------------------------------


@dataclass
class RecordingAvp:
    calls: list[dict[str, Any]] = field(default_factory=list)
    decision: str = "ALLOW"

    def is_authorized(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {"decision": self.decision}


def _entity(claims: dict[str, Any]) -> dict[str, Any]:
    avp = RecordingAvp()
    user = user_from_claims(claims)
    assert Authorizer(avp, "ps").is_allowed(user, "ViewGroups", "Mango::Platform", "mango")  # type: ignore[arg-type]
    entities = avp.calls[0]["entities"]["entityList"]
    return next(e for e in entities if e["identifier"]["entityType"] == "Mango::User")


def test_user_entity_carries_groups_from_the_token() -> None:
    entity = _entity(TOKENS["creator"])
    assert entity["identifier"] == {"entityType": "Mango::User", "entityId": "creator-1"}
    assert entity["attributes"] == {
        "isAdmin": {"boolean": False},
        "groups": {"set": [{"string": "hr"}, {"string": "mango-agent-creator"}]},
    }


def test_user_entity_keeps_role_and_business_unit_when_present() -> None:
    assert _entity(TOKENS["lead"])["attributes"] == {
        "isAdmin": {"boolean": False},
        "groups": {"set": [{"string": "bu-lead"}, {"string": "bu-security"}]},
        "role": {"string": "bu-lead"},
        "businessUnit": {"string": "security"},
    }


def test_user_entity_has_an_empty_group_set_for_tokens_without_the_claim() -> None:
    attributes = _entity({"sub": "u", "mango_role": "finops-central"})["attributes"]
    assert attributes["groups"] == {"set": []}
