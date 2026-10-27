"""MCP catalog: Mango connectors and MCP packs as release data (D19, D22, D36).

Each connector ships a ``manifest.json`` next to its code (``connectors/<id>/``); the release
copies them into the mango-api image. The installation never edits them, and nothing here is
read from user input.

MCP packs come from the signed statements of the release (``mango_api.pack_release``). A
pack's tools can be given to agents only while the pack is installed: what counts is the
pointer the pack provisioner writes (``MCP_INSTALLED#``), which mango-api cannot write. The
Gateway target of a pack is its id, so its tools are exposed as ``<pack id>___<tool>``.

A manifest declares, per tool, what agent rules need (``mango_api.agent_rules``):

* ``access``: ``read``, ``write`` or ``destructive`` (D84). Write tools always need approval
  on each call; a ``destructive`` tool is never given to an agent, not even with approval. A
  pack tool its signed manifest leaves unclassified is listed as ``write``. A connector
  declares no ``destructive`` tool: the catalog refuses the release if one does;
* ``audience``: ``central`` for tools that answer for the whole organization. The Gateway
  (Cedar L2) and the connector enforce it on every call, whatever the agent says.

and per connector the data tier and how identity reaches the data (spec §4.3):

* ``per_user``: the connector filters by the verified user on every call (Cost Explorer);
* ``service``: no account data, the connector's own role is enough;
* ``central_only``: a pack over account data that does not filter by area. Only agents
  visible to central groups may have its tools, Cedar L2 only lets central users call them,
  and each call reaches AWS as the user (D37);
* ``per_user_adapter``: not validated, never installed.

Remote MCP servers of third parties (D93, D98) are listed too, one per registration: the
server id and Gateway target are ``remote-<registration>``. Their tools count only while the
registration is ``active`` and the catalog the remote provisioner signed (``MCP_REMOTE#``,
which mango-api cannot write) names them: all ``read``, each person's own data (``per_user``).
Who may use one is decided by its groups (``UseRemoteMcp``), not here.
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
from typing import Annotated, Literal, Self

from botocore.exceptions import BotoCoreError, ClientError
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from mango_api.mcp_store import Enablement, Installed, PackRecordError, PackStore
from mango_api.pack_release import (
    CatalogEntry,
    PackReleaseUnavailableError,
    ReleasePack,
    ReleasePacks,
)
from mango_api.remote_mcp_store import (
    ApprovedRemotes,
    Registration,
    RemoteRecordError,
    RemoteRegistrationStatus,
    RemoteStore,
)
from mango_api.remote_release import ReleaseRemotes, RemoteReleaseUnavailableError
from mango_core.remote_mcp import ApprovedRemote, registration_of_target, target_name
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
    access: Literal["read", "write", "destructive"]
    audience: Literal["all", "central"] = "all"
    approval: ManifestApproval | None = None
    unclassified: bool = False
    """A pack tool the signed manifest does not classify: it counts as ``write`` (D84). Only the
    catalog sets it; a connector cannot declare it."""


class ManifestIam(_Frozen):
    actions: Annotated[
        tuple[Annotated[str, Field(pattern=r"^[a-z0-9-]+:[A-Za-z0-9]+$")], ...], Field(min_length=1)
    ]
    resources: Annotated[tuple[str, ...], Field(min_length=1)]
    note: Annotated[str, Field(max_length=500)] = ""


class McpServer(_Frozen):
    """What a connector and a pack have in common: an MCP server behind a Gateway target."""

    id: Annotated[str, _ID]
    kind: Literal["connector", "pack", "remote"]
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

    @model_validator(mode="after")
    def _never_destructive(self) -> Self:
        # A destructive tool is never enabled (D84): the release must not ship one.
        if any(tool.access == "destructive" for tool in self.tools):
            raise ValueError("a connector declares no destructive tool (D84)")
        if any(tool.unclassified for tool in self.tools):
            raise ValueError("a connector classifies every tool (D84)")
        return self


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
        """It changes resources: a write, or a destructive tool (D84)."""
        return self.tool.access != "read" or self.server.data_tier is DataTier.WRITE

    @property
    def is_destructive(self) -> bool:
        """Never given to an agent, not even with approval (D84)."""
        return self.tool.access == "destructive"

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
        # An unclassified tool is listed as the write it counts as (D84).
        declared = {tool.name: tool.effective_access.value for tool in manifest.tools}
        unclassified = {tool.name for tool in manifest.tools if tool.access is None}
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
                ManifestTool(
                    name=name,
                    description="",
                    access=access,  # type: ignore[arg-type]
                    unclassified=name in unclassified,
                )
                for name, access in declared.items()
            ),
        )


@dataclass(frozen=True)
class RemoteState:
    """A remote MCP registration next to the catalog the remote provisioner signed for it."""

    registration: Registration
    approved: ApprovedRemote | None
    """The signed catalog, verified; read only while the registration is ``active``."""
    service: str | None = None
    """Name of its profile in the release («Azure DevOps»); ``None`` when the release no
    longer has it."""
    operator: str | None = None

    @property
    def registration_id(self) -> str:
        return self.registration.registration_id

    @property
    def target(self) -> str:
        return target_name(self.registration_id)

    @property
    def groups(self) -> frozenset[str]:
        return frozenset(self.registration.groups)

    @property
    def usable_tools(self) -> frozenset[str]:
        """Tools agents may use now: the signed ones, while the registration is active."""
        approved = self.approved
        if (
            approved is None
            or self.registration.status is not RemoteRegistrationStatus.ACTIVE
            or approved.registration_id != self.registration_id
        ):
            return frozenset()
        return approved.tools

    @property
    def server(self) -> McpServer:
        """The registration in the shape of the catalog: only its signed tools, all ``read``
        (D84 (5)). The signed catalog carries no descriptions."""
        return McpServer(
            id=self.target,
            kind="remote",
            name=self.service or self.registration.profile_id,
            description="",
            provider=self.operator or self.registration.profile_id,
            data_tier=DataTier.ACCOUNT_DATA,
            identity_mode=IdentityMode.PER_USER,
            gateway_target=self.target,
            tools=tuple(
                ManifestTool(name=name, description="", access="read")
                for name in sorted(self.usable_tools)
            ),
        )


class RemoteStates:
    """Every remote MCP registration with its verified signed catalog (D98 (12), (13))."""

    def __init__(
        self, store: RemoteStore, approved: ApprovedRemotes | None, release: ReleaseRemotes
    ) -> None:
        self._store = store
        self._approved = approved
        self._release = release

    def __call__(self) -> tuple[RemoteState, ...]:
        """Raises ``RemoteRecordError`` or a boto error when the registrations cannot be read.
        A signed catalog that is missing or does not verify reads as ``None``: no tools."""
        states: list[RemoteState] = []
        for registration in self._store.registrations():
            active = registration.status is RemoteRegistrationStatus.ACTIVE
            approved = (
                self._approved.get(registration.registration_id)
                if active and self._approved is not None
                else None
            )
            try:
                release = self._release.get(registration.profile_id)
            except RemoteReleaseUnavailableError:
                # Only the name shown is missing: the signed catalog decides the tools.
                release = None
            profile = release.profile if release is not None else None
            states.append(
                RemoteState(
                    registration,
                    approved,
                    service=profile.name if profile is not None else None,
                    operator=profile.operator if profile is not None else None,
                )
            )
        return tuple(states)


class McpCatalog:
    def __init__(
        self,
        connectors: Iterable[ConnectorManifest],
        packs: Iterable[PackState] = (),
        *,
        packs_available: bool = True,
        remotes: Iterable[RemoteState] = (),
        remotes_available: bool = True,
    ) -> None:
        self._connectors: dict[str, ConnectorManifest] = {}
        self._packs: dict[str, PackState] = {}
        self._remotes: dict[str, RemoteState] = {}
        self._tools: dict[str, CatalogTool] = {}
        self.packs_available = packs_available
        """False when the packs could not be read: their tools are unknown, not disabled."""
        self.remotes_available = remotes_available
        """False when the registrations could not be read: their tools count as unavailable."""
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
            if registration_of_target(pack.pack_id) is not None:
                # ``remote-<registration>`` is the target of a remote MCP (D98 (11)).
                logger.error("pack id is a remote MCP target", extra={"pack": pack.pack_id})
                continue
            try:
                server = pack.server
            except ValidationError:
                logger.exception("pack does not fit the catalog", extra={"pack": pack.pack_id})
                continue
            self._packs[pack.pack_id] = pack
            self._add_tools(server, enabled=pack.usable_tools)
        for remote in remotes:
            if remote.target in self._connectors or remote.target in targets:
                logger.error("remote target collides with a connector")
                continue
            try:
                remote_server = remote.server
            except ValidationError:
                logger.exception("remote MCP does not fit the catalog")
                continue
            self._remotes[remote.registration_id] = remote
            self._add_tools(remote_server, enabled=remote.usable_tools)

    def _add_tools(self, server: McpServer, *, enabled: frozenset[str] | None) -> None:
        names = [tool.name for tool in server.tools]
        if len(set(names)) != len(names):
            raise InvalidCatalogError("duplicate tool name")
        for tool in server.tools:
            ref = f"{server.id}.{tool.name}"
            # A destructive tool is never enabled, not even with approval (D84): no agent can
            # be given it (`tool_not_enabled`).
            usable = (enabled is None or tool.name in enabled) and tool.access != "destructive"
            self._tools[ref] = CatalogTool(ref=ref, server=server, tool=tool, enabled=usable)

    @property
    def connectors(self) -> tuple[ConnectorManifest, ...]:
        return tuple(self._connectors[key] for key in sorted(self._connectors))

    @property
    def packs(self) -> tuple[PackState, ...]:
        return tuple(self._packs[key] for key in sorted(self._packs))

    @property
    def remotes(self) -> tuple[RemoteState, ...]:
        return tuple(self._remotes[key] for key in sorted(self._remotes))

    def remote(self, registration_id: str) -> RemoteState | None:
        return self._remotes.get(registration_id)

    def tool(self, ref: str) -> CatalogTool | None:
        return self._tools.get(ref)

    def server(self, server_id: str) -> McpServer | None:
        """A connector, or a pack of the release that fits the catalog."""
        if (connector := self._connectors.get(server_id)) is not None:
            return connector
        registration = registration_of_target(server_id)
        if registration is not None:
            remote = self._remotes.get(registration)
            return remote.server if remote is not None else None
        pack = self._packs.get(server_id)
        return pack.server if pack is not None else None

    def server_enabled(self, server_id: str) -> bool:
        """The server serves at least one tool now (a connector always does)."""
        server = self.server(server_id)
        return server is not None and any(t.enabled for t in self.tools_of(server))

    def pack_tool_unavailable(self, ref: str) -> bool:
        """``ref`` names a pack of the release that does not serve that tool now: the pack is
        not installed, or its installed version does not have the tool (spec §4.4)."""
        tool = self._tools.get(ref)
        return (tool is None or not tool.enabled) and ref.partition(".")[0] in self._packs

    def remote_tool_unavailable(self, ref: str) -> bool:
        """``ref`` names a tool of a remote MCP (``remote-<registration>.<tool>``) that is not
        usable now: the registration is not active, does not exist any more, could not be
        read, or its signed catalog does not name the tool (D98 (17)). Fewer tools than
        approved, never a tool nobody signed."""
        if registration_of_target(ref.partition(".")[0]) is None:
            return False
        tool = self._tools.get(ref)
        return tool is None or not tool.enabled

    def tool_unavailable(self, ref: str) -> bool:
        """A tool of a pack or of a remote MCP that the agent serves without, for now."""
        return self.pack_tool_unavailable(ref) or self.remote_tool_unavailable(ref)

    def remote_of(self, ref: str) -> RemoteState | None:
        """The registration a remote tool ref belongs to, if the catalog knows it."""
        registration = registration_of_target(ref.partition(".")[0])
        return self._remotes.get(registration) if registration is not None else None

    def tools_of(self, server: McpServer) -> tuple[CatalogTool, ...]:
        return tuple(
            tool
            for manifest_tool in server.tools
            if (tool := self._tools.get(f"{server.id}.{manifest_tool.name}")) is not None
        )

    def with_packs(self, packs: Iterable[PackState], *, available: bool = True) -> McpCatalog:
        return McpCatalog(
            self.connectors,
            packs,
            packs_available=available,
            remotes=self.remotes,
            remotes_available=self.remotes_available,
        )

    def with_remotes(self, remotes: Iterable[RemoteState], *, available: bool = True) -> McpCatalog:
        return McpCatalog(
            self.connectors,
            self.packs,
            packs_available=self.packs_available,
            remotes=remotes,
            remotes_available=available,
        )

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
    their installation state, and the remote MCP registrations with their signed catalogs.

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
        remotes: Callable[[], tuple[RemoteState, ...]] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._connectors = connectors
        self._release = release
        self._store = store
        self._remotes = remotes
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
        remotes, readable = self._remote_states()
        if self._remotes is not None:
            catalog = catalog.with_remotes(remotes, available=readable)
        if readable:
            # A read error is never cached: the next call reads again.
            with self._lock:
                self._cached = (self._clock(), catalog)
        return catalog

    def _remote_states(self) -> tuple[tuple[RemoteState, ...], bool]:
        """The registrations and whether they could be read. Unread, every remote tool counts
        as unavailable: agents serve without them, never with tools nobody signed."""
        if self._remotes is None:
            return (), True
        try:
            return self._remotes(), True
        except (RemoteRecordError, ClientError, BotoCoreError):
            logger.exception("remote MCP registrations unavailable")
            return (), False

    def invalidate(self) -> None:
        with self._lock:
            self._cached = None

    def __call__(self) -> McpCatalog:
        base = self._connectors()
        packs = (
            self._release is not None and self._store is not None and bool(self._release.catalog)
        )
        if not packs and self._remotes is None:
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
