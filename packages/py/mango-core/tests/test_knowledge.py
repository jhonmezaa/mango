"""Ids of the knowledge bases (D88 (8)): ULIDs, random and sortable by time."""

from __future__ import annotations

import pytest

from mango_core.knowledge import is_id, new_id


def test_an_id_is_a_ulid() -> None:
    kb_id = new_id()
    assert len(kb_id) == 26
    assert is_id(kb_id)
    # Crockford's alphabet: no I, L, O or U, and never lowercase.
    assert not set(kb_id) & set("ILOUilou")


def test_ids_sort_by_time_and_never_repeat() -> None:
    earlier = [new_id(1_700_000_000_000) for _ in range(200)]
    later = new_id(1_700_000_000_001)
    assert len(set(earlier)) == 200
    assert all(kb_id < later for kb_id in earlier)
    # The first 10 characters are the time: the same millisecond, the same prefix.
    assert len({kb_id[:10] for kb_id in earlier}) == 1


def test_the_time_is_encoded_as_ulid_does() -> None:
    # 0 ms and the largest time of 48 bits are the bounds of the format.
    assert new_id(0).startswith("0000000000")
    assert new_id((1 << 48) - 1).startswith("7ZZZZZZZZZ")
    with pytest.raises(ValueError, match="time"):
        new_id(1 << 48)


@pytest.mark.parametrize(
    "value",
    ["", "01ARZ3NDEKTSV4RRFFQ69G5FA", "01ARZ3NDEKTSV4RRFFQ69G5FAVX", "01arz3ndektsv4rrffq69g5fav"],
)
def test_anything_else_is_not_an_id(value: str) -> None:
    assert not is_id(value)
