"""Lambda entry point of the daily reconciliation (EventBridge rule, asynchronous).

Reads the ``Agents`` table, the harnesses and the agent roles of the installation, compares
them and reports: one log line per finding, and the counts as CloudWatch metrics (embedded
metric format, so the function needs no ``PutMetricData``). It also reports the runtimes of
MCP packs that are not in the pack network (TM-E7). It changes nothing: what a retired agent
leaves behind is removed by the deprovisioner, and reported here if that did not happen.

If any read fails the invocation fails: Lambda retries it and then sends the event to the
dead-letter queue, which has its own alarm. A partial run never reports "no findings".
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from functools import cache
from typing import Any

import boto3
from botocore.config import Config

from mango_reconciler.checks import Report, Severity, evaluate
from mango_reconciler.config import Settings
from mango_reconciler.inventory import Harnesses, HarnessVersion, PackRuntimes, Roles
from mango_reconciler.snapshot import read_snapshot

logger = logging.getLogger()
logger.setLevel(logging.INFO)

METRIC_NAMESPACE = "Mango/Reconciler"
METRIC_DIMENSION = "Installation"
MAX_REPORTED_FINDINGS = 200
"""Findings logged and returned per run; the metrics always count all of them."""

_CLIENT_CONFIG = Config(
    retries={"mode": "standard", "max_attempts": 5}, connect_timeout=5, read_timeout=20
)


class Reconciler:
    def __init__(self, settings: Settings, *, dynamodb: Any, agentcore: Any, iam: Any) -> None:
        self._settings = settings
        self._db = dynamodb
        self._harnesses = Harnesses(agentcore, settings)
        self._roles = Roles(iam, settings)
        self._pack_runtimes = PackRuntimes(agentcore, settings)

    def run(self, now: datetime) -> Report:
        settings = self._settings
        snapshot = read_snapshot(self._db, settings.agents_table)
        harnesses = self._harnesses.list()
        deployed: dict[str, HarnessVersion | None] = {}
        for harness in harnesses:
            pointer = snapshot.pointers.get(harness.agent_id) if harness.agent_id else None
            if pointer is None or pointer.harness_arn != harness.arn:
                continue
            deployed[harness.harness_id] = (
                harness.latest
                if harness.latest.version == pointer.harness_version
                else self._harnesses.version(harness.harness_id, pointer.harness_version)
            )
        return evaluate(
            settings,
            snapshot,
            harnesses=harnesses,
            deployed=deployed,
            roles=self._roles.list(),
            pack_runtimes=self._pack_runtimes.list(),
            now=now,
        )


def metrics_record(namespace: str, report: Report, now: datetime) -> dict[str, Any]:
    """Embedded metric format: CloudWatch Logs turns this log line into metrics."""
    values = {
        "Runs": 1,
        "Findings": report.alarming,
        "DriftFindings": report.count(Severity.DRIFT),
        "QuotaFindings": report.count(Severity.QUOTA),
        "RetiredAgentResources": report.count(Severity.CLEANUP),
        **report.stats,
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


def handle(reconciler: Reconciler, settings: Settings, now: datetime) -> dict[str, Any]:
    report = reconciler.run(now)
    reported = [f.as_dict() for f in report.findings[:MAX_REPORTED_FINDINGS]]
    for finding in reported:
        logger.warning(json.dumps({"event": "reconciler.finding", **finding}))
    # Printed as-is (not through `logging`) so the `_aws` key stays at the root of the line.
    print(json.dumps(metrics_record(settings.namespace, report, now)))
    summary = {
        "findings": report.alarming,
        "cleanup": report.count(Severity.CLEANUP),
        "stats": dict(report.stats),
    }
    logger.info(json.dumps({"event": "reconciler.summary", **summary}))
    return {**summary, "reported": reported}


@cache
def _reconciler() -> tuple[Reconciler, Settings]:
    settings = Settings.from_env()
    return (
        Reconciler(
            settings,
            dynamodb=boto3.client("dynamodb", config=_CLIENT_CONFIG),
            agentcore=boto3.client("bedrock-agentcore-control", config=_CLIENT_CONFIG),
            iam=boto3.client("iam", config=_CLIENT_CONFIG),
        ),
        settings,
    )


def lambda_handler(_event: object, _context: Any) -> dict[str, Any]:
    reconciler, settings = _reconciler()
    return handle(reconciler, settings, datetime.now(UTC))
