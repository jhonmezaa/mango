"""Reading the traces of the evals harness (D110 (8)).

Only this function reads them: the evals runtime's own log groups hold the content (questions,
answers, tool inputs and outputs), with a key whose policy lets only this role decrypt. Nothing
read here is ever logged; what leaves this function is a verdict, a label and token counts.

``FilterLogEvents`` names one log group (IAM scopes it), is synchronous and has no charge per
query (unlike Logs Insights, whose ``GetQueryResults`` takes no resource).
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

from botocore.exceptions import ClientError

if TYPE_CHECKING:
    from mypy_boto3_logs import CloudWatchLogsClient

MAX_PAGES = 40
MAX_SPANS = 2000
"""A case is one turn of at most 75 iterations; far below the 20,000 ``Evaluate`` accepts."""
MAX_BYTES = 4 * 1024 * 1024
_SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{33,100}$")
_MARKER_RE = re.compile(r"^[0-9a-f]{32}$")


class TooManySpansError(Exception):
    """The session has more telemetry than an evaluation may carry: it is not scored."""


def _not_found(exc: ClientError) -> bool:
    return exc.response.get("Error", {}).get("Code") == "ResourceNotFoundException"


def _events(  # noqa: PLR0917 - one query, all required
    logs: CloudWatchLogsClient, group: str, pattern: str, start_ms: int, end_ms: int, limit: int
) -> Iterable[str]:
    kwargs: dict[str, Any] = {
        "logGroupName": group,
        "filterPattern": pattern,
        "startTime": start_ms,
        "endTime": end_ms,
    }
    seen = 0
    for _ in range(MAX_PAGES):
        try:
            page = logs.filter_log_events(**kwargs)
        except ClientError as exc:
            if _not_found(exc):
                # A log group that does not exist (yet) holds nothing.
                return
            raise
        for event in page.get("events", []):
            message = event.get("message")
            if isinstance(message, str):
                seen += 1
                yield message
                if seen >= limit:
                    return
        token = page.get("nextToken")
        if not token:
            return
        kwargs["nextToken"] = token
    raise TooManySpansError("too many pages")


def session_pattern(session_id: str) -> str:
    """The attribute has a dot in its name: ``$.attributes.['session.id']`` (finding of
    2026-10-06)."""
    if not _SESSION_RE.fullmatch(session_id):
        raise ValueError("invalid session")
    return f"{{ $.attributes.['session.id'] = \"{session_id}\" }}"


def session_spans(
    logs: CloudWatchLogsClient,
    groups: tuple[str, ...],
    session_id: str,
    start_ms: int,
    end_ms: int,
) -> list[dict[str, Any]]:
    """Every span record of ``session_id`` in the evals runtime's log groups, as JSON."""
    pattern = session_pattern(session_id)
    out: list[dict[str, Any]] = []
    size = 0
    for group in groups:
        for message in _events(logs, group, pattern, start_ms, end_ms, MAX_SPANS + 1):
            size += len(message)
            if len(out) >= MAX_SPANS or size > MAX_BYTES:
                raise TooManySpansError("session too large")
            try:
                record = json.loads(message)
            except ValueError:
                continue
            if isinstance(record, dict):
                out.append(record)
    return out


def trace_ids(spans: list[dict[str, Any]]) -> list[str]:
    """The traces of the session, in the order their spans started."""
    starts: dict[str, int] = {}
    for span in spans:
        trace = span.get("traceId")
        start = span.get("startTimeUnixNano", 0)
        if isinstance(trace, str) and trace:
            value = start if isinstance(start, int) else 0
            starts[trace] = min(starts.get(trace, value), value)
    return sorted(starts, key=lambda t: (starts[t], t))


def marker_count(
    logs: CloudWatchLogsClient, group: str, marker: str, start_ms: int, end_ms: int
) -> int:
    """How many records of ``group`` carry the canary's random marker (0 or 1 is enough)."""
    if not _MARKER_RE.fullmatch(marker):
        raise ValueError("invalid marker")
    return sum(1 for _ in _events(logs, group, f'"{marker}"', start_ms, end_ms, 1))
