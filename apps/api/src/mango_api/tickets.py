"""Tickets of Mango (D112): a board of work items people and agents create and follow.

A ticket has a title, a description, a status, a priority, an optional agent and an optional
assignee; comments in Markdown and its history. The record and its writes live in
``mango_core.tickets``: the tickets tool of the Gateway writes the same table. Threat model:
``docs/security/threat-models/tickets-threat-model.md``.

Security notes (security-best-practices, FastAPI):
* Every route declares its authorization (AUTH-001): ``ListTickets`` and ``CreateTicket`` on
  the platform; on the ticket itself ``ViewTicket``, ``EditTicket`` and ``CommentTicket``,
  decided by Cedar from the creator, the assignee and the agent's published groups and users
  (AUTHZ-001, TM-TK1). A ticket the caller may not see answers 404, not 403. A list is filtered
  ticket by ticket with one batch of decisions.
* Request models forbid extra fields (VALID-001): nobody sends a creator, a conversation, a
  source or «Por aprobar». «Por aprobar» is derived from an open approval (D56) of the
  conversation that created the ticket, requested by its creator (TM-TK7).
* Assigning is only to oneself or to someone who already takes part in the ticket (creator,
  assignee, whoever commented): the directory is never read nor revealed (D112, TM-TK4).
* Texts have size limits and are checked for credentials (D26); they are stored as text (the
  web renders Markdown without raw HTML) and never reach logs nor the audit trail, which
  carries ids, fields and sizes (TM-TK5, TM-TK6). Responses use explicit models (RESP-001);
  every write counts in a limit shared by the tasks of mango-api (D70).
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated, Any, Literal, Protocol

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from mango_api.agent_rules import find_secrets
from mango_api.approvals_store import OPEN_STATUSES
from mango_api.audit import AuditLog
from mango_api.authz import TICKET_TYPE, AgentResource, TicketResource
from mango_api.published import AgentUnavailableError, PublishedAgent, PublishedAgents
from mango_api.rate_limits import Limiter, RateLimitUnavailableError
from mango_api.web import ApiError, Caller, rate_limited
from mango_core import tickets as core
from mango_core.agents import AGENT_ID_PATTERN
from mango_core.tickets import (
    MAX_COMMENT,
    MAX_DESCRIPTION,
    MAX_TITLE,
    NEEDS_APPROVAL,
    Change,
    Priority,
    Source,
    Status,
    Ticket,
    TicketConflictError,
    TicketLimitError,
    TicketStore,
    TicketStoreUnavailableError,
)

if TYPE_CHECKING:
    from mango_api.approvals_store import ApprovalRecord, ApprovalStore

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
CREATES_PER_HOUR = 30
CHANGES_PER_HOUR = 120
COMMENTS_PER_HOUR = 60
MAX_QUERY = 100

StatusIn = Literal["open", "in_progress", "done"]
StatusOut = Literal["open", "in_progress", "needs_approval", "done"]
PriorityIn = Literal["high", "medium", "low"]
QuickView = Literal["all", "mine", "unassigned", "high"]
_USER_ID = r"^[A-Za-z0-9-]{1,64}$"


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TicketIn(_Strict):
    title: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_TITLE)
    ]
    description: Annotated[str, StringConstraints(max_length=MAX_DESCRIPTION)] = ""
    priority: PriorityIn = "medium"
    status: StatusIn = "open"
    agent_id: Annotated[str, StringConstraints(pattern=AGENT_ID_PATTERN)] | None = None
    assign_to_me: bool = False
    """The only assignee a new ticket may have: nobody else takes part yet (D112)."""


class TicketChangeIn(_Strict):
    version: Annotated[int, Field(ge=1)]
    """The version that was read: a change on an older one is refused (409)."""
    status: StatusIn | None = None
    priority: PriorityIn | None = None
    assignee_id: Annotated[str, StringConstraints(pattern=_USER_ID)] | None = None
    """Present and ``null`` unassigns; absent leaves the assignee as it is."""


class CommentIn(_Strict):
    body: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_COMMENT)
    ]


class PersonOut(_Strict):
    user_id: str
    email: str | None


class TicketOut(_Strict):
    ticket_id: str
    title: str
    status: StatusOut
    """``needs_approval`` while an approval of its conversation waits (D56), else as chosen."""
    priority: PriorityIn
    agent_id: str | None
    agent_name: str | None
    creator: PersonOut
    assignee: PersonOut | None
    source: Literal["web", "agent", "task"]
    created_at: str
    updated_at: str
    version: int
    comment_count: int
    approval_id: str | None
    """The approval that keeps it «Por aprobar» («Revisar en Aprobaciones»)."""


class CommentOut(_Strict):
    comment_id: str
    author: PersonOut
    body: str
    created_at: str


class EventOut(_Strict):
    actor: PersonOut
    action: Literal["created", "changed", "commented"]
    field: Literal["status", "priority", "assignee"] | None
    before: str | None
    after: str | None
    created_at: str


class TicketDetailOut(TicketOut):
    description: str
    comments: list[CommentOut]
    history: list[EventOut]
    participants: list[PersonOut]
    """Who it may be assigned to, besides the caller (D112)."""


class QuickCountsOut(_Strict):
    all: int
    mine: int
    unassigned: int
    high: int


class TicketListOut(_Strict):
    items: list[TicketOut]
    counts: QuickCountsOut
    """Of the quick views, over the tickets that match the other filters."""


# --- Use cases --------------------------------------------------------------------------


class AuthorizeTicket(Protocol):
    def __call__(
        self,
        caller: Caller,
        action: str,
        resource_type: str,
        resource_id: str,
        *,
        read_only: bool = ...,
        context: dict[str, str] | None = ...,
        agent: AgentResource | None = ...,
        ticket: TicketResource | None = ...,
    ) -> Awaitable[None]: ...


@dataclass
class TicketsDeps:
    store: TicketStore
    published: PublishedAgents
    audit: AuditLog
    creates: Limiter
    changes: Limiter
    comments: Limiter
    approvals: "ApprovalStore | None" = None
    """Where «Por aprobar» comes from (D56); without it no ticket is «Por aprobar»."""
    clock: Callable[[], float] = time.time


def _unavailable(exc: Exception) -> ApiError:
    logger.error("tickets unavailable: %s", type(exc).__name__)
    return ApiError(503, "tickets_unavailable", "please try again")


def _limit(limiter: Limiter, key: str) -> None:
    try:
        allowed = limiter.allow(key)
    except RateLimitUnavailableError as exc:
        raise ApiError(503, "rate_limit_unavailable", "please try again") from exc
    if not allowed:
        raise rate_limited(limiter.retry_after(key))


def _check_secrets(*texts: str) -> None:
    if find_secrets("\n".join(texts)):
        # D26: the same validation as an agent's prompt; the match is never repeated.
        raise ApiError(422, "secret_in_ticket", "the text contains what looks like a credential")


def _audit(deps: TicketsDeps, event: str, caller: Caller, **detail: Any) -> None:
    """Fail closed: a change that cannot be audited is not made (rule 4). Never the texts."""
    try:
        deps.audit.emit(event, caller.user.user_id, detail, caller.user)
    except Exception as exc:
        raise ApiError(503, "audit_unavailable", "the change could not be audited; retry") from exc


class Agents:
    """The published agents a request needs, each read once."""

    def __init__(self, published: PublishedAgents) -> None:
        self._published = published
        self._seen: dict[str, PublishedAgent | None] = {}

    def get(self, agent_id: str) -> PublishedAgent | None:
        if agent_id not in self._seen:
            try:
                self._seen[agent_id] = self._published.get(agent_id)
            except AgentUnavailableError as exc:
                raise _unavailable(exc) from exc
        return self._seen[agent_id]

    def resource(self, agent_id: str) -> AgentResource:
        """As UseAgent sees it: the published version's groups and users; a retired or missing
        agent has none, so only the ticket's people and administrators keep seeing it."""
        agent = self.get(agent_id)
        if agent is None or agent.retired:
            return AgentResource(agent_id)
        return AgentResource(
            agent_id,
            groups=frozenset(agent.definition.groups),
            users=frozenset(agent.definition.users),
        )

    def name(self, agent_id: str | None) -> str | None:
        agent = self.get(agent_id) if agent_id else None
        return agent.definition.name if agent is not None else None


