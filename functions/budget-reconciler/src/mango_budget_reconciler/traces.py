"""What the AgentCore traces say a turn spent.

The managed harness writes its spans to the ``aws/spans`` log group (CloudWatch Transaction
Search, D16) with the runtime session id mango-api computed for the turn. Three kinds are read:

* ``invoke_agent``: one per invocation, with the tokens the harness counted until the
  invocation ended.
* ``chat``: one per model call, the harness's own record of it. It is closed when the harness
  stops waiting for the call, which is not always when the call ends.
* ``chat <model id>``: the model call itself, child of its ``chat``. It is written when the
  call really ends and carries the tokens the model reported.

A turn the harness cuts at its time limit closes ``invoke_agent`` and ``chat`` with zero tokens
while the model call goes on; its tokens only arrive later, in ``chat <model id>``. So a turn
is summed twice, by invocations and by model calls, and it is not complete while a model call
the harness opened has not been written.

That log group holds the spans of the whole account and nothing in it is trusted: from each
span only its name, its ids, its start and end, its status and four token counts are read,
each checked for type and range. Nothing else is kept or logged.

A session with a pending turn is never continued by another turn, so every span of the session
that started after the turn reserved is the turn's.
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

INVOCATION_NAME: Final = "invoke_agent"
"""One span whose name starts like this per invocation."""
CALL_RECORD_NAME: Final = "chat"
"""The harness's record of one model call."""
MODEL_CALL_PREFIX: Final = "chat "
"""``chat <model id>``: the model call itself, child of its ``chat`` span."""
START_SKEW_SECONDS: Final = 2
"""How much earlier than the reservation a span of the turn may say it started (clocks)."""
OUTLIVED_SECONDS: Final = 1
"""A model call that ended this much after its ``chat`` span was not waited for: the harness
closed its record before the call reported its tokens. Calls that were waited for ended a few
milliseconds before their record; the two that were not, 69 and 79 s after."""
MAX_TOKENS: Final = 1_000_000_000
MAX_PAGES: Final = 20
STATUS_ERROR: Final = "ERROR"

_SESSION_ID: Final = re.compile(r"^[0-9a-f]{64}$")
_SPAN_ID: Final = re.compile(r"^[0-9a-f]{1,32}$")
_NANOS: Final = 1_000_000_000
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
    """What the invocations add up to."""
    model_calls: int = 0
    """Model calls of the turn that have ended."""
    model_usage: TokenUsage = field(default_factory=TokenUsage)
    """What the model calls add up to. They report no cache tokens."""
    unfinished: int = 0
    """Model calls the harness opened that have not been written yet (still running, or the
    span never arrived), and invocations that ended with no usage and no model call at all:
    what the turn cost is not known yet."""
    unreadable: int = 0
    """Spans of the turn whose tokens cannot be told: not a failure, and no usable counts."""


def filter_pattern(session_id: str) -> str:
    """CloudWatch Logs filter for the invocation and model call spans of one runtime session."""
    if not _SESSION_ID.fullmatch(session_id):
        raise ValueError("invalid session id")
    return (
        f"{{ ($.attributes.['session.id'] = \"{session_id}\") && "
        f'(($.name = "{INVOCATION_NAME}*") || ($.name = "{CALL_RECORD_NAME}*")) }}'
    )


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


def _failed(span: dict[str, Any]) -> bool:
    status = span.get("status")
    return isinstance(status, dict) and status.get("code") == STATUS_ERROR


def _usage(span: dict[str, Any]) -> TokenUsage:
    """Tokens of an invocation or of a model call record: both counts, or a failure."""
    attributes = span["attributes"]
    tokens_in, tokens_out = _count(attributes, _INPUT), _count(attributes, _OUTPUT)
    if tokens_in is None or tokens_out is None:
        # A failed invocation reports no tokens. Any other span without them cannot be read
        # as "it cost nothing": the attribute names may have changed.
        if _failed(span) and tokens_in is None and tokens_out is None:
            return TokenUsage()
        raise _UnreadableError
    return TokenUsage(
        tokens_in,
        tokens_out,
        _count(attributes, _CACHE_READ) or 0,
        _count(attributes, _CACHE_WRITE) or 0,
    )


def _reported(span: dict[str, Any]) -> TokenUsage | None:
    """Tokens a model call span carries. Its instrumentation leaves out a count of zero, so
    one count alone is a real answer; none at all is not an answer."""
    attributes = span["attributes"]
    tokens_in, tokens_out = _count(attributes, _INPUT), _count(attributes, _OUTPUT)
    if tokens_in is None and tokens_out is None:
        return None
    return TokenUsage(tokens_in or 0, tokens_out or 0)


