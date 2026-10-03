"""Packs of the member chain (``identity.chain: member``, D51): the pack role may only assume
the Read broker, its ceiling is the role of the member accounts, and its runtime learns the
name of that role, never an ARN."""

from __future__ import annotations

import json
from typing import Any

import pytest

from mango_packs.manifest import PackManifest
from mango_provisioner.errors import StepError
from mango_provisioner.packs.config import ConfigError, PackSettings
from mango_provisioner.packs.release import check_manifest
from mango_provisioner.packs.role import role_policy
from mango_provisioner.packs.store import Installed

from .pack_lab import (
    BROKER_ARN,
    MEMBER_BROKER_ARN,
    MEMBER_ROLE_NAME,
    PACK,
    PACK_SECURITY_GROUP,
    SUBNETS,
    PackLab,
    Signer,
    account_data_manifest,
    env,
)

CATALOG = {PACK: {"version": "1.1.1-1", "statement_sha256": "a" * 64}}
ENV = env(Signer().public_pem, CATALOG)
SETTINGS = PackSettings.from_env(ENV)
MEMBER_IAM = [
    {
        "actions": ["cloudwatch:GetMetricData"],
        "resources": ["*"],
        "reason": "GetMetricData does not accept ARNs.",
    },
    {
        "actions": ["cloudwatch:DescribeAlarms"],
        "resources": ["arn:aws:cloudwatch:*:*:alarm:*"],
    },
]


def member_manifest(**overrides: Any) -> dict[str, Any]:
    return account_data_manifest(
        **{"identity": {"chain": "member"}, "iam": MEMBER_IAM, **overrides}
    )


def _member(lab: PackLab, **overrides: Any) -> dict[str, Any]:
    lab.release(lab.signer.statement(member_manifest(**overrides)))
    return lab.approve()


# --- Limits of the installation on a signed manifest ------------------------------------------


def test_the_ceiling_of_a_member_pack_is_the_role_of_the_member_accounts() -> None:
    check_manifest(SETTINGS, PackManifest.model_validate(member_manifest()))
    # An action of the payer chain's role is not one of the member role, and the other way.
    payer_action = [{"actions": ["ce:GetCostAndUsage"], "resources": ["*"], "reason": "No ARNs."}]
    with pytest.raises(StepError, match="action_outside_broker"):
        check_manifest(SETTINGS, PackManifest.model_validate(member_manifest(iam=payer_action)))
    with pytest.raises(StepError, match="action_outside_broker"):
        check_manifest(SETTINGS, PackManifest.model_validate(account_data_manifest(iam=MEMBER_IAM)))
    logs = [{"actions": ["logs:StartQuery"], "resources": ["*"], "reason": "No ARNs."}]
    with pytest.raises(StepError, match="action_outside_broker"):
        check_manifest(SETTINGS, PackManifest.model_validate(member_manifest(iam=logs)))


@pytest.mark.parametrize(
    "missing", ["PACK_MEMBER_BROKER_ROLE_ARN", "PACK_MEMBER_ROLE_NAME", "PACK_IDENTITY_KEY_ARN"]
)
def test_without_the_member_chain_a_member_pack_is_refused(missing: str) -> None:
    settings = PackSettings.from_env({**ENV, missing: ""})
    with pytest.raises(StepError, match="identity_unavailable"):
        check_manifest(settings, PackManifest.model_validate(member_manifest()))


def test_an_installation_that_predates_the_member_chain_still_starts() -> None:
    old = {k: v for k, v in ENV.items() if not k.startswith("PACK_MEMBER_")}
    settings = PackSettings.from_env(old)
    assert settings.can_broker and not settings.can_broker_members
    assert settings.member_actions == frozenset()
    with pytest.raises(StepError, match="identity_unavailable"):
        check_manifest(settings, PackManifest.model_validate(member_manifest()))


def test_a_member_pack_needs_its_security_group_in_the_pack_network() -> None:
    """R6: there is no lab-only exception. A pack runs where the stack built its network."""
    check_manifest(SETTINGS, PackManifest.model_validate(member_manifest()))
    network = {"subnets": SUBNETS, "security_groups": {"another-pack": PACK_SECURITY_GROUP}}
    settings = PackSettings.from_env(env(Signer().public_pem, CATALOG, network=network))
    with pytest.raises(StepError, match="egress_unavailable"):
        check_manifest(settings, PackManifest.model_validate(member_manifest()))


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("PACK_MEMBER_BROKER_ROLE_ARN", "arn:aws:iam::123:role/*"),
        ("PACK_MEMBER_ROLE_NAME", "arn:aws:iam::111122223333:role/Mango-test-ReadOnly"),
        ("PACK_MEMBER_ROLE_NAME", "Mango-*"),
        ("PACK_MEMBER_ACTIONS", '["cloudwatch:*"]'),
        ("PACK_MEMBER_ACTIONS", "not json"),
    ],
)
def test_member_settings_are_strict(name: str, value: str) -> None:
    with pytest.raises(ConfigError, match="PACK_MEMBER"):
        PackSettings.from_env({**ENV, name: value})


