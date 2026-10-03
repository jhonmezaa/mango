"""Confirmation of write tool calls in two tiers (D27; threat model
``write-tools-approval-threat-model.md``).

No write tool runs without a person confirming it. When an agent calls one, the Gateway
refuses the call and mango-api turns it into a request: the arguments as the model sent them,
the tier computed here from those arguments and the tool's policy, and an expiry. Below the
threshold the person who asked confirms it in the chat; above it, N approvers other than that
person sign it. Then the same person runs it: mango-api calls the Gateway with the stored
arguments and an approval token bound to ``hash(tool, args)``.

Security notes (security-best-practices, FastAPI):
* Every route declares its Cedar action: ``ViewApprovals`` to read, ``ApproveToolCall`` to
  sign or reject. Confirming, cancelling and running are only for who asked, and running
  checks ``UseAgent`` on the agent again.
* Object-level authorization: approvers see the requests that need approvers; anyone else
  sees only their own. A request the caller may not see is a 404.
* Separation of duties in the code and again in the DynamoDB condition: who asked never
  signs, nobody signs twice, nothing is decided after it expired (TM-W5, TM-W8).
* What is shown is what was stored and what runs: never the model's description (R3).
* Fail-closed audit: ``requested`` is recorded before a decision is written. Audit events
  carry the hash of the arguments, never the arguments.
* Bodies forbid extra fields and responses use explicit models (VALID-001, RESP-001).
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Path, Query
from pydantic import BaseModel, ConfigDict, Field

from mango_api.approval_executor import ApprovedCall, Execution, Executor, Outcome
from mango_api.approval_policy import DEFAULT_POLICY, Policy, Tier, decide
from mango_api.approvals_store import (
    ApprovalConflictError,
    ApprovalRecord,
    ApprovalStore,
    Signature,
    Status,
    iso,
    new_approval_id,
)
from mango_api.audit import AuditLog
from mango_api.mcp_catalog import CatalogTool, InvalidCatalogError, McpCatalog
from mango_api.probe import RateLimiter
from mango_api.published import AgentUnavailableError, PublishedAgent, PublishedAgents
from mango_api.tool_policies import PolicyStore, PolicyUnavailableError, governed, tier_inputs
from mango_api.web import ApiError, Caller, rate_limited
from mango_core.approval import APPROVAL_ID_PATTERN, InvalidArgumentsError, call_hash
from mango_core.approval import canonical_arguments as canonical
from mango_core.identity import UserContext

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
MAX_REQUESTS_PER_TURN = 3
MAX_OPEN_PER_USER = 20
MAX_EXPIRED_PER_READ = 20
RUNS_PER_MINUTE = 10
"""Each run signs with KMS and calls the Gateway: bounded per person (in process)."""
CONVERSATION_ID_PATTERN = r"^[0-9a-f]{32}$"
_WAITING = frozenset({Status.PENDING, Status.APPROVED, Status.EXECUTING})
"""Still waiting for someone: to be signed, to be run by who asked, or to finish running."""
_FINAL = frozenset(
    {Status.EXECUTED, Status.FAILED, Status.REJECTED, Status.CANCELLED, Status.EXPIRED}
)


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


Note = Annotated[str, Field(min_length=1, max_length=500)]


class ApproveIn(_Strict):
    note: Note | None = None


class RejectIn(_Strict):
    reason: Note


class EmptyIn(_Strict):
    pass


class RuleOut(_Strict):
    """The policy the request was born with and why it fell in its tier."""

    condition: Literal["always", "amount", "count", "environment"]
    reason: Literal["always", "above", "below", "unknown"]
    amount_usd: str | None = None
    count: int | None = None
    environment: str | None = None
    approvers: int
    expires_hours: int


class SignatureOut(_Strict):
    user_id: str
    email: str | None
    at: str
    note: str | None


class ApprovalOut(_Strict):
    approval_id: str
    status: Literal[
        "pending",
        "approved",
        "executing",
        "executed",
        "failed",
        "rejected",
        "cancelled",
        "expired",
    ]
    tier: Literal["self", "approvers"]
    tool: str
    server_name: str
    description: str
    """What the tool does, from the release's manifest: never the model's summary (R3)."""
    agent_id: str
    agent_name: str | None
    arguments: dict[str, Any]
    """The arguments the tool will run with, exactly as stored."""
    rule: RuleOut
    approvals_needed: int
    signatures: list[SignatureOut]
    requested_by: str
    requested_by_email: str | None
    created_at: str
    expires_at: str
    decided_by: str | None
    decided_by_email: str | None
    decided_at: str | None
    executed_at: str | None
    """When the call ended, whether it ran or failed."""
    note: str | None
    error: str | None
    conversation_id: str | None
    """Only for who asked: the conversation belongs to that person."""
    mine: bool
    can_sign: bool
    """A hint for the SPA; the API authorizes every decision on its own."""


class ApprovalListOut(_Strict):
    items: list[ApprovalOut]
    can_decide: bool
    """Whether the caller may sign requests (hint; decided again on each request)."""


# --- Use cases --------------------------------------------------------------------------


@dataclass
class ApprovalDeps:
    store: ApprovalStore
    policies: PolicyStore
    catalog: Callable[[], McpCatalog]
    published: PublishedAgents
    audit: AuditLog
    clock: Callable[[], datetime]
    executor: Executor | None = None
    """``None`` until the approval key is deployed: nothing can be run (503)."""
    run_limiter: RateLimiter = field(
        default_factory=lambda: RateLimiter(limit=RUNS_PER_MINUTE, window_seconds=60)
    )


def _unavailable(exc: Exception) -> ApiError:
    logger.exception("approvals unavailable")
    return ApiError(503, "approvals_unavailable", "please try again")


def _catalog_tool(deps: ApprovalDeps, ref: str) -> CatalogTool | None:
    try:
        return deps.catalog().tool(ref)
    except InvalidCatalogError:
        return None


def _agent_name(deps: ApprovalDeps, agent_id: str) -> str | None:
    try:
        agent = deps.published.get(agent_id)
    except AgentUnavailableError:
        return None
    return agent.definition.name if agent else None


def _rule_out(record: ApprovalRecord) -> RuleOut:
    rule = record.rule
    return RuleOut(
        condition=rule.get("condition", "always"),
        reason=record.tier_reason.value,
        amount_usd=rule.get("amount_usd"),
        count=rule.get("count"),
        environment=rule.get("environment"),
        approvers=int(rule.get("approvers", record.approvals_needed)),
        expires_hours=int(rule.get("expires_hours", 24)),
    )


def approval_out(
    deps: ApprovalDeps, record: ApprovalRecord, user_id: str, *, can_decide: bool, now: datetime
) -> ApprovalOut:
    tool = _catalog_tool(deps, record.tool)
    mine = record.requested_by == user_id
    status = Status.EXPIRED if record.expired(now) else record.status
    return ApprovalOut(
        approval_id=record.approval_id,
        status=status.value,
        tier=record.tier.value,
        tool=record.tool,
        server_name=tool.server.name if tool else record.tool.partition(".")[0],
        description=tool.tool.description if tool else "",
        agent_id=record.agent_id,
        agent_name=_agent_name(deps, record.agent_id),
        arguments=json.loads(record.arguments),
        rule=_rule_out(record),
        approvals_needed=record.approvals_needed,
        signatures=[
            SignatureOut(user_id=s.user_id, email=s.email, at=s.at, note=s.note)
            for s in record.signatures
        ],
        requested_by=record.requested_by,
        requested_by_email=record.requested_by_email,
        created_at=iso(record.created_at),
        expires_at=iso(record.expires_at),
        decided_by=record.decided_by,
        decided_by_email=record.decided_by_email,
        decided_at=iso(record.decided_at) if record.decided_at else None,
        executed_at=iso(record.executed_at) if record.executed_at else None,
        note=record.note,
        error=record.error,
        conversation_id=record.conversation_id if mine else None,
        mine=mine,
        can_sign=(
            can_decide
            and status is Status.PENDING
            and record.tier is Tier.APPROVERS
            and not mine
            and user_id not in record.signers
        ),
    )


def _audit_detail(record: ApprovalRecord) -> dict[str, Any]:
    """Identifiers and the hash of the call; never its arguments (TM-W11)."""
    return {
        "approval_id": record.approval_id,
        "tool": record.tool,
        "agent": record.agent_id,
        "args_hash": record.args_hash,
        "tier": record.tier.value,
        "requested_by": record.requested_by,
    }


def _expire(deps: ApprovalDeps, record: ApprovalRecord, now: datetime) -> None:
    """Close a request nobody resolved in time and audit it once; never raises (the reader
    already sees it as expired)."""
    try:
        deps.store.close(
            record,
            to=Status.EXPIRED,
            actor=None,
            actor_email=None,
            note=None,
            now=now,
        )
        deps.audit.emit(
            "approval.expire",
            record.requested_by,
            {**_audit_detail(record), "outcome": "applied"},
        )
    except ApprovalConflictError:
        pass  # Someone decided or expired it first.
    except Exception:
        logger.exception("could not expire an approval")


def _sweep(deps: ApprovalDeps, records: list[ApprovalRecord], now: datetime) -> None:
    for record in [r for r in records if r.expired(now)][:MAX_EXPIRED_PER_READ]:
        _expire(deps, record, now)


# --- Requests created by the chat -------------------------------------------------------


@dataclass(frozen=True)
class WriteCall:
    """A write tool call of an agent, as its harness stream reported it."""

    gateway_tool: str
    arguments: str
    """Raw JSON text of the tool input."""


def _policy(deps: ApprovalDeps, tool: str) -> Policy:
    """The tool's policy; one that cannot be read is the default: approvers (fail closed)."""
    try:
        return deps.policies.policy(tool)
    except PolicyUnavailableError:
        logger.exception("tool policy unreadable; using the approvers default")
        return DEFAULT_POLICY


