"""Audit events of the budget reconciler, in the same format mango-api writes
(``mango_api.audit``): the immutable copy to Firehose -> S3 Object Lock and a 30-day copy to
the index table the admin UI reads. A test keeps the record identical to mango-api's.

``budget.reconciled`` carries identifiers, amounts and token counts: never content.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from mango_core.budget_turns import PendingTurn

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient
    from mypy_boto3_firehose import FirehoseClient

ACTOR = "system:budget-reconciler"
"""``user_id`` of these events; whose turn it was is in the event detail."""
EVENT_RECONCILED = "budget.reconciled"
INDEX_TTL = timedelta(days=30)


def _usd(amount: Decimal) -> str:
    return str(amount.quantize(Decimal("0.000001")))


def reconciled_detail(turn: PendingTurn) -> dict[str, Any]:
    """Detail of ``budget.reconciled`` for a turn the reconciler closed."""
    outcome = turn.outcome
    if outcome is None:
        raise ValueError("the turn is not settled")
    return {
        "target_user": turn.user_id,
        "agent": turn.agent_id,
        "version": turn.agent_version,
        "model": turn.model,
        "conversation_id": turn.conversation_id,
        "turn": turn.turn_id,
        # Where the cost came from: ``trace``, ``partial``, ``reservation``, ``not_invoked``.
        "basis": outcome.basis,
        "reason": outcome.reason,
        "ended": outcome.ended,
        "cost_usd": _usd(turn.charged),
        "known_cost_usd": _usd(outcome.known),
        "reserved_usd": _usd(turn.reserved),
        "released_usd": _usd(max(turn.reserved - turn.charged, Decimal(0))),
        "invocations": outcome.invocations,
        # Where the tokens below come from: how many model calls had ended, and which of the
        # two sums of the traces they are (``invocations`` or ``model_calls``).
        "model_calls": outcome.model_calls,
        "usage_source": outcome.source,
        "input_tokens": outcome.usage.input_tokens,
        "output_tokens": outcome.usage.output_tokens,
        "cache_read_tokens": outcome.usage.cache_read_tokens,
        "cache_write_tokens": outcome.usage.cache_write_tokens,
    }


class AuditWriter:
    def __init__(
        self, firehose: FirehoseClient, stream: str, dynamodb: DynamoDBClient, index_table: str
    ) -> None:
        self._firehose = firehose
        self._stream = stream
        self._db = dynamodb
        self._index = index_table

    def emit(self, event: str, detail: dict[str, Any], now: datetime | None = None) -> None:
        """Write one event; raises if either copy fails (the caller writes it again later)."""
        now = now or datetime.now(UTC)
        record: dict[str, Any] = {
            "event_id": secrets.token_hex(16),
            "ts": now.astimezone(UTC).isoformat(timespec="milliseconds"),
            "event": event,
            "user_id": ACTOR,
            "detail": detail,
        }
        target = detail.get("target_user")
        if isinstance(target, str) and target:
            record["resource"] = {"type": "user", "id": target}
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
