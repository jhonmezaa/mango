"""Item layout of the ``Mango-<ns>-Agents`` table, shared by mango-api and the provisioner.

``PK`` / ``SK``:

* ``AGENT#<id>`` / ``META``: ``status`` (``AgentStatus``), ``published_version``,
  ``latest_version`` (last version number handed out), ``open_version`` (the single version
  that is not yet published, if any), ``harness_arn`` and ``harness_version`` (set by the
  provisioner), creator, retirement (``retired_by``, ``retired_at``, ``retire_reason``) and
  ``version`` (optimistic lock of this item).
* ``AGENT#<id>`` / ``VERSION#<n, 6 digits>``: ``definition`` (canonical JSON, includes
  ``reports_to`` and ``role``, D30), ``content_hash`` (set when sent to review), ``status``
  (``VersionStatus``), ``revision`` (optimistic lock of the draft), ``created_by``,
  ``editors`` (everyone who wrote this content: none of them may approve it, TM-M2),
  ``approved_by``, ``rejection_reason``, ``failed_step`` and ``base_version``.
* ``CREATOR#<sub>`` / ``DAY#<yyyy-mm-dd>``: ``submissions`` counter (UTC day) with ``ttl``.
* ``PUBLISHED#<id>`` / ``CURRENT``: what the provisioner deployed last (``version``,
  ``content_hash``, ``harness_arn``, ``harness_version``, ``published_at``). Only the
  provisioner can write this partition (IAM, ``dynamodb:LeadingKeys``): whoever serves an
  agent reads the version from here and checks its content against this hash, so nothing
  mango-api writes can change what is live (TM-M2).

``META`` also carries the provisioner lock (``provision_lock``, ``provision_lock_until``): one
execution per agent at a time (TM-M9).

Sparse indexes:

* ``ByStatus`` (``status_index`` / ``status_at``): versions in review, approved, failed,
  published or retired, and drafts a reviewer rejected (``REJECTED_INDEX``) until they are sent
  again or discarded. Other drafts and superseded versions are not indexed.
* ``ByCreator`` (``creator_index`` / ``created_at``): every version, by who created it.

Only two writers of state exist. mango-api owns the lifecycle up to ``approved`` (and
retirement); the provisioner owns ``approved`` -> ``published`` | ``failed`` through the builders
below, so both sides agree on the layout. The deprovisioner, which deletes the AWS resources
of a retired agent (D48), takes the same lock and writes nothing else.
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime, timedelta
from typing import Any

from mango_core.agents import AgentStatus, VersionStatus

AGENT_PREFIX = "AGENT#"
SK_META = "META"
VERSION_PREFIX = "VERSION#"
CREATOR_PREFIX = "CREATOR#"
PUBLISHED_PREFIX = "PUBLISHED#"
SK_CURRENT = "CURRENT"
DAY_PREFIX = "DAY#"
INDEX_BY_STATUS = "ByStatus"
INDEX_BY_CREATOR = "ByCreator"
MAX_VERSION = 999_999
MAX_FAILURE_CHARS = 500
REJECTED_INDEX = "VERSION#rejected"
"""``status_index`` of a draft that came back from review: the review history lists it."""
APPROVED_STUCK_AFTER = timedelta(minutes=45)
"""An ``approved`` version older than this has no execution behind it: the state machine
stops at 25 minutes and the provisioner lock expires at 30. Only then may it be retried."""
EXPIRED_STEP = "publication_expired"
"""``failed_step`` of an approved version that was given up on after ``APPROVED_STUCK_AFTER``."""

INDEXED_STATUSES = frozenset(
    {
        VersionStatus.IN_REVIEW,
        VersionStatus.APPROVED,
        VersionStatus.FAILED,
        VersionStatus.PUBLISHED,
        VersionStatus.RETIRED,
    }
)

_STEP_RE = re.compile(r"^[a-z][a-z0-9_]{0,47}$")


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds")


def agent_pk(agent_id: str) -> str:
    return AGENT_PREFIX + agent_id


def version_sk(number: int) -> str:
    if not 1 <= number <= MAX_VERSION:
        raise ValueError("version number out of range")
    return f"{VERSION_PREFIX}{number:06d}"


def creator_pk(user_id: str) -> str:
    return CREATOR_PREFIX + user_id


def day_sk(day: date) -> str:
    return DAY_PREFIX + day.isoformat()


def status_index(status: VersionStatus) -> str:
    return f"VERSION#{status.value}"


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: int) -> dict[str, str]:
    return {"N": str(value)}


def version_key(agent_id: str, number: int) -> dict[str, Any]:
    return {"PK": _s(agent_pk(agent_id)), "SK": _s(version_sk(number))}


def meta_key(agent_id: str) -> dict[str, Any]:
    return {"PK": _s(agent_pk(agent_id)), "SK": _s(SK_META)}


def published_key(agent_id: str) -> dict[str, Any]:
    return {"PK": _s(PUBLISHED_PREFIX + agent_id), "SK": _s(SK_CURRENT)}


# --- Provisioner transitions ------------------------------------------------------------


def publish_items(
    table: str,
    *,
    agent_id: str,
    version: int,
    content_hash: str,
    previous_version: int | None,
    harness_arn: str,
    harness_version: str,
    now: datetime,
) -> list[dict[str, Any]]:
    """``TransactWriteItems`` marking an approved version as the published one.

    Fails (condition) unless the version is still ``approved`` with the hash that was deployed
    and the agent has not been retired or republished meanwhile (TM-M2). The same transaction
    replaces the ``PUBLISHED#<id>`` pointer.
    """
    at = _s(iso(now))
    items: list[dict[str, Any]] = [
        {
            "Update": {
                "TableName": table,
                "Key": version_key(agent_id, version),
                "UpdateExpression": (
                    "SET #s = :published, status_index = :idx, status_at = :at, "
                    "published_at = :at REMOVE failed_step, failure"
                ),
                "ConditionExpression": "#s = :approved AND content_hash = :hash",
                "ExpressionAttributeNames": {"#s": "status"},
                "ExpressionAttributeValues": {
                    ":published": _s(VersionStatus.PUBLISHED),
                    ":approved": _s(VersionStatus.APPROVED),
                    ":idx": _s(status_index(VersionStatus.PUBLISHED)),
                    ":hash": _s(content_hash),
                    ":at": at,
                },
            }
        },
        {
            "Update": {
                "TableName": table,
                "Key": meta_key(agent_id),
                "UpdateExpression": (
                    "SET #s = :published, published_version = :n, harness_arn = :arn, "
                    "harness_version = :hv, updated_at = :at ADD version :one REMOVE open_version"
                ),
                "ConditionExpression": (
                    "#s <> :retired AND open_version = :n AND "
                    + (
                        "published_version = :prev"
                        if previous_version is not None
                        else "attribute_not_exists(published_version)"
                    )
                ),
                "ExpressionAttributeNames": {"#s": "status"},
                "ExpressionAttributeValues": {
                    ":published": _s(AgentStatus.PUBLISHED),
                    ":retired": _s(AgentStatus.RETIRED),
                    ":n": _n(version),
                    ":arn": _s(harness_arn),
                    ":hv": _s(harness_version),
                    ":at": at,
                    ":one": _n(1),
                    **({":prev": _n(previous_version)} if previous_version is not None else {}),
                },
            }
        },
    ]
    items.append(
        {
            "Put": {
                "TableName": table,
                "Item": {
                    **published_key(agent_id),
                    "agent_id": _s(agent_id),
                    "n": _n(version),
                    "content_hash": _s(content_hash),
                    "harness_arn": _s(harness_arn),
                    "harness_version": _s(harness_version),
                    "published_at": at,
                },
            }
        }
    )
    if previous_version is not None:
        items.append(
            {
                "Update": {
                    "TableName": table,
                    "Key": version_key(agent_id, previous_version),
                    "UpdateExpression": "SET #s = :superseded REMOVE status_index, status_at",
                    "ConditionExpression": "#s = :published",
                    "ExpressionAttributeNames": {"#s": "status"},
                    "ExpressionAttributeValues": {
                        ":superseded": _s(VersionStatus.SUPERSEDED),
                        ":published": _s(VersionStatus.PUBLISHED),
                    },
                }
            }
        )
    return items


def fail_item(
    table: str,
    *,
    agent_id: str,
    version: int,
    failed_step: str,
    failure: str,
    now: datetime,
) -> dict[str, Any]:
    """``UpdateItem`` arguments marking an approved version as failed at ``failed_step``.

    ``failure`` is shown to admins: pass an error code or short message, never raw payloads.
    """
    if not _STEP_RE.fullmatch(failed_step):
        raise ValueError("invalid step name")
    return {
        "TableName": table,
        "Key": version_key(agent_id, version),
        "UpdateExpression": (
            "SET #s = :failed, status_index = :idx, status_at = :at, failed_step = :step, "
            "failure = :failure"
        ),
        "ConditionExpression": "#s = :approved",
        "ExpressionAttributeNames": {"#s": "status"},
        "ExpressionAttributeValues": {
            ":failed": _s(VersionStatus.FAILED),
            ":approved": _s(VersionStatus.APPROVED),
            ":idx": _s(status_index(VersionStatus.FAILED)),
            ":at": _s(iso(now)),
            ":step": _s(failed_step),
            ":failure": _s(failure[:MAX_FAILURE_CHARS]),
        },
    }


def lock_item(
    table: str, *, agent_id: str, owner: str, now: datetime, ttl: timedelta
) -> dict[str, Any]:
    """``UpdateItem`` arguments taking the provisioner lock of an agent for ``owner``.

    Fails (condition) while another owner holds an unexpired lock, or if the agent is unknown.
    The lock expires so an aborted execution cannot block the agent forever.
    """
    return {
        "TableName": table,
        "Key": meta_key(agent_id),
        "UpdateExpression": "SET provision_lock = :owner, provision_lock_until = :until",
        "ConditionExpression": (
            "attribute_exists(PK) AND (attribute_not_exists(provision_lock) "
            "OR provision_lock = :owner OR provision_lock_until < :now)"
        ),
        "ExpressionAttributeValues": {
            ":owner": _s(owner),
            ":now": _n(int(now.timestamp())),
            ":until": _n(int((now + ttl).timestamp())),
        },
    }


def unlock_item(table: str, *, agent_id: str, owner: str) -> dict[str, Any]:
    """``UpdateItem`` arguments releasing the lock; fails (condition) unless ``owner`` holds it."""
    return {
        "TableName": table,
        "Key": meta_key(agent_id),
        "UpdateExpression": "REMOVE provision_lock, provision_lock_until",
        "ConditionExpression": "provision_lock = :owner",
        "ExpressionAttributeValues": {":owner": _s(owner)},
    }
