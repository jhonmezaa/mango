"""Knowledge bases, the registry (D88 (8), (12), (13); knowledge-bases-threat-model.md): the
API with the real Cedar policies and the Knowledge table in moto."""

from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api.authz import Authorizer
from mango_api.groups import GroupsUnavailableError
from mango_api.knowledge import CHANGES_PER_HOUR, KnowledgeDeps
from mango_api.knowledge_store import ALL_PK, INDEX_ALL, KnowledgeStore
from mango_core.groups import GroupDef
from mango_core.identity import IdentityError
from mango_core.knowledge import is_id

from .cedar_fake import CedarPolicyStore
from .test_admin import RecordingAudit
from .test_app import (
    HOST,
    KEY,
    FakeAgentCore,
    FakeBedrock,
    FakeBudgets,
    FakeConversations,
    FakeLimits,
    FakeModelCatalog,
    FakePublished,
    _settings,
)

EXP = int(time.time()) + 3600
CLAIMS: dict[str, dict[str, Any]] = {
    "admin": {
        "sub": "admin-1",
        "mango_admin": "true",
        "mango_email": "admin@example.com",
        "cognito:groups": ["mango-admin"],
    },
    "creator": {
        "sub": "creator-1",
        "mango_email": "creator1@example.com",
        "mango_name": "Creadora Uno",
        "cognito:groups": ["mango-agent-creator", "hr"],
    },
    "creator2": {"sub": "creator-2", "cognito:groups": ["mango-agent-creator", "hr"]},
    "outsider": {"sub": "creator-3", "cognito:groups": ["mango-agent-creator", "finance"]},
    "former": {"sub": "creator-1", "cognito:groups": ["hr"]},
    "member": {"sub": "member-1", "cognito:groups": ["hr"]},
}
GROUPS = ("hr", "finance", "people")


class FakeVerifier:
    def verify(self, token: str) -> dict[str, Any]:
        if token not in CLAIMS:
            raise IdentityError("invalid")
        return {**CLAIMS[token], "exp": EXP, "client_id": "client"}


@dataclass
class FakeGroups:
    unavailable: bool = False

    def list_groups(self) -> list[GroupDef]:
        if self.unavailable:
            raise GroupsUnavailableError("down")
        return [GroupDef(g, "general", None, g) for g in GROUPS]


