"""Knowledge bases, the registry (D88 (8), (12), (13); knowledge-bases-threat-model.md): the
API with the real Cedar policies and the Knowledge table in moto."""

from __future__ import annotations

import base64
import io
import json
import logging
import time
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api import knowledge as knowledge_module
from mango_api import knowledge_store
from mango_api.authz import Authorizer
from mango_api.groups import GroupsUnavailableError
from mango_api.knowledge import CHANGES_PER_HOUR, KnowledgeDeps, SyncStarter
from mango_api.knowledge_store import ALL_PK, INDEX_ALL, KnowledgeStore
from mango_api.knowledge_uploads import S3_CONFIG, DocumentStorage, StorageUnavailableError
from mango_api.presign import PresignSessions
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
BUCKET = "mango-test-knowledge-0a1b2c3d"
PRESIGN_ARN = "arn:aws:iam::111122223333:role/Mango-test-Presign"
PRESIGN_TOKEN = "presign-session-token"


@dataclass
class FakeSts:
    """STS: what mango-api assumes to sign, and for whom."""

    calls: list[dict[str, Any]] = field(default_factory=list)

    def assume_role(self, **request: Any) -> dict[str, Any]:
        self.calls.append(request)
        return {
            "Credentials": {
                "AccessKeyId": "ASIAPRESIGNEXAMPLE01",
                "SecretAccessKey": "presign-secret",
                "SessionToken": PRESIGN_TOKEN,
                "Expiration": datetime.now(UTC) + timedelta(seconds=request["DurationSeconds"]),
            }
        }


def presign_sessions(sts: FakeSts | None = None) -> PresignSessions:
    return PresignSessions(
        sts or FakeSts(),
        PRESIGN_ARN,
        "us-east-1",
        client_factory=lambda c: boto3.client(
            "s3",
            region_name="us-east-1",
            config=S3_CONFIG,
            aws_access_key_id=c["AccessKeyId"],
            aws_secret_access_key=c["SecretAccessKey"],
            aws_session_token=c["SessionToken"],
        ),
    )


SYNC_ARN = "arn:aws:states:us-east-1:111122223333:stateMachine:Mango-test-KnowledgeSync"


