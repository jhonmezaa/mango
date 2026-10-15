"""How the consumer starts runs: a minimal interface over the task engine (D78).

The engine (automations, runs, the owner's identity, budget) belongs to the tasks work of
milestone 3. Until its interface is fixed, the consumer depends only on :class:`RunStarter`;
the integration replaces :class:`UnconnectedRunStarter` with an adapter over the engine. The
engine is expected to honor the idempotency key and the daily cap, to run as the
automation's owner, to reserve budget before invoking (D73) and to refuse automations whose
owner lost access or is no longer central (D26, D79).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

from mango_cost_anomaly_consumer.event import AnomalyTrigger

TRIGGER_TYPE = "cost_anomaly"
DAILY_CAP = 5
"""Runs a single automation may start from anomalies in a day (D79). The rest are skipped."""


class StartOutcome(StrEnum):
    STARTED = "started"
    DUPLICATE = "duplicate"
    """A run for this anomaly and automation already exists."""
    CAPPED = "capped"
    """The automation reached :data:`DAILY_CAP` today: recorded as skipped, nothing invoked."""
    NOT_ELIGIBLE = "not_eligible"
    """Paused, retired, owner without access or not central, agent not published."""


@dataclass(frozen=True)
class Subscription:
    automation_id: str


class RunStarter(Protocol):
    @property
    def connected(self) -> bool:
        """False while no task engine is wired in: nothing can be started."""
        ...

    def subscriptions(self, trigger_type: str) -> Sequence[Subscription]:
        """Active automations whose trigger is ``trigger_type``."""
        ...

    def start(
        self,
        subscription: Subscription,
        trigger_input: dict[str, str],
        idempotency_key: str,
        daily_cap: int,
    ) -> StartOutcome:
        """Start one run, or say why not. Raises if the engine cannot be reached."""
        ...


def trigger_input(trigger: AnomalyTrigger) -> dict[str, str]:
    """What the run receives from the event (D79): identifiers and dates only. The agent reads
    amounts and root causes itself, with its owner's scope, through its read-only tool."""
    return {
        "type": TRIGGER_TYPE,
        "anomaly_id": trigger.anomaly_id,
        "monitor_arn": trigger.monitor_arn,
        "anomaly_start_date": trigger.start_date.isoformat(),
        "anomaly_end_date": trigger.end_date.isoformat(),
    }


class UnconnectedRunStarter:
    """Stand-in until the task engine is integrated: no automation exists, nothing starts."""

    connected = False

    def subscriptions(self, trigger_type: str) -> Sequence[Subscription]:
        return ()

    def start(
        self,
        subscription: Subscription,
        trigger_input: dict[str, str],
        idempotency_key: str,
        daily_cap: int,
    ) -> StartOutcome:
        raise RuntimeError("no task engine is connected")
