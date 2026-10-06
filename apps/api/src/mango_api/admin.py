"""Admin v0 (D17): budgets, area -> OU mapping with dual approval, organization, connectivity.

Security notes (threat model ``admin-v0-threat-model.md``; security-best-practices, FastAPI):
* Every route declares an authorization dependency bound to its own Cedar action
  (``ViewAdmin``, ``ManageBudgets``, ``ProposeBusinessUnits``, ``ApproveBusinessUnits``); the
  decision is audited and ``is_admin`` is re-checked in process (TM-A2, AUTH-001, AUTHZ-001).
* Nobody edits what affects them: own budget, own area mapping (TM-A1, TM-A3). The mapping
  needs a different approver than the proposer (TM-A1). Only the proposer withdraws a
  proposal (``ProposeBusinessUnits``); rejecting is always someone else's decision.
* Optimistic locking with ``version``; approval is one conditional transaction (TM-A4, A5).
* Bodies forbid extra fields; responses use explicit models (VALID-001, RESP-001).
* Each write emits an audit event with before/after before the response (TM-A9).
* Probe calls carry only the verified ``sub``; rate limited (429 + ``Retry-After``) and cached
  (TM-A7).
* The member account check answers with a closed set of statuses per account, never with the
  probe's details, role names or ARNs; the accounts are the configured targets, not input.
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
import re
from collections.abc import Awaitable, Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Path
from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field

from mango_api.audit import AuditLog
from mango_api.budget import BudgetService, current_period
from mango_api.probe import (
    AdminProbe,
    Connectivity,
    ConnectivityCheck,
    MemberAccess,
    Organization,
    OrganizationalUnit,
    OrganizationCache,
    ProbeError,
    RateLimiter,
)
from mango_api.rate_limits import Limiter
from mango_api.settings_store import (
    USER_PREFIX,
    BudgetLimits,
    BusinessUnitMapping,
    ChangeRequest,
    SettingsStore,
    VersionConflictError,
    iso,
    new_change_id,
)
from mango_api.web import ApiError, Caller, rate_limited
from mango_core.agents import is_agent_id
from mango_core.business_units import (
    MAX_AREAS,
    MAX_OUS_PER_AREA,
    InvalidMappingError,
    Units,
    changed_areas,
    validate_units,
)

logger = logging.getLogger(__name__)

AGENT_PREFIX = "AGENT#"
"""Budget scope of an agent (``app._budget_scopes``)."""

PLATFORM = ("Mango::Platform", "mango")
MAX_USD = Decimal(1_000_000)
_USD_RE = re.compile(r"^\d{1,7}(\.\d{1,2})?$")
USER_ID_PATTERN = r"^[A-Za-z0-9-]{1,64}$"
CHANGE_ID_PATTERN = r"^[0-9a-f]{32}$"
PROBE_CALLS_PER_MINUTE = 5
MEMBER_CHECK_WORKERS = 8
"""Member accounts checked at once: each is one probe invocation of a few STS calls."""
MAX_PENDING_CHANGES = 10


# --- Validation -------------------------------------------------------------------------


def _units_out(units: Units) -> dict[str, list[str]]:
    return {area: list(ous) for area, ous in units.items()}


def _usd(value: object) -> Decimal:
    """USD amounts are decimal strings, ``0 < x <= 1000000``, at most two decimals."""
    if not isinstance(value, str) or not _USD_RE.fullmatch(value):
        raise ValueError("amount must be a decimal string such as '12.50'")
    try:
        amount = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError("invalid amount") from exc
    if not Decimal(0) < amount <= MAX_USD:
        raise ValueError("amount must be greater than 0 and at most 1000000")
    return amount


def _units(value: dict[str, list[str]]) -> dict[str, list[str]]:
    try:
        return _units_out(validate_units(value))
    except InvalidMappingError as exc:
        raise ValueError(str(exc)) from exc


UsdAmount = Annotated[Decimal, BeforeValidator(_usd)]
Reason = Annotated[str, Field(min_length=1, max_length=500)]
UnitsIn = Annotated[
    dict[
        Annotated[str, Field(pattern=r"^[a-z0-9-]{2,32}$")],
        Annotated[
            list[Annotated[str, Field(max_length=70)]],
            Field(min_length=1, max_length=MAX_OUS_PER_AREA),
        ],
    ],
    Field(max_length=MAX_AREAS),
    AfterValidator(_units),
]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BudgetDefaultsIn(_Strict):
    version: Annotated[int, Field(ge=0)]
    user_monthly_usd: UsdAmount
    agent_monthly_usd: UsdAmount


class UserBudgetIn(_Strict):
    version: Annotated[int, Field(ge=0)]
    limit_usd: UsdAmount | None


class ProposalIn(_Strict):
    base_version: Annotated[int, Field(ge=0)]
    units: UnitsIn
    reason: Reason


class EmptyIn(_Strict):
    pass


class RejectIn(_Strict):
    reason: Reason


# --- Responses --------------------------------------------------------------------------


class BudgetDefaultsOut(_Strict):
    user_monthly_usd: str
    agent_monthly_usd: str


class AgentBudgetOut(_Strict):
    agent_id: str
    name: str | None
    """Name of the published (or retired) agent; ``None`` when it is not known."""
    limit_usd: str
    spent_usd: str


class UserBudgetOut(_Strict):
    user_id: str
    email: str | None
    limit_usd: str
    override: bool
    spent_usd: str


class BudgetsOut(_Strict):
    period: str
    version: int
    defaults: BudgetDefaultsOut
    agents: list[AgentBudgetOut]
    users: list[UserBudgetOut]


class ChangeOut(_Strict):
    change_id: str
    proposed_by: str
    proposed_by_email: str | None
    created_at: str
    expires_at: str
    base_version: int
    units: dict[str, list[str]]
    reason: str


class BusinessUnitsOut(_Strict):
    version: int
    units: dict[str, list[str]]
    pending: list[ChangeOut]


class ChangeCreatedOut(_Strict):
    change_id: str


class OrganizationOut(_Strict):
    ous: list[OrganizationalUnit]


class ConnectivityOut(_Strict):
    checked_at: str
    checks: list[ConnectivityCheck]


MEMBER_CHECKS = frozenset({"read_broker", "member_role", "account", "source_identity_required"})
MemberAccountStatus = Literal["ok", "role_missing", "identity_not_required"]


class MemberAccountOut(_Strict):
    account_id: str
    name: str
    status: MemberAccountStatus
    """``role_missing``: the read role cannot be assumed in the account.
    ``identity_not_required``: the chain accepts a session that names no person."""


class MemberAccessOut(_Strict):
    checked_at: str
    accounts: list[MemberAccountOut]
    truncated: bool
    """There are more target accounts than the check covers; only the first ones are listed."""
    total: int
    """Target accounts in all (``len(accounts)`` unless ``truncated``)."""
    identity_required: bool | None
    """Whether the broker role refuses a session that names no person. It is checked on the
    broker, not on each account, so one answer stands for all of them; ``None`` when no account
    was checked."""


# --- Use cases --------------------------------------------------------------------------


def _money(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.01")))


@dataclass
class AdminDeps:
    store: SettingsStore
    limits: BudgetLimits
    budgets: BudgetService
    audit: AuditLog
    probe: AdminProbe
    agent_id: str
    rate_limiter: Limiter
    organization_cache: OrganizationCache
    clock: Callable[[], datetime]
    agent_names: Callable[[], Mapping[str, str]] | None = None
    """Names of the published and retired agents by id, for the budget list."""
    member_rate_limiter: Limiter = field(
        default_factory=lambda: RateLimiter(limit=PROBE_CALLS_PER_MINUTE, window_seconds=60)
    )
    """Own window of the member account check, which the screen runs after connectivity."""


def _agent_names(deps: AdminDeps) -> Mapping[str, str]:
    """The list still works without names: the id is shown instead."""
    if deps.agent_names is None:
        return {}
    try:
        return deps.agent_names()
    except Exception:
        logger.exception("agent names unavailable for the budget list")
        return {}


def budgets_view(deps: AdminDeps) -> BudgetsOut:
    period = current_period(deps.clock())
    defaults = deps.store.budget_defaults()
    overrides = deps.store.user_limits()
    usage = deps.budgets.period_usage(period)
    # Every agent that spent this period, and the release agent even before its first turn.
    agent_ids = {deps.agent_id} | {
        agent_id
        for key in usage
        if key.startswith(AGENT_PREFIX) and is_agent_id(agent_id := key.removeprefix(AGENT_PREFIX))
    }
    names = _agent_names(deps)
    users: list[UserBudgetOut] = []
    user_ids = {k.removeprefix(USER_PREFIX) for k in usage if k.startswith(USER_PREFIX)}
    for user_id in user_ids | overrides.keys():
        row = usage.get(USER_PREFIX + user_id)
        own = overrides.get(user_id)
        users.append(
            UserBudgetOut(
                user_id=user_id,
                email=row.label if row else None,
                limit_usd=_money(own if own is not None else defaults.user_monthly_usd),
                override=own is not None,
                spent_usd=_money(row.spent if row else Decimal(0)),
            )
        )
    users.sort(key=lambda u: (u.email is None, u.email or "", u.user_id))
    return BudgetsOut(
        period=period,
        version=defaults.version,
        defaults=BudgetDefaultsOut(
            user_monthly_usd=_money(defaults.user_monthly_usd),
            agent_monthly_usd=_money(defaults.agent_monthly_usd),
        ),
        agents=[
            AgentBudgetOut(
                agent_id=agent_id,
                name=names.get(agent_id),
                limit_usd=_money(defaults.agent_monthly_usd),
                spent_usd=_money(
                    row.spent if (row := usage.get(AGENT_PREFIX + agent_id)) else Decimal(0)
                ),
            )
            for agent_id in sorted(
                agent_ids,
                key=lambda a: (a != deps.agent_id, names.get(a, a).casefold(), a),
            )
        ],
        users=users,
    )


def _change_out(change: ChangeRequest) -> ChangeOut:
    return ChangeOut(
        change_id=change.change_id,
        proposed_by=change.proposed_by,
        proposed_by_email=change.proposed_by_email,
        created_at=iso(change.created_at),
        expires_at=iso(change.expires_at),
        base_version=change.base_version,
        units=_units_out(change.units),
        reason=change.reason,
    )


def business_units_view(deps: AdminDeps) -> BusinessUnitsOut:
    mapping = deps.store.mapping()
    return BusinessUnitsOut(
        version=mapping.version,
        units=_units_out(mapping.units),
        pending=[_change_out(c) for c in deps.store.pending_changes(deps.clock())],
    )


def _audited[T](
    deps: AdminDeps, event: str, caller: Caller, detail: dict[str, Any], write: Callable[[], T]
) -> T:
    """Fail-closed audit around a settings write (TM-A9, review ADM-01).

    1. ``outcome: requested`` with the intended before/after is emitted **before** writing;
       if it cannot be recorded, nothing is written and the caller gets 503.
    2. The write runs. On failure ``outcome: rejected`` (with the error code) is emitted.
    3. On success ``outcome: applied`` is emitted. The change is already committed and the
       immutable ``requested`` record exists, so a failure here is logged, not returned.
    """
    actor, user = caller.user.user_id, caller.user
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "requested"}, user)
    except Exception as exc:
        raise ApiError(503, "audit_unavailable", "the change could not be audited; retry") from exc
    try:
        result = write()
    except Exception as exc:
        code = (
            "version_conflict"
            if isinstance(exc, VersionConflictError)
            else exc.code
            if isinstance(exc, ApiError)
            else "error"
        )
        try:
            deps.audit.emit(event, actor, {**detail, "outcome": "rejected", "error": code}, user)
        except Exception:
            logger.exception("audit emit failed after a rejected write")
        raise
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "applied"}, user)
    except Exception:
        logger.exception("audit emit failed after an applied write")
    return result


def update_defaults(deps: AdminDeps, caller: Caller, body: BudgetDefaultsIn) -> None:
    before = deps.store.budget_defaults()
    actor = caller.user.user_id
    _audited(
        deps,
        "settings.budget.updated",
        caller,
        {
            "scope": "defaults",
            "before": {
                "user_monthly_usd": str(before.user_monthly_usd),
                "agent_monthly_usd": str(before.agent_monthly_usd),
            },
            "after": {
                "user_monthly_usd": str(body.user_monthly_usd),
                "agent_monthly_usd": str(body.agent_monthly_usd),
            },
            "base_version": body.version,
        },
        lambda: deps.store.put_budget_defaults(
            body.version, body.user_monthly_usd, body.agent_monthly_usd, actor, deps.clock()
        ),
    )
    deps.limits.invalidate()


def update_user_limit(deps: AdminDeps, caller: Caller, user_id: str, body: UserBudgetIn) -> None:
    if user_id == caller.user.user_id:
        raise ApiError(403, "self_edit", "you cannot change your own budget")
    before = deps.store.user_limit(user_id)
    actor = caller.user.user_id
    _audited(
        deps,
        "settings.budget.updated",
        caller,
        {
            "scope": f"USER#{user_id}",
            "target_user": user_id,
            "before": {"limit_usd": str(before) if before is not None else None},
            "after": {"limit_usd": str(body.limit_usd) if body.limit_usd is not None else None},
            "base_version": body.version,
        },
        lambda: deps.store.set_user_limit(
            body.version, user_id, body.limit_usd, actor, deps.clock()
        ),
    )
    deps.limits.invalidate()


def _require_not_own_area(caller: Caller, before: Units, after: Units) -> None:
    area = caller.user.business_unit
    if area and area in changed_areas(before, after):
        raise ApiError(403, "self_edit", "you cannot change the mapping of your own area")


def _rate_limited(deps: AdminDeps, caller: Caller) -> ApiError:
    return rate_limited(deps.rate_limiter.retry_after(caller.user.user_id))


def _organization(deps: AdminDeps, caller: Caller, rate_limited: bool) -> Organization:
    cached = deps.organization_cache.get()
    if cached is not None:
        return cached
    if rate_limited and not deps.rate_limiter.allow(caller.user.user_id):
        raise _rate_limited(deps, caller)
    try:
        organization = deps.probe.organization(caller.user.user_id)
    except ProbeError as exc:
        logger.warning("admin probe failed: %s", exc)
        raise ApiError(502, "upstream_error", "the organization could not be read") from exc
    deps.organization_cache.put(organization)
    return organization


def propose(deps: AdminDeps, caller: Caller, body: ProposalIn) -> str:
    current = deps.store.mapping()
    if body.base_version != current.version:
        raise ApiError(409, "version_conflict", "the mapping changed; reload and try again")
    units = validate_units(body.units)
    touched = changed_areas(current.units, units)
    if not touched:
        raise ApiError(422, "invalid_request", "the proposal does not change the mapping")
    _require_not_own_area(caller, current.units, units)
    now = deps.clock()
    if len(deps.store.pending_changes(now)) >= MAX_PENDING_CHANGES:
        raise ApiError(409, "too_many_pending", "too many pending changes; resolve some first")
    known = {ou.id for ou in _organization(deps, caller, rate_limited=False).ous}
    unknown = sorted({ou for ous in units.values() for ou in ous} - known)
    if unknown:
        raise ApiError(400, "unknown_ou", f"unknown OUs: {', '.join(unknown[:5])}")
    actor = caller.user.user_id
    change_id = new_change_id()
    _audited(
        deps,
        "settings.bu_mapping.proposed",
        caller,
        {
            "change_id": change_id,
            "proposed_by": actor,
            "base_version": body.base_version,
            "areas_changed": sorted(touched),
            "before": _units_out(current.units),
            "after": _units_out(units),
            "reason": body.reason,
        },
        lambda: deps.store.create_change(
            change_id=change_id,
            base_version=body.base_version,
            units=units,
            reason=body.reason,
            proposed_by=actor,
            proposed_by_email=caller.user.email,
            now=now,
        ),
    )
    return change_id


def _pending_change(deps: AdminDeps, change_id: str) -> ChangeRequest:
    change = deps.store.change(change_id)
    if change is None:
        raise ApiError(404, "not_found", "change request not found")
    if change.status != "pending":
        raise ApiError(409, "version_conflict", "the change request is already closed")
    return change


def approve(deps: AdminDeps, caller: Caller, change_id: str) -> None:
    change = _pending_change(deps, change_id)
    now = deps.clock()
    if now >= change.expires_at:
        raise ApiError(410, "expired", "the change request expired")
    if change.proposed_by == caller.user.user_id:
        raise ApiError(403, "same_approver", "another administrator must approve this change")
    current: BusinessUnitMapping = deps.store.mapping()
    if current.version != change.base_version:
        raise ApiError(409, "version_conflict", "the mapping changed since the proposal")
    _require_not_own_area(caller, current.units, change.units)
    actor = caller.user.user_id
    _audited(
        deps,
        "settings.bu_mapping.approved",
        caller,
        {
            "change_id": change.change_id,
            "proposed_by": change.proposed_by,
            "approved_by": actor,
            "areas_changed": sorted(changed_areas(current.units, change.units)),
            "before": _units_out(current.units),
            "after": _units_out(change.units),
            "base_version": change.base_version,
        },
        lambda: deps.store.approve_change(change, actor, now),
    )


def reject(deps: AdminDeps, caller: Caller, change_id: str, reason: str) -> None:
    change = _pending_change(deps, change_id)
    actor = caller.user.user_id
    if actor == change.proposed_by:
        # The proposer withdraws (POST .../withdraw); rejecting is another admin's decision.
        raise ApiError(403, "use_withdraw", "withdraw your own proposal instead")
    # Rejecting is a decision on the change too: no veto over your own area (ADM-03).
    _require_not_own_area(caller, deps.store.mapping().units, change.units)
    _audited(
        deps,
        "settings.bu_mapping.rejected",
        caller,
        {
            "change_id": change.change_id,
            "proposed_by": change.proposed_by,
            "rejected_by": actor,
            "reason": reason,
        },
        lambda: deps.store.reject_change(change, actor, reason, deps.clock()),
    )


def withdraw(deps: AdminDeps, caller: Caller, change_id: str) -> None:
    """The proposer closes their own pending proposal; no reason, the mapping is untouched."""
    change = _pending_change(deps, change_id)
    actor = caller.user.user_id
    if actor != change.proposed_by:
        raise ApiError(403, "not_proposer", "only the proposer can withdraw this change")
    _audited(
        deps,
        "settings.bu_mapping.withdrawn",
        caller,
        {"change_id": change.change_id, "proposed_by": change.proposed_by},
        lambda: deps.store.withdraw_change(change, actor, deps.clock()),
    )


def connectivity(deps: AdminDeps, caller: Caller) -> ConnectivityOut:
    if not deps.rate_limiter.allow(caller.user.user_id):
        raise _rate_limited(deps, caller)
    try:
        result: Connectivity = deps.probe.connectivity(caller.user.user_id)
    except ProbeError as exc:
        logger.warning("admin probe failed: %s", exc)
        raise ApiError(502, "upstream_error", "the connectivity check could not run") from exc
    return ConnectivityOut(checked_at=iso(deps.clock()), checks=result.checks)


def _member_status(result: MemberAccess) -> MemberAccountStatus | None:
    """Status of one account from the probe's checks; ``None`` when they do not settle it."""
    checks = {check.name: check for check in result.checks}
    if set(checks) != MEMBER_CHECKS or checks["read_broker"].status != "ok":
        return None
    role, account, identity = (
        checks["member_role"],
        checks["account"],
        checks["source_identity_required"],
    )
    # A missing role and a trust that refuses the broker are the same answer from STS.
    if role.status != "ok":
        return "role_missing" if role.detail == "access denied" else None
    if account.status != "ok":
        return None
    if identity.status != "ok":
        return (
            "identity_not_required"
            if identity.detail == "accepted without source identity"
            else None
        )
    return "ok"


