"""What each Bedrock model can do, as release data (``models/capabilities.json``, rule 7).

Bedrock's listing APIs do not say whether a model supports tool use or how large its context
is. The release ships that per foundation model id. A model that is not in the file gets no
capabilities: it joins the catalog without tool use (fail closed).
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from types import MappingProxyType
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError

MAX_CAPABILITIES_BYTES = 256 * 1024
FoundationModelId = Annotated[
    str, Field(pattern=r"^[a-z0-9][a-z0-9-]{0,39}\.[A-Za-z0-9.:_-]{1,100}$")
]


class ModelCapabilitiesError(Exception):
    """The capabilities file is missing or invalid; nothing is refreshed with it."""


class ModelCapability(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    supports_tools: StrictBool
    context_tokens: Annotated[int, Field(strict=True, ge=1_000, le=100_000_000)] | None = None


class _CapabilitiesFile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Annotated[Literal[1], Field(alias="schema")]
    models: Annotated[dict[FoundationModelId, ModelCapability], Field(max_length=500)]


def load_capabilities(path: Path) -> Mapping[str, ModelCapability]:
    """Capabilities by foundation model id. Raises ``ModelCapabilitiesError`` if unusable."""
    try:
        raw = path.read_bytes()
        if len(raw) > MAX_CAPABILITIES_BYTES:
            raise ModelCapabilitiesError("model capabilities file is too large")
        parsed = _CapabilitiesFile.model_validate(json.loads(raw))
    except (OSError, ValueError, ValidationError) as exc:
        raise ModelCapabilitiesError("model capabilities could not be read") from exc
    return MappingProxyType(dict(parsed.models))
