"""Snapshot of a pack's `tools/list` (spec §4.2 step 4, TM-M5).

Tool names, descriptions and schemas are what the model reads, so a change in any of them
is a change of behavior: the hash is pinned in the manifest and a different one must go
through review again.
"""

from __future__ import annotations

from typing import Any

from mango_packs.canonical import SHA256_PREFIX, canonical_json, sha256_hex
from mango_packs.manifest import IdentityMode, PackManifest, ToolAccess

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


def _upstream_class(tool: dict[str, Any]) -> ToolAccess | None:
    """The strictest class the server's own MCP annotations claim, or None if they claim none.

    Annotations are hints from third-party code: they can only make a check stricter, never
    turn a tool into a read. ``destructiveHint`` only means something when the tool is not
    read-only (MCP specification).
    """
    annotations = tool.get("annotations")
    if not isinstance(annotations, dict):
        return None
    read_only = annotations.get("readOnlyHint")
    if read_only is True:
        return None
    if annotations.get("destructiveHint") is True:
        return ToolAccess.DESTRUCTIVE
    return ToolAccess.WRITE if read_only is False else None


def check_classes(manifest: PackManifest, normalized: list[dict[str, Any]]) -> None:
    """Fail when the server says a tool does more than the manifest classifies it (D84).

    A tool the manifest calls ``read`` that the server annotates as not read-only, or one the
    server annotates as destructive that the manifest does not classify ``destructive``, is a
    reviewer's mistake: the manifest must say at least what upstream says.
    """
    declared = {tool.name: tool.effective_access for tool in manifest.tools}
    understated: list[str] = []
    for tool in normalized:
        claimed = _upstream_class(tool)
        access = declared.get(str(tool["name"]))
        if claimed is None or access is None:
            continue
        if access is ToolAccess.READ or (
            claimed is ToolAccess.DESTRUCTIVE and access is not ToolAccess.DESTRUCTIVE
        ):
            understated.append(f"{tool['name']} ({claimed.value})")
    if understated:
        raise PackToolsError(
            f"the server annotates {sorted(understated)} as more than the manifest classifies "
            "them: classify each one at least as its annotations say (D84)"
        )


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
    # On the listing the manifest pins: what the reviewer saw when classifying the tools.
    check_classes(manifest, normalized)
