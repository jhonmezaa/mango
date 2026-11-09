"""The Python the connector itself sends to the sandbox: the bootstrap of a session and the
wrapper of a cell. Values go in as Python literals (``repr``), never pasted into the source."""

from __future__ import annotations

import json
import posixpath
from dataclasses import dataclass
from pathlib import Path

LOGICAL_ROOT = "/mnt/data"
"""What the model and the person see as the working folder (D114 (5))."""
_HELPER = (Path(__file__).parent / "sandbox_helper.py").read_text(encoding="utf-8")


@dataclass(frozen=True)
class Layout:
    """Where the session works, all inside its working directory (``root``): ``data`` (what the
    model and the person see as ``/mnt/data``), ``out`` and ``lib`` (Mango's own, hidden). The
    file tools of the sandbox only reach paths inside ``root``."""

    data: str
    out: str
    lib: str

    @property
    def root(self) -> str:
        """The session's working directory: ``lib`` is ``<root>/.mango/lib``."""
        return posixpath.dirname(posixpath.dirname(self.lib.rstrip("/")))


def bootstrap(nonce: str) -> str:
    """Code of the first call of a session: write ``_mango``, set the folders up and report
    them on one line after ``nonce``. Every folder is inside the working directory, the only
    place the file tools reach (``/mnt/data`` is never made: the service does not let it be)."""
    return f"""
import json as _j, os as _o, sys as _s
_base = _o.getcwd()
_data = _o.path.join(_base, "data")
_lib = _o.path.join(_base, ".mango", "lib")
_out = _o.path.join(_base, ".mango", "out")
_o.makedirs(_lib, exist_ok=True)
with open(_o.path.join(_lib, "_mango.py"), "w", encoding="utf-8") as _h:
    _h.write({_HELPER!r})
if _lib not in _s.path:
    _s.path.insert(0, _lib)
import _mango
_mango.setup(_data, _out)
from _mango import display_chart, display_table
print("\\n" + {nonce!r} + _j.dumps({{"data": _data, "out": _out, "lib": _lib}}), flush=True)
"""


def cell(layout: Layout, code: str, nonce: str, seconds: int) -> str:
    """Code of one cell: ``_mango.run`` with the model's code as a literal."""
    return (
        "import sys as _s\n"
        f"if {layout.lib!r} not in _s.path:\n"
        f"    _s.path.insert(0, {layout.lib!r})\n"
        "import _mango\n"
        f"_mango.setup({layout.data!r}, {layout.out!r})\n"
        f"_mango.run({code!r}, {nonce!r}, {int(seconds)})\n"
    )


def split_report(stdout: str, nonce: str) -> tuple[str, dict[str, object] | None]:
    """The cell's own stdout and the report after the last ``nonce``; ``None`` when there is
    none (the cell was cut, or printed too much for the report to arrive)."""
    at = stdout.rfind(nonce)
    if at < 0:
        return stdout, None
    line = stdout[at + len(nonce) :].split("\n", 1)[0]
    try:
        report = json.loads(line)
    except ValueError:
        return stdout, None
    own = stdout[:at]
    if own.endswith("\n"):
        own = own[:-1]
    return own, report if isinstance(report, dict) else None
