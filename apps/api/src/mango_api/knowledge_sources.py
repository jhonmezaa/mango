"""Sources of a knowledge base on an existing bucket (D88 (10), (19), (20); TM-K2).

A creator (the owner of the knowledge base while a creator) or an administrator proposes a
bucket of the installation's account and a prefix (``ProposeKbSource``). An administrator
other than whoever proposed it approves or rejects it (``ApproveKbSource``): Cedar says who is
an approver, and mango-api and a condition of the Knowledge table say it is not the proposer,
also when the proposer is another administrator (as in the review of agents, D18). The
approval holds for that bucket and that prefix only: they never change, and another one is
another proposal. Until a source is approved nothing reads it: its role is created only then,
by ``Mango-<ns>-KnowledgeSources`` (``Mango-<ns>-kbsrc-<source id>``, which reads that bucket
and prefix only and only the synchronization assumes), and the synchronization copies it into
the documents bucket of Mango (D88 (19), PR 7c). Removing a source deletes its role.

mango-api never names the bucket to that function: it sends the ids, and the function reads
the source from the registry. Creating or deleting the role is audited (``kb.source_role``)
before and after; if the function fails, the approval or the removal stands and the role is
left for the next synchronization of the knowledge base, which asks for it again (PR 7c).

The bucket is checked when it is proposed and again when it is approved:

* its name is not one of Mango (``mango-*``: this installation's and any other's in the
  account);
* it is in the installation's account: ``GetBucketEncryption`` with ``ExpectedBucketOwner``,
  whose only permission is ``s3:GetEncryptionConfiguration`` on buckets of this account. S3
  refuses it for a bucket of another account, so mango-api needs no ``s3:ListBucket``;
* it is encrypted with SSE-S3 or the managed key ``aws/s3`` (v1); a bucket with a key of its
  own is refused (D88 (17)).

Security notes (security-best-practices, FastAPI):
* Every route declares its authorization (AUTH-001): ``ViewKnowledgeBase``,
  ``ProposeKbSource`` or ``ApproveKbSource`` on the knowledge base, whose owner and groups come
  from the table (AUTHZ-001, TM-K8).
* The request names a bucket and a prefix (``s3://bucket/prefix/``), checked by pattern; the
  ids of the source and its proposer come from here (VALID-001). Responses use explicit models
  (RESP-001): the proposer's email only reaches administrators and the owner.
* Proposing, approving, rejecting and removing are audited before and after they are written,
  with the ARN (D88 (20)), and count in the limit of changes of the knowledge bases (D70).
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import json
import logging
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Annotated, Any

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from mango_api.agent_rules import find_secrets
from mango_api.authz import KNOWLEDGE_BASE_TYPE, KnowledgeBaseResource
from mango_api.knowledge import (
    PLATFORM,
    Authorize,
    KnowledgeDeps,
    _limit,
    _unavailable,
    of_origin,
    request_sync,
    reschedule,
    resource_of,
)
from mango_api.knowledge_store import (
    KnowledgeBase,
    KnowledgeConflictError,
    KnowledgeStoreUnavailableError,
    Source,
)
from mango_api.web import ApiError, Caller
from mango_core import knowledge
from mango_core.knowledge import ACTIVE_SOURCE_STATUSES, MAX_SOURCES, SourceStatus, Status

logger = logging.getLogger(__name__)

_BUCKET_RE = re.compile(
    r"^(?!xn--)(?!sthree-)(?!.*-s3alias$)(?!.*--ol-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$"
)
_IP_RE = re.compile(r"^\d+\.\d+\.\d+\.\d+$")
_CONTROL_BUT_NEWLINE = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]")
NOTE_CHARS = 500
_PREFIX_RE = re.compile(r"^[A-Za-z0-9!_.*'()/ =+@,;:&$?-]{0,512}$")
MANGO_BUCKETS = "mango-"
"""Names of the buckets of every installation of Mango (D88 (10)): never a source."""
MANAGED_S3_KEY = "alias/aws/s3"


# --- Models -------------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _location(value: str) -> str:
    bucket, prefix = split_location(value)
    return f"s3://{bucket}/{prefix}"


def split_location(value: str) -> tuple[str, str]:
    """``(bucket, prefix)`` of ``s3://bucket/prefix/``; the prefix is empty or ends in ``/``."""
    if not value.startswith("s3://"):
        raise ValueError("the location is s3://bucket/prefix/")
    bucket, _, prefix = value[len("s3://") :].partition("/")
    if not _BUCKET_RE.fullmatch(bucket) or ".." in bucket or _IP_RE.fullmatch(bucket):
        raise ValueError("not a bucket name")
    if not _PREFIX_RE.fullmatch(prefix) or prefix.startswith("/") or "//" in prefix:
        raise ValueError("not a prefix")
    if prefix and not prefix.endswith("/"):
        raise ValueError("a prefix ends in /")
    return bucket, prefix


