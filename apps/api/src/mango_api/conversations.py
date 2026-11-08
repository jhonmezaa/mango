"""Conversation storage with row-level security (AGENTS.md: DynamoDB RLS via LeadingKeys).

Every request assumes the data-access role with a session policy that only allows items whose
partition key is ``USER#<sub>``: even a bug in this module cannot read another user's data.
"""

from __future__ import annotations

import json
import re
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import boto3
from botocore.exceptions import ClientError

from mango_api.sessions import SessionBusyError, SessionState
from mango_core import code_sandbox

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient
    from mypy_boto3_sts import STSClient

CONVERSATION_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_CREDENTIAL_TTL_SECONDS = 10 * 60
MAX_USER_CLIENTS = 1000
"""Clients a task keeps at once, one per person seen in the last 10 minutes. Each takes about
255 KB (measured): the cap is 250 MB of the 1 GB of a task. Over it the oldest goes first, and
that person's next request asks STS for credentials again."""
_MAX_LIST = 50
MEMORY_PREFIX = "MEMORY#"
"""Items of the agents that remembered the person (D122): ``MEMORY#<agent id>``."""
MAX_MEMORY_SESSIONS = 500
"""Memory sessions noted per conversation: one per runtime session it used."""


def new_id() -> str:
    return secrets.token_hex(16)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _sort_suffix() -> str:
    return f"{time.time_ns():020d}-{secrets.token_hex(4)}"


@dataclass(frozen=True)
class ConversationRecord:
    """What a turn needs to know about its conversation."""

    session: SessionState
    agent_id: str | None
    """Agent the conversation belongs to; ``None`` for conversations stored before agents
    were data (they belong to the release agent)."""
    owner: str = ""
    """Whose partition the record was read from (``USER#<sub>``): the owner Cedar is given for
    ``OwnConversation`` (TM-TW3). Empty for a conversation not stored yet."""


@dataclass(frozen=True)
class StoredMessage:
    message_id: str
    role: str
    content: str
    created_at: str
    tools: list[dict[str, str]]
    approvals: list[str] = field(default_factory=list)
    """Ids of the approval requests this message's write tool calls created (D27)."""
    citations: list[dict[str, Any]] = field(default_factory=list)
    """Knowledge base, document and page of each source of the answer, never the text of a
    fragment (D88 (44))."""
    connection_required: list[str] = field(default_factory=list)
    """Remote MCP registrations that asked the person to connect their account (D98 (20))."""
    remote_sources: list[str] = field(default_factory=list)
    """Remote MCP registrations whose tools answered («Leyó {servicio}»)."""
    stopped: bool = False
    """An answer cut by its owner's «Detener» or lost halfway: what was written of it until
    then (D121 (7))."""
    stop_code: str = ""
    """Why it was cut: ``cancelled`` («Detener») or ``turn_interrupted`` (lost halfway).
    Empty for an answer that was not cut, or one stored before the code existed."""
    attachments: list[dict[str, Any]] = field(default_factory=list)
    """Files of a question (D116): id, name, kind and size of each, never a key of the bucket
    (``chat_files.snapshot``)."""
    code_runs: list[dict[str, Any]] = field(default_factory=list)
    """Cells of the code sandbox this answer showed (C4): turn, run and the guardrail's verdict,
    never their content (``code_blocks.Reference``)."""


@dataclass(frozen=True)
class SearchableMessage:
    """What the conversation search reads of a message (D103): its text and tool names."""

    message_id: str
    role: str
    content: str
    tools: tuple[str, ...]
    """Names of the tools the message called, as stored (their arguments are not stored)."""


@dataclass(frozen=True)
class SearchableConversation:
    conversation_id: str
    title: str
    updated_at: str
    agent_id: str | None
    messages: tuple[SearchableMessage, ...]


@dataclass(frozen=True)
class SearchCorpus:
    """The newest conversations of one person, read within the caps of the search (D103)."""

    conversations: tuple[SearchableConversation, ...]
    capped: bool
    """A cap stopped the read: older conversations, or part of one, were not read."""
    items_read: int
    bytes_read: int
    owner: str = ""
    """Whose partition the conversations were read from: their owner for ``OwnConversation``
    (TM-TW3). Empty when none was read."""


