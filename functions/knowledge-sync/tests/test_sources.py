"""The copy of the sources into Mango's bucket (D88 (19), (40)), against moto S3 and DynamoDB.

The role of a source is played by the same moto client: what is checked here is what the
synchronization asks of it (its ARN, the SourceIdentity) and what it does with the answers.
"""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass, field
from typing import Any

import pytest

from mango_core.knowledge import new_id
from mango_knowledge_sync import handler
from mango_knowledge_sync.sources import SourceCopier
from mango_knowledge_sync.store import SyncStore

from .test_sync import BUCKET, REQUESTER, Env, env  # noqa: F401 - fixture

SOURCE_BUCKET = "docs-rrhh"
ROLE = "arn:aws:iam::123456789012:role/Mango-lab-kbsrc-{}"
PDF = b"%PDF-1.7\n" + b"0" * 3000


@dataclass
class Sources:
    env: Env
    sessions: list[tuple[str, str]] = field(default_factory=list)
    asked: list[tuple[str, str]] = field(default_factory=list)
    gives_role: bool = True

    def session_for(self, role_arn: str, identity: str) -> Any:
        self.sessions.append((role_arn, identity))
        return self.env.s3

    def request_role(self, op: str, kb_id: str, src_id: str) -> None:
        self.asked.append((op, src_id))
        key = {"PK": {"S": f"KB#{kb_id}"}, "SK": {"S": f"SRC#{src_id}"}}
        if op == "ensure" and self.gives_role:
            self.env.db.update_item(
                TableName="knowledge",
                Key=key,
                UpdateExpression="SET role_arn = :a",
                ExpressionAttributeValues={":a": {"S": ROLE.format(src_id)}},
            )
        if op == "delete":
            self.env.db.update_item(
                TableName="knowledge", Key=key, UpdateExpression="REMOVE role_arn"
            )


@pytest.fixture
def sources(env: Env) -> Sources:  # noqa: F811
    fake = Sources(env)
    env.s3.create_bucket(Bucket=SOURCE_BUCKET)
    env.deps.sources = SourceCopier(
        store=SyncStore(env.db, "knowledge"),
        documents_s3=env.s3,
        documents_bucket=BUCKET,
        session_for=fake.session_for,
        request_role=fake.request_role,
        now_iso=lambda: "2026-10-21T15:00:00+00:00",
    )
    return fake


def _source(
    env: Env,  # noqa: F811
    kb_id: str,
    *,
    status: str = "approved",
    prefix: str = "politicas/",
    role: bool = True,
) -> str:
    src_id = new_id()
    item: dict[str, Any] = {
        "PK": {"S": f"KB#{kb_id}"},
        "SK": {"S": f"SRC#{src_id}"},
        "kb_id": {"S": kb_id},
        "src_id": {"S": src_id},
        "bucket": {"S": SOURCE_BUCKET},
        "prefix": {"S": prefix},
        "status": {"S": status},
        "proposed_by": {"S": "creator-1"},
        "proposed_at": {"S": "2026-10-21T10:00:00+00:00"},
        "version": {"N": "2"},
    }
    if role:
        item["role_arn"] = {"S": ROLE.format(src_id)}
    env.db.put_item(TableName="knowledge", Item=item)
    return src_id


def _put(env: Env, key: str, body: bytes) -> None:  # noqa: F811
    env.s3.put_object(Bucket=SOURCE_BUCKET, Key=key, Body=body)


def _docs(env: Env, kb_id: str) -> dict[str, dict[str, Any]]:  # noqa: F811
    items = env.db.query(
        TableName="knowledge",
        KeyConditionExpression="PK = :pk AND begins_with(SK, :d)",
        ExpressionAttributeValues={":pk": {"S": f"KB#{kb_id}"}, ":d": {"S": "DOC#"}},
    )["Items"]
    return {item["source_key"]["S"]: item for item in items if "source_key" in item}


def _copy(env: Env, kb_id: str, mode: str = "sync") -> dict[str, Any]:  # noqa: F811
    state = {"mode": mode, "kb_id": kb_id, "sync_id": new_id(), "requested_by": REQUESTER}
    return handler.handle(env.deps, {"step": "copy", "state": state})


def _docx() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", "<w:document/>")
    return buffer.getvalue()


