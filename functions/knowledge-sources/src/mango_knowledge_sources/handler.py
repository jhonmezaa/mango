"""The role that reads one approved source of a knowledge base (D88 (10), (20); TM-K2, TM-K7).

``Mango-<ns>-KnowledgeSources`` is invoked only by mango-api, after an administrator approved a
source (``ensure``) and after a source was removed (``delete``). The event names the knowledge
base and the source, nothing else: the bucket and the prefix are read from the registry, where
only an approval puts them, so no request can name another bucket.

``ensure`` creates ``Mango-<ns>-kbsrc-<source id>`` for an ``approved`` source:

* its permissions boundary is ``Mango-<ns>-kbsrc-boundary`` (objects of this account only,
  never a bucket of Mango); IAM refuses this function any write on a role under that prefix
  without it;
* its policy names that bucket and that prefix and nothing else: ``s3:ListBucket`` on the
  bucket, only for keys under the prefix, and ``s3:GetObject`` under the prefix;
* only the synchronization may assume it, and only with a ``SourceIdentity`` (rule 5: who
  synchronizes). An existing role is used only if it still has that boundary and that trust:
  this function never repairs a role someone changed, it fails.

It then records the role's ARN on the source. ``delete`` removes the role of a source that is
being removed (``removing``) and forgets its ARN. Neither ever touches a role of another
prefix or one without the boundary. Errors carry the AWS error code only.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from functools import cache
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from mango_core.knowledge import ID_PATTERN, SourceStatus

logger = logging.getLogger()
logger.setLevel(logging.INFO)

POLICY_NAME = "source"
_ID_RE = re.compile(ID_PATTERN)
_NOT_FOUND = "NoSuchEntity"
_OPERATIONS = frozenset({"ensure", "delete"})


class SourceStepError(Exception):
    """What the step answers instead of a role: a code, never AWS's message."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Settings:
    namespace: str
    account_id: str
    table: str
    boundary_arn: str
    sync_role_arn: str
    """``Mango-<ns>-KnowledgeSync``: the only principal that may assume a source role."""

    @staticmethod
    def from_env() -> Settings:
        env = os.environ
        return Settings(
            namespace=env["MANGO_NAMESPACE"],
            account_id=env["ACCOUNT_ID"],
            table=env["KNOWLEDGE_TABLE"],
            boundary_arn=env["SOURCE_BOUNDARY_ARN"],
            sync_role_arn=env["SYNC_ROLE_ARN"],
        )

    def role_name(self, src_id: str) -> str:
        return f"Mango-{self.namespace}-kbsrc-{src_id}"


@dataclass(frozen=True)
class Source:
    kb_id: str
    src_id: str
    bucket: str
    prefix: str
    status: SourceStatus
    role_arn: str | None


def trust_policy(settings: Settings) -> dict[str, Any]:
    """The synchronization only, and only with a ``SourceIdentity`` (AGENTS.md, rule 5)."""
    principal = {"AWS": f"arn:aws:iam::{settings.account_id}:root"}
    condition = {"ArnEquals": {"aws:PrincipalArn": settings.sync_role_arn}}
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "SyncAsWhoeverSynchronizes",
                "Effect": "Allow",
                "Principal": principal,
                "Action": "sts:AssumeRole",
                "Condition": {**condition, "Null": {"sts:SourceIdentity": "false"}},
            },
            {
                "Sid": "SetSourceIdentity",
                "Effect": "Allow",
                "Principal": principal,
                "Action": "sts:SetSourceIdentity",
                "Condition": {**condition, "StringLike": {"sts:SourceIdentity": "*"}},
            },
        ],
    }


