"""La Bandeja (D83; threat model ``inbox-threat-model.md``): what each person has to look at.

Two kinds of notice, as the design (``other-views.jsx``, «Bandeja»):

* **Aprobación**: the pending requests the caller can sign. They are not copied: they are read
  from the approvals table on every request with the rule of the approvals screen (D56): the
  ``approvers`` tier, pending and not expired, not asked by the caller and not signed by them
  yet, and only with ``ApproveToolCall``. Once decided or signed they are gone. Only whether
  the caller read or archived each one is stored, in the caller's partition.
* **Bucket de S3** (``kbsource``): the bucket proposals of knowledge bases the caller may sign
  (D88 (49)), read on every request with the rules of Aprobaciones (D88 (48)) and gone once
  decided; as with approvals, only whether the caller read or archived each one is stored.
* **Ejecución**: one per task run that ended completed or failed, written by the task worker
  in the partition of the task's owner (never anyone else, D78 (18), D82): the task's name,
  the agent, the reason code and the first line of the report. Never the report itself.
  A run that failed because its owner has to connect a remote MCP is ``remote_connect``
  (D98 (20)): the same notice, with the registration to connect and never a URL.

Mentions, tickets, budget and system notices have no signal in the product: «Próximamente».

Security notes (security-best-practices, FastAPI):
* Every route declares its Cedar action (``ViewInbox``, any person with a session).
* Object-level authorization is the partition: notices are read and written with the caller's
  row-level security client (``dynamodb:LeadingKeys``), so an id of someone else's notice is a
  404. An approval the caller cannot sign is a 404 too, as if it did not exist.
* Path, query and body are validated by schema (``extra="forbid"``) and responses use explicit
  models. Nothing of a notice is logged.
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Literal

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Path, Query
from pydantic import BaseModel, ConfigDict, model_validator

from mango_api.approval_policy import Tier
from mango_api.approvals import ApprovalDeps, ApprovalOut, approval_out
from mango_api.approvals_store import ApprovalRecord, Status
from mango_api.inbox_store import (
    NOTICE_ID_PATTERN,
    NOTICE_ID_RE,
    InboxStore,
    InboxStoreUnavailableError,
    NoticeState,
    RunNotice,
    View,
    first_line,
)
from mango_api.knowledge_sources import QueuedSourceOut
from mango_api.published import AgentUnavailableError, PublishedAgents
from mango_api.web import ApiError, Caller
from mango_core.approval import APPROVAL_ID_PATTERN
from mango_core.knowledge import ID_PATTERN as SOURCE_ID_PATTERN

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
UNREAD_SHOWN = 99
"""The count stops here: the sidebar shows «99+» past it."""
_NO_STATE = NoticeState(read=False, archived=False)


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class InboxRun(_Strict):
    task_id: str
    run_id: str
    task_name: str
    ok: bool
    """Completed, or did not complete (failed)."""
    summary: str | None
    """First line of the report, plain text; only for its owner."""
    reason: str | None
    """Why it did not complete: a fixed code (the SPA has a text per code)."""


class InboxRemote(_Strict):
    registration_id: str
    """The remote MCP registration to connect from «Mis conexiones» (D98 (20)). Never a URL."""


Kind = Literal["approval", "kbsource", "run", "remote_connect"]


class InboxItem(_Strict):
    kind: Kind
    item_id: str
    agent_id: str | None
    """``None`` for a bucket proposal: it is not about an agent."""
    agent_name: str | None
    at: str
    read: bool
    archived: bool
    approval: ApprovalOut | None = None
    source: QueuedSourceOut | None = None
    run: InboxRun | None = None
    remote: InboxRemote | None = None
    """Set for ``remote_connect``, next to ``run``."""


class InboxPage(_Strict):
    items: list[InboxItem]
    """What the caller may sign first, approvals and bucket proposals (only on the first
    page), then run notices, newest first."""
    next_cursor: str | None
    unread: int
    can_decide: bool
    """Whether the caller may sign requests (hint; decided again on each decision)."""


class UnreadOut(_Strict):
    unread: int
    to_sign: int
    """What the caller may sign now (approvals and bucket proposals), read, archived or not:
    the sidebar's Gobernanza dot. Capped like ``unread``."""


