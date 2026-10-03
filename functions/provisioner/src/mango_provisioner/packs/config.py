"""Installation settings of the pack provisioner and the names of what it creates per pack.

Everything here comes from the stack (Lambda environment), never from an enablement request
or from a pack. That includes what decides which code may be installed: the public key that
verifies pack signatures, the release catalog (one exact signed statement per pack) and the
IAM actions the pack permissions boundary allows. Names are derived only from the namespace
and the pack id, so the IAM policy of the provisioner can pin them by prefix (TM-M1).
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from urllib.parse import quote

from mango_packs.enablement import is_pack_id
from mango_packs.signing import PackSignatureError, load_public_key

ENDPOINT_LIVE = "live"
"""Runtime endpoint the Gateway target invokes; moved only to a verified runtime version."""
ENDPOINT_DEFAULT = "DEFAULT"
ROLE_POLICY_NAME = "pack"
COMPONENT_TAG = "mcp-pack"
_LOG_GROUP_PREFIX = "/aws/bedrock-agentcore/runtimes/"

_NAMESPACE_RE = re.compile(r"^[a-z0-9]{3,8}$")
_ACCOUNT_RE = re.compile(r"^\d{12}$")
_REGION_RE = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d$")
_BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
_GATEWAY_ID_RE = re.compile(r"^([0-9a-z][-]?){1,100}-[0-9a-z]{10}$")
_POLICY_ENGINE_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*-[a-z0-9_]{10}$")
_VERSION_RE = re.compile(r"^[0-9]+(\.[0-9]+){1,3}-[1-9][0-9]{0,3}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_ACTION_RE = re.compile(r"^[a-z0-9-]{1,32}:[A-Za-z0-9]{1,64}$")
_TARGET_RE = re.compile(r"^[A-Za-z0-9-]{1,48}$")
_ROLE_ARN_RE = re.compile(r"^arn:aws:iam::\d{12}:role/[\w+=,.@-]{1,64}$")
_ROLE_NAME_RE = re.compile(r"^[\w+=,.@-]{1,64}$", re.ASCII)
_KMS_KEY_ARN_RE = re.compile(r"^arn:aws:kms:[a-z0-9-]+:\d{12}:key/[0-9a-f-]{36}$")
_SUBNET_RE = re.compile(r"^subnet-[0-9a-f]{8,17}$")
_SECURITY_GROUP_RE = re.compile(r"^sg-[0-9a-f]{8,17}$")
_MAX_SUBNETS = 16
"""AgentCore's limit for a runtime in VPC mode."""
_MIN_SUBNETS = 2
"""Two Availability Zones: the least the stack ever builds for packs."""


class ConfigError(Exception):
    """The Lambda environment is not what the stack should have set."""


@dataclass(frozen=True)
class CatalogEntry:
    """The only signed statement of a pack this release installs (no rollback, TM-P6)."""

    version: str
    statement_sha256: str


def _json(name: str, env: Mapping[str, str]) -> object:
    try:
        return json.loads(env[name])
    except ValueError:
        raise ConfigError(f"{name} is not JSON") from None


def _catalog(raw: object) -> Mapping[str, CatalogEntry]:
    if not isinstance(raw, dict):
        raise ConfigError("PACK_CATALOG must be an object")
    catalog: dict[str, CatalogEntry] = {}
    for pack_id, entry in raw.items():
        version = entry.get("version") if isinstance(entry, dict) else None
        digest = entry.get("statement_sha256") if isinstance(entry, dict) else None
        if (
            not is_pack_id(pack_id)
            or not isinstance(version, str)
            or not _VERSION_RE.fullmatch(version)
            or not isinstance(digest, str)
            or not _SHA256_RE.fullmatch(digest)
        ):
            raise ConfigError("PACK_CATALOG has an invalid entry")
        catalog[pack_id] = CatalogEntry(version=version, statement_sha256=digest)
    return MappingProxyType(catalog)


def _strings(name: str, raw: object, pattern: re.Pattern[str]) -> frozenset[str]:
    if not isinstance(raw, list) or not all(
        isinstance(item, str) and pattern.fullmatch(item) for item in raw
    ):
        raise ConfigError(f"{name} is invalid")
    return frozenset(raw)


