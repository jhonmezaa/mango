"""Server rules a version must pass to be sent to review (spec §3, D26, D30; TM-M3, TM-M7).

The Builder runs the same checks to guide the creator, but only these count. They are pure:
the caller passes the release catalog, the model catalog, the group registry and a view of
the published organization chart, and gets back every violation as a stable ``code`` (the UI
owns the wording). Nothing here echoes a detected secret.

The caller must validate the exact draft revision it then freezes
(``AgentsStore.submit(..., revision=...)``), and should validate again when approving: the
catalogs and the organization chart may have changed while the version waited.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

from mango_api.mcp_catalog import McpCatalog
from mango_api.model_catalog import ModelCatalog
from mango_core.agents import ROOT_SUPERVISOR, AgentDefinition, dumps_definition
from mango_core.groups import GroupDef

MAX_DRAFTS = 20
"""Drafts a creator may hold at once (TM-M9)."""
MAX_SUBMISSIONS_PER_DAY = 5
"""Versions a creator may send to review per UTC day (TM-M9)."""
MAX_DEFINITION_BYTES = 48 * 1024
MAX_ORG_DEPTH = 50


class OrgChart(Protocol):
    def supervisor_of(self, agent_id: str) -> str | None:
        """``reports_to`` of a **published** agent; ``None`` if it is not published."""
        ...


@dataclass(frozen=True)
class RuleContext:
    catalog: McpCatalog
    models: ModelCatalog
    groups: Mapping[str, GroupDef]
    """Group registry of the installation by id (``mango_api.groups.GroupRegistry``)."""
    org: OrgChart


@dataclass(frozen=True)
class Violation:
    code: str
    field: str
    """Field of the definition the creator has to fix."""
    items: tuple[str, ...] = ()
    """Offending tool refs, group ids or model ids. Never free text from the definition."""


# --- Secrets (TM-M7) ----------------------------------------------------------------------

_SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("aws_access_key_id", re.compile(r"(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])")),
    ("aws_secret_access_key", re.compile(r"aws_?secret_?access_?key\s*[:=]", re.IGNORECASE)),
    ("private_key", re.compile(r"-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----")),
    ("api_key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}")),
    ("slack_token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    (
        "github_token",
        re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})"),
    ),
    (
        "jwt",
        re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    ),
    ("bearer_token", re.compile(r"\bbearer\s+[A-Za-z0-9._~+/=-]{20,}", re.IGNORECASE)),
    (
        "password",
        re.compile(r"\b(?:password|passwd|pwd|contraseña)\s*[:=]\s*\S{4,}", re.IGNORECASE),
    ),
    (
        "credential",
        re.compile(
            r"\b(?:api[_-]?key|secret|token)\s*[:=]\s*[\"']?[A-Za-z0-9/+_=-]{20,}", re.IGNORECASE
        ),
    ),
)


def find_secrets(text: str) -> tuple[str, ...]:
    """Kinds of credentials that appear in ``text``. The matches are never returned."""
    return tuple(kind for kind, pattern in _SECRET_PATTERNS if pattern.search(text))


# --- Rules --------------------------------------------------------------------------------


def _required(definition: AgentDefinition) -> list[Violation]:
    out: list[Violation] = []
    if not definition.system_prompt.strip():
        out.append(Violation("prompt_required", "system_prompt"))
    if definition.reports_to is None:
        out.append(Violation("reports_to_required", "reports_to"))
    if not definition.role:
        out.append(Violation("role_required", "role"))
    if not definition.groups:
        out.append(Violation("groups_required", "groups"))
    if len(dumps_definition(definition).encode("utf-8")) > MAX_DEFINITION_BYTES:
        out.append(Violation("definition_too_large", "system_prompt"))
    return out


def _secrets(definition: AgentDefinition) -> list[Violation]:
    out: list[Violation] = []
    for field in ("system_prompt", "name", "description", "role"):
        kinds = find_secrets(getattr(definition, field))
        if kinds:
            out.append(Violation("secret_detected", field, kinds))
    return out


def _organization(agent_id: str, definition: AgentDefinition, org: OrgChart) -> list[Violation]:
    """``reports_to`` is a published agent other than this one and none of its subordinates."""
    supervisor = definition.reports_to
    if supervisor is None or supervisor == ROOT_SUPERVISOR:
        return []
    if supervisor == agent_id:
        return [Violation("reports_to_cycle", "reports_to", (supervisor,))]
    above = org.supervisor_of(supervisor)
    if above is None:
        return [Violation("reports_to_unknown", "reports_to", (supervisor,))]
    # Walk up the published chart; reaching this agent means the supervisor is below it.
    seen = {supervisor}
    current: str | None = above
    while current is not None and current != ROOT_SUPERVISOR:
        if current == agent_id or current in seen or len(seen) >= MAX_ORG_DEPTH:
            return [Violation("reports_to_cycle", "reports_to", (supervisor,))]
        seen.add(current)
        # A retired ancestor ends the chain: only the direct supervisor must be published.
        current = org.supervisor_of(current)
    return []


def _models(definition: AgentDefinition, models: ModelCatalog) -> list[Violation]:
    out: list[Violation] = []
    if definition.model is None:
        return [Violation("model_required", "model")]
    if definition.model not in definition.allowed_models:
        out.append(Violation("default_model_not_allowed", "allowed_models", (definition.model,)))
    entries = {model_id: models.get(model_id) for model_id in definition.allowed_models}
    disabled = tuple(m for m, entry in entries.items() if entry is None or not entry.enabled)
    if disabled:
        out.append(Violation("model_not_enabled", "allowed_models", disabled))
    if definition.tools:
        no_tools = tuple(m for m, e in entries.items() if e is not None and not e.supports_tools)
        if no_tools:
            out.append(Violation("model_without_tools", "allowed_models", no_tools))
    return out


def _tools(definition: AgentDefinition, ctx: RuleContext) -> list[Violation]:
    out: list[Violation] = []
    resolved = {ref: ctx.catalog.tool(ref) for ref in definition.tools}
    unavailable = tuple(ref for ref, tool in resolved.items() if tool is None or not tool.enabled)
    if unavailable:
        out.append(Violation("tool_not_enabled", "tools", unavailable))
    stray = tuple(ref for ref in definition.approval_tools if ref not in resolved)
    if stray:
        out.append(Violation("approval_tool_not_selected", "approval_tools", stray))
    unmarked = tuple(
        ref
        for ref, tool in resolved.items()
        if tool is not None and tool.is_write and ref not in definition.approval_tools
    )
    if unmarked:
        out.append(Violation("write_tool_without_approval", "approval_tools", unmarked))
    return out


def _access(definition: AgentDefinition, ctx: RuleContext) -> list[Violation]:
    out: list[Violation] = []
    unknown = tuple(g for g in definition.groups if g not in ctx.groups)
    if unknown:
        out.append(Violation("group_unknown", "groups", unknown))
    central_tools = [
        tool
        for ref in definition.tools
        if (tool := ctx.catalog.tool(ref)) is not None and tool.central_groups_only
    ]
    if central_tools:
        # Unknown groups count as not central: deny by default.
        exposed = tuple(
            g
            for g in definition.groups
            if (group := ctx.groups.get(g)) is None or not group.is_central
        )
        if exposed:
            out.append(Violation("account_data_for_non_central_group", "groups", exposed))
        if definition.users:
            # A user's group type is not known here, so account data that the server does
            # not filter is never shared with individual users.
            out.append(Violation("account_data_for_users", "users"))
    return out


def validate_for_review(
    agent_id: str, definition: AgentDefinition, ctx: RuleContext
) -> list[Violation]:
    """Every rule the version breaks; an empty list means it may be sent to review."""
    return [
        *_required(definition),
        *_secrets(definition),
        *_organization(agent_id, definition, ctx.org),
        *_models(definition, ctx.models),
        *_tools(definition, ctx),
        *_access(definition, ctx),
    ]
