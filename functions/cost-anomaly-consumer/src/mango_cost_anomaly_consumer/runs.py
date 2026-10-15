"""How the consumer hands an anomaly to the task engine (D78): one event message per anomaly.

The contract of milestone 3 fixes the interface: the consumer puts one message on the queue
``Mango-<ns>-TaskRuns``, built by ``mango_core.task_runs.event_message``, and ends. mango-api
reads it, finds the active automations subscribed to ``cost_anomaly`` and starts one run of
each as its owner, with the event id as idempotency key (run id = hash of automation and event
id). That module is not on this branch yet: the consumer depends only on :class:`RunQueue`,
and the integration replaces :class:`UnconnectedRunQueue` with an adapter that builds the
message with ``event_message`` and sends it to the queue (``TASK_RUNS_QUEUE_URL``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from mango_cost_anomaly_consumer.event import AnomalyTrigger

EVENT_TYPE = "cost_anomaly"


@dataclass(frozen=True)
class EventMessage:
    """The arguments of ``mango_core.task_runs.event_message``."""

    event_type: str
    event_id: str
    occurred_at: str
    data: dict[str, str]


class RunQueue(Protocol):
    @property
    def connected(self) -> bool:
        """False while no task engine is wired in: nothing is queued."""
        ...

    def enqueue(self, message: EventMessage) -> None:
        """Queue one event for the engine. Raises if the queue cannot be reached."""
        ...


def event_message(trigger: AnomalyTrigger) -> EventMessage:
    """What the engine receives (D79): identifiers and dates only. The agent reads amounts and
    root causes itself, with its owner's scope, through its read-only tool.

    The event id is the anomaly id, not the EventBridge id: AWS repeats the event, with a new
    EventBridge id, while the anomaly lasts, and the engine starts one run per automation and
    event id."""
    return EventMessage(
        event_type=EVENT_TYPE,
        event_id=trigger.anomaly_id,
        occurred_at=trigger.occurred_at,
        data={
            "anomaly_id": trigger.anomaly_id,
            "monitor_arn": trigger.monitor_arn,
            "anomaly_start_date": trigger.start_date.isoformat(),
            "anomaly_end_date": trigger.end_date.isoformat(),
        },
    )


class UnconnectedRunQueue:
    """Stand-in until the task engine is integrated: nothing is queued."""

    connected = False

    def enqueue(self, message: EventMessage) -> None:
        raise RuntimeError("no task engine is connected")
