"""The copy of the sources of a knowledge base into Mango's bucket (D88 (10), (19), (20)).

Each synchronization of a knowledge base with sources on existing buckets compares every
approved source with what was copied from it before, and leaves the documents bucket like the
source:

* **Who reads:** the role of that source (``Mango-<ns>-kbsrc-<source id>``, D88 (39)), assumed
  with the ``SourceIdentity`` of whoever synchronizes (rule 5). It reads only that bucket and
  that prefix. Writing goes to ``kb/<kb id>/docs/<doc id>`` with the synchronization's own
  role, which never reads the source; the source's role never writes to Mango.
* **What is copied:** the same documents an upload may be (``mango_core.knowledge_files``):
  the kind by extension, the bytes in agreement with it, at most 50 MB, within the limits of
  the knowledge base. An object that does not qualify is recorded ``failed`` with its reason,
  and copies nothing. What the role cannot read (a key of its own) is ``failed`` too
  (``protected``).
* **Changes:** a new key is copied; a key whose ETag changed is copied as a new document and
  the old one deleted; a key gone from the source is deleted (D88 (19)). The deletions are the
  synchronization's own, verified as any other (D88 (16)).
* **Bounded:** one step copies for at most ``STEP_SECONDS`` or ``STEP_BYTES``; the state
  machine runs it again while something is left. The state carries no key nor name: each step
  lists the source again.
* **The role:** a source approved without a role (its function failed when it was approved)
  asks ``Mango-<ns>-KnowledgeSources`` for it again; a removed one, for its deletion. A removed
  source with no document and no role left loses its record.
* **A new role:** IAM takes a while to let a role it just created be assumed and read. A
  refusal in the first ``PROPAGATION`` after the source was approved (or after its role was
  asked for again in this step), listing or reading, is counted apart (``propagating``): the
  state machine waits and copies again, a few times. Its last try (``patient`` False) takes
  a refusal as it is: the source is unreadable, or the document ``protected``.

Nothing of a key, a name or a document is logged: ids, counts and AWS error codes.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_core import knowledge
from mango_core.knowledge import DocumentStatus, SourceStatus
from mango_core.knowledge_files import (
    HEAD_BYTES,
    MAX_FILE_BYTES,
    TAIL_BYTES,
    TYPES,
    ZIP_PARTS,
    content_matches,
    display_name,
    extension,
)
from mango_knowledge_sync.store import (
    CopiedDocument,
    DocumentRecord,
    KnowledgeBaseFullError,
    SourceRecord,
    SyncStore,
)

logger = logging.getLogger(__name__)

STEP_SECONDS = 180
"""Of copying in one step: the function has 5 minutes."""
STEP_BYTES = 300 * 1024 * 1024
MAX_LISTED = 5000
"""Keys of one source looked at per step: above what a knowledge base may hold."""
_SOURCE_IDENTITY_RE = re.compile(r"^[A-Za-z0-9+=,.@_-]{2,64}$")
_DENIED = frozenset({"AccessDenied", "AccessDeniedException", "KMS.AccessDeniedException"})
PROPAGATION = timedelta(minutes=5)
"""After a source is approved, how long a refusal may still be IAM not having its role ready."""


class SourceUnavailableError(Exception):
    """The source could not be read now (not a refusal): the next synchronization tries again."""


class RolePropagatingError(SourceUnavailableError):
    """The role of a source approved moments ago was refused: IAM may not have it ready yet."""


@dataclass
class CopyResult:
    copied: int = 0
    failed: int = 0
    removed: int = 0
    unavailable: int = 0
    propagating: int = 0
    more: bool = False
    full: bool = False
    by_source: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class Listed:
    key: str
    etag: str
    size: int


SessionFor = Callable[[str, str], Any]
"""``(role ARN, source identity)`` -> an S3 client acting as that role."""
RoleRequest = Callable[[str, str, str], None]
"""``(op, kb id, source id)``: asks ``Mango-<ns>-KnowledgeSources`` (``ensure``/``delete``)."""


def _code(exc: Exception) -> str:
    if isinstance(exc, ClientError):
        return str(exc.response.get("Error", {}).get("Code", "unknown"))
    return type(exc).__name__


def listing(s3: Any, source: SourceRecord) -> Iterator[Listed]:
    """The objects under the prefix of ``source``, as its role sees them (no folders)."""
    token: str | None = None
    seen = 0
    while True:
        request: dict[str, Any] = {"Bucket": source.bucket, "Prefix": source.prefix}
        if token:
            request["ContinuationToken"] = token
        page = s3.list_objects_v2(**request)
        for item in page.get("Contents", []):
            key = str(item["Key"])
            if key.endswith("/"):
                continue
            seen += 1
            if seen > MAX_LISTED:
                return
            yield Listed(key, str(item["ETag"]), int(item["Size"]))
        token = page.get("NextContinuationToken")
        if not page.get("IsTruncated") or not token:
            return


class SourceCopier:
    def __init__(
        self,
        *,
        store: SyncStore,
        documents_s3: Any,
        documents_bucket: str,
        session_for: SessionFor,
        request_role: RoleRequest | None,
        clock: Callable[[], float] = time.monotonic,
        now_iso: Callable[[], str],
    ) -> None:
        self._store = store
        self._s3 = documents_s3
        self._bucket = documents_bucket
        self._session_for = session_for
        self._request_role = request_role
        self._clock = clock
        self._now_iso = now_iso

    # --- Roles of the sources ---------------------------------------------------------------

    def _ask(self, op: str, kb_id: str, src_id: str) -> None:
        if self._request_role is None:
            return
        try:
            self._request_role(op, kb_id, src_id)
        except Exception as exc:  # noqa: BLE001 - the next synchronization asks again
            logger.warning("the role of source %s was not %s: %s", src_id, op, _code(exc))

    # --- One step ---------------------------------------------------------------------------

    def step(
        self, kb_id: str, requester_id: str, *, copy: bool, patient: bool = True
    ) -> CopyResult:
        """Bring the documents of ``kb_id`` in line with its sources. ``copy`` False: only what
        removed sources leave behind (a synchronization that may not spend). ``patient`` False:
        a refusal of a new role is not waited for any more."""
        result = CopyResult()
        sources = self._store.sources(kb_id)
        if not sources:
            return result
        documents = [d for d in self._store.documents(kb_id) if d.src_id]
        by_source: dict[str, list[DocumentRecord]] = {}
        for document in documents:
            by_source.setdefault(str(document.src_id), []).append(document)
        active = {s.src_id for s in sources if s.status is SourceStatus.APPROVED}
        # Documents of a source that is no longer approved (removed, or gone) are deleted.
        for src_id, docs in by_source.items():
            if src_id not in active:
                result.removed += self._delete_all(kb_id, docs)
        for source in sources:
            if source.status is SourceStatus.REMOVING:
                self._finish_removal(kb_id, source, by_source.get(source.src_id, []))
        if copy and _SOURCE_IDENTITY_RE.fullmatch(requester_id):
            self._copy_sources(kb_id, requester_id, sources, by_source, result, patient=patient)
        return result

    def _copy_sources(
        self,
        kb_id: str,
        requester_id: str,
        sources: list[SourceRecord],
        by_source: dict[str, list[DocumentRecord]],
        result: CopyResult,
        *,
        patient: bool,
    ) -> None:
        started = self._clock()
        budget = [STEP_BYTES]
        for source in sources:
            if source.status is not SourceStatus.APPROVED:
                continue
            role_arn = source.role_arn or self._role_again(kb_id, source.src_id)
            if role_arn is None:
                result.unavailable += 1
                continue
            try:
                self._sync_source(
                    kb_id,
                    source=source,
                    role_arn=role_arn,
                    new_role=patient
                    and (source.role_arn is None or self._recent(source.decided_at)),
                    requester_id=requester_id,
                    documents=by_source.get(source.src_id, []),
                    result=result,
                    out_of_time=lambda: self._clock() - started > STEP_SECONDS or budget[0] <= 0,
                    budget=budget,
                )
            except RolePropagatingError:
                result.propagating += 1
            except SourceUnavailableError:
                result.unavailable += 1
            if result.more or result.full:
                break

    def _recent(self, decided_at: str | None) -> bool:
        """Whether the source was approved (and its role made) less than ``PROPAGATION`` ago."""
        if not decided_at:
            return False
        try:
            decided = datetime.fromisoformat(decided_at)
            now = datetime.fromisoformat(self._now_iso())
        except ValueError:
            return False
        if decided.tzinfo is None:
            decided = decided.replace(tzinfo=UTC)
        return now - decided < PROPAGATION

    def _role_again(self, kb_id: str, src_id: str) -> str | None:
        """Ask again for the role of an approved source that has none (D88 (39))."""
        self._ask("ensure", kb_id, src_id)
        return next((s.role_arn for s in self._store.sources(kb_id) if s.src_id == src_id), None)

    def _delete_all(self, kb_id: str, documents: list[DocumentRecord]) -> int:
        marked = 0
        for document in documents:
            if document.status is not DocumentStatus.DELETING:
                self._store.mark(kb_id, document.doc_id, DocumentStatus.DELETING, unless=None)
                marked += 1
        return marked

    def _finish_removal(
        self, kb_id: str, source: SourceRecord, documents: list[DocumentRecord]
    ) -> None:
        """A removed source goes once its documents are gone (verified) and its role too."""
        if documents:
            return
        if source.role_arn:
            self._ask("delete", kb_id, source.src_id)
            return
        self._store.remove_source(kb_id, source.src_id)

    def _sync_source(
        self,
        kb_id: str,
        *,
        source: SourceRecord,
        role_arn: str,
        new_role: bool,
        requester_id: str,
        documents: list[DocumentRecord],
        result: CopyResult,
        out_of_time: Callable[[], bool],
        budget: list[int],
    ) -> None:
        try:
            s3 = self._session_for(role_arn, requester_id)
            listed = {item.key: item for item in listing(s3, source)}
        except (ClientError, BotoCoreError) as exc:
            if new_role and _code(exc) in _DENIED:
                logger.info("source %s refused while its role is new: waiting", source.src_id)
                raise RolePropagatingError(_code(exc)) from None
            logger.warning("source %s could not be listed: %s", source.src_id, _code(exc))
            raise SourceUnavailableError(_code(exc)) from None
        current = {d.source_key: d for d in documents if d.status is not DocumentStatus.DELETING}
        # Gone from the source, or changed there: the copy goes (D88 (19)).
        for key, document in current.items():
            item = listed.get(str(key))
            if item is None or item.etag != document.source_etag:
                self._store.mark(kb_id, document.doc_id, DocumentStatus.DELETING, unless=None)
                result.removed += 1
        kept = {
            key
            for key, document in current.items()
            if (item := listed.get(str(key))) is not None and item.etag == document.source_etag
        }
        for key in sorted(set(listed) - kept):
            if out_of_time():
                result.more = True
                return
            item = listed[key]
            try:
                copied = self._copy(kb_id, source, s3, item, requester_id, new_role=new_role)
            except (ClientError, BotoCoreError) as exc:
                logger.warning(
                    "a document of source %s was not copied: %s", source.src_id, _code(exc)
                )
                raise SourceUnavailableError(_code(exc)) from None
            try:
                self._store.add_copied(kb_id, copied)
            except KnowledgeBaseFullError:
                if copied.status is DocumentStatus.UPLOADED:
                    # Not counted, and its object is not kept.
                    self._s3.delete_object(Bucket=self._bucket, Key=_key(kb_id, copied.doc_id))
                result.full = True
                return
            budget[0] -= copied.size
            if copied.status is DocumentStatus.UPLOADED:
                result.copied += 1
            else:
                result.failed += 1
            result.by_source[source.src_id] = result.by_source.get(source.src_id, 0) + 1

    def _copy(
        self,
        kb_id: str,
        source: SourceRecord,
        s3: Any,
        item: Listed,
        requester_id: str,
        *,
        new_role: bool,
    ) -> CopiedDocument:
        doc_id = knowledge.new_id()
        name = display_name(item.key) or "Documento"
        kind = extension(name)

        def recorded(
            status: DocumentStatus, reason: str | None, size: int, sha256: str = ""
        ) -> CopiedDocument:
            return CopiedDocument(
                doc_id=doc_id,
                name=name,
                size=size,
                content_type=TYPES.get(kind or "", "application/octet-stream"),
                status=status,
                reason=reason,
                sha256=sha256,
                src_id=source.src_id,
                source_key=item.key,
                source_etag=item.etag,
                uploaded_by=requester_id,
                created_at=self._now_iso(),
            )

        # Failed documents copy nothing and take no bytes of the knowledge base.
        if kind is None:
            return recorded(DocumentStatus.FAILED, "unsupported_type", 0)
        if item.size == 0 or item.size > MAX_FILE_BYTES:
            return recorded(DocumentStatus.FAILED, "too_large" if item.size else "empty", 0)
        try:
            body = s3.get_object(Bucket=source.bucket, Key=item.key, IfMatch=item.etag)[
                "Body"
            ].read()
        except ClientError as exc:
            if _code(exc) in _DENIED and new_role:
                # Its read permission may not be in force yet: not ``protected`` for good.
                raise RolePropagatingError(_code(exc)) from None
            if _code(exc) in _DENIED:
                return recorded(DocumentStatus.FAILED, "protected", 0)
            # Changed while it was being copied (PreconditionFailed), or S3 did not answer:
            # the next synchronization copies it.
            raise
        if len(body) != item.size:
            return recorded(DocumentStatus.FAILED, "size_mismatch", 0)
        tail = body[-TAIL_BYTES:] if kind in ZIP_PARTS else b""
        if not content_matches(kind, body[:HEAD_BYTES], tail, item.size):
            return recorded(DocumentStatus.FAILED, "type_mismatch", 0)
        response = self._s3.put_object(
            Bucket=self._bucket,
            Key=_key(kb_id, doc_id),
            Body=body,
            ContentType=TYPES[kind],
            ChecksumAlgorithm="SHA256",
        )
        checksum = response.get("ChecksumSHA256", "")
        sha256 = base64.b64decode(checksum).hex() if checksum else ""
        return recorded(DocumentStatus.UPLOADED, None, item.size, sha256)


def _key(kb_id: str, doc_id: str) -> str:
    return f"kb/{kb_id}/docs/{doc_id}"


def role_requester(lambda_client: Any, function_name: str) -> RoleRequest:
    """Asks ``Mango-<ns>-KnowledgeSources`` with ids, as mango-api does."""

    def request(op: str, kb_id: str, src_id: str) -> None:
        response = lambda_client.invoke(
            FunctionName=function_name,
            InvocationType="RequestResponse",
            Payload=json.dumps({"op": op, "kb_id": kb_id, "src_id": src_id}).encode(),
        )
        answer = json.loads(response["Payload"].read() or b"{}")
        if response.get("FunctionError") or not isinstance(answer, dict) or "error" in answer:
            raise RuntimeError(str(answer.get("error", "function_error"))[:64])

    return request


def session_for(sts: Any, session_factory: Callable[..., Any]) -> SessionFor:
    """An S3 client as the role of a source, with the ``SourceIdentity`` of who synchronizes."""

    def assume(role_arn: str, source_identity: str) -> Any:
        credentials = sts.assume_role(
            RoleArn=role_arn,
            RoleSessionName=f"kbsync-{source_identity}"[:64],
            SourceIdentity=source_identity,
            DurationSeconds=900,
        )["Credentials"]
        return session_factory(
            aws_access_key_id=credentials["AccessKeyId"],
            aws_secret_access_key=credentials["SecretAccessKey"],
            aws_session_token=credentials["SessionToken"],
        ).client("s3")

    return assume