# --- The pack role ----------------------------------------------------------------------------


def test_a_pack_role_may_assume_the_broker_of_its_chain_and_only_that_one() -> None:
    member = role_policy(SETTINGS, PACK, [], broker=True, member=True)
    payer = role_policy(SETTINGS, PACK, [], broker=True)
    for document, broker, other in (
        (member, MEMBER_BROKER_ARN, BROKER_ARN),
        (payer, BROKER_ARN, MEMBER_BROKER_ARN),
    ):
        sids = {s["Sid"]: s for s in document["Statement"]}
        assert sids["AssumeBroker"]["Resource"] == broker
        assert other not in json.dumps(document)
        assert not any(sid.startswith("Manifest") for sid in sids)


def test_no_member_broker_no_role() -> None:
    settings = PackSettings.from_env({**ENV, "PACK_MEMBER_BROKER_ROLE_ARN": ""})
    with pytest.raises(StepError, match="identity_unavailable"):
        role_policy(settings, PACK, [], broker=True, member=True)


# --- End to end -------------------------------------------------------------------------------


def test_enable_installs_a_member_pack_that_acts_through_the_read_broker(
    packlab: PackLab,
) -> None:
    lab = packlab
    assert lab.run(_member(lab))["enabled"] is True

    # The role: no data permission of its own, only the Read broker.
    assert lab.role_actions() == []
    document = lab.role_document()
    sids = {s["Sid"]: s for s in document["Statement"]}
    assert sids["AssumeBroker"]["Resource"] == MEMBER_BROKER_ARN
    assert BROKER_ARN not in json.dumps(document)
    assert "cloudwatch:GetMetricData" not in json.dumps(document)

    # The runtime: the Read broker and the name of the role behind it. No account, no ARN.
    environment = lab.agentcore.runtime()["versions"][-1]["config"]["environmentVariables"]
    assert environment["MANGO_PACK_BROKER_ROLE_ARN"] == MEMBER_BROKER_ARN
    assert environment["MANGO_PACK_TARGET_ROLE_NAME"] == MEMBER_ROLE_NAME
    assert "MANGO_PACK_TARGET_ROLE_ARN" not in environment
    assert environment["MANGO_PACK_REGION"] == lab.settings.region

    # Central users only, like any pack over account data.
    policies = lab.agentcore.pack_policies()
    assert [p["statement"].split(" ")[0] for _, p in sorted(policies.items())] == [
        "permit",
        "forbid",
    ]

    installed = lab.installed()
    assert installed is not None
    assert installed["identity_chain"] == "member"
    assert (installed["data_tier"], installed["identity_mode"]) == ("account_data", "central_only")


def test_a_payer_pack_keeps_the_pointer_it_always_had(packlab: PackLab) -> None:
    lab = packlab
    lab.release(lab.signer.statement(account_data_manifest()))
    assert lab.run(lab.approve())["enabled"] is True
    installed = lab.installed()
    assert installed is not None and "identity_chain" not in installed
    environment = lab.agentcore.runtime()["versions"][-1]["config"]["environmentVariables"]
    assert "MANGO_PACK_TARGET_ROLE_NAME" not in environment


def test_an_update_cannot_move_a_pack_to_another_chain(packlab: PackLab) -> None:
    lab = packlab
    lab.release(lab.signer.statement(account_data_manifest()))
    assert lab.run(lab.approve())["enabled"] is True
    before = lab.role_document()

    lab.release(lab.signer.statement(member_manifest(version="1.1.1-2"), revision="2" * 40))
    request = lab.approve("enablement-0002", version="1.1.1-2")
    result = lab.run(request, "exec-2")
    assert (result["failed_step"], result["failure"]) == ("ensure_role", "identity_chain_changed")
    assert lab.enablement()["status"] == "failed"
    # The installed version keeps serving with the broker it had.
    assert lab.role_document() == before
    installed = lab.installed()
    assert installed is not None and installed["pack_version"] == "1.1.1-1"


def test_the_pointer_remembers_the_chain() -> None:
    base: dict[str, Any] = {
        "enablement_id": "e",
        "pack_version": "1.0.0-1",
        "statement_sha256": "a" * 64,
        "artifact_version_id": "v",
        "runtime_id": "r",
        "runtime_version": "1",
        "target_id": "t",
        "tools": ("a",),
        "grants": [],
        "config": {},
        "data_tier": "account_data",
        "identity_mode": "central_only",
    }
    assert Installed(**base).member_chain is False
    assert "identity_chain" not in Installed(**base).record()
    member = Installed(**base, identity_chain="member")
    assert member.member_chain and member.record()["identity_chain"] == "member"
