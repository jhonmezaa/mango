"""How the consumer hands an anomaly to the task engine (D78): one event message per anomaly.

The consumer puts one message on the queue ``Mango-<ns>-TaskRuns``, built by
``mango_core.task_runs.event_message``, and ends. mango-api reads it, finds the active
automations subscribed to ``cost_anomaly`` and starts one run of each as its owner, with the
event id as idempotency key (run id = hash of automation and event id). The rules of D79 on who
may subscribe (central people only) and how often (five runs a day per automation) live there,
in mango-api, not here.
"""

from __future__ import annotations

from typing import Any, Protocol

from mango_core import task_runs
from mango_cost_anomaly_consumer.event import AnomalyTrigger

EVENT_TYPE = "cost_anomaly"


class RunQueue(Protocol):
    def send(self, body: str) -> None:
        """Queue one message for the engine. Raises if the queue cannot be reached."""
        ...


def event_data(trigger: AnomalyTrigger) -> dict[str, str]:
    """What the engine receives (D79): identifiers and dates only. The agent reads amounts and
    root causes itself, with its owner's scope, through its read-only tool."""
    return {
        "anomaly_id": trigger.anomaly_id,
        "monitor_arn": trigger.monitor_arn,
        "anomaly_start_date": trigger.start_date.isoformat(),
        "anomaly_end_date": trigger.end_date.isoformat(),
    }


def event_message(trigger: AnomalyTrigger) -> str:
    """The body of the message. The event id is the anomaly id, not the EventBridge id: AWS
    repeats the event, with a new EventBridge id, while the anomaly lasts, and the engine starts
    one run per automation and event id."""
    return task_runs.event_message(
        EVENT_TYPE, trigger.anomaly_id, trigger.occurred_at, event_data(trigger)
    )


class SqsRunQueue:
    """The task queue of D78, ``Mango-<ns>-TaskRuns`` (``TASK_RUNS_QUEUE_URL``)."""

    def __init__(self, sqs: Any, queue_url: str) -> None:
        self._sqs = sqs
        self._queue_url = queue_url

    def send(self, body: str) -> None:
        self._sqs.send_message(QueueUrl=self._queue_url, MessageBody=body)
