"""The helper that runs inside the sandbox (``_mango``): one figure reaches the chat once."""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path
from typing import Any

import pytest


class _Figure:
    def savefig(self, fname: Any, *args: Any, **kwargs: Any) -> None:
        Path(fname).write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 16)


@pytest.fixture
def helper(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    """The helper with a fake matplotlib: two open figures, ``Agg`` accepted."""
    figures = {1: _Figure(), 2: _Figure()}
    matplotlib = types.ModuleType("matplotlib")
    matplotlib.use = lambda backend: None  # type: ignore[attr-defined]
    figure_module = types.ModuleType("matplotlib.figure")
    figure_module.Figure = _Figure  # type: ignore[attr-defined]
    pyplot = types.ModuleType("matplotlib.pyplot")
    pyplot.get_fignums = lambda: sorted(figures)  # type: ignore[attr-defined]
    pyplot.figure = lambda n: figures[n]  # type: ignore[attr-defined]
    pyplot.close = lambda what: figures.clear()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "matplotlib", matplotlib)
    monkeypatch.setitem(sys.modules, "matplotlib.figure", figure_module)
    monkeypatch.setitem(sys.modules, "matplotlib.pyplot", pyplot)
    original = _Figure.savefig
    module = importlib.reload(importlib.import_module("mango_code_interpreter.sandbox_helper"))
    module.setup(str(tmp_path / "data"), str(tmp_path / "out"))
    yield module, figures
    _Figure.savefig = original  # type: ignore[method-assign]


def test_a_figure_the_cell_saved_as_an_image_is_not_captured_again(helper: Any) -> None:
    module, figures = helper
    module._SAVED.clear()
    figures[1].savefig(Path(module.DATA) / "top5.png", dpi=150)
    module._save_figures("abcd1234")
    captured = sorted(p.name for p in Path(module.OUT).iterdir())
    # Figure 1 is top5.png already; only figure 2, which the cell did not save, is captured.
    assert captured == ["figure-abcd1234-2.png"]


def test_a_figure_saved_in_another_format_is_still_captured(helper: Any) -> None:
    module, figures = helper
    module._SAVED.clear()
    figures[1].savefig(Path(module.DATA) / "top5.svg")
    module._save_figures("abcd1234")
    assert sorted(p.name for p in Path(module.OUT).iterdir()) == [
        "figure-abcd1234-1.png",
        "figure-abcd1234-2.png",
    ]