class StateIn(_Strict):
    read: bool | None = None
    archived: bool | None = None

    @model_validator(mode="after")
    def _something(self) -> "StateIn":
        if self.read is None and self.archived is None:
            raise ValueError("read or archived is required")
        return self


class EmptyIn(_Strict):
    pass


InboxView = Literal["all", "unread", "approvals", "archived"]


# --- Use cases --------------------------------------------------------------------------


@dataclass
class InboxDeps:
    store: InboxStore
    published: PublishedAgents
    approvals: ApprovalDeps | None
    """``None`` while the approvals table is not deployed: no approval notices."""
    clock: Callable[[], datetime]
    sources: Callable[[Caller], list[QueuedSourceOut]] | None = None
    """The bucket proposals of Aprobaciones for the caller (D88 (48)); ``None`` without
    knowledge bases."""


def _unavailable() -> ApiError:
    logger.exception("inbox unavailable")
    return ApiError(503, "inbox_unavailable", "please try again")


def _agent_name(deps: InboxDeps, agent_id: str, names: dict[str, str | None]) -> str | None:
    if agent_id not in names:
        try:
            agent = deps.published.get(agent_id)
        except AgentUnavailableError:
            agent = None
        names[agent_id] = agent.definition.name if agent else None
    return names[agent_id]


def _signable(deps: InboxDeps, user_id: str, can_decide: bool) -> list[ApprovalOut]:
    """The pending requests the caller can sign now, newest first (the rule of D56)."""
    approvals = deps.approvals
    if approvals is None or not can_decide:
        return []
    now = approvals.clock()
    records: list[ApprovalRecord] = approvals.store.inbox(open_=True)
    shown = [
        approval_out(approvals, r, user_id, can_decide=True, now=now)
        for r in records
        if r.tier is Tier.APPROVERS and r.status is Status.PENDING and not r.expired(now)
    ]
    return [a for a in shown if a.can_sign]


def _approval_item(approval: ApprovalOut, state: NoticeState) -> InboxItem:
    return InboxItem(
        kind="approval",
        item_id=approval.approval_id,
        agent_id=approval.agent_id,
        agent_name=approval.agent_name,
        at=approval.created_at,
        read=state.read,
        archived=state.archived,
        approval=approval,
    )


def _signable_sources(deps: InboxDeps, caller: Caller) -> list[QueuedSourceOut]:
    """The bucket proposals the caller may sign now (D88 (49)), newest first."""
    if deps.sources is None:
        return []
    try:
        queued = deps.sources(caller)
    except ApiError:
        # Without the knowledge table the rest of the Bandeja is still answered.
        logger.warning("the bucket proposals could not be read for the inbox")
        return []
    signable = [s for s in queued if s.can_decide]
    return sorted(signable, key=lambda s: s.proposed_at, reverse=True)


def _source_item(source: QueuedSourceOut, state: NoticeState) -> InboxItem:
    return InboxItem(
        kind="kbsource",
        item_id=source.src_id,
        agent_id=None,
        agent_name=None,
        at=source.proposed_at.isoformat(),
        read=state.read,
        archived=state.archived,
        source=source,
    )


def _run_item(deps: InboxDeps, notice: RunNotice, names: dict[str, str | None]) -> InboxItem:
    return InboxItem(
        kind="remote_connect" if notice.remote_connect else "run",
        item_id=notice.notice_id,
        agent_id=notice.agent_id,
        agent_name=_agent_name(deps, notice.agent_id, names),
        at=notice.created_at,
        read=notice.read,
        archived=notice.archived,
        run=InboxRun(
            task_id=notice.task_id,
            run_id=notice.run_id,
            task_name=notice.task_name,
            ok=notice.ok,
            summary=notice.summary,
            reason=notice.reason,
        ),
        remote=InboxRemote(registration_id=notice.remote_connect)
        if notice.remote_connect
        else None,
    )