def request_call(  # noqa: PLR0911 - each early return is one reason not to create a request
    deps: ApprovalDeps,
    user: UserContext,
    agent: PublishedAgent,
    conversation_id: str,
    *,
    call: WriteCall,
    seen: set[str],
) -> ApprovalRecord | None:
    """Turn a refused write tool call into a request for confirmation.

    Returns ``None`` when nothing is created: the tool is not a write tool of this agent
    version, the arguments are not a JSON object, the same call was already requested in this
    turn, a limit was reached or the request could not be audited. The call stays refused by
    the Gateway either way.
    """
    ref = dict(agent.write_tools).get(call.gateway_tool)
    tool = _catalog_tool(deps, ref) if ref else None
    if ref is None or tool is None or not governed(tool):
        return None
    try:
        arguments = json.loads(call.arguments or "{}")
        canonical_text = canonical(arguments)
        args_hash = call_hash(call.gateway_tool, arguments)
    except (ValueError, InvalidArgumentsError):
        return None
    if args_hash in seen or len(seen) >= MAX_REQUESTS_PER_TURN:
        return None
    now = deps.clock()
    try:
        mine = deps.store.by_requester(user.user_id)
    except (ClientError, BotoCoreError):
        logger.exception("approvals unreadable")
        return None
    waiting = sum(1 for r in mine if r.status is Status.PENDING and not r.expired(now))
    if waiting >= MAX_OPEN_PER_USER:
        return None
    policy = _policy(deps, ref)
    decision = decide(policy, tier_inputs(tool), arguments)
    record = ApprovalRecord(
        approval_id=new_approval_id(),
        status=Status.PENDING,
        tier=decision.tier,
        tier_reason=decision.reason,
        tool=ref,
        gateway_tool=call.gateway_tool,
        arguments=canonical_text,
        args_hash=args_hash,
        agent_id=agent.agent_id,
        agent_version=agent.version,
        conversation_id=conversation_id,
        requested_by=user.user_id,
        requested_by_email=user.email,
        created_at=now,
        expires_at=now + timedelta(hours=policy.expires_hours),
        approvals_needed=policy.approvers if decision.tier is Tier.APPROVERS else 0,
        rule=policy.rule(),
    )
    try:
        deps.store.create(record, now)
    except Exception:
        logger.exception("could not create an approval request")
        return None
    try:
        deps.audit.emit(
            "approval.request",
            user.user_id,
            {
                **_audit_detail(record),
                "tier_reason": decision.reason.value,
                "conversation_id": conversation_id,
                "outcome": "applied",
            },
            user,
        )
    except Exception:
        # No request without its audit record (fail closed): it is withdrawn.
        logger.exception("could not audit an approval request")
        try:
            deps.store.close(
                record, to=Status.CANCELLED, actor=None, actor_email=None, note=None, now=now
            )
        except Exception:
            logger.exception("could not withdraw an unaudited approval request")
        return None
    seen.add(args_hash)
    return record


