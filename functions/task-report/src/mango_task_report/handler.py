"""Mango-<ns>-TaskReport: draws the PDF of one task run (D86 (2), D87).

mango-api invokes it asynchronously once a run that asked for a report ended with valid data.
The event only names the run (``mango_core.task_reports.valid_event``); everything else is read
from the run's item: the data mango-api validated (validated again here), the name of the file
and the key of its object, both computed by mango-api. It never decides what it touches
(TM-R5): its role reads the table, changes only the ``report_*`` attributes of a run and writes
only under ``owner/`` in the reports bucket.

What it writes back is a status: ``ready`` (with pages and size) or ``failed`` with ``data``,
``size`` or ``render``. Only a failure of DynamoDB or S3 raises: the invocation is retried and,
after its retries, goes to the dead-letter queue (its alarm). Nothing of the data, the PDF or
the key is logged: ids and codes only.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import date, datetime
from typing import TYPE_CHECKING, Any

import boto3
from botocore.exceptions import ClientError

from mango_core import task_reports as tr
from mango_task_report.render import Meta, RenderError, render

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient
    from mypy_boto3_s3 import S3Client

logger = logging.getLogger()
logger.setLevel(logging.INFO)

GENERATING = "generating"
_ATTRIBUTES = (
    "run_id",
    "report_status",
    "report_meta",
    "report_data",
    "steps",
    "anomaly_id",
    "anomaly_start",
    "anomaly_end",
)
"""What it reads of a run: never its result or the task's instruction. Kept in sync with the
condition of its role (``infra/lib/constructs/task-reports.ts``)."""


class Reports:
    def __init__(
        self, dynamodb: DynamoDBClient, s3: S3Client, *, table: str, bucket: str, key_arn: str
    ) -> None:
        self._db = dynamodb
        self._s3 = s3
        self._table = table
        self._bucket = bucket
        self._key = key_arn

    def handle(self, event: Any) -> str:
        """The outcome, as a code (for tests and the log)."""
        try:
            task_id, run_id, run_sk = tr.valid_event(event)
        except ValueError:
            logger.warning("task report: event rejected")
            return "rejected"
        key = {"PK": {"S": f"AUTO#{task_id}"}, "SK": {"S": run_sk}}
        item = self._db.get_item(
            TableName=self._table,
            Key=key,
            ConsistentRead=True,
            ProjectionExpression=", ".join(f"#a{i}" for i in range(len(_ATTRIBUTES))),
            ExpressionAttributeNames={f"#a{i}": name for i, name in enumerate(_ATTRIBUTES)},
        ).get("Item")
        if not item or _s(item, "run_id") != run_id or _s(item, "report_status") != GENERATING:
            # Generated already, or not asked: a second delivery changes nothing.
            logger.info("task report: nothing to do for run %s", run_id)
            return "skipped"
        try:
            meta_raw = json.loads(_s(item, "report_meta") or "{}")
            kind, data, info = tr.load(_s(item, "report_data") or "")
            meta = _meta(meta_raw, run_id, item)
            object_key = tr.object_key(meta_raw["owner_id"], task_id, run_id, meta.file)
        except (tr.InvalidReportError, ValueError, KeyError, TypeError):
            return self._end(key, run_id, "failed", reason="data")
        try:
            pdf = render(kind, data, info, meta, _steps(_s(item, "steps")))
        except RenderError:
            logger.exception("task report: run %s could not be drawn", run_id)
            return self._end(key, run_id, "failed", reason="render")
        if len(pdf.content) > tr.MAX_PDF_BYTES:
            return self._end(key, run_id, "failed", reason="size")
        self._s3.put_object(
            Bucket=self._bucket,
            Key=object_key,
            Body=pdf.content,
            ContentType="application/pdf",
            ServerSideEncryption="aws:kms",
            SSEKMSKeyId=self._key,
            BucketKeyEnabled=True,
        )
        return self._end(key, run_id, "ready", pages=pdf.pages, size=len(pdf.content))

    def _end(
        self,
        key: dict[str, Any],
        run_id: str,
        status: str,
        *,
        reason: str | None = None,
        pages: int | None = None,
        size: int | None = None,
    ) -> str:
        values: dict[str, Any] = {":s": {"S": status}, ":g": {"S": GENERATING}}
        sets = ["report_status = :s"]
        if reason:
            values[":r"] = {"S": reason}
            sets.append("report_reason = :r")
        if pages is not None and size is not None:
            values[":p"] = {"N": str(pages)}
            values[":b"] = {"N": str(size)}
            sets += ["report_pages = :p", "report_bytes = :b"]
        try:
            self._db.update_item(
                TableName=self._table,
                Key=key,
                UpdateExpression="SET " + ", ".join(sets),
                ConditionExpression="report_status = :g",
                ExpressionAttributeValues=values,
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return "skipped"
            raise
        outcome = status if not reason else f"{status}:{reason}"
        logger.info("task report: run %s %s", run_id, outcome)
        return outcome


def _s(item: dict[str, Any], name: str) -> str | None:
    value = item.get(name)
    return value["S"] if isinstance(value, dict) and "S" in value else None


def _steps(raw: str | None) -> list[dict[str, str]]:
    try:
        loaded = json.loads(raw or "[]")
    except ValueError:
        return []
    if not isinstance(loaded, list):
        return []
    return [
        {"text": str(s.get("text", ""))[:2000], "tool": str(s.get("tool", ""))[:64]}
        for s in loaded[:20]
        if isinstance(s, dict)
    ]


def _meta(raw: Any, run_id: str, item: dict[str, Any]) -> Meta:
    if not isinstance(raw, dict):
        raise TypeError("no meta")
    start, end = _s(item, "anomaly_start"), _s(item, "anomaly_end")
    return Meta(
        task=str(raw["task"])[:48],
        agent=str(raw["agent"])[:64],
        owner=str(raw["owner"])[:254],
        run_id=run_id,
        file=str(raw["file"]),
        generated_at=datetime.fromisoformat(str(raw["generated_at"])),
        timezone=raw.get("timezone") if isinstance(raw.get("timezone"), str) else None,
        keep_until=date.fromisoformat(str(raw["keep_until"])),
        anomaly_id=_s(item, "anomaly_id"),
        anomaly_start=date.fromisoformat(start) if start else None,
        anomaly_end=date.fromisoformat(end) if end else None,
    )


_reports: Reports | None = None


def lambda_handler(event: Any, _context: Any) -> dict[str, str]:
    global _reports  # noqa: PLW0603 - one client per container
    if _reports is None:
        _reports = Reports(
            boto3.client("dynamodb"),
            boto3.client("s3"),
            table=os.environ["TASKS_TABLE"],
            bucket=os.environ["REPORTS_BUCKET"],
            key_arn=os.environ["REPORTS_KEY_ARN"],
        )
    return {"outcome": _reports.handle(event)}
