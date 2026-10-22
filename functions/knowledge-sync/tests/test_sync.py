"""The synchronization of the knowledge bases (D88 (11), (16), (24); TM-K1, TM-K5, TM-K6, TM-K10),
step by step as the state machine runs them, with DynamoDB and S3 in moto and doubles of
Bedrock and Step Functions."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from mango_core.knowledge import new_id
from mango_knowledge_sync import handler
from mango_knowledge_sync.bedrock import KnowledgeBedrock, reason_of
from mango_knowledge_sync.budget import Budgets, estimate
from mango_knowledge_sync.config import Settings
from mango_knowledge_sync.store import SyncStore

NOW = datetime(2026, 10, 21, 15, 0, tzinfo=UTC)
BUCKET = "mango-lab-knowledge-0a1b2c3d"
SETTINGS = Settings(
    namespace="lab",
    knowledge_table="knowledge",
    documents_bucket=BUCKET,
    knowledge_base_id="KBID000001",
    data_source_id="DSID000001",
    account_id="111122223333",
    state_machine_arn="arn:aws:states:us-east-1:111122223333:stateMachine:Mango-lab-KnowledgeSync",
    budgets_table="budgets",
    audit_stream="Mango-lab-audit",
    audit_index_table="audit-index",
    embedding_price=Decimal("0.02"),
)
REQUESTER = {"user_id": "creator-1", "email": "creator1@example.com", "limit": "5"}


@dataclass
class FakeAgent:
    """bedrock-agent: what was ingested and deleted, and the status Bedrock reports."""

    ingested: list[dict[str, Any]] = field(default_factory=list)
    deleted: list[list[str]] = field(default_factory=list)
    statuses: dict[str, tuple[str, str]] = field(default_factory=dict)
    throttle: bool = False
    deny: bool = False

    def ingest_knowledge_base_documents(self, **request: Any) -> dict[str, Any]:
        if self.throttle:
            raise ClientError({"Error": {"Code": "ThrottlingException"}}, "Ingest")
        if self.deny:
            raise ClientError({"Error": {"Code": "AccessDeniedException", "Message": ""}}, "Ingest")
        self.ingested.append(request)
        return {"documentDetails": []}

    def get_knowledge_base_documents(self, **request: Any) -> dict[str, Any]:
        details = []
        for identifier in request["documentIdentifiers"]:
            doc_id = identifier["custom"]["id"]
            if doc_id in self.statuses:
                status, reason = self.statuses[doc_id]
                details.append({"identifier": identifier, "status": status, "statusReason": reason})
        return {"documentDetails": details}

    def delete_knowledge_base_documents(self, **request: Any) -> dict[str, Any]:
        if self.deny:
            raise ClientError({"Error": {"Code": "AccessDeniedException", "Message": ""}}, "Delete")
        self.deleted.append([i["custom"]["id"] for i in request["documentIdentifiers"]])
        return {}


@dataclass
class FakeRuntime:
    """bedrock-agent-runtime: a search returns the fragments of what still ``answers``."""

    answers: dict[str, set[str]] = field(default_factory=dict)
    """kb_id -> doc ids with vectors."""
    filters: list[dict[str, Any]] = field(default_factory=list)

    def retrieve(self, **request: Any) -> dict[str, Any]:
        condition = request["retrievalConfiguration"]["vectorSearchConfiguration"]["filter"]
        self.filters.append(condition)
        if "equals" in condition:
            kb_id, ids = condition["equals"]["value"], None
        else:
            [kb, docs] = condition["andAll"]
            kb_id, ids = kb["equals"]["value"], set(docs["in"]["value"])
            assert docs["in"]["value"], "an empty `in` is an error of Retrieve (D88 (27))"
        found = [d for d in self.answers.get(kb_id, set()) if ids is None or d in ids]
        return {"retrievalResults": [{"metadata": {"kb_id": kb_id, "doc_id": d}} for d in found]}


@dataclass
class FakeSfn:
    started: list[dict[str, Any]] = field(default_factory=list)

    def start_execution(self, **request: Any) -> dict[str, Any]:
        self.started.append({**request, "input": json.loads(request["input"])})
        return {}


@dataclass
class FakeAudit:
    events: list[tuple[str, dict[str, Any]]] = field(default_factory=list)

    def emit(self, event: str, detail: dict[str, Any], now: Any = None) -> None:
        self.events.append((event, detail))


@dataclass
class Env:
    deps: handler.Deps
    db: Any
    s3: Any
    agent: FakeAgent
    runtime: FakeRuntime
    sfn: FakeSfn
    audit: FakeAudit
    metrics: dict[str, float]

    def kb(
        self, *, status: str = "pending", groups: tuple[str, ...] = ("hr",), **extra: str
    ) -> str:
        kb_id = new_id()
        item: dict[str, Any] = {
            "PK": {"S": f"KB#{kb_id}"},
            "SK": {"S": "META"},
            "all_pk": {"S": "KB"},
            "kb_id": {"S": kb_id},
            "name": {"S": "Políticas"},
            "owner_id": {"S": "creator-1"},
            "business_unit": {"S": "security"},
            "groups": {"SS": list(groups)},
            "classification": {"S": "internal"},
            "sync_schedule": {"S": "manual"},
            "status": {"S": status},
            "documents": {"N": "0"},
            "bytes": {"N": "0"},
            "version": {"N": "1"},
            "created_at": {"S": "2026-10-21T10:00:00+00:00"},
            "updated_at": {"S": "2026-10-21T10:00:00+00:00"},
        }
        item.update({k: {"S": v} for k, v in extra.items()})
        self.db.put_item(TableName="knowledge", Item=item)
        return kb_id

    def doc(self, kb_id: str, status: str = "uploaded", size: int = 4000) -> str:
        doc_id = new_id()
        self.db.put_item(
            TableName="knowledge",
            Item={
                "PK": {"S": f"KB#{kb_id}"},
                "SK": {"S": f"DOC#{doc_id}"},
                "kb_id": {"S": kb_id},
                "doc_id": {"S": doc_id},
                "name": {"S": "manual.pdf"},
                "size": {"N": str(size)},
                "content_type": {"S": "application/pdf"},
                "status": {"S": status},
                "uploaded_by": {"S": "creator-1"},
                "created_at": {"S": "2026-10-21T10:00:00+00:00"},
            },
        )
        self.db.update_item(
            TableName="knowledge",
            Key={"PK": {"S": f"KB#{kb_id}"}, "SK": {"S": "META"}},
            UpdateExpression="ADD documents :one, #b :size",
            ExpressionAttributeNames={"#b": "bytes"},
            ExpressionAttributeValues={":one": {"N": "1"}, ":size": {"N": str(size)}},
        )
        self.s3.put_object(Bucket=BUCKET, Key=f"kb/{kb_id}/docs/{doc_id}", Body=b"%PDF-1.7")
        return doc_id

    def meta(self, kb_id: str) -> dict[str, Any] | None:
        item = self.db.get_item(
            TableName="knowledge", Key={"PK": {"S": f"KB#{kb_id}"}, "SK": {"S": "META"}}
        ).get("Item")
        return dict(item) if item else None

    def status_of(self, kb_id: str, doc_id: str) -> str | None:
        item = self.db.get_item(
            TableName="knowledge", Key={"PK": {"S": f"KB#{kb_id}"}, "SK": {"S": f"DOC#{doc_id}"}}
        ).get("Item")
        return item["status"]["S"] if item else None

    def budget(self) -> dict[str, Decimal]:
        item = self.db.get_item(
            TableName="budgets", Key={"PK": {"S": "USER#creator-1"}, "SK": {"S": "2026-10"}}
        ).get("Item", {})
        return {k: Decimal(item[k]["N"]) for k in ("committed", "reserved", "spent") if k in item}

    def step(self, name: str, state: dict[str, Any]) -> dict[str, Any]:
        return handler.handle(self.deps, {"step": name, "state": state})

    def run(self, kb_id: str, *, requester: dict[str, str] | None = None) -> dict[str, Any]:
        """What the state machine does, with the waits taken out."""
        state: dict[str, Any] = {
            "mode": "sync",
            "kb_id": kb_id,
            "sync_id": new_id(),
            "requested_by": requester or REQUESTER,
        }
        assert SyncStore(self.db, "knowledge").claim(
            kb_id, state["sync_id"], "2026-10-21T15:00:00+00:00"
        )
        state = self.step("acquire", state)
        if not state["locked"]:
            return self.step("finish", state)
        state = self.step("plan", state)
        while state["ingest"]:
            state = self.step("ingest", state)
        while state["indexing"]:
            state = self.step("poll", state)
            if state["polled"]:
                break
        while state["delete"]:
            state = self.step("delete", state)
        while state["verifying"]:
            state = self.step("verify", state)
            if state["verified"]:
                break
        return self.step("finish", state)


def _table(db: Any, name: str, *, index: bool) -> None:
    attributes = ["PK", "SK", *(["all_pk", "created_at"] if index else [])]
    request: dict[str, Any] = {
        "TableName": name,
        "KeySchema": [
            {"AttributeName": "PK", "KeyType": "HASH"},
            {"AttributeName": "SK", "KeyType": "RANGE"},
        ],
        "AttributeDefinitions": [{"AttributeName": a, "AttributeType": "S"} for a in attributes],
        "BillingMode": "PAY_PER_REQUEST",
    }
    if index:
        request["GlobalSecondaryIndexes"] = [
            {
                "IndexName": "All",
                "KeySchema": [
                    {"AttributeName": "all_pk", "KeyType": "HASH"},
                    {"AttributeName": "created_at", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }
        ]
    db.create_table(**request)


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "knowledge", index=True)
        _table(db, "budgets", index=False)
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=BUCKET)
        s3.put_bucket_versioning(Bucket=BUCKET, VersioningConfiguration={"Status": "Enabled"})
        agent, runtime, sfn, audit = FakeAgent(), FakeRuntime(), FakeSfn(), FakeAudit()
        metrics: dict[str, float] = {}
        deps = handler.Deps(
            settings=SETTINGS,
            store=SyncStore(db, "knowledge"),
            bedrock=KnowledgeBedrock(
                agent,
                runtime,
                knowledge_base_id=SETTINGS.knowledge_base_id,
                data_source_id=SETTINGS.data_source_id,
                bucket=BUCKET,
                account_id=SETTINGS.account_id,
                sleep=lambda _s: None,
            ),
            budgets=Budgets(db, "budgets", sleep=lambda _s: None),
            audit=audit,  # type: ignore[arg-type]
            s3=s3,
            sfn=sfn,
            clock=lambda: NOW,
            metrics=metrics.__setitem__,
        )
        yield Env(deps, db, s3, agent, runtime, sfn, audit, metrics)


# --- Ingesting ------------------------------------------------------------------------------


def test_uploaded_documents_are_indexed_with_the_metadata_of_the_registry(env: Env) -> None:
    kb_id = env.kb(groups=("hr", "finance"))
    first, second = env.doc(kb_id), env.doc(kb_id, size=8000)
    env.agent.statuses = {first: ("INDEXED", ""), second: ("INDEXED", "")}
    state = env.run(kb_id)
    assert state["outcome"] == "done"
    [call] = env.agent.ingested
    assert call["knowledgeBaseId"] == "KBID000001"
    assert call["dataSourceId"] == "DSID000001"
    for document in call["documents"]:
        custom = document["content"]["custom"]
        assert custom["sourceType"] == "S3_LOCATION"
        assert custom["s3Location"]["bucketOwnerAccountId"] == "111122223333"
        doc_id = custom["customDocumentIdentifier"]["id"]
        assert custom["s3Location"]["uri"] == f"s3://{BUCKET}/kb/{kb_id}/docs/{doc_id}"
        attributes = {a["key"]: a["value"] for a in document["metadata"]["inlineAttributes"]}
        assert attributes["kb_id"] == {"type": "STRING", "stringValue": kb_id}
        assert attributes["doc_id"] == {"type": "STRING", "stringValue": doc_id}
        assert attributes["business_unit"]["stringValue"] == "security"
        assert sorted(attributes["acl_groups"]["stringListValue"]) == ["finance", "hr"]
        assert attributes["classification"]["stringValue"] == "internal"
    assert {env.status_of(kb_id, d) for d in (first, second)} == {"indexed"}
    meta = env.meta(kb_id)
    assert meta is not None
    assert meta["status"]["S"] == "ok"
    assert "sync_id" not in meta
    # The lock is free again.
    assert "Item" not in env.db.get_item(
        TableName="knowledge", Key={"PK": {"S": "LOCK#KBID000001"}, "SK": {"S": "LOCK"}}
    )


def test_every_document_ever_ingested_carries_its_kb_id(env: Env) -> None:
    kb_id = env.kb()
    ids = [env.doc(kb_id, size=100) for _ in range(60)]
    env.agent.statuses = dict.fromkeys(ids, ("INDEXED", ""))
    env.run(kb_id)
    assert [len(c["documents"]) for c in env.agent.ingested] == [25, 25, 10]
    for call in env.agent.ingested:
        for document in call["documents"]:
            [first, *_] = document["metadata"]["inlineAttributes"]
            assert first == {"key": "kb_id", "value": {"type": "STRING", "stringValue": kb_id}}
    # A retry of the same batch is the same request.
    tokens = [c["clientToken"] for c in env.agent.ingested]
    assert len(set(tokens)) == 3 and all(len(t) >= 33 for t in tokens)


def test_what_bedrock_does_not_index_is_failed_with_its_reason_and_warns(env: Env) -> None:
    kb_id = env.kb()
    good, scanned = env.doc(kb_id), env.doc(kb_id)
    env.agent.statuses = {
        good: ("INDEXED", ""),
        scanned: ("FAILED", "The document has no text content to index"),
    }
    env.run(kb_id)
    assert env.status_of(kb_id, scanned) == "failed"
    item = env.db.get_item(
        TableName="knowledge", Key={"PK": {"S": f"KB#{kb_id}"}, "SK": {"S": f"DOC#{scanned}"}}
    )["Item"]
    assert item["reason"]["S"] == "no_text"
    assert env.meta(kb_id)["status"]["S"] == "warn"  # type: ignore[index]


@pytest.mark.parametrize(
    ("text", "reason"),
    [
        ("File is password protected", "protected"),
        ("Exceeds the maximum file size", "too_large"),
        ("Unsupported file format", "unsupported"),
        ("No text content", "no_text"),
        ("Something else", "not_indexed"),
    ],
)
def test_the_reasons_of_the_design(text: str, reason: str) -> None:
    assert reason_of(text) == reason


def test_what_is_still_indexing_is_polled_by_the_next_synchronization(env: Env) -> None:
    kb_id = env.kb()
    slow = env.doc(kb_id)
    env.agent.statuses = {slow: ("IN_PROGRESS", "")}
    state = env.run(kb_id)
    assert state["polls"] == handler.MAX_POLLS
    assert env.status_of(kb_id, slow) == "indexing"
    assert env.meta(kb_id)["status"]["S"] == "syncing"  # type: ignore[index]
    env.agent.statuses = {slow: ("INDEXED", "")}
    env.run(kb_id)
    assert env.status_of(kb_id, slow) == "indexed"
    assert len(env.agent.ingested) == 1  # never ingested twice


# --- Budget (rule 4, D88 (24)) --------------------------------------------------------------


def test_the_embeddings_are_reserved_before_and_charged_after(env: Env) -> None:
    kb_id = env.kb()
    indexed, failed = env.doc(kb_id, size=4_000_000), env.doc(kb_id, size=4_000_000)
    env.agent.statuses = {indexed: ("INDEXED", ""), failed: ("FAILED", "unsupported format")}
    state = env.run(kb_id)
    reserved = estimate(8_000_000, Decimal("0.02"))
    assert state["reservation"]["amount"] == str(reserved)
    charged = estimate(4_000_000, Decimal("0.02"))
    assert env.budget() == {"committed": charged, "reserved": Decimal(0), "spent": charged}
    [detail] = [d for e, d in env.audit.events if e == "kb.sync"]
    assert (detail["reserved_usd"], detail["charged_usd"]) == (str(reserved), str(charged))
    assert detail["requested_by"] == "creator-1"


def test_a_synchronization_that_does_not_fit_in_the_budget_ingests_nothing(env: Env) -> None:
    kb_id = env.kb()
    env.doc(kb_id, size=10**9)
    state = env.run(kb_id, requester={**REQUESTER, "limit": "0.01"})
    assert state["outcome"] == "budget"
    assert env.agent.ingested == []
    assert env.budget() == {}
    assert env.meta(kb_id)["status"]["S"] == "error"  # type: ignore[index]


def test_a_failed_synchronization_releases_its_reservation_and_its_lock(env: Env) -> None:
    kb_id = env.kb()
    env.doc(kb_id)
    state = {"mode": "sync", "kb_id": kb_id, "sync_id": new_id(), "requested_by": REQUESTER}
    SyncStore(env.db, "knowledge").claim(kb_id, state["sync_id"], "2026-10-21T15:00:00+00:00")
    state = env.step("plan", env.step("acquire", state))
    assert env.budget()["reserved"] > 0
    state["error"] = {"Error": "States.TaskFailed"}
    env.step("finish", state)
    assert env.budget()["reserved"] == 0
    assert env.budget()["spent"] == 0
    assert env.meta(kb_id)["status"]["S"] == "error"  # type: ignore[index]
    # Finishing twice charges nothing twice.
    env.step("finish", state)
    assert env.budget()["spent"] == 0


# --- One at a time (D88 (11)) ---------------------------------------------------------------


def test_one_synchronization_at_a_time_per_bedrock_knowledge_base(env: Env) -> None:
    first, second = env.kb(), env.kb()
    holder = {"mode": "sync", "kb_id": first, "sync_id": new_id(), "requested_by": REQUESTER}
    assert env.step("acquire", holder)["locked"]
    waiting = {"mode": "sync", "kb_id": second, "sync_id": new_id(), "requested_by": REQUESTER}
    for _ in range(handler.MAX_LOCK_ATTEMPTS - 1):
        waiting = env.step("acquire", waiting)
        assert not waiting["locked"] and not waiting["gave_up"]
    waiting = env.step("acquire", waiting)
    assert waiting["gave_up"] and waiting["outcome"] == "busy"


def test_what_is_asked_for_while_one_runs_starts_after_it(env: Env) -> None:
    kb_id = env.kb(sync_again=json.dumps({"user_id": "creator-2", "email": "", "limit": "5"}))
    env.doc(kb_id)
    env.agent.statuses = {}
    env.run(kb_id)
    [started] = env.sfn.started
    assert started["stateMachineArn"] == SETTINGS.state_machine_arn
    assert started["input"]["requested_by"]["user_id"] == "creator-2"
    assert started["input"]["kb_id"] == kb_id
    assert started["name"] == started["input"]["sync_id"]
    assert env.meta(kb_id)["sync_id"]["S"] == started["name"]  # type: ignore[index]


# --- Deleting (D88 (16), TM-K5) -------------------------------------------------------------


def test_a_deleted_document_goes_only_once_nothing_of_it_answers(env: Env) -> None:
    kb_id = env.kb(status="ok", deleting_since="2026-10-21T14:00:00+00:00")
    keep, gone = env.doc(kb_id, "indexed"), env.doc(kb_id, "deleting", size=500)
    env.runtime.answers = {kb_id: {keep, gone}}
    state = env.run(kb_id)
    assert env.agent.deleted == [[gone]]
    # Still answering after every verification: it stays «Borrando», with its object.
    assert state["verifies"] == handler.MAX_VERIFIES
    assert env.status_of(kb_id, gone) == "deleting"
    assert "deleting_since" in env.meta(kb_id)  # type: ignore[operator]
    env.runtime.answers = {kb_id: {keep}}
    env.run(kb_id)
    assert env.status_of(kb_id, gone) is None
    assert env.status_of(kb_id, keep) == "indexed"
    meta = env.meta(kb_id)
    assert meta is not None
    assert (meta["documents"]["N"], meta["bytes"]["N"]) == ("1", "4000")
    assert "deleting_since" not in meta
    versions = env.s3.list_object_versions(Bucket=BUCKET, Prefix=f"kb/{kb_id}/docs/{gone}")
    assert versions.get("DeleteMarkers")
    # Every verification named the knowledge base and the documents; never an empty list.
    for condition in env.runtime.filters:
        assert condition["andAll"][0] == {"equals": {"key": "kb_id", "value": kb_id}}


def test_a_deleted_knowledge_base_goes_once_a_search_by_its_kb_id_returns_nothing(env: Env) -> None:
    kb_id = env.kb(status="deleting", deleting_since="2026-10-21T14:00:00+00:00")
    docs = [env.doc(kb_id, "indexed"), env.doc(kb_id, "uploaded")]
    other = env.kb()
    env.runtime.answers = {other: {"x"}}
    state = env.run(kb_id)
    assert sorted(env.agent.deleted[0]) == sorted(docs)
    assert env.agent.ingested == []  # nothing is ingested into a knowledge base being deleted
    assert state["counts"]["deleted"] == 2
    assert env.meta(kb_id) is None
    remaining = env.db.query(
        TableName="knowledge",
        KeyConditionExpression="PK = :pk",
        ExpressionAttributeValues={":pk": {"S": f"KB#{kb_id}"}},
    )["Items"]
    assert remaining == []
    assert (
        "kb.deleted",
        {"kb_id": kb_id, "sync_id": state["sync_id"], "verified": True},
    ) in env.audit.events
    # The whole-base check asked for its kb_id only.
    assert {"equals": {"key": "kb_id", "value": kb_id}} in env.runtime.filters
    assert env.meta(other) is not None


def test_a_knowledge_base_with_vectors_left_stays_deleting(env: Env) -> None:
    kb_id = env.kb(status="deleting")
    env.runtime.answers = {kb_id: {"orphan"}}
    env.run(kb_id)
    meta = env.meta(kb_id)
    assert meta is not None and meta["status"]["S"] == "deleting"


# --- The hourly sweep -----------------------------------------------------------------------


def test_the_sweep_counts_overdue_deletions_and_starts_their_synchronization(env: Env) -> None:
    overdue = env.kb(status="ok", deleting_since=(NOW - timedelta(hours=7)).isoformat())
    recent = env.kb(status="deleting", deleting_since=(NOW - timedelta(hours=1)).isoformat())
    env.kb()
    result = handler.handle(env.deps, {"step": "sweep", "state": {}})
    assert env.metrics == {"DeletionsOverdue": 1}
    assert result["started"] == 2
    modes = {s["input"]["kb_id"]: s["input"]["mode"] for s in env.sfn.started}
    assert modes == {overdue: "deletions", recent: "deletions"}
    # A synchronization of deletions costs nothing: it is asked for by the system.
    assert all(s["input"]["requested_by"]["limit"] == "0" for s in env.sfn.started)


def test_a_deletions_synchronization_never_ingests(env: Env) -> None:
    kb_id = env.kb()
    env.doc(kb_id)
    state = {
        "mode": "deletions",
        "kb_id": kb_id,
        "sync_id": new_id(),
        "requested_by": handler.SYSTEM.as_json(),
    }
    state = env.step("plan", env.step("acquire", state))
    assert state["ingest"] == []
    assert env.budget() == {}


def test_the_sweep_settles_a_synchronization_that_died(env: Env) -> None:
    kb_id = env.kb()
    env.doc(kb_id)
    state = {"mode": "sync", "kb_id": kb_id, "sync_id": new_id(), "requested_by": REQUESTER}
    store = SyncStore(env.db, "knowledge")
    store.claim(kb_id, state["sync_id"], (NOW - timedelta(hours=4)).isoformat())
    env.step("plan", env.step("acquire", state))
    reserved = env.budget()["reserved"]
    assert reserved > 0
    result = handler.handle(env.deps, {"step": "sweep", "state": {}})
    assert result["abandoned"] == 1
    # What it reserved is charged: what it spent is not known any more.
    assert env.budget() == {"committed": reserved, "reserved": Decimal(0), "spent": reserved}
    assert "sync_id" not in env.meta(kb_id)  # type: ignore[operator]


# --- Inputs and retries ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "state",
    [
        {"kb_id": "../x", "sync_id": new_id(), "requested_by": REQUESTER},
        {"kb_id": new_id(), "sync_id": "x", "requested_by": REQUESTER},
        {"kb_id": new_id(), "sync_id": new_id(), "requested_by": {"user_id": "a b"}},
        {"kb_id": new_id(), "sync_id": new_id(), "requested_by": REQUESTER, "ingest": ["KB#x"]},
    ],
)
def test_a_state_this_machine_does_not_write_is_refused(env: Env, state: dict[str, Any]) -> None:
    with pytest.raises(handler.InvalidInputError):
        env.step("plan", state)


def test_throttling_is_retried_by_the_state_machine(env: Env) -> None:
    kb_id = env.kb()
    env.doc(kb_id)
    state = {"mode": "sync", "kb_id": kb_id, "sync_id": new_id(), "requested_by": REQUESTER}
    state = env.step("plan", env.step("acquire", state))
    env.agent.throttle = True
    with pytest.raises(handler.RetryableStepError):
        env.step("ingest", state)


def test_an_unknown_step_is_refused(env: Env) -> None:
    with pytest.raises(handler.InvalidInputError):
        handler.handle(env.deps, {"step": "drop_everything", "state": {}})


def test_a_permission_refused_by_aws_is_not_retried_and_says_its_code(
    env: Env, caplog: pytest.LogCaptureFixture
) -> None:
    """Seen in an installation on 2026-10-22: the deletion was retried as if Bedrock were
    busy, and the log only said BedrockUnavailableError."""
    kb_id = env.kb(status="deleting")
    doc = env.doc(kb_id)
    state = {"mode": "sync", "kb_id": kb_id, "sync_id": new_id(), "requested_by": REQUESTER}
    state = env.step("plan", env.step("acquire", state))
    assert state["delete"] == [doc]
    env.agent.deny = True
    with pytest.raises(handler.StepDeniedError, match="AccessDeniedException"):
        env.step("delete", state)
    assert "denied by AWS: AccessDeniedException" in caplog.text
    # Ingesting is refused the same way.
    other = env.kb()
    env.doc(other)
    state = {"mode": "sync", "kb_id": other, "sync_id": new_id(), "requested_by": REQUESTER}
    env.deps.store.release(SETTINGS.knowledge_base_id, "nobody")
    state = env.step("plan", {**state, "locked": True})
    with pytest.raises(handler.StepDeniedError):
        env.step("ingest", state)


def test_a_retried_step_logs_the_code_of_aws(env: Env, caplog: pytest.LogCaptureFixture) -> None:
    kb_id = env.kb()
    env.doc(kb_id)
    state = {"mode": "sync", "kb_id": kb_id, "sync_id": new_id(), "requested_by": REQUESTER}
    state = env.step("plan", env.step("acquire", state))
    env.agent.throttle = True
    with pytest.raises(handler.RetryableStepError):
        env.step("ingest", state)
    assert "will be retried: ThrottledError (ThrottlingException)" in caplog.text


@pytest.mark.parametrize(
    ("exc", "code"),
    [
        (
            ClientError({"Error": {"Code": "AccessDenied", "Message": "secret text"}}, "X"),
            "AccessDenied",
        ),
        (handler.StoreUnavailableError("ValidationException"), "ValidationException"),
        (handler.StoreUnavailableError("quoted request: a b"), "unknown"),
        (handler.StoreUnavailableError(), "unknown"),
    ],
)
def test_only_the_code_reaches_the_log(exc: Exception, code: str) -> None:
    assert handler.aws_code(exc) == code
