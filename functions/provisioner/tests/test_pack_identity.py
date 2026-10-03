"""Packs over account data (``central_only``, D37): the pack acts as the calling user through
the broker, only central users reach its tools, and nothing of that comes from a request."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import cedarpy
import pytest
import yaml

from mango_packs.manifest import PackManifest
from mango_provisioner.errors import StepError
from mango_provisioner.packs.config import ConfigError, PackSettings
from mango_provisioner.packs.gateway import policy_statements
from mango_provisioner.packs.release import check_manifest
from mango_provisioner.packs.role import role_policy

from .pack_lab import (
    BROKER_ARN,
    GATEWAY_ARN,
    PACK,
    PACK_SECURITY_GROUP,
    SUBNETS,
    TARGET_ARN,
    TOOLS,
    PackLab,
    Signer,
    account_data_manifest,
    env,
    manifest_data,
)

REPO = Path(__file__).resolve().parents[3]
RUNTIME = "Mango_test_mcp_aws_pricing"
TOOL_NAMES = sorted(tool["name"] for tool in TOOLS)
CATALOG = {PACK: {"version": "1.1.1-1", "statement_sha256": "a" * 64}}
SETTINGS = PackSettings.from_env(env(Signer().public_pem, CATALOG))


def _account_data(lab: PackLab, **overrides: Any) -> dict[str, Any]:
    """Release the pack as a ``central_only`` pack and stage its approved enablement."""
    lab.release(lab.signer.statement(account_data_manifest(**overrides)))
    return lab.approve()


# --- Cedar L2: only central users, whatever else the engine holds (TM-M3) -----------------


def _decision(statements: list[str], tool: str, tags: dict[str, str], *, pack: str = PACK) -> bool:
    """Evaluate generated policies as the Gateway does: token claims are tags of the user."""
    entities = [
        {
            "uid": {"type": "AgentCore::OAuthUser", "id": "user-1"},
            "attrs": {},
            "parents": [],
            "tags": tags,
        },
        {"uid": {"type": "AgentCore::Gateway", "id": GATEWAY_ARN}, "attrs": {}, "parents": []},
    ]
    request = {
        "principal": 'AgentCore::OAuthUser::"user-1"',
        "action": f'AgentCore::Action::"{pack}___{tool}"',
        "resource": f'AgentCore::Gateway::"{GATEWAY_ARN}"',
        "context": {},
    }
    result = cedarpy.is_authorized(request, "\n".join(statements), entities)
    assert result.diagnostics.errors == []
    return bool(result.decision == cedarpy.Decision.Allow)


AREA_USERS: list[dict[str, str]] = [
    {},
    {"mango_role": "bu-lead", "mango_bu": "retail"},
    {"mango_central": "false"},
    {"mango_central": "TRUE"},
    # A FinOps role is not the claim: only the group registry makes a user central (D44).
    {"mango_role": "finops-central"},
]


@pytest.mark.parametrize("tags", AREA_USERS)
def test_area_users_are_denied_by_l2_even_if_the_agent_has_the_tool(tags: dict[str, str]) -> None:
    statements = policy_statements(SETTINGS, PACK, TOOL_NAMES, central=True)
    for tool in TOOL_NAMES:
        assert not _decision(statements, tool, tags)


def test_central_users_are_permitted() -> None:
    statements = policy_statements(SETTINGS, PACK, TOOL_NAMES, central=True)
    for tool in TOOL_NAMES:
        assert _decision(statements, tool, {"mango_central": "true"})
    # Only the pack's own tools, on this Gateway.
    assert not _decision(statements, "other_tool", {"mango_central": "true"})


def test_the_billing_pack_of_the_release_gets_the_same_limits() -> None:
    """Its tool names carry hyphens (``cost-explorer``): they are still exact Cedar actions."""
    manifest = PackManifest.model_validate(
        yaml.safe_load((REPO / "packs" / "aws-billing" / "manifest.yaml").read_text())
    )
    assert manifest.central_only
    tools = sorted(manifest.tool_names)
    statements = policy_statements(SETTINGS, manifest.id, tools, central=True)
    assert [s.split(" ")[0] for s in statements] == ["permit", "forbid"]
    for tool in tools:
        assert _decision(statements, tool, {"mango_central": "true"}, pack=manifest.id)
        for tags in AREA_USERS:
            assert not _decision(statements, tool, tags, pack=manifest.id)
    # A name that only shares a prefix is another action.
    assert not _decision(statements, "cost", {"mango_central": "true"}, pack=manifest.id)
    assert not _decision(statements, "cost-explorer", {"mango_central": "true"})


@pytest.mark.parametrize("tags", AREA_USERS)
def test_no_other_policy_can_open_account_data_to_area_users(tags: dict[str, str]) -> None:
    """The limit is also a ``forbid``: a permit added to the engine later does not win."""
    wide_open = "permit (principal, action, resource);"
    statements = [*policy_statements(SETTINGS, PACK, TOOL_NAMES, central=True), wide_open]
    assert not _decision(statements, TOOL_NAMES[0], tags)
    assert _decision(statements, TOOL_NAMES[0], {"mango_central": "true"})


def test_public_packs_keep_their_single_permit() -> None:
    (statement,) = policy_statements(SETTINGS, PACK, TOOL_NAMES)
    assert statement.startswith("permit (") and "mango_central" not in statement
    assert _decision([statement], TOOL_NAMES[0], {})


def test_central_policies_are_split_in_pairs() -> None:
    tools = [f"tool_{'x' * 50}_{n:03d}" for n in range(100)]
    statements = policy_statements(SETTINGS, PACK, tools, central=True)
    assert len(statements) % 2 == 0 and len(statements) > 2
    assert [s.split(" ")[0] for s in statements] == ["permit", "forbid"] * (len(statements) // 2)
    for tool in tools:
        assert sum(f'"{PACK}___{tool}"' in s for s in statements) == 2


# --- Manifest limits of the installation ----------------------------------------------------


def test_the_pack_role_gets_no_data_action_only_the_broker() -> None:
    document = role_policy(SETTINGS, PACK, [], broker=True)
    statements = {s["Sid"]: s for s in document["Statement"]}
    assert statements["AssumeBroker"] == {
        "Sid": "AssumeBroker",
        "Effect": "Allow",
        "Action": ["sts:AssumeRole", "sts:SetSourceIdentity", "sts:TagSession"],
        "Resource": BROKER_ARN,
    }
    assert set(statements) == {"AssumeBroker", "RuntimeLogs", "Tracing", "Metrics"}
    # A public pack never gets the broker.
    assert "AssumeBroker" not in json.dumps(role_policy(SETTINGS, PACK, []))


def test_an_action_the_role_behind_the_broker_does_not_allow_is_refused() -> None:
    greedy = account_data_manifest(
        iam=[{"actions": ["ce:GetCostAndUsage", "s3:GetObject"], "resources": ["*"], "reason": "x"}]
    )
    with pytest.raises(StepError, match="action_outside_broker"):
        check_manifest(SETTINGS, PackManifest.model_validate(greedy))
    # The list of a public pack's boundary does not apply either way.
    public_action = account_data_manifest(
        iam=[{"actions": ["pricing:GetProducts"], "resources": ["*"], "reason": "x"}]
    )
    with pytest.raises(StepError, match="action_outside_broker"):
        check_manifest(SETTINGS, PackManifest.model_validate(public_action))
    with pytest.raises(StepError, match="action_outside_boundary"):
        check_manifest(
            SETTINGS,
            PackManifest.model_validate(
                manifest_data(
                    iam=[{"actions": ["ce:GetCostAndUsage"], "resources": ["*"], "reason": "x"}]
                )
            ),
        )


def test_an_installation_without_broker_installs_no_account_data_pack(packlab: PackLab) -> None:
    lab = packlab
    lab.broker = False
    request = _account_data(lab)
    assert lab.settings.can_broker is False
    result = lab.run(request)
    assert result["failure"] == "identity_unavailable"
    assert lab.agentcore.writes() == [] and not lab.role_exists()


def test_an_account_data_pack_runs_on_the_pack_network(packlab: PackLab) -> None:
    """R6: every pack runtime is in the pack VPC, with the security group the stack built for
    it. There is no lab-only exception any more (D49 (7) is retired)."""
    lab = packlab
    assert lab.run(_account_data(lab))["enabled"] is True
    assert lab.agentcore.runtime()["versions"][-1]["config"]["networkConfiguration"] == {
        "networkMode": "VPC",
        "networkModeConfig": {"subnets": SUBNETS, "securityGroups": [PACK_SECURITY_GROUP]},
    }


def test_a_pack_without_a_security_group_is_not_installed(packlab: PackLab) -> None:
    """The stack builds the network of each pack of the release from its signed manifest.
    Without it the pack has nowhere to run: it never falls back to the PUBLIC network."""
    lab = packlab
    lab.network = {"subnets": SUBNETS, "security_groups": {"another-pack": PACK_SECURITY_GROUP}}
    lab.build(lab.publish(lab.statement))
    result = lab.run(lab.approve())
    assert result["failure"] == "egress_unavailable"
    assert lab.agentcore.writes() == [] and not lab.role_exists()


def test_a_pack_that_declares_external_hosts_is_not_installed(packlab: PackLab) -> None:
    lab = packlab
    manifest = manifest_data(egress={"aws": ["pricing"], "hosts": ["api.example.com"]})
    lab.release(lab.signer.statement(manifest))
    result = lab.run(lab.approve())
    assert result["failure"] == "external_egress_unsupported"
    assert lab.agentcore.writes() == [] and not lab.role_exists()


def test_a_runtime_version_on_another_network_is_never_exposed(packlab: PackLab) -> None:
    """A version on the PUBLIC network, or with another security group, fails before `live`
    points at it."""
    lab = packlab
    request = lab.approve()
    state = lab.provisioner.load(request, "exec-1")
    state = lab.provisioner.ensure_role(state)
    state = lab.provisioner.ensure_runtime(state)
    version = lab.agentcore.runtime()["versions"][-1]
    version["config"]["networkConfiguration"] = {"networkMode": "PUBLIC"}
    with pytest.raises(StepError, match="runtime_network_mismatch"):
        lab.provisioner.check_runtime(state)
    version["config"]["networkConfiguration"] = {
        "networkMode": "VPC",
        "networkModeConfig": {"subnets": SUBNETS, "securityGroups": ["sg-0cccccccccccccccc"]},
    }
    with pytest.raises(StepError, match="runtime_network_mismatch"):
        lab.provisioner.check_runtime(state)


@pytest.mark.parametrize(
    "network",
    [
        "",
        "[]",
        '{"subnets": [], "security_groups": {"aws-pricing": "sg-0bbbbbbbbbbbbbbb1"}}',
        json.dumps({"subnets": SUBNETS[:1], "security_groups": {PACK: PACK_SECURITY_GROUP}}),
        json.dumps({"subnets": [SUBNETS[0], SUBNETS[0]], "security_groups": {}}),
        '{"subnets": ["vpc-0aaaaaaaaaaaaaaa1", "subnet-0aaaaaaaaaaaaaaa2"], "security_groups": {}}',
        '{"subnets": [], "security_groups": {"Bad Pack": "sg-0bbbbbbbbbbbbbbb1"}}',
        '{"subnets": [], "security_groups": {}, "mode": "PUBLIC"}',
    ],
)
def test_the_pack_network_setting_is_strict(network: str) -> None:
    with pytest.raises(ConfigError, match="PACK_NETWORK"):
        PackSettings.from_env({**env(None, {}), "PACK_NETWORK": network})
    missing = {k: v for k, v in env(None, {}).items() if k != "PACK_NETWORK"}
    with pytest.raises(ConfigError, match="PACK_NETWORK"):
        PackSettings.from_env(missing)


def test_a_release_without_packs_has_no_pack_network() -> None:
    settings = PackSettings.from_env(
        {**env(None, {}), "PACK_NETWORK": '{"subnets": [], "security_groups": {}}'}
    )
    assert settings.network.subnets == () and not settings.network.security_groups


@pytest.mark.parametrize(
    "name", ["PACK_BROKER_ROLE_ARN", "PACK_TARGET_ROLE_ARN", "PACK_IDENTITY_KEY_ARN"]
)
def test_broker_settings_must_be_arns(name: str) -> None:
    with pytest.raises(ConfigError, match=name):
        PackSettings.from_env({**env(None, {}), name: "arn:aws:iam::123:role/*"})


# --- End to end -------------------------------------------------------------------------------


def test_enable_installs_an_account_data_pack_that_acts_through_the_broker(
    packlab: PackLab,
) -> None:
    lab = packlab
    assert lab.run(_account_data(lab))["enabled"] is True

    # The role: no data permission of its own (rule 5), only the broker.
    assert lab.role_actions() == []
    sids = {s["Sid"]: s for s in lab.role_document()["Statement"]}
    assert sids["AssumeBroker"]["Resource"] == BROKER_ARN
    assert "ce:GetCostAndUsage" not in json.dumps(lab.role_document())

    # The runtime: where the broker is and the public key that verifies callers. No secrets.
    environment = lab.agentcore.runtime()["versions"][-1]["config"]["environmentVariables"]
    assert environment["MANGO_PACK_BROKER_ROLE_ARN"] == BROKER_ARN
    assert environment["MANGO_PACK_TARGET_ROLE_ARN"] == TARGET_ARN
    assert environment["MANGO_PACK_REGION"] == lab.settings.region
    assert base64.b64decode(environment["MANGO_PACK_IDENTITY_PUBLIC_KEY"]) == lab.kms.public_der
    assert set(lab.kms.calls) == {lab.settings.identity_key_arn}

    # Cedar L2: permit for central users and the same limit as a forbid.
    policies = lab.agentcore.pack_policies()
    assert sorted(policies) == [f"{RUNTIME}_1", f"{RUNTIME}_2"]
    assert all(p["status"] == "ACTIVE" for p in policies.values())
    statements = [policies[name]["statement"] for name in sorted(policies)]
    assert statements == policy_statements(lab.settings, PACK, TOOL_NAMES, central=True)
    assert not _decision(statements, TOOL_NAMES[0], {"mango_role": "bu-lead"})

    # The pointer says what kind of data the installed version serves (mango-api reads it).
    installed = lab.installed()
    assert installed is not None
    assert (installed["data_tier"], installed["identity_mode"]) == ("account_data", "central_only")
    assert json.loads(installed["grants"]) == [
        {"actions": ["ce:GetCostAndUsage"], "resources": ["*"]}
    ]


def test_a_public_pack_records_its_tier_and_gets_nothing_of_the_broker(packlab: PackLab) -> None:
    lab = packlab
    lab.run(lab.approve())
    installed = lab.installed()
    assert installed is not None
    assert (installed["data_tier"], installed["identity_mode"]) == ("public", "service")
    environment = lab.agentcore.runtime()["versions"][-1]["config"]["environmentVariables"]
    assert not [name for name in environment if "BROKER" in name or "IDENTITY" in name]
    assert "AssumeBroker" not in json.dumps(lab.role_document())
    assert lab.kms.calls == []


def test_a_wrong_identity_key_is_refused(packlab: PackLab) -> None:
    lab = packlab
    lab.kms.key_spec = "RSA_2048"
    result = lab.run(_account_data(lab))
    assert result["failure"] == "identity_key_invalid"
    assert not lab.role_exists()


def test_a_failed_first_installation_of_an_account_data_pack_leaves_nothing(
    packlab: PackLab,
) -> None:
    lab = packlab
    result = lab.run(_account_data(lab), fail_at="ensure_policies")
    assert result["marked"] is True
    assert lab.agentcore.pack_policies() == {} and lab.agentcore.pack_target() is None
    assert not lab.role_exists() and lab.installed() is None


def test_update_from_public_to_account_data_never_serves_under_the_old_policies(
    packlab: PackLab,
) -> None:
    """Same tools, other audience: the permit of the public version goes before ``live``
    moves to the version that reads account data."""
    lab = packlab
    lab.run(lab.approve())
    (public_policy,) = lab.agentcore.pack_policies().values()
    assert "mango_central" not in public_policy["statement"]

    lab.release(lab.signer.statement(account_data_manifest(version="1.1.1-2"), revision="2" * 40))
    p = lab.provisioner
    request = lab.approve("enablement-0002", version="1.1.1-2")
    state = p.load(request, "exec-2")
    state = p.ensure_role(state)
    # While the public version still serves, the role keeps its actions and gains the broker.
    assert lab.role_actions() == ["pricing:DescribeServices", "pricing:GetProducts"]
    assert "AssumeBroker" in json.dumps(lab.role_document())
    assert lab.run(request, "exec-2")["enabled"] is True

    order = lab.agentcore.writes()
    assert order.index("DeletePolicy") < order.index("UpdateAgentRuntimeEndpoint")
    statements = [p["statement"] for p in lab.agentcore.pack_policies().values()]
    assert len(statements) == 2 and all("mango_central" in s for s in statements)
    # Only the new version's access remains: the broker, no data action.
    assert lab.role_actions() == []
    installed = lab.installed()
    assert installed is not None and installed["identity_mode"] == "central_only"


def test_a_failed_update_of_an_account_data_pack_goes_back_to_its_policies(
    packlab: PackLab,
) -> None:
    lab = packlab
    lab.run(_account_data(lab))
    before = {n: p["statement"] for n, p in lab.agentcore.pack_policies().items()}

    newer = account_data_manifest(version="1.1.1-2")
    lab.release(lab.signer.statement(newer, revision="3" * 40))
    result = lab.run(
        lab.approve("enablement-0002", version="1.1.1-2"), "exec-2", fail_at="ensure_target"
    )
    assert result["compensated"] is True
    after = {n: p["statement"] for n, p in lab.agentcore.pack_policies().items()}
    assert after == before
    assert lab.role_actions() == [] and "AssumeBroker" in json.dumps(lab.role_document())
    assert lab.agentcore.runtime()["live"]["live"] == "1"


def test_disable_removes_an_account_data_pack(packlab: PackLab) -> None:
    lab = packlab
    lab.run(_account_data(lab))
    assert lab.run(lab.disable(), "exec-2")["disabled"] is True
    assert lab.agentcore.pack_policies() == {} and lab.agentcore.pack_target() is None
    assert not lab.role_exists() and lab.installed() is None
