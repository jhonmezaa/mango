"""The «Analizando» block of the chat: what a turn shows of the cells it ran (C4, D114 (7)).

The code connector (``connectors/code-interpreter``) writes each cell of a turn to the person's
partition of ``Conversations`` (``CODE#TURN#<turn>#RUN#<run>``, ``mango_core.code_sandbox``):
its code, stdout and stderr capped at 20,000 characters, its exception and the files it wrote,
by id. Once the harness reports the answer of a ``code___run_python`` call, the turn worker
reads the cells of the turn it has not shown yet and writes each one, as shown, to the turn's
record (event ``code``); ``chat_stream`` puts it on the result message as its
``aggregate_result``. The stored answer keeps only which cells it showed and the guardrail's
verdict (``code_runs``); the history reads the cells again from their rows.

Security notes (security-best-practices, TM-CI5, TM-CI6, D90 (3), D16):
* The code, stdout, stderr and the exception that are shown go through ``ApplyGuardrail`` of
  the base guardrail first. When it intervenes, or cannot be asked, nothing of the cell is shown
  (fail closed): «Mango no muestra el código ni la salida de esta celda…».
* Everything in a cell is untrusted (it came from the model and from the sandbox): it is data
  of the message, shown as text by the SPA, never logged and never sent to Actividad.
* Only rows of the caller's own partition are read (row-level security), and only those of the
  turn being shown.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

logger = logging.getLogger("mango_api.code_blocks")

CODE_RECIPIENT = "code.run_python"
"""The ``recipient`` of a cell's call in the ``v1`` stream (D120 (2))."""
SHOWN_CHARS = 20_000
"""What the chat shows of stdout and of stderr (the connector's cap, design round 40)."""
GUARD_CHUNK_CHARS = 20_000
"""Characters per ``ApplyGuardrail`` call (20 text units), so that a long cell does not ask for
more than a default quota of text units at once."""
MAX_CELLS_SHOWN = 8
"""Cells of one turn (``mango_core.code_sandbox.CELLS_PER_TURN``): never more are read."""
MAX_FILES_SHOWN = 20
"""Files of one cell (the connector's cap, D114 (13))."""
_IMAGE_KINDS = frozenset({"png", "jpg", "jpeg"})

CellStatus = Literal["completed", "error", "timeout"]
_STATUS: dict[str, CellStatus] = {"ok": "completed", "error": "error", "timeout": "timeout"}


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


FileRole = Literal["file", "figure", "chart", "table"]
"""What a file of a cell is to the chat: a file card, a figure of the block, or the spec of a
chart or a table (D118), drawn after the text («bloque → texto → gráfica → tabla → archivos»)."""
_ROLES: frozenset[str] = frozenset({"file", "figure", "chart", "table"})


class CodeFileOut(_Strict):
    """A file a cell wrote, by id: the chat asks for it through the files routes (D116)."""

    file_id: str
    name: str
    kind: str
    """Its extension (``png``, ``xlsx``, ``json``…), the card's badge."""
    role: FileRole = "file"
    size_bytes: int
    image: bool
    """PNG or JPEG: shown as a figure of the block; a chart or a table is drawn; any other
    kind is a file card."""
    gone: bool = False
    """After 90 days or with its conversation: «Ya no está disponible» (history only)."""


class CodeExceptionOut(_Strict):
    name: str
    message: str


class CodeCellOut(_Strict):
    """One cell as the chat shows it (the ``aggregate_result`` of its result message)."""

    run_id: str
    status: CellStatus
    """``timeout``: «La celda pasó su tope de 300 s y se detuvo.»."""
    blocked: bool
    """The guardrail intervened (or could not be asked): nothing of the cell is shown."""
    code: str = ""
    stdout: str = ""
    stderr: str = ""
    stdout_truncated: bool = False
    stderr_truncated: bool = False
    """The cell wrote more than ``SHOWN_CHARS``: «Salida recortada…»."""
    exception: CodeExceptionOut | None = None
    seconds: int | None = None
    files: list[CodeFileOut] = []


@dataclass(frozen=True)
class CodeRun:
    """A cell's row, as the connector wrote it (``CODE#TURN#<turn>#RUN#<run>``)."""

    run_id: str
    created_at: int
    done: bool
    status: CellStatus
    code: str
    stdout: str
    stderr: str
    stdout_chars: int
    stderr_chars: int
    exception: dict[str, str] | None
    seconds: int | None
    files: tuple[dict[str, Any], ...]