@dataclass
class FakeSfn:
    started: list[dict[str, Any]] = field(default_factory=list)
    fail: bool = False

    def start_execution(self, **request: Any) -> dict[str, Any]:
        if self.fail:
            raise ClientError({"Error": {"Code": "ServiceUnavailable"}}, "StartExecution")
        self.started.append({**request, "input": json.loads(request["input"])})
        return {}


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
    s3: Any = None
    sfn: Any = None
    deps: KnowledgeDeps | None = None

    def create(self, token: str = "creator", **body: Any) -> Any:
        payload = {"name": "Políticas de RR. HH.", "groups": ["hr"], "origin": "upload", **body}
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
        s3 = boto3.client("s3", region_name="us-east-1", config=S3_CONFIG)
        s3.create_bucket(Bucket=BUCKET)
        sfn = FakeSfn()
        audit, cedar, groups = RecordingAudit(), CedarPolicyStore(), FakeGroups()
        deps = KnowledgeDeps(
            store=KnowledgeStore(db, "knowledge"),
            groups=groups,  # type: ignore[arg-type]
            areas=lambda: ["security", "sandbox"],
            audit=audit,  # type: ignore[arg-type]
            changes=app_module.Limits().limiter("knowledge.changes"),
            storage=DocumentStorage(s3, BUCKET, "us-east-1", presign_sessions()),
            uploads=app_module.Limits().limiter("knowledge.uploads"),
            sync=SyncStarter(sfn, SYNC_ARN),
            user_limit=lambda _user: Decimal("5"),
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
        yield Env(client, audit, groups, db, s3, sfn, deps)
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
    for name, value in (
        ("owner_id", "admin-1"),
        ("status", "ok"),
        ("kb_id", "01JABCDEFGHJKMNPQRSTVWXYZ0"),
        ("documents", 5),
        ("version", 7),
    ):
        response = env.create(**{name: value})
        assert response.status_code == 422, name
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


@dataclass(frozen=True)
class _Using:
    agent_id: str
    version: int
    name: str


def test_a_knowledge_base_an_agent_serves_is_not_deleted(env: Env) -> None:
    # D88 (15): a new version of the agent leaves it out first.
    assert env.deps is not None
    kb = env.created()
    asked: list[str] = []

    def using(kb_id: str) -> list[_Using]:
        asked.append(kb_id)
        return [_Using("k3fq7zr2m5xw6n4a", 2, "Asistente de RR. HH.")]

    env.deps.agents_using = using
    response = env.delete("creator", kb)
    assert (response.status_code, _code(response)) == (409, "knowledge_base_in_use")
    assert response.json()["agents"] == [
        {"agent_id": "k3fq7zr2m5xw6n4a", "version": 2, "name": "Asistente de RR. HH."}
    ]
    assert asked == [kb["kb_id"]]
    assert env.get("creator", kb["kb_id"]).json()["status"] == "pending"
    # Nothing was asked to be written: no audit of a deletion, no synchronization.
    assert env.events("kb.delete", None) == []
    assert env.sfn.started == []
    env.deps.agents_using = lambda _kb_id: []
    assert env.delete("creator", kb).status_code == 202


def test_a_knowledge_base_is_not_deleted_when_its_agents_cannot_be_read(env: Env) -> None:
    assert env.deps is not None
    kb = env.created()

    def unavailable(_kb_id: str) -> list[_Using]:
        raise RuntimeError("table unavailable")

    env.deps.agents_using = unavailable
    response = env.delete("creator", kb)
    assert (response.status_code, _code(response)) == (503, "agent_unavailable")
    assert env.get("creator", kb["kb_id"]).json()["status"] == "pending"


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


# --- Uploads and documents (D88 (9), TM-K4) -----------------------------------------------

PDF = b"%PDF-1.7\n" + b"0" * 2000
DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _zip_with(part: str) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr(part, "<x/>")
    return out.getvalue()


def _uploads(
    env: Env, kb: dict[str, Any], files: list[dict[str, Any]], token: str = "creator"
) -> Any:
    return env.client.post(
        f"/api/knowledge-bases/{kb['kb_id']}/uploads", headers=_h(token), json={"files": files}
    )


def _signed(env: Env, kb: dict[str, Any], *files: tuple[str, bytes, str]) -> dict[str, Any]:
    response = _uploads(
        env, kb, [{"name": n, "size": len(b), "content_type": t} for n, b, t in files]
    )
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


def _put(env: Env, signed_file: dict[str, Any], body: bytes, content_type: str) -> None:
    """What the browser does with the POST: here, the object S3 would end up with."""
    env.s3.put_object(
        Bucket=BUCKET, Key=signed_file["fields"]["key"], Body=body, ContentType=content_type
    )


def _save(
    env: Env,
    kb: dict[str, Any],
    upload: dict[str, Any],
    doc_ids: list[str] | None = None,
    token: str = "creator",
) -> Any:
    ids = doc_ids if doc_ids is not None else [f["doc_id"] for f in upload["files"]]
    return env.client.post(
        f"/api/knowledge-bases/{kb['kb_id']}/documents",
        headers=_h(token),
        json={"upload_id": upload["upload_id"], "doc_ids": ids},
    )


def _policy(signed_file: dict[str, Any]) -> dict[str, Any]:
    policy: dict[str, Any] = json.loads(base64.b64decode(signed_file["fields"]["policy"]))
    return policy


def test_each_upload_is_signed_for_one_key_of_ids_one_size_and_one_type(env: Env) -> None:
    kb = env.created()
    upload = _signed(env, kb, ("../../etc/Informe\u202e fdp.pdf", PDF, "application/pdf"))
    [file] = upload["files"]
    assert is_id(upload["upload_id"]) and is_id(file["doc_id"])
    key = f"uploads/creator-1/{upload['upload_id']}/{file['doc_id']}"
    assert file["fields"]["key"] == key
    assert file["fields"]["Content-Type"] == "application/pdf"
    # The regional host of the bucket: the one the CSP of the SPA allows.
    assert file["url"] == f"https://{BUCKET}.s3.us-east-1.amazonaws.com/"
    # The name is shown cleaned, and never reaches the key.
    assert file["name"] == "Informe fdp.pdf"
    conditions = _policy(file)["conditions"]
    assert ["eq", "$key", key] in conditions
    assert ["content-length-range", len(PDF), len(PDF)] in conditions
    assert {"Content-Type": "application/pdf"} in conditions
    assert {"bucket": BUCKET} in conditions
    [applied] = env.events("kb.upload")
    assert (applied["files"], applied["bytes"]) == (1, len(PDF))
    assert "Informe" not in str(env.audit.events)


@pytest.mark.parametrize(
    ("file", "code"),
    [
        (
            {"name": "virus.exe", "size": 10, "content_type": "application/pdf"},
            "type_not_supported",
        ),
        ({"name": "sin-extension", "size": 10, "content_type": "text/plain"}, "type_not_supported"),
        ({"name": "\u200b\u202e", "size": 10, "content_type": "text/plain"}, "type_not_supported"),
        ({"name": "nota.md", "size": 10, "content_type": "text/html"}, "type_mismatch"),
        (
            {"name": "a.pdf", "size": 50 * 1024 * 1024 + 1, "content_type": "application/pdf"},
            "invalid_request",
        ),
        ({"name": "a.pdf", "size": 0, "content_type": "application/pdf"}, "invalid_request"),
    ],
)
def test_what_may_be_uploaded(env: Env, file: dict[str, Any], code: str) -> None:
    kb = env.created()
    response = _uploads(env, kb, [file])
    assert response.status_code == 422, response.text
    assert _code(response) == code


def test_at_most_twenty_files_at_once_and_only_by_who_edits(env: Env) -> None:
    kb = env.created()
    many = [{"name": f"{i}.txt", "size": 5, "content_type": "text/plain"} for i in range(21)]
    assert _uploads(env, kb, many).status_code == 422
    one = [{"name": "a.txt", "size": 5, "content_type": "text/plain"}]
    assert _uploads(env, kb, one, token="creator2").status_code == 403
    assert _uploads(env, kb, one, token="member").status_code == 403
    assert _uploads(env, kb, one, token="admin").status_code == 201


def test_saving_checks_the_bytes_and_copies_on_the_server(env: Env) -> None:
    kb = env.created()
    docx = _zip_with("word/document.xml")
    upload = _signed(
        env,
        kb,
        ("manual.pdf", PDF, "application/pdf"),
        ("guía.docx", docx, DOCX_TYPE),
        ("notas.md", "# Título\nñandú".encode(), "text/markdown"),
    )
    for file, (body, ct) in zip(
        upload["files"],
        [
            (PDF, "application/pdf"),
            (docx, DOCX_TYPE),
            ("# Título\nñandú".encode(), "text/markdown"),
        ],
        strict=True,
    ):
        _put(env, file, body, ct)
    response = _save(env, kb, upload)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["rejected"] == []
    assert [d["name"] for d in result["saved"]] == ["manual.pdf", "guía.docx", "notas.md"]
    assert {d["status"] for d in result["saved"]} == {"uploaded"}
    for document in result["saved"]:
        copy = env.s3.get_object(Bucket=BUCKET, Key=f"kb/{kb['kb_id']}/docs/{document['doc_id']}")
        assert copy["ContentType"] == document["content_type"]
    listed = env.client.get(f"/api/knowledge-bases/{kb['kb_id']}/documents", headers=_h("creator"))
    assert listed.status_code == 200
    assert len(listed.json()["items"]) == 3
    refreshed = env.get("creator", kb["kb_id"]).json()
    assert refreshed["documents"] == 3
    assert refreshed["bytes"] == len(PDF) + len(docx) + len("# Título\nñandú".encode())
    # Counting documents is not editing the knowledge base: its version does not move.
    assert refreshed["version"] == kb["version"]
    [applied] = env.events("kb.documents_save")
    assert (applied["documents"], applied["rejected"]) == (3, 0)


@pytest.mark.parametrize(
    ("name", "content_type", "body", "uploaded", "reason"),
    [
        ("falso.pdf", "application/pdf", b"MZ\x90\x00 not a pdf", None, "type_mismatch"),
        (
            "hoja.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            _zip_with("word/document.xml"),
            None,
            "type_mismatch",
        ),
        ("binario.txt", "text/plain", b"abc\x00def", None, "type_mismatch"),
        ("latin1.csv", "text/csv", "año".encode("latin-1"), None, "type_mismatch"),
        ("corto.pdf", "application/pdf", PDF, PDF[:100], "size_mismatch"),
        ("nunca.pdf", "application/pdf", PDF, b"", "not_uploaded"),
    ],
)
def test_a_document_that_is_not_what_it_says_is_rejected(
    env: Env, name: str, content_type: str, body: bytes, uploaded: bytes | None, *, reason: str
) -> None:
    kb = env.created()
    upload = _signed(env, kb, (name, body, content_type))
    [file] = upload["files"]
    if uploaded != b"":
        _put(env, file, uploaded if uploaded is not None else body, content_type)
    response = _save(env, kb, upload)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "saved": [],
        "rejected": [{"doc_id": file["doc_id"], "reason": reason}],
        "sync": None,
    }
    assert env.get("creator", kb["kb_id"]).json()["documents"] == 0
    listed = env.s3.list_objects_v2(Bucket=BUCKET, Prefix="kb/")
    assert listed.get("KeyCount", 0) == 0


