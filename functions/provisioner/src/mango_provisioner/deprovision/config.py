"""Installation settings of the agent deprovisioner and the names of what it deletes.

Everything here comes from the stack (Lambda environment). The names are the ones the agent
provisioner creates (``mango_provisioner.config``; a test keeps both sides equal): they derive
only from the namespace and the agent id, so the IAM policy of the deprovisioner pins them by
prefix and nothing else can be deleted.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass

from mango_core.agents import is_agent_id
from mango_provisioner.config import ConfigError

ENDPOINT_DEFAULT = "DEFAULT"
"""Endpoint AgentCore keeps for every harness; it goes away with the harness itself."""

_NAMESPACE_RE = re.compile(r"^[a-z0-9]{3,8}$")
_ACCOUNT_RE = re.compile(r"^\d{12}$")
_REGION_RE = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d$")
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")


def _release_agents(raw: str) -> frozenset[str]:
    """Ids of the agents this release ships (D34): their resources are never deleted."""
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise ConfigError("RELEASE_AGENTS is not JSON") from exc
    if not isinstance(data, dict) or not all(
        is_agent_id(agent_id) and isinstance(digest, str) and _HASH_RE.fullmatch(digest)
        for agent_id, digest in data.items()
    ):
        raise ConfigError("RELEASE_AGENTS is invalid")
    return frozenset(data)


def _match(pattern: re.Pattern[str], name: str, value: str) -> str:
    if not pattern.fullmatch(value):
        raise ConfigError(f"{name} is invalid")
    return value


@dataclass(frozen=True)
class DeprovisionSettings:
    namespace: str
    region: str
    account_id: str
    agents_table: str
    audit_stream: str
    audit_index_table: str
    boundary_arn: str
    """Permissions boundary of agent roles: a role without it is not one Mango created."""
    release_agents: frozenset[str]

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> DeprovisionSettings:
        env = os.environ if env is None else env
        try:
            settings = DeprovisionSettings(
                namespace=_match(_NAMESPACE_RE, "MANGO_NAMESPACE", env["MANGO_NAMESPACE"]),
                region=_match(_REGION_RE, "AWS_REGION", env["AWS_REGION"]),
                account_id=_match(_ACCOUNT_RE, "MANGO_ACCOUNT_ID", env["MANGO_ACCOUNT_ID"]),
                agents_table=env["AGENTS_TABLE"],
                audit_stream=env["AUDIT_STREAM"],
                audit_index_table=env["AUDIT_INDEX_TABLE"],
                boundary_arn=env["AGENT_BOUNDARY_ARN"],
                release_agents=_release_agents(env["RELEASE_AGENTS"]),
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

    def role_name(self, agent_id: str) -> str:
        return f"Mango-{self.namespace}-agent-{_agent(agent_id)}"

    def harness_name(self, agent_id: str) -> str:
        return f"Mango_{self.namespace}_a_{_agent(agent_id)}"

    def harness_id_pattern(self, agent_id: str) -> re.Pattern[str]:
        """AgentCore appends ``-<10 characters>`` to the name."""
        return re.compile(rf"^{re.escape(self.harness_name(agent_id))}-[A-Za-z0-9]{{10}}$")

    def harness_arn(self, harness_id: str) -> str:
        return f"arn:aws:bedrock-agentcore:{self.region}:{self.account_id}:harness/{harness_id}"


def _agent(agent_id: str) -> str:
    if not is_agent_id(agent_id):
        raise ValueError("invalid agent id")
    return agent_id
