import pytest

from mango_core.groups import (
    GroupDef,
    InvalidGroupError,
    fixed_shape,
    is_group_name,
    is_reserved_name,
)


@pytest.mark.parametrize(
    "name", ["finops-central", "bu-lead", "mango-agent-creator", "hr", "bu-" + "a" * 32]
)
def test_group_names(name: str) -> None:
    assert is_group_name(name)


@pytest.mark.parametrize("name", ["", "a", "HR", "-hr", "h r", "us-east-1_Abc_Okta", "x" * 65, 3])
def test_names_that_are_not_groups(name: object) -> None:
    assert not is_group_name(name)


def test_valid_registry_entries() -> None:
    assert GroupDef("finops-central", "central", None, "FinOps central").is_central
    area = GroupDef("bu-security", "area", "security", "")
    assert not area.is_central
    assert not GroupDef("hr", "general", None, "Personas").is_central


@pytest.mark.parametrize(
    ("group_id", "kind", "area", "description"),
    [
        ("HR", "general", None, ""),
        ("hr", "owner", None, ""),
        ("hr", "area", None, ""),  # an area group needs its area
        ("hr", "general", "security", ""),  # only area groups carry one
        ("hr", "central", "security", ""),
        ("hr", "area", "Security", ""),
        ("hr", "general", None, "x" * 201),
        ("hr", "general", None, "line\nbreak"),
    ],
)
def test_invalid_registry_entries_are_rejected(
    group_id: str, kind: str, area: str | None, description: str
) -> None:
    with pytest.raises(InvalidGroupError):
        GroupDef(group_id, kind, area, description)


@pytest.mark.parametrize(
    ("name", "shape"),
    [
        ("finops-central", ("central", None)),
        ("bu-lead", ("general", None)),
        ("bu-security", ("area", "security")),
        ("bu-a", None),
        ("hr", None),
        ("business", None),
    ],
)
def test_names_the_pre_token_trigger_reads_keep_their_meaning(
    name: str, shape: tuple[str, str | None] | None
) -> None:
    assert fixed_shape(name) == shape


def test_permission_groups_are_reserved() -> None:
    assert is_reserved_name("mango-admin")
    assert is_reserved_name("mango-agent-creator")
    assert not is_reserved_name("mangos")
