"""Knowledge table repository (D88 (8), (21)): the registry of the knowledge bases.

Item layout, all under ``PK = KB#<kb id>`` (a ULID, ``mango_core.knowledge``):

* ``SK = META``: the knowledge base. ``owner_id`` is the verified subject of whoever created
  it and never changes; ``groups`` are the groups it answers to (D88 (22)); ``business_unit``
  its area or ``all``, fixed when it is created; ``status`` and the counters of its documents.
  ``version`` grows with every change: an edit names the version it read.
* ``SK = UPLOAD#<upload id>``: a presigned upload (D88 (9)): who asked for it, the files it
  announced (name, size, type, by document id) and the ones already saved (``saved``). It
  expires with the objects of ``uploads/`` (``expires_at``, the table's TTL).
* ``SK = DOC#<doc id>``: a saved document. Its key derives from the ids only
  (``kb/<kb id>/docs/<doc id>``); the name is what is shown, never part of a key. ``status``
  ``uploaded`` until the synchronization indexes it (D88 (8)), and ``reason`` when it fails.
* ``SK = SYNC#<sync id>``: one synchronization, written by ``functions/knowledge-sync``.
  On the knowledge base, ``sync_id`` is the one running (mango-api claims it before starting
  the state machine) and ``sync_again`` who asked for one more meanwhile; ``deleting_since``
  is when the oldest pending deletion was asked for (the alarm of D88 (16)).
* ``SK = SRC#<source id>``: a source on an existing bucket of the installation's account
  (D88 (10)): its bucket and prefix, which never change (another bucket or prefix is another
  proposal, D88 (20)), who proposed it and who decided. While it is ``pending`` it is also in
  the index ``All`` under ``all_pk`` = ``SRC_PENDING``: the administrators' list to sign.

The counters of a knowledge base (``documents``, ``bytes``) grow in the same transaction as
the documents they count, so the limits of D88 (9) hold whoever saves at the same time.

Index ``All`` (``all_pk`` = ``KB``, ``created_at``) lists every knowledge base. Keep in sync
with ``infra/lib/constructs/knowledge.ts``. Deleting is a status (``deleting``): the item stays
until the synchronization verified that no vector is left (D88 (16)); mango-api never deletes
an item.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from botocore.exceptions import ClientError

from mango_core.knowledge import MAX_BYTES, MAX_DOCUMENTS, DocumentStatus, SourceStatus, Status

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

INDEX_ALL = "All"
SK_META = "META"
ALL_PK = "KB"
PENDING_SOURCES_PK = "SRC_PENDING"
"""``all_pk`` of the sources waiting for a decision (the index ``All``)."""
MAX_LISTED = 1000
"""Knowledge bases a list reads at most: far above what an installation holds."""
_PAGE = 100


class KnowledgeConflictError(Exception):
    """The knowledge base changed (another version) or is being deleted."""


class KnowledgeStoreUnavailableError(Exception):
    """The table could not be read or written; callers fail closed."""


@dataclass(frozen=True)
class KnowledgeBase:
    kb_id: str
    name: str
    description: str
    owner_id: str
    owner_email: str | None
    owner_name: str | None
    business_unit: str
    groups: tuple[str, ...]
    classification: str
    sync_schedule: str
    status: Status
    documents: int
    bytes: int
    version: int
    created_at: str
    updated_at: str
    sync_running: bool = False


@dataclass(frozen=True)
class AnnouncedFile:
    name: str
    size: int
    content_type: str


@dataclass(frozen=True)
class Upload:
    kb_id: str
    upload_id: str
    owner_id: str
    files: dict[str, AnnouncedFile]
    """By document id."""
    saved: frozenset[str]
    expires_at: int


@dataclass(frozen=True)
class Document:
    kb_id: str
    doc_id: str
    name: str
    size: int
    content_type: str
    sha256: str
    status: DocumentStatus
    reason: str | None
    uploaded_by: str
    created_at: str


@dataclass(frozen=True)
class Source:
    """A source on an existing bucket (D88 (10))."""

    kb_id: str
    src_id: str
    bucket: str
    prefix: str
    status: SourceStatus
    proposed_by: str
    proposed_by_email: str | None
    proposed_at: str
    version: int
    decided_by: str | None = None
    decided_at: str | None = None
    removed_by: str | None = None
    role_arn: str | None = None
    """``Mango-<ns>-kbsrc-<source id>``, once ``Mango-<ns>-KnowledgeSources`` created it."""


class KnowledgeLimitError(Exception):
    """The documents would pass the limits of the knowledge base (D88 (9))."""


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: int) -> dict[str, str]:
    return {"N": str(value)}


def _pk(kb_id: str) -> str:
    return f"KB#{kb_id}"


def _str(item: dict[str, Any], name: str) -> str | None:
    value = item.get(name)
    return value["S"] if value and "S" in value else None


def _int(item: dict[str, Any], name: str) -> int:
    value = item.get(name)
    return int(value["N"]) if value and "N" in value else 0


def _knowledge_base(item: dict[str, Any]) -> KnowledgeBase:
    return KnowledgeBase(
        kb_id=item["kb_id"]["S"],
        name=item["name"]["S"],
        description=_str(item, "description") or "",
        owner_id=item["owner_id"]["S"],
        owner_email=_str(item, "owner_email"),
        owner_name=_str(item, "owner_name"),
        business_unit=item["business_unit"]["S"],
        groups=tuple(sorted(item.get("groups", {}).get("SS", []))),
        classification=item["classification"]["S"],
        sync_schedule=item["sync_schedule"]["S"],
        status=Status(item["status"]["S"]),
        documents=_int(item, "documents"),
        bytes=_int(item, "bytes"),
        version=_int(item, "version"),
        created_at=item["created_at"]["S"],
        updated_at=item["updated_at"]["S"],
        sync_running="sync_id" in item,
    )


def _conditional(exc: ClientError) -> bool:
    return exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException"


def _source(item: dict[str, Any]) -> Source:
    return Source(
        kb_id=item["kb_id"]["S"],
        src_id=item["src_id"]["S"],
        bucket=item["bucket"]["S"],
        prefix=_str(item, "prefix") or "",
        status=SourceStatus(item["status"]["S"]),
        proposed_by=item["proposed_by"]["S"],
        proposed_by_email=_str(item, "proposed_by_email"),
        proposed_at=item["proposed_at"]["S"],
        version=_int(item, "version"),
        decided_by=_str(item, "decided_by"),
        decided_at=_str(item, "decided_at"),
        removed_by=_str(item, "removed_by"),
        role_arn=_str(item, "role_arn"),
    )


def _upload(item: dict[str, Any]) -> Upload:
    raw: dict[str, dict[str, Any]] = json.loads(item["files"]["S"])
    return Upload(
        kb_id=item["kb_id"]["S"],
        upload_id=item["upload_id"]["S"],
        owner_id=item["owner_id"]["S"],
        files={
            doc_id: AnnouncedFile(f["name"], int(f["size"]), f["content_type"])
            for doc_id, f in raw.items()
        },
        saved=frozenset(item.get("saved", {}).get("SS", [])),
        expires_at=_int(item, "expires_at"),
    )


def _document(item: dict[str, Any]) -> Document:
    return Document(
        kb_id=item["kb_id"]["S"],
        doc_id=item["doc_id"]["S"],
        name=item["name"]["S"],
        size=_int(item, "size"),
        content_type=item["content_type"]["S"],
        sha256=_str(item, "sha256") or "",
        status=DocumentStatus(item["status"]["S"]),
        reason=_str(item, "reason"),
        uploaded_by=item["uploaded_by"]["S"],
        created_at=item["created_at"]["S"],
    )


class KnowledgeStore:
    def __init__(self, dynamodb: DynamoDBClient, table: str) -> None:
        self._db = dynamodb
        self._table = table

    def create(self, kb: KnowledgeBase) -> None:
        item: dict[str, Any] = {
            "PK": _s(_pk(kb.kb_id)),
            "SK": _s(SK_META),
            "all_pk": _s(ALL_PK),
            "kb_id": _s(kb.kb_id),
            "name": _s(kb.name),
            "owner_id": _s(kb.owner_id),
            "business_unit": _s(kb.business_unit),
            # A knowledge base always has at least one group (``knowledge.KnowledgeBaseIn``).
            "groups": {"SS": sorted(kb.groups)},
            "classification": _s(kb.classification),
            "sync_schedule": _s(kb.sync_schedule),
            "status": _s(kb.status),
            "documents": _n(kb.documents),
            "bytes": _n(kb.bytes),
            "version": _n(kb.version),
            "created_at": _s(kb.created_at),
            "updated_at": _s(kb.updated_at),
        }
        for name, value in (
            ("description", kb.description),
            ("owner_email", kb.owner_email),
            ("owner_name", kb.owner_name),
        ):
            if value:
                item[name] = _s(value)
        try:
            self._db.put_item(
                TableName=self._table, Item=item, ConditionExpression="attribute_not_exists(PK)"
            )
        except ClientError as exc:
            if _conditional(exc):
                raise KnowledgeConflictError from exc
            raise KnowledgeStoreUnavailableError from exc

    def get(self, kb_id: str) -> KnowledgeBase | None:
        try:
            resp = self._db.get_item(
                TableName=self._table,
                Key={"PK": _s(_pk(kb_id)), "SK": _s(SK_META)},
                ConsistentRead=True,
            )
        except ClientError as exc:
            raise KnowledgeStoreUnavailableError from exc
        item = resp.get("Item")
        return _knowledge_base(item) if item else None

    def everything(self) -> list[KnowledgeBase]:
        """Every knowledge base of the installation, newest first."""
        out: list[KnowledgeBase] = []
        start: dict[str, Any] | None = None
        try:
            while len(out) < MAX_LISTED:
                request: dict[str, Any] = {
                    "TableName": self._table,
                    "IndexName": INDEX_ALL,
                    "KeyConditionExpression": "all_pk = :a",
                    "ExpressionAttributeValues": {":a": _s(ALL_PK)},
                    "ScanIndexForward": False,
                    "Limit": _PAGE,
                }
                if start:
                    request["ExclusiveStartKey"] = start
                page = self._db.query(**request)
                out.extend(_knowledge_base(item) for item in page.get("Items", []))
                start = page.get("LastEvaluatedKey")
                if not start:
                    break
        except ClientError as exc:
            raise KnowledgeStoreUnavailableError from exc
        return out[:MAX_LISTED]

    def update(self, kb: KnowledgeBase, changes: dict[str, Any], *, now: str) -> KnowledgeBase:
        """Set fields of ``kb`` if nobody changed it since (its ``version``) and it is not
        being deleted. Strings, and ``groups`` as a set; nothing else is accepted."""
        names = {"#version": "version", "#status": "status", "#updated_at": "updated_at"}
        values: dict[str, Any] = {
            ":expected": _n(kb.version),
            ":next": _n(kb.version + 1),
            ":deleting": _s(Status.DELETING),
            ":now": _s(now),
        }
        sets = ["#version = :next", "#updated_at = :now"]
        removes: list[str] = []
        for index, (name, value) in enumerate(sorted(changes.items())):
            names[f"#f{index}"] = name
            if name == "groups":
                values[f":v{index}"] = {"SS": sorted(value)}
            elif isinstance(value, str) and value == "" and name == "description":
                removes.append(f"#f{index}")
                continue
            elif isinstance(value, str):
                values[f":v{index}"] = _s(value)
            else:
                raise TypeError(f"unsupported value for {name}")
            sets.append(f"#f{index} = :v{index}")
        expression = "SET " + ", ".join(sets) + (" REMOVE " + ", ".join(removes) if removes else "")
        try:
            resp = self._db.update_item(
                TableName=self._table,
                Key={"PK": _s(_pk(kb.kb_id)), "SK": _s(SK_META)},
                UpdateExpression=expression,
                ConditionExpression=(
                    "attribute_exists(PK) AND #version = :expected AND #status <> :deleting"
                ),
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
                ReturnValues="ALL_NEW",
            )
        except ClientError as exc:
            if _conditional(exc):
                raise KnowledgeConflictError from exc
            raise KnowledgeStoreUnavailableError from exc
        return _knowledge_base(resp["Attributes"])

    # --- Uploads and documents (D88 (9)) ---------------------------------------------------

    def put_upload(self, upload: Upload, *, now: str) -> None:
        files = {
            doc_id: {"name": f.name, "size": f.size, "content_type": f.content_type}
            for doc_id, f in upload.files.items()
        }
        try:
            self._db.put_item(
                TableName=self._table,
                Item={
                    "PK": _s(_pk(upload.kb_id)),
                    "SK": _s(f"UPLOAD#{upload.upload_id}"),
                    "kb_id": _s(upload.kb_id),
                    "upload_id": _s(upload.upload_id),
                    "owner_id": _s(upload.owner_id),
                    "files": _s(json.dumps(files, sort_keys=True, separators=(",", ":"))),
                    "expires_at": _n(upload.expires_at),
                    "created_at": _s(now),
                },
                ConditionExpression="attribute_not_exists(PK)",
            )
        except ClientError as exc:
            raise KnowledgeStoreUnavailableError from exc

    def upload(self, kb_id: str, upload_id: str) -> Upload | None:
        try:
            resp = self._db.get_item(
                TableName=self._table,
                Key={"PK": _s(_pk(kb_id)), "SK": _s(f"UPLOAD#{upload_id}")},
                ConsistentRead=True,
            )
        except ClientError as exc:
            raise KnowledgeStoreUnavailableError from exc
        item = resp.get("Item")
        return _upload(item) if item else None

    def save_documents(self, kb: KnowledgeBase, upload: Upload, documents: list[Document]) -> None:
        """Record ``documents`` of ``upload``, once each, and count them in the knowledge base,
        all or nothing: within its limits, while it is not being deleted."""
        count, size = len(documents), sum(d.size for d in documents)
        pk = _s(_pk(kb.kb_id))
        counters: dict[str, Any] = {
            "Update": {
                "TableName": self._table,
                "Key": {"PK": pk, "SK": _s(SK_META)},
                "UpdateExpression": "ADD documents :n, #bytes :b",
                "ConditionExpression": (
                    "attribute_exists(PK) AND #status <> :deleting"
                    " AND documents <= :max_documents AND #bytes <= :max_bytes"
                ),
                "ExpressionAttributeNames": {"#status": "status", "#bytes": "bytes"},
                "ExpressionAttributeValues": {
                    ":n": _n(count),
                    ":b": _n(size),
                    ":deleting": _s(Status.DELETING),
                    ":max_documents": _n(MAX_DOCUMENTS - count),
                    ":max_bytes": _n(MAX_BYTES - size),
                },
            }
        }
        ids = [d.doc_id for d in documents]
        not_saved = " AND ".join(f"NOT contains(#saved, :d{i})" for i in range(len(ids)))
        values: dict[str, Any] = {f":d{i}": _s(doc_id) for i, doc_id in enumerate(ids)}
        values[":ids"] = {"SS": ids}
        mark: dict[str, Any] = {
            "Update": {
                "TableName": self._table,
                "Key": {"PK": pk, "SK": _s(f"UPLOAD#{upload.upload_id}")},
                "UpdateExpression": "ADD #saved :ids",
                "ConditionExpression": (
                    f"attribute_exists(PK) AND (attribute_not_exists(#saved) OR ({not_saved}))"
                ),
                "ExpressionAttributeNames": {"#saved": "saved"},
                "ExpressionAttributeValues": values,
            }
        }
        puts: list[Any] = [
            {
                "Put": {
                    "TableName": self._table,
                    "Item": {
                        "PK": pk,
                        "SK": _s(f"DOC#{d.doc_id}"),
                        "kb_id": _s(d.kb_id),
                        "doc_id": _s(d.doc_id),
                        "name": _s(d.name),
                        "size": _n(d.size),
                        "content_type": _s(d.content_type),
                        "status": _s(d.status),
                        "uploaded_by": _s(d.uploaded_by),
                        "created_at": _s(d.created_at),
                    },
                    "ConditionExpression": "attribute_not_exists(PK)",
                }
            }
            for d in documents
        ]
        try:
            items: list[Any] = [counters, mark, *puts]
            self._db.transact_write_items(TransactItems=items)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "TransactionCanceledException":
                reasons = exc.response.get("CancellationReasons", [])
                first = reasons[0].get("Code") if reasons else None
                if first == "ConditionalCheckFailed":
                    raise KnowledgeLimitError from exc
                raise KnowledgeConflictError from exc
            raise KnowledgeStoreUnavailableError from exc

    def stored(self, kb_id: str, doc_id: str, *, sha256: str | None, reason: str | None) -> None:
        """After the copy: its SHA-256, or ``failed`` with ``reason`` if it could not be made."""
        key = {"PK": _s(_pk(kb_id)), "SK": _s(f"DOC#{doc_id}")}
        try:
            if reason is None:
                self._db.update_item(
                    TableName=self._table,
                    Key=key,
                    UpdateExpression="SET sha256 = :h",
                    ConditionExpression="attribute_exists(PK)",
                    ExpressionAttributeValues={":h": _s(sha256 or "")},
                )
            else:
                self._db.update_item(
                    TableName=self._table,
                    Key=key,
                    UpdateExpression="SET #status = :failed, reason = :r",
                    ConditionExpression="attribute_exists(PK)",
                    ExpressionAttributeNames={"#status": "status"},
                    ExpressionAttributeValues={
                        ":failed": _s(DocumentStatus.FAILED),
                        ":r": _s(reason),
                    },
                )
        except ClientError as exc:
            raise KnowledgeStoreUnavailableError from exc

    def documents(self, kb_id: str) -> list[Document]:
        out: list[Document] = []
        start: dict[str, Any] | None = None
        try:
            while len(out) <= MAX_DOCUMENTS:
                request: dict[str, Any] = {
                    "TableName": self._table,
                    "KeyConditionExpression": "PK = :pk AND begins_with(SK, :doc)",
                    "ExpressionAttributeValues": {":pk": _s(_pk(kb_id)), ":doc": _s("DOC#")},
                    "ConsistentRead": True,
                }
                if start:
                    request["ExclusiveStartKey"] = start
                page = self._db.query(**request)
                out.extend(_document(item) for item in page.get("Items", []))
                start = page.get("LastEvaluatedKey")
                if not start:
                    break
        except ClientError as exc:
            raise KnowledgeStoreUnavailableError from exc
        return out

    # --- Synchronizations (D88 (11)) ------------------------------------------------------

    def claim_sync(self, kb_id: str, sync_id: str, requester: str, *, now: str) -> bool:
        """``True`` if this synchronization holds the knowledge base and may start; ``False``
        if another runs, which then starts one more for ``requester`` when it ends."""
        key = {"PK": _s(_pk(kb_id)), "SK": _s(SK_META)}
        for _attempt in range(2):
            try:
                self._db.update_item(
                    TableName=self._table,
                    Key=key,
                    UpdateExpression="SET sync_id = :id, sync_requested_at = :now",
                    ConditionExpression="attribute_exists(PK) AND attribute_not_exists(sync_id)",
                    ExpressionAttributeValues={":id": _s(sync_id), ":now": _s(now)},
                )
            except ClientError as exc:
                if not _conditional(exc):
                    raise KnowledgeStoreUnavailableError from exc
            else:
                return True
            try:
                self._db.update_item(
                    TableName=self._table,
                    Key=key,
                    UpdateExpression="SET sync_again = :r",
                    ConditionExpression="attribute_exists(sync_id)",
                    ExpressionAttributeValues={":r": _s(requester)},
                )
            except ClientError as exc:
                if not _conditional(exc):
                    raise KnowledgeStoreUnavailableError from exc
                continue  # It ended in between: claim it again.
            return False
        raise KnowledgeConflictError

    def drop_sync(self, kb_id: str, sync_id: str) -> None:
        """A claim whose state machine could not start."""
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": _s(_pk(kb_id)), "SK": _s(SK_META)},
                UpdateExpression="REMOVE sync_id, sync_requested_at",
                ConditionExpression="sync_id = :me",
                ExpressionAttributeValues={":me": _s(sync_id)},
            )
        except ClientError as exc:
            if not _conditional(exc):
                raise KnowledgeStoreUnavailableError from exc

    def document(self, kb_id: str, doc_id: str) -> Document | None:
        try:
            resp = self._db.get_item(
                TableName=self._table,
                Key={"PK": _s(_pk(kb_id)), "SK": _s(f"DOC#{doc_id}")},
                ConsistentRead=True,
            )
        except ClientError as exc:
            raise KnowledgeStoreUnavailableError from exc
        item = resp.get("Item")
        return _document(item) if item else None

    def delete_document(self, kb_id: str, doc_id: str, *, now: str) -> None:
        """Mark a document ``deleting`` (the synchronization deletes and verifies it), and
        when the oldest pending deletion of the knowledge base was asked for."""
        items: list[Any] = [
            {
                "Update": {
                    "TableName": self._table,
                    "Key": {"PK": _s(_pk(kb_id)), "SK": _s(f"DOC#{doc_id}")},
                    "UpdateExpression": "SET #status = :deleting",
                    "ConditionExpression": "attribute_exists(PK) AND #status <> :deleting",
                    "ExpressionAttributeNames": {"#status": "status"},
                    "ExpressionAttributeValues": {":deleting": _s(DocumentStatus.DELETING)},
                }
            },
            {
                "Update": {
                    "TableName": self._table,
                    "Key": {"PK": _s(_pk(kb_id)), "SK": _s(SK_META)},
                    "UpdateExpression": "SET deleting_since = if_not_exists(deleting_since, :now)",
                    "ConditionExpression": "attribute_exists(PK)",
                    "ExpressionAttributeValues": {":now": _s(now)},
                }
            },
        ]
        try:
            self._db.transact_write_items(TransactItems=items)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "TransactionCanceledException":
                raise KnowledgeConflictError from exc
            raise KnowledgeStoreUnavailableError from exc

    # --- Sources on existing buckets (D88 (10), (20)) ---------------------------------------

    def put_source(self, source: Source) -> None:
        """A new proposal, ``pending``; the knowledge base must exist and not be deleted."""
        item: dict[str, Any] = {
            "PK": _s(_pk(source.kb_id)),
            "SK": _s(f"SRC#{source.src_id}"),
            "all_pk": _s(PENDING_SOURCES_PK),
            "created_at": _s(source.proposed_at),
            "kb_id": _s(source.kb_id),
            "src_id": _s(source.src_id),
            "bucket": _s(source.bucket),
            "status": _s(source.status),
            "proposed_by": _s(source.proposed_by),
            "proposed_at": _s(source.proposed_at),
            "version": _n(source.version),
        }
        if source.prefix:
            item["prefix"] = _s(source.prefix)
        if source.proposed_by_email:
            item["proposed_by_email"] = _s(source.proposed_by_email)
        pk = _s(_pk(source.kb_id))
        try:
            self._db.transact_write_items(
                TransactItems=[
                    {
                        "ConditionCheck": {
                            "TableName": self._table,
                            "Key": {"PK": pk, "SK": _s(SK_META)},
                            "ConditionExpression": "attribute_exists(PK) AND #status <> :deleting",
                            "ExpressionAttributeNames": {"#status": "status"},
                            "ExpressionAttributeValues": {":deleting": _s(Status.DELETING)},
                        }
                    },
                    {
                        "Put": {
                            "TableName": self._table,
                            "Item": item,
                            "ConditionExpression": "attribute_not_exists(PK)",
                        }
                    },
                ]
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "TransactionCanceledException":
                raise KnowledgeConflictError from exc
            raise KnowledgeStoreUnavailableError from exc

    def sources(self, kb_id: str) -> list[Source]:
        """Every source of a knowledge base, oldest first (a few: ``MAX_SOURCES`` active)."""
        out: list[Source] = []
        start: dict[str, Any] | None = None
        try:
            while True:
                request: dict[str, Any] = {
                    "TableName": self._table,
                    "KeyConditionExpression": "PK = :pk AND begins_with(SK, :src)",
                    "ExpressionAttributeValues": {":pk": _s(_pk(kb_id)), ":src": _s("SRC#")},
                    "ConsistentRead": True,
                }
                if start:
                    request["ExclusiveStartKey"] = start
                page = self._db.query(**request)
                out.extend(_source(item) for item in page.get("Items", []))
                start = page.get("LastEvaluatedKey")
                if not start or len(out) >= MAX_LISTED:
                    break
        except ClientError as exc:
            raise KnowledgeStoreUnavailableError from exc
        return out

    def source(self, kb_id: str, src_id: str) -> Source | None:
        try:
            resp = self._db.get_item(
                TableName=self._table,
                Key={"PK": _s(_pk(kb_id)), "SK": _s(f"SRC#{src_id}")},
                ConsistentRead=True,
            )
        except ClientError as exc:
            raise KnowledgeStoreUnavailableError from exc
        item = resp.get("Item")
        return _source(item) if item else None

    def pending_sources(self) -> list[Source]:
        """Sources waiting for a decision, in every knowledge base, oldest first."""
        out: list[Source] = []
        start: dict[str, Any] | None = None
        try:
            while len(out) < MAX_LISTED:
                request: dict[str, Any] = {
                    "TableName": self._table,
                    "IndexName": INDEX_ALL,
                    "KeyConditionExpression": "all_pk = :a",
                    "ExpressionAttributeValues": {":a": _s(PENDING_SOURCES_PK)},
                    "Limit": _PAGE,
                }
                if start:
                    request["ExclusiveStartKey"] = start
                page = self._db.query(**request)
                out.extend(_source(item) for item in page.get("Items", []))
                start = page.get("LastEvaluatedKey")
                if not start:
                    break
        except ClientError as exc:
            raise KnowledgeStoreUnavailableError from exc
        return out[:MAX_LISTED]

    def set_source_status(
        self,
        source: Source,
        status: SourceStatus,
        *,
        by: str,
        now: str,
        not_proposed_by: str | None = None,
    ) -> Source:
        """Move ``source`` from the status it was read in to ``status``, if nobody changed it
        since (its ``version``). ``not_proposed_by``: the change must not be made by whoever
        proposed it (D88 (20)), checked by the table too. Leaving ``pending`` takes it out of
        the administrators' list."""
        names = {"#version": "version", "#status": "status"}
        values: dict[str, Any] = {
            ":expected": _n(source.version),
            ":next": _n(source.version + 1),
            ":from": _s(source.status),
            ":to": _s(status),
            ":by": _s(by),
            ":now": _s(now),
        }
        condition = "attribute_exists(PK) AND #version = :expected AND #status = :from"
        if not_proposed_by is not None:
            names["#proposed_by"] = "proposed_by"
            values[":me"] = _s(not_proposed_by)
            condition += " AND #proposed_by <> :me"
        # Approving or rejecting is a decision; withdrawing or removing keeps who decided.
        decided = status in (SourceStatus.APPROVED, SourceStatus.REJECTED)
        names["#by"], names["#at"] = (
            ("decided_by", "decided_at") if decided else ("removed_by", "removed_at")
        )
        expression = "SET #status = :to, #version = :next, #by = :by, #at = :now REMOVE all_pk"
        try:
            resp = self._db.update_item(
                TableName=self._table,
                Key={"PK": _s(_pk(source.kb_id)), "SK": _s(f"SRC#{source.src_id}")},
                UpdateExpression=expression,
                ConditionExpression=condition,
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
                ReturnValues="ALL_NEW",
            )
        except ClientError as exc:
            if _conditional(exc):
                raise KnowledgeConflictError from exc
            raise KnowledgeStoreUnavailableError from exc
        return _source(resp["Attributes"])
