"""The schema the Gateway shows the model matches what the tools accept."""

from __future__ import annotations

import json
from pathlib import Path

from mango_code_interpreter.handler import (
    MAX_CODE_CHARS,
    MAX_PATH_CHARS,
    RESERVED_CONTEXT_ARG,
    ListArguments,
    ReadArguments,
    RunArguments,
)
from mango_code_interpreter.outputs import TYPES
from mango_core.code_sandbox import CELL_SECONDS
from mango_core.harness_tools import CODE_TOOLS

SCHEMA = Path(__file__).resolve().parents[1] / "tool-schema.json"


def test_the_tools_and_their_arguments_are_the_ones_accepted() -> None:
    tools = {t["name"]: t for t in json.loads(SCHEMA.read_text())}
    assert tuple(tools) == CODE_TOOLS
    for name, model in (
        ("run_python", RunArguments),
        ("list_files", ListArguments),
        ("read_file", ReadArguments),
    ):
        assert set(tools[name]["inputSchema"]["properties"]) == set(model.model_fields)
    # The model never sees the argument the interceptor sets.
    assert RESERVED_CONTEXT_ARG not in SCHEMA.read_text()


def test_the_descriptions_say_the_real_limits_and_types() -> None:
    tools = {t["name"]: t for t in json.loads(SCHEMA.read_text())}
    run = tools["run_python"]
    assert str(MAX_CODE_CHARS) in run["inputSchema"]["properties"]["code"]["description"]
    assert f"{CELL_SECONDS} seconds" in run["description"]
    for extension in TYPES:
        if extension != "jpeg":
            assert extension in run["description"]
    assert (
        str(MAX_PATH_CHARS)
        in tools["read_file"]["inputSchema"]["properties"]["path"]["description"]
    )
