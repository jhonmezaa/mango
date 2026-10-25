"""Gobernanza (D89; threat model ``governance-threat-model.md``): what needs attention and how
the controls are working, in one read.

It summarizes what other screens already show and creates nothing: the requests that need
approvers (Aprobaciones), the agents over their alert threshold (Presupuestos), the pending
changes of the area mapping (Ajustes > Áreas) and the governance events of the audit trail
(Auditoría). Agent health and team budgets have no source: «Próximamente» (D24).

Security notes (security-best-practices, FastAPI):
* The route declares its Cedar action, ``ViewGovernance`` (administrators and central FinOps),
  audited as a read.
* Each section is decided again with the action of its own screen: ``ApproveToolCall`` for
  approvals, ``ViewAdmin`` for budgets and areas, ``ViewAudit`` for the audit trail, and
  ``is_admin`` again in process for the last two (as their routes). A section the caller may
  not read is ``null``, never empty (TM-G1).
* Approvals are counts, tools and rules only: never arguments, conversations or emails
  (TM-G2). The recent activity is a closed list of events with the output of Auditoría.
* Reads are bounded (the approvals lists, 5,000 audit events for the count, 2,000 for the
  activity), limited per person and cached for a short time per person and permissions
  (TM-G3). No query or body is accepted; responses use explicit models (VALID-001, RESP-001).
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from mango_api.admin import AdminDeps, budgets_view
from mango_api.approval_policy import Tier
from mango_api.approvals import ApprovalDeps
from mango_api.approvals_store import MAX_LIST, ApprovalRecord, Status, iso
from mango_api.audit import AuditEventOut, AuditLog, AuditQuery, audit_event_out
from mango_api.knowledge_sources import QueuedSourceOut
from mango_api.mcp_catalog import InvalidCatalogError
from mango_api.rate_limits import Limiter
from mango_api.tool_policies import PolicyRule, policy_rule
from mango_api.web import ApiError, Caller, rate_limited

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
READS_PER_MINUTE = 30
CACHE_SECONDS = 30.0
CACHE_ENTRIES = 256
WARN_PERCENT = Decimal(80)
"""Alert threshold of a budget, as the budgets screen (``govFormat.ts``)."""
FULL = Decimal(100)
SOON = timedelta(hours=1)
WEEK = timedelta(days=7)
DAY = timedelta(days=1)
AUDIT_COUNT_CAP = 5000
RECENT_EVENTS = 7
MAX_POLICIES = 20
GOVERNANCE_EVENTS = (
    "approval.request",
    "approval.approve",
    "approval.reject",
    "approval.expire",
    "approval.policy.",
    "settings.budget.updated",
    "budget.exceeded",
    "settings.bu_mapping.",
    "agent.retired",
    "agent.version.approved",
    "agent.version.rejected",
    "settings.groups.",
    "directory.group_add",
    "directory.group_remove",
    "directory.area_change",
    "directory.member_propose",
    "directory.member_approve",
    "directory.member_reject",
    "directory.member_withdraw",
    "mcp.pack.request.",
)
"""What counts as governance in the recent activity (D89): names, or prefixes ending in ``.``."""


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PolicyLine(_Strict):
    tool: str
    server_name: str
    policy: PolicyRule
    """The tool's policy now (D27)."""
    pending: int
    total: int


class ApprovalsSummary(_Strict):
    pending: int
    """Requests that need approvers, waiting for signatures and not expired, plus the bucket
    proposals of knowledge bases pending in Aprobaciones for the caller (D88 (48))."""
    mine: int
    """What waits for the caller's signature: requests not asked by them nor signed by them
    yet, plus the bucket proposals they may decide."""
    mine_soon: int
    """Of the caller's requests, the ones that expire within an hour."""
    next_expires_at: str | None
    """When the first pending request expires: «La primera vence en {t}»."""
    approved_7d: int
    """Approved in the last 7 days, also when it ran or failed afterwards."""
    rejected_7d: int
    policies: list[PolicyLine]
    """One line per tool with requests pending or of the last 7 days, most pending first."""
    capped: bool
    """A list of the approvals index was full: the counts are a floor."""


class BudgetLine(_Strict):
    scope: Literal["agent", "user"]
    id: str
    """The agent's id or the person's user id."""
    name: str | None
    """The agent's name or the person's email, as the budgets screen; ``None`` when unknown."""
    spent_usd: str
    limit_usd: str
    exhausted: bool
    """Spent the whole limit."""


class BudgetsSummary(_Strict):
    period: str
    over_warn: list[BudgetLine]
    """Agents and people at or over the alert threshold, highest consumption first."""


class AreasSummary(_Strict):
    pending: int
    """Changes of the area mapping waiting for a second administrator."""


