"""Lambda entry point of the trace reader (D108; threat model ``observability-threat-model.md``).

mango-api invokes it synchronously for the Observability view, with the window and, optionally,
one agent:

    {"start": <epoch ms>, "end": <epoch ms>, "agent": "<agent id>" | null}

It answers the traces of the installation's harnesses that started in the window, newest first,
metadata only (``spans.py``):

    {"traces": [...], "capped": bool, "unreadable": int, "found": {"aws_spans": n, "runtime": n}}

Each trace carries the runtime ``session.id`` of its spans, which only mango-api reads: it joins
the trace with the turn that opened the session and never returns it (TM-OB4).

Only mango-api's role may invoke it. Nothing is written anywhere, and the log line of each
reading holds counts only. A window longer than a day, in the future or older than the spans'
retention is refused. If the spans cannot be read the invocation fails, and mango-api answers
that the view is not available: no dead-letter queue, it is never invoked asynchronously.
"""

from __future__ import annotations

import json
import logging
import re
import time
from functools import cache
from typing import Any, Final

import boto3
from botocore.config import Config

from mango_trace_reader.config import Settings
from mango_trace_reader.reader import ReadError, SpanReader
from mango_trace_reader.spans import AGENT_ID_PATTERN, EVALS_ID

logger = logging.getLogger()
logger.setLevel(logging.INFO)

MAX_WINDOW_MS: Final = 24 * 3_600_000 + 60_000
RETENTION_MS: Final = 30 * 24 * 3_600_000
"""Spans are kept 30 days (D16): an older window has nothing."""
SKEW_MS: Final = 60_000
BUDGET_SECONDS: Final = 20.0
"""Most of what one reading may take: mango-api waits a little longer."""
MARGIN_SECONDS: Final = 3.0
"""Kept, before the function's own timeout, to answer what was read."""
_KEYS: Final = frozenset({"start", "end", "agent"})
_AGENT_RE: Final = re.compile(rf"^{AGENT_ID_PATTERN}$")
_CLIENT_CONFIG = Config(
    retries={"mode": "standard", "max_attempts": 4}, connect_timeout=3, read_timeout=10
)


class BadRequestError(Exception):
    """The event is not one mango-api sends."""


def request(event: Any, now_ms: int) -> tuple[int, int, str | None]:
    if not isinstance(event, dict) or not set(event) <= _KEYS or not {"start", "end"} <= set(event):
        raise BadRequestError("unexpected event")
    start, end, agent = event["start"], event["end"], event.get("agent")
    if type(start) is not int or type(end) is not int:
        raise BadRequestError("start and end must be integers")
    if not 0 < end - start <= MAX_WINDOW_MS:
        raise BadRequestError("the window must be positive and at most a day")
    if end > now_ms + SKEW_MS or start < now_ms - RETENTION_MS:
        raise BadRequestError("the window is out of range")
    if agent is not None and (
        not isinstance(agent, str) or not _AGENT_RE.fullmatch(agent) or agent == EVALS_ID
    ):
        raise BadRequestError("invalid agent")
    return start, end, agent


def handle(reader: SpanReader, event: Any, now_ms: int, deadline: float) -> dict[str, Any]:
    start, end, agent = request(event, now_ms)
    reading = reader.read(start, end, now_ms, agent, deadline)
    traces = [out for trace in reading.traces.values() if (out := trace.out()) is not None]
    traces.sort(key=lambda t: (-t["start_ms"], t["trace_id"]))
    mixed = len(reading.traces) - len(traces)
    logger.info(
        json.dumps(
            {
                "event": "traces.read",
                "window_ms": end - start,
                "agent_filter": agent is not None,
                "traces": len(traces),
                "pages": reading.pages,
                "capped": reading.capped,
                "unreadable": reading.unreadable + mixed,
                "found": reading.found,
            }
        )
    )
    return {
        "traces": traces,
        "capped": reading.capped,
        "unreadable": reading.unreadable + mixed,
        "found": reading.found,
    }


@cache
def _reader() -> SpanReader:
    return SpanReader(boto3.client("logs", config=_CLIENT_CONFIG), Settings.from_env())


def lambda_handler(event: Any, context: Any) -> dict[str, Any]:
    remaining = context.get_remaining_time_in_millis() / 1000 - MARGIN_SECONDS
    deadline = time.monotonic() + min(BUDGET_SECONDS, max(0.0, remaining))
    try:
        return handle(_reader(), event, int(time.time() * 1000), deadline)
    except BadRequestError as exc:
        logger.warning(json.dumps({"event": "traces.refused", "reason": str(exc)}))
        raise
    except ReadError as exc:
        logger.error(json.dumps({"event": "traces.failed", "error": str(exc)}))  # noqa: TRY400
        raise
