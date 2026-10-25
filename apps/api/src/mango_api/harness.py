"""AgentCore harness invocation (D13).

The request is built entirely server-side from the published version of the agent: the
client never controls prompt, tools, skills or allowed tools, and only picks the agent and one
of its allowed models (TM-I2, TM-M11). ``InvokeHarness`` overrides whatever the harness has
stored, so what runs is always what was approved. The caller's verified access token travels
only as the Authorization header of the ``remote_mcp`` tool pointing at the Gateway.
"""

from __future__ import annotations

import json
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import TYPE_CHECKING, Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, EventStreamError

from mango_api import knowledge_citations
from mango_api.pricing import Usage
from mango_core import invocation
from mango_core.agents import AgentLimits
from mango_core.harness_tools import (
    GATEWAY_MCP_SERVER,
    KNOWLEDGE_TARGET,
    KNOWLEDGE_TOOL,
    allowed_inline_tool,
    allowed_tool,
    gateway_tool_name,
)

if TYPE_CHECKING:
    from mypy_boto3_bedrock_agentcore import BedrockAgentCoreClient

MAX_HISTORY_MESSAGES = 20
PARAGRAPH_BREAK = "\n\n"
MAX_TOOL_INPUT_CHARS = 16 * 1024
"""Input of a write tool call kept to ask for its confirmation; a longer one is dropped."""
KNOWLEDGE = "knowledge"
"""Event of a knowledge search of the turn: its knowledge bases, how many fragments and the
document and page of each source, never their text (D88 (44))."""
WRITE_CALL = "write_call"
"""Internal event: a write tool was called. mango-api turns it into an approval request and
never forwards it to the client as it is."""
INLINE_CALL = "inline_call"
"""Internal event: the agent called an ``inline_function`` of this invocation (D87 (3)). The
harness hands the call back to mango-api and reaches no other system; its input is model
output, validated by whoever asked for the tool."""
MAX_INLINE_INPUT_CHARS = 128 * 1024
"""Input of an inline call kept; a longer one is dropped (``task_reports.MAX_INPUT_CHARS``)."""
MAX_RECORDED_CHARS = 512 * 1024
"""Input and answer kept of a recorded tool call (``task_reports.MAX_QUERY_CHARS``)."""
MAX_RECORDED_CALLS = 20
READ_MARGIN_SECONDS = 30
"""How much longer than the limit of a turn mango-api waits in silence for the harness. The
harness ends the turn itself when the limit is up: the margin lets its answer arrive first."""
CONNECT_TIMEOUT_SECONDS = 10
POOL_CONNECTIONS = 100
"""Connections kept open to AgentCore, per client. A turn holds one for as long as it lasts.
Sized for one task holding every open turn of the installation while the other is replaced:
about 330 active people, a turn a minute each, 12 s a turn, are 66 at once. Beyond it nothing
fails: a turn opens a connection of its own and closes it at the end."""
MAX_TURN_CLIENTS = 8
"""Clients kept, one per turn limit in use. Agents share a few limits (120 s unless changed)."""
TOOL_STOP = "tool_use"
"""Stop reason of a model message that ended as a tool call: the only end after which its
write tool calls are asked to be confirmed."""
CAP_STOP = "max_tokens"
"""Stop reason of a model call that reached its output cap (D74): its message ends there."""
CAP_ERROR = "runtimeClientError"
"""Error the harness ends an invocation with once a model call reached its cap: it treats
the cap as an exception, after delivering the message and its usage."""
_STREAM_ERRORS = ("internalServerException", "validationException", CAP_ERROR)
"""Errors the harness ends an invocation with. The service sends them as exceptions, and
botocore raises them while the stream is read."""
HARNESS_NOT_FOUND = "ResourceNotFoundException"
"""Error of an invocation whose harness, or its endpoint, does not exist: deleted outside
Mango, or by an uninstall that stopped halfway. AgentCore answers it instead of opening the
stream, so nothing ran."""
_NAME_BOUNDARIES = "/_.: "
"""What may come before a Gateway tool name in the name the harness reports (its server
prefix). Never a hyphen: `evil-ops___x` is a tool of another target, not `ops___x`."""


