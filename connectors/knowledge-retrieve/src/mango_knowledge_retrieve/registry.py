"""What the tool reads of the registry of knowledge bases (``Mango-<ns>-Knowledge``, D88 (8)).

Only reads, by key: the record of each knowledge base the agent version names (its groups,
area, status and name now, D88 (22)) and the names of the documents a search returned. The
layout is the one ``mango_api.knowledge_store`` writes.
"""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass
from typing import Any

from mango_core.knowledge import Status

SK_META = "META"
_MAX_KEYS = 100
"""Of one ``BatchGetItem``."""


@dataclass(frozen=True)
class KnowledgeBaseRecord:
    kb_id: str
    name: str
    business_unit: str
    groups: frozenset[str]
    status: Status


def _pk(kb_id: str) -> str:
    return f"KB#{kb_id}"


class Registry:
    def __init__(self, dynamodb: Any, table: str) -> None:
        self._db = dynamodb
        self._table = table

    def _batch(self, keys: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Every item of ``keys`` that exists; raises if the table does not answer for all."""
        items: list[dict[str, Any]] = []
        pending: list[dict[str, Any]] = keys[:_MAX_KEYS]
        for _ in range(3):
            if not pending:
                return items
            response = self._db.batch_get_item(
                RequestItems={self._table: {"Keys": pending, "ConsistentRead": True}}
            )
            items.extend(response.get("Responses", {}).get(self._table, []))
            pending = response.get("UnprocessedKeys", {}).get(self._table, {}).get("Keys", [])
        if pending:
            raise RuntimeError("the registry did not answer for every key")
        return items

    def knowledge_bases(self, kb_ids: Collection[str]) -> dict[str, KnowledgeBaseRecord]:
        """The records of ``kb_ids`` that exist, by id."""
        keys = [{"PK": {"S": _pk(kb_id)}, "SK": {"S": SK_META}} for kb_id in sorted(kb_ids)]
        found: dict[str, KnowledgeBaseRecord] = {}
        for item in self._batch(keys):
            record = KnowledgeBaseRecord(
                kb_id=item["kb_id"]["S"],
                name=item["name"]["S"],
                business_unit=item["business_unit"]["S"],
                groups=frozenset(item.get("groups", {}).get("SS", [])),
                status=Status(item["status"]["S"]),
            )
            found[record.kb_id] = record
        return found

    def document_names(self, documents: Collection[tuple[str, str]]) -> dict[tuple[str, str], str]:
        """Shown names of ``(kb_id, doc_id)`` documents that are still in the registry."""
        keys = [
            {"PK": {"S": _pk(kb_id)}, "SK": {"S": f"DOC#{doc_id}"}}
            for kb_id, doc_id in sorted(set(documents))
        ]
        return {
            (item["kb_id"]["S"], item["doc_id"]["S"]): item["name"]["S"]
            for item in self._batch(keys)
        }
