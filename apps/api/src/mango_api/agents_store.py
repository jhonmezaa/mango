"""Agents table repository (Marketplace v1, D18): versioned agent definitions.

The item layout lives in ``mango_core.agents_table`` (shared with the provisioner). This
module owns the lifecycle up to ``approved`` and retirement; ``approved`` -> ``published`` or
``failed`` belongs to the provisioner.

Invariants enforced with DynamoDB conditions, not only in Python (threat model
``marketplace-v1-threat-model.md``):

* A version is editable only while it is a ``draft``; sending it to review freezes the content
  and stores its ``content_hash`` (TM-M2). Every write to a draft carries the ``revision`` the
  caller read (optimistic locking).
* Approval names the hash the approver saw and is refused to anyone who wrote that content
  (``editors``), not only to the creator of the version (TM-M2).
* An agent has at most one open version (``open_version``), so reviews never race each other.
* A creator holds at most ``MAX_DRAFTS`` drafts and sends at most ``MAX_SUBMISSIONS_PER_DAY``
  versions to review per UTC day (TM-M9). The daily counter is atomic; the draft count reads
  an eventually consistent index, which is enough for a quota.
* Nothing is deleted except a draft; agents are retired and keep their history (D22).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from typing import TYPE_CHECKING, Any

from botocore.exceptions import ClientError

from mango_api.agent_rules import MAX_DRAFTS, MAX_SUBMISSIONS_PER_DAY
from mango_core.agents import (
    ROOT_SUPERVISOR,
    AgentDefinition,
    AgentStatus,
    VersionStatus,
    dumps_definition,
    is_agent_id,
    loads_definition,
    new_agent_id,
)
from mango_core.agents import content_hash as hash_content
from mango_core.agents_table import (
    APPROVED_STUCK_AFTER,
    EXPIRED_STEP,
    INDEX_BY_CREATOR,
    INDEX_BY_STATUS,
    MAX_VERSION,
    REJECTED_INDEX,
    VERSION_PREFIX,
    agent_pk,
    creator_pk,
    day_sk,
    fail_item,
    iso,
    meta_key,
    published_key,
    status_index,
    version_key,
)

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

MAX_PAGES = 20
COUNTER_RETENTION = timedelta(days=2)
MAX_REASON_CHARS = 500
START_STEP = "start_provisioner"
"""``failed_step`` when mango-api could not start the provisioner."""
_CONDITION_FAILED = "ConditionalCheckFailed"
_CONFLICT_REASONS = frozenset({"None", _CONDITION_FAILED, "TransactionConflict"})


class AgentNotFoundError(Exception):
    """No such agent or version."""


class AgentConflictError(Exception):
    """The item changed since the caller read it, or is not in the required state."""


class DraftLimitError(Exception):
    """The creator already holds the maximum number of drafts."""


class SubmissionLimitError(Exception):
    """The creator already sent the maximum number of versions to review today."""


class SelfApprovalError(Exception):
    """Whoever wrote a version cannot approve it (D18)."""


@dataclass(frozen=True)
class AgentMeta:
    agent_id: str
    status: AgentStatus
    version: int
    """Optimistic lock of the agent item (not a version number of the agent)."""
    latest_version: int
    open_version: int | None
    published_version: int | None
    created_by: str
    created_at: datetime
    harness_arn: str | None
    harness_version: str | None
    retired_by: str | None
    retired_at: datetime | None
    retire_reason: str | None
    retired_by_email: str | None = None


@dataclass(frozen=True)
class AgentVersion:
    agent_id: str
    number: int
    status: VersionStatus
    revision: int
    definition: AgentDefinition
    canonical: str
    """The stored JSON; ``content_hash`` is computed over exactly this string."""
    content_hash: str | None
    base_version: int | None
    created_by: str
    created_by_email: str | None
    created_at: datetime
    updated_at: datetime
    editors: frozenset[str]
    submitted_by: str | None
    submitted_at: datetime | None
    approved_by: str | None
    approved_at: datetime | None
    rejected_by: str | None
    rejected_at: datetime | None
    rejection_reason: str | None
    failed_step: str | None
    failure: str | None
    published_at: datetime | None
    status_at: datetime | None = None
    """When the version entered its indexed status (``None`` for plain drafts)."""
    approved_by_email: str | None = None
    rejected_by_email: str | None = None

    def approval_expired(self, now: datetime) -> bool:
        """``approved`` for so long that no provisioner execution can still be publishing it."""
        return (
            self.status is VersionStatus.APPROVED
            and self.status_at is not None
            and now - self.status_at > APPROVED_STUCK_AFTER
        )


@dataclass(frozen=True)
class PublishedPointer:
    """``PUBLISHED#<id>``: what the provisioner deployed last (only it can write this item)."""

    version: int
    content_hash: str
    harness_arn: str
    harness_version: str


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: int) -> dict[str, str]:
    return {"N": str(value)}


