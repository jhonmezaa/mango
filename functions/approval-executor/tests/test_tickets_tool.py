"""The tickets tool in the approval executor (D112 (9)): records of Mango, only with a verified
caller and a verified approval, as the person of the token."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import replace
from typing import Any

import boto3
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from moto import mock_aws

from mango_approval_executor import handler
from mango_core import approval, ticket_tool
from mango_core.tickets import Source, TicketStore

from .test_executor import SETTINGS, _Budgets, _Claims, _ctx, _Sessions, _Verifier

NOW = 1_800_000_000
KEY = ec.generate_private_key(ec.SECP256R1())
CONVERSATION = "c" * 32
APPROVAL_ID = "d" * 32


def _token(tool: str, arguments: dict[str, Any], *, approval_id: str = APPROVAL_ID) -> str:
    claims = approval.encode_claims(
        approval_id=approval_id,
        subject="u-bu",
        tool=tool,
        args_hash=approval.call_hash(tool, arguments),
        agent_id="finops",
        expires_at=NOW + 60,
        conversation_id=CONVERSATION,
    )
    signature = KEY.sign(
        approval.signing_digest(claims), ec.ECDSA(utils.Prehashed(hashes.SHA256()))
    )
    return approval.assemble(claims, signature)


def _table(db: Any) -> None:
    db.create_table(
        TableName="tickets",
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


@pytest.fixture
def runtime(monkeypatch: pytest.MonkeyPatch) -> Iterator[handler.Runtime]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db)
        public = KEY.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        yield handler.Runtime(
            replace(SETTINGS, tickets_table="tickets"),
            verifier=_Verifier(),  # type: ignore[arg-type]
            approvals=lambda: approval.ApprovalVerifier(public, clock=lambda: NOW),
            claim=_Claims(),
            sessions=_Sessions(_Budgets()),  # type: ignore[arg-type]
            tickets=TicketStore(db, "tickets"),
            clock=lambda: NOW,
        )


def _call(
    runtime: handler.Runtime,
    name: str,
    arguments: dict[str, Any],
    *,
    approval_token: str | None = None,
    token: str = "bu-token",
) -> dict[str, Any]:
    tool = f"ops___{name}"
    event = {
        **arguments,
        "_mango_ctx": {"token": token, "approval": approval_token or _token(tool, arguments)},
    }
    return handler.handle(event, _ctx(tool), runtime)


def test_an_approved_call_creates_the_ticket_as_the_person_of_the_token(
    runtime: handler.Runtime,
) -> None:
    result = _call(runtime, "create_ticket", {"title": "Revisar la factura", "priority": "high"})
    assert result["status"] == "ok"
    assert result["ticket_id"] == ticket_tool.ticket_id_for(APPROVAL_ID)
    assert runtime.tickets is not None
    ticket = runtime.tickets.get(result["ticket_id"])
    assert ticket is not None
    assert (ticket.creator_id, ticket.source, ticket.agent_id) == ("u-bu", Source.AGENT, "finops")
    # The conversation comes from the signed approval, never from the model (D112, «Por aprobar»).
    assert ticket.conversation_id == CONVERSATION
    assert "description" not in result


def test_a_call_without_a_valid_approval_writes_nothing(runtime: handler.Runtime) -> None:
    args = {"title": "Sin aprobación"}
    other = _token("ops___create_ticket", {"title": "otro"})
    result = _call(runtime, "create_ticket", args, approval_token=other)
    assert result["error"]["code"] == "approval_required"
    assert runtime.tickets is not None
    assert runtime.tickets.get(ticket_tool.ticket_id_for(APPROVAL_ID)) is None


def test_the_model_cannot_name_the_creator_nor_the_conversation(runtime: handler.Runtime) -> None:
    result = _call(runtime, "create_ticket", {"title": "x", "creator_id": "u-central"})
    assert result["error"]["code"] == "invalid_arguments"
    result = _call(runtime, "create_ticket", {"title": "x", "conversation_id": "e" * 32})
    assert result["error"]["code"] == "invalid_arguments"


def test_update_and_comment_apply_to_an_existing_ticket(runtime: handler.Runtime) -> None:
    created = _call(runtime, "create_ticket", {"title": "Ticket"})
    ticket_id = created["ticket_id"]
    updated = _call(
        runtime,
        "update_ticket",
        {"ticket_id": ticket_id, "status": "in_progress", "assign_to_me": True},
        approval_token=_token(
            "ops___update_ticket",
            {"ticket_id": ticket_id, "status": "in_progress", "assign_to_me": True},
            approval_id="e" * 32,
        ),
    )
    assert updated["ticket_status"] == "in_progress"
    commented = _call(
        runtime,
        "comment_ticket",
        {"ticket_id": ticket_id, "body": "Hecho"},
        approval_token=_token(
            "ops___comment_ticket", {"ticket_id": ticket_id, "body": "Hecho"}, approval_id="f" * 32
        ),
    )
    assert commented["status"] == "ok"
    assert runtime.tickets is not None
    ticket = runtime.tickets.get(ticket_id)
    assert ticket is not None
    assert (ticket.assignee_id, ticket.comment_count) == ("u-bu", 1)


def test_a_missing_ticket_is_an_error_without_details(runtime: handler.Runtime) -> None:
    result = _call(runtime, "comment_ticket", {"ticket_id": "a" * 12, "body": "hola"})
    assert result["error"]["code"] == "ticket_not_found"


def test_without_the_table_the_tool_is_unavailable(runtime: handler.Runtime) -> None:
    runtime.tickets = None
    result = _call(runtime, "create_ticket", {"title": "x"})
    assert result["error"]["code"] == "unavailable"
