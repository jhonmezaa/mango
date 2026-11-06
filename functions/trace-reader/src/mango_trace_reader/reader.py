"""Reading the spans of a window from both places the harness may write them.

* ``aws/spans`` (split telemetry, Transaction Search, D16): where the managed harness wrote them
  when the budget reconciliation was validated (2026-10-06).
* The ``spans`` stream of each runtime's log group (unified telemetry): the default of agents
  created since 2026-07-20, according to the AgentCore documentation read on 2026-11-05.

Both are read (decision of 2026-11-05, D108) and a span found in both counts once.

**Logs Insights first, ``FilterLogEvents`` if it fails** (D113, chosen by the owner on
2026-11-06; it precises D108 (2) and D73 (9)). Measured in the installation that day (obs-perf):
``FilterLogEvents`` is paid per call, not per byte. A call took 0.7 to 1 s even when it found
nothing, and a window of ``aws/spans`` is answered a slice at a time: 24 hours read an hour at a
time took 27 calls and 22 s and always stopped at the deadline (``capped``), with ``aws/spans``
holding about 5 MB a day. One Logs Insights query over the same 24 hours, ``aws/spans`` and the
runtimes' log groups together, took 1.7 s.

* **Logs Insights:** one ``StartQuery`` per 50 log groups (its limit) with the query of
  ``insights_query``, then ``GetQueryResults`` until it completes, within ``INSIGHTS_SECONDS``.
  ``GetQueryResults`` and ``StopQuery`` take no resource in IAM: the reader only asks for the ids
  its own ``StartQuery`` returned in this reading, and it may not list queries (TM-OB8).
  The evals harness's log groups are never named, and the role denies them every action.
* **``FilterLogEvents``, if a query cannot be started, fails or runs out of time:** ``aws/spans``
  six hours at a time from the newest (14 calls and 8.7 s for 24 hours, measured), then the
  runtimes' log groups, two calls at a time at most (``READ_THREADS``: its request quota per
  account is low and the budget reconciliation shares it).

Either way the reading stops at a deadline, at a number of pages or rows, or at a number of
traces; then ``capped`` says the answer is the newest part of the window only.
"""

from __future__ import annotations

import contextlib
import logging
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from mango_trace_reader.config import RUNTIME_SPANS_STREAM, SPANS_LOG_GROUP, Settings
from mango_trace_reader.spans import (
    EVALS_ID,
    QUERY_LIMIT,
    Trace,
    UnreadableSpanError,
    filter_pattern,
    harness_pattern,
    insights_query,
    parse,
)

if TYPE_CHECKING:
    from mypy_boto3_logs import CloudWatchLogsClient

logger = logging.getLogger(__name__)

CHUNK_MS: Final = 6 * 3_600_000
"""``aws/spans`` is read six hours at a time, newest first: a capped answer keeps the newest."""
READ_THREADS: Final = 2
"""Calls of one reading at once (the account's ``FilterLogEvents`` quota is shared)."""
MAX_PAGES: Final = 200
"""Pages of ``FilterLogEvents`` one reading may ask for, all log groups together."""
MAX_TRACES: Final = 1_000
MAX_RUNTIME_GROUPS: Final = 100
"""Runtime log groups one reading may filter (two per agent: its endpoints)."""
GROUPS_CACHE_SECONDS: Final = 300.0
TAIL_MS: Final = 15 * 60 * 1000
"""A span's event is stamped with its end: the spans of a trace that started at the end of the
window are read up to this much later (never past now)."""
INSIGHTS_SECONDS: Final = 10.0
"""Most of the deadline the Logs Insights query may take; ``FilterLogEvents`` has the rest."""
QUERY_GROUPS: Final = 50
"""Log groups one ``StartQuery`` may name."""
POLL_SECONDS: Final = (0.2, 0.3, 0.5)
"""Waits between ``GetQueryResults`` calls; the last repeats."""
_NOT_FOUND: Final = "ResourceNotFoundException"
_DONE: Final = frozenset({"Complete"})
_FAILED: Final = frozenset({"Failed", "Cancelled", "Timeout", "Unknown"})


