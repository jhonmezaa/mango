"""AgentCore harness invocation (D13).

The request is built entirely server-side from the published version of the agent: the
client never controls prompt, tools, skills or allowed tools, and only picks the agent and one
of its allowed models (TM-I2, TM-M11). ``InvokeHarness`` overrides whatever the harness has
stored, so what runs is always what was approved. The caller's verified access token travels
only as the Authorization header of the ``remote_mcp`` tool pointing at the Gateway.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import TYPE_CHECKING, Any, Final

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, EventStreamError

from mango_api import knowledge_citations
from mango_api.pricing import Usage
from mango_core import invocation, remote_mcp
from mango_core.agents import AgentLimits
from mango_core.harness_tools import (
    CODE_RUN_TOOL,
    CODE_TARGET,
    GATEWAY_MCP_SERVER,
    KNOWLEDGE_TARGET,
    KNOWLEDGE_TOOL,
    SKILLS_TOOL,
    TEXTDOC_TARGET,
    TEXTDOC_TOOLS,
    allowed_inline_tool,
    allowed_tool,
    code_allowed_tools,
    gateway_tool_name,
    skills_allowed_tool,
)

if TYPE_CHECKING:
    from mypy_boto3_bedrock_agentcore import BedrockAgentCoreClient

logger = logging.getLogger(__name__)

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
REMOTE_CONNECTION_REQUIRED = "remote_connection_required"
"""Event of a tool of a remote MCP that answered ``consent_required`` (D94, D98 (20)): the
person has to connect their account. It names the registration, never a URL: the ``RESPONSE``
interceptor removed it, and mango-api hands it out only from «Mis conexiones»."""
MAX_CONSENT_ERROR_CHARS = 4096
"""Answer of a failed remote tool call read for ``consent_required``; the rest is ignored."""
_CONSENT_REQUIRED = re.compile(r"\bconsent_required\b")
MAX_INLINE_INPUT_CHARS = 128 * 1024
"""Input of an inline call kept; a longer one is dropped (``task_reports.MAX_INPUT_CHARS``)."""
MAX_RECORDED_CHARS = 512 * 1024
"""Input and answer kept of a recorded tool call (``task_reports.MAX_QUERY_CHARS``)."""
MAX_RECORDED_CALLS = 20
MAX_APP_CALLS = 3
"""MCP Apps one answer shows (D125): the first calls of tools with an app that answered."""
MAX_APP_INPUT_CHARS = 16 * 1024
MAX_APP_OUTPUT_CHARS = 256 * 1024
"""What is kept of the input and the answer of a call with an app: the input is what the
model wrote (it must be a JSON object), the answer the Gateway's, already cut by the
``RESPONSE`` interceptor. A call past either bound gets no app: its answer is never shown cut."""
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
START_ERROR = "InternalServerException"
"""What AgentCore answers when it could not start a turn's runtime session (an incident of
AgentCore Runtime in us-east-1, 2026-11-09/10: «errors or timeouts when creating new agent
runtime sessions … retries … may succeed»). It is an answer, before any stream: nothing ran."""

START_RETRY_DELAYS = (1.0, 3.0)
"""Waits before each new attempt after :data:`START_ERROR` (D121 (11)): two more at most."""

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
    retried by the person. The one exception is :func:`run`'s: AgentCore *answered* that it
    could not start the turn (:data:`START_ERROR`), so nothing is running (D121 (11)).
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
    CODE = "code"
    """A cell of the code sandbox is running (D114, design «Ejecutando código…»)."""


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


@dataclass(frozen=True)
class AppCall:
    """One answered call of a remote tool that has an MCP App (D125). Untrusted, like every
    answer of a tool: it only goes to the app's own frame, in the second origin."""

    gateway_tool: str
    """The Gateway name of the tool (``remote-<registration>___<tool>``)."""
    input: str
    output: str


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
    connection_required: list[str] = field(default_factory=list)
    """Registrations of remote MCPs whose tool answered ``consent_required`` in this turn: the
    person has not connected their account (D98 (20)). Ids only, never a URL."""
    remote_sources: list[str] = field(default_factory=list)
    """Registrations of remote MCPs whose tools answered in this turn (design «Leyó {servicio}»)."""
    app_calls: list[AppCall] = field(default_factory=list)
    """Calls of remote tools with an MCP App that answered (D125), in order, at most
    ``MAX_APP_CALLS``: what their app gets as ``tool-input`` and ``tool-result``."""
    guardrail: list[dict[str, str]] = field(default_factory=list)
    """What the base guardrail decided in this turn, from its trace: where (``input`` or
    ``output``), the policy, the type, the action and the confidence. Never the text it found
    (the trace's ``match`` holds it): only this summary is kept, to know why a turn was cut."""
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
    skills: tuple[str, ...] = ()
    """Ids of the skills of the version (D92). The provisioner put them in the harness; the
    invocation only allows the tool that loads them, and never sends ``skills``: invoke-time
    skills are added to the harness's, never instead of them."""