class SourceIn(_Strict):
    location: Annotated[str, Field(max_length=600), AfterValidator(_location)]
    """``s3://bucket/prefix/`` (or ``s3://bucket/`` for the whole bucket)."""


class SourceDecisionIn(_Strict):
    version: Annotated[int, Field(ge=1)]
    """The version of the source the caller read: a source changed meanwhile is a 409."""


def _note(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if _CONTROL_BUT_NEWLINE.search(value):
        raise ValueError("control characters are not allowed")
    return value or None


class SourceDecideIn(SourceDecisionIn):
    note: Annotated[str | None, Field(max_length=NOTE_CHARS), AfterValidator(_note)] = None
    """Why (D88 (42)): optional to approve, required to reject. Whoever proposed it reads it."""


class ProposerOut(_Strict):
    user_id: str
    email: str | None
    """Only for administrators, the owner of the knowledge base and whoever proposed it."""


class SourceOut(_Strict):
    src_id: str
    kb_id: str
    bucket: str
    prefix: str
    status: SourceStatus
    proposed_by: ProposerOut
    proposed_at: datetime
    decided_at: datetime | None
    decided_by: ProposerOut | None
    note: str | None
    """The note of the decision, for whoever sees the emails (the same people)."""
    version: int
    role_ready: bool
    """Its role exists: the synchronization may read it (once approved)."""
    can_decide: bool
    """The caller may approve or reject it: an administrator, pending, not proposed by them."""


class SourceListOut(_Strict):
    items: list[SourceOut]


class PendingSourceOut(SourceOut):
    knowledge_base: str
    """The name of its knowledge base."""


class PendingSourceListOut(_Strict):
    items: list[PendingSourceOut]


class QueuedSourceOut(PendingSourceOut):
    """A proposal in Aprobaciones and the Bandeja (D88 (48)), with what its card says."""

    groups: list[str]
    """The groups of its knowledge base: «La consultan»."""
    sync_schedule: str
    replaces: str | None
    """``s3://bucket/prefix`` the knowledge base reads now, when this pending proposal would
    replace it (D88 (42))."""
    withdrawn_at: datetime | None


class SourceQueueOut(_Strict):
    items: list[QueuedSourceOut]
    """Pending first (oldest first), then the decisions of the last ``DECIDED_DAYS`` days
    (newest first)."""


DECIDED_DAYS = 30
"""How far back Aprobaciones lists decided proposals (D88 (48))."""


# --- Checking a bucket ------------------------------------------------------------------


class SourceRefusedError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class BucketCheckUnavailableError(Exception):
    """S3 did not say: nothing is proposed nor approved."""


class BucketChecker:
    """What D88 (10) asks of a bucket before it is a source."""

    def __init__(self, s3: Any, account_id: str) -> None:
        if not re.fullmatch(r"\d{12}", account_id):
            raise ValueError("the account of the installation is required")
        self._s3 = s3
        self._account = account_id

    def check(self, bucket: str) -> None:
        """Raises ``SourceRefusedError`` with the reason, or ``BucketCheckUnavailableError``."""
        if bucket.startswith(MANGO_BUCKETS):
            raise SourceRefusedError("mango_bucket", "a bucket of Mango cannot be a source")
        try:
            response = self._s3.get_bucket_encryption(
                Bucket=bucket, ExpectedBucketOwner=self._account
            )
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            if code == "ServerSideEncryptionConfigurationNotFoundError":
                # Every bucket is encrypted with SSE-S3 by default since 2023.
                return
            if code == "NoSuchBucket":
                raise SourceRefusedError("bucket_not_found", "the bucket does not exist") from None
            if code in {"AccessDenied", "AccessDeniedException", "AllAccessDisabled"}:
                # Another account's bucket, or one whose policy keeps Mango out.
                raise SourceRefusedError(
                    "bucket_not_in_account", "the bucket is not in the account of the installation"
                ) from None
            logger.error("bucket check failed: %s", code)  # noqa: TRY400 - the code only
            raise BucketCheckUnavailableError(code) from None
        except BotoCoreError:
            logger.error("bucket check failed: no answer")  # noqa: TRY400 - nothing to log
            raise BucketCheckUnavailableError("unreachable") from None
        rules = response.get("ServerSideEncryptionConfiguration", {}).get("Rules", [])
        for rule in rules:
            default = rule.get("ApplyServerSideEncryptionByDefault", {})
            algorithm = default.get("SSEAlgorithm")
            key = default.get("KMSMasterKeyID")
            if algorithm == "AES256":
                continue
            if algorithm == "aws:kms" and (not key or str(key).endswith(MANAGED_S3_KEY)):
                continue
            raise SourceRefusedError(
                "bucket_key_unsupported",
                "the bucket is encrypted with a key of its own: not supported in this version",
            )


# --- The roles of the sources -------------------------------------------------------------


class SourceRoleError(Exception):
    """The function did not create or delete the role; the code it answered, if any."""


class SourceRoleFunction:
    """Invokes ``Mango-<ns>-KnowledgeSources`` with ids only (``functions/knowledge-sources``)."""

    def __init__(self, lambda_client: Any, function_name: str) -> None:
        self._lambda = lambda_client
        self._name = function_name

    def _invoke(self, op: str, kb_id: str, src_id: str) -> None:
        try:
            response = self._lambda.invoke(
                FunctionName=self._name,
                InvocationType="RequestResponse",
                Payload=json.dumps({"op": op, "kb_id": kb_id, "src_id": src_id}).encode(),
            )
            answer = json.loads(response["Payload"].read() or b"{}")
        except (ClientError, BotoCoreError, ValueError) as exc:
            raise SourceRoleError("unreachable") from exc
        if response.get("FunctionError") or not isinstance(answer, dict):
            raise SourceRoleError("function_error")
        if "error" in answer:
            raise SourceRoleError(str(answer["error"])[:64])

    def ensure(self, kb_id: str, src_id: str) -> None:
        self._invoke("ensure", kb_id, src_id)

    def delete(self, kb_id: str, src_id: str) -> None:
        self._invoke("delete", kb_id, src_id)


# --- Use cases ----------------------------------------------------------------------------


def _now_iso(deps: KnowledgeDeps) -> str:
    return datetime.fromtimestamp(deps.clock(), UTC).isoformat(timespec="seconds")


def bucket_arn(source: Source) -> str:
    return f"arn:aws:s3:::{source.bucket}/{source.prefix}"


def _audit(
    deps: KnowledgeDeps, event: str, caller: Caller, source: Source, outcome: str, **extra: Any
) -> None:
    """Fail closed: a change that cannot be audited is not made (rule 4)."""
    try:
        deps.audit.emit(
            event,
            caller.user.user_id,
            {
                "kb_id": source.kb_id,
                "src_id": source.src_id,
                "arn": bucket_arn(source),
                "proposed_by": source.proposed_by,
                "outcome": outcome,
                **extra,
            },
            caller.user,
        )
    except Exception as exc:
        raise ApiError(503, "audit_unavailable", "the change could not be audited; retry") from exc


def _check_bucket(deps: KnowledgeDeps, bucket: str) -> None:
    if deps.buckets is None:
        raise ApiError(503, "source_check_unavailable", "please try again")
    try:
        deps.buckets.check(bucket)
    except SourceRefusedError as exc:
        raise ApiError(422, exc.code, str(exc)) from exc
    except BucketCheckUnavailableError as exc:
        raise ApiError(503, "source_check_unavailable", "please try again") from exc


def propose_source(
    deps: KnowledgeDeps, caller: Caller, kb: KnowledgeBase, body: SourceIn
) -> Source:
    if kb.status is Status.DELETING:
        raise ApiError(409, "knowledge_base_deleting", "this knowledge base is being deleted")
    of_origin(kb, "bucket")
    bucket, prefix = split_location(body.location)
    try:
        existing = deps.store.sources(kb.kb_id)
    except KnowledgeStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    active = [s for s in existing if s.status in ACTIVE_SOURCE_STATUSES]
    if any(s.status is SourceStatus.PENDING for s in active):
        # One bucket per knowledge base (D88 (42)): a change waits for its decision alone.
        raise ApiError(409, "source_pending", "a proposal of this knowledge base is pending")
    if any(
        (s.bucket, s.prefix) == (bucket, prefix) and s.status is not SourceStatus.REMOVING
        for s in active
    ):
        raise ApiError(409, "source_exists", "this bucket and prefix are already a source")
    if len(active) >= MAX_SOURCES:
        raise ApiError(422, "too_many_sources", "a knowledge base has at most 5 sources")
    _check_bucket(deps, bucket)
    source = Source(
        kb_id=kb.kb_id,
        src_id=knowledge.new_id(int(deps.clock() * 1000)),
        bucket=bucket,
        prefix=prefix,
        status=SourceStatus.PENDING,
        proposed_by=caller.user.user_id,
        proposed_by_email=caller.user.email,
        proposed_at=_now_iso(deps),
        version=1,
    )
    _audit(deps, "kb.source_propose", caller, source, "requested")
    try:
        deps.store.put_source(source)
    except KnowledgeConflictError as exc:
        raise ApiError(
            409, "knowledge_base_deleting", "this knowledge base is being deleted"
        ) from exc
    except KnowledgeStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    _audit(deps, "kb.source_propose", caller, source, "applied")
    return source


def _change(
    deps: KnowledgeDeps,
    caller: Caller,
    source: Source,
    event: str,
    status: SourceStatus,
    *,
    not_proposer: bool,
    note: str | None = None,
    **extra: Any,
) -> Source:
    # The note is the administrator's text: the audit says it was written, never what.
    if note is not None:
        extra["note_chars"] = len(note)
    _audit(deps, event, caller, source, "requested", **extra)
    try:
        changed = deps.store.set_source_status(
            source,
            status,
            by=caller.user.user_id,
            now=_now_iso(deps),
            not_proposed_by=caller.user.user_id if not_proposer else None,
            by_email=caller.user.email,
            note=note,
        )
    except KnowledgeConflictError as exc:
        _audit(deps, event, caller, source, "rejected", reason="conflict", **extra)
        raise ApiError(409, "version_conflict", "the source changed; reload") from exc
    except KnowledgeStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    _audit(deps, event, caller, changed, "applied", **extra)
    return changed


def _role(deps: KnowledgeDeps, caller: Caller, source: Source, op: str) -> Source:
    """Create (``ensure``) or delete the role of ``source``; never raises once audited: the
    decision already stands, and the next synchronization asks again (PR 7c)."""
    _audit(deps, "kb.source_role", caller, source, "requested", op=op)
    if deps.source_roles is None:
        _audit(deps, "kb.source_role", caller, source, "failed", op=op, reason="unavailable")
        return source
    try:
        if op == "ensure":
            deps.source_roles.ensure(source.kb_id, source.src_id)
        else:
            deps.source_roles.delete(source.kb_id, source.src_id)
    except SourceRoleError as exc:
        logger.error("the role of a source was not %s: %s", op, exc)  # noqa: TRY400 - a code
        _audit(deps, "kb.source_role", caller, source, "failed", op=op, reason=str(exc))
        return source
    try:
        current = deps.store.source(source.kb_id, source.src_id) or source
    except KnowledgeStoreUnavailableError:
        current = source
    _audit(deps, "kb.source_role", caller, current, "applied", op=op)
    return current


def decide_source(
    deps: KnowledgeDeps,
    caller: Caller,
    source: Source,
    version: int,
    *,
    approve: bool,
    note: str | None = None,
) -> Source:
    """Approve or reject, by an administrator other than whoever proposed it (D88 (20)); a
    rejection says why (D88 (42))."""
    if not approve and not note:
        raise ApiError(422, "note_required", "a rejection says why")
    if note and find_secrets(note):
        raise ApiError(422, "secret_in_note", "the note looks like it has a credential")
    if source.proposed_by == caller.user.user_id:
        raise ApiError(403, "own_proposal", "a source is decided by someone who did not propose it")
    if source.status is not SourceStatus.PENDING:
        raise ApiError(409, "source_decided", "this source was already decided")
    if source.version != version:
        raise ApiError(409, "version_conflict", "the source changed; reload")
    if approve:
        # The bucket is checked again: what was true when it was proposed may not be now.
        _check_bucket(deps, source.bucket)
    event, status = (
        ("kb.source_approve", SourceStatus.APPROVED)
        if approve
        else ("kb.source_reject", SourceStatus.REJECTED)
    )
    decided = _change(deps, caller, source, event, status, not_proposer=True, note=note)
    if not approve:
        return decided
    _replace(deps, caller, decided)
    return _role(deps, caller, decided, "ensure")


def _replace(deps: KnowledgeDeps, caller: Caller, approved: Source) -> None:
    """A change of bucket or prefix, once approved, replaces the one it was read from
    (D88 (42)): that one is removed, and the next synchronization takes out what is no longer
    in the new one. Until then the knowledge base kept reading from it."""
    try:
        others = [
            s
            for s in deps.store.sources(approved.kb_id)
            if s.status is SourceStatus.APPROVED and s.src_id != approved.src_id
        ]
    except KnowledgeStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    for old in others:
        removed = _change(
            deps,
            caller,
            old,
            "kb.source_remove",
            SourceStatus.REMOVING,
            not_proposer=False,
            replaced_by=approved.src_id,
        )
        _role(deps, caller, removed, "delete")


def remove_source(deps: KnowledgeDeps, caller: Caller, source: Source, version: int) -> Source:
    """A pending source is withdrawn; an approved one is removed: its role and its copied
    documents go with it (PR 7b and 7c)."""
    if source.version != version:
        raise ApiError(409, "version_conflict", "the source changed; reload")
    if source.status is SourceStatus.PENDING:
        status = SourceStatus.WITHDRAWN
    elif source.status is SourceStatus.APPROVED:
        status = SourceStatus.REMOVING
    else:
        raise ApiError(409, "source_inactive", "this source is not active")
    removed = _change(deps, caller, source, "kb.source_remove", status, not_proposer=False)
    return _role(deps, caller, removed, "delete") if status is SourceStatus.REMOVING else removed


def source_out(
    source: Source, caller: Caller, kb: KnowledgeBase, *, can_approve: bool
) -> SourceOut:
    sees_email = caller.user.is_admin or caller.user.user_id in (kb.owner_id, source.proposed_by)
    decided_by = (
        ProposerOut(
            user_id=source.decided_by,
            email=source.decided_by_email if sees_email else None,
        )
        if source.decided_by
        else None
    )
    return SourceOut(
        src_id=source.src_id,
        kb_id=source.kb_id,
        bucket=source.bucket,
        prefix=source.prefix,
        status=source.status,
        proposed_by=ProposerOut(
            user_id=source.proposed_by,
            email=source.proposed_by_email if sees_email else None,
        ),
        proposed_at=datetime.fromisoformat(source.proposed_at),
        decided_at=datetime.fromisoformat(source.decided_at) if source.decided_at else None,
        decided_by=decided_by,
        note=source.note if sees_email else None,
        version=source.version,
        role_ready=source.role_arn is not None,
        can_decide=(
            can_approve
            and source.status is SourceStatus.PENDING
            and source.proposed_by != caller.user.user_id
        ),
    )


Allowed = Callable[[Caller, str, list[KnowledgeBaseResource]], frozenset[str]]


def queued_sources(
    deps: KnowledgeDeps, caller: Caller, allowed: Allowed, *, decided: bool = True
) -> list[QueuedSourceOut]:
    """The proposals of Aprobaciones (D88 (48)): the pending ones the caller may sign and their
    own, and (``decided``) the decisions of the last ``DECIDED_DAYS`` days on knowledge bases
    they may sign for, or that they proposed. Nobody signs their own (D88 (20)). Raises
    ``ApiError`` 503 when the table cannot be read."""
    since = datetime.fromtimestamp(deps.clock() - DECIDED_DAYS * 86_400, UTC).isoformat(
        timespec="seconds"
    )
    try:
        pending = deps.store.pending_sources()
        closed = deps.store.decided_sources(since) if decided else []
        bases = {
            kb_id: kb
            for kb_id in {s.kb_id for s in [*pending, *closed]}
            if (kb := deps.store.get(kb_id)) is not None
        }
        signable = allowed(caller, "ApproveKbSource", [resource_of(kb) for kb in bases.values()])
        me = caller.user.user_id
        items: list[QueuedSourceOut] = []
        for source in [*pending, *closed]:
            kb = bases.get(source.kb_id)
            if kb is None or kb.status is Status.DELETING:
                continue
            if source.proposed_by != me and source.kb_id not in signable:
                continue
            out = source_out(source, caller, kb, can_approve=source.kb_id in signable)
            items.append(
                QueuedSourceOut(
                    **out.model_dump(),
                    knowledge_base=kb.name,
                    groups=list(kb.groups),
                    sync_schedule=kb.sync_schedule,
                    replaces=_replaced(deps, source),
                    withdrawn_at=(
                        datetime.fromisoformat(source.removed_at)
                        if source.status is SourceStatus.WITHDRAWN and source.removed_at
                        else None
                    ),
                )
            )
    except KnowledgeStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    return items


def _replaced(deps: KnowledgeDeps, source: Source) -> str | None:
    """The bucket a pending proposal would replace (D88 (42))."""
    if source.status is not SourceStatus.PENDING:
        return None
    approved = next(
        (s for s in deps.store.sources(source.kb_id) if s.status is SourceStatus.APPROVED), None
    )
    return f"s3://{approved.bucket}/{approved.prefix}" if approved else None


# --- Router -------------------------------------------------------------------------------


def knowledge_sources_router(  # noqa: PLR0915 - registers the route closures
    deps: KnowledgeDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
    allowed: Callable[[Caller, str, list[KnowledgeBaseResource]], frozenset[str]],
) -> APIRouter:
    """``allowed(caller, action, bases)``: the ids of ``bases`` the caller may ``action``."""
    router = APIRouter()
    KbId = Annotated[str, Path(pattern=knowledge.ID_PATTERN)]  # noqa: N806
    SrcId = Annotated[str, Path(pattern=knowledge.ID_PATTERN)]  # noqa: N806

    async def run[T](fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        return await asyncio.to_thread(fn, *args, **kwargs)

    async def viewer(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        await authorize(caller, "ViewKnowledgeBase", *PLATFORM, read_only=True)
        return caller

    Viewer = Annotated[Caller, Depends(viewer)]  # noqa: N806

    async def load(kb_id: str) -> KnowledgeBase:
        try:
            kb = await run(deps.store.get, kb_id)
        except KnowledgeStoreUnavailableError as exc:
            raise _unavailable(exc) from exc
        if kb is None:
            raise HTTPException(status_code=404, detail="not found")
        return kb

    async def on(
        caller: Caller, action: str, kb: KnowledgeBase, *, read_only: bool = False
    ) -> None:
        await authorize(
            caller,
            action,
            KNOWLEDGE_BASE_TYPE,
            kb.kb_id,
            read_only=read_only,
            knowledge=resource_of(kb),
        )

    async def load_source(kb: KnowledgeBase, src_id: str) -> Source:
        try:
            source = await run(deps.store.source, kb.kb_id, src_id)
        except KnowledgeStoreUnavailableError as exc:
            raise _unavailable(exc) from exc
        if source is None:
            raise HTTPException(status_code=404, detail="not found")
        return source

    async def can_approve(caller: Caller, kb: KnowledgeBase) -> bool:
        return kb.kb_id in await run(allowed, caller, "ApproveKbSource", [resource_of(kb)])

    prefix = "/api/knowledge-bases/{kb_id}/sources"

    @router.get(prefix, response_model=SourceListOut)
    async def list_sources(kb_id: KbId, caller: Viewer) -> SourceListOut:
        kb = await load(kb_id)
        await on(caller, "ViewKnowledgeBase", kb, read_only=True)
        try:
            sources = await run(deps.store.sources, kb_id)
        except KnowledgeStoreUnavailableError as exc:
            raise _unavailable(exc) from exc
        approver = await can_approve(caller, kb)
        return SourceListOut(
            items=[source_out(s, caller, kb, can_approve=approver) for s in sources]
        )

    @router.post(prefix, response_model=SourceOut, status_code=201)
    async def propose(kb_id: KbId, body: SourceIn, caller: Viewer) -> SourceOut:
        kb = await load(kb_id)
        await on(caller, "ProposeKbSource", kb)
        _limit(deps.changes, caller.user.user_id)
        source = await run(propose_source, deps, caller, kb, body)
        return source_out(source, caller, kb, can_approve=await can_approve(caller, kb))

    async def decide(
        kb_id: str, src_id: str, body: SourceDecideIn, caller: Caller, *, approve: bool
    ) -> SourceOut:
        kb = await load(kb_id)
        await on(caller, "ApproveKbSource", kb)
        source = await load_source(kb, src_id)
        _limit(deps.changes, caller.user.user_id)
        decided = await run(
            decide_source, deps, caller, source, body.version, approve=approve, note=body.note
        )
        if decided.status is SourceStatus.APPROVED:
            # From now on its frequency applies (D88 (11)).
            await run(reschedule, deps, caller, kb)
        if decided.status is SourceStatus.APPROVED and decided.role_arn:
            # The first copy, as whoever approved it (D88 (19), (24)).
            await run(request_sync, deps, caller, kb)
        return source_out(decided, caller, kb, can_approve=True)

    @router.post(prefix + "/{src_id}/approve", response_model=SourceOut)
    async def approve_source(
        kb_id: KbId, src_id: SrcId, body: SourceDecideIn, caller: Viewer
    ) -> SourceOut:
        return await decide(kb_id, src_id, body, caller, approve=True)

    @router.post(prefix + "/{src_id}/reject", response_model=SourceOut)
    async def reject_source(
        kb_id: KbId, src_id: SrcId, body: SourceDecideIn, caller: Viewer
    ) -> SourceOut:
        return await decide(kb_id, src_id, body, caller, approve=False)

    @router.post(prefix + "/{src_id}/delete", response_model=SourceOut, status_code=202)
    async def delete_source(
        kb_id: KbId, src_id: SrcId, body: SourceDecisionIn, caller: Viewer
    ) -> SourceOut:
        kb = await load(kb_id)
        await on(caller, "ProposeKbSource", kb)
        source = await load_source(kb, src_id)
        _limit(deps.changes, caller.user.user_id)
        removed = await run(remove_source, deps, caller, source, body.version)
        if removed.status is SourceStatus.REMOVING:
            # Its documents go with the synchronization, verified (D88 (16)); without other
            # approved sources, so does the schedule.
            await run(request_sync, deps, caller, kb)
            await run(reschedule, deps, caller, kb)
        return source_out(removed, caller, kb, can_approve=await can_approve(caller, kb))

    @router.get("/api/knowledge-sources", response_model=SourceQueueOut)
    async def source_queue(caller: Viewer) -> SourceQueueOut:
        """The proposals of Aprobaciones (D88 (48))."""
        return SourceQueueOut(items=await run(queued_sources, deps, caller, allowed))

    @router.get("/api/knowledge-sources/pending", response_model=PendingSourceListOut)
    async def pending_sources(caller: Viewer) -> PendingSourceListOut:
        """What the caller may sign (D88 (20)): never what they proposed."""
        try:
            pending = await run(deps.store.pending_sources)
            bases = {
                kb_id: kb
                for kb_id in {s.kb_id for s in pending}
                if (kb := await run(deps.store.get, kb_id)) is not None
            }
        except KnowledgeStoreUnavailableError as exc:
            raise _unavailable(exc) from exc
        signable = await run(
            allowed, caller, "ApproveKbSource", [resource_of(kb) for kb in bases.values()]
        )
        return PendingSourceListOut(
            items=[
                PendingSourceOut(
                    **source_out(s, caller, bases[s.kb_id], can_approve=True).model_dump(),
                    knowledge_base=bases[s.kb_id].name,
                )
                for s in pending
                if s.kb_id in signable
                and s.proposed_by != caller.user.user_id
                and bases[s.kb_id].status is not Status.DELETING
            ]
        )

    return router