class ReadError(Exception):
    """The spans could not be read at all."""


@dataclass
class Reading:
    traces: dict[str, Trace] = field(default_factory=dict)
    capped: bool = False
    unreadable: int = 0
    pages: int = 0
    found: dict[str, int] = field(default_factory=lambda: {"aws_spans": 0, "runtime": 0})
    engine: str = "insights"
    """``insights``, or ``filter`` when Logs Insights failed and ``FilterLogEvents`` read."""
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)


class _StopReadingError(Exception):
    pass


class _InsightsFailedError(Exception):
    """The query could not be started, failed or ran out of time: ``FilterLogEvents`` reads."""


class SpanReader:
    def __init__(
        self,
        logs: CloudWatchLogsClient,
        settings: Settings,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._logs = logs
        self._settings = settings
        self._monotonic = monotonic
        self._sleep = sleep
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
        until = min(now_ms, end_ms + TAIL_MS)
        groups = self.runtime_groups(agent_id)
        capped_groups = len(groups) > MAX_RUNTIME_GROUPS
        groups = groups[:MAX_RUNTIME_GROUPS]
        insights_deadline = min(deadline, self._monotonic() + INSIGHTS_SECONDS)
        try:
            reading = self._read_insights(start_ms, until, agent_id, groups, insights_deadline)
        except _InsightsFailedError as exc:
            logger.warning("logs insights failed (%s): reading with FilterLogEvents", exc)
            reading = self._read_filter(start_ms, until, agent_id, groups, deadline)
        reading.capped = reading.capped or capped_groups
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

    def _read_insights(
        self,
        start_ms: int,
        until: int,
        agent_id: str | None,
        groups: list[str],
        deadline: float,
    ) -> Reading:
        reading = Reading()
        query = insights_query(self._settings.harness_prefix, agent_id)
        harness = harness_pattern(self._settings.harness_prefix)
        names = [SPANS_LOG_GROUP, *groups]
        running: list[str] = []
        try:
            for i in range(0, len(names), QUERY_GROUPS):
                batch = names[i : i + QUERY_GROUPS]
                query_id = self._start_query(batch, start_ms, until, query)
                if query_id is not None:
                    running.append(query_id)
            for query_id in list(running):
                rows = self._results(query_id, deadline)
                running.remove(query_id)
                if len(rows) >= QUERY_LIMIT:
                    reading.capped = True
                for row in rows:
                    self._add_row(reading, row, harness)
        except _StopReadingError:
            reading.capped = True
        finally:
            # Only the queries of this reading that have not completed.
            for query_id in running:
                self._stop(query_id)
        return reading

    def _start_query(self, groups: list[str], start_ms: int, until: int, query: str) -> str | None:
        """The id of a new query over ``groups``; ``None`` when none of them exists."""
        try:
            out = self._logs.start_query(
                logGroupNames=groups,
                startTime=start_ms // 1000,
                endTime=-(-until // 1000),
                queryString=query,
                limit=QUERY_LIMIT,
            )
        except ClientError as exc:
            # An account without Transaction Search has no `aws/spans`: the runtimes only.
            if (
                exc.response.get("Error", {}).get("Code") == _NOT_FOUND
                and SPANS_LOG_GROUP in groups
            ):
                rest = [g for g in groups if g != SPANS_LOG_GROUP]
                logger.info("no %s log group in this account", SPANS_LOG_GROUP)
                return self._start_query(rest, start_ms, until, query) if rest else None
            raise _InsightsFailedError(type(exc).__name__) from None
        except BotoCoreError as exc:
            raise _InsightsFailedError(type(exc).__name__) from None
        return str(out["queryId"])

    def _results(self, query_id: str, deadline: float) -> list[Any]:
        """The rows of a query this reading started, once it completes."""
        polls = 0
        while True:
            if self._monotonic() >= deadline:
                raise _InsightsFailedError("deadline")
            self._sleep(POLL_SECONDS[min(polls, len(POLL_SECONDS) - 1)])
            polls += 1
            try:
                out = self._logs.get_query_results(queryId=query_id)
            except (ClientError, BotoCoreError) as exc:
                raise _InsightsFailedError(type(exc).__name__) from None
            status = str(out.get("status", "Unknown"))
            if status in _DONE:
                return list(out.get("results", []))
            if status in _FAILED:
                raise _InsightsFailedError(status)

    def _stop(self, query_id: str) -> None:
        """Stops a query of this reading that may still run; one already done says so."""
        with contextlib.suppress(ClientError, BotoCoreError):
            self._logs.stop_query(queryId=query_id)

    def _add_row(self, reading: Reading, row: Any, harness: Any) -> None:
        fields = {
            str(f.get("field")): str(f.get("value", ""))
            for f in row
            if isinstance(f, dict) and f.get("field") in {"@log", "@message"}
        }
        # `@log` is `<account>:<log group>`.
        group = fields.get("@log", "").partition(":")[2] or fields.get("@log", "")
        source = "aws_spans" if group == SPANS_LOG_GROUP else "runtime"
        self._add(reading, fields.get("@message", ""), harness, source)

    def _add(self, reading: Reading, message: str, harness: Any, source: str) -> None:
        try:
            span = parse(message, harness)
        except UnreadableSpanError:
            with reading.lock:
                reading.unreadable += 1
            return
        if span is None:
            return
        with reading.lock:
            trace = reading.traces.get(span.trace_id)
            if trace is None:
                if len(reading.traces) >= MAX_TRACES:
                    raise _StopReadingError
                trace = reading.traces[span.trace_id] = Trace(span.trace_id)
            trace.add(span)
            reading.found[source] += 1

    def _read_filter(
        self,
        start_ms: int,
        until: int,
        agent_id: str | None,
        groups: list[str],
        deadline: float,
    ) -> Reading:
        reading = Reading(engine="filter")
        pattern = filter_pattern(self._settings.harness_prefix, agent_id)
        harness = harness_pattern(self._settings.harness_prefix)
        jobs: list[tuple[str, dict[str, Any]]] = [
            ("aws_spans", {"logGroupName": SPANS_LOG_GROUP, "startTime": lo, "endTime": hi})
            for lo, hi in _chunks(start_ms, until)
        ]
        jobs += [
            (
                "runtime",
                {
                    "logGroupName": group,
                    "logStreamNamePrefix": RUNTIME_SPANS_STREAM,
                    "startTime": start_ms,
                    "endTime": until,
                },
            )
            for group in groups
        ]
        missing = threading.Event()

        def job(source: str, request: dict[str, Any]) -> None:
            if source == "aws_spans" and missing.is_set():
                return
            try:
                found = self._filter(reading, deadline, pattern, harness, source, **request)
            except _StopReadingError:
                with reading.lock:
                    reading.capped = True
                return
            if not found and source == "aws_spans":
                missing.set()

        # Submitted newest first: the pool takes them in order, so a capped answer keeps the
        # newest hours. A ReadError of any call fails the reading.
        with ThreadPoolExecutor(READ_THREADS, thread_name_prefix="reader") as pool:
            for future in [pool.submit(job, source, request) for source, request in jobs]:
                future.result()
        if missing.is_set():
            logger.info("no %s log group in this account", SPANS_LOG_GROUP)
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
                self._add(reading, str(event.get("message", "")), harness, source)
        return True

    def _pages(
        self, reading: Reading, deadline: float, request: dict[str, Any]
    ) -> Iterator[list[Any] | None]:
        while True:
            with reading.lock:
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
    """``[start_ms, end_ms)`` in slices of ``CHUNK_MS``, newest first."""
    upper = end_ms
    while upper > start_ms:
        lower = max(start_ms, upper - CHUNK_MS)
        yield lower, upper
        upper = lower
