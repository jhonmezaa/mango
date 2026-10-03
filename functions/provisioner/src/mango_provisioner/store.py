"""What the provisioner reads and writes in DynamoDB.

It reads agent versions and the model catalog, and writes only publication state: the lock,
``approved`` -> ``published`` | ``failed`` and the harness references, through the builders of
``mango_core.agents_table``. Its IAM policy limits it to those attributes.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_core.agents import MODEL_ID_PATTERN, AgentStatus, VersionStatus
from mango_core.agents_table import (
    fail_item,
    lock_item,
    meta_key,
    publish_items,
    published_key,
    unlock_item,
    version_key,
)
from mango_packs.enablement import installed_key
from mango_provisioner.errors import (
    BusyError,
    RetryableError,
    StepError,
    aws_error,
    error_code,
)

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

LOCK_TTL = timedelta(minutes=30)
"""Longer than the state machine timeout, so a live execution never loses its lock."""
_CONDITION_FAILED = "ConditionalCheckFailedException"
_TRANSACTION_CANCELED = "TransactionCanceledException"
_MODEL_ID_RE = re.compile(MODEL_ID_PATTERN)


@dataclass(frozen=True)
class Meta:
    status: AgentStatus
    open_version: int | None
    published_version: int | None
    harness_arn: str | None
    harness_version: str | None
    lock_owner: str | None


@dataclass(frozen=True)
class Version:
    number: int
    status: VersionStatus
    content_hash: str | None
    canonical: str
    """Definition exactly as stored; the hash is verified against these bytes."""
    created_by: str
    approved_by: str | None


@dataclass(frozen=True)
class Published:
    """The ``PUBLISHED#<id>`` pointer: what this provisioner deployed last for an agent."""

    version: int
    content_hash: str
    harness_arn: str
    harness_version: str


def _opt_s(item: dict[str, Any], name: str) -> str | None:
    value: str | None = item.get(name, {}).get("S")
    return value


def _opt_n(item: dict[str, Any], name: str) -> int | None:
    value = item.get(name, {}).get("N")
    return int(value) if value is not None else None


class ProvisionerStore:
    def __init__(self, dynamodb: DynamoDBClient, agents_table: str, settings_table: str) -> None:
        self._db = dynamodb
        self._agents = agents_table
        self._settings = settings_table

    def _get(self, table: str, key: dict[str, Any]) -> dict[str, Any] | None:
        try:
            item = self._db.get_item(TableName=table, Key=key, ConsistentRead=True).get("Item")
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("GetItem", exc) from None
        return dict(item) if item else None

    def meta(self, agent_id: str) -> Meta | None:
        item = self._get(self._agents, meta_key(agent_id))
        if item is None:
            return None
        try:
            return Meta(
                status=AgentStatus(item["status"]["S"]),
                open_version=_opt_n(item, "open_version"),
                published_version=_opt_n(item, "published_version"),
                harness_arn=_opt_s(item, "harness_arn"),
                harness_version=_opt_s(item, "harness_version"),
                lock_owner=_opt_s(item, "provision_lock"),
            )
        except (KeyError, ValueError):
            raise StepError("agent_record_invalid") from None

    def version(self, agent_id: str, number: int) -> Version | None:
        item = self._get(self._agents, version_key(agent_id, number))
        if item is None:
            return None
        try:
            return Version(
                number=number,
                status=VersionStatus(item["status"]["S"]),
                content_hash=_opt_s(item, "content_hash"),
                canonical=item["definition"]["S"],
                created_by=item["created_by"]["S"],
                approved_by=_opt_s(item, "approved_by"),
            )
        except (KeyError, ValueError):
            raise StepError("version_record_invalid") from None

    def published(self, agent_id: str) -> Published | None:
        """What is live, from the partition only the provisioner can write.

        Compensation and updates decide from this, not from ``META``: nothing mango-api can
        write makes the provisioner delete or repoint the resources of a published agent.
        """
        item = self._get(self._agents, published_key(agent_id))
        if item is None:
            return None
        try:
            return Published(
                version=int(item["n"]["N"]),
                content_hash=item["content_hash"]["S"],
                harness_arn=item["harness_arn"]["S"],
                harness_version=item["harness_version"]["S"],
            )
        except (KeyError, ValueError):
            raise StepError("published_record_invalid") from None

    def enabled_models(self) -> frozenset[str]:
        """Ids of the models enabled in the installation catalog. Fails closed."""
        item = self._get(self._settings, {"PK": {"S": "MODELS"}, "SK": {"S": "CATALOG"}})
        if item is None:
            raise StepError("model_catalog_unavailable")
        try:
            models = json.loads(item["models"]["S"])
            enabled = frozenset(
                m["id"]
                for m in models
                if m["enabled"] is True
                and isinstance(m["id"], str)
                and _MODEL_ID_RE.fullmatch(m["id"])
            )
        except (KeyError, TypeError, ValueError):
            raise StepError("model_catalog_unavailable") from None
        return enabled

    def installed_pack_tools(self, pack_id: str) -> frozenset[str] | None:
        """Tools of an installed MCP pack, from the pointer only the pack provisioner writes
        (``MCP_INSTALLED#<pack>``); ``None`` if the pack is not installed. Fails closed."""
        item = self._get(self._settings, installed_key(pack_id))
        if item is None:
            return None
        try:
            tools = json.loads(item["tools"]["S"])
        except (KeyError, TypeError, ValueError):
            raise StepError("installed_pack_invalid") from None
        if not isinstance(tools, list) or not all(isinstance(t, str) for t in tools):
            raise StepError("installed_pack_invalid")
        return frozenset(tools)

    # --- Lock (one execution per agent, TM-M9) --------------------------------------------

    def acquire_lock(self, agent_id: str, owner: str, now: datetime) -> None:
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

    # --- Transitions ----------------------------------------------------------------------

    def publish(
        self,
        *,
        agent_id: str,
        version: int,
        content_hash: str,
        previous_version: int | None,
        harness_arn: str,
        harness_version: str,
        now: datetime,
    ) -> None:
        items: Any = publish_items(
            self._agents,
            agent_id=agent_id,
            version=version,
            content_hash=content_hash,
            previous_version=previous_version,
            harness_arn=harness_arn,
            harness_version=harness_version,
            now=now,
        )
        try:
            self._db.transact_write_items(TransactItems=items)
        except ClientError as exc:
            if error_code(exc) == _TRANSACTION_CANCELED:
                reasons = {str(r.get("Code")) for r in exc.response.get("CancellationReasons", [])}
                if reasons <= {"None", "ConditionalCheckFailed"}:
                    # Retired, edited or republished meanwhile: nothing was written.
                    raise StepError("publish_conflict") from None
                raise RetryableError("publish_contention") from None
            raise aws_error("TransactWriteItems", exc) from None
        except BotoCoreError as exc:
            raise aws_error("TransactWriteItems", exc) from None

    def fail(
        self, *, agent_id: str, version: int, failed_step: str, failure: str, now: datetime
    ) -> bool:
        """Mark an approved version as failed. False if it is no longer ``approved``."""
        try:
            self._db.update_item(
                **fail_item(
                    self._agents,
                    agent_id=agent_id,
                    version=version,
                    failed_step=failed_step,
                    failure=failure,
                    now=now,
                )
            )
        except ClientError as exc:
            if error_code(exc) == _CONDITION_FAILED:
                return False
            raise aws_error("UpdateItem", exc) from None
        except BotoCoreError as exc:
            raise aws_error("UpdateItem", exc) from None
        return True
