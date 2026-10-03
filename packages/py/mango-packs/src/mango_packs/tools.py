"""Snapshot of a pack's `tools/list` (spec §4.2 step 4, TM-M5).

Tool names, descriptions and schemas are what the model reads, so a change in any of them
is a change of behavior: the hash is pinned in the manifest and a different one must go
through review again.
"""

from __future__ import annotations

from typing import Any

from mango_packs.canonical import SHA256_PREFIX, canonical_json, sha256_hex
from mango_packs.manifest import IdentityMode, PackManifest

# What reaches the model through the Gateway. Other fields (`_meta`, icons) do not.
_HASHED_FIELDS = ("name", "title", "description", "inputSchema", "outputSchema", "annotations")
_MAX_TOOLS = 100


class PackToolsError(Exception):
    """The tools a pack serves are not the ones its manifest declares."""


def normalize_tools(tools: object) -> list[dict[str, Any]]:
    """Reduce the `tools` array of a `tools/list` result to its hashed fields, sorted by name."""
    if not isinstance(tools, list) or len(tools) > _MAX_TOOLS:
        raise PackToolsError("tools/list did not return a list of tools of a sane size")
    normalized: list[dict[str, Any]] = []
    for tool in tools:
        if not isinstance(tool, dict) or not isinstance(tool.get("name"), str):
            raise PackToolsError("tools/list returned a tool without a name")
        normalized.append(
            {field: tool[field] for field in _HASHED_FIELDS if tool.get(field) is not None}
        )
    normalized.sort(key=lambda tool: str(tool["name"]))
    names = [tool["name"] for tool in normalized]
    if len(set(names)) != len(names):
        raise PackToolsError("tools/list returned a duplicate tool name")
    return normalized


def tools_hash(normalized: list[dict[str, Any]]) -> str:
    return SHA256_PREFIX + sha256_hex(canonical_json(normalized))


def check_tools(manifest: PackManifest, tools: object) -> None:
    """Fail unless the served tools are exactly the manifest's, with the pinned hash."""
    normalized = normalize_tools(tools)
    served = {str(tool["name"]) for tool in normalized}
    extra = sorted(served - manifest.tool_names)
    missing = sorted(manifest.tool_names - served)
    if extra or missing:
        raise PackToolsError(
            f"served tools differ from the manifest: not allowed {extra}, not served {missing}"
        )
    if manifest.identity_mode is not IdentityMode.SERVICE:
        # The Gateway validates the arguments against this schema after its interceptor
        # added the caller in `_mango_ctx`: a closed schema makes it refuse every call.
        closed = sorted(
            str(tool["name"])
            for tool in normalized
            if (tool.get("inputSchema") or {}).get("additionalProperties") is False
        )
        if closed:
            raise PackToolsError(
                f"the input schema of {closed} forbids additional properties: the Gateway "
                "would reject the caller context of a pack over account data"
            )
    actual = tools_hash(normalized)
    if actual != manifest.tools_hash:
        raise PackToolsError(
            f"tools/list changed: manifest pins {manifest.tools_hash}, server gives {actual}. "
            "Review the diff of the snapshot; a new hash needs approval again (D19)"
        )
