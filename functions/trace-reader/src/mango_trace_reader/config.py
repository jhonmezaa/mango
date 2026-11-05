"""Installation settings of the trace reader, from the Lambda environment."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

SPANS_LOG_GROUP: Final = "aws/spans"
"""Where CloudWatch Transaction Search writes the spans of the account (D16): split telemetry."""
RUNTIME_LOG_GROUP_PREFIX: Final = "/aws/bedrock-agentcore/runtimes/"
"""Log groups of the AgentCore runtimes: with unified telemetry their ``spans`` stream holds the
spans of the runtime (AgentCore documentation, read on 2026-11-05)."""
RUNTIME_SPANS_STREAM: Final = "spans"

_NAMESPACE_RE: Final = re.compile(r"^[a-z0-9]{3,8}$")


class ConfigError(Exception):
    """The Lambda environment is not what the stack should have set."""


@dataclass(frozen=True)
class Settings:
    namespace: str

    @property
    def harness_prefix(self) -> str:
        """``harness.id`` of every harness of the installation starts like this (``Mango_<ns>_a_``,
        the agents' and the Playground's)."""
        return f"Mango_{self.namespace}_a_"

    @property
    def runtime_log_group_prefix(self) -> str:
        """Log groups of the runtimes AgentCore makes for those harnesses."""
        return f"{RUNTIME_LOG_GROUP_PREFIX}harness_{self.harness_prefix}"

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env
        namespace = env.get("MANGO_NAMESPACE", "")
        if not _NAMESPACE_RE.fullmatch(namespace):
            raise ConfigError("invalid MANGO_NAMESPACE")
        return Settings(namespace=namespace)
