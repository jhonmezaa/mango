"""Credentials that sign the presigned URLs a browser uses (D86 (4), D88 (9)).

A presigned URL carries the session of whoever signed it (``x-amz-security-token``). Signed
with the credentials of the ECS task of mango-api, every download of a PDF and every upload
of a document is the task's credentials used from the internet: GuardDuty reports it as
``UnauthorizedAccess:IAMUser/ResourceCredentialExfiltration.OutsideAWS`` (severity 8, seen
in an installation on 2026-10-21).

So nothing is ever signed with the task's credentials. mango-api assumes
``Mango-<ns>-Presign`` with STS, one session per person, ``SourceIdentity`` = that person
(rule 5): the role can only put objects under ``uploads/`` of the documents bucket and get
them under ``owner/`` of the reports bucket, with their keys through S3, and its trust only
takes mango-api's task role with a source identity. A session lasts 30 minutes and is kept
while it has more life left than the longest URL (15 minutes), so every URL lives its full
time.

Security notes (security-best-practices, FastAPI): the source identity is the verified
subject of the caller, checked against the pattern STS accepts; no credential is logged; a
role that cannot be assumed makes signing unavailable (503), never a fallback to the task's
credentials.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

logger = logging.getLogger(__name__)

SESSION_SECONDS = 30 * 60
"""Life of a signing session."""
LONGEST_URL_SECONDS = 15 * 60
"""The presigned POST of an upload (D88 (9)); a PDF link lives 5 minutes (D86 (4))."""
_MARGIN_SECONDS = 60
MAX_SESSIONS = 1000
"""People whose session is kept at once; the oldest goes first."""
SESSION_NAME = "mango-presign"
_SOURCE_IDENTITY_RE = re.compile(r"^[\w+=,.@-]{2,64}$")
S3_CONFIG = Config(signature_version="s3v4", s3={"addressing_style": "virtual"})
"""SigV4 (the buckets are encrypted with KMS) and each bucket's own host name."""


class SigningUnavailableError(Exception):
    """The signing role could not be assumed: nothing is signed."""


@dataclass(frozen=True)
class _Session:
    client: Any
    expires_at: float


class PresignSessions:
    """S3 clients with the credentials of ``Mango-<ns>-Presign`` for one person."""

    def __init__(
        self,
        sts: Any,
        role_arn: str,
        region: str,
        *,
        clock: Callable[[], float] = time.time,
        client_factory: Callable[[dict[str, str]], Any] | None = None,
    ) -> None:
        self._sts = sts
        self._role = role_arn
        self._region = region
        self._clock = clock
        self._factory = client_factory or self._s3_client
        self._sessions: OrderedDict[str, _Session] = OrderedDict()
        self._lock = threading.Lock()

    def _s3_client(self, credentials: dict[str, str]) -> Any:
        return boto3.client(
            "s3",
            region_name=self._region,
            config=S3_CONFIG,
            aws_access_key_id=credentials["AccessKeyId"],
            aws_secret_access_key=credentials["SecretAccessKey"],
            aws_session_token=credentials["SessionToken"],
        )

    def s3_for(self, user_id: str) -> S3Client:
        """An S3 client that signs as the presign role, for ``user_id``."""
        if not _SOURCE_IDENTITY_RE.fullmatch(user_id):
            raise SigningUnavailableError("the user cannot be a source identity")
        now = self._clock()
        with self._lock:
            session = self._sessions.get(user_id)
            if (
                session is not None
                and session.expires_at - now > LONGEST_URL_SECONDS + _MARGIN_SECONDS
            ):
                self._sessions.move_to_end(user_id)
                client: S3Client = session.client
                return client
        try:
            response = self._sts.assume_role(
                RoleArn=self._role,
                RoleSessionName=SESSION_NAME,
                SourceIdentity=user_id,
                DurationSeconds=SESSION_SECONDS,
            )
        except (BotoCoreError, ClientError) as exc:
            logger.exception("presign role could not be assumed")
            raise SigningUnavailableError(type(exc).__name__) from exc
        credentials = response["Credentials"]
        expiration = credentials["Expiration"]
        expires_at = (
            expiration.timestamp() if hasattr(expiration, "timestamp") else now + SESSION_SECONDS
        )
        client = self._factory(credentials)
        with self._lock:
            self._sessions[user_id] = _Session(client, expires_at)
            self._sessions.move_to_end(user_id)
            while len(self._sessions) > MAX_SESSIONS:
                self._sessions.popitem(last=False)
        return client
