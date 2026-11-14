"""Packs whose network a stack parameter switches (D54, precision of 2026-11-13).

The endpoints of such a pack exist only while its parameter of the pack network is
``Enabled``. The stack writes the parameter's value to SSM; the provisioner reads it before it
installs the pack and refuses one whose network is off, instead of installing a pack whose
every call would fail.
"""

from __future__ import annotations

import re

import pytest

from mango_provisioner.packs.ceilings import BROKERED_ACTIONS, MEMBER_ACTIONS
from mango_provisioner.packs.config import ConfigError, PackSettings

from .pack_lab import NS, PACK, PACK_SECURITY_GROUP, SUBNETS, PackLab, Signer, env

CATALOG = {PACK: {"version": "1.1.1-1", "statement_sha256": "a" * 64}}
SWITCHED = {"subnets": SUBNETS, "security_groups": {PACK: PACK_SECURITY_GROUP}, "switched": [PACK]}


def _switch(lab: PackLab, value: str | None) -> None:
    if value is not None:
        lab.ssm.put_parameter(
            Name=f"/Mango-{NS}-pack-network/{PACK}", Value=value, Type="String", Overwrite=True
        )
    lab.network = SWITCHED
    lab.build(lab.publish(lab.statement))


@pytest.mark.parametrize("value", [None, "Disabled", "enabled", ""])
def test_a_switched_pack_whose_network_is_off_is_not_installed(
    packlab: PackLab, value: str | None
) -> None:
    lab = packlab
    if value == "":
        # SSM refuses an empty value: what a parameter that never existed looks like instead.
        value = None
    _switch(lab, value)
    result = lab.run(lab.approve())
    assert result["failure"] == "pack_network_disabled"
    assert lab.agentcore.writes() == [] and not lab.role_exists()


def test_a_switched_pack_whose_network_is_on_is_installed(packlab: PackLab) -> None:
    lab = packlab
    _switch(lab, "Enabled")
    assert lab.run(lab.approve())["enabled"] is True


def test_a_pack_that_is_not_switched_needs_no_switch(packlab: PackLab) -> None:
    """The packs whose network is always on install as before: nothing is read from SSM."""
    lab = packlab
    assert lab.network.get("switched") is None
    assert lab.run(lab.approve())["enabled"] is True


def test_the_switch_is_named_after_the_installation_and_the_pack() -> None:
    settings = PackSettings.from_env(env(Signer().public_pem, CATALOG, network=SWITCHED))
    assert settings.network.switched == frozenset({PACK})
    assert settings.network_switch(PACK) == f"/Mango-{NS}-pack-network/{PACK}"


@pytest.mark.parametrize(
    "switched",
    [["another-pack"], "aws-pricing", [7], {"aws-pricing": True}],
)
def test_only_packs_of_the_network_can_be_switched(switched: object) -> None:
    network = {**SWITCHED, "switched": switched}
    with pytest.raises(ConfigError, match="PACK_NETWORK"):
        PackSettings.from_env(env(Signer().public_pem, CATALOG, network=network))


def test_the_ceilings_are_exact_read_actions_of_the_release() -> None:
    """``infra/test/packs.test.ts`` keeps them equal to the roles of the template; here, their
    form: exact actions, never a wildcard, and the reads the role is limited to."""
    action = re.compile(r"^[a-z0-9-]{1,32}:[A-Za-z0-9]{1,64}$")
    for actions in (BROKERED_ACTIONS, MEMBER_ACTIONS):
        assert actions and all(action.fullmatch(item) for item in actions)
    # Log events and full statement text never reach a member pack (D55 (3)).
    for absent in ("logs:FilterLogEvents", "logs:GetLogEvents", "pi:GetDimensionKeyDetails"):
        assert absent not in MEMBER_ACTIONS
    settings = PackSettings.from_env(env(Signer().public_pem, CATALOG))
    assert settings.member_actions == MEMBER_ACTIONS
    assert settings.brokered_actions == BROKERED_ACTIONS