_NOTE_TEXT = {
    Status.EXECUTED: "was confirmed and executed successfully",
    Status.FAILED: "was confirmed but could not be completed",
    Status.REJECTED: "was rejected by an approver and was not executed",
    Status.CANCELLED: "was cancelled by the user and was not executed",
    Status.EXPIRED: "expired without a decision and was not executed",
}


def outcome_note(deps: ApprovalDeps, user_id: str, conversation_id: str) -> str:
    """What happened to the actions this conversation asked for since the agent last spoke,
    for the next turn. Only the tool and its outcome: never the tool's output (TM-W12)."""
    try:
        records = [
            r
            for r in deps.store.by_requester(user_id)
            if r.conversation_id == conversation_id and not r.notified
        ]
        now = deps.clock()
        lines = []
        for record in reversed(records):
            status = Status.EXPIRED if record.expired(now) else record.status
            if status not in _FINAL:
                continue
            lines.append(f"- {record.gateway_tool}: {_NOTE_TEXT[status]}.")
            deps.store.mark_notified(record.approval_id)
    except Exception:
        logger.exception("could not build the approvals note")
        return ""
    if not lines:
        return ""
    return (
        "[Mango] Outcome of the actions you asked to confirm earlier in this conversation "
        "(do not call them again unless the user asks):\n" + "\n".join(lines)
    )


