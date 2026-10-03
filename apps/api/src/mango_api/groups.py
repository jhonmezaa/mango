"""Registry of access groups (D26): read-only list for the agent builder and settings.

Item layout in the Settings table (``PK`` / ``SK``): ``GROUPS`` / ``<group id>`` with ``type``
(``central``, ``area`` or ``general``), ``area`` (area groups only) and ``description``. IaC
seeds the partition once; afterwards it changes only through ``mango_api.group_admin``
(Settings > Groups, dual approval).

Security notes (security-best-practices, FastAPI):
* The route declares its authorization dependency, bound to the Cedar action ``ViewGroups``;
  the decision is audited (AUTH-001, AUTHZ-001).
* The response uses an explicit model (RESP-001). Stored items are validated with the shared
  rules of ``mango_core.groups``; an invalid registry fails closed (503), never a partial list.
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Annotated, Any

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from mango_api.web import ApiError, Caller
from mango_core.groups import MAX_GROUPS, GroupDef, InvalidGroupError

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

logger = logging.getLogger(__name__)

PK_GROUPS = "GROUPS"
PLATFORM = ("Mango::Platform", "mango")


class GroupsUnavailableError(Exception):
    """The registry could not be read or holds an invalid entry; callers fail closed."""


class GroupRegistry:
    def __init__(self, dynamodb: "DynamoDBClient", table: str) -> None:
        self._db = dynamodb
        self._table = table

    def list_groups(self) -> list[GroupDef]:
        """Every registered group, sorted by id."""
        items: list[dict[str, Any]] = []
        try:
            pages = self._db.get_paginator("query").paginate(
                TableName=self._table,
                KeyConditionExpression="PK = :pk",
                ExpressionAttributeValues={":pk": {"S": PK_GROUPS}},
                ConsistentRead=True,
            )
            for page in pages:
                items.extend(page.get("Items", []))
                if len(items) > MAX_GROUPS:
                    raise GroupsUnavailableError("too many groups")
        except (ClientError, BotoCoreError) as exc:
            raise GroupsUnavailableError("group registry unavailable") from exc
        try:
            groups = [_group_from(item) for item in items]
        except (InvalidGroupError, KeyError, TypeError, AttributeError) as exc:
            raise GroupsUnavailableError("invalid group registry") from exc
        return sorted(groups, key=lambda g: g.id)


def _group_from(item: dict[str, Any]) -> GroupDef:
    return GroupDef(
        id=item["SK"]["S"],
        type=item["type"]["S"],
        area=item.get("area", {}).get("S"),
        description=item.get("description", {}).get("S", ""),
    )


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GroupOut(_Strict):
    id: str
    type: str
    area: str | None
    description: str


class GroupList(_Strict):
    items: list[GroupOut]


Authorize = Callable[..., Awaitable[None]]


def groups_router(
    registry: GroupRegistry,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    router = APIRouter(prefix="/api")

    async def view_groups(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
        await authorize(caller, "ViewGroups", *PLATFORM, read_only=True)
        return caller

    @router.get("/groups", response_model=GroupList)
    async def list_groups(_caller: Annotated[Caller, Depends(view_groups)]) -> GroupList:
        try:
            groups = await asyncio.to_thread(registry.list_groups)
        except GroupsUnavailableError as exc:
            logger.warning("group registry read failed: %s", exc)
            raise ApiError(503, "groups_unavailable", "please try again") from exc
        return GroupList(
            items=[
                GroupOut(id=g.id, type=g.type, area=g.area, description=g.description)
                for g in groups
            ]
        )

    return router
