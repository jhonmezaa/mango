"""What Mango says exists: a read of the ``Agents`` table without agent content.

The reconciler never needs a definition, so it projects a fixed list of attributes and its
IAM policy allows only those (``dynamodb:Attributes``): prompts cannot reach this function.
Layout: ``mango_core.agents_table``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any

from mango_core.agents import AgentStatus, VersionStatus, is_agent_id
from mango_core.agents_table import (
    AGENT_PREFIX,
    CREATOR_PREFIX,
    DAY_PREFIX,
    PUBLISHED_PREFIX,
    SK_CURRENT,
    SK_META,
    VERSION_PREFIX,
)

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

SCAN_ATTRIBUTES = (
    "PK",
    "SK",
    "status",
    "status_at",
    "content_hash",
    "created_by",
    "published_version",
    "open_version",
    "harness_arn",
    "harness_version",
    "provision_lock_until",
    "n",
    "submissions",
)
"""Everything the reconciler reads. Keep in sync with ``RECONCILER_READABLE_ATTRIBUTES`` in
``infra/lib/constructs/reconciler.ts``; never add ``definition``."""


@dataclass(frozen=True)
class AgentMeta:
    status: AgentStatus
    published_version: int | None
    open_version: int | None
    harness_arn: str | None
    harness_version: str | None
    lock_until: int | None
    """Epoch seconds until which a provisioner execution holds the agent."""


@dataclass(frozen=True)
class VersionRecord:
    number: int
    status: VersionStatus
    content_hash: str | None
    status_at: datetime | None
    created_by: str | None


@dataclass(frozen=True)
class Pointer:
    """``PUBLISHED#<id>``: what the provisioner deployed last (only it can write this)."""

    version: int
    content_hash: str
    harness_arn: str
    harness_version: str


@dataclass(frozen=True)
class Submissions:
    creator: str
    day: str
    count: int


@dataclass
class Snapshot:
    agents: dict[str, AgentMeta] = field(default_factory=dict)
    versions: dict[str, dict[int, VersionRecord]] = field(default_factory=dict)
    pointers: dict[str, Pointer] = field(default_factory=dict)
    submissions: list[Submissions] = field(default_factory=list)
    invalid: list[str] = field(default_factory=list)
    """``PK|SK`` of items that do not follow the layout."""


def _opt_s(item: dict[str, Any], name: str) -> str | None:
    value: str | None = item.get(name, {}).get("S")
    return value


def _opt_n(item: dict[str, Any], name: str) -> int | None:
    value = item.get(name, {}).get("N")
    return int(value) if value is not None else None


def _add(snapshot: Snapshot, pk: str, sk: str, item: dict[str, Any]) -> None:
    if pk.startswith(AGENT_PREFIX):
        agent_id = pk[len(AGENT_PREFIX) :]
        if not is_agent_id(agent_id):
            raise ValueError("agent id")
        if sk == SK_META:
            snapshot.agents[agent_id] = AgentMeta(
                status=AgentStatus(item["status"]["S"]),
                published_version=_opt_n(item, "published_version"),
                open_version=_opt_n(item, "open_version"),
                harness_arn=_opt_s(item, "harness_arn"),
                harness_version=_opt_s(item, "harness_version"),
                lock_until=_opt_n(item, "provision_lock_until"),
            )
        elif sk.startswith(VERSION_PREFIX):
            number = int(sk[len(VERSION_PREFIX) :])
            raw_status_at = _opt_s(item, "status_at")
            status_at = datetime.fromisoformat(raw_status_at) if raw_status_at else None
            if status_at is not None and status_at.tzinfo is None:
                raise ValueError("status_at without offset")
            snapshot.versions.setdefault(agent_id, {})[number] = VersionRecord(
                number=number,
                status=VersionStatus(item["status"]["S"]),
                content_hash=_opt_s(item, "content_hash"),
                status_at=status_at,
                created_by=_opt_s(item, "created_by"),
            )
        else:
            raise ValueError("sort key")
    elif pk.startswith(PUBLISHED_PREFIX) and sk == SK_CURRENT:
        agent_id = pk[len(PUBLISHED_PREFIX) :]
        if not is_agent_id(agent_id):
            raise ValueError("agent id")
        snapshot.pointers[agent_id] = Pointer(
            version=int(item["n"]["N"]),
            content_hash=item["content_hash"]["S"],
            harness_arn=item["harness_arn"]["S"],
            harness_version=item["harness_version"]["S"],
        )
    elif pk.startswith(CREATOR_PREFIX) and sk.startswith(DAY_PREFIX):
        snapshot.submissions.append(
            Submissions(
                creator=pk[len(CREATOR_PREFIX) :],
                day=sk[len(DAY_PREFIX) :],
                count=int(item["submissions"]["N"]),
            )
        )
    else:
        raise ValueError("key")


def read_snapshot(dynamodb: DynamoDBClient, table: str) -> Snapshot:
    """Scan the table (hundreds of small items, once a day). Any AWS error propagates: a
    partial read must never look like a clean installation."""
    names = {f"#a{i}": name for i, name in enumerate(SCAN_ATTRIBUTES)}
    snapshot = Snapshot()
    pages = dynamodb.get_paginator("scan").paginate(
        TableName=table,
        Select="SPECIFIC_ATTRIBUTES",
        ProjectionExpression=", ".join(names),
        ExpressionAttributeNames=names,
        ConsistentRead=True,
    )
    for page in pages:
        for item in page.get("Items", []):
            pk = str(item.get("PK", {}).get("S", ""))
            sk = str(item.get("SK", {}).get("S", ""))
            try:
                _add(snapshot, pk, sk, dict(item))
            except (KeyError, ValueError, TypeError):
                snapshot.invalid.append(f"{pk}|{sk}"[:200])
    return snapshot
