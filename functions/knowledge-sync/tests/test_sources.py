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
from botocore.exceptions import ClientError

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
    denied: int = 0
    """Sessions of a role IAM refuses (not ready yet, or never) before it answers."""
    reads_denied: int = 0
    """Sessions whose role lists but may not read yet."""

    def session_for(self, role_arn: str, identity: str) -> Any:
        self.sessions.append((role_arn, identity))
        if self.denied:
            self.denied -= 1
            raise _denied("AssumeRole")
        if self.reads_denied:
            self.reads_denied -= 1
            return _NoReads(self.env.s3)
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


def _denied(operation: str) -> ClientError:
    return ClientError({"Error": {"Code": "AccessDenied", "Message": "no"}}, operation)


class _NoReads:
    def __init__(self, s3: Any) -> None:
        self._s3 = s3

    def list_objects_v2(self, **request: Any) -> Any:
        return self._s3.list_objects_v2(**request)

    def get_object(self, **_request: Any) -> Any:
        raise _denied("GetObject")


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
    decided_at: str | None = None,
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
    if decided_at:
        item["decided_at"] = {"S": decided_at}
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


# --- Schedules (D88 (11), (24), (41)) ------------------------------------------------------


@dataclass
class Settings:
    limits: dict[str, str] = field(default_factory=lambda: {"DEFAULTS": "7"})
    down: bool = False


def _limits(env: Env, settings: Settings) -> None:  # noqa: F811
    from botocore.exceptions import ClientError  # noqa: PLC0415

    from mango_knowledge_sync.budget import Limits  # noqa: PLC0415

    class Table:
        def get_item(self, **request: Any) -> dict[str, Any]:
            if settings.down:
                raise ClientError({"Error": {"Code": "InternalServerError"}}, "GetItem")
            assert request["Key"]["PK"] == {"S": "BUDGETS"}
            sk = request["Key"]["SK"]["S"]
            value = settings.limits.get(sk.removeprefix("USER#") if sk != "DEFAULTS" else sk)
            if value is None:
                return {}
            name = "user_monthly_usd" if sk == "DEFAULTS" else "limit_usd"
            return {"Item": {name: {"N": value}}}

    env.deps.limits = Limits(Table(), "settings")


def _scheduled(env: Env, kb_id: str) -> dict[str, Any]:  # noqa: F811
    return handler.handle(
        env.deps, {"step": "scheduled", "state": {"mode": "scheduled", "kb_id": kb_id}}
    )


def test_a_schedule_synchronizes_as_the_owner_with_their_limit(env: Env, sources: Sources) -> None:  # noqa: F811
    _limits(env, Settings(limits={"DEFAULTS": "7", "creator-1": "12"}))
    kb_id = env.kb(owner_email="creator1@example.com")
    _source(env, kb_id)
    assert _scheduled(env, kb_id)["started"] is True
    [started] = env.sfn.started
    assert started["input"]["requested_by"] == {
        "user_id": "creator-1",
        "email": "creator1@example.com",
        "limit": "12",
    }
    assert started["input"]["mode"] == "sync"


def test_a_schedule_uses_the_default_limit_and_fails_closed(env: Env, sources: Sources) -> None:  # noqa: F811
    settings = Settings()
    _limits(env, settings)
    kb_id = env.kb()
    _source(env, kb_id)
    assert _scheduled(env, kb_id)["started"] is True
    assert env.sfn.started[-1]["input"]["requested_by"]["limit"] == "7"
    env.db.update_item(
        TableName="knowledge",
        Key={"PK": {"S": f"KB#{kb_id}"}, "SK": {"S": "META"}},
        UpdateExpression="REMOVE sync_id",
    )
    settings.down = True
    result = _scheduled(env, kb_id)
    assert (result["started"], result["reason"]) == (False, "limit_unavailable")
    settings.down, settings.limits = False, {}
    assert _scheduled(env, kb_id)["started"] is False


def test_a_schedule_starts_nothing_without_an_approved_source(env: Env, sources: Sources) -> None:  # noqa: F811
    _limits(env, Settings())
    kb_id = env.kb()
    assert _scheduled(env, kb_id)["started"] is False
    _source(env, kb_id, status="pending")
    assert _scheduled(env, kb_id)["started"] is False
    deleting = env.kb(status="deleting")
    _source(env, deleting)
    assert _scheduled(env, deleting)["started"] is False
    assert env.sfn.started == []


def test_a_schedule_leaves_a_running_synchronization_alone(env: Env, sources: Sources) -> None:  # noqa: F811
    _limits(env, Settings())
    kb_id = env.kb()
    _source(env, kb_id)
    assert _scheduled(env, kb_id)["started"] is True
    assert _scheduled(env, kb_id)["started"] is False
    assert len(env.sfn.started) == 1


def test_a_schedule_names_ids_only(env: Env, sources: Sources) -> None:  # noqa: F811
    import pytest as _pytest  # noqa: PLC0415

    with _pytest.raises(handler.InvalidInputError):
        _scheduled(env, "../otra")


# --- A role IAM has not readied yet ---------------------------------------------------------

JUST_APPROVED = "2026-10-21T14:59:40+00:00"
"""Twenty seconds before the copy (``now_iso`` of the fixture)."""


