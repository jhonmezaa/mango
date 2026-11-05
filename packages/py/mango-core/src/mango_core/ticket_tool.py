"""The tickets tool of the Gateway (D112 (8), (9)): its arguments and what each call writes.

Shared by mango-api, which validates a call before it asks the person to confirm it and
decides it with Cedar (``CreateTicket``, ``EditTicket``, ``CommentTicket``), and the approval
executor, which runs it once the approval token verifies. Needs the ``agents`` extra
(pydantic).

* The ticket of ``create_ticket`` gets an id derived from the approval (``ticket_id_for``): a
  second delivery of the same approved call finds it and writes nothing new, and mango-api
  knows the id to audit without reading the result.
* The person is always the one of the verified token, never an argument: an agent assigns a
  ticket only to the person it talks to (D112 (3)).
* What the tool answers names the ticket and its status, never what other people wrote: the
  agent does not read tickets (D112 (9)).
"""

from __future__ import annotations

import base64
import hashlib
from typing import Annotated, Any, Final, Literal

from pydantic import BaseModel, ConfigDict, StringConstraints

from mango_core.identity import UserContext
from mango_core.tickets import (
    ID_LENGTH,
    ID_PATTERN,
    MAX_COMMENT,
    MAX_DESCRIPTION,
    MAX_TITLE,
    Change,
    Priority,
    Source,
    Status,
    Ticket,
    TicketConflictError,
    TicketLimitError,
    TicketStore,
    now_iso,
)

SERVER_ID: Final = "mango-tickets"
CREATE: Final = "create_ticket"
UPDATE: Final = "update_ticket"
COMMENT: Final = "comment_ticket"
TOOLS: Final = (CREATE, UPDATE, COMMENT)
ACTIONS: Final = {CREATE: "CreateTicket", UPDATE: "EditTicket", COMMENT: "CommentTicket"}
"""The Cedar action mango-api decides for each tool (D112 (9))."""
AUDIT_EVENTS: Final = {CREATE: "ticket.create", UPDATE: "ticket.update", COMMENT: "ticket.comment"}


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


TicketId = Annotated[str, StringConstraints(pattern=ID_PATTERN)]


class CreateArgs(_Strict):
    title: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_TITLE)
    ]
    description: Annotated[str, StringConstraints(max_length=MAX_DESCRIPTION)] = ""
    priority: Literal["high", "medium", "low"] = "medium"


class UpdateArgs(_Strict):
    ticket_id: TicketId
    status: Literal["open", "in_progress", "done"] | None = None
    priority: Literal["high", "medium", "low"] | None = None
    assign_to_me: bool = False


class CommentArgs(_Strict):
    ticket_id: TicketId
    body: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_COMMENT)
    ]


ARGS: Final[dict[str, type[_Strict]]] = {
    CREATE: CreateArgs,
    UPDATE: UpdateArgs,
    COMMENT: CommentArgs,
}


class ToolFailedError(Exception):
    """The call cannot be applied; ``code`` is what the model and the audit see."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def ticket_id_for(approval_id: str) -> str:
    """The id of the ticket an approved ``create_ticket`` writes: random as the approval it
    comes from (128 bits), never incremental, and the same on every delivery."""
    digest = hashlib.sha256(b"mango-ticket." + approval_id.encode()).digest()
    return base64.b32encode(digest).decode().lower()[:ID_LENGTH]


def parse(tool: str, arguments: dict[str, Any]) -> _Strict:
    """Raises ``pydantic.ValidationError`` for anything the schema does not allow."""
    return ARGS[tool].model_validate(arguments)


def texts(args: _Strict) -> tuple[str, ...]:
    """The free texts of a call, to check them for credentials (D26)."""
    if isinstance(args, CreateArgs):
        return (args.title, args.description)
    if isinstance(args, CommentArgs):
        return (args.body,)
    return ()


def _answer(ticket: Ticket) -> dict[str, Any]:
    return {
        "status": "ok",
        "ticket_id": ticket.ticket_id,
        "title": ticket.title,
        "ticket_status": ticket.status.value,
        "priority": ticket.priority.value,
    }


def run(
    store: TicketStore,
    tool: str,
    args: _Strict,
    *,
    user: UserContext,
    approval_id: str,
    agent_id: str,
    conversation_id: str | None,
) -> dict[str, Any]:
    """Apply one approved call as ``user``. Raises ``ToolFailedError``."""
    if isinstance(args, CreateArgs):
        return _create(store, args, user, approval_id, agent_id, conversation_id)
    ticket = store.get(args.ticket_id) if isinstance(args, (UpdateArgs, CommentArgs)) else None
    if ticket is None:
        raise ToolFailedError("ticket_not_found", "there is no such ticket")
    if isinstance(args, UpdateArgs):
        change = Change(
            status=Status(args.status) if args.status else None,
            priority=Priority(args.priority) if args.priority else None,
            assignee_id=user.user_id if args.assign_to_me else None,
            assign=args.assign_to_me,
        )
        try:
            return _answer(
                store.update(ticket, change, actor_id=user.user_id, actor_email=user.email)
            )
        except TicketConflictError as exc:
            raise ToolFailedError(
                "ticket_changed", "the ticket changed; nothing was applied"
            ) from exc
    if isinstance(args, CommentArgs):
        try:
            store.comment(
                ticket.ticket_id, args.body, author_id=user.user_id, author_email=user.email
            )
        except TicketLimitError as exc:
            raise ToolFailedError(
                "ticket_comment_limit", "this ticket takes no more comments"
            ) from exc
        except TicketConflictError as exc:
            raise ToolFailedError("ticket_not_found", "there is no such ticket") from exc
        return _answer(ticket)
    raise ToolFailedError("invalid_arguments", "invalid arguments")


def _create(  # noqa: PLR0917 - the parts of one approved call, all required
    store: TicketStore,
    args: CreateArgs,
    user: UserContext,
    approval_id: str,
    agent_id: str,
    conversation_id: str | None,
) -> dict[str, Any]:
    now = now_iso()
    ticket = Ticket(
        ticket_id=ticket_id_for(approval_id),
        title=args.title,
        description=args.description.strip(),
        status=Status.OPEN,
        priority=Priority(args.priority),
        creator_id=user.user_id,
        created_at=now,
        updated_at=now,
        source=Source.AGENT,
        agent_id=agent_id,
        people={user.user_id: user.email},
        conversation_id=conversation_id,
    )
    try:
        store.create(ticket)
    except TicketConflictError:
        # The same approved call delivered again: its ticket is already there.
        existing = store.get(ticket.ticket_id)
        if existing is None or existing.creator_id != user.user_id:
            raise ToolFailedError("ticket_conflict", "the ticket could not be created") from None
        return _answer(existing)
    return _answer(ticket)
