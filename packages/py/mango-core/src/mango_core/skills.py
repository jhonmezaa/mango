"""Skills of instructions only (D92): what mango-api and the provisioner share.

A skill is a playbook in the AgentSkills.io format (``SKILL.md``) that the AgentCore harness
fetches from S3 when a session starts and loads into the agent's context when the model
activates it. Mango only has skills of **instructions**: no scripts, so agents never get
``shell`` or ``file_operations`` (D25, D26).

* Every approved version is immutable and is written once, by mango-api, under
  ``skills/<id>/v<N>/<id>/SKILL.md`` of the skills bucket: the format requires the directory to
  be named as the skill.
* An agent version names the exact versions it uses (``<id>@<N>``, ``AgentDefinition.skills``):
  a new version of a skill reaches an agent with that agent's next approved version.
* The text is written by creators, so it is untrusted until another administrator approves it:
  it is normalized as a system prompt (NFC, no control or text-direction characters) and the
  frontmatter is built here, never taken from the text.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Callable
from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

MAX_ID_CHARS = 40
SKILL_ID_PATTERN = r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
"""AgentSkills.io ``name``: lowercase letters, digits and single hyphens. At most
``MAX_ID_CHARS`` (the design derives it from the name, cut at 40)."""
SKILL_REF_PATTERN = r"^[a-z0-9]+(?:-[a-z0-9]+)*@[1-9][0-9]{0,3}$"
"""``<skill id>@<version>`` in an agent version."""
SERVER_ID_PATTERN = r"^[a-z0-9][a-z0-9-]{0,47}$"
"""Id of a connector or pack of the MCP catalog (the part before the dot of a tool ref)."""
MAX_VERSION = 9999

CATEGORIES = ("FinOps", "DevOps", "ERP", "Productivity", "Security", "Data")
"""The categories the design's editor offers."""
MAX_NAME_CHARS = 48
MAX_DESCRIPTION_CHARS = 140
MAX_INSTRUCTIONS_CHARS = 20_000
"""About 5 000 tokens: the AgentSkills.io advice for the body of one skill."""
MAX_OUTPUTS = 10
MAX_OUTPUT_CHARS = 40
MAX_SERVERS = 10
MAX_PER_AGENT = 10
"""Skills one agent version may use: each one costs tokens in every model call."""

_ID_RE = re.compile(SKILL_ID_PATTERN)
_REF_RE = re.compile(SKILL_REF_PATTERN)
_VARIABLE_RE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")
_BIDI_CONTROLS = frozenset("\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200f")


class InvalidSkillError(ValueError):
    """A stored skill does not satisfy the schema; readers must fail closed."""


def is_skill_id(value: object) -> bool:
    return isinstance(value, str) and len(value) <= MAX_ID_CHARS and bool(_ID_RE.fullmatch(value))


def skill_ref(skill_id: str, version: int) -> str:
    return f"{skill_id}@{version}"


def parse_ref(ref: str) -> tuple[str, int]:
    """``(id, version)`` of a reference; ``ValueError`` if it is not one."""
    if not _REF_RE.fullmatch(ref):
        raise ValueError("not a skill reference")
    skill_id, _, version = ref.partition("@")
    if len(skill_id) > MAX_ID_CHARS:
        raise ValueError("not a skill reference")
    return skill_id, int(version)


def _line(max_chars: int, min_chars: int = 0) -> Callable[[str], str]:
    def validate(value: str) -> str:
        text = unicodedata.normalize("NFC", value).strip()
        if not min_chars <= len(text) <= max_chars:
            raise ValueError(f"between {min_chars} and {max_chars} characters")
        if not text.isprintable():
            raise ValueError("control or invisible characters are not allowed")
        return text

    return validate


def _instructions(value: str) -> str:
    text = unicodedata.normalize("NFC", value.replace("\r\n", "\n").replace("\r", "\n")).strip()
    if not 1 <= len(text) <= MAX_INSTRUCTIONS_CHARS:
        raise ValueError(f"between 1 and {MAX_INSTRUCTIONS_CHARS} characters")
    for char in text:
        if char in _BIDI_CONTROLS or (unicodedata.category(char) == "Cc" and char not in "\n\t"):
            raise ValueError("control or text-direction characters are not allowed")
    return text


def _category(value: str) -> str:
    if value not in CATEGORIES:
        raise ValueError("unknown category")
    return value


def _sorted_unique(values: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(sorted(set(values)))


def _unique(values: tuple[str, ...]) -> tuple[str, ...]:
    """Keeps the order the author gave (the design shows the outputs as written)."""
    return tuple(dict.fromkeys(values))


Output = Annotated[str, AfterValidator(_line(MAX_OUTPUT_CHARS, min_chars=1))]
ServerId = Annotated[str, Field(pattern=SERVER_ID_PATTERN)]


class SkillContent(BaseModel):
    """What one version of a skill says. Everything else (owner, dates) is the store's."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    name: Annotated[str, AfterValidator(_line(MAX_NAME_CHARS, min_chars=1))]
    category: Annotated[str, AfterValidator(_category)]
    description: Annotated[str, AfterValidator(_line(MAX_DESCRIPTION_CHARS))] = ""
    instructions: Annotated[str, AfterValidator(_instructions)]
    outputs: Annotated[
        tuple[Output, ...], Field(max_length=MAX_OUTPUTS), AfterValidator(_unique)
    ] = ()
    servers: Annotated[
        tuple[ServerId, ...],
        Field(min_length=1, max_length=MAX_SERVERS),
        AfterValidator(_sorted_unique),
    ]
    """MCP servers of the catalog the instructions rely on (the design's «MCP requeridos»)."""


def variables(instructions: str) -> list[str]:
    """``{{variable}}`` names, in order of appearance, without repeats."""
    return list(dict.fromkeys(m.group(1) for m in _VARIABLE_RE.finditer(instructions)))


def prefix(skill_id: str, version: int) -> str:
    """Directory of one version in the skills bucket (what the harness fetches)."""
    return f"skills/{skill_id}/v{version}/{skill_id}/"


def object_key(skill_id: str, version: int) -> str:
    return f"{prefix(skill_id, version)}SKILL.md"


def s3_uri(bucket: str, skill_id: str, version: int) -> str:
    return f"s3://{bucket}/{prefix(skill_id, version)}"


def render(skill_id: str, version: int, content: SkillContent) -> str:
    """``SKILL.md`` of one version.

    The frontmatter is built here: ``name`` is the id (it must match the directory) and the
    description is a JSON string, which YAML reads as a double-quoted scalar, so nothing in
    the text can add keys. An empty description falls back to the name: the format requires
    one, and the harness shows it to the model to decide when to use the skill.
    """
    if not is_skill_id(skill_id) or not 1 <= version <= MAX_VERSION:
        raise InvalidSkillError("invalid skill id or version")
    description = content.description or content.name
    lines = [
        "---",
        f"name: {skill_id}",
        f"description: {json.dumps(description, ensure_ascii=False)}",
        "metadata:",
        f'  mango-version: "{version}"',
        "---",
        "",
        f"# {content.name}",
        "",
        content.instructions,
    ]
    if content.outputs:
        lines += ["", "## Entrega", "", *(f"- {output}" for output in content.outputs)]
    return "\n".join(lines) + "\n"
