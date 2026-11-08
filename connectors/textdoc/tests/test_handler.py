"""The Canvas tools against moto (DynamoDB): identity from the signature, one conversation,
literal edits, comments, audit without content, the rate limit (D124; TM-CV1, CV2, CV5)."""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import boto3
import pytest
from moto import mock_aws

from mango_core.identity import IdentityError
from mango_core.rate_limits import RateLimitStore, SharedRateLimiter
from mango_core.textdocs import TextdocStore
from mango_textdoc.audit import AuditWriter
from mango_textdoc.handler import (
    CALLS_PER_MINUTE,
    RESERVED_CONTEXT_ARG,
    Deps,
    RlsClients,
    Settings,
    handle,
)

REGION = "us-east-1"
CONV = "c" * 32
OTHER_CONV = "d" * 32
TURN = "e" * 32
USERS = {
    "token-ana": {"sub": "user-ana", "cognito:groups": ["ventas"]},
    "token-bob": {"sub": "user-bob", "cognito:groups": ["ventas"]},
}


@dataclass
class World:
    deps: Deps
    db: Any
    records: list[dict[str, Any]]


def _verify(token: str) -> dict[str, Any]:
    if token not in USERS:
        raise IdentityError("bad token")
    return USERS[token]


def _table(db: Any, name: str) -> None:
    db.create_table(
        TableName=name,
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
def world() -> Iterator[World]:
    with mock_aws():
        db = boto3.client("dynamodb", region_name=REGION)
        for name in ("conversations", "rate-limits", "audit-index"):
            _table(db, name)
        records: list[dict[str, Any]] = []
        firehose = SimpleNamespace(put_record=lambda **kw: records.append(kw))
        settings = Settings(
            issuer="https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example",
            client_id="web",
            conversations_table="conversations",
            conversations_table_arn="arn:aws:dynamodb:us-east-1:111122223333:table/conversations",
            data_key_arn="arn:aws:kms:us-east-1:111122223333:key/data",
            data_role_arn="arn:aws:iam::111122223333:role/Mango-poc-ConversationData",
            rate_limits_table="rate-limits",
            audit_stream="audit",
            audit_index_table="audit-index",
            region=REGION,
        )
        deps = Deps(
            settings=settings,
            verify=_verify,
            store_for=lambda sub: TextdocStore(db, "conversations", sub),
            calls=SharedRateLimiter(
                RateLimitStore(db, "rate-limits"), "textdoc.write", CALLS_PER_MINUTE, 60
            ),
            audit=AuditWriter(firehose, "audit", db, "audit-index"),
        )
        yield World(deps, db, records)


def _ctx(**over: Any) -> dict[str, Any]:
    return {
        "token": "token-ana",
        "subject": "user-ana",
        "agent_id": "finops",
        "agent_version": 3,
        "conversation_id": CONV,
        "turn_id": TURN,
        **over,
    }


def _call(
    world: World, tool: str, args: dict[str, Any], ctx: dict[str, Any] | None = None
) -> dict[str, Any]:
    context = SimpleNamespace(
        client_context=SimpleNamespace(custom={"bedrockAgentCoreToolName": f"textdoc___{tool}"})
    )
    return handle({**args, RESERVED_CONTEXT_ARG: ctx or _ctx()}, context, world.deps)


def _create(world: World, **over: Any) -> str:
    result = _call(
        world,
        "create",
        {"title": "Análisis", "kind": "document", "content": "## Resumen\n\nGasto alto.", **over},
    )
    assert "text" in result, result
    doc_id = str(result["text"]).split("(id ", 1)[1].split(",", 1)[0]
    return doc_id


def _store(world: World, user: str = "user-ana") -> TextdocStore:
    return TextdocStore(world.db, "conversations", user)


def _audits(world: World) -> list[dict[str, Any]]:
    return [json.loads(r["Record"]["Data"]) for r in world.records]


def test_create_writes_the_first_version_in_the_signed_conversation(world: World) -> None:
    doc_id = _create(world)
    [doc] = _store(world).docs(CONV)
    assert (doc.textdoc_id, doc.kind, doc.latest, doc.last_turn) == (doc_id, "document", 1, TURN)
    assert _store(world).docs(OTHER_CONV) == []
    [audit] = _audits(world)
    assert audit["event"] == "textdoc.write"
    assert audit["detail"]["tool"] == "create"
    assert audit["detail"]["conversation_id"] == CONV
    # Never the title nor the text.
    assert "Análisis" not in json.dumps(audit)
    assert "Gasto" not in json.dumps(audit)


def test_update_takes_literal_edits_or_a_whole_text(world: World) -> None:
    doc_id = _create(world)
    edited = _call(
        world,
        "update",
        {
            "textdoc_id": doc_id,
            "edits": [{"find": "Gasto alto.", "replace": "Gasto de USD 124.530."}],
            "note": "Puso la cifra",
        },
    )
    assert "Wrote v2" in edited["text"]
    latest = _store(world).latest(CONV, doc_id)
    assert latest is not None
    assert latest.content == "## Resumen\n\nGasto de USD 124.530."
    assert latest.note == "Puso la cifra"
    whole = _call(world, "update", {"textdoc_id": doc_id, "content": "otro"})
    assert "Wrote v3" in whole["text"]
    # Neither, or both: refused.
    assert _call(world, "update", {"textdoc_id": doc_id})["error"]["code"] == "invalid_arguments"
    both = _call(
        world,
        "update",
        {"textdoc_id": doc_id, "content": "x", "edits": [{"find": "o", "replace": "a"}]},
    )
    assert both["error"]["code"] == "invalid_arguments"


def test_an_edit_that_does_not_match_changes_nothing(world: World) -> None:
    doc_id = _create(world)
    missing = _call(
        world, "update", {"textdoc_id": doc_id, "edits": [{"find": "(.*)", "replace": "x"}]}
    )
    assert missing["error"]["code"] == "not_found"
    unchanged = _call(
        world, "update", {"textdoc_id": doc_id, "content": "## Resumen\n\nGasto alto."}
    )
    assert unchanged["error"]["code"] == "unchanged"
    assert _store(world).doc(CONV, doc_id).latest == 1  # type: ignore[union-attr]


def test_a_document_of_another_conversation_or_person_is_not_found(world: World) -> None:
    doc_id = _create(world)
    other_conv = _call(
        world, "update", {"textdoc_id": doc_id, "content": "x"}, _ctx(conversation_id=OTHER_CONV)
    )
    assert other_conv["error"]["code"] == "not_found"
    bob = _call(
        world,
        "comment",
        {"textdoc_id": doc_id, "comments": [{"quote": "Gasto", "text": "?"}]},
        _ctx(token="token-bob", subject="user-bob"),
    )
    assert bob["error"]["code"] == "not_found"


def test_comments_quote_the_latest_version(world: World) -> None:
    doc_id = _create(world)
    ok = _call(
        world,
        "comment",
        {"textdoc_id": doc_id, "comments": [{"quote": "Gasto alto", "text": "¿Contra qué mes?"}]},
    )
    assert "Added 1 comment" in ok["text"]
    [comment] = _store(world).comments(CONV, doc_id)
    assert (comment.quote, comment.text, comment.version) == ("Gasto alto", "¿Contra qué mes?", 1)
    missing = _call(
        world, "comment", {"textdoc_id": doc_id, "comments": [{"quote": "nada", "text": "x"}]}
    )
    assert missing["error"]["code"] == "not_found"
    assert "¿Contra" not in json.dumps(_audits(world))


def test_the_caller_is_the_one_mango_api_signed(world: World) -> None:
    args = {"title": "T", "kind": "document", "content": "x"}
    assert _call(world, "create", args, _ctx(subject="user-bob"))["error"]["code"] == (
        "unauthenticated"
    )
    assert _call(world, "create", args, _ctx(token="forged"))["error"]["code"] == "unauthenticated"
    no_conv = {k: v for k, v in _ctx().items() if k != "conversation_id"}
    assert _call(world, "create", args, no_conv)["error"]["code"] == "unauthenticated"
    playground = _call(world, "create", args, _ctx(playground=True))
    assert playground["error"]["code"] == "unavailable"
    unknown = handle(
        {**args, RESERVED_CONTEXT_ARG: _ctx()},
        SimpleNamespace(
            client_context=SimpleNamespace(custom={"bedrockAgentCoreToolName": "textdoc___delete"})
        ),
        world.deps,
    )
    assert unknown["error"]["code"] == "unknown_tool"


def test_the_kind_and_the_size_are_checked(world: World) -> None:
    bad_kind = _call(world, "create", {"title": "T", "kind": "code/java", "content": "x"})
    assert bad_kind["error"]["code"] == "invalid_arguments"
    control = _call(world, "create", {"title": "T", "kind": "document", "content": "a\x00b"})
    assert control["error"]["code"] == "invalid_content"
    extra = _call(world, "create", {"title": "T", "kind": "document", "content": "x", "y": 1})
    assert extra["error"]["code"] == "invalid_arguments"


def test_calls_are_limited_per_person(world: World) -> None:
    args = {"title": "T", "kind": "document", "content": "x"}
    for _ in range(CALLS_PER_MINUTE):
        _call(
            world,
            "comment",
            {"textdoc_id": "01J0000000000000000000000X", "comments": [{"quote": "q", "text": "t"}]},
        )
    assert _call(world, "create", args)["error"]["code"] == "rate_limited"


def test_nothing_of_the_document_is_logged(world: World, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO)
    _create(world, content="dato-secreto-del-texto", title="titulo-secreto")
    logged = "\n".join(r.getMessage() for r in caplog.records if r.name == "root")
    assert "tool.call" in logged
    assert "secreto" not in logged


def test_the_session_policy_reaches_one_partition() -> None:
    rls = RlsClients(None, "role", "arn:table", "arn:key", REGION)
    policy = json.loads(rls.policy("user-ana"))
    [rows, _key] = policy["Statement"]
    assert rows["Condition"] == {
        "ForAllValues:StringEquals": {"dynamodb:LeadingKeys": ["USER#user-ana"]}
    }
    assert "dynamodb:DeleteItem" not in rows["Action"]


def test_the_tool_schema_names_the_tools_of_the_target() -> None:
    from pathlib import Path  # noqa: PLC0415

    from mango_core.harness_tools import TEXTDOC_TOOLS  # noqa: PLC0415

    schema = json.loads((Path(__file__).parents[1] / "tool-schema.json").read_text())
    assert tuple(t["name"] for t in schema) == TEXTDOC_TOOLS
    kinds = schema[0]["inputSchema"]["properties"]["kind"]["enum"]
    from mango_core.textdocs import KINDS  # noqa: PLC0415

    assert tuple(kinds) == KINDS