def test_an_approved_source_is_copied_as_whoever_synchronizes(env: Env, sources: Sources) -> None:  # noqa: F811
    kb_id = env.kb()
    src_id = _source(env, kb_id)
    _put(env, "politicas/vacaciones.pdf", PDF)
    _put(env, "politicas/sub/contrato.docx", _docx())
    _put(env, "otra/fuera.pdf", PDF)
    state = _copy(env, kb_id)
    assert state["counts"]["copied"] == 2
    assert state["copy_more"] is False
    # As the role of the source, with the SourceIdentity of who synchronizes (rule 5).
    assert sources.sessions == [(ROLE.format(src_id), "creator-1")]
    docs = _docs(env, kb_id)
    assert set(docs) == {"politicas/vacaciones.pdf", "politicas/sub/contrato.docx"}
    pdf = docs["politicas/vacaciones.pdf"]
    assert (pdf["status"]["S"], pdf["name"]["S"], pdf["src_id"]["S"]) == (
        "uploaded",
        "vacaciones.pdf",
        src_id,
    )
    copied = env.s3.get_object(Bucket=BUCKET, Key=f"kb/{kb_id}/docs/{pdf['doc_id']['S']}")
    assert copied["Body"].read() == PDF
    assert copied["ContentType"] == "application/pdf"
    meta = env.meta(kb_id)
    assert meta is not None
    assert meta["documents"]["N"] == "2"
    # The next run of the same source copies nothing again.
    assert _copy(env, kb_id)["counts"]["copied"] == 0


@pytest.mark.parametrize(
    ("key", "body", "reason"),
    [
        ("politicas/foto.png", b"\x89PNG", "unsupported_type"),
        ("politicas/falso.pdf", b"no soy un pdf", "type_mismatch"),
        ("politicas/vacio.txt", b"", "empty"),
    ],
)
def test_what_is_not_a_document_is_recorded_failed_and_copies_nothing(
    env: Env,  # noqa: F811
    sources: Sources,
    key: str,
    body: bytes,
    reason: str,
) -> None:
    kb_id = env.kb()
    _source(env, kb_id)
    _put(env, key, body)
    state = _copy(env, kb_id)
    assert state["counts"]["copy_failed"] == 1
    document = _docs(env, kb_id)[key]
    assert (document["status"]["S"], document["reason"]["S"]) == ("failed", reason)
    assert document["size"]["N"] == "0"
    listed = env.s3.list_objects_v2(Bucket=BUCKET, Prefix=f"kb/{kb_id}/")
    assert listed.get("KeyCount", 0) == 0
    # Not tried again while it does not change.
    assert _copy(env, kb_id)["counts"]["copy_failed"] == 0


def test_a_change_or_a_deletion_in_the_source_reaches_the_copy(env: Env, sources: Sources) -> None:  # noqa: F811
    kb_id = env.kb()
    _source(env, kb_id)
    _put(env, "politicas/a.pdf", PDF)
    _put(env, "politicas/b.pdf", PDF)
    _copy(env, kb_id)
    before = _docs(env, kb_id)
    _put(env, "politicas/a.pdf", PDF + b"cambio")
    env.s3.delete_object(Bucket=SOURCE_BUCKET, Key="politicas/b.pdf")
    _copy(env, kb_id)
    assert env.status_of(kb_id, before["politicas/b.pdf"]["doc_id"]["S"]) == "deleting"
    assert env.status_of(kb_id, before["politicas/a.pdf"]["doc_id"]["S"]) == "deleting"
    items = env.db.query(
        TableName="knowledge",
        KeyConditionExpression="PK = :pk AND begins_with(SK, :d)",
        ExpressionAttributeValues={":pk": {"S": f"KB#{kb_id}"}, ":d": {"S": "DOC#"}},
    )["Items"]
    fresh = [
        i
        for i in items
        if i["status"]["S"] == "uploaded" and i["source_key"]["S"] == "politicas/a.pdf"
    ]
    assert len(fresh) == 1


@pytest.mark.parametrize("status", ["pending", "rejected", "withdrawn"])
def test_a_source_that_is_not_approved_is_never_read(
    env: Env,  # noqa: F811
    sources: Sources,
    status: str,
) -> None:
    kb_id = env.kb()
    _source(env, kb_id, status=status)
    _put(env, "politicas/a.pdf", PDF)
    _copy(env, kb_id)
    assert sources.sessions == []
    assert _docs(env, kb_id) == {}


