"""Knowledge bases (D88): the registry, without documents or synchronization yet.

A knowledge base of Mango is a record and a prefix over the one Bedrock knowledge base of the
installation (D88 (7)); it answers whoever is in one of its groups (D88 (22)). Administrators
and agent creators create and see them; their owner (while a creator) or an administrator
edits and deletes them (D88 (4), (13)). Design: ``docs/design/briefs/sync-2026-10-21-
knowledge-bases.md``. Threat model: ``docs/security/threat-models/knowledge-bases-threat-model.md``.

Security notes (security-best-practices, FastAPI):
* Every route declares its authorization (AUTH-001): ``ViewKnowledgeBase`` or
  ``CreateKnowledgeBase`` on the platform, and ``EditKnowledgeBase`` on the knowledge base,
  whose owner and groups come from the Knowledge table, never from the request (AUTHZ-001,
  TM-K8).
* Request models forbid extra fields: nobody sends an owner, a status, counters or an id
  (VALID-001). The owner is the verified subject of the caller; the id is a ULID made here.
  Groups must be in the registry and the area must exist; names are checked for control
  characters and credentials (D26) and are never part of an S3 key.
* Responses use explicit models (RESP-001): the owner's email only reaches administrators and
  the owner. Changes count in the shared rate limits (D70).
* Every change is audited before and after it is written (rule 4), with ids, groups and
  counts, never the name or the description (D88 (12), TM-K9).
* Documents (D88 (9), TM-K4): the browser uploads to S3 with a POST signed for one key made of
  ids, one size and one type (``knowledge_uploads``). Saving accepts only documents of an
  upload the same person asked for in the same knowledge base, checks their size and bytes
  again, and copies them on the server side. Their names are shown, never used in a key.
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable, Collection, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal, Protocol

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from mango_api.agent_rules import find_secrets
from mango_api.audit import AuditLog
from mango_api.authz import KNOWLEDGE_BASE_TYPE, KnowledgeBaseResource
from mango_api.groups import GroupRegistry, GroupsUnavailableError
from mango_api.knowledge_store import (
    MAX_BYTES,
    MAX_DOCUMENTS,
    AnnouncedFile,
    Document,
    KnowledgeBase,
    KnowledgeConflictError,
    KnowledgeLimitError,
    KnowledgeStore,
    KnowledgeStoreUnavailableError,
    Upload,
)
from mango_api.knowledge_uploads import (
    MAX_FILE_BYTES,
    TYPES,
    UPLOAD_SECONDS,
    DocumentStorage,
    StorageUnavailableError,
    display_name,
    document_key,
    extension,
    upload_key,
)
from mango_api.rate_limits import Limiter, RateLimitUnavailableError
from mango_api.web import ApiError, Caller, rate_limited
from mango_core import knowledge
from mango_core.knowledge import DocumentStatus, Status

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
CHANGES_PER_HOUR = 30
"""Creating, editing and deleting knowledge bases, per person (D70)."""
UPLOADS_PER_HOUR = 60
"""Requests of presigned uploads and saves, per person: each one is up to 20 documents."""
FILES_PER_UPLOAD = 20
"""Files per upload (D88 (9))."""
UPLOAD_DAYS_SECONDS = 23 * 3600
"""An upload may be saved for 23 hours: the bucket empties ``uploads/`` after a day."""
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_CONTROL_BUT_NEWLINE = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]")


# --- Models -----------------------------------------------------------------------------


def _one_line(value: str) -> str:
    value = value.strip()
    if not value or _CONTROL.search(value):
        raise ValueError("a name is one line of visible text")
    return value


def _text(value: str) -> str:
    value = value.strip()
    if _CONTROL_BUT_NEWLINE.search(value):
        raise ValueError("control characters are not allowed")
    return value


GroupId = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{1,63}$")]
Classification = Literal["public", "internal", "confidential", "restricted"]
SyncSchedule = Literal["manual", "6h", "daily", "weekly"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KnowledgeBaseIn(_Strict):
    """What a person may edit (D88 (12)). The area is chosen once, when it is created."""

    name: Annotated[str, Field(min_length=1, max_length=80), AfterValidator(_one_line)]
    description: Annotated[str, Field(max_length=500), AfterValidator(_text)] = ""
    groups: Annotated[list[GroupId], Field(min_length=1, max_length=knowledge.MAX_GROUPS)]
    classification: Classification = "internal"
    sync_schedule: SyncSchedule = "manual"
    """Only bucket sources follow it (D88 (11)); uploads are indexed when they are saved."""


class KnowledgeBaseCreate(KnowledgeBaseIn):
    business_unit: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")] = (
        knowledge.BUSINESS_UNIT_ALL
    )


class KnowledgeBaseUpdate(KnowledgeBaseIn):
    version: Annotated[int, Field(ge=1)]
    """The version that was read: a change made since is not overwritten."""


class DeleteIn(_Strict):
    version: Annotated[int, Field(ge=1)]


class EmptyIn(_Strict):
    pass


class OwnerOut(_Strict):
    user_id: str
    name: str | None
    email: str | None
    """Only for administrators and the owner."""


class KnowledgeBaseOut(_Strict):
    kb_id: str
    name: str
    description: str
    owner: OwnerOut
    business_unit: str
    groups: list[str]
    classification: Classification
    sync_schedule: SyncSchedule
    status: Status
    documents: int
    bytes: int
    version: int
    created_at: datetime
    updated_at: datetime
    can_edit: bool
    can_view_documents: bool
    """Its documents and «Probar búsqueda» (D88 (13)); the list itself is for every creator."""
    sync_running: bool
    """A synchronization holds it: «Ya hay una sincronización en curso» (design 2.4)."""


class KnowledgeBaseListOut(_Strict):
    items: list[KnowledgeBaseOut]
    can_create: bool


class UploadFileIn(_Strict):
    name: Annotated[str, Field(min_length=1, max_length=1000)]
    """As the browser has it; what is shown is :func:`display_name` of it."""
    size: Annotated[int, Field(ge=1, le=MAX_FILE_BYTES)]
    content_type: Annotated[str, Field(max_length=100)]
    """Must be the type of the extension of the name (``knowledge_uploads.TYPES``)."""


class UploadsIn(_Strict):
    files: Annotated[list[UploadFileIn], Field(min_length=1, max_length=FILES_PER_UPLOAD)]


class SignedFileOut(_Strict):
    doc_id: str
    name: str
    url: str
    fields: dict[str, str]
    """The form fields of the POST, in order, before the file."""


class UploadsOut(_Strict):
    upload_id: str
    expires_at: datetime
    """When the POSTs stop being accepted (15 minutes)."""
    files: list[SignedFileOut]


class SaveIn(_Strict):
    upload_id: Annotated[str, Field(pattern=knowledge.ID_PATTERN)]
    doc_ids: Annotated[
        list[Annotated[str, Field(pattern=knowledge.ID_PATTERN)]],
        Field(min_length=1, max_length=FILES_PER_UPLOAD),
    ]


RejectReason = Literal["not_uploaded", "too_large", "size_mismatch", "type_mismatch"]


class RejectedOut(_Strict):
    doc_id: str
    reason: RejectReason


class DocumentOut(_Strict):
    doc_id: str
    name: str
    size: int
    content_type: str
    status: DocumentStatus
    reason: str | None
    created_at: datetime


SyncState = Literal["started", "queued", "unavailable"]
"""Started now; queued after the one running; or not started (it may be asked for again)."""


class SyncOut(_Strict):
    sync: SyncState


class SaveOut(_Strict):
    saved: list[DocumentOut]
    rejected: list[RejectedOut]
    sync: SyncState | None
    """The synchronization that indexes them, when something was saved."""


class DocumentDeleteOut(_Strict):
    document: DocumentOut
    sync: SyncState


class DocumentListOut(_Strict):
    items: list[DocumentOut]


# --- Use cases --------------------------------------------------------------------------


class Authorize(Protocol):
    def __call__(
        self,
        caller: Caller,
        action: str,
        resource_type: str,
        resource_id: str,
        *,
        read_only: bool = ...,
        knowledge: KnowledgeBaseResource | None = ...,
    ) -> Awaitable[None]: ...


class SyncStarter:
    """Starts ``Mango-<ns>-KnowledgeSync`` for one knowledge base (D88 (11)). The input is ids,
    and who asks with their limit: everything else the machine reads from the registry."""

    def __init__(self, sfn: Any, state_machine_arn: str) -> None:
        self._sfn = sfn
        self._arn = state_machine_arn

    def start(self, kb_id: str, sync_id: str, requester: dict[str, str]) -> None:
        self._sfn.start_execution(
            stateMachineArn=self._arn,
            name=sync_id,
            input=json.dumps(
                {"mode": "sync", "kb_id": kb_id, "sync_id": sync_id, "requested_by": requester},
                separators=(",", ":"),
            ),
        )


class AgentUsing(Protocol):
    """A version that serves a knowledge base (``agents.AgentUsing``)."""

    @property
    def agent_id(self) -> str: ...
    @property
    def version(self) -> int: ...
    @property
    def name(self) -> str: ...


@dataclass
class KnowledgeDeps:
    store: KnowledgeStore
    groups: GroupRegistry
    areas: Callable[[], Collection[str]]
    """Areas of the installation (the business unit mapping, D35)."""
    audit: AuditLog
    changes: Limiter
    clock: Callable[[], float] = time.time
    storage: DocumentStorage | None = None
    """The documents bucket; ``None`` until mango-api may use it (the routes answer 503)."""
    uploads: Limiter | None = None
    sync: SyncStarter | None = None
    """The state machine ``Mango-<ns>-KnowledgeSync``; ``None`` until mango-api may start it."""
    user_limit: Callable[[str], Decimal] | None = None
    """The monthly budget limit of a person: the synchronization reserves against it (D88 (24))."""
    agents_using: Callable[[str], Sequence[AgentUsing]] | None = None
    """Agents whose versions serve a knowledge base (``agents.agents_using_knowledge_base``);
    set in production. Raises when it cannot tell: nothing is deleted then."""


def resource_of(kb: KnowledgeBase) -> KnowledgeBaseResource:
    """The KnowledgeBase entity for Cedar, from the record (never from the request)."""
    return KnowledgeBaseResource(kb.kb_id, kb.owner_id, frozenset(kb.groups))


def _unavailable(exc: Exception) -> ApiError:
    logger.error("knowledge bases unavailable: %s", type(exc).__name__)
    return ApiError(503, "knowledge_unavailable", "please try again")


def _limit(limiter: Limiter, key: str) -> None:
    try:
        allowed = limiter.allow(key)
    except RateLimitUnavailableError as exc:
        raise ApiError(503, "rate_limit_unavailable", "please try again") from exc
    if not allowed:
        raise rate_limited(limiter.retry_after(key))


def _now_iso(deps: KnowledgeDeps) -> str:
    return datetime.fromtimestamp(deps.clock(), UTC).isoformat(timespec="seconds")


def _check(deps: KnowledgeDeps, body: KnowledgeBaseIn, business_unit: str | None) -> None:
    if find_secrets(f"{body.name}\n{body.description}"):
        # D26: the same validation as an agent's prompt; the match is never repeated.
        raise ApiError(422, "secret_in_knowledge_base", "the text looks like it has a credential")
    if len(set(body.groups)) != len(body.groups):
        raise ApiError(422, "duplicate_group", "a group is listed twice")
    try:
        registered = {g.id for g in deps.groups.list_groups()}
        areas = set(deps.areas()) if business_unit is not None else set()
    except GroupsUnavailableError as exc:
        raise ApiError(503, "groups_unavailable", "please try again") from exc
    except Exception as exc:
        raise _unavailable(exc) from exc
    if any(g not in registered for g in body.groups):
        raise ApiError(422, "group_unknown", "a group is not in the registry")
    if business_unit not in (None, knowledge.BUSINESS_UNIT_ALL) and business_unit not in areas:
        raise ApiError(422, "business_unit_unknown", "the area does not exist")


def _audit(
    deps: KnowledgeDeps, event: str, caller: Caller, kb: KnowledgeBase, **detail: Any
) -> None:
    """Fail closed: a change that cannot be audited is not made (rule 4)."""
    try:
        deps.audit.emit(
            event,
            caller.user.user_id,
            {
                "kb_id": kb.kb_id,
                "owner": kb.owner_id,
                "business_unit": kb.business_unit,
                "groups": list(kb.groups),
                **detail,
            },
            caller.user,
        )
    except Exception as exc:
        raise ApiError(503, "audit_unavailable", "the change could not be audited; retry") from exc


def create_knowledge_base(
    deps: KnowledgeDeps, caller: Caller, body: KnowledgeBaseCreate
) -> KnowledgeBase:
    _check(deps, body, body.business_unit)
    now = _now_iso(deps)
    kb = KnowledgeBase(
        kb_id=knowledge.new_id(int(deps.clock() * 1000)),
        name=body.name,
        description=body.description,
        owner_id=caller.user.user_id,
        owner_email=caller.user.email,
        owner_name=caller.user.name,
        business_unit=body.business_unit,
        groups=tuple(sorted(body.groups)),
        classification=body.classification,
        sync_schedule=body.sync_schedule,
        status=Status.PENDING,
        documents=0,
        bytes=0,
        version=1,
        created_at=now,
        updated_at=now,
    )
    detail = {"classification": kb.classification, "sync_schedule": kb.sync_schedule}
    _audit(deps, "kb.create", caller, kb, outcome="requested", **detail)
    try:
        deps.store.create(kb)
    except (KnowledgeConflictError, KnowledgeStoreUnavailableError) as exc:
        raise _unavailable(exc) from exc
    _audit(deps, "kb.create", caller, kb, outcome="applied", **detail)
    return kb


def _write(
    deps: KnowledgeDeps,
    event: str,
    caller: Caller,
    kb: KnowledgeBase,
    *,
    changes: dict[str, Any],
    detail: dict[str, Any],
) -> KnowledgeBase:
    _audit(deps, event, caller, kb, outcome="requested", **detail)
    try:
        updated = deps.store.update(kb, changes, now=_now_iso(deps))
    except KnowledgeConflictError as exc:
        _audit(deps, event, caller, kb, outcome="rejected", reason="conflict", **detail)
        raise ApiError(409, "version_conflict", "the knowledge base changed; reload") from exc
    except KnowledgeStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    _audit(deps, event, caller, updated, outcome="applied", **detail)
    return updated


def _editable(kb: KnowledgeBase, version: int) -> None:
    if kb.status is Status.DELETING:
        raise ApiError(409, "knowledge_base_deleting", "this knowledge base is being deleted")
    if kb.version != version:
        raise ApiError(409, "version_conflict", "the knowledge base changed; reload")


def update_knowledge_base(
    deps: KnowledgeDeps, caller: Caller, kb: KnowledgeBase, body: KnowledgeBaseUpdate
) -> KnowledgeBase:
    _editable(kb, body.version)
    _check(deps, body, None)
    wanted: dict[str, Any] = {
        "name": body.name,
        "description": body.description,
        "groups": tuple(sorted(body.groups)),
        "classification": body.classification,
        "sync_schedule": body.sync_schedule,
    }
    changes = {k: v for k, v in wanted.items() if getattr(kb, k) != v}
    if not changes:
        return kb
    detail: dict[str, Any] = {"fields": sorted(changes)}
    if "groups" in changes:
        # Who may read it changes at once (D88 (22)): the audit says from what to what.
        detail["groups_before"] = list(kb.groups)
    for name in ("classification", "sync_schedule"):
        if name in changes:
            detail[name] = changes[name]
    return _write(deps, "kb.update", caller, kb, changes=changes, detail=detail)


def _not_in_use(deps: KnowledgeDeps, kb: KnowledgeBase) -> None:
    """A knowledge base an agent serves is not deleted: a new version of the agent leaves it
    out first (D88 (15)). The answer names those agents, which whoever may delete it (its
    owner while a creator, or an administrator) already sees in the organization chart."""
    if deps.agents_using is None:
        return
    try:
        using = deps.agents_using(kb.kb_id)
    except Exception as exc:
        logger.exception("agents of a knowledge base unavailable")
        raise ApiError(503, "agent_unavailable", "please try again") from exc
    if using:
        raise ApiError(
            409,
            "knowledge_base_in_use",
            "agents use this knowledge base; remove it from them first",
            extra={
                "agents": [
                    {"agent_id": a.agent_id, "version": a.version, "name": a.name} for a in using
                ]
            },
        )


def delete_knowledge_base(
    deps: KnowledgeDeps, caller: Caller, kb: KnowledgeBase, version: int
) -> KnowledgeBase:
    """Mark it ``deleting``: the synchronization deletes its documents and vectors and
    verifies it (D88 (16)). The record stays, and listed, until then."""
    _editable(kb, version)
    _not_in_use(deps, kb)
    detail = {"documents": kb.documents, "bytes": kb.bytes}
    changes = {"status": Status.DELETING.value, "deleting_since": _now_iso(deps)}
    return _write(deps, "kb.delete", caller, kb, changes=changes, detail=detail)


def request_sync(deps: KnowledgeDeps, caller: Caller, kb: KnowledgeBase) -> SyncState:
    """Start the synchronization of ``kb`` for ``caller``, or ask the one running for one more.
    Its embeddings go to the caller's budget (D88 (24)), reserved by the machine before it
    ingests. Never raises for the machine: what was saved stays saved, and «Sincronizar ahora»
    asks again."""
    if deps.sync is None or deps.user_limit is None:
        return "unavailable"
    try:
        limit = deps.user_limit(caller.user.user_id)
    except Exception:
        logger.exception("knowledge sync: budget limit unavailable")
        return "unavailable"
    requester = {
        "user_id": caller.user.user_id,
        "email": caller.user.email or "",
        "limit": str(limit),
    }
    sync_id = knowledge.new_id(int(deps.clock() * 1000))
    try:
        started = deps.store.claim_sync(
            kb.kb_id, sync_id, json.dumps(requester, sort_keys=True), now=_now_iso(deps)
        )
    except (KnowledgeConflictError, KnowledgeStoreUnavailableError):
        logger.exception("knowledge sync could not be claimed")
        return "unavailable"
    state: SyncState = "queued"
    if started:
        try:
            deps.sync.start(kb.kb_id, sync_id, requester)
            state = "started"
        except (BotoCoreError, ClientError):
            logger.exception("knowledge sync could not start")
            try:
                deps.store.drop_sync(kb.kb_id, sync_id)
            except KnowledgeStoreUnavailableError:
                logger.exception("knowledge sync claim could not be dropped")
            state = "unavailable"
    try:
        deps.audit.emit(
            "kb.sync_request",
            caller.user.user_id,
            {"kb_id": kb.kb_id, "sync_id": sync_id, "outcome": state},
            caller.user,
        )
    except Exception:
        # The machine audits the synchronization itself (``kb.sync``).
        logger.exception("knowledge sync request could not be audited")
    return state


def delete_document(
    deps: KnowledgeDeps, caller: Caller, kb: KnowledgeBase, doc_id: str
) -> Document:
    """Mark a document ``deleting``: it leaves the answers once the synchronization deleted
    and verified it (D88 (16)); until then it shows «Borrando»."""
    _accepting(kb)
    try:
        document = deps.store.document(kb.kb_id, doc_id)
    except KnowledgeStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    if document is None:
        raise HTTPException(status_code=404, detail="not found")
    if document.status is DocumentStatus.DELETING:
        raise ApiError(409, "document_deleting", "this document is being deleted")
    detail = {"doc_id": doc_id, "bytes": document.size}
    _audit(deps, "kb.document_delete", caller, kb, outcome="requested", **detail)
    try:
        deps.store.delete_document(kb.kb_id, doc_id, now=_now_iso(deps))
    except KnowledgeConflictError as exc:
        raise ApiError(409, "document_deleting", "this document is being deleted") from exc
    except KnowledgeStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    _audit(deps, "kb.document_delete", caller, kb, outcome="applied", **detail)
    return replace(document, status=DocumentStatus.DELETING)


def knowledge_base_out(
    kb: KnowledgeBase, caller: Caller, *, can_edit: bool, can_view: bool
) -> KnowledgeBaseOut:
    sees_email = caller.user.is_admin or caller.user.user_id == kb.owner_id
    return KnowledgeBaseOut(
        kb_id=kb.kb_id,
        name=kb.name,
        description=kb.description,
        owner=OwnerOut(
            user_id=kb.owner_id,
            name=kb.owner_name,
            email=kb.owner_email if sees_email else None,
        ),
        business_unit=kb.business_unit,
        groups=list(kb.groups),
        classification=kb.classification,  # type: ignore[arg-type]
        sync_schedule=kb.sync_schedule,  # type: ignore[arg-type]
        status=kb.status,
        documents=kb.documents,
        bytes=kb.bytes,
        version=kb.version,
        created_at=datetime.fromisoformat(kb.created_at),
        updated_at=datetime.fromisoformat(kb.updated_at),
        can_edit=can_edit and kb.status is not Status.DELETING,
        can_view_documents=can_view,
        sync_running=kb.sync_running,
    )


def _storage(deps: KnowledgeDeps) -> DocumentStorage:
    if deps.storage is None:
        raise ApiError(503, "knowledge_unavailable", "please try again")
    return deps.storage


def _storage_unavailable(exc: StorageUnavailableError) -> ApiError:
    logger.error("knowledge documents unavailable: %s", exc)
    return ApiError(503, "storage_unavailable", "please try again")


def _accepting(kb: KnowledgeBase) -> None:
    if kb.status is Status.DELETING:
        raise ApiError(409, "knowledge_base_deleting", "this knowledge base is being deleted")


def request_uploads(
    deps: KnowledgeDeps, caller: Caller, kb: KnowledgeBase, body: UploadsIn
) -> tuple[Upload, dict[str, tuple[str, str, dict[str, str]]]]:
    """Sign one POST per file; returns the upload and, by document id, its name, URL and
    fields. Nothing is written to the bucket here."""
    storage = _storage(deps)
    _accepting(kb)
    files: dict[str, AnnouncedFile] = {}
    now = deps.clock()
    for index, file in enumerate(body.files):
        name = display_name(file.name)
        kind = extension(name) if name else None
        if name is None or kind is None:
            raise ApiError(422, "type_not_supported", f"file {index + 1}: type not supported")
        if file.content_type != TYPES[kind]:
            raise ApiError(422, "type_mismatch", f"file {index + 1}: the type is not its own")
        files[knowledge.new_id(int(now * 1000) + index)] = AnnouncedFile(
            name, file.size, TYPES[kind]
        )
    total = sum(f.size for f in files.values())
    if kb.documents + len(files) > MAX_DOCUMENTS or kb.bytes + total > MAX_BYTES:
        raise ApiError(409, "knowledge_base_full", "the knowledge base would pass its limits")
    upload = Upload(
        kb_id=kb.kb_id,
        upload_id=knowledge.new_id(int(now * 1000)),
        owner_id=caller.user.user_id,
        files=files,
        saved=frozenset(),
        expires_at=int(now) + UPLOAD_DAYS_SECONDS,
    )
    detail = {"upload_id": upload.upload_id, "files": len(files), "bytes": total}
    _audit(deps, "kb.upload", caller, kb, outcome="requested", **detail)
    try:
        signed = {
            doc_id: storage.sign(
                upload_key(caller.user.user_id, upload.upload_id, doc_id),
                f.size,
                f.content_type,
                user_id=caller.user.user_id,
            )
            for doc_id, f in files.items()
        }
        deps.store.put_upload(upload, now=_now_iso(deps))
    except StorageUnavailableError as exc:
        raise _storage_unavailable(exc) from exc
    except KnowledgeStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    _audit(deps, "kb.upload", caller, kb, outcome="applied", **detail)
    return upload, {d: (files[d].name, s.url, s.fields) for d, s in signed.items()}


def _checked(
    storage: DocumentStorage, upload: Upload, doc_ids: list[str], caller: Caller, now: str
) -> tuple[list[tuple[Document, str]], list[RejectedOut]]:
    """Each announced document as S3 has it: there, of its size, and its bytes of its type;
    with the ETag of what was checked."""
    accepted: list[tuple[Document, str]] = []
    rejected: list[RejectedOut] = []
    for doc_id in doc_ids:
        announced = upload.files[doc_id]
        key = upload_key(upload.owner_id, upload.upload_id, doc_id)
        try:
            found = storage.inspect(key, extension(announced.name) or "")
        except StorageUnavailableError as exc:
            raise _storage_unavailable(exc) from exc
        reason: RejectReason | None = None
        if found is None:
            reason = "not_uploaded"
        elif found.size > MAX_FILE_BYTES:
            reason = "too_large"
        elif found.size != announced.size:
            reason = "size_mismatch"
        elif not found.matches:
            reason = "type_mismatch"
        if found is None or reason is not None:
            rejected.append(RejectedOut(doc_id=doc_id, reason=reason or "not_uploaded"))
            continue
        accepted.append(
            (
                Document(
                    kb_id=upload.kb_id,
                    doc_id=doc_id,
                    name=announced.name,
                    size=announced.size,
                    content_type=announced.content_type,
                    sha256="",
                    status=DocumentStatus.UPLOADED,
                    reason=None,
                    uploaded_by=caller.user.user_id,
                    created_at=now,
                ),
                found.etag,
            )
        )
    return accepted, rejected


def _copy(
    deps: KnowledgeDeps, storage: DocumentStorage, upload: Upload, document: Document, etag: str
) -> Document:
    """S3 copies the upload under ``kb/``. A copy that fails is recorded as ``failed``: the
    document is counted, but never shows as uploaded."""
    source = upload_key(upload.owner_id, upload.upload_id, document.doc_id)
    destination = document_key(document.kb_id, document.doc_id)
    try:
        digest = storage.copy(source, etag, destination, document.content_type)
    except StorageUnavailableError:
        logger.exception("knowledge document copy failed")
        try:
            deps.store.stored(document.kb_id, document.doc_id, sha256=None, reason="storage")
        except KnowledgeStoreUnavailableError:
            logger.exception("knowledge document copy failure could not be recorded")
        return replace(document, status=DocumentStatus.FAILED, reason="storage")
    try:
        deps.store.stored(document.kb_id, document.doc_id, sha256=digest, reason=None)
    except KnowledgeStoreUnavailableError:
        logger.exception("knowledge document checksum could not be recorded")
    return replace(document, sha256=digest)


def save_documents(
    deps: KnowledgeDeps, caller: Caller, kb: KnowledgeBase, body: SaveIn
) -> tuple[list[Document], list[RejectedOut]]:
    """Check each uploaded document and record the good ones; then S3 copies them under
    ``kb/<kb id>/docs/``. The synchronization indexes them (D88 (11), PR 4)."""
    storage = _storage(deps)
    _accepting(kb)
    try:
        upload = deps.store.upload(kb.kb_id, body.upload_id)
    except KnowledgeStoreUnavailableError as exc:
        raise _unavailable(exc) from exc
    # Only the person who asked for the upload, in this knowledge base, while it lasts.
    if upload is None or upload.owner_id != caller.user.user_id or upload.expires_at < deps.clock():
        raise HTTPException(status_code=404, detail="not found")
    wanted = list(dict.fromkeys(body.doc_ids))
    if any(d not in upload.files for d in wanted):
        raise ApiError(422, "unknown_document", "a document is not of this upload")
    if any(d in upload.saved for d in wanted):
        raise ApiError(409, "already_saved", "a document of this upload is already saved")
    checked, rejected = _checked(storage, upload, wanted, caller, _now_iso(deps))
    accepted = [document for document, _etag in checked]
    detail = {
        "upload_id": upload.upload_id,
        "documents": len(accepted),
        "rejected": len(rejected),
        "bytes": sum(d.size for d in accepted),
    }
    _audit(deps, "kb.documents_save", caller, kb, outcome="requested", **detail)
    if accepted:
        try:
            deps.store.save_documents(kb, upload, accepted)
        except KnowledgeLimitError as exc:
            _audit(
                deps, "kb.documents_save", caller, kb, outcome="rejected", reason="full", **detail
            )
            raise ApiError(
                409, "knowledge_base_full", "the knowledge base would pass its limits"
            ) from exc
        except KnowledgeConflictError as exc:
            raise ApiError(
                409, "already_saved", "a document of this upload is already saved"
            ) from exc
        except KnowledgeStoreUnavailableError as exc:
            raise _unavailable(exc) from exc
    saved = [_copy(deps, storage, upload, d, etag) for d, etag in checked]
    _audit(deps, "kb.documents_save", caller, kb, outcome="applied", **detail)
    return saved, rejected


def document_out(document: Document) -> DocumentOut:
    return DocumentOut(
        doc_id=document.doc_id,
        name=document.name,
        size=document.size,
        content_type=document.content_type,
        status=document.status,
        reason=document.reason,
        created_at=datetime.fromisoformat(document.created_at),
    )


# --- Router -------------------------------------------------------------------------------


def knowledge_router(  # noqa: PLR0915 - registers the route closures
    deps: KnowledgeDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
    allowed: Callable[[Caller, str, list[KnowledgeBaseResource]], frozenset[str]],
    is_allowed: Callable[[Caller, str], bool],
) -> APIRouter:
    """``allowed(caller, action, bases)``: the ids of ``bases`` the caller may ``action``, to
    shape an answer (no 403). ``is_allowed(caller, action)``: the same on the platform."""
    router = APIRouter(prefix="/api/knowledge-bases")
    KbId = Annotated[str, Path(pattern=knowledge.ID_PATTERN)]  # noqa: N806
    DocId = Annotated[str, Path(pattern=knowledge.ID_PATTERN)]  # noqa: N806

    async def run[T](fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        return await asyncio.to_thread(fn, *args, **kwargs)

    async def viewer(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        await authorize(caller, "ViewKnowledgeBase", *PLATFORM, read_only=True)
        return caller

    async def creator(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        await authorize(caller, "CreateKnowledgeBase", *PLATFORM)
        return caller

    Viewer = Annotated[Caller, Depends(viewer)]  # noqa: N806
    Creator = Annotated[Caller, Depends(creator)]  # noqa: N806

    async def load(kb_id: str) -> KnowledgeBase:
        try:
            kb = await run(deps.store.get, kb_id)
        except KnowledgeStoreUnavailableError as exc:
            raise _unavailable(exc) from exc
        if kb is None:
            raise HTTPException(status_code=404, detail="not found")
        return kb

    async def editable(caller: Caller, kb_id: str) -> KnowledgeBase:
        kb = await load(kb_id)
        await authorize(
            caller, "EditKnowledgeBase", KNOWLEDGE_BASE_TYPE, kb_id, knowledge=resource_of(kb)
        )
        return kb

    async def out(caller: Caller, bases: list[KnowledgeBase]) -> list[KnowledgeBaseOut]:
        resources = [resource_of(kb) for kb in bases]
        can_edit = await run(allowed, caller, "EditKnowledgeBase", resources)
        can_view = await run(allowed, caller, "ViewKnowledgeBase", resources)
        return [
            knowledge_base_out(
                kb, caller, can_edit=kb.kb_id in can_edit, can_view=kb.kb_id in can_view
            )
            for kb in bases
        ]

    @router.get("", response_model=KnowledgeBaseListOut)
    async def list_knowledge_bases(caller: Viewer) -> KnowledgeBaseListOut:
        try:
            bases = await run(deps.store.everything)
        except KnowledgeStoreUnavailableError as exc:
            raise _unavailable(exc) from exc
        can_create = await run(is_allowed, caller, "CreateKnowledgeBase")
        return KnowledgeBaseListOut(items=await out(caller, bases), can_create=can_create)

    @router.post("", response_model=KnowledgeBaseOut, status_code=201)
    async def create_new_knowledge_base(
        body: KnowledgeBaseCreate, caller: Creator
    ) -> KnowledgeBaseOut:
        _limit(deps.changes, caller.user.user_id)
        kb = await run(create_knowledge_base, deps, caller, body)
        return (await out(caller, [kb]))[0]

    @router.get("/{kb_id}", response_model=KnowledgeBaseOut)
    async def get_knowledge_base(kb_id: KbId, caller: Viewer) -> KnowledgeBaseOut:
        kb = await load(kb_id)
        return (await out(caller, [kb]))[0]

    @router.put("/{kb_id}", response_model=KnowledgeBaseOut)
    async def update_existing_knowledge_base(
        kb_id: KbId, body: KnowledgeBaseUpdate, caller: Viewer
    ) -> KnowledgeBaseOut:
        kb = await editable(caller, kb_id)
        _limit(deps.changes, caller.user.user_id)
        updated = await run(update_knowledge_base, deps, caller, kb, body)
        return (await out(caller, [updated]))[0]

    @router.post("/{kb_id}/delete", response_model=KnowledgeBaseOut, status_code=202)
    async def delete_existing_knowledge_base(
        kb_id: KbId, body: DeleteIn, caller: Viewer
    ) -> KnowledgeBaseOut:
        kb = await editable(caller, kb_id)
        _limit(deps.changes, caller.user.user_id)
        deleted = await run(delete_knowledge_base, deps, caller, kb, body.version)
        # Its documents and vectors are deleted, and verified, by the synchronization.
        await run(request_sync, deps, caller, deleted)
        return (await out(caller, [deleted]))[0]

    @router.post("/{kb_id}/sync", response_model=SyncOut, status_code=202)
    async def synchronize_knowledge_base(kb_id: KbId, _body: EmptyIn, caller: Viewer) -> SyncOut:
        """«Sincronizar ahora» (design 1)."""
        kb = await editable(caller, kb_id)
        _accepting(kb)
        _limit(deps.changes, caller.user.user_id)
        state = await run(request_sync, deps, caller, kb)
        if state == "unavailable":
            raise ApiError(503, "sync_unavailable", "please try again")
        return SyncOut(sync=state)

    @router.post(
        "/{kb_id}/documents/{doc_id}/delete", response_model=DocumentDeleteOut, status_code=202
    )
    async def delete_knowledge_base_document(
        kb_id: KbId, doc_id: DocId, _body: EmptyIn, caller: Viewer
    ) -> DocumentDeleteOut:
        kb = await editable(caller, kb_id)
        _limit(deps.changes, caller.user.user_id)
        document = await run(delete_document, deps, caller, kb, doc_id)
        state = await run(request_sync, deps, caller, kb)
        return DocumentDeleteOut(document=document_out(document), sync=state)

    @router.post("/{kb_id}/uploads", response_model=UploadsOut, status_code=201)
    async def request_document_uploads(kb_id: KbId, body: UploadsIn, caller: Viewer) -> UploadsOut:
        kb = await editable(caller, kb_id)
        if deps.uploads is not None:
            _limit(deps.uploads, caller.user.user_id)
        upload, signed = await run(request_uploads, deps, caller, kb, body)
        return UploadsOut(
            upload_id=upload.upload_id,
            expires_at=datetime.fromtimestamp(deps.clock() + UPLOAD_SECONDS, UTC),
            files=[
                SignedFileOut(doc_id=doc_id, name=name, url=url, fields=fields)
                for doc_id, (name, url, fields) in signed.items()
            ],
        )

    @router.post("/{kb_id}/documents", response_model=SaveOut)
    async def save_uploaded_documents(kb_id: KbId, body: SaveIn, caller: Viewer) -> SaveOut:
        kb = await editable(caller, kb_id)
        if deps.uploads is not None:
            _limit(deps.uploads, caller.user.user_id)
        saved, rejected = await run(save_documents, deps, caller, kb, body)
        # What was saved is indexed by the synchronization (D88 (11)).
        state = await run(request_sync, deps, caller, kb) if saved else None
        return SaveOut(saved=[document_out(d) for d in saved], rejected=rejected, sync=state)

    @router.get("/{kb_id}/documents", response_model=DocumentListOut)
    async def list_documents(kb_id: KbId, caller: Viewer) -> DocumentListOut:
        kb = await load(kb_id)
        await authorize(
            caller,
            "ViewKnowledgeBase",
            KNOWLEDGE_BASE_TYPE,
            kb_id,
            read_only=True,
            knowledge=resource_of(kb),
        )
        try:
            documents = await run(deps.store.documents, kb_id)
        except KnowledgeStoreUnavailableError as exc:
            raise _unavailable(exc) from exc
        return DocumentListOut(items=[document_out(d) for d in documents])

    return router
