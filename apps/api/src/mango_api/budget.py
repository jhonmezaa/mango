"""Budget Service: reserve before invoking, settle with real usage (rule 4, D11).

Each scope/period item keeps ``committed`` (= spent + reserved), ``spent`` and ``reserved``.
DynamoDB conditions cannot do arithmetic, so the reservation checks
``committed <= limit - amount`` with the subtraction done client-side, atomically across all
scopes in one transaction.
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient


class BudgetExceededError(Exception):
    """A scope has no remaining budget for the estimated cost."""


class BudgetUnavailableError(Exception):
    """The reservation could not be recorded (e.g. sustained write contention); retry later."""


# Concurrent turns update the shared agent item at the same time: DynamoDB cancels one of the
# transactions with ``TransactionConflict``. That is contention, not a budget decision.
MAX_RESERVE_ATTEMPTS = 4
_RETRYABLE_REASONS = frozenset({"TransactionConflict", "None"})


@dataclass(frozen=True)
class BudgetScope:
    key: str
    limit: Decimal
    label: str | None = None
    """Display label (the user's email) stored on the usage item for the admin list only."""


@dataclass(frozen=True)
class PeriodUsage:
    spent: Decimal
    label: str | None


def current_period(now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).strftime("%Y-%m")


def _n(value: Decimal) -> dict[str, str]:
    return {"N": str(value)}


class BudgetService:
    def __init__(
        self,
        dynamodb: DynamoDBClient,
        table: str,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._db = dynamodb
        self._table = table
        self._sleep = sleep

    def reserve(self, scopes: list[BudgetScope], amount: Decimal, period: str) -> None:
        if amount <= 0:
            return
        items: list[Any] = []
        for scope in scopes:
            headroom = scope.limit - amount
            if headroom < 0:
                raise BudgetExceededError(scope.key)
            label_update, label_values = (
                (", #e = :label", {":label": {"S": scope.label}}) if scope.label else ("", {})
            )
            items.append(
                {
                    "Update": {
                        "TableName": self._table,
                        "Key": {"PK": {"S": scope.key}, "SK": {"S": period}},
                        "UpdateExpression": (
                            "ADD committed :amt, reserved :amt SET #l = :limit" + label_update
                        ),
                        "ConditionExpression": (
                            "attribute_not_exists(committed) OR committed <= :headroom"
                        ),
                        "ExpressionAttributeNames": {
                            "#l": "limit",
                            **({"#e": "email"} if scope.label else {}),
                        },
                        "ExpressionAttributeValues": {
                            ":amt": _n(amount),
                            ":headroom": _n(headroom),
                            ":limit": _n(scope.limit),
                            **label_values,
                        },
                    }
                }
            )
        for attempt in range(1, MAX_RESERVE_ATTEMPTS + 1):
            try:
                self._db.transact_write_items(TransactItems=items)
            except self._db.exceptions.TransactionCanceledException as exc:
                reasons = {
                    str(reason.get("Code"))
                    for reason in exc.response.get("CancellationReasons", [])
                }
                if "ConditionalCheckFailed" in reasons:
                    raise BudgetExceededError("budget exceeded") from exc
                if not reasons <= _RETRYABLE_REASONS or attempt == MAX_RESERVE_ATTEMPTS:
                    raise BudgetUnavailableError("budget reservation not recorded") from exc
                # Full jitter so competing turns do not collide again.
                self._sleep(random.uniform(0, 0.05 * 2**attempt))  # noqa: S311
            else:
                return

    def settle(
        self, scopes: list[BudgetScope], reserved: Decimal, actual: Decimal, period: str
    ) -> None:
        """Replace the reservation with the real cost (may exceed the estimate)."""
        for scope in scopes:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": {"S": scope.key}, "SK": {"S": period}},
                UpdateExpression="ADD committed :delta, reserved :release, spent :actual",
                ExpressionAttributeValues={
                    ":delta": _n(actual - reserved),
                    ":release": _n(-reserved),
                    ":actual": _n(actual),
                },
            )

    def status(self, scope: BudgetScope, period: str) -> dict[str, str]:
        item = self._db.get_item(
            TableName=self._table, Key={"PK": {"S": scope.key}, "SK": {"S": period}}
        ).get("Item", {})
        spent = Decimal(item.get("spent", {}).get("N", "0"))
        return {"limit_usd": str(scope.limit), "spent_usd": str(spent.quantize(Decimal("0.01")))}

    def period_usage(self, period: str, max_pages: int = 20) -> dict[str, PeriodUsage]:
        """Spend per scope key (``USER#…``, ``AGENT#…``) in ``period`` for the admin list.

        The table has no period index, so this is a bounded, filtered scan: acceptable for the
        admin page at PoC scale (one item per active user and month).
        """
        usage: dict[str, PeriodUsage] = {}
        pages = self._db.get_paginator("scan").paginate(
            TableName=self._table,
            FilterExpression="SK = :period",
            ProjectionExpression="PK, spent, #e",
            ExpressionAttributeNames={"#e": "email"},
            ExpressionAttributeValues={":period": {"S": period}},
        )
        for page_number, page in enumerate(pages):
            if page_number >= max_pages:
                break
            for item in page.get("Items", []):
                usage[item["PK"]["S"]] = PeriodUsage(
                    spent=Decimal(item.get("spent", {}).get("N", "0")),
                    label=item.get("email", {}).get("S"),
                )
        return usage
