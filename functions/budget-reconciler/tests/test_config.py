from __future__ import annotations

import pytest

from mango_budget_reconciler.config import ConfigError, Settings

ENV = {
    "MANGO_NAMESPACE": "lab",
    "BUDGETS_TABLE": "Mango-lab-Budgets",
    "AUDIT_STREAM": "Mango-lab-Audit",
    "AUDIT_INDEX_TABLE": "Mango-lab-AuditIndex",
}


def test_settings_come_from_the_environment() -> None:
    settings = Settings.from_env(ENV)
    assert (settings.namespace, settings.budgets_table) == ("lab", "Mango-lab-Budgets")
    assert (settings.audit_stream, settings.audit_index_table) == (
        "Mango-lab-Audit",
        "Mango-lab-AuditIndex",
    )


@pytest.mark.parametrize("missing", sorted(ENV))
def test_a_missing_variable_is_an_error(missing: str) -> None:
    with pytest.raises(ConfigError, match=missing):
        Settings.from_env({k: v for k, v in ENV.items() if k != missing})


@pytest.mark.parametrize(
    "change", [{"MANGO_NAMESPACE": "Lab!"}, {"BUDGETS_TABLE": "a b"}, {"AUDIT_STREAM": ""}]
)
def test_values_of_another_shape_are_refused(change: dict[str, str]) -> None:
    with pytest.raises(ConfigError):
        Settings.from_env({**ENV, **change})
