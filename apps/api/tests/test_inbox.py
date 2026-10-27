"""La Bandeja (D83; threat model ``inbox-threat-model.md``): approvals the caller can sign,
notices of the caller's task runs, read and archived state, pages and the unread count, against
moto DynamoDB and the release's real connector catalog."""

from __future__ import annotations

import json
import secrets
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api.approval_policy import Tier, TierReason
from mango_api.approvals import ApprovalDeps
from mango_api.approvals_store import ApprovalRecord, ApprovalStore, Signature, Status
from mango_api.inbox import InboxDeps, RunInbox
from mango_api.inbox_store import RETENTION, InboxStore, first_line
from mango_api.knowledge_sources import ProposerOut, QueuedSourceOut
from mango_api.mcp_catalog import McpCatalog
from mango_api.tool_policies import PolicyStore
from mango_api.web import ApiError
from mango_core.knowledge import SourceStatus

from .test_admin import RecordingAudit, _table
from .test_app import (
    HOST,
    KEY,
    FakeBedrock,
    FakeBudgets,
    FakeConversations,
    FakeLimits,
    FakeModelCatalog,
    FakePublished,
    FakeVerifier,
    _settings,
)
from .test_approvals import (
    CONNECTORS,
    GATEWAY_TOOL,
    TOOL,
    RoleAuthorizer,
    _approvals_table,
    _h,
    write_agent,
)

URL = "/api/inbox"
REQUESTER, APPROVER, APPROVER2, LEAD = "user-10", "user-11", "user-12", "user-13"


@dataclass
class InboxAuthorizer(RoleAuthorizer):
    deny_inbox: bool = False

    def is_allowed(self, user: Any, action: str, _rt: str, _rid: str, _agent: Any = None) -> bool:
        if action == "ViewInbox":
            self.decisions.append((user.user_id, action, not self.deny_inbox))
            return not self.deny_inbox
        return super().is_allowed(user, action, _rt, _rid, _agent)


@dataclass
class Clients:
    """The RLS client factory: records whose partition each call was bound to."""

    db: Any
    users: list[str] = field(default_factory=list)

    def __call__(self, user_id: str) -> Any:
        self.users.append(user_id)
        return self.db