def _text(item: dict[str, Any], key: str) -> str:
    value = item.get(key, {})
    return value.get("S", "") if isinstance(value, dict) else ""


def _number(item: dict[str, Any], key: str) -> int | None:
    try:
        return int(item[key]["N"])
    except (KeyError, TypeError, ValueError):
        return None


def _exception(raw: str) -> dict[str, str] | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    return {"name": str(data.get("name", ""))[:200], "message": str(data.get("message", ""))[:2000]}


def _files(raw: str) -> tuple[dict[str, Any], ...]:
    try:
        data = json.loads(raw) if raw else []
    except ValueError:
        return ()
    if not isinstance(data, list):
        return ()
    out: list[dict[str, Any]] = []
    for f in data[:MAX_FILES_SHOWN]:
        if not isinstance(f, dict):
            continue
        try:
            name = str(f["name"])[:255]
            # The connector writes its role as ``kind`` (``outputs.Exported``) and the extension
            # apart; the extension is what a card shows.
            role = str(f.get("kind", ""))
            extension = str(f.get("extension") or name.rpartition(".")[2]).lower()[:8]
            if role not in _ROLES:
                role = "figure" if extension in _IMAGE_KINDS else "file"
            out.append(
                {
                    "file_id": str(f["file_id"]),
                    "name": name,
                    "kind": extension,
                    "role": role,
                    "size_bytes": max(int(f.get("size", 0)), 0),
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    return tuple(out)


def code_run(item: dict[str, Any]) -> CodeRun | None:
    """A row of DynamoDB as a ``CodeRun``; ``None`` when it is not one."""
    sk = _text(item, "SK")
    run_id = sk.rpartition("#RUN#")[2]
    if "#RUN#" not in sk or not run_id:
        return None
    done = _text(item, "state") == "done"
    return CodeRun(
        run_id=run_id,
        created_at=_number(item, "created_at") or 0,
        done=done,
        status=_STATUS.get(_text(item, "status"), "error") if done else "error",
        code=_text(item, "code"),
        stdout=_text(item, "stdout")[:SHOWN_CHARS],
        stderr=_text(item, "stderr")[:SHOWN_CHARS],
        stdout_chars=_number(item, "stdout_chars") or 0,
        stderr_chars=_number(item, "stderr_chars") or 0,
        exception=_exception(_text(item, "exception")),
        seconds=_number(item, "cpu_seconds") if done else None,
        files=_files(_text(item, "files")),
    )


def shown(run: CodeRun, *, blocked: bool, present: frozenset[str] | None = None) -> CodeCellOut:
    """What the chat shows of a cell. ``present``: the file ids still available (history)."""
    if blocked:
        # Nothing of it: neither its text nor what it drew or wrote (design round 40).
        return CodeCellOut(run_id=run.run_id, status=run.status, blocked=True, seconds=run.seconds)
    return CodeCellOut(
        run_id=run.run_id,
        status=run.status,
        blocked=False,
        code=run.code,
        stdout=run.stdout,
        stderr=run.stderr,
        stdout_truncated=run.stdout_chars > SHOWN_CHARS,
        stderr_truncated=run.stderr_chars > SHOWN_CHARS,
        exception=CodeExceptionOut(**run.exception) if run.exception else None,
        seconds=run.seconds,
        files=[
            CodeFileOut(
                **f,
                image=f["kind"] in _IMAGE_KINDS,
                gone=present is not None and f["file_id"] not in present,
            )
            for f in run.files
        ],
    )


def _chunks(texts: Iterable[str]) -> list[list[str]]:
    """The texts in calls of at most ``GUARD_CHUNK_CHARS``, a long one split across calls."""
    calls: list[list[str]] = []
    current: list[str] = []
    size = 0
    for text in texts:
        for start in range(0, len(text), GUARD_CHUNK_CHARS):
            piece = text[start : start + GUARD_CHUNK_CHARS]
            if size + len(piece) > GUARD_CHUNK_CHARS and current:
                calls.append(current)
                current, size = [], 0
            current.append(piece)
            size += len(piece)
    if current:
        calls.append(current)
    return calls


class Guardrail:
    """``ApplyGuardrail`` of the base guardrail over what a cell shows (TM-CI5)."""

    def __init__(self, client: Any, guardrail_id: str, version: str) -> None:
        self._client = client
        self._id = guardrail_id
        self._version = version

    def blocks(self, run: CodeRun) -> bool:
        """Whether nothing of the cell may be shown: the guardrail intervened in any of its
        parts, or could not be asked (fail closed). Never logs any of it."""
        exception = run.exception or {}
        return self.blocks_texts(
            (
                run.code,
                run.stdout,
                run.stderr,
                exception.get("name", ""),
                exception.get("message", ""),
                *(f["name"] for f in run.files),
            )
        )

    def blocks_texts(self, texts: Iterable[str]) -> bool:
        """Whether any of ``texts`` may not be shown: the guardrail intervened, or could not
        be asked (fail closed). Also the texts of a chart or a table (``chat_outputs``)."""
        if not self._id or not self._version:
            logger.error("no base guardrail configured: code outputs are not shown")
            return True
        shown = [t for t in texts if t]
        try:
            for call in _chunks(shown):
                response = self._client.apply_guardrail(
                    guardrailIdentifier=self._id,
                    guardrailVersion=self._version,
                    source="OUTPUT",
                    content=[{"text": {"text": text}} for text in call],
                )
                if response.get("action") != "NONE":
                    return True
        except Exception:
            logger.exception("the guardrail could not check a code cell")
            return True
        return False


@dataclass(frozen=True)
class Reference:
    """What a stored answer keeps of a cell it showed: never its content."""

    turn_id: str
    run_id: str
    blocked: bool

    def stored(self) -> dict[str, Any]:
        return {"turn": self.turn_id, "run": self.run_id, "blocked": self.blocked}


def references(raw: Sequence[Any]) -> list[Reference]:
    out: list[Reference] = []
    for r in raw[: MAX_CELLS_SHOWN * 4]:
        if isinstance(r, dict) and isinstance(r.get("turn"), str) and isinstance(r.get("run"), str):
            out.append(Reference(r["turn"], r["run"], bool(r.get("blocked", True))))
    return out


class TurnCells:
    """The cells of one turn, in the worker: each one shown once, in the order they ran."""

    def __init__(
        self,
        read: Callable[[str, str], list[dict[str, Any]]],
        guardrail: Guardrail,
        user_id: str,
        turn_id: str,
    ) -> None:
        self._read = read
        self._guardrail = guardrail
        self._user_id = user_id
        self._turn_id = turn_id
        self._shown: dict[str, bool] = {}

    def new(self) -> list[dict[str, Any]]:
        """The cells that ended and were not shown yet, as the stream shows them. A failure to
        read them is logged and shows nothing: the call is still in the stream."""
        if len(self._shown) >= MAX_CELLS_SHOWN:
            return []
        try:
            items = self._read(self._user_id, self._turn_id)
        except Exception:
            logger.exception("the code cells of a turn could not be read")
            return []
        runs = sorted(
            (r for r in map(code_run, items) if r is not None and r.run_id not in self._shown),
            key=lambda r: (r.created_at, r.run_id),
        )
        out: list[dict[str, Any]] = []
        for run in runs[: MAX_CELLS_SHOWN - len(self._shown)]:
            blocked = self._guardrail.blocks(run)
            self._shown[run.run_id] = blocked
            out.append(shown(run, blocked=blocked).model_dump(mode="json"))
        return out

    def stored(self) -> list[dict[str, Any]]:
        return [Reference(self._turn_id, r, b).stored() for r, b in self._shown.items()]


def stored_of_events(turn_id: str, cells: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """``code_runs`` of an answer kept from its written events (``interrupt``)."""
    return [
        Reference(turn_id, str(c.get("run_id", "")), bool(c.get("blocked", True))).stored()
        for c in cells
        if c.get("run_id")
    ][:MAX_CELLS_SHOWN]


def history(
    refs: Sequence[Reference],
    read: Callable[[str], list[dict[str, Any]]],
    present: frozenset[str],
) -> list[CodeCellOut]:
    """The cells of a stored answer, read again from their rows (``read(turn_id)``), with the
    verdict of the guardrail they were shown with. A row gone (90 days) is left out."""
    by_turn: dict[str, dict[str, CodeRun]] = {}
    out: list[CodeCellOut] = []
    for ref in refs:
        if ref.turn_id not in by_turn:
            runs = (code_run(i) for i in read(ref.turn_id))
            by_turn[ref.turn_id] = {r.run_id: r for r in runs if r is not None}
        run = by_turn[ref.turn_id].get(ref.run_id)
        if run is not None:
            out.append(shown(run, blocked=ref.blocked, present=present))
    return out
