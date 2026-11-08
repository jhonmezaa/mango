"""The «Analizando» block of the chat (C4): the cells a turn ran, as the chat shows them.

The connector's rows → ``code_blocks`` (``ApplyGuardrail`` first, TM-CI5) → the turn's record
(event ``code``) → ``chat_stream`` (``metadata.aggregate_result`` of the result message) and the
stored answer (``code_runs``) → the history.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field, replace
from typing import Any

import pytest

from mango_api import chat_stream, code_blocks, harness
from mango_api.turns_store import TurnEvent
from mango_core.harness_tools import CODE_RUN_TOOL, CODE_TARGET, allowed_tool

from . import test_turn_endings
from .test_turn_endings import CALL, END, TEXT, TOOL_USE, Env, ScriptedBedrock, _runs_code

env = test_turn_endings.env
"""The DynamoDB budget and the chat of ``test_turn_endings``."""

TURN = "t" * 32


def row(
    run_id: str,
    *,
    created: int = 1,
    status: str = "ok",
    code: str = "print(1)",
    stdout: str = "1\n",
    stderr: str = "",
    stdout_chars: int | None = None,
    exception: dict[str, str] | None = None,
    files: list[dict[str, Any]] | None = None,
    done: bool = True,
) -> dict[str, Any]:
    """A cell's row as the connector writes it (``SessionStore.begin_cell``/``end_cell``)."""
    item: dict[str, Any] = {
        "SK": {"S": f"CODE#TURN#{TURN}#RUN#{run_id}"},
        "state": {"S": "done" if done else "running"},
        "code": {"S": code},
        "created_at": {"N": str(created)},
    }
    if done:
        item |= {
            "status": {"S": status},
            "cpu_seconds": {"N": "2"},
            "stdout": {"S": stdout},
            "stderr": {"S": stderr},
            "stdout_chars": {"N": str(stdout_chars if stdout_chars is not None else len(stdout))},
            "stderr_chars": {"N": str(len(stderr))},
            "exception": {"S": json.dumps(exception)} if exception else {"NULL": True},
            "files": {"S": json.dumps(files or [])},
        }
    return item


FIGURE = {
    "file_id": "f" * 26,
    "name": "costo.png",
    "kind": "figure",
    "mime": "image/png",
    "size": 4096,
    "sha256": "0" * 64,
    "key": "owner/x/conv/y/z",
    "extension": "png",
}
SHEET = {**FIGURE, "file_id": "e" * 26, "name": "detalle.xlsx", "kind": "file", "extension": "xlsx"}


@dataclass
class Guard:
    """``ApplyGuardrail`` of bedrock-runtime: intervenes when a text has ``word``."""

    word: str = "secreto"
    fail: bool = False
    ids: tuple[str, str] = ("g-1", "3")
    calls: list[list[str]] = field(default_factory=list)

    def apply_guardrail(self, **kw: Any) -> dict[str, Any]:
        assert kw["source"] == "OUTPUT"
        assert (kw["guardrailIdentifier"], kw["guardrailVersion"]) == self.ids
        texts = [c["text"]["text"] for c in kw["content"]]
        self.calls.append(texts)
        if self.fail:
            raise RuntimeError("throttled")
        hit = any(self.word in t for t in texts)
        return {"action": "GUARDRAIL_INTERVENED" if hit else "NONE"}


def guard(g: Guard) -> code_blocks.Guardrail:
    return code_blocks.Guardrail(g, "g-1", "3")


# --- What a cell shows ------------------------------------------------------------------


def test_a_cell_shows_its_code_output_exception_and_files_by_id() -> None:
    run = code_blocks.code_run(
        row(
            "r1",
            status="error",
            stderr="Traceback…",
            stdout_chars=25_000,
            exception={"name": "KeyError", "message": "'region'"},
            files=[FIGURE, SHEET],
        )
    )
    assert run is not None
    cell = code_blocks.shown(run, blocked=False)
    assert cell.status == "error"
    assert (cell.code, cell.stdout, cell.stderr) == ("print(1)", "1\n", "Traceback…")
    assert cell.stdout_truncated and not cell.stderr_truncated
    assert cell.exception is not None and cell.exception.name == "KeyError"
    assert [(f.name, f.image) for f in cell.files] == [("costo.png", True), ("detalle.xlsx", False)]
    # Never a key of the bucket nor a hash: only what the chat asks the files routes with.
    assert "key" not in cell.files[0].model_dump() and "sha256" not in cell.files[0].model_dump()


def test_the_cutoff_and_an_unfinished_cell_have_their_own_status() -> None:
    timeout = code_blocks.code_run(row("r1", status="timeout"))
    unfinished = code_blocks.code_run(row("r2", done=False))
    assert timeout is not None and unfinished is not None
    assert code_blocks.shown(timeout, blocked=False).status == "timeout"
    assert code_blocks.shown(unfinished, blocked=False).status == "error"
    assert code_blocks.code_run({"SK": {"S": "CODE#SESSION#x"}}) is None


