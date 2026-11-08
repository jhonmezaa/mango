"""The person's sandbox sessions and cells, in their own partition of ``Conversations``.

Every read and write goes through credentials that only reach ``PK = USER#<sub>`` of the
person the token named (``dynamodb:LeadingKeys``, AGENTS.md): even a bug here cannot touch
somebody else's session. The ``sessionId`` is stored sealed with the data key of Core, with
``purpose = code-session``, the person and the conversation as encryption context (TM-CI1): a
sealed id copied to another partition does not open. What is logged or audited is a short hash.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

import boto3
from botocore.exceptions import ClientError

from mango_code_interpreter.programs import Layout
from mango_core.code_sandbox import (
    CELL_SECONDS,
    RENDER_TOOL,
    SESSION_SECONDS,
    run_sk,
    session_sk,
    turn_prefix,
)

LOCK_MARGIN_SECONDS = 60
"""A cell holds the session a little longer than its cutoff: the files are read after it."""
USABLE_MARGIN_SECONDS = CELL_SECONDS + LOCK_MARGIN_SECONDS
"""A session closer than this to its end is not given another cell: it would be cut."""
RUN_RETENTION_SECONDS = 90 * 24 * 3600
"""What a cell keeps for the chat: the life of the chat files (D116 (1))."""
_CREDENTIAL_SECONDS = 600
_MAX_CLIENTS = 200


FILE_PREFIX = "CFILE#"
"""Records of the files of the chat (``mango_api.chat_files_store.file_sk``)."""


@dataclass(frozen=True)
class UploadedFile:
    file_id: str
    name: str
    size: int


@dataclass(frozen=True)
class GeneratedFile:
    file_id: str
    name: str
    kind: str
    size: int
    sha256: str


@dataclass(frozen=True)
class ChatFile:
    """A file of the conversation as its record says (``mango_api.chat_files_store``)."""

    file_id: str
    name: str
    origin: str
    """``upload`` (the person attached it) or ``generated`` (a cell wrote it)."""
    status: str
    created_at: int


class SessionBusyError(Exception):
    """Another cell of this conversation is running."""


def session_hash(session_id: str) -> str:
    """What the audit carries instead of the id (TM-CI1)."""
    return hashlib.sha256(session_id.encode()).hexdigest()[:16]


def _context(user_id: str, conversation_id: str) -> dict[str, str]:
    return {"purpose": "code-session", "sub": user_id, "conversation": conversation_id}


@dataclass(frozen=True)
class Session:
    session_id: str
    created_at: int
    layout: Layout
    new: bool
    hydrated: frozenset[str] = frozenset()
    """Ids of the attached files already written into the session."""

    @property
    def hash(self) -> str:
        return session_hash(self.session_id)


class RlsClients:
    """A DynamoDB client per person, from ``Mango-<ns>-ConversationData`` with a session policy
    that only reaches that person's partition of ``Conversations``."""

    def __init__(self, sts: Any, role_arn: str, table_arn: str, key_arn: str, region: str) -> None:
        self._sts, self._role, self._table, self._key, self._region = (
            sts,
            role_arn,
            table_arn,
            key_arn,
            region,
        )
        self._cache: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()

    def policy(self, user_id: str) -> str:
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
                            "dynamodb:DeleteItem",
                            "dynamodb:Query",
                        ],
                        "Resource": self._table,
                        "Condition": {
                            "ForAllValues:StringEquals": {
                                "dynamodb:LeadingKeys": [f"USER#{user_id}"]
                            }
                        },
                    },
                    {
                        "Effect": "Allow",
                        "Action": ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*"],
                        "Resource": self._key,
                    },
                ],
            },
            separators=(",", ":"),
        )

    def for_user(self, user_id: str) -> Any:
        now = time.monotonic()
        with self._lock:
            cached = self._cache.get(user_id)
            if cached and now - cached[0] < _CREDENTIAL_SECONDS:
                return cached[1]
        creds = self._sts.assume_role(
            RoleArn=self._role,
            RoleSessionName=f"mango-code-{user_id[:40]}",
            DurationSeconds=900,
            Policy=self.policy(user_id),
        )["Credentials"]
        client = boto3.client(
            "dynamodb",
            region_name=self._region,
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
        )
        with self._lock:
            self._cache.pop(user_id, None)
            self._cache[user_id] = (now, client)
            while len(self._cache) > _MAX_CLIENTS:
                self._cache.popitem(last=False)
        return client


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: int) -> dict[str, str]:
    return {"N": str(value)}