def test_an_upload_is_saved_once_by_who_asked_for_it_in_its_knowledge_base(env: Env) -> None:
    kb = env.created()
    other = env.created("admin", name="Otra")
    upload = _signed(env, kb, ("a.pdf", PDF, "application/pdf"))
    _put(env, upload["files"][0], PDF, "application/pdf")
    # Another editor of the same knowledge base, or the same upload in another one: not found.
    assert _save(env, kb, upload, token="admin").status_code == 404
    assert _save(env, other, upload, token="admin").status_code == 404
    unknown = _save(env, kb, upload, doc_ids=["01JABCDEFGHJKMNPQRSTVWXYZ0"])
    assert (unknown.status_code, _code(unknown)) == (422, "unknown_document")
    assert _save(env, kb, upload).status_code == 200
    again = _save(env, kb, upload)
    assert (again.status_code, _code(again)) == (409, "already_saved")
    assert env.get("creator", kb["kb_id"]).json()["documents"] == 1


def test_the_documents_are_seen_by_the_owner_admins_and_creators_in_its_groups(env: Env) -> None:
    kb = env.created()
    path = f"/api/knowledge-bases/{kb['kb_id']}/documents"
    for token, status in (
        ("creator", 200),
        ("creator2", 200),
        ("admin", 200),
        ("outsider", 403),
        ("member", 403),
    ):
        assert env.client.get(path, headers=_h(token)).status_code == status, token