@dataclass
class Env:
    client: TestClient
    db: Any
    clients: Clients
    approvals: ApprovalStore
    store: InboxStore
    runs: RunInbox
    authorizer: InboxAuthorizer
    clock: list[datetime]
    now: list[float]
    inbox: InboxDeps | None = None

    def request(self, by: str = REQUESTER, **changes: Any) -> ApprovalRecord:
        at = self.clock[0]
        record = ApprovalRecord(
            approval_id=changes.pop("approval_id", secrets.token_hex(16)),
            status=Status.PENDING,
            tier=changes.pop("tier", Tier.APPROVERS),
            tier_reason=TierReason.ALWAYS,
            tool=TOOL,
            gateway_tool=GATEWAY_TOOL,
            arguments=json.dumps({"amount_usd": 100, "name": "team-a"}, separators=(",", ":")),
            args_hash="h" * 64,
            agent_id="finops",
            agent_version=3,
            conversation_id="c" * 32,
            requested_by=by,
            requested_by_email="r@x.co",
            created_at=at,
            expires_at=at + timedelta(hours=24),
            approvals_needed=changes.pop("approvals_needed", 1),
            rule={"condition": "always", "approvers": 1, "expires_hours": 24},
            **changes,
        )
        self.approvals.create(record, at)
        return record

    def run(self, owner: str = REQUESTER, *, ok: bool = True, **changes: Any) -> None:
        self.now[0] += 1
        self.runs.run_ended(
            remote_connect=changes.get("remote_connect"),
            owner_id=owner,
            task_id=changes.get("task_id", "t" * 32),
            task_name=changes.get("task_name", "Budget check diario"),
            agent_id="finops",
            run_id=changes.get("run_id", "r" * 32),
            ok=ok,
            reason=changes.get("reason"),
            report=changes.get("report", "## Gasto estable\n\nTodo en orden."),
        )

    def get(self, token: str, **params: str) -> Any:
        return self.client.get(URL, headers=_h(token), params=params)

    def put(self, token: str, kind: str, item_id: str, body: dict[str, Any]) -> Any:
        return self.client.put(f"{URL}/{kind}/{item_id}", headers=_h(token), json=body)


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    clock = [datetime(2026, 10, 16, 12, tzinfo=UTC)]
    now = [clock[0].timestamp()]
    catalog = McpCatalog.load(CONNECTORS)
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "settings")
        _table(db, "conv")
        _approvals_table(db, "approvals")
        audit, authorizer = RecordingAudit(), InboxAuthorizer()
        published = FakePublished(agents={"finops": write_agent()})
        approvals = ApprovalStore(db, "approvals")
        deps = ApprovalDeps(
            store=approvals,
            policies=PolicyStore(db, "settings"),
            catalog=lambda: catalog,
            published=published,  # type: ignore[arg-type]
            audit=audit,  # type: ignore[arg-type]
            clock=lambda: clock[0],
        )
        clients = Clients(db)
        store = InboxStore(clients, "conv", clock=lambda: now[0])
        inbox = InboxDeps(
            store=store,
            published=published,  # type: ignore[arg-type]
            approvals=deps,
            clock=lambda: clock[0],
        )

        def factory(s: Any) -> app_module.Services:
            return app_module.Services(
                settings=s,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=authorizer,  # type: ignore[arg-type]
                budgets=FakeBudgets(),  # type: ignore[arg-type]
                conversations=FakeConversations(),  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=None,
                bedrock=FakeBedrock(),
                settings_store=None,  # type: ignore[arg-type]
                budget_limits=FakeLimits(),  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=published,  # type: ignore[arg-type]
                model_catalog=FakeModelCatalog(),  # type: ignore[arg-type]
                invocation_key=KEY,
                approvals=deps,
                inbox=inbox,
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(
            client, db, clients, approvals, store, RunInbox(store), authorizer, clock, now, inbox
        )


# --- Approvals: the rule of the approvals screen (D56) ---------------------------------------


def test_an_approver_sees_what_they_can_sign_and_nobody_else_does(env: Env) -> None:
    record = env.request()
    page = env.get("approver").json()
    (item,) = page["items"]
    assert (item["kind"], item["item_id"], item["read"]) == ("approval", record.approval_id, False)
    assert item["approval"]["arguments"] == {"amount_usd": 100, "name": "team-a"}
    assert item["approval"]["can_sign"] is True
    # Who asked never signs, so it is not in their inbox; an area lead cannot sign at all.
    assert env.get("requester").json()["items"] == []
    assert env.get("lead").json()["items"] == []
    assert (page["unread"], page["can_decide"]) == (1, True)


def test_a_request_leaves_the_inbox_once_signed_decided_or_expired(env: Env) -> None:
    two = env.request(approvals_needed=2)
    one = env.request()
    expiring = env.request()
    # The first signature of two: gone for who signed, still there for the other approver.
    env.approvals.sign(two, Signature(APPROVER, "a1@x.co", "now"), now=env.clock[0])
    assert {i["item_id"] for i in env.get("approver").json()["items"]} == {
        one.approval_id,
        expiring.approval_id,
    }
    assert two.approval_id in {i["item_id"] for i in env.get("approver2").json()["items"]}
    env.approvals.close(
        one, to=Status.REJECTED, actor=APPROVER2, actor_email=None, note="no", now=env.clock[0]
    )
    env.clock[0] += timedelta(hours=25)
    assert env.get("approver").json()["items"] == []
    # Self-confirmation requests are never in anyone's inbox.
    env.clock[0] -= timedelta(hours=25)
    env.request(tier=Tier.SELF)
    # Which requests remain, not their order: they were all made at the same instant.
    remaining = [i["item_id"] for i in env.get("approver2").json()["items"]]
    assert sorted(remaining) == sorted([two.approval_id, expiring.approval_id])


def test_reading_and_archiving_an_approval_is_per_person(env: Env) -> None:
    record = env.request()
    read = env.put("approver", "approval", record.approval_id, {"read": True})
    assert (read.status_code, read.json()["read"]) == (200, True)
    assert env.get("approver", view="unread").json()["items"] == []
    assert env.get("approver2", view="unread").json()["items"][0]["read"] is False
    archived = env.put("approver", "approval", record.approval_id, {"archived": True}).json()
    assert (archived["archived"], archived["read"]) == (True, True)
    assert env.get("approver").json()["items"] == []
    assert env.get("approver", view="archived").json()["items"][0]["item_id"] == record.approval_id
    # The state lives in the approver's partition, with the inbox's retention.
    item = env.db.get_item(
        TableName="conv",
        Key={
            "PK": {"S": f"USER#{APPROVER}"},
            "SK": {"S": f"INBOXSTATE#APPROVAL#{record.approval_id}"},
        },
    )["Item"]
    assert int(item["ttl"]["N"]) == int(env.now[0] + RETENTION.total_seconds())


def test_an_approval_the_caller_cannot_sign_is_not_found(env: Env) -> None:
    record = env.request()
    for token in ("requester", "lead"):
        response = env.put(token, "approval", record.approval_id, {"read": True})
        assert response.status_code == 404, token
    assert env.put("approver", "approval", "f" * 32, {"read": True}).status_code == 404
    # Nothing was written for them.
    assert (
        env.db.query(
            TableName="conv",
            KeyConditionExpression="PK = :pk",
            ExpressionAttributeValues={":pk": {"S": f"USER#{LEAD}"}},
        )["Items"]
        == []
    )


# --- Run notices: only for the owner (D78 (18), D82) ----------------------------------------


def test_a_run_notice_is_for_its_owner_only(env: Env) -> None:
    env.run(report="## Gasto **estable**\n\nDetalle largo que no se copia.")
    env.run(ok=False, reason="budget_exceeded", report="texto que no debe aparecer")
    page = env.get("requester").json()
    failed, completed = page["items"]
    assert completed["run"] == {
        "task_id": "t" * 32,
        "run_id": "r" * 32,
        "task_name": "Budget check diario",
        "ok": True,
        "summary": "Gasto estable",
        "reason": None,
    }
    assert (failed["run"]["ok"], failed["run"]["reason"], failed["run"]["summary"]) == (
        False,
        "budget_exceeded",
        None,
    )
    assert completed["agent_name"] is not None
    assert "Detalle largo" not in json.dumps(page) and "no debe" not in json.dumps(page)
    assert page["unread"] == 2
    for token in ("approver", "admin2"):
        assert env.get(token).json()["items"] == [], token
        response = env.put(token, "run", completed["item_id"], {"read": True})
        assert response.status_code == 404, token
    # Every call was bound to the partition of whoever it served.
    assert set(env.clients.users) <= {REQUESTER, APPROVER, "admin-2"}


def test_a_run_that_needs_a_connection_asks_its_owner_to_connect(env: Env) -> None:
    """D98 (20): the notice of a run that failed for a remote MCP's consent is
    ``remote_connect``, with the registration and never a URL; read and archived as a run."""
    env.runs.run_ended(
        owner_id=REQUESTER,
        task_id="t" * 32,
        task_name="Work items",
        agent_id="finops",
        run_id="r" * 32,
        ok=False,
        reason="remote_consent_required",
        report=None,
        remote_connect="abcdefghij23",
    )
    # A completed run never carries it, nor an id that is not a registration.
    env.run(remote_connect="abcdefghij23")
    env.runs.run_ended(
        owner_id=REQUESTER,
        task_id="t" * 32,
        task_name="x",
        agent_id="finops",
        run_id="s" * 32,
        ok=False,
        reason="upstream_error",
        report=None,
        remote_connect="https://evil.example",
    )
    bad, completed, notice = env.get("requester").json()["items"]
    assert (notice["kind"], notice["remote"]) == (
        "remote_connect",
        {"registration_id": "abcdefghij23"},
    )
    assert (notice["run"]["ok"], notice["run"]["reason"]) == (False, "remote_consent_required")
    assert (completed["kind"], completed["remote"]) == ("run", None)
    assert (bad["kind"], bad["remote"]) == ("run", None)
    read = env.put("requester", "remote_connect", notice["item_id"], {"read": True})
    assert (read.status_code, read.json()["kind"], read.json()["read"]) == (
        200,
        "remote_connect",
        True,
    )
    assert (
        env.put("approver", "remote_connect", notice["item_id"], {"read": True}).status_code == 404
    )


def test_pages_of_twenty_newest_first_with_a_cursor(env: Env) -> None:
    for n in range(25):
        env.run(task_name=f"Tarea {n:02d}")
    first = env.get("requester").json()
    assert [i["run"]["task_name"] for i in first["items"]][:2] == ["Tarea 24", "Tarea 23"]
    assert len(first["items"]) == 20 and first["next_cursor"]
    second = env.get("requester", cursor=first["next_cursor"]).json()
    assert [i["run"]["task_name"] for i in second["items"]] == [
        f"Tarea {n:02d}" for n in range(4, -1, -1)
    ]
    assert second["next_cursor"] is None
    assert env.get("requester", cursor="../../etc").status_code == 422


def test_unread_count_mark_all_read_and_archive(env: Env) -> None:
    env.run()
    env.run()
    env.request(by=APPROVER2)
    assert env.client.get(f"{URL}/unread", headers=_h("approver")).json() == {
        "unread": 1,
        "to_sign": 1,
    }
    env.run(owner=APPROVER)
    assert env.client.get(f"{URL}/unread", headers=_h("approver")).json() == {
        "unread": 2,
        "to_sign": 1,
    }
    done = env.client.post(f"{URL}/read-all", headers=_h("approver"), json={})
    # Read or not, the request still waits for the approver's signature.
    assert done.json() == {"unread": 0, "to_sign": 1}
    # The requester is central FinOps too: two runs and the request they can sign.
    assert env.client.get(f"{URL}/unread", headers=_h("requester")).json() == {
        "unread": 3,
        "to_sign": 1,
    }
    item = env.get("requester", view="unread").json()["items"][-1]
    env.put("requester", "run", item["item_id"], {"archived": True})
    assert len(env.get("requester").json()["items"]) == 2
    assert env.get("requester", view="archived").json()["items"][0]["read"] is True
    back = env.put("requester", "run", item["item_id"], {"archived": False}).json()
    assert (back["archived"], back["read"]) == (False, True)
    unread = env.put("requester", "run", item["item_id"], {"read": False}).json()
    assert unread["read"] is False
    # The approvals view has no run notices.
    assert env.get("approver", view="approvals").json()["items"][0]["kind"] == "approval"


def test_the_body_and_the_path_are_validated(env: Env) -> None:
    env.run()
    item = env.get("requester").json()["items"][0]["item_id"]
    assert env.put("requester", "run", item, {}).status_code == 422
    assert env.put("requester", "run", item, {"read": True, "x": 1}).status_code == 422
    assert env.put("requester", "ticket", item, {"read": True}).status_code == 422
    assert env.put("requester", "run", "1" * 28, {"read": True}).status_code == 422
    assert env.put("requester", "run", "1" * 13 + "a" * 16, {"read": True}).status_code == 404
    assert env.get("requester", view="mentions").status_code == 422


def test_every_route_needs_view_inbox(env: Env) -> None:
    env.authorizer.deny_inbox = True
    assert env.get("requester").status_code == 403
    assert env.client.get(f"{URL}/unread", headers=_h("requester")).status_code == 403
    assert env.client.post(f"{URL}/read-all", headers=_h("requester"), json={}).status_code == 403
    assert env.client.get(URL).status_code == 401


def test_a_notice_that_cannot_be_written_never_breaks_the_run(env: Env) -> None:
    env.db.delete_table(TableName="conv")
    env.run()  # does not raise
    assert env.get("requester").status_code == 503


@pytest.mark.parametrize(
    ("report", "line"),
    [
        ("## Resumen\n\nTodo bien", "Resumen"),
        ("\n\n  **Costo** sube `ec2`  \nmás", "Costo sube ec2"),
        ("", None),
        (None, None),
        ("#\n###   \n", None),
        ("x" * 500, "x" * 200),
    ],
)
def test_the_first_line_of_the_report(report: str | None, line: str | None) -> None:
    assert first_line(report) == line


# --- Bucket proposals of knowledge bases (D88 (49)) ------------------------------------------

SRC = "01JD0000000000000000000001"


def _source(src_id: str = SRC, *, can_decide: bool = True, **changes: Any) -> QueuedSourceOut:
    return QueuedSourceOut(
        src_id=src_id,
        kb_id="01JC0000000000000000000001",
        bucket="docs-rrhh",
        prefix="politicas/",
        status=SourceStatus.PENDING,
        proposed_by=ProposerOut(user_id="creator-1", email="creator1@example.com"),
        proposed_at=changes.pop("proposed_at", datetime(2026, 10, 16, 11, tzinfo=UTC)),
        decided_at=None,
        decided_by=None,
        note=None,
        version=1,
        role_ready=False,
        can_decide=can_decide,
        knowledge_base="Políticas de RH",
        groups=["hr"],
        sync_schedule="daily",
        replaces=None,
        withdrawn_at=None,
        **changes,
    )


def test_a_bucket_proposal_to_sign_is_pinned_with_its_card(env: Env) -> None:
    assert env.inbox is not None
    record = env.request()
    env.inbox.sources = lambda caller: (
        [_source(), _source("01JD0000000000000000000002", can_decide=False)]
        if caller.user.user_id == APPROVER
        else []
    )
    page = env.get("approver").json()
    # Newest first: the approval (12:00) before the proposal (11:00); the own one is not there.
    assert [(i["kind"], i["item_id"]) for i in page["items"]] == [
        ("approval", record.approval_id),
        ("kbsource", SRC),
    ]
    source = page["items"][1]
    assert (source["agent_id"], source["source"]["knowledge_base"]) == (None, "Políticas de RH")
    assert page["unread"] == 2
    assert [i["kind"] for i in env.get("approver", view="approvals").json()["items"]] == [
        "approval",
        "kbsource",
    ]
    assert env.get("approver2").json()["items"][0]["kind"] == "approval"


def test_reading_and_archiving_a_bucket_proposal_is_per_person(env: Env) -> None:
    assert env.inbox is not None
    env.inbox.sources = lambda caller: [_source()]
    read = env.put("approver", "kbsource", SRC, {"read": True})
    assert (read.status_code, read.json()["read"]) == (200, True)
    assert env.get("approver", view="unread").json()["items"] == []
    archived = env.put("approver", "kbsource", SRC, {"archived": True}).json()
    assert (archived["archived"], archived["read"]) == (True, True)
    assert env.get("approver", view="archived").json()["items"][0]["item_id"] == SRC
    item = env.db.get_item(
        TableName="conv",
        Key={"PK": {"S": f"USER#{APPROVER}"}, "SK": {"S": f"INBOXSTATE#KBSOURCE#{SRC}"}},
    )["Item"]
    assert item["is_archived"]["BOOL"] is True
    # «Marcar todo como leído» reaches them too.
    env.inbox.sources = lambda caller: [_source(), _source("01JD0000000000000000000003")]
    assert env.client.post(f"{URL}/read-all", headers=_h("approver"), json={}).json() == {
        "unread": 0,
        "to_sign": 2,
    }


def test_a_bucket_proposal_one_cannot_sign_is_not_found(env: Env) -> None:
    assert env.inbox is not None
    env.inbox.sources = lambda caller: [_source(can_decide=False)]
    assert env.put("approver", "kbsource", SRC, {"read": True}).status_code == 404
    assert env.put("approver", "kbsource", "not-an-id", {"read": True}).status_code == 422


def test_the_inbox_answers_when_the_proposals_cannot_be_read(env: Env) -> None:
    assert env.inbox is not None
    record = env.request()

    def down(_caller: Any) -> list[QueuedSourceOut]:
        raise ApiError(503, "knowledge_unavailable", "please try again")

    env.inbox.sources = down
    assert [i["item_id"] for i in env.get("approver").json()["items"]] == [record.approval_id]
