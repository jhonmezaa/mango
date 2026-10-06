"""Installation settings of the budget reconciler, from the Lambda environment."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass

SPANS_LOG_GROUP = "aws/spans"
"""Where CloudWatch Transaction Search writes the spans of the account (D16)."""

_NAMESPACE_RE = re.compile(r"^[a-z0-9]{3,8}$")
_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,255}$")


class ConfigError(Exception):
    """The Lambda environment is not what the stack should have set."""


@dataclass(frozen=True)
class Settings:
    namespace: str
    budgets_table: str
    audit_stream: str
    audit_index_table: str

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env
        try:
            settings = Settings(
                namespace=env["MANGO_NAMESPACE"],
                budgets_table=env["BUDGETS_TABLE"],
                audit_stream=env["AUDIT_STREAM"],
                audit_index_table=env["AUDIT_INDEX_TABLE"],
            )
        except KeyError as exc:
            raise ConfigError(f"missing environment variable {exc.args[0]}") from None
        if not _NAMESPACE_RE.fullmatch(settings.namespace):
            raise ConfigError("invalid MANGO_NAMESPACE")
        for name in (settings.budgets_table, settings.audit_stream, settings.audit_index_table):
            if not _NAME_RE.fullmatch(name):
                raise ConfigError("invalid resource name in the environment")
        return settings