def test_a_blocked_cell_shows_nothing_of_itself() -> None:
    run = code_blocks.code_run(row("r1", files=[FIGURE], exception={"name": "E", "message": "m"}))
    assert run is not None
    cell = code_blocks.shown(run, blocked=True).model_dump()
    assert cell["blocked"] is True
    assert (cell["code"], cell["stdout"], cell["stderr"], cell["exception"], cell["files"]) == (
        "",
        "",
        "",
        None,
        [],
    )


# --- The guardrail (TM-CI5) -------------------------------------------------------------


def test_the_guardrail_checks_the_code_the_output_the_exception_and_the_file_names() -> None:
    g = Guard()
    run = code_blocks.code_run(
        row("r1", stderr="warn", exception={"name": "E", "message": "m"}, files=[SHEET])
    )
    assert run is not None
    assert guard(g).blocks(run) is False
    assert g.calls == [["print(1)", "1\n", "warn", "E", "m", "detalle.xlsx"]]


@pytest.mark.parametrize("where", ["code", "stdout", "stderr"])
def test_a_cell_the_guardrail_intervenes_in_is_blocked(where: str) -> None:
    run = code_blocks.code_run(row("r1", **{where: "un secreto"}))
    assert run is not None
    assert guard(Guard()).blocks(run) is True


def test_a_guardrail_that_cannot_be_asked_blocks_the_cell() -> None:
    run = code_blocks.code_run(row("r1"))
    assert run is not None
    assert guard(Guard(fail=True)).blocks(run) is True
    assert code_blocks.Guardrail(Guard(), "", "").blocks(run) is True


def test_a_long_cell_is_checked_in_calls_of_at_most_twenty_thousand_characters() -> None:
    g = Guard()
    run = code_blocks.code_run(row("r1", code="x" * 45_000, stdout="y" * 100))
    assert run is not None
    assert guard(g).blocks(run) is False
    sizes = [sum(map(len, call)) for call in g.calls]
    assert max(sizes) <= code_blocks.GUARD_CHUNK_CHARS
    assert sum(sizes) == 45_100


# --- The cells of a turn ----------------------------------------------------------------


def test_each_cell_is_shown_once_in_the_order_it_ran() -> None:
    rows: list[dict[str, Any]] = [row("b", created=2)]
    cells = code_blocks.TurnCells(lambda _u, _t: rows, guard(Guard()), "user-1", TURN)
    assert [c["run_id"] for c in cells.new()] == ["b"]
    rows += [row("c", created=4, code="secreto"), row("a", created=3)]
    assert [(c["run_id"], c["blocked"]) for c in cells.new()] == [("a", False), ("c", True)]
    assert cells.new() == []
    assert cells.stored() == [
        {"turn": TURN, "run": "b", "blocked": False},
        {"turn": TURN, "run": "a", "blocked": False},
        {"turn": TURN, "run": "c", "blocked": True},
    ]


def test_cells_that_cannot_be_read_show_nothing() -> None:
    def broken(_u: str, _t: str) -> list[dict[str, Any]]:
        raise RuntimeError("throttled")

    assert code_blocks.TurnCells(broken, guard(Guard()), "u", TURN).new() == []


def test_the_history_reads_the_cells_with_the_verdict_they_were_shown_with() -> None:
    refs = code_blocks.references(
        [
            {"turn": TURN, "run": "a", "blocked": False},
            {"turn": TURN, "run": "b", "blocked": True},
            {"turn": TURN, "run": "gone", "blocked": False},
            {"bad": 1},
        ]
    )
    reads: list[str] = []

    def read(turn: str) -> list[dict[str, Any]]:
        reads.append(turn)
        return [row("a", files=[FIGURE, SHEET]), row("b")]

    cells = code_blocks.history(refs, read, frozenset({FIGURE["file_id"]}))
    assert reads == [TURN]
    assert [(c.run_id, c.blocked) for c in cells] == [("a", False), ("b", True)]
    assert [f.gone for f in cells[0].files] == [False, True]


# --- The stream v1 ----------------------------------------------------------------------


def _translate(*events: tuple[str, dict[str, Any]]) -> list[chat_stream.Delta]:
    t = chat_stream.Translator(turn_id=TURN, conversation_id="c" * 32)
    out: list[chat_stream.Delta] = []
    for seq, (kind, data) in enumerate(events, start=1):
        out += t.feed(TurnEvent(seq, kind, data))
    return out


CELL = {"run_id": "a", "status": "completed", "blocked": False, "code": "1"}


def test_a_cell_is_a_code_call_and_its_result_carries_what_it_showed() -> None:
    deltas = _translate(
        ("tool", {"name": "run_python", "status": "started", "code": True}),
        ("tool", {"name": "run_python", "status": "completed", "code": True}),
        ("code", CELL),
    )
    call = next(d.v for d in deltas if d.p == "" and d.c == 1)
    assert (call["recipient"], call["content_type"]) == ("code.run_python", "code")
    result = next(d.v for d in deltas if d.p == "" and d.c == 2)
    assert (result["author"], result["content_type"]) == (
        {"role": "tool", "name": "code.run_python"},
        "code_result",
    )
    assert result["metadata"] == {"call_id": f"{TURN}.1", "aggregate_result": None}
    assert deltas[-1] == chat_stream.Delta(2, "/metadata/aggregate_result", "replace", CELL)
    assert all(d.p in chat_stream.MESSAGE_PATHS for d in deltas)