REMOTE_CONNECT_LINE = (
    "Some tools read external services with the user's own account. If one says the account "
    "is not connected, never write a link or URL to connect or authorize it: Mango shows the "
    "user its own «Conectar» button. Say that they need to connect their account and ask again."
)
"""Platform line for agents with remote MCP tools: a model told to connect invents a link."""


BLOCKED_INPUT_MESSAGE = (
    "No puedo procesar esta solicitud porque infringe las políticas de uso de Mango."
)
BLOCKED_OUTPUT_MESSAGE = (
    "No puedo mostrar esta respuesta porque infringe las políticas de uso de Mango."
)
"""What the base guardrail answers when it blocks (``blockedInputMessaging`` and
``blockedOutputsMessaging`` of ``infra/lib/constructs/agent-platform.ts``; a test keeps them
equal)."""

GUARDRAIL_MASKED = "guardrail_masked"
"""Stop reason of a turn the guardrail only masked: the model reports ``guardrail_intervened``
also when it masked a password in an answer that arrived whole (D34, 2026-11-09). Not a cut:
the chat shows the answer as it is, without «se cortó»."""

CHARTS_LINE = (
    "Charts and tables of data go in your answer, where the user reads them. When the data is "
    "already in the conversation (the user's message or a tool's answer), draw it without "
    "running code: write a fenced block with the language mango-chart and one JSON object: "
    "chartType (bar, line, pie or scatter), data (a list of row objects), xKey (the category "
    "or x field), series (a list of {key, label}), optional layout vertical for horizontal "
    "bars when the category names are long, valueFormat (compact, integer or raw), "
    "valuePrefix or valueSuffix (such as $ or %) and meta {title, subtitle}. Mango draws it "
    "there, interactive, at most 5000 rows and 20 series. A table of data is a Markdown "
    "table. Use run_python only when something has to be computed; then draw the result "
    "from the cell with display_chart and display_table, and use matplotlib only for a "
    "figure those cannot draw."
)
"""Platform line for every agent (D118 (8)): without it a model never writes the
``mango-chart`` block the chat draws, and puts charts in a Canvas document instead."""

PASSWORDS_LINE = (
    "Do not write passwords in your answers or documents, not even made-up examples: describe "
    "what a strong password looks like, or use a placeholder such as <password>."
)
"""Platform line for every agent (decision of the owner, 2026-11-09, D34): the base guardrail
masks passwords (``ANONYMIZE``) only in the output, so a password the model writes is not masked
in what the harness sends back, and an example password in a Canvas document came back in every
later turn of its conversation."""

CANVAS_CHARTS_LINE = (
    "Never use the Canvas for a chart or a table of data: the Canvas is only for a document, "
    "an app or code the user asked for, to edit or iterate on."
)
"""Platform line for versions with the Canvas tools (D124 (6), D118 (8))."""


def _runs_code(allowed_tools: Iterable[str]) -> bool:
    return any(tool in allowed_tools for tool in code_allowed_tools())


def _has_remote_tools(allowed_tools: Iterable[str]) -> bool:
    return any(
        remote_mcp.split_gateway_tool(name.rpartition("/")[2]) is not None for name in allowed_tools
    )


_TRACE_POLICIES: Mapping[str, tuple[str, ...]] = {
    "contentPolicy": ("filters",),
    "sensitiveInformationPolicy": ("piiEntities", "regexes"),
    "topicPolicy": ("topics",),
    "wordPolicy": ("customWords", "managedWordLists"),
    "contextualGroundingPolicy": ("filters",),
}


