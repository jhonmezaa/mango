"""The platform Cedar policies (L1), evaluated for real through ``mango_api.authz``."""

from __future__ import annotations

import re

import cedarpy
import pytest

from mango_api.authz import AGENT_TYPE, PLATFORM, AgentResource, Authorizer
from mango_core.identity import UserContext

from .cedar_fake import CedarPolicyStore, policy_files, schema

ADMIN = UserContext("admin-1", None, None, True, groups=frozenset({"mango-admin"}))
CREATOR = UserContext("creator-1", None, None, False, groups=frozenset({"mango-agent-creator"}))
OTHER_CREATOR = UserContext(
    "creator-2", None, None, False, groups=frozenset({"mango-agent-creator", "hr"})
)
FORMER_CREATOR = UserContext("creator-1", None, None, False, groups=frozenset({"hr"}))
MEMBER = UserContext("member-1", None, None, False, groups=frozenset({"hr"}))
LEAD = UserContext("lead-1", "bu-lead", "security", False, groups=frozenset({"bu-lead"}))
EVERYONE = (ADMIN, CREATOR, OTHER_CREATOR, FORMER_CREATOR, MEMBER, LEAD)

AGENT = "abcdefghijklmnop"


@pytest.fixture
def store() -> CedarPolicyStore:
    return CedarPolicyStore()


@pytest.fixture
def authz(store: CedarPolicyStore) -> Authorizer:
    return Authorizer(store, "ps")  # type: ignore[arg-type]


def test_policies_validate_against_the_schema_in_strict_mode() -> None:
    result = cedarpy.validate_policies("\n".join(policy_files().values()), schema())
    assert result.validation_passed, result.errors


def test_each_file_holds_exactly_one_policy() -> None:
    # IaC creates one static policy per file (`governance.ts`); a second statement would not
    # deploy, and a `forbid` or an unconditional permit must never slip in.
    for name, text in policy_files().items():
        code = re.sub(r"//.*", "", text)
        assert len(re.findall(r"\bpermit\s*\(", code)) == 1, name
        assert "forbid" not in code, name
        assert re.search(r"\bwhen\s*\{", code), name


@pytest.mark.parametrize("action", ["CreateAgent", "ViewMcpCatalog"])
def test_creating_is_for_admins_and_creators(authz: Authorizer, action: str) -> None:
    allowed = {u.user_id for u in EVERYONE if authz.is_allowed(u, action, *PLATFORM)}
    assert allowed == {"admin-1", "creator-1", "creator-2"}
    assert FORMER_CREATOR.user_id == CREATOR.user_id  # same person, no longer a creator
    assert not authz.is_allowed(FORMER_CREATOR, action, *PLATFORM)


@pytest.mark.parametrize("action", ["ProposeGroups", "ApproveGroups"])
def test_changing_access_groups_is_for_admins_only(authz: Authorizer, action: str) -> None:
    # Creators read the registry (``ViewGroups``) but never change it (D26, TM-M13).
    allowed = {u.user_id for u in EVERYONE if authz.is_allowed(u, action, *PLATFORM)}
    assert allowed == {"admin-1"}


def test_reviewing_and_retiring_are_for_admins_only(authz: Authorizer) -> None:
    resource = AgentResource(AGENT, creator="creator-1")
    for user in EVERYONE:
        expected = user.is_admin
        assert authz.is_allowed(user, "ApproveAgent", *PLATFORM) is expected
        assert authz.is_allowed(user, "ApproveAgent", AGENT_TYPE, AGENT, resource) is expected
        assert authz.is_allowed(user, "RetireAgent", AGENT_TYPE, AGENT, resource) is expected


def test_editing_is_for_admins_and_for_the_creator_while_still_a_creator(
    authz: Authorizer,
) -> None:
    own = AgentResource(AGENT, creator="creator-1")
    assert authz.is_allowed(ADMIN, "EditAgent", AGENT_TYPE, AGENT, own)
    assert authz.is_allowed(CREATOR, "EditAgent", AGENT_TYPE, AGENT, own)
    assert not authz.is_allowed(OTHER_CREATOR, "EditAgent", AGENT_TYPE, AGENT, own)
    assert not authz.is_allowed(FORMER_CREATOR, "EditAgent", AGENT_TYPE, AGENT, own)
    assert not authz.is_allowed(MEMBER, "EditAgent", AGENT_TYPE, AGENT, own)
    # Without the creator attribute (agent not found) only administrators match.
    assert not authz.is_allowed(CREATOR, "EditAgent", AGENT_TYPE, AGENT, AgentResource(AGENT))
    assert not authz.is_allowed(CREATOR, "EditAgent", AGENT_TYPE, AGENT)
    assert authz.is_allowed(ADMIN, "EditAgent", AGENT_TYPE, AGENT)


def test_using_an_agent_is_decided_by_its_groups_and_users(authz: Authorizer) -> None:
    by_group = AgentResource(AGENT, groups=frozenset({"hr", "ops"}))
    assert authz.is_allowed(MEMBER, "UseAgent", AGENT_TYPE, AGENT, by_group)
    assert authz.is_allowed(OTHER_CREATOR, "UseAgent", AGENT_TYPE, AGENT, by_group)
    assert not authz.is_allowed(LEAD, "UseAgent", AGENT_TYPE, AGENT, by_group)
    # Neither administrators nor the creator get to use an agent that was not shared with them.
    assert not authz.is_allowed(ADMIN, "UseAgent", AGENT_TYPE, AGENT, by_group)
    owned = AgentResource(AGENT, creator="creator-1", groups=frozenset({"ops"}))
    assert not authz.is_allowed(CREATOR, "UseAgent", AGENT_TYPE, AGENT, owned)

    by_user = AgentResource(AGENT, users=frozenset({"lead-1"}))
    assert authz.is_allowed(LEAD, "UseAgent", AGENT_TYPE, AGENT, by_user)
    assert not authz.is_allowed(MEMBER, "UseAgent", AGENT_TYPE, AGENT, by_user)


