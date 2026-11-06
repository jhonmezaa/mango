"""Runtime log groups of an agent harness (D16): customer-managed key and bounded retention.

AgentCore names a log group per runtime endpoint after the generated runtime id and creates
it on its own, unencrypted and without retention, as soon as the endpoint exists. The
provisioner therefore creates-or-adopts them before the agent is published, when nothing has
been invoked yet. The runtimes of MCP packs get the same treatment.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from typing import TYPE_CHECKING

from botocore.exceptions import BotoCoreError, ClientError

from mango_provisioner.config import RUNTIME_LOG_RETENTION_DAYS, Settings
from mango_provisioner.errors import aws_error, error_code

if TYPE_CHECKING:
    from mypy_boto3_logs import CloudWatchLogsClient


def govern_log_groups(
    logs: CloudWatchLogsClient,
    names: Iterable[str],
    key_arn: str,
    tags: Mapping[str, str],
    arn_of: Callable[[str], str],
    *,
    rebind: bool = False,
) -> None:
    """Create or adopt each log group with the key and the retention of D16, and the tags.

    A log group AgentCore created first is adopted: it gets the key, the retention and the
    same tags as one created here, the stack's included (D76).

    ``rebind`` (only the evals harness, D110 (9)): an adopted log group gets its key taken off
    and associated again, while no eval may run. It was the first explanation of a harness that
    delivered no span; that the key caused it is not proven (2026-11-06: every turn without
    spans ran seconds after a release rewrote the harness's role), and it is kept because it
    is harmless then.

    Otherwise an adopted log group that already has this key, or this retention, is not
    written again. Turns of the evals harness seconds after the release rewrote, unchanged, its
    role and its log groups' settings got no span at all (2026-11-06, D110 (9)); a write that
    changes nothing is left out.
    """
    for name in names:
        try:
            try:
                logs.create_log_group(logGroupName=name, kmsKeyId=key_arn, tags=dict(tags))
            except ClientError as exc:
                if error_code(exc) != "ResourceAlreadyExistsException":
                    raise
                current = _group(logs, name)
                if rebind:
                    logs.disassociate_kms_key(logGroupName=name)
                    logs.associate_kms_key(logGroupName=name, kmsKeyId=key_arn)
                elif current.get("kmsKeyId") != key_arn:
                    logs.associate_kms_key(logGroupName=name, kmsKeyId=key_arn)
                logs.tag_resource(resourceArn=arn_of(name), tags=dict(tags))
                if current.get("retentionInDays") == RUNTIME_LOG_RETENTION_DAYS:
                    continue
            logs.put_retention_policy(logGroupName=name, retentionInDays=RUNTIME_LOG_RETENTION_DAYS)
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("RuntimeLogGroup", exc) from None


def _group(logs: CloudWatchLogsClient, name: str) -> Mapping[str, object]:
    """The log group as it is now (its key and retention), or nothing if it is not listed."""
    groups = logs.describe_log_groups(logGroupNamePrefix=name)["logGroups"]
    return next((dict(g) for g in groups if g.get("logGroupName") == name), {})


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

    def govern(
        self, agent_id: str, runtime_id: str, key_arn: str | None = None, *, rebind: bool = False
    ) -> None:
        """``key_arn``: the evals harness has a key of its own (D110 (3)); the others share the
        runtime logs key. ``rebind``: see :func:`govern_log_groups`."""
        settings = self._settings
        govern_log_groups(
            self._logs,
            settings.log_group_names(runtime_id),
            key_arn or settings.runtime_logs_key_arn,
            settings.tags(agent_id),
            settings.log_group_arn,
            rebind=rebind,
        )

    def delete(self, runtime_id: str) -> None:
        """Remove the log groups of a harness that was never published."""
        delete_log_groups(self._logs, self._settings.log_group_names(runtime_id))