class AuditSummary(_Strict):
    events_24h: int
    """Events of the last 24 hours, without reads."""
    capped: bool
    """The count stopped at its cap: ``events_24h`` is a floor."""
    recent: list[AuditEventOut]
    """The last governance events of the last 7 days, newest first."""


class GovernanceOut(_Strict):
    approvals: ApprovalsSummary | None
    """``None`` when the caller may not sign requests."""
    budgets: BudgetsSummary | None
    """``None`` for anyone who is not an administrator."""
    areas: AreasSummary | None
    """``None`` for anyone who is not an administrator."""
    audit: AuditSummary | None
    """``None`` for anyone who may not read the audit trail."""


# --- Use cases --------------------------------------------------------------------------


@dataclass(frozen=True)
class Access:
    """What the caller may read, decided for each request."""

    approvals: bool
    admin: bool
    audit: bool


@dataclass
class GovernanceDeps:
    approvals: ApprovalDeps | None
    admin: AdminDeps
    audit: AuditLog
    clock: Callable[[], datetime]
    limiter: Limiter
    sources: Callable[[Caller], list[QueuedSourceOut]] | None = None
    """The bucket proposals of Aprobaciones for the caller (D88 (48)); ``None`` without knowledge
    bases."""
    monotonic: Callable[[], float] = time.monotonic
    _cache: dict[tuple[str, Access], tuple[float, GovernanceOut]] = field(default_factory=dict)


def _server_name(deps: ApprovalDeps, ref: str) -> str:
    try:
        tool = deps.catalog().tool(ref)
    except InvalidCatalogError:
        tool = None
    return tool.server.name if tool else ref.partition(".")[0]


_APPROVED = frozenset({Status.APPROVED, Status.EXECUTING, Status.EXECUTED, Status.FAILED})
"""Approved, whether it ran, failed or still waits to be run (not expired after approval)."""


def approvals_summary(
    deps: ApprovalDeps, user_id: str, now: datetime, sources: list[QueuedSourceOut]
) -> ApprovalsSummary:
    """The requests of the approvers tier, as the approvers see them in Aprobaciones, and the
    caller's bucket proposals. Read only: an expired request is counted as expired, never
    written (the screen sweeps it)."""
    open_ = deps.store.inbox(open_=True)
    closed = deps.store.inbox(open_=False)
    records = {r.approval_id: r for r in [*open_, *closed] if r.tier is Tier.APPROVERS}
    week = now - WEEK
    pending = [r for r in records.values() if r.status is Status.PENDING and not r.expired(now)]
    mine = [r for r in pending if r.requested_by != user_id and user_id not in r.signers]
    decided = [r for r in records.values() if r.decided_at is not None and r.decided_at >= week]
    approved = sum(1 for r in decided if r.status in _APPROVED)
    rejected = sum(1 for r in decided if r.status is Status.REJECTED)
    waiting = [s for s in sources if s.status.value == "pending"]
    live = {r.approval_id for r in pending}
    by_tool: dict[str, list[ApprovalRecord]] = {}
    for record in records.values():
        if record.approval_id in live or record.created_at >= week:
            by_tool.setdefault(record.tool, []).append(record)
    lines = [
        PolicyLine(
            tool=ref,
            server_name=_server_name(deps, ref),
            policy=policy_rule(deps.policies.policy(ref)),
            pending=sum(1 for r in items if r.approval_id in live),
            total=len(items),
        )
        for ref, items in sorted(
            by_tool.items(),
            key=lambda kv: (
                -sum(1 for r in kv[1] if r.approval_id in live),
                -len(kv[1]),
                kv[0],
            ),
        )[:MAX_POLICIES]
    ]
    return ApprovalsSummary(
        pending=len(pending) + len(waiting),
        mine=len(mine) + sum(1 for s in waiting if s.can_decide),
        mine_soon=sum(1 for r in mine if r.expires_at - now < SOON),
        next_expires_at=iso(min(r.expires_at for r in pending)) if pending else None,
        approved_7d=approved,
        rejected_7d=rejected,
        policies=lines,
        capped=len(open_) >= MAX_LIST or len(closed) >= MAX_LIST,
    )


def _ratio(spent: Decimal, limit: Decimal) -> Decimal:
    if limit <= 0:
        return FULL if spent > 0 else Decimal(0)
    return spent / limit * 100


