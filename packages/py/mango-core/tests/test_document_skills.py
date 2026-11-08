"""The document skills of the release (D119): their texts, where they live and how they are
written (never replacing one)."""

from __future__ import annotations

import json
import re
from typing import Any

import pytest
from botocore.exceptions import ClientError

from mango_core import chat_files, document_skills
from mango_core.skills import (
    BUCKET_PREFIX,
    MAX_INSTRUCTIONS_CHARS,
    SKILL_ID_PATTERN,
    is_skill_id,
)


def _frontmatter(text: str) -> dict[str, str]:
    head = text.split("---\n", 2)[1]
    pairs = (line.partition(":") for line in head.splitlines() if not line.startswith(" "))
    return {key: value.strip() for key, _, value in pairs}


@pytest.mark.parametrize("skill_id", document_skills.IDS)
def test_each_text_is_a_valid_skill_named_as_its_folder(skill_id: str) -> None:
    text = document_skills.text(skill_id)
    meta = _frontmatter(text)
    assert meta["name"] == skill_id
    assert is_skill_id(skill_id)
    # A JSON string: YAML reads it as a double-quoted scalar (as mango_core.skills.render).
    description = json.loads(meta["description"])
    assert 40 <= len(description) <= 300
    body = text.split("---\n", 2)[2]
    assert len(body) <= MAX_INSTRUCTIONS_CHARS
    # The loop and the closed list of outputs (D119 (1), (3)).
    assert "render" in body
    handing = body.split("## Handing it out", 1)[1]
    assert "HTML" in handing
    assert "executables" in handing
    assert "\r" not in text


def test_the_texts_hand_out_only_kinds_of_the_chat() -> None:
    assert set(document_skills.OUTPUT_EXTENSIONS) <= set(chat_files.TYPES)
    for extension in ("html", "svg", "docm", "xlsm", "pptm", "exe"):
        assert extension not in chat_files.TYPES


def test_the_folder_cannot_be_a_skill_of_a_creator() -> None:
    assert document_skills.RELEASE_PREFIX.startswith(BUCKET_PREFIX)
    folder = document_skills.RELEASE_PREFIX.removeprefix(BUCKET_PREFIX).rstrip("/")
    assert not re.fullmatch(SKILL_ID_PATTERN, folder)


def test_the_key_names_the_text_it_holds() -> None:
    key = document_skills.object_key("xlsx")
    assert re.fullmatch(r"skills/_release/xlsx/[0-9a-f]{16}/xlsx/SKILL\.md", key)
    assert document_skills.s3_uri("bucket", "xlsx") == f"s3://bucket/{key.removesuffix('SKILL.md')}"
    assert [s["s3"]["uri"].split("/")[5] for s in document_skills.sources("b")] == list(
        document_skills.IDS
    )


def test_the_ids_are_reserved() -> None:
    assert all(document_skills.is_reserved(i) for i in document_skills.IDS)
    assert not document_skills.is_reserved("ventas")


class FakeS3:
    def __init__(self, error: str | None = None) -> None:
        self.objects: dict[str, bytes] = {}
        self.calls: list[dict[str, Any]] = []
        self.error = error

    def put_object(self, **kwargs: Any) -> None:
        self.calls.append(kwargs)
        assert kwargs["IfNoneMatch"] == "*"
        if self.error:
            raise ClientError({"Error": {"Code": self.error}}, "PutObject")
        if kwargs["Key"] in self.objects:
            raise ClientError({"Error": {"Code": "PreconditionFailed"}}, "PutObject")
        self.objects[kwargs["Key"]] = kwargs["Body"]


def test_ensure_writes_each_text_once_and_never_replaces_it() -> None:
    s3 = FakeS3()
    document_skills.ensure(s3, "skills-bucket")
    document_skills.ensure(s3, "skills-bucket")
    assert sorted(s3.objects) == sorted(document_skills.object_key(i) for i in document_skills.IDS)
    assert s3.objects[document_skills.object_key("pdf")] == document_skills.text("pdf").encode()
    assert {c["Bucket"] for c in s3.calls} == {"skills-bucket"}


def test_ensure_raises_any_other_error() -> None:
    with pytest.raises(ClientError):
        document_skills.ensure(FakeS3("AccessDenied"), "skills-bucket")
    document_skills.ensure(FakeS3("ConditionalRequestConflict"), "skills-bucket")
