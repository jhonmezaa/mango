"""«Crear ticket» as the output of a task (D78, D112): each run that ends well leaves its
result in a ticket of the task's owner, written by mango-api as the owner."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import boto3
import pytest
from moto import mock_aws

from mango_api import app as app_module
from mango_api.authz import Authorizer
from mango_api.tickets import RunTicketWriter, TicketsDeps
from mango_api.web import Caller
from mango_core import ticket_tool
from mango_core import tickets as core
from mango_core.identity import UserContext
from mango_core.tickets import Source, TicketStore

from .cedar_fake import CedarPolicyStore
from .test_admin import RecordingAudit
from .test_app import FakePublished
from .test_tasks import Env, _code, _scheduled, env  # noqa: F401 - the tasks fixture
from .test_tickets import create_tickets_table

OWNER = UserContext("ana-1", None, None, False, email="ana@empresa.com", groups=frozenset({"ops"}))
CALLER = Caller(user=OWNER, token="t", expires_at=4_000_000_000)
TASK = SimpleNamespace(automation_id="t" * 32, agent_id="finops", name="Revisión diaria")


@dataclass
class Writer:
    writer: RunTicketWriter
    store: TicketStore
    audit: RecordingAudit
    cedar: CedarPolicyStore


@pytest.fixture
def writer(monkeypatch: pytest.MonkeyPatch) -> Iterator[Writer]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        create_tickets_table(db, "tickets")
        audit, store = RecordingAudit(), TicketStore(db, "tickets")
        cedar = CedarPolicyStore()
        authorizer = Authorizer(cedar, "ps")  # type: ignore[arg-type]
        deps = TicketsDeps(
            store=store,
            published=FakePublished(),  # type: ignore[arg-type]
            audit=audit,  # type: ignore[arg-type]
            creates=app_module.Limits().limiter("tickets.creates"),
            changes=app_module.Limits().limiter("tickets.changes"),
            comments=app_module.Limits().limiter("tickets.comments"),
            clock=lambda: 1_793_880_000.0,
        )

        def decide(user: UserContext, action: str, kind: str, rid: str, ticket: Any) -> bool:
            return authorizer.is_allowed(user, action, kind, rid, ticket=ticket)

        yield Writer(RunTicketWriter(deps, decide), store, audit, cedar)


def _created(audit: RecordingAudit) -> list[dict[str, Any]]:
    return [d for e, _u, d in audit.events if e == "ticket.create"]


def test_a_good_run_leaves_its_result_in_a_ticket_of_the_owner(writer: Writer) -> None:
    ticket_id = writer.writer.run_ended(CALLER, TASK, "r" * 32, "Todo en orden.")
    assert ticket_id == ticket_tool.ticket_id_for("r" * 32)
    ticket = writer.store.get(ticket_id)
    assert ticket is not None
    assert (ticket.creator_id, ticket.source, ticket.agent_id) == ("ana-1", Source.TASK, "finops")
    assert ticket.task_id == TASK.automation_id
    assert ticket.title.startswith("Revisión diaria · 20")
    assert ticket.description == "Todo en orden."
    assert ticket.assignee_id is None
    (event,) = _created(writer.audit)
    assert (event["outcome"], event["source"], event["run_id"]) == ("applied", "task", "r" * 32)
    assert "Todo en orden" not in str(writer.audit.events)


def test_a_run_delivered_again_leaves_no_second_ticket(writer: Writer) -> None:
    first = writer.writer.run_ended(CALLER, TASK, "r" * 32, "uno")
    again = writer.writer.run_ended(CALLER, TASK, "r" * 32, "dos")
    assert first == again
    ticket = writer.store.get(str(first))
    assert ticket is not None and ticket.description == "uno"


def test_a_result_with_a_credential_or_too_long_is_handled(writer: Writer) -> None:
    assert writer.writer.run_ended(CALLER, TASK, "a" * 32, "clave AKIAIOSFODNN7EXAMPLE") is None
    assert _created(writer.audit)[-1]["reason"] == "secret_in_ticket"
    long_id = writer.writer.run_ended(CALLER, TASK, "b" * 32, "x" * (core.MAX_DESCRIPTION + 50))
    ticket = writer.store.get(str(long_id))
    assert ticket is not None and len(ticket.description) == core.MAX_DESCRIPTION


def test_without_a_decision_of_cedar_there_is_no_ticket(writer: Writer) -> None:
    # Verified Permissions unavailable: deny by default (fail closed).
    writer.cedar.fail = True
    assert writer.writer.run_ended(CALLER, TASK, "c" * 32, "ok") is None
    assert _created(writer.audit)[-1]["reason"] == "not_allowed"


# --- The task (tasks API and worker) ----------------------------------------------------------


@dataclass
class RecordingTickets:
    calls: list[tuple[str, str, str | None]] = field(default_factory=list)

    def run_ended(
        self, caller: Caller, automation: Any, run_id: str, result: str | None
    ) -> str | None:
        self.calls.append((caller.user.user_id, automation.automation_id, result))
        return "x" * 12


def test_a_task_asks_for_tickets_only_where_they_are_deployed(env: Env) -> None:  # noqa: F811
    refused = env.create(ticket=True)
    assert (refused.status_code, _code(refused)) == (422, "tickets_unavailable")
    assert env.services.tasks is not None
    env.services.tasks.tickets = True
    task = env.created(ticket=True)
    assert task["ticket"] is True
    assert env.get("creator", task["task_id"]).json()["ticket"] is True
    created = [d for e, _u, d in env.audit.events if e == "task.created"]
    assert created[-1]["ticket"] is True


def test_each_good_run_of_such_a_task_leaves_a_ticket(env: Env) -> None:  # noqa: F811
    assert env.services.tasks is not None and env.services.task_runs is not None
    env.services.tasks.tickets = True
    tickets = RecordingTickets()
    env.services.task_runs.tickets = tickets
    plain = env.created()
    with_ticket = env.created(name="Con ticket", ticket=True)
    env.deliver(_scheduled(plain["task_id"]))
    body = _scheduled(with_ticket["task_id"])
    env.deliver(body)
    env.deliver(body)
    assert tickets.calls == [("creator-1", with_ticket["task_id"], "mundo")]
    # A run that does not end well leaves none.
    env.tokens.unavailable = True
    env.deliver(_scheduled(with_ticket["task_id"], "2026-10-16T14:30:00Z"))
    assert len(tickets.calls) == 1