def _match(pattern: re.Pattern[str], name: str, value: str) -> str:
    if not pattern.fullmatch(value):
        raise ConfigError(f"{name} is invalid")
    return value


def _optional(pattern: re.Pattern[str], name: str, value: str) -> str | None:
    """A setting the stack leaves empty when the installation does not have the feature."""
    return _match(pattern, name, value) if value else None


@dataclass(frozen=True)
class PackNetwork:
    """Where pack runtimes run (R6): the pack VPC of the stack, which has no way out but the
    VPC endpoints each pack's security group allows. Built by the stack from the signed
    manifests of the release; never from a request or from a pack.
    """

    subnets: tuple[str, ...]
    security_groups: Mapping[str, str]
    """Pack id -> its security group. A pack without one cannot be installed."""

    def configuration(self, pack_id: str) -> dict[str, object]:
        """``networkConfiguration`` of the pack's runtime. Never ``PUBLIC``."""
        group = self.security_groups.get(pack_id)
        if group is None or not self.subnets:
            raise KeyError(pack_id)
        return {
            "networkMode": "VPC",
            "networkModeConfig": {"subnets": list(self.subnets), "securityGroups": [group]},
        }


def _network(raw: object) -> PackNetwork:
    subnets = raw.get("subnets") if isinstance(raw, dict) else None
    groups = raw.get("security_groups") if isinstance(raw, dict) else None
    if (
        not isinstance(raw, dict)
        or set(raw) != {"subnets", "security_groups"}
        or not isinstance(subnets, list)
        or len(subnets) > _MAX_SUBNETS
        or len(set(subnets)) != len(subnets)
        or not all(isinstance(item, str) and _SUBNET_RE.fullmatch(item) for item in subnets)
        or not isinstance(groups, dict)
        or not all(
            is_pack_id(pack_id) and isinstance(group, str) and _SECURITY_GROUP_RE.fullmatch(group)
            for pack_id, group in groups.items()
        )
        # A network with packs has subnets; a release without packs has neither.
        or (bool(groups) and len(subnets) < _MIN_SUBNETS)
    ):
        raise ConfigError("PACK_NETWORK is invalid")
    return PackNetwork(subnets=tuple(subnets), security_groups=MappingProxyType(dict(groups)))


def _public_key(value: str) -> bytes | None:
    """PEM of the provider's signing key, or ``None`` while signing is not set up (U10).

    Without a key nothing can be verified, so nothing is installed.
    """
    if not value.strip():
        return None
    pem = value.encode()
    try:
        load_public_key(pem)
    except PackSignatureError:
        raise ConfigError("PACK_SIGNING_PUBLIC_KEY is invalid") from None
    return pem


