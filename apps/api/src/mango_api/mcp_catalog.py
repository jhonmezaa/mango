"""MCP catalog: Mango connectors and MCP packs as release data (D19, D22, D36).

Each connector ships a ``manifest.json`` next to its code (``connectors/<id>/``); the release
copies them into the mango-api image. The installation never edits them, and nothing here is
read from user input.

MCP packs come from the signed statements of the release (``mango_api.pack_release``). A
pack's tools can be given to agents only while the pack is installed: what counts is the
pointer the pack provisioner writes (``MCP_INSTALLED#``), which mango-api cannot write. The
Gateway target of a pack is its id, so its tools are exposed as ``<pack id>___<tool>``.

A manifest declares, per tool, what agent rules need (``mango_api.agent_rules``):

* ``access``: ``read`` or ``write`` (write tools always need approval on each call);
* ``audience``: ``central`` for tools that answer for the whole organization. The Gateway
  (Cedar L2) and the connector enforce it on every call, whatever the agent says.

and per connector the data tier and how identity reaches the data (spec §4.3):

* ``per_user``: the connector filters by the verified user on every call (Cost Explorer);
* ``service``: no account data, the connector's own role is enough;
* ``central_only``: a pack over account data that does not filter by area. Only agents
  visible to central groups may have its tools, Cedar L2 only lets central users call them,
  and each call reaches AWS as the user (D37);
* ``per_user_adapter``: not validated, never installed.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Annotated, Literal

from botocore.exceptions import BotoCoreError, ClientError
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from mango_api.mcp_store import Enablement, Installed, PackRecordError, PackStore
from mango_api.pack_release import (
    CatalogEntry,
    PackReleaseUnavailableError,
    ReleasePack,
    ReleasePacks,
)
from mango_packs.enablement import PackStatus

logger = logging.getLogger(__name__)

MANIFEST_FILE = "manifest.json"
MAX_MANIFEST_BYTES = 256 * 1024
_ID = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,47}$")
_TOOL_NAME = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")


OPT_IN_SERVICES: dict[str, dict[str, str]] = {
    "aws-billing": {
        "compute-optimizer": "Compute Optimizer",
        "cost-optimization": "Cost Optimization Hub",
    },
}
"""Tools that only answer once the customer turns an AWS service on in the payer account
(D52: Mango never enrolls it, and never asks AWS whether it is on). Release data by pack and
tool: the signed manifest has no field for it. Only shown in the catalog; nothing is decided
with it."""


def required_service(ref: str) -> str | None:
    """The opt-in AWS service the tool ``<server id>.<tool>`` needs, if any."""
    server, _, tool = ref.partition(".")
    return OPT_IN_SERVICES.get(server, {}).get(tool)


class DataTier(StrEnum):
    PUBLIC = "public"
    ACCOUNT_DATA = "account_data"
    WRITE = "write"


class IdentityMode(StrEnum):
    SERVICE = "service"
    PER_USER = "per_user"
    CENTRAL_ONLY = "central_only"
    PER_USER_ADAPTER = "per_user_adapter"


class _Frozen(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


_ARGUMENT_NAME = Field(pattern=r"^[a-z][a-z0-9_]{0,39}$")


class ManifestApproval(_Frozen):
    """Arguments of a write tool that a tool policy may set a threshold on (D27): which one
    is the amount in USD, the number of resources and the environment. Release data, so that
    a call cannot choose what its tier is computed from."""

    amount: Annotated[str, _ARGUMENT_NAME] | None = None
    count: Annotated[str, _ARGUMENT_NAME] | None = None
    environment: Annotated[str, _ARGUMENT_NAME] | None = None


class ManifestTool(_Frozen):
    name: Annotated[str, _TOOL_NAME]
    description: Annotated[str, Field(max_length=300)]
    access: Literal["read", "write"]
    audience: Literal["all", "central"] = "all"
    approval: ManifestApproval | None = None


class ManifestIam(_Frozen):
    actions: Annotated[
        tuple[Annotated[str, Field(pattern=r"^[a-z0-9-]+:[A-Za-z0-9]+$")], ...], Field(min_length=1)
    ]
    resources: Annotated[tuple[str, ...], Field(min_length=1)]
    note: Annotated[str, Field(max_length=500)] = ""


class McpServer(_Frozen):
    """What a connector and a pack have in common: an MCP server behind a Gateway target."""

    id: Annotated[str, _ID]
    kind: Literal["connector", "pack"]
    name: Annotated[str, Field(min_length=1, max_length=120)]
    description: Annotated[str, Field(max_length=600)]
    provider: Annotated[str, Field(min_length=1, max_length=100)]
    data_tier: DataTier
    identity_mode: IdentityMode
    gateway_target: Annotated[str, Field(pattern=r"^[A-Za-z0-9-]{1,48}$")]
    """Target name in the AgentCore Gateway; tools are exposed as ``<target>___<tool>``."""
    iam: tuple[ManifestIam, ...] = ()
    tools: Annotated[tuple[ManifestTool, ...], Field(max_length=200)]


class ConnectorManifest(McpServer):
    kind: Literal["connector"]
    name: Annotated[str, Field(min_length=1, max_length=60)]
    description: Annotated[str, Field(max_length=300)]
    provider: Annotated[str, Field(min_length=1, max_length=60)]
    tools: Annotated[tuple[ManifestTool, ...], Field(min_length=1, max_length=100)]


class InvalidCatalogError(Exception):
    """The release catalog is missing or malformed; callers fail closed."""


@dataclass(frozen=True)
class CatalogTool:
    ref: str
    """``<server id>.<tool name>``, as stored in agent definitions."""
    server: McpServer
    tool: ManifestTool
    enabled: bool = True
    """Connectors come deployed with the release. A pack tool is enabled only while the pack
    is installed and serves it."""

    @property
    def is_write(self) -> bool:
        return self.tool.access == "write" or self.server.data_tier is DataTier.WRITE

    @property
    def filters_by_user(self) -> bool:
        return self.server.identity_mode is IdentityMode.PER_USER

    @property
    def central_groups_only(self) -> bool:
        """Account data that the server does not filter by user (TM-M3, decision U7).

        Such a tool may only be given to agents visible to central groups. A connector that
        filters by user on every call may be shared with area groups; its organization-wide
        tools (``audience: central``) are still denied to them per call by Cedar L2.
        """
        return self.server.data_tier is DataTier.ACCOUNT_DATA and not self.filters_by_user


@dataclass(frozen=True)
class PackState:
    """A pack of the release next to what the installation did with it."""

    release: ReleasePack
    enablement: Enablement | None
    installed: Installed | None

    @property
    def pack_id(self) -> str:
        return self.release.manifest.id

    @property
    def serving(self) -> bool:
        """The provisioner installed it and nobody asked to remove it.

        A failed update leaves the enablement ``failed`` while the previous version keeps
        serving, so the status alone does not say: the pointer does.
        """
        return (
            self.installed is not None
            and self.enablement is not None
            and self.enablement.status not in {PackStatus.DISABLING, PackStatus.DISABLED}
        )

    @property
    def usable_tools(self) -> frozenset[str]:
        """Tools agents may use now: the ones of the installed version, while it serves."""
        return frozenset(self.installed.tools) if self.installed and self.serving else frozenset()

    @property
    def server(self) -> McpServer:
        """The pack in the shape of the catalog: the tools of the release's version, plus
        the ones only the installed (older) version serves."""
        manifest = self.release.manifest
        declared = {tool.name: tool.access.value for tool in manifest.tools}
        for name in sorted(self.usable_tools - declared.keys()):
            # The provisioner only installs packs whose tools are all read-only.
            declared[name] = "read"
        data_tier, identity_mode = manifest.data_tier.value, manifest.identity_mode.value
        if self.installed is not None and self.serving:
            # What agents use now is the installed version, which may be older than the
            # release's: its tier and mode decide who may be given its tools (TM-M3).
            data_tier, identity_mode = self.installed.data_tier, self.installed.identity_mode
        return McpServer(
            id=manifest.id,
            kind="pack",
            name=manifest.name,
            description=manifest.description,
            provider=manifest.source.package,
            data_tier=DataTier(data_tier),
            identity_mode=IdentityMode(identity_mode),
            gateway_target=manifest.id,
            iam=tuple(
                ManifestIam(
                    actions=tuple(statement.actions),
                    resources=tuple(statement.resources),
                    note=statement.reason or "",
                )
                for statement in manifest.iam
            ),
            tools=tuple(
                # Pack manifests carry no tool descriptions (they are in the signed snapshot).
                ManifestTool(name=name, description="", access=access)  # type: ignore[arg-type]
                for name, access in declared.items()
            ),
        )


class McpCatalog:
    def __init__(
        self,
        connectors: Iterable[ConnectorManifest],
        packs: Iterable[PackState] = (),
        *,
        packs_available: bool = True,
    ) -> None:
        self._connectors: dict[str, ConnectorManifest] = {}
        self._packs: dict[str, PackState] = {}
        self._tools: dict[str, CatalogTool] = {}
        self.packs_available = packs_available
        """False when the packs could not be read: their tools are unknown, not disabled."""
        for connector in connectors:
            if connector.id in self._connectors:
                raise InvalidCatalogError("duplicate connector id")
            self._connectors[connector.id] = connector
            self._add_tools(connector, enabled=None)
        targets = {connector.gateway_target for connector in self._connectors.values()}
        for pack in packs:
            if pack.pack_id in self._connectors or pack.pack_id in targets:
                # A pack never takes the id or the Gateway target of a connector; the
                # provisioner refuses it too (``reserved_target``).
                logger.error("pack id collides with a connector", extra={"pack": pack.pack_id})
                continue
            try:
                server = pack.server
            except ValidationError:
                logger.exception("pack does not fit the catalog", extra={"pack": pack.pack_id})
                continue
            self._packs[pack.pack_id] = pack
            self._add_tools(server, enabled=pack.usable_tools)

    def _add_tools(self, server: McpServer, *, enabled: frozenset[str] | None) -> None:
        names = [tool.name for tool in server.tools]
        if len(set(names)) != len(names):
            raise InvalidCatalogError("duplicate tool name")
        for tool in server.tools:
            ref = f"{server.id}.{tool.name}"
            self._tools[ref] = CatalogTool(
                ref=ref, server=server, tool=tool, enabled=enabled is None or tool.name in enabled
            )

    @property
    def connectors(self) -> tuple[ConnectorManifest, ...]:
        return tuple(self._connectors[key] for key in sorted(self._connectors))

    @property
    def packs(self) -> tuple[PackState, ...]:
        return tuple(self._packs[key] for key in sorted(self._packs))

    def tool(self, ref: str) -> CatalogTool | None:
        return self._tools.get(ref)

    def pack_tool_unavailable(self, ref: str) -> bool:
        """``ref`` names a pack of the release that does not serve that tool now: the pack is
        not installed, or its installed version does not have the tool (spec §4.4)."""
        tool = self._tools.get(ref)
        return (tool is None or not tool.enabled) and ref.partition(".")[0] in self._packs

    def tools_of(self, server: McpServer) -> tuple[CatalogTool, ...]:
        return tuple(
            tool
            for manifest_tool in server.tools
            if (tool := self._tools.get(f"{server.id}.{manifest_tool.name}")) is not None
        )

    def with_packs(self, packs: Iterable[PackState], *, available: bool = True) -> McpCatalog:
        return McpCatalog(self.connectors, packs, packs_available=available)

    @staticmethod
    def load(directory: Path) -> McpCatalog:
        """Read ``<directory>/<id>/manifest.json``; the folder name must match the id."""
        manifests: list[ConnectorManifest] = []
        try:
            folders = sorted(p for p in directory.iterdir() if (p / MANIFEST_FILE).is_file())
            for folder in folders:
                path = folder / MANIFEST_FILE
                if path.stat().st_size > MAX_MANIFEST_BYTES:
                    raise InvalidCatalogError("manifest too large")
                manifest = ConnectorManifest.model_validate(
                    json.loads(path.read_text(encoding="utf-8"))
                )
                if manifest.id != folder.name:
                    raise InvalidCatalogError("manifest id does not match its folder")
                manifests.append(manifest)
        except (OSError, ValueError, ValidationError) as exc:
            raise InvalidCatalogError("cannot read the MCP catalog") from exc
        return McpCatalog(manifests)


PACK_STATE_SECONDS = 15
"""How long the chat and the agent rules may see a stale pack state (as published agents)."""


class CatalogSource:
    """The catalog as it is now: connectors of the image plus the packs of the release with
    their installation state.

    Called on the chat path (through ``PublishedAgents``) and by the agent rules, so the pack
    state is cached briefly. A read error is never cached and never looks like "disabled":
    the catalog then says its packs are unavailable and callers fail closed.
    """

    def __init__(
        self,
        connectors: Callable[[], McpCatalog],
        release: ReleasePacks | None,
        store: PackStore | None,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._connectors = connectors
        self._release = release
        self._store = store
        self._clock = clock
        self._lock = threading.Lock()
        self._cached: tuple[float, McpCatalog] | None = None

    def release_entry(self, pack_id: str) -> CatalogEntry | None:
        """What the release names for ``pack_id`` (from the stack, no I/O)."""
        return self._release.catalog.get(pack_id) if self._release else None

    def pack_states(self) -> tuple[PackState, ...]:
        """Fresh state of every pack of the release (no cache): for administration."""
        if self._release is None or self._store is None:
            return ()
        return tuple(
            PackState(
                release=pack,
                enablement=self._store.enablement(pack.manifest.id),
                installed=self._store.installed(pack.manifest.id),
            )
            for pack in self._release.packs()
        )

    def fresh(self) -> McpCatalog:
        """The catalog with the current pack state; raises when the packs cannot be read."""
        base = self._connectors()
        try:
            catalog = base.with_packs(self.pack_states())
        except (PackReleaseUnavailableError, PackRecordError, ClientError, BotoCoreError) as exc:
            raise InvalidCatalogError("cannot read the MCP packs") from exc
        with self._lock:
            self._cached = (self._clock(), catalog)
        return catalog

    def invalidate(self) -> None:
        with self._lock:
            self._cached = None

    def __call__(self) -> McpCatalog:
        base = self._connectors()
        if self._release is None or self._store is None or not self._release.catalog:
            return base
        with self._lock:
            cached = self._cached
        if cached is not None and self._clock() - cached[0] < PACK_STATE_SECONDS:
            return cached[1]
        try:
            return self.fresh()
        except InvalidCatalogError:
            logger.exception("MCP packs unavailable")
            # Connector tools keep working; pack tools are unknown until the next read.
            return base.with_packs((), available=False)