def _identity_required(results: list[MemberAccess]) -> bool | None:
    """The broker's answer to a session without a person, from the accounts that settle it.

    Every account runs the same check against the broker, so one conclusive answer is enough;
    a single acceptance wins (fail closed). ``None`` when no account settles it."""
    answer: bool | None = None
    for result in results:
        checks = {check.name: check for check in result.checks}
        identity = checks.get("source_identity_required")
        if set(checks) != MEMBER_CHECKS or identity is None:
            continue
        if identity.status == "ok":
            answer = True
        elif identity.detail == "accepted without source identity":
            return False
    return answer


def member_access(deps: AdminDeps, caller: Caller) -> MemberAccessOut:
    """Checks the read role of every target member account (D51) for this administrator."""
    actor = caller.user.user_id
    if not deps.member_rate_limiter.allow(actor):
        raise rate_limited(deps.member_rate_limiter.retry_after(actor))
    try:
        targets = deps.probe.member_accounts(actor)
        with ThreadPoolExecutor(max_workers=MEMBER_CHECK_WORKERS) as pool:
            results = list(
                pool.map(
                    lambda account: deps.probe.member_access(actor, account.id), targets.accounts
                )
            )
    except ProbeError as exc:
        logger.warning("admin probe failed: %s", exc)
        raise ApiError(502, "upstream_error", "the member account check could not run") from exc
    accounts: list[MemberAccountOut] = []
    for account, result in zip(targets.accounts, results, strict=True):
        status = _member_status(result)
        if status is None:
            # No answer for one account: reporting the rest as the whole picture would mislead.
            logger.warning("member account check was inconclusive")
            raise ApiError(502, "upstream_error", "the member account check could not run")
        accounts.append(MemberAccountOut(account_id=account.id, name=account.name, status=status))
    identity_required = _identity_required(results)
    if accounts and identity_required is None:
        # Every account lacks the role and none could tell what the broker demands.
        logger.warning("member account check was inconclusive")
        raise ApiError(502, "upstream_error", "the member account check could not run")
    # A probe that predates ``total`` reports only the accounts it listed.
    total = len(accounts) if targets.total is None else max(targets.total, len(accounts))
    return MemberAccessOut(
        checked_at=iso(deps.clock()),
        accounts=accounts,
        truncated=targets.truncated,
        total=total,
        identity_required=identity_required,
    )


