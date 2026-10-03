"""Pack enablement items of the ``Mango-<ns>-Settings`` table, shared by mango-api and the
pack provisioner (spec §4.4, §8).

``PK`` / ``SK``:

* ``MCP#<pack id>`` / ``ENABLEMENT``: the request an admin made and another approved.
  mango-api owns ``enablement_id`` (random, one per approved request), ``pack_version``,
  ``config`` (JSON object of manifest parameters), ``requested_by``, ``approved_by`` and
  ``status`` up to ``approved`` (and ``disabling``). The provisioner owns the rest of the
  life cycle (``installing`` -> ``enabled`` | ``failed``, ``disabling`` -> ``disabled``),
  ``status_at``, ``failed_step``, ``failure`` and its lock (``provision_lock``,
  ``provision_lock_until``): one execution per pack at a time.
* ``MCP_INSTALLED#<pack id>`` / ``CURRENT``: what the provisioner installed last. Only the
  provisioner can write this partition (IAM, ``dynamodb:LeadingKeys``); compensation and
  updates decide from it, so nothing mango-api writes can make the provisioner delete or
  repoint the resources of an installed pack.

* ``MCP_CHANGE#<pack id>`` / ``CHANGE#<change id>`` and ``PENDING``: the requests of
  administrators (enable, change parameters, update) and the marker of the one that waits for
  another administrator. Only mango-api reads and writes this partition.

Only two writers exist, and both build their writes to an enablement here so they agree on the
layout. mango-api owns ``version`` (optimistic locking of its own writes); the provisioner
never changes it, so every mango-api write is also conditioned on the status it expects and
on no execution holding the lock.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any

ENABLEMENT_PREFIX = "MCP#"
INSTALLED_PREFIX = "MCP_INSTALLED#"
CHANGE_PREFIX = "MCP_CHANGE#"
SK_ENABLEMENT = "ENABLEMENT"
SK_CURRENT = "CURRENT"
MAX_FAILURE_CHARS = 200

PACK_ID_PATTERN = r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$"
MAX_PACK_ID_CHARS = 24
ENABLEMENT_ID_PATTERN = r"^[A-Za-z0-9_-]{8,64}$"
_PACK_ID_RE = re.compile(PACK_ID_PATTERN)
_STEP_RE = re.compile(r"^[a-z][a-z0-9_]{0,47}$")


class PackStatus(StrEnum):
    PENDING = "pending"
    """Requested, waiting for another admin (mango-api)."""
    APPROVED = "approved"
    """Approved; the provisioner has not started yet (mango-api)."""
    INSTALLING = "installing"
    ENABLED = "enabled"
    FAILED = "failed"
    DISABLING = "disabling"
    """An admin asked to disable it (mango-api); the provisioner removes its resources."""
    DISABLED = "disabled"


def is_pack_id(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= MAX_PACK_ID_CHARS
        and _PACK_ID_RE.fullmatch(value) is not None
    )


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds")


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: int) -> dict[str, str]:
    return {"N": str(value)}


def _pack(pack_id: str) -> str:
    if not is_pack_id(pack_id):
        raise ValueError("invalid pack id")
    return pack_id


def enablement_key(pack_id: str) -> dict[str, Any]:
    return {"PK": _s(ENABLEMENT_PREFIX + _pack(pack_id)), "SK": _s(SK_ENABLEMENT)}


def installed_key(pack_id: str) -> dict[str, Any]:
    return {"PK": _s(INSTALLED_PREFIX + _pack(pack_id)), "SK": _s(SK_CURRENT)}


def change_partition(pack_id: str) -> str:
    return CHANGE_PREFIX + _pack(pack_id)


# --- mango-api transitions --------------------------------------------------------------

_API_LOCK_FREE = "(attribute_not_exists(provision_lock) OR provision_lock_until < :now)"


def _api_condition(
    expected_version: int, statuses: tuple[PackStatus, ...]
) -> tuple[str, dict[str, Any]]:
    """The item is as mango-api last saw it, in one of ``statuses``, and nobody works on it.

    Version 0 means "never written by mango-api"; a pack that was never requested has no item
    at all, which also passes when ``statuses`` allows a new request.
    """
    values: dict[str, Any] = {f":st{i}": _s(status) for i, status in enumerate(statuses)}
    names = ", ".join(values)
    if expected_version == 0:
        version = "attribute_not_exists(version)"
        status = f"(attribute_not_exists(#s) OR #s IN ({names}))"
    else:
        version = "version = :expected"
        status = f"#s IN ({names})"
        values[":expected"] = _n(expected_version)
    return f"{version} AND {status} AND {_API_LOCK_FREE}", values


def approve_item(
    table: str,
    *,
    pack_id: str,
    enablement_id: str,
    pack_version: str,
    config: dict[str, str],
    requested_by: str,
    approved_by: str,
    expected_version: int,
    now: datetime,
    extra: dict[str, str] | None = None,
) -> dict[str, Any]:
    """``Update`` (of a transaction) recording a request another administrator approved.

    It replaces whatever was approved before: a new ``enablement_id`` for the provisioner to
    install. What is installed keeps serving until that execution finishes (D26). ``extra``
    holds display attributes of mango-api (e-mails, dates); the provisioner ignores them.
    """
    if not re.fullmatch(ENABLEMENT_ID_PATTERN, enablement_id):
        raise ValueError("invalid enablement id")
    condition, values = _api_condition(
        expected_version, (PackStatus.ENABLED, PackStatus.FAILED, PackStatus.DISABLED)
    )
    assignments = {
        "#s": _s(PackStatus.APPROVED),
        "enablement_id": _s(enablement_id),
        "pack_version": _s(pack_version),
        "config": _s(json.dumps(config, sort_keys=True, separators=(",", ":"))),
        "requested_by": _s(requested_by),
        "approved_by": _s(approved_by),
        "status_at": _s(iso(now)),
        "version": _n(expected_version + 1),
        **{name: _s(value) for name, value in (extra or {}).items()},
    }
    sets = ", ".join(f"{name} = :set{i}" for i, name in enumerate(assignments))
    values |= {f":set{i}": value for i, value in enumerate(assignments.values())}
    values[":now"] = _n(int(now.timestamp()))
    return {
        "TableName": table,
        "Key": enablement_key(pack_id),
        "UpdateExpression": (
            f"SET {sets} REMOVE failed_step, failure, disabled_by, disabled_by_email, "
            "disabled_at, disable_reason"
        ),
        "ConditionExpression": condition,
        "ExpressionAttributeNames": {"#s": "status"},
        "ExpressionAttributeValues": values,
    }


def retry_item(
    table: str, *, pack_id: str, enablement_id: str, expected_version: int, now: datetime
) -> dict[str, Any]:
    """``UpdateItem`` arguments putting a failed installation back to ``approved``.

    Nothing that was approved changes: same request, same version, same parameters.
    """
    condition, values = _api_condition(expected_version, (PackStatus.FAILED,))
    return {
        "TableName": table,
        "Key": enablement_key(pack_id),
        "UpdateExpression": (
            "SET #s = :approved, status_at = :at, version = :new REMOVE failed_step, failure"
        ),
        "ConditionExpression": f"enablement_id = :id AND {condition}",
        "ExpressionAttributeNames": {"#s": "status"},
        "ExpressionAttributeValues": {
            **values,
            ":approved": _s(PackStatus.APPROVED),
            ":id": _s(enablement_id),
            ":at": _s(iso(now)),
            ":new": _n(expected_version + 1),
            ":now": _n(int(now.timestamp())),
        },
    }


def disable_item(
    table: str,
    *,
    pack_id: str,
    expected_version: int,
    disabled_by: str,
    disabled_by_email: str | None,
    reason: str,
    now: datetime,
) -> dict[str, Any]:
    """``Update`` (of a transaction) asking the provisioner to remove an installed pack."""
    condition, values = _api_condition(expected_version, (PackStatus.ENABLED, PackStatus.FAILED))
    update = (
        "SET #s = :disabling, status_at = :at, version = :new, disabled_by = :by, "
        "disabled_at = :at, disable_reason = :reason"
    )
    values |= {
        ":disabling": _s(PackStatus.DISABLING),
        ":at": _s(iso(now)),
        ":new": _n(expected_version + 1),
        ":by": _s(disabled_by),
        ":reason": _s(reason),
        ":now": _n(int(now.timestamp())),
    }
    if disabled_by_email:
        update += ", disabled_by_email = :email"
        values[":email"] = _s(disabled_by_email)
    return {
        "TableName": table,
        "Key": enablement_key(pack_id),
        "UpdateExpression": f"{update} REMOVE failed_step, failure",
        "ConditionExpression": condition,
        "ExpressionAttributeNames": {"#s": "status"},
        "ExpressionAttributeValues": values,
    }


# --- Provisioner transitions ------------------------------------------------------------

_CLEAR_FAILURE = "status_at = :at REMOVE failed_step, failure"
_LOCK_FREE = (
    "(attribute_not_exists(provision_lock) OR provision_lock = :owner "
    "OR provision_lock_until < :now)"
)


def begin_item(
    table: str,
    *,
    pack_id: str,
    enablement_id: str,
    pack_version: str,
    owner: str,
    now: datetime,
    ttl: timedelta,
    disable: bool,
) -> dict[str, Any]:
    """``UpdateItem`` arguments taking the provisioner lock of a pack for ``owner``.

    Enabling moves ``approved`` to ``installing`` in the same write; disabling keeps
    ``disabling``. Fails (condition) unless the item is the approved request the execution was
    started for, or while another owner holds an unexpired lock. The lock expires, so an
    execution that was cut off can be started again.
    """
    values: dict[str, Any] = {
        ":owner": _s(owner),
        ":now": _n(int(now.timestamp())),
        ":until": _n(int((now + ttl).timestamp())),
        ":id": _s(enablement_id),
        ":version": _s(pack_version),
    }
    if disable:
        update = "SET provision_lock = :owner, provision_lock_until = :until"
        status = "#s = :disabling"
        values[":disabling"] = _s(PackStatus.DISABLING)
    else:
        update = (
            "SET provision_lock = :owner, provision_lock_until = :until, #s = :installing, "
            "status_at = :at REMOVE failed_step, failure"
        )
        status = "#s IN (:approved, :installing)"
        values |= {
            ":approved": _s(PackStatus.APPROVED),
            ":installing": _s(PackStatus.INSTALLING),
            ":at": _s(iso(now)),
        }
    return {
        "TableName": table,
        "Key": enablement_key(pack_id),
        "UpdateExpression": update,
        "ConditionExpression": (
            f"enablement_id = :id AND pack_version = :version AND {status} AND {_LOCK_FREE}"
        ),
        "ExpressionAttributeNames": {"#s": "status"},
        "ExpressionAttributeValues": values,
    }


def unlock_item(table: str, *, pack_id: str, owner: str) -> dict[str, Any]:
    """``UpdateItem`` arguments releasing the lock; fails (condition) unless ``owner`` holds it."""
    return {
        "TableName": table,
        "Key": enablement_key(pack_id),
        "UpdateExpression": "REMOVE provision_lock, provision_lock_until",
        "ConditionExpression": "provision_lock = :owner",
        "ExpressionAttributeValues": {":owner": _s(owner)},
    }


def enabled_items(
    table: str,
    *,
    pack_id: str,
    enablement_id: str,
    owner: str,
    installed: dict[str, Any],
    now: datetime,
) -> list[dict[str, Any]]:
    """``TransactWriteItems`` marking the pack as enabled and replacing the installed pointer.

    ``installed`` holds plain values (strings, or JSON-serializable lists and objects); it is
    stored next to the key. Fails unless ``owner`` still holds the lock of this request.
    """
    at = _s(iso(now))
    pointer: dict[str, Any] = {**installed_key(pack_id), "pack_id": _s(pack_id), "installed_at": at}
    for name, value in installed.items():
        pointer[name] = _s(value if isinstance(value, str) else json.dumps(value, sort_keys=True))
    return [
        {
            "Update": {
                "TableName": table,
                "Key": enablement_key(pack_id),
                "UpdateExpression": f"SET #s = :enabled, {_CLEAR_FAILURE}",
                "ConditionExpression": (
                    "provision_lock = :owner AND enablement_id = :id AND #s = :installing"
                ),
                "ExpressionAttributeNames": {"#s": "status"},
                "ExpressionAttributeValues": {
                    ":enabled": _s(PackStatus.ENABLED),
                    ":installing": _s(PackStatus.INSTALLING),
                    ":owner": _s(owner),
                    ":id": _s(enablement_id),
                    ":at": at,
                },
            }
        },
        {"Put": {"TableName": table, "Item": pointer}},
    ]


def disabled_items(
    table: str, *, pack_id: str, enablement_id: str, owner: str, now: datetime
) -> list[dict[str, Any]]:
    """``TransactWriteItems`` marking the pack as disabled and removing the installed pointer."""
    return [
        {
            "Update": {
                "TableName": table,
                "Key": enablement_key(pack_id),
                "UpdateExpression": f"SET #s = :disabled, {_CLEAR_FAILURE}",
                "ConditionExpression": (
                    "provision_lock = :owner AND enablement_id = :id AND #s = :disabling"
                ),
                "ExpressionAttributeNames": {"#s": "status"},
                "ExpressionAttributeValues": {
                    ":disabled": _s(PackStatus.DISABLED),
                    ":disabling": _s(PackStatus.DISABLING),
                    ":owner": _s(owner),
                    ":id": _s(enablement_id),
                    ":at": _s(iso(now)),
                },
            }
        },
        {"Delete": {"TableName": table, "Key": installed_key(pack_id)}},
    ]


def fail_item(
    table: str,
    *,
    pack_id: str,
    owner: str,
    failed_step: str,
    failure: str,
    now: datetime,
    disable: bool,
) -> dict[str, Any]:
    """``UpdateItem`` arguments recording a failure at ``failed_step``.

    A failed installation becomes ``failed``; a failed removal stays ``disabling`` (it can be
    started again). ``failure`` is shown to admins: an error code, never raw payloads.
    """
    if not _STEP_RE.fullmatch(failed_step):
        raise ValueError("invalid step name")
    current = PackStatus.DISABLING if disable else PackStatus.INSTALLING
    target = PackStatus.DISABLING if disable else PackStatus.FAILED
    return {
        "TableName": table,
        "Key": enablement_key(pack_id),
        "UpdateExpression": (
            "SET #s = :target, status_at = :at, failed_step = :step, failure = :failure"
        ),
        "ConditionExpression": "provision_lock = :owner AND #s = :current",
        "ExpressionAttributeNames": {"#s": "status"},
        "ExpressionAttributeValues": {
            ":target": _s(target),
            ":current": _s(current),
            ":owner": _s(owner),
            ":at": _s(iso(now)),
            ":step": _s(failed_step),
            ":failure": _s(failure[:MAX_FAILURE_CHARS]),
        },
    }
