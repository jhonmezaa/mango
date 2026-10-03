"""What the deprovisioner reads and writes in the ``Agents`` table.

It reads the state of an agent, never its content: every read projects a fixed list of
attributes and its IAM policy allows only those (``dynamodb:Attributes``), so no definition
reaches this function. It writes only the provisioner lock, which it shares with the agent
provisioner: one execution per agent at a time (TM-M9). Layout: ``mango_core.agents_table``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_core.agents import AgentStatus, VersionStatus
from mango_core.agents_table import lock_item, meta_key, published_key, unlock_item, version_key
from mango_provisioner.errors import BusyError, StepError, aws_error, error_code
from mango_provisioner.store import LOCK_TTL

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

READ_ATTRIBUTES = ("PK", "SK", "status", "provision_lock", "n", "harness_arn")
"""Everything the deprovisioner reads. Keep in sync with ``DEPROVISIONER_READABLE_ATTRIBUTES``
in ``infra/lib/constructs/deprovisioner.ts``; never add ``definition``."""
_CONDITION_FAILED = "ConditionalCheckFailedException"


@dataclass(frozen=True)
class Meta:
    status: AgentStatus
    lock_owner: str | None


@dataclass(frozen=True)
class Pointer:
    """``PUBLISHED#<id>``: the version and the harness the provisioner deployed last."""

    version: int
    harness_arn: str


class DeprovisionStore:
    def __init__(self, dynamodb: DynamoDBClient, agents_table: str) -> None:
        self._db = dynamodb
        self._agents = agents_table

    def _get(self, key: dict[str, Any]) -> dict[str, Any] | None:
        names = {f"#a{i}": name for i, name in enumerate(READ_ATTRIBUTES)}
        try:
            item = self._db.get_item(
                TableName=self._agents,
                Key=key,
                ConsistentRead=True,
                ProjectionExpression=", ".join(names),
                ExpressionAttributeNames=names,
            ).get("Item")
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("GetItem", exc) from None
        return dict(item) if item else None

    def meta(self, agent_id: str) -> Meta | None:
        item = self._get(meta_key(agent_id))
        if item is None:
            return None
        try:
            return Meta(
                status=AgentStatus(item["status"]["S"]),
                lock_owner=item.get("provision_lock", {}).get("S"),
            )
        except (KeyError, ValueError):
            raise StepError("agent_record_invalid") from None

    def version_status(self, agent_id: str, number: int) -> VersionStatus | None:
        item = self._get(version_key(agent_id, number))
        if item is None:
            return None
        try:
            return VersionStatus(item["status"]["S"])
        except (KeyError, ValueError):
            raise StepError("version_record_invalid") from None

    def pointer(self, agent_id: str) -> Pointer | None:
        item = self._get(published_key(agent_id))
        if item is None:
            return None
        try:
            return Pointer(version=int(item["n"]["N"]), harness_arn=item["harness_arn"]["S"])
        except (KeyError, ValueError):
            raise StepError("published_record_invalid") from None

    # --- Lock (shared with the agent provisioner) -----------------------------------------

    def hold_lock(self, agent_id: str, owner: str, now: datetime) -> None:
        """Take the agent's lock for ``owner``, or extend it if ``owner`` already holds it."""
        try:
            self._db.update_item(
                **lock_item(self._agents, agent_id=agent_id, owner=owner, now=now, ttl=LOCK_TTL)
            )
        except ClientError as exc:
            if error_code(exc) == _CONDITION_FAILED:
                raise BusyError from None
            raise aws_error("UpdateItem", exc) from None
        except BotoCoreError as exc:
            raise aws_error("UpdateItem", exc) from None

    def release_lock(self, agent_id: str, owner: str) -> None:
        try:
            self._db.update_item(**unlock_item(self._agents, agent_id=agent_id, owner=owner))
        except ClientError as exc:
            if error_code(exc) != _CONDITION_FAILED:
                raise aws_error("UpdateItem", exc) from None
        except BotoCoreError as exc:
            raise aws_error("UpdateItem", exc) from None
