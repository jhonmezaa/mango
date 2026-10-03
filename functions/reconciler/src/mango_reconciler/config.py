"""Installation settings of the reconciler and the names it expects to find (spec §5.2).

The names and the trust policy are the ones the provisioner uses
(``mango_provisioner.config`` and ``mango_provisioner.role``), and the ones the pack
provisioner uses for pack runtimes (``mango_provisioner.packs.config``); a test keeps both
sides equal. The reconciler only reads: it never repairs what it finds.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import timedelta
from types import MappingProxyType
from typing import Any

from mango_core.agents import is_agent_id
from mango_core.agents_table import APPROVED_STUCK_AFTER

ENDPOINT_LIVE = "live"
ENDPOINT_DEFAULT = "DEFAULT"
"""Endpoint every runtime has; it always serves the latest runtime version."""
PACK_NETWORK_MODE = "VPC"
"""The only network a pack runtime may run in: the pack VPC, which has no way out (R6, D54)."""
ROLE_POLICY_NAME = "agent"
AGENTCORE_SERVICE = "bedrock-agentcore.amazonaws.com"

# Creator limits mango-api enforces (``mango_api.agent_rules``); more than this in the table
# means they were bypassed (TM-M9).
MAX_DRAFTS = 20
MAX_SUBMISSIONS_PER_DAY = 5

LOCK_TTL = timedelta(minutes=30)
"""How long the provisioner holds an agent (``mango_provisioner.store.LOCK_TTL``). A lock that
ends later than this from now was not written by the provisioner."""
STUCK_AFTER = APPROVED_STUCK_AFTER
"""An ``approved`` version older than this has no execution behind it; mango-api lets an
administrator retry it from the same moment (``mango_core.agents_table``)."""
CLOCK_SKEW = timedelta(minutes=5)
DEPROVISION_GRACE = timedelta(minutes=45)
"""How long after a retirement the agent's harness and role may still exist without anyone
holding the agent: the deprovisioner starts with the retirement and holds the lock while it
works (D48). After this, what is left means the removal failed or never started."""

_NAMESPACE_RE = re.compile(r"^[a-z0-9]{3,8}$")
_ACCOUNT_RE = re.compile(r"^\d{12}$")
_REGION_RE = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d$")
_TABLE_RE = re.compile(r"^[A-Za-z0-9_.-]{3,255}$")
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")


class ConfigError(Exception):
    """The Lambda environment is not what the stack should have set."""


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
    boundary_arn: str
    """Permissions boundary every agent role must carry (TM-M1)."""
    release_agents: Mapping[str, str] = field(default_factory=dict)
    """Agent id -> content hash of the versions the release ships approved (D34, TM-M16).
    The same values the stack gives the provisioner."""

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env
        try:
            settings = Settings(
                namespace=_match(_NAMESPACE_RE, "MANGO_NAMESPACE", env["MANGO_NAMESPACE"]),
                region=_match(_REGION_RE, "AWS_REGION", env["AWS_REGION"]),
                account_id=_match(_ACCOUNT_RE, "MANGO_ACCOUNT_ID", env["MANGO_ACCOUNT_ID"]),
                agents_table=_match(_TABLE_RE, "AGENTS_TABLE", env["AGENTS_TABLE"]),
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

    @property
    def role_prefix(self) -> str:
        return f"Mango-{self.namespace}-agent-"

    def role_name(self, agent_id: str) -> str:
        return f"{self.role_prefix}{agent_id}"

    def role_arn(self, agent_id: str) -> str:
        return f"arn:aws:iam::{self.account_id}:role/{self.role_name(agent_id)}"

    @property
    def harness_prefix(self) -> str:
        return f"Mango_{self.namespace}_a_"

    def harness_name(self, agent_id: str) -> str:
        return f"{self.harness_prefix}{agent_id}"

    def harness_arn(self, harness_id: str) -> str:
        return f"arn:aws:bedrock-agentcore:{self.region}:{self.account_id}:harness/{harness_id}"

    def runtime_name(self, agent_id: str) -> str:
        return f"harness_{self.harness_name(agent_id)}"

    @property
    def pack_runtime_prefix(self) -> str:
        """Runtimes of MCP packs: ``Mango_<ns>_mcp_<pack id>`` (D36)."""
        return f"Mango_{self.namespace}_mcp_"

    def agent_of_role(self, role_name: str) -> str | None:
        """Agent id a role name stands for, or ``None`` if it is not a name Mango would use."""
        return _agent_of(role_name, self.role_prefix)

    def agent_of_harness(self, harness_name: str, harness_id: str) -> str | None:
        """Agent id of a harness; AgentCore appends ``-<10 characters>`` to the name."""
        agent_id = _agent_of(harness_name, self.harness_prefix)
        if agent_id is None or not re.fullmatch(
            rf"{re.escape(harness_name)}-[A-Za-z0-9]{{10}}", harness_id
        ):
            return None
        return agent_id

    def trust_policy(self, agent_id: str) -> dict[str, Any]:
        """Only AgentCore, in this account, acting for this agent's harness or its runtime."""
        prefix = f"arn:aws:bedrock-agentcore:{self.region}:{self.account_id}"
        return {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {"Service": AGENTCORE_SERVICE},
                    "Action": "sts:AssumeRole",
                    "Condition": {
                        "StringEquals": {"aws:SourceAccount": self.account_id},
                        "ArnLike": {
                            "aws:SourceArn": [
                                f"{prefix}:harness/{self.harness_name(agent_id)}-*",
                                f"{prefix}:runtime/{self.runtime_name(agent_id)}-*",
                            ]
                        },
                    },
                }
            ],
        }


def _agent_of(name: str, prefix: str) -> str | None:
    if not name.startswith(prefix):
        return None
    agent_id = name[len(prefix) :]
    return agent_id if is_agent_id(agent_id) else None