# --- Reads ------------------------------------------------------------------------------


def _visible(record: ApprovalRecord, user_id: str, can_decide: bool) -> bool:
    return record.requested_by == user_id or (can_decide and record.tier is Tier.APPROVERS)


def list_view(
    deps: ApprovalDeps, caller: Caller, view: Literal["pending", "resolved"], can_decide: bool
) -> ApprovalListOut:
    user_id = caller.user.user_id
    now = deps.clock()
    try:
        mine = [r for r in deps.store.by_requester(user_id) if r.tier is Tier.APPROVERS]
        # Both sides of the index: an approved request is filed as closed although it still
        # waits to be run, and one that expired without a decision is still filed as open.
        others = (
            [*deps.store.inbox(open_=True), *deps.store.inbox(open_=False)] if can_decide else []
        )
    except (ClientError, BotoCoreError) as exc:
        raise _unavailable(exc) from exc
    records = {r.approval_id: r for r in [*mine, *others]}
    _sweep(deps, list(records.values()), now)

    def waiting(record: ApprovalRecord) -> bool:
        return record.status in _WAITING and not record.expired(now)

    shown = [r for r in records.values() if waiting(r) == (view == "pending")]
    shown.sort(key=lambda r: r.decided_at or r.created_at, reverse=True)
    return ApprovalListOut(
        items=[approval_out(deps, r, user_id, can_decide=can_decide, now=now) for r in shown],
        can_decide=can_decide,
    )


def conversation_view(deps: ApprovalDeps, user_id: str, conversation_id: str) -> list[ApprovalOut]:
    """The caller's own requests of one conversation (both tiers), oldest first."""
    now = deps.clock()
    try:
        records = [
            r for r in deps.store.by_requester(user_id) if r.conversation_id == conversation_id
        ]
    except (ClientError, BotoCoreError) as exc:
        raise _unavailable(exc) from exc
    _sweep(deps, records, now)
    return [
        approval_out(deps, r, user_id, can_decide=False, now=now)
        for r in sorted(records, key=lambda r: r.created_at)
    ]


def _load(deps: ApprovalDeps, caller: Caller, approval_id: str, can_decide: bool) -> ApprovalRecord:
    try:
        record = deps.store.get(approval_id)
    except (ClientError, BotoCoreError) as exc:
        raise _unavailable(exc) from exc
    if record is None or not _visible(record, caller.user.user_id, can_decide):
        # The same answer whether it does not exist or belongs to someone else (TM-W9).
        raise ApiError(404, "not_found", "approval not found")
    return record


def _reload(deps: ApprovalDeps, caller: Caller, approval_id: str, can_decide: bool) -> ApprovalOut:
    record = _load(deps, caller, approval_id, can_decide)
    return approval_out(deps, record, caller.user.user_id, can_decide=can_decide, now=deps.clock())


