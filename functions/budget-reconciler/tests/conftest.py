"""Doubles of the budget reconciler tests: DynamoDB (moto), the spans log group and Firehose."""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from mango_budget_reconciler.audit import AuditWriter
from mango_budget_reconciler.config import Settings
from mango_budget_reconciler.handler import BudgetReconciler
from mango_budget_reconciler.traces import Traces
from mango_core import budget_turns
from mango_core.budget_turns import PendingTurn, TokenUsage, TurnPrice

TABLE, AUDIT_TABLE = "budgets", "audit-index"
PERIOD = "2026-10"
USER, AGENT = "USER#user-1", "AGENT#finops"
PRICE = TurnPrice(Decimal(3), Decimal(15), Decimal("0.3"), Decimal("3.75"))
RESERVED = Decimal("0.337")
SESSION = "ab" * 32
OTHER_SESSION = "cd" * 32
START = 1_791_306_900
"""When the turn reserved (epoch seconds)."""
DUE = START + 120 + 90
EXPIRED = START + 120 + 15 * 60
NOW = datetime(2026, 10, 6, 17, 30, tzinfo=UTC)
SETTINGS = Settings(
    namespace="lab", budgets_table=TABLE, audit_stream="audit", audit_index_table=AUDIT_TABLE
)


def span(
    *,
    session: str = SESSION,
    start: float = START + 1,
    seconds: float = 6.5,
    tokens: tuple[int, int] | None = (3030, 250),
    status: str = "OK",
    name: str = "invoke_agent Strands Agents",
    span_id: str = "ac5bda4b4f6d0001",
    **attributes: Any,
) -> dict[str, Any]:
    """A span as the managed harness writes it to ``aws/spans`` (shape seen in the lab)."""
    start_ns = int(start * 1_000_000_000)
    usage = (
        {}
        if tokens is None
        else {
            "gen_ai.usage.input_tokens": tokens[0],
            "gen_ai.usage.prompt_tokens": tokens[0],
            "gen_ai.usage.output_tokens": tokens[1],
            "gen_ai.usage.completion_tokens": tokens[1],
            "gen_ai.usage.total_tokens": sum(tokens),
            "gen_ai.usage.cache_read_input_tokens": 0,
            "gen_ai.usage.cache_write_input_tokens": 0,
        }
    )
    return {
        "resource": {"attributes": {"service.name": "harness_Mango_lab_a_finops"}},
        "traceId": "6ac52cb76b730000000000000000beef",
        "spanId": span_id,
        "name": name,
        "kind": "INTERNAL",
        "startTimeUnixNano": start_ns,
        "endTimeUnixNano": start_ns + int(seconds * 1_000_000_000),
        "durationNano": int(seconds * 1_000_000_000),
        "attributes": {
            "harness.id": "Mango_lab_a_finops",
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.request.model": "us.anthropic.claude-sonnet-4-6",
            "session.id": session,
            **usage,
            **attributes,
        },
        "status": {"code": status},
    }


@dataclass
class FakeLogs:
    """``FilterLogEvents`` over the spans given, by time range and session id."""

    spans: list[Any] = field(default_factory=list)
    fail: bool = False
    page_size: int = 100
    endless: bool = False
    calls: list[dict[str, Any]] = field(default_factory=list)

    def filter_log_events(self, **request: Any) -> dict[str, Any]:
        self.calls.append(request)
        if self.fail:
            raise ClientError({"Error": {"Code": "ThrottlingException"}}, "FilterLogEvents")
        if self.endless:
            return {"events": [], "nextToken": "more"}
        events = []
        for index, item in enumerate(self.spans):
            message = item if isinstance(item, str) else json.dumps(item)
            end_ms = (
                item["endTimeUnixNano"] // 1_000_000 if isinstance(item, dict) else START * 1000
            )
            # The real filter matches on the session id; a raw string stands for an event
            # that matched and is not a span.
            matches = not isinstance(item, dict) or (
                f'"{item["attributes"].get("session.id")}"' in request["filterPattern"]
            )
            if matches and request["startTime"] <= end_ms <= request["endTime"]:
                events.append({"eventId": str(index), "timestamp": end_ms, "message": message})
        offset = int(request.get("nextToken", 0))
        page = events[offset : offset + self.page_size]
        more = offset + self.page_size < len(events)
        return {"events": page, **({"nextToken": str(offset + self.page_size)} if more else {})}