def _model_call_usage(call: dict[str, Any], record: dict[str, Any] | None) -> TokenUsage:
    """What one ended model call cost, from its own span and the harness's record of it."""
    reported = _reported(call)
    if reported is not None:
        return reported
    if _failed(call):
        return TokenUsage()
    # No tokens on a call that did not fail (a guardrail block looks like this): the harness's
    # record is believed only if it waited for the call to end.
    if record is None or call["end"] - record["end"] > OUTLIVED_SECONDS * _NANOS:
        raise _UnreadableError
    return _usage(record)


def _span(event: Any, session_id: str) -> dict[str, Any] | None:
    """The span of a log event when it is one of the session's that this module reads; None
    for anything else. Raises ``_UnreadableError`` when it is one but its shape is not."""
    try:
        span = json.loads(event.get("message", ""))
    except ValueError:
        raise _UnreadableError from None
    if not isinstance(span, dict):
        raise _UnreadableError
    attributes, name = span.get("attributes"), span.get("name")
    # The filter already says so; what is summed is checked again here.
    if (
        not isinstance(attributes, dict)
        or attributes.get("session.id") != session_id
        or not isinstance(name, str)
        or not name.startswith((INVOCATION_NAME, CALL_RECORD_NAME))
    ):
        return None
    start, end = span.get("startTimeUnixNano"), span.get("endTimeUnixNano")
    span_id, parent = span.get("spanId"), span.get("parentSpanId")
    if (
        type(start) is not int
        or type(end) is not int
        or not isinstance(span_id, str)
        or not _SPAN_ID.fullmatch(span_id)
    ):
        raise _UnreadableError
    return {
        "name": name,
        "id": span_id,
        "identity": f"{span.get('traceId')}/{span_id}",
        "parent": parent if isinstance(parent, str) else "",
        "start": start,
        "end": end,
        "status": span.get("status"),
        "attributes": attributes,
    }


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

    def _spans(self, session_id: str, earliest: int, now: int) -> tuple[list[dict[str, Any]], int]:
        """Spans of the turn, each once, and how many of the session's could not be read."""
        spans: list[dict[str, Any]] = []
        seen: set[str] = set()
        unreadable = 0
        for event in self._events(session_id, earliest * 1000, (now + 1) * 1000):
            try:
                span = _span(event, session_id)
            except _UnreadableError:
                unreadable += 1
                continue
            # A span that started before the reservation is of an earlier turn of the session.
            if span is None or span["start"] < earliest * _NANOS or span["identity"] in seen:
                continue
            seen.add(span["identity"])
            spans.append(span)
        return spans, unreadable

    def read(self, session_id: str, started_at: int, now: int) -> TraceReading:
        """What the spans of ``session_id`` that started since the turn reserved at
        ``started_at`` add up to, by invocations and by model calls."""
        spans, unreadable = self._spans(session_id, started_at - START_SKEW_SECONDS, now)
        invocations = [span for span in spans if span["name"].startswith(INVOCATION_NAME)]
        records = {span["id"]: span for span in spans if span["name"] == CALL_RECORD_NAME}
        calls = [span for span in spans if span["name"].startswith(MODEL_CALL_PREFIX)]

        usage = model_usage = TokenUsage()
        silent = 0
        for invocation in invocations:
            try:
                spent = _usage(invocation)
            except _UnreadableError:
                unreadable += 1
                continue
            usage = usage.plus(spent)
            silent += spent == TokenUsage() and not _failed(invocation)
        for call in calls:
            try:
                model_usage = model_usage.plus(_model_call_usage(call, records.get(call["parent"])))
            except _UnreadableError:
                unreadable += 1
        answered = {call["parent"] for call in calls}
        # A call the harness opened and did not fail, with no span of its own yet.
        unfinished = sum(
            1 for record in records.values() if record["id"] not in answered and not _failed(record)
        )
        if silent and not calls and not records:
            # An invocation that ended well and spent nothing made no model call that is
            # known: every invocation makes one, so its spans are still to come.
            unfinished += silent
        return TraceReading(
            invocations=len(invocations),
            usage=usage,
            model_calls=len(calls),
            model_usage=model_usage,
            unfinished=unfinished,
            unreadable=unreadable,
        )