def role_policy(source: Source) -> dict[str, Any]:
    """That bucket and that prefix, nothing else (D88 (10)); the boundary keeps it to this
    account and away from Mango's buckets whatever it says."""
    bucket = f"arn:aws:s3:::{source.bucket}"
    listing: dict[str, Any] = {
        "Sid": "ListThePrefix",
        "Effect": "Allow",
        "Action": "s3:ListBucket",
        "Resource": bucket,
    }
    if source.prefix:
        listing["Condition"] = {"StringLike": {"s3:prefix": [f"{source.prefix}*"]}}
    return {
        "Version": "2012-10-17",
        "Statement": [
            listing,
            {
                "Sid": "ReadThePrefix",
                "Effect": "Allow",
                "Action": "s3:GetObject",
                "Resource": f"{bucket}/{source.prefix}*",
            },
        ],
    }


def _canonical(document: Any) -> str:
    if isinstance(document, str):
        document = json.loads(document)
    return json.dumps(document, sort_keys=True, separators=(",", ":"))


def _code(exc: ClientError) -> str:
    return str(exc.response.get("Error", {}).get("Code", ""))


class Sources:
    def __init__(self, settings: Settings, iam: Any, dynamodb: Any) -> None:
        self._s = settings
        self._iam = iam
        self._db = dynamodb

    # --- Registry ---------------------------------------------------------------------------

    def _key(self, kb_id: str, src_id: str) -> dict[str, Any]:
        return {"PK": {"S": f"KB#{kb_id}"}, "SK": {"S": f"SRC#{src_id}"}}

    def load(self, kb_id: str, src_id: str) -> Source:
        try:
            item = self._db.get_item(
                TableName=self._s.table, Key=self._key(kb_id, src_id), ConsistentRead=True
            ).get("Item")
        except (ClientError, BotoCoreError):
            raise SourceStepError("registry_unavailable") from None
        if item is None:
            raise SourceStepError("source_not_found")
        return Source(
            kb_id=item["kb_id"]["S"],
            src_id=item["src_id"]["S"],
            bucket=item["bucket"]["S"],
            prefix=item.get("prefix", {}).get("S", ""),
            status=SourceStatus(item["status"]["S"]),
            role_arn=item.get("role_arn", {}).get("S"),
        )

    def _record(self, source: Source, role_arn: str | None, status: SourceStatus) -> None:
        """Set or forget the role's ARN while the source is still in ``status``."""
        expression = "SET role_arn = :arn" if role_arn else "REMOVE role_arn"
        values: dict[str, Any] = {":status": {"S": status}}
        if role_arn:
            values[":arn"] = {"S": role_arn}
        try:
            self._db.update_item(
                TableName=self._s.table,
                Key=self._key(source.kb_id, source.src_id),
                UpdateExpression=expression,
                ConditionExpression="#status = :status",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues=values,
            )
        except ClientError as exc:
            if _code(exc) == "ConditionalCheckFailedException":
                raise SourceStepError("source_changed") from None
            raise SourceStepError("registry_unavailable") from None
        except BotoCoreError:
            raise SourceStepError("registry_unavailable") from None

    # --- IAM --------------------------------------------------------------------------------

    def _get(self, name: str) -> dict[str, Any] | None:
        try:
            return dict(self._iam.get_role(RoleName=name)["Role"])
        except ClientError as exc:
            if _code(exc) == _NOT_FOUND:
                return None
            raise SourceStepError(f"iam_{_code(exc) or 'error'}") from None
        except BotoCoreError:
            raise SourceStepError("iam_unreachable") from None

    def _verify(self, role: dict[str, Any]) -> None:
        boundary = role.get("PermissionsBoundary", {}).get("PermissionsBoundaryArn")
        if boundary != self._s.boundary_arn:
            raise SourceStepError("role_without_boundary")
        if role.get("Path") != "/":
            raise SourceStepError("role_path_mismatch")
        if _canonical(role.get("AssumeRolePolicyDocument")) != _canonical(trust_policy(self._s)):
            raise SourceStepError("role_trust_mismatch")

    def _iam_call(self, operation: str, **arguments: Any) -> None:
        try:
            getattr(self._iam, operation)(**arguments)
        except ClientError as exc:
            raise SourceStepError(f"iam_{_code(exc) or 'error'}") from None
        except BotoCoreError:
            raise SourceStepError("iam_unreachable") from None

    def ensure(self, kb_id: str, src_id: str) -> dict[str, Any]:
        source = self.load(kb_id, src_id)
        if source.status is not SourceStatus.APPROVED:
            # Nothing is read before an approval (D88 (20)), nor after a removal.
            raise SourceStepError("source_not_approved")
        name = self._s.role_name(src_id)
        role = self._get(name)
        created = False
        if role is None:
            try:
                self._iam.create_role(
                    RoleName=name,
                    AssumeRolePolicyDocument=json.dumps(
                        trust_policy(self._s), separators=(",", ":")
                    ),
                    PermissionsBoundary=self._s.boundary_arn,
                    Description="Mango: reads one approved source of a knowledge base (D88)",
                    MaxSessionDuration=3600,
                    Tags=[
                        {"Key": "mango:kb", "Value": kb_id},
                        {"Key": "mango:source", "Value": src_id},
                    ],
                )
                created = True
            except ClientError as exc:
                if _code(exc) != "EntityAlreadyExists":
                    raise SourceStepError(f"iam_{_code(exc) or 'error'}") from None
            except BotoCoreError:
                raise SourceStepError("iam_unreachable") from None
            role = self._get(name)
            if role is None:
                raise SourceStepError("role_not_found")
        self._verify(role)
        self._iam_call(
            "put_role_policy",
            RoleName=name,
            PolicyName=POLICY_NAME,
            PolicyDocument=json.dumps(role_policy(source), separators=(",", ":")),
        )
        role_arn = str(role["Arn"])
        self._record(source, role_arn, SourceStatus.APPROVED)
        return {"outcome": "created" if created else "exists", "role_arn": role_arn}

    def delete(self, kb_id: str, src_id: str) -> dict[str, Any]:
        source = self.load(kb_id, src_id)
        if source.status is not SourceStatus.REMOVING:
            raise SourceStepError("source_not_removed")
        name = self._s.role_name(src_id)
        role = self._get(name)
        if role is not None:
            # IAM refuses these on a role without the boundary: never one this did not make.
            try:
                self._iam.delete_role_policy(RoleName=name, PolicyName=POLICY_NAME)
            except ClientError as exc:
                if _code(exc) != _NOT_FOUND:
                    raise SourceStepError(f"iam_{_code(exc) or 'error'}") from None
            except BotoCoreError:
                raise SourceStepError("iam_unreachable") from None
            self._iam_call("delete_role", RoleName=name)
        if source.role_arn:
            self._record(source, None, SourceStatus.REMOVING)
        return {"outcome": "deleted" if role is not None else "absent"}


def handle(event: dict[str, Any], sources: Sources) -> dict[str, Any]:
    operation, kb_id, src_id = event.get("op"), event.get("kb_id"), event.get("src_id")
    if (
        operation not in _OPERATIONS
        or not isinstance(kb_id, str)
        or not isinstance(src_id, str)
        or not _ID_RE.fullmatch(kb_id)
        or not _ID_RE.fullmatch(src_id)
    ):
        return {"error": "invalid_event"}
    try:
        result = (
            sources.ensure(kb_id, src_id)
            if operation == "ensure"
            else sources.delete(kb_id, src_id)
        )
    except SourceStepError as exc:
        # Ids and the code only: never the bucket, never AWS's message.
        line = {"event": "kb.source_role", "op": operation, "error": exc.code}
        logger.error(json.dumps(line))  # noqa: TRY400 - the code, never AWS's message
        return {"error": exc.code}
    logger.info(
        json.dumps(
            {
                "event": "kb.source_role",
                "op": operation,
                "src": src_id,
                **{"outcome": result["outcome"]},
            }
        )
    )
    return result


@cache
def _sources() -> Sources:
    return Sources(Settings.from_env(), boto3.client("iam"), boto3.client("dynamodb"))


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    return handle(event, _sources())
