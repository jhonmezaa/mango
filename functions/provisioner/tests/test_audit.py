"""The provisioner writes audit records in exactly the format mango-api writes."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from mango_api.audit import AuditLog, resource_of
from mango_provisioner.audit import ACTOR, AuditWriter

from .conftest import AUDIT_TABLE, NOW, FakeFirehose, Lab

DETAIL = {"agent": "finops", "version": 2, "content_hash": "a" * 64, "outcome": "applied"}


def test_record_has_the_shape_of_mango_api_records(lab: Lab) -> None:
    ours = FakeFirehose()
    AuditWriter(ours, "s", lab.db, AUDIT_TABLE).emit("agent.version.published", dict(DETAIL), NOW)  # type: ignore[arg-type]
    theirs = FakeFirehose()
    AuditLog(theirs, "s", lab.db, AUDIT_TABLE).emit("agent.version.published", ACTOR, dict(DETAIL))  # type: ignore[arg-type]

    (mine,), (reference,) = ours.records, theirs.records
    assert set(mine) == set(reference)
    assert mine["user_id"] == ACTOR == reference["user_id"]
    assert (
        mine["resource"] == reference["resource"] == resource_of("agent.version.published", DETAIL)
    )
    assert mine["detail"] == reference["detail"]
    assert mine["ts"] == "2026-10-01T15:00:00.000+00:00"


def test_hash_covers_the_record_and_the_index_copy_is_readable_by_mango_api(lab: Lab) -> None:
    firehose = FakeFirehose()
    AuditWriter(firehose, "s", lab.db, AUDIT_TABLE).emit(
        "agent.version.published", dict(DETAIL), NOW
    )  # type: ignore[arg-type]
    (record,) = firehose.records
    body: dict[str, Any] = {k: v for k, v in record.items() if k != "hash"}
    expected = hashlib.sha256(
        json.dumps(body, separators=(",", ":"), sort_keys=True).encode()
    ).hexdigest()
    assert record["hash"] == expected

    items = lab.db.scan(TableName=AUDIT_TABLE)["Items"]
    (item,) = items
    assert item["PK"]["S"] == "DAY#2026-10-01"
    assert item["SK"]["S"] == f"{record['ts']}#{record['event_id']}"
    assert json.loads(item["record"]["S"]) == record
    assert int(item["ttl"]["N"]) > NOW.timestamp()
