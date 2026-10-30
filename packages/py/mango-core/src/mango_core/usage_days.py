"""Spend and turns per day, for Inicio (D102; threat model ``home-threat-model.md``).

The Budgets table only keeps one item per scope and month, and the audit index keeps 30 days:
neither answers «what was spent each day of the last six months» without reading every event.
So every write that adds to ``spent`` of a turn's budget also adds, in the same transaction,
to three day counters: the organization's, the person's and, when the token said which, the
person's area at the time of the turn. They are counted exactly once, as the budget.

Item layout, in the Budgets table: ``PK = DAY#ORG``, ``DAY#AREA#<area>`` or
``DAY#USER#<sub>``; ``SK = <yyyy-mm-dd>`` (UTC, the day the turn started). Attributes:
``spent`` (USD) and ``turns`` (turns that reached the agent). A person's own counter is read
with row-level security (``dynamodb:LeadingKeys`` = ``DAY#USER#<sub>``). Items expire after
``RETENTION_DAYS``: six months and the six before them, to compare.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Final

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

DAY_PREFIX: Final = "DAY#"
ORG_KEY: Final = "DAY#ORG"
AREA_PREFIX: Final = "DAY#AREA#"
USER_PREFIX: Final = "DAY#USER#"
RETENTION_DAYS: Final = 400
"""Two periods of 180 days, and margin."""
_AREA: Final = re.compile(r"^[a-z0-9-]{2,32}$")
_DAY: Final = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ZERO: Final = Decimal(0)
_QUERY_LIMIT: Final = 400


def is_area(value: object) -> bool:
    return isinstance(value, str) and _AREA.fullmatch(value) is not None


def user_key(user_id: str) -> str:
    return USER_PREFIX + user_id


def area_key(area: str) -> str:
    if not is_area(area):
        raise ValueError("invalid area")
    return AREA_PREFIX + area


def keys(user_id: str, area: str | None) -> tuple[str, ...]:
    """The counters a turn of ``user_id`` adds to: an area that is not one is left out."""
    if area is None or not is_area(area):
        return (ORG_KEY, user_key(user_id))
    return (ORG_KEY, user_key(user_id), area_key(area))


def day_of(epoch_seconds: int) -> str:
    return datetime.fromtimestamp(epoch_seconds, UTC).date().isoformat()


def _expires(day: str) -> int:
    start = datetime.combine(date.fromisoformat(day), datetime.min.time(), UTC)
    return int((start + timedelta(days=RETENTION_DAYS)).timestamp())


def updates(
    table: str, counters: tuple[str, ...], day: str, *, spent: Decimal, turns: int
) -> list[dict[str, Any]]:
    """The writes that go into a transaction of the budget. Nothing when there is nothing to
    add: a turn released without reaching the agent leaves no trace here."""
    if not _DAY.fullmatch(day):
        raise ValueError("invalid day")
    if spent == _ZERO and turns == 0:
        return []
    return [
        {
            "Update": {
                "TableName": table,
                "Key": {"PK": {"S": key}, "SK": {"S": day}},
                "UpdateExpression": "ADD #spent :spent, #turns :turns SET #ttl = :ttl",
                "ExpressionAttributeNames": {"#spent": "spent", "#turns": "turns", "#ttl": "ttl"},
                "ExpressionAttributeValues": {
                    ":spent": {"N": str(spent)},
                    ":turns": {"N": str(turns)},
                    ":ttl": {"N": str(_expires(day))},
                },
            }
        }
        for key in counters
    ]


@dataclass(frozen=True)
class Day:
    day: str
    spent: Decimal
    turns: int


def _day(item: Mapping[str, Any]) -> Day | None:
    try:
        day = item["SK"]["S"]
        spent = Decimal(item.get("spent", {}).get("N", "0"))
        turns = int(item.get("turns", {}).get("N", "0"))
    except (KeyError, TypeError, ValueError, ArithmeticError):
        return None
    if not _DAY.fullmatch(day) or not spent.is_finite() or spent < 0 or turns < 0:
        return None
    return Day(day=day, spent=spent, turns=turns)


def read(dynamodb: DynamoDBClient, table: str, key: str, first: str, last: str) -> list[Day]:
    """The days of one counter between ``first`` and ``last`` (both included), oldest first.
    Days without an item had nothing; an item this module did not write is skipped."""
    if not key.startswith(DAY_PREFIX) or not _DAY.fullmatch(first) or not _DAY.fullmatch(last):
        raise ValueError("invalid range")
    days: list[Day] = []
    start: dict[str, Any] | None = None
    while True:
        request: dict[str, Any] = {
            "TableName": table,
            "KeyConditionExpression": "PK = :pk AND SK BETWEEN :first AND :last",
            "ProjectionExpression": "SK, #spent, #turns",
            "ExpressionAttributeNames": {"#spent": "spent", "#turns": "turns"},
            "ExpressionAttributeValues": {
                ":pk": {"S": key},
                ":first": {"S": first},
                ":last": {"S": last},
            },
            "Limit": _QUERY_LIMIT,
        }
        if start:
            request["ExclusiveStartKey"] = start
        page = dynamodb.query(**request)
        days.extend(d for item in page.get("Items", []) if (d := _day(item)) is not None)
        start = page.get("LastEvaluatedKey")
        if not start:
            return days


def first_day(dynamodb: DynamoDBClient, table: str) -> str | None:
    """The first day the organization's counter has: when the counters started, as far as
    anyone can tell (a day without turns leaves no item). ``None`` before the first turn."""
    page = dynamodb.query(
        TableName=table,
        KeyConditionExpression="PK = :pk",
        ProjectionExpression="SK",
        ExpressionAttributeValues={":pk": {"S": ORG_KEY}},
        Limit=1,
        ScanIndexForward=True,
    )
    for item in page.get("Items", []):
        day = item.get("SK", {}).get("S")
        if isinstance(day, str) and _DAY.fullmatch(day):
            return day
    return None
