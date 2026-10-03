"""What the pack provisioner reads and writes in the Settings table.

It reads the enablement mango-api approved and writes only installation state: its lock,
``approved`` -> ``installing`` -> ``enabled`` | ``failed``, ``disabling`` -> ``disabled`` and
the ``MCP_INSTALLED#`` pointer, through the builders of ``mango_packs.enablement``. Its IAM
policy limits it to those partitions and attributes.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_packs.enablement import (
    ENABLEMENT_ID_PATTERN,
    PackStatus,
    begin_item,
    disabled_items,
    enabled_items,
    enablement_key,
    fail_item,
    installed_key,
    unlock_item,
)
from mango_packs.manifest import DataTier, IdentityChain, IdentityMode
from mango_provisioner.errors import BusyError, RetryableError, StepError, aws_error, error_code

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

LOCK_TTL = timedelta(minutes=45)
"""Longer than the state machine timeout, so a live execution never loses its lock."""
_CONDITION_FAILED = "ConditionalCheckFailedException"
_TRANSACTION_CANCELED = "TransactionCanceledException"
_ENABLEMENT_ID_RE = re.compile(ENABLEMENT_ID_PATTERN)
_MAX_CONFIG_KEYS = 20
_MAX_ACTOR_CHARS = 256


@dataclass(frozen=True)
class Enablement:
    status: PackStatus
    enablement_id: str
    pack_version: str
    config: dict[str, str]
    """Parameters as requested; they are checked against the signed manifest before use."""
    requested_by: str | None
    approved_by: str | None
    lock_owner: str | None


@dataclass(frozen=True)
class Installed:
    """The ``MCP_INSTALLED#<pack>`` pointer: what this provisioner installed last."""

    enablement_id: str
    pack_version: str
    statement_sha256: str
    artifact_version_id: str
    runtime_id: str
    runtime_version: str
    target_id: str
    tools: tuple[str, ...]
    grants: Any
    """IAM statements of the installed manifest (``role.grants_to_json``)."""
    config: dict[str, str]
    data_tier: str = "public"
    identity_mode: str = "service"
    """How identity reaches the data in the installed version: it decides who may be given
    its tools (mango-api), its Cedar policies and whether its role acts through the broker.
    A pointer written before packs over account data existed is a public ``service`` pack."""

    identity_chain: str = "payer"
    """Broker chain of the installed version (``central_only`` packs): which broker its role
    may assume. A pointer written before the member chain existed is of the payer chain."""

    @property
    def central_only(self) -> bool:
        return self.identity_mode == "central_only"

    @property
    def member_chain(self) -> bool:
        return self.identity_chain == "member"

    def record(self) -> dict[str, Any]:
        # The chain is only written when it is not the default: pointers of the payer chain
        # keep the attributes they always had.
        chain = {"identity_chain": self.identity_chain} if self.member_chain else {}
        return {
            **chain,
            "enablement_id": self.enablement_id,
            "pack_version": self.pack_version,
            "statement_sha256": self.statement_sha256,
            "artifact_version_id": self.artifact_version_id,
            "runtime_id": self.runtime_id,
            "runtime_version": self.runtime_version,
            "target_id": self.target_id,
            "tools": list(self.tools),
            "grants": self.grants,
            "config": self.config,
            "data_tier": self.data_tier,
            "identity_mode": self.identity_mode,
        }


def _opt_s(item: dict[str, Any], name: str) -> str | None:
    value: str | None = item.get(name, {}).get("S")
    return value


def _actor(item: dict[str, Any], name: str) -> str | None:
    """Who asked or approved, as mango-api recorded it. It only goes to the audit event."""
    value = _opt_s(item, name)
    if value is not None and not 0 < len(value) <= _MAX_ACTOR_CHARS:
        raise ValueError("actor")
    return value


def _checked(pattern: re.Pattern[str], value: str) -> str:
    if not pattern.fullmatch(value):
        raise ValueError("unexpected format")
    return value


def _strings(raw: str) -> tuple[str, ...]:
    data = json.loads(raw)
    if not isinstance(data, list) or not all(isinstance(entry, str) for entry in data):
        raise ValueError("not a list of strings")
    return tuple(data)


def _config(raw: str | None) -> dict[str, str]:
    data = json.loads(raw) if raw else {}
    if (
        not isinstance(data, dict)
        or len(data) > _MAX_CONFIG_KEYS
        or not all(isinstance(k, str) and isinstance(v, str) for k, v in data.items())
    ):
        raise ValueError("config")
    return dict(data)