def ticket_resource(ticket: Ticket, agents: Agents) -> TicketResource:
    return TicketResource(
        ticket.ticket_id,
        ticket.creator_id,
        ticket.assignee_id,
        agents.resource(ticket.agent_id) if ticket.agent_id else None,
    )


def _open_approvals(deps: TicketsDeps, user_id: str) -> "list[ApprovalRecord]":
    if deps.approvals is None:
        return []
    now = datetime.fromtimestamp(deps.clock(), UTC)
    try:
        records = deps.approvals.by_requester(user_id)
    except Exception:  # noqa: BLE001 - a hint: any failure leaves the board as chosen
        # «Por aprobar» is a hint of the board; the ticket is still shown as it was chosen.
        logger.warning("approvals could not be read for the tickets board")
        return []
    return [r for r in records if r.status in OPEN_STATUSES and not r.expired(now)]


def pending_approvals(deps: TicketsDeps, tickets: Sequence[Ticket]) -> dict[str, str]:
    """Ticket id → the open approval of its conversation (D56, D112): requested by its creator,
    for its agent, in the conversation that created it. Read once per creator."""
    linked = [t for t in tickets if t.conversation_id and t.agent_id and t.status != Status.DONE]
    by_creator: dict[str, list[ApprovalRecord]] = {}
    found: dict[str, str] = {}
    for ticket in linked:
        if ticket.creator_id not in by_creator:
            by_creator[ticket.creator_id] = _open_approvals(deps, ticket.creator_id)
        for record in by_creator[ticket.creator_id]:
            if (
                record.conversation_id == ticket.conversation_id
                and record.agent_id == ticket.agent_id
            ):
                found[ticket.ticket_id] = record.approval_id
                break
    return found


