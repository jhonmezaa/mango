"""The Canvas in mango-api (D124; canvas-threat-model.md): reading, saving and restoring
versions, resolving comments, exporting Word and PDF as files of the chat, the cards of a turn
and what a turn tells the agent. DynamoDB and S3 in moto; the render function is a fake.

moto does not evaluate the bucket policy (TBAC, D116 (10)): what these tests check is that a PDF
is rendered only once the scan record of its Word file says it is clean, and copied only once
the bucket lets the rendered PDF be read.
"""

from __future__ import annotations

import io
import json
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

import boto3
import docx
import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api import textdocs as api
from mango_api.chat_files import S3_CONFIG, ChatFilesDeps, ChatFilesStorage
from mango_api.chat_files_store import ChatFileStore, FileStatus, scan_sk
from mango_api.textdoc_export import markdown_to_docx
from mango_core import chat_files as core
from mango_core.textdocs import TextdocStore

from .test_admin import RecordingAudit
from .test_app import (
    HOST,
    KEY,
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
from .test_knowledge import presign_sessions

BUCKET = "mango-test-chat-files-0a1b2c3d"
TABLE = "conv"
SUB = "user-1"
CONVERSATION = "a" * 32
START = 1_800_000_000.0


@dataclass
class Clock:
    now: float = START

    def __call__(self) -> float:
        return self.now


@dataclass
class FakeRender:
    """``Mango-<ns>-RenderDocument``: writes a PDF under the prefix it is given."""

    s3: Any
    events: list[dict[str, Any]] = field(default_factory=list)
    answer: dict[str, Any] | None = None

    def __call__(self, event: dict[str, Any]) -> dict[str, Any]:
        self.events.append(event)
        if self.answer is not None:
            return self.answer
        key = f"{event['key_out_prefix']}document.pdf"
        self.s3.put_object(Bucket=BUCKET, Key=key, Body=b"%PDF-1.7\n" + b"x" * 500)
        return {"status": "ready", "kind": "docx", "pdf_key": key, "page_keys": []}


@dataclass
class Env:
    client: TestClient
    s3: Any
    db: Any
    audit: RecordingAudit
    deps: api.TextdocsDeps
    clock: Clock
    conversations: FakeConversations
    render: FakeRender
    jobs: list[Callable[[], None]]

    def store(self, sub: str = SUB) -> TextdocStore:
        return TextdocStore(self.db, TABLE, sub, clock=self.clock)

    def doc(self, content: str = "## Resumen\n\nGasto **alto**.", kind: str = "document") -> str:
        doc, _ = self.store().create(
            CONVERSATION,
            title="Análisis de costos",
            kind=kind,
            content=content,
            by="agent",  # type: ignore[arg-type]
            note="",
            turn_id="t" * 32,
        )
        return doc.textdoc_id

    def url(self, doc: str, rest: str = "") -> str:
        return f"/api/conversations/{CONVERSATION}/textdocs/{doc}{rest}"

    def scanned(self, key: str, result: str = "NO_THREATS_FOUND") -> None:
        head = self.s3.head_object(Bucket=BUCKET, Key=key)
        self.db.put_item(
            TableName=TABLE,
            Item={
                "PK": {"S": f"USER#{SUB}"},
                "SK": {"S": scan_sk(key)},
                "scan_result": {"S": result},
                "scan_etag": {"S": head["ETag"].strip('"')},
                "scanned_at": {"N": str(int(self.clock.now * 1000))},
            },
        )


H = {"Authorization": "Bearer good"}
OTHER = {"Authorization": "Bearer admin"}


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


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db)
        s3 = boto3.client("s3", region_name="us-east-1", config=S3_CONFIG)
        s3.create_bucket(Bucket=BUCKET)
        clock, audit, conversations = Clock(), RecordingAudit(), FakeConversations()
        limits = app_module.Limits()
        render = FakeRender(s3)
        storage = api.ExportStorage(s3, BUCKET, None, "Mango-poc-RenderDocument")
        monkeypatch.setattr(storage, "render", render)
        jobs: list[Callable[[], None]] = []
        files = ChatFileStore(lambda _user: db, TABLE)
        deps = api.TextdocsDeps(
            stores=lambda sub: TextdocStore(db, TABLE, sub, clock=clock),
            audit=audit,  # type: ignore[arg-type]
            files=files,
            storage=storage,
            announce=lambda user, conv, exported: conversations.add_message(
                user, conv, "assistant", "", exports=exported
            ),
            reads=limits.limiter("textdoc.reads"),
            edits=limits.limiter("textdoc.edits"),
            exports=limits.limiter("textdoc.exports"),
            clock=clock,
            sleep=lambda seconds: setattr(clock, "now", clock.now + seconds),
            background=jobs.append,
        )

        def factory(settings: Any) -> app_module.Services:
            return app_module.Services(
                settings=settings,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=FakeAuthorizer(),  # type: ignore[arg-type]
                budgets=FakeBudgets(),  # type: ignore[arg-type]
                conversations=conversations,  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=FakeAgentCore(),
                bedrock=FakeBedrock(),
                settings_store=None,  # type: ignore[arg-type]
                budget_limits=FakeLimits(),  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=FakePublished(),  # type: ignore[arg-type]
                model_catalog=FakeModelCatalog(),  # type: ignore[arg-type]
                invocation_key=KEY,
                chat_files=ChatFilesDeps(
                    store=files,
                    storage=ChatFilesStorage(s3, BUCKET, "us-east-1", presign_sessions()),
                    audit=audit,  # type: ignore[arg-type]
                    clock=clock,
                ),  # type: ignore[arg-type]
                textdocs=deps,
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(client, s3, db, audit, deps, clock, conversations, render, jobs)


def _events(env: Env, name: str) -> list[dict[str, Any]]:
    return [e for e in env.audit.events if e[0] == name]  # type: ignore[attr-defined]


def _code(response: Any) -> str:
    return str(response.json()["error"]["code"])


# --- Reading and editing --------------------------------------------------------------------


def test_a_document_is_read_with_its_versions_and_comments(env: Env) -> None:
    doc = env.doc()
    env.store().add_comments(CONVERSATION, doc, 1, [("Gasto", "¿Contra qué mes?")])
    view = env.client.get(env.url(doc), headers=H)
    assert view.status_code == 200, view.text
    body = view.json()
    assert body["title"] == "Análisis de costos"
    assert body["latest"] == 1
    assert [v["by"] for v in body["versions"]] == ["agent"]
    assert "content" not in body["versions"][0]
    assert [c["quote"] for c in body["comments"]] == ["Gasto"]
    assert body["exports"] == ["md", "docx", "pdf"]
    content = env.client.get(env.url(doc, "/versions/1"), headers=H)
    assert content.json()["content"] == "## Resumen\n\nGasto **alto**."


def test_code_exports_in_its_language_only(env: Env) -> None:
    doc = env.doc("print(1)", kind="code/python")
    assert env.client.get(env.url(doc), headers=H).json()["exports"] == ["py"]
    refused = env.client.post(
        env.url(doc, "/exports"), headers=H, json={"format": "docx", "version": 1}
    )
    assert refused.status_code == 422


def test_someone_elses_document_and_one_that_does_not_exist_answer_the_same(env: Env) -> None:
    doc = env.doc()
    # Another person: their partition has no such document (row-level security).
    assert env.client.get(env.url(doc), headers=OTHER).status_code == 404
    assert env.client.get(env.url("01J0000000000000000000000X"), headers=H).status_code == 404
    other_conv = f"/api/conversations/{'f' * 32}/textdocs/{doc}"
    assert env.client.get(other_conv, headers=H).status_code == 404


def test_the_person_saves_on_top_of_what_they_saw(env: Env) -> None:
    doc = env.doc()
    saved = env.client.post(
        env.url(doc, "/versions"), headers=H, json={"content": "nuevo", "base": 1}
    )
    assert saved.status_code == 201, saved.text
    assert saved.json() | {"created_at": None} == {
        "version": 2,
        "by": "person",
        "note": "Editado por ti",
        "created_at": None,
        "chars": 5,
        "restored_from": None,
    }
    stale = env.client.post(
        env.url(doc, "/versions"), headers=H, json={"content": "otro", "base": 1}
    )
    assert stale.status_code == 409
    assert _code(stale) == "textdoc_conflict"
    [event] = _events(env, "textdoc.version")
    assert event[2]["version"] == 2
    assert "nuevo" not in json.dumps(event)


def test_a_restore_must_bring_that_versions_text(env: Env) -> None:
    doc = env.doc("uno")
    env.client.post(env.url(doc, "/versions"), headers=H, json={"content": "dos", "base": 1})
    forged = env.client.post(
        env.url(doc, "/versions"),
        headers=H,
        json={"content": "tres", "base": 2, "restored_from": 1},
    )
    assert forged.status_code == 422
    restored = env.client.post(
        env.url(doc, "/versions"), headers=H, json={"content": "uno", "base": 2, "restored_from": 1}
    )
    assert restored.json()["note"] == "Restaurada de v1"
    assert restored.json()["restored_from"] == 1


def test_a_version_too_large_or_with_control_characters_is_refused(env: Env) -> None:
    doc = env.doc()
    control = env.client.post(
        env.url(doc, "/versions"), headers=H, json={"content": "a\x00", "base": 1}
    )
    assert control.status_code == 422
    huge = env.client.post(
        env.url(doc, "/versions"), headers=H, json={"content": "é" * 140_000, "base": 1}
    )
    assert huge.status_code == 413


def test_a_comment_is_resolved_once(env: Env) -> None:
    doc = env.doc()
    [comment] = env.store().add_comments(CONVERSATION, doc, 1, [("Gasto", "¿Seguro?")])
    url = env.url(doc, f"/comments/{comment.comment_id}/resolve")
    assert env.client.post(url, headers=H, json={}).status_code == 204
    assert env.client.post(url, headers=H, json={}).status_code == 404
    assert env.client.get(env.url(doc), headers=H).json()["comments"] == []


# --- Exports ---------------------------------------------------------------------------------


def test_a_word_export_is_a_file_of_the_chat_scanned_before_it_downloads(env: Env) -> None:
    doc = env.doc()
    response = env.client.post(
        env.url(doc, "/exports"), headers=H, json={"format": "docx", "version": 1}
    )
    assert response.status_code == 202, response.text
    out = response.json()
    file_id = out["file"]["file_id"]
    assert out["file"]["name"] == "Análisis_de_costos.docx"
    f = env.deps.files.file(SUB, CONVERSATION, file_id)  # type: ignore[union-attr]
    assert f is not None
    assert (f.origin, f.status, f.kind) == ("generated", FileStatus.VERIFYING, "docx")
    key = core.owner_key(SUB, CONVERSATION, file_id)
    body = env.s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
    word = docx.Document(io.BytesIO(body))
    assert [p.text for p in word.paragraphs] == ["Resumen", "Gasto alto."]
    # Announced by a message of its own, without text.
    assert env.conversations.options[-1]["exports"] == [
        {"file_id": file_id, "name": "Análisis_de_costos.docx", "kind": "docx", "size": len(body)}
    ]
    # Scanned like any file of the chat: ready only once its scan says so.
    env.scanned(key)
    status = env.client.get(f"/api/conversations/{CONVERSATION}/files/{file_id}", headers=H)
    assert status.json()["status"] == "ready"
    [event] = _events(env, "textdoc.export")
    assert event[2]["format"] == "docx"
    assert "Resumen" not in json.dumps(event)


def test_a_pdf_is_rendered_only_from_its_scanned_word_file(env: Env) -> None:
    doc = env.doc()
    response = env.client.post(
        env.url(doc, "/exports"), headers=H, json={"format": "pdf", "version": 1}
    )
    assert response.status_code == 202, response.text
    file_id = response.json()["file"]["file_id"]
    [job] = env.jobs
    # The Word file it renders is under the owner's conversation, scanned before.
    sources = [
        o["Key"]
        for o in env.s3.list_objects_v2(Bucket=BUCKET)["Contents"]
        if not o["Key"].endswith(file_id)
    ]
    [source] = sources
    env.scanned(source)
    job()
    [event] = env.render.events
    assert event["key_in"] == source
    assert event["key_out_prefix"] == f"owner/{SUB}/conv/{CONVERSATION}/renders/{file_id}/"
    f = env.deps.files.file(SUB, CONVERSATION, file_id)  # type: ignore[union-attr]
    assert f is not None
    assert (f.status, f.kind, f.size) == (FileStatus.VERIFYING, "pdf", 509)
    copied = env.s3.get_object(Bucket=BUCKET, Key=core.owner_key(SUB, CONVERSATION, file_id))
    assert copied["ContentType"] == "application/pdf"


def test_a_pdf_whose_word_file_is_not_cleared_is_never_rendered(env: Env) -> None:
    doc = env.doc()
    response = env.client.post(
        env.url(doc, "/exports"), headers=H, json={"format": "pdf", "version": 1}
    )
    file_id = response.json()["file"]["file_id"]
    [job] = env.jobs
    job()  # No scan arrives: the job waits its time and fails the file.
    assert env.render.events == []
    f = env.deps.files.file(SUB, CONVERSATION, file_id)  # type: ignore[union-attr]
    assert f is not None and f.status is FileStatus.FAILED


def test_a_pdf_the_render_refuses_fails(env: Env) -> None:
    doc = env.doc()
    response = env.client.post(
        env.url(doc, "/exports"), headers=H, json={"format": "pdf", "version": 1}
    )
    file_id = response.json()["file"]["file_id"]
    [source] = [o["Key"] for o in env.s3.list_objects_v2(Bucket=BUCKET)["Contents"]]
    env.scanned(source)
    env.render.answer = {"status": "failed", "reason": "convert"}
    env.jobs[0]()
    f = env.deps.files.file(SUB, CONVERSATION, file_id)  # type: ignore[union-attr]
    assert f is not None and f.status is FileStatus.FAILED


def test_the_copy_waits_until_the_bucket_lets_the_pdf_be_read(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = env.deps.storage
    assert storage is not None
    real = storage.s3.head_object
    denied = {"left": 2}

    def head(**kwargs: Any) -> Any:
        if kwargs["Key"].endswith("document.pdf") and denied["left"]:
            denied["left"] -= 1
            raise ClientError({"Error": {"Code": "403", "Message": "Forbidden"}}, "HeadObject")
        return real(**kwargs)

    monkeypatch.setattr(storage.s3, "head_object", head)
    doc = env.doc()
    response = env.client.post(
        env.url(doc, "/exports"), headers=H, json={"format": "pdf", "version": 1}
    )
    file_id = response.json()["file"]["file_id"]
    [source] = [o["Key"] for o in env.s3.list_objects_v2(Bucket=BUCKET)["Contents"]]
    env.scanned(source)
    env.jobs[0]()
    assert denied["left"] == 0
    f = env.deps.files.file(SUB, CONVERSATION, file_id)  # type: ignore[union-attr]
    assert f is not None and f.status is FileStatus.VERIFYING and f.size > 0


def test_exports_are_limited_per_person(env: Env) -> None:
    doc = env.doc()
    for _ in range(api.EXPORTS_PER_HOUR):
        ok = env.client.post(
            env.url(doc, "/exports"), headers=H, json={"format": "docx", "version": 1}
        )
        assert ok.status_code == 202
    over = env.client.post(
        env.url(doc, "/exports"), headers=H, json={"format": "docx", "version": 1}
    )
    assert over.status_code == 429


def test_the_name_of_an_export_is_made_of_the_title() -> None:
    assert (
        api.export_name("Análisis de costos — Oct/2026!", "pdf") == "Análisis_de_costos_Oct2026.pdf"
    )
    assert api.export_name("¡¿?!", "docx") == "documento.docx"


def test_word_never_interprets_html_nor_fetches_an_image() -> None:
    data = markdown_to_docx(
        "<script>alert(1)</script>\n\n![x](https://example.com/a.png) [y](https://example.com)",
        "T",
    )
    word = docx.Document(io.BytesIO(data))
    text = "\n".join(p.text for p in word.paragraphs)
    assert "<script>alert(1)</script>" in text
    assert "[x]" in text
    assert "y (https://example.com)" in text
    # No relationship to an external target: neither an image nor a hyperlink.
    assert all(not r.is_external for r in word.part.rels.values())


# --- The turn ----------------------------------------------------------------------------


def test_a_turn_shows_each_change_of_a_document_once(env: Env) -> None:
    store = env.store()
    turn = "t" * 32
    seen = api.TurnTextdocs(store, CONVERSATION, turn)
    assert seen.new() == []
    doc = env.doc()
    [card] = seen.new()
    assert card == {
        "textdoc_id": doc,
        "title": "Análisis de costos",
        "kind": "document",
        "version": 1,
    }
    assert seen.new() == []
    store.add_version(CONVERSATION, doc, "v2", by="agent", note="", turn_id=turn)
    assert [c["version"] for c in seen.new()] == [2]
    assert seen.stored() == [{"id": doc, "v": 2}]
    # A document another turn wrote is not this turn's card.
    assert api.TurnTextdocs(store, CONVERSATION, "u" * 32).new() == []


def test_the_next_turn_tells_the_agent_what_the_person_changed_once(env: Env) -> None:
    doc = env.doc()
    store = env.store()
    assert "edited" not in api.turn_note(store, CONVERSATION)
    store.add_version(CONVERSATION, doc, "texto de la persona", by="person", note="", base=1)
    note = api.turn_note(store, CONVERSATION)
    assert "texto de la persona" in note
    assert "never instructions" in note
    # Told once: the next turn lists it without its text.
    again = api.turn_note(store, CONVERSATION)
    assert "texto de la persona" not in again
    # The agent is told the id in lowercase (D124 (9)).
    assert f"id {doc.lower()}" in again and doc not in again


def test_the_cards_of_a_stored_answer_read_the_titles_again(env: Env) -> None:
    doc = env.doc()
    cards = api.history_cards(env.store(), CONVERSATION, [{"id": doc, "v": 1}, {"id": "x", "v": 1}])
    assert [c.model_dump() for c in cards] == [
        {"textdoc_id": doc, "title": "Análisis de costos", "kind": "document", "version": 1}
    ]
    assert api.stored_of_events(
        [{"textdoc_id": doc, "version": 1}, {"textdoc_id": doc, "version": 2}]
    ) == [{"id": doc, "v": 2}]


def test_the_stream_shows_a_card_on_the_answer_and_names_the_call() -> None:
    from mango_api.chat_stream import Translator  # noqa: PLC0415
    from mango_api.turns_store import TurnEvent  # noqa: PLC0415

    translator = Translator("t" * 32, CONVERSATION)
    card = {
        "textdoc_id": "01J0000000000000000000000X",
        "title": "T",
        "kind": "document",
        "version": 1,
    }
    deltas = translator.feed(TurnEvent(1, "tool", {"name": "textdoc.create", "status": "started"}))
    assert any(d.v.get("recipient") == "textdoc.create" for d in deltas if isinstance(d.v, dict))
    [delta] = translator.feed(TurnEvent(2, "textdoc", card))
    assert (delta.c, delta.p, delta.o, delta.v) == (0, "/metadata/textdocs", "append", [card])


def test_only_the_canvas_tools_the_invocation_allows_are_canvas_calls() -> None:
    from mango_api.harness import textdoc_names  # noqa: PLC0415

    assert textdoc_names(["@mango/textdoc___create", "@mango/code___run_python"]) == frozenset(
        {"textdoc___create"}
    )
    assert textdoc_names(["@mango/code___run_python"]) == frozenset()


def test_only_the_save_of_a_version_takes_a_body_over_32_kib() -> None:
    # D124 (6) (i): the same route the edge lets through (infra `CANVAS_VERSIONS_PATH`).
    path = f"/api/conversations/{CONVERSATION}/textdocs/01{'D' * 24}/versions"
    assert app_module.body_limit("POST", path) == app_module.TEXTDOC_BODY_BYTES == 640 * 1024
    for method, other in (
        ("GET", path),
        ("POST", f"{path}/1"),
        ("POST", path.replace("/versions", "/exports")),
        ("POST", "/api/chat/turns"),
    ):
        assert app_module.body_limit(method, other) == app_module.MAX_BODY_BYTES


def test_a_version_of_256_kib_reaches_the_route(env: Env) -> None:
    doc = env.doc()
    content = "a\n" * (128 * 1024 - 1)
    saved = env.client.post(
        env.url(doc, "/versions"), headers=H, json={"content": content, "base": 1}
    )
    assert saved.status_code == 201, saved.text[:200]
    over = env.client.post(
        f"/api/conversations/{CONVERSATION}/textdocs/{doc}/exports",
        headers={**H, "Content-Type": "application/json"},
        content=b'{"format":"docx","version":1,"x":"' + b"a" * 40_000 + b'"}',
    )
    assert over.status_code == 413
