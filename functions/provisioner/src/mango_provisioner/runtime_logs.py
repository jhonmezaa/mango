"""Runtime log groups of an agent harness (D16): customer-managed key and bounded retention.

AgentCore names a log group per runtime endpoint after the generated runtime id and creates
it on its own, unencrypted and without retention, as soon as the endpoint exists. The
provisioner therefore creates-or-adopts them before the agent is published, when nothing has
been invoked yet. The runtimes of MCP packs get the same treatment.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import TYPE_CHECKING

from botocore.exceptions import BotoCoreError, ClientError

from mango_provisioner.config import RUNTIME_LOG_RETENTION_DAYS, Settings
from mango_provisioner.errors import aws_error, error_code

if TYPE_CHECKING:
    from mypy_boto3_logs import CloudWatchLogsClient


def govern_log_groups(
    logs: CloudWatchLogsClient, names: Iterable[str], key_arn: str, tags: Mapping[str, str]
) -> None:
    """Create or adopt each log group with the key and the retention of D16."""
    for name in names:
        try:
            try:
                logs.create_log_group(logGroupName=name, kmsKeyId=key_arn, tags=dict(tags))
            except ClientError as exc:
                if error_code(exc) != "ResourceAlreadyExistsException":
                    raise
                logs.associate_kms_key(logGroupName=name, kmsKeyId=key_arn)
            logs.put_retention_policy(logGroupName=name, retentionInDays=RUNTIME_LOG_RETENTION_DAYS)
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("RuntimeLogGroup", exc) from None


def delete_log_groups(logs: CloudWatchLogsClient, names: Iterable[str]) -> None:
    for name in names:
        try:
            logs.delete_log_group(logGroupName=name)
        except ClientError as exc:
            if error_code(exc) != "ResourceNotFoundException":
                raise aws_error("DeleteLogGroup", exc) from None
        except BotoCoreError as exc:
            raise aws_error("DeleteLogGroup", exc) from None


class RuntimeLogs:
    def __init__(self, logs: CloudWatchLogsClient, settings: Settings) -> None:
        self._logs = logs
        self._settings = settings

    def govern(self, agent_id: str, runtime_id: str) -> None:
        settings = self._settings
        govern_log_groups(
            self._logs,
            settings.log_group_names(runtime_id),
            settings.runtime_logs_key_arn,
            settings.tags(agent_id),
        )

    def delete(self, runtime_id: str) -> None:
        """Remove the log groups of a harness that was never published."""
        delete_log_groups(self._logs, self._settings.log_group_names(runtime_id))
