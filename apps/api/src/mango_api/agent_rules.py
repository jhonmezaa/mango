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
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Protocol

from mango_api.knowledge_store import KnowledgeBase
from mango_api.mcp_catalog import McpCatalog
from mango_api.model_catalog import ModelCatalog
from mango_api.skills_store import SkillVersion
from mango_core.agents import ROOT_SUPERVISOR, AgentDefinition, dumps_definition
from mango_core.groups import GroupDef
from mango_core.knowledge import Status as KnowledgeStatus

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
    knowledge: Mapping[str, KnowledgeBase] = field(default_factory=dict)
    """The knowledge bases the version names, as the Knowledge table has them now (D88 (15)).
    One that is not here does not exist."""
    skills: Mapping[str, SkillVersion] = field(default_factory=dict)
    """The approved skill versions the version names, by ``<id>@<version>`` (D92). One that is
    not here was never approved."""


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
    for name in ("system_prompt", "name", "description", "role"):
        kinds = find_secrets(getattr(definition, name))
        if kinds:
            out.append(Violation("secret_detected", name, kinds))
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
    # The knowledge bases are searched with a tool too (``knowledge-retrieve``, D88 (14)), and
    # skills are loaded with one (``skills``, D92).
    if definition.tools or definition.knowledge_bases or definition.skills:
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


def _knowledge(definition: AgentDefinition, ctx: RuleContext) -> list[Violation]:
    """Every knowledge base exists and is not being deleted (D88 (15), (16)). Who may use it
    is checked when it is added (``mango_api.agents``): it depends on the person who adds it."""
    gone = tuple(
        kb_id
        for kb_id in definition.knowledge_bases
        if (kb := ctx.knowledge.get(kb_id)) is None or kb.status is KnowledgeStatus.DELETING
    )
    return [Violation("knowledge_base_unavailable", "knowledge_bases", gone)] if gone else []


def _skills(definition: AgentDefinition, ctx: RuleContext) -> list[Violation]:
    """Every skill is an approved version; the MCP servers it relies on are enabled and the
    version has at least one tool of each, or its instructions could not be followed (D92)."""
    missing: list[str] = []
    disabled: list[str] = []
    without_tools: list[str] = []
    servers_with_tools = {ref.partition(".")[0] for ref in definition.tools}
    for ref in definition.skills:
        skill = ctx.skills.get(ref)
        if skill is None:
            missing.append(ref)
            continue
        if not all(ctx.catalog.server_enabled(s) for s in skill.content.servers):
            disabled.append(ref)
        elif not set(skill.content.servers) <= servers_with_tools:
            without_tools.append(ref)
    out: list[Violation] = []
    if missing:
        out.append(Violation("skill_unavailable", "skills", tuple(missing)))
    if disabled:
        out.append(Violation("skill_server_not_enabled", "skills", tuple(disabled)))
    if without_tools:
        out.append(Violation("skill_server_without_tools", "skills", tuple(without_tools)))
    return out


def added_knowledge_violations(
    added: Sequence[str], knowledge: Mapping[str, KnowledgeBase], usable: Collection[str]
) -> list[Violation]:
    """Knowledge bases a person adds to a version (D88 (15), TM-K8): each must exist, not be
    being deleted, and be one ``usable`` by that person (``UseKnowledgeBase``). Checked when
    the draft is saved, by who saves it: the review rules do not know the author's groups."""
    gone = tuple(
        kb_id
        for kb_id in added
        if (kb := knowledge.get(kb_id)) is None or kb.status is KnowledgeStatus.DELETING
    )
    forbidden = tuple(kb_id for kb_id in added if kb_id not in gone and kb_id not in usable)
    out: list[Violation] = []
    if gone:
        out.append(Violation("knowledge_base_unavailable", "knowledge_bases", gone))
    if forbidden:
        out.append(Violation("knowledge_base_not_usable", "knowledge_bases", forbidden))
    return out


def added_remote_violations(
    added: Sequence[str], catalog: McpCatalog, usable: Collection[str]
) -> list[Violation]:
    """Tools of remote MCPs a person adds to a version (D93 (7), D98 (17), (18)): each must be
    one the registration's signed catalog names while it is active (``tool_not_enabled``), of a
    registration that person may use (``remote_not_usable``: ``UseRemoteMcp``, their groups).
    Checked when the draft is saved, by who saves it; the tools the version already had stay,
    as its knowledge bases (D88 (35))."""
    disabled = tuple(
        ref for ref in added if (tool := catalog.tool(ref)) is None or not tool.enabled
    )
    forbidden = tuple(
        ref
        for ref in added
        if ref not in disabled
        and ((remote := catalog.remote_of(ref)) is None or remote.registration_id not in usable)
    )
    out: list[Violation] = []
    if disabled:
        out.append(Violation("tool_not_enabled", "tools", disabled))
    if forbidden:
        out.append(Violation("remote_not_usable", "tools", forbidden))
    return out


def remote_alerts(definition: AgentDefinition, catalog: McpCatalog) -> dict[str, tuple[str, ...]]:
    """The alert ``remote_audience_outside_groups`` (D98 (2)), by registration: the groups of
    the agent with no group of the registration. Their people use the agent without its remote
    tools. Not a rule: it never blocks a version. Like ``knowledge_alerts``, people the agent
    is shared with one by one are not looked at: their groups are in their token."""
    alerts: dict[str, tuple[str, ...]] = {}
    for ref in definition.tools:
        remote = catalog.remote_of(ref)
        if remote is None or remote.registration_id in alerts:
            continue
        alerts[remote.registration_id] = tuple(
            g for g in definition.groups if g not in remote.groups
        )
    return alerts


def knowledge_alerts(
    definition: AgentDefinition, knowledge: Mapping[str, KnowledgeBase]
) -> dict[str, tuple[str, ...]]:
    """The alert of D26 (D88 (15), (26)), by knowledge base: the groups of the agent with no
    group of the knowledge base. Their people use the agent but get no answers from it. Not a
    rule: it never blocks a version. People the agent is shared with one by one are not
    looked at here: their groups are in their token."""
    alerts: dict[str, tuple[str, ...]] = {}
    for kb_id in definition.knowledge_bases:
        kb = knowledge.get(kb_id)
        if kb is None:
            continue
        without = tuple(g for g in definition.groups if g not in kb.groups)
        if without:
            alerts[kb_id] = without
    return alerts


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
        *_knowledge(definition, ctx),
        *_skills(definition, ctx),
    ]
