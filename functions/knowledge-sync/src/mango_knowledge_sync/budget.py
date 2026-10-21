"""Embeddings go to the budget of whoever synchronizes (D88 (24), rule 4).

Before ingesting, the synchronization reserves what the documents may cost, estimated by
their size; at the end it charges what the indexed ones were estimated at and releases the
rest. Bedrock does not report the tokens of an ingestion: the charge is the estimate, to be
reconciled against the bill (CUR) like the rest of §4.5.

The counters of a scope are those of ``mango_api.budget`` (``committed`` = ``spent`` +
``reserved``), changed with the same conditions: a reservation never takes ``committed``
over the limit.
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from botocore.exceptions import ClientError

BYTES_PER_TOKEN = 4
"""A generous estimate: a PDF or a DOCX has fewer tokens than bytes."""
_MILLION = Decimal(1_000_000)
_ATTEMPTS = 4
_CENT_FRACTION = Decimal("0.000001")


class BudgetExceededError(Exception):
    """The synchronization does not fit in the budget of whoever asked for it."""


class BudgetUnavailableError(Exception):
    """The reservation could not be written; the step is retried."""


@dataclass(frozen=True)
class Reservation:
    scope: str
    period: str
    amount: Decimal


def estimate(total_bytes: int, price_per_million: Decimal) -> Decimal:
    tokens = Decimal(-(-total_bytes // BYTES_PER_TOKEN))
    return (tokens * price_per_million / _MILLION).quantize(_CENT_FRACTION)


def scope_of(user_id: str) -> str:
    return f"USER#{user_id}"


class Budgets:
    def __init__(
        self, dynamodb: Any, table: str, sleep: Callable[[float], None] = time.sleep
    ) -> None:
        self._db = dynamodb
        self._table = table
        self._sleep = sleep

    def reserve(self, reservation: Reservation, limit: Decimal, label: str | None) -> None:
        if reservation.amount <= 0:
            return
        headroom = limit - reservation.amount
        if headroom < 0:
            raise BudgetExceededError(reservation.scope)
        names = {"#l": "limit", **({"#e": "email"} if label else {})}
        values: dict[str, Any] = {
            ":amt": {"N": str(reservation.amount)},
            ":headroom": {"N": str(headroom)},
            ":limit": {"N": str(limit)},
            **({":label": {"S": label}} if label else {}),
        }
        for attempt in range(1, _ATTEMPTS + 1):
            try:
                self._db.update_item(
                    TableName=self._table,
                    Key={"PK": {"S": reservation.scope}, "SK": {"S": reservation.period}},
                    UpdateExpression="ADD committed :amt, reserved :amt SET #l = :limit"
                    + (", #e = :label" if label else ""),
                    ConditionExpression="attribute_not_exists(committed) OR committed <= :headroom",
                    ExpressionAttributeNames=names,
                    ExpressionAttributeValues=values,
                )
            except ClientError as exc:
                code = exc.response.get("Error", {}).get("Code")
                if code == "ConditionalCheckFailedException":
                    raise BudgetExceededError(reservation.scope) from exc
                if attempt == _ATTEMPTS:
                    raise BudgetUnavailableError(str(code)) from exc
                self._sleep(random.uniform(0, 0.05 * 2**attempt))  # noqa: S311
            else:
                return

    def settle(self, reservation: Reservation, charged: Decimal) -> None:
        """Replace the reservation with what is charged. Once per synchronization: the caller
        records it as settled first."""
        if reservation.amount <= 0 and charged <= 0:
            return
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": {"S": reservation.scope}, "SK": {"S": reservation.period}},
                UpdateExpression="ADD committed :delta, reserved :release, spent :charged",
                ExpressionAttributeValues={
                    ":delta": {"N": str(charged - reservation.amount)},
                    ":release": {"N": str(-reservation.amount)},
                    ":charged": {"N": str(charged)},
                },
            )
        except ClientError as exc:
            raise BudgetUnavailableError(str(exc.response.get("Error", {}).get("Code"))) from exc
