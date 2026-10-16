"""Inbox notices of each person (D83), in the conversations table under ``USER#<sub>``.

Every read and write goes through the row-level security client of the person it belongs to
(``RlsClientFactory``: a ``dynamodb:LeadingKeys`` session policy): even a bug here cannot touch
another person's partition.

Item layout, all under ``PK = USER#<sub>``:

* ``SK = INBOX#<notice id>``: the notice of a task run that ended (``kind = run``). The id is
  the time in milliseconds followed by 16 random hex characters, so the newest sorts last and
  ids cannot be guessed. It keeps the task's name, the agent, whether it completed, the reason
  code and the first line of the report: never the report, its steps or the instruction.
* ``SK = INBOXSTATE#APPROVAL#<approval id>``: whether this person read or archived a pending
  approval. Approvals themselves are never copied: they are read from the approvals table on
  every request, with the rules of the approvals screen (D56).

Both expire with the table's TTL (``ttl``) after ``RETENTION``.
"""

from __future__ import annotations

import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

RETENTION = timedelta(days=90)
"""Taken by the owner on 2026-10-16 (D83 (1)): the same as the run a notice opens."""
NOTICE_ID_PATTERN = r"^[0-9]{13}[0-9a-f]{16}$"
NOTICE_ID_RE = re.compile(NOTICE_ID_PATTERN)
SUMMARY_MAX_CHARS = 200
PAGE_SIZE = 20
UNREAD_SCAN = 200
"""Notices the unread count and «mark all as read» look at: the newest ones."""
_NOTICE = "INBOX#"
_APPROVAL_STATE = "INBOXSTATE#APPROVAL#"
_READ_PAGE = 50
_MAX_READS = 6
"""Queries one page may make while a filter skips notices (read or archived ones)."""

View = Literal["all", "unread", "archived"]

_FILTERS: dict[View, str] = {
    "all": "is_archived = :f",
    "unread": "is_archived = :f AND is_read = :f",
    "archived": "is_archived = :t",
}


class InboxStoreUnavailableError(Exception):
    """The table could not be read or written."""


@dataclass(frozen=True)
class RunNotice:
    notice_id: str
    task_id: str
    run_id: str
    task_name: str
    agent_id: str
    ok: bool
    summary: str | None
    """First line of the report, as plain text; ``None`` when the run wrote nothing."""
    reason: str | None
    """Why it did not complete: a fixed code of the run, never text of the model."""
    created_at: str
    read: bool
    archived: bool


@dataclass(frozen=True)
class NoticeState:
    read: bool
    archived: bool


def first_line(report: str | None) -> str | None:
    """The first line with text, without heading marks, bold or code (design ``scSummary``)."""
    for line in (report or "").splitlines():
        text = re.sub(r"^#+\s*", "", line).replace("**", "").replace("`", "").strip()
        if text:
            return text[:SUMMARY_MAX_CHARS]
    return None


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _b(value: bool) -> dict[str, bool]:
    return {"BOOL": value}


def _pk(user_id: str) -> dict[str, str]:
    return _s(f"USER#{user_id}")


def _notice(item: dict[str, Any]) -> RunNotice:
    def text(name: str) -> str | None:
        value = item.get(name, {}).get("S")
        return str(value) if value else None

    return RunNotice(
        notice_id=item["SK"]["S"].removeprefix(_NOTICE),
        task_id=item["task_id"]["S"],
        run_id=item["run_id"]["S"],
        task_name=item["task_name"]["S"],
        agent_id=item["agent_id"]["S"],
        ok=bool(item["ok"]["BOOL"]),
        summary=text("summary"),
        reason=text("reason"),
        created_at=item["created_at"]["S"],
        read=bool(item.get("is_read", {}).get("BOOL", False)),
        archived=bool(item.get("is_archived", {}).get("BOOL", False)),
    )