def owner_of(item: dict[str, Any]) -> str:
    """The owner of a stored item: the person of its partition (``USER#<sub>``), as the
    record says, never the request. Empty when the key is not a person's partition."""
    pk = item.get("PK", {}).get("S", "")
    return pk.removeprefix("USER#") if pk.startswith("USER#") else ""


def _tool_names(raw: str) -> tuple[str, ...]:
    try:
        parsed = json.loads(raw)
    except ValueError:
        return ()
    if not isinstance(parsed, list):
        return ()
    return tuple(
        t["name"] for t in parsed if isinstance(t, dict) and isinstance(t.get("name"), str)
    )


class RlsClientFactory:
    """DynamoDB clients bound to one user through an STS session policy (cached briefly).

    A client is only ever stored under, and returned for, the user its credentials were issued
    to. An entry lives 10 minutes and is dropped when a later request finds it expired; before
    this a task kept one per person it had ever seen, until its next deployment.
    """

    def __init__(
        self,
        sts: STSClient,
        *,
        role_arn: str,
        table_arn: str,
        key_arn: str,
        region: str,
        clock: Callable[[], float] = time.monotonic,
        budgets_table_arn: str | None = None,
    ) -> None:
        self._sts = sts
        self._role_arn = role_arn
        self._table_arn = table_arn
        self._budgets_table_arn = budgets_table_arn
        self._key_arn = key_arn
        self._region = region
        self._clock = clock
        # Oldest first: every entry lives the same time, so that is also the order they expire.
        self._cache: OrderedDict[str, tuple[float, DynamoDBClient]] = OrderedDict()
        self._lock = threading.Lock()

    def session_policy(self, user_id: str) -> str:
        return json.dumps(
            {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Action": [
                            "dynamodb:GetItem",
                            "dynamodb:PutItem",
                            "dynamodb:UpdateItem",
                            "dynamodb:Query",
                        ],
                        "Resource": self._table_arn,
                        "Condition": {
                            "ForAllValues:StringEquals": {
                                "dynamodb:LeadingKeys": [f"USER#{user_id}"]
                            }
                        },
                    },
                    *self._budget_statements(user_id),
                    {
                        "Effect": "Allow",
                        "Action": ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*"],
                        "Resource": self._key_arn,
                    },
                ],
            },
            separators=(",", ":"),
        )

    def _budget_statements(self, user_id: str) -> list[dict[str, Any]]:
        """Inicio reads the person's own budget and day counters (D102): read only, and only
        their two keys of the Budgets table."""
        if self._budgets_table_arn is None:
            return []
        return [
            {
                "Effect": "Allow",
                "Action": ["dynamodb:GetItem", "dynamodb:Query"],
                "Resource": self._budgets_table_arn,
                "Condition": {
                    "ForAllValues:StringEquals": {
                        "dynamodb:LeadingKeys": [f"USER#{user_id}", f"DAY#USER#{user_id}"]
                    }
                },
            }
        ]

    def for_user(self, user_id: str) -> DynamoDBClient:
        now = self._clock()
        with self._lock:
            cached = self._cache.get(user_id)
            if cached and now - cached[0] < _CREDENTIAL_TTL_SECONDS:
                return cached[1]
            self._drop_expired(now)
        creds = self._sts.assume_role(
            RoleArn=self._role_arn,
            RoleSessionName=f"mango-data-{user_id[:40]}",
            DurationSeconds=900,
            Policy=self.session_policy(user_id),
        )["Credentials"]
        client: DynamoDBClient = boto3.client(
            "dynamodb",
            region_name=self._region,
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
        )
        with self._lock:
            # Removed first so that a renewed entry goes to the end, with the newest.
            self._cache.pop(user_id, None)
            self._cache[user_id] = (now, client)
            while len(self._cache) > MAX_USER_CLIENTS:
                self._cache.popitem(last=False)
        return client

    def _drop_expired(self, now: float) -> None:
        """Forget the clients whose time is up. A request that still holds one finishes with
        it: the entry is dropped, the client is not closed."""
        while self._cache:
            user_id, (created, _) = next(iter(self._cache.items()))
            if now - created < _CREDENTIAL_TTL_SECONDS:
                return
            del self._cache[user_id]