def test_a_full_knowledge_base_takes_no_more(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    kb = env.created()
    monkeypatch.setattr(knowledge_module, "MAX_DOCUMENTS", 1)
    monkeypatch.setattr(knowledge_store, "MAX_DOCUMENTS", 1)
    upload = _signed(env, kb, ("a.pdf", PDF, "application/pdf"))
    _put(env, upload["files"][0], PDF, "application/pdf")
    assert _save(env, kb, upload).status_code == 200
    full = _uploads(env, kb, [{"name": "b.pdf", "size": 10, "content_type": "application/pdf"}])
    assert (full.status_code, _code(full)) == (409, "knowledge_base_full")


def test_a_knowledge_base_being_deleted_takes_no_documents(env: Env) -> None:
    kb = env.created()
    upload = _signed(env, kb, ("a.pdf", PDF, "application/pdf"))
    deleted = env.delete("creator", kb).json()
    one = [{"name": "b.pdf", "size": 10, "content_type": "application/pdf"}]
    assert _code(_uploads(env, deleted, one)) == "knowledge_base_deleting"
    assert _code(_save(env, deleted, upload)) == "knowledge_base_deleting"


def test_the_copy_takes_only_the_object_that_was_checked(env: Env) -> None:
    """The POST lasts 15 minutes: a second upload to the same key after the check is not what
    gets copied. Every read and the copy name the ETag that was checked (S3 refuses the copy
    with 412 otherwise; moto does not apply the condition, so the request is what is tested)."""
    kb = env.created()
    upload = _signed(env, kb, ("a.pdf", PDF, "application/pdf"))
    [file] = upload["files"]
    _put(env, file, PDF, "application/pdf")
    calls: list[tuple[str, dict[str, Any]]] = []

    class Recording:
        def __getattr__(self, name: str) -> Any:
            method = getattr(env.s3, name)

            def call(**kwargs: Any) -> Any:
                calls.append((name, kwargs))
                return method(**kwargs)

            return call

    storage = DocumentStorage(Recording(), BUCKET, "us-east-1", None)  # type: ignore[arg-type]
    found = storage.inspect(file["fields"]["key"], "pdf")
    assert found is not None and found.matches
    storage.copy(file["fields"]["key"], found.etag, f"kb/{kb['kb_id']}/docs/x", "application/pdf")
    assert [k["IfMatch"] for n, k in calls if n == "get_object"] == [found.etag]
    [copy] = [k for n, k in calls if n == "copy_object"]
    assert copy["CopySourceIfMatch"] == found.etag
    assert copy["ChecksumAlgorithm"] == "SHA256"


# --- Synchronization (D88 (11), (24)) -------------------------------------------------------


def _saved(env: Env, kb: dict[str, Any], token: str = "creator") -> dict[str, Any]:
    files = [{"name": "a.pdf", "size": len(PDF), "content_type": "application/pdf"}]
    upload = _uploads(env, kb, files, token=token).json()
    _put(env, upload["files"][0], PDF, "application/pdf")
    response = _save(env, kb, upload, token=token)
    assert response.status_code == 200, response.text
    result: dict[str, Any] = response.json()
    return result


def test_saving_starts_the_synchronization_of_whoever_saved(env: Env) -> None:
    kb = env.created()
    result = _saved(env, kb)
    assert result["sync"] == "started"
    [started] = env.sfn.started
    assert started["stateMachineArn"] == SYNC_ARN
    assert started["name"] == started["input"]["sync_id"]
    assert started["input"] == {
        "mode": "sync",
        "kb_id": kb["kb_id"],
        "sync_id": started["name"],
        "requested_by": {"user_id": "creator-1", "email": "creator1@example.com", "limit": "5"},
    }
    assert env.get("creator", kb["kb_id"]).json()["sync_running"] is True
    [request] = env.events("kb.sync_request", None)
    assert request == {"kb_id": kb["kb_id"], "sync_id": started["name"], "outcome": "started"}


def test_what_is_asked_for_while_one_runs_is_queued_for_after_it(env: Env) -> None:
    kb = env.created()
    _saved(env, kb)
    second = _saved(env, kb, token="admin")
    assert second["sync"] == "queued"
    assert len(env.sfn.started) == 1
    item = env.db.get_item(
        TableName="knowledge", Key={"PK": {"S": f"KB#{kb['kb_id']}"}, "SK": {"S": "META"}}
    )["Item"]
    assert json.loads(item["sync_again"]["S"])["user_id"] == "admin-1"


def test_a_machine_that_does_not_start_leaves_what_was_saved_and_frees_the_knowledge_base(
    env: Env,
) -> None:
    kb = env.created()
    env.sfn.fail = True
    result = _saved(env, kb)
    assert result["sync"] == "unavailable"
    assert [d["status"] for d in result["saved"]] == ["uploaded"]
    assert env.get("creator", kb["kb_id"]).json()["sync_running"] is False
    path = f"/api/knowledge-bases/{kb['kb_id']}/sync"
    response = env.client.post(path, headers=_h("creator"), json={})
    assert (response.status_code, _code(response)) == (503, "sync_unavailable")
    env.sfn.fail = False
    response = env.client.post(path, headers=_h("creator"), json={})
    assert (response.status_code, response.json()) == (202, {"sync": "started"})


def test_synchronizing_now_is_for_who_edits(env: Env) -> None:
    kb = env.created()
    path = f"/api/knowledge-bases/{kb['kb_id']}/sync"
    assert env.client.post(path, headers=_h("creator2"), json={}).status_code == 403
    assert env.client.post(path, headers=_h("member"), json={}).status_code == 403
    assert env.client.post(path, headers=_h("admin"), json={}).status_code == 202
    assert env.sfn.started[0]["input"]["requested_by"]["user_id"] == "admin-1"


def test_removing_a_document_marks_it_and_starts_the_synchronization(env: Env) -> None:
    kb = env.created()
    [document] = _saved(env, kb)["saved"]
    env.sfn.started.clear()
    env.db.update_item(
        TableName="knowledge",
        Key={"PK": {"S": f"KB#{kb['kb_id']}"}, "SK": {"S": "META"}},
        UpdateExpression="REMOVE sync_id",
    )
    path = f"/api/knowledge-bases/{kb['kb_id']}/documents/{document['doc_id']}/delete"
    assert env.client.post(path, headers=_h("creator2"), json={}).status_code == 403
    response = env.client.post(path, headers=_h("creator"), json={})
    assert response.status_code == 202, response.text
    assert response.json()["document"]["status"] == "deleting"
    assert response.json()["sync"] == "started"
    again = env.client.post(path, headers=_h("creator"), json={})
    assert (again.status_code, _code(again)) == (409, "document_deleting")
    unknown = f"/api/knowledge-bases/{kb['kb_id']}/documents/01JABCDEFGHJKMNPQRSTVWXYZ0/delete"
    assert env.client.post(unknown, headers=_h("creator"), json={}).status_code == 404
    item = env.db.get_item(
        TableName="knowledge", Key={"PK": {"S": f"KB#{kb['kb_id']}"}, "SK": {"S": "META"}}
    )["Item"]
    assert "deleting_since" in item
    [applied] = env.events("kb.document_delete")
    assert applied["doc_id"] == document["doc_id"]


def test_deleting_a_knowledge_base_starts_the_synchronization_that_deletes_it(env: Env) -> None:
    kb = env.created()
    env.delete("creator", kb)
    [started] = env.sfn.started
    assert started["input"]["kb_id"] == kb["kb_id"]
    item = env.db.get_item(
        TableName="knowledge", Key={"PK": {"S": f"KB#{kb['kb_id']}"}, "SK": {"S": "META"}}
    )["Item"]
    assert (item["status"]["S"], "deleting_since" in item) == ("deleting", True)
    path = f"/api/knowledge-bases/{kb['kb_id']}/sync"
    assert _code(env.client.post(path, headers=_h("creator"), json={})) == "knowledge_base_deleting"


def test_uploads_are_signed_by_the_presign_role_never_by_the_task(env: Env) -> None:
    """GuardDuty, 2026-10-21: a POST signed with the session of the ECS task, used from a
    browser, is reported as credentials of a resource used outside AWS."""
    kb = env.created()
    [file] = _signed(env, kb, ("a.pdf", PDF, "application/pdf"))["files"]
    assert file["fields"]["x-amz-security-token"] == PRESIGN_TOKEN
    assert file["fields"]["x-amz-credential"].startswith("ASIAPRESIGNEXAMPLE01/")


def test_without_the_presign_role_nothing_is_signed(env: Env) -> None:
    services_storage = DocumentStorage(env.s3, BUCKET, "us-east-1", None)
    with pytest.raises(StorageUnavailableError):
        services_storage.sign("uploads/x", 1, "application/pdf", user_id="creator-1")


# --- «Probar búsqueda» (D88 (12)) -------------------------------------------------------


@dataclass
class FakeRetrieve:
    results: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    calls: list[dict[str, Any]] = field(default_factory=list)

    def __call__(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        if self.error:
            raise ClientError({"Error": {"Code": self.error, "Message": "m"}}, "Retrieve")
        return {"retrievalResults": self.results}


def _searching(env: Env, retrieve: FakeRetrieve) -> None:
    assert env.deps is not None
    env.deps.retrieve = retrieve
    env.deps.knowledge_base_id = "BEDROCKKB1"
    env.deps.searches = app_module.Limits().limiter("knowledge.searches")


def _search(env: Env, kb: dict[str, Any], token: str = "creator", query: str = "vacaciones") -> Any:
    return env.client.post(
        f"/api/knowledge-bases/{kb['kb_id']}/search", headers=_h(token), json={"query": query}
    )


def _fragment(kb_id: str, doc_id: str, text: str = "Quince días hábiles.") -> dict[str, Any]:
    return {
        "content": {"text": text},
        "score": 0.81234,
        "metadata": {
            "kb_id": kb_id,
            "doc_id": doc_id,
            "x-amz-bedrock-kb-chunk-id": "chunk-1",
            "x-amz-bedrock-kb-document-page-number": 4.0,
        },
    }


def test_a_search_uses_the_filter_of_the_tool_over_this_base_only(env: Env) -> None:
    kb = env.created(business_unit="security")
    [document] = _saved(env, kb)["saved"]
    other = env.created(name="Otra")
    retrieve = FakeRetrieve(
        [_fragment(kb["kb_id"], document["doc_id"]), _fragment(other["kb_id"], "DOCX")]
    )
    _searching(env, retrieve)
    response = _search(env, kb)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "fragments": [
            {
                "doc_id": document["doc_id"],
                "document": "a.pdf",
                "page": 4,
                "score": 0.812,
                "text": "Quince días hábiles.",
            }
        ]
    }
    [call] = retrieve.calls
    assert call["retrievalConfiguration"]["vectorSearchConfiguration"]["filter"] == {
        "andAll": [
            {"in": {"key": "kb_id", "value": [kb["kb_id"]]}},
            {"in": {"key": "business_unit", "value": ["security"]}},
        ]
    }


def test_who_sees_the_documents_and_is_in_its_groups_may_try_the_search(env: Env) -> None:
    # D88 (37): View and Use. The administrator sees the documents but is not in `hr`; the
    # member is in `hr` but does not see the documents.
    kb = env.created()
    _searching(env, FakeRetrieve())
    for token, status in (
        ("creator", 200),
        ("creator2", 200),
        ("admin", 403),
        ("outsider", 403),
        ("member", 403),
    ):
        assert _search(env, kb, token).status_code == status, token
    assert (
        env.client.get(
            f"/api/knowledge-bases/{kb['kb_id']}/documents", headers=_h("admin")
        ).status_code
        == 200
    )


def test_each_search_is_audited_without_the_query(env: Env) -> None:
    kb = env.created()
    _searching(env, FakeRetrieve([_fragment(kb["kb_id"], "DOC1")]))
    assert _search(env, kb, query="¿cuántos días de vacaciones?").status_code == 200
    [detail] = [d for _u, d in env.audit.named("kb.search", None)]
    assert detail == {
        "kb_id": kb["kb_id"],
        "query_chars": len("¿cuántos días de vacaciones?"),
        "fragments": ["chunk-1"],
        "outcome": "ok",
    }
    assert "vacaciones" not in json.dumps(env.audit.events)


def test_what_a_query_may_be(env: Env) -> None:
    kb = env.created()
    _searching(env, FakeRetrieve())
    for query in ("", "   ", "x" * 1001, "a\x00b"):
        assert _search(env, kb, query=query).status_code == 422, repr(query)
    assert _search(env, kb, query="línea uno\nlínea dos").status_code == 200


def test_searches_are_limited_per_person(env: Env) -> None:
    kb = env.created()
    _searching(env, FakeRetrieve())
    for _ in range(knowledge_module.SEARCHES_PER_MINUTE):
        assert _search(env, kb).status_code == 200
    assert _search(env, kb).status_code == 429
    assert _search(env, kb, "creator2").status_code == 200


def test_a_busy_or_failed_search_says_so_and_is_audited(
    env: Env, caplog: pytest.LogCaptureFixture
) -> None:
    kb = env.created()
    _searching(env, FakeRetrieve(error="ThrottlingException"))
    with caplog.at_level(logging.WARNING):
        response = _search(env, kb)
    assert (response.status_code, _code(response)) == (503, "search_busy")
    # The line the metric filter of the alarm counts, without the query.
    assert f"{knowledge_module.SEARCH_THROTTLED_LOG}; kb {kb['kb_id']}" in caplog.text
    assert "vacaciones" not in caplog.text
    _searching(env, FakeRetrieve(error="ValidationException"))
    assert _code(_search(env, kb)) == "search_unavailable"
    assert [d["outcome"] for _u, d in env.audit.named("kb.search", None)] == [
        "throttled",
        "unavailable",
    ]


def test_without_the_audit_or_bedrock_nothing_is_answered(env: Env) -> None:
    kb = env.created()
    assert _code(_search(env, kb)) == "search_unavailable"
    _searching(env, FakeRetrieve([_fragment(kb["kb_id"], "DOC1")]))
    env.audit.fail_outcomes = {"ok"}
    assert _code(_search(env, kb)) == "audit_unavailable"


def test_a_knowledge_base_being_deleted_is_not_searched(env: Env) -> None:
    kb = env.created()
    retrieve = FakeRetrieve()
    _searching(env, retrieve)
    assert env.delete("creator", kb).status_code == 202
    assert _code(_search(env, kb)) == "knowledge_base_deleting"
    assert retrieve.calls == []


# --- What the screen reads of each one (D88 (43)) ----------------------------------------


def test_who_may_search_it_comes_with_it(env: Env) -> None:
    kb = env.created()
    by_token = {t: env.get(t, kb["kb_id"]).json() for t in ("creator", "admin", "outsider")}
    # Sees its documents and is in its groups; an administrator outside them does not search.
    assert by_token["creator"]["can_search"] is True
    assert (by_token["admin"]["can_view_documents"], by_token["admin"]["can_search"]) == (
        True,
        False,
    )
    assert by_token["outsider"]["can_search"] is False
    # A knowledge base of uploads has no sources; a new one never synchronized.
    assert by_token["creator"]["sources"] == []
    assert by_token["creator"]["last_synced_at"] is None
    assert by_token["creator"]["status_reason"] is None


@dataclass(frozen=True)
class Serving:
    agent_id: str
    version: int
    name: str
    groups: tuple[str, ...]
    knowledge_bases: tuple[str, ...]


def test_the_agents_that_serve_it_and_who_of_theirs_gets_nothing(env: Env) -> None:
    kb = env.created()
    other = env.created(name="Otra")
    assert env.deps is not None
    env.deps.agents_serving = lambda: [
        Serving("agt_people", 3, "People Docs", ("hr", "people"), (kb["kb_id"],)),
        Serving("agt_people", 4, "People Docs v4", ("hr", "finance"), (kb["kb_id"],)),
        Serving("agt_ops", 1, "Ops", ("hr",), (other["kb_id"],)),
    ]
    [agent] = env.get("creator", kb["kb_id"]).json()["agents"]
    # One per agent, from its latest version; the alert of D26 with its groups out of it.
    assert agent == {
        "agent_id": "agt_people",
        "name": "People Docs v4",
        "groups_without_access": ["finance"],
    }
    # Who does not see its documents sees the agent, not its groups.
    [agent] = env.get("outsider", kb["kb_id"]).json()["agents"]
    assert agent["groups_without_access"] is None

    def down() -> list[Serving]:
        raise RuntimeError("agents unavailable")

    env.deps.agents_serving = down
    assert env.get("creator", kb["kb_id"]).json()["agents"] is None


def test_why_the_last_synchronization_did_not_finish(env: Env) -> None:
    kb = env.created()
    env.db.update_item(
        TableName="knowledge",
        Key={"PK": {"S": f"KB#{kb['kb_id']}"}, "SK": {"S": "META"}},
        UpdateExpression=(
            "SET #s = :e, status_reason = :r, status_estimate_usd = :u,"
            " last_attempt_at = :a, last_synced_at = :y"
        ),
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":e": {"S": "error"},
            ":r": {"S": "budget"},
            ":u": {"N": "12.4"},
            ":a": {"S": "2026-10-22T10:00:00+00:00"},
            ":y": {"S": "2026-10-21T10:00:00+00:00"},
        },
    )
    got = env.get("creator", kb["kb_id"]).json()
    assert (got["status"], got["status_reason"], got["budget_estimate_usd"]) == (
        "error",
        "budget",
        "12.4",
    )
    assert got["last_attempt_at"].startswith("2026-10-22T10:00")
    assert got["last_synced_at"].startswith("2026-10-21T10:00")
    # A record from before says whose budget it was not: nobody is named.
    assert (got["budget_by"], got["sync_preparing"]) == (None, False)


