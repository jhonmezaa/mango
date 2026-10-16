"""Messages that start the run of a task (D78).

A run of an automation starts from one message in the queue ``Mango-<ns>-TaskRuns``. Three
kinds of trigger leave one:

* ``schedule``: EventBridge Scheduler, with the automation and the time it was due;
* ``manual``: mango-api, when the owner presses «Ejecutar ahora», with the run it created;
* ``event``: the consumer of an event (the cost anomalies of the payer account, D79), with the
  type and the id of the event and its data.

And one kind only mango-api leaves, for itself: ``wait``, an event run that found its task busy
and waits for the previous one (D81). It names the run by its automation and its event, and
carries the random ``wake`` of that wait: only the message whose ``wake`` the run still holds
resumes it, so a copy of it, a stale one or one made up by another sender resumes nothing.

A message never carries authority: mango-api reloads the automation and its owner from the
Tasks table and decides everything again. What it does carry is the idempotency key: the id of
a scheduled or event run is derived from the automation and the due time or the event id, so
SQS delivering a message twice (at least once) does not run the agent twice.

The data of an event is untrusted input (indirect prompt injection): it is bounded here and
reaches the model as data, never as an instruction. Nothing in a message is ever logged.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

VERSION: Final = 1
KIND_SCHEDULE: Final = "schedule"
KIND_MANUAL: Final = "manual"
KIND_EVENT: Final = "event"
KIND_WAIT: Final = "wait"
EVENT_TYPES: Final = frozenset({"cost_anomaly"})
"""The events a task may subscribe to. A closed list: a new one is a new decision."""
MAX_MESSAGE_BYTES: Final = 24 * 1024
MAX_EVENT_DATA_BYTES: Final = 16 * 1024
"""Serialized size of the data of an event: what the investigation needs, never a dump."""

ID_PATTERN: Final = r"^[0-9a-f]{32}$"
"""Automations and runs: 128 random bits in hex, like every public id of mango-api."""
_ID_RE = re.compile(ID_PATTERN)
_EVENT_ID_RE = re.compile(r"^[A-Za-z0-9:_./-]{1,128}$")
_MAX_DEPTH = 8


class InvalidTaskMessageError(ValueError):
    """A message this module does not accept. Never says which part was wrong."""


@dataclass(frozen=True)
class ScheduledRun:
    automation_id: str
    scheduled_at: datetime

    @property
    def run_id(self) -> str:
        return derived_run_id(self.automation_id, f"schedule:{self.scheduled_at.isoformat()}")


@dataclass(frozen=True)
class ManualRun:
    automation_id: str
    run_id: str


@dataclass(frozen=True)
class EventRun:
    """One event, for every automation subscribed to its type."""

    event_type: str
    event_id: str
    occurred_at: datetime
    data: dict[str, Any]

    def run_id(self, automation_id: str) -> str:
        return derived_run_id(automation_id, f"event:{self.event_type}:{self.event_id}")


@dataclass(frozen=True)
class WaitRun:
    """An event run of ``automation_id`` that waits for the run holding its task (D81)."""

    automation_id: str
    wake: str
    event: EventRun

    @property
    def run_id(self) -> str:
        return self.event.run_id(self.automation_id)


TaskMessage = ScheduledRun | ManualRun | EventRun | WaitRun


def derived_run_id(automation_id: str, key: str) -> str:
    """Run id of a trigger that may be delivered more than once: the same automation and the
    same due time or event always give the same id, with the shape of any other id."""
    return hashlib.sha256(f"mango-task-run.v1\n{automation_id}\n{key}".encode()).hexdigest()[:32]


def _dumps(value: object) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True, ensure_ascii=False)


def _depth(value: object, depth: int = 0) -> int:
    if depth > _MAX_DEPTH:
        return depth
    if isinstance(value, dict):
        return max((_depth(item, depth + 1) for item in value.values()), default=depth)
    if isinstance(value, list):
        return max((_depth(item, depth + 1) for item in value), default=depth)
    return depth


def _instant(value: object) -> datetime:
    if not isinstance(value, str) or len(value) > 40:  # noqa: PLR2004
        raise InvalidTaskMessageError
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        raise InvalidTaskMessageError from None
    if moment.tzinfo is None:
        raise InvalidTaskMessageError
    return moment.astimezone(UTC)


def _event_data(data: object) -> dict[str, Any]:
    if not isinstance(data, dict) or _depth(data) > _MAX_DEPTH:
        raise InvalidTaskMessageError
    try:
        size = len(_dumps(data).encode())
    except (TypeError, ValueError):
        raise InvalidTaskMessageError from None
    if size > MAX_EVENT_DATA_BYTES:
        raise InvalidTaskMessageError
    return data


# --- Building (mango-api, the consumer of an event) ---------------------------------------


def manual_message(automation_id: str, run_id: str) -> str:
    if not _ID_RE.fullmatch(automation_id) or not _ID_RE.fullmatch(run_id):
        raise InvalidTaskMessageError
    return _dumps(
        {"v": VERSION, "kind": KIND_MANUAL, "automation_id": automation_id, "run_id": run_id}
    )


def schedule_input(automation_id: str) -> str:
    """The input of an EventBridge Scheduler schedule. Scheduler replaces the placeholder
    with the time the run was due."""
    if not _ID_RE.fullmatch(automation_id):
        raise InvalidTaskMessageError
    return (
        f'{{"automation_id":"{automation_id}","kind":"{KIND_SCHEDULE}",'
        f'"scheduled_at":"<aws.scheduler.scheduled-time>","v":{VERSION}}}'
    )


def event_message(
    event_type: str, event_id: str, occurred_at: datetime, data: dict[str, Any]
) -> str:
    """Body of the message that starts the runs of every automation subscribed to
    ``event_type``. ``event_id`` is the id the source gives the event: the idempotency key."""
    if event_type not in EVENT_TYPES or not _EVENT_ID_RE.fullmatch(event_id):
        raise InvalidTaskMessageError
    if occurred_at.tzinfo is None:
        raise InvalidTaskMessageError
    body = _dumps(
        {
            "v": VERSION,
            "kind": KIND_EVENT,
            "event_type": event_type,
            "event_id": event_id,
            "occurred_at": occurred_at.astimezone(UTC).isoformat(),
            "data": _event_data(data),
        }
    )
    if len(body.encode()) > MAX_MESSAGE_BYTES:
        raise InvalidTaskMessageError
    return body


def wait_message(automation_id: str, wake: str, event: EventRun) -> str:
    """Body of the message that resumes a waiting event run of ``automation_id``."""
    if not _ID_RE.fullmatch(automation_id) or not _ID_RE.fullmatch(wake):
        raise InvalidTaskMessageError
    if event.event_type not in EVENT_TYPES or not _EVENT_ID_RE.fullmatch(event.event_id):
        raise InvalidTaskMessageError
    body = _dumps(
        {
            "v": VERSION,
            "kind": KIND_WAIT,
            "automation_id": automation_id,
            "wake": wake,
            "event_type": event.event_type,
            "event_id": event.event_id,
            "occurred_at": event.occurred_at.astimezone(UTC).isoformat(),
            "data": _event_data(event.data),
        }
    )
    if len(body.encode()) > MAX_MESSAGE_BYTES:
        raise InvalidTaskMessageError
    return body


# --- Reading (mango-api) ------------------------------------------------------------------


def parse_message(body: object) -> TaskMessage:
    """The trigger a message names, if it is one this module accepts exactly."""
    if not isinstance(body, str) or len(body.encode()) > MAX_MESSAGE_BYTES:
        raise InvalidTaskMessageError
    try:
        message = json.loads(body)
    except ValueError:
        raise InvalidTaskMessageError from None
    if not isinstance(message, dict) or message.get("v") != VERSION:
        raise InvalidTaskMessageError
    kind = message.get("kind")
    if kind == KIND_SCHEDULE:
        if set(message) != {"v", "kind", "automation_id", "scheduled_at"} or not is_id(
            message["automation_id"]
        ):
            raise InvalidTaskMessageError
        return ScheduledRun(message["automation_id"], _instant(message["scheduled_at"]))
    if kind == KIND_MANUAL:
        if set(message) != {"v", "kind", "automation_id", "run_id"} or not (
            is_id(message["automation_id"]) and is_id(message["run_id"])
        ):
            raise InvalidTaskMessageError
        return ManualRun(message["automation_id"], message["run_id"])
    if kind == KIND_EVENT:
        if set(message) != _EVENT_FIELDS:
            raise InvalidTaskMessageError
        return _event(message)
    if kind == KIND_WAIT:
        if set(message) != _EVENT_FIELDS | {"automation_id", "wake"} or not (
            is_id(message["automation_id"]) and is_id(message["wake"])
        ):
            raise InvalidTaskMessageError
        return WaitRun(message["automation_id"], message["wake"], _event(message))
    raise InvalidTaskMessageError


_EVENT_FIELDS: Final = frozenset({"v", "kind", "event_type", "event_id", "occurred_at", "data"})


def _event(message: dict[str, Any]) -> EventRun:
    event_type, event_id = message["event_type"], message["event_id"]
    if (
        not isinstance(event_type, str)
        or event_type not in EVENT_TYPES
        or not isinstance(event_id, str)
        or not _EVENT_ID_RE.fullmatch(event_id)
    ):
        raise InvalidTaskMessageError
    return EventRun(
        event_type, event_id, _instant(message["occurred_at"]), _event_data(message["data"])
    )


def is_id(value: object) -> bool:
    return isinstance(value, str) and bool(_ID_RE.fullmatch(value))
