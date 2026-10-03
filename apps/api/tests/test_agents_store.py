"""Agents table repository against moto DynamoDB: real conditions, transactions and indexes."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
import pytest
from moto import mock_aws

from mango_api.agent_rules import MAX_DRAFTS, MAX_SUBMISSIONS_PER_DAY
from mango_api.agents_store import (
    AgentConflictError,
    AgentNotFoundError,
    AgentsStore,
    AgentVersion,
    DraftLimitError,
    SelfApprovalError,
    SubmissionLimitError,
)
from mango_core.agents import (
    ROOT_SUPERVISOR,
    AgentDefinition,
    AgentStatus,
    VersionStatus,
    verify_content,
)
from mango_core.agents_table import (
    INDEX_BY_CREATOR,
    INDEX_BY_STATUS,
    creator_pk,
    day_sk,
    fail_item,
    publish_items,
    version_key,
)

TABLE = "Mango-test-Agents"
NOW = datetime(2026, 10, 1, 15, 0, tzinfo=UTC)
CREATOR = "creator-1"
ADMIN = "admin-1"
ADMIN2 = "admin-2"
HARNESS = "arn:aws:bedrock-agentcore:us-east-1:111111111111:harness/Mango_test_a_x"


def create_agents_table(client: Any, name: str = TABLE) -> None:
    """Same keys and indexes as `infra/lib/constructs/governance.ts`."""
    string = "S"
    client.create_table(
        TableName=name,
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[
            {"AttributeName": n, "AttributeType": string}
            for n in ("PK", "SK", "status_index", "status_at", "creator_index", "created_at")
        ],
        KeySchema=[
            {"AttributeName": "PK", "KeyType": "HASH"},
            {"AttributeName": "SK", "KeyType": "RANGE"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": INDEX_BY_STATUS,
                "KeySchema": [
                    {"AttributeName": "status_index", "KeyType": "HASH"},
                    {"AttributeName": "status_at", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            },
            {
                "IndexName": INDEX_BY_CREATOR,
                "KeySchema": [
                    {"AttributeName": "creator_index", "KeyType": "HASH"},
                    {"AttributeName": "created_at", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            },
        ],
    )


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        create_agents_table(client)
        yield client


@pytest.fixture
def store(db: Any) -> AgentsStore:
    return AgentsStore(db, TABLE)


def definition(**overrides: Any) -> AgentDefinition:
    base: dict[str, Any] = {
        "name": "Analista",
        "reports_to": ROOT_SUPERVISOR,
        "role": "Costos",
        "system_prompt": "Eres un analista.",
        "groups": ["finops-central"],
    }
    return AgentDefinition.model_validate({**base, **overrides})


def new_draft(store: AgentsStore, actor: str = CREATOR, **overrides: Any) -> AgentVersion:
    return store.create_agent(
        definition(**overrides), actor=actor, actor_email=f"{actor}@example.com", now=NOW
    )


def in_review(store: AgentsStore, actor: str = CREATOR, **overrides: Any) -> AgentVersion:
    draft = new_draft(store, actor, **overrides)
    return store.submit(draft.agent_id, 1, revision=draft.revision, actor=actor, now=NOW)


def publish(db: Any, store: AgentsStore, version: AgentVersion) -> None:
    """What the provisioner does after deploying an approved version."""
    meta = store.meta(version.agent_id)
    current = store.version(version.agent_id, version.number)
    assert meta is not None and current is not None and current.content_hash is not None
    db.transact_write_items(
        TransactItems=publish_items(
            TABLE,
            agent_id=version.agent_id,
            version=version.number,
            content_hash=current.content_hash,
            previous_version=meta.published_version,
            harness_arn=HARNESS,
            harness_version=str(version.number),
            now=NOW,
        )
    )


def published(db: Any, store: AgentsStore, **overrides: Any) -> AgentVersion:
    review = in_review(store, **overrides)
    assert review.content_hash is not None
    store.approve(review.agent_id, 1, content_hash=review.content_hash, approver=ADMIN, now=NOW)
    publish(db, store, review)
    result = store.version(review.agent_id, 1)
    assert result is not None
    return result


# --- Drafts ---------------------------------------------------------------------------------------


def test_create_agent_stores_meta_and_first_draft(store: AgentsStore) -> None:
    draft = new_draft(store)
    meta = store.meta(draft.agent_id)
    assert meta is not None
    assert (meta.status, meta.latest_version, meta.open_version) == (AgentStatus.DRAFT, 1, 1)
    assert meta.published_version is None and meta.created_by == CREATOR
    assert (draft.number, draft.status, draft.revision) == (1, VersionStatus.DRAFT, 1)
    assert draft.content_hash is None
    assert draft.editors == {CREATOR}
    assert draft.created_by_email == "creator-1@example.com"
    stored = store.version(draft.agent_id, 1)
    assert stored == draft


def test_release_agents_keep_their_slug_and_ids_never_collide(store: AgentsStore) -> None:
    release = store.create_agent(
        definition(), actor="release", actor_email=None, now=NOW, agent_id="finops"
    )
    assert release.agent_id == "finops"
    with pytest.raises(AgentConflictError):
        store.create_agent(
            definition(), actor=CREATOR, actor_email=None, now=NOW, agent_id="finops"
        )
    with pytest.raises(ValueError, match="invalid agent id"):
        store.create_agent(
            definition(), actor=CREATOR, actor_email=None, now=NOW, agent_id="platform"
        )


def test_save_draft_uses_optimistic_locking(store: AgentsStore) -> None:
    draft = new_draft(store)
    revision = store.save_draft(
        draft.agent_id, 1, revision=1, definition=definition(role="Otro"), actor=ADMIN, now=NOW
    )
    assert revision == 2
    saved = store.version(draft.agent_id, 1)
    assert saved is not None
    assert saved.definition.role == "Otro"
    assert saved.editors == {CREATOR, ADMIN}
    with pytest.raises(AgentConflictError):
        store.save_draft(
            draft.agent_id,
            1,
            revision=1,
            definition=definition(role="Viejo"),
            actor=CREATOR,
            now=NOW,
        )
    unchanged = store.version(draft.agent_id, 1)
    assert unchanged is not None and unchanged.definition.role == "Otro"


def test_unknown_agents_and_versions(store: AgentsStore) -> None:
    assert store.meta("finops") is None
    assert store.meta("../etc") is None
    assert store.version("finops", 1) is None
    assert store.version("finops", 0) is None
    assert store.versions("no such") == []
    with pytest.raises(AgentNotFoundError):
        store.submit("finops", 1, revision=1, actor=CREATOR, now=NOW)
    with pytest.raises(AgentNotFoundError):
        store.create_version("finops", definition(), actor=CREATOR, actor_email=None, now=NOW)
    with pytest.raises(AgentConflictError):
        store.save_draft("finops", 1, revision=1, definition=definition(), actor=CREATOR, now=NOW)


def test_draft_limit_per_creator(store: AgentsStore) -> None:
    for _ in range(MAX_DRAFTS):
        new_draft(store)
    assert store.draft_count(CREATOR) == MAX_DRAFTS
    with pytest.raises(DraftLimitError):
        new_draft(store)
    # Another creator has an own quota; sending a draft to review frees a slot.
    new_draft(store, actor="creator-2")
    first = store.by_creator(CREATOR)[0]
    store.submit(first.agent_id, 1, revision=1, actor=CREATOR, now=NOW)
    new_draft(store)


def test_discarding_the_only_draft_removes_the_agent(store: AgentsStore) -> None:
    draft = new_draft(store)
    with pytest.raises(AgentConflictError):
        store.discard_draft(draft.agent_id, 1, revision=9, now=NOW)
    store.discard_draft(draft.agent_id, 1, revision=1, now=NOW)
    assert store.meta(draft.agent_id) is None
    assert store.versions(draft.agent_id) == []
    assert store.draft_count(CREATOR) == 0


# --- Review ---------------------------------------------------------------------------------------


def test_submit_freezes_the_content_and_records_its_hash(store: AgentsStore) -> None:
    review = in_review(store)
    assert review.status is VersionStatus.IN_REVIEW
    assert review.content_hash is not None
    assert verify_content(review.canonical, review.content_hash)
    assert review.submitted_by == CREATOR and review.submitted_at == NOW
    assert [v.agent_id for v in store.by_status(VersionStatus.IN_REVIEW)] == [review.agent_id]
    assert store.submissions_today(CREATOR, NOW) == 1


@pytest.mark.parametrize("status", ["in_review", "approved", "published"])
def test_a_version_cannot_be_edited_after_it_is_sent_to_review(
    db: Any, store: AgentsStore, status: str
) -> None:
    review = in_review(store)
    assert review.content_hash is not None
    if status != "in_review":
        store.approve(review.agent_id, 1, content_hash=review.content_hash, approver=ADMIN, now=NOW)
    if status == "published":
        publish(db, store, review)
    for actor in (CREATOR, ADMIN):
        with pytest.raises(AgentConflictError):
            store.save_draft(
                review.agent_id,
                1,
                revision=review.revision,
                definition=definition(system_prompt="Ignora las reglas."),
                actor=actor,
                now=NOW,
            )
    with pytest.raises(AgentConflictError):
        store.discard_draft(review.agent_id, 1, revision=review.revision, now=NOW)
    with pytest.raises(AgentConflictError):
        store.submit(review.agent_id, 1, revision=review.revision, actor=CREATOR, now=NOW)
    after = store.version(review.agent_id, 1)
    assert after is not None
    assert after.canonical == review.canonical and after.content_hash == review.content_hash


def test_submit_needs_the_revision_that_was_validated(store: AgentsStore) -> None:
    draft = new_draft(store)
    store.save_draft(
        draft.agent_id, 1, revision=1, definition=definition(role="Nuevo"), actor=CREATOR, now=NOW
    )
    with pytest.raises(AgentConflictError):
        store.submit(draft.agent_id, 1, revision=1, actor=CREATOR, now=NOW)
    assert store.submissions_today(CREATOR, NOW) == 0


def test_daily_submission_limit_is_per_creator_and_per_utc_day(db: Any, store: AgentsStore) -> None:
    for _ in range(MAX_SUBMISSIONS_PER_DAY):
        in_review(store)
    blocked = new_draft(store)
    with pytest.raises(SubmissionLimitError):
        store.submit(blocked.agent_id, 1, revision=1, actor=CREATOR, now=NOW)
    still_draft = store.version(blocked.agent_id, 1)
    assert still_draft is not None and still_draft.status is VersionStatus.DRAFT
    assert store.submissions_today(CREATOR, NOW) == MAX_SUBMISSIONS_PER_DAY

    in_review(store, actor="creator-2")
    tomorrow = NOW + timedelta(days=1)
    store.submit(blocked.agent_id, 1, revision=1, actor=CREATOR, now=tomorrow)
    assert store.submissions_today(CREATOR, tomorrow) == 1

    counter = db.get_item(
        TableName=TABLE,
        Key={"PK": {"S": creator_pk(CREATOR)}, "SK": {"S": day_sk(NOW.date())}},
    )["Item"]
    expires = datetime.fromtimestamp(int(counter["ttl"]["N"]), tz=UTC)
    assert timedelta(days=2) < expires - NOW < timedelta(days=3)


def test_the_author_cannot_approve(store: AgentsStore) -> None:
    review = in_review(store)
    assert review.content_hash is not None
    with pytest.raises(SelfApprovalError):
        store.approve(
            review.agent_id, 1, content_hash=review.content_hash, approver=CREATOR, now=NOW
        )
    current = store.version(review.agent_id, 1)
    assert current is not None and current.status is VersionStatus.IN_REVIEW


def test_whoever_edited_or_submitted_a_draft_cannot_approve_it(store: AgentsStore) -> None:
    draft = new_draft(store)
    store.save_draft(
        draft.agent_id, 1, revision=1, definition=definition(role="Editado"), actor=ADMIN, now=NOW
    )
    review = store.submit(draft.agent_id, 1, revision=2, actor=ADMIN2, now=NOW)
    assert review.content_hash is not None
    for author in (CREATOR, ADMIN, ADMIN2):
        with pytest.raises(SelfApprovalError):
            store.approve(
                review.agent_id, 1, content_hash=review.content_hash, approver=author, now=NOW
            )
    store.approve(review.agent_id, 1, content_hash=review.content_hash, approver="admin-3", now=NOW)


def test_self_approval_is_also_refused_by_the_table_condition(db: Any, store: AgentsStore) -> None:
    """The Python check reads first; the condition must hold on its own (race)."""
    review = in_review(store)
    assert review.content_hash is not None

    class StaleRead(AgentsStore):
        def _require(self, agent_id: str, number: int) -> AgentVersion:
            current = super()._require(agent_id, number)
            return AgentVersion(**{**current.__dict__, "editors": frozenset(), "created_by": "x"})

    with pytest.raises(AgentConflictError):
        StaleRead(db, TABLE).approve(
            review.agent_id, 1, content_hash=review.content_hash, approver=CREATOR, now=NOW
        )


def test_approval_is_bound_to_the_hash_the_approver_saw(store: AgentsStore) -> None:
    review = in_review(store)
    assert review.content_hash is not None
    with pytest.raises(AgentConflictError):
        store.approve(review.agent_id, 1, content_hash="0" * 64, approver=ADMIN, now=NOW)
    store.approve(review.agent_id, 1, content_hash=review.content_hash, approver=ADMIN, now=NOW)
    approved = store.version(review.agent_id, 1)
    assert approved is not None
    assert (approved.status, approved.approved_by) == (VersionStatus.APPROVED, ADMIN)
    assert approved.content_hash == review.content_hash
    assert store.by_status(VersionStatus.IN_REVIEW) == []
    assert len(store.by_status(VersionStatus.APPROVED)) == 1
    with pytest.raises(AgentConflictError):
        store.approve(
            review.agent_id, 1, content_hash=review.content_hash, approver=ADMIN2, now=NOW
        )


def test_reject_returns_the_version_to_an_editable_draft(store: AgentsStore) -> None:
    review = in_review(store)
    store.reject(review.agent_id, 1, rejected_by=ADMIN, reason="Faltan límites", now=NOW)
    draft = store.version(review.agent_id, 1)
    assert draft is not None
    assert draft.status is VersionStatus.DRAFT and draft.content_hash is None
    assert (draft.rejected_by, draft.rejection_reason) == (ADMIN, "Faltan límites")
    assert draft.revision == review.revision + 1
    assert store.by_status(VersionStatus.IN_REVIEW) == []
    with pytest.raises(AgentConflictError):
        store.reject(review.agent_id, 1, rejected_by=ADMIN, reason="otra vez", now=NOW)

    revision = store.save_draft(
        review.agent_id,
        1,
        revision=draft.revision,
        definition=definition(role="Corregido"),
        actor=CREATOR,
        now=NOW,
    )
    again = store.submit(review.agent_id, 1, revision=revision, actor=CREATOR, now=NOW)
    assert again.content_hash != review.content_hash
    assert again.rejection_reason is None


# --- Publication (provisioner) and new versions ---------------------------------------------------


def test_publish_marks_the_version_and_the_agent(db: Any, store: AgentsStore) -> None:
    version = published(db, store)
    meta = store.meta(version.agent_id)
    assert meta is not None
    assert (meta.status, meta.published_version, meta.open_version) == (
        AgentStatus.PUBLISHED,
        1,
        None,
    )
    assert (meta.harness_arn, meta.harness_version) == (HARNESS, "1")
    assert version.status is VersionStatus.PUBLISHED and version.published_at == NOW
    assert [v.agent_id for v in store.by_status(VersionStatus.PUBLISHED)] == [version.agent_id]
    assert store.supervisor_of(version.agent_id) == ROOT_SUPERVISOR


def test_publish_is_refused_when_the_hash_or_state_do_not_match(
    db: Any, store: AgentsStore
) -> None:
    review = in_review(store)
    assert review.content_hash is not None
    args: dict[str, Any] = {
        "agent_id": review.agent_id,
        "version": 1,
        "previous_version": None,
        "harness_arn": HARNESS,
        "harness_version": "1",
        "now": NOW,
    }
    # Not approved yet.
    with pytest.raises(db.exceptions.TransactionCanceledException):
        db.transact_write_items(
            TransactItems=publish_items(TABLE, content_hash=review.content_hash, **args)
        )
    store.approve(review.agent_id, 1, content_hash=review.content_hash, approver=ADMIN, now=NOW)
    with pytest.raises(db.exceptions.TransactionCanceledException):
        db.transact_write_items(TransactItems=publish_items(TABLE, content_hash="0" * 64, **args))
    meta = store.meta(review.agent_id)
    assert meta is not None and meta.status is AgentStatus.DRAFT


def test_new_version_of_a_published_agent(db: Any, store: AgentsStore) -> None:
    first = published(db, store)
    agent_id = first.agent_id
    second = store.create_version(
        agent_id, definition(role="v2"), actor="creator-2", actor_email=None, now=NOW
    )
    assert (second.number, second.base_version, second.status) == (2, 1, VersionStatus.DRAFT)
    with pytest.raises(AgentConflictError):  # one open version per agent
        store.create_version(agent_id, definition(), actor=CREATOR, actor_email=None, now=NOW)

    # The published version keeps serving while the new one is reviewed.
    review = store.submit(agent_id, 2, revision=1, actor="creator-2", now=NOW)
    meta = store.meta(agent_id)
    assert meta is not None and (meta.published_version, meta.open_version) == (1, 2)
    assert review.content_hash is not None
    store.approve(agent_id, 2, content_hash=review.content_hash, approver=ADMIN, now=NOW)
    publish(db, store, review)

    meta = store.meta(agent_id)
    assert meta is not None and (meta.published_version, meta.open_version) == (2, None)
    statuses = [v.status for v in store.versions(agent_id)]
    assert statuses == [VersionStatus.SUPERSEDED, VersionStatus.PUBLISHED]
    assert [v.number for v in store.by_status(VersionStatus.PUBLISHED)] == [2]
    old = store.version(agent_id, 1)
    assert old is not None and old.canonical == first.canonical  # never overwritten


def test_a_draft_agent_cannot_get_a_second_version(store: AgentsStore) -> None:
    draft = new_draft(store)
    with pytest.raises(AgentConflictError):
        store.create_version(draft.agent_id, definition(), actor=CREATOR, actor_email=None, now=NOW)


def test_discarding_a_draft_of_a_published_agent_keeps_the_agent(
    db: Any, store: AgentsStore
) -> None:
    first = published(db, store)
    store.create_version(first.agent_id, definition(), actor=CREATOR, actor_email=None, now=NOW)
    store.discard_draft(first.agent_id, 2, revision=1, now=NOW)
    meta = store.meta(first.agent_id)
    assert meta is not None
    assert (meta.status, meta.published_version, meta.open_version) == (
        AgentStatus.PUBLISHED,
        1,
        None,
    )
    # Version numbers are never reused.
    third = store.create_version(
        first.agent_id, definition(), actor=CREATOR, actor_email=None, now=NOW
    )
    assert third.number == 3


def test_failed_publication_can_be_retried_or_reopened(db: Any, store: AgentsStore) -> None:
    review = in_review(store)
    assert review.content_hash is not None
    agent_id = review.agent_id
    store.approve(agent_id, 1, content_hash=review.content_hash, approver=ADMIN, now=NOW)
    failed = fail_item(
        TABLE,
        agent_id=agent_id,
        version=1,
        failed_step="create_harness",
        failure="x" * 900,
        now=NOW,
    )
    db.update_item(**failed)
    current = store.version(agent_id, 1)
    assert current is not None
    assert (current.status, current.failed_step) == (VersionStatus.FAILED, "create_harness")
    assert current.failure is not None and len(current.failure) == 500
    with pytest.raises(db.exceptions.ConditionalCheckFailedException):
        db.update_item(**failed)  # only an approved version can fail

    with pytest.raises(AgentConflictError):
        store.retry_failed(agent_id, 1, content_hash="0" * 64, now=NOW)
    store.retry_failed(agent_id, 1, content_hash=review.content_hash, now=NOW)
    retried = store.version(agent_id, 1)
    assert retried is not None
    assert (retried.status, retried.approved_by) == (VersionStatus.APPROVED, ADMIN)

    db.update_item(**failed)
    store.reopen_failed(agent_id, 1, now=NOW)
    draft = store.version(agent_id, 1)
    assert draft is not None
    assert draft.status is VersionStatus.DRAFT
    assert draft.content_hash is None and draft.approved_by is None
    assert draft.failed_step == "create_harness"
    with pytest.raises(AgentConflictError):
        store.reopen_failed(agent_id, 1, now=NOW)


def test_fail_item_rejects_free_text_steps() -> None:
    with pytest.raises(ValueError, match="invalid step"):
        fail_item(
            TABLE, agent_id="finops", version=1, failed_step="Crear rol; x", failure="", now=NOW
        )
    with pytest.raises(ValueError, match="out of range"):
        version_key("finops", 0)


# --- Retirement and organization ------------------------------------------------------------------


def test_retire_keeps_history_and_blocks_new_work(db: Any, store: AgentsStore) -> None:
    first = published(db, store)
    agent_id = first.agent_id
    store.create_version(agent_id, definition(role="v2"), actor=CREATOR, actor_email=None, now=NOW)
    meta = store.meta(agent_id)
    assert meta is not None
    with pytest.raises(AgentConflictError):
        store.retire(agent_id, version=meta.version - 1, actor=ADMIN, reason="obsoleto", now=NOW)
    store.retire(agent_id, version=meta.version, actor=ADMIN, reason="obsoleto", now=NOW)

    retired = store.meta(agent_id)
    assert retired is not None
    assert (retired.status, retired.retired_by, retired.retire_reason) == (
        AgentStatus.RETIRED,
        ADMIN,
        "obsoleto",
    )
    assert retired.retired_at == NOW
    assert len(store.versions(agent_id)) == 2
    assert store.by_status(VersionStatus.PUBLISHED) == []
    assert [v.agent_id for v in store.by_status(VersionStatus.RETIRED)] == [agent_id]
    assert store.supervisor_of(agent_id) is None

    with pytest.raises(AgentConflictError):
        store.submit(agent_id, 2, revision=1, actor=CREATOR, now=NOW)
    assert store.submissions_today(CREATOR, NOW) == 1  # the refused submit is not counted
    with pytest.raises(AgentConflictError):
        store.create_version(agent_id, definition(), actor=CREATOR, actor_email=None, now=NOW)
    with pytest.raises(AgentConflictError):
        store.retire(agent_id, version=retired.version, actor=ADMIN, reason="otra vez", now=NOW)


def test_only_published_agents_can_be_retired(store: AgentsStore) -> None:
    draft = new_draft(store)
    with pytest.raises(AgentConflictError):
        store.retire(draft.agent_id, version=1, actor=ADMIN, reason="x", now=NOW)
    with pytest.raises(AgentNotFoundError):
        store.retire("finops", version=1, actor=ADMIN, reason="x", now=NOW)


def test_supervisor_of_reads_the_published_version_only(db: Any, store: AgentsStore) -> None:
    boss = published(db, store)
    report = published(db, store, reports_to=boss.agent_id)
    assert store.supervisor_of(report.agent_id) == boss.agent_id
    assert store.supervisor_of(boss.agent_id) == ROOT_SUPERVISOR
    draft = new_draft(store, reports_to=boss.agent_id)
    assert store.supervisor_of(draft.agent_id) is None
    assert store.supervisor_of("unknown") is None

    # A pending change of supervisor does not move the published chart.
    store.create_version(
        report.agent_id,
        definition(reports_to=ROOT_SUPERVISOR),
        actor=CREATOR,
        actor_email=None,
        now=NOW,
    )
    assert store.supervisor_of(report.agent_id) == boss.agent_id


def test_by_creator_lists_newest_first(store: AgentsStore) -> None:
    old = store.create_agent(definition(name="Viejo"), actor=CREATOR, actor_email=None, now=NOW)
    new = store.create_agent(
        definition(name="Nuevo"), actor=CREATOR, actor_email=None, now=NOW + timedelta(minutes=5)
    )
    new_draft(store, actor="creator-2")
    assert [v.agent_id for v in store.by_creator(CREATOR)] == [new.agent_id, old.agent_id]


def test_corrupt_stored_definitions_fail_closed(db: Any, store: AgentsStore) -> None:
    draft = new_draft(store)
    db.update_item(
        TableName=TABLE,
        Key=version_key(draft.agent_id, 1),
        UpdateExpression="SET #d = :d",
        ExpressionAttributeNames={"#d": "definition"},
        ExpressionAttributeValues={":d": {"S": '{"name":"x","iam":"*"}'}},
    )
    with pytest.raises(ValueError, match="invalid definition"):
        store.version(draft.agent_id, 1)


@pytest.mark.parametrize("reason", ["", "x" * 501])
def test_reasons_are_bounded(db: Any, store: AgentsStore, reason: str) -> None:
    review = in_review(store)
    with pytest.raises(ValueError, match="reason must have"):
        store.reject(review.agent_id, 1, rejected_by=ADMIN, reason=reason, now=NOW)
    current = store.version(review.agent_id, 1)
    assert current is not None and current.status is VersionStatus.IN_REVIEW
