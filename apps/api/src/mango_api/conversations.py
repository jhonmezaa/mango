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
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import boto3
from botocore.exceptions import ClientError

from mango_api.sessions import SessionBusyError, SessionState

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient
    from mypy_boto3_sts import STSClient

CONVERSATION_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_CREDENTIAL_TTL_SECONDS = 10 * 60
_MAX_LIST = 50


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


@dataclass(frozen=True)
class StoredMessage:
    message_id: str
    role: str
    content: str
    created_at: str
    tools: list[dict[str, str]]
    approvals: list[str] = field(default_factory=list)
    """Ids of the approval requests this message's write tool calls created (D27)."""


class RlsClientFactory:
    """DynamoDB clients bound to one user through an STS session policy (cached briefly)."""

    def __init__(
        self,
        sts: STSClient,
        *,
        role_arn: str,
        table_arn: str,
        key_arn: str,
        region: str,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._sts = sts
        self._role_arn = role_arn
        self._table_arn = table_arn
        self._key_arn = key_arn
        self._region = region
        self._clock = clock
        self._cache: dict[str, tuple[float, DynamoDBClient]] = {}
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
                    {
                        "Effect": "Allow",
                        "Action": ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*"],
                        "Resource": self._key_arn,
                    },
                ],
            },
            separators=(",", ":"),
        )

    def for_user(self, user_id: str) -> DynamoDBClient:
        now = self._clock()
        with self._lock:
            cached = self._cache.get(user_id)
            if cached and now - cached[0] < _CREDENTIAL_TTL_SECONDS:
                return cached[1]
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
            self._cache[user_id] = (now, client)
        return client


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
    ) -> str:
        message_id = new_id()
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
        self._clients(user_id).put_item(TableName=self._table, Item=item)
        return message_id

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
            }
            for i in resp.get("Items", [])
        ]
        items.sort(key=lambda c: c["updated_at"] or "", reverse=True)
        return items[:_MAX_LIST]

    def summary(self, user_id: str, conversation_id: str) -> tuple[str, str | None] | None:
        """``(title, agent_id)`` of a conversation, or ``None`` if it does not exist."""
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
        return item.get("title", {}).get("S", ""), item.get("agent_id", {}).get("S")

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
                    )
                )
            if "LastEvaluatedKey" not in resp:
                return out
            kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