class PackStore:
    def __init__(self, dynamodb: DynamoDBClient, settings_table: str) -> None:
        self._db = dynamodb
        self._table = settings_table

    def _get(self, key: dict[str, Any]) -> dict[str, Any] | None:
        try:
            item = self._db.get_item(TableName=self._table, Key=key, ConsistentRead=True).get(
                "Item"
            )
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("GetItem", exc) from None
        return dict(item) if item else None

    def enablement(self, pack_id: str) -> Enablement | None:
        item = self._get(enablement_key(pack_id))
        if item is None:
            return None
        try:
            return Enablement(
                status=PackStatus(item["status"]["S"]),
                enablement_id=_checked(_ENABLEMENT_ID_RE, item["enablement_id"]["S"]),
                pack_version=item["pack_version"]["S"],
                config=_config(_opt_s(item, "config")),
                requested_by=_actor(item, "requested_by"),
                approved_by=_actor(item, "approved_by"),
                lock_owner=_opt_s(item, "provision_lock"),
            )
        except (KeyError, ValueError, TypeError):
            raise StepError("enablement_record_invalid") from None

    def installed(self, pack_id: str) -> Installed | None:
        """What is installed, from the partition only the provisioner can write."""
        item = self._get(installed_key(pack_id))
        if item is None:
            return None
        try:
            return Installed(
                enablement_id=item["enablement_id"]["S"],
                pack_version=item["pack_version"]["S"],
                statement_sha256=item["statement_sha256"]["S"],
                artifact_version_id=item["artifact_version_id"]["S"],
                runtime_id=item["runtime_id"]["S"],
                runtime_version=item["runtime_version"]["S"],
                target_id=item["target_id"]["S"],
                tools=_strings(item["tools"]["S"]),
                grants=json.loads(item["grants"]["S"]),
                config=_config(item["config"]["S"]),
                data_tier=DataTier(item.get("data_tier", {}).get("S", "public")).value,
                identity_mode=IdentityMode(item.get("identity_mode", {}).get("S", "service")).value,
                identity_chain=IdentityChain(
                    item.get("identity_chain", {}).get("S", "payer")
                ).value,
            )
        except (KeyError, ValueError, TypeError):
            raise StepError("installed_record_invalid") from None

    # --- Lock (one execution per pack, TM-M9) ---------------------------------------------

    def begin(
        self,
        *,
        pack_id: str,
        enablement_id: str,
        pack_version: str,
        owner: str,
        now: datetime,
        disable: bool,
    ) -> None:
        """Take the lock of the pack for ``owner`` (and mark it ``installing`` when enabling)."""
        try:
            self._db.update_item(
                **begin_item(
                    self._table,
                    pack_id=pack_id,
                    enablement_id=enablement_id,
                    pack_version=pack_version,
                    owner=owner,
                    now=now,
                    ttl=LOCK_TTL,
                    disable=disable,
                )
            )
        except ClientError as exc:
            if error_code(exc) == _CONDITION_FAILED:
                raise BusyError from None
            raise aws_error("UpdateItem", exc) from None
        except BotoCoreError as exc:
            raise aws_error("UpdateItem", exc) from None

    def release_lock(self, pack_id: str, owner: str) -> None:
        try:
            self._db.update_item(**unlock_item(self._table, pack_id=pack_id, owner=owner))
        except ClientError as exc:
            if error_code(exc) != _CONDITION_FAILED:
                raise aws_error("UpdateItem", exc) from None
        except BotoCoreError as exc:
            raise aws_error("UpdateItem", exc) from None

    # --- Transitions ----------------------------------------------------------------------

    def _transact(self, items: Any) -> None:
        try:
            self._db.transact_write_items(TransactItems=items)
        except ClientError as exc:
            if error_code(exc) == _TRANSACTION_CANCELED:
                reasons = {str(r.get("Code")) for r in exc.response.get("CancellationReasons", [])}
                if reasons <= {"None", "ConditionalCheckFailed"}:
                    # Changed by someone else meanwhile: nothing was written.
                    raise StepError("state_conflict") from None
                raise RetryableError("state_contention") from None
            raise aws_error("TransactWriteItems", exc) from None
        except BotoCoreError as exc:
            raise aws_error("TransactWriteItems", exc) from None

    def enabled(
        self, *, pack_id: str, enablement_id: str, owner: str, installed: Installed, now: datetime
    ) -> None:
        self._transact(
            enabled_items(
                self._table,
                pack_id=pack_id,
                enablement_id=enablement_id,
                owner=owner,
                installed=installed.record(),
                now=now,
            )
        )

    def disabled(self, *, pack_id: str, enablement_id: str, owner: str, now: datetime) -> None:
        self._transact(
            disabled_items(
                self._table, pack_id=pack_id, enablement_id=enablement_id, owner=owner, now=now
            )
        )

    def fail(
        self,
        *,
        pack_id: str,
        owner: str,
        failed_step: str,
        failure: str,
        now: datetime,
        disable: bool,
    ) -> bool:
        """Record the failure. False if the item is no longer in the state being worked on."""
        try:
            self._db.update_item(
                **fail_item(
                    self._table,
                    pack_id=pack_id,
                    owner=owner,
                    failed_step=failed_step,
                    failure=failure,
                    now=now,
                    disable=disable,
                )
            )
        except ClientError as exc:
            if error_code(exc) == _CONDITION_FAILED:
                return False
            raise aws_error("UpdateItem", exc) from None
        except BotoCoreError as exc:
            raise aws_error("UpdateItem", exc) from None
        return True
