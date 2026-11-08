"""Records of the files of the chat (D116), in the owner's partition of the Conversations table.

Every call goes through the row-level security client of the person (``conversations.
RlsClientFactory``: a session policy that only reaches items whose partition key is
``USER#<sub>``), so a bug here cannot read another person's files.

Items:

* ``CFILE#<conversation>#<file id>``: a file of a conversation, what it is called, its kind and
  size, where it is in its life (:class:`FileStatus`) and when it goes (90 days, D116 (1)).
  The name a person gave the file lives only here, never in a key of the bucket (TM-CF8).
* ``CSCAN#<key of the bucket>``: what the malware scan said of one object, written by the
  function ``Mango-<ns>-ChatFilesScan`` (``functions/chat-files-scan``) and only read here.

Nothing is deleted with ``DeleteItem``, which the session policy does not allow: a record that
goes is marked ``deleted`` and expires at once with the table's TTL.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient


class ChatFileStoreUnavailableError(Exception):
    """DynamoDB could not be reached; callers fail closed."""


class FileStatus(StrEnum):
    UPLOADING = "uploading"
    """Signed; the browser has not said it posted the file yet."""
    SCANNING = "scanning"
    """Posted under ``uploads/``: waiting for its malware scan."""
    VERIFYING = "verifying"
    """Checked and copied under ``owner/``: waiting for the scan of the copy."""
    READY = "ready"
    BLOCKED = "blocked"
    """The scan did not say ``NO_THREATS_FOUND`` (TM-CF3): never delivered."""
    TYPE_MISMATCH = "type_mismatch"
    """Its bytes are not of the kind its name says."""
    TOO_LARGE = "too_large"
    FAILED = "failed"
    """Not uploaded, of another size than announced, or its scan never arrived."""


ENDED = frozenset(
    {
        FileStatus.READY,
        FileStatus.BLOCKED,
        FileStatus.TYPE_MISMATCH,
        FileStatus.TOO_LARGE,
        FileStatus.FAILED,
    }
)


@dataclass(frozen=True)
class ChatFile:
    file_id: str
    conversation_id: str
    owner: str
    """The person of the partition the record was read from, never the request."""
    origin: str
    """``upload`` (attached by the person) or ``generated`` (by the code sandbox, C2)."""
    name: str
    kind: str
    """Its extension, one of ``mango_core.chat_files.TYPES``."""
    size: int
    status: FileStatus
    status_at: int
    created_at: int
    expires_at: int
    upload_id: str = ""
    sha256: str = ""
    deleted: bool = False
    guard: str = ""
    """What the guardrail said of the texts of a chart or a table (``pass`` or ``blocked``),
    once: a file never changes. Empty until it was asked."""


@dataclass(frozen=True)
class ScanRecord:
    result: str
    etag: str
    scanned_at: int


def file_sk(conversation_id: str, file_id: str) -> str:
    return f"CFILE#{conversation_id}#{file_id}"


def scan_sk(key: str) -> str:
    """The same key the scan function writes (``mango_chat_files_scan.handler``)."""
    return f"CSCAN#{key}"


def _file(item: dict[str, Any]) -> ChatFile:
    pk = item["PK"]["S"]
    return ChatFile(
        file_id=item["file_id"]["S"],
        conversation_id=item["conversation_id"]["S"],
        owner=pk.removeprefix("USER#") if pk.startswith("USER#") else "",
        origin=item["origin"]["S"],
        name=item["name"]["S"],
        kind=item["kind"]["S"],
        size=int(item["size"]["N"]),
        status=FileStatus(item["status"]["S"]),
        status_at=int(item["status_at"]["N"]),
        created_at=int(item["created_at"]["N"]),
        expires_at=int(item["expires_at"]["N"]),
        upload_id=item.get("upload_id", {}).get("S", ""),
        sha256=item.get("sha256", {}).get("S", ""),
        deleted=item.get("deleted", {}).get("BOOL", False),
        guard=item.get("guard", {}).get("S", ""),
    )


class ChatFileStore:
    def __init__(self, clients: Callable[[str], DynamoDBClient], table: str) -> None:
        self._clients = clients
        self._table = table

    def _key(self, user_id: str, sk: str) -> dict[str, Any]:
        return {"PK": {"S": f"USER#{user_id}"}, "SK": {"S": sk}}

    def put_new(self, user_id: str, files: list[ChatFile]) -> None:
        """Record new files; an id that already exists is never overwritten."""
        try:
            client = self._clients(user_id)
            for f in files:
                item: dict[str, Any] = {
                    **self._key(user_id, file_sk(f.conversation_id, f.file_id)),
                    "file_id": {"S": f.file_id},
                    "conversation_id": {"S": f.conversation_id},
                    "origin": {"S": f.origin},
                    "name": {"S": f.name},
                    "kind": {"S": f.kind},
                    "size": {"N": str(f.size)},
                    "status": {"S": f.status.value},
                    "status_at": {"N": str(f.status_at)},
                    "created_at": {"N": str(f.created_at)},
                    "expires_at": {"N": str(f.expires_at)},
                    # The record outlives its file by a day, so «Ya no disponible» can be said.
                    "ttl": {"N": str(f.expires_at + 86400)},
                }
                if f.upload_id:
                    item["upload_id"] = {"S": f.upload_id}
                client.put_item(
                    TableName=self._table,
                    Item=item,
                    ConditionExpression="attribute_not_exists(PK)",
                )
        except (BotoCoreError, ClientError) as exc:
            raise ChatFileStoreUnavailableError(type(exc).__name__) from exc

    def file(self, user_id: str, conversation_id: str, file_id: str) -> ChatFile | None:
        try:
            item = (
                self._clients(user_id)
                .get_item(
                    TableName=self._table,
                    Key=self._key(user_id, file_sk(conversation_id, file_id)),
                    ConsistentRead=True,
                )
                .get("Item")
            )
        except (BotoCoreError, ClientError) as exc:
            raise ChatFileStoreUnavailableError(type(exc).__name__) from exc
        return _file(item) if item is not None else None

    def files(self, user_id: str, conversation_id: str) -> list[ChatFile]:
        """Every file recorded for a conversation, deleted ones included."""
        out: list[ChatFile] = []
        kwargs: dict[str, Any] = {
            "TableName": self._table,
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": {
                ":pk": {"S": f"USER#{user_id}"},
                ":prefix": {"S": f"CFILE#{conversation_id}#"},
            },
        }
        try:
            while True:
                resp = self._clients(user_id).query(**kwargs)
                out.extend(_file(i) for i in resp.get("Items", []))
                if "LastEvaluatedKey" not in resp:
                    return out
                kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
        except (BotoCoreError, ClientError) as exc:
            raise ChatFileStoreUnavailableError(type(exc).__name__) from exc

    def move(
        self,
        f: ChatFile,
        to: FileStatus,
        *,
        now: int,
        sha256: str | None = None,
        size: int | None = None,
    ) -> ChatFile | None:
        """Move a file from the status it was read in to ``to``; ``None`` when another
        request moved it first (the caller reads it again)."""
        values: dict[str, Any] = {
            ":to": {"S": to.value},
            ":at": {"N": str(now)},
            ":from": {"S": f.status.value},
            ":f": {"BOOL": False},
        }
        update = "SET #s = :to, status_at = :at"
        if sha256 is not None:
            update += ", sha256 = :h"
            values[":h"] = {"S": sha256}
        if size is not None:
            # A PDF of the Canvas learns its size once it is rendered (D124 (3)).
            update += ", #z = :z"
            values[":z"] = {"N": str(size)}
        try:
            self._clients(f.owner).update_item(
                TableName=self._table,
                Key=self._key(f.owner, file_sk(f.conversation_id, f.file_id)),
                UpdateExpression=update,
                ConditionExpression=(
                    "#s = :from AND (attribute_not_exists(deleted) OR deleted = :f)"
                ),
                ExpressionAttributeNames={
                    "#s": "status",
                    **({"#z": "size"} if size is not None else {}),
                },
                ExpressionAttributeValues=values,
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return None
            raise ChatFileStoreUnavailableError(type(exc).__name__) from exc
        except BotoCoreError as exc:
            raise ChatFileStoreUnavailableError(type(exc).__name__) from exc
        return replace(
            f,
            status=to,
            status_at=now,
            sha256=sha256 or f.sha256,
            size=f.size if size is None else size,
        )

    def set_guard(self, f: ChatFile, verdict: str) -> ChatFile:
        """Keep what the guardrail said of a chart or a table (``chat_outputs``). Only the first
        verdict is kept: a file's bytes never change, so two requests say the same."""
        try:
            self._clients(f.owner).update_item(
                TableName=self._table,
                Key=self._key(f.owner, file_sk(f.conversation_id, f.file_id)),
                UpdateExpression="SET guard = :v",
                ConditionExpression="attribute_exists(PK) AND attribute_not_exists(guard)",
                ExpressionAttributeValues={":v": {"S": verdict}},
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise ChatFileStoreUnavailableError(type(exc).__name__) from exc
        except BotoCoreError as exc:
            raise ChatFileStoreUnavailableError(type(exc).__name__) from exc
        return replace(f, guard=verdict)

    def mark_deleted(self, f: ChatFile, *, now: int) -> None:
        """The file is gone (D116 (9)): its record says so and expires with the TTL."""
        try:
            self._clients(f.owner).update_item(
                TableName=self._table,
                Key=self._key(f.owner, file_sk(f.conversation_id, f.file_id)),
                UpdateExpression="SET deleted = :t, #ttl = :now",
                ConditionExpression="attribute_exists(PK)",
                ExpressionAttributeNames={"#ttl": "ttl"},
                ExpressionAttributeValues={":t": {"BOOL": True}, ":now": {"N": str(now)}},
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return
            raise ChatFileStoreUnavailableError(type(exc).__name__) from exc
        except BotoCoreError as exc:
            raise ChatFileStoreUnavailableError(type(exc).__name__) from exc

    def scan(self, user_id: str, key: str) -> ScanRecord | None:
        """What the malware scan said of ``key``, if it said anything yet."""
        try:
            item = (
                self._clients(user_id)
                .get_item(
                    TableName=self._table,
                    Key=self._key(user_id, scan_sk(key)),
                    ConsistentRead=True,
                )
                .get("Item")
            )
        except (BotoCoreError, ClientError) as exc:
            raise ChatFileStoreUnavailableError(type(exc).__name__) from exc
        if item is None or "scan_result" not in item:
            return None
        return ScanRecord(
            result=item["scan_result"]["S"],
            etag=item.get("scan_etag", {}).get("S", ""),
            scanned_at=int(item.get("scanned_at", {}).get("N", "0")),
        )