def _copy_again(env: Env, state: dict[str, Any]) -> dict[str, Any]:  # noqa: F811
    """What the machine does after ``WaitCopy``: the same state, the copy step again."""
    return handler.handle(env.deps, {"step": "copy", "state": state})


def test_a_new_role_refused_is_waited_for_and_then_copies(env: Env, sources: Sources) -> None:  # noqa: F811
    kb_id = env.kb()
    _source(env, kb_id, decided_at=JUST_APPROVED)
    _put(env, "politicas/a.pdf", PDF)
    sources.denied = 2
    state = _copy(env, kb_id)
    # The machine waits; the function does not sleep.
    assert (state["copy_wait_seconds"], state["copy_waits"]) == (10, 1)
    assert state["counts"]["copied"] == 0
    state = _copy_again(env, state)
    assert state["copy_wait_seconds"] == 20
    state = _copy_again(env, state)
    assert "copy_wait_seconds" not in state
    assert "sources_unavailable" not in state
    assert state["counts"]["copied"] == 1


def test_a_new_role_that_may_list_but_not_read_yet_is_waited_for(
    env: Env,  # noqa: F811
    sources: Sources,
) -> None:
    kb_id = env.kb()
    _source(env, kb_id, decided_at=JUST_APPROVED)
    _put(env, "politicas/a.pdf", PDF)
    sources.reads_denied = 1
    state = _copy(env, kb_id)
    # Not «protected» for good: that document would never be copied again.
    assert state["copy_wait_seconds"] == 10
    assert _docs(env, kb_id) == {}
    state = _copy_again(env, state)
    assert _docs(env, kb_id)["politicas/a.pdf"]["status"]["S"] == "uploaded"


def test_the_wait_is_bounded_and_the_source_ends_unreadable(env: Env, sources: Sources) -> None:  # noqa: F811
    kb_id = env.kb()
    _source(env, kb_id, decided_at=JUST_APPROVED)
    _put(env, "politicas/a.pdf", PDF)
    sources.denied = 100
    state = _copy(env, kb_id)
    waited = [state["copy_wait_seconds"]]
    while "copy_wait_seconds" in state:
        state = _copy_again(env, state)
        waited += [state["copy_wait_seconds"]] if "copy_wait_seconds" in state else []
    assert waited == list(handler.COPY_WAITS)
    assert sum(waited) == 120
    assert len(sources.sessions) == len(handler.COPY_WAITS) + 1
    assert state["sources_unavailable"] == 1


def test_an_old_role_refused_is_unreadable_at_once(env: Env, sources: Sources) -> None:  # noqa: F811
    kb_id = env.kb()
    _source(env, kb_id, decided_at="2026-10-21T12:00:00+00:00")
    _put(env, "politicas/a.pdf", PDF)
    sources.denied = 1
    state = _copy(env, kb_id)
    assert "copy_wait_seconds" not in state
    assert state["sources_unavailable"] == 1


def _sync(env: Env, kb_id: str) -> dict[str, Any]:  # noqa: F811
    """Acquire, copy (with the waits taken out), plan, ingest, poll and finish."""
    state: dict[str, Any] = {
        "mode": "sync",
        "kb_id": kb_id,
        "sync_id": new_id(),
        "requested_by": REQUESTER,
    }
    assert SyncStore(env.db, "knowledge").claim(
        kb_id, state["sync_id"], "2026-10-21T15:00:00+00:00"
    )
    state = handler.handle(env.deps, {"step": "acquire", "state": state})
    state = handler.handle(env.deps, {"step": "copy", "state": state})
    while "copy_wait_seconds" in state or state["copy_more"]:
        state = _copy_again(env, state)
    state = handler.handle(env.deps, {"step": "plan", "state": state})
    while state["ingest"]:
        state = handler.handle(env.deps, {"step": "ingest", "state": state})
    env.agent.statuses = dict.fromkeys(state["indexing"], ("INDEXED", ""))
    if state["indexing"]:
        state = handler.handle(env.deps, {"step": "poll", "state": state})
    return handler.handle(env.deps, {"step": "finish", "state": state})


def test_a_source_that_could_not_be_read_is_not_synchronized(env: Env, sources: Sources) -> None:  # noqa: F811
    # Seen in the installation on 2026-10-23: «Sincronizada» with nothing read.
    kb_id = env.kb()
    _source(env, kb_id, decided_at=JUST_APPROVED)
    _put(env, "politicas/a.pdf", PDF)
    sources.denied = 100
    state = _sync(env, kb_id)
    assert state["outcome"] == "unreadable"
    meta = env.meta(kb_id)
    assert meta is not None
    assert (meta["status"]["S"], meta["status_reason"]["S"]) == ("error", "error")
    assert "synced_at" not in meta
    assert env.audit.events[-1][1]["outcome"] == "unreadable"


def test_a_source_read_after_waiting_is_synchronized(env: Env, sources: Sources) -> None:  # noqa: F811
    kb_id = env.kb()
    _source(env, kb_id, decided_at=JUST_APPROVED)
    _put(env, "politicas/a.pdf", PDF)
    sources.denied = 3
    state = _sync(env, kb_id)
    assert state["outcome"] == "done"
    meta = env.meta(kb_id)
    assert meta is not None
    assert meta["status"]["S"] == "ok"
    assert "status_reason" not in meta
