"""The tickets tool of the Gateway as mango-api governs it (D112 (8), (9)): born
self-confirmed, decided with Cedar when the request is created and again when it is
confirmed, and audited as ``ticket.*`` once it ran."""

from __future__ import annotations

import dataclasses
import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import boto3
import pytest
from moto import mock_aws
from pydantic import ValidationError

from mango_api import app as app_module
from mango_api import approvals as approvals_module
from mango_api.approval_policy import Condition, Tier
from mango_api.approvals import ApprovalDeps
from mango_api.approvals_store import ApprovalStore
from mango_api.authz import Authorizer
from mango_api.mcp_catalog import ConnectorManifest, McpCatalog
from mango_api.published import PublishedAgent
from mango_api.tickets import TicketsDeps, TicketToolGate
from mango_api.tool_policies import PolicyStore, default_policy
from mango_api.web import ApiError, Caller
from mango_core import ticket_tool
from mango_core import tickets as core
from mango_core.identity import UserContext
from mango_core.tickets import Priority, Status, Ticket, TicketStore

from .cedar_fake import CedarPolicyStore
from .test_admin import RecordingAudit, _table
from .test_app import FakePublished, served
from .test_approvals import CONNECTORS, FakeExecutor, _approvals_table
from .test_tickets import create_tickets_table

ANA = UserContext("ana-1", None, None, False, email="ana@empresa.com", groups=frozenset({"ops"}))
BETO = UserContext("beto-1", None, None, False, groups=frozenset({"ops"}))
CONVERSATION = "c" * 32
TOOLS = {name: f"{ticket_tool.SERVER_ID}.{name}" for name in ticket_tool.TOOLS}
GATEWAY = {name: f"ops___{name}" for name in ticket_tool.TOOLS}


def tickets_agent() -> PublishedAgent:
    refs = tuple(TOOLS.values())
    agent = served("helper", tools=refs, approval_tools=list(refs), groups=["ops"])
    return dataclasses.replace(
        agent,
        gateway_tools=tuple(GATEWAY.values()),
        write_tools=tuple((GATEWAY[n], TOOLS[n]) for n in ticket_tool.TOOLS),
    )


@dataclass
class Env:
    deps: ApprovalDeps
    tickets: TicketStore
    audit: RecordingAudit
    executor: FakeExecutor

    def request(self, user: UserContext, name: str, arguments: dict[str, Any]) -> Any:
        call = approvals_module.WriteCall(GATEWAY[name], json.dumps(arguments))
        return approvals_module.request_call(
            self.deps, user, tickets_agent(), CONVERSATION, call=call, seen=set()
        )

    def ticket(self, creator: str = "ana-1") -> Ticket:
        now = core.now_iso()
        ticket = Ticket(
            ticket_id=core.new_ticket_id(),
            title="Ticket",
            description="",
            status=Status.OPEN,
            priority=Priority.MEDIUM,
            creator_id=creator,
            created_at=now,
            updated_at=now,
            people={creator: None},
        )
        self.tickets.create(ticket)
        return ticket


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    catalog = McpCatalog.load(CONNECTORS)
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "settings")
        _approvals_table(db, "approvals")
        create_tickets_table(db, "tickets")
        audit = RecordingAudit()
        authorizer = Authorizer(CedarPolicyStore(), "ps")  # type: ignore[arg-type]
        published = FakePublished(agents={"helper": tickets_agent()})
        tickets = TicketStore(db, "tickets")
        tickets_deps = TicketsDeps(
            store=tickets,
            published=published,  # type: ignore[arg-type]
            audit=audit,  # type: ignore[arg-type]
            creates=app_module.Limits().limiter("tickets.creates"),
            changes=app_module.Limits().limiter("tickets.changes"),
            comments=app_module.Limits().limiter("tickets.comments"),
        )

        def decide(user: UserContext, action: str, kind: str, rid: str, ticket: Any) -> bool:
            return authorizer.is_allowed(user, action, kind, rid, ticket=ticket)

        executor = FakeExecutor()
        deps = ApprovalDeps(
            store=ApprovalStore(db, "approvals"),
            policies=PolicyStore(db, "settings"),
            catalog=lambda: catalog,
            published=published,  # type: ignore[arg-type]
            audit=audit,  # type: ignore[arg-type]
            clock=lambda: datetime(2026, 11, 5, 12, tzinfo=UTC),
            executor=executor,
            gate=TicketToolGate(tickets_deps, decide),
        )
        yield Env(deps, tickets, audit, executor)


