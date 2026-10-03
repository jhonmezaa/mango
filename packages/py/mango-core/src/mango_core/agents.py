"""Agents as data (Marketplace v1: D18, D22, D30): definition schema, content hash and ids.

An ``AgentDefinition`` is the content of one agent version. It is written by creators, so
everything here is untrusted input (threat model ``marketplace-v1-threat-model.md``):

* The schema forbids unknown fields and carries no IAM, ARNs or free-form configuration: the
  provisioner derives the agent's role from a fixed template, never from the definition
  (TM-M1).
* A version is frozen when it is sent to review. ``content_hash`` is the SHA-256 of the
  **stored canonical JSON**; approval records it and the provisioner deploys by hash (TM-M2).
  Verify with ``verify_content`` against the stored string: never re-serialize a parsed
  definition to compare, because a later schema default would change the bytes.
* Text is NFC-normalized and rejects control and bidirectional-override characters, so what a
  reviewer reads in the diff is what the model receives.

Completeness (required fields, enabled tools, cycles...) is checked when the version is sent to
review, by ``mango_api.agent_rules``; drafts only need to satisfy this schema.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import unicodedata
from collections.abc import Callable
from enum import StrEnum
from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictInt, ValidationError

ROOT_SUPERVISOR = "platform"
"""``reports_to`` value of an agent at the top of the organization chart (D30)."""

# Generated ids are 16 base32 characters (80 random bits); release agents keep a slug such as
# ``finops``. Both fit the harness name ``Mango_<ns>_a_<id>`` (40 characters, no hyphens).
_GENERATED_ID_RE = re.compile(r"^[a-z2-7]{16}$")
_RELEASE_SLUG_RE = re.compile(r"^[a-z][a-z0-9]{1,15}$")
AGENT_ID_PATTERN = r"^(?:[a-z2-7]{16}|[a-z][a-z0-9]{1,15})$"
TOOL_REF_PATTERN = r"^[a-z0-9][a-z0-9-]{0,47}\.[A-Za-z0-9_-]{1,64}$"
MODEL_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9.:_-]{0,127}$"
GROUP_ID_PATTERN = r"^[a-z0-9][a-z0-9-]{1,63}$"
USER_ID_PATTERN = r"^[A-Za-z0-9-]{1,64}$"

MAX_NAME_CHARS = 40
MAX_DESCRIPTION_CHARS = 140
MAX_ROLE_CHARS = 40
MAX_CATEGORY_CHARS = 24
MAX_PROMPT_CHARS = 12_000
MAX_TOOLS = 50
MAX_MODELS = 10
MAX_GROUPS = 50
MAX_USERS = 50
ICON_COLORS = 8

_BIDI_CONTROLS = frozenset("\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200f")
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")


class VersionStatus(StrEnum):
    """Lifecycle of one agent version (spec §3). A rejected version goes back to ``draft``."""

    DRAFT = "draft"
    IN_REVIEW = "in_review"
    APPROVED = "approved"
    PUBLISHED = "published"
    FAILED = "failed"
    SUPERSEDED = "superseded"
    RETIRED = "retired"


class AgentStatus(StrEnum):
    DRAFT = "draft"  # never published
    PUBLISHED = "published"
    RETIRED = "retired"


class InvalidDefinitionError(ValueError):
    """A stored definition does not satisfy the schema; readers must fail closed."""


def new_agent_id() -> str:
    """Random public id (never incremental): 16 lowercase base32 characters."""
    return base64.b32encode(secrets.token_bytes(10)).decode("ascii").lower()


def is_agent_id(value: object) -> bool:
    if not isinstance(value, str) or value == ROOT_SUPERVISOR:
        return False
    return bool(_GENERATED_ID_RE.fullmatch(value) or _RELEASE_SLUG_RE.fullmatch(value))


# --- Text normalization -----------------------------------------------------------------


def _line(max_chars: int, min_chars: int = 0) -> Callable[[str], str]:
    """Single-line display text: NFC, trimmed, printable only."""

    def validate(value: str) -> str:
        text = unicodedata.normalize("NFC", value).strip()
        if not min_chars <= len(text) <= max_chars:
            raise ValueError(f"between {min_chars} and {max_chars} characters")
        if not text.isprintable():
            raise ValueError("control or invisible characters are not allowed")
        return text

    return validate


def _prompt(value: str) -> str:
    """Multi-line text: NFC, ``\\n`` line ends, no control or bidi-override characters."""
    text = unicodedata.normalize("NFC", value.replace("\r\n", "\n").replace("\r", "\n"))
    if len(text) > MAX_PROMPT_CHARS:
        raise ValueError(f"at most {MAX_PROMPT_CHARS} characters")
    for char in text:
        if char in _BIDI_CONTROLS or (unicodedata.category(char) == "Cc" and char not in "\n\t"):
            raise ValueError("control or text-direction characters are not allowed")
    return text


def _sorted_unique(values: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(sorted(set(values)))


def _supervisor(value: str | None) -> str | None:
    if value is None or value == ROOT_SUPERVISOR or is_agent_id(value):
        return value
    raise ValueError("must be an agent id or the root supervisor")


def _temperature(value: float | None) -> float | None:
    # Two decimals keep the canonical JSON free of float noise.
    return None if value is None else round(value, 2)


Name = Annotated[str, AfterValidator(_line(MAX_NAME_CHARS, min_chars=1))]
Description = Annotated[str, AfterValidator(_line(MAX_DESCRIPTION_CHARS))]
Role = Annotated[str, AfterValidator(_line(MAX_ROLE_CHARS))]
Category = Annotated[str, AfterValidator(_line(MAX_CATEGORY_CHARS))]
Icon = Annotated[str, Field(pattern=r"^[A-Za-z][A-Za-z0-9]{0,31}$")]
ToolRef = Annotated[str, Field(pattern=TOOL_REF_PATTERN)]
ModelId = Annotated[str, Field(pattern=MODEL_ID_PATTERN)]
GroupId = Annotated[str, Field(pattern=GROUP_ID_PATTERN)]
UserId = Annotated[str, Field(pattern=USER_ID_PATTERN)]
ToolRefs = Annotated[
    tuple[ToolRef, ...], Field(max_length=MAX_TOOLS), AfterValidator(_sorted_unique)
]


class _Frozen(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class AgentLimits(_Frozen):
    """Harness limits per turn. Ranges follow the Agent Builder design."""

    max_tokens: Annotated[StrictInt, Field(ge=256, le=8192)] = 4096
    max_iterations: Annotated[StrictInt, Field(ge=1, le=25)] = 8
    timeout_seconds: Annotated[StrictInt, Field(ge=10, le=600)] = 120
    # Not editable in the Builder; release agents (FinOps) set them.
    max_tokens_per_call: Annotated[StrictInt, Field(ge=256, le=8192)] | None = None
    temperature: Annotated[float | None, Field(ge=0, le=1), AfterValidator(_temperature)] = None


class AgentDefinition(_Frozen):
    """Content of one agent version. The agent's budget is not part of it (D22)."""

    name: Name
    description: Description = ""
    category: Category = ""
    icon: Icon = "Bot"
    color: Annotated[StrictInt, Field(ge=0, lt=ICON_COLORS)] = 0
    # Organization data only (D30): no effect on execution, permissions or budgets.
    reports_to: Annotated[str | None, AfterValidator(_supervisor)] = None
    role: Role = ""
    model: ModelId | None = None
    """Default model; the user may pick any of ``allowed_models`` in the chat (D22)."""
    allowed_models: Annotated[
        tuple[ModelId, ...], Field(max_length=MAX_MODELS), AfterValidator(_sorted_unique)
    ] = ()
    system_prompt: Annotated[str, AfterValidator(_prompt)] = ""
    tools: ToolRefs = ()
    """``<connector or pack id>.<tool name>`` references from the MCP catalog."""
    approval_tools: ToolRefs = ()
    """Subset of ``tools`` that needs approval on every call (all write tools)."""
    limits: AgentLimits = AgentLimits()
    groups: Annotated[
        tuple[GroupId, ...], Field(max_length=MAX_GROUPS), AfterValidator(_sorted_unique)
    ] = ()
    users: Annotated[
        tuple[UserId, ...], Field(max_length=MAX_USERS), AfterValidator(_sorted_unique)
    ] = ()


# --- Canonical form and hash ------------------------------------------------------------


def dumps_definition(definition: AgentDefinition) -> str:
    """Canonical JSON used to store a definition: sorted keys, no whitespace, UTF-8."""
    return json.dumps(
        definition.model_dump(mode="json"),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def loads_definition(raw: str) -> AgentDefinition:
    try:
        return AgentDefinition.model_validate_json(raw)
    except ValidationError as exc:
        # The error detail may quote the stored content: keep only the count.
        raise InvalidDefinitionError(f"invalid definition ({exc.error_count()} errors)") from None


def content_hash(canonical: str) -> str:
    """SHA-256 (hex) of the canonical JSON exactly as stored."""
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def verify_content(canonical: str, expected_hash: str) -> bool:
    """True when the stored definition is the one that was approved (TM-M2)."""
    if not _HASH_RE.fullmatch(expected_hash):
        return False
    return hmac.compare_digest(content_hash(canonical), expected_hash)