class ConversationRepository:
    def __init__(self, clients: Callable[[str], DynamoDBClient], table: str) -> None:
        self._clients = clients
        self._table = table

    def _pk(self, user_id: str) -> dict[str, str]:
        return {"S": f"USER#{user_id}"}

    def conversation(self, user_id: str, conversation_id: str) -> ConversationRecord | None:
        """Agent and runtime session of the conversation; ``None`` when the conversation does
        not exist for this user."""
        item = (
            self._clients(user_id)
            .get_item(
                TableName=self._table,
                Key={"PK": self._pk(user_id), "SK": {"S": f"CONV#{conversation_id}"}},
                ConsistentRead=True,
            )
            .get("Item")
        )
        if item is None:
            return None
        return ConversationRecord(
            session=SessionState(
                generation=int(item.get("session_gen", {}).get("N", "0")),
                started_at=int(item.get("session_started_at", {}).get("N", "0")),
                used_at=int(item.get("session_used_at", {}).get("N", "0")),
                binding=item.get("session_binding", {}).get("S", ""),
            ),
            agent_id=item.get("agent_id", {}).get("S"),
            owner=owner_of(item),
        )

    def session_state(self, user_id: str, conversation_id: str) -> SessionState | None:
        """Runtime session of the conversation; ``None`` when the conversation does not exist
        for this user."""
        record = self.conversation(user_id, conversation_id)
        return record.session if record else None

    def begin_session(
        self,
        user_id: str,
        conversation_id: str,
        previous: SessionState,
        generation: int,
        started_at: int,
        *,
        binding: str,
    ) -> None:
        """Take the session for the turn that starts now; it is not reusable again until the
        turn ends well (``complete_session``).

        Conditional on the state the plan was made from: of two turns that start at once only
        one gets the session, the other raises ``SessionBusyError`` and must plan again.
        """
        values = {
            ":g": {"N": str(generation)},
            ":s": {"N": str(started_at)},
            ":z": {"N": "0"},
            ":b": {"S": binding},
        }
        if previous.generation == 0:
            condition = "attribute_not_exists(session_gen)"
        else:
            condition = "session_gen = :pg AND session_used_at = :pu"
            values[":pg"] = {"N": str(previous.generation)}
            values[":pu"] = {"N": str(previous.used_at)}
        try:
            self._clients(user_id).update_item(
                TableName=self._table,
                Key={"PK": self._pk(user_id), "SK": {"S": f"CONV#{conversation_id}"}},
                UpdateExpression=(
                    "SET session_gen = :g, session_started_at = :s, session_used_at = :z, "
                    "session_binding = :b"
                ),
                ConditionExpression=condition,
                ExpressionAttributeValues=values,
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                raise SessionBusyError from None
            raise

    def complete_session(
        self, user_id: str, conversation_id: str, generation: int, used_at: int
    ) -> None:
        """Mark the session reusable, unless another turn already moved the conversation to a
        newer session."""
        try:
            self._clients(user_id).update_item(
                TableName=self._table,
                Key={"PK": self._pk(user_id), "SK": {"S": f"CONV#{conversation_id}"}},
                UpdateExpression="SET session_used_at = :u",
                ConditionExpression="session_gen = :g",
                ExpressionAttributeValues={
                    ":u": {"N": str(used_at)},
                    ":g": {"N": str(generation)},
                },
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise

    def upsert_conversation(
        self, user_id: str, conversation_id: str, title: str, agent_id: str
    ) -> None:
        """Create the conversation or touch it. Its agent is fixed by the first turn: a later
        turn never moves a conversation, and its stored history, to another agent."""
        self._clients(user_id).update_item(
            TableName=self._table,
            Key={"PK": self._pk(user_id), "SK": {"S": f"CONV#{conversation_id}"}},
            UpdateExpression=(
                "SET updated_at = :u, title = if_not_exists(title, :t), "
                "agent_id = if_not_exists(agent_id, :a)"
            ),
            ExpressionAttributeValues={
                ":u": {"S": _now_iso()},
                ":t": {"S": title[:120]},
                ":a": {"S": agent_id},
            },
        )

    def set_title(self, user_id: str, conversation_id: str, title: str) -> None:
        self._clients(user_id).update_item(
            TableName=self._table,
            Key={"PK": self._pk(user_id), "SK": {"S": f"CONV#{conversation_id}"}},
            UpdateExpression="SET title = :t",
            ExpressionAttributeValues={":t": {"S": title[:120]}},
        )

    def add_message(
        self,
        user_id: str,
        conversation_id: str,
        role: str,
        content: str,
        tools: list[dict[str, str]] | None = None,
        *,
        approvals: list[str] | None = None,
        citations: list[dict[str, Any]] | None = None,
        connection_required: list[str] | None = None,
        remote_sources: list[str] | None = None,
        message_id: str | None = None,
        stopped: bool = False,
        stop_code: str = "",
        attachments: list[dict[str, Any]] | None = None,
        code_runs: list[dict[str, Any]] | None = None,
    ) -> str:
        message_id = message_id or new_id()
        item: dict[str, Any] = {
            "PK": self._pk(user_id),
            "SK": {"S": f"MSG#{conversation_id}#{_sort_suffix()}"},
            "message_id": {"S": message_id},
            "role": {"S": role},
            "content": {"S": content},
            "created_at": {"S": _now_iso()},
            "tools": {"S": json.dumps(tools or [])},
        }
        if approvals:
            item["approvals"] = {"S": json.dumps(approvals)}
        if citations:
            item["citations"] = {"S": json.dumps(citations, ensure_ascii=False)}
        # Registration ids only (D98 (20)): never a URL.
        if connection_required:
            item["connection_required"] = {"S": json.dumps(connection_required)}
        if remote_sources:
            item["remote_sources"] = {"S": json.dumps(remote_sources)}
        if stopped:
            item["stopped"] = {"BOOL": True}
        if stopped and stop_code:
            item["stop_code"] = {"S": stop_code[:40]}
        if attachments:
            item["attachments"] = {"S": json.dumps(attachments, ensure_ascii=False)}
        if code_runs:
            item["code_runs"] = {"S": json.dumps(code_runs)}
        self._clients(user_id).put_item(TableName=self._table, Item=item)
        return message_id

    # --- Memory of the agents (D122): which agents remembered the person, and the memory
    # sessions of each conversation. Only ids: what is remembered lives in AgentCore Memory.

    def note_memory(
        self, user_id: str, agent_id: str, conversation_id: str, session_id: str
    ) -> None:
        """Written before a turn with memory runs (TM-ME1): the person finds in «Memoria»
        every agent that remembered them, and deleting a conversation finds its sessions."""
        client = self._clients(user_id)
        client.update_item(
            TableName=self._table,
            Key={"PK": self._pk(user_id), "SK": {"S": f"{MEMORY_PREFIX}{agent_id}"}},
            UpdateExpression="SET agent_id = :a, first_used = if_not_exists(first_used, :t)",
            ExpressionAttributeValues={":a": {"S": agent_id}, ":t": {"S": _now_iso()}},
        )
        client.update_item(
            TableName=self._table,
            Key={"PK": self._pk(user_id), "SK": {"S": f"CONV#{conversation_id}"}},
            UpdateExpression="ADD memory_sessions :s",
            ConditionExpression=(
                "attribute_not_exists(memory_sessions) OR size(memory_sessions) < :max"
            ),
            ExpressionAttributeValues={
                ":s": {"SS": [session_id]},
                ":max": {"N": str(MAX_MEMORY_SESSIONS)},
            },
        )

    def memory_agents(self, user_id: str) -> list[str]:
        items: list[str] = []
        kwargs: dict[str, Any] = {
            "TableName": self._table,
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": {
                ":pk": self._pk(user_id),
                ":prefix": {"S": MEMORY_PREFIX},
            },
        }
        while True:
            page = self._clients(user_id).query(**kwargs)
            items.extend(i["SK"]["S"].removeprefix(MEMORY_PREFIX) for i in page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                return items
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    def memory_sessions(self, user_id: str, conversation_id: str) -> tuple[str | None, list[str]]:
        item = (
            self._clients(user_id)
            .get_item(
                TableName=self._table,
                Key={"PK": self._pk(user_id), "SK": {"S": f"CONV#{conversation_id}"}},
                ConsistentRead=True,
            )
            .get("Item")
        )
        if item is None:
            return None, []
        return item.get("agent_id", {}).get("S"), sorted(
            item.get("memory_sessions", {}).get("SS", [])
        )

    def memory_sessions_by_agent(self, user_id: str) -> dict[str, list[str]]:
        """The memory sessions every conversation of the person noted, by agent (D122): where
        «Memoria» and the purge find the summaries once the events expired."""
        found: dict[str, set[str]] = {}
        kwargs: dict[str, Any] = {
            "TableName": self._table,
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "FilterExpression": "attribute_exists(memory_sessions)",
            "ProjectionExpression": "agent_id, memory_sessions",
            "ExpressionAttributeValues": {":pk": self._pk(user_id), ":prefix": {"S": "CONV#"}},
        }
        while True:
            page = self._clients(user_id).query(**kwargs)
            for item in page.get("Items", []):
                agent = item.get("agent_id", {}).get("S")
                if agent:
                    found.setdefault(agent, set()).update(
                        item.get("memory_sessions", {}).get("SS", [])
                    )
            if "LastEvaluatedKey" not in page:
                return {agent: sorted(ids) for agent, ids in found.items()}
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    def list_conversations(self, user_id: str) -> list[dict[str, str | None]]:
        resp = self._clients(user_id).query(
            TableName=self._table,
            KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
            ExpressionAttributeValues={":pk": self._pk(user_id), ":prefix": {"S": "CONV#"}},
        )
        items = [
            {
                "conversation_id": i["SK"]["S"].removeprefix("CONV#"),
                "title": i.get("title", {}).get("S", ""),
                "updated_at": i.get("updated_at", {}).get("S", ""),
                "agent_id": i.get("agent_id", {}).get("S"),
                "owner": owner_of(i),
            }
            for i in resp.get("Items", [])
        ]
        items.sort(key=lambda c: c["updated_at"] or "", reverse=True)
        return items[:_MAX_LIST]

    def summary(self, user_id: str, conversation_id: str) -> tuple[str, str | None, str] | None:
        """``(title, agent_id, owner)`` of a conversation, or ``None`` if it does not exist."""
        item = (
            self._clients(user_id)
            .get_item(
                TableName=self._table,
                Key={"PK": self._pk(user_id), "SK": {"S": f"CONV#{conversation_id}"}},
            )
            .get("Item")
        )
        if item is None:
            return None
        return item.get("title", {}).get("S", ""), item.get("agent_id", {}).get("S"), owner_of(item)

    def code_uses(self, user_id: str, turn_id: str) -> list[code_sandbox.CellUse]:
        """What the cells of a turn used, as the code connector metered them (D115 (3)), from
        the person's own partition. A cell that never wrote its end counts at its cutoff."""
        uses: list[code_sandbox.CellUse] = []
        kwargs: dict[str, Any] = {
            "TableName": self._table,
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": {
                ":pk": self._pk(user_id),
                ":prefix": {"S": code_sandbox.turn_prefix(turn_id)},
            },
            "ProjectionExpression": "#state, cpu_seconds, session_seconds",
            "ExpressionAttributeNames": {"#state": "state"},
            "ConsistentRead": True,
        }
        while True:
            resp = self._clients(user_id).query(**kwargs)
            uses.extend(code_sandbox.cell_use(item) for item in resp.get("Items", []))
            start = resp.get("LastEvaluatedKey")
            if not start:
                return uses
            kwargs["ExclusiveStartKey"] = start

    def code_runs(self, user_id: str, turn_id: str) -> list[dict[str, Any]]:
        """The cells of a turn as the code connector wrote them (C4), from the person's own
        partition: what the chat shows of each one (``code_blocks``)."""
        items: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {
            "TableName": self._table,
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": {
                ":pk": self._pk(user_id),
                ":prefix": {"S": code_sandbox.turn_prefix(turn_id)},
            },
            "ProjectionExpression": (
                "SK, #state, #status, code, stdout, stderr, stdout_chars, stderr_chars, "
                "#exception, files, cpu_seconds, created_at"
            ),
            "ExpressionAttributeNames": {
                "#state": "state",
                "#status": "status",
                "#exception": "exception",
            },
            "ConsistentRead": True,
        }
        while True:
            resp = self._clients(user_id).query(**kwargs)
            items.extend(resp.get("Items", []))
            start = resp.get("LastEvaluatedKey")
            if not start:
                return items
            kwargs["ExclusiveStartKey"] = start

    def messages(self, user_id: str, conversation_id: str) -> list[StoredMessage]:
        out: list[StoredMessage] = []
        kwargs: dict[str, Any] = {
            "TableName": self._table,
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": {
                ":pk": self._pk(user_id),
                ":prefix": {"S": f"MSG#{conversation_id}#"},
            },
        }
        while True:
            resp = self._clients(user_id).query(**kwargs)
            for i in resp.get("Items", []):
                out.append(
                    StoredMessage(
                        message_id=i["message_id"]["S"],
                        role=i["role"]["S"],
                        content=i["content"]["S"],
                        created_at=i["created_at"]["S"],
                        tools=json.loads(i.get("tools", {}).get("S", "[]")),
                        approvals=json.loads(i.get("approvals", {}).get("S", "[]")),
                        citations=json.loads(i.get("citations", {}).get("S", "[]")),
                        connection_required=json.loads(
                            i.get("connection_required", {}).get("S", "[]")
                        ),
                        remote_sources=json.loads(i.get("remote_sources", {}).get("S", "[]")),
                        stopped=i.get("stopped", {}).get("BOOL", False),
                        stop_code=i.get("stop_code", {}).get("S", ""),
                        attachments=json.loads(i.get("attachments", {}).get("S", "[]")),
                        code_runs=json.loads(i.get("code_runs", {}).get("S", "[]")),
                    )
                )
            if "LastEvaluatedKey" not in resp:
                return out
            kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

    def search_corpus(
        self,
        user_id: str,
        *,
        max_conversations: int,
        max_messages: int,
        max_bytes: int,
        max_list_pages: int,
    ) -> SearchCorpus:
        """The person's conversations, newest first, and their messages, until a cap (D103).

        Only ``CONV#`` and ``MSG#`` items of the caller's partition, read with their row-level
        security client. ``bytes_read`` counts the text kept (titles, contents, tool names).
        """
        client = self._clients(user_id)
        pk = self._pk(user_id)
        listed: list[dict[str, Any]] = []
        pages = 0
        listing_capped = False
        kwargs: dict[str, Any] = {
            "TableName": self._table,
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": {":pk": pk, ":prefix": {"S": "CONV#"}},
            "ProjectionExpression": "PK, SK, #t, updated_at, agent_id",
            "ExpressionAttributeNames": {"#t": "title"},
        }
        while True:
            resp = client.query(**kwargs)
            listed.extend(resp.get("Items", []))
            pages += 1
            if "LastEvaluatedKey" not in resp:
                break
            if pages >= max_list_pages:
                # Their order is that of the ids, not of time: «newest first» no longer holds
                # for all of them, so the answer says it did not cover everything.
                listing_capped = True
                break
            kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
        heads = [
            (
                i["SK"]["S"].removeprefix("CONV#"),
                i.get("title", {}).get("S", ""),
                i.get("updated_at", {}).get("S", ""),
                i.get("agent_id", {}).get("S"),
            )
            for i in listed
        ]
        heads = [h for h in heads if CONVERSATION_ID_RE.fullmatch(h[0])]
        heads.sort(key=lambda h: h[2], reverse=True)
        items = len(listed)
        size = 0
        capped = listing_capped or len(heads) > max_conversations
        out: list[SearchableConversation] = []
        messages_left = max_messages
        for conversation_id, title, updated_at, agent_id in heads[:max_conversations]:
            if messages_left <= 0 or size >= max_bytes:
                capped = True
                break
            size += len(title)
            messages: list[SearchableMessage] = []
            query: dict[str, Any] = {
                "TableName": self._table,
                "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
                "ExpressionAttributeValues": {
                    ":pk": pk,
                    ":prefix": {"S": f"MSG#{conversation_id}#"},
                },
                "ProjectionExpression": "message_id, #r, content, tools",
                "ExpressionAttributeNames": {"#r": "role"},
            }
            while True:
                query["Limit"] = messages_left
                resp = client.query(**query)
                for i in resp.get("Items", []):
                    message = SearchableMessage(
                        message_id=i.get("message_id", {}).get("S", ""),
                        role=i.get("role", {}).get("S", ""),
                        content=i.get("content", {}).get("S", ""),
                        tools=_tool_names(i.get("tools", {}).get("S", "[]")),
                    )
                    messages.append(message)
                    size += len(message.content) + sum(len(t) for t in message.tools)
                items += len(resp.get("Items", []))
                messages_left -= len(resp.get("Items", []))
                if "LastEvaluatedKey" not in resp:
                    break
                if messages_left <= 0 or size >= max_bytes:
                    capped = True
                    break
                query["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
            out.append(
                SearchableConversation(
                    conversation_id=conversation_id,
                    title=title,
                    updated_at=updated_at,
                    agent_id=agent_id,
                    messages=tuple(messages),
                )
            )
        return SearchCorpus(
            conversations=tuple(out),
            capped=capped,
            items_read=items,
            bytes_read=size,
            owner=next((o for o in map(owner_of, listed) if o), ""),
        )
