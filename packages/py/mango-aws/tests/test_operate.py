import re
from pathlib import Path

import pytest

from mango_aws.operate import APPROVAL_TAG, write_caller


def test_a_write_session_names_the_person_the_agent_and_the_approval() -> None:
    caller = write_caller(user_id="user-1", agent_id="finops", approval_id="a" * 32)
    assert caller.source_identity == "user-1"
    assert caller.tags == {"mango_user": "user-1", "mango_agent": "finops", APPROVAL_TAG: "a" * 32}


@pytest.mark.parametrize(
    ("agent_id", "approval_id"),
    [("finops", ""), ("finops", "APR-1"), ("", "a" * 32), ("Bad Agent", "a" * 32)],
)
def test_no_write_session_without_an_approval_and_an_agent(agent_id: str, approval_id: str) -> None:
    with pytest.raises(ValueError, match="approval"):
        write_caller(user_id="user-1", agent_id=agent_id, approval_id=approval_id)


def test_the_person_must_be_a_valid_source_identity() -> None:
    with pytest.raises(ValueError, match="SourceIdentity"):
        write_caller(user_id="bad user", agent_id="finops", approval_id="a" * 32)


def test_only_the_approval_executor_uses_the_write_capability() -> None:
    """Dependency rule of the repository (AGENTS.md): a connector never writes."""
    root = Path(__file__).parents[4]
    importers = sorted(
        str(path.relative_to(root).parts[:2])
        for folder in ("apps", "connectors", "functions", "packages", "deployment")
        for path in (root / folder).rglob("*.py")
        if ".venv" not in path.parts
        and "tests" not in path.parts
        and "mango_aws" not in path.parts
        and re.search(r"mango_aws(\.operate|\s+import\s+operate)", path.read_text(encoding="utf-8"))
    )
    assert set(importers) == {"('functions', 'approval-executor')"}
