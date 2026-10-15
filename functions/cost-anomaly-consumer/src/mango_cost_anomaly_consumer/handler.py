"""Lambda entry point of the cost anomaly consumer (EventBridge rule on the Mango bus, D79).

The payer account forwards each AWS Cost Anomaly Detection event to the bus
``Mango-<ns>-CostAnomalies``. This function checks that it is one (``event.py``), finds the
automations subscribed to cost anomalies and starts one run of each, with the anomaly's
identifiers and dates as input. The runs belong to the task engine (D78): it runs them as the
automation's owner, reserves budget first and honors the idempotency key and the daily cap.

A rejected event is not retried: it is counted (alarm), audited with its reason code and
dropped. If the engine or the audit cannot be reached the invocation fails, Lambda retries it
and then sends it to the dead-letter queue, which has its own alarm; retrying is safe because
each run is started with the anomaly's idempotency key.

Nothing of the event but identifiers, reason codes and counts is logged or audited (TM-CA8).
"""

from __future__ import annotations

import json
import logging
import time
from collections import Counter
from collections.abc import Mapping
from functools import cache
from typing import Any

import boto3
from botocore.config import Config

from mango_cost_anomaly_consumer.audit import EVENT_RECEIVED, EVENT_REJECTED, AuditWriter
from mango_cost_anomaly_consumer.config import Settings
from mango_cost_anomaly_consumer.event import RejectedEventError, parse_anomaly_event, safe_event_id
from mango_cost_anomaly_consumer.runs import (
    DAILY_CAP,
    TRIGGER_TYPE,
    RunStarter,
    StartOutcome,
    UnconnectedRunStarter,
    trigger_input,
)

logger = logging.getLogger()
logger.setLevel(logging.INFO)

METRIC_NAMESPACE = "Mango/CostAnomalies"
METRIC_DIMENSION = "Installation"
METRICS = ("Received", "Rejected", "NotConnected", *(o.value for o in StartOutcome))
"""What becomes a CloudWatch metric; ``Rejected`` has an alarm (TM-CA1)."""

_CLIENT_CONFIG = Config(
    retries={"mode": "standard", "max_attempts": 3}, connect_timeout=3, read_timeout=10
)


def metrics_record(namespace: str, stats: Counter[str], now: int) -> dict[str, Any]:
    """Embedded metric format: CloudWatch Logs turns this log line into metrics."""
    values = {name: stats[name] for name in METRICS}
    return {
        "_aws": {
            "Timestamp": now * 1000,
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


def consume(
    event: Mapping[str, object], settings: Settings, runs: RunStarter, audit: AuditWriter
) -> Counter[str]:
    """Validate one event and start the runs it triggers; the counts of what happened."""
    stats: Counter[str] = Counter()
    try:
        trigger = parse_anomaly_event(event, settings.management_account_id)
    except RejectedEventError as exc:
        stats["Rejected"] += 1
        audit.emit(
            EVENT_REJECTED, {"reason": exc.reason, "aws_event_id": safe_event_id(event.get("id"))}
        )
        logger.warning(json.dumps({"event": "cost_anomaly.rejected", "reason": exc.reason}))
        return stats

    stats["Received"] += 1
    if not runs.connected:
        stats["NotConnected"] += 1
    subscriptions = runs.subscriptions(TRIGGER_TYPE) if runs.connected else ()
    payload = trigger_input(trigger)
    outcomes: dict[str, str] = {}
    for subscription in subscriptions:
        outcome = runs.start(subscription, payload, trigger.idempotency_key, DAILY_CAP)
        stats[outcome.value] += 1
        outcomes[subscription.automation_id] = outcome.value
    audit.emit(
        EVENT_RECEIVED,
        {
            "anomaly_id": trigger.anomaly_id,
            "aws_event_id": trigger.event_id,
            "anomaly_start_date": trigger.start_date.isoformat(),
            "anomaly_end_date": trigger.end_date.isoformat(),
            "engine_connected": runs.connected,
            "automations": len(subscriptions),
            "outcomes": outcomes,
        },
    )
    return stats


@cache
def _wiring() -> tuple[Settings, RunStarter, AuditWriter]:
    settings = Settings.from_env()
    audit = AuditWriter(
        boto3.client("firehose", config=_CLIENT_CONFIG),
        settings.audit_stream,
        boto3.client("dynamodb", config=_CLIENT_CONFIG),
        settings.audit_index_table,
    )
    # Replaced by the adapter over the task engine when D78 is integrated.
    return settings, UnconnectedRunStarter(), audit


def lambda_handler(event: Mapping[str, object], _context: Any) -> dict[str, int]:
    settings, runs, audit = _wiring()
    stats = consume(event, settings, runs, audit)
    # Printed as-is (not through `logging`) so the `_aws` key stays at the root of the line.
    print(json.dumps(metrics_record(settings.namespace, stats, int(time.time()))))
    logger.info(json.dumps({"event": "cost_anomaly.summary", **stats}))
    return dict(stats)