def guardrail_summary(trace: Any) -> list[dict[str, str]]:
    """The decisions of the base guardrail in a Converse ``trace.guardrail``, without what it
    found: where, the policy, the type (or name), the action and the confidence. The ``match``
    of a sensitive entity (the password itself) and any text are never copied."""
    if not isinstance(trace, Mapping):
        return []
    found: list[dict[str, str]] = []

    def assessments(where: str, value: Any) -> None:
        items = value.values() if isinstance(value, Mapping) else []
        for item in items:
            for assessment in item if isinstance(item, list) else [item]:
                if not isinstance(assessment, Mapping):
                    continue
                for policy, lists in _TRACE_POLICIES.items():
                    section = assessment.get(policy)
                    if not isinstance(section, Mapping):
                        continue
                    for name in lists:
                        for entry in section.get(name) or []:
                            if not isinstance(entry, Mapping):
                                continue
                            found.append(
                                {
                                    "where": where,
                                    "policy": policy,
                                    "type": str(entry.get("type") or entry.get("name") or name)[
                                        :64
                                    ],
                                    "action": str(entry.get("action", ""))[:32],
                                    "confidence": str(entry.get("confidence", ""))[:16],
                                }
                            )

    assessments("input", trace.get("inputAssessment"))
    assessments("output", trace.get("outputAssessments"))
    return found[:MAX_GUARDRAIL_ENTRIES]


MAX_GUARDRAIL_ENTRIES = 20

SCREEN_UNAVAILABLE: Final = [{"where": "input", "policy": "screen", "type": "unavailable"}]
"""What :func:`screen_message` answers when the guardrail could not be asked: the turn is
refused (fails closed)."""


def screen_message(
    client: Any, guardrail_id: str, version: str, text: str
) -> list[dict[str, str]] | None:
    """The base guardrail on the person's new message, before the harness (decision 44, D34).

    The chat's harness carries the turn version of the guardrail, without the input
    ``PROMPT_ATTACK`` filter: it evaluates the whole conversation, and that filter blocked
    harmless second questions. What the person writes now is checked here with the base version,
    every filter included. ``None`` when it may go on; otherwise what the guardrail decided,
    without what it found (:func:`guardrail_summary`). Fails closed: a guardrail that could not
    be asked refuses the turn. Never logs the text."""
    try:
        answer = client.apply_guardrail(
            guardrailIdentifier=guardrail_id,
            guardrailVersion=version,
            source="INPUT",
            content=[{"text": {"text": text}}],
        )
    except Exception:
        logger.exception("the base guardrail could not check the new message")
        return list(SCREEN_UNAVAILABLE)
    if answer.get("action") == "NONE":
        return None
    assessments = answer.get("assessments") or []
    return guardrail_summary({"inputAssessment": dict(enumerate(assessments))}) or [
        {"where": "input", "policy": "screen", "type": "intervened"}
    ]


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
    test_skills: tuple[dict[str, Any], ...] = (),
    recalled: str = "",
) -> dict[str, Any]:
    """``recalled``: what the turn worker recalled of the person (D122 (8)), a block of untrusted
    data built by ``mango_core.memory.recalled_context``. It goes before the person's text, in
    the last message only, as the harness itself puts what it recalls: never in the system
    prompt, and never in the history Mango stores.

    ``inline_tools``: ``inline_function`` tools of this invocation only, built by mango-api
    (the internal tool of a report, D87 (3)). Their calls come back to mango-api: they reach no
    system, so the Gateway has nothing to govern (rule 3 as D87 precises it).

    ``test_skills``: only for the Playground's test harness, which has no skills of its own
    (D91 (12)): the ``s3`` sources of the tested version's approved skills, built by mango-api
    from the stored version. Invoke-time skills are added to the harness's, so an agent's own
    harness never gets them (D92 (4))."""
    date_line = f"Current date (UTC): {today or datetime.now(UTC).date().isoformat()}."
    charts = CHARTS_LINE
    if textdoc_names(agent.allowed_tools):
        charts = f"{charts} {CANVAS_CHARTS_LINE}"
    date_line = f"{charts}\n\n{PASSWORDS_LINE}\n\n{date_line}"
    if _has_remote_tools(agent.allowed_tools):
        # The model never gets the consent URL (D94); left alone it invents one.
        date_line = f"{REMOTE_CONNECT_LINE}\n\n{date_line}"
    messages = [
        {"role": turn.role, "content": [{"text": turn.text}]}
        for turn in history[-MAX_HISTORY_MESSAGES:]
    ]
    if recalled and messages and messages[-1]["role"] == "user":
        messages[-1] = {**messages[-1], "content": [{"text": recalled}, *messages[-1]["content"]]}
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
            "trace": "enabled",
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
            # A version that runs code also has the document skills of the release (D119).
            *([skills_allowed_tool()] if agent.skills or _runs_code(agent.allowed_tools) else []),
        ],
        "maxIterations": limits.max_iterations,
        "maxTokens": limits.max_tokens,
        "timeoutSeconds": limits.timeout_seconds,
        "model": {"bedrockModelConfig": model},
    }
    if test_skills:
        request["skills"] = list(test_skills)
    return request


