"""Lambda entry point that records the malware scan of each file of the chat (D116 (2), (10)).

GuardDuty Malware Protection for S3 scans every object created in ``Mango-<ns>-chat-files`` and
sends a ``GuardDuty Malware Protection Object Scan Result`` event to the default bus; an
EventBridge rule on that bucket invokes this function asynchronously. It writes what the scan
said in the owner's partition of the Conversations table, one item per key
(``CSCAN#<key>``), and nothing else: mango-api reads it to say «Revisando el archivo», to
check and copy an upload, or to deliver a file (``mango_api.chat_files``).

* Only keys of a person's files (``mango_core.chat_files.parse_key``) are recorded; the
  scanner's validation object and anything else are ignored.
* Delivery is at least once, maybe out of order: an event older than the recorded one is
  dropped (``scanned_at``), so a repeated event changes nothing.
* The role may only write the attributes of this item (``dynamodb:Attributes``) under the
  partitions of people (``USER#*``): it reads no message and no file.
* A failure to write raises: Lambda retries and then sends the event to the dead-letter queue,
  which has an alarm. The person sees «Revisando el archivo» meanwhile, never a file unscanned.
* Nothing of a file is logged but the ids of its key and the scan's result (TM-CF8). A result
  that blocks a file is counted (metric ``Blocked``, with an alarm).
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from collections.abc import Mapping
from datetime import datetime
from functools import cache
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from mango_core.chat_files import (
    RETENTION_DAYS,
    SCAN_RESULTS,
    ScanOutcome,
    parse_key,
    scan_outcome,
)

logger = logging.getLogger()
logger.setLevel(logging.INFO)

DETAIL_TYPE = "GuardDuty Malware Protection Object Scan Result"
METRIC_NAMESPACE = "Mango/ChatFiles"
METRIC_DIMENSION = "Installation"
DAY = 86400
UPLOAD_SCAN_SECONDS = 2 * DAY
"""An upload lives a day in the bucket; its scan is kept a day longer."""
FILE_SCAN_SECONDS = (RETENTION_DAYS + 1) * DAY
_NAMESPACE_RE = re.compile(r"^[a-z0-9]{3,8}$")
_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,255}$")
_ETAG_RE = re.compile(r"^[A-Za-z0-9-]{1,128}$")
_VERSION_RE = re.compile(r"^[A-Za-z0-9._-]{1,1024}$")
_CLIENT_CONFIG = Config(
    retries={"mode": "standard", "max_attempts": 3}, connect_timeout=3, read_timeout=10
)


class ConfigError(Exception):
    """The Lambda environment is not what the stack should have set."""


def scan_item_key(key: str) -> str:
    return f"CSCAN#{key}"


def _event_millis(raw: object, fallback: float) -> int:
    if isinstance(raw, str):
        try:
            return int(datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            pass
    return int(fallback * 1000)


def record_scan(
    event: Mapping[str, Any], *, bucket: str, table: str, dynamodb: Any, now: float
) -> str | None:
    """Write the result of one scan event; the result recorded, or ``None`` when the event is
    not about a person's file of this bucket (ignored, never retried)."""
    if event.get("detail-type") != DETAIL_TYPE or event.get("source") != "aws.guardduty":
        return None
    detail = event.get("detail")
    if not isinstance(detail, Mapping):
        return None
    s3 = detail.get("s3ObjectDetails")
    if not isinstance(s3, Mapping) or s3.get("bucketName") != bucket:
        return None
    key = s3.get("objectKey")
    parsed = parse_key(key) if isinstance(key, str) else None
    if parsed is None or not isinstance(key, str):
        return None
    status = detail.get("scanStatus")
    result_details = detail.get("scanResultDetails")
    result = result_details.get("scanResultStatus") if isinstance(result_details, Mapping) else None
    # A scan that did not complete (SKIPPED, FAILED) never opens the file.
    recorded = result if status == "COMPLETED" and result in SCAN_RESULTS else "FAILED"
    etag = str(s3.get("eTag") or "").strip('"')
    version = str(s3.get("versionId") or "")
    scanned_at = _event_millis(event.get("time"), now)
    ttl = int(now) + (UPLOAD_SCAN_SECONDS if parsed.area == "uploads" else FILE_SCAN_SECONDS)
    values: dict[str, Any] = {
        ":r": {"S": recorded},
        ":t": {"N": str(scanned_at)},
        ":x": {"N": str(ttl)},
        ":e": {"S": etag if _ETAG_RE.fullmatch(etag) else ""},
        ":v": {"S": version if _VERSION_RE.fullmatch(version) else ""},
    }
    try:
        dynamodb.update_item(
            TableName=table,
            Key={"PK": {"S": f"USER#{parsed.sub}"}, "SK": {"S": scan_item_key(key)}},
            UpdateExpression=(
                "SET scan_result = :r, scanned_at = :t, scan_etag = :e, scan_version = :v, "
                "#ttl = :x"
            ),
            ConditionExpression="attribute_not_exists(scanned_at) OR scanned_at <= :t",
            ExpressionAttributeNames={"#ttl": "ttl"},
            ExpressionAttributeValues=values,
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        # A newer scan of the same key was recorded first.
        logger.info(json.dumps({"event": "chat_file.scan_stale", "area": parsed.area}))
        return None
    logger.info(
        json.dumps(
            {
                "event": "chat_file.scanned",
                "area": parsed.area,
                "file_id": parsed.file_id,
                "result": recorded,
            }
        )
    )
    return recorded


def metrics_record(namespace: str, blocked: int, now: float) -> dict[str, Any]:
    """Embedded metric format: CloudWatch Logs turns this log line into the metric."""
    return {
        "_aws": {
            "Timestamp": int(now * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": METRIC_NAMESPACE,
                    "Dimensions": [[METRIC_DIMENSION]],
                    "Metrics": [{"Name": "Blocked", "Unit": "Count"}],
                }
            ],
        },
        METRIC_DIMENSION: namespace,
        "Blocked": blocked,
    }


@cache
def _settings() -> tuple[str, str, str]:
    env = os.environ
    try:
        namespace, bucket, table = (
            env["MANGO_NAMESPACE"],
            env["CHAT_FILES_BUCKET"],
            env["CONVERSATIONS_TABLE"],
        )
    except KeyError as exc:
        raise ConfigError(f"missing environment variable {exc.args[0]}") from None
    if not _NAMESPACE_RE.fullmatch(namespace):
        raise ConfigError("invalid MANGO_NAMESPACE")
    if not _NAME_RE.fullmatch(bucket) or not _NAME_RE.fullmatch(table):
        raise ConfigError("invalid resource name in the environment")
    return namespace, bucket, table


@cache
def _dynamodb() -> Any:
    return boto3.client("dynamodb", config=_CLIENT_CONFIG)


def lambda_handler(event: dict[str, Any], _context: object) -> dict[str, Any]:
    namespace, bucket, table = _settings()
    now = time.time()
    result = record_scan(event, bucket=bucket, table=table, dynamodb=_dynamodb(), now=now)
    blocked = int(result is not None and scan_outcome(result) is ScanOutcome.BLOCKED)
    print(json.dumps(metrics_record(namespace, blocked, now)))
    return {"recorded": result is not None}