def _approval_visible(item: InboxItem, view: InboxView) -> bool:
    if view == "archived":
        return item.archived
    return not item.archived and (view != "unread" or not item.read)


def _unread(approvals: list[InboxItem], runs: int) -> int:
    return min(UNREAD_SHOWN, runs + sum(1 for a in approvals if not a.read and not a.archived))


def _approval_items(deps: InboxDeps, caller: Caller, can_decide: bool) -> list[InboxItem]:
    """What the caller may sign: approvals and bucket proposals, newest first."""
    user_id = caller.user.user_id
    signable = _signable(deps, user_id, can_decide)
    states = deps.store.approval_states(user_id) if signable else {}
    items = [_approval_item(a, states.get(a.approval_id, _NO_STATE)) for a in signable]
    sources = _signable_sources(deps, caller)
    if sources:
        kept = deps.store.approval_states(user_id, "kbsource")
        items += [_source_item(s, kept.get(s.src_id, _NO_STATE)) for s in sources]
    return sorted(items, key=lambda item: item.at, reverse=True)


def list_view(
    deps: InboxDeps, caller: Caller, view: InboxView, cursor: str | None, can_decide: bool
) -> InboxPage:
    user_id = caller.user.user_id
    names: dict[str, str | None] = {}
    try:
        approvals = _approval_items(deps, caller, can_decide)
        runs: list[RunNotice] = []
        next_cursor = None
        if view != "approvals":
            store_view: View = "all" if view == "all" else view
            runs, next_cursor = deps.store.page(user_id, view=store_view, cursor=cursor)
        unread = _unread(approvals, deps.store.unread_runs(user_id))
    except (InboxStoreUnavailableError, ClientError, BotoCoreError) as exc:
        raise _unavailable() from exc
    shown = (
        [a for a in approvals if _approval_visible(a, "all" if view == "approvals" else view)]
        if cursor is None
        else []
    )
    return InboxPage(
        items=[*shown, *(_run_item(deps, n, names) for n in runs)],
        next_cursor=next_cursor,
        unread=unread,
        can_decide=can_decide,
    )


def unread_view(deps: InboxDeps, caller: Caller, can_decide: bool) -> UnreadOut:
    user_id = caller.user.user_id
    try:
        approvals = _approval_items(deps, caller, can_decide)
        return UnreadOut(
            unread=_unread(approvals, deps.store.unread_runs(user_id)),
            to_sign=min(UNREAD_SHOWN, len(approvals)),
        )
    except (InboxStoreUnavailableError, ClientError, BotoCoreError) as exc:
        raise _unavailable() from exc


def set_state(
    deps: InboxDeps,
    caller: Caller,
    kind: Kind,
    item_id: str,
    body: StateIn,
    *,
    can_decide: bool,
) -> InboxItem:
    user_id = caller.user.user_id
    not_found = ApiError(404, "not_found", "notice not found")
    try:
        if kind in {"run", "remote_connect"}:
            if not NOTICE_ID_RE.fullmatch(item_id):
                raise not_found
            notice = deps.store.set_run_state(
                user_id, item_id, read=body.read, archived=body.archived
            )
            # Both kinds are run notices of the caller's own partition; the item says which.
            if notice is None:
                raise not_found
            return _run_item(deps, notice, {})
        if kind == "kbsource":
            # Only a proposal the caller can sign now: anything else is the same 404 (TM-I1).
            source = next((s for s in _signable_sources(deps, caller) if s.src_id == item_id), None)
            if source is None:
                raise not_found
            kept = deps.store.set_approval_state(
                user_id, item_id, read=body.read, archived=body.archived, kind="kbsource"
            )
            return _source_item(source, kept)
        # Only an approval the caller can sign now: anything else is the same 404 (TM-I1).
        approval = next(
            (a for a in _signable(deps, user_id, can_decide) if a.approval_id == item_id), None
        )
        if approval is None:
            raise not_found
        state = deps.store.set_approval_state(
            user_id, item_id, read=body.read, archived=body.archived
        )
        return _approval_item(approval, state)
    except (InboxStoreUnavailableError, ClientError, BotoCoreError) as exc:
        raise _unavailable() from exc