def _budget_stop(env: Env, kb_id: str, user: str, email: str, scheduled: bool) -> None:
    values: dict[str, Any] = {
        ":e": {"S": "error"},
        ":r": {"S": "budget"},
        ":w": {"S": user},
        ":m": {"S": email},
    }
    update = "SET #s = :e, status_reason = :r, status_budget_user = :w, status_budget_email = :m"
    if scheduled:
        update += ", status_budget_scheduled = :t"
        values[":t"] = {"BOOL": True}
    env.db.update_item(
        TableName="knowledge",
        Key={"PK": {"S": f"KB#{kb_id}"}, "SK": {"S": "META"}},
        UpdateExpression=update,
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues=values,
    )


def test_whose_budget_stopped_it_and_who_sees_the_email(env: Env) -> None:
    kb = env.created()
    _budget_stop(env, kb["kb_id"], "admin-1", "admin@example.com", scheduled=False)
    by = {t: env.get(t, kb["kb_id"]).json()["budget_by"] for t in ("admin", "creator", "creator2")}
    assert by["admin"] == {"user_id": "admin-1", "email": "admin@example.com", "scheduled": False}
    # The owner of the knowledge base sees it too; another creator of its groups, the id only.
    assert by["creator"] == by["admin"]
    assert by["creator2"] == {"user_id": "admin-1", "email": None, "scheduled": False}
    _budget_stop(env, kb["kb_id"], "creator-1", "creator1@example.com", scheduled=True)
    assert env.get("creator2", kb["kb_id"]).json()["budget_by"] == {
        "user_id": "creator-1",
        "email": None,
        "scheduled": True,
    }


def test_preparing_the_access_is_said_while_a_synchronization_holds_it(env: Env) -> None:
    kb = env.created()
    key = {"PK": {"S": f"KB#{kb['kb_id']}"}, "SK": {"S": "META"}}
    env.db.update_item(
        TableName="knowledge",
        Key=key,
        UpdateExpression="SET sync_preparing = :t",
        ExpressionAttributeValues={":t": {"BOOL": True}},
    )
    # Without a synchronization holding it, a mark left behind says nothing.
    assert env.get("creator", kb["kb_id"]).json()["sync_preparing"] is False
    env.db.update_item(
        TableName="knowledge",
        Key=key,
        UpdateExpression="SET sync_id = :s",
        ExpressionAttributeValues={":s": {"S": "s1"}},
    )
    assert env.get("creator", kb["kb_id"]).json()["sync_preparing"] is True
