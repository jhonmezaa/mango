"""Approvals table repository (D27): one item per write tool call that asked for confirmation.

Item layout (``PK`` = ``APPROVAL#<id>``, ``SK`` = ``META``):

* What was asked: ``tool`` (``<server>.<tool>``), ``gateway_tool``, ``arguments`` (canonical
  JSON, exactly what will run) and ``args_hash`` (what the approval token is bound to).
* Who and where: ``requested_by``, ``agent_id``, ``agent_version``, ``conversation_id``.
* The tier it was born with: ``tier``, ``tier_reason``, ``rule`` (the policy then),
  ``approvals_needed``. A later policy change never lowers it (TM-W6).
* Progress: ``status``, ``signers`` (string set), ``signatures`` (JSON, for display),
  ``decided_*``, ``note``, ``error``.
* Single-use marks: ``gateway_used_at`` is set by the Gateway interceptor and
  ``executor_used_at`` by the approval executor, each with its own condition (TM-W3).
  mango-api never writes them.

Indexes: ``ByState`` (``state_pk`` = ``approvers#open`` or ``approvers#closed``; only requests
that need approvers, for the inbox) and ``ByRequester`` (``requester_pk`` = ``USER#<sub>``).

Every transition is a conditional update: the condition, not the code before it, is what
keeps a request from being signed twice, signed by who asked, or decided after it expired.
"""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from botocore.exceptions import ClientError

from mango_api.approval_policy import Tier, TierReason

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

INDEX_BY_STATE = "ByState"
INDEX_BY_REQUESTER = "ByRequester"
"""Keep in sync with ``infra/lib/constructs/write-tools.ts``."""
SK_META = "META"
RETENTION = timedelta(days=90)  # table TTL; the audit trail keeps the evidence
STATE_OPEN = "approvers#open"
STATE_CLOSED = "approvers#closed"
MAX_LIST = 100
_PAGE = 100


class Status(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    """Confirmed or fully signed; not run yet."""
    EXECUTING = "executing"
    EXECUTED = "executed"
    FAILED = "failed"
    REJECTED = "rejected"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


OPEN_STATUSES = frozenset({Status.PENDING, Status.APPROVED})
"""Statuses that still wait for someone, and so can expire."""


class ApprovalConflictError(Exception):
    """The request is no longer in the state the caller read (or a condition refused it)."""


@dataclass(frozen=True)
class Signature:
    user_id: str
    email: str | None
    at: str
    note: str | None = None


@dataclass(frozen=True)
class ApprovalRecord:
    approval_id: str
    status: Status
    tier: Tier
    tier_reason: TierReason
    tool: str
    gateway_tool: str
    arguments: str
    """Canonical JSON of the arguments: what was shown is what runs."""
    args_hash: str
    agent_id: str
    agent_version: int
    conversation_id: str
    requested_by: str
    requested_by_email: str | None
    created_at: datetime
    expires_at: datetime
    approvals_needed: int
    rule: dict[str, Any]
    signatures: tuple[Signature, ...] = ()
    decided_by: str | None = None
    decided_by_email: str | None = None
    decided_at: datetime | None = None
    executed_at: datetime | None = None
    """When the call ended (ran or failed); absent until then."""
    note: str | None = None
    error: str | None = None
    gateway_used: bool = False
    notified: bool = False
    """The agent was told the outcome on a later turn."""
    signers: frozenset[str] = field(default_factory=frozenset)

    def expired(self, now: datetime) -> bool:
        return self.status in OPEN_STATUSES and now >= self.expires_at


def new_approval_id() -> str:
    """Random public id (never incremental)."""
    return secrets.token_hex(16)


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds")


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: int) -> dict[str, str]:
    return {"N": str(value)}


def _opt(item: dict[str, Any], key: str) -> str | None:
    value = item.get(key, {}).get("S")
    return str(value) if value else None


def _key(approval_id: str) -> dict[str, Any]:
    return {"PK": _s(f"APPROVAL#{approval_id}"), "SK": _s(SK_META)}