def test_a_cell_without_a_call_waiting_gets_a_result_of_its_own() -> None:
    deltas = _translate(("code", CELL))
    (added,) = [d.v for d in deltas if d.p == "" and d.c == 1]
    assert added["metadata"] == {"call_id": None, "aggregate_result": CELL}


def test_only_a_call_the_harness_knew_as_a_cell_is_one() -> None:
    deltas = _translate(("tool", {"name": "code.run_python", "status": "started"}))
    call = next(d.v for d in deltas if d.p == "" and d.c == 1)
    assert (call["recipient"], call["content_type"]) == ("tool", "tool_call")


# --- The harness ------------------------------------------------------------------------


def _code_call() -> Iterator[dict[str, Any]]:
    yield {
        "contentBlockStart": {
            "contentBlockIndex": 1,
            "start": {"toolUse": {"toolUseId": "tu-1", "name": "code___run_python"}},
        }
    }
    yield {"contentBlockStop": {"contentBlockIndex": 1}}
    yield TOOL_USE
    yield CALL
    yield {
        "contentBlockStart": {
            "contentBlockIndex": 2,
            "start": {"toolResult": {"toolUseId": "tu-1", "status": "success"}},
        }
    }
    yield TEXT
    yield END
    yield CALL


@dataclass
class _Client:
    def invoke_harness(self, **_kw: Any) -> dict[str, Any]:
        return {"stream": _code_call()}


def _run(allowed: list[str]) -> list[harness.StreamEvent]:
    result = harness.InvocationResult()
    return list(harness.run(_Client(), {"allowedTools": allowed}, result))  # type: ignore[arg-type]


def test_a_cell_call_says_so_and_its_phase_is_running_code() -> None:
    events = _run([allowed_tool(CODE_TARGET, CODE_RUN_TOOL)])
    tools = [e.data for e in events if e.kind == "tool"]
    assert tools == [
        {"name": "run_python", "status": "started", "code": True},
        {"name": "run_python", "status": "completed", "code": True},
    ]
    assert {"phase": "code"} in [e.data for e in events if e.kind == "status"]


def test_a_call_of_a_version_without_code_is_not_a_cell() -> None:
    events = _run([])
    assert all("code" not in e.data for e in events if e.kind == "tool")
    assert {"phase": "code"} not in [e.data for e in events if e.kind == "status"]


# --- The turn, end to end ---------------------------------------------------------------


@dataclass
class GuardedBedrock(ScriptedBedrock):
    # The base guardrail of the test settings.
    guard: Guard = field(default_factory=lambda: Guard(ids=("gr-base", "1")))

    def apply_guardrail(self, **kw: Any) -> dict[str, Any]:
        return self.guard.apply_guardrail(**kw)


def test_a_turn_shows_its_cells_after_the_guardrail_and_keeps_which_ones(env: Env) -> None:
    _runs_code(env)
    agent = env.published.agents["finops"]
    # What ``published`` adds to a version with the capability (D114 (6)).
    env.published.agents["finops"] = replace(
        agent, allowed_tools=(*agent.allowed_tools, allowed_tool(CODE_TARGET, CODE_RUN_TOOL))
    )
    env.bedrock = GuardedBedrock()
    env.agentcore.stream = _code_call

    def rows(_user: str, turn: str) -> list[dict[str, Any]]:
        return [{**row("a"), "SK": {"S": f"CODE#TURN#{turn}#RUN#a"}}]

    env.conversations.code_runs = rows  # type: ignore[method-assign]
    assert env.chat().status_code == 200
    assert env.bedrock.guard.calls == [["print(1)", "1\n"]]
    (pending,) = env.seen
    kept = env.conversations.options[-1]["code_runs"]
    assert kept == [{"turn": pending.turn_id, "run": "a", "blocked": False}]


def test_the_files_of_a_cell_say_their_role_and_their_extension() -> None:
    chart = {
        **FIGURE,
        "file_id": "g" * 26,
        "name": "costo.chart.json",
        "kind": "chart",
        "extension": "json",
    }
    table = {**chart, "file_id": "h" * 26, "name": "cuentas.table.json", "kind": "table"}
    csv = {**SHEET, "file_id": "i" * 26, "name": "cuentas.csv", "extension": "csv"}
    legacy = {**FIGURE, "file_id": "j" * 26, "kind": "png"}
    run = code_blocks.code_run(row("a1", files=[FIGURE, SHEET, chart, table, csv, legacy]))
    assert run is not None
    cell = code_blocks.shown(run, blocked=False)
    assert [(f.kind, f.role, f.image) for f in cell.files] == [
        ("png", "figure", True),
        ("xlsx", "file", False),
        ("json", "chart", False),
        ("json", "table", False),
        ("csv", "file", False),
        ("png", "figure", True),
    ]
