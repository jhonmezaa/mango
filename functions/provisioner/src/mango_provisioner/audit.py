"""Audit events of the provisioner, in the same format mango-api writes (``mango_api.audit``).

The immutable copy goes to Firehose -> S3 Object Lock and a 30-day copy to the index table the
admin UI reads. Events carry identifiers, hashes and error codes: never a definition. A test
keeps this record identical to the one mango-api would write.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_provisioner.errors import aws_error

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient
    from mypy_boto3_firehose import FirehoseClient

ACTOR = "system:provisioner"
"""``user_id`` of provisioner events; the people involved are in the event detail."""
EVENT_PUBLISHED = "agent.version.published"
EVENT_DEPROVISION = "agent.deprovision"
"""Removal of what a retired agent left in AWS (D48): ``requested``, ``applied``, ``rejected``."""
EVENT_PACK_ENABLED = "mcp.pack.enabled"
EVENT_PACK_DISABLED = "mcp.pack.disabled"
# Detail key -> resource type of the record (what the event is about).
_RESOURCES = (("agent", "agent"), ("pack", "mcp_pack"))
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
        now = now or datetime.now(UTC)
        record: dict[str, Any] = {
            "event_id": secrets.token_hex(16),
            "ts": now.astimezone(UTC).isoformat(timespec="milliseconds"),
            "event": event,
            "user_id": ACTOR,
            "detail": detail,
        }
        for key, kind in _RESOURCES:
            value = detail.get(key)
            if isinstance(value, str) and value:
                record["resource"] = {"type": kind, "id": value}
                break
        body = json.dumps(record, separators=(",", ":"), sort_keys=True)
        record["hash"] = hashlib.sha256(body.encode()).hexdigest()
        line = json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n"
        try:
            self._firehose.put_record(
                DeliveryStreamName=self._stream, Record={"Data": line.encode()}
            )
            self._db.put_item(
                TableName=self._index,
                Item={
                    "PK": {"S": f"DAY#{now.strftime('%Y-%m-%d')}"},
                    "SK": {"S": f"{record['ts']}#{record['event_id']}"},
                    "record": {"S": line},
                    "ttl": {"N": str(int((now + INDEX_TTL).timestamp()))},
                },
            )
        except (ClientError, BotoCoreError) as exc:
            # Fail closed: the step fails and the publication does not go on unaudited.
            raise aws_error("Audit", exc) from None
