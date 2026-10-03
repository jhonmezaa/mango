"""Approval policy of each write tool, changed with dual approval (D27; threat model
``write-tools-approval-threat-model.md`` TM-W4, TM-W6).

Every write tool of the release has a policy: when a call needs other people (always, above
an amount, above a number of resources, in one environment), how many approvers (1 to 3) and
how long a request waits. A tool nobody configured uses the default: always, one approver,
24 hours. An administrator proposes a change and a **different** administrator approves it.

Security notes (security-best-practices, FastAPI):
* Every route declares its Cedar action (``ViewApprovals``, ``ProposeToolPolicy``,
  ``ApproveToolPolicy``); the decision is audited and ``is_admin`` is re-checked in process.
* Whoever proposes does not approve nor reject their own proposal; they withdraw it. The
  store enforces it again in the condition of the transaction.
* A policy may only use a threshold the tool declares a value for (release data).
* Fail-closed audit: ``requested`` is recorded before any write.
* Bodies forbid extra fields and responses use explicit models (VALID-001, RESP-001).
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import json
import logging
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, Annotated, Any, Literal

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, ConfigDict, Field

from mango_api.approval_policy import (
    DEFAULT_POLICY,
    MAX_APPROVERS,
    MIN_APPROVERS,
    Condition,
    Policy,
    TierInputs,
)
from mango_api.audit import AuditLog
from mango_api.mcp_catalog import CatalogTool, InvalidCatalogError, McpCatalog
from mango_api.probe import RateLimiter
from mango_api.web import ApiError, Caller, rate_limited

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
PK_POLICY = "TOOL_POLICY"
PK_CHANGE = "TOOL_POLICY_CHANGE"
PK_PENDING = "TOOL_POLICY_PENDING"
CHANGE_LIFETIME = timedelta(days=7)
CHANGE_RETENTION = timedelta(days=90)  # table TTL; the audit trail keeps the evidence
LIST_WINDOW = timedelta(days=30)
PROPOSALS_PER_HOUR = 10
MAX_PAGES = 20
CHANGE_ID_PATTERN = r"^[0-9a-f]{32}$"
TOOL_REF_PATTERN = r"^[a-z0-9][a-z0-9-]{0,47}\.[A-Za-z0-9_-]{1,64}$"
_USD_PATTERN = r"^\d{1,9}(\.\d{1,2})?$"

Status = Literal["pending", "approved", "rejected", "withdrawn"]


class PolicyConflictError(Exception):
    """The policy or the change moved since it was read (optimistic locking)."""


class PolicyUnavailableError(Exception):
    """Policies could not be read; callers use the default, which asks for approvers."""


# --- Repository -------------------------------------------------------------------------


@dataclass(frozen=True)
class PolicyChange:
    change_id: str
    tool: str
    status: Status
    before: Policy
    after: Policy
    reason: str
    proposed_by: str
    proposed_by_email: str | None
    created_at: datetime
    expires_at: datetime
    decided_by: str | None = None
    decided_by_email: str | None = None
    decided_at: datetime | None = None
    note: str | None = None


def new_change_id() -> str:
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


def policy_from_rule(rule: object, version: int = 0) -> Policy:
    """A stored rule as a policy. Raises ``ValueError`` for anything this code did not write:
    a policy that cannot be read is never guessed."""
    if not isinstance(rule, dict):
        raise ValueError("invalid policy")  # noqa: TRY004 - one error type for the caller
    amount = rule.get("amount_usd")
    count = rule.get("count")
    environment = rule.get("environment")
    approvers = rule.get("approvers")
    expires = rule.get("expires_hours")
    if isinstance(approvers, bool) or not isinstance(approvers, int):
        raise ValueError("invalid policy")  # noqa: TRY004
    if isinstance(expires, bool) or not isinstance(expires, int):
        raise ValueError("invalid policy")  # noqa: TRY004
    if count is not None and (isinstance(count, bool) or not isinstance(count, int)):
        raise ValueError("invalid policy")
    if environment is not None and not isinstance(environment, str):
        raise ValueError("invalid policy")
    try:
        return Policy(
            condition=Condition(str(rule.get("condition"))),
            amount_usd=Decimal(amount) if isinstance(amount, str) else None,
            count=count,
            environment=environment,
            approvers=approvers,
            expires_hours=expires,
            version=version,
        )
    except InvalidOperation as exc:
        raise ValueError("invalid policy") from exc


def _rule_json(policy: Policy) -> str:
    return json.dumps(policy.rule(), separators=(",", ":"), sort_keys=True)


def _conflict(exc: ClientError) -> None:
    code = exc.response.get("Error", {}).get("Code")
    if code in {"ConditionalCheckFailedException", "TransactionCanceledException"}:
        raise PolicyConflictError from exc
    raise exc


class PolicyStore:
    """Items in the Settings table (only mango-api writes it, TM-A6):

    * ``TOOL_POLICY`` / ``<server>.<tool>``: ``rule`` (JSON) and ``version``.
    * ``TOOL_POLICY_CHANGE`` / ``<change_id>``: a proposal and its decision.
    * ``TOOL_POLICY_PENDING`` / ``<server>.<tool>``: the open proposal of a tool and its
      expiry, so there is one at a time without a ``Scan``.
    """

    def __init__(self, dynamodb: "DynamoDBClient", table: str) -> None:
        self._db = dynamodb
        self._table = table

    def policy(self, tool: str) -> Policy:
        """The stored policy of ``tool``, or the default if it was never set."""
        try:
            item = self._db.get_item(
                TableName=self._table,
                Key={"PK": _s(PK_POLICY), "SK": _s(tool)},
                ConsistentRead=True,
            ).get("Item")
            if item is None:
                return DEFAULT_POLICY
            return policy_from_rule(json.loads(item["rule"]["S"]), int(item["version"]["N"]))
        except (ClientError, BotoCoreError, KeyError, ValueError) as exc:
            raise PolicyUnavailableError from exc

    @staticmethod
    def _parse(item: dict[str, Any]) -> PolicyChange:
        decided_at = _opt(item, "decided_at")
        base = int(item["base_version"]["N"])
        return PolicyChange(
            change_id=item["SK"]["S"],
            tool=item["tool"]["S"],
            status=item["status"]["S"],
            before=policy_from_rule(json.loads(item["before"]["S"]), base),
            after=policy_from_rule(json.loads(item["after"]["S"]), base),
            reason=item["reason"]["S"],
            proposed_by=item["proposed_by"]["S"],
            proposed_by_email=_opt(item, "proposed_by_email"),
            created_at=datetime.fromisoformat(item["created_at"]["S"]),
            expires_at=datetime.fromisoformat(item["expires_at"]["S"]),
            decided_by=_opt(item, "decided_by"),
            decided_by_email=_opt(item, "decided_by_email"),
            decided_at=datetime.fromisoformat(decided_at) if decided_at else None,
            note=_opt(item, "note"),
        )

    def change(self, change_id: str) -> PolicyChange | None:
        item = self._db.get_item(
            TableName=self._table,
            Key={"PK": _s(PK_CHANGE), "SK": _s(change_id)},
            ConsistentRead=True,
        ).get("Item")
        return self._parse(item) if item else None

    def recent(self, now: datetime) -> list[PolicyChange]:
        items: list[PolicyChange] = []
        pages = self._db.get_paginator("query").paginate(
            TableName=self._table,
            KeyConditionExpression="PK = :pk",
            ExpressionAttributeValues={":pk": _s(PK_CHANGE)},
            ConsistentRead=True,
        )
        for page_number, page in enumerate(pages):
            if page_number >= MAX_PAGES:
                break
            items.extend(self._parse(i) for i in page.get("Items", []))
        cutoff = now - LIST_WINDOW
        return sorted(
            (c for c in items if c.created_at >= cutoff),
            key=lambda c: (c.created_at, c.change_id),
            reverse=True,
        )

    def create(self, change: PolicyChange, now: datetime) -> None:
        item: dict[str, Any] = {
            "PK": _s(PK_CHANGE),
            "SK": _s(change.change_id),
            "tool": _s(change.tool),
            "status": _s("pending"),
            "before": _s(_rule_json(change.before)),
            "after": _s(_rule_json(change.after)),
            "base_version": _n(change.before.version),
            "reason": _s(change.reason),
            "proposed_by": _s(change.proposed_by),
            "created_at": _s(iso(change.created_at)),
            "expires_at": _s(iso(change.expires_at)),
            "ttl": _n(int((now + CHANGE_RETENTION).timestamp())),
        }
        if change.proposed_by_email:
            item["proposed_by_email"] = _s(change.proposed_by_email)
        try:
            self._db.transact_write_items(
                TransactItems=[
                    {
                        "Put": {
                            "TableName": self._table,
                            "Item": item,
                            "ConditionExpression": "attribute_not_exists(PK)",
                        }
                    },
                    {
                        # One open proposal per tool; an expired one no longer blocks.
                        "Put": {
                            "TableName": self._table,
                            "Item": {
                                "PK": _s(PK_PENDING),
                                "SK": _s(change.tool),
                                "change_id": _s(change.change_id),
                                "expires_at": _s(iso(change.expires_at)),
                            },
                            "ConditionExpression": "attribute_not_exists(PK) OR expires_at < :now",
                            "ExpressionAttributeValues": {":now": _s(iso(now))},
                        }
                    },
                ]
            )
        except ClientError as exc:
            _conflict(exc)

    def pending_ids(self, tools: list[str], now: datetime) -> dict[str, str]:
        """Open proposal of each tool that has one, by tool."""
        out: dict[str, str] = {}
        for tool in tools:
            item = self._db.get_item(
                TableName=self._table,
                Key={"PK": _s(PK_PENDING), "SK": _s(tool)},
                ConsistentRead=True,
            ).get("Item")
            if item and datetime.fromisoformat(item["expires_at"]["S"]) > now:
                out[tool] = item["change_id"]["S"]
        return out

    def _close(
        self,
        change: PolicyChange,
        *,
        to: Status,
        actor: str,
        actor_email: str | None,
        note: str | None,
        now: datetime,
        other_than_proposer: bool,
    ) -> list[Any]:
        names = {"#status": "status"}
        values: dict[str, Any] = {
            ":to": _s(to),
            ":pending": _s("pending"),
            ":by": _s(actor),
            ":at": _s(iso(now)),
        }
        sets = ["#status = :to", "decided_by = :by", "decided_at = :at"]
        if actor_email:
            sets.append("decided_by_email = :by_email")
            values[":by_email"] = _s(actor_email)
        if note:
            sets.append("note = :note")
            values[":note"] = _s(note)
        condition = "#status = :pending"
        if other_than_proposer:
            # Dual approval again, where it cannot be skipped (TM-W6).
            condition += " AND proposed_by <> :by"
        return [
            {
                "Update": {
                    "TableName": self._table,
                    "Key": {"PK": _s(PK_CHANGE), "SK": _s(change.change_id)},
                    "UpdateExpression": "SET " + ", ".join(sets),
                    "ConditionExpression": condition,
                    "ExpressionAttributeNames": names,
                    "ExpressionAttributeValues": values,
                }
            },
            {
                "Delete": {
                    "TableName": self._table,
                    "Key": {"PK": _s(PK_PENDING), "SK": _s(change.tool)},
                    # An expired proposal may have lost the marker to a newer one.
                    "ConditionExpression": "attribute_not_exists(PK) OR change_id = :id",
                    "ExpressionAttributeValues": {":id": _s(change.change_id)},
                }
            },
        ]

    def approve(
        self, change: PolicyChange, *, actor: str, actor_email: str | None, now: datetime
    ) -> None:
        """Apply the proposal: one transaction closes it and writes the policy, only if the
        policy is still the one the proposal was made from."""
        base = change.before.version
        put: Any = {
            "TableName": self._table,
            "Item": {
                "PK": _s(PK_POLICY),
                "SK": _s(change.tool),
                "rule": _s(_rule_json(change.after)),
                "version": _n(base + 1),
                "updated_by": _s(actor),
                "updated_at": _s(iso(now)),
            },
        }
        if base == 0:
            put["ConditionExpression"] = "attribute_not_exists(PK)"
        else:
            put["ConditionExpression"] = "version = :expected"
            put["ExpressionAttributeValues"] = {":expected": _n(base)}
        try:
            self._db.transact_write_items(
                TransactItems=[
                    *self._close(
                        change,
                        to="approved",
                        actor=actor,
                        actor_email=actor_email,
                        note=None,
                        now=now,
                        other_than_proposer=True,
                    ),
                    {"Put": put},
                ]
            )
        except ClientError as exc:
            _conflict(exc)

    def close(
        self,
        change: PolicyChange,
        *,
        to: Literal["rejected", "withdrawn"],
        actor: str,
        actor_email: str | None,
        note: str | None,
        now: datetime,
    ) -> None:
        try:
            self._db.transact_write_items(
                TransactItems=self._close(
                    change,
                    to=to,
                    actor=actor,
                    actor_email=actor_email,
                    note=note,
                    now=now,
                    other_than_proposer=to == "rejected",
                )
            )
        except ClientError as exc:
            _conflict(exc)


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


Reason = Annotated[str, Field(min_length=1, max_length=500)]
ConditionName = Literal["always", "amount", "count", "environment"]


class PolicyRule(_Strict):
    """A policy as shown: only the threshold of its condition is set."""

    condition: ConditionName
    amount_usd: Annotated[str, Field(pattern=_USD_PATTERN)] | None = None
    count: Annotated[int, Field(ge=1, le=100_000)] | None = None
    environment: Literal["prod", "staging"] | None = None
    approvers: Annotated[int, Field(ge=MIN_APPROVERS, le=MAX_APPROVERS)]
    expires_hours: Literal[1, 4, 24, 48, 72]


class ProposeIn(PolicyRule):
    base_version: Annotated[int, Field(ge=0, le=1_000_000)]
    """Version of the policy the proposal was made from (0: the default)."""
    reason: Reason


class EmptyIn(_Strict):
    pass


class RejectIn(_Strict):
    reason: Reason


class ToolPolicyOut(_Strict):
    tool: str
    server_name: str
    description: str
    conditions: list[ConditionName]
    """Conditions a policy of this tool may use: the release says which values it has."""
    policy: PolicyRule
    version: int
    pending_change_id: str | None


class PolicyChangeOut(_Strict):
    change_id: str
    tool: str
    status: Literal["pending", "approved", "rejected", "withdrawn", "expired"]
    before: PolicyRule
    after: PolicyRule
    reason: str
    proposed_by: str
    proposed_by_email: str | None
    created_at: str
    expires_at: str
    decided_by: str | None
    decided_by_email: str | None
    decided_at: str | None
    note: str | None


class PoliciesOut(_Strict):
    tools: list[ToolPolicyOut]
    changes: list[PolicyChangeOut]
    """Proposals of the last 30 days; empty for anyone who is not an administrator."""


class ChangeCreatedOut(_Strict):
    change_id: str


# --- Use cases --------------------------------------------------------------------------


@dataclass
class ToolPolicyDeps:
    store: PolicyStore
    catalog: Callable[[], McpCatalog]
    audit: AuditLog
    rate_limiter: RateLimiter
    clock: Callable[[], datetime]


def tier_inputs(tool: CatalogTool) -> TierInputs:
    declared = tool.tool.approval
    if declared is None:
        return TierInputs()
    return TierInputs(
        amount=declared.amount, count=declared.count, environment=declared.environment
    )


def governed(tool: CatalogTool) -> bool:
    """A write tool Mango can run with an approval today: one of a Mango connector. Write
    tools of third-party packs are not installed yet (D43)."""
    return tool.is_write and tool.server.kind == "connector"


def write_tools(catalog: McpCatalog) -> list[CatalogTool]:
    return [
        tool
        for connector in catalog.connectors
        for tool in catalog.tools_of(connector)
        if governed(tool)
    ]


def _catalog(deps: ToolPolicyDeps) -> McpCatalog:
    try:
        return deps.catalog()
    except InvalidCatalogError as exc:
        raise ApiError(503, "catalog_unavailable", "please try again") from exc


def _rule_out(policy: Policy) -> PolicyRule:
    return PolicyRule.model_validate(policy.rule())


def _change_out(change: PolicyChange, now: datetime) -> PolicyChangeOut:
    shown: Any = (
        "expired" if change.status == "pending" and now >= change.expires_at else change.status
    )
    return PolicyChangeOut(
        change_id=change.change_id,
        tool=change.tool,
        status=shown,
        before=_rule_out(change.before),
        after=_rule_out(change.after),
        reason=change.reason,
        proposed_by=change.proposed_by,
        proposed_by_email=change.proposed_by_email,
        created_at=iso(change.created_at),
        expires_at=iso(change.expires_at),
        decided_by=change.decided_by,
        decided_by_email=change.decided_by_email,
        decided_at=iso(change.decided_at) if change.decided_at else None,
        note=change.note,
    )


def _read[T](read: Callable[[], T]) -> T:
    try:
        return read()
    except (ClientError, BotoCoreError, KeyError, ValueError, PolicyUnavailableError) as exc:
        logger.exception("tool policies unreadable")
        raise ApiError(503, "policies_unavailable", "please try again") from exc


def policies_view(deps: ToolPolicyDeps, caller: Caller) -> PoliciesOut:
    now = deps.clock()
    tools = write_tools(_catalog(deps))
    refs = [tool.ref for tool in tools]
    pending = _read(lambda: deps.store.pending_ids(refs, now))
    rows = []
    for tool in tools:
        policy = _read(lambda ref=tool.ref: deps.store.policy(ref))  # type: ignore[misc]
        rows.append(
            ToolPolicyOut(
                tool=tool.ref,
                server_name=tool.server.name,
                description=tool.tool.description,
                conditions=[c.value for c in tier_inputs(tool).conditions()],
                policy=_rule_out(policy),
                version=policy.version,
                pending_change_id=pending.get(tool.ref),
            )
        )
    # Proposals carry administrators' emails and reasons: only administrators read them.
    changes = _read(lambda: deps.store.recent(now)) if caller.user.is_admin else []
    return PoliciesOut(tools=rows, changes=[_change_out(c, now) for c in changes])


def _audited[T](
    deps: ToolPolicyDeps, event: str, caller: Caller, detail: dict[str, Any], write: Callable[[], T]
) -> T:
    """Fail-closed audit: ``requested`` before writing, then ``applied`` or ``rejected``."""
    actor, user = caller.user.user_id, caller.user
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "requested"}, user)
    except Exception as exc:
        raise ApiError(503, "audit_unavailable", "the change could not be audited; retry") from exc
    try:
        result = write()
    except Exception as exc:
        code = (
            exc.code
            if isinstance(exc, ApiError)
            else "version_conflict"
            if isinstance(exc, PolicyConflictError)
            else "error"
        )
        try:
            deps.audit.emit(event, actor, {**detail, "outcome": "rejected", "error": code}, user)
        except Exception:
            logger.exception("audit emit failed after a rejected policy change")
        raise
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "applied"}, user)
    except Exception:
        logger.exception("audit emit failed after an applied policy change")
    return result


def _proposed(body: ProposeIn, inputs: TierInputs) -> Policy:
    condition = Condition(body.condition)
    if condition not in inputs.conditions():
        raise ApiError(422, "condition_unsupported", "this tool has no such value")
    try:
        return Policy(
            condition=condition,
            amount_usd=Decimal(body.amount_usd)
            if condition is Condition.AMOUNT and body.amount_usd
            else None,
            count=body.count if condition is Condition.COUNT else None,
            environment=body.environment if condition is Condition.ENVIRONMENT else None,
            approvers=body.approvers,
            expires_hours=body.expires_hours,
            version=body.base_version,
        )
    except ValueError as exc:
        raise ApiError(422, "invalid_policy", "the policy is not valid") from exc


def _detail(change: PolicyChange) -> dict[str, Any]:
    return {
        "change_id": change.change_id,
        "tool": change.tool,
        "before": change.before.rule(),
        "after": change.after.rule(),
        "proposed_by": change.proposed_by,
    }


def propose(deps: ToolPolicyDeps, caller: Caller, tool_ref: str, body: ProposeIn) -> str:
    actor = caller.user.user_id
    if not deps.rate_limiter.allow(actor):
        raise rate_limited(deps.rate_limiter.retry_after(actor))
    tool = _catalog(deps).tool(tool_ref)
    if tool is None or not governed(tool):
        raise ApiError(404, "not_found", "tool not found")
    current = _read(lambda: deps.store.policy(tool_ref))
    if body.base_version != current.version:
        raise ApiError(409, "version_conflict", "the policy changed; reload")
    after = _proposed(body, tier_inputs(tool))
    if after.same_rule(current):
        raise ApiError(422, "no_change", "the proposal changes nothing")
    now = deps.clock()
    change = PolicyChange(
        change_id=new_change_id(),
        tool=tool_ref,
        status="pending",
        before=current,
        after=after,
        reason=body.reason,
        proposed_by=actor,
        proposed_by_email=caller.user.email,
        created_at=now,
        expires_at=now + CHANGE_LIFETIME,
    )

    def write() -> None:
        try:
            deps.store.create(change, now)
        except PolicyConflictError as exc:
            raise ApiError(
                409, "already_pending", "this tool already has an open proposal"
            ) from exc

    _audited(
        deps, "approval.policy.propose", caller, {**_detail(change), "reason": body.reason}, write
    )
    return change.change_id


def _open_change(deps: ToolPolicyDeps, change_id: str) -> PolicyChange:
    change = _read(lambda: deps.store.change(change_id))
    if change is None:
        raise ApiError(404, "not_found", "proposal not found")
    if change.status != "pending":
        raise ApiError(409, "version_conflict", "the proposal is already closed")
    return change


def _refuse(
    deps: ToolPolicyDeps, event: str, caller: Caller, detail: dict[str, Any], err: ApiError
) -> None:
    """A refused decision is audited too; the refusal stands even if audit fails."""
    try:
        deps.audit.emit(
            event,
            caller.user.user_id,
            {**detail, "outcome": "rejected", "error": err.code},
            caller.user,
        )
    except Exception:
        logger.exception("audit emit failed for a refused policy decision")
    raise err


def approve(deps: ToolPolicyDeps, caller: Caller, change_id: str) -> None:
    actor = caller.user.user_id
    event = "approval.policy.approve"
    change = _open_change(deps, change_id)
    detail = {**_detail(change), "approved_by": actor}
    now = deps.clock()
    if now >= change.expires_at:
        raise ApiError(410, "expired", "the proposal expired")
    if change.proposed_by == actor:
        _refuse(
            deps,
            event,
            caller,
            detail,
            ApiError(403, "same_approver", "another administrator must approve this proposal"),
        )

    def write() -> None:
        try:
            deps.store.approve(change, actor=actor, actor_email=caller.user.email, now=now)
        except PolicyConflictError as exc:
            raise ApiError(409, "version_conflict", "the proposal or the policy changed") from exc

    _audited(deps, event, caller, detail, write)


def reject(deps: ToolPolicyDeps, caller: Caller, change_id: str, reason: str) -> None:
    actor = caller.user.user_id
    change = _open_change(deps, change_id)
    if change.proposed_by == actor:
        raise ApiError(403, "same_approver", "withdraw your own proposal instead")
    now = deps.clock()

    def write() -> None:
        try:
            deps.store.close(
                change,
                to="rejected",
                actor=actor,
                actor_email=caller.user.email,
                note=reason,
                now=now,
            )
        except PolicyConflictError as exc:
            raise ApiError(409, "version_conflict", "the proposal changed; reload") from exc

    detail = {**_detail(change), "rejected_by": actor, "reason": reason}
    _audited(deps, "approval.policy.reject", caller, detail, write)


def withdraw(deps: ToolPolicyDeps, caller: Caller, change_id: str) -> None:
    actor = caller.user.user_id
    change = _open_change(deps, change_id)
    if change.proposed_by != actor:
        raise ApiError(403, "forbidden", "only the proposer can withdraw a proposal")
    now = deps.clock()

    def write() -> None:
        try:
            deps.store.close(
                change, to="withdrawn", actor=actor, actor_email=None, note=None, now=now
            )
        except PolicyConflictError as exc:
            raise ApiError(409, "version_conflict", "the proposal changed; reload") from exc

    _audited(deps, "approval.policy.withdraw", caller, _detail(change), write)


# --- Routes -----------------------------------------------------------------------------


Authorize = Callable[[Caller, str, str, str], Awaitable[None]]


def tool_policy_router(
    deps: ToolPolicyDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    router = APIRouter(prefix="/api/approvals/policies")

    def action(name: str, *, admin: bool) -> Callable[[Caller], Awaitable[Caller]]:
        async def dependency(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
            await authorize(caller, name, *PLATFORM)
            # Defense in depth: the Cedar policies already require isAdmin.
            if admin and not caller.user.is_admin:
                raise ApiError(403, "forbidden", "not allowed")
            return caller

        return dependency

    View = Annotated[Caller, Depends(action("ViewApprovals", admin=False))]  # noqa: N806
    Propose = Annotated[Caller, Depends(action("ProposeToolPolicy", admin=True))]  # noqa: N806
    Approve = Annotated[Caller, Depends(action("ApproveToolPolicy", admin=True))]  # noqa: N806
    ChangeId = Annotated[str, Path(pattern=CHANGE_ID_PATTERN)]  # noqa: N806
    ToolRef = Annotated[str, Path(pattern=TOOL_REF_PATTERN, max_length=113)]  # noqa: N806

    async def run[T](fn: Callable[..., T], *args: Any) -> T:
        return await asyncio.to_thread(fn, *args)

    @router.get("", response_model=PoliciesOut)
    async def get_tool_policies(caller: View) -> PoliciesOut:
        return await run(policies_view, deps, caller)

    @router.post("/{tool}/changes", response_model=ChangeCreatedOut, status_code=201)
    async def propose_tool_policy(
        tool: ToolRef, body: ProposeIn, caller: Propose
    ) -> ChangeCreatedOut:
        return ChangeCreatedOut(change_id=await run(propose, deps, caller, tool, body))

    @router.post("/changes/{change_id}/approve", response_model=PoliciesOut)
    async def approve_tool_policy(
        change_id: ChangeId, _body: EmptyIn, caller: Approve
    ) -> PoliciesOut:
        await run(approve, deps, caller, change_id)
        return await run(policies_view, deps, caller)

    @router.post("/changes/{change_id}/reject", response_model=PoliciesOut)
    async def reject_tool_policy(
        change_id: ChangeId, body: RejectIn, caller: Approve
    ) -> PoliciesOut:
        await run(reject, deps, caller, change_id, body.reason)
        return await run(policies_view, deps, caller)

    @router.post("/changes/{change_id}/withdraw", response_model=PoliciesOut)
    async def withdraw_tool_policy(
        change_id: ChangeId, _body: EmptyIn, caller: Propose
    ) -> PoliciesOut:
        await run(withdraw, deps, caller, change_id)
        return await run(policies_view, deps, caller)

    return router
