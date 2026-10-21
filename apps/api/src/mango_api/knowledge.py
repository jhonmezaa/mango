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
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
import re
import time
from collections.abc import Awaitable, Callable, Collection
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, Protocol

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from mango_api.agent_rules import find_secrets
from mango_api.audit import AuditLog
from mango_api.authz import KNOWLEDGE_BASE_TYPE, KnowledgeBaseResource
from mango_api.groups import GroupRegistry, GroupsUnavailableError
from mango_api.knowledge_store import (
    KnowledgeBase,
    KnowledgeConflictError,
    KnowledgeStore,
    KnowledgeStoreUnavailableError,
)
from mango_api.rate_limits import Limiter, RateLimitUnavailableError
from mango_api.web import ApiError, Caller, rate_limited
from mango_core import knowledge
from mango_core.knowledge import Status

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
CHANGES_PER_HOUR = 30
"""Creating, editing and deleting knowledge bases, per person (D70)."""
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


class KnowledgeBaseListOut(_Strict):
    items: list[KnowledgeBaseOut]
    can_create: bool


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


@dataclass
class KnowledgeDeps:
    store: KnowledgeStore
    groups: GroupRegistry
    areas: Callable[[], Collection[str]]
    """Areas of the installation (the business unit mapping, D35)."""
    audit: AuditLog
    changes: Limiter
    clock: Callable[[], float] = time.time


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


def delete_knowledge_base(
    deps: KnowledgeDeps, caller: Caller, kb: KnowledgeBase, version: int
) -> KnowledgeBase:
    """Mark it ``deleting``: the synchronization deletes its documents and vectors and
    verifies it (D88 (16)). The record stays, and listed, until then."""
    _editable(kb, version)
    detail = {"documents": kb.documents, "bytes": kb.bytes}
    return _write(
        deps, "kb.delete", caller, kb, changes={"status": Status.DELETING.value}, detail=detail
    )


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
    )


# --- Router -------------------------------------------------------------------------------


def knowledge_router(
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
        return (await out(caller, [deleted]))[0]

    return router