def _agentcore_client(region: str, config: Config) -> BedrockAgentCoreClient:
    return boto3.client("bedrock-agentcore", region_name=region, config=config)


class TurnClients:
    """AgentCore clients whose read timeout follows the limit of the turn they serve.

    The harness may stay silent for most of a turn (a slow tool, a model call it retries after
    a throttle). botocore gives up after 60 s without a byte by default, and cut turns that
    still had half of their time. A timeout belongs to a client, so there is one per limit.

    The SDK never sends an invocation twice. Its default retries a request whose answer did
    not arrive, and the first one may be running: the turn would repeat on its own, in the same
    runtime session, with one budget reservation for two model bills. A turn that fails is
    retried by the person.
    """

    def __init__(
        self,
        region: str,
        *,
        read_margin_seconds: int = READ_MARGIN_SECONDS,
        factory: Callable[[str, Config], BedrockAgentCoreClient] = _agentcore_client,
    ) -> None:
        self._region = region
        self._margin = read_margin_seconds
        self._factory = factory
        self._clients: OrderedDict[int, BedrockAgentCoreClient] = OrderedDict()
        self._lock = threading.Lock()

    def config(self, turn_seconds: int) -> Config:
        return Config(
            read_timeout=turn_seconds + self._margin,
            connect_timeout=CONNECT_TIMEOUT_SECONDS,
            retries={"total_max_attempts": 1, "mode": "standard"},
            max_pool_connections=POOL_CONNECTIONS,
        )

    def for_turn(self, turn_seconds: int) -> BedrockAgentCoreClient:
        with self._lock:
            client = self._clients.get(turn_seconds)
            if client is None:
                client = self._factory(self._region, self.config(turn_seconds))
                self._clients[turn_seconds] = client
                if len(self._clients) > MAX_TURN_CLIENTS:
                    # A turn in flight keeps its own reference: dropping the entry cuts nothing.
                    self._clients.popitem(last=False)
            else:
                self._clients.move_to_end(turn_seconds)
            return client


@dataclass(frozen=True)
class ChatTurn:
    role: str
    text: str


@dataclass
class StreamEvent:
    kind: str  # "delta" | "tool" | "status" | "knowledge" | "write_call" (internal)
    data: dict[str, Any] = field(default_factory=dict)


class Phase(StrEnum):
    """What the agent is doing right now, as far as mango-api can tell from the stream.

    It is structured progress computed here, never text of the model: with the guardrail in
    synchronous mode (D39) Bedrock holds back everything the model produces, reasoning
    included, until a block of the answer has been checked, so progress is the only thing that
    can be shown live.
    """

    THINKING = "thinking"
    """The model is working and nothing has been released yet."""
    TOOL = "tool"
    """A tool call is in flight."""
    TOOL_RESULT = "tool_result"
    """Every tool call has answered and the model is working on the results."""
    WRITING = "writing"
    """Checked text of the answer is arriving."""


class _Progress:
    """Phase of the turn; yields a ``status`` event only when it changes."""

    def __init__(self) -> None:
        self._last: dict[str, str] = {}

    def to(self, phase: Phase, tool: str = "") -> Iterator[StreamEvent]:
        data = {"phase": phase.value, **({"tool": tool} if tool else {})}
        if data != self._last:
            self._last = data
            yield StreamEvent("status", dict(data))


@dataclass(frozen=True)
class ToolCall:
    """One answered tool call, metadata only (D90): never its input or its answer."""

    name: str
    """As shown (without its prefix), and only a tool of the published version (TM-LP1)."""
    ok: bool
    ms: int
    """From the end of the model's tool call to the arrival of its answer: the time the tool
    took, without the time the model spent writing the call."""