def paragraph_separator(text: str) -> str:
    """What to append so the next text starts a new Markdown paragraph ("" if it already does)."""
    if not text or text.endswith(PARAGRAPH_BREAK):
        return ""
    return "\n" if text.endswith("\n") else PARAGRAPH_BREAK


CODE_RUN = gateway_tool_name(CODE_TARGET, CODE_RUN_TOOL)
"""Gateway name of the tool that runs a cell (``code___run_python``, D114 (5))."""


def code_run_names(allowed: Iterable[str]) -> frozenset[str]:
    """The cell tool, when the invocation allows it: only then is a call of it a cell (the name
    in the stream is written by the model, TM-LP1)."""
    return (
        frozenset({CODE_RUN})
        if allowed_tool(CODE_TARGET, CODE_RUN_TOOL) in allowed
        else frozenset()
    )


TEXTDOC_RECIPIENT_PREFIX = "textdoc."
"""The ``recipient`` of a Canvas call in the ``v1`` stream (``textdoc.create``…, D124)."""


def textdoc_names(allowed: Iterable[str]) -> frozenset[str]:
    """The Canvas tools the invocation allows: only then is a call of one of them a Canvas call
    (the name in the stream is written by the model, TM-LP1)."""
    entries = set(allowed)
    return frozenset(
        gateway_tool_name(TEXTDOC_TARGET, tool)
        for tool in TEXTDOC_TOOLS
        if allowed_tool(TEXTDOC_TARGET, tool) in entries
    )


def _captured_tool(raw: str, capture: frozenset[str]) -> str | None:
    """The Gateway name in ``capture`` that ``raw`` (the name as the harness reports it, with
    or without its server prefix) refers to."""
    for name in capture:
        if raw == name or (raw.endswith(name) and raw[-len(name) - 1] in _NAME_BOUNDARIES):
            return name
    return None


MAX_SKILL_INPUT_CHARS = 512
"""Input kept of a call to the skills tool: only the name of a skill is expected."""


class _SkillCalls:
    """Calls to the built-in ``skills`` tool (D92): loading a skill's instructions.

    They are plumbing of the harness, not tools of the agent: the chat, the phase of the turn
    and the Actividad never see them (D92 (9)). Each one that loads a skill of the version is
    told to ``on_skill`` once its answer arrives, by the skill's id: the model writes the
    input, so a name that is not a skill of the version is never told."""

    def __init__(self, skills: frozenset[str], on_skill: Callable[[str], None] | None) -> None:
        self._skills = skills
        self._on_skill = on_skill
        self._blocks: dict[int, str] = {}
        self._inputs: dict[str, str] = {}

    def start(self, index: int, tool_id: str, raw_name: str) -> bool:
        """Whether the call is one of these (and so must not be shown)."""
        if raw_name != SKILLS_TOOL:
            # Block indexes start again with every message of the model: an index a skills call
            # used earlier in the turn now belongs to this other call.
            self._blocks.pop(index, None)
            return False
        self._blocks[index] = tool_id
        self._inputs[tool_id] = ""
        return True

    def add(self, index: int, piece: str) -> None:
        tool_id = self._blocks.get(index)
        current = self._inputs.get(tool_id) if tool_id is not None else None
        if tool_id is not None and current is not None and len(current) < MAX_SKILL_INPUT_CHARS:
            self._inputs[tool_id] = (current + piece)[:MAX_SKILL_INPUT_CHARS]

    def answer(self, tool_id: str, *, failed: bool) -> bool:
        """Whether the answer belongs to one of these calls (and so must not be shown)."""
        raw = self._inputs.pop(tool_id, None)
        if raw is None:
            return False
        if failed or self._on_skill is None:
            return True
        try:
            name = json.loads(raw).get("skill_name") if raw else None
        except (ValueError, AttributeError):
            name = None
        if isinstance(name, str) and name in self._skills:
            self._on_skill(name)
        return True


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


