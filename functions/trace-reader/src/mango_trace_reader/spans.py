"""What the trace reader takes from a span, and how spans become traces.

The spans come from log groups that hold the telemetry of the whole account (``aws/spans``) or
of a runtime, and nothing in them is trusted: any principal of the account allowed to write
traces can write a span with the attributes it wants. So a span is read through a closed list
(threat model ``observability-threat-model.md``, TM-OB1):

* its name, ``traceId``, ``spanId``, ``parentSpanId``, start, end and ``status.code``;
* the attributes ``session.id``, ``harness.id``, ``gen_ai.request.model``, ``gen_ai.tool.name``,
  ``gen_ai.tool.status`` and the token counts.

Each value is checked for type, shape and range. Anything else a span carries (URLs, the access
key of the caller, the description and schema of a tool, and content if its capture were ever on)
is never read, returned or logged.

Three kinds of span make a trace (one per invocation of a harness, as the harness writes them,
seen on 2026-10-06; finding ``…las-trazas-de-agentcore-traen-los-tokens-por-sesion.md``). In the
customer's installation, on 2026-11-05, they were in ``aws/spans``, and the ``execute_tool`` spans
carried the description and the JSON schema of the tool: only the closed list above is read.

* ``invoke_agent …``: the invocation, with the tokens the harness counted;
* ``chat <model id>``: one model call, with the tokens the model reported (``chat`` alone is
  the harness's record of the same call: it repeats its tokens and is not kept);
* ``execute_tool <tool>``: one tool call.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Final, Literal

INVOCATION_PREFIX: Final = "invoke_agent"
MODEL_CALL_PREFIX: Final = "chat "
CALL_RECORD_NAME: Final = "chat"
TOOL_PREFIX: Final = "execute_tool"
STATUS_ERROR: Final = "ERROR"
MAX_TOKENS: Final = 1_000_000_000
MAX_SPANS_PER_TRACE: Final = 60
"""Spans of a trace that are returned; the rest are counted (``more_spans``)."""

EVALS_ID: Final = "evals"
"""The harness of the evals (``Mango_<ns>_a_evals``, D110 (3)) is the only one that captures
content; its spans are never read (only the evaluator's role reads them)."""
AGENT_ID_PATTERN: Final = r"(?:[a-z2-7]{16}|[a-z][a-z0-9]{1,15})"
"""``mango_core.agents.AGENT_ID_PATTERN`` without its anchors (a test keeps them equal)."""
_TRACE_ID: Final = re.compile(r"^[0-9a-f]{32}$")
_SPAN_ID: Final = re.compile(r"^[0-9a-f]{16}$")
_SESSION_ID: Final = re.compile(r"^[0-9a-f]{64}$")
_MODEL: Final = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
_TOOL: Final = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_TOOL_FAILED: Final = frozenset({"error", "failed", "failure"})
_NANOS_PER_MS: Final = 1_000_000
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

Kind = Literal["invocation", "model", "tool"]


class UnreadableSpanError(Exception):
    """A span of the installation whose shape is not the expected one."""


@dataclass(frozen=True)
class Tokens:
    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0

    def plus(self, other: Tokens) -> Tokens:
        return Tokens(
            self.input + other.input,
            self.output + other.output,
            self.cache_read + other.cache_read,
            self.cache_write + other.cache_write,
        )


@dataclass(frozen=True)
class Span:
    kind: Kind
    trace_id: str
    span_id: str
    agent_id: str
    session_id: str | None
    start_ns: int
    end_ns: int
    failed: bool
    name: str | None = None
    """The model of a model call, the tool of a tool call; ``None`` for an invocation."""
    tokens: Tokens | None = None
    """Tokens of an invocation or a model call, when it reports them."""


def harness_pattern(harness_prefix: str) -> re.Pattern[str]:
    """``harness.id`` of a harness of the installation: ``Mango_<ns>_a_<agent>-<10 chars>``."""
    return re.compile(rf"^{re.escape(harness_prefix)}({AGENT_ID_PATTERN})-[A-Za-z0-9]{{10}}$")


def filter_pattern(harness_prefix: str, agent_id: str | None = None) -> str:
    """CloudWatch Logs filter for the spans of the installation's harnesses (or one agent's)."""
    if not re.fullmatch(r"Mango_[a-z0-9]{3,8}_a_", harness_prefix):
        raise ValueError("invalid harness prefix")
    if agent_id is not None and (
        not re.fullmatch(AGENT_ID_PATTERN, agent_id) or agent_id == EVALS_ID
    ):
        raise ValueError("invalid agent id")
    harness = f"{harness_prefix}{agent_id}-*" if agent_id else f"{harness_prefix}*"
    return (
        f"{{ ($.attributes.['harness.id'] = \"{harness}\") && "
        f'(($.name = "{INVOCATION_PREFIX}*") || ($.name = "{MODEL_CALL_PREFIX}*") || '
        f'($.name = "{TOOL_PREFIX}*")) }}'
    )


QUERY_LIMIT: Final = 10_000
"""Rows one Logs Insights query returns at most (its own limit): more says ``capped``."""


def insights_query(harness_prefix: str, agent_id: str | None = None) -> str:
    """The Logs Insights query for the same spans as ``filter_pattern`` (D113), newest first.

    Built only from the installation's prefix and an agent id that matched its pattern: nothing
    of a request reaches the query as text. ``@log`` says which log group each event came from.
    """
    if not re.fullmatch(r"Mango_[a-z0-9]{3,8}_a_", harness_prefix):
        raise ValueError("invalid harness prefix")
    if agent_id is not None and (
        not re.fullmatch(AGENT_ID_PATTERN, agent_id) or agent_id == EVALS_ID
    ):
        raise ValueError("invalid agent id")
    harness = f"{harness_prefix}{agent_id}-" if agent_id else harness_prefix
    return (
        "fields @log, @message"
        f" | filter `attributes.harness.id` like /^{harness}/"
        f" | filter name like /^({INVOCATION_PREFIX}|{MODEL_CALL_PREFIX}|{TOOL_PREFIX})/"
        " | sort @timestamp desc"
        f" | limit {QUERY_LIMIT}"
    )


def _count(attributes: dict[str, Any], names: tuple[str, ...]) -> int | None:
    for name in names:
        if name in attributes:
            value = attributes[name]
            # ``bool`` is an ``int`` in Python; a count is never one.
            if type(value) is not int or not 0 <= value <= MAX_TOKENS:
                raise UnreadableSpanError
            return value
    return None


def _tokens(attributes: dict[str, Any]) -> Tokens | None:
    tokens_in, tokens_out = _count(attributes, _INPUT), _count(attributes, _OUTPUT)
    if tokens_in is None and tokens_out is None:
        return None
    return Tokens(
        tokens_in or 0,
        tokens_out or 0,
        _count(attributes, _CACHE_READ) or 0,
        _count(attributes, _CACHE_WRITE) or 0,
    )


def _kind(name: str) -> Kind | None:
    if name.startswith(INVOCATION_PREFIX):
        return "invocation"
    if name.startswith(MODEL_CALL_PREFIX):
        return "model"
    if name.startswith(TOOL_PREFIX):
        return "tool"
    return None


def parse(message: str, harness: re.Pattern[str]) -> Span | None:
    """The span of a log event when it is one of the installation's that is read; ``None`` for
    anything else. Raises ``UnreadableSpanError`` when it is one but its shape is not."""
    try:
        raw = json.loads(message)
    except ValueError:
        return None
    if not isinstance(raw, dict):
        return None
    attributes, name = raw.get("attributes"), raw.get("name")
    if not isinstance(attributes, dict) or not isinstance(name, str):
        return None
    harness_id = attributes.get("harness.id")
    matched = harness.fullmatch(harness_id) if isinstance(harness_id, str) else None
    kind = _kind(name)
    # The filter already says so; what is returned is checked again here. A span of the evals
    # harness is never read, even if it reached aws/spans (D110 (8)).
    if matched is None or kind is None or matched.group(1) == EVALS_ID:
        return None
    trace_id, span_id = raw.get("traceId"), raw.get("spanId")
    start, end = raw.get("startTimeUnixNano"), raw.get("endTimeUnixNano")
    if (
        not isinstance(trace_id, str)
        or not _TRACE_ID.fullmatch(trace_id)
        or not isinstance(span_id, str)
        or not _SPAN_ID.fullmatch(span_id)
        or type(start) is not int
        or type(end) is not int
        or not 0 < start <= end
    ):
        raise UnreadableSpanError
    session = attributes.get("session.id")
    session_id = session if isinstance(session, str) and _SESSION_ID.fullmatch(session) else None
    status = raw.get("status")
    failed = isinstance(status, dict) and status.get("code") == STATUS_ERROR
    label: str | None = None
    tokens: Tokens | None = None
    if kind == "model":
        # The model call is named after its model (``chat <model id>``): the name says it when
        # the attribute does not.
        model = attributes.get("gen_ai.request.model")
        if not isinstance(model, str):
            model = name[len(MODEL_CALL_PREFIX) :]
        label = model if _MODEL.fullmatch(model) else None
        tokens = _tokens(attributes)
    elif kind == "tool":
        # ``execute_tool <target>___<tool>``: the name says it when the attribute does not.
        tool = attributes.get("gen_ai.tool.name")
        if not isinstance(tool, str):
            tool = name[len(TOOL_PREFIX) :].strip()
        if not _TOOL.fullmatch(tool):
            raise UnreadableSpanError
        label = tool
        tool_status = attributes.get("gen_ai.tool.status")
        failed = failed or (isinstance(tool_status, str) and tool_status.lower() in _TOOL_FAILED)
    else:
        tokens = _tokens(attributes)
    return Span(
        kind=kind,
        trace_id=trace_id,
        span_id=span_id,
        agent_id=matched.group(1),
        session_id=session_id,
        start_ns=start,
        end_ns=end,
        failed=failed,
        name=label,
        tokens=tokens,
    )


@dataclass
class Trace:
    """The spans of one trace (one invocation of a harness)."""

    trace_id: str
    spans: dict[str, Span] = field(default_factory=dict)

    def add(self, span: Span) -> None:
        # The same span may be in both destinations while a runtime changes mode.
        self.spans.setdefault(span.span_id, span)

    def out(self) -> dict[str, Any] | None:
        """The trace as the reader returns it; ``None`` when its spans disagree on the agent."""
        spans = sorted(self.spans.values(), key=lambda s: (s.start_ns, s.span_id))
        agents = {s.agent_id for s in spans}
        if len(agents) != 1:
            return None
        invocations = [s for s in spans if s.kind == "invocation"]
        calls = [s for s in spans if s.kind == "model"]
        tools = [s for s in spans if s.kind == "tool"]
        # Without its invocation span (not every turn has one: one that asks to confirm a write
        # tool does not), the trace spans its model and tool calls.
        bounds = invocations or spans
        start = min(s.start_ns for s in bounds)
        end = max(s.end_ns for s in bounds)
        sessions = {s.session_id for s in spans if s.session_id}
        models = [s.name for s in calls if s.name]
        # The model calls carry what the model reported, also of a call that outlived its
        # invocation (a turn cut at its time limit); the invocation carries the cache tokens.
        reported = [s.tokens for s in calls if s.tokens is not None]
        tokens = Tokens()
        for t in reported or [s.tokens for s in invocations if s.tokens is not None]:
            tokens = tokens.plus(Tokens(t.input, t.output))
        for t in (s.tokens for s in invocations if s.tokens is not None):
            tokens = tokens.plus(Tokens(cache_read=t.cache_read, cache_write=t.cache_write))
        known = bool(reported) or any(s.tokens is not None for s in invocations)
        steps = [s for s in spans if s.kind != "invocation"]
        return {
            "trace_id": self.trace_id,
            "session_id": next(iter(sessions)) if len(sessions) == 1 else None,
            "agent_id": agents.pop(),
            "start_ms": start // _NANOS_PER_MS,
            "duration_ms": (end - start) // _NANOS_PER_MS,
            "failed": any(s.failed for s in spans),
            "model": models[-1] if models else None,
            "tokens": (
                {
                    "input": tokens.input,
                    "output": tokens.output,
                    "cache_read": tokens.cache_read,
                    "cache_write": tokens.cache_write,
                }
                if known
                else None
            ),
            "model_calls": len(calls),
            "tool_calls": len(tools),
            "spans": [_step(s, start) for s in steps[:MAX_SPANS_PER_TRACE]],
            "more_spans": max(0, len(steps) - MAX_SPANS_PER_TRACE),
        }


def _step(span: Span, trace_start: int) -> dict[str, Any]:
    return {
        "kind": span.kind,
        "name": span.name,
        "offset_ms": max(0, span.start_ns - trace_start) // _NANOS_PER_MS,
        "duration_ms": (span.end_ns - span.start_ns) // _NANOS_PER_MS,
        "failed": span.failed,
        "input_tokens": span.tokens.input if span.tokens else None,
        "output_tokens": span.tokens.output if span.tokens else None,
    }
