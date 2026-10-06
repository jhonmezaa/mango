"""AgentCore harness invocation (D13).

The request is built entirely server-side from the published version of the agent: the
client never controls prompt, tools, skills or allowed tools, and only picks the agent and one
of its allowed models (TM-I2, TM-M11). ``InvokeHarness`` overrides whatever the harness has
stored, so what runs is always what was approved. The caller's verified access token travels
only as the Authorization header of the ``remote_mcp`` tool pointing at the Gateway.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import TYPE_CHECKING, Any

import boto3
from botocore.config import Config

from mango_api.pricing import Usage
from mango_core import invocation
from mango_core.agents import AgentLimits
from mango_core.harness_tools import GATEWAY_MCP_SERVER

if TYPE_CHECKING:
    from mypy_boto3_bedrock_agentcore import BedrockAgentCoreClient

MAX_HISTORY_MESSAGES = 20
PARAGRAPH_BREAK = "\n\n"
MAX_TOOL_INPUT_CHARS = 16 * 1024
"""Input of a write tool call kept to ask for its confirmation; a longer one is dropped."""
WRITE_CALL = "write_call"
"""Internal event: a write tool was called. mango-api turns it into an approval request and
never forwards it to the client as it is."""
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
    kind: str  # "delta" | "tool" | "status" | "error" | "write_call" (internal)
    data: dict[str, str] = field(default_factory=dict)


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


@dataclass
class InvocationResult:
    text: str = ""
    stop_reason: str = ""
    usage: Usage = field(default_factory=Usage)
    tools: list[dict[str, str]] = field(default_factory=list)
    failed: bool = False
    interrupted: bool = False
    """The turn was ended here while the harness was still working (a write tool waits for a
    person, D27): its runtime session holds a half-finished turn."""
    started: bool = False
    """The harness was called (or about to be): from here on the agent may have spent."""
    usage_final: bool = False
    """``usage`` is everything the turn cost: the stream was read to its end and every model
    call reported its usage. False after an error, a cut or a call whose usage never arrived:
    the cost of the turn is then not known and its budget reservation is held (D73)."""


def _display_tool_name(raw: str) -> str:
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
) -> dict[str, Any]:
    date_line = f"Current date (UTC): {today or datetime.now(UTC).date().isoformat()}."
    messages = [
        {"role": turn.role, "content": [{"text": turn.text}]}
        for turn in history[-MAX_HISTORY_MESSAGES:]
    ]
    limits = agent.limits
    # Server-defined model configuration with the base guardrail (never client-supplied).
    model: dict[str, Any] = {"modelId": agent.model}
    if limits.max_tokens_per_call is not None:
        model["maxTokens"] = limits.max_tokens_per_call
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
        else [],
        # Exactly the tools of the published version, by name (no globs).
        "allowedTools": list(agent.allowed_tools),
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
    its input is what mango-api shows to whoever confirms it. It comes in pieces and is only
    reported once the block is complete.
    """

    def __init__(self, capture: frozenset[str]) -> None:
        self._capture = capture
        self._open: dict[int, tuple[str, list[str], int]] = {}

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
        if size + len(piece) > MAX_TOOL_INPUT_CHARS:
            # Too large to show and to sign: no request is made for it.
            del self._open[index]
            return
        pieces.append(piece)
        self._open[index] = (name, pieces, size + len(piece))

    def close(self, index: int | None = None) -> Iterator[StreamEvent]:
        """Report the call of ``index``, or every call still open."""
        indexes = list(self._open) if index is None else [index]
        for key in indexes:
            entry = self._open.pop(key, None)
            if entry is not None:
                yield StreamEvent(WRITE_CALL, {"tool": entry[0], "arguments": "".join(entry[1])})


def run(  # noqa: PLR0912, PLR0915 - one branch per kind of stream event
    client: BedrockAgentCoreClient,
    request: dict[str, Any],
    result: InvocationResult,
    capture: frozenset[str] = frozenset(),
) -> Iterator[StreamEvent]:
    """Invoke the harness and translate its event stream. Fills ``result`` as it goes.

    ``capture`` names the write tools of the agent (Gateway names): each call to one of them
    is also reported as a ``write_call`` event with its input.

    A turn ends with the model message that calls a write tool. The Gateway refuses that call
    (it carries no approval) and the harness does not get past the refusal: its stream goes
    silent until the read times out, long after the request to confirm was shown. Nothing the
    agent could add matters either: the person decides, and the next turn tells the agent
    what happened. So the stream is closed once that message and its usage have arrived, and
    the tool is never tried again in this turn.
    """
    progress = _Progress()
    # The tool name in the stream is written by the model and the guardrail does not check it:
    # progress only names tools of the published version (TM-LP1).
    known_tools = {_display_tool_name(tool) for tool in request.get("allowedTools", [])}
    # Sent before the call: the first event of the harness only arrives once the guardrail
    # has released the first block of the answer (or the first tool call).
    yield from progress.to(Phase.THINKING)
    result.started = True
    response = client.invoke_harness(**request)
    tool_names: dict[str, str] = {}
    running: set[str] = set()
    text_blocks: set[int] = set()
    write_calls = _WriteCalls(capture)
    # Write tool calls in flight: the Gateway refuses them, whatever the harness does next.
    refused: set[str] = set()
    asked = False
    # A model call reports its usage after its message: while one is owed, or none has
    # arrived at all, what the turn cost is not known.
    reported = owed = False
    stream = response["stream"]
    for event in stream:
        if result.interrupted:
            # The event after the message that called a write tool: its usage, which is all
            # that is still needed from this stream.
            if "metadata" in event:
                result.usage.add(Usage.from_bedrock(event["metadata"].get("usage", {})))
                result.usage_final = True
            break
        if "contentBlockStart" in event:
            block = event["contentBlockStart"]
            start = block.get("start", {})
            if "toolUse" in start:
                tool_id = start["toolUse"].get("toolUseId", "")
                if write_calls.start(
                    block.get("contentBlockIndex", -1), str(start["toolUse"].get("name", ""))
                ):
                    refused.add(tool_id)
                    asked = True
                name = _display_tool_name(start["toolUse"].get("name", "tool"))
                tool_names[tool_id] = name
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
                yield from write_calls.close()
                tool_id = start["toolResult"].get("toolUseId", "")
                name = tool_names.get(tool_id, "tool")
                status = "completed" if start["toolResult"].get("status") != "error" else "error"
                result.tools.append({"name": name, "status": status})
                yield StreamEvent("tool", {"name": name, "status": status})
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
            tool_delta = delta.get("toolUse")
            piece = tool_delta.get("input") if tool_delta else None
            if isinstance(piece, str):
                write_calls.add(event["contentBlockDelta"].get("contentBlockIndex", -1), piece)
        elif "contentBlockStop" in event:
            yield from write_calls.close(event["contentBlockStop"].get("contentBlockIndex", -1))
        elif "messageStop" in event:
            yield from write_calls.close()
            result.stop_reason = event["messageStop"].get("stopReason", "")
            result.interrupted = asked
            owed = True
        elif "metadata" in event:
            result.usage.add(Usage.from_bedrock(event["metadata"].get("usage", {})))
            reported, owed = True, False
        elif any(
            k in event
            for k in ("internalServerException", "validationException", "runtimeClientError")
        ):
            result.failed = True
            yield StreamEvent("error", {"code": "upstream_error", "message": "agent error"})
            return
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