def _person(ticket: Ticket, user_id: str) -> PersonOut:
    return PersonOut(user_id=user_id, email=ticket.email_of(user_id))


def ticket_out(ticket: Ticket, agents: Agents, approval_id: str | None) -> TicketOut:
    status: StatusOut = NEEDS_APPROVAL if approval_id else ticket.status.value
    return TicketOut(
        ticket_id=ticket.ticket_id,
        title=ticket.title,
        status=status,
        priority=ticket.priority.value,
        agent_id=ticket.agent_id,
        agent_name=agents.name(ticket.agent_id),
        creator=_person(ticket, ticket.creator_id),
        assignee=_person(ticket, ticket.assignee_id) if ticket.assignee_id else None,
        source=ticket.source.value,
        created_at=ticket.created_at,
        updated_at=ticket.updated_at,
        version=ticket.version,
        comment_count=ticket.comment_count,
        approval_id=approval_id,
    )


def detail_out(
    deps: TicketsDeps, ticket: Ticket, agents: Agents, approval_id: str | None
) -> TicketDetailOut:
    try:
        comments = deps.store.comments(ticket.ticket_id)
        history = deps.store.history(ticket.ticket_id)
    except TicketStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    base = ticket_out(ticket, agents, approval_id)
    return TicketDetailOut(
        **base.model_dump(),
        description=ticket.description,
        comments=[
            CommentOut(
                comment_id=c.comment_id,
                author=PersonOut(user_id=c.author_id, email=c.author_email),
                body=c.body,
                created_at=c.created_at,
            )
            for c in comments
        ],
        history=[
            EventOut(
                actor=PersonOut(user_id=e.actor_id, email=e.actor_email),
                action=e.action,  # type: ignore[arg-type]
                field=e.field,  # type: ignore[arg-type]
                before=e.before,
                after=e.after,
                created_at=e.created_at,
            )
            for e in history
        ],
        participants=[
            PersonOut(user_id=u, email=email) for u, email in sorted(ticket.people.items())
        ],
    )