def budgets_summary(deps: AdminDeps) -> BudgetsSummary:
    """The agents and people of the budgets screen at or over the alert threshold (D17: every
    agent uses the default limit; team budgets do not exist)."""
    budgets = budgets_view(deps)
    lines = [
        *(
            BudgetLine(
                scope="agent",
                id=a.agent_id,
                name=a.name,
                spent_usd=a.spent_usd,
                limit_usd=a.limit_usd,
                exhausted=_ratio(Decimal(a.spent_usd), Decimal(a.limit_usd)) >= FULL,
            )
            for a in budgets.agents
        ),
        *(
            BudgetLine(
                scope="user",
                id=u.user_id,
                name=u.email,
                spent_usd=u.spent_usd,
                limit_usd=u.limit_usd,
                exhausted=_ratio(Decimal(u.spent_usd), Decimal(u.limit_usd)) >= FULL,
            )
            for u in budgets.users
        ),
    ]
    over = [
        (ratio, line)
        for line in lines
        if (ratio := _ratio(Decimal(line.spent_usd), Decimal(line.limit_usd))) >= WARN_PERCENT
    ]
    over.sort(key=lambda pair: (-pair[0], pair[1].scope, pair[1].id))
    return BudgetsSummary(period=budgets.period, over_warn=[line for _, line in over])


def audit_summary(audit: AuditLog, now: datetime) -> AuditSummary:
    counted = audit.count(
        AuditQuery(since=now - DAY, until=now, limit=1, exclude_reads=True),
        cap=AUDIT_COUNT_CAP,
        now=now,
    )
    recent = audit.page(
        AuditQuery(
            since=now - WEEK,
            until=now,
            limit=RECENT_EVENTS,
            exclude_reads=True,
            events=GOVERNANCE_EVENTS,
            applied_only=True,
        ),
        now=now,
    )
    return AuditSummary(
        events_24h=counted.count,
        capped=counted.capped,
        recent=[audit_event_out(r) for r in recent.items],
    )


def _sources(deps: GovernanceDeps, caller: Caller) -> list[QueuedSourceOut]:
    if deps.sources is None:
        return []
    try:
        return deps.sources(caller)
    except ApiError:
        # As the Bandeja: without the knowledge table the rest of the summary is still answered.
        logger.warning("the bucket proposals could not be read for the governance summary")
        return []


def summary(deps: GovernanceDeps, caller: Caller, access: Access) -> GovernanceOut:
    now = deps.clock()
    try:
        return GovernanceOut(
            approvals=(
                approvals_summary(
                    deps.approvals,
                    caller.user.user_id,
                    now,
                    _sources(deps, caller),
                )
                if access.approvals and deps.approvals is not None
                else None
            ),
            budgets=budgets_summary(deps.admin) if access.admin else None,
            areas=(
                AreasSummary(pending=len(deps.admin.store.pending_changes(now)))
                if access.admin
                else None
            ),
            audit=audit_summary(deps.audit, now) if access.audit else None,
        )
    except ApiError:
        raise
    except Exception as exc:
        logger.exception("governance unavailable")
        raise ApiError(503, "governance_unavailable", "please try again") from exc


def cached(deps: GovernanceDeps, caller: Caller, access: Access) -> GovernanceOut:
    """The same answer for a short time per person and permissions: reloading the view does
    not read the audit trail again (TM-G3). A change of permissions misses the cache."""
    key = (caller.user.user_id, access)
    now = deps.monotonic()
    hit = deps._cache.get(key)
    if hit is not None and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    out = summary(deps, caller, access)
    if len(deps._cache) >= CACHE_ENTRIES:
        for stale in [k for k, (at, _) in deps._cache.items() if now - at >= CACHE_SECONDS]:
            del deps._cache[stale]
        if len(deps._cache) >= CACHE_ENTRIES:
            deps._cache.clear()
    deps._cache[key] = (now, out)
    return out


# --- Routes -----------------------------------------------------------------------------


Authorize = Callable[[Caller, str, str, str], Awaitable[None]]
Allowed = Callable[[Caller, str], bool]
"""``(caller, action)``: one decision on the platform, not audited (a section, not a request)."""


def governance_router(
    deps: GovernanceDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
    allowed: Allowed,
) -> APIRouter:
    router = APIRouter(prefix="/api/governance")

    async def view(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        await authorize(caller, "ViewGovernance", *PLATFORM)
        return caller

    def access(caller: Caller) -> Access:
        admin = caller.user.is_admin
        return Access(
            approvals=allowed(caller, "ApproveToolCall"),
            # Defense in depth, as their own routes: the Cedar policies already require isAdmin.
            admin=admin and allowed(caller, "ViewAdmin"),
            audit=admin and allowed(caller, "ViewAudit"),
        )

    @router.get("", response_model=GovernanceOut)
    async def get_governance(caller: Annotated[Caller, Depends(view)]) -> GovernanceOut:
        user_id = caller.user.user_id
        if not deps.limiter.allow(user_id):
            raise rate_limited(deps.limiter.retry_after(user_id))
        granted = await asyncio.to_thread(access, caller)
        return await asyncio.to_thread(cached, deps, caller, granted)

    return router
