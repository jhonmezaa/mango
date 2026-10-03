"""Installation settings of the provisioner and the names of what it creates (spec §5.2).

Everything here comes from the stack (Lambda environment), never from an agent definition.
Names are derived only from the namespace and the agent id, so the IAM policy of the
provisioner can pin them by prefix (TM-M1).
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType

from mango_core.agents import is_agent_id

ENDPOINT_LIVE = "live"
"""Harness endpoint mango-api invokes; the provisioner moves it to the published version."""
ENDPOINT_DEFAULT = "DEFAULT"
ROLE_POLICY_NAME = "agent"
RUNTIME_LOG_RETENTION_DAYS = 30  # D16
_LOG_GROUP_PREFIX = "/aws/bedrock-agentcore/runtimes/"

_NAMESPACE_RE = re.compile(r"^[a-z0-9]{3,8}$")
_ACCOUNT_RE = re.compile(r"^\d{12}$")
_REGION_RE = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d$")
_TARGET_RE = re.compile(r"^[A-Za-z0-9-]{1,48}$")
_CONNECTOR_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
_TOOL_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_GATEWAY_URL_RE = re.compile(
    r"^https://[a-z0-9-]+\.gateway\.bedrock-agentcore\.[a-z0-9-]+\.amazonaws\.com/mcp$"
)
_GUARDRAIL_ID_RE = re.compile(r"^[a-z0-9]{1,64}$")
_GUARDRAIL_VERSION_RE = re.compile(r"^[1-9][0-9]{0,7}$")
_ACCESS = frozenset({"read", "write"})
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
RELEASE_APPROVER_PREFIX = "release@"
"""``approved_by`` of a version the release ships already approved (D34)."""
# AgentCore accepts 60 s to 8 h for both session lifecycle settings.
_MIN_SESSION_SECONDS = 60
_MAX_SESSION_SECONDS = 28_800


class ConfigError(Exception):
    """The Lambda environment is not what the stack should have set."""


@dataclass(frozen=True)
class Connector:
    """Tools of one connector of the release (`connectors/<id>/manifest.json`)."""

    target: str
    """Gateway target; tools are exposed as ``<target>___<tool>``."""
    tools: Mapping[str, str]
    """Tool name -> ``read`` | ``write``."""


def _connector_catalog(raw: str) -> Mapping[str, Connector]:
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise ConfigError("CONNECTOR_CATALOG is not JSON") from exc
    if not isinstance(data, dict):
        raise ConfigError("CONNECTOR_CATALOG must be an object")
    catalog: dict[str, Connector] = {}
    for connector_id, entry in data.items():
        target = entry.get("target") if isinstance(entry, dict) else None
        tools = entry.get("tools") if isinstance(entry, dict) else None
        if (
            not _CONNECTOR_RE.fullmatch(str(connector_id))
            or not isinstance(target, str)
            or not _TARGET_RE.fullmatch(target)
            or not isinstance(tools, dict)
            or not all(
                isinstance(name, str) and _TOOL_RE.fullmatch(name) and access in _ACCESS
                for name, access in tools.items()
            )
        ):
            raise ConfigError("CONNECTOR_CATALOG has an invalid entry")
        catalog[connector_id] = Connector(target=target, tools=MappingProxyType(dict(tools)))
    return MappingProxyType(catalog)


def _release_agents(raw: str) -> Mapping[str, str]:
    """``{agent id: content hash}`` of the agents this release ships approved (D34)."""
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise ConfigError("RELEASE_AGENTS is not JSON") from exc
    if not isinstance(data, dict) or not all(
        is_agent_id(agent_id) and isinstance(digest, str) and _HASH_RE.fullmatch(digest)
        for agent_id, digest in data.items()
    ):
        raise ConfigError("RELEASE_AGENTS is invalid")
    return MappingProxyType(dict(data))


def _seconds(name: str, env: Mapping[str, str]) -> int:
    value = env[name]
    if not value.isdigit() or not _MIN_SESSION_SECONDS <= int(value) <= _MAX_SESSION_SECONDS:
        raise ConfigError(f"{name} is invalid")
    return int(value)


def _match(pattern: re.Pattern[str], name: str, value: str) -> str:
    if not pattern.fullmatch(value):
        raise ConfigError(f"{name} is invalid")
    return value


@dataclass(frozen=True)
class Settings:
    namespace: str
    region: str
    account_id: str
    agents_table: str
    settings_table: str
    audit_stream: str
    audit_index_table: str
    boundary_arn: str
    """Permissions boundary every agent role must carry (TM-M1)."""
    gateway_url: str
    guardrail_id: str
    guardrail_version: str
    runtime_logs_key_arn: str
    connectors: Mapping[str, Connector]
    release_agents: Mapping[str, str]
    """Agent id -> content hash of the versions the release ships approved (D34, TM-M16)."""
    session_idle_seconds: int
    """Runtime session lifecycle (D39); mango-api keeps sessions with the same values."""
    session_max_seconds: int

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env
        try:
            namespace = _match(_NAMESPACE_RE, "MANGO_NAMESPACE", env["MANGO_NAMESPACE"])
            account_id = _match(_ACCOUNT_RE, "MANGO_ACCOUNT_ID", env["MANGO_ACCOUNT_ID"])
            settings = Settings(
                namespace=namespace,
                region=_match(_REGION_RE, "AWS_REGION", env["AWS_REGION"]),
                account_id=account_id,
                agents_table=env["AGENTS_TABLE"],
                settings_table=env["SETTINGS_TABLE"],
                audit_stream=env["AUDIT_STREAM"],
                audit_index_table=env["AUDIT_INDEX_TABLE"],
                boundary_arn=env["AGENT_BOUNDARY_ARN"],
                gateway_url=_match(_GATEWAY_URL_RE, "GATEWAY_URL", env["GATEWAY_URL"]),
                guardrail_id=_match(_GUARDRAIL_ID_RE, "GUARDRAIL_ID", env["GUARDRAIL_ID"]),
                guardrail_version=_match(
                    _GUARDRAIL_VERSION_RE, "GUARDRAIL_VERSION", env["GUARDRAIL_VERSION"]
                ),
                runtime_logs_key_arn=env["RUNTIME_LOGS_KEY_ARN"],
                connectors=_connector_catalog(env["CONNECTOR_CATALOG"]),
                release_agents=_release_agents(env["RELEASE_AGENTS"]),
                session_idle_seconds=_seconds("AGENT_SESSION_IDLE_SECONDS", env),
                session_max_seconds=_seconds("AGENT_SESSION_MAX_SECONDS", env),
            )
        except KeyError as exc:
            raise ConfigError(f"missing environment variable {exc.args[0]}") from None
        if settings.boundary_arn != settings.expected_boundary_arn:
            raise ConfigError("AGENT_BOUNDARY_ARN is not this installation's agent boundary")
        return settings

    # --- Names (regla 6, D32) -------------------------------------------------------------

    @property
    def expected_boundary_arn(self) -> str:
        return f"arn:aws:iam::{self.account_id}:policy/Mango-{self.namespace}-agent-boundary"

    @property
    def guardrail_arn(self) -> str:
        return f"arn:aws:bedrock:{self.region}:{self.account_id}:guardrail/{self.guardrail_id}"

    def role_name(self, agent_id: str) -> str:
        return f"Mango-{self.namespace}-agent-{_agent(agent_id)}"

    def role_arn(self, agent_id: str) -> str:
        return f"arn:aws:iam::{self.account_id}:role/{self.role_name(agent_id)}"

    def harness_name(self, agent_id: str) -> str:
        """No hyphens and at most 40 characters: AgentCore's limits for a harness name."""
        return f"Mango_{self.namespace}_a_{_agent(agent_id)}"

    def harness_id_pattern(self, agent_id: str) -> re.Pattern[str]:
        """AgentCore appends ``-<10 characters>`` to the name."""
        return re.compile(rf"^{re.escape(self.harness_name(agent_id))}-[A-Za-z0-9]{{10}}$")

    def harness_arn(self, harness_id: str) -> str:
        return f"arn:aws:bedrock-agentcore:{self.region}:{self.account_id}:harness/{harness_id}"

    def runtime_name(self, agent_id: str) -> str:
        """Runtime AgentCore creates for the harness (``harness_<name>``)."""
        return f"harness_{self.harness_name(agent_id)}"

    def runtime_id_pattern(self, agent_id: str) -> re.Pattern[str]:
        return re.compile(rf"^{re.escape(self.runtime_name(agent_id))}-[A-Za-z0-9]{{10}}$")

    def log_group_names(self, runtime_id: str) -> tuple[str, str]:
        """One log group per runtime endpoint; AgentCore names them after the runtime id."""
        return (
            f"{_LOG_GROUP_PREFIX}{runtime_id}-{ENDPOINT_DEFAULT}",
            f"{_LOG_GROUP_PREFIX}{runtime_id}-{ENDPOINT_LIVE}",
        )

    def tags(self, agent_id: str) -> dict[str, str]:
        """Cost tags (same keys as the stack) plus the agent the resource belongs to."""
        return {
            "mango:namespace": self.namespace,
            "mango:component": "agent",
            "mango:agent": _agent(agent_id),
        }


def _agent(agent_id: str) -> str:
    if not is_agent_id(agent_id):
        raise ValueError("invalid agent id")
    return agent_id