def create_ticket(deps: TicketsDeps, caller: Caller, body: TicketIn) -> Ticket:
    _check_secrets(body.title, body.description)
    user = caller.user
    now = core.now_iso()
    ticket = Ticket(
        ticket_id=core.new_ticket_id(),
        title=body.title,
        description=body.description.strip(),
        status=Status(body.status),
        priority=Priority(body.priority),
        creator_id=user.user_id,
        created_at=now,
        updated_at=now,
        source=Source.WEB,
        agent_id=body.agent_id,
        assignee_id=user.user_id if body.assign_to_me else None,
        people={user.user_id: user.email},
    )
    detail = {
        "ticket_id": ticket.ticket_id,
        "agent": ticket.agent_id,
        "source": ticket.source.value,
        "status": ticket.status.value,
        "priority": ticket.priority.value,
        "assigned": ticket.assignee_id is not None,
        "title_chars": len(ticket.title),
        "description_chars": len(ticket.description),
    }
    _audit(deps, "ticket.create", caller, **detail, outcome="requested")
    try:
        deps.store.create(ticket)
    except TicketConflictError as exc:
        raise ApiError(409, "ticket_conflict", "please try again") from exc
    except TicketStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    _audit(deps, "ticket.create", caller, **detail, outcome="applied")
    return ticket


def _check_assignee(ticket: Ticket, caller: Caller, assignee_id: str | None) -> None:
    """D112: oneself or someone who already takes part; the same answer whether the id exists
    or not, and the directory is never read (TM-TK4)."""
    if assignee_id is None or assignee_id == caller.user.user_id:
        return
    if assignee_id not in ticket.people:
        raise ApiError(
            422, "assignee_not_participant", "a ticket is assigned to oneself or a participant"
        )


def update_ticket(
    deps: TicketsDeps, caller: Caller, ticket: Ticket, body: TicketChangeIn
) -> Ticket:
    if body.version != ticket.version:
        raise ApiError(409, "ticket_changed", "the ticket changed; reload it")
    assign = "assignee_id" in body.model_fields_set
    if assign:
        _check_assignee(ticket, caller, body.assignee_id)
    change = Change(
        status=Status(body.status) if body.status else None,
        priority=Priority(body.priority) if body.priority else None,
        assignee_id=body.assignee_id,
        assign=assign,
    )
    fields = [
        name
        for name, given in (
            ("status", change.status is not None and change.status != ticket.status),
            ("priority", change.priority is not None and change.priority != ticket.priority),
            ("assignee", assign and change.assignee_id != ticket.assignee_id),
        )
        if given
    ]
    if not fields:
        return ticket
    detail: dict[str, Any] = {
        "ticket_id": ticket.ticket_id,
        "agent": ticket.agent_id,
        "fields": fields,
    }
    if "status" in fields:
        detail |= {"status_from": ticket.status.value, "status_to": body.status}
    if "priority" in fields:
        detail |= {"priority_from": ticket.priority.value, "priority_to": body.priority}
    if "assignee" in fields:
        detail |= {"assignee_from": ticket.assignee_id, "assignee_to": body.assignee_id}
    _audit(deps, "ticket.update", caller, **detail, outcome="requested")
    try:
        updated = deps.store.update(
            ticket, change, actor_id=caller.user.user_id, actor_email=caller.user.email
        )
    except TicketConflictError as exc:
        raise ApiError(409, "ticket_changed", "the ticket changed; reload it") from exc
    except TicketStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    _audit(deps, "ticket.update", caller, **detail, outcome="applied")
    return updated


def comment_ticket(
    deps: TicketsDeps, caller: Caller, ticket: Ticket, body: CommentIn
) -> core.Comment:
    _check_secrets(body.body)
    detail = {"ticket_id": ticket.ticket_id, "agent": ticket.agent_id, "chars": len(body.body)}
    _audit(deps, "ticket.comment", caller, **detail, outcome="requested")
    try:
        comment = deps.store.comment(
            ticket.ticket_id,
            body.body,
            author_id=caller.user.user_id,
            author_email=caller.user.email,
        )
    except TicketLimitError as exc:
        raise ApiError(409, "ticket_comment_limit", "this ticket takes no more comments") from exc
    except TicketConflictError as exc:
        raise HTTPException(status_code=404, detail="not found") from exc
    except TicketStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    _audit(
        deps, "ticket.comment", caller, **detail, comment_id=comment.comment_id, outcome="applied"
    )
    return comment