def _sort(record: ApprovalRecord) -> str:
    return f"{iso(record.created_at)}#{record.approval_id}"


def _signatures_json(signatures: tuple[Signature, ...]) -> str:
    return json.dumps(
        [{"user_id": s.user_id, "email": s.email, "at": s.at, "note": s.note} for s in signatures],
        separators=(",", ":"),
    )


def _parse(item: dict[str, Any]) -> ApprovalRecord:
    decided_at = _opt(item, "decided_at")
    executed_at = _opt(item, "executed_at")
    raw_signatures = json.loads(item.get("signatures", {}).get("S", "[]"))
    return ApprovalRecord(
        approval_id=item["PK"]["S"].removeprefix("APPROVAL#"),
        status=Status(item["status"]["S"]),
        tier=Tier(item["tier"]["S"]),
        tier_reason=TierReason(item["tier_reason"]["S"]),
        tool=item["tool"]["S"],
        gateway_tool=item["gateway_tool"]["S"],
        arguments=item["arguments"]["S"],
        args_hash=item["args_hash"]["S"],
        agent_id=item["agent_id"]["S"],
        agent_version=int(item["agent_version"]["N"]),
        conversation_id=item["conversation_id"]["S"],
        requested_by=item["requested_by"]["S"],
        requested_by_email=_opt(item, "requested_by_email"),
        created_at=datetime.fromisoformat(item["created_at"]["S"]),
        expires_at=datetime.fromisoformat(item["expires_at"]["S"]),
        approvals_needed=int(item["approvals_needed"]["N"]),
        rule=json.loads(item["rule"]["S"]),
        signatures=tuple(
            Signature(
                user_id=str(s["user_id"]), email=s.get("email"), at=str(s["at"]), note=s.get("note")
            )
            for s in raw_signatures
        ),
        decided_by=_opt(item, "decided_by"),
        decided_by_email=_opt(item, "decided_by_email"),
        decided_at=datetime.fromisoformat(decided_at) if decided_at else None,
        executed_at=datetime.fromisoformat(executed_at) if executed_at else None,
        note=_opt(item, "note"),
        error=_opt(item, "error"),
        gateway_used="gateway_used_at" in item,
        notified=bool(item.get("notified", {}).get("BOOL", False)),
        signers=frozenset(item.get("signers", {}).get("SS", [])),
    )


def _conflict(exc: ClientError) -> None:
    if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
        raise ApprovalConflictError from exc
    raise exc


