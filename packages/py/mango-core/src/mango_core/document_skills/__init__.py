"""The document skills of the release (D119): ``pdf``, ``docx``, ``xlsx`` and ``pptx``.

They are skills of instructions in the AgentSkills.io format, like the ones creators write
(D92), but they come with Mango: their text lives here, in the release, reviewed and signed with
it, never in the skills table. Every version with the ``code_interpreter`` capability gets the
four (D119 (1)); they describe the loop create → render → look → fix with the sandbox helpers
(``mango_docs``, copied into each session by the code connector) and ``render_document``.

* **Where the harness reads them.** ``skills/_release/<id>/<digest>/<id>/SKILL.md`` of the
  installation's skills bucket: under ``skills/`` (the boundary of agents and the Playground's
  role already read that prefix), in a folder no skill of a creator can have (``_release`` is
  not a skill id), named by the SHA-256 of the text, so a release that changes a text writes a
  new object and never replaces one a published version still uses.
* **Who writes them.** The provisioner, with ``If-None-Match`` before it gives a harness their
  sources (:func:`ensure`): nothing else writes under ``skills/_release/``.
* **Their ids are reserved.** No creator may propose a skill named like one of them
  (:func:`is_reserved`): a harness cannot hold two skills of the same name.
"""

from __future__ import annotations

import hashlib
from functools import cache
from importlib import resources
from typing import Any

__all__ = [
    "IDS",
    "REF_PREFIX",
    "RELEASE_PREFIX",
    "digest",
    "ensure",
    "is_reserved",
    "object_key",
    "prefix",
    "refs",
    "s3_uri",
    "sources",
    "text",
]

IDS = ("docx", "pdf", "pptx", "xlsx")
"""The skills of the release, sorted (D119 (1))."""
RELEASE_PREFIX = "skills/_release/"
"""Their folder in the skills bucket; ``_release`` cannot be a skill id (``SKILL_ID_PATTERN``)."""
OUTPUT_EXTENSIONS = ("csv", "docx", "json", "pdf", "png", "pptx", "txt", "xlsx")
"""What the skills tell the model to hand out: a subset of the chat's closed list of kinds
(``mango_core.chat_files.TYPES``, D116 (6), D119 (3)); never HTML, SVG, macros nor executables."""


REF_PREFIX = "release:"
"""How the provisioner names one of them among the skill versions an agent role reads."""


def refs() -> tuple[str, ...]:
    """``release:<id>`` of each: what an agent role that runs code reads of the bucket."""
    return tuple(f"{REF_PREFIX}{skill_id}" for skill_id in IDS)


def is_reserved(skill_id: str) -> bool:
    """Whether an id belongs to a skill of the release (never proposed by a creator)."""
    return skill_id in IDS


@cache
def text(skill_id: str) -> str:
    """The ``SKILL.md`` of one skill of the release, as the harness reads it."""
    if skill_id not in IDS:
        raise KeyError(skill_id)
    return resources.files(__package__).joinpath(skill_id, "SKILL.md").read_text(encoding="utf-8")


def digest(skill_id: str) -> str:
    """First 16 hex characters of the SHA-256 of its text: the folder of this text."""
    return hashlib.sha256(text(skill_id).encode("utf-8")).hexdigest()[:16]


def prefix(skill_id: str) -> str:
    """Folder the harness fetches (the last part must be named as the skill)."""
    return f"{RELEASE_PREFIX}{skill_id}/{digest(skill_id)}/{skill_id}/"


def object_key(skill_id: str) -> str:
    return f"{prefix(skill_id)}SKILL.md"


def s3_uri(bucket: str, skill_id: str) -> str:
    return f"s3://{bucket}/{prefix(skill_id)}"


def sources(bucket: str) -> list[dict[str, Any]]:
    """The four, as a harness (or an invocation of the Playground's) takes its skills."""
    return [{"s3": {"uri": s3_uri(bucket, skill_id)}} for skill_id in IDS]


def ensure(s3: Any, bucket: str) -> None:
    """Write the texts of this release that are not in the bucket yet; never replaces one.

    ``If-None-Match: *``: an object already there (``PreconditionFailed``, or a concurrent
    write, ``ConditionalRequestConflict``) has this very text, since its key is its digest.
    Any other error is raised: a harness must not name a skill it could not download (the
    harness fails the invocation then, D92)."""
    for skill_id in IDS:
        body = text(skill_id).encode("utf-8")
        try:
            s3.put_object(
                Bucket=bucket,
                Key=object_key(skill_id),
                Body=body,
                ContentType="text/markdown; charset=utf-8",
                IfNoneMatch="*",
            )
        except Exception as exc:  # botocore's ClientError, without importing botocore here
            code = getattr(exc, "response", {}).get("Error", {}).get("Code")
            if code not in {"PreconditionFailed", "ConditionalRequestConflict"}:
                raise
