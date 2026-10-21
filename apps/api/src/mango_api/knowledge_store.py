"""Knowledge table repository (D88 (8), (21)): the registry of the knowledge bases.

Item layout, all under ``PK = KB#<kb id>`` (a ULID, ``mango_core.knowledge``):

* ``SK = META``: the knowledge base. ``owner_id`` is the verified subject of whoever created
  it and never changes; ``groups`` are the groups it answers to (D88 (22)); ``business_unit``
  its area or ``all``, fixed when it is created; ``status`` and the counters of its documents.
  ``version`` grows with every change: an edit names the version it read.
* Sources (``SRC#``), documents (``DOC#``) and synchronizations (``SYNC#``) come with the PRs
  that write them (D88 (9) to (11)).

Index ``All`` (``all_pk`` = ``KB``, ``created_at``) lists every knowledge base. Keep in sync
with ``infra/lib/constructs/knowledge.ts``. Deleting is a status (``deleting``): the item stays
until the synchronization verified that no vector is left (D88 (16)); mango-api never deletes
an item.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from botocore.exceptions import ClientError

from mango_core.knowledge import Status

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

INDEX_ALL = "All"
SK_META = "META"
ALL_PK = "KB"
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
    )


def _conditional(exc: ClientError) -> bool:
    return exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException"


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