@dataclass
class InvocationResult:
    text: str = ""
    stop_reason: str = ""
    usage: Usage = field(default_factory=Usage)
    tools: list[dict[str, str]] = field(default_factory=list)
    calls: list[dict[str, str]] = field(default_factory=list)
    """The calls of the tools ``run`` was asked to record, by their id in the stream: ``id``,
    ``name``, ``input``, ``output`` (the answer as text) and ``at`` (when the answer arrived).
    Untrusted, like every answer of a tool; read only to take a series from a query and the
    causes of an anomaly (D87 (4))."""
    searches: list[knowledge_citations.Search] = field(default_factory=list)
    """The knowledge searches of the turn, metadata only (D88 (44))."""
    interrupted: bool = False
    """The turn was ended here while the harness was still working (a write tool waits for a
    person, D27): its runtime session holds a half-finished turn."""
    started: bool = False
    """The harness was called (or about to be): from here on the agent may have spent."""
    harness_missing: bool = False
    """AgentCore answered that the harness does not exist: the agent never ran, so the turn
    is one that never started (D75 (10))."""
    usage_final: bool = False
    """``usage`` is everything the turn cost: the stream was read to its end and every model
    call reported its usage. False after an error, a cut or a call whose usage never arrived:
    the cost of the turn is then not known and its budget reservation is held (D73). The
    error the harness ends with right after the usage of a message cut at its token cap is
    that end of the stream, not a failure (D74)."""


def display_tool_name(raw: str) -> str:
    name = raw.rsplit("/", 1)[-1]
    return name.split("___", 1)[-1][:64]


@dataclass(frozen=True)
class AgentInvocation:
    """Everything of one invocation that comes from the published agent version (D32, D33)."""

    harness_arn: str
    qualifier: str
    """Harness endpoint (``live``): the version the provisioner published."""
    system_prompt: str
    model: str
    """One of the version's allowed models, already checked against the model catalog."""
    limits: AgentLimits
    allowed_tools: tuple[str, ...]
    gateway_url: str
    guardrail_id: str
    guardrail_version: str


def build_request(
    agent: AgentInvocation,
    *,
    session_id: str,
    actor_id: str,
    access_token: str,
    invocation_signature: str,
    history: list[ChatTurn],
    today: str | None = None,
    inline_tools: tuple[dict[str, Any], ...] = (),
) -> dict[str, Any]:
    """``inline_tools``: ``inline_function`` tools of this invocation only, built by mango-api
    (the internal tool of a report, D87 (3)). Their calls come back to mango-api: they reach no
    system, so the Gateway has nothing to govern (rule 3 as D87 precises it)."""
    date_line = f"Current date (UTC): {today or datetime.now(UTC).date().isoformat()}."
    messages = [
        {"role": turn.role, "content": [{"text": turn.text}]}
        for turn in history[-MAX_HISTORY_MESSAGES:]
    ]
    limits = agent.limits
    # Server-defined model configuration with the base guardrail (never client-supplied).
    model: dict[str, Any] = {"modelId": agent.model}
    # Every model call carries an output cap (D74): without it one call can outrun the turn's
    # budget reservation.
    model["maxTokens"] = limits.call_max_tokens
    if limits.temperature is not None:
        model["temperature"] = limits.temperature
    model["additionalParams"] = {
        "guardrailConfig": {
            "guardrailIdentifier": agent.guardrail_id,
            "guardrailVersion": agent.guardrail_version,
            "trace": "disabled",
        }
    }
    request: dict[str, Any] = {
        "harnessArn": agent.harness_arn,
        "qualifier": agent.qualifier,
        "runtimeSessionId": session_id,
        "actorId": actor_id,
        "messages": messages,
        "systemPrompt": [{"text": f"{agent.system_prompt}\n\n{date_line}"}],
        # Every tool goes through the Gateway (rule 3), registered as one MCP server. An agent
        # without tools gets no server at all; the empty allow-list also disables the harness
        # built-in shell and file tools.
        "tools": [
            *inline_tools,
            *(
                [
                    {
                        "type": "remote_mcp",
                        "name": GATEWAY_MCP_SERVER,
                        "config": {
                            "remoteMcp": {
                                "url": agent.gateway_url,
                                "headers": {
                                    "Authorization": f"Bearer {access_token}",
                                    invocation.HEADER: invocation_signature,
                                },
                            }
                        },
                    }
                ]
                if agent.allowed_tools
                else []
            ),
        ],
        # Exactly the tools of the published version, by name (no globs), and the inline ones.
        "allowedTools": [
            *agent.allowed_tools,
            *(allowed_inline_tool(str(t["name"])) for t in inline_tools),
        ],
        "maxIterations": limits.max_iterations,
        "maxTokens": limits.max_tokens,
        "timeoutSeconds": limits.timeout_seconds,
        "model": {"bedrockModelConfig": model},
    }
    return request


