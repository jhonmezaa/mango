"""Reading the spans of a window from both places the harness may write them.

* ``aws/spans`` (split telemetry, Transaction Search, D16): where the managed harness wrote them
  when the budget reconciliation was validated (2026-10-06).
* The ``spans`` stream of each runtime's log group (unified telemetry): the default of agents
  created since 2026-07-20, according to the AgentCore documentation read on 2026-11-05.

Both are read (decision of 2026-11-05, D108) and a span found in both counts once.

``FilterLogEvents``, not Logs Insights: it is synchronous, it is scoped to a log group in IAM
(``GetQueryResults`` has no resource scope) and it has no charge per query (the budget
reconciliation made the same choice, D73 (9)). Its cost is time: a window of the whole account
is scanned page by page. So ``aws/spans`` is read an hour at a time from the newest, and the
reading stops at a deadline, at a number of pages or at a number of traces; then ``capped``
says the answer is the newest part of the window only.

Calls go one after the other: ``FilterLogEvents`` has a low request quota per account, which the
budget reconciliation shares.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from mango_trace_reader.config import RUNTIME_SPANS_STREAM, SPANS_LOG_GROUP, Settings
from mango_trace_reader.spans import (
    EVALS_ID,
    Trace,
    UnreadableSpanError,
    filter_pattern,
    harness_pattern,
    parse,
)

if TYPE_CHECKING:
    from mypy_boto3_logs import CloudWatchLogsClient

logger = logging.getLogger(__name__)

CHUNK_MS: Final = 3_600_000
"""``aws/spans`` is read an hour at a time, newest first: a capped answer keeps the newest."""
MAX_PAGES: Final = 200
"""Pages of ``FilterLogEvents`` one reading may ask for, all log groups together."""
MAX_TRACES: Final = 1_000
MAX_RUNTIME_GROUPS: Final = 100
"""Runtime log groups one reading may filter (two per agent: its endpoints)."""
GROUPS_CACHE_SECONDS: Final = 300.0
TAIL_MS: Final = 15 * 60 * 1000
"""A span's event is stamped with its end: the spans of a trace that started at the end of the
window are read up to this much later (never past now)."""
_NOT_FOUND: Final = "ResourceNotFoundException"


class ReadError(Exception):
    """The spans could not be read at all."""


@dataclass
class Reading:
    traces: dict[str, Trace] = field(default_factory=dict)
    capped: bool = False
    unreadable: int = 0
    pages: int = 0
    found: dict[str, int] = field(default_factory=lambda: {"aws_spans": 0, "runtime": 0})


class _StopReadingError(Exception):
    pass


class SpanReader:
    def __init__(
        self,
        logs: CloudWatchLogsClient,
        settings: Settings,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._logs = logs
        self._settings = settings
        self._monotonic = monotonic
        self._groups: tuple[float, list[str]] | None = None

    def runtime_groups(self, agent_id: str | None) -> list[str]:
        """Log groups of the installation's runtimes (of one agent's, if given), cached."""
        now = self._monotonic()
        if self._groups is None or now - self._groups[0] >= GROUPS_CACHE_SECONDS:
            names: list[str] = []
            try:
                pages = self._logs.get_paginator("describe_log_groups").paginate(
                    logGroupNamePrefix=self._settings.runtime_log_group_prefix
                )
                for page in pages:
                    names.extend(
                        str(g["logGroupName"])
                        for g in page.get("logGroups", [])
                        if "logGroupName" in g
                    )
            except (ClientError, BotoCoreError) as exc:
                raise ReadError(type(exc).__name__) from None
            # Never the evals harness's: it holds content (D110 (3)), and its role denies it.
            evals = f"{self._settings.runtime_log_group_prefix}{EVALS_ID}-"
            self._groups = (now, sorted(n for n in names if not n.startswith(evals)))
        groups = self._groups[1]
        if agent_id is None:
            return groups
        prefix = f"{self._settings.runtime_log_group_prefix}{agent_id}-"
        return [g for g in groups if g.startswith(prefix)]

    def read(
        self, start_ms: int, end_ms: int, now_ms: int, agent_id: str | None, deadline: float
    ) -> Reading:
        """Traces of the installation that started in ``[start_ms, end_ms)``."""
        reading = Reading()
        pattern = filter_pattern(self._settings.harness_prefix, agent_id)
        harness = harness_pattern(self._settings.harness_prefix)
        until = min(now_ms, end_ms + TAIL_MS)
        try:
            missing_spans_group = False
            for chunk_start, chunk_end in _chunks(start_ms, until):
                found = self._filter(
                    reading,
                    deadline,
                    pattern,
                    harness,
                    "aws_spans",
                    logGroupName=SPANS_LOG_GROUP,
                    startTime=chunk_start,
                    endTime=chunk_end,
                )
                if not found:
                    missing_spans_group = True
                    break
            groups = self.runtime_groups(agent_id)
            if len(groups) > MAX_RUNTIME_GROUPS:
                reading.capped = True
                groups = groups[:MAX_RUNTIME_GROUPS]
            for group in groups:
                self._filter(
                    reading,
                    deadline,
                    pattern,
                    harness,
                    "runtime",
                    logGroupName=group,
                    logStreamNamePrefix=RUNTIME_SPANS_STREAM,
                    startTime=start_ms,
                    endTime=until,
                )
            if missing_spans_group:
                logger.info("no %s log group in this account", SPANS_LOG_GROUP)
        except _StopReadingError:
            reading.capped = True
        # Only traces that started in the window: the tail is read for their last spans.
        for trace_id in [
            t
            for t, trace in reading.traces.items()
            if not start_ms * 1_000_000
            <= min(s.start_ns for s in trace.spans.values())
            < end_ms * 1_000_000
        ]:
            del reading.traces[trace_id]
        return reading

    def _filter(
        self,
        reading: Reading,
        deadline: float,
        pattern: str,
        harness: Any,
        source: str,
        **request: Any,
    ) -> bool:
        """Adds what one log group says to ``reading``; False if the log group does not exist."""
        request["filterPattern"] = pattern
        for events in self._pages(reading, deadline, request):
            if events is None:
                return False
            for event in events:
                try:
                    span = parse(str(event.get("message", "")), harness)
                except UnreadableSpanError:
                    reading.unreadable += 1
                    continue
                if span is None:
                    continue
                trace = reading.traces.get(span.trace_id)
                if trace is None:
                    if len(reading.traces) >= MAX_TRACES:
                        raise _StopReadingError
                    trace = reading.traces[span.trace_id] = Trace(span.trace_id)
                trace.add(span)
                reading.found[source] += 1
        return True

    def _pages(
        self, reading: Reading, deadline: float, request: dict[str, Any]
    ) -> Iterator[list[Any] | None]:
        while True:
            if reading.pages >= MAX_PAGES or self._monotonic() >= deadline:
                raise _StopReadingError
            reading.pages += 1
            try:
                page = self._logs.filter_log_events(**request)
            except ClientError as exc:
                if exc.response.get("Error", {}).get("Code") == _NOT_FOUND:
                    yield None
                    return
                raise ReadError(type(exc).__name__) from None
            except BotoCoreError as exc:
                raise ReadError(type(exc).__name__) from None
            yield list(page.get("events", []))
            token = page.get("nextToken")
            if not token:
                return
            request["nextToken"] = token


def _chunks(start_ms: int, end_ms: int) -> Iterator[tuple[int, int]]:
    """``[start_ms, end_ms)`` an hour at a time, newest first."""
    upper = end_ms
    while upper > start_ms:
        lower = max(start_ms, upper - CHUNK_MS)
        yield lower, upper
        upper = lower