@dataclass
class FakeFirehose:
    records: list[dict[str, Any]] = field(default_factory=list)
    fail: bool = False

    def put_record(self, *, DeliveryStreamName: str, Record: dict[str, bytes]) -> None:  # noqa: N803
        if self.fail:
            raise ClientError({"Error": {"Code": "ServiceUnavailableException"}}, "PutRecord")
        self.records.append(json.loads(Record["Data"]))


@dataclass
class Lab:
    db: Any
    logs: FakeLogs = field(default_factory=FakeLogs)
    firehose: FakeFirehose = field(default_factory=FakeFirehose)
    remaining: float = 200.0

    def reconciler(self) -> BudgetReconciler:
        return BudgetReconciler(
            SETTINGS,
            dynamodb=self.db,
            traces=Traces(self.logs, "aws/spans"),  # type: ignore[arg-type]
            audit=AuditWriter(self.firehose, "audit", self.db, AUDIT_TABLE),  # type: ignore[arg-type]
        )

    def run(self, now: int = DUE) -> Counter[str]:
        return self.reconciler().run(now, lambda: self.remaining)

    def turn(
        self, turn_id: str = "a" * 32, *, session: str = SESSION, **changes: Any
    ) -> PendingTurn:
        """A turn that reserved; its mango-api task never said how it ended."""
        turn = replace(
            PendingTurn.new(
                turn_id=turn_id,
                user_id="user-1",
                agent_id="finops",
                agent_version=3,
                model="us.anthropic.claude-sonnet-4-6",
                conversation_id="c" * 32,
                period=PERIOD,
                scopes=(USER, AGENT),
                reserved=RESERVED,
                price=PRICE,
                started_at=START,
                timeout_seconds=120,
            ),
            session_id=session,
            **changes,
        )
        self.db.transact_write_items(
            TransactItems=[
                budget_turns.reservation_item(TABLE, turn),
                *[
                    {
                        "Update": {
                            "TableName": TABLE,
                            "Key": {"PK": {"S": scope}, "SK": {"S": PERIOD}},
                            "UpdateExpression": "ADD committed :amount, reserved :amount",
                            "ExpressionAttributeValues": {":amount": {"N": str(turn.reserved)}},
                        }
                    }
                    for scope in turn.scopes
                ],
            ]
        )
        return turn

    def cut(
        self, turn_id: str = "a" * 32, usage: TokenUsage | None = None, **changes: Any
    ) -> PendingTurn:
        """A turn mango-api stopped reading: what it knew is charged, the rest is held."""
        held = budget_turns.hold(
            self.db, TABLE, self.turn(turn_id, **changes), usage or TokenUsage()
        )
        assert held is not None
        return held

    def budget(self, scope: str = USER) -> dict[str, Decimal]:
        item = self.db.get_item(TableName=TABLE, Key={"PK": {"S": scope}, "SK": {"S": PERIOD}})[
            "Item"
        ]
        return {
            name: Decimal(item.get(name, {}).get("N", "0"))
            for name in ("spent", "reserved", "committed", "held")
        }

    def record(self, turn: PendingTurn) -> PendingTurn | None:
        item = self.db.get_item(TableName=TABLE, Key=turn.key).get("Item")
        return PendingTurn.from_item(item) if item else None


def amounts(spent: str, reserved: str = "0", held: str = "0") -> dict[str, Decimal]:
    return {
        "spent": Decimal(spent),
        "reserved": Decimal(reserved),
        "committed": Decimal(spent) + Decimal(reserved),
        "held": Decimal(held),
    }


@pytest.fixture
def lab(monkeypatch: pytest.MonkeyPatch) -> Iterator[Lab]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        for table in (TABLE, AUDIT_TABLE):
            db.create_table(
                TableName=table,
                KeySchema=[
                    {"AttributeName": "PK", "KeyType": "HASH"},
                    {"AttributeName": "SK", "KeyType": "RANGE"},
                ],
                AttributeDefinitions=[
                    {"AttributeName": "PK", "AttributeType": "S"},
                    {"AttributeName": "SK", "AttributeType": "S"},
                ],
                BillingMode="PAY_PER_REQUEST",
            )
        yield Lab(db=db)