def detail_view(
    deps: ApprovalDeps, caller: Caller, approval_id: str, can_decide: bool
) -> ApprovalOut:
    record = _load(deps, caller, approval_id, can_decide)
    now = deps.clock()
    if record.expired(now):
        _expire(deps, record, now)
    return approval_out(deps, record, caller.user.user_id, can_decide=can_decide, now=now)


# --- Decisions --------------------------------------------------------------------------


def _audited[T](
    deps: ApprovalDeps, event: str, caller: Caller, detail: dict[str, Any], write: Callable[[], T]
) -> T:
    """Fail-closed audit: ``requested`` before writing, then ``applied`` or ``rejected``."""
    actor, user = caller.user.user_id, caller.user
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "requested"}, user)
    except Exception as exc:
        raise ApiError(
            503, "audit_unavailable", "the decision could not be audited; retry"
        ) from exc
    try:
        result = write()
    except Exception as exc:
        code = (
            exc.code
            if isinstance(exc, ApiError)
            else "version_conflict"
            if isinstance(exc, ApprovalConflictError)
            else "error"
        )
        try:
            deps.audit.emit(event, actor, {**detail, "outcome": "rejected", "error": code}, user)
        except Exception:
            logger.exception("audit emit failed after a rejected approval decision")
        raise
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "applied"}, user)
    except Exception:
        logger.exception("audit emit failed after an applied approval decision")
    return result


