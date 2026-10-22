"""The schema the Gateway shows the model matches what the tool accepts."""

from __future__ import annotations

import json
from pathlib import Path

from mango_core.harness_tools import KNOWLEDGE_TOOL
from mango_core.knowledge_search import MAX_QUERY_CHARS
from mango_knowledge_retrieve.handler import RESERVED_CONTEXT_ARG, Arguments

SCHEMA = Path(__file__).resolve().parents[1] / "tool-schema.json"


def test_one_tool_whose_arguments_are_the_ones_accepted() -> None:
    [tool] = json.loads(SCHEMA.read_text())
    assert tool["name"] == KNOWLEDGE_TOOL
    properties = tool["inputSchema"]["properties"]
    assert set(properties) == set(Arguments.model_fields)
    assert tool["inputSchema"]["required"] == ["query"]
    # The model never sees the argument the interceptor sets.
    assert RESERVED_CONTEXT_ARG not in json.dumps(tool)
    assert str(MAX_QUERY_CHARS) in properties["query"]["description"]
