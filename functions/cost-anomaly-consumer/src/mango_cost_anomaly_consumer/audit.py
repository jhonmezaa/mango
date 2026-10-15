"""Audit events of the cost anomaly consumer, in the same format mango-api writes
(``mango_api.audit``): the immutable copy to Firehose -> S3 Object Lock and a 30-day copy to
the index table the admin UI reads. A test keeps the record identical to mango-api's.

The events carry identifiers, reason codes and counts: never text from the AWS event.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient
    from mypy_boto3_firehose import FirehoseClient

ACTOR = "system:cost-anomaly-consumer"
EVENT_RECEIVED = "cost_anomaly.received"
"""A valid anomaly event and what happened to each automation subscribed to it."""
EVENT_REJECTED = "cost_anomaly.rejected"
"""An event that reached the consumer and is not a Cost Anomaly Detection event of the payer."""
INDEX_TTL = timedelta(days=30)


class AuditWriter:
    def __init__(
        self, firehose: FirehoseClient, stream: str, dynamodb: DynamoDBClient, index_table: str
    ) -> None:
        self._firehose = firehose
        self._stream = stream
        self._db = dynamodb
        self._index = index_table

    def emit(self, event: str, detail: dict[str, Any], now: datetime | None = None) -> None:
        """Write one event; raises if either copy fails (Lambda retries the invocation)."""
        now = now or datetime.now(UTC)
        record: dict[str, Any] = {
            "event_id": secrets.token_hex(16),
            "ts": now.astimezone(UTC).isoformat(timespec="milliseconds"),
            "event": event,
            "user_id": ACTOR,
            "detail": detail,
        }
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
