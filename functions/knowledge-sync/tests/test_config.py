from __future__ import annotations

from decimal import Decimal

import pytest

from mango_knowledge_sync.config import ConfigError, Settings

ENV = {
    "MANGO_NAMESPACE": "lab",
    "KNOWLEDGE_TABLE": "Mango-lab-Knowledge",
    "KNOWLEDGE_BUCKET": "mango-lab-knowledge-0a1b2c3d",
    "KNOWLEDGE_BASE_ID": "KBID000001",
    "DATA_SOURCE_ID": "DSID000001",
    "ACCOUNT_ID": "111122223333",
    "STATE_MACHINE_ARN": (
        "arn:aws:states:us-east-1:111122223333:stateMachine:Mango-lab-KnowledgeSync"
    ),
    "BUDGETS_TABLE": "Mango-lab-Budgets",
    "AUDIT_STREAM": "Mango-lab-Audit",
    "AUDIT_INDEX_TABLE": "Mango-lab-AuditIndex",
    "EMBEDDING_PRICE": "0.02",
}


def test_settings_come_from_the_environment() -> None:
    settings = Settings.from_env(ENV)
    assert settings.embedding_price == Decimal("0.02")
    assert (settings.knowledge_base_id, settings.data_source_id) == ("KBID000001", "DSID000001")


@pytest.mark.parametrize("missing", sorted(ENV))
def test_a_missing_variable_is_an_error(missing: str) -> None:
    with pytest.raises(ConfigError, match=missing):
        Settings.from_env({k: v for k, v in ENV.items() if k != missing})


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("MANGO_NAMESPACE", "Lab"),
        ("KNOWLEDGE_BASE_ID", "kb-1"),
        ("ACCOUNT_ID", "12345"),
        ("STATE_MACHINE_ARN", "arn:aws:states:us-east-1:111122223333:activity:x"),
        ("EMBEDDING_PRICE", "-1"),
        ("EMBEDDING_PRICE", "free"),
        ("EMBEDDING_PRICE", "NaN"),
        ("KNOWLEDGE_TABLE", "a b"),
    ],
)
def test_an_invalid_value_is_an_error(name: str, value: str) -> None:
    with pytest.raises(ConfigError):
        Settings.from_env({**ENV, name: value})
