"""The Knowledge table as the synchronization reads and writes it (D88 (8), (11), (16)).

Layout (``mango_api.knowledge_store`` is the other writer, and documents it):

* ``KB#<kb id>`` / ``META``: what is synchronized, from the registry only (TM-K10): the area,
  the groups and the classification of every fragment. The synchronization sets ``status``,
  takes down the counters of what it deleted, and owns ``sync_id`` (the one running),
  ``sync_again`` (one more, asked for while it ran) and ``deleting_since``.
* ``KB#<kb id>`` / ``DOC#<doc id>``: a document and its status. One copied from a source also
  has ``src_id``, the key it has there (``source_key``) and the ETag it was copied at
  (``source_etag``): the next synchronization compares them with the bucket (D88 (19)).
* ``KB#<kb id>`` / ``SRC#<source id>``: a source on an existing bucket, written by mango-api
  (and its role's ARN by ``Mango-<ns>-KnowledgeSources``). The synchronization reads it, and
  deletes the record of a removed source once its documents and its role are gone.
* ``KB#<kb id>`` / ``SYNC#<sync id>``: one synchronization: who asked, what it reserved and
  charged, how many documents it ingested, indexed, failed and deleted.
* ``LOCK#<bedrock kb id>`` / ``LOCK``: one synchronization at a time per Bedrock knowledge
  base (D88 (11), the pattern of bedrock-chat), with an expiry so a dead one cannot hold it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from botocore.exceptions import ClientError

from mango_core.knowledge import (
    MAX_BYTES,
    MAX_DOCUMENTS,
    DocumentStatus,
    SourceStatus,
    Status,
)

INDEX_ALL = "All"
ALL_PK = "KB"
_PAGE = 100


class StoreUnavailableError(Exception):
    """The table could not be read or written; the step is retried."""


@dataclass(frozen=True)
class Requester:
    """Who asked for a synchronization and the monthly limit of their budget (D88 (24))."""

    user_id: str
    email: str | None
    limit: Decimal

    def as_json(self) -> dict[str, str]:
        return {"user_id": self.user_id, "email": self.email or "", "limit": str(self.limit)}

    @staticmethod
    def from_json(raw: dict[str, Any]) -> Requester:
        return Requester(
            str(raw["user_id"]), str(raw.get("email") or "") or None, Decimal(str(raw["limit"]))
        )


@dataclass(frozen=True)
class KnowledgeBaseRecord:
    kb_id: str
    business_unit: str
    groups: tuple[str, ...]
    classification: str
    status: Status
    sync_id: str | None
    sync_requested_at: str | None
    deleting_since: str | None
    owner_id: str = ""
    owner_email: str | None = None


@dataclass(frozen=True)
class DocumentRecord:
    doc_id: str
    size: int
    status: DocumentStatus
    src_id: str | None = None
    source_key: str | None = None
    source_etag: str | None = None


@dataclass(frozen=True)
class SourceRecord:
    src_id: str
    bucket: str
    prefix: str
    status: SourceStatus
    role_arn: str | None
    decided_at: str | None = None
    """When it was approved: its role was made then (D88 (39))."""


@dataclass(frozen=True)
class CopiedDocument:
    """A document copied from a source, ``uploaded`` (or ``failed`` with its reason)."""

    doc_id: str
    name: str
    size: int
    content_type: str
    status: DocumentStatus
    reason: str | None
    sha256: str
    src_id: str
    source_key: str
    source_etag: str
    uploaded_by: str
    created_at: str


class KnowledgeBaseFullError(Exception):
    """The document would pass the limits of the knowledge base (D88 (9))."""


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: int | Decimal) -> dict[str, str]:
    return {"N": str(value)}


def _pk(kb_id: str) -> dict[str, str]:
    return _s(f"KB#{kb_id}")


def _str(item: dict[str, Any], name: str) -> str | None:
    value = item.get(name)
    return value["S"] if value and "S" in value else None


def _conditional(exc: ClientError) -> bool:
    return exc.response.get("Error", {}).get("Code") in {
        "ConditionalCheckFailedException",
        "TransactionCanceledException",
    }


def _kb(item: dict[str, Any]) -> KnowledgeBaseRecord:
    return KnowledgeBaseRecord(
        kb_id=item["kb_id"]["S"],
        business_unit=item["business_unit"]["S"],
        groups=tuple(sorted(item.get("groups", {}).get("SS", []))),
        classification=item["classification"]["S"],
        status=Status(item["status"]["S"]),
        sync_id=_str(item, "sync_id"),
        sync_requested_at=_str(item, "sync_requested_at"),
        deleting_since=_str(item, "deleting_since"),
        owner_id=_str(item, "owner_id") or "",
        owner_email=_str(item, "owner_email"),
    )


class SyncStore:
    def __init__(self, dynamodb: Any, table: str) -> None:
        self._db = dynamodb
        self._table = table

    def _call(self, method: str, **request: Any) -> Any:
        try:
            return getattr(self._db, method)(TableName=self._table, **request)
        except ClientError as exc:
            if _conditional(exc):
                raise
            raise StoreUnavailableError(exc.response.get("Error", {}).get("Code")) from exc

    # --- Lock ----------------------------------------------------------------------------

    def acquire(self, lock: str, sync_id: str, *, now: int, ttl: int) -> bool:
        """Hold the lock of the Bedrock knowledge base for ``ttl`` seconds; ``False`` if
        another synchronization holds it."""
        try:
            self._call(
                "put_item",
                Item={
                    "PK": _s(f"LOCK#{lock}"),
                    "SK": _s("LOCK"),
                    "holder": _s(sync_id),
                    "expires_at": _n(now + ttl),
                },
                ConditionExpression="attribute_not_exists(PK) OR holder = :me OR expires_at < :now",
                ExpressionAttributeValues={":me": _s(sync_id), ":now": _n(now)},
            )
        except ClientError:
            return False
        return True

    def release(self, lock: str, sync_id: str) -> None:
        try:
            self._call(
                "delete_item",
                Key={"PK": _s(f"LOCK#{lock}"), "SK": _s("LOCK")},
                ConditionExpression="holder = :me",
                ExpressionAttributeValues={":me": _s(sync_id)},
            )
        except ClientError:
            return  # Not ours any more (it expired and another took it): nothing to release.

    # --- Knowledge bases and documents ---------------------------------------------------

    def knowledge_base(self, kb_id: str) -> KnowledgeBaseRecord | None:
        item = self._call(
            "get_item", Key={"PK": _pk(kb_id), "SK": _s("META")}, ConsistentRead=True
        ).get("Item")
        return _kb(item) if item else None

    def everything(self) -> list[KnowledgeBaseRecord]:
        out: list[KnowledgeBaseRecord] = []
        start: dict[str, Any] | None = None
        while True:
            request: dict[str, Any] = {
                "IndexName": INDEX_ALL,
                "KeyConditionExpression": "all_pk = :a",
                "ExpressionAttributeValues": {":a": _s(ALL_PK)},
                "Limit": _PAGE,
            }
            if start:
                request["ExclusiveStartKey"] = start
            page = self._call("query", **request)
            out.extend(_kb(item) for item in page.get("Items", []))
            start = page.get("LastEvaluatedKey")
            if not start:
                return out

    def _items(self, kb_id: str, prefix: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        start: dict[str, Any] | None = None
        while True:
            request: dict[str, Any] = {
                "KeyConditionExpression": "PK = :pk"
                + (" AND begins_with(SK, :p)" if prefix else ""),
                "ExpressionAttributeValues": {
                    ":pk": _pk(kb_id),
                    **({":p": _s(prefix)} if prefix else {}),
                },
                "ConsistentRead": True,
            }
            if start:
                request["ExclusiveStartKey"] = start
            page = self._call("query", **request)
            out.extend(page.get("Items", []))
            start = page.get("LastEvaluatedKey")
            if not start:
                return out

    def documents(self, kb_id: str) -> list[DocumentRecord]:
        return [
            DocumentRecord(
                item["doc_id"]["S"],
                int(item["size"]["N"]),
                DocumentStatus(item["status"]["S"]),
                src_id=_str(item, "src_id"),
                source_key=_str(item, "source_key"),
                source_etag=_str(item, "source_etag"),
            )
            for item in self._items(kb_id, "DOC#")
        ]

    # --- Sources (D88 (10), (19)) -----------------------------------------------------------

    def sources(self, kb_id: str) -> list[SourceRecord]:
        return [
            SourceRecord(
                src_id=item["src_id"]["S"],
                bucket=item["bucket"]["S"],
                prefix=_str(item, "prefix") or "",
                status=SourceStatus(item["status"]["S"]),
                role_arn=_str(item, "role_arn"),
                decided_at=_str(item, "decided_at"),
            )
            for item in self._items(kb_id, "SRC#")
        ]

    def add_copied(self, kb_id: str, document: CopiedDocument) -> None:
        """Record a copied document and count it, within the limits of the knowledge base and
        while it is not being deleted; raises ``KnowledgeBaseFullError`` past them."""
        item: dict[str, Any] = {
            "PK": _pk(kb_id),
            "SK": _s(f"DOC#{document.doc_id}"),
            "kb_id": _s(kb_id),
            "doc_id": _s(document.doc_id),
            "name": _s(document.name),
            "size": _n(document.size),
            "content_type": _s(document.content_type),
            "status": _s(document.status),
            "uploaded_by": _s(document.uploaded_by),
            "created_at": _s(document.created_at),
            "src_id": _s(document.src_id),
            "source_key": _s(document.source_key),
            "source_etag": _s(document.source_etag),
        }
        if document.sha256:
            item["sha256"] = _s(document.sha256)
        if document.reason:
            item["reason"] = _s(document.reason)
        try:
            self._call_transaction(
                [
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": {"PK": _pk(kb_id), "SK": _s("META")},
                            "UpdateExpression": "ADD documents :one, #bytes :size",
                            "ConditionExpression": (
                                "attribute_exists(PK) AND #status <> :deleting"
                                " AND documents <= :max_documents AND #bytes <= :max_bytes"
                            ),
                            "ExpressionAttributeNames": {"#status": "status", "#bytes": "bytes"},
                            "ExpressionAttributeValues": {
                                ":one": _n(1),
                                ":size": _n(document.size),
                                ":deleting": _s(Status.DELETING),
                                ":max_documents": _n(MAX_DOCUMENTS - 1),
                                ":max_bytes": _n(MAX_BYTES - document.size),
                            },
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
            raise KnowledgeBaseFullError from exc

    def remove_source(self, kb_id: str, src_id: str) -> None:
        """The record of a removed source, once nothing of it is left; the audit trail stays."""
        try:
            self._call(
                "delete_item",
                Key={"PK": _pk(kb_id), "SK": _s(f"SRC#{src_id}")},
                ConditionExpression="#status = :removing AND attribute_not_exists(role_arn)",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={":removing": _s(SourceStatus.REMOVING)},
            )
        except ClientError:
            return

    def set_status(
        self,
        kb_id: str,
        status: Status,
        *,
        attempted_at: str | None = None,
        synced_at: str | None = None,
        reason: str | None = None,
        estimate_usd: Decimal | None = None,
    ) -> None:
        """Of a knowledge base that is not being deleted: deleting is never undone here.

        When a synchronization closes (``attempted_at``), also what the screen says of it
        (D88 (43)): when it last tried, when it last finished, and why it did not, if so
        (``reason``; ``budget`` with the estimate of its embeddings). A closing without a
        reason clears the one before."""
        names = {"#status": "status"}
        values: dict[str, Any] = {":s": _s(status), ":deleting": _s(Status.DELETING)}
        sets, removes = ["#status = :s"], []
        if attempted_at is not None:
            fields: dict[str, Any] = {
                "last_attempt_at": _s(attempted_at),
                "last_synced_at": _s(synced_at) if synced_at else None,
                "status_reason": _s(reason) if reason else None,
                "status_estimate_usd": _n(estimate_usd) if estimate_usd is not None else None,
            }
            for name, value in fields.items():
                names[f"#{name}"] = name
                if value is not None:
                    values[f":{name}"] = value
                    sets.append(f"#{name} = :{name}")
                elif name != "last_synced_at":
                    removes.append(f"#{name}")
                else:
                    del names[f"#{name}"]
        expression = "SET " + ", ".join(sets) + (" REMOVE " + ", ".join(removes) if removes else "")
        try:
            self._call(
                "update_item",
                Key={"PK": _pk(kb_id), "SK": _s("META")},
                UpdateExpression=expression,
                ConditionExpression="attribute_exists(PK) AND #status <> :deleting",
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            )
        except ClientError:
            return

    def mark(
        self,
        kb_id: str,
        doc_id: str,
        status: DocumentStatus,
        reason: str | None = None,
        *,
        unless: DocumentStatus | None = DocumentStatus.DELETING,
    ) -> None:
        """Set the status of a document that still exists. A document someone asked to delete
        meanwhile stays ``deleting``."""
        names = {"#status": "status"}
        values: dict[str, Any] = {":s": _s(status)}
        expression = "SET #status = :s" + (", reason = :r" if reason else " REMOVE reason")
        condition = "attribute_exists(PK)"
        if reason:
            values[":r"] = _s(reason)
        if unless is not None:
            condition += " AND #status <> :unless"
            values[":unless"] = _s(unless)
        try:
            self._call(
                "update_item",
                Key={"PK": _pk(kb_id), "SK": _s(f"DOC#{doc_id}")},
                UpdateExpression=expression,
                ConditionExpression=condition,
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            )
        except ClientError:
            return

    def remove_document(self, kb_id: str, doc_id: str, size: int) -> None:
        """A deletion verified: the record goes, and its counters with it."""
        try:
            self._call_transaction(
                [
                    {
                        "Delete": {
                            "TableName": self._table,
                            "Key": {"PK": _pk(kb_id), "SK": _s(f"DOC#{doc_id}")},
                            "ConditionExpression": "attribute_exists(PK)",
                        }
                    },
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": {"PK": _pk(kb_id), "SK": _s("META")},
                            "UpdateExpression": "ADD documents :minus_one, #bytes :minus_size",
                            "ConditionExpression": "attribute_exists(PK)",
                            "ExpressionAttributeNames": {"#bytes": "bytes"},
                            "ExpressionAttributeValues": {
                                ":minus_one": _n(-1),
                                ":minus_size": _n(-size),
                            },
                        }
                    },
                ]
            )
        except ClientError:
            return  # Already removed by a run before this one.

    def _call_transaction(self, items: list[Any]) -> None:
        try:
            self._db.transact_write_items(TransactItems=items)
        except ClientError as exc:
            if _conditional(exc):
                raise
            raise StoreUnavailableError(exc.response.get("Error", {}).get("Code")) from exc

    def remove_knowledge_base(self, kb_id: str) -> int:
        """Every record of a deleted knowledge base, once nothing of it answers (D88 (16)).
        The audit trail stays. Returns how many records went."""
        items = self._items(kb_id, "")
        for item in items:
            self._call("delete_item", Key={"PK": item["PK"], "SK": item["SK"]})
        return len(items)

    # --- Synchronizations ----------------------------------------------------------------

    def start_sync(self, kb_id: str, sync_id: str, requester: Requester, now: str) -> None:
        try:
            self._call(
                "put_item",
                Item={
                    "PK": _pk(kb_id),
                    "SK": _s(f"SYNC#{sync_id}"),
                    "kb_id": _s(kb_id),
                    "sync_id": _s(sync_id),
                    "requested_by": _s(requester.user_id),
                    "state": _s("running"),
                    "started_at": _s(now),
                },
                ConditionExpression="attribute_not_exists(PK)",
            )
        except ClientError:
            return  # The same execution, retried.

    def record_sync(self, kb_id: str, sync_id: str, fields: dict[str, Any]) -> None:
        names: dict[str, str] = {}
        values: dict[str, Any] = {}
        sets: list[str] = []
        for index, (name, value) in enumerate(sorted(fields.items())):
            names[f"#f{index}"] = name
            values[f":v{index}"] = (
                _n(value)
                if isinstance(value, (int, Decimal)) and not isinstance(value, bool)
                else _s(str(value))
            )
            sets.append(f"#f{index} = :v{index}")
        self._call(
            "update_item",
            Key={"PK": _pk(kb_id), "SK": _s(f"SYNC#{sync_id}")},
            UpdateExpression="SET " + ", ".join(sets),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )

    def sync_record(self, kb_id: str, sync_id: str) -> dict[str, Any] | None:
        item = self._call(
            "get_item", Key={"PK": _pk(kb_id), "SK": _s(f"SYNC#{sync_id}")}, ConsistentRead=True
        ).get("Item")
        return dict(item) if item else None

    def finish(self, kb_id: str, sync_id: str, *, deletions_left: bool) -> Requester | None:
        """This synchronization is over: it lets go of the knowledge base. Returns who asked
        for one more meanwhile, if anyone (``sync_again``), so it can start."""
        removes = ["sync_id", "sync_requested_at", "sync_again"]
        if not deletions_left:
            removes.append("deleting_since")
        try:
            response = self._call(
                "update_item",
                Key={"PK": _pk(kb_id), "SK": _s("META")},
                UpdateExpression="REMOVE " + ", ".join(removes),
                ConditionExpression="attribute_exists(PK) AND sync_id = :me",
                ExpressionAttributeValues={":me": _s(sync_id)},
                ReturnValues="ALL_OLD",
            )
        except ClientError:
            return None
        again = _str(response.get("Attributes", {}), "sync_again")
        return Requester.from_json(json.loads(again)) if again else None

    def claim(self, kb_id: str, sync_id: str, now: str) -> bool:
        """Take a knowledge base for a new synchronization, if none holds it."""
        try:
            self._call(
                "update_item",
                Key={"PK": _pk(kb_id), "SK": _s("META")},
                UpdateExpression="SET sync_id = :id, sync_requested_at = :now",
                ConditionExpression="attribute_exists(PK) AND attribute_not_exists(sync_id)",
                ExpressionAttributeValues={":id": _s(sync_id), ":now": _s(now)},
            )
        except ClientError:
            return False
        return True

    def drop_claim(self, kb_id: str, sync_id: str) -> None:
        """A claim whose execution never started (or died long ago)."""
        try:
            self._call(
                "update_item",
                Key={"PK": _pk(kb_id), "SK": _s("META")},
                UpdateExpression="REMOVE sync_id, sync_requested_at",
                ConditionExpression="sync_id = :me",
                ExpressionAttributeValues={":me": _s(sync_id)},
            )
        except ClientError:
            return