def create_knowledge_table(db: Any, name: str) -> None:
    db.create_table(
        TableName=name,
        KeySchema=[
            {"AttributeName": "PK", "KeyType": "HASH"},
            {"AttributeName": "SK", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": n, "AttributeType": "S"} for n in ("PK", "SK", "all_pk", "created_at")
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": INDEX_ALL,
                "KeySchema": [
                    {"AttributeName": "all_pk", "KeyType": "HASH"},
                    {"AttributeName": "created_at", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }
        ],
        BillingMode="PAY_PER_REQUEST",
    )


@dataclass
class Env:
    client: TestClient
    audit: RecordingAudit
    groups: FakeGroups
    db: Any

    def create(self, token: str = "creator", **body: Any) -> Any:
        payload = {"name": "Políticas de RR. HH.", "groups": ["hr"], **body}
        return self.client.post("/api/knowledge-bases", headers=_h(token), json=payload)

    def created(self, token: str = "creator", **body: Any) -> dict[str, Any]:
        response = self.create(token, **body)
        assert response.status_code == 201, response.text
        result: dict[str, Any] = response.json()
        return result

    def get(self, token: str, kb_id: str) -> Any:
        return self.client.get(f"/api/knowledge-bases/{kb_id}", headers=_h(token))

    def list(self, token: str) -> Any:
        return self.client.get("/api/knowledge-bases", headers=_h(token))

    def update(self, token: str, kb: dict[str, Any], **changes: Any) -> Any:
        body = {
            "name": kb["name"],
            "description": kb["description"],
            "groups": kb["groups"],
            "classification": kb["classification"],
            "sync_schedule": kb["sync_schedule"],
            "version": kb["version"],
            **changes,
        }
        return self.client.put(f"/api/knowledge-bases/{kb['kb_id']}", headers=_h(token), json=body)

    def delete(self, token: str, kb: dict[str, Any], version: int | None = None) -> Any:
        return self.client.post(
            f"/api/knowledge-bases/{kb['kb_id']}/delete",
            headers=_h(token),
            json={"version": version or kb["version"]},
        )

    def events(self, name: str, outcome: str | None = "applied") -> list[dict[str, Any]]:
        return [d for _u, d in self.audit.named(name, outcome)]


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _code(response: Any) -> str:
    return str(response.json()["error"]["code"])


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        create_knowledge_table(db, "knowledge")
        audit, cedar, groups = RecordingAudit(), CedarPolicyStore(), FakeGroups()
        deps = KnowledgeDeps(
            store=KnowledgeStore(db, "knowledge"),
            groups=groups,  # type: ignore[arg-type]
            areas=lambda: ["security", "sandbox"],
            audit=audit,  # type: ignore[arg-type]
            changes=app_module.Limits().limiter("knowledge.changes"),
        )

        def factory(settings: Any) -> app_module.Services:
            return app_module.Services(
                settings=settings,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=Authorizer(cedar, "ps"),  # type: ignore[arg-type]
                budgets=FakeBudgets(),  # type: ignore[arg-type]
                conversations=FakeConversations(),  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=FakeAgentCore(),
                bedrock=FakeBedrock(),
                settings_store=None,  # type: ignore[arg-type]
                budget_limits=FakeLimits(),  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=FakePublished(agents={}),  # type: ignore[arg-type]
                model_catalog=FakeModelCatalog(),  # type: ignore[arg-type]
                invocation_key=KEY,
                knowledge=deps,
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(client, audit, groups, db)
        assert cedar.errors == []


# --- Who may do what --------------------------------------------------------------------


def test_people_who_create_no_agents_see_no_knowledge_bases(env: Env) -> None:
    for token in ("member", "former"):
        assert env.list(token).status_code == 403
        assert env.create(token).status_code == 403
    kb = env.created()
    assert env.get("member", kb["kb_id"]).status_code == 403
    assert env.update("member", kb, name="x").status_code == 403
    assert env.delete("member", kb).status_code == 403


def test_creating_records_the_caller_as_owner_and_starts_unsynchronized(env: Env) -> None:
    kb = env.created(description="Reglamento interno", classification="confidential")
    assert is_id(kb["kb_id"])
    assert kb["owner"] == {
        "user_id": "creator-1",
        "name": "Creadora Uno",
        "email": "creator1@example.com",
    }
    assert kb["status"] == "pending"
    assert (kb["documents"], kb["bytes"], kb["version"]) == (0, 0, 1)
    assert kb["business_unit"] == "all"
    assert (kb["sync_schedule"], kb["classification"]) == ("manual", "confidential")
    assert kb["can_edit"] is True
    assert kb["can_view_documents"] is True


def test_nobody_sends_an_owner_a_status_an_id_or_counters(env: Env) -> None:
    for field, value in (
        ("owner_id", "admin-1"),
        ("status", "ok"),
        ("kb_id", "01JABCDEFGHJKMNPQRSTVWXYZ0"),
        ("documents", 5),
        ("version", 7),
    ):
        response = env.create(**{field: value})
        assert response.status_code == 422, field
        assert _code(response) == "invalid_request"


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({"groups": ["ops"]}, "group_unknown"),
        ({"groups": ["hr", "hr"]}, "duplicate_group"),
        ({"business_unit": "marketing"}, "business_unit_unknown"),
        ({"description": "clave AKIAIOSFODNN7EXAMPLE"}, "secret_in_knowledge_base"),
        ({"groups": []}, "invalid_request"),
        ({"groups": ["Mango Admin"]}, "invalid_request"),
        ({"groups": [f"g{i:02d}" for i in range(21)]}, "invalid_request"),
        ({"name": "  "}, "invalid_request"),
        ({"name": "linea\nnueva"}, "invalid_request"),
        ({"name": "x" * 81}, "invalid_request"),
        ({"description": "x" * 501}, "invalid_request"),
        ({"classification": "secret"}, "invalid_request"),
        ({"sync_schedule": "hourly"}, "invalid_request"),
    ],
)
def test_what_a_knowledge_base_may_say(env: Env, body: dict[str, Any], code: str) -> None:
    response = env.create(**body)
    assert response.status_code == 422, response.text
    assert _code(response) == code
    assert env.events("kb.create", None) == []


def test_an_area_of_the_installation_is_accepted(env: Env) -> None:
    assert env.created(business_unit="security")["business_unit"] == "security"


def test_without_the_group_registry_nothing_is_created(env: Env) -> None:
    env.groups.unavailable = True
    response = env.create()
    assert (response.status_code, _code(response)) == (503, "groups_unavailable")


def test_every_creator_sees_the_list_and_only_some_its_documents(env: Env) -> None:
    env.created(name="RR. HH.")
    finance = env.created("outsider", name="Finanzas", groups=["finance"])

    def listed(token: str) -> dict[str, dict[str, Any]]:
        response = env.list(token)
        assert response.status_code == 200
        return {kb["name"]: kb for kb in response.json()["items"]}

    mine = listed("creator")
    assert set(mine) == {"RR. HH.", "Finanzas"}
    assert (mine["RR. HH."]["can_edit"], mine["RR. HH."]["can_view_documents"]) == (True, True)
    assert (mine["Finanzas"]["can_edit"], mine["Finanzas"]["can_view_documents"]) == (False, False)
    # Another creator in `hr` reads its documents but does not edit it, nor sees the email.
    theirs = listed("creator2")
    assert (theirs["RR. HH."]["can_edit"], theirs["RR. HH."]["can_view_documents"]) == (
        False,
        True,
    )
    assert theirs["RR. HH."]["owner"]["email"] is None
    assert theirs["RR. HH."]["owner"]["name"] == "Creadora Uno"
    admin = listed("admin")
    assert all(kb["can_edit"] and kb["can_view_documents"] for kb in admin.values())
    assert admin["RR. HH."]["owner"]["email"] == "creator1@example.com"
    assert env.list("admin").json()["can_create"] is True
    assert env.get("creator2", finance["kb_id"]).json()["can_view_documents"] is False


def test_an_unknown_or_malformed_id_is_not_found_or_refused(env: Env) -> None:
    assert env.get("creator", "01JABCDEFGHJKMNPQRSTVWXYZ0").status_code == 404
    assert env.get("creator", "not-a-ulid").status_code == 422
    assert env.get("creator", "../../KB").status_code in {404, 422}


# --- Editing and deleting ---------------------------------------------------------------


def test_the_owner_edits_and_each_change_names_the_version_it_read(env: Env) -> None:
    kb = env.created()
    response = env.update("creator", kb, name="Políticas 2026", sync_schedule="daily")
    assert response.status_code == 200, response.text
    updated = response.json()
    assert (updated["name"], updated["sync_schedule"], updated["version"]) == (
        "Políticas 2026",
        "daily",
        2,
    )
    # The same body again names version 1, which is gone.
    stale = env.update("creator", kb, name="Otra")
    assert (stale.status_code, _code(stale)) == (409, "version_conflict")
    [applied] = env.events("kb.update")
    assert applied["fields"] == ["name", "sync_schedule"]
    assert applied["sync_schedule"] == "daily"
    assert "Políticas" not in str(env.audit.events)


def test_a_change_of_groups_is_audited_from_what_to_what(env: Env) -> None:
    kb = env.created()
    response = env.update("admin", kb, groups=["finance", "hr"])
    assert response.status_code == 200
    [applied] = env.events("kb.update")
    assert (applied["groups_before"], applied["groups"]) == (["hr"], ["finance", "hr"])
    assert env.audit.named("kb.update")[0][0] == "admin-1"


def test_an_edit_that_changes_nothing_writes_nothing(env: Env) -> None:
    kb = env.created()
    response = env.update("creator", kb)
    assert response.status_code == 200
    assert response.json()["version"] == 1
    assert env.events("kb.update", None) == []


def test_only_the_owner_while_a_creator_or_an_admin_edits(env: Env) -> None:
    kb = env.created()
    for token in ("creator2", "outsider"):
        assert env.update(token, kb, name="x").status_code == 403
        assert env.delete(token, kb).status_code == 403
    # The owner who stopped being a creator: not even the platform check passes.
    assert env.update("former", kb, name="x").status_code == 403
    assert env.update("admin", kb, name="Revisada").status_code == 200


def test_the_area_is_chosen_once(env: Env) -> None:
    kb = env.created(business_unit="security")
    response = env.update("creator", kb, business_unit="sandbox")
    assert response.status_code == 422


def test_deleting_marks_it_and_keeps_it_listed_until_verified(env: Env) -> None:
    kb = env.created()
    response = env.delete("creator", kb)
    assert response.status_code == 202, response.text
    deleted = response.json()
    assert (deleted["status"], deleted["can_edit"], deleted["version"]) == ("deleting", False, 2)
    assert [k["status"] for k in env.list("creator").json()["items"]] == ["deleting"]
    again = env.update("creator", deleted, name="x")
    assert (again.status_code, _code(again)) == (409, "knowledge_base_deleting")
    assert _code(env.delete("creator", deleted)) == "knowledge_base_deleting"
    [applied] = env.events("kb.delete")
    assert (applied["kb_id"], applied["documents"]) == (kb["kb_id"], 0)
    # The record stays: only the synchronization removes it, once verified (D88 (16)).
    item = env.db.get_item(
        TableName="knowledge", Key={"PK": {"S": f"KB#{kb['kb_id']}"}, "SK": {"S": "META"}}
    )
    assert item["Item"]["status"]["S"] == "deleting"


def test_a_stale_delete_is_refused(env: Env) -> None:
    kb = env.created()
    env.update("creator", kb, name="Otra")
    response = env.delete("creator", kb, version=1)
    assert (response.status_code, _code(response)) == (409, "version_conflict")


# --- Audit and limits -------------------------------------------------------------------


def test_every_change_is_audited_before_and_after_with_ids_never_text(env: Env) -> None:
    kb = env.created(description="Contenido del manual")
    requested, applied = env.events("kb.create", "requested"), env.events("kb.create")
    assert len(requested) == len(applied) == 1
    assert applied[0]["kb_id"] == kb["kb_id"]
    assert (applied[0]["owner"], applied[0]["groups"]) == ("creator-1", ["hr"])
    flat = str(env.audit.events)
    assert "Contenido del manual" not in flat
    assert "Políticas de RR. HH." not in flat
    decisions = [d for e, _u, d in env.audit.events if e == "policy.decision"]
    assert any(d["action"] == "CreateKnowledgeBase" and d["allowed"] for d in decisions)


def test_a_change_that_cannot_be_audited_is_not_made(env: Env) -> None:
    env.audit.fail_outcomes = {"requested"}
    response = env.create()
    assert (response.status_code, _code(response)) == (503, "audit_unavailable")
    env.audit.fail_outcomes = set()
    assert env.list("creator").json()["items"] == []


def test_changes_count_in_a_limit_per_person(env: Env) -> None:
    for _ in range(CHANGES_PER_HOUR):
        assert env.create().status_code == 201
    response = env.create()
    assert response.status_code == 429
    assert "Retry-After" in response.headers
    # Another person still may.
    assert env.create("creator2").status_code == 201


def test_the_list_reads_one_index_of_the_table(env: Env) -> None:
    env.created()
    items = env.db.query(
        TableName="knowledge",
        IndexName=INDEX_ALL,
        KeyConditionExpression="all_pk = :a",
        ExpressionAttributeValues={":a": {"S": ALL_PK}},
    )["Items"]
    assert len(items) == 1
    assert items[0]["groups"] == {"SS": ["hr"]}
