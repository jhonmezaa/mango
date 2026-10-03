import json
from pathlib import Path

import pytest

from mango_cost_explorer.handler import RESERVED_CONTEXT_ARG, TOOLS

SCHEMA = json.loads((Path(__file__).parents[1] / "tool-schema.json").read_text())
BY_NAME = {tool["name"]: tool for tool in SCHEMA}


def test_schema_and_handler_expose_the_same_tools() -> None:
    assert set(BY_NAME) == set(TOOLS)


@pytest.mark.parametrize("name", sorted(TOOLS))
def test_schema_properties_match_argument_model(name: str) -> None:
    schema = BY_NAME[name]["inputSchema"]
    model_fields = set(TOOLS[name].args_model.model_fields)
    assert set(schema.get("properties", {})) == model_fields
    required = {f for f, info in TOOLS[name].args_model.model_fields.items() if info.is_required()}
    assert set(schema.get("required", [])) == required


def test_reserved_context_argument_is_not_advertised_to_the_model() -> None:
    for tool in SCHEMA:
        assert RESERVED_CONTEXT_ARG not in tool["inputSchema"].get("properties", {})
