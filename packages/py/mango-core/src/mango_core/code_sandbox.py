"""The code sandbox as mango-api and the code connector both see it (D114, D115).

The connector (``connectors/code-interpreter``) runs each cell of a version with the
``code_interpreter`` capability in the Code Interpreter of the installation and writes, under
the person's partition of ``Conversations`` (``PK = USER#<sub>``, row-level security):

* ``CODE#SESSION#<conversation>``: the sandbox session of (person, conversation), with its
  ``sessionId`` sealed with KMS, the person and the conversation as encryption context (TM-CI1).
* ``CODE#TURN#<turn>#RUN#<run>``: one cell, its result for the chat (status, code, output with a
  cap, exception, files by id) and its metered use: what mango-api settles the turn with.

The prices are configuration (rule 7): USD per vCPU-hour and per GB-hour of the release or of
the installation. A session is charged its memory for the whole life it is given, idle or not
(D115 (4)), and the CPU of each cell for the seconds it ran; CPU waiting is free, memory is not.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

CELL_SECONDS = 300
"""The connector's own cutoff of one cell (D114 (5)); what a cell reserves."""
SESSION_SECONDS = 1800
"""Life of a sandbox session (D114 (4)): AWS stops it then, idle or not (a TTL)."""
CELLS_PER_TURN = 8
"""Cells one turn may run, whatever its iterations (D115 (1)); the connector refuses more."""
SANDBOX_VCPUS = 2
SANDBOX_GB = 8
"""Hardware of a session (fixed by AWS): what a second of it may cost, at most."""
SESSION_PREFIX = "CODE#SESSION#"
TURN_PREFIX = "CODE#TURN#"
_HOUR = Decimal(3600)
_MICRO = Decimal("0.000001")


@dataclass(frozen=True)
class Prices:
    """USD per vCPU-hour and per GB-hour of the Code Interpreter (D115 (2))."""

    vcpu_hour: Decimal
    gb_hour: Decimal

    @staticmethod
    def parse(raw: str) -> Prices:
        """``{"vcpuHour": …, "gbHour": …}`` as the stack writes it; raises ``ValueError``."""
        try:
            data = json.loads(raw)
            prices = Prices(Decimal(str(data["vcpuHour"])), Decimal(str(data["gbHour"])))
        except (ValueError, KeyError, TypeError, ArithmeticError) as exc:
            raise ValueError("invalid code interpreter prices") from exc
        if prices.vcpu_hour < 0 or prices.gb_hour < 0:
            raise ValueError("invalid code interpreter prices")
        return prices

    def cpu_second(self) -> Decimal:
        return self.vcpu_hour * SANDBOX_VCPUS / _HOUR

    def memory_second(self) -> Decimal:
        return self.gb_hour * SANDBOX_GB / _HOUR


def session_sk(conversation_id: str) -> str:
    return f"{SESSION_PREFIX}{conversation_id}"


def turn_prefix(turn_id: str) -> str:
    return f"{TURN_PREFIX}{turn_id}#RUN#"


def run_sk(turn_id: str, run_id: str) -> str:
    return f"{turn_prefix(turn_id)}{run_id}"


@dataclass(frozen=True)
class CellUse:
    """What one cell used, as the connector metered it (D115 (3))."""

    cpu_seconds: int
    """Seconds the cell ran, rounded up; a cell still running counts its whole cutoff."""
    session_seconds: int
    """Life of the session this cell started (0 when it reused one): its memory, idle or not."""


def cost(uses: Iterable[CellUse], prices: Prices) -> Decimal:
    """What the cells of a turn cost: an estimate that never falls short."""
    total = Decimal(0)
    for use in uses:
        total += use.cpu_seconds * prices.cpu_second()
        total += use.session_seconds * prices.memory_second()
    return total.quantize(_MICRO, rounding="ROUND_CEILING")


def reserve(max_iterations: int, prices: Prices) -> Decimal:
    """What a turn of a version that runs code reserves before it starts (D115 (1)): its cells
    at the cutoff, and one new session (a session lives longer than any turn, so a turn
    starts at most one)."""
    cells = min(max_iterations, CELLS_PER_TURN)
    return cost(
        [CellUse(CELL_SECONDS, 0)] * cells + [CellUse(0, SESSION_SECONDS)],
        prices,
    )


def cell_use(item: dict[str, Any]) -> CellUse:
    """The use of a run item as DynamoDB returns it. A cell that never wrote its end counts at
    its cutoff: "I do not know" is never "nothing" (D73)."""
    finished = item.get("state", {}).get("S") == "done"
    cpu = int(item["cpu_seconds"]["N"]) if finished and "cpu_seconds" in item else CELL_SECONDS
    session = int(item.get("session_seconds", {}).get("N", "0"))
    return CellUse(max(cpu, 0), max(session, 0))