def _opt_s(item: dict[str, Any], name: str) -> str | None:
    value: str | None = item.get(name, {}).get("S")
    return value


def _opt_n(item: dict[str, Any], name: str) -> int | None:
    value = item.get(name, {}).get("N")
    return int(value) if value is not None else None


def _opt_time(item: dict[str, Any], name: str) -> datetime | None:
    value = _opt_s(item, name)
    return datetime.fromisoformat(value) if value else None


def _meta_from(item: dict[str, Any]) -> AgentMeta:
    return AgentMeta(
        agent_id=item["agent_id"]["S"],
        status=AgentStatus(item["status"]["S"]),
        version=int(item["version"]["N"]),
        latest_version=int(item["latest_version"]["N"]),
        open_version=_opt_n(item, "open_version"),
        published_version=_opt_n(item, "published_version"),
        created_by=item["created_by"]["S"],
        created_at=datetime.fromisoformat(item["created_at"]["S"]),
        harness_arn=_opt_s(item, "harness_arn"),
        harness_version=_opt_s(item, "harness_version"),
        retired_by=_opt_s(item, "retired_by"),
        retired_at=_opt_time(item, "retired_at"),
        retire_reason=_opt_s(item, "retire_reason"),
        retired_by_email=_opt_s(item, "retired_by_email"),
    )


def _version_from(item: dict[str, Any]) -> AgentVersion:
    canonical = item["definition"]["S"]
    return AgentVersion(
        agent_id=item["agent_id"]["S"],
        number=int(item["n"]["N"]),
        status=VersionStatus(item["status"]["S"]),
        revision=int(item["revision"]["N"]),
        definition=loads_definition(canonical),
        canonical=canonical,
        content_hash=_opt_s(item, "content_hash"),
        base_version=_opt_n(item, "base_version"),
        created_by=item["created_by"]["S"],
        created_by_email=_opt_s(item, "created_by_email"),
        created_at=datetime.fromisoformat(item["created_at"]["S"]),
        updated_at=datetime.fromisoformat(item["updated_at"]["S"]),
        editors=frozenset(item.get("editors", {}).get("SS", [])),
        submitted_by=_opt_s(item, "submitted_by"),
        submitted_at=_opt_time(item, "submitted_at"),
        approved_by=_opt_s(item, "approved_by"),
        approved_at=_opt_time(item, "approved_at"),
        rejected_by=_opt_s(item, "rejected_by"),
        rejected_at=_opt_time(item, "rejected_at"),
        rejection_reason=_opt_s(item, "rejection_reason"),
        failed_step=_opt_s(item, "failed_step"),
        failure=_opt_s(item, "failure"),
        published_at=_opt_time(item, "published_at"),
        status_at=_opt_time(item, "status_at"),
        approved_by_email=_opt_s(item, "approved_by_email"),
        rejected_by_email=_opt_s(item, "rejected_by_email"),
    )


def _reason(value: str) -> str:
    """Reasons are shown to other users and audited: bounded here as well as in the API."""
    if not 0 < len(value) <= MAX_REASON_CHARS:
        raise ValueError(f"reason must have 1 to {MAX_REASON_CHARS} characters")
    return value


def _cancel_reasons(exc: ClientError) -> list[str] | None:
    """Per-item cancellation codes of a failed transaction, or ``None`` for other errors."""
    if exc.response.get("Error", {}).get("Code") != "TransactionCanceledException":
        return None
    return [str(r.get("Code")) for r in exc.response.get("CancellationReasons", [])]


