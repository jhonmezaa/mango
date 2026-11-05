"""Tickets of Mango (D112): the record shared by mango-api and the tickets tool of the Gateway.

Table ``Mango-<ns>-Tickets``, all under ``PK = TICKET#<id>``:

* ``SK = META``: the ticket. ``creator_id`` is the verified subject of whoever created it and
  never changes. ``people`` maps every participant (creator, assignee, whoever commented) to
  the email their own token carried, so a ticket can be assigned to them without reading the
  directory (D112, «Sin revelar si un usuario existe»). ``status`` is what a person chose
  (``open``, ``in_progress``, ``done``); «Por aprobar» is never stored: mango-api derives it
  from an open approval of ``conversation_id`` (D56). ``version`` grows with each change and
  is the condition of the next one (no lost updates).
* ``SK = COMMENT#<created_at>#<random>``: a comment in Markdown, stored as text.
* ``SK = EVENT#<created_at>#<random>``: the history (who changed what, from and to). Never
  the text of a title, a description or a comment.

Indexes, all sorted by ``updated_at``: ``ByUpdated`` (``all_pk`` = ``TICKET``), ``ByCreator``
(``creator_id``) and ``ByAssignee`` (``assignee_id``, only assigned tickets). Keep in sync with
``infra/lib/constructs/tickets.ts``.

Every write is conditional: the condition, not the code before it, is what keeps a ticket from
being overwritten by an older read or from growing past its limits. The content never reaches
logs: errors carry codes only.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from dataclasses import replace as _replace
from datetime import UTC, datetime
from enum import StrEnum
from typing import TYPE_CHECKING, Any, Final

from botocore.exceptions import BotoCoreError, ClientError

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

INDEX_BY_UPDATED: Final = "ByUpdated"
INDEX_BY_CREATOR: Final = "ByCreator"
INDEX_BY_ASSIGNEE: Final = "ByAssignee"
ALL_PK: Final = "TICKET"
SK_META: Final = "META"
_COMMENT: Final = "COMMENT#"
_EVENT: Final = "EVENT#"

_ID_ALPHABET: Final = "abcdefghijklmnopqrstuvwxyz234567"
ID_LENGTH: Final = 12
"""60 random bits: short enough to read aloud, never incremental (D112)."""
ID_PATTERN: Final = rf"^[a-z2-7]{{{ID_LENGTH}}}$"

MAX_TITLE: Final = 200
MAX_DESCRIPTION: Final = 8000
MAX_COMMENT: Final = 4000
MAX_COMMENTS: Final = 200
"""Comments per ticket: past it the ticket takes no more (the design shows them all)."""
MAX_EVENTS_SHOWN: Final = 200
MAX_LISTED: Final = 300
"""Tickets read for one list, per index (newest change first)."""
_PAGE: Final = 100


class Status(StrEnum):
    """What a person may choose. «Por aprobar» (``needs_approval``) is derived, never stored."""

    OPEN = "open"
    IN_PROGRESS = "in_progress"
    DONE = "done"


NEEDS_APPROVAL: Final = "needs_approval"


class Priority(StrEnum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class Source(StrEnum):
    WEB = "web"
    AGENT = "agent"
    """Created by an agent with the tickets tool, confirmed by the person (D56)."""
    TASK = "task"
    """Created by a run of a task, as its owner (D78)."""


class TicketConflictError(Exception):
    """The ticket changed since it was read, or a condition refused the write."""


class TicketLimitError(Exception):
    """The ticket takes no more comments."""


class TicketStoreUnavailableError(Exception):
    """DynamoDB could not be read or written."""


@dataclass(frozen=True)
class Ticket:
    ticket_id: str
    title: str
    description: str
    status: Status
    priority: Priority
    creator_id: str
    created_at: str
    updated_at: str
    source: Source = Source.WEB
    agent_id: str | None = None
    assignee_id: str | None = None
    people: dict[str, str | None] = field(default_factory=dict)
    """Participants and the email of their own token (``None`` if it had none)."""
    conversation_id: str | None = None
    """The conversation of the agent that created it, signed by mango-api (D112, PR B)."""
    task_id: str | None = None
    version: int = 1
    comment_count: int = 0

    def email_of(self, user_id: str | None) -> str | None:
        return self.people.get(user_id) if user_id else None


@dataclass(frozen=True)
class Comment:
    comment_id: str
    author_id: str
    author_email: str | None
    body: str
    created_at: str


@dataclass(frozen=True)
class Event:
    """One line of the history: ``action`` is ``created``, ``changed`` or ``commented``."""

    actor_id: str
    actor_email: str | None
    action: str
    created_at: str
    field: str | None = None
    before: str | None = None
    after: str | None = None


@dataclass(frozen=True)
class Change:
    """What one update changes: only the fields given (``assignee`` may be set to ``None``)."""

    status: Status | None = None
    priority: Priority | None = None
    assignee_id: str | None = None
    assign: bool = False
    """Whether ``assignee_id`` is part of the change (``None`` then unassigns)."""


def new_ticket_id() -> str:
    """Random public id (D112, never incremental)."""
    return "".join(secrets.choice(_ID_ALPHABET) for _ in range(ID_LENGTH))


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: int) -> dict[str, str]:
    return {"N": str(value)}


def _str(item: dict[str, Any], name: str) -> str | None:
    value = item.get(name, {}).get("S")
    return str(value) if value is not None else None


def _pk(ticket_id: str) -> str:
    return f"TICKET#{ticket_id}"


def _sort_suffix(created_at: str, position: int = 0) -> str:
    """Time first, then the order inside one write (several lines share its time)."""
    return f"{created_at}#{position:02d}{secrets.token_hex(4)}"


def _people(item: dict[str, Any]) -> dict[str, str | None]:
    raw = item.get("people", {}).get("M", {})
    return {user: (v.get("S") or None) for user, v in raw.items()}


def _ticket(item: dict[str, Any]) -> Ticket:
    return Ticket(
        ticket_id=str(_str(item, "ticket_id")),
        title=str(_str(item, "title")),
        description=_str(item, "description") or "",
        status=Status(str(_str(item, "status"))),
        priority=Priority(str(_str(item, "priority"))),
        creator_id=str(_str(item, "creator_id")),
        created_at=str(_str(item, "created_at")),
        updated_at=str(_str(item, "updated_at")),
        source=Source(_str(item, "source") or Source.WEB),
        agent_id=_str(item, "agent_id"),
        assignee_id=_str(item, "assignee_id"),
        people=_people(item),
        conversation_id=_str(item, "conversation_id"),
        task_id=_str(item, "task_id"),
        version=int(item.get("version", {}).get("N", "1")),
        comment_count=int(item.get("comment_count", {}).get("N", "0")),
    )


def _event_item(ticket_id: str, event: Event, position: int = 0) -> dict[str, Any]:
    item: dict[str, Any] = {
        "PK": _s(_pk(ticket_id)),
        "SK": _s(_EVENT + _sort_suffix(event.created_at, position)),
        "actor_id": _s(event.actor_id),
        "action": _s(event.action),
        "created_at": _s(event.created_at),
    }
    for name, value in (
        ("actor_email", event.actor_email),
        ("field", event.field),
        ("before", event.before),
        ("after", event.after),
    ):
        if value is not None:
            item[name] = _s(value)
    return item


def _conditional(exc: ClientError) -> bool:
    code = exc.response.get("Error", {}).get("Code", "")
    return code in ("ConditionalCheckFailedException", "TransactionCanceledException")


class TicketStore:
    def __init__(self, client: DynamoDBClient, table: str) -> None:
        self._db = client
        self._table = table

    # --- Reads --------------------------------------------------------------------------

    def get(self, ticket_id: str) -> Ticket | None:
        try:
            item = self._db.get_item(
                TableName=self._table,
                Key={"PK": _s(_pk(ticket_id)), "SK": _s(SK_META)},
                ConsistentRead=True,
            ).get("Item")
        except (ClientError, BotoCoreError) as exc:
            raise TicketStoreUnavailableError(type(exc).__name__) from exc
        return _ticket(item) if item else None

    def _query(self, limit: int, **kwargs: Any) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        start: dict[str, Any] | None = None
        try:
            while len(items) < limit:
                request: dict[str, Any] = {
                    "TableName": self._table,
                    "Limit": min(_PAGE, limit - len(items)),
                    **kwargs,
                    **({"ExclusiveStartKey": start} if start else {}),
                }
                page = self._db.query(**request)
                items.extend(page.get("Items", []))
                start = page.get("LastEvaluatedKey")
                if not start:
                    break
        except (ClientError, BotoCoreError) as exc:
            raise TicketStoreUnavailableError(type(exc).__name__) from exc
        return items

    def _by_index(self, index: str, key: str, value: str) -> list[Ticket]:
        items = self._query(
            MAX_LISTED,
            IndexName=index,
            KeyConditionExpression="#k = :v",
            ExpressionAttributeNames={"#k": key},
            ExpressionAttributeValues={":v": _s(value)},
            ScanIndexForward=False,
        )
        return [_ticket(i) for i in items]

    def recent(self) -> list[Ticket]:
        """The tickets changed last, of everybody: the list filters them with Cedar."""
        return self._by_index(INDEX_BY_UPDATED, "all_pk", ALL_PK)

    def created_by(self, user_id: str) -> list[Ticket]:
        return self._by_index(INDEX_BY_CREATOR, "creator_id", user_id)

    def assigned_to(self, user_id: str) -> list[Ticket]:
        return self._by_index(INDEX_BY_ASSIGNEE, "assignee_id", user_id)

    def comments(self, ticket_id: str) -> list[Comment]:
        items = self._query(
            MAX_COMMENTS,
            KeyConditionExpression="PK = :pk AND begins_with(SK, :c)",
            ExpressionAttributeValues={":pk": _s(_pk(ticket_id)), ":c": _s(_COMMENT)},
        )
        return [
            Comment(
                comment_id=str(_str(i, "comment_id")),
                author_id=str(_str(i, "author_id")),
                author_email=_str(i, "author_email"),
                body=str(_str(i, "body")),
                created_at=str(_str(i, "created_at")),
            )
            for i in items
        ]

    def history(self, ticket_id: str) -> list[Event]:
        """The newest ``MAX_EVENTS_SHOWN`` lines, oldest first."""
        items = self._query(
            MAX_EVENTS_SHOWN,
            KeyConditionExpression="PK = :pk AND begins_with(SK, :e)",
            ExpressionAttributeValues={":pk": _s(_pk(ticket_id)), ":e": _s(_EVENT)},
            ScanIndexForward=False,
        )
        return [
            Event(
                actor_id=str(_str(i, "actor_id")),
                actor_email=_str(i, "actor_email"),
                action=str(_str(i, "action")),
                created_at=str(_str(i, "created_at")),
                field=_str(i, "field"),
                before=_str(i, "before"),
                after=_str(i, "after"),
            )
            for i in reversed(items)
        ]

    # --- Writes -------------------------------------------------------------------------

    def _transact(self, items: list[dict[str, Any]]) -> None:
        try:
            self._db.transact_write_items(TransactItems=items)  # type: ignore[arg-type]
        except ClientError as exc:
            if _conditional(exc):
                raise TicketConflictError from exc
            raise TicketStoreUnavailableError(type(exc).__name__) from exc
        except BotoCoreError as exc:
            raise TicketStoreUnavailableError(type(exc).__name__) from exc

    def create(self, ticket: Ticket) -> None:
        """The ticket and the first line of its history, or nothing (an id never repeats)."""
        item: dict[str, Any] = {
            "PK": _s(_pk(ticket.ticket_id)),
            "SK": _s(SK_META),
            "all_pk": _s(ALL_PK),
            "ticket_id": _s(ticket.ticket_id),
            "title": _s(ticket.title),
            "status": _s(ticket.status),
            "priority": _s(ticket.priority),
            "creator_id": _s(ticket.creator_id),
            "created_at": _s(ticket.created_at),
            "updated_at": _s(ticket.updated_at),
            "source": _s(ticket.source),
            "people": {"M": {u: _s(e or "") for u, e in ticket.people.items()}},
            "version": _n(1),
            "comment_count": _n(0),
        }
        if ticket.description:
            item["description"] = _s(ticket.description)
        for name, value in (
            ("agent_id", ticket.agent_id),
            ("assignee_id", ticket.assignee_id),
            ("conversation_id", ticket.conversation_id),
            ("task_id", ticket.task_id),
        ):
            if value is not None:
                item[name] = _s(value)
        created = Event(
            actor_id=ticket.creator_id,
            actor_email=ticket.email_of(ticket.creator_id),
            action="created",
            created_at=ticket.created_at,
            after=ticket.source,
        )
        self._transact(
            [
                {
                    "Put": {
                        "TableName": self._table,
                        "Item": item,
                        "ConditionExpression": "attribute_not_exists(PK)",
                    }
                },
                {"Put": {"TableName": self._table, "Item": _event_item(ticket.ticket_id, created)}},
            ]
        )

    def update(
        self, ticket: Ticket, change: Change, *, actor_id: str, actor_email: str | None
    ) -> Ticket:
        """Apply ``change`` to ``ticket`` as read (``version``): a newer change wins nothing.

        Returns the ticket as written. A change that changes nothing writes nothing."""
        now = now_iso()
        sets = ["updated_at = :now", "version = version + :one"]
        removes: list[str] = []
        names: dict[str, str] = {}
        values: dict[str, Any] = {
            ":now": _s(now),
            ":one": _n(1),
            ":version": _n(ticket.version),
        }
        events: list[Event] = []
        updated = ticket

        def changed(name: str, before: str | None, after: str | None) -> None:
            events.append(
                Event(actor_id, actor_email, "changed", now, field=name, before=before, after=after)
            )

        if change.status is not None and change.status != ticket.status:
            sets.append("#status = :status")
            names["#status"] = "status"
            values[":status"] = _s(change.status)
            changed("status", ticket.status, change.status)
            updated = _replace(updated, status=change.status)
        if change.priority is not None and change.priority != ticket.priority:
            sets.append("priority = :priority")
            values[":priority"] = _s(change.priority)
            changed("priority", ticket.priority, change.priority)
            updated = _replace(updated, priority=change.priority)
        if change.assign and change.assignee_id != ticket.assignee_id:
            if change.assignee_id is None:
                removes.append("assignee_id")
            else:
                sets.append("assignee_id = :assignee")
                values[":assignee"] = _s(change.assignee_id)
                if change.assignee_id not in ticket.people:
                    # Only the caller may be new here (``tickets.py`` checks it): they join.
                    sets.append("people.#who = :email")
                    names["#who"] = change.assignee_id
                    values[":email"] = _s(actor_email or "")
                    updated = _replace(
                        updated, people={**updated.people, change.assignee_id: actor_email}
                    )
            changed("assignee", ticket.assignee_id, change.assignee_id)
            updated = _replace(updated, assignee_id=change.assignee_id)
        if not events:
            return ticket
        expression = "SET " + ", ".join(sets)
        if removes:
            expression += " REMOVE " + ", ".join(removes)
        update: dict[str, Any] = {
            "TableName": self._table,
            "Key": {"PK": _s(_pk(ticket.ticket_id)), "SK": _s(SK_META)},
            "UpdateExpression": expression,
            "ConditionExpression": "attribute_exists(PK) AND version = :version",
            "ExpressionAttributeValues": values,
        }
        if names:
            update["ExpressionAttributeNames"] = names
        self._transact(
            [
                {"Update": update},
                *(
                    {
                        "Put": {
                            "TableName": self._table,
                            "Item": _event_item(ticket.ticket_id, e, position),
                        }
                    }
                    for position, e in enumerate(events)
                ),
            ]
        )
        return _replace(updated, updated_at=now, version=ticket.version + 1)

    def comment(
        self, ticket_id: str, body: str, *, author_id: str, author_email: str | None
    ) -> Comment:
        """A comment, the line of the history and the author as a participant, or nothing.

        Raises ``TicketLimitError`` past ``MAX_COMMENTS`` and ``TicketConflictError`` if the
        ticket no longer exists."""
        now = now_iso()
        comment_id = secrets.token_hex(8)
        item: dict[str, Any] = {
            "PK": _s(_pk(ticket_id)),
            "SK": _s(f"{_COMMENT}{now}#{comment_id}"),
            "comment_id": _s(comment_id),
            "author_id": _s(author_id),
            "body": _s(body),
            "created_at": _s(now),
        }
        if author_email:
            item["author_email"] = _s(author_email)
        event = Event(author_id, author_email, "commented", now)
        try:
            self._db.transact_write_items(
                TransactItems=[
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": {"PK": _s(_pk(ticket_id)), "SK": _s(SK_META)},
                            "UpdateExpression": (
                                "SET comment_count = comment_count + :one, updated_at = :now, "
                                "people.#who = if_not_exists(people.#who, :email)"
                            ),
                            "ConditionExpression": "attribute_exists(PK) AND comment_count < :max",
                            "ExpressionAttributeNames": {"#who": author_id},
                            "ExpressionAttributeValues": {
                                ":one": _n(1),
                                ":now": _s(now),
                                ":email": _s(author_email or ""),
                                ":max": _n(MAX_COMMENTS),
                            },
                        }
                    },
                    {"Put": {"TableName": self._table, "Item": item}},
                    {"Put": {"TableName": self._table, "Item": _event_item(ticket_id, event)}},
                ]
            )
        except ClientError as exc:
            if _conditional(exc):
                current = self.get(ticket_id)
                if current is not None and current.comment_count >= MAX_COMMENTS:
                    raise TicketLimitError from exc
                raise TicketConflictError from exc
            raise TicketStoreUnavailableError(type(exc).__name__) from exc
        except BotoCoreError as exc:
            raise TicketStoreUnavailableError(type(exc).__name__) from exc
        return Comment(comment_id, author_id, author_email, body, now)