def _refuse(
    deps: ApprovalDeps, event: str, caller: Caller, detail: dict[str, Any], err: ApiError
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
        logger.exception("audit emit failed for a refused approval decision")
    raise err


def _waiting(deps: ApprovalDeps, record: ApprovalRecord, *expected: Status) -> datetime:
    """``record`` still waits in one of ``expected`` and has not expired."""
    now = deps.clock()
    if record.expired(now):
        _expire(deps, record, now)
        raise ApiError(410, "expired", "the request expired")
    if record.status not in expected:
        raise ApiError(409, "version_conflict", "the request is no longer pending")
    return now


def _changed(exc: Exception) -> ApiError:
    return ApiError(409, "version_conflict", "the request changed; reload")


def approve(deps: ApprovalDeps, caller: Caller, approval_id: str, note: str | None) -> ApprovalOut:
    actor = caller.user.user_id
    event = "approval.approve"
    record = _load(deps, caller, approval_id, can_decide=True)
    detail = {**_audit_detail(record), "approved_by": actor}
    if record.tier is not Tier.APPROVERS:
        raise ApiError(404, "not_found", "approval not found")
    now = _waiting(deps, record, Status.PENDING)
    if record.requested_by == actor:
        _refuse(
            deps,
            event,
            caller,
            detail,
            ApiError(403, "own_request", "another person must approve what you asked for"),
        )
    if actor in record.signers:
        _refuse(deps, event, caller, detail, ApiError(409, "already_signed", "you already signed"))

    def write() -> bool:
        try:
            return deps.store.sign(
                record,
                Signature(user_id=actor, email=caller.user.email, at=iso(now), note=note),
                now=now,
            )
        except ApprovalConflictError as exc:
            raise _changed(exc) from exc

    signed = len(record.signers) + 1
    _audited(
        deps,
        event,
        caller,
        {**detail, "signatures": signed, "needed": record.approvals_needed},
        write,
    )
    return _reload(deps, caller, approval_id, can_decide=True)


def reject(deps: ApprovalDeps, caller: Caller, approval_id: str, reason: str) -> ApprovalOut:
    actor = caller.user.user_id
    record = _load(deps, caller, approval_id, can_decide=True)
    if record.tier is not Tier.APPROVERS:
        raise ApiError(404, "not_found", "approval not found")
    now = _waiting(deps, record, Status.PENDING)
    if record.requested_by == actor:
        raise ApiError(403, "own_request", "cancel your own request instead")

    def write() -> None:
        try:
            deps.store.close(
                record,
                to=Status.REJECTED,
                actor=actor,
                actor_email=caller.user.email,
                note=reason,
                now=now,
            )
        except ApprovalConflictError as exc:
            raise _changed(exc) from exc

    detail = {**_audit_detail(record), "rejected_by": actor, "reason": reason}
    _audited(deps, "approval.reject", caller, detail, write)
    return _reload(deps, caller, approval_id, can_decide=True)


def cancel(deps: ApprovalDeps, caller: Caller, approval_id: str) -> ApprovalOut:
    """Only who asked cancels: a pending request, or an approved one that did not run yet."""
    record = _load(deps, caller, approval_id, can_decide=False)
    now = _waiting(deps, record, Status.PENDING, Status.APPROVED)

    def write() -> None:
        try:
            deps.store.close(
                record,
                to=Status.CANCELLED,
                actor=caller.user.user_id,
                actor_email=caller.user.email,
                note=None,
                now=now,
            )
        except ApprovalConflictError as exc:
            raise _changed(exc) from exc

    event = "approval.self_cancel" if record.tier is Tier.SELF else "approval.cancel"
    _audited(deps, event, caller, _audit_detail(record), write)
    return _reload(deps, caller, approval_id, can_decide=False)


def _serving(deps: ApprovalDeps, record: ApprovalRecord) -> PublishedAgent:
    """The agent as it is served now, if it still has the tool that was approved."""
    try:
        agent = deps.published.get(record.agent_id)
    except AgentUnavailableError as exc:
        raise ApiError(503, "agent_unavailable", "please try again") from exc
    if agent is None or agent.retired or record.gateway_tool not in dict(agent.write_tools):
        raise ApiError(409, "tool_unavailable", "the agent no longer has this tool")
    return agent


def _run(deps: ApprovalDeps, caller: Caller, record: ApprovalRecord) -> None:
    """Run an approved request once, as the person who asked for it."""
    if deps.executor is None:
        raise ApiError(503, "execution_unavailable", "write tools are not deployed yet")
    actor = caller.user.user_id
    if not deps.run_limiter.allow(actor):
        raise rate_limited(deps.run_limiter.retry_after(actor))
    executor = deps.executor
    agent = _serving(deps, record)
    now = deps.clock()
    detail = _audit_detail(record)

    def write() -> Execution:
        try:
            deps.store.begin_execution(record, now=now)
        except ApprovalConflictError as exc:
            raise _changed(exc) from exc
        execution = executor.run(
            ApprovedCall(
                approval_id=record.approval_id,
                subject=record.requested_by,
                agent_id=agent.agent_id,
                agent_version=agent.version,
                gateway_tool=record.gateway_tool,
                arguments=record.arguments,
                args_hash=record.args_hash,
            ),
            access_token=caller.token,
            token_expires_at=caller.expires_at,
        )
        finished = deps.clock()
        if execution.outcome is Outcome.EXECUTED:
            deps.store.finish(record.approval_id, ok=True, error=None, now=finished)
            return execution
        error = execution.error or "error"
        if execution.outcome is Outcome.NOT_RUN and deps.store.release(
            record.approval_id, error=error
        ):
            # Nothing ran and the Gateway did not use the approval: it can be run again.
            raise ApiError(502, "execution_not_started", "the action did not start; try again")
        deps.store.finish(record.approval_id, ok=False, error=error, now=finished)
        return execution

    execution = _audited(deps, "approval.execute", caller, detail, write)
    if execution.outcome is not Outcome.EXECUTED:
        try:
            deps.audit.emit(
                "approval.execute_failed",
                caller.user.user_id,
                {**detail, "outcome": "rejected", "error": execution.error or "error"},
                caller.user,
            )
        except Exception:
            logger.exception("audit emit failed after a failed execution")


def confirm(deps: ApprovalDeps, caller: Caller, approval_id: str) -> ApprovalOut:
    """The person who asked confirms a call below the threshold, and it runs."""
    record = _load(deps, caller, approval_id, can_decide=False)
    if record.requested_by != caller.user.user_id or record.tier is not Tier.SELF:
        raise ApiError(404, "not_found", "approval not found")
    now = _waiting(deps, record, Status.PENDING)
    _serving(deps, record)

    def write() -> None:
        try:
            deps.store.confirm(record, now=now)
        except ApprovalConflictError as exc:
            raise _changed(exc) from exc

    _audited(deps, "approval.self_confirm", caller, _audit_detail(record), write)
    return execute(deps, caller, approval_id)


def execute(deps: ApprovalDeps, caller: Caller, approval_id: str) -> ApprovalOut:
    """Who asked runs a request that is confirmed or fully signed, before it expires."""
    record = _load(deps, caller, approval_id, can_decide=False)
    if record.requested_by != caller.user.user_id:
        raise ApiError(404, "not_found", "approval not found")
    _waiting(deps, record, Status.APPROVED)
    try:
        _run(deps, caller, record)
    except ApiError as exc:
        if exc.code != "execution_not_started":
            raise
    return _reload(deps, caller, approval_id, can_decide=False)


# --- Routes -----------------------------------------------------------------------------


Authorize = Callable[[Caller, str, str, str], Awaitable[None]]
AuthorizeUse = Callable[[Caller, str, str], Awaitable[None]]
"""``(caller, agent_id, approval_id)``: the audited ``UseAgent`` decision on the agent."""
CanDecide = Callable[[Caller], bool]


def approvals_router(
    deps: ApprovalDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
    authorize_use: AuthorizeUse,
    can_decide: CanDecide,
) -> APIRouter:
    router = APIRouter(prefix="/api/approvals")

    def action(name: str) -> Callable[[Caller], Awaitable[Caller]]:
        async def dependency(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
            await authorize(caller, name, *PLATFORM)
            return caller

        return dependency

    View = Annotated[Caller, Depends(action("ViewApprovals"))]  # noqa: N806
    Decide = Annotated[Caller, Depends(action("ApproveToolCall"))]  # noqa: N806
    ApprovalId = Annotated[str, Path(pattern=APPROVAL_ID_PATTERN)]  # noqa: N806

    async def run[T](fn: Callable[..., T], *args: Any) -> T:
        return await asyncio.to_thread(fn, *args)

    async def decides(caller: Caller) -> bool:
        return await asyncio.to_thread(can_decide, caller)

    async def use_agent(caller: Caller, approval_id: str) -> None:
        """Running an action is using the agent: its ``UseAgent`` decision is made again."""
        record = await run(_load, deps, caller, approval_id, False)
        await authorize_use(caller, record.agent_id, approval_id)

    @router.get("", response_model=ApprovalListOut)
    async def list_approvals(
        caller: View,
        view: Annotated[Literal["pending", "resolved"], Query()] = "pending",
        conversation_id: Annotated[str | None, Query(pattern=CONVERSATION_ID_PATTERN)] = None,
    ) -> ApprovalListOut:
        if conversation_id is not None:
            items = await run(conversation_view, deps, caller.user.user_id, conversation_id)
            return ApprovalListOut(items=items, can_decide=False)
        return await run(list_view, deps, caller, view, await decides(caller))

    @router.get("/{approval_id}", response_model=ApprovalOut)
    async def get_approval(approval_id: ApprovalId, caller: View) -> ApprovalOut:
        return await run(detail_view, deps, caller, approval_id, await decides(caller))

    @router.post("/{approval_id}/confirm", response_model=ApprovalOut)
    async def confirm_approval(
        approval_id: ApprovalId, _body: EmptyIn, caller: View
    ) -> ApprovalOut:
        await use_agent(caller, approval_id)
        return await run(confirm, deps, caller, approval_id)

    @router.post("/{approval_id}/cancel", response_model=ApprovalOut)
    async def cancel_approval(approval_id: ApprovalId, _body: EmptyIn, caller: View) -> ApprovalOut:
        return await run(cancel, deps, caller, approval_id)

    @router.post("/{approval_id}/execute", response_model=ApprovalOut)
    async def execute_approval(
        approval_id: ApprovalId, _body: EmptyIn, caller: View
    ) -> ApprovalOut:
        await use_agent(caller, approval_id)
        return await run(execute, deps, caller, approval_id)

    @router.post("/{approval_id}/approve", response_model=ApprovalOut)
    async def approve_approval(
        approval_id: ApprovalId, body: ApproveIn, caller: Decide
    ) -> ApprovalOut:
        return await run(approve, deps, caller, approval_id, body.note)

    @router.post("/{approval_id}/reject", response_model=ApprovalOut)
    async def reject_approval(
        approval_id: ApprovalId, body: RejectIn, caller: Decide
    ) -> ApprovalOut:
        return await run(reject, deps, caller, approval_id, body.reason)

    return router