class InboxStore:
    def __init__(
        self,
        clients: Callable[[str], DynamoDBClient],
        table: str,
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._clients = clients
        self._table = table
        self._clock = clock

    def _ttl(self) -> dict[str, str]:
        return {"N": str(int(self._clock() + RETENTION.total_seconds()))}

    def _call[T](self, fn: Callable[[], T]) -> T:
        try:
            return fn()
        except Exception as exc:
            raise InboxStoreUnavailableError from exc

    # --- Run notices ----------------------------------------------------------------------

    def add_run(
        self,
        owner_id: str,
        *,
        task_id: str,
        run_id: str,
        task_name: str,
        agent_id: str,
        ok: bool,
        summary: str | None,
        reason: str | None,
    ) -> RunNotice:
        now = self._clock()
        notice_id = f"{int(now * 1000):013d}{secrets.token_hex(8)}"
        created_at = datetime.fromtimestamp(now, UTC).isoformat(timespec="seconds")
        item: dict[str, Any] = {
            "PK": _pk(owner_id),
            "SK": _s(f"{_NOTICE}{notice_id}"),
            "kind": _s("run"),
            "task_id": _s(task_id),
            "run_id": _s(run_id),
            "task_name": _s(task_name),
            "agent_id": _s(agent_id),
            "ok": _b(ok),
            "created_at": _s(created_at),
            "is_read": _b(False),
            "is_archived": _b(False),
            "ttl": self._ttl(),
        }
        if summary:
            item["summary"] = _s(summary[:SUMMARY_MAX_CHARS])
        if reason:
            item["reason"] = _s(reason)
        self._call(
            lambda: self._clients(owner_id).put_item(
                TableName=self._table, Item=item, ConditionExpression="attribute_not_exists(SK)"
            )
        )
        return _notice(item)

    def page(
        self, user_id: str, *, view: View, cursor: str | None, limit: int = PAGE_SIZE
    ) -> tuple[list[RunNotice], str | None]:
        """Run notices of one view, newest first, and the cursor of the next page (or ``None``).

        The cursor is the id of the last notice returned: it only moves inside the caller's
        partition, which the session policy enforces anyway.
        """
        client = self._clients(user_id)
        kwargs: dict[str, Any] = {
            "TableName": self._table,
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "FilterExpression": _FILTERS[view],
            "ExpressionAttributeValues": {
                ":pk": _pk(user_id),
                ":prefix": _s(_NOTICE),
                **({":f": _b(False)} if ":f" in _FILTERS[view] else {}),
                **({":t": _b(True)} if ":t" in _FILTERS[view] else {}),
            },
            "ScanIndexForward": False,
            "Limit": _READ_PAGE,
        }
        if cursor:
            kwargs["ExclusiveStartKey"] = {"PK": _pk(user_id), "SK": _s(f"{_NOTICE}{cursor}")}
        out: list[RunNotice] = []
        last: str | None = None
        for _ in range(_MAX_READS):
            resp = self._call(lambda: client.query(**kwargs))
            for item in resp.get("Items", []):
                out.append(_notice(item))
                if len(out) == limit:
                    # More may follow this one: the next page starts after it.
                    return out, out[-1].notice_id
            evaluated = resp.get("LastEvaluatedKey")
            if not evaluated:
                return out, None
            kwargs["ExclusiveStartKey"] = evaluated
            last = str(evaluated["SK"]["S"]).removeprefix(_NOTICE)
        return out, last

    def get(self, user_id: str, notice_id: str) -> RunNotice | None:
        item = self._call(
            lambda: self._clients(user_id).get_item(
                TableName=self._table,
                Key={"PK": _pk(user_id), "SK": _s(f"{_NOTICE}{notice_id}")},
                ConsistentRead=True,
            )
        ).get("Item")
        return _notice(item) if item else None

    def set_run_state(
        self, user_id: str, notice_id: str, *, read: bool | None, archived: bool | None
    ) -> RunNotice | None:
        """Change read or archived; ``None`` when the notice is not in this partition."""
        sets, values = self._state_sets(read, archived)
        try:
            item = self._clients(user_id).update_item(
                TableName=self._table,
                Key={"PK": _pk(user_id), "SK": _s(f"{_NOTICE}{notice_id}")},
                UpdateExpression="SET " + ", ".join(sets),
                ConditionExpression="attribute_exists(SK)",
                ExpressionAttributeValues=values,
                ReturnValues="ALL_NEW",
            )["Attributes"]
        except Exception as exc:
            if getattr(exc, "response", {}).get("Error", {}).get("Code") == (
                "ConditionalCheckFailedException"
            ):
                return None
            raise InboxStoreUnavailableError from exc
        return _notice(item)

    def unread_runs(self, user_id: str) -> int:
        """Unread notices that are not archived, among the newest ``UNREAD_SCAN``."""
        resp = self._call(
            lambda: self._clients(user_id).query(
                TableName=self._table,
                KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
                FilterExpression=_FILTERS["unread"],
                ExpressionAttributeValues={
                    ":pk": _pk(user_id),
                    ":prefix": _s(_NOTICE),
                    ":f": _b(False),
                },
                ScanIndexForward=False,
                Limit=UNREAD_SCAN,
                Select="COUNT",
            )
        )
        return int(resp.get("Count", 0))

    def mark_runs_read(self, user_id: str) -> None:
        """Mark as read the unread notices among the newest ``UNREAD_SCAN``."""
        client = self._clients(user_id)
        resp = self._call(
            lambda: client.query(
                TableName=self._table,
                KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
                FilterExpression=_FILTERS["unread"],
                ExpressionAttributeValues={
                    ":pk": _pk(user_id),
                    ":prefix": _s(_NOTICE),
                    ":f": _b(False),
                },
                ProjectionExpression="SK",
                ScanIndexForward=False,
                Limit=UNREAD_SCAN,
            )
        )
        try:
            for item in resp.get("Items", []):
                client.update_item(
                    TableName=self._table,
                    Key={"PK": _pk(user_id), "SK": item["SK"]},
                    UpdateExpression="SET is_read = :t",
                    ConditionExpression="attribute_exists(SK)",
                    ExpressionAttributeValues={":t": _b(True)},
                )
        except Exception as exc:
            raise InboxStoreUnavailableError from exc

    # --- Approval state -------------------------------------------------------------------

    def approval_states(self, user_id: str) -> dict[str, NoticeState]:
        """What this person read or archived of the approvals, by approval id."""
        client = self._clients(user_id)
        kwargs: dict[str, Any] = {
            "TableName": self._table,
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": {":pk": _pk(user_id), ":prefix": _s(_APPROVAL_STATE)},
        }
        out: dict[str, NoticeState] = {}
        for _ in range(_MAX_READS):
            resp = self._call(lambda: client.query(**kwargs))
            for item in resp.get("Items", []):
                out[item["SK"]["S"].removeprefix(_APPROVAL_STATE)] = NoticeState(
                    read=bool(item.get("is_read", {}).get("BOOL", False)),
                    archived=bool(item.get("is_archived", {}).get("BOOL", False)),
                )
            if "LastEvaluatedKey" not in resp:
                break
            kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
        return out

    def set_approval_state(
        self, user_id: str, approval_id: str, *, read: bool | None, archived: bool | None
    ) -> NoticeState:
        sets, values = self._state_sets(read, archived)
        item = self._call(
            lambda: self._clients(user_id).update_item(
                TableName=self._table,
                Key={"PK": _pk(user_id), "SK": _s(f"{_APPROVAL_STATE}{approval_id}")},
                UpdateExpression="SET " + ", ".join([*sets, "#ttl = :ttl"]),
                ExpressionAttributeNames={"#ttl": "ttl"},
                ExpressionAttributeValues={**values, ":ttl": self._ttl()},
                ReturnValues="ALL_NEW",
            )["Attributes"]
        )
        return NoticeState(
            read=bool(item.get("is_read", {}).get("BOOL", False)),
            archived=bool(item.get("is_archived", {}).get("BOOL", False)),
        )

    @staticmethod
    def _state_sets(read: bool | None, archived: bool | None) -> tuple[list[str], dict[str, Any]]:
        sets: list[str] = []
        values: dict[str, Any] = {}
        if read is not None:
            sets.append("is_read = :read")
            values[":read"] = _b(read)
        if archived is not None:
            sets.append("is_archived = :archived")
            values[":archived"] = _b(archived)
            if archived:
                # Archiving reads it (design: an archived notice is read).
                sets = [s for s in sets if not s.startswith("is_read")] + ["is_read = :read"]
                values[":read"] = _b(True)
        return sets, values