class SessionStore:
    """Sessions (``CODE#SESSION#<conversation>``) and cells (``CODE#TURN#<turn>#RUN#<run>``)
    of one person, with ``db`` from ``RlsClients.for_user``."""

    def __init__(self, db: Any, table: str, kms: Any, key_id: str, user_id: str) -> None:
        self._db, self._table, self._kms, self._key = db, table, kms, key_id
        self._user = user_id
        self._pk = _s(f"USER#{user_id}")

    # --- Sessions -------------------------------------------------------------------------

    def current(self, conversation_id: str, now: int) -> tuple[dict[str, Any] | None, bool]:
        """The stored session item and whether it may take a cell now."""
        item = self._db.get_item(
            TableName=self._table,
            Key={"PK": self._pk, "SK": _s(session_sk(conversation_id))},
            ConsistentRead=True,
        ).get("Item")
        if item is None:
            return None, False
        if int(item.get("busy_until", {}).get("N", "0")) > now:
            raise SessionBusyError
        usable = int(item["expires_at"]["N"]) - now > USABLE_MARGIN_SECONDS
        return item, usable

    def lock(self, conversation_id: str, item: dict[str, Any], now: int) -> Session:
        """Take a stored, usable session for one cell."""
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": self._pk, "SK": _s(session_sk(conversation_id))},
                UpdateExpression="SET busy_until = :until",
                ConditionExpression="created_at = :created AND busy_until <= :now",
                ExpressionAttributeValues={
                    ":until": _n(now + USABLE_MARGIN_SECONDS),
                    ":created": item["created_at"],
                    ":now": _n(now),
                },
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                raise SessionBusyError from None
            raise
        return Session(
            session_id=self._open(item["sealed"]["B"], conversation_id),
            created_at=int(item["created_at"]["N"]),
            layout=_layout(item),
            new=False,
            hydrated=frozenset(item.get("hydrated", {}).get("SS", [])),
        )

    def save_new(
        self,
        conversation_id: str,
        session_id: str,
        layout: Layout,
        replaces: dict[str, Any] | None,
        now: int,
    ) -> Session:
        """Store a session just started, locked for its first cell. Fails with
        ``SessionBusyError`` if another cell stored one first."""
        condition = (
            "attribute_not_exists(SK)"
            if replaces is None
            else "created_at = :old AND busy_until <= :now"
        )
        values = {":old": replaces["created_at"], ":now": _n(now)} if replaces else None
        expires = now + SESSION_SECONDS
        item = {
            "PK": self._pk,
            "SK": _s(session_sk(conversation_id)),
            "sealed": {"B": self._seal(session_id, conversation_id)},
            "session_hash": _s(session_hash(session_id)),
            "created_at": _n(now),
            "expires_at": _n(expires),
            "busy_until": _n(now + USABLE_MARGIN_SECONDS),
            "data": _s(layout.data),
            "out": _s(layout.out),
            "lib": _s(layout.lib),
            "ttl": _n(expires + 3600),
        }
        kwargs: dict[str, Any] = {"ConditionExpression": condition}
        if values:
            kwargs["ExpressionAttributeValues"] = values
        try:
            self._db.put_item(TableName=self._table, Item=item, **kwargs)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                raise SessionBusyError from None
            raise
        return Session(session_id, now, layout, new=True)

    def sealed_id(self, item: dict[str, Any], conversation_id: str) -> str:
        """The id of a stored session, to stop it."""
        return self._open(item["sealed"]["B"], conversation_id)

    def release(self, conversation_id: str, session: Session) -> None:
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": self._pk, "SK": _s(session_sk(conversation_id))},
                UpdateExpression="SET busy_until = :zero",
                ConditionExpression="created_at = :created",
                ExpressionAttributeValues={":zero": _n(0), ":created": _n(session.created_at)},
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise

    def forget(self, conversation_id: str, session: Session) -> None:
        """Drop a session that can no longer be trusted (a cell that did not come back)."""
        try:
            self._db.delete_item(
                TableName=self._table,
                Key={"PK": self._pk, "SK": _s(session_sk(conversation_id))},
                ConditionExpression="created_at = :created",
                ExpressionAttributeValues={":created": _n(session.created_at)},
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise

    def _seal(self, session_id: str, conversation_id: str) -> bytes:
        blob: bytes = self._kms.encrypt(
            KeyId=self._key,
            Plaintext=session_id.encode(),
            EncryptionContext=_context(self._user, conversation_id),
        )["CiphertextBlob"]
        return blob

    def _open(self, sealed: bytes, conversation_id: str) -> str:
        plain: bytes = self._kms.decrypt(
            KeyId=self._key,
            CiphertextBlob=sealed,
            EncryptionContext=_context(self._user, conversation_id),
        )["Plaintext"]
        return plain.decode()

    def mark_hydrated(self, conversation_id: str, session: Session, file_ids: list[str]) -> None:
        """The attached files written into the session: not written again into it."""
        if not file_ids:
            return
        self._db.update_item(
            TableName=self._table,
            Key={"PK": self._pk, "SK": _s(session_sk(conversation_id))},
            UpdateExpression="ADD hydrated :ids",
            ConditionExpression="created_at = :created",
            ExpressionAttributeValues={
                ":ids": {"SS": sorted(set(file_ids))},
                ":created": _n(session.created_at),
            },
        )

    # --- Files of the chat (U1's records, ``mango_api.chat_files_store``) -----------------

    def ready_uploads(self, conversation_id: str, now: int) -> list[UploadedFile]:
        """What the person attached to the conversation and its scan cleared (D116 (2)):
        ``ready``, not deleted, not expired. Read here again: the model never names them."""
        out: list[UploadedFile] = []
        kwargs: dict[str, Any] = {
            "TableName": self._table,
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": {
                ":pk": self._pk,
                ":prefix": _s(f"{FILE_PREFIX}{conversation_id}#"),
            },
            "ConsistentRead": True,
        }
        while True:
            page = self._db.query(**kwargs)
            for item in page.get("Items", []):
                if (
                    item.get("origin", {}).get("S") == "upload"
                    and item.get("status", {}).get("S") == "ready"
                    and not item.get("deleted", {}).get("BOOL", False)
                    and int(item.get("expires_at", {}).get("N", "0")) > now
                ):
                    out.append(
                        UploadedFile(
                            file_id=item["file_id"]["S"],
                            name=item["name"]["S"],
                            size=int(item["size"]["N"]),
                        )
                    )
            start = page.get("LastEvaluatedKey")
            if not start:
                return out
            kwargs["ExclusiveStartKey"] = start

    def chat_file(self, conversation_id: str, wanted: str, now: int) -> ChatFile | None:
        """The file of the conversation the model named, by id or by name: not deleted, not
        expired, not blocked by its scan. By name, the newest one that has it (a cell that
        saves the same name again hands out a new file). Read in the person's own partition:
        the model cannot name another person's or another conversation's file."""
        best: ChatFile | None = None
        kwargs: dict[str, Any] = {
            "TableName": self._table,
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": {
                ":pk": self._pk,
                ":prefix": _s(f"{FILE_PREFIX}{conversation_id}#"),
            },
            "ConsistentRead": True,
        }
        while True:
            page = self._db.query(**kwargs)
            for item in page.get("Items", []):
                if (
                    item.get("deleted", {}).get("BOOL", False)
                    or int(item.get("expires_at", {}).get("N", "0")) <= now
                    or item.get("status", {}).get("S") not in {"ready", "verifying"}
                ):
                    continue
                found = ChatFile(
                    file_id=item["file_id"]["S"],
                    name=item["name"]["S"],
                    origin=item.get("origin", {}).get("S", ""),
                    status=item["status"]["S"],
                    created_at=int(item.get("created_at", {}).get("N", "0")),
                )
                if found.file_id == wanted:
                    return found
                if wanted in {found.name, found.name.rsplit("/", 1)[-1]} and (
                    best is None or found.created_at >= best.created_at
                ):
                    best = found
            start = page.get("LastEvaluatedKey")
            if not start:
                return best
            kwargs["ExclusiveStartKey"] = start

    def record_generated(self, conversation_id: str, files: list[GeneratedFile], now: int) -> None:
        """A record per file a cell handed out, as mango-api records an attached one, waiting
        for the scan of its object (``verifying``): the chat delivers it once it is clean."""
        expires = now + RUN_RETENTION_SECONDS
        for f in files:
            self._db.put_item(
                TableName=self._table,
                Item={
                    "PK": self._pk,
                    "SK": _s(f"{FILE_PREFIX}{conversation_id}#{f.file_id}"),
                    "file_id": _s(f.file_id),
                    "conversation_id": _s(conversation_id),
                    "origin": _s("generated"),
                    "name": _s(f.name),
                    "kind": _s(f.kind),
                    "size": _n(f.size),
                    "status": _s("verifying"),
                    "status_at": _n(now),
                    "created_at": _n(now),
                    "expires_at": _n(expires),
                    "sha256": _s(f.sha256),
                    "ttl": _n(expires + 86400),
                },
                ConditionExpression="attribute_not_exists(PK)",
            )

    # --- Cells ----------------------------------------------------------------------------

    def cells_of_turn(self, turn_id: str) -> int:
        response = self._db.query(
            TableName=self._table,
            KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
            ExpressionAttributeValues={":pk": self._pk, ":prefix": _s(turn_prefix(turn_id))},
            Select="COUNT",
            ConsistentRead=True,
        )
        return int(response.get("Count", 0))

    def begin_cell(
        self,
        *,
        turn_id: str,
        run_id: str,
        conversation_id: str,
        session_seconds: int,
        code: str,
        now: int,
        render_of: str | None = None,
    ) -> None:
        """The cell before it runs: if nothing more is ever written, it counts its whole
        cutoff (``mango_core.code_sandbox.cell_use``).

        ``render_of``: a call of ``render_document`` on that file id instead of a cell of code
        (``tool = render_document``, no ``code``): it counts as one of the turn's cells and is
        charged its seconds like one (D119)."""
        item: dict[str, Any] = {
            "PK": self._pk,
            "SK": _s(run_sk(turn_id, run_id)),
            "conversation_id": _s(conversation_id),
            "state": _s("running"),
            "session_seconds": _n(session_seconds),
            "created_at": _n(now),
            "ttl": _n(now + RUN_RETENTION_SECONDS),
        }
        if render_of is None:
            item["code"] = _s(code)
        else:
            item["tool"] = _s(RENDER_TOOL)
            item["file_id"] = _s(render_of)
        self._db.put_item(
            TableName=self._table,
            Item=item,
            ConditionExpression="attribute_not_exists(SK)",
        )

    def end_cell(self, *, turn_id: str, run_id: str, result: dict[str, Any]) -> None:
        """The cell's result for the chat and its metered use (``result`` in DynamoDB form)."""
        names = {f"#{k}": k for k in result}
        values = {f":{k}": v for k, v in result.items()}
        self._db.update_item(
            TableName=self._table,
            Key={"PK": self._pk, "SK": _s(run_sk(turn_id, run_id))},
            UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in result),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )


def _layout(item: dict[str, Any]) -> Layout:
    return Layout(data=item["data"]["S"], out=item["out"]["S"], lib=item["lib"]["S"])