@dataclass(frozen=True)
class PackSettings:
    namespace: str
    region: str
    account_id: str
    settings_table: str
    audit_stream: str
    audit_index_table: str
    boundary_arn: str
    """Permissions boundary every pack role must carry (TM-M1)."""
    allowed_actions: frozenset[str]
    """IAM actions the boundary lets a pack use; a manifest asking for more is refused."""
    packs_bucket: str
    catalog: Mapping[str, CatalogEntry]
    public_key_pem: bytes | None
    gateway_id: str
    policy_engine_id: str
    runtime_logs_key_arn: str
    connector_targets: frozenset[str]
    """Gateway targets of Mango connectors: a pack never takes or touches one of them."""
    broker_role_arn: str | None = None
    """Broker a pack over account data assumes on every call, as the user (D10, D37)."""
    target_role_arn: str | None = None
    """Read-only role behind the broker, in the account that holds the data (the payer)."""
    brokered_actions: frozenset[str] = frozenset()
    """Actions that role allows: the ceiling of a ``central_only`` manifest."""
    identity_key_arn: str | None = None
    """KMS key the Gateway interceptor signs callers with; packs get its public key."""
    member_broker_role_arn: str | None = None
    """Read broker: what a pack of the member chain assumes on every call, as the user (D51)."""
    member_role_name: str | None = None
    """Name of the role behind the Read broker in every member account. A name, not an ARN:
    the account is the one each call asks for."""
    member_actions: frozenset[str] = frozenset()
    """Actions that role allows: the ceiling of a manifest of the member chain."""
    network: PackNetwork = PackNetwork(subnets=(), security_groups=MappingProxyType({}))
    """Subnets and per-pack security groups of the pack VPC (R6)."""

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> PackSettings:
        env = os.environ if env is None else env
        try:
            settings = PackSettings(
                namespace=_match(_NAMESPACE_RE, "MANGO_NAMESPACE", env["MANGO_NAMESPACE"]),
                region=_match(_REGION_RE, "AWS_REGION", env["AWS_REGION"]),
                account_id=_match(_ACCOUNT_RE, "MANGO_ACCOUNT_ID", env["MANGO_ACCOUNT_ID"]),
                settings_table=env["SETTINGS_TABLE"],
                audit_stream=env["AUDIT_STREAM"],
                audit_index_table=env["AUDIT_INDEX_TABLE"],
                boundary_arn=env["PACK_BOUNDARY_ARN"],
                allowed_actions=_strings(
                    "PACK_ALLOWED_ACTIONS", _json("PACK_ALLOWED_ACTIONS", env), _ACTION_RE
                ),
                packs_bucket=_match(_BUCKET_RE, "PACKS_BUCKET", env["PACKS_BUCKET"]),
                catalog=_catalog(_json("PACK_CATALOG", env)),
                public_key_pem=_public_key(env["PACK_SIGNING_PUBLIC_KEY"]),
                gateway_id=_match(_GATEWAY_ID_RE, "GATEWAY_ID", env["GATEWAY_ID"]),
                policy_engine_id=_match(
                    _POLICY_ENGINE_ID_RE, "POLICY_ENGINE_ID", env["POLICY_ENGINE_ID"]
                ),
                runtime_logs_key_arn=env["RUNTIME_LOGS_KEY_ARN"],
                connector_targets=_strings(
                    "CONNECTOR_TARGETS", _json("CONNECTOR_TARGETS", env), _TARGET_RE
                ),
                broker_role_arn=_optional(
                    _ROLE_ARN_RE, "PACK_BROKER_ROLE_ARN", env["PACK_BROKER_ROLE_ARN"]
                ),
                target_role_arn=_optional(
                    _ROLE_ARN_RE, "PACK_TARGET_ROLE_ARN", env["PACK_TARGET_ROLE_ARN"]
                ),
                brokered_actions=_strings(
                    "PACK_BROKERED_ACTIONS", _json("PACK_BROKERED_ACTIONS", env), _ACTION_RE
                ),
                identity_key_arn=_optional(
                    _KMS_KEY_ARN_RE, "PACK_IDENTITY_KEY_ARN", env["PACK_IDENTITY_KEY_ARN"]
                ),
                # Absent in an installation without access to the member accounts.
                member_broker_role_arn=_optional(
                    _ROLE_ARN_RE,
                    "PACK_MEMBER_BROKER_ROLE_ARN",
                    env.get("PACK_MEMBER_BROKER_ROLE_ARN", ""),
                ),
                member_role_name=_optional(
                    _ROLE_NAME_RE, "PACK_MEMBER_ROLE_NAME", env.get("PACK_MEMBER_ROLE_NAME", "")
                ),
                member_actions=_strings(
                    "PACK_MEMBER_ACTIONS",
                    json.loads(env.get("PACK_MEMBER_ACTIONS", "[]")),
                    _ACTION_RE,
                ),
                network=_network(_json("PACK_NETWORK", env)),
            )
        except KeyError as exc:
            raise ConfigError(f"missing environment variable {exc.args[0]}") from None
        except ValueError:
            raise ConfigError("PACK_MEMBER_ACTIONS is not JSON") from None
        if settings.boundary_arn != settings.expected_boundary_arn:
            raise ConfigError("PACK_BOUNDARY_ARN is not this installation's pack boundary")
        return settings

    @property
    def can_broker(self) -> bool:
        """The installation can run packs over account data as the calling user."""
        return bool(self.broker_role_arn and self.target_role_arn and self.identity_key_arn)

    @property
    def can_broker_members(self) -> bool:
        """The installation can run packs that read the member accounts as the calling user."""
        return bool(self.member_broker_role_arn and self.member_role_name and self.identity_key_arn)

    def broker_for(self, *, member: bool) -> str | None:
        """The broker a pack role may assume: one chain per pack, named by its manifest."""
        return self.member_broker_role_arn if member else self.broker_role_arn

    # --- Names (regla 6, D32) -------------------------------------------------------------

    @property
    def expected_boundary_arn(self) -> str:
        return f"arn:aws:iam::{self.account_id}:policy/Mango-{self.namespace}-mcp-boundary"

    @property
    def _agentcore(self) -> str:
        return f"arn:aws:bedrock-agentcore:{self.region}:{self.account_id}"

    @property
    def gateway_arn(self) -> str:
        return f"{self._agentcore}:gateway/{self.gateway_id}"

    def role_name(self, pack_id: str) -> str:
        return f"Mango-{self.namespace}-mcp-{_pack(pack_id)}"

    def role_arn(self, pack_id: str) -> str:
        return f"arn:aws:iam::{self.account_id}:role/{self.role_name(pack_id)}"

    def runtime_name(self, pack_id: str) -> str:
        """No hyphens and at most 48 characters: AgentCore's limits for a runtime name."""
        return f"Mango_{self.namespace}_mcp_{_pack(pack_id).replace('-', '_')}"

    def runtime_id_pattern(self, pack_id: str) -> re.Pattern[str]:
        """AgentCore appends ``-<10 characters>`` to the name."""
        return re.compile(rf"^{re.escape(self.runtime_name(pack_id))}-[A-Za-z0-9]{{10}}$")

    def runtime_arn(self, runtime_id: str) -> str:
        return f"{self._agentcore}:runtime/{runtime_id}"

    def runtime_url(self, runtime_id: str) -> str:
        """MCP endpoint of the runtime's ``live`` endpoint, as the Gateway target calls it."""
        arn = quote(self.runtime_arn(runtime_id), safe="")
        return (
            f"https://bedrock-agentcore.{self.region}.amazonaws.com/runtimes/{arn}/invocations"
            f"?qualifier={ENDPOINT_LIVE}"
        )

    def log_group_names(self, runtime_id: str) -> tuple[str, str]:
        """One log group per runtime endpoint; AgentCore names them after the runtime id."""
        return (
            f"{_LOG_GROUP_PREFIX}{runtime_id}-{ENDPOINT_DEFAULT}",
            f"{_LOG_GROUP_PREFIX}{runtime_id}-{ENDPOINT_LIVE}",
        )

    def target_name(self, pack_id: str) -> str:
        """Gateway target of a pack: its id. Tools are exposed as ``<id>___<tool>``."""
        return _pack(pack_id)

    def policy_name(self, pack_id: str, index: int) -> str:
        """Cedar policies of a pack (at most 48 characters, no hyphens)."""
        return f"{self.runtime_name(pack_id)}_{index}"

    def policy_name_pattern(self, pack_id: str) -> re.Pattern[str]:
        return re.compile(rf"^{re.escape(self.runtime_name(pack_id))}_[1-9][0-9]?$")

    def artifact_prefix(self, pack_id: str, version: str) -> str:
        """Where CloudFormation copies the files of a pack version (D36)."""
        return f"packs/{_pack(pack_id)}/{version}/"

    def envelope_key(self, pack_id: str, version: str) -> str:
        return f"{self.artifact_prefix(pack_id, version)}{pack_id}-{version}.pack.json"

    def tags(self, pack_id: str) -> dict[str, str]:
        """Cost tags (same keys as the stack) plus the pack the resource belongs to."""
        return {
            "mango:namespace": self.namespace,
            "mango:component": COMPONENT_TAG,
            "mango:pack": _pack(pack_id),
        }


def _pack(pack_id: str) -> str:
    if not is_pack_id(pack_id):
        raise ValueError("invalid pack id")
    return pack_id
