"""Pack manifest: what a pack is allowed to be (D19, spec §4.2).

The manifest is the only source of the IAM policy, the tool list and the admin-settable
parameters of a pack (TM-M1), so the schema is strict: unknown fields, IAM wildcards and
anything that looks like a secret are rejected here, before a pack can be built or signed.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Annotated, Any, Literal, Self

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    StringConstraints,
    model_serializer,
    model_validator,
)

SCHEMA_VERSION = 1
QUARANTINE = timedelta(days=7)

PackId = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$", max_length=24)]
Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
Sha256Ref = Annotated[str, StringConstraints(pattern=r"^sha256:[0-9a-f]{64}$")]
UpstreamVersion = Annotated[str, StringConstraints(pattern=r"^[0-9]+(\.[0-9]+){1,3}$")]
# Upstream version plus the Mango revision of the pack: "1.1.1-2".
PackVersion = Annotated[str, StringConstraints(pattern=r"^[0-9]+(\.[0-9]+){1,3}-[1-9][0-9]{0,3}$")]
PackageName = Annotated[
    str, StringConstraints(pattern=r"^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$", max_length=100)
]
ToolName = Annotated[str, StringConstraints(pattern=r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")]
# One exact action: no wildcards, so the role never grows with a new AWS release.
IamAction = Annotated[str, StringConstraints(pattern=r"^[a-z0-9-]{1,32}:[A-Za-z0-9]{1,64}$")]
IamResource = Annotated[
    str, StringConstraints(pattern=r"^(\*|arn:[A-Za-z0-9*?:/_.${}=,@+-]{1,500})$")
]
ConfigKey = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,31}$")]
ConfigValue = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$")]
SourceFile = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,40}\.py$")]
ShortText = Annotated[str, StringConstraints(min_length=1, max_length=120, strip_whitespace=True)]
LongText = Annotated[str, StringConstraints(min_length=1, max_length=600, strip_whitespace=True)]
# Fully qualified host name: no wildcards, no IP addresses, no trailing dot.
EgressHost = Annotated[
    str,
    StringConstraints(
        pattern=r"^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$",
        max_length=253,
    ),
]
CveId = Annotated[
    str, StringConstraints(pattern=r"^(CVE-[0-9]{4}-[0-9]{4,7}|GHSA(-[a-z0-9]{4}){3})$")
]

# Parameters are plain configuration an admin picks from an enum. Secrets never go here (D19).
_SECRET_KEY = re.compile(r"secret|password|passwd|token|credential|api_?key|private")


class DataTier(StrEnum):
    PUBLIC = "public"
    ACCOUNT_DATA = "account_data"
    WRITE = "write"


class IdentityMode(StrEnum):
    SERVICE = "service"
    CENTRAL_ONLY = "central_only"
    PER_USER_ADAPTER = "per_user_adapter"


class IdentityChain(StrEnum):
    """Which broker chain a pack over account data assumes for the caller (D49, D51)."""

    PAYER = "payer"
    """Billing broker -> ``Mango-<ns>-BillingReader`` in the payer account."""
    MEMBER = "member"
    """Read broker -> ``Mango-<ns>-ReadOnly`` in the member account each call asks for."""


class AwsEndpoint(StrEnum):
    """AWS APIs a pack may reach from its network (R6): one VPC endpoint each.

    A closed list: a new one is added here and to the endpoint catalog of the stack
    (``PACK_EGRESS_SERVICES`` in ``infra/lib/constructs/pack-network.ts``), in a reviewed
    release. The names are IAM service prefixes. Every endpoint is the one of the
    installation's own Region: a pack reaches no other Region.
    """

    STS = "sts"
    PRICING = "pricing"
    COST_EXPLORER = "ce"
    BUDGETS = "budgets"
    COMPUTE_OPTIMIZER = "compute-optimizer"
    COST_OPTIMIZATION_HUB = "cost-optimization-hub"
    CLOUDWATCH = "cloudwatch"
    # As data, read with the caller's session. A pack's own log groups need no entry.
    LOGS = "logs"


class ToolAccess(StrEnum):
    READ = "read"
    WRITE = "write"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class PackSource(StrictModel):
    package: PackageName
    version: UpstreamVersion
    # sha256 of the upstream wheel that the lock pins.
    sha256: Sha256Hex
    # Resolution cutoff of the lock (`uv --exclude-newer`).
    exclude_newer: AwareDatetime
    # Security patches may skip the quarantine; the advisory is recorded and reviewed.
    quarantine_exception: CveId | None = None


class PackRuntime(StrictModel):
    """Contract of AgentCore Runtime for MCP servers deployed from a zip (S-M2, S-M3)."""

    python: Literal["PYTHON_3_13"] = "PYTHON_3_13"
    architecture: Literal["arm64"] = "arm64"
    entrypoint: SourceFile = "entrypoint.py"
    protocol: Literal["MCP"] = "MCP"
    port: Literal[8000] = 8000
    path: Literal["/mcp"] = "/mcp"


class IamStatement(StrictModel):
    actions: Annotated[list[IamAction], Field(min_length=1, max_length=50)]
    resources: Annotated[list[IamResource], Field(min_length=1, max_length=20)]
    # Mandatory when a resource is "*": why the API does not accept ARNs.
    reason: LongText | None = None

    @model_validator(mode="after")
    def _wildcard_needs_reason(self) -> Self:
        if "*" in self.resources and self.reason is None:
            raise ValueError('resources "*" requires a reason (the API does not support ARNs)')
        if len(set(self.actions)) != len(self.actions):
            raise ValueError("duplicate IAM action")
        return self


class PackIdentity(StrictModel):
    """How a pack that acts for the caller reaches the data. Part of what is signed."""

    chain: IdentityChain = IdentityChain.PAYER


class PackTool(StrictModel):
    name: ToolName
    access: ToolAccess


class ConfigParam(StrictModel):
    key: ConfigKey
    allowed: Annotated[list[ConfigValue], Field(min_length=1, max_length=50)]
    default: ConfigValue
    description: ShortText | None = None

    @model_validator(mode="after")
    def _enum_only(self) -> Self:
        if _SECRET_KEY.search(self.key):
            raise ValueError(f"config key {self.key!r} looks like a secret; packs take no secrets")
        if len(set(self.allowed)) != len(self.allowed):
            raise ValueError(f"duplicate allowed value in config {self.key!r}")
        if self.default not in self.allowed:
            raise ValueError(f"default of config {self.key!r} is not one of its allowed values")
        return self


class PackEgress(StrictModel):
    """Everything the pack's Runtime may connect to (R6). Its network routes nothing else.

    It is part of the signed manifest: the stack builds the pack's security group from it,
    so an installation cannot widen it.
    """

    aws: Annotated[list[AwsEndpoint], Field(max_length=20)]
    # Hosts outside AWS, on port 443. No installation can enforce them yet, so a pack that
    # names one is not installable (`PackManifest.installable`).
    hosts: Annotated[list[EgressHost], Field(max_length=20)] = []

    @model_validator(mode="after")
    def _unique(self) -> Self:
        if len(set(self.aws)) != len(self.aws):
            raise ValueError("duplicate AWS endpoint in egress")
        if len(set(self.hosts)) != len(self.hosts):
            raise ValueError("duplicate host in egress")
        return self


class PackManifest(StrictModel):
    schema_version: Literal[1]
    id: PackId
    version: PackVersion
    name: ShortText
    description: LongText
    source: PackSource
    runtime: PackRuntime = PackRuntime()
    data_tier: DataTier
    identity_mode: IdentityMode
    # Left out of the serialized manifest while it is the default, so the statements signed
    # before the field existed keep their exact bytes (and their meaning: the payer chain).
    identity: PackIdentity = PackIdentity()
    iam: Annotated[list[IamStatement], Field(max_length=20)]
    # Mandatory, even when empty: a pack states what it reaches.
    egress: PackEgress
    tools: Annotated[list[PackTool], Field(min_length=1, max_length=100)]
    # Hash of the `tools/list` snapshot taken in CI (names, descriptions and schemas).
    tools_hash: Sha256Ref
    config: Annotated[list[ConfigParam], Field(max_length=20)] = []

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if not self.version.startswith(f"{self.source.version}-"):
            raise ValueError("version must be '<source.version>-<revision>'")
        names = [tool.name for tool in self.tools]
        if len(set(names)) != len(names):
            raise ValueError("duplicate tool name")
        keys = [param.key for param in self.config]
        if len(set(keys)) != len(keys):
            raise ValueError("duplicate config key")
        # A server that does not filter per user must not serve account data with its own
        # role to everyone (TM-M3): `service` identity is only for public data.
        if (self.identity_mode is IdentityMode.SERVICE) != (self.data_tier is DataTier.PUBLIC):
            raise ValueError(
                "identity_mode 'service' goes with data_tier 'public', and only with it"
            )
        has_write = any(tool.access is ToolAccess.WRITE for tool in self.tools)
        if has_write != (self.data_tier is DataTier.WRITE):
            raise ValueError("write tools go with data_tier 'write', and only with it")
        if self.member_chain and self.identity_mode is not IdentityMode.CENTRAL_ONLY:
            # The member chain exists only for calls made as a verified central user.
            raise ValueError("identity.chain 'member' goes with identity_mode 'central_only'")
        # Account data is read with a session assumed through the broker on every call.
        if (
            self.identity_mode is not IdentityMode.SERVICE
            and AwsEndpoint.STS not in self.egress.aws
        ):
            raise ValueError("a pack that acts as the calling user needs 'sts' in egress.aws")
        return self

    @model_serializer(mode="wrap")
    def _canonical(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        data: dict[str, Any] = handler(self)
        if self.identity == PackIdentity():
            data.pop("identity", None)
        return data

    @property
    def tool_names(self) -> frozenset[str]:
        return frozenset(tool.name for tool in self.tools)

    @property
    def installable(self) -> bool:
        """What an installation enables today, whatever the signature says.

        Read-only tools, over public data with the pack's own role or over account data in
        ``central_only`` mode (D37). Write tools need an approval on every call (D27) and
        ``per_user_adapter`` is not validated (S-M1): neither exists yet. Hosts outside AWS
        cannot be allowed one by one yet (R6): the pack network only reaches VPC endpoints.
        mango-api and the provisioner both ask here, so they refuse the same packs.
        """
        return (
            self.identity_mode in {IdentityMode.SERVICE, IdentityMode.CENTRAL_ONLY}
            and all(tool.access is ToolAccess.READ for tool in self.tools)
            and not self.egress.hosts
        )

    @property
    def central_only(self) -> bool:
        """The server does not filter by area: only central users, each call as the user."""
        return self.identity_mode is IdentityMode.CENTRAL_ONLY

    @property
    def member_chain(self) -> bool:
        """Each call reads one member account, through the Read broker (D51)."""
        return self.identity.chain is IdentityChain.MEMBER

    def quarantine_error(self, now: datetime) -> str | None:
        """Why the upstream version is still in quarantine at `now`, or None (D19)."""
        if self.source.quarantine_exception is not None:
            return None
        if self.source.exclude_newer > now - QUARANTINE:
            return (
                f"source.exclude_newer {self.source.exclude_newer.isoformat()} is less than "
                f"{QUARANTINE.days} days old; wait, or record source.quarantine_exception "
                "for a security patch"
            )
        return None
