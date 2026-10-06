"""Lambda entry point of the budget reconciler (EventBridge rule every 5 minutes, D73).

A chat turn whose end mango-api never knew (it stopped reading the agent, or its task died)
keeps its budget reservation held and leaves a pending record. This function reads the
records that are due, asks the AgentCore traces what each turn's session spent and closes
the turn: the real cost is charged and the rest of the reservation is released. A turn with
no readable trace 15 minutes after its time limit is charged its whole reservation, and the
audit event says so.

A turn whose traces cannot be read yet is left for the next run: nothing is charged blindly
before its deadline. Closing is one transaction conditioned on the record, so two runs at
once, or a run after one that failed halfway, never charge or release twice. The record is
only deleted after its audit event is written; a run that died in between writes it again.

If the records cannot be read, or an audit event cannot be written, the invocation fails:
Lambda retries it and then sends the event to the dead-letter queue, which has its own alarm.
"""

from __future__ import annotations

import json
import logging
import time
from collections import Counter
from collections.abc import Callable
from functools import cache
from typing import Any

import boto3
from botocore.config import Config

from mango_budget_reconciler.audit import EVENT_RECONCILED, AuditWriter, reconciled_detail
from mango_budget_reconciler.config import SPANS_LOG_GROUP, Settings
from mango_budget_reconciler.traces import TraceQueryError, Traces
from mango_core import budget_turns
from mango_core.budget_turns import (
    BASIS_NOT_INVOKED,
    BASIS_PARTIAL,
    BASIS_RESERVATION,
    BASIS_TRACE,
    STATE_SETTLED,
    Outcome,
    PendingTurn,
    TurnConflictError,
    token_cost,
)

logger = logging.getLogger()
logger.setLevel(logging.INFO)

METRIC_NAMESPACE = "Mango/BudgetReconciler"
METRIC_DIMENSION = "Installation"
METRICS = ("ChargedByReservation", "ChargedByTrace", "Waiting", "TraceQueryErrors")
"""What becomes a CloudWatch metric (each one is billed); every count is in the summary line."""
MAX_TURNS_PER_RUN = 200
"""Turns closed per run, oldest first; the rest wait for the next one."""
MIN_REMAINING_SECONDS = 30.0
"""A run stops taking turns when the invocation has less time left than this."""

REASON_NO_TRACE = "no_trace"
REASON_UNREADABLE = "trace_unreadable"
REASON_QUERY_FAILED = "trace_query_failed"

_CLIENT_CONFIG = Config(
    retries={"mode": "standard", "max_attempts": 3}, connect_timeout=3, read_timeout=10
)


class BudgetReconciler:
    def __init__(
        self, settings: Settings, *, dynamodb: Any, traces: Traces, audit: AuditWriter
    ) -> None:
        self._table = settings.budgets_table
        self._db = dynamodb
        self._traces = traces
        self._audit = audit

    def _outcome(self, turn: PendingTurn, now: int, stats: Counter[str]) -> Outcome | None:
        """How to close ``turn`` now; None to leave it for a later run."""
        if not turn.session_id:
            # The session is recorded before the agent is called: this turn never was.
            return Outcome(BASIS_NOT_INVOKED)
        expired = now >= turn.charge_at
        try:
            reading = self._traces.read(turn.session_id, turn.started_at, now)
        except TraceQueryError:
            stats["TraceQueryErrors"] += 1
            return Outcome(BASIS_RESERVATION, reason=REASON_QUERY_FAILED) if expired else None
        if reading.unreadable:
            return Outcome(BASIS_RESERVATION, reason=REASON_UNREADABLE) if expired else None
        if reading.invocations == 0:
            return Outcome(BASIS_RESERVATION, reason=REASON_NO_TRACE) if expired else None
        traced = token_cost(reading.usage, turn.price)
        return Outcome(
            # mango-api counted more than the traces show: what it charged stands.
            BASIS_TRACE if traced >= turn.charged else BASIS_PARTIAL,
            usage=reading.usage,
            invocations=reading.invocations,
        )

    def _finish(self, turn: PendingTurn, stats: Counter[str]) -> None:
        """Audit a settled turn and delete its record, in that order."""
        outcome = turn.outcome
        self._audit.emit(EVENT_RECONCILED, reconciled_detail(turn))
        budget_turns.forget(self._db, self._table, turn)
        basis = outcome.basis if outcome else ""
        stats["Closed"] += 1
        stats["ChargedByReservation"] += basis == BASIS_RESERVATION
        stats["ChargedByTrace"] += basis in (BASIS_TRACE, BASIS_PARTIAL)
        stats["NotInvoked"] += basis == BASIS_NOT_INVOKED
        logger.info(
            json.dumps(
                {
                    "event": "budget_reconciler.closed",
                    "turn": turn.turn_id,
                    "basis": basis,
                    "reason": outcome.reason if outcome else "",
                }
            )
        )

    def run(self, now: int, remaining_seconds: Callable[[], float]) -> Counter[str]:
        stats: Counter[str] = Counter(
            dict.fromkeys(
                (
                    "Closed",
                    "ChargedByTrace",
                    "ChargedByReservation",
                    "NotInvoked",
                    "Waiting",
                    "Conflicts",
                    "TraceQueryErrors",
                    "InvalidRecords",
                ),
                0,
            )
        )
        turns, invalid = budget_turns.due(self._db, self._table, now, limit=MAX_TURNS_PER_RUN)
        stats["InvalidRecords"] = invalid
        for index, turn in enumerate(turns):
            if remaining_seconds() < MIN_REMAINING_SECONDS:
                stats["Waiting"] += len(turns) - index
                break
            if turn.state == STATE_SETTLED:
                # A run closed it and died before auditing it.
                self._finish(turn, stats)
                continue
            outcome = self._outcome(turn, now, stats)
            if outcome is None:
                stats["Waiting"] += 1
                continue
            try:
                closed = budget_turns.close(self._db, self._table, turn, outcome)
            except TurnConflictError:
                closed = None
            if closed is None:
                # mango-api or another run got there first, or the budget items were busy:
                # whatever is still pending is read again by the next run.
                stats["Conflicts"] += 1
                continue
            self._finish(closed, stats)
        return stats


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


def handle(
    reconciler: BudgetReconciler,
    settings: Settings,
    now: int,
    remaining_seconds: Callable[[], float],
) -> dict[str, int]:
    stats = reconciler.run(now, remaining_seconds)
    # Printed as-is (not through `logging`) so the `_aws` key stays at the root of the line.
    print(json.dumps(metrics_record(settings.namespace, stats, now)))
    logger.info(json.dumps({"event": "budget_reconciler.summary", **stats}))
    return dict(stats)


@cache
def _reconciler() -> tuple[BudgetReconciler, Settings]:
    settings = Settings.from_env()
    dynamodb = boto3.client("dynamodb", config=_CLIENT_CONFIG)
    return (
        BudgetReconciler(
            settings,
            dynamodb=dynamodb,
            traces=Traces(boto3.client("logs", config=_CLIENT_CONFIG), SPANS_LOG_GROUP),
            audit=AuditWriter(
                boto3.client("firehose", config=_CLIENT_CONFIG),
                settings.audit_stream,
                dynamodb,
                settings.audit_index_table,
            ),
        ),
        settings,
    )


def lambda_handler(_event: object, context: Any) -> dict[str, int]:
    reconciler, settings = _reconciler()
    return handle(
        reconciler,
        settings,
        int(time.time()),
        lambda: context.get_remaining_time_in_millis() / 1000,
    )
