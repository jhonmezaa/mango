"""What the chat serves: the published version of an agent (D32, D33, D40).

Which version is live is decided by the ``PUBLISHED#<id>`` item of the Agents table, which only
the provisioner can write. This module reads the version it points to, checks the stored
content against the pointer's hash (TM-M2) and derives from it everything an invocation needs:
prompt, models, limits and the exact tools. Nothing here comes from a request.

Everything fails closed: a pointer that cannot be read, content that does not match its hash,
a harness that is not this agent's or a tool the release does not ship raise
``AgentUnavailableError`` and the turn is not served. Results are cached for a few seconds, so
a new publication or a retirement takes effect within ``CACHE_SECONDS``; errors are never
cached and a stale entry is never used in their place.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

from botocore.exceptions import BotoCoreError, ClientError

from mango_api.agents_store import AgentsStore, AgentVersion
from mango_api.mcp_catalog import InvalidCatalogError, McpCatalog
from mango_core.agents import (
    AgentDefinition,
    AgentStatus,
    InvalidDefinitionError,
    is_agent_id,
    verify_content,
)
from mango_core.harness_tools import allowed_tool, gateway_tool_name

logger = logging.getLogger(__name__)

CACHE_SECONDS = 15
MAX_CACHED_AGENTS = 256
ENDPOINT_LIVE = "live"
"""Harness endpoint the provisioner moves to the published version (D32)."""


class AgentUnavailableError(Exception):
    """The published version of an agent could not be established; nothing is served."""


@dataclass(frozen=True)
class PublishedAgent:
    agent_id: str
    version: int
    content_hash: str
    harness_arn: str
    harness_version: str
    qualifier: str
    """Harness endpoint to invoke: ``live``, which the provisioner moves on publication."""
    record: AgentVersion
    """The stored version, already checked against the deployed hash."""
    retired: bool
    allowed_tools: tuple[str, ...]
    """``allowedTools`` entries of the harness invocation: exactly the version's tools."""
    gateway_tools: tuple[str, ...]
    """The same tools as the Gateway names them; signed into every invocation (D33)."""
    unavailable_tools: tuple[str, ...] = ()
    """Tools of the version whose MCP pack is not installed now (disabled, or removed by an
    update). The agent keeps serving without them until it is edited (spec §4.4)."""
    write_tools: tuple[tuple[str, str], ...] = ()
    """Write tools of the version as ``(Gateway name, <server>.<tool>)``. The Gateway refuses
    them without an approval token (D27); mango-api turns each call into a request."""

    @property
    def definition(self) -> AgentDefinition:
        return self.record.definition