def paragraph_separator(text: str) -> str:
    """What to append so the next text starts a new Markdown paragraph ("" if it already does)."""
    if not text or text.endswith(PARAGRAPH_BREAK):
        return ""
    return "\n" if text.endswith("\n") else PARAGRAPH_BREAK


def _captured_tool(raw: str, capture: frozenset[str]) -> str | None:
    """The Gateway name in ``capture`` that ``raw`` (the name as the harness reports it, with
    or without its server prefix) refers to."""
    for name in capture:
        if raw == name or (raw.endswith(name) and raw[-len(name) - 1] in _NAME_BOUNDARIES):
            return name
    return None


class _WriteCalls:
    """Inputs of the write tool calls in flight, by content block (D27).

    The Gateway refuses a write tool without an approval, so the call itself changes nothing;
    its input is what mango-api shows to whoever confirms it. It comes in pieces, and whether
    the model finished writing it is only known when its message ends: a message that ends
    any other way than as a tool call (its token cap, the time limit, the guardrail, an end
    not known today) may hold a call that stops anywhere, even before its first piece, where
    it reads as a call with no arguments. So a call is reported when its message ends as a
    tool call, and otherwise never (D74). Once its block stops its input takes no more
    pieces.
    """

    def __init__(
        self,
        capture: frozenset[str],
        *,
        kind: str = WRITE_CALL,
        max_chars: int = MAX_TOOL_INPUT_CHARS,
    ) -> None:
        self._capture = capture
        self._kind = kind
        self._max = max_chars
        self._open: dict[int, tuple[str, list[str], int]] = {}
        self._complete: list[tuple[str, str]] = []

    def start(self, index: int, raw_name: str) -> bool:
        """Whether the call is to a write tool."""
        name = _captured_tool(raw_name, self._capture) if self._capture else None
        if name is None:
            return False
        self._open[index] = (name, [], 0)
        return True

    def add(self, index: int, piece: str) -> None:
        entry = self._open.get(index)
        if entry is None:
            return
        name, pieces, size = entry
        if size + len(piece) > self._max:
            # Too large to show and to sign: no request is made for it.
            del self._open[index]
            return
        pieces.append(piece)
        self._open[index] = (name, pieces, size + len(piece))

    def stop(self, index: int) -> None:
        """The block of the call of ``index`` stopped: its input is what arrived so far."""
        entry = self._open.pop(index, None)
        if entry is not None:
            self._complete.append((entry[0], "".join(entry[1])))

    def end(self, stop_reason: str) -> Iterator[StreamEvent]:
        """The message ended: report its calls, those whose block stopped and then those
        still open, only if it ended as a tool call. Its calls are forgotten either way."""
        for index in list(self._open):
            self.stop(index)
        calls, self._complete = self._complete, []
        if stop_reason != TOOL_STOP:
            return
        for name, arguments in calls:
            yield StreamEvent(self._kind, {"tool": name, "arguments": arguments})

    def drop(self) -> None:
        """Forget the calls of a message whose end never arrived: they are never asked."""
        self._open, self._complete = {}, []


class _Recorded:
    """Input and answer of the calls of some tools, by their id in the stream (D87 (4)).

    A call's input arrives in the deltas of its block; its answer, in the deltas of the block
    that starts with its result. Both are kept up to ``MAX_RECORDED_CHARS`` and a call that
    passes it is dropped whole: a cut answer is never read as a complete one."""

    def __init__(self, names: frozenset[str]) -> None:
        self._names = names
        self._by_index: dict[int, tuple[str, str]] = {}
        self._calls: dict[str, dict[str, Any]] = {}

    def call(self, index: int, call_id: str, name: str) -> None:
        if name in self._names and call_id and len(self._calls) < MAX_RECORDED_CALLS:
            self._calls[call_id] = {"id": call_id, "name": name, "input": [], "output": [], "n": 0}
            self._by_index[index] = (call_id, "input")

    def answer(self, index: int, call_id: str) -> None:
        if call_id in self._calls:
            self._by_index[index] = (call_id, "output")
            # When its answer arrived: the time of the query a report cites (D87, D88).
            self._calls[call_id]["at"] = datetime.now(UTC).isoformat(timespec="seconds")

    def add(self, index: int, piece: str) -> None:
        target = self._by_index.get(index)
        if target is None:
            return
        call = self._calls.get(target[0])
        if call is None:
            return
        call["n"] += len(piece)
        if call["n"] > MAX_RECORDED_CHARS:
            del self._calls[target[0]]
            return
        call[target[1]].append(piece)

    def stop(self, index: int) -> None:
        self._by_index.pop(index, None)

    def done(self) -> list[dict[str, str]]:
        return [
            {
                "id": c["id"],
                "name": c["name"],
                "input": "".join(c["input"]),
                "output": "".join(c["output"]),
                "at": c.get("at", ""),
            }
            for c in self._calls.values()
            if c["output"]
        ]