def candidates(deps: TicketsDeps, caller: Caller) -> list[Ticket]:
    """The person's own tickets and the ones changed last; Cedar decides which are shown."""
    user_id = caller.user.user_id
    try:
        found = [
            *deps.store.created_by(user_id),
            *deps.store.assigned_to(user_id),
            *deps.store.recent(),
        ]
    except TicketStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    unique = {t.ticket_id: t for t in found}
    return sorted(unique.values(), key=lambda t: t.updated_at, reverse=True)


@dataclass(frozen=True)
class Filters:
    view: QuickView
    status: frozenset[str]
    priority: frozenset[str]
    agent: str | None
    assignee: str | None
    """A user id, or ``none`` for unassigned."""
    query: str


def _quick(view: QuickView, item: TicketOut, user_id: str) -> bool:
    if view == "mine":
        return item.assignee is not None and item.assignee.user_id == user_id
    if view == "unassigned":
        return item.assignee is None
    if view == "high":
        return item.priority == "high" and item.status != "done"
    return True


def _matches(filters: Filters, item: TicketOut) -> bool:
    if filters.status and item.status not in filters.status:
        return False
    if filters.priority and item.priority not in filters.priority:
        return False
    if filters.agent and item.agent_id != filters.agent:
        return False
    if filters.assignee == "none" and item.assignee is not None:
        return False
    if (
        filters.assignee
        and filters.assignee != "none"
        and (item.assignee is None or item.assignee.user_id != filters.assignee)
    ):
        return False
    query = filters.query.casefold()
    return not query or query in item.title.casefold() or query in item.ticket_id


def listing(
    items: list[TicketOut], filters: Filters, user_id: str
) -> tuple[list[TicketOut], QuickCountsOut]:
    matching = [i for i in items if _matches(filters, i)]
    counts = QuickCountsOut(
        **{
            view: sum(1 for i in matching if _quick(view, i, user_id))
            for view in ("all", "mine", "unassigned", "high")
        }
    )
    return [i for i in matching if _quick(filters.view, i, user_id)], counts


# --- Router -------------------------------------------------------------------------------


