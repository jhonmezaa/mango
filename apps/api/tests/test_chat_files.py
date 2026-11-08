"""Files of the chat (D116; chat-files-threat-model.md): uploads, the malware scan, downloads,
the images of the chat and the attachments of a turn, with S3 and DynamoDB in moto.

moto does not evaluate the bucket policy, so the TBAC of D116 (10) is not exercised here (its
test is ``infra/test/code-sandbox.test.ts``): what these tests check is that mango-api never
reads, copies nor delivers an object before the scan record says it is clean.
"""

from __future__ import annotations

import base64
import io
import json
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlparse

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api.authz import Authorizer
from mango_api.chat_files import (
    CONFIRM_SECONDS,
    LINK_SECONDS,
    RETENTION_SECONDS,
    S3_CONFIG,
    SCAN_TIMEOUT_SECONDS,
    ChatFilesDeps,
    ChatFilesStorage,
    content_disposition,
    delete_conversation_files,
)
from mango_api.chat_files_store import ChatFileStore, FileStatus, scan_sk
from mango_api.conversations import StoredMessage
from mango_api.web import Caller
from mango_core import chat_files as core
from mango_core.identity import user_from_claims
from mango_core.knowledge import is_id

from .cedar_fake import CedarPolicyStore
from .test_admin import RecordingAudit
from .test_app import (
    HOST,
    KEY,
    TOKENS,
    FakeAgentCore,
    FakeAuthorizer,
    FakeBedrock,
    FakeBudgets,
    FakeConversations,
    FakeLimits,
    FakeModelCatalog,
    FakePublished,
    FakeVerifier,
    _settings,
)
from .test_knowledge import PRESIGN_TOKEN, presign_sessions

BUCKET = "mango-test-chat-files-0a1b2c3d"
TABLE = "conv"
SUB = "user-1"
CONVERSATION = "c" * 32
PDF = b"%PDF-1.7\n" + b"x" * 100
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
START = 1_800_000_000.0


@dataclass
class Clock:
    now: float = START

    def __call__(self) -> float:
        return self.now


@dataclass
class Env:
    client: TestClient
    s3: Any
    db: Any
    audit: RecordingAudit
    deps: ChatFilesDeps
    clock: Clock
    conversations: FakeConversations
    agentcore: FakeAgentCore = field(default_factory=FakeAgentCore)

    def uploads(
        self, *files: tuple[str, int], token: str = "good", conv: str = CONVERSATION
    ) -> Any:
        return self.client.post(
            f"/api/conversations/{conv}/uploads",
            headers=_h(token),
            json={"files": [{"name": n, "size": s} for n, s in files]},
        )

    def signed(self, *files: tuple[str, bytes]) -> dict[str, Any]:
        response = self.uploads(*((n, len(b)) for n, b in files))
        assert response.status_code == 201, response.text
        result: dict[str, Any] = response.json()
        return result

    def post(self, signed_file: dict[str, Any], body: bytes) -> None:
        """What the browser does with the POST: here, the object S3 ends up with."""
        self.s3.put_object(
            Bucket=BUCKET,
            Key=signed_file["fields"]["key"],
            Body=body,
            ContentType=signed_file["fields"]["Content-Type"],
        )

    def confirm(
        self, upload: dict[str, Any], ids: list[str] | None = None, token: str = "good"
    ) -> Any:
        file_ids = (
            ids if ids is not None else [f["file_id"] for f in upload["files"] if f["file_id"]]
        )
        return self.client.post(
            f"/api/conversations/{CONVERSATION}/uploads/{upload['upload_id']}/confirm",
            headers=_h(token),
            json={"file_ids": file_ids},
        )

    def scanned(self, key: str, result: str = "NO_THREATS_FOUND", *, sub: str = SUB) -> None:
        """What ``Mango-<ns>-ChatFilesScan`` writes for a scan event of ``key``."""
        head = self.s3.head_object(Bucket=BUCKET, Key=key)
        self.db.put_item(
            TableName=TABLE,
            Item={
                "PK": {"S": f"USER#{sub}"},
                "SK": {"S": scan_sk(key)},
                "scan_result": {"S": result},
                "scan_etag": {"S": head["ETag"].strip('"')},
                "scanned_at": {"N": str(int(self.clock.now * 1000))},
            },
        )

    def ready(self, name: str = "informe.pdf", body: bytes = PDF) -> str:
        """A file of the conversation, uploaded, scanned twice and ready."""
        upload = self.signed((name, body))
        [signed_file] = upload["files"]
        self.post(signed_file, body)
        self.confirm(upload)
        self.scanned(signed_file["fields"]["key"])
        self.confirm(upload)
        file_id: str = signed_file["file_id"]
        self.scanned(core.owner_key(SUB, CONVERSATION, file_id))
        [status] = self.confirm(upload).json()["files"]
        assert status["status"] == "ready", status
        return file_id

    def download(self, file_id: str, token: str = "good") -> Any:
        return self.client.post(
            f"/api/conversations/{CONVERSATION}/files/{file_id}/download",
            headers=_h(token),
            json={},
        )


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def _policy(signed_file: dict[str, Any]) -> dict[str, Any]:
    policy: dict[str, Any] = json.loads(base64.b64decode(signed_file["fields"]["policy"]))
    return policy


