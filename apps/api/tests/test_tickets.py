"""Tickets of Mango (D112; threat model ``tickets-threat-model.md``): the API with the real Cedar
policies and the Tickets table in moto."""

from __future__ import annotations

import time
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
from mango_api.approvals_store import ApprovalRecord
from mango_api.approvals_store import Status as ApprovalStatus
from mango_api.authz import AgentResource, Authorizer, TicketResource
from mango_api.tickets import TicketsDeps
from mango_core import tickets as core
from mango_core.identity import IdentityError, UserContext
from mango_core.tickets import (
    INDEX_BY_ASSIGNEE,
    INDEX_BY_CREATOR,
    INDEX_BY_UPDATED,
    Priority,
    Source,
    Status,
    Ticket,
    TicketStore,
)

from .cedar_fake import CedarPolicyStore
from .test_admin import RecordingAudit
from .test_app import (
    HOST,
    KEY,
    FakeAgentCore,
    FakeBedrock,
    FakeBudgets,
    FakeConversations,
    FakeLimits,
    FakeModelCatalog,
    FakePublished,
    _settings,
    served,
)

EXP = int(time.time()) + 3600
CLAIMS: dict[str, dict[str, Any]] = {
    "admin": {"sub": "admin-1", "mango_admin": "true", "cognito:groups": ["mango-admin"]},
    "ana": {"sub": "ana-1", "mango_email": "ana@empresa.com", "cognito:groups": ["finops-central"]},
    "beto": {
        "sub": "beto-1",
        "mango_email": "beto@empresa.com",
        "cognito:groups": ["finops-central"],
    },
    "carla": {"sub": "carla-1", "mango_email": "carla@empresa.com", "cognito:groups": ["ops"]},
}
AGENT = "finops"


class FakeVerifier:
    def verify(self, token: str) -> dict[str, Any]:
        if token not in CLAIMS:
            raise IdentityError("invalid")
        return {**CLAIMS[token], "exp": EXP, "client_id": "client"}


@dataclass
class FakeApprovals:
    records: dict[str, list[ApprovalRecord]] = field(default_factory=dict)
    fail: bool = False

    def by_requester(self, user_id: str, limit: int = 100) -> list[ApprovalRecord]:
        if self.fail:
            raise RuntimeError("down")
        return self.records.get(user_id, [])[:limit]


def approval(
    approval_id: str, *, conversation: str, agent: str = AGENT, status: str = "pending"
) -> ApprovalRecord:
    now = datetime.now(UTC)
    return ApprovalRecord(
        approval_id=approval_id,
        status=ApprovalStatus(status),
        tier=Tier.SELF,
        tier_reason=TierReason.ALWAYS,
        tool="tickets.create",
        gateway_tool="tickets___create",
        arguments="{}",
        args_hash="h",
        agent_id=agent,
        agent_version=3,
        conversation_id=conversation,
        requested_by="ana-1",
        requested_by_email=None,
        created_at=now,
        expires_at=now + timedelta(hours=1),
        approvals_needed=0,
        rule={},
    )


