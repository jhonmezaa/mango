"""The Bedrock knowledge base, as the synchronization uses it (D88 (11), (16), (23), (27)).

* Documents are ingested directly on the ``CUSTOM`` data source, from their S3 location, with
  their metadata inline: never an ingestion job, never a transformation function (D88 (23)).
  Every document carries ``kb_id`` (a test makes sure), ``doc_id``, ``business_unit``,
  ``acl_groups`` and ``classification``, all from the registry (TM-K1, TM-K10).
* Calls go in batches of at most 25 documents (the quota of the account, D88 (27)), one at a
  time, which keeps them under 5 per second and under 10 at once.
* A deletion is verified with a search filtered by ``kb_id`` and the documents: it is done
  when nothing comes back (D88 (16)).

What Bedrock throttles is raised as :class:`ThrottledError`: the state machine retries the step.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

BATCH = 25
"""Documents per ingestion or deletion call (D88 (27))."""
QUERY_FILTER_MAX = 50
"""Ids in one ``in`` filter: seen working in the account (D88 (27))."""
_PAUSE_SECONDS = 0.25
"""Between two calls of one step: at most 4 per second, under the quota of 5."""
_DONE = frozenset({"INDEXED", "PARTIALLY_INDEXED", "METADATA_PARTIALLY_INDEXED"})
_FAILED = frozenset({"FAILED", "METADATA_UPDATE_FAILED", "IGNORED", "NOT_FOUND"})


class ThrottledError(Exception):
    """Bedrock refused for a quota: the step is retried later."""


class BedrockUnavailableError(Exception):
    """Bedrock refused or failed for another reason; the error code only."""


class BedrockDeniedError(Exception):
    """Bedrock refused for permissions: retrying changes nothing (the error code only)."""


DENIED = frozenset({"AccessDeniedException", "AccessDenied", "UnauthorizedException"})


@dataclass(frozen=True)
class Ingestable:
    doc_id: str
    key: str
    kb_id: str
    business_unit: str
    groups: tuple[str, ...]
    classification: str


@dataclass(frozen=True)
class Outcome:
    doc_id: str
    state: str
    """``indexed``, ``failed`` or ``pending``."""
    reason: str | None = None


def chunks[T](items: Sequence[T], size: int) -> list[Sequence[T]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def metadata(doc: Ingestable) -> list[dict[str, Any]]:
    """The inline attributes of a document; ``kb_id`` always first and never empty."""
    if not doc.kb_id or not doc.doc_id:
        raise ValueError("a document is ingested with its kb_id and doc_id")
    return [
        {"key": "kb_id", "value": {"type": "STRING", "stringValue": doc.kb_id}},
        {"key": "doc_id", "value": {"type": "STRING", "stringValue": doc.doc_id}},
        {"key": "business_unit", "value": {"type": "STRING", "stringValue": doc.business_unit}},
        {
            "key": "acl_groups",
            "value": {"type": "STRING_LIST", "stringListValue": list(doc.groups)},
        },
        {"key": "classification", "value": {"type": "STRING", "stringValue": doc.classification}},
    ]


def reason_of(status_reason: str) -> str:
    """The reason of the design for a document Bedrock did not index (D88 (8)). The text of
    Bedrock is not kept: it may quote the document."""
    text = status_reason.lower()
    if "password" in text or "encrypt" in text or "protected" in text:
        return "protected"
    if "size" in text or "too large" in text or "exceed" in text:
        return "too_large"
    if "format" in text or "unsupported" in text or "not supported" in text:
        return "unsupported"
    if "text" in text or "empty" in text or "content" in text:
        return "no_text"
    return "not_indexed"


def _error(exc: Exception) -> Exception:
    if isinstance(exc, ClientError):
        code = str(exc.response.get("Error", {}).get("Code"))
        if code in {
            "ThrottlingException",
            "ServiceQuotaExceededException",
            "TooManyRequestsException",
        }:
            return ThrottledError(code)
        if code in DENIED:
            return BedrockDeniedError(code)
        return BedrockUnavailableError(code)
    return BedrockUnavailableError(type(exc).__name__)


class KnowledgeBedrock:
    def __init__(
        self,
        agent: Any,
        runtime: Any,
        *,
        knowledge_base_id: str,
        data_source_id: str,
        bucket: str,
        account_id: str,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._agent = agent
        self._runtime = runtime
        self._kb = knowledge_base_id
        self._ds = data_source_id
        self._bucket = bucket
        self._account = account_id
        self._sleep = sleep

    def _identifier(self, doc_id: str) -> dict[str, Any]:
        return {"dataSourceType": "CUSTOM", "custom": {"id": doc_id}}

    def ingest(self, documents: Sequence[Ingestable], token: str) -> None:
        """Ask Bedrock to index ``documents`` (at most :data:`BATCH`). ``token`` makes a retry
        of the same batch the same request."""
        if len(documents) > BATCH:
            raise ValueError("too many documents for one call")
        try:
            self._agent.ingest_knowledge_base_documents(
                knowledgeBaseId=self._kb,
                dataSourceId=self._ds,
                clientToken=token,
                documents=[
                    {
                        "content": {
                            "dataSourceType": "CUSTOM",
                            "custom": {
                                "customDocumentIdentifier": {"id": doc.doc_id},
                                "sourceType": "S3_LOCATION",
                                "s3Location": {
                                    "uri": f"s3://{self._bucket}/{doc.key}",
                                    "bucketOwnerAccountId": self._account,
                                },
                            },
                        },
                        "metadata": {
                            "type": "IN_LINE_ATTRIBUTE",
                            "inlineAttributes": metadata(doc),
                        },
                    }
                    for doc in documents
                ],
            )
        except (BotoCoreError, ClientError) as exc:
            raise _error(exc) from exc

    def outcomes(self, doc_ids: Sequence[str]) -> list[Outcome]:
        """Where each document is in its indexing."""
        found: list[Outcome] = []
        for index, batch in enumerate(chunks(doc_ids, BATCH)):
            if index:
                self._sleep(_PAUSE_SECONDS)
            try:
                response = self._agent.get_knowledge_base_documents(
                    knowledgeBaseId=self._kb,
                    dataSourceId=self._ds,
                    documentIdentifiers=[self._identifier(d) for d in batch],
                )
            except (BotoCoreError, ClientError) as exc:
                raise _error(exc) from exc
            seen: set[str] = set()
            for detail in response.get("documentDetails", []):
                doc_id = str(detail.get("identifier", {}).get("custom", {}).get("id", ""))
                if doc_id not in batch:
                    continue
                seen.add(doc_id)
                status = str(detail.get("status", ""))
                if status in _DONE:
                    found.append(Outcome(doc_id, "indexed"))
                elif status in _FAILED:
                    found.append(
                        Outcome(doc_id, "failed", reason_of(str(detail.get("statusReason", ""))))
                    )
                else:
                    found.append(Outcome(doc_id, "pending"))
            found.extend(Outcome(d, "pending") for d in batch if d not in seen)
        return found

    def delete(self, doc_ids: Sequence[str], token: str) -> None:
        if len(doc_ids) > BATCH:
            raise ValueError("too many documents for one call")
        try:
            self._agent.delete_knowledge_base_documents(
                knowledgeBaseId=self._kb,
                dataSourceId=self._ds,
                clientToken=token,
                documentIdentifiers=[self._identifier(d) for d in doc_ids],
            )
        except (BotoCoreError, ClientError) as exc:
            raise _error(exc) from exc

    def still_answering(self, kb_id: str, doc_ids: Sequence[str] | None) -> set[str]:
        """The documents that a search filtered by ``kb_id`` (and by them, if given) still
        returns. With ``doc_ids`` empty, nothing is asked: an empty ``in`` is an error of
        ``Retrieve``, not zero results (D88 (27))."""
        if doc_ids is not None and not doc_ids:
            return set()
        filters: list[dict[str, Any]] = []
        if doc_ids is None:
            filters.append({"equals": {"key": "kb_id", "value": kb_id}})
        else:
            filters = [
                {
                    "andAll": [
                        {"equals": {"key": "kb_id", "value": kb_id}},
                        {"in": {"key": "doc_id", "value": list(batch)}},
                    ]
                }
                for batch in chunks(doc_ids, QUERY_FILTER_MAX)
            ]
        answering: set[str] = set()
        for index, condition in enumerate(filters):
            if index:
                self._sleep(_PAUSE_SECONDS)
            try:
                response = self._runtime.retrieve(
                    knowledgeBaseId=self._kb,
                    retrievalQuery={"text": "verify deletion"},
                    retrievalConfiguration={
                        "vectorSearchConfiguration": {
                            "numberOfResults": 100,
                            "filter": condition,
                        }
                    },
                )
            except (BotoCoreError, ClientError) as exc:
                raise _error(exc) from exc
            for result in response.get("retrievalResults", []):
                meta = result.get("metadata", {})
                # Whatever comes back counts: a result without doc_id still answers.
                answering.add(str(meta.get("doc_id", "")))
        return answering
