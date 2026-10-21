"""Audit events of the knowledge synchronization, in the format mango-api writes
(``mango_api.audit``): the immutable copy to Firehose -> S3 Object Lock and a 30-day copy to
the index table the admin UI reads.

``kb.sync`` and ``kb.deleted`` carry ids, counts and amounts: never a name nor content
(D88 (12), TM-K9).
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

ACTOR = "system:knowledge-sync"
"""``user_id`` of these events; who asked for the synchronization is in the detail."""
INDEX_TTL = timedelta(days=30)


class AuditWriter:
    def __init__(self, firehose: Any, stream: str, dynamodb: Any, index_table: str) -> None:
        self._firehose = firehose
        self._stream = stream
        self._db = dynamodb
        self._index = index_table

    def emit(self, event: str, detail: dict[str, Any], now: datetime | None = None) -> None:
        """Write one event; raises if either copy fails (the step is retried)."""
        now = now or datetime.now(UTC)
        record: dict[str, Any] = {
            "event_id": secrets.token_hex(16),
            "ts": now.astimezone(UTC).isoformat(timespec="milliseconds"),
            "event": event,
            "user_id": ACTOR,
            "detail": detail,
        }
        kb_id = detail.get("kb_id")
        if isinstance(kb_id, str) and kb_id:
            record["resource"] = {"type": "knowledge_base", "id": kb_id}
        body = json.dumps(record, separators=(",", ":"), sort_keys=True)
        record["hash"] = hashlib.sha256(body.encode()).hexdigest()
        line = json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n"
        self._firehose.put_record(DeliveryStreamName=self._stream, Record={"Data": line.encode()})
        self._db.put_item(
            TableName=self._index,
            Item={
                "PK": {"S": f"DAY#{now.strftime('%Y-%m-%d')}"},
                "SK": {"S": f"{record['ts']}#{record['event_id']}"},
                "record": {"S": line},
                "ttl": {"N": str(int((now + INDEX_TTL).timestamp()))},
            },
        )
