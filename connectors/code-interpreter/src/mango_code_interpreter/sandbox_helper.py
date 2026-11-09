"""Mango's module inside the code sandbox, imported there as ``_mango`` (D114 (5), D118).

The connector writes this file into every new session and runs each cell through ``run``:
never imported by the Lambda itself. Only the standard library (Python 3.12 of the sandbox);
``matplotlib`` and ``pandas`` are used only if the cell already imported them.

``_mango`` is not a name a package on PyPI can take (a project name starts with a letter or a
digit), so ``import _mango`` can never load somebody else's code, and there is no ``pip`` in the
sandbox anyway.

What the model may call:

* ``display_table(df, name)``: writes ``<name>.table.json`` for the chat's grid and
  ``<name>.csv`` with every row, the file of the table's card (D118 (5)).
* ``display_chart(spec, name)``: writes ``<name>.chart.json``, a closed spec the server
  validates (D118 (1)).

Everything a cell prints is untrusted: the connector treats this module's report as data too.
"""

from __future__ import annotations

import ast
import csv
import json
import os
import re
import signal
import sys
import time
import traceback
from typing import Any

DATA = ""
"""The folder the model works in, shown to it and to the person as ``/mnt/data``."""
OUT = ""
"""Where the helpers and the figures land; emptied at the start of every cell."""
MAX_ROWS = 5000
MAX_SERIES = 20
MAX_SPEC_BYTES = 2 * 1024 * 1024
MAX_LISTED = 200
MAX_DEPTH = 4
_NAME_RE = re.compile(r"[^A-Za-z0-9_.-]+")


class _CellTimeoutError(BaseException):
    """Raised by the alarm: a ``BaseException``, so a cell's ``except Exception`` cannot keep it."""


