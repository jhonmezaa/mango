"""What the AgentCore traces say a turn spent.

The managed harness writes one ``invoke_agent`` span per invocation to the ``aws/spans`` log
group (CloudWatch Transaction Search, D16), with the runtime session id mango-api computed
for the turn and the tokens of the invocation. That log group holds the spans of the whole
account and nothing in it is trusted: from each span only four token counts, its start and
its status are read, each checked for type and range. Nothing else is kept or logged.

A turn can leave more than one invocation in its session (a retried call), and a session with
a pending turn is never continued by another turn, so every invocation of the session that
started after the turn reserved is the turn's.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from mango_core.budget_turns import TokenUsage

if TYPE_CHECKING:
    from mypy_boto3_logs import CloudWatchLogsClient

SPAN_NAME: Final = "invoke_agent"
"""One span of this name per invocation. ``chat`` spans repeat the same tokens: never summed."""
START_SKEW_SECONDS: Final = 2
"""How much earlier than the reservation a span of the turn may say it started (clocks)."""
MAX_TOKENS: Final = 1_000_000_000
MAX_PAGES: Final = 20
STATUS_ERROR: Final = "ERROR"

_SESSION_ID: Final = re.compile(r"^[0-9a-f]{64}$")
# The same count under the names the harness has used for it; the first one present wins.
_INPUT: Final = ("gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens")
_OUTPUT: Final = ("gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens")
_CACHE_READ: Final = (
    "gen_ai.usage.cache_read_input_tokens",
    "gen_ai.usage.cache_read.input_tokens",
)
_CACHE_WRITE: Final = (
    "gen_ai.usage.cache_write_input_tokens",
    "gen_ai.usage.cache_creation.input_tokens",
)


class TraceQueryError(Exception):
    """The spans could not be read (or not all of them): nothing is known about the turn."""


@dataclass(frozen=True)
class TraceReading:
    invocations: int = 0
    """Invocations of the session that belong to the turn."""
    usage: TokenUsage = field(default_factory=TokenUsage)
    unreadable: int = 0
    """Spans of the turn whose tokens cannot be told: not a failure, and no usable counts."""


def filter_pattern(session_id: str) -> str:
    """CloudWatch Logs filter for the invocation spans of one runtime session."""
    if not _SESSION_ID.fullmatch(session_id):
        raise ValueError("invalid session id")
    return f'{{ ($.attributes.[\'session.id\'] = "{session_id}") && ($.name = "{SPAN_NAME}*") }}'


class _UnreadableError(Exception):
    pass


def _count(attributes: dict[str, Any], names: tuple[str, ...]) -> int | None:
    for name in names:
        if name in attributes:
            value = attributes[name]
            # ``bool`` is an ``int`` in Python; a count is never one.
            if type(value) is not int or not 0 <= value <= MAX_TOKENS:
                raise _UnreadableError
            return value
    return None


def _usage(span: dict[str, Any]) -> TokenUsage:
    attributes = span.get("attributes")
    status = span.get("status")
    if not isinstance(attributes, dict):
        raise _UnreadableError
    tokens_in, tokens_out = _count(attributes, _INPUT), _count(attributes, _OUTPUT)
    if tokens_in is None or tokens_out is None:
        # A failed invocation reports no tokens. Any other span without them cannot be read
        # as "it cost nothing": the attribute names may have changed.
        failed = isinstance(status, dict) and status.get("code") == STATUS_ERROR
        if failed and tokens_in is None and tokens_out is None:
            return TokenUsage()
        raise _UnreadableError
    return TokenUsage(
        tokens_in,
        tokens_out,
        _count(attributes, _CACHE_READ) or 0,
        _count(attributes, _CACHE_WRITE) or 0,
    )


class Traces:
    def __init__(self, logs: CloudWatchLogsClient, log_group: str) -> None:
        self._logs = logs
        self._log_group = log_group

    def _events(self, session_id: str, start_ms: int, end_ms: int) -> list[Any]:
        request: dict[str, Any] = {
            "logGroupName": self._log_group,
            "filterPattern": filter_pattern(session_id),
            # The timestamp of a span's event is its end, which is never before its start.
            "startTime": start_ms,
            "endTime": end_ms,
        }
        events: list[Any] = []
        try:
            for _ in range(MAX_PAGES):
                page = self._logs.filter_log_events(**request)
                events.extend(page.get("events", []))
                token = page.get("nextToken")
                if not token:
                    return events
                request["nextToken"] = token
        except (ClientError, BotoCoreError) as exc:
            raise TraceQueryError(type(exc).__name__) from None
        # More pages than a turn can have: a partial answer is not an answer.
        raise TraceQueryError("too many pages")

    def read(self, session_id: str, started_at: int, now: int) -> TraceReading:
        """Invocations of ``session_id`` that started since the turn reserved at ``started_at``."""
        earliest = started_at - START_SKEW_SECONDS
        events = self._events(session_id, earliest * 1000, (now + 1) * 1000)
        usage = TokenUsage()
        seen: set[str] = set()
        invocations = unreadable = 0
        for event in events:
            try:
                span = json.loads(event.get("message", ""))
            except ValueError:
                unreadable += 1
                continue
            if not isinstance(span, dict):
                unreadable += 1
                continue
            attributes = span.get("attributes")
            name, start = span.get("name"), span.get("startTimeUnixNano")
            # The filter already says so; what is summed is checked again here.
            if (
                not isinstance(attributes, dict)
                or attributes.get("session.id") != session_id
                or not isinstance(name, str)
                or not name.startswith(SPAN_NAME)
            ):
                continue
            if type(start) is not int:
                unreadable += 1
                continue
            if start < earliest * 1_000_000_000:
                # An earlier turn of the same session.
                continue
            identity = f"{span.get('traceId')}/{span.get('spanId')}"
            if identity in seen:
                continue
            seen.add(identity)
            invocations += 1
            try:
                usage = usage.plus(_usage(span))
            except _UnreadableError:
                unreadable += 1
        return TraceReading(invocations=invocations, usage=usage, unreadable=unreadable)