class _Searches:
    """Answers of the knowledge tool, by content block, read for their citations (D88 (44)).

    Only the tool of the ``knowledge`` target counts, and only when the version has it: the
    name in the stream is written by the model (TM-LP1). An answer longer than
    ``MAX_ANSWER_CHARS`` is dropped whole, and one marked as an error gives nothing."""

    _NAME = frozenset({gateway_tool_name(KNOWLEDGE_TARGET, KNOWLEDGE_TOOL)})

    def __init__(self, allowed: Iterable[str]) -> None:
        self._enabled = allowed_tool(KNOWLEDGE_TARGET, KNOWLEDGE_TOOL) in allowed
        self._calls: set[str] = set()
        self._open: dict[int, tuple[list[str], int]] = {}

    def call(self, call_id: str, raw_name: str) -> None:
        if self._enabled and call_id and _captured_tool(raw_name, self._NAME) is not None:
            self._calls.add(call_id)

    def answer(self, index: int, call_id: str, *, failed: bool) -> None:
        if call_id in self._calls:
            self._calls.discard(call_id)
            if not failed:
                self._open[index] = ([], 0)

    def add(self, index: int, piece: str) -> None:
        entry = self._open.get(index)
        if entry is None:
            return
        pieces, size = entry
        if size + len(piece) > knowledge_citations.MAX_ANSWER_CHARS:
            del self._open[index]
            return
        pieces.append(piece)
        self._open[index] = (pieces, size + len(piece))

    def stop(self, index: int) -> knowledge_citations.Search | None:
        entry = self._open.pop(index, None)
        return None if entry is None else knowledge_citations.search_of("".join(entry[0]))


def _result_pieces(delta: Any) -> Iterator[str]:
    """The text of a tool result delta: a list of blocks with ``text`` or ``json``."""
    for block in delta if isinstance(delta, list) else [delta]:
        if not isinstance(block, Mapping):
            continue
        if isinstance(block.get("text"), str):
            yield block["text"]
        elif "json" in block:
            yield json.dumps(block["json"], separators=(",", ":"), default=str)


def _raised[Event: Mapping[str, object]](stream: Iterable[Event]) -> Iterator[Event]:
    """The stream, with an error that arrived as one of its events raised as botocore raises
    the errors the service sends as exceptions. Nothing of the event goes into the exception
    but its name."""
    for event in stream:
        code = next((name for name in _STREAM_ERRORS if name in event), None)
        if code is not None:
            message = "the harness reported an error as an event"
            raise EventStreamError({"Error": {"Code": code, "Message": message}}, "InvokeHarness")
        yield event


def _events[Event: Mapping[str, object]](
    stream: Iterable[Event], ended_at_its_cap: Callable[[], bool]
) -> Iterator[Event]:
    """The events of the harness stream.

    botocore raises an error the harness reports instead of yielding it. The one that follows
    a message cut at its cap whose usage arrived is the end of that turn, not a failure: the
    stream ends there. Any other error is raised as it came.

    The service declares those errors as exceptions. Should one ever arrive as an event, it
    is raised here all the same (``_raised``): a turn fails in one way, whatever the shape
    of the error.
    """
    try:
        yield from _raised(stream)
    except EventStreamError as error:
        if error.response.get("Error", {}).get("Code") != CAP_ERROR or not ended_at_its_cap():
            raise


