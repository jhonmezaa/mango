"""The release manifest (MCP catalog) describes exactly what the connector does."""

import json
from pathlib import Path

from mango_cost_explorer.handler import TOOLS

ROOT = Path(__file__).parents[1]
MANIFEST = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
BY_NAME = {tool["name"]: tool for tool in MANIFEST["tools"]}


def test_manifest_id_matches_the_connector_folder() -> None:
    assert MANIFEST["id"] == ROOT.name
    assert MANIFEST["kind"] == "connector"


def test_manifest_and_handler_expose_the_same_tools() -> None:
    assert set(BY_NAME) == set(TOOLS)
    assert len(MANIFEST["tools"]) == len(BY_NAME)


def test_organization_wide_tools_are_declared_central() -> None:
    central = {name for name, tool in BY_NAME.items() if tool["audience"] == "central"}
    assert central == {name for name, spec in TOOLS.items() if spec.central_only}


def test_the_connector_only_reads_and_filters_by_user() -> None:
    assert {tool["access"] for tool in MANIFEST["tools"]} == {"read"}
    assert MANIFEST["data_tier"] == "account_data"
    assert MANIFEST["identity_mode"] == "per_user"


def test_manifest_lists_every_action_the_tools_use() -> None:
    declared = {action for statement in MANIFEST["iam"] for action in statement["actions"]}
    assert declared == {action for spec in TOOLS.values() for action in spec.actions}