def _raise_conflict(exc: ClientError) -> None:
    """Failed conditions and concurrent writers are conflicts; anything else raises."""
    if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
        raise AgentConflictError("agent changed") from exc
    reasons = _cancel_reasons(exc)
    if reasons is not None and set(reasons) <= _CONFLICT_REASONS:
        raise AgentConflictError("agent changed") from exc
    raise exc


class AgentsStore:
    def __init__(self, dynamodb: DynamoDBClient, table: str) -> None:
        self._db = dynamodb
        self._table = table

    def _transact(self, items: Any) -> None:
        self._db.transact_write_items(TransactItems=items)

    # --- Reads ----------------------------------------------------------------------------

    def meta(self, agent_id: str) -> AgentMeta | None:
        if not is_agent_id(agent_id):
            return None
        item = self._db.get_item(
            TableName=self._table, Key=meta_key(agent_id), ConsistentRead=True
        ).get("Item")
        return _meta_from(item) if item else None

    def version(self, agent_id: str, number: int) -> AgentVersion | None:
        if not is_agent_id(agent_id) or not 1 <= number <= MAX_VERSION:
            return None
        item = self._db.get_item(
            TableName=self._table, Key=version_key(agent_id, number), ConsistentRead=True
        ).get("Item")
        return _version_from(item) if item else None

    def published_pointer(self, agent_id: str) -> PublishedPointer | None:
        """What is live for an agent, from the partition only the provisioner writes (D40).

        Whoever serves an agent reads the version from here and checks its content against
        this hash: nothing mango-api itself writes can change what is served (TM-M2).
        """
        if not is_agent_id(agent_id):
            return None
        item = self._db.get_item(
            TableName=self._table, Key=published_key(agent_id), ConsistentRead=True
        ).get("Item")
        if not item:
            return None
        return PublishedPointer(
            version=int(item["n"]["N"]),
            content_hash=item["content_hash"]["S"],
            harness_arn=item["harness_arn"]["S"],
            harness_version=item["harness_version"]["S"],
        )

    def _require(self, agent_id: str, number: int) -> AgentVersion:
        found = self.version(agent_id, number)
        if found is None:
            raise AgentNotFoundError("version not found")
        return found

    def _query(self, **kwargs: Any) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        pages = self._db.get_paginator("query").paginate(TableName=self._table, **kwargs)
        for page_number, page in enumerate(pages):
            if page_number >= MAX_PAGES:
                break
            items.extend(page.get("Items", []))
        return items

    def versions(self, agent_id: str) -> list[AgentVersion]:
        """Every version of an agent, oldest first."""
        if not is_agent_id(agent_id):
            return []
        items = self._query(
            KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
            ExpressionAttributeValues={
                ":pk": _s(agent_pk(agent_id)),
                ":prefix": _s(VERSION_PREFIX),
            },
            ConsistentRead=True,
        )
        return [_version_from(item) for item in items]

    def by_status(self, status: VersionStatus) -> list[AgentVersion]:
        """Versions in an indexed status (review queue, marketplace), oldest first."""
        items = self._query(
            IndexName=INDEX_BY_STATUS,
            KeyConditionExpression="status_index = :idx",
            ExpressionAttributeValues={":idx": _s(status_index(status))},
        )
        return [_version_from(item) for item in items]

    def rejected(self) -> list[AgentVersion]:
        """Drafts a reviewer sent back and their author has not sent again, oldest first."""
        items = self._query(
            IndexName=INDEX_BY_STATUS,
            KeyConditionExpression="status_index = :idx",
            ExpressionAttributeValues={":idx": _s(REJECTED_INDEX)},
        )
        return [_version_from(item) for item in items]

    def by_creator(self, user_id: str) -> list[AgentVersion]:
        """Versions created by a user, newest first."""
        items = self._query(
            IndexName=INDEX_BY_CREATOR,
            KeyConditionExpression="creator_index = :creator",
            ExpressionAttributeValues={":creator": _s(creator_pk(user_id))},
            ScanIndexForward=False,
        )
        return [_version_from(item) for item in items]

    def draft_count(self, user_id: str) -> int:
        total = 0
        pages = self._db.get_paginator("query").paginate(
            TableName=self._table,
            IndexName=INDEX_BY_CREATOR,
            KeyConditionExpression="creator_index = :creator",
            FilterExpression="#s = :draft",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":creator": _s(creator_pk(user_id)),
                ":draft": _s(VersionStatus.DRAFT),
            },
            Select="COUNT",
        )
        for page_number, page in enumerate(pages):
            if page_number >= MAX_PAGES:
                break
            total += int(page.get("Count", 0))
        return total

    def submissions_today(self, user_id: str, now: datetime) -> int:
        item = self._db.get_item(
            TableName=self._table,
            Key={"PK": _s(creator_pk(user_id)), "SK": _s(day_sk(now.astimezone(UTC).date()))},
            ConsistentRead=True,
        ).get("Item")
        return int(item["submissions"]["N"]) if item else 0

    def supervisor_of(self, agent_id: str) -> str | None:
        """``reports_to`` of a published agent (``agent_rules.OrgChart``); else ``None``."""
        meta = self.meta(agent_id)
        if meta is None or meta.status is not AgentStatus.PUBLISHED or not meta.published_version:
            return None
        published = self.version(agent_id, meta.published_version)
        if published is None:
            return None
        return published.definition.reports_to or ROOT_SUPERVISOR

    # --- Drafts ---------------------------------------------------------------------------

    def _check_draft_quota(self, actor: str) -> None:
        if self.draft_count(actor) >= MAX_DRAFTS:
            raise DraftLimitError("too many drafts")

    def _draft_item(
        self,
        agent_id: str,
        number: int,
        definition: AgentDefinition,
        *,
        actor: str,
        actor_email: str | None,
        now: datetime,
        base_version: int | None,
    ) -> dict[str, Any]:
        at = _s(iso(now))
        item: dict[str, Any] = {
            **version_key(agent_id, number),
            "agent_id": _s(agent_id),
            "n": _n(number),
            "status": _s(VersionStatus.DRAFT),
            "revision": _n(1),
            "definition": _s(dumps_definition(definition)),
            "created_by": _s(actor),
            "created_at": at,
            "updated_at": at,
            "editors": {"SS": [actor]},
            "creator_index": _s(creator_pk(actor)),
        }
        if actor_email:
            item["created_by_email"] = _s(actor_email)
        if base_version is not None:
            item["base_version"] = _n(base_version)
        return item

    def create_agent(
        self,
        definition: AgentDefinition,
        *,
        actor: str,
        actor_email: str | None,
        now: datetime,
        agent_id: str | None = None,
    ) -> AgentVersion:
        """Create an agent with its first draft. ``agent_id`` is only given for release agents."""
        self._check_draft_quota(actor)
        new_id = agent_id or new_agent_id()
        if not is_agent_id(new_id):
            raise ValueError("invalid agent id")
        at = _s(iso(now))
        absent = "attribute_not_exists(PK)"
        meta: dict[str, Any] = {
            **meta_key(new_id),
            "agent_id": _s(new_id),
            "status": _s(AgentStatus.DRAFT),
            "version": _n(1),
            "latest_version": _n(1),
            "open_version": _n(1),
            "created_by": _s(actor),
            "created_at": at,
            "updated_at": at,
        }
        draft = self._draft_item(
            new_id, 1, definition, actor=actor, actor_email=actor_email, now=now, base_version=None
        )
        try:
            self._transact(
                [
                    {
                        "Put": {
                            "TableName": self._table,
                            "Item": meta,
                            "ConditionExpression": absent,
                        }
                    },
                    {
                        "Put": {
                            "TableName": self._table,
                            "Item": draft,
                            "ConditionExpression": absent,
                        }
                    },
                ]
            )
        except ClientError as exc:
            _raise_conflict(exc)
        return _version_from(draft)

    def create_version(
        self,
        agent_id: str,
        definition: AgentDefinition,
        *,
        actor: str,
        actor_email: str | None,
        now: datetime,
    ) -> AgentVersion:
        """Open a new draft on a published agent; the published version keeps serving."""
        self._check_draft_quota(actor)
        meta = self.meta(agent_id)
        if meta is None:
            raise AgentNotFoundError("agent not found")
        if meta.status is not AgentStatus.PUBLISHED or meta.open_version is not None:
            raise AgentConflictError("agent is not published or already has an open version")
        number = meta.latest_version + 1
        draft = self._draft_item(
            agent_id,
            number,
            definition,
            actor=actor,
            actor_email=actor_email,
            now=now,
            base_version=meta.published_version,
        )
        try:
            self._transact(
                [
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": meta_key(agent_id),
                            "UpdateExpression": (
                                "SET latest_version = :n, open_version = :n, updated_at = :at "
                                "ADD version :one"
                            ),
                            "ConditionExpression": (
                                "#s = :published AND attribute_not_exists(open_version) "
                                "AND version = :lock"
                            ),
                            "ExpressionAttributeNames": {"#s": "status"},
                            "ExpressionAttributeValues": {
                                ":n": _n(number),
                                ":at": _s(iso(now)),
                                ":one": _n(1),
                                ":published": _s(AgentStatus.PUBLISHED),
                                ":lock": _n(meta.version),
                            },
                        }
                    },
                    {
                        "Put": {
                            "TableName": self._table,
                            "Item": draft,
                            "ConditionExpression": "attribute_not_exists(PK)",
                        }
                    },
                ]
            )
        except ClientError as exc:
            _raise_conflict(exc)
        return _version_from(draft)

    def save_draft(
        self,
        agent_id: str,
        number: int,
        *,
        revision: int,
        definition: AgentDefinition,
        actor: str,
        now: datetime,
    ) -> int:
        """Replace the content of a draft; returns the new revision."""
        try:
            self._db.update_item(
                TableName=self._table,
                Key=version_key(agent_id, number),
                UpdateExpression=(
                    "SET #d = :definition, revision = :new, updated_at = :at, "
                    "updated_by = :by ADD editors :editor"
                ),
                ConditionExpression="#s = :draft AND revision = :revision",
                ExpressionAttributeNames={"#s": "status", "#d": "definition"},
                ExpressionAttributeValues={
                    ":definition": _s(dumps_definition(definition)),
                    ":new": _n(revision + 1),
                    ":revision": _n(revision),
                    ":at": _s(iso(now)),
                    ":by": _s(actor),
                    ":editor": {"SS": [actor]},
                    ":draft": _s(VersionStatus.DRAFT),
                },
            )
        except ClientError as exc:
            _raise_conflict(exc)
        return revision + 1

    def discard_draft(self, agent_id: str, number: int, *, revision: int, now: datetime) -> None:
        """Delete a draft. An agent that was never published disappears with its only draft."""
        meta = self.meta(agent_id)
        if meta is None:
            raise AgentNotFoundError("agent not found")
        delete_draft: dict[str, Any] = {
            "Delete": {
                "TableName": self._table,
                "Key": version_key(agent_id, number),
                "ConditionExpression": "#s = :draft AND revision = :revision",
                "ExpressionAttributeNames": {"#s": "status"},
                "ExpressionAttributeValues": {
                    ":draft": _s(VersionStatus.DRAFT),
                    ":revision": _n(revision),
                },
            }
        }
        values = {":n": _n(number), ":lock": _n(meta.version)}
        release_meta: dict[str, Any]
        if meta.published_version is None:
            release_meta = {
                "Delete": {
                    "TableName": self._table,
                    "Key": meta_key(agent_id),
                    "ConditionExpression": (
                        "attribute_not_exists(published_version) AND open_version = :n "
                        "AND version = :lock"
                    ),
                    "ExpressionAttributeValues": values,
                }
            }
        else:
            release_meta = {
                "Update": {
                    "TableName": self._table,
                    "Key": meta_key(agent_id),
                    "UpdateExpression": "SET updated_at = :at ADD version :one REMOVE open_version",
                    "ConditionExpression": "open_version = :n AND version = :lock",
                    "ExpressionAttributeValues": {
                        **values,
                        ":at": _s(iso(now)),
                        ":one": _n(1),
                    },
                }
            }
        try:
            self._transact([delete_draft, release_meta])
        except ClientError as exc:
            _raise_conflict(exc)

    # --- Review ---------------------------------------------------------------------------

    def _agent_not_retired(self, agent_id: str) -> dict[str, Any]:
        return {
            "ConditionCheck": {
                "TableName": self._table,
                "Key": meta_key(agent_id),
                "ConditionExpression": "attribute_exists(PK) AND #s <> :retired",
                "ExpressionAttributeNames": {"#s": "status"},
                "ExpressionAttributeValues": {":retired": _s(AgentStatus.RETIRED)},
            }
        }

    def submit(
        self, agent_id: str, number: int, *, revision: int, actor: str, now: datetime
    ) -> AgentVersion:
        """Freeze draft ``revision`` and send it to review.

        The caller validates that same revision with ``agent_rules.validate_for_review`` first;
        the condition on ``revision`` guarantees the frozen content is the validated one.
        """
        draft = self._require(agent_id, number)
        if draft.status is not VersionStatus.DRAFT or draft.revision != revision:
            raise AgentConflictError("draft changed")
        digest = hash_content(draft.canonical)
        at = _s(iso(now))
        day = now.astimezone(UTC).date()
        expires = datetime.combine(day, time.max, tzinfo=UTC) + COUNTER_RETENTION
        items: list[dict[str, Any]] = [
            {
                "Update": {
                    "TableName": self._table,
                    "Key": version_key(agent_id, number),
                    "UpdateExpression": (
                        "SET #s = :review, content_hash = :hash, submitted_by = :by, "
                        "submitted_at = :at, updated_at = :at, status_index = :idx, "
                        "status_at = :at ADD editors :editor "
                        "REMOVE rejected_by, rejected_by_email, rejected_at, rejection_reason, "
                        "failed_step, failure"
                    ),
                    # The definition is compared too: the hash covers exactly what is stored.
                    "ConditionExpression": (
                        "#s = :draft AND revision = :revision AND #d = :definition"
                    ),
                    "ExpressionAttributeNames": {"#s": "status", "#d": "definition"},
                    "ExpressionAttributeValues": {
                        ":review": _s(VersionStatus.IN_REVIEW),
                        ":draft": _s(VersionStatus.DRAFT),
                        ":revision": _n(revision),
                        ":definition": _s(draft.canonical),
                        ":hash": _s(digest),
                        ":by": _s(actor),
                        ":editor": {"SS": [actor]},
                        ":at": at,
                        ":idx": _s(status_index(VersionStatus.IN_REVIEW)),
                    },
                }
            },
            {
                "Update": {
                    "TableName": self._table,
                    "Key": {"PK": _s(creator_pk(actor)), "SK": _s(day_sk(day))},
                    "UpdateExpression": "SET #ttl = :ttl ADD submissions :one",
                    "ConditionExpression": (
                        "attribute_not_exists(submissions) OR submissions < :max"
                    ),
                    "ExpressionAttributeNames": {"#ttl": "ttl"},
                    "ExpressionAttributeValues": {
                        ":one": _n(1),
                        ":max": _n(MAX_SUBMISSIONS_PER_DAY),
                        ":ttl": _n(int(expires.timestamp())),
                    },
                }
            },
            self._agent_not_retired(agent_id),
        ]
        try:
            self._transact(items)
        except ClientError as exc:
            # Only the counter's condition failed: the creator is over today's quota.
            if _cancel_reasons(exc) == ["None", _CONDITION_FAILED, "None"]:
                raise SubmissionLimitError("daily submission limit reached") from exc
            _raise_conflict(exc)
        return self._require(agent_id, number)

    def approve(
        self,
        agent_id: str,
        number: int,
        *,
        content_hash: str,
        approver: str,
        now: datetime,
        approver_email: str | None = None,
    ) -> None:
        """Approve the content the approver saw (``content_hash``); never by one of its authors."""
        current = self._require(agent_id, number)
        if current.status is not VersionStatus.IN_REVIEW or current.content_hash != content_hash:
            raise AgentConflictError("version changed")
        if approver in current.editors or approver == current.created_by:
            raise SelfApprovalError("the author of a version cannot approve it")
        at = _s(iso(now))
        items: list[dict[str, Any]] = [
            {
                "Update": {
                    "TableName": self._table,
                    "Key": version_key(agent_id, number),
                    "UpdateExpression": (
                        "SET #s = :approved, approved_by = :by, approved_at = :at, "
                        "updated_at = :at, status_index = :idx, status_at = :at"
                        + (", approved_by_email = :email" if approver_email else "")
                    ),
                    # The conditions close the race with a concurrent edit or self-approval.
                    "ConditionExpression": (
                        "#s = :review AND content_hash = :hash AND created_by <> :by "
                        "AND NOT contains(editors, :by)"
                    ),
                    "ExpressionAttributeNames": {"#s": "status"},
                    "ExpressionAttributeValues": {
                        ":approved": _s(VersionStatus.APPROVED),
                        ":review": _s(VersionStatus.IN_REVIEW),
                        ":hash": _s(content_hash),
                        ":by": _s(approver),
                        ":at": at,
                        ":idx": _s(status_index(VersionStatus.APPROVED)),
                        **({":email": _s(approver_email)} if approver_email else {}),
                    },
                }
            },
            self._agent_not_retired(agent_id),
        ]
        try:
            self._transact(items)
        except ClientError as exc:
            _raise_conflict(exc)

    def _back_to_draft(
        self,
        agent_id: str,
        number: int,
        *,
        from_status: VersionStatus,
        extra_set: str,
        values: dict[str, Any],
        now: datetime,
        indexed: bool = False,
    ) -> None:
        """``indexed`` keeps the draft in ``ByStatus`` (the caller sets ``status_index``)."""
        removed = "content_hash, approved_by, approved_by_email, approved_at"
        if not indexed:
            removed += ", status_index, status_at"
        try:
            self._db.update_item(
                TableName=self._table,
                Key=version_key(agent_id, number),
                UpdateExpression=(
                    f"SET #s = :draft, updated_at = :at{extra_set} ADD revision :one "
                    f"REMOVE {removed}"
                ),
                ConditionExpression="#s = :from",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":draft": _s(VersionStatus.DRAFT),
                    ":from": _s(from_status),
                    ":at": _s(iso(now)),
                    ":one": _n(1),
                    **values,
                },
            )
        except ClientError as exc:
            _raise_conflict(exc)

    def reject(
        self,
        agent_id: str,
        number: int,
        *,
        rejected_by: str,
        reason: str,
        now: datetime,
        rejected_by_email: str | None = None,
    ) -> None:
        """Send a version in review back to draft with the reviewer's reason.

        The draft stays in ``ByStatus`` as rejected, so the review history shows it until its
        author sends it again or discards it.
        """
        self._back_to_draft(
            agent_id,
            number,
            from_status=VersionStatus.IN_REVIEW,
            extra_set=(
                ", rejected_by = :by, rejected_at = :at, rejection_reason = :reason, "
                "status_index = :idx, status_at = :at"
                + (", rejected_by_email = :email" if rejected_by_email else "")
            ),
            values={
                ":by": _s(rejected_by),
                ":reason": _s(_reason(reason)),
                ":idx": _s(REJECTED_INDEX),
                **({":email": _s(rejected_by_email)} if rejected_by_email else {}),
            },
            now=now,
            indexed=True,
        )

    def reopen_failed(self, agent_id: str, number: int, *, now: datetime) -> None:
        """A version whose publication failed goes back to draft; the failed step is kept."""
        self._back_to_draft(
            agent_id, number, from_status=VersionStatus.FAILED, extra_set="", values={}, now=now
        )

    def retry_failed(self, agent_id: str, number: int, *, content_hash: str, now: datetime) -> None:
        """Queue a failed publication again: same approved content, same approver."""
        at = _s(iso(now))
        items: list[dict[str, Any]] = [
            {
                "Update": {
                    "TableName": self._table,
                    "Key": version_key(agent_id, number),
                    "UpdateExpression": (
                        "SET #s = :approved, updated_at = :at, status_index = :idx, status_at = :at"
                    ),
                    "ConditionExpression": "#s = :failed AND content_hash = :hash",
                    "ExpressionAttributeNames": {"#s": "status"},
                    "ExpressionAttributeValues": {
                        ":approved": _s(VersionStatus.APPROVED),
                        ":failed": _s(VersionStatus.FAILED),
                        ":hash": _s(content_hash),
                        ":at": at,
                        ":idx": _s(status_index(VersionStatus.APPROVED)),
                    },
                }
            },
            self._agent_not_retired(agent_id),
        ]
        try:
            self._transact(items)
        except ClientError as exc:
            _raise_conflict(exc)

    def expire_approved(
        self, agent_id: str, number: int, *, content_hash: str, now: datetime
    ) -> None:
        """Give up on an approved version nothing is publishing any more (it becomes ``failed``).

        The provisioner stops at 25 minutes and its lock expires at 30: after
        ``APPROVED_STUCK_AFTER`` no execution can still publish this version, so marking it
        failed cannot race with one. The condition re-checks the age and the content.
        """
        update = fail_item(
            self._table,
            agent_id=agent_id,
            version=number,
            failed_step=EXPIRED_STEP,
            failure="execution_expired",
            now=now,
        )
        update["ConditionExpression"] += " AND content_hash = :hash AND status_at < :cutoff"
        update["ExpressionAttributeValues"] |= {
            ":hash": _s(content_hash),
            ":cutoff": _s(iso(now - APPROVED_STUCK_AFTER)),
        }
        try:
            self._db.update_item(**update)
        except ClientError as exc:
            _raise_conflict(exc)

    def fail_start(self, agent_id: str, number: int, *, now: datetime) -> None:
        """An approved version whose provisioner execution could not be started.

        Same transition the provisioner uses for its own failures (``fail_item``), so an
        administrator can retry it instead of leaving it ``approved`` with nothing running.
        """
        try:
            self._db.update_item(
                **fail_item(
                    self._table,
                    agent_id=agent_id,
                    version=number,
                    failed_step=START_STEP,
                    failure="execution_not_started",
                    now=now,
                )
            )
        except ClientError as exc:
            _raise_conflict(exc)

    # --- Retirement -----------------------------------------------------------------------

    def retire(
        self,
        agent_id: str,
        *,
        version: int,
        actor: str,
        reason: str,
        now: datetime,
        actor_email: str | None = None,
    ) -> None:
        """Take a published agent out of the marketplace; its history stays (D22)."""
        meta = self.meta(agent_id)
        if meta is None:
            raise AgentNotFoundError("agent not found")
        if meta.status is not AgentStatus.PUBLISHED or meta.published_version is None:
            raise AgentConflictError("agent is not published")
        at = _s(iso(now))
        items: list[dict[str, Any]] = [
            {
                "Update": {
                    "TableName": self._table,
                    "Key": meta_key(agent_id),
                    "UpdateExpression": (
                        "SET #s = :retired, retired_by = :by, retired_at = :at, "
                        "retire_reason = :reason, updated_at = :at"
                        + (", retired_by_email = :email" if actor_email else "")
                        + " ADD version :one"
                    ),
                    "ConditionExpression": (
                        "#s = :published AND version = :lock AND published_version = :n"
                    ),
                    "ExpressionAttributeNames": {"#s": "status"},
                    "ExpressionAttributeValues": {
                        ":retired": _s(AgentStatus.RETIRED),
                        ":published": _s(AgentStatus.PUBLISHED),
                        ":lock": _n(version),
                        ":n": _n(meta.published_version),
                        ":by": _s(actor),
                        ":reason": _s(_reason(reason)),
                        ":at": at,
                        ":one": _n(1),
                        **({":email": _s(actor_email)} if actor_email else {}),
                    },
                }
            },
            {
                "Update": {
                    "TableName": self._table,
                    "Key": version_key(agent_id, meta.published_version),
                    "UpdateExpression": "SET #s = :retired, status_index = :idx, status_at = :at",
                    "ConditionExpression": "#s = :published",
                    "ExpressionAttributeNames": {"#s": "status"},
                    "ExpressionAttributeValues": {
                        ":retired": _s(VersionStatus.RETIRED),
                        ":published": _s(VersionStatus.PUBLISHED),
                        ":idx": _s(status_index(VersionStatus.RETIRED)),
                        ":at": at,
                    },
                }
            },
        ]
        try:
            self._transact(items)
        except ClientError as exc:
            _raise_conflict(exc)