def create_tickets_table(db: Any, name: str) -> None:
    keys = {
        INDEX_BY_UPDATED: "all_pk",
        INDEX_BY_CREATOR: "creator_id",
        INDEX_BY_ASSIGNEE: "assignee_id",
    }
    db.create_table(
        TableName=name,
        KeySchema=[
            {"AttributeName": "PK", "KeyType": "HASH"},
            {"AttributeName": "SK", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": n, "AttributeType": "S"}
            for n in ("PK", "SK", "all_pk", "creator_id", "assignee_id", "updated_at")
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": index,
                "KeySchema": [
                    {"AttributeName": key, "KeyType": "HASH"},
                    {"AttributeName": "updated_at", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }
            for index, key in keys.items()
        ],
        BillingMode="PAY_PER_REQUEST",
    )


@dataclass
class Env:
    client: TestClient
    audit: RecordingAudit
    store: TicketStore
    published: FakePublished
    approvals: FakeApprovals
    cedar: CedarPolicyStore

    def create(self, token: str = "ana", **body: Any) -> Any:
        payload = {"title": "Revisar el gasto de octubre", "description": "Ver **EC2**.", **body}
        return self.client.post("/api/tickets", headers=_h(token), json=payload)

    def created(self, token: str = "ana", **body: Any) -> dict[str, Any]:
        response = self.create(token, **body)
        assert response.status_code == 201, response.text
        result: dict[str, Any] = response.json()
        return result

    def get(self, token: str, ticket_id: str) -> Any:
        return self.client.get(f"/api/tickets/{ticket_id}", headers=_h(token))

    def change(self, token: str, ticket: dict[str, Any], **body: Any) -> Any:
        return self.client.patch(
            f"/api/tickets/{ticket['ticket_id']}",
            headers=_h(token),
            json={"version": ticket["version"], **body},
        )

    def comment(self, token: str, ticket_id: str, body: str = "Lo reviso hoy.") -> Any:
        return self.client.post(
            f"/api/tickets/{ticket_id}/comments", headers=_h(token), json={"body": body}
        )

    def listed(self, token: str, **params: Any) -> dict[str, Any]:
        response = self.client.get("/api/tickets", headers=_h(token), params=params)
        assert response.status_code == 200, response.text
        result: dict[str, Any] = response.json()
        return result

    def events(self, name: str) -> list[dict[str, Any]]:
        return [d for e, _u, d in self.audit.events if e == name]


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _code(response: Any) -> str:
    return str(response.json()["error"]["code"])


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        create_tickets_table(db, "tickets")
        audit, cedar = RecordingAudit(), CedarPolicyStore()
        authorizer = Authorizer(cedar, "ps")  # type: ignore[arg-type]
        published = FakePublished(
            agents={
                AGENT: served(AGENT, groups=["finops-central"]),
                "retired1": served("retired1", retired=True, groups=["finops-central"]),
            }
        )
        store = TicketStore(db, "tickets")
        approvals = FakeApprovals()
        deps = TicketsDeps(
            store=store,
            published=published,  # type: ignore[arg-type]
            audit=audit,  # type: ignore[arg-type]
            creates=app_module.Limits().limiter("tickets.creates"),
            changes=app_module.Limits().limiter("tickets.changes"),
            comments=app_module.Limits().limiter("tickets.comments"),
            approvals=approvals,  # type: ignore[arg-type]
        )

        def factory(settings: Any) -> app_module.Services:
            return app_module.Services(
                settings=settings,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=authorizer,
                budgets=FakeBudgets(),  # type: ignore[arg-type]
                conversations=FakeConversations(),  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=FakeAgentCore(),
                bedrock=FakeBedrock(),
                settings_store=None,  # type: ignore[arg-type]
                budget_limits=FakeLimits(),  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=published,  # type: ignore[arg-type]
                model_catalog=FakeModelCatalog(),  # type: ignore[arg-type]
                invocation_key=KEY,
                tickets=deps,
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(client, audit, store, published, approvals, cedar)
        assert cedar.errors == []


# --- Creating -----------------------------------------------------------------------------


def test_a_ticket_gets_a_random_short_id_and_its_creator_from_the_token(env: Env) -> None:
    ticket = env.created(priority="high", agent_id=AGENT, assign_to_me=True)
    assert len(ticket["ticket_id"]) == core.ID_LENGTH
    assert ticket["status"] == "open"
    assert ticket["priority"] == "high"
    assert ticket["creator"] == {"user_id": "ana-1", "email": "ana@empresa.com"}
    assert ticket["assignee"] == ticket["creator"]
    assert ticket["source"] == "web"
    assert ticket["agent_name"] == "FinOps"
    assert ticket["history"][0]["action"] == "created"
    assert env.created()["ticket_id"] != ticket["ticket_id"]


@pytest.mark.parametrize(
    "extra",
    [
        {"creator_id": "beto-1"},
        {"status": "needs_approval"},
        {"conversation_id": "c1"},
        {"source": "agent"},
        {"assignee_id": "beto-1"},
    ],
)
def test_nobody_sends_what_the_server_decides(env: Env, extra: dict[str, Any]) -> None:
    response = env.create(**extra)
    assert response.status_code == 422
    assert _code(response) == "invalid_request"


def test_the_texts_have_limits_and_no_credentials(env: Env) -> None:
    assert env.create(title="x" * (core.MAX_TITLE + 1)).status_code == 422
    assert env.create(title="   ").status_code == 422
    assert env.create(description="x" * (core.MAX_DESCRIPTION + 1)).status_code == 422
    response = env.create(description="clave AKIAIOSFODNN7EXAMPLE")
    assert response.status_code == 422
    assert _code(response) == "secret_in_ticket"
    assert "AKIA" not in response.text


def test_the_agent_of_a_ticket_must_be_one_the_creator_may_use(env: Env) -> None:
    assert env.create("carla", agent_id=AGENT).status_code == 403
    assert env.create("ana", agent_id="retired1").status_code == 403
    assert env.create("ana", agent_id="nosuchagent").status_code == 403


def test_creating_is_audited_without_the_texts(env: Env) -> None:
    ticket = env.created(title="Secreto de negocio", description="Contenido")
    events = env.events("ticket.create")
    assert [e["outcome"] for e in events] == ["requested", "applied"]
    assert events[-1]["ticket_id"] == ticket["ticket_id"]
    assert events[-1]["title_chars"] == len("Secreto de negocio")
    assert all("Secreto" not in str(e) and "Contenido" not in str(e) for e in env.audit.events)


# --- Who sees what --------------------------------------------------------------------------


def test_a_ticket_is_seen_by_its_people_its_agents_users_and_admins(env: Env) -> None:
    private = env.created("carla")
    shared = env.created("ana", agent_id=AGENT)
    assert env.get("carla", private["ticket_id"]).status_code == 200
    assert env.get("admin", private["ticket_id"]).status_code == 200
    # Not hers and not of an agent she uses: as if it did not exist (TM-TK1).
    assert env.get("ana", private["ticket_id"]).status_code == 404
    assert env.get("beto", private["ticket_id"]).status_code == 404
    # Beto may use the agent: he sees the ticket; Carla may not.
    assert env.get("beto", shared["ticket_id"]).status_code == 200
    assert env.get("carla", shared["ticket_id"]).status_code == 404
    assert env.get("ana", "aaaaaaaaaaaa").status_code == 404
    assert env.get("ana", "../etc").status_code == 404


def test_a_ticket_of_a_retired_agent_stays_with_its_people(env: Env) -> None:
    ticket = env.created("ana", agent_id=AGENT)
    env.published.agents[AGENT] = served(AGENT, retired=True, groups=["finops-central"])
    assert env.get("beto", ticket["ticket_id"]).status_code == 404
    assert env.get("ana", ticket["ticket_id"]).status_code == 200


def test_a_hidden_ticket_cannot_be_changed_nor_commented(env: Env) -> None:
    ticket = env.created("carla")
    assert env.change("ana", ticket, status="done").status_code == 404
    assert env.comment("ana", ticket["ticket_id"]).status_code == 404
    assert env.get("carla", ticket["ticket_id"]).json()["status"] == "open"


def test_the_list_shows_only_what_cedar_allows_with_quick_views(env: Env) -> None:
    mine = env.created("ana", priority="high", assign_to_me=True)
    shared = env.created("beto", agent_id=AGENT)
    private = env.created("carla", priority="high")
    listed = env.listed("ana")
    ids = {t["ticket_id"] for t in listed["items"]}
    assert ids == {mine["ticket_id"], shared["ticket_id"]}
    assert listed["counts"] == {"all": 2, "mine": 1, "unassigned": 1, "high": 1}
    assert [t["ticket_id"] for t in env.listed("ana", view="mine")["items"]] == [mine["ticket_id"]]
    assert [t["ticket_id"] for t in env.listed("ana", view="unassigned")["items"]] == [
        shared["ticket_id"]
    ]
    admin = {t["ticket_id"] for t in env.listed("admin")["items"]}
    assert private["ticket_id"] in admin and len(admin) == 3


def test_the_list_filters_and_searches_on_the_server(env: Env) -> None:
    first = env.created("ana", title="Factura de EC2", priority="low")
    env.created("ana", title="Cuota de S3", status="in_progress")
    assert [t["ticket_id"] for t in env.listed("ana", q="ec2")["items"]] == [first["ticket_id"]]
    assert [t["ticket_id"] for t in env.listed("ana", q=first["ticket_id"][:6])["items"]] == [
        first["ticket_id"]
    ]
    assert len(env.listed("ana", status=["in_progress"])["items"]) == 1
    assert len(env.listed("ana", priority=["low", "high"])["items"]) == 1
    assert len(env.listed("ana", assignee="none")["items"]) == 2
    bad = env.client.get("/api/tickets", headers=_h("ana"), params={"view": "everything"})
    assert bad.status_code == 422


def test_listing_is_authorized_and_audited_as_a_read(env: Env) -> None:
    env.listed("ana")
    decisions = env.events("policy.decision")
    assert any(d["action"] == "ListTickets" and d["read_only"] for d in decisions)


# --- Changing ------------------------------------------------------------------------------


def test_status_and_priority_change_with_their_history(env: Env) -> None:
    ticket = env.created("ana")
    response = env.change("ana", ticket, status="in_progress", priority="low")
    assert response.status_code == 200, response.text
    changed = response.json()
    assert (changed["status"], changed["priority"], changed["version"]) == ("in_progress", "low", 2)
    lines = [(h["field"], h["before"], h["after"]) for h in changed["history"][1:]]
    assert lines == [("status", "open", "in_progress"), ("priority", "medium", "low")]
    update = env.events("ticket.update")[-1]
    assert update["fields"] == ["status", "priority"] and update["outcome"] == "applied"


def test_a_change_on_an_older_version_is_refused(env: Env) -> None:
    ticket = env.created("ana")
    assert env.change("ana", ticket, status="done").status_code == 200
    stale = env.change("ana", ticket, status="open")
    assert stale.status_code == 409
    assert _code(stale) == "ticket_changed"


def test_por_aprobar_is_never_chosen_by_hand(env: Env) -> None:
    ticket = env.created("ana")
    response = env.change("ana", ticket, status="needs_approval")
    assert response.status_code == 422


def test_an_unchanged_ticket_writes_nothing(env: Env) -> None:
    ticket = env.created("ana")
    response = env.change("ana", ticket, status="open")
    assert response.status_code == 200
    assert response.json()["version"] == 1
    assert env.events("ticket.update") == []


def test_a_ticket_is_assigned_to_oneself_or_a_participant_only(env: Env) -> None:
    ticket = env.created("ana", agent_id=AGENT)
    # Beto does not take part yet: the same answer whether he exists or not (TM-TK4).
    for who in ("beto-1", "nobody-9"):
        refused = env.change("ana", ticket, assignee_id=who)
        assert refused.status_code == 422
        assert _code(refused) == "assignee_not_participant"
    # He comments, so he takes part; or he assigns it to himself.
    assert env.comment("beto", ticket["ticket_id"]).status_code == 201
    current = env.get("ana", ticket["ticket_id"]).json()
    assert {p["user_id"] for p in current["participants"]} == {"ana-1", "beto-1"}
    assigned = env.change("ana", current, assignee_id="beto-1")
    assert assigned.status_code == 200
    assert assigned.json()["assignee"] == {"user_id": "beto-1", "email": "beto@empresa.com"}
    unassigned = env.change("ana", assigned.json(), assignee_id=None)
    assert unassigned.json()["assignee"] is None


def test_whoever_assigns_it_to_themselves_joins_and_keeps_seeing_it(env: Env) -> None:
    ticket = env.created("ana", agent_id=AGENT)
    taken = env.change("beto", ticket, assignee_id="beto-1")
    assert taken.status_code == 200
    assert taken.json()["assignee"]["email"] == "beto@empresa.com"
    # Without the agent, Beto still sees it: he has it assigned.
    env.published.agents[AGENT] = served(AGENT, retired=True, groups=["finops-central"])
    assert env.get("beto", ticket["ticket_id"]).status_code == 200


# --- Comments ------------------------------------------------------------------------------


def test_a_comment_is_markdown_stored_as_text_and_audited_without_it(env: Env) -> None:
    ticket = env.created("ana")
    body = "Ver <img src=x onerror=alert(1)> y **esto**"
    response = env.comment("ana", ticket["ticket_id"], body)
    assert response.status_code == 201
    detail = response.json()
    assert detail["comments"][0]["body"] == body
    assert detail["comment_count"] == 1
    assert detail["history"][-1]["action"] == "commented"
    event = env.events("ticket.comment")[-1]
    assert event["chars"] == len(body) and "body" not in event
    assert all("onerror" not in str(e) for e in env.audit.events)


def test_comments_have_limits(env: Env) -> None:
    ticket = env.created("ana")
    assert env.comment("ana", ticket["ticket_id"], "x" * (core.MAX_COMMENT + 1)).status_code == 422
    assert env.comment("ana", ticket["ticket_id"], "  ").status_code == 422
    assert (
        _code(env.comment("ana", ticket["ticket_id"], "AKIAIOSFODNN7EXAMPLE")) == "secret_in_ticket"
    )


def test_a_ticket_takes_a_bounded_number_of_comments(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(core, "MAX_COMMENTS", 2)
    ticket = env.created("ana")
    assert env.comment("ana", ticket["ticket_id"]).status_code == 201
    assert env.comment("ana", ticket["ticket_id"]).status_code == 201
    refused = env.comment("ana", ticket["ticket_id"])
    assert refused.status_code == 409
    assert _code(refused) == "ticket_comment_limit"


def test_writes_count_in_a_limit_per_person(env: Env) -> None:
    for _ in range(30):
        assert env.create("beto").status_code == 201
    refused = env.create("beto")
    assert refused.status_code == 429
    assert env.create("ana").status_code == 201


# --- Por aprobar (D56) -----------------------------------------------------------------------


def _agent_ticket(env: Env, conversation: str = "conv-1") -> Ticket:
    now = core.now_iso()
    ticket = Ticket(
        ticket_id=core.new_ticket_id(),
        title="Crear presupuesto",
        description="",
        status=Status.OPEN,
        priority=Priority.MEDIUM,
        creator_id="ana-1",
        created_at=now,
        updated_at=now,
        source=Source.AGENT,
        agent_id=AGENT,
        people={"ana-1": "ana@empresa.com"},
        conversation_id=conversation,
    )
    env.store.create(ticket)
    return ticket


def test_por_aprobar_comes_from_an_open_approval_of_its_conversation(env: Env) -> None:
    ticket = _agent_ticket(env)
    assert env.get("ana", ticket.ticket_id).json()["status"] == "open"
    env.approvals.records["ana-1"] = [
        approval("other", conversation="conv-2"),
        approval("done1", conversation="conv-1", status="executed"),
        approval("other-agent", conversation="conv-1", agent="other"),
    ]
    assert env.get("ana", ticket.ticket_id).json()["status"] == "open"
    env.approvals.records["ana-1"].append(approval("wait1", conversation="conv-1"))
    shown = env.get("ana", ticket.ticket_id).json()
    assert (shown["status"], shown["approval_id"]) == ("needs_approval", "wait1")
    listed = env.listed("ana", status=["needs_approval"])["items"]
    assert [t["ticket_id"] for t in listed] == [ticket.ticket_id]


def test_a_resolved_ticket_or_a_failed_read_is_never_por_aprobar(env: Env) -> None:
    ticket = _agent_ticket(env)
    env.approvals.records["ana-1"] = [approval("wait1", conversation="conv-1")]
    shown = env.get("ana", ticket.ticket_id).json()
    resolved = env.change("ana", shown, status="done").json()
    assert resolved["status"] == "done" and resolved["approval_id"] is None
    env.approvals.fail = True
    reopened = env.change("ana", resolved, status="open").json()
    assert reopened["status"] == "open"


# --- Cedar --------------------------------------------------------------------------------


def test_the_ticket_policies_decide_like_d112() -> None:
    authz = Authorizer(CedarPolicyStore(), "ps")  # type: ignore[arg-type]
    ana = UserContext("ana-1", None, None, False, groups=frozenset({"finops-central"}))
    carla = UserContext("carla-1", None, None, False, groups=frozenset({"ops"}))
    admin = UserContext("admin-1", None, None, True, groups=frozenset({"mango-admin"}))
    agent = AgentResource(AGENT, groups=frozenset({"finops-central"}))
    ticket = TicketResource("aaaaaaaaaaaa", "beto-1", None, agent)
    for action in ("ViewTicket", "EditTicket", "CommentTicket"):
        assert authz.is_allowed(ana, action, "Mango::Ticket", "aaaaaaaaaaaa", ticket=ticket)
        assert authz.is_allowed(admin, action, "Mango::Ticket", "aaaaaaaaaaaa", ticket=ticket)
        assert not authz.is_allowed(carla, action, "Mango::Ticket", "aaaaaaaaaaaa", ticket=ticket)
    assigned = TicketResource("aaaaaaaaaaaa", "beto-1", "carla-1", None)
    assert authz.is_allowed(carla, "ViewTicket", "Mango::Ticket", "aaaaaaaaaaaa", ticket=assigned)
    # Attributes of another ticket are never used.
    assert not authz.is_allowed(
        carla, "ViewTicket", "Mango::Ticket", "bbbbbbbbbbbb", ticket=assigned
    )
    other = TicketResource("bbbbbbbbbbbb", "beto-1", "carla-1", None)
    batch = authz.allowed_tickets(ana, "ViewTicket", [ticket, other])
    assert batch == frozenset({"aaaaaaaaaaaa"})