class ApprovalStore:
    def __init__(self, dynamodb: DynamoDBClient, table: str) -> None:
        self._db = dynamodb
        self._table = table

    # --- Reads ----------------------------------------------------------------------------

    def get(self, approval_id: str) -> ApprovalRecord | None:
        item = self._db.get_item(
            TableName=self._table, Key=_key(approval_id), ConsistentRead=True
        ).get("Item")
        return _parse(item) if item else None

    def _query(self, index: str, name: str, value: str, limit: int) -> list[ApprovalRecord]:
        out: list[ApprovalRecord] = []
        kwargs: dict[str, Any] = {
            "TableName": self._table,
            "IndexName": index,
            "KeyConditionExpression": "#pk = :pk",
            "ExpressionAttributeNames": {"#pk": name},
            "ExpressionAttributeValues": {":pk": _s(value)},
            "ScanIndexForward": False,
            "Limit": _PAGE,
        }
        while len(out) < limit:
            resp = self._db.query(**kwargs)
            out.extend(_parse(item) for item in resp.get("Items", []))
            if "LastEvaluatedKey" not in resp:
                break
            kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
        return out[:limit]

    def inbox(self, *, open_: bool, limit: int = MAX_LIST) -> list[ApprovalRecord]:
        """Requests that need approvers, newest first: waiting, or already closed."""
        state = STATE_OPEN if open_ else STATE_CLOSED
        return self._query(INDEX_BY_STATE, "state_pk", state, limit)

    def by_requester(self, user_id: str, limit: int = MAX_LIST) -> list[ApprovalRecord]:
        """Everything one person asked for, newest first (both tiers)."""
        return self._query(INDEX_BY_REQUESTER, "requester_pk", f"USER#{user_id}", limit)

    # --- Writes ---------------------------------------------------------------------------

    def create(self, record: ApprovalRecord, now: datetime) -> None:
        item: dict[str, Any] = {
            **_key(record.approval_id),
            "status": _s(record.status.value),
            "tier": _s(record.tier.value),
            "tier_reason": _s(record.tier_reason.value),
            "tool": _s(record.tool),
            "gateway_tool": _s(record.gateway_tool),
            "arguments": _s(record.arguments),
            "args_hash": _s(record.args_hash),
            "agent_id": _s(record.agent_id),
            "agent_version": _n(record.agent_version),
            "conversation_id": _s(record.conversation_id),
            "requested_by": _s(record.requested_by),
            "created_at": _s(iso(record.created_at)),
            "expires_at": _s(iso(record.expires_at)),
            "expires_epoch": _n(int(record.expires_at.timestamp())),
            "approvals_needed": _n(record.approvals_needed),
            "rule": _s(json.dumps(record.rule, separators=(",", ":"), sort_keys=True)),
            "requester_pk": _s(f"USER#{record.requested_by}"),
            "sort": _s(_sort(record)),
            "ttl": _n(int((now + RETENTION).timestamp())),
        }
        if record.requested_by_email:
            item["requested_by_email"] = _s(record.requested_by_email)
        if record.tier is Tier.APPROVERS:
            item["state_pk"] = _s(STATE_OPEN)
        try:
            self._db.put_item(
                TableName=self._table, Item=item, ConditionExpression="attribute_not_exists(PK)"
            )
        except ClientError as exc:
            _conflict(exc)

    def _update(
        self,
        approval_id: str,
        *,
        sets: dict[str, Any],
        condition: str,
        values: dict[str, Any],
        add: str = "",
        remove: str = "",
    ) -> None:
        names = {f"#{name}": name for name in sets} | {"#status": "status"}
        expression = "SET " + ", ".join(f"#{name} = :set_{name}" for name in sets)
        if add:
            expression += f" ADD {add}"
        if remove:
            expression += f" REMOVE {remove}"
        try:
            self._db.update_item(
                TableName=self._table,
                Key=_key(approval_id),
                UpdateExpression=expression,
                ConditionExpression=condition,
                ExpressionAttributeNames=names,
                ExpressionAttributeValues={
                    **{f":set_{name}": value for name, value in sets.items()},
                    **values,
                },
            )
        except ClientError as exc:
            _conflict(exc)

    def confirm(self, record: ApprovalRecord, *, now: datetime) -> None:
        """The person who asked confirms a call of the ``self`` tier."""
        self._update(
            record.approval_id,
            sets={
                "status": _s(Status.APPROVED.value),
                "decided_by": _s(record.requested_by),
                "decided_at": _s(iso(now)),
                **(
                    {"decided_by_email": _s(record.requested_by_email)}
                    if record.requested_by_email
                    else {}
                ),
            },
            condition=(
                "#status = :pending AND tier = :self AND requested_by = :by "
                "AND expires_epoch > :now"
            ),
            values={
                ":pending": _s(Status.PENDING.value),
                ":self": _s(Tier.SELF.value),
                ":by": _s(record.requested_by),
                ":now": _n(int(now.timestamp())),
            },
        )

    def sign(self, record: ApprovalRecord, signature: Signature, *, now: datetime) -> bool:
        """Add one approver's signature; returns whether the request is now fully approved.

        The condition repeats the separation of duties where it cannot be skipped (TM-W5):
        never the person who asked, never the same person twice, never after it expired, and
        only on top of the signatures the caller saw.
        """
        signatures = (*record.signatures, signature)
        complete = len(signatures) >= record.approvals_needed
        sets: dict[str, Any] = {"signatures": _s(_signatures_json(signatures))}
        if complete:
            sets |= {
                "status": _s(Status.APPROVED.value),
                "state_pk": _s(STATE_CLOSED),
                "decided_by": _s(signature.user_id),
                "decided_at": _s(iso(now)),
            }
            if signature.email:
                sets["decided_by_email"] = _s(signature.email)
        seen = "attribute_not_exists(signers)" if not record.signers else "size(signers) = :seen"
        values: dict[str, Any] = {
            ":pending": _s(Status.PENDING.value),
            ":approvers": _s(Tier.APPROVERS.value),
            ":by": _s(signature.user_id),
            ":signer": {"SS": [signature.user_id]},
            ":now": _n(int(now.timestamp())),
        }
        if record.signers:
            values[":seen"] = _n(len(record.signers))
        self._update(
            record.approval_id,
            sets=sets,
            add="signers :signer",
            condition=(
                "#status = :pending AND tier = :approvers AND requested_by <> :by "
                f"AND (attribute_not_exists(signers) OR NOT contains(signers, :by)) AND {seen} "
                "AND expires_epoch > :now"
            ),
            values=values,
        )
        return complete

    def close(
        self,
        record: ApprovalRecord,
        *,
        to: Status,
        actor: str | None,
        actor_email: str | None,
        note: str | None,
        now: datetime,
    ) -> None:
        """Reject, cancel or expire a request that still waits (``pending`` or ``approved``)."""
        sets: dict[str, Any] = {"status": _s(to.value), "decided_at": _s(iso(now))}
        if record.tier is Tier.APPROVERS:
            sets["state_pk"] = _s(STATE_CLOSED)
        if actor:
            sets["decided_by"] = _s(actor)
        if actor_email:
            sets["decided_by_email"] = _s(actor_email)
        if note:
            sets["note"] = _s(note)
        self._update(
            record.approval_id,
            sets=sets,
            condition="#status = :expected",
            values={":expected": _s(record.status.value)},
        )

    def begin_execution(self, record: ApprovalRecord, *, now: datetime) -> None:
        """Take the approved request to run it: of two attempts only one gets it."""
        self._update(
            record.approval_id,
            sets={"status": _s(Status.EXECUTING.value), "execution_started_at": _s(iso(now))},
            condition=(
                "#status = :approved AND requested_by = :by AND expires_epoch > :now "
                "AND attribute_not_exists(gateway_used_at)"
            ),
            values={
                ":approved": _s(Status.APPROVED.value),
                ":by": _s(record.requested_by),
                ":now": _n(int(now.timestamp())),
            },
        )

    def finish(self, approval_id: str, *, ok: bool, error: str | None, now: datetime) -> None:
        sets: dict[str, Any] = {
            "status": _s((Status.EXECUTED if ok else Status.FAILED).value),
            "executed_at": _s(iso(now)),
        }
        if error:
            sets["error"] = _s(error)
        self._update(
            approval_id,
            sets=sets,
            condition="#status = :executing",
            values={":executing": _s(Status.EXECUTING.value)},
        )

    def release(self, approval_id: str, *, error: str) -> bool:
        """Give back a request whose call never reached the tool, so it can be run again.

        Only while the Gateway has not used the approval: once its mark exists the call may
        have run, and the request is not released (returns ``False``).
        """
        try:
            self._update(
                approval_id,
                sets={"status": _s(Status.APPROVED.value), "error": _s(error)},
                condition="#status = :executing AND attribute_not_exists(gateway_used_at)",
                values={":executing": _s(Status.EXECUTING.value)},
                remove="execution_started_at",
            )
        except ApprovalConflictError:
            return False
        return True

    def mark_notified(self, approval_id: str) -> None:
        self._db.update_item(
            TableName=self._table,
            Key=_key(approval_id),
            UpdateExpression="SET notified = :yes",
            ConditionExpression="attribute_exists(PK)",
            ExpressionAttributeValues={":yes": {"BOOL": True}},
        )