def read_all(deps: InboxDeps, caller: Caller, can_decide: bool) -> UnreadOut:
    user_id = caller.user.user_id
    try:
        for item in _approval_items(deps, caller, can_decide):
            if not item.read:
                deps.store.set_approval_state(
                    user_id,
                    item.item_id,
                    read=True,
                    archived=None,
                    kind="kbsource" if item.kind == "kbsource" else "approval",
                )
        deps.store.mark_runs_read(user_id)
    except (InboxStoreUnavailableError, ClientError, BotoCoreError) as exc:
        raise _unavailable() from exc
    return unread_view(deps, caller, can_decide)


# --- Notices of task runs ---------------------------------------------------------------


@dataclass
class RunInbox:
    """What the task worker calls when a run ends (``task_worker.TaskRuns``)."""

    store: InboxStore

    def run_ended(
        self,
        *,
        owner_id: str,
        task_id: str,
        task_name: str,
        agent_id: str,
        run_id: str,
        ok: bool,
        reason: str | None,
        report: str | None,
        remote_connect: str | None = None,
    ) -> None:
        """Leave the notice in the owner's partition. Never raises: the run is recorded in
        its table either way, and its detail shows it."""
        try:
            self.store.add_run(
                owner_id,
                task_id=task_id,
                run_id=run_id,
                task_name=task_name,
                agent_id=agent_id,
                ok=ok,
                summary=first_line(report) if ok else None,
                reason=None if ok else reason,
                remote_connect=remote_connect,
            )
        except Exception:
            # Without the notice's content: only that it could not be written.
            logger.exception("an inbox notice could not be written")


# --- Routes -----------------------------------------------------------------------------


Authorize = Callable[[Caller, str, str, str], Awaitable[None]]
CanDecide = Callable[[Caller], bool]


def inbox_router(
    deps: InboxDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
    can_decide: CanDecide,
) -> APIRouter:
    router = APIRouter(prefix="/api/inbox")

    async def view_inbox(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        await authorize(caller, "ViewInbox", *PLATFORM)
        return caller

    View_ = Annotated[Caller, Depends(view_inbox)]  # noqa: N806
    ItemId = Annotated[  # noqa: N806
        str,
        Path(pattern=f"(?:{NOTICE_ID_PATTERN})|(?:{APPROVAL_ID_PATTERN})|(?:{SOURCE_ID_PATTERN})"),
    ]

    async def decides(caller: Caller) -> bool:
        return deps.approvals is not None and await asyncio.to_thread(can_decide, caller)

    @router.get("", response_model=InboxPage)
    async def list_inbox(
        caller: View_,
        view: Annotated[InboxView, Query()] = "all",
        cursor: Annotated[str | None, Query(pattern=NOTICE_ID_PATTERN)] = None,
    ) -> InboxPage:
        return await asyncio.to_thread(list_view, deps, caller, view, cursor, await decides(caller))

    @router.get("/unread", response_model=UnreadOut)
    async def unread_inbox(caller: View_) -> UnreadOut:
        return await asyncio.to_thread(unread_view, deps, caller, await decides(caller))

    @router.post("/read-all", response_model=UnreadOut)
    async def read_all_inbox(_body: EmptyIn, caller: View_) -> UnreadOut:
        return await asyncio.to_thread(read_all, deps, caller, await decides(caller))

    @router.put("/{kind}/{item_id}", response_model=InboxItem)
    async def set_inbox_state(
        kind: Kind,
        item_id: ItemId,
        body: StateIn,
        caller: View_,
    ) -> InboxItem:
        return await asyncio.to_thread(
            set_state, deps, caller, kind, item_id, body, can_decide=await decides(caller)
        )

    return router