class _RemoteCalls:
    """Calls to tools of remote MCPs (D93), by the registration of each one's Gateway name.

    Only names of the invocation's own remote tools count: the name in the stream is written by
    the model (TM-LP1). An answer that is not an error marks the registration as a source of
    the turn; an error whose text says ``consent_required`` (the form the ``RESPONSE``
    interceptor gives, D98 (16)) means the person has to connect their account. The answer is
    untrusted: at most it shows the card that sends the person to «Mis conexiones»."""

    def __init__(self, remotes: Mapping[str, str], result: InvocationResult) -> None:
        self._names = frozenset(remotes)
        self._remotes = remotes
        self._result = result
        self._calls: dict[str, str] = {}
        self._errors: dict[int, tuple[str, list[str], int]] = {}

    def call(self, tool_id: str, raw_name: str) -> None:
        name = _captured_tool(raw_name, self._names) if self._names and tool_id else None
        if name is not None:
            self._calls[tool_id] = self._remotes[name]

    def answer(self, index: int, tool_id: str, *, failed: bool) -> None:
        registration = self._calls.pop(tool_id, None)
        if registration is None:
            return
        if failed:
            self._errors[index] = (registration, [], 0)
        elif registration not in self._result.remote_sources:
            self._result.remote_sources.append(registration)

    def add(self, index: int, piece: str) -> None:
        entry = self._errors.get(index)
        if entry is None or entry[2] >= MAX_CONSENT_ERROR_CHARS:
            return
        registration, pieces, size = entry
        pieces.append(piece[: MAX_CONSENT_ERROR_CHARS - size])
        self._errors[index] = (registration, pieces, size + len(piece))

    def stop(self, index: int) -> Iterator[StreamEvent]:
        entry = self._errors.pop(index, None)
        if entry is None or not _CONSENT_REQUIRED.search("".join(entry[1])):
            return
        registration = entry[0]
        if registration not in self._result.connection_required:
            self._result.connection_required.append(registration)
            yield StreamEvent(REMOTE_CONNECTION_REQUIRED, {"registration_id": registration})

    def end(self) -> Iterator[StreamEvent]:
        """Answers whose block never stopped are read as they are."""
        for index in list(self._errors):
            yield from self.stop(index)


