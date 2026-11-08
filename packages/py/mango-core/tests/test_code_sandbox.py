from __future__ import annotations

from decimal import Decimal

import pytest

from mango_core.code_sandbox import (
    CELL_SECONDS,
    CELLS_PER_TURN,
    SESSION_SECONDS,
    CellUse,
    Prices,
    cell_use,
    cost,
    reserve,
)

PRICES = Prices.parse('{"vcpuHour": 0.0895, "gbHour": 0.00945}')


def test_prices_are_parsed_as_the_stack_writes_them() -> None:
    assert Prices(Decimal("0.0895"), Decimal("0.00945")) == PRICES


@pytest.mark.parametrize(
    "raw", ["", "{}", '{"vcpuHour": -1, "gbHour": 1}', '{"vcpuHour": "x", "gbHour": 1}']
)
def test_invalid_prices_are_refused(raw: str) -> None:
    with pytest.raises(ValueError, match="prices"):
        Prices.parse(raw)


def test_a_cell_costs_its_cpu_and_a_new_session_its_memory_for_its_life() -> None:
    # 300 s at 2 vCPU: 0.0895 * 2 / 3600 * 300.
    assert cost([CellUse(CELL_SECONDS, 0)], PRICES) == Decimal("0.014917")
    # 30 min of 8 GB: 0.00945 * 8 / 2.
    assert cost([CellUse(0, SESSION_SECONDS)], PRICES) == Decimal("0.037800")


def test_the_reservation_counts_the_cells_and_one_session() -> None:
    eight = reserve(25, PRICES)
    assert eight == cost(
        [CellUse(CELL_SECONDS, 0)] * CELLS_PER_TURN + [CellUse(0, SESSION_SECONDS)], PRICES
    )
    assert reserve(2, PRICES) < eight
    assert reserve(2, PRICES) >= cost([CellUse(CELL_SECONDS, 0)] * 2, PRICES)


def test_what_is_not_known_counts_at_its_cutoff() -> None:
    assert cell_use({"session_seconds": {"N": "0"}}) == CellUse(CELL_SECONDS, 0)
    done = {"state": {"S": "done"}, "cpu_seconds": {"N": "3"}, "session_seconds": {"N": "1800"}}
    assert cell_use(done) == CellUse(3, SESSION_SECONDS)
