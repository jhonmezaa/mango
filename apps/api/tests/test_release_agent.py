"""The agent that ships with the release (FinOps, D34): its definition and its seed."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from mango_api.agent_rules import RuleContext, validate_for_review
from mango_api.agents_store import AgentsStore
from mango_api.authz import AgentResource, Authorizer
from mango_api.mcp_catalog import McpCatalog
from mango_api.model_catalog import ModelCatalog, ModelEntry
from mango_core.agents import (
    AgentStatus,
    VersionStatus,
    content_hash,
    dumps_definition,
    is_agent_id,
    loads_definition,
    verify_content,
)
from mango_core.groups import GroupDef
from mango_core.identity import user_from_claims

from .cedar_fake import CedarPolicyStore
from .release_seed import APPROVER, release_definition, seed_release_agent
from .test_agents_store import TABLE, db, store  # noqa: F401 - fixtures

MODEL = "us.anthropic.claude-sonnet-4-6"
CONNECTORS = Path(__file__).parents[3] / "connectors"


def test_definition_is_stored_as_the_stack_writes_it() -> None:
    # `infra/test/release-agents.test.ts` pins the same hash from TypeScript: the stack and
    # Python must produce the same bytes. It changes with any change to
    # agents/finops/agent.json: update both on purpose.
    canonical = dumps_definition(release_definition("finops", MODEL))
    assert content_hash(canonical) == (
        "d68ea3956b28a1989caba25e0169cb9755294804b05bccf759860c3ee968f5e9"
    )
    # Reading it back and writing it again changes nothing.
    assert dumps_definition(loads_definition(canonical)) == canonical


def test_finops_keeps_its_prompt_tools_and_limits() -> None:
    definition = release_definition("finops", MODEL)
    assert definition.system_prompt.startswith("You are Mango FinOps, an assistant that helps")
    assert definition.system_prompt.endswith("the platform handles identity.")
    assert definition.system_prompt.count("\n") == 21
    limits = definition.limits
    assert (limits.max_iterations, limits.max_tokens, limits.timeout_seconds) == (12, 8000, 300)
    assert (limits.max_tokens_per_call, limits.temperature) == (4000, 0.2)
    catalog = McpCatalog.load(CONNECTORS)
    (connector,) = (c for c in catalog.connectors if c.id == "cost-explorer")
    assert set(definition.tools) == {f"cost-explorer.{t.name}" for t in connector.tools}
    assert definition.approval_tools == ()
    assert (definition.model, definition.allowed_models) == (MODEL, (MODEL,))
    assert is_agent_id("finops")


def test_definition_passes_the_rules_every_agent_must_pass() -> None:
    """The release approves it instead of a person; it still is a valid agent (D18, D35)."""

    class Org:
        def supervisor_of(self, _agent_id: str) -> str | None:
            return None

    model = ModelEntry(
        id=MODEL,
        name=MODEL,
        provider="anthropic",
        enabled=True,
        supports_tools=True,
        input_usd=3,  # type: ignore[arg-type]
        output_usd=15,  # type: ignore[arg-type]
        cache_read_usd=0,  # type: ignore[arg-type]
        cache_write_usd=0,  # type: ignore[arg-type]
    )
    groups = {
        "finops-central": GroupDef("finops-central", "central", None, "FinOps central"),
        "bu-lead": GroupDef("bu-lead", "general", None, "Líderes de área"),
    }
    ctx = RuleContext(
        catalog=McpCatalog.load(CONNECTORS),
        models=ModelCatalog(models=(model,), version=1),
        groups=groups,
        org=Org(),
    )
    assert validate_for_review("finops", release_definition("finops", MODEL), ctx) == []


def test_seed_is_an_approved_first_version_nobody_published(db: Any, store: AgentsStore) -> None:  # noqa: F811
    digest = seed_release_agent(db, TABLE, "finops", MODEL)
    meta = store.meta("finops")
    version = store.version("finops", 1)
    assert meta is not None and version is not None
    assert (meta.status, meta.open_version, meta.published_version) == (AgentStatus.DRAFT, 1, None)
    assert (version.status, version.approved_by) == (VersionStatus.APPROVED, APPROVER)
    assert version.content_hash == digest
    assert verify_content(version.canonical, digest)
    assert store.published_pointer("finops") is None
    # It is in the queue the provisioner's work shows up in.
    assert [v.agent_id for v in store.by_status(VersionStatus.APPROVED)] == ["finops"]


@pytest.mark.parametrize(
    ("claims", "allowed"),
    [
        ({"mango_role": "finops-central", "cognito:groups": ["finops-central"]}, True),
        (
            {
                "mango_role": "bu-lead",
                "mango_business_unit": "security",
                "cognito:groups": ["bu-lead", "bu-security"],
            },
            True,
        ),
        ({"cognito:groups": ["mango-admin"], "mango_admin": "true"}, False),
        ({"cognito:groups": ["hr"]}, False),
        ({"cognito:groups": ["mango-agent-creator"]}, False),
    ],
)
def test_finops_is_used_by_its_groups_like_any_other_agent(
    claims: dict[str, Any], allowed: bool
) -> None:
    definition = release_definition("finops", MODEL)
    authorizer = Authorizer(CedarPolicyStore(), "ps")  # type: ignore[arg-type]
    user = user_from_claims({"sub": "user-1", **claims})
    resource = AgentResource("finops", groups=frozenset(definition.groups))
    assert authorizer.is_allowed(user, "UseAgent", "Mango::Agent", "finops", resource) is allowed