def _zip_with(part: str) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr(part, "<x/>")
    return out.getvalue()


def _table(db: Any) -> None:
    db.create_table(
        TableName=TABLE,
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


def _env(authorizer: Any, monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db)
        s3 = boto3.client("s3", region_name="us-east-1", config=S3_CONFIG)
        s3.create_bucket(Bucket=BUCKET)
        s3.put_bucket_versioning(Bucket=BUCKET, VersioningConfiguration={"Status": "Enabled"})
        clock, audit, conversations = Clock(), RecordingAudit(), FakeConversations()
        limits = app_module.Limits()
        deps = ChatFilesDeps(
            store=ChatFileStore(lambda _user: db, TABLE),
            storage=ChatFilesStorage(s3, BUCKET, "us-east-1", presign_sessions()),
            audit=audit,  # type: ignore[arg-type]
            uploads=limits.limiter("chat.uploads"),
            upload_bytes=limits.limiter("chat.upload_bytes"),
            checks=limits.limiter("chat.upload_checks"),
            downloads=limits.limiter("chat.file_downloads"),
            contents=limits.limiter("chat.file_contents"),
            clock=clock,
        )
        agentcore = FakeAgentCore()

        def factory(settings: Any) -> app_module.Services:
            return app_module.Services(
                settings=settings,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=authorizer,
                budgets=FakeBudgets(),  # type: ignore[arg-type]
                conversations=conversations,  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=agentcore,
                bedrock=FakeBedrock(),
                settings_store=None,  # type: ignore[arg-type]
                budget_limits=FakeLimits(),  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=FakePublished(),  # type: ignore[arg-type]
                model_catalog=FakeModelCatalog(),  # type: ignore[arg-type]
                invocation_key=KEY,
                chat_files=deps,
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(client, s3, db, audit, deps, clock, conversations, agentcore)


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    yield from _env(FakeAuthorizer(), monkeypatch)


@pytest.fixture
def cedar_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    cedar = CedarPolicyStore()
    yield from _env(Authorizer(cedar, "ps"), monkeypatch)
    assert cedar.errors == []


def _events(env: Env, name: str, outcome: str | None = None) -> list[dict[str, Any]]:
    return [d for _u, d in env.audit.named(name, outcome)]


# --- What a file may be (mango_core.chat_files) -----------------------------------------------


@pytest.mark.parametrize(
    ("kind", "head", "tail", "ok"),
    [
        ("pdf", PDF, b"", True),
        ("pdf", b"<html>", b"", False),
        ("png", PNG, b"", True),
        ("png", b"<svg onload=x>", b"", False),
        ("jpg", b"\xff\xd8\xff\xe0rest", b"", True),
        ("jpeg", b"GIF89a", b"", False),
        ("json", b'  {"a": 1}', b"", True),
        ("json", b"<script>", b"", False),
        ("csv", "año,costo\n".encode(), b"", True),
        ("txt", b"a\x00b", b"", False),
        ("pptx", b"PK\x03\x04", b"ppt/presentation.xml", True),
        ("xlsx", b"PK\x03\x04", b"word/document.xml", False),
        ("docx", b"PK\x03\x04", b"word/document.xml", True),
        ("html", b"<html>", b"", False),
    ],
)
def test_the_bytes_must_be_of_the_kind_the_name_says(
    kind: str, head: bytes, tail: bytes, ok: bool
) -> None:
    assert core.content_matches(kind, head, tail, len(head)) is ok


@pytest.mark.parametrize(
    ("name", "kind"),
    [
        ("Costos.XLSX", "xlsx"),
        ("foto.jpeg", "jpeg"),
        ("reporte.html", None),
        ("figura.svg", None),
        ("macros.xlsm", None),
        ("instalador.exe", None),
        ("sin-extension", None),
    ],
)
def test_only_the_closed_list_of_the_design(name: str, kind: str | None) -> None:
    assert core.extension(name) == kind


def test_keys_are_made_of_ids_and_parsed_back() -> None:
    upload, file_id = "01JC0000000000000000000000", "01JC0000000000000000000001"
    key = core.upload_key(SUB, upload, file_id)
    assert core.parse_key(key) == core.ParsedKey("uploads", SUB, upload, file_id)
    owner = core.owner_key(SUB, CONVERSATION, file_id)
    assert owner == f"owner/{SUB}/conv/{CONVERSATION}/{file_id}"
    assert core.parse_key(owner) == core.ParsedKey("owner", SUB, CONVERSATION, file_id)
    assert core.parse_key(f"owner/{SUB}/conv/../{file_id}") is None


def test_only_no_threats_found_opens_a_file() -> None:
    assert core.scan_outcome("NO_THREATS_FOUND") is core.ScanOutcome.CLEAN
    for result in ("THREATS_FOUND", "UNSUPPORTED", "ACCESS_DENIED", "FAILED", "", "x"):
        assert core.scan_outcome(result) is core.ScanOutcome.BLOCKED


def test_the_download_name_never_breaks_its_header() -> None:
    header = content_disposition('in"forme\r\nX: y ñ.pdf')
    assert header.startswith('attachment; filename="in_forme__X: y _.pdf"')
    assert "filename*=UTF-8''in%22forme%0D%0AX%3A%20y%20%C3%B1.pdf" in header
    assert "\r" not in header and "\n" not in header


# --- Uploads ----------------------------------------------------------------------------


def test_each_file_is_signed_for_one_key_of_ids_one_size_and_the_type_of_its_extension(
    env: Env,
) -> None:
    upload = env.signed(("../../etc/Informe\u202e fdp.pdf", PDF))
    [signed_file] = upload["files"]
    assert is_id(upload["upload_id"]) and is_id(signed_file["file_id"])
    key = f"uploads/{SUB}/{upload['upload_id']}/{signed_file['file_id']}"
    assert signed_file["fields"]["key"] == key
    # The server decides the type, from the extension.
    assert signed_file["fields"]["Content-Type"] == "application/pdf"
    assert signed_file["url"] == f"https://{BUCKET}.s3.us-east-1.amazonaws.com/"
    assert signed_file["name"] == "Informe fdp.pdf"
    assert signed_file["status"] == "uploading"
    # Signed by the presign role, never with the task's credentials (TM-CF5).
    assert signed_file["fields"]["x-amz-security-token"] == PRESIGN_TOKEN
    conditions = _policy(signed_file)["conditions"]
    assert ["eq", "$key", key] in conditions
    assert ["content-length-range", len(PDF), len(PDF)] in conditions
    assert {"Content-Type": "application/pdf"} in conditions
    assert {"bucket": BUCKET} in conditions
    [requested] = _events(env, "chat.file_upload", "requested")
    assert (requested["files"], requested["bytes"]) == (1, len(PDF))
    assert "Informe" not in str(env.audit.events)


def test_files_of_another_kind_or_over_100_mb_are_answered_and_never_signed(env: Env) -> None:
    response = env.uploads(
        ("reporte_proveedor.html", 200),
        ("macros_finanzas.xlsm", 1300),
        ("cur_anual_2026.csv", core.MAX_FILE_BYTES + 1),
        ("presupuesto_2027.xlsx", 2100),
    )
    assert response.status_code == 201, response.text
    files = response.json()["files"]
    assert [f["status"] for f in files] == [
        "unsupported_type",
        "unsupported_type",
        "too_large",
        "uploading",
    ]
    assert [f["file_id"] is None for f in files] == [True, True, True, False]
    assert all("fields" not in f or f["fields"] is None for f in files[:3])


def test_at_most_twenty_files_and_each_with_a_visible_name(env: Env) -> None:
    assert env.uploads(*(("a.csv", 10),) * 21).status_code == 422
    response = env.uploads(("\u200b\u202e", 10))
    assert response.status_code == 422
    assert _code(response) == "invalid_name"


def test_the_bytes_a_person_uploads_count_against_a_daily_limit(env: Env) -> None:
    for _ in range(60):
        response = env.uploads(("cur.csv", core.MAX_FILE_BYTES))
        if response.status_code == 429:
            break
    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) > 0


def test_a_conversation_of_someone_else_takes_no_uploads(cedar_env: Env) -> None:
    # A stored conversation whose record names another owner: OwnConversation refuses it,
    # with the 404 of one that does not exist.
    cedar_env.conversations.agents[(SUB, CONVERSATION)] = "finops"
    original = cedar_env.conversations.summary
    cedar_env.conversations.summary = lambda u, c: ("t", "finops", "user-9")  # type: ignore[method-assign]
    response = cedar_env.uploads(("a.pdf", 10))
    assert response.status_code == 404
    cedar_env.conversations.summary = original  # type: ignore[method-assign]
    # Its own conversation, stored or not yet, does.
    assert cedar_env.uploads(("a.pdf", 10)).status_code == 201


# --- The malware scan --------------------------------------------------------------------


def test_nothing_is_read_before_the_scan_and_the_copy_is_scanned_again(env: Env) -> None:
    upload = env.signed(("informe.pdf", PDF))
    [signed_file] = upload["files"]
    file_id = signed_file["file_id"]
    env.post(signed_file, PDF)
    # Posted, not scanned: «Revisando el archivo…», and nothing under owner/.
    [status] = env.confirm(upload).json()["files"]
    assert status["status"] == "scanning"
    owner = core.owner_key(SUB, CONVERSATION, file_id)
    assert "Contents" not in env.s3.list_objects_v2(Bucket=BUCKET, Prefix="owner/")
    # The upload is clean: checked and copied, without tags, and still scanning (its copy).
    env.scanned(signed_file["fields"]["key"])
    [status] = env.confirm(upload).json()["files"]
    assert status["status"] == "scanning"
    copied = env.s3.head_object(Bucket=BUCKET, Key=owner)
    assert copied["ContentType"] == "application/pdf"
    assert env.s3.get_object_tagging(Bucket=BUCKET, Key=owner)["TagSet"] == []
    # The copy is clean: ready, audited with what it is and never its name.
    env.scanned(owner)
    [status] = env.confirm(upload).json()["files"]
    assert status == {
        "file_id": file_id,
        "name": "informe.pdf",
        "kind": "pdf",
        "size_bytes": len(PDF),
        "status": "ready",
        "origin": "upload",
        "expires_at": status["expires_at"],
        "gone": False,
    }
    [applied] = _events(env, "chat.file_upload", "applied")
    assert applied["file_id"] == file_id
    assert len(applied["sha256"]) == 64
    assert "informe" not in str(env.audit.events)
    # Confirming again changes nothing.
    assert env.confirm(upload).json()["files"][0]["status"] == "ready"
    assert len(_events(env, "chat.file_upload", "applied")) == 1


@pytest.mark.parametrize("result", ["THREATS_FOUND", "UNSUPPORTED", "ACCESS_DENIED", "FAILED"])
def test_a_file_the_scan_did_not_clear_is_blocked_and_never_copied(env: Env, result: str) -> None:
    upload = env.signed(("informe.pdf", PDF))
    [signed_file] = upload["files"]
    env.post(signed_file, PDF)
    env.confirm(upload)
    env.scanned(signed_file["fields"]["key"], result)
    [status] = env.confirm(upload).json()["files"]
    assert status["status"] == "blocked"
    assert "Contents" not in env.s3.list_objects_v2(Bucket=BUCKET, Prefix="owner/")
    [rejected] = _events(env, "chat.file_upload", "rejected")
    assert rejected["reason"] == "blocked"


def test_a_copy_the_scan_did_not_clear_is_blocked(env: Env) -> None:
    upload = env.signed(("informe.pdf", PDF))
    [signed_file] = upload["files"]
    env.post(signed_file, PDF)
    env.confirm(upload)
    env.scanned(signed_file["fields"]["key"])
    env.confirm(upload)
    env.scanned(core.owner_key(SUB, CONVERSATION, signed_file["file_id"]), "THREATS_FOUND")
    assert env.confirm(upload).json()["files"][0]["status"] == "blocked"


@pytest.mark.parametrize(
    ("name", "body"),
    [
        ("informe.pdf", b"<html><script>alert(1)</script></html>"),
        ("figura.png", b"<svg xmlns='http://www.w3.org/2000/svg' onload='x'/>"),
        ("datos.xlsx", _zip_with("word/document.xml")),
        ("datos.json", b"\x00\x01binary"),
    ],
)
def test_a_file_that_is_not_what_it_says_is_rejected(env: Env, name: str, body: bytes) -> None:
    upload = env.signed((name, body))
    [signed_file] = upload["files"]
    env.post(signed_file, body)
    env.confirm(upload)
    env.scanned(signed_file["fields"]["key"])
    assert env.confirm(upload).json()["files"][0]["status"] == "type_mismatch"
    assert "Contents" not in env.s3.list_objects_v2(Bucket=BUCKET, Prefix="owner/")


def test_a_file_of_another_size_than_announced_fails(env: Env) -> None:
    upload = env.signed(("informe.pdf", PDF))
    [signed_file] = upload["files"]
    env.post(signed_file, PDF + b"more")
    env.confirm(upload)
    env.scanned(signed_file["fields"]["key"])
    assert env.confirm(upload).json()["files"][0]["status"] == "failed"


def test_only_the_object_the_scan_cleared_is_copied(env: Env) -> None:
    upload = env.signed(("informe.pdf", PDF))
    [signed_file] = upload["files"]
    env.post(signed_file, PDF)
    env.confirm(upload)
    env.scanned(signed_file["fields"]["key"])
    # The POST lasts 15 minutes: another file replaced the scanned one meanwhile.
    env.post(signed_file, PDF.replace(b"x", b"y"))
    assert env.confirm(upload).json()["files"][0]["status"] == "scanning"
    assert "Contents" not in env.s3.list_objects_v2(Bucket=BUCKET, Prefix="owner/")


def test_a_scan_that_never_arrives_fails_the_file(env: Env) -> None:
    upload = env.signed(("informe.pdf", PDF))
    [signed_file] = upload["files"]
    env.post(signed_file, PDF)
    env.confirm(upload)
    env.clock.now += SCAN_TIMEOUT_SECONDS + 1
    assert env.confirm(upload).json()["files"][0]["status"] == "failed"


def test_an_upload_is_confirmed_by_its_person_in_its_conversation_while_it_lasts(
    env: Env,
) -> None:
    upload = env.signed(("informe.pdf", PDF))
    [signed_file] = upload["files"]
    # Another person: their partition has no such file.
    assert env.confirm(upload, token="admin").status_code == 404
    other = env.client.post(
        f"/api/conversations/{'d' * 32}/uploads/{upload['upload_id']}/confirm",
        headers=_h("good"),
        json={"file_ids": [signed_file["file_id"]]},
    )
    assert other.status_code == 404
    wrong_upload = env.client.post(
        f"/api/conversations/{CONVERSATION}/uploads/{'0' * 26}/confirm",
        headers=_h("good"),
        json={"file_ids": [signed_file["file_id"]]},
    )
    assert wrong_upload.status_code == 404
    env.clock.now += CONFIRM_SECONDS + 1
    assert env.confirm(upload).json()["files"][0]["status"] == "failed"


# --- Downloads and images ------------------------------------------------------------------


def test_a_ready_file_downloads_as_an_attachment_with_a_link_of_five_minutes(env: Env) -> None:
    file_id = env.ready("Costos de octubre.pdf")
    response = env.download(file_id)
    assert response.status_code == 200, response.text
    link = response.json()
    assert link["file"] == "Costos de octubre.pdf"
    query = parse_qs(urlparse(link["url"]).query)
    assert urlparse(link["url"]).path.endswith(core.owner_key(SUB, CONVERSATION, file_id))
    assert query["response-content-type"] == ["application/pdf"]
    assert query["response-content-disposition"][0].startswith("attachment;")
    assert query["X-Amz-Expires"] == [str(LINK_SECONDS)]
    assert query["X-Amz-Security-Token"] == [PRESIGN_TOKEN]
    [downloaded] = _events(env, "chat.file_download", "applied")
    assert (downloaded["file_id"], downloaded["kind"], downloaded["size"]) == (
        file_id,
        "pdf",
        len(PDF),
    )
    assert "Costos" not in str(env.audit.events)


def test_a_file_that_is_not_ready_blocked_or_gone_is_not_downloaded(env: Env) -> None:
    upload = env.signed(("informe.pdf", PDF))
    [signed_file] = upload["files"]
    env.post(signed_file, PDF)
    env.confirm(upload)
    pending = env.download(signed_file["file_id"])
    assert (pending.status_code, _code(pending)) == (409, "file_not_ready")
    env.scanned(signed_file["fields"]["key"], "THREATS_FOUND")
    env.confirm(upload)
    blocked = env.download(signed_file["file_id"])
    assert (blocked.status_code, _code(blocked)) == (409, "file_blocked")
    ready = env.ready()
    env.clock.now += RETENTION_SECONDS
    gone = env.download(ready)
    assert (gone.status_code, _code(gone)) == (410, "file_gone")
    assert _events(env, "chat.file_download") == []


def test_someone_elses_file_and_one_that_does_not_exist_answer_the_same(env: Env) -> None:
    file_id = env.ready()
    assert env.download(file_id, token="admin").status_code == 404
    assert env.download("0" * 26).status_code == 404
    assert env.download("../../x").status_code in {404, 422}


def test_sixty_downloads_per_person_and_hour(env: Env) -> None:
    file_id = env.ready()
    for _ in range(60):
        assert env.download(file_id).status_code == 200
    refused = env.download(file_id)
    assert refused.status_code == 429
    assert int(refused.headers["Retry-After"]) > 0


def test_an_image_is_served_with_its_type_and_nothing_that_runs(env: Env) -> None:
    file_id = env.ready("captura_consola.png", PNG)
    response = env.client.get(
        f"/api/conversations/{CONVERSATION}/files/{file_id}/content", headers=_h("good")
    )
    assert response.status_code == 200
    assert response.content == PNG
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-security-policy"] == "default-src 'none'; sandbox"
    assert response.headers["cache-control"] == "private, no-store"
    [shown] = _events(env, "chat.file_download", "applied")
    assert shown["inline"] is True


def test_only_images_are_served_inline(env: Env) -> None:
    file_id = env.ready()
    response = env.client.get(
        f"/api/conversations/{CONVERSATION}/files/{file_id}/content", headers=_h("good")
    )
    assert (response.status_code, _code(response)) == (415, "not_an_image")


# --- Deleting with the conversation -----------------------------------------------------------


def test_deleting_a_conversation_deletes_its_files_and_their_records(env: Env) -> None:
    file_id = env.ready()
    caller = Caller(user_from_claims(TOKENS["good"]), "token", int(START) + 3600)
    assert delete_conversation_files(env.deps, caller, CONVERSATION) == 1
    owner = core.owner_key(SUB, CONVERSATION, file_id)
    listed = env.s3.list_objects_v2(Bucket=BUCKET, Prefix=f"owner/{SUB}/")
    assert owner not in [o["Key"] for o in listed.get("Contents", [])]
    record = env.deps.store.file(SUB, CONVERSATION, file_id)
    assert record is not None and record.deleted
    assert int(
        env.db.get_item(
            TableName=TABLE,
            Key={"PK": {"S": f"USER#{SUB}"}, "SK": {"S": f"CFILE#{CONVERSATION}#{file_id}"}},
        )["Item"]["ttl"]["N"]
    ) == int(env.clock.now)
    assert (env.download(file_id).status_code, _code(env.download(file_id))) == (410, "file_gone")
    [deleted] = _events(env, "chat.file_delete", "requested")
    assert deleted["files"] == 1


# --- The attachments of a turn ---------------------------------------------------------------


def test_a_question_takes_ready_files_of_its_conversation_and_keeps_what_they_are(
    env: Env,
) -> None:
    file_id = env.ready("cur_octubre_2026.csv", b"cuenta,costo\n1,2\n")
    response = env.client.post(
        "/api/chat",
        headers=_h("good"),
        json={"conversation_id": CONVERSATION, "message": "Analiza esto", "attachments": [file_id]},
    )
    assert response.status_code == 200, response.text
    [question] = [o for o in env.conversations.options if o.get("attachments")]
    assert question["attachments"] == [
        {"file_id": file_id, "name": "cur_octubre_2026.csv", "kind": "csv", "size": 17}
    ]


def test_a_question_takes_no_file_that_is_not_ready_or_not_of_its_conversation(
    env: Env,
) -> None:
    upload = env.signed(("informe.pdf", PDF))
    [signed_file] = upload["files"]
    body = {
        "conversation_id": CONVERSATION,
        "message": "Mira",
        "attachments": [signed_file["file_id"]],
    }
    pending = env.client.post("/api/chat/turns", headers=_h("good"), json=body)
    assert (pending.status_code, _code(pending)) == (422, "attachment_not_ready")
    other = env.client.post(
        "/api/chat/turns", headers=_h("good"), json={**body, "conversation_id": "d" * 32}
    )
    assert (other.status_code, _code(other)) == (404, "unknown_attachment")
    unnamed = env.client.post(
        "/api/chat/turns",
        headers=_h("good"),
        json={"message": "Mira", "attachments": [signed_file["file_id"]]},
    )
    assert (unnamed.status_code, _code(unnamed)) == (422, "attachments_need_conversation")
    too_many = env.client.post(
        "/api/chat/turns", headers=_h("good"), json={**body, "attachments": ["0" * 26] * 21}
    )
    assert too_many.status_code == 422
    assert env.agentcore.requests == []


def test_the_history_says_which_files_are_gone(env: Env) -> None:
    file_id = env.ready()
    env.conversations.agents[(SUB, CONVERSATION)] = "finops"
    env.conversations.messages = lambda _u, _c: [  # type: ignore[method-assign]
        StoredMessage(
            "m" * 32,
            "user",
            "Mira",
            "t",
            [],
            attachments=[{"file_id": file_id, "name": "informe.pdf", "kind": "pdf", "size": 109}],
        )
    ]
    detail = env.client.get(f"/api/conversations/{CONVERSATION}", headers=_h("good")).json()
    assert detail["messages"][0]["attachments"] == [
        {"file_id": file_id, "name": "informe.pdf", "kind": "pdf", "size_bytes": 109, "gone": False}
    ]
    env.clock.now += RETENTION_SECONDS
    detail = env.client.get(f"/api/conversations/{CONVERSATION}", headers=_h("good")).json()
    assert detail["messages"][0]["attachments"][0]["gone"] is True


def test_a_stored_status_survives_a_read(env: Env) -> None:
    file_id = env.ready()
    record = env.deps.store.file(SUB, CONVERSATION, file_id)
    assert record is not None and record.status is FileStatus.READY


# --- Files a code cell wrote (C4, W1) ------------------------------------------------------


def _generated(env: Env, name: str = "detalle.pdf") -> str:
    """A file a cell wrote, as the code connector records it: in ``verifying``."""
    file_id = "01" + "A" * 24
    key = core.owner_key(SUB, CONVERSATION, file_id)
    env.s3.put_object(Bucket=BUCKET, Key=key, Body=PDF)
    now = int(env.clock.now)
    env.db.put_item(
        TableName=TABLE,
        Item={
            "PK": {"S": f"USER#{SUB}"},
            "SK": {"S": f"CFILE#{CONVERSATION}#{file_id}"},
            "file_id": {"S": file_id},
            "conversation_id": {"S": CONVERSATION},
            "origin": {"S": "generated"},
            "name": {"S": name},
            "kind": {"S": "pdf"},
            "size": {"N": str(len(PDF))},
            "status": {"S": "verifying"},
            "status_at": {"N": str(now)},
            "created_at": {"N": str(now)},
            "expires_at": {"N": str(now + RETENTION_SECONDS)},
            "sha256": {"S": "0" * 64},
        },
    )
    return file_id


def _status(env: Env, file_id: str, token: str = "good") -> Any:
    return env.client.get(f"/api/conversations/{CONVERSATION}/files/{file_id}", headers=_h(token))


def test_a_generated_file_waits_for_its_scan_and_is_then_ready(env: Env) -> None:
    file_id = _generated(env)
    waiting = _status(env, file_id)
    assert waiting.status_code == 200, waiting.text
    assert (waiting.json()["status"], waiting.json()["origin"]) == ("scanning", "generated")
    assert env.download(file_id).status_code == 409
    env.scanned(core.owner_key(SUB, CONVERSATION, file_id))
    assert _status(env, file_id).json()["status"] == "ready"
    assert env.download(file_id).status_code == 200


def test_a_generated_file_the_scan_blocked_is_never_delivered(env: Env) -> None:
    file_id = _generated(env)
    env.scanned(core.owner_key(SUB, CONVERSATION, file_id), "THREATS_FOUND")
    assert _status(env, file_id).json()["status"] == "blocked"
    assert _code(env.download(file_id)) == "file_blocked"


def test_the_status_of_someone_elses_file_answers_like_one_that_does_not_exist(env: Env) -> None:
    file_id = _generated(env)
    assert _status(env, file_id, token="admin").status_code == 404
    assert _status(env, "0" * 26).status_code == 404