def test_an_agent_without_attributes_matches_nobody(authz: Authorizer) -> None:
    for user in EVERYONE:
        assert not authz.is_allowed(user, "UseAgent", AGENT_TYPE, AGENT)
        assert not authz.is_allowed(user, "UseAgent", AGENT_TYPE, AGENT, AgentResource(AGENT))


def test_a_group_name_never_matches_a_user_id(authz: Authorizer) -> None:
    # `users` holds entity references and `groups` strings: neither can stand for the other.
    resource = AgentResource(AGENT, groups=frozenset({"member-1"}), users=frozenset({"hr"}))
    assert not authz.is_allowed(MEMBER, "UseAgent", AGENT_TYPE, AGENT, resource)


def test_the_release_agent_is_used_through_its_groups_like_any_other(authz: Authorizer) -> None:
    # No policy names an agent any more: a FinOps role alone opens nothing (D33, D34).
    assert not authz.is_allowed(LEAD, "UseAgent", AGENT_TYPE, "finops")
    finops = AgentResource("finops", groups=frozenset({"bu-lead", "finops-central"}))
    assert authz.is_allowed(LEAD, "UseAgent", AGENT_TYPE, "finops", finops)
    assert not authz.is_allowed(MEMBER, "UseAgent", AGENT_TYPE, "finops", finops)
    assert not authz.is_allowed(CREATOR, "UseAgent", AGENT_TYPE, "finops", finops)


def test_agent_actions_do_not_apply_to_the_platform(
    authz: Authorizer, store: CedarPolicyStore
) -> None:
    # The schema rejects the request and the authorizer fails closed.
    assert not authz.is_allowed(ADMIN, "RetireAgent", *PLATFORM)
    assert not authz.is_allowed(ADMIN, "CreateAgent", AGENT_TYPE, AGENT)
    assert not authz.is_allowed(ADMIN, "DeleteAgent", AGENT_TYPE, AGENT)
    assert len(store.errors) == 3


def test_attributes_of_another_agent_are_never_used(authz: Authorizer) -> None:
    other = AgentResource("zzzzzzzzzzzzzzzz", groups=frozenset({"hr"}))
    assert not authz.is_allowed(MEMBER, "UseAgent", AGENT_TYPE, AGENT, other)
    assert not authz.is_allowed(MEMBER, "UseAgent", "Mango::Platform", "mango", other)


def test_lists_are_filtered_in_batches(authz: Authorizer, store: CedarPolicyStore) -> None:
    agents = [
        AgentResource(f"agent{i:02d}", groups=frozenset({"hr" if i % 2 else "ops"}))
        for i in range(70)
    ]
    allowed = authz.allowed_agents(MEMBER, "UseAgent", agents)
    assert allowed == {f"agent{i:02d}" for i in range(70) if i % 2}
    assert len(store.decisions) == 70
    assert store.errors == []
    assert authz.allowed_agents(MEMBER, "UseAgent", []) == frozenset()


def test_a_failed_batch_denies_its_agents(authz: Authorizer, store: CedarPolicyStore) -> None:
    store.fail = True
    agents = [AgentResource("agent01", groups=frozenset({"hr"}))]
    assert authz.allowed_agents(MEMBER, "UseAgent", agents) == frozenset()
    assert not authz.is_allowed(ADMIN, "ApproveAgent", *PLATFORM)


@pytest.mark.parametrize("action", ["EnableMcp", "ApproveMcp"])
def test_mcp_packs_are_decided_by_admins_only(authz: Authorizer, action: str) -> None:
    # Creators read the catalog (`ViewMcpCatalog`) but never ask for or approve a pack.
    allowed = {u.user_id for u in EVERYONE if authz.is_allowed(u, action, *PLATFORM)}
    assert allowed == {"admin-1"}
    assert not authz.is_allowed(ADMIN, action, AGENT_TYPE, AGENT, AgentResource(AGENT))


# --- Write tools with approval (D27) --------------------------------------------------------

CENTRAL = UserContext("central-1", "finops-central", None, False, groups=frozenset({"finops"}))
NO_GROUP = UserContext("new-1", None, None, False)


def test_any_mango_user_reads_approvals(authz: Authorizer) -> None:
    # Which requests each one sees is decided per object by mango-api (TM-W9).
    for user in (*EVERYONE, CENTRAL, NO_GROUP):
        assert authz.is_allowed(user, "ViewApprovals", *PLATFORM), user.user_id


def test_tool_calls_are_approved_by_admins_and_central_finops(authz: Authorizer) -> None:
    people = (*EVERYONE, CENTRAL)
    allowed = {u.user_id for u in people if authz.is_allowed(u, "ApproveToolCall", *PLATFORM)}
    assert allowed == {"admin-1", "central-1"}
    # An area lead has a role, but not the central one.
    assert not authz.is_allowed(LEAD, "ApproveToolCall", *PLATFORM)


@pytest.mark.parametrize("action", ["ProposeToolPolicy", "ApproveToolPolicy"])
def test_tool_policies_are_changed_by_admins_only(authz: Authorizer, action: str) -> None:
    people = (*EVERYONE, CENTRAL)
    allowed = {u.user_id for u in people if authz.is_allowed(u, action, *PLATFORM)}
    assert allowed == {"admin-1"}
