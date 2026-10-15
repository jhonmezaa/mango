"""Validation of the AWS Cost Anomaly Detection event (``aws.ce`` / ``Anomaly Detected``).

The event reaches the Mango bus from the payer account (D79). Everything in it but its shape
is untrusted: account names, tag values (``dimensionValue``), monitor names and usage types are
written by whoever can name or tag things in the organization. Only the identifiers and dates
are kept, each checked against the format AWS documents; no free text leaves this module
(TM-CA3).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

SOURCE = "aws.ce"
DETAIL_TYPE = "Anomaly Detected"
MAX_DURATION_DAYS = 92
"""Longest anomaly accepted: longer windows are not an anomaly any person would act on."""

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_UUID_RE = re.compile(rf"^{_UUID}$")
_ACCOUNT_RE = re.compile(r"^\d{12}$")
_EVENT_ID_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
_DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})T00:00:00Z$")
_TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


class RejectedEventError(Exception):
    """The event is not a Cost Anomaly Detection event of the payer account.

    ``reason`` is a fixed code, safe to log and audit: never a value from the event.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class AnomalyTrigger:
    """What a run may learn from the event: identifiers and dates, nothing written by people."""

    event_id: str
    """The EventBridge id: a new one each time AWS repeats the anomaly. For the audit only."""
    anomaly_id: str
    monitor_arn: str
    start_date: date
    end_date: date
    occurred_at: str
    """When AWS emitted the event, ``YYYY-MM-DDTHH:MM:SSZ``."""


def _text(value: object, reason: str) -> str:
    if not isinstance(value, str):
        raise RejectedEventError(reason)
    return value


def _day(value: object, reason: str) -> date:
    match = _DATE_RE.fullmatch(_text(value, reason))
    if not match:
        raise RejectedEventError(reason)
    try:
        return date.fromisoformat(match.group(1))
    except ValueError:
        raise RejectedEventError(reason) from None


def safe_event_id(value: object) -> str | None:
    """The EventBridge id of an event, only if it has the shape of one: never free text."""
    return value if isinstance(value, str) and _EVENT_ID_RE.fullmatch(value) else None


def monitor_arn_re(management_account_id: str) -> re.Pattern[str]:
    if not _ACCOUNT_RE.fullmatch(management_account_id):
        raise ValueError("invalid management account id")
    return re.compile(rf"^arn:aws:ce::{management_account_id}:anomalymonitor/{_UUID}$")


def parse_anomaly_event(
    event: Mapping[str, object], management_account_id: str, today: date | None = None
) -> AnomalyTrigger:
    """The trigger of a valid event, or :class:`RejectedEventError` with a fixed reason code."""
    if event.get("source") != SOURCE or event.get("detail-type") != DETAIL_TYPE:
        raise RejectedEventError("not_an_anomaly_event")
    if event.get("account") != management_account_id:
        raise RejectedEventError("not_the_payer_account")
    event_id = _text(event.get("id"), "bad_event_id")
    if not _EVENT_ID_RE.fullmatch(event_id):
        raise RejectedEventError("bad_event_id")
    detail = event.get("detail")
    if not isinstance(detail, Mapping):
        raise RejectedEventError("no_detail")

    anomaly_id = _text(detail.get("anomalyId"), "bad_anomaly_id")
    if not _UUID_RE.fullmatch(anomaly_id):
        raise RejectedEventError("bad_anomaly_id")
    monitor_arn = _text(detail.get("monitorArn"), "bad_monitor")
    if not monitor_arn_re(management_account_id).fullmatch(monitor_arn):
        raise RejectedEventError("bad_monitor")
    # The monitor is the one resource AWS names in the event.
    if event.get("resources") != [monitor_arn]:
        raise RejectedEventError("bad_resources")
    if detail.get("accountId") not in (None, management_account_id):
        raise RejectedEventError("not_the_payer_account")

    start = _day(detail.get("anomalyStartDate"), "bad_dates")
    end = _day(detail.get("anomalyEndDate"), "bad_dates")
    if end < start or (end - start).days > MAX_DURATION_DAYS:
        raise RejectedEventError("bad_dates")
    # A day of slack: AWS dates the anomaly in UTC and the clock of the event may run ahead.
    if start > (today or datetime.now(UTC).date()) + timedelta(days=1):
        raise RejectedEventError("bad_dates")
    occurred_at = _text(event.get("time"), "bad_time")
    if not _TIME_RE.fullmatch(occurred_at):
        raise RejectedEventError("bad_time")
    try:
        datetime.strptime(occurred_at, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        raise RejectedEventError("bad_time") from None
    return AnomalyTrigger(event_id, anomaly_id, monitor_arn, start, end, occurred_at)