# --- Routes -----------------------------------------------------------------------------


Authorize = Callable[[Caller, str, str, str], Awaitable[None]]


def admin_router(
    deps: AdminDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    router = APIRouter(prefix="/api/admin")

    def admin_action(action: str) -> Callable[[Caller], Awaitable[Caller]]:
        async def dependency(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
            await authorize(caller, action, *PLATFORM)
            # Defense in depth: the Cedar policies already require isAdmin.
            if not caller.user.is_admin:
                raise ApiError(403, "forbidden", "not allowed")
            return caller

        return dependency

    ViewAdmin = Annotated[Caller, Depends(admin_action("ViewAdmin"))]  # noqa: N806
    ManageBudgets = Annotated[Caller, Depends(admin_action("ManageBudgets"))]  # noqa: N806
    Propose = Annotated[Caller, Depends(admin_action("ProposeBusinessUnits"))]  # noqa: N806
    Approve = Annotated[Caller, Depends(admin_action("ApproveBusinessUnits"))]  # noqa: N806
    UserId = Annotated[str, Path(pattern=USER_ID_PATTERN)]  # noqa: N806
    ChangeId = Annotated[str, Path(pattern=CHANGE_ID_PATTERN)]  # noqa: N806

    async def run[T](fn: Callable[..., T], *args: Any) -> T:
        try:
            return await asyncio.to_thread(fn, *args)
        except VersionConflictError as exc:
            raise ApiError(409, "version_conflict", "settings changed; reload and retry") from exc

    @router.get("/budgets", response_model=BudgetsOut)
    async def get_budgets(_caller: ViewAdmin) -> BudgetsOut:
        return await run(budgets_view, deps)

    @router.put("/budgets/defaults", response_model=BudgetsOut)
    async def put_defaults(body: BudgetDefaultsIn, caller: ManageBudgets) -> BudgetsOut:
        await run(update_defaults, deps, caller, body)
        return await run(budgets_view, deps)

    @router.put("/budgets/users/{user_id}", response_model=BudgetsOut)
    async def put_user_budget(
        user_id: UserId, body: UserBudgetIn, caller: ManageBudgets
    ) -> BudgetsOut:
        await run(update_user_limit, deps, caller, user_id, body)
        return await run(budgets_view, deps)

    @router.get("/business-units", response_model=BusinessUnitsOut)
    async def get_business_units(_caller: ViewAdmin) -> BusinessUnitsOut:
        return await run(business_units_view, deps)

    @router.post("/business-units/changes", response_model=ChangeCreatedOut, status_code=201)
    async def post_change(body: ProposalIn, caller: Propose) -> ChangeCreatedOut:
        return ChangeCreatedOut(change_id=await run(propose, deps, caller, body))

    @router.post("/business-units/changes/{change_id}/approve", response_model=BusinessUnitsOut)
    async def approve_change(
        change_id: ChangeId, _body: EmptyIn, caller: Approve
    ) -> BusinessUnitsOut:
        await run(approve, deps, caller, change_id)
        return await run(business_units_view, deps)

    @router.post("/business-units/changes/{change_id}/reject", response_model=BusinessUnitsOut)
    async def reject_change(
        change_id: ChangeId, body: RejectIn, caller: Approve
    ) -> BusinessUnitsOut:
        await run(reject, deps, caller, change_id, body.reason)
        return await run(business_units_view, deps)

    @router.post("/business-units/changes/{change_id}/withdraw", response_model=BusinessUnitsOut)
    async def withdraw_change(
        change_id: ChangeId, _body: EmptyIn, caller: Propose
    ) -> BusinessUnitsOut:
        await run(withdraw, deps, caller, change_id)
        return await run(business_units_view, deps)

    @router.get("/organization", response_model=OrganizationOut)
    async def get_organization(caller: ViewAdmin) -> OrganizationOut:
        organization = await run(_organization, deps, caller, True)
        return OrganizationOut(ous=organization.ous)

    @router.post("/connectivity-check", response_model=ConnectivityOut)
    async def connectivity_check(_body: EmptyIn, caller: ViewAdmin) -> ConnectivityOut:
        return await run(connectivity, deps, caller)

    @router.post("/member-access-check", response_model=MemberAccessOut)
    async def member_access_check(_body: EmptyIn, caller: ViewAdmin) -> MemberAccessOut:
        return await run(member_access, deps, caller)

    return router


def now_utc() -> datetime:
    return datetime.now(UTC)