def test_the_catalog_ships_the_tickets_connector_born_self_confirmed() -> None:
    catalog = McpCatalog.load(CONNECTORS)
    for ref in TOOLS.values():
        tool = catalog.tool(ref)
        assert tool is not None and tool.is_write
        assert default_policy(tool).condition is Condition.SELF
    budgets = catalog.tool("aws-budgets.create_budget")
    assert budgets is not None and default_policy(budgets).condition is Condition.ALWAYS


def test_only_a_connector_without_iam_is_born_self_confirmed() -> None:
    manifest = json.loads((CONNECTORS / "mango-tickets" / "manifest.json").read_text())
    manifest["iam"] = [{"actions": ["budgets:ModifyBudget"], "resources": ["*"]}]
    with pytest.raises(ValidationError):
        ConnectorManifest.model_validate(manifest)


def test_a_new_ticket_is_asked_for_confirmation_of_the_person(env: Env) -> None:
    made = env.request(ANA, "create_ticket", {"title": "Revisar EC2", "priority": "high"})
    assert made is not None
    assert (made.tier, made.approvals_needed, made.rule["condition"]) == (Tier.SELF, 0, "self")


def test_a_ticket_the_person_cannot_see_or_change_is_never_asked(env: Env) -> None:
    hidden = env.ticket(creator="beto-1")
    assert (
        env.request(ANA, "update_ticket", {"ticket_id": hidden.ticket_id, "status": "done"}) is None
    )
    assert env.request(ANA, "comment_ticket", {"ticket_id": "a" * 12, "body": "hola"}) is None
    assert env.request(ANA, "create_ticket", {"title": "x", "creator_id": "beto-1"}) is None
    assert env.request(ANA, "create_ticket", {"title": "AKIAIOSFODNN7EXAMPLE"}) is None
    own = env.ticket(creator="ana-1")
    assert (
        env.request(ANA, "comment_ticket", {"ticket_id": own.ticket_id, "body": "ok"}) is not None
    )


def test_a_confirmation_never_runs_what_the_person_may_no_longer_do(env: Env) -> None:
    ticket = env.ticket(creator="ana-1")
    made = env.request(ANA, "update_ticket", {"ticket_id": ticket.ticket_id, "status": "done"})
    assert made is not None
    # The ticket is reassigned to another creator meanwhile: Ana no longer sees it.
    env.tickets._db.update_item(  # type: ignore[attr-defined]
        TableName="tickets",
        Key={"PK": {"S": f"TICKET#{ticket.ticket_id}"}, "SK": {"S": "META"}},
        UpdateExpression="SET creator_id = :b",
        ExpressionAttributeValues={":b": {"S": "beto-1"}},
    )
    caller = Caller(user=ANA, token="t", expires_at=4_000_000_000)
    with pytest.raises(ApiError) as refused:
        approvals_module.confirm(env.deps, caller, made.approval_id)
    assert refused.value.code == "ticket_not_found"
    assert env.executor.calls == []


def test_an_executed_call_is_audited_as_a_ticket_event_without_its_texts(env: Env) -> None:
    made = env.request(ANA, "create_ticket", {"title": "Factura secreta", "description": "texto"})
    assert made is not None
    caller = Caller(user=ANA, token="t", expires_at=4_000_000_000)
    approvals_module.confirm(env.deps, caller, made.approval_id)
    ((call, _token),) = env.executor.calls
    assert call.conversation_id == CONVERSATION
    events = [d for e, _u, d in env.audit.events if e == "ticket.create"]
    assert events == [
        {
            "agent": "helper",
            "source": "agent",
            "approval_id": made.approval_id,
            "conversation_id": CONVERSATION,
            "outcome": "applied",
            "ticket_id": ticket_tool.ticket_id_for(made.approval_id),
            "priority": "medium",
            "title_chars": len("Factura secreta"),
            "description_chars": len("texto"),
        }
    ]
    assert all("secreta" not in str(e) for e in env.audit.events)


def test_the_tool_arguments_are_closed() -> None:
    with pytest.raises(ValidationError):
        ticket_tool.parse(ticket_tool.UPDATE, {"ticket_id": "a" * 12, "assignee_id": "beto-1"})
    with pytest.raises(ValidationError):
        ticket_tool.parse(ticket_tool.UPDATE, {"ticket_id": "a" * 12, "status": "needs_approval"})
    assert ticket_tool.ticket_id_for("a" * 32) == ticket_tool.ticket_id_for("a" * 32)
    assert ticket_tool.ticket_id_for("a" * 32) != ticket_tool.ticket_id_for("b" * 32)
    assert BETO.user_id != ANA.user_id