class _AppCalls:
    """Input and answer of the calls of remote tools with an MCP App (D125), by their id in the
    stream. Only the invocation's own tools count (the name in the stream is the model's,
    TM-LP1); a call that failed or passed a bound gets no app."""

    def __init__(self, names: frozenset[str], result: InvocationResult) -> None:
        self._names = names
        self._result = result
        self._by_index: dict[int, tuple[str, str]] = {}
        self._calls: dict[str, dict[str, Any]] = {}

    def call(self, index: int, call_id: str, raw_name: str) -> None:
        name = _captured_tool(raw_name, self._names) if self._names and call_id else None
        if name is None or len(self._calls) + len(self._result.app_calls) >= MAX_APP_CALLS:
            return
        self._calls[call_id] = {"name": name, "input": [], "output": [], "n": 0, "m": 0}
        self._by_index[index] = (call_id, "input")

    def answer(self, index: int, call_id: str, *, failed: bool) -> None:
        if call_id not in self._calls:
            return
        if failed:
            del self._calls[call_id]
            return
        self._by_index[index] = (call_id, "output")

    def add(self, index: int, piece: str) -> None:
        target = self._by_index.get(index)
        call = self._calls.get(target[0]) if target is not None else None
        if target is None or call is None:
            return
        size, bound = (
            ("n", MAX_APP_INPUT_CHARS) if target[1] == "input" else ("m", MAX_APP_OUTPUT_CHARS)
        )
        call[size] += len(piece)
        if call[size] > bound:
            del self._calls[target[0]]
            return
        call[target[1]].append(piece)

    def stop(self, index: int) -> None:
        target = self._by_index.pop(index, None)
        if target is None or target[1] != "output":
            return
        call = self._calls.pop(target[0], None)
        if call is None or not call["output"]:
            return
        self._result.app_calls.append(
            AppCall(call["name"], "".join(call["input"]), "".join(call["output"]))
        )


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
    skills: frozenset[str] = frozenset(),
    on_skill: Callable[[str], None] | None = None,
    remotes: Mapping[str, str] | None = None,
    apps: frozenset[str] = frozenset(),
    clock: Callable[[], float] = time.monotonic,
    screen: Callable[[], list[dict[str, str]] | None] | None = None,
    sleep: Callable[[float], None] = time.sleep,
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

    Calls to the built-in ``skills`` tool load one of the version's ``skills`` (D92): they are
    never shown, and ``on_skill`` is told the id of each skill loaded. It must not raise.

    ``remotes`` maps the Gateway names of the invocation's remote MCP tools to their
    registration (D93): a call to one that answers ``consent_required`` is reported once per
    registration as a ``remote_connection_required`` event, and ``result`` keeps which
    registrations needed a connection and which ones answered.

    ``apps`` names the Gateway tools of the invocation that have an MCP App (D125): the input
    and the answer of their calls that answered are kept in ``result.app_calls``.

    ``screen`` checks the person's new message with the base guardrail before the harness
    (decision 44, D34: :func:`screen_message`). When it refuses it, the harness is never called:
    the turn ends as one the guardrail blocked at its input (its message, ``guardrail_intervened``
    and nothing spent).
    """
    if screen is not None:
        refused_by = screen()
        if refused_by is not None:
            result.guardrail.extend(refused_by)
            result.text = BLOCKED_INPUT_MESSAGE
            result.stop_reason = "guardrail_intervened"
            result.usage_final = True
            logger.warning(
                "guardrail intervened: %s",
                json.dumps([{"screen": "new message"}, *refused_by], separators=(",", ":")),
            )
            yield StreamEvent("delta", {"text": BLOCKED_INPUT_MESSAGE})
            return
    progress = _Progress()
    # The tool name in the stream is written by the model and the guardrail does not check it:
    # progress only names tools of the published version (TM-LP1).
    known_tools = {display_tool_name(tool) for tool in request.get("allowedTools", [])}
    # Sent before the call: the first event of the harness only arrives once the guardrail
    # has released the first block of the answer (or the first tool call).
    yield from progress.to(Phase.THINKING)
    result.started = True
    attempt = 0
    while True:
        try:
            response = client.invoke_harness(**request)
            break
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code")
            if code == HARNESS_NOT_FOUND:
                # Answered before any stream: no model call was made, nothing was spent.
                result.started = False
                result.harness_missing = True
            elif code == START_ERROR and attempt < len(START_RETRY_DELAYS):
                # AgentCore answered that it could not start the turn: nothing is running, so
                # asking again cannot make two (D121 (11)). Never after a timeout or a lost
                # answer, where the first invocation may be running.
                logger.warning("the harness could not start the turn: asked again")
                sleep(START_RETRY_DELAYS[attempt])
                attempt += 1
                continue
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
    skill_calls = _SkillCalls(skills, on_skill)
    remote_calls = _RemoteCalls(remotes or {}, result)
    app_calls = _AppCalls(apps, result)
    code_runs = code_run_names(request.get("allowedTools", []))
    code_calls: set[str] = set()
    textdoc_tools = textdoc_names(request.get("allowedTools", []))
    textdoc_calls: set[str] = set()
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
                if skill_calls.start(index, tool_id, raw_name):
                    continue
                if write_calls.start(index, raw_name):
                    refused.add(tool_id)
                    asked = True
                elif inline and raw_name in inline and inline_calls.start(index, raw_name):
                    # Handed back to mango-api: the turn ends with this message (D87 (3)).
                    asked = True
                name = display_tool_name(start["toolUse"].get("name", "tool"))
                canvas = _captured_tool(raw_name, textdoc_tools) if textdoc_tools else None
                if canvas is not None:
                    # A Canvas tool (D124): ``textdoc.create``…, never the model's own name.
                    name = TEXTDOC_RECIPIENT_PREFIX + canvas.split("___", 1)[1]
                recorded.call(index, tool_id, name)
                searches.call(tool_id, raw_name)
                remote_calls.call(tool_id, raw_name)
                app_calls.call(index, tool_id, raw_name)
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
                if code_runs and _captured_tool(raw_name, code_runs) is not None:
                    # A cell of the sandbox: the chat shows it as its «Analizando» block.
                    code_calls.add(tool_id)
                    yield StreamEvent("tool", {"name": name, "status": "started", "code": True})
                    yield from progress.to(Phase.CODE)
                elif canvas is not None:
                    textdoc_calls.add(tool_id)
                    yield StreamEvent("tool", {"name": name, "status": "started", "textdoc": True})
                    yield from progress.to(Phase.TOOL, "")
                else:
                    yield StreamEvent("tool", {"name": name, "status": "started"})
                    yield from progress.to(Phase.TOOL, name if name in known_tools else "")
            elif "toolResult" in start:
                # The message before this result never reported its end: nothing is asked.
                write_calls.drop()
                inline_calls.drop()
                tool_id = start["toolResult"].get("toolUseId", "")
                if skill_calls.answer(tool_id, failed=start["toolResult"].get("status") == "error"):
                    continue
                recorded.answer(block.get("contentBlockIndex", -1), tool_id)
                name = tool_names.get(tool_id, "tool")
                status = "completed" if start["toolResult"].get("status") != "error" else "error"
                searches.answer(
                    block.get("contentBlockIndex", -1), tool_id, failed=status == "error"
                )
                remote_calls.answer(
                    block.get("contentBlockIndex", -1), tool_id, failed=status == "error"
                )
                app_calls.answer(
                    block.get("contentBlockIndex", -1), tool_id, failed=status == "error"
                )
                result.tools.append({"name": name, "status": status})
                cell: dict[str, Any] = {"code": True} if tool_id in code_calls else {}
                if tool_id in textdoc_calls:
                    cell = {"textdoc": True}
                code_calls.discard(tool_id)
                textdoc_calls.discard(tool_id)
                yield StreamEvent("tool", {"name": name, "status": status, **cell})
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
                skill_calls.add(index, piece)
                write_calls.add(index, piece)
                inline_calls.add(index, piece)
                recorded.add(index, piece)
                app_calls.add(index, piece)
            if "toolResult" in delta:
                for part in _result_pieces(delta["toolResult"]):
                    recorded.add(index, part)
                    searches.add(index, part)
                    remote_calls.add(index, part)
                    app_calls.add(index, part)
        elif "contentBlockStop" in event:
            index = event["contentBlockStop"].get("contentBlockIndex", -1)
            if index in tool_blocks:
                called_at[tool_blocks.pop(index)] = clock()
            write_calls.stop(index)
            inline_calls.stop(index)
            recorded.stop(index)
            app_calls.stop(index)
            yield from remote_calls.stop(index)
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
            trace_info = event["metadata"].get("trace")
            trace = trace_info.get("guardrail") if isinstance(trace_info, dict) else None
            if trace:
                result.guardrail.extend(guardrail_summary(trace))
            at_cap = owed and result.stop_reason == CAP_STOP
            reported, owed = True, False
    yield from remote_calls.end()
    if result.stop_reason == "guardrail_intervened":
        # Why the turn was cut, without the text (D16): types, actions and where only.
        logger.warning(
            "guardrail intervened: %s",
            json.dumps(result.guardrail or [{"trace": "none"}], separators=(",", ":")),
        )
        if result.text.strip() and not any(
            message in result.text for message in (BLOCKED_INPUT_MESSAGE, BLOCKED_OUTPUT_MESSAGE)
        ):
            # The whole answer arrived, with what the guardrail masked: not a cut.
            result.stop_reason = GUARDRAIL_MASKED
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
