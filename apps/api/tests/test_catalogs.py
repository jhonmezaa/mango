"""Release MCP catalog (connector manifests) and the read-only model catalog."""

from __future__ import annotations

import json
from collections.abc import Iterator
from decimal import Decimal
from pathlib import Path
from typing import Any

import boto3
import pytest
from moto import mock_aws

from mango_api.mcp_catalog import DataTier, IdentityMode, InvalidCatalogError, McpCatalog
from mango_api.model_catalog import ModelCatalogStore, ModelCatalogUnavailableError

CONNECTORS = Path(__file__).parents[3] / "connectors"
TABLE = "Mango-test-Settings"
SONNET = "us.anthropic.claude-sonnet-4-6"


# --- MCP catalog ----------------------------------------------------------------------------------


def test_the_release_catalog_lists_only_the_connectors_that_exist() -> None:
    catalog = McpCatalog.load(CONNECTORS)
    assert [c.id for c in catalog.connectors] == ["aws-budgets", "cost-explorer"]
    writer, connector = catalog.connectors
    assert connector.data_tier is DataTier.ACCOUNT_DATA
    assert connector.identity_mode is IdentityMode.PER_USER
    assert connector.gateway_target == "finops"
    # The write connector (D27): its own Gateway target, served by the approval executor.
    assert writer.data_tier is DataTier.WRITE and writer.gateway_target == "ops"
    budget = catalog.tool("aws-budgets.create_budget")
    assert budget is not None and budget.is_write and budget.tool.audience == "central"
    assert budget.tool.approval is not None and budget.tool.approval.amount == "amount_usd"


def test_tool_lookup_by_reference() -> None:
    catalog = McpCatalog.load(CONNECTORS)
    tool = catalog.tool("cost-explorer.get_cost_and_usage")
    assert tool is not None
    assert tool.enabled and not tool.is_write and not tool.central_groups_only
    org_wide = catalog.tool("cost-explorer.get_savings_plans_utilization")
    assert org_wide is not None and org_wide.tool.audience == "central"
    assert catalog.tool("cost-explorer.unknown") is None
    assert catalog.tool("get_cost_and_usage") is None


def _write(folder: Path, manifest: dict[str, Any]) -> None:
    folder.mkdir(parents=True)
    (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def _manifest(**overrides: Any) -> dict[str, Any]:
    base = json.loads((CONNECTORS / "cost-explorer" / "manifest.json").read_text(encoding="utf-8"))
    return {**base, **overrides}


@pytest.mark.parametrize(
    "overrides",
    [
        {"id": "other"},  # does not match its folder
        {"kind": "pack"},
        {"data_tier": "secret"},
        {"identity_mode": "anything"},
        {"role_arn": "arn:aws:iam::111111111111:role/Admin"},
        {"tools": []},
        {"tools": [{"name": "t", "description": "", "access": "admin"}]},
        {
            "tools": [
                {"name": "t", "description": "", "access": "read"},
                {"name": "t", "description": "", "access": "write"},
            ]
        },
        {"iam": [{"actions": ["*"], "resources": ["*"]}]},
    ],
)
def test_a_malformed_manifest_fails_closed(tmp_path: Path, overrides: dict[str, Any]) -> None:
    _write(tmp_path / "cost-explorer", _manifest(**overrides))
    with pytest.raises(InvalidCatalogError):
        McpCatalog.load(tmp_path)


def test_missing_catalog_folder_fails_closed(tmp_path: Path) -> None:
    with pytest.raises(InvalidCatalogError):
        McpCatalog.load(tmp_path / "missing")
    (tmp_path / "cost-explorer").mkdir()
    (tmp_path / "cost-explorer" / "manifest.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(InvalidCatalogError):
        McpCatalog.load(tmp_path)


def test_folders_without_a_manifest_are_not_connectors(tmp_path: Path) -> None:
    (tmp_path / "notes").mkdir()
    assert McpCatalog.load(tmp_path).connectors == ()


# --- Model catalog --------------------------------------------------------------------------------


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        client.create_table(
            TableName=TABLE,
            BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
            ],
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
        )
        yield client


def _seed(db: Any, models: object) -> None:
    db.put_item(
        TableName=TABLE,
        Item={
            "PK": {"S": "MODELS"},
            "SK": {"S": "CATALOG"},
            "models": {"S": models if isinstance(models, str) else json.dumps(models)},
            "version": {"N": "1"},
        },
    )


def _entry(**overrides: Any) -> dict[str, Any]:
    """Same shape as the IaC seed (`infra/lib/constructs/governance.ts`)."""
    return {
        "id": SONNET,
        "name": SONNET,
        "provider": "anthropic",
        "enabled": True,
        "supports_tools": True,
        "input_usd": "3",
        "output_usd": "15",
        "cache_read_usd": "0.3",
        "cache_write_usd": "3.75",
        **overrides,
    }


def test_reads_the_seeded_catalog(db: Any) -> None:
    _seed(db, [_entry(), _entry(id="us.anthropic.claude-haiku-4-5", enabled=False)])
    catalog = ModelCatalogStore(db, TABLE).catalog()
    assert catalog.version == 1
    assert [m.id for m in catalog.enabled] == [SONNET]
    sonnet = catalog.get(SONNET)
    assert sonnet is not None
    assert (sonnet.input_usd, sonnet.cache_read_usd) == (Decimal(3), Decimal("0.3"))
    assert catalog.get("us.anthropic.unknown") is None


@pytest.mark.parametrize(
    "models",
    [
        "{not json",
        {"id": SONNET},
        [_entry(input_usd="-1")],
        [_entry(api_key="x")],
        [_entry(), _entry()],
        [{"id": SONNET}],
    ],
)
def test_an_invalid_catalog_fails_closed(db: Any, models: object) -> None:
    _seed(db, models)
    with pytest.raises(ModelCatalogUnavailableError):
        ModelCatalogStore(db, TABLE).catalog()


def test_a_missing_catalog_fails_closed(db: Any) -> None:
    with pytest.raises(ModelCatalogUnavailableError):
        ModelCatalogStore(db, TABLE).catalog()
    with pytest.raises(ModelCatalogUnavailableError):
        ModelCatalogStore(db, "Mango-test-Missing").catalog()