def run(  # noqa: PLR0912, PLR0915 - one branch per kind of stream event
    client: BedrockAgentCoreClient,
    request: dict[str, Any],
    result: InvocationResult,
    capture: frozenset[str] = frozenset(),
    *,
    inline: frozenset[str] = frozenset(),
    record: frozenset[str] = frozenset(),
    on_call: Callable[[ToolCall], None] | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> Iterator[StreamEvent]:
    """Invoke the harness and translate its event stream. Fills ``result`` as it goes.

    ``capture`` names the write tools of the agent (Gateway names): each call to one of them
    is also reported as a ``write_call`` event with its input, once its message has ended as
    a tool call (``tool_use``). A message that ended any other way, or whose end never
    arrived, reports none (D74): nothing is asked of a message the model may not have
    finished.

    A turn ends with the model message that calls a write tool. The Gateway refuses that call
    (it carries no approval) and the harness does not get past the refusal: its stream goes
    silent until the read times out, long after the request to confirm was shown. Nothing the
    agent could add matters either: the person decides, and the next turn tells the agent
    what happened. So the stream is closed once that message and its usage have arrived, and
    the tool is never tried again in this turn.

    ``inline`` names the ``inline_function`` tools of the request. The harness hands their
    calls back: each one is reported as an ``inline_call`` event with its input once its
    message has ended as a tool call, and the turn ends there, as with a write tool. ``record``
    names tools (as shown, without their prefix) whose calls are kept in ``result.calls``.

    ``on_call`` is told of each tool call of the published version once its answer arrives
    (the Actividad, D90): name, result and time, nothing of its input or answer. It must not
    raise. A write tool refused by the Gateway, or an inline call, gets no answer in the
    stream and is not told: its approval request or its report says what happened.
    """
    progress = _Progress()
    # The tool name in the stream is written by the model and the guardrail does not check it:
    # progress only names tools of the published version (TM-LP1).
    known_tools = {display_tool_name(tool) for tool in request.get("allowedTools", [])}
    # Sent before the call: the first event of the harness only arrives once the guardrail
    # has released the first block of the answer (or the first tool call).
    yield from progress.to(Phase.THINKING)
    result.started = True
    try:
        response = client.invoke_harness(**request)
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == HARNESS_NOT_FOUND:
            # Answered before any stream: no model call was made, nothing was spent.
            result.started = False
            result.harness_missing = True
        raise
    tool_names: dict[str, str] = {}
    # Tool call ids by their block, and when their block ended (the model finished the call).
    tool_blocks: dict[int, str] = {}
    called_at: dict[str, float] = {}
    running: set[str] = set()
    text_blocks: set[int] = set()
    write_calls = _WriteCalls(capture)
    inline_calls = _WriteCalls(inline, kind=INLINE_CALL, max_chars=MAX_INLINE_INPUT_CHARS)
    recorded = _Recorded(record)
    searches = _Searches(request.get("allowedTools", []))
    # Write tool calls in flight: the Gateway refuses them, whatever the harness does next.
    refused: set[str] = set()
    asked = False
    # A model call reports its usage after its message: while one is owed, or none has
    # arrived at all, what the turn cost is not known.
    reported = owed = False
    # The last thing the stream delivered is the usage of a message cut at its cap: no model
    # call is in flight and every one is counted. Told by those events, never by the text
    # of the error that follows them (D74).
    at_cap = False

    def ends_at_its_cap() -> bool:
        return at_cap

    stream = response["stream"]
    for event in _events(stream, ends_at_its_cap):
        if result.interrupted:
            # The event after the message that called a write tool: its usage, which is all
            # that is still needed from this stream.
            if "metadata" in event:
                result.usage.add(Usage.from_bedrock(event["metadata"].get("usage", {})))
                result.usage_final = True
            break
        at_cap = False
        if "contentBlockStart" in event:
            block = event["contentBlockStart"]
            start = block.get("start", {})
            if "toolUse" in start:
                tool_id = start["toolUse"].get("toolUseId", "")
                index = block.get("contentBlockIndex", -1)
                raw_name = str(start["toolUse"].get("name", ""))
                if write_calls.start(index, raw_name):
                    refused.add(tool_id)
                    asked = True
                elif inline and raw_name in inline and inline_calls.start(index, raw_name):
                    # Handed back to mango-api: the turn ends with this message (D87 (3)).
                    asked = True
                name = display_tool_name(start["toolUse"].get("name", "tool"))
                recorded.call(index, tool_id, name)
                searches.call(tool_id, raw_name)
                tool_names[tool_id] = name
                tool_blocks[index] = tool_id
                called_at[tool_id] = clock()
                running.add(tool_id)
                # Text before and after a tool call are separate model blocks; keep them as
                # separate paragraphs instead of gluing sentences together.
                separator = paragraph_separator(result.text)
                if separator:
                    result.text += separator
                    yield StreamEvent("delta", {"text": separator})
                result.tools.append({"name": name, "status": "started"})
                yield StreamEvent("tool", {"name": name, "status": "started"})
                yield from progress.to(Phase.TOOL, name if name in known_tools else "")
            elif "toolResult" in start:
                # The message before this result never reported its end: nothing is asked.
                write_calls.drop()
                inline_calls.drop()
                tool_id = start["toolResult"].get("toolUseId", "")
                recorded.answer(block.get("contentBlockIndex", -1), tool_id)
                name = tool_names.get(tool_id, "tool")
                status = "completed" if start["toolResult"].get("status") != "error" else "error"
                searches.answer(
                    block.get("contentBlockIndex", -1), tool_id, failed=status == "error"
                )
                result.tools.append({"name": name, "status": status})
                yield StreamEvent("tool", {"name": name, "status": status})
                if on_call is not None and tool_id in called_at and name in known_tools:
                    elapsed = max(0, round((clock() - called_at.pop(tool_id)) * 1000))
                    on_call(ToolCall(name=name, ok=status != "error", ms=elapsed))
                running.discard(tool_id)
                refused.discard(tool_id)
                if not running:
                    yield from progress.to(Phase.TOOL_RESULT)
            else:
                text_blocks.add(block.get("contentBlockIndex", -1))
        elif "contentBlockDelta" in event:
            delta = event["contentBlockDelta"].get("delta", {})
            text = delta.get("text")
            if isinstance(text, str) and text:
                yield from progress.to(Phase.WRITING)
                result.text += text
                yield StreamEvent("delta", {"text": text})
            index = event["contentBlockDelta"].get("contentBlockIndex", -1)
            tool_delta = delta.get("toolUse")
            piece = tool_delta.get("input") if tool_delta else None
            if isinstance(piece, str):
                write_calls.add(index, piece)
                inline_calls.add(index, piece)
                recorded.add(index, piece)
            if "toolResult" in delta:
                for part in _result_pieces(delta["toolResult"]):
                    recorded.add(index, part)
                    searches.add(index, part)
        elif "contentBlockStop" in event:
            index = event["contentBlockStop"].get("contentBlockIndex", -1)
            if index in tool_blocks:
                called_at[tool_blocks.pop(index)] = clock()
            write_calls.stop(index)
            inline_calls.stop(index)
            recorded.stop(index)
            search = searches.stop(index)
            if search is not None:
                result.searches.append(search)
                yield StreamEvent(KNOWLEDGE, search.event())
        elif "messageStop" in event:
            result.stop_reason = event["messageStop"].get("stopReason", "")
            yield from write_calls.end(result.stop_reason)
            yield from inline_calls.end(result.stop_reason)
            result.interrupted = asked
            owed = True
        elif "metadata" in event:
            result.usage.add(Usage.from_bedrock(event["metadata"].get("usage", {})))
            at_cap = owed and result.stop_reason == CAP_STOP
            reported, owed = True, False
    result.calls = recorded.done()
    if not result.interrupted:
        result.usage_final = reported and not owed
    if result.interrupted:
        # Dropping the connection is what stops the wait; the harness is not read again.
        close = getattr(stream, "close", None)
        if callable(close):
            close()
        for tool_id in sorted(refused):
            name = tool_names.get(tool_id, "tool")
            result.tools.append({"name": name, "status": "error"})
            yield StreamEvent("tool", {"name": name, "status": "error"})