class PublishedAgents:
    def __init__(
        self,
        store: AgentsStore,
        catalog: Callable[[], McpCatalog],
        *,
        namespace: str,
        region: str,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._store = store
        self._catalog = catalog
        self._clock = clock
        self._namespace = namespace
        self._region = region
        self._cache: dict[str, tuple[float, PublishedAgent]] = {}
        self._lock = threading.Lock()

    def get(self, agent_id: str) -> PublishedAgent | None:
        """The agent as it is served now, or ``None`` if it was never published."""
        if not is_agent_id(agent_id):
            return None
        now = self._clock()
        with self._lock:
            cached = self._cache.get(agent_id)
            if cached and now - cached[0] < CACHE_SECONDS:
                return cached[1]
            self._cache.pop(agent_id, None)
        agent = self._load(agent_id)
        if agent is not None:
            with self._lock:
                if len(self._cache) >= MAX_CACHED_AGENTS:
                    self._cache.clear()
                self._cache[agent_id] = (now, agent)
        return agent

    def invalidate(self, agent_id: str) -> None:
        with self._lock:
            self._cache.pop(agent_id, None)

    # --- Loading --------------------------------------------------------------------------

    def _harness_arn_re(self, agent_id: str) -> re.Pattern[str]:
        """The harness the provisioner creates for this agent, in this installation (D32)."""
        name = re.escape(f"Mango_{self._namespace}_a_{agent_id}")
        region = re.escape(self._region)
        return re.compile(
            rf"^arn:aws[a-z-]*:bedrock-agentcore:{region}:\d{{12}}:harness/{name}-[A-Za-z0-9]{{10}}$"
        )

    def _load(self, agent_id: str) -> PublishedAgent | None:
        try:
            pointer = self._store.published_pointer(agent_id)
            if pointer is None:
                return None
            version = self._store.version(agent_id, pointer.version)
            meta = self._store.meta(agent_id)
        except (ClientError, BotoCoreError, InvalidDefinitionError, KeyError, ValueError) as exc:
            logger.exception("published agent unreadable")
            raise AgentUnavailableError("agent unavailable") from exc
        if version is None or meta is None:
            logger.error("published pointer without its version or agent")
            raise AgentUnavailableError("agent unavailable")
        if not verify_content(version.canonical, pointer.content_hash):
            # The stored content is not what the provisioner deployed.
            logger.error("published content does not match the deployed hash")
            raise AgentUnavailableError("agent unavailable")
        if not self._harness_arn_re(agent_id).fullmatch(pointer.harness_arn):
            logger.error("published pointer names a harness that is not this agent's")
            raise AgentUnavailableError("agent unavailable")
        return self._agent(
            version,
            content_hash=pointer.content_hash,
            harness_arn=pointer.harness_arn,
            harness_version=pointer.harness_version,
            qualifier=ENDPOINT_LIVE,
            retired=meta.status is AgentStatus.RETIRED,
        )

    def _agent(
        self,
        version: AgentVersion,
        *,
        content_hash: str,
        harness_arn: str,
        harness_version: str,
        qualifier: str,
        retired: bool,
    ) -> PublishedAgent:
        definition = version.definition
        if definition.model is None or definition.model not in definition.allowed_models:
            raise AgentUnavailableError("agent unavailable")
        if not definition.system_prompt.strip():
            raise AgentUnavailableError("agent unavailable")
        allowed, gateway, unavailable, write = self._tools(definition)
        return PublishedAgent(
            agent_id=version.agent_id,
            version=version.number,
            content_hash=content_hash,
            harness_arn=harness_arn,
            harness_version=harness_version,
            qualifier=qualifier,
            record=version,
            retired=retired,
            allowed_tools=allowed,
            gateway_tools=gateway,
            unavailable_tools=unavailable,
            write_tools=write,
        )

    def _tools(
        self, definition: AgentDefinition
    ) -> tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...], tuple[tuple[str, str], ...]]:
        """Harness and Gateway names of the version's tools, and the tools left out.

        Connector tools come from the release catalog. Pack tools count only while the pack
        is installed (the provisioner's pointer): a disabled pack takes its tools away from
        the agents that use it, which keep serving with the rest (spec §4.4). Fewer tools than
        approved is always within what was approved.

        Write tools need an approval on every call (D27). The Gateway interceptor enforces it
        for the write tools of Mango connectors, so only those are served, and only when the
        version marks them in ``approval_tools`` (what its reviewers saw). Asking approval for
        a read tool, or a write tool of a third-party pack, is not enforced by anything yet:
        such a version is not published (D40, D43) and neither is it served.
        """
        approval = set(definition.approval_tools)
        if not approval <= set(definition.tools):
            raise AgentUnavailableError("agent unavailable")
        try:
            catalog = self._catalog()
        except InvalidCatalogError as exc:
            raise AgentUnavailableError("agent unavailable") from exc
        allowed: list[str] = []
        gateway: list[str] = []
        unavailable: list[str] = []
        write: list[tuple[str, str]] = []
        for ref in definition.tools:
            tool = catalog.tool(ref)
            if tool is None or not tool.enabled:
                if catalog.pack_tool_unavailable(ref):
                    # A pack of the release that is not installed now, or whose installed
                    # version does not serve this tool.
                    unavailable.append(ref)
                    continue
                # Unknown is not disabled: a tool the release does not ship, or packs that
                # could not be read just now. Fail closed.
                logger.error("published agent uses a tool the release does not serve")
                raise AgentUnavailableError("agent unavailable")
            target = tool.server.gateway_target
            name = gateway_tool_name(target, tool.tool.name)
            if tool.is_write != (ref in approval) or (
                tool.is_write and tool.server.kind != "connector"
            ):
                logger.error("published agent uses a tool whose approval is not enforced")
                raise AgentUnavailableError("agent unavailable")
            if tool.is_write:
                write.append((name, ref))
            allowed.append(allowed_tool(target, tool.tool.name))
            gateway.append(name)
        if approval - {ref for _, ref in write} - set(unavailable):
            raise AgentUnavailableError("agent unavailable")
        return (
            tuple(sorted(allowed)),
            tuple(sorted(gateway)),
            tuple(sorted(unavailable)),
            tuple(sorted(write)),
        )