def setup(data: str, out: str) -> None:
    """Point the module at its folders, work in ``data`` and draw off-screen (``Agg``): a figure
    reaches the person only as a PNG the connector reads (``plt.show()`` draws nothing)."""
    global DATA, OUT
    DATA, OUT = data, out
    os.makedirs(DATA, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    os.chdir(DATA)
    try:
        import matplotlib  # type: ignore[import-not-found]  # noqa: PLC0415

        matplotlib.use("Agg")
        _track_saved_figures()
    except Exception:  # noqa: BLE001, S110 - without matplotlib there is nothing to set
        pass


_SAVED: set[int] = set()
"""Figures (``id``) the cell itself saved as an image: not captured again at its end."""
_IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg")


def _track_saved_figures() -> None:
    """Note each figure the cell saves as a PNG or JPEG: the same figure left open is that
    image, so the end of the cell does not add a second copy of it (one figure, one image)."""
    from matplotlib.figure import Figure  # type: ignore[import-not-found]  # noqa: PLC0415

    original = Figure.savefig
    if getattr(original, "_mango_tracked", False):
        return

    def savefig(self: Any, fname: Any, *args: Any, **kwargs: Any) -> Any:
        result = original(self, fname, *args, **kwargs)
        target = os.fspath(fname) if isinstance(fname, str | os.PathLike) else ""
        fmt = str(kwargs.get("format") or "").lower()
        if target.lower().endswith(_IMAGE_SUFFIXES) or fmt in {"png", "jpg", "jpeg"}:
            _SAVED.add(id(self))
        return result

    savefig._mango_tracked = True  # type: ignore[attr-defined]
    Figure.savefig = savefig


def _safe_name(name: object, default: str) -> str:
    text = _NAME_RE.sub("-", str(name or "")).strip("-.")[:64]
    return text or default


def _write(name: str, suffix: str, payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, default=str, ensure_ascii=False)
    if len(raw.encode()) > MAX_SPEC_BYTES:
        raise ValueError(f"too large for the chat (more than {MAX_SPEC_BYTES} bytes)")
    path = os.path.join(OUT, f"{name}{suffix}")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(raw)
    return path


_FORMULA = ("=", "+", "-", "@", "\t", "\r")
_TABLE_CSVS: set[str] = set()
"""The CSVs ``display_table`` wrote in this session: only those it may write again."""


def _csv_cell(value: Any) -> Any:
    """A text cell that a spreadsheet would read as a formula gets a ``'`` in front (CSV
    injection, D118 (4)); numbers stay numbers."""
    if isinstance(value, str) and value.startswith(_FORMULA):
        return "'" + value
    return value


def _csv_name(base: str) -> str:
    """``<base>.csv`` in the working folder, or ``<base>-table.csv`` when a file of that name is
    there that this module did not write (an attachment, the model's own file)."""
    for name in (f"{base}.csv", f"{base}-table.csv"):
        if name in _TABLE_CSVS or not os.path.exists(os.path.join(DATA, name)):
            return name
    return f"{base}-table.csv"


def _write_csv(name: str, columns: list[str], rows: Any) -> None:
    with open(os.path.join(DATA, name), "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow([_csv_cell(c) for c in columns])
        for row in rows:
            writer.writerow([_csv_cell(v) for v in row])
    _TABLE_CSVS.add(name)


def display_table(df: Any, name: str = "table") -> None:
    """Show a table in the chat: a pandas DataFrame or a list of dicts. The chat shows its first
    rows (at most 5,000 reach it) and offers every row as ``<name>.csv``."""
    if hasattr(df, "to_dict") and hasattr(df, "columns"):
        columns = [str(c) for c in df.columns]
        total = len(df)
        rows = df.head(MAX_ROWS).to_dict(orient="split")["data"]
        every = df.itertuples(index=False, name=None)
    else:
        records = [dict(r) for r in df]
        columns = sorted({str(k) for r in records for k in r})
        total = len(records)
        every = [[r.get(c) for c in columns] for r in records]
        rows = every[:MAX_ROWS]
    base = _safe_name(name, "table")
    csv_name = _csv_name(base)
    _write(
        base,
        ".table.json",
        {
            "name": str(name)[:200],
            "columns": columns,
            "rows": rows,
            "total_rows": total,
            "csv": csv_name,
        },
    )
    _write_csv(csv_name, columns, every)


def display_chart(spec: dict[str, Any], name: str | None = None) -> None:
    """Show a chart in the chat from a spec: ``chartType`` (bar, line, pie, scatter), ``data``
    (rows), ``xKey`` and ``series``; at most 5,000 rows and 20 series."""
    if not isinstance(spec, dict):
        raise TypeError("the spec is a dict")
    if len(spec.get("data") or []) > MAX_ROWS or len(spec.get("series") or []) > MAX_SERIES:
        raise ValueError(f"at most {MAX_ROWS} rows and {MAX_SERIES} series")
    title = (spec.get("meta") or {}).get("title") if isinstance(spec.get("meta"), dict) else None
    _write(_safe_name(name or title, "chart"), ".chart.json", spec)


def _clear_out() -> None:
    for entry in os.listdir(OUT):
        path = os.path.join(OUT, entry)
        if os.path.isfile(path):
            os.remove(path)


def _save_figures(tag: str) -> None:
    """Every figure the cell left open, as a PNG (``savefig``), then closed."""
    pyplot = sys.modules.get("matplotlib.pyplot")
    if pyplot is None:
        return
    for index, number in enumerate(pyplot.get_fignums(), start=1):
        figure = pyplot.figure(number)
        if id(figure) in _SAVED:
            continue  # the cell saved it as an image already: that file is this figure
        figure.savefig(os.path.join(OUT, f"figure-{tag}-{index}.png"), dpi=110)
    pyplot.close("all")


def _changed(since: float) -> list[dict[str, Any]]:
    """Files of ``DATA`` written by the cell (by time), and everything in ``OUT``."""
    found: list[dict[str, Any]] = []
    for root, dirs, files in os.walk(DATA):
        depth = os.path.relpath(root, DATA).count(os.sep)
        dirs[:] = [d for d in dirs if not d.startswith(".")] if depth < MAX_DEPTH else []
        for name in files:
            path = os.path.join(root, name)
            try:
                stat = os.stat(path)
            except OSError:
                continue
            if stat.st_mtime >= since - 1 and not name.startswith("."):
                found.append({"path": path, "size": stat.st_size, "kind": "file"})
            if len(found) >= MAX_LISTED:
                return found
    for name in sorted(os.listdir(OUT)):
        path = os.path.join(OUT, name)
        kind = (
            "table"
            if name.endswith(".table.json")
            else "chart"
            if name.endswith(".chart.json")
            else "figure"
        )
        found.append({"path": path, "size": os.path.getsize(path), "kind": kind})
    return found[: MAX_LISTED + 50]


def _cell_traceback(exc: BaseException) -> str:
    """The traceback from the cell's own frames only: this module is not the model's code."""
    tb = traceback.TracebackException.from_exception(exc)
    tb.stack = traceback.StackSummary.from_list([f for f in tb.stack if f.filename == "<cell>"])
    return "".join(tb.format())


def run(code: str, nonce: str, seconds: int) -> None:
    """Run one cell in the session's namespace, with a cutoff of ``seconds``, then report on
    one line after ``nonce`` what it did and which files it wrote."""
    _clear_out()
    _SAVED.clear()
    started = time.time()
    status, error = "ok", None
    previous: Any = None
    armed = False
    try:
        previous = signal.signal(signal.SIGALRM, _alarm)
        signal.setitimer(signal.ITIMER_REAL, seconds)
        armed = True
    except (ValueError, OSError):
        # Not in the main thread: the connector's own read timeout cuts the cell instead.
        pass
    try:
        namespace = sys.modules["__main__"].__dict__
        tree = ast.parse(code, "<cell>", "exec")
        last = None
        tail = tree.body[-1] if tree.body else None
        if isinstance(tail, ast.Expr):
            tree.body.pop()
            last = ast.Expression(tail.value)
        exec(compile(tree, "<cell>", "exec"), namespace)  # noqa: S102 - the sandbox's job
        if last is not None:
            value = eval(compile(last, "<cell>", "eval"), namespace)  # noqa: S307
            if value is not None:
                print(repr(value)[:20_000])
    except _CellTimeoutError:
        status = "timeout"
        print(f"The cell was stopped after {seconds} seconds.", file=sys.stderr)
    except BaseException as exc:  # noqa: BLE001 - every failure of the cell is its result
        status = "error"
        error = {"name": type(exc).__name__, "message": str(exc)[:2000]}
        print(_cell_traceback(exc), file=sys.stderr, end="")
    finally:
        if armed:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
    try:
        _save_figures(nonce[:8])
    except Exception as exc:  # noqa: BLE001
        print(f"A figure could not be saved: {type(exc).__name__}", file=sys.stderr)
    report = {"status": status, "error": error, "files": _changed(started)}
    sys.stdout.flush()
    print(f"\n{nonce}{json.dumps(report, default=str)}", flush=True)


def _alarm(_signum: int, _frame: object) -> None:
    raise _CellTimeoutError