def test_an_approved_source_without_a_role_asks_for_it_again(env: Env, sources: Sources) -> None:  # noqa: F811
    kb_id = env.kb()
    src_id = _source(env, kb_id, role=False)
    _put(env, "politicas/a.pdf", PDF)
    sources.gives_role = False
    state = _copy(env, kb_id)
    assert sources.asked == [("ensure", src_id)]
    assert state["sources_unavailable"] == 1
    assert sources.sessions == []
    sources.gives_role = True
    assert _copy(env, kb_id)["counts"]["copied"] == 1


def test_a_removed_source_takes_its_documents_its_role_and_then_its_record(
    env: Env,  # noqa: F811
    sources: Sources,
) -> None:
    kb_id = env.kb()
    src_id = _source(env, kb_id)
    _put(env, "politicas/a.pdf", PDF)
    _copy(env, kb_id)
    [document] = _docs(env, kb_id).values()
    env.db.update_item(
        TableName="knowledge",
        Key={"PK": {"S": f"KB#{kb_id}"}, "SK": {"S": f"SRC#{src_id}"}},
        UpdateExpression="SET #s = :r",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":r": {"S": "removing"}},
    )
    # A synchronization of deletions only still clears what the source left.
    _copy(env, kb_id, mode="deletions")
    assert env.status_of(kb_id, document["doc_id"]["S"]) == "deleting"
    # Once the deletion is verified, the role goes, then the record.
    env.db.delete_item(
        TableName="knowledge",
        Key={"PK": {"S": f"KB#{kb_id}"}, "SK": {"S": f"DOC#{document['doc_id']['S']}"}},
    )
    _copy(env, kb_id, mode="deletions")
    assert sources.asked == [("delete", src_id)]
    _copy(env, kb_id, mode="deletions")
    record = env.db.get_item(
        TableName="knowledge", Key={"PK": {"S": f"KB#{kb_id}"}, "SK": {"S": f"SRC#{src_id}"}}
    )
    assert "Item" not in record


def test_a_synchronization_of_deletions_copies_nothing(env: Env, sources: Sources) -> None:  # noqa: F811
    kb_id = env.kb()
    _source(env, kb_id)
    _put(env, "politicas/a.pdf", PDF)
    assert _copy(env, kb_id, mode="deletions")["counts"]["copied"] == 0
    assert sources.sessions == []


def test_a_full_knowledge_base_stops_the_copy(env: Env, sources: Sources) -> None:  # noqa: F811
    kb_id = env.kb(documents="x")
    env.db.update_item(
        TableName="knowledge",
        Key={"PK": {"S": f"KB#{kb_id}"}, "SK": {"S": "META"}},
        UpdateExpression="SET documents = :n",
        ExpressionAttributeValues={":n": {"N": "1000"}},
    )
    _source(env, kb_id)
    _put(env, "politicas/a.pdf", PDF)
    state = _copy(env, kb_id)
    assert state["full"] is True
    assert _docs(env, kb_id) == {}
    assert env.s3.list_objects_v2(Bucket=BUCKET, Prefix=f"kb/{kb_id}/").get("KeyCount", 0) == 0


def test_the_copy_continues_in_another_step_when_its_time_is_up(
    env: Env,  # noqa: F811
    sources: Sources,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mango_knowledge_sync import sources as module  # noqa: PLC0415

    monkeypatch.setattr(module, "STEP_BYTES", 1)
    kb_id = env.kb()
    _source(env, kb_id)
    for name in ("a", "b", "c"):
        _put(env, f"politicas/{name}.pdf", PDF)
    state = _copy(env, kb_id)
    assert (state["counts"]["copied"], state["copy_more"]) == (1, True)
    assert len(_docs(env, kb_id)) == 1


def test_what_is_copied_is_ingested_with_the_metadata_of_the_registry(
    env: Env,  # noqa: F811
    sources: Sources,
) -> None:
    kb_id = env.kb(groups=("hr", "ops"))
    _source(env, kb_id)
    _put(env, "politicas/a.pdf", PDF)
    _copy(env, kb_id)
    [document] = _docs(env, kb_id).values()
    env.run(kb_id)
    [request] = env.agent.ingested
    [ingested] = request["documents"]
    attributes = {a["key"]: a["value"] for a in ingested["metadata"]["inlineAttributes"]}
    assert attributes["kb_id"]["stringValue"] == kb_id
    assert attributes["doc_id"]["stringValue"] == document["doc_id"]["S"]
    # Never the bucket nor the key of the source: the copy in Mango's bucket.
    location = ingested["content"]["custom"]["s3Location"]["uri"]
    assert location == f"s3://{BUCKET}/kb/{kb_id}/docs/{document['doc_id']['S']}"
