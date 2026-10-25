"""AuditLog against moto DynamoDB: fields written per event, cursor pages, range and filters."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
import pytest
from moto import mock_aws

from mango_api.audit import (
    MAX_AGENT_LOOKUPS,
    MAX_EXAMINED,
    AuditAgentOut,
    AuditLog,
    AuditQuery,
    InvalidCursorError,
    audit_events_out,
    decode_cursor,
    encode_cursor,
    resource_of,
)
from mango_core.identity import UserContext

NOW = datetime(2026, 9, 30, 12, 0, tzinfo=UTC)
ADMIN = UserContext("admin-1", "finops-central", None, is_admin=True, email="a@example.com")


class FakeFirehose:
    def __init__(self) -> None:
        self.lines: list[bytes] = []

    def put_record(self, **kwargs: Any) -> None:
        self.lines.append(kwargs["Record"]["Data"])


@pytest.fixture
def log(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[AuditLog, Any, FakeFirehose]]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        db.create_table(
            TableName="audit-index",
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        firehose = FakeFirehose()
        yield AuditLog(firehose, "audit", db, "audit-index"), db, firehose  # type: ignore[arg-type]


def _put(db: Any, ts: datetime, n: int, event: str = "x", **detail: Any) -> str:
    """Index row as ``emit`` writes it, at a chosen time."""
    event_id = f"{n:032x}"
    stamp = ts.isoformat(timespec="milliseconds")
    record = {"event_id": event_id, "ts": stamp, "event": event, "user_id": "u", "detail": detail}
    db.put_item(
        TableName="audit-index",
        Item={
            "PK": {"S": f"DAY#{ts.strftime('%Y-%m-%d')}"},
            "SK": {"S": f"{stamp}#{event_id}"},
            "record": {"S": json.dumps(record)},
        },
    )
    return event_id


def _query(**kwargs: Any) -> AuditQuery:
    return AuditQuery(**{"since": NOW - timedelta(days=30), "until": NOW, "limit": 50, **kwargs})


def test_emit_records_actor_resource_and_hash(log: Any) -> None:
    audit, db, firehose = log
    audit.emit("settings.bu_mapping.withdrawn", "admin-1", {"change_id": "c" * 32}, ADMIN)
    record = json.loads(firehose.lines[0])
    assert (record["actor_email"], record["actor_role"], record["actor_is_admin"]) == (
        "a@example.com",
        "finops-central",
        True,
    )
    assert record["resource"] == {"type": "bu_change", "id": "c" * 32}
    body = {k: v for k, v in record.items() if k != "hash"}
    digest = hashlib.sha256(json.dumps(body, separators=(",", ":"), sort_keys=True).encode())
    assert record["hash"] == digest.hexdigest()
    [item] = db.scan(TableName="audit-index")["Items"]
    assert json.loads(item["record"]["S"]) == record


def test_emit_without_actor_keeps_the_old_shape(log: Any) -> None:
    audit, _, firehose = log
    audit.emit("x", "u", {"a": 1})
    assert set(json.loads(firehose.lines[0])) == {
        "event_id",
        "ts",
        "event",
        "user_id",
        "detail",
        "hash",
    }


@pytest.mark.parametrize(
    ("event", "detail", "expected"),
    [
        (
            "policy.decision",
            {"resource": "Mango::Platform::mango"},
            {"type": "Mango::Platform", "id": "mango"},
        ),
        (
            "settings.budget.updated",
            {"scope": "defaults"},
            {"type": "budget_defaults", "id": "defaults"},
        ),
        ("settings.budget.updated", {"target_user": "u9"}, {"type": "user_budget", "id": "u9"}),
        (
            "agent.invoke",
            {"agent": "finops", "conversation_id": "c1"},
            {"type": "conversation", "id": "c1"},
        ),
        ("budget.exceeded", {"agent": "finops"}, {"type": "agent", "id": "finops"}),
        ("account.mfa_reset", {"target_user": "u2"}, {"type": "user", "id": "u2"}),
        (
            # Same resource as the pack provisioner's own events, whatever else it carries.
            "mcp.pack.request.approved",
            {"pack": "aws-pricing", "change_id": "c" * 32},
            {"type": "mcp_pack", "id": "aws-pricing"},
        ),
        ("other", {}, None),
    ],
)
def test_resource_is_normalized(event: str, detail: dict[str, Any], expected: Any) -> None:
    assert resource_of(event, detail) == expected


def test_cursor_pages_across_days_without_gaps(log: Any) -> None:
    audit, db, _ = log
    ids = [_put(db, NOW - timedelta(hours=10 * i), i) for i in range(1, 8)]  # ~3 days
    seen: list[str] = []
    cursor = None
    for _ in range(10):
        page = audit.page(_query(limit=3, cursor=cursor), now=NOW)
        seen += [r["event_id"] for r in page.items]
        cursor = page.next_cursor
        if cursor is None:
            break
    assert seen == ids  # newest first, each once


def test_range_is_applied_on_the_server(log: Any) -> None:
    audit, db, _ = log
    old = _put(db, NOW - timedelta(days=3), 1)
    mid = _put(db, NOW - timedelta(days=2), 2)
    _put(db, NOW - timedelta(hours=1), 3)
    page = audit.page(
        _query(since=NOW - timedelta(days=3, hours=1), until=NOW - timedelta(days=1)), now=NOW
    )
    assert [r["event_id"] for r in page.items] == [mid, old]
    assert page.next_cursor is None


def test_range_is_clamped_to_the_index_lifetime(log: Any) -> None:
    audit, db, _ = log
    _put(db, NOW - timedelta(days=45), 1)
    page = audit.page(
        _query(since=NOW - timedelta(days=3650), until=NOW + timedelta(days=3650)), now=NOW
    )
    assert page.items == []


def test_reads_can_be_hidden_but_denials_and_writes_stay(log: Any) -> None:
    audit, db, _ = log
    t = NOW - timedelta(minutes=1)
    _put(db, t, 1, "policy.decision", action="ViewAdmin", allowed=True)  # old event, no flag
    _put(db, t, 2, "policy.decision", action="UseAgent", allowed=True, read_only=True)
    denied = _put(db, t, 3, "policy.decision", action="ViewAudit", allowed=False)
    chat = _put(db, t, 4, "policy.decision", action="UseAgent", allowed=True, read_only=False)
    write = _put(db, t, 5, "settings.budget.updated", outcome="applied")
    # Reading the directory is a read too; inviting someone is not.
    _put(db, t, 6, "directory.list", outcome="applied", returned=7)
    invite = _put(db, t, 7, "directory.invite", outcome="applied")
    # A session recovered on a page load is a read; its start, end and rejection are not (D64).
    _put(db, t, 8, "session.renewed")
    started = _put(db, t, 9, "session.started", federated=False)
    ended = _put(db, t, 10, "session.ended", reason="sign_out")
    refused = _put(db, t, 11, "session.rejected", reason="sub_mismatch")
    # An agent's search of its knowledge bases is a read; «Probar búsqueda» is not.
    _put(db, t, 12, "kb.retrieve", outcome="applied")
    tested = _put(db, t, 13, "kb.search", outcome="applied")
    everything = audit.page(_query(), now=NOW)
    assert len(everything.items) == 13
    page = audit.page(_query(exclude_reads=True), now=NOW)
    assert sorted(r["event_id"] for r in page.items) == sorted(
        [denied, chat, write, invite, started, ended, refused, tested]
    )


def test_a_scope_decision_of_the_actividad_is_a_read_even_when_denied(log: Any) -> None:
    # Someone who is not an administrator reads the Actividad (D90): the ViewAudit decision only
    # chooses whose activity is read. It must not show as a refused access nor count.
    audit, db, _ = log
    t = NOW - timedelta(minutes=1)
    scope = {"action": "ViewAudit", "resource": "Mango::Platform::mango", "read_only": True}
    _put(db, t, 1, "policy.decision", **scope, allowed=False, purpose="activity")
    _put(db, t, 2, "policy.decision", **scope, allowed=True, purpose="activity")
    # A real denial stays, also when read-only or with a purpose that is not in the list.
    denied = _put(db, t, 3, "policy.decision", action="ViewAudit", allowed=False)
    read_denied = _put(db, t, 4, "policy.decision", **scope, allowed=False)
    other = _put(db, t, 5, "policy.decision", **scope, allowed=False, purpose="other")
    listed = _put(db, t, 6, "policy.decision", **scope, allowed=False, purpose=["activity"])
    shown = audit.page(_query(exclude_reads=True), now=NOW)
    stay = [denied, read_denied, other, listed]
    assert sorted(r["event_id"] for r in shown.items) == sorted(stay)
    day = AuditQuery(since=NOW - timedelta(days=1), until=NOW, limit=1, exclude_reads=True)
    assert audit.count(day, cap=100, now=NOW).count == 4


def test_event_filter_exact_or_prefix(log: Any) -> None:
    audit, db, _ = log
    t = NOW - timedelta(minutes=1)
    _put(db, t, 1, "settings.budget.updated")
    _put(db, t, 2, "settings.bu_mapping.proposed")
    _put(db, t, 3, "agent.invoke")
    assert len(audit.page(_query(event="settings."), now=NOW).items) == 2
    assert len(audit.page(_query(event="agent.invoke"), now=NOW).items) == 1
    assert audit.page(_query(event="agent."), now=NOW).items[0]["event"] == "agent.invoke"


def test_several_events_and_only_what_happened(log: Any) -> None:
    # The recent activity of Gobernanza (D89): names or prefixes, without the ``requested`` (or
    # ``rejected``) half of a fail-closed audit; events without an outcome stay.
    audit, db, _ = log
    t = NOW - timedelta(minutes=1)
    _put(db, t, 1, "settings.budget.updated", outcome="requested")
    applied = _put(db, t, 2, "settings.budget.updated", outcome="applied")
    _put(db, t, 3, "settings.bu_mapping.proposed", outcome="rejected")
    mapping = _put(db, t, 4, "settings.bu_mapping.approved", outcome="applied")
    exceeded = _put(db, t, 5, "budget.exceeded")
    _put(db, t, 6, "agent.invoke")
    query = _query(
        events=("settings.budget.updated", "settings.bu_mapping.", "budget.exceeded"),
        applied_only=True,
    )
    assert sorted(r["event_id"] for r in audit.page(query, now=NOW).items) == sorted(
        [applied, mapping, exceeded]
    )


def test_count_skips_reads_and_stops_at_its_cap(log: Any) -> None:
    audit, db, _ = log
    for i in range(1, 4):
        _put(db, NOW - timedelta(minutes=i), i, "settings.budget.updated")
    _put(db, NOW - timedelta(minutes=5), 7, "policy.decision", action="ViewAdmin", allowed=True)
    # Across midnight, inside the last 24 hours; and one too old to count.
    _put(db, NOW - timedelta(hours=20), 8, "agent.invoke")
    _put(db, NOW - timedelta(hours=25), 9, "agent.invoke")
    day = AuditQuery(since=NOW - timedelta(days=1), until=NOW, limit=1, exclude_reads=True)
    counted = audit.count(day, cap=100, now=NOW)
    assert (counted.count, counted.capped) == (4, False)
    capped = audit.count(day, cap=2, now=NOW)
    assert (capped.count, capped.capped) == (2, True)
    # Exactly the cap examined is not capped.
    assert audit.count(day, cap=5, now=NOW).capped is False


def test_filtered_scan_is_bounded_and_resumable(log: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    import mango_api.audit as audit_module  # noqa: PLC0415

    monkeypatch.setattr(audit_module, "MAX_EXAMINED", 3)
    audit, db, _ = log
    for i in range(1, 6):
        _put(db, NOW - timedelta(minutes=i), i, "policy.decision", action="ViewAdmin", allowed=True)
    wanted = _put(db, NOW - timedelta(minutes=10), 9, "settings.budget.updated")
    first = audit.page(_query(exclude_reads=True), now=NOW)
    assert first.items == []
    assert first.next_cursor is not None
    second = audit.page(_query(exclude_reads=True, cursor=first.next_cursor), now=NOW)
    assert [r["event_id"] for r in second.items] == [wanted]
    assert MAX_EXAMINED > 3  # the real bound is larger


def test_cursor_is_validated() -> None:
    key = "2026-09-30T12:00:00.000+00:00#" + "a" * 32
    assert decode_cursor(encode_cursor(key)) == key
    for bad in ("", "not base64!", encode_cursor("DAY#x"), encode_cursor(key + "x"), "a" * 200):
        with pytest.raises(InvalidCursorError):
            decode_cursor(bad)


# --- Agent of an event --------------------------------------------------------------------


def _record(event: str, **detail: Any) -> dict[str, Any]:
    return {"event_id": "e" * 32, "ts": "t", "event": event, "user_id": "u", "detail": detail}


def test_the_agent_of_approved_and_retired_events_is_resolved_once_per_version() -> None:
    calls: list[tuple[str, int, str | None]] = []

    def lookup(agent: str, version: int, creator: str | None) -> AuditAgentOut | None:
        calls.append((agent, version, creator))
        return None if agent == "gone" else AuditAgentOut(name=agent.upper(), created_by_email="c")

    out = audit_events_out(
        [
            _record("agent.version.approved", agent="finops", version=3, created_by="u1"),
            _record("agent.retired", agent="finops", version=3, created_by="u1", reason="r"),
            _record("agent.retired", agent="gone", version=1, created_by="u1"),
            # Not an agent event, or one without the fields to look it up.
            _record("agent.invoke", agent="finops", version=3),
            _record("agent.version.approved", agent="finops", version="3"),
            _record("agent.version.approved", agent="finops", version=True),
        ],
        lookup,
    )
    assert calls == [("finops", 3, "u1"), ("gone", 1, "u1")]
    assert [e.agent.name if e.agent else None for e in out] == ["FINOPS", "FINOPS"] + [None] * 4
    assert audit_events_out([_record("agent.retired", agent="a", version=1)])[0].agent is None


def test_agent_lookups_are_bounded_and_a_failure_leaves_the_event_without_it() -> None:
    calls: list[str] = []

    def lookup(agent: str, version: int, creator: str | None) -> AuditAgentOut | None:
        calls.append(agent)
        if agent == "broken":
            raise RuntimeError("agents table unavailable")
        return AuditAgentOut(name=agent)

    records = [
        _record("agent.retired", agent=f"a{n}", version=1, created_by=None)
        for n in range(MAX_AGENT_LOOKUPS + 5)
    ]
    out = audit_events_out([_record("agent.retired", agent="broken", version=1), *records], lookup)
    assert len(calls) == MAX_AGENT_LOOKUPS
    assert out[0].agent is None
    assert sum(1 for e in out if e.agent is not None) == MAX_AGENT_LOOKUPS - 1
    assert out[0].model_dump()["agent"] is None
