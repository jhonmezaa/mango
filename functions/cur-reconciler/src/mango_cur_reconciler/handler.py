"""Lambda entry point of the CUR reconciler (EventBridge Scheduler, once a day; D104 (7)).

Each run reads what the bill (the CUR 2.0 export, through Athena) charged for Bedrock on each
closed day of the last 35, and compares it with what Mango counted:

* every role ``Mango-<ns>-agent-<id>`` with the day counter ``DAY#AGENT#<id>``;
* every model token of the bill with the organization's ``DAY#ORG``.

A closed day is two days ago or older: CUR takes up to a day to bring a day's usage and revises
the month. A day of an agent deviates when the difference passes both thresholds of the
configuration; any deviation sets off the ``Cur-reconciler-findings`` alarm.

It only reads: no budget or counter changes (D41). Every run is audited (``cur.reconciled``),
with one of three statuses:

* ``reconciled``: compared;
* ``no_data``: the bill has nothing for the window (the payer's manual step is not done yet, or
  nothing used Bedrock): no alarm;
* ``unexpected_rows``: the bill brings rows of another account or of a product that is not
  Bedrock. Nothing is compared, and the alarm goes off: the export lacks its query (TM-CUR1).

If Athena or the table cannot be read, or the audit event cannot be written, the invocation
fails: Lambda retries it and then sends the event to the dead-letter queue, which has its own
alarm.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from functools import cache
from typing import TYPE_CHECKING, Any, Final

import boto3
from botocore.config import Config

from mango_core import usage_days
from mango_core.playground import PLAYGROUND_ID
from mango_cur_reconciler import query
from mango_cur_reconciler.audit import EVENT_RECONCILED, AuditWriter
from mango_cur_reconciler.compare import MAX_DEVIATIONS, Comparison, Sorted, compare, sort
from mango_cur_reconciler.config import Settings

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

logger = logging.getLogger()
logger.setLevel(logging.INFO)

METRIC_NAMESPACE: Final = "Mango/CurReconciler"
METRIC_DIMENSION: Final = "Installation"
FIRST_DAY_AGO: Final = 35
LAST_DAY_AGO: Final = 2
"""The window: from 35 days ago to two days ago, both included."""
MAX_AGENTS: Final = 500
"""Agents whose counters one run reads; the rest are counted, not compared."""
QUERY_MARGIN_SECONDS: Final = 60.0
"""Time kept, after the query, to read the counters and write the audit event."""

STATUS_RECONCILED: Final = "reconciled"
STATUS_NO_DATA: Final = "no_data"
STATUS_UNEXPECTED: Final = "unexpected_rows"

_CLIENT_CONFIG = Config(
    retries={"mode": "standard", "max_attempts": 3}, connect_timeout=3, read_timeout=20
)
_ZERO: Final = Decimal(0)
_DAY: Final = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _usd(amount: Decimal) -> str:
    return str(amount.quantize(Decimal("0.000001")))


def window(today: date) -> list[str]:
    first = today - timedelta(days=FIRST_DAY_AGO)
    return [
        (first + timedelta(days=offset)).isoformat()
        for offset in range(FIRST_DAY_AGO - LAST_DAY_AGO + 1)
    ]


@dataclass(frozen=True)
class Report:
    status: str
    detail: dict[str, Any]
    findings: int
    deviations: int
    unexpected: int

    def metrics(self, namespace: str, now: datetime) -> dict[str, Any]:
        """Embedded metric format: CloudWatch Logs turns this log line into metrics."""
        values = {
            "Findings": self.findings,
            "Deviations": self.deviations,
            "UnexpectedRows": self.unexpected,
            "NoData": 1 if self.status == STATUS_NO_DATA else 0,
        }
        return {
            "_aws": {
                "Timestamp": int(now.timestamp() * 1000),
                "CloudWatchMetrics": [
                    {
                        "Namespace": METRIC_NAMESPACE,
                        "Dimensions": [[METRIC_DIMENSION]],
                        "Metrics": [{"Name": name, "Unit": "Count"} for name in values],
                    }
                ],
            },
            METRIC_DIMENSION: namespace,
            **values,
        }


class CurReconciler:
    def __init__(
        self,
        settings: Settings,
        *,
        dynamodb: DynamoDBClient,
        athena: query.Athena,
        audit: AuditWriter,
    ) -> None:
        self._settings = settings
        self._db = dynamodb
        self._athena = athena
        self._audit = audit

    def run(self, now: datetime, remaining_seconds: Callable[[], float]) -> Report:
        s = self._settings
        days = window(now.astimezone(UTC).date())
        first, last = days[0], days[-1]
        rows = self._athena.run(
            query.sql(s.database, s.table),
            query.parameters(first, last),
            timeout_seconds=max(remaining_seconds() - QUERY_MARGIN_SECONDS, 1.0),
        )
        base: dict[str, Any] = {
            "first_day": first,
            "last_day": last,
            "threshold_percent": str(s.threshold_percent),
            "threshold_usd": str(s.threshold_usd),
        }
        if not rows:
            report = Report(STATUS_NO_DATA, {**base, "status": STATUS_NO_DATA}, 0, 0, 0)
            return self._finish(report, now)
        sorted_rows = sort(
            rows, account=s.account_id, products=s.product_codes, prefix=s.agent_role_prefix
        )
        if sorted_rows.unexpected:
            # Nothing of what was read is compared or described: only how much there was.
            report = Report(
                STATUS_UNEXPECTED,
                {
                    **base,
                    "status": STATUS_UNEXPECTED,
                    "line_items": sorted_rows.line_items,
                    "unexpected_line_items": sorted_rows.unexpected,
                },
                findings=1,
                deviations=0,
                unexpected=sorted_rows.unexpected,
            )
            return self._finish(report, now)
        return self._finish(self._reconcile(sorted_rows, days, base), now)

    def _reconcile(self, sorted_rows: Sorted, days: list[str], base: dict[str, Any]) -> Report:
        s = self._settings
        first, last = days[0], days[-1]
        names = sorted({*sorted_rows.agents, PLAYGROUND_ID})
        skipped = max(len(names) - MAX_AGENTS, 0)
        names = names[:MAX_AGENTS]
        counted: dict[str, dict[str, Decimal]] = {}
        starts: list[str] = []
        for agent in names:
            key = usage_days.agent_key(agent)
            series = usage_days.read(self._db, s.budgets_table, key, first, last)
            counted[agent] = {d.day: d.spent for d in series}
            start = self._first_day(key)
            if start is not None:
                starts.append(start)
        # The first counter's day may be partial (the release that brought it was installed
        # that day): the comparison starts the day after.
        since = _day_after(min(starts)) if starts else None
        org = {
            d.day: d.spent
            for d in usage_days.read(self._db, s.budgets_table, usage_days.ORG_KEY, first, last)
        }
        org_start = self._first_day(usage_days.ORG_KEY)
        org_since = _day_after(org_start) if org_start else None
        result = compare(
            sorted_rows,
            window=days,
            since=since,
            org_since=org_since,
            org=org,
            agents=counted,
            percent=s.threshold_percent,
            usd=s.threshold_usd,
        )
        detail = {
            **base,
            "status": STATUS_RECONCILED,
            **_described(result, sorted_rows),
            "since": since or "",
            "org_since": org_since or "",
            "agents_not_compared": skipped,
        }
        return Report(
            STATUS_RECONCILED,
            detail,
            findings=len(result.deviations),
            deviations=len(result.deviations),
            unexpected=0,
        )

    def _first_day(self, key: str) -> str | None:
        page = self._db.query(
            TableName=self._settings.budgets_table,
            KeyConditionExpression="PK = :pk",
            ProjectionExpression="SK",
            ExpressionAttributeValues={":pk": {"S": key}},
            Limit=1,
            ScanIndexForward=True,
        )
        for item in page.get("Items", []):
            day = item.get("SK", {}).get("S")
            if isinstance(day, str) and _DAY.fullmatch(day):
                return day
        return None

    def _finish(self, report: Report, now: datetime) -> Report:
        self._audit.emit(EVENT_RECONCILED, report.detail, now)
        return report


def _day_after(day: str) -> str:
    return (date.fromisoformat(day) + timedelta(days=1)).isoformat()


def _described(result: Comparison, sorted_rows: Sorted) -> dict[str, Any]:
    return {
        "days_compared": len(result.days),
        "org_days_compared": result.org_days,
        "agents": result.agents,
        "deviations": len(result.deviations),
        "deviation_list": [
            {
                "day": d.day,
                "agent": d.agent,
                "mango_usd": _usd(d.mango_usd),
                "cur_usd": _usd(d.cur_usd),
            }
            for d in result.deviations[:MAX_DEVIATIONS]
        ],
        "mango_usd": _usd(result.mango_usd),
        "cur_usd": _usd(result.cur_usd),
        "agents_mango_usd": _usd(result.agents_mango_usd),
        "agents_cur_usd": _usd(result.agents_cur_usd),
        "unattributed_usd": {
            reason: _usd(amount) for reason, amount in sorted(sorted_rows.unattributed.items())
        },
        "line_items": sorted_rows.line_items,
    }


def handle(
    reconciler: CurReconciler,
    settings: Settings,
    now: datetime,
    remaining_seconds: Callable[[], float],
) -> dict[str, Any]:
    report = reconciler.run(now, remaining_seconds)
    # Printed as-is (not through `logging`) so the `_aws` key stays at the root of the line.
    print(json.dumps(report.metrics(settings.namespace, now)))
    summary = {
        "event": "cur_reconciler.summary",
        "status": report.status,
        "deviations": report.deviations,
        "unexpected": report.unexpected,
    }
    logger.info(json.dumps(summary))
    return summary


@cache
def _reconciler() -> tuple[CurReconciler, Settings]:
    settings = Settings.from_env()
    dynamodb = boto3.client("dynamodb", config=_CLIENT_CONFIG)
    return (
        CurReconciler(
            settings,
            dynamodb=dynamodb,
            athena=query.Athena(boto3.client("athena", config=_CLIENT_CONFIG), settings.workgroup),
            audit=AuditWriter(
                boto3.client("firehose", config=_CLIENT_CONFIG),
                settings.audit_stream,
                dynamodb,
                settings.audit_index_table,
            ),
        ),
        settings,
    )


def lambda_handler(_event: object, context: Any) -> dict[str, Any]:
    reconciler, settings = _reconciler()
    return handle(
        reconciler,
        settings,
        datetime.now(UTC),
        lambda: context.get_remaining_time_in_millis() / 1000,
    )
