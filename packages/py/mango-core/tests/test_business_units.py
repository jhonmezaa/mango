import pytest

from mango_core.business_units import (
    InvalidMappingError,
    changed_areas,
    dumps_units,
    loads_units,
    validate_units,
)

OU1 = "ou-abcd-11111111"
OU2 = "ou-abcd-22222222"


def test_normalizes_and_round_trips() -> None:
    units = validate_units({"security": [OU2, OU1, OU1], "sandbox": [OU1]})
    assert units == {"sandbox": (OU1,), "security": (OU1, OU2)}
    assert loads_units(dumps_units(units)) == units


@pytest.mark.parametrize(
    "raw",
    [
        [],
        {"Security": [OU1]},
        {"s": [OU1]},
        {"security": []},
        {"security": OU1},
        {"security": ["ou-bad"]},
        {"security": [f"ou-abcd-{i:08d}" for i in range(16)]},
        {f"area-{i}": [OU1] for i in range(21)},
    ],
)
def test_rejects_invalid_mappings(raw: object) -> None:
    with pytest.raises(InvalidMappingError):
        validate_units(raw)


def test_rejects_invalid_json() -> None:
    with pytest.raises(InvalidMappingError):
        loads_units("{not json")


def test_changed_areas_covers_added_removed_and_modified() -> None:
    before = {"a1": (OU1,), "b1": (OU1,), "c1": (OU1,)}
    after = {"a1": (OU1,), "b1": (OU2,), "d1": (OU1,)}
    assert changed_areas(before, after) == {"b1", "c1", "d1"}
