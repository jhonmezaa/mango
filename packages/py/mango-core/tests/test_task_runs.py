"""Messages that start a task run (D78): what mango-api accepts from the queue."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta, timezone

import pytest

from mango_core import task_runs

AUTOMATION = "a" * 32
RUN = "b" * 32
WHEN = datetime(2026, 10, 15, 14, 0, tzinfo=UTC)


def test_a_schedule_input_reads_back_with_the_time_scheduler_puts() -> None:
    body = task_runs.schedule_input(AUTOMATION).replace(
        "<aws.scheduler.scheduled-time>", "2026-10-15T14:00:00Z"
    )
    message = task_runs.parse_message(body)
    assert message == task_runs.ScheduledRun(AUTOMATION, WHEN)


def test_the_same_due_time_always_gives_the_same_run() -> None:
    first = task_runs.ScheduledRun(AUTOMATION, WHEN).run_id
    assert first == task_runs.ScheduledRun(AUTOMATION, WHEN).run_id
    assert task_runs.is_id(first)
    assert first != task_runs.ScheduledRun(AUTOMATION, WHEN + timedelta(days=1)).run_id
    assert first != task_runs.ScheduledRun("c" * 32, WHEN).run_id


def test_a_manual_message_round_trips() -> None:
    message = task_runs.parse_message(task_runs.manual_message(AUTOMATION, RUN))
    assert message == task_runs.ManualRun(AUTOMATION, RUN)


def test_an_event_message_round_trips_in_utc() -> None:
    bogota = timezone(timedelta(hours=-5))
    body = task_runs.event_message(
        "cost_anomaly", "anomaly:1234", datetime(2026, 10, 15, 9, tzinfo=bogota), {"impact": 12.5}
    )
    message = task_runs.parse_message(body)
    assert isinstance(message, task_runs.EventRun)
    assert message.occurred_at == WHEN
    assert message.data == {"impact": 12.5}
    # One event, one run per subscribed automation, whatever times it is delivered.
    assert message.run_id(AUTOMATION) == message.run_id(AUTOMATION)
    assert message.run_id(AUTOMATION) != message.run_id("c" * 32)


@pytest.mark.parametrize(
    ("event_type", "event_id"),
    [
        ("guardduty", "x"),
        ("cost_anomaly", ""),
        ("cost_anomaly", "a b"),
        ("cost_anomaly", "x" * 129),
    ],
)
def test_unknown_events_and_bad_ids_are_refused(event_type: str, event_id: str) -> None:
    with pytest.raises(task_runs.InvalidTaskMessageError):
        task_runs.event_message(event_type, event_id, WHEN, {})


def test_event_data_is_bounded() -> None:
    with pytest.raises(task_runs.InvalidTaskMessageError):
        task_runs.event_message(
            "cost_anomaly", "e1", WHEN, {"x": "y" * task_runs.MAX_EVENT_DATA_BYTES}
        )
    deep: dict[str, object] = {}
    node = deep
    for _ in range(12):
        node["n"] = {}
        node = node["n"]  # type: ignore[assignment]
    with pytest.raises(task_runs.InvalidTaskMessageError):
        task_runs.event_message("cost_anomaly", "e1", WHEN, deep)


def test_a_naive_time_is_refused() -> None:
    with pytest.raises(task_runs.InvalidTaskMessageError):
        task_runs.event_message("cost_anomaly", "e1", datetime(2026, 10, 15), {})


@pytest.mark.parametrize(
    "body",
    [
        "not json",
        "[]",
        json.dumps({"v": 2, "kind": "manual", "automation_id": AUTOMATION, "run_id": RUN}),
        json.dumps({"v": 1, "kind": "manual", "automation_id": AUTOMATION}),
        json.dumps({"v": 1, "kind": "manual", "automation_id": "x", "run_id": RUN}),
        # Nothing more than the fields of its kind: a message never carries an owner.
        json.dumps(
            {"v": 1, "kind": "manual", "automation_id": AUTOMATION, "run_id": RUN, "owner": "u"}
        ),
        json.dumps(
            {
                "v": 1,
                "kind": "schedule",
                "automation_id": AUTOMATION,
                "scheduled_at": "2026-10-15T14:00:00",
            }
        ),
        json.dumps({"v": 1, "kind": "other"}),
        7,
        "x" * (task_runs.MAX_MESSAGE_BYTES + 1),
    ],
)
def test_anything_else_is_refused(body: object) -> None:
    with pytest.raises(task_runs.InvalidTaskMessageError):
        task_runs.parse_message(body)
