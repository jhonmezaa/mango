"""Skills table and bucket (D92; threat model ``skills-threat-model.md``).

Item layout in the Skills table (``PK`` / ``SK``), which only mango-api writes:

* ``CATALOG`` / ``<skill id>``: the skill as the catalog lists it: its approved version
  (``version``, 0 while none is approved), what that version says in one line (name, category,
  description, MCP servers), owner, last change, and the open request of the skill, if any
  (``pending``, ``pending_expires_at``): one at a time.
* ``SKILL#<skill id>`` / ``V#<version, 4 digits>``: one approved version, immutable: its content
  as canonical JSON, the SHA-256 of its ``SKILL.md`` and who proposed and approved it.
* ``CHANGES`` / ``<change id>``: a proposed version and its decision. Kept 90 days (TTL).
* ``RUNS#<day>`` / ``<skill id>``: activations of the skill that day (D92 (8)). Kept 31 days.

The ``SKILL.md`` of an approved version is written once to the skills bucket, before the table
says it is approved, and never again (``If-None-Match``): an agent that names the version can
always fetch it.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal

from botocore.exceptions import ClientError
from pydantic import ValidationError

from mango_core.skills import InvalidSkillError, SkillContent, object_key, render, skill_ref

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient
    from mypy_boto3_dynamodb.type_defs import TransactWriteItemTypeDef
    from mypy_boto3_s3 import S3Client

PK_CATALOG = "CATALOG"
PK_CHANGES = "CHANGES"
CHANGE_RETENTION = timedelta(days=90)
RUNS_RETENTION = timedelta(days=31)
RUN_DAYS = 30
MAX_PAGES = 20
ChangeStatus = Literal["pending", "approved", "rejected", "withdrawn"]


class ConflictError(Exception):
    """A condition failed: someone else changed the skill or the request first."""


class StoredSkillError(Exception):
    """A stored item does not satisfy the schema; readers fail closed."""


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _when(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: int) -> dict[str, str]:
    return {"N": str(value)}


def _opt(item: dict[str, Any], key: str) -> str | None:
    value = item.get(key, {}).get("S")
    return value if isinstance(value, str) else None


def new_change_id() -> str:
    """Random public id (never incremental)."""
    return secrets.token_hex(16)


def dumps_content(content: SkillContent) -> str:
    return json.dumps(
        content.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )


def loads_content(raw: str) -> SkillContent:
    try:
        return SkillContent.model_validate_json(raw)
    except ValidationError as exc:
        # The error detail may quote the stored text: keep only the count.
        raise StoredSkillError(f"invalid skill ({exc.error_count()} errors)") from None


def markdown_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _version_sk(version: int) -> str:
    return f"V#{version:04d}"


@dataclass(frozen=True)
class SkillMeta:
    skill_id: str
    version: int
    """Approved version; 0 while none is."""
    name: str
    category: str
    description: str
    servers: tuple[str, ...]
    owner: str | None
    owner_email: str | None
    updated_by: str | None
    updated_by_email: str | None
    updated_at: datetime | None
    pending: str | None
    pending_expires_at: datetime | None

    def locked(self, now: datetime) -> bool:
        return self.pending is not None and (
            self.pending_expires_at is None or self.pending_expires_at > now
        )


@dataclass(frozen=True)
class SkillVersion:
    skill_id: str
    version: int
    content: SkillContent
    markdown_sha256: str
    proposed_by: str
    proposed_by_email: str | None
    approved_by: str
    approved_by_email: str | None
    approved_at: datetime
    change_id: str

    @property
    def ref(self) -> str:
        return skill_ref(self.skill_id, self.version)


@dataclass(frozen=True)
class SkillChange:
    change_id: str
    skill_id: str
    version: int
    """The version it would become (1 for a new skill)."""
    content: SkillContent
    status: ChangeStatus
    proposed_by: str
    proposed_by_email: str | None
    reason: str
    created_at: datetime
    expires_at: datetime
    duplicate_of: str | None = None
    """``<id>@<version>`` it was duplicated from («Duplicar como instrucciones»)."""
    decided_by: str | None = None
    decided_by_email: str | None = None
    decided_at: datetime | None = None
    note: str | None = None

    @property
    def is_new(self) -> bool:
        return self.version == 1


def _meta_from(item: dict[str, Any]) -> SkillMeta:
    try:
        servers = json.loads(_opt(item, "servers") or "[]")
        if not isinstance(servers, list) or not all(isinstance(s, str) for s in servers):
            raise StoredSkillError("invalid servers")
        updated_at = _opt(item, "updated_at")
        expires = _opt(item, "pending_expires_at")
        return SkillMeta(
            skill_id=item["SK"]["S"],
            version=int(item["version"]["N"]),
            name=_opt(item, "name") or "",
            category=_opt(item, "category") or "",
            description=_opt(item, "description") or "",
            servers=tuple(servers),
            owner=_opt(item, "owner"),
            owner_email=_opt(item, "owner_email"),
            updated_by=_opt(item, "updated_by"),
            updated_by_email=_opt(item, "updated_by_email"),
            updated_at=_when(updated_at) if updated_at else None,
            pending=_opt(item, "pending"),
            pending_expires_at=_when(expires) if expires else None,
        )
    except (KeyError, ValueError) as exc:
        raise StoredSkillError("invalid catalog item") from exc


def _version_from(item: dict[str, Any]) -> SkillVersion:
    try:
        return SkillVersion(
            skill_id=item["PK"]["S"].removeprefix("SKILL#"),
            version=int(item["SK"]["S"].removeprefix("V#")),
            content=loads_content(item["content"]["S"]),
            markdown_sha256=item["markdown_sha256"]["S"],
            proposed_by=item["proposed_by"]["S"],
            proposed_by_email=_opt(item, "proposed_by_email"),
            approved_by=item["approved_by"]["S"],
            approved_by_email=_opt(item, "approved_by_email"),
            approved_at=_when(item["approved_at"]["S"]),
            change_id=item["change_id"]["S"],
        )
    except (KeyError, ValueError) as exc:
        raise StoredSkillError("invalid version item") from exc


def _change_from(item: dict[str, Any]) -> SkillChange:
    try:
        decided_at = _opt(item, "decided_at")
        return SkillChange(
            change_id=item["SK"]["S"],
            skill_id=item["skill_id"]["S"],
            version=int(item["version"]["N"]),
            content=loads_content(item["content"]["S"]),
            status=item["status"]["S"],
            proposed_by=item["proposed_by"]["S"],
            proposed_by_email=_opt(item, "proposed_by_email"),
            reason=item["reason"]["S"],
            created_at=_when(item["created_at"]["S"]),
            expires_at=_when(item["expires_at"]["S"]),
            duplicate_of=_opt(item, "duplicate_of"),
            decided_by=_opt(item, "decided_by"),
            decided_by_email=_opt(item, "decided_by_email"),
            decided_at=_when(decided_at) if decided_at else None,
            note=_opt(item, "note"),
        )
    except (KeyError, ValueError) as exc:
        raise StoredSkillError("invalid change item") from exc


def _conflict(exc: ClientError) -> None:
    code = exc.response.get("Error", {}).get("Code")
    if code in ("ConditionalCheckFailedException", "TransactionCanceledException"):
        raise ConflictError(code) from exc
    raise exc


class SkillStore:
    """Skills of the installation (D92). Only mango-api writes the table and the bucket."""

    def __init__(
        self, dynamodb: DynamoDBClient, table: str, s3: S3Client | None, bucket: str
    ) -> None:
        self._db = dynamodb
        self._table = table
        self._s3 = s3
        self._bucket = bucket

    def _query(self, pk: str, prefix: str | None = None) -> list[dict[str, Any]]:
        condition = "PK = :pk" + (" AND begins_with(SK, :sk)" if prefix else "")
        values: dict[str, Any] = {":pk": _s(pk)}
        if prefix:
            values[":sk"] = _s(prefix)
        items: list[dict[str, Any]] = []
        pages = self._db.get_paginator("query").paginate(
            TableName=self._table,
            KeyConditionExpression=condition,
            ExpressionAttributeValues=values,
            ConsistentRead=True,
        )
        for page_number, page in enumerate(pages):
            if page_number >= MAX_PAGES:  # hard stop on a runaway partition
                break
            items.extend(page.get("Items", []))
        return items

    def _get(self, pk: str, sk: str) -> dict[str, Any] | None:
        item: dict[str, Any] | None = self._db.get_item(
            TableName=self._table, Key={"PK": _s(pk), "SK": _s(sk)}, ConsistentRead=True
        ).get("Item")
        return item

    # --- Reads ----------------------------------------------------------------------------

    def catalog(self) -> list[SkillMeta]:
        return sorted(
            (_meta_from(item) for item in self._query(PK_CATALOG)), key=lambda m: m.skill_id
        )

    def meta(self, skill_id: str) -> SkillMeta | None:
        item = self._get(PK_CATALOG, skill_id)
        return _meta_from(item) if item else None

    def version(self, skill_id: str, version: int) -> SkillVersion | None:
        item = self._get(f"SKILL#{skill_id}", _version_sk(version))
        return _version_from(item) if item else None

    def versions(self, skill_id: str) -> list[SkillVersion]:
        items = self._query(f"SKILL#{skill_id}", "V#")
        return sorted((_version_from(i) for i in items), key=lambda v: v.version)

    def approved(self, refs: dict[str, tuple[str, int]]) -> dict[str, SkillVersion]:
        """The approved versions among ``refs`` (``ref -> (id, version)``), by ref."""
        found: dict[str, SkillVersion] = {}
        for ref, (skill_id, number) in refs.items():
            stored = self.version(skill_id, number)
            if stored is not None:
                found[ref] = stored
        return found

    def change(self, change_id: str) -> SkillChange | None:
        item = self._get(PK_CHANGES, change_id)
        return _change_from(item) if item else None

    def changes(self) -> list[SkillChange]:
        return sorted(
            (_change_from(item) for item in self._query(PK_CHANGES)),
            key=lambda c: c.created_at,
            reverse=True,
        )

    def runs(self, now: datetime) -> dict[str, int]:
        """Activations of each skill in the last ``RUN_DAYS`` days."""
        totals: dict[str, int] = {}
        for days_ago in range(RUN_DAYS):
            day = (now - timedelta(days=days_ago)).date().isoformat()
            for item in self._query(f"RUNS#{day}"):
                skill_id = item["SK"]["S"]
                totals[skill_id] = totals.get(skill_id, 0) + int(item.get("n", {}).get("N", "0"))
        return totals

    # --- Writes ---------------------------------------------------------------------------

    def propose(self, change: SkillChange, *, base_version: int, now: datetime) -> None:
        """Store the request and take the skill's lock, in one transaction.

        A new skill (``version == 1``) creates its catalog item, or takes over the one a
        request that was never approved left behind. A new version needs the skill to still be
        at ``base_version``. Either way an open, unexpired request blocks.
        """
        content = change.content
        item: dict[str, Any] = {
            "PK": _s(PK_CHANGES),
            "SK": _s(change.change_id),
            "skill_id": _s(change.skill_id),
            "version": _n(change.version),
            "content": _s(dumps_content(content)),
            "status": _s("pending"),
            "proposed_by": _s(change.proposed_by),
            "reason": _s(change.reason),
            "created_at": _s(iso(change.created_at)),
            "expires_at": _s(iso(change.expires_at)),
            "ttl": _n(int((now + CHANGE_RETENTION).timestamp())),
        }
        if change.proposed_by_email:
            item["proposed_by_email"] = _s(change.proposed_by_email)
        if change.duplicate_of:
            item["duplicate_of"] = _s(change.duplicate_of)
        lock_values = {
            ":id": _s(change.change_id),
            ":exp": _s(iso(change.expires_at)),
            ":now": _s(iso(now)),
            ":base": _n(base_version),
        }
        free = "(attribute_not_exists(pending) OR pending_expires_at < :now)"
        if change.is_new:
            lock: TransactWriteItemTypeDef = {
                "Update": {
                    "TableName": self._table,
                    "Key": {"PK": _s(PK_CATALOG), "SK": _s(change.skill_id)},
                    "UpdateExpression": (
                        "SET pending = :id, pending_expires_at = :exp, "
                        "version = if_not_exists(version, :base)"
                    ),
                    "ConditionExpression": (
                        f"attribute_not_exists(PK) OR (version = :base AND {free})"
                    ),
                    "ExpressionAttributeValues": lock_values,
                }
            }
        else:
            lock = {
                "Update": {
                    "TableName": self._table,
                    "Key": {"PK": _s(PK_CATALOG), "SK": _s(change.skill_id)},
                    "UpdateExpression": "SET pending = :id, pending_expires_at = :exp",
                    "ConditionExpression": f"version = :base AND {free}",
                    "ExpressionAttributeValues": lock_values,
                }
            }
        try:
            self._db.transact_write_items(
                TransactItems=[
                    {
                        "Put": {
                            "TableName": self._table,
                            "Item": item,
                            "ConditionExpression": "attribute_not_exists(PK)",
                        }
                    },
                    lock,
                ]
            )
        except ClientError as exc:
            _conflict(exc)

    def _write_markdown(self, change: SkillChange) -> str:
        """The ``SKILL.md`` of the version, written once. Returns its SHA-256.

        A retry of an approval that wrote the object and then lost the table write finds the
        same bytes there. Different bytes are a conflict when the table has the version
        approved, and are replaced when it does not (nothing can name them).
        """
        if self._s3 is None:
            raise ConflictError("no skills bucket")
        try:
            text = render(change.skill_id, change.version, change.content)
        except InvalidSkillError as exc:
            raise StoredSkillError("invalid skill") from exc
        digest = markdown_hash(text)
        key = object_key(change.skill_id, change.version)
        try:
            self._s3.put_object(
                Bucket=self._bucket,
                Key=key,
                Body=text.encode("utf-8"),
                ContentType="text/markdown; charset=utf-8",
                IfNoneMatch="*",
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") not in (
                "PreconditionFailed",
                "ConditionalRequestConflict",
            ):
                raise
            existing = self._s3.get_object(Bucket=self._bucket, Key=key)["Body"].read()
            if hashlib.sha256(existing).hexdigest() == digest:
                return digest
            if self.version(change.skill_id, change.version) is not None:
                # An approved version is never rewritten: agents may name it.
                raise ConflictError("another SKILL.md exists for this version") from exc
            # Left by an approval that lost its transaction (a rejection or a withdrawal won
            # the race): no approved version and so no agent names it, and keeping it would
            # block this version number for good.
            self._s3.put_object(
                Bucket=self._bucket,
                Key=key,
                Body=text.encode("utf-8"),
                ContentType="text/markdown; charset=utf-8",
            )
        return digest

    def approve(
        self, change: SkillChange, *, approver: str, approver_email: str | None, now: datetime
    ) -> SkillVersion:
        """Write the ``SKILL.md``, then apply the request in one transaction: the request is
        still open and unexpired and was proposed by someone else, and the skill is still at
        the version before it."""
        digest = self._write_markdown(change)
        content = change.content
        stamp = {
            ":by": _s(approver),
            ":at": _s(iso(now)),
        }
        version_item: dict[str, Any] = {
            "PK": _s(f"SKILL#{change.skill_id}"),
            "SK": _s(_version_sk(change.version)),
            "content": _s(dumps_content(content)),
            "markdown_sha256": _s(digest),
            "proposed_by": _s(change.proposed_by),
            "approved_by": _s(approver),
            "approved_at": _s(iso(now)),
            "change_id": _s(change.change_id),
        }
        if change.proposed_by_email:
            version_item["proposed_by_email"] = _s(change.proposed_by_email)
        if approver_email:
            version_item["approved_by_email"] = _s(approver_email)
        decided = "SET #s = :approved, decided_by = :by, decided_at = :at"
        decided_values: dict[str, Any] = {
            **stamp,
            ":approved": _s("approved"),
            ":pending": _s("pending"),
        }
        if approver_email:
            decided += ", decided_by_email = :email"
            decided_values[":email"] = _s(approver_email)
        catalog_set = (
            "SET version = :v, #name = :name, category = :cat, description = :desc, "
            "servers = :servers, updated_by = :by, updated_at = :at"
        )
        catalog_values: dict[str, Any] = {
            **stamp,
            ":v": _n(change.version),
            ":base": _n(change.version - 1),
            ":id": _s(change.change_id),
            ":name": _s(content.name),
            ":cat": _s(content.category),
            ":desc": _s(content.description),
            ":servers": _s(json.dumps(list(content.servers))),
        }
        if approver_email:
            catalog_set += ", updated_by_email = :email"
            catalog_values[":email"] = _s(approver_email)
        else:
            catalog_set += " REMOVE updated_by_email"
        if change.is_new:
            catalog_set = catalog_set.replace("SET ", "SET #owner = :owner, ", 1)
            catalog_values[":owner"] = _s(change.proposed_by)
            if change.proposed_by_email:
                catalog_set = catalog_set.replace("SET ", "SET owner_email = :owner_email, ", 1)
                catalog_values[":owner_email"] = _s(change.proposed_by_email)
        catalog_set += (", " if " REMOVE " in catalog_set else " REMOVE ") + (
            "pending, pending_expires_at"
        )
        try:
            self._db.transact_write_items(
                TransactItems=[
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": {"PK": _s(PK_CHANGES), "SK": _s(change.change_id)},
                            "UpdateExpression": decided,
                            "ConditionExpression": (
                                "#s = :pending AND proposed_by <> :by AND expires_at > :at"
                            ),
                            "ExpressionAttributeNames": {"#s": "status"},
                            "ExpressionAttributeValues": decided_values,
                        }
                    },
                    {
                        "Put": {
                            "TableName": self._table,
                            "Item": version_item,
                            "ConditionExpression": "attribute_not_exists(PK)",
                        }
                    },
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": {"PK": _s(PK_CATALOG), "SK": _s(change.skill_id)},
                            "UpdateExpression": catalog_set,
                            "ConditionExpression": "version = :base AND pending = :id",
                            "ExpressionAttributeNames": {
                                "#name": "name",
                                **({"#owner": "owner"} if change.is_new else {}),
                            },
                            "ExpressionAttributeValues": catalog_values,
                        }
                    },
                ]
            )
        except ClientError as exc:
            _conflict(exc)
        return SkillVersion(
            skill_id=change.skill_id,
            version=change.version,
            content=content,
            markdown_sha256=digest,
            proposed_by=change.proposed_by,
            proposed_by_email=change.proposed_by_email,
            approved_by=approver,
            approved_by_email=approver_email,
            approved_at=now,
            change_id=change.change_id,
        )

    def close(
        self,
        change: SkillChange,
        *,
        to: Literal["rejected", "withdrawn"],
        actor: str,
        actor_email: str | None,
        note: str | None,
        now: datetime,
    ) -> None:
        """Reject or withdraw an open request and release the skill's lock."""
        update = "SET #s = :to, decided_by = :by, decided_at = :at"
        values: dict[str, Any] = {
            ":to": _s(to),
            ":pending": _s("pending"),
            ":by": _s(actor),
            ":at": _s(iso(now)),
        }
        if actor_email:
            update += ", decided_by_email = :email"
            values[":email"] = _s(actor_email)
        if note:
            update += ", note = :note"
            values[":note"] = _s(note)
        try:
            self._db.transact_write_items(
                TransactItems=[
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": {"PK": _s(PK_CHANGES), "SK": _s(change.change_id)},
                            "UpdateExpression": update,
                            "ConditionExpression": "#s = :pending",
                            "ExpressionAttributeNames": {"#s": "status"},
                            "ExpressionAttributeValues": values,
                        }
                    },
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": {"PK": _s(PK_CATALOG), "SK": _s(change.skill_id)},
                            "UpdateExpression": "REMOVE pending, pending_expires_at",
                            "ConditionExpression": "pending = :id",
                            "ExpressionAttributeValues": {":id": _s(change.change_id)},
                        }
                    },
                ]
            )
        except ClientError as exc:
            _conflict(exc)

    def count_run(self, skill_id: str, now: datetime) -> None:
        """One activation of the skill (D92 (8)): a counter per day, never what it was used for."""
        day = now.date().isoformat()
        self._db.update_item(
            TableName=self._table,
            Key={"PK": _s(f"RUNS#{day}"), "SK": _s(skill_id)},
            UpdateExpression="ADD n :one SET #ttl = if_not_exists(#ttl, :ttl)",
            ExpressionAttributeNames={"#ttl": "ttl"},
            ExpressionAttributeValues={
                ":one": _n(1),
                ":ttl": _n(int((now + RUNS_RETENTION).timestamp())),
            },
        )
