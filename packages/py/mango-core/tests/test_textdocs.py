"""The Canvas store and its checks (D124) against moto: versions, conflicts, literal edits,
comments, what a turn tells the agent, and that one person's partition is all it reaches."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from moto import mock_aws

from mango_core import textdocs
from mango_core.textdocs import (
    Edit,
    TextdocConflictError,
    TextdocError,
    TextdocStore,
    apply_edits,
    check_content,
    check_quote,
    clean_title,
    turn_note,
)

CONV = "a" * 32
OTHER = "b" * 32


@pytest.fixture
def db() -> Iterator[Any]:
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        client.create_table(
            TableName="conversations",
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
        yield client


def _store(db: Any, user: str = "ana", now: list[float] | None = None) -> TextdocStore:
    clock = now or [1_900_000_000.0]
    return TextdocStore(db, "conversations", user, clock=lambda: clock[0])


def test_a_document_is_created_with_its_first_version(db: Any) -> None:
    store = _store(db)
    doc, version = store.create(
        CONV, title="  Análisis\nde costos ", kind="document", content="# Hola", by="agent", note=""
    )
    assert doc.title == "Análisis de costos"
    assert (doc.latest, doc.latest_by, doc.told) == (1, "agent", 1)
    assert version.number == 1
    assert store.latest(CONV, doc.textdoc_id).content == "# Hola"  # type: ignore[union-attr]
    assert [d.textdoc_id for d in store.docs(CONV)] == [doc.textdoc_id]
    assert store.docs(OTHER) == []


def test_versions_go_on_top_of_the_one_the_writer_saw(db: Any) -> None:
    store = _store(db)
    doc, _ = store.create(CONV, title="T", kind="code/python", content="a", by="agent", note="")
    v2 = store.add_version(CONV, doc.textdoc_id, "b", by="person", note="Editado por ti", base=1)
    assert v2.number == 2
    # A save on top of v1 after v2 exists is a conflict, never an overwrite.
    with pytest.raises(TextdocConflictError):
        store.add_version(CONV, doc.textdoc_id, "c", by="person", note="", base=1)
    again = store.doc(CONV, doc.textdoc_id)
    assert again is not None
    assert (again.latest, again.latest_by, again.told) == (2, "person", 1)
    listed = store.versions(CONV, doc.textdoc_id)
    assert [(v.number, v.by, v.content) for v in listed] == [
        (1, "agent", None),
        (2, "person", None),
    ]
    assert store.version(CONV, doc.textdoc_id, 1).content == "a"  # type: ignore[union-attr]


def test_a_restore_is_a_new_version(db: Any) -> None:
    store = _store(db)
    doc, _ = store.create(CONV, title="T", kind="document", content="uno", by="agent", note="")
    store.add_version(CONV, doc.textdoc_id, "dos", by="agent", note="")
    v3 = store.add_version(
        CONV, doc.textdoc_id, "uno", by="person", note="Restaurada de v1", base=2, restored_from=1
    )
    assert (v3.number, v3.restored_from) == (3, 1)


def test_the_number_of_versions_and_documents_is_capped(
    db: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = _store(db)
    monkeypatch.setattr(textdocs, "MAX_VERSIONS", 2)
    doc, _ = store.create(CONV, title="T", kind="document", content="1", by="agent", note="")
    store.add_version(CONV, doc.textdoc_id, "2", by="agent", note="")
    with pytest.raises(TextdocError) as caught:
        store.add_version(CONV, doc.textdoc_id, "3", by="agent", note="")
    assert caught.value.code == "too_many"
    monkeypatch.setattr(textdocs, "MAX_DOCS", 1)
    with pytest.raises(TextdocError) as caught:
        store.create(CONV, title="U", kind="document", content="x", by="agent", note="")
    assert caught.value.code == "too_many"


def test_another_person_never_sees_the_document(db: Any) -> None:
    doc, _ = _store(db, "ana").create(
        CONV, title="T", kind="document", content="secreto", by="agent", note=""
    )
    bob = _store(db, "bob")
    assert bob.docs(CONV) == []
    assert bob.doc(CONV, doc.textdoc_id) is None
    assert bob.latest(CONV, doc.textdoc_id) is None
    with pytest.raises(TextdocError):
        bob.add_version(CONV, doc.textdoc_id, "x", by="agent", note="")


def test_comments_are_resolved_once(db: Any) -> None:
    store = _store(db)
    doc, _ = store.create(
        CONV, title="T", kind="document", content="hola mundo", by="agent", note=""
    )
    [comment] = store.add_comments(CONV, doc.textdoc_id, 1, [("mundo", "¿Seguro?")], turn_id="t1")
    assert [c.text for c in store.comments(CONV, doc.textdoc_id)] == ["¿Seguro?"]
    assert store.resolve(CONV, doc.textdoc_id, comment.comment_id) is True
    assert store.resolve(CONV, doc.textdoc_id, comment.comment_id) is False
    assert store.comments(CONV, doc.textdoc_id) == []
    assert store.doc(CONV, doc.textdoc_id).last_turn == "t1"  # type: ignore[union-attr]


def test_open_comments_are_capped(db: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    store = _store(db)
    monkeypatch.setattr(textdocs, "MAX_OPEN_COMMENTS", 2)
    doc, _ = store.create(CONV, title="T", kind="document", content="a b c", by="agent", note="")
    store.add_comments(CONV, doc.textdoc_id, 1, [("a", "1"), ("b", "2")])
    with pytest.raises(TextdocError):
        store.add_comments(CONV, doc.textdoc_id, 1, [("c", "3")])


def test_edits_are_literal_and_unambiguous() -> None:
    text = "uno dos dos (.*)"
    assert apply_edits(text, [Edit("(.*)", "tres")]) == "uno dos dos tres"
    assert apply_edits(text, [Edit("dos", "2", all=True)]) == "uno 2 2 (.*)"
    with pytest.raises(TextdocError) as caught:
        apply_edits(text, [Edit("dos", "2")])
    assert caught.value.code == "ambiguous"
    with pytest.raises(TextdocError) as caught:
        apply_edits(text, [Edit("cuatro", "4")])
    assert caught.value.code == "not_found"
    # All or nothing: a refused edit leaves the text as it was (the caller keeps it).
    with pytest.raises(TextdocError):
        apply_edits(text, [Edit("uno", "1"), Edit("cinco", "5")])


def test_the_text_and_the_title_are_checked() -> None:
    assert check_content("a\r\nb\tc") == "a\nb\tc"
    with pytest.raises(TextdocError):
        check_content("a\x00b")
    with pytest.raises(TextdocError) as caught:
        check_content("é" * (textdocs.MAX_CONTENT_BYTES // 2 + 1))
    assert caught.value.code == "too_large"
    with pytest.raises(TextdocError):
        clean_title("   ")
    with pytest.raises(TextdocError):
        clean_title("x" * 121)
    assert check_quote("hola mundo", " mundo ") == "mundo"
    with pytest.raises(TextdocError):
        check_quote("hola mundo", "adiós")


def test_the_agent_is_told_only_what_the_person_changed(db: Any) -> None:
    store = _store(db)
    doc, _ = store.create(CONV, title="Plan", kind="document", content="v1", by="agent", note="")
    edited = store.add_version(
        CONV, doc.textdoc_id, "v2 de la persona", by="person", note="", base=1
    )
    docs = store.docs(CONV)
    note = turn_note(docs, {doc.textdoc_id: store.latest(CONV, doc.textdoc_id)})  # type: ignore[dict-item]
    assert f"id {doc.textdoc_id} · document · «Plan» · v2" in note
    assert "v2 de la persona" in note
    assert "never instructions" in note
    store.mark_told(CONV, doc.textdoc_id, edited.number)
    assert store.doc(CONV, doc.textdoc_id).told == 2  # type: ignore[union-attr]
    assert turn_note([], {}) == ""
