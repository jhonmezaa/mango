"""Installation settings of the cost anomaly consumer, from the Lambda environment."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass

_NAMESPACE_RE = re.compile(r"^[a-z0-9]{3,8}$")
_ACCOUNT_RE = re.compile(r"^\d{12}$")
_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,255}$")
_QUEUE_URL_RE = re.compile(
    r"^https://sqs\.[a-z0-9-]+\.amazonaws\.com/\d{12}/Mango-([a-z0-9]{3,8})-TaskRuns$"
)


class ConfigError(Exception):
    """The Lambda environment is not what the stack should have set."""


@dataclass(frozen=True)
class Settings:
    namespace: str
    management_account_id: str
    audit_stream: str
    audit_index_table: str
    task_runs_queue_url: str

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env
        try:
            settings = Settings(
                namespace=env["MANGO_NAMESPACE"],
                management_account_id=env["MANAGEMENT_ACCOUNT_ID"],
                audit_stream=env["AUDIT_STREAM"],
                audit_index_table=env["AUDIT_INDEX_TABLE"],
                task_runs_queue_url=env["TASK_RUNS_QUEUE_URL"],
            )
        except KeyError as exc:
            raise ConfigError(f"missing environment variable {exc.args[0]}") from None
        if not _NAMESPACE_RE.fullmatch(settings.namespace):
            raise ConfigError("invalid MANGO_NAMESPACE")
        if not _ACCOUNT_RE.fullmatch(settings.management_account_id):
            raise ConfigError("invalid MANAGEMENT_ACCOUNT_ID")
        for name in (settings.audit_stream, settings.audit_index_table):
            if not _NAME_RE.fullmatch(name):
                raise ConfigError("invalid resource name in the environment")
        queue = _QUEUE_URL_RE.fullmatch(settings.task_runs_queue_url)
        if queue is None or queue.group(1) != settings.namespace:
            raise ConfigError("invalid TASK_RUNS_QUEUE_URL")
        return settings
