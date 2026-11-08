"""The record of the malware scan of each file of the chat (D116 (2))."""

from __future__ import annotations

import copy
from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from moto import mock_aws

from mango_chat_files_scan.handler import (
    FILE_SCAN_SECONDS,
    UPLOAD_SCAN_SECONDS,
    metrics_record,
    record_scan,
    scan_item_key,
)

BUCKET = "mango-poc-chat-files-0a1b2c3d"
TABLE = "Mango-poc-Conversations"
SUB = "0f6e8a52-1111-4222-8333-944455556666"
UPLOAD, FILE = "01JC0000000000000000000000", "01JC0000000000000000000001"
CONVERSATION = "0123456789abcdef0123456789abcdef"
UPLOAD_KEY = f"uploads/{SUB}/{UPLOAD}/{FILE}"
OWNER_KEY = f"owner/{SUB}/conv/{CONVERSATION}/{FILE}"
NOW = 1_800_000_000.0


def scan_event(key: str = UPLOAD_KEY, result: str = "NO_THREATS_FOUND", **changes: Any) -> dict:
    """The shape of the documentation (monitor-with-eventbridge-s3-malware-protection)."""
    event: dict[str, Any] = {
        "version": "0",
        "id": "72c7d362-737a-6dce-fc78-9e27a0171419",
        "detail-type": "GuardDuty Malware Protection Object Scan Result",
        "source": "aws.guardduty",
        "account": "111122223333",
        "time": "2027-01-15T08:00:00Z",
        "region": "us-east-1",
        "resources": ["arn:aws:guardduty:us-east-1:111122223333:malware-protection-plan/x"],
        "detail": {
            "schemaVersion": "1.0",
            "scanStatus": "COMPLETED",
            "resourceType": "S3_OBJECT",
            "s3ObjectDetails": {
                "bucketName": BUCKET,
                "objectKey": key,
                "eTag": "0123456789abcdef0123456789abcdef",
                "versionId": "d41d8cd98f00b204e9800998ecf8427e",
                "s3Throttled": False,
            },
            "scanResultDetails": {"scanResultStatus": result, "threats": None},
        },
    }
    event.update(changes)
    return event


@pytest.fixture
def dynamodb() -> Iterator[Any]:
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


def stored(dynamodb: Any, key: str) -> dict[str, Any] | None:
    item = dynamodb.get_item(
        TableName=TABLE, Key={"PK": {"S": f"USER#{SUB}"}, "SK": {"S": scan_item_key(key)}}
    ).get("Item")
    return item


def record(dynamodb: Any, event: dict[str, Any]) -> str | None:
    return record_scan(event, bucket=BUCKET, table=TABLE, dynamodb=dynamodb, now=NOW)


def test_a_clean_upload_is_recorded_in_its_owners_partition(dynamodb: Any) -> None:
    assert record(dynamodb, scan_event()) == "NO_THREATS_FOUND"
    item = stored(dynamodb, UPLOAD_KEY)
    assert item is not None
    assert item["scan_result"] == {"S": "NO_THREATS_FOUND"}
    assert item["scan_etag"] == {"S": "0123456789abcdef0123456789abcdef"}
    assert item["ttl"] == {"N": str(int(NOW) + UPLOAD_SCAN_SECONDS)}
    # Only the scan's attributes: nothing of the file.
    assert set(item) == {
        "PK",
        "SK",
        "scan_result",
        "scanned_at",
        "scan_etag",
        "scan_version",
        "ttl",
    }


def test_a_file_of_a_conversation_is_kept_as_long_as_the_file(dynamodb: Any) -> None:
    record(dynamodb, scan_event(OWNER_KEY, "THREATS_FOUND"))
    item = stored(dynamodb, OWNER_KEY)
    assert item is not None
    assert item["scan_result"] == {"S": "THREATS_FOUND"}
    assert item["ttl"] == {"N": str(int(NOW) + FILE_SCAN_SECONDS)}


@pytest.mark.parametrize("status", ["SKIPPED", "FAILED"])
def test_a_scan_that_did_not_complete_is_recorded_as_failed(dynamodb: Any, status: str) -> None:
    event = scan_event()
    event["detail"]["scanStatus"] = status
    event["detail"]["scanResultDetails"] = None
    assert record(dynamodb, event) == "FAILED"


def test_an_unknown_result_never_opens_the_file(dynamodb: Any) -> None:
    assert record(dynamodb, scan_event(result="PROBABLY_FINE")) == "FAILED"


@pytest.mark.parametrize(
    "key",
    [
        "malware-protection-resource-validation-object",
        f"uploads/{SUB}/{UPLOAD}",
        f"uploads/{SUB}/../{FILE}/x",
        f"owner/{SUB}/{CONVERSATION}/{FILE}",
        f"owner/{SUB}/conv/NOT-A-CONVERSATION/{FILE}",
        f"uploads/USER#x/{UPLOAD}/{FILE}",
    ],
)
def test_keys_that_are_not_a_persons_file_are_ignored(dynamodb: Any, key: str) -> None:
    assert record(dynamodb, scan_event(key)) is None
    assert dynamodb.scan(TableName=TABLE)["Items"] == []


def test_events_of_another_bucket_or_kind_are_ignored(dynamodb: Any) -> None:
    other = scan_event()
    other["detail"]["s3ObjectDetails"]["bucketName"] = "someone-else"
    assert record(dynamodb, other) is None
    assert record(dynamodb, scan_event(source="aws.s3")) is None
    assert record(dynamodb, scan_event(**{"detail-type": "Object Created"})) is None


def test_a_repeated_or_older_event_changes_nothing(dynamodb: Any) -> None:
    record(dynamodb, scan_event(result="THREATS_FOUND", time="2027-01-15T08:05:00Z"))
    older = scan_event(result="NO_THREATS_FOUND", time="2027-01-15T08:00:00Z")
    assert record(dynamodb, older) is None
    item = stored(dynamodb, UPLOAD_KEY)
    assert item is not None
    assert item["scan_result"] == {"S": "THREATS_FOUND"}
    # The same event again (at least once): recorded the same.
    again = scan_event(result="THREATS_FOUND", time="2027-01-15T08:05:00Z")
    assert record(dynamodb, copy.deepcopy(again)) == "THREATS_FOUND"


def test_the_metric_counts_what_blocks() -> None:
    line = metrics_record("poc", 1, NOW)
    assert line["Blocked"] == 1
    assert line["Installation"] == "poc"
    assert line["_aws"]["CloudWatchMetrics"][0]["Namespace"] == "Mango/ChatFiles"