def tickets_router(  # noqa: PLR0915 - registers the route closures
    deps: TicketsDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: AuthorizeTicket,
    allowed: Callable[[Caller, str, list[TicketResource]], frozenset[str]],
    is_allowed: Callable[[Caller, str, str, str, TicketResource], bool],
) -> APIRouter:
    """``allowed``: the ids of a list the caller may see (one batch, not audited one by one:
    the list itself is authorized and audited). ``is_allowed``: one decision that only shapes
    the answer (404), audited as a read."""
    router = APIRouter(prefix="/api/tickets")
    TicketId = Annotated[str, Path(pattern=core.ID_PATTERN)]  # noqa: N806

    async def run[T](fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        return await asyncio.to_thread(fn, *args, **kwargs)

    async def lister(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        await authorize(caller, "ListTickets", *PLATFORM, read_only=True)
        return caller

    async def creator(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        await authorize(caller, "CreateTicket", *PLATFORM)
        return caller

    async def signed_in(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        return caller

    Lister = Annotated[Caller, Depends(lister)]  # noqa: N806
    Creator = Annotated[Caller, Depends(creator)]  # noqa: N806
    SignedIn = Annotated[Caller, Depends(signed_in)]  # noqa: N806

    async def load(caller: Caller, ticket_id: str, action: str) -> tuple[Ticket, Agents]:
        """The ticket, if the caller may ``action`` it; 404 for anyone who may not even see it."""
        try:
            ticket = await run(deps.store.get, ticket_id)
        except TicketStoreUnavailableError as exc:
            raise _unavailable(exc) from exc
        if ticket is None:
            raise HTTPException(status_code=404, detail="not found")
        agents = Agents(deps.published)
        resource = await run(ticket_resource, ticket, agents)
        if action != "ViewTicket" and not await run(
            is_allowed, caller, "ViewTicket", TICKET_TYPE, ticket_id, resource
        ):
            raise HTTPException(status_code=404, detail="not found")
        try:
            await authorize(caller, action, TICKET_TYPE, ticket_id, ticket=resource)
        except HTTPException as exc:
            if action == "ViewTicket":
                raise HTTPException(status_code=404, detail="not found") from exc
            raise
        return ticket, agents

    async def detail(ticket: Ticket, agents: Agents) -> TicketDetailOut:
        approvals = await run(pending_approvals, deps, [ticket])
        return await run(detail_out, deps, ticket, agents, approvals.get(ticket.ticket_id))

    @router.get("", response_model=TicketListOut)
    async def list_tickets(
        caller: Lister,
        *,
        view: QuickView = "all",
        status: Annotated[list[StatusOut] | None, Query(max_length=4)] = None,
        priority: Annotated[list[PriorityIn] | None, Query(max_length=3)] = None,
        agent: Annotated[str | None, Query(pattern=AGENT_ID_PATTERN)] = None,
        assignee: Annotated[str | None, Query(pattern=r"^(?:none|[A-Za-z0-9-]{1,64})$")] = None,
        q: Annotated[str, Query(max_length=MAX_QUERY)] = "",
    ) -> TicketListOut:
        found = await run(candidates, deps, caller)
        agents = Agents(deps.published)
        resources = [await run(ticket_resource, t, agents) for t in found]
        visible = await run(allowed, caller, "ViewTicket", resources)
        shown = [t for t in found if t.ticket_id in visible]
        approvals = await run(pending_approvals, deps, shown)
        items = [ticket_out(t, agents, approvals.get(t.ticket_id)) for t in shown]
        filters = Filters(
            view=view,
            status=frozenset(status or ()),
            priority=frozenset(priority or ()),
            agent=agent,
            assignee=assignee,
            query=q.strip(),
        )
        listed, counts = listing(items, filters, caller.user.user_id)
        return TicketListOut(items=listed, counts=counts)

    @router.post("", response_model=TicketDetailOut, status_code=201)
    async def create_new_ticket(body: TicketIn, caller: Creator) -> TicketDetailOut:
        _limit(deps.creates, caller.user.user_id)
        agents = Agents(deps.published)
        if body.agent_id is not None:
            # Naming an agent shares the ticket with whoever may use it: only an agent the
            # caller may use, and only while it is published.
            resource = await run(agents.resource, body.agent_id)
            await authorize(caller, "UseAgent", "Mango::Agent", body.agent_id, agent=resource)
            served = await run(agents.get, body.agent_id)
            if served is None or served.retired:
                raise ApiError(409, "agent_unavailable", "this agent is not published")
        ticket = await run(create_ticket, deps, caller, body)
        return await detail(ticket, agents)

    @router.get("/{ticket_id}", response_model=TicketDetailOut)
    async def get_ticket(ticket_id: TicketId, caller: SignedIn) -> TicketDetailOut:
        ticket, agents = await load(caller, ticket_id, "ViewTicket")
        return await detail(ticket, agents)

    @router.patch("/{ticket_id}", response_model=TicketDetailOut)
    async def change_ticket(
        ticket_id: TicketId, body: TicketChangeIn, caller: SignedIn
    ) -> TicketDetailOut:
        ticket, agents = await load(caller, ticket_id, "EditTicket")
        _limit(deps.changes, caller.user.user_id)
        updated = await run(update_ticket, deps, caller, ticket, body)
        return await detail(updated, agents)

    @router.post("/{ticket_id}/comments", response_model=TicketDetailOut, status_code=201)
    async def add_comment(
        ticket_id: TicketId, body: CommentIn, caller: SignedIn
    ) -> TicketDetailOut:
        ticket, agents = await load(caller, ticket_id, "CommentTicket")
        _limit(deps.comments, caller.user.user_id)
        await run(comment_ticket, deps, caller, ticket, body)
        try:
            current = await run(deps.store.get, ticket_id)
        except TicketStoreUnavailableError as exc:
            raise _unavailable(exc) from exc
        return await detail(current or ticket, agents)

    return router
