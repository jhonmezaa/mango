"""The day counters of Inicio (D102): key layout, writes and reads against moto DynamoDB."""

from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal
from typing import Any

import boto3
import pytest
from moto import mock_aws

from mango_core import usage_days

TABLE = "budgets"


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        client.create_table(
            TableName=TABLE,
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
        yield client


def _add(db: Any, key: str, day: str, spent: str, turns: int = 1) -> None:
    for item in usage_days.updates(TABLE, (key,), day, spent=Decimal(spent), turns=turns):
        db.update_item(**item["Update"])


def test_keys_name_the_organization_the_person_and_a_valid_area() -> None:
    assert usage_days.keys("u-1", "ventas") == ("DAY#ORG", "DAY#USER#u-1", "DAY#AREA#ventas")
    assert usage_days.keys("u-1", None) == ("DAY#ORG", "DAY#USER#u-1")
    # An area that is not one never becomes a key.
    assert usage_days.keys("u-1", "DAY#ORG") == ("DAY#ORG", "DAY#USER#u-1")
    with pytest.raises(ValueError, match="area"):
        usage_days.area_key("x/../y")


def test_the_day_is_the_utc_day() -> None:
    assert usage_days.day_of(1_791_306_900) == "2026-10-06"


def test_nothing_is_written_for_nothing_and_a_bad_day_is_refused() -> None:
    assert usage_days.updates(TABLE, ("DAY#ORG",), "2026-10-06", spent=Decimal(0), turns=0) == []
    with pytest.raises(ValueError, match="day"):
        usage_days.updates(TABLE, ("DAY#ORG",), "2026-10", spent=Decimal(1), turns=1)


def test_counters_add_up_and_expire_after_the_retention(db: Any) -> None:
    _add(db, "DAY#ORG", "2026-10-06", "0.5")
    _add(db, "DAY#ORG", "2026-10-06", "0.25", turns=0)
    item = db.get_item(TableName=TABLE, Key={"PK": {"S": "DAY#ORG"}, "SK": {"S": "2026-10-06"}})
    assert item["Item"]["spent"]["N"] == "0.75"
    assert item["Item"]["turns"]["N"] == "1"
    # 400 days after the start of the day, whatever the write.
    assert int(item["Item"]["ttl"]["N"]) == 1_791_244_800 + 400 * 86_400


def test_reading_returns_the_range_oldest_first_and_only_that_counter(db: Any) -> None:
    _add(db, "DAY#ORG", "2026-10-01", "1")
    _add(db, "DAY#ORG", "2026-10-03", "2")
    _add(db, "DAY#ORG", "2026-10-09", "4")
    _add(db, "DAY#USER#u-1", "2026-10-03", "8")
    days = usage_days.read(db, TABLE, "DAY#ORG", "2026-10-02", "2026-10-09")
    assert [(d.day, d.spent, d.turns) for d in days] == [
        ("2026-10-03", Decimal(2), 1),
        ("2026-10-09", Decimal(4), 1),
    ]
    assert usage_days.first_day(db, TABLE) == "2026-10-01"


def test_a_foreign_item_is_skipped_and_only_day_keys_are_read(db: Any) -> None:
    db.put_item(
        TableName=TABLE,
        Item={"PK": {"S": "DAY#ORG"}, "SK": {"S": "2026-10-04"}, "spent": {"N": "-3"}},
    )
    assert usage_days.read(db, TABLE, "DAY#ORG", "2026-10-01", "2026-10-31") == []
    with pytest.raises(ValueError, match="range"):
        usage_days.read(db, TABLE, "USER#u-1", "2026-10-01", "2026-10-31")


def test_first_day_is_none_before_the_first_turn(db: Any) -> None:
    assert usage_days.first_day(db, TABLE) is None
