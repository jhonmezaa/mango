"""Item layout shared by mango-api and the pack provisioner."""

import re
from datetime import UTC, datetime, timedelta

import pytest

from mango_packs.enablement import (
    PackStatus,
    approve_item,
    begin_item,
    change_partition,
    disable_item,
    disabled_items,
    enabled_items,
    enablement_key,
    fail_item,
    installed_key,
    is_pack_id,
    retry_item,
    unlock_item,
)

NOW = datetime(2026, 10, 1, 15, 0, tzinfo=UTC)
# Keep in sync with PACK_PROVISIONER_WRITABLE_ATTRIBUTES (infra/lib/constructs/pack-provisioner.ts):
# IAM only lets the provisioner name these attributes in a write to an enablement item.
WRITABLE = {
    "PK",
    "SK",
    "status",
    "status_at",
    "failed_step",
    "failure",
    "enablement_id",
    "pack_version",
    "provision_lock",
    "provision_lock_until",
}


def test_keys() -> None:
    assert enablement_key("aws-pricing") == {
        "PK": {"S": "MCP#aws-pricing"},
        "SK": {"S": "ENABLEMENT"},
    }
    assert installed_key("aws-pricing") == {
        "PK": {"S": "MCP_INSTALLED#aws-pricing"},
        "SK": {"S": "CURRENT"},
    }


@pytest.mark.parametrize("value", ["", "Aws", "a_b", "a/b", "MCP#x", "a" * 25, "-a", "a-", 7, None])
def test_pack_ids_are_strict(value: object) -> None:
    assert not is_pack_id(value)
    if isinstance(value, str):
        with pytest.raises(ValueError, match="invalid pack id"):
            enablement_key(value)


def test_pack_ids() -> None:
    assert is_pack_id("aws-pricing")
    assert is_pack_id("a" * 24)


def _names(update: dict[str, object]) -> set[str]:
    """Attribute names an update expression and its condition mention."""
    text = f"{update['UpdateExpression']} {update.get('ConditionExpression', '')}"
    aliases = update.get("ExpressionAttributeNames", {})
    assert isinstance(aliases, dict)
    for alias, name in aliases.items():
        text = text.replace(alias, name)
    words = set(re.findall(r"(?<![:#\w])[a-z_]+(?![\w(])", text))
    return words - {"attribute_not_exists", "attribute_exists"}


def test_the_provisioner_only_writes_its_own_attributes() -> None:
    common = {"pack_id": "aws-pricing", "owner": "exec-1"}
    updates = [
        begin_item(
            "t",
            **common,
            enablement_id="enablement-0001",
            pack_version="1.1.1-1",
            now=NOW,
            ttl=timedelta(minutes=45),
            disable=False,
        ),
        begin_item(
            "t",
            **common,
            enablement_id="enablement-0001",
            pack_version="1.1.1-1",
            now=NOW,
            ttl=timedelta(minutes=45),
            disable=True,
        ),
        unlock_item("t", **common),
        fail_item("t", **common, failed_step="load", failure="x", now=NOW, disable=False),
        fail_item("t", **common, failed_step="remove", failure="x", now=NOW, disable=True),
        enabled_items("t", **common, enablement_id="enablement-0001", installed={}, now=NOW)[0][
            "Update"
        ],
        disabled_items("t", **common, enablement_id="enablement-0001", now=NOW)[0]["Update"],
    ]
    for update in updates:
        assert update["Key"] == enablement_key("aws-pricing")
        assert _names(update) <= WRITABLE - {"PK", "SK"}, update["UpdateExpression"]


def test_begin_moves_approved_to_installing_under_the_lock() -> None:
    item = begin_item(
        "t",
        pack_id="aws-pricing",
        enablement_id="enablement-0001",
        pack_version="1.1.1-1",
        owner="exec-1",
        now=NOW,
        ttl=timedelta(minutes=45),
        disable=False,
    )
    values = item["ExpressionAttributeValues"]
    assert values[":installing"] == {"S": PackStatus.INSTALLING}
    assert values[":until"] == {"N": str(int(NOW.timestamp()) + 45 * 60)}
    assert "enablement_id = :id AND pack_version = :version" in item["ConditionExpression"]
    assert "provision_lock_until < :now" in item["ConditionExpression"]


def test_installed_pointer_is_written_with_the_enabled_state() -> None:
    update, put = enabled_items(
        "t",
        pack_id="aws-pricing",
        enablement_id="enablement-0001",
        owner="exec-1",
        installed={"runtime_id": "r-1", "tools": ["b", "a"], "config": {"region": "us-east-1"}},
        now=NOW,
    )
    assert "provision_lock = :owner" in update["Update"]["ConditionExpression"]
    item = put["Put"]["Item"]
    assert item["PK"] == {"S": "MCP_INSTALLED#aws-pricing"}
    assert item["runtime_id"] == {"S": "r-1"}
    assert item["tools"] == {"S": '["b", "a"]'}
    assert item["config"] == {"S": '{"region": "us-east-1"}'}
    assert item["installed_at"] == {"S": "2026-10-01T15:00:00+00:00"}


def test_a_failed_removal_stays_disabling() -> None:
    values = fail_item(
        "t",
        pack_id="aws-pricing",
        owner="e",
        failed_step="remove",
        failure="x" * 500,
        now=NOW,
        disable=True,
    )["ExpressionAttributeValues"]
    assert values[":target"] == values[":current"] == {"S": PackStatus.DISABLING}
    assert len(values[":failure"]["S"]) == 200
    with pytest.raises(ValueError, match="invalid step name"):
        fail_item(
            "t",
            pack_id="aws-pricing",
            owner="e",
            failed_step="Bad Step",
            failure="x",
            now=NOW,
            disable=False,
        )


# --- mango-api transitions ------------------------------------------------------------------

LOCK_FREE = "(attribute_not_exists(provision_lock) OR provision_lock_until < :now)"


def _approve(expected_version: int) -> dict[str, object]:
    return approve_item(
        "t",
        pack_id="aws-pricing",
        enablement_id="e" * 32,
        pack_version="1.1.1-1",
        config={"region": "us-east-1"},
        requested_by="admin-1",
        approved_by="admin-2",
        expected_version=expected_version,
        now=NOW,
        extra={"approved_at": "2026-10-01T15:00:00+00:00"},
    )


def test_requests_live_in_a_partition_the_provisioner_cannot_read() -> None:
    # The provisioner's IAM policy only names `MCP#*` and `MCP_INSTALLED#*`.
    partition = change_partition("aws-pricing")
    assert partition == "MCP_CHANGE#aws-pricing"
    assert not partition.startswith(("MCP#", "MCP_INSTALLED#"))
    with pytest.raises(ValueError, match="invalid pack id"):
        change_partition("MCP#x")


def test_first_approval_only_applies_to_a_pack_nobody_approved_before() -> None:
    update = _approve(0)
    assert update["Key"] == enablement_key("aws-pricing")
    condition = str(update["ConditionExpression"])
    assert condition.startswith("attribute_not_exists(version) AND (attribute_not_exists(#s) OR")
    assert condition.endswith(LOCK_FREE)
    values = update["ExpressionAttributeValues"]
    assert isinstance(values, dict)
    assert {"S": PackStatus.APPROVED} in values.values()
    assert {"S": "e" * 32} in values.values()
    assert {"S": '{"region":"us-east-1"}'} in values.values()
    assert {"N": "1"} in values.values()  # version 0 -> 1
    assert str(update["UpdateExpression"]).endswith(
        "REMOVE failed_step, failure, disabled_by, disabled_by_email, disabled_at, disable_reason"
    )


def test_later_approvals_need_the_version_a_settled_status_and_no_execution() -> None:
    update = _approve(4)
    condition = str(update["ConditionExpression"])
    assert condition.startswith("version = :expected AND #s IN (")
    assert condition.endswith(LOCK_FREE)
    values = update["ExpressionAttributeValues"]
    assert isinstance(values, dict)
    assert values[":expected"] == {"N": "4"}
    allowed = {values[name]["S"] for name in values if name.startswith(":st")}
    # Never over a request that is approved, installing or being removed.
    assert allowed == {PackStatus.ENABLED, PackStatus.FAILED, PackStatus.DISABLED}


def test_approval_needs_a_well_formed_enablement_id() -> None:
    with pytest.raises(ValueError, match="invalid enablement id"):
        approve_item(
            "t",
            pack_id="aws-pricing",
            enablement_id="short",
            pack_version="1.1.1-1",
            config={},
            requested_by="a",
            approved_by="b",
            expected_version=0,
            now=NOW,
        )


def test_retry_keeps_what_was_approved() -> None:
    update = retry_item(
        "t", pack_id="aws-pricing", enablement_id="e" * 32, expected_version=2, now=NOW
    )
    # Only the status, its date and the version change; the failure is cleared.
    assert _names(update) - {"provision_lock", "provision_lock_until"} == {
        "status",
        "status_at",
        "version",
        "failed_step",
        "failure",
        "enablement_id",
    }
    condition = str(update["ConditionExpression"])
    assert condition.startswith("enablement_id = :id AND version = :expected AND #s IN (:st0)")
    assert update["ExpressionAttributeValues"][":st0"] == {"S": PackStatus.FAILED}


def test_disable_only_applies_to_an_installed_or_failed_pack() -> None:
    update = disable_item(
        "t",
        pack_id="aws-pricing",
        expected_version=3,
        disabled_by="admin-1",
        disabled_by_email="a@example.com",
        reason="unused",
        now=NOW,
    )
    values = update["ExpressionAttributeValues"]
    assert values[":disabling"] == {"S": PackStatus.DISABLING}
    assert {values[":st0"]["S"], values[":st1"]["S"]} == {PackStatus.ENABLED, PackStatus.FAILED}
    assert values[":reason"] == {"S": "unused"} and values[":email"] == {"S": "a@example.com"}
    assert str(update["ConditionExpression"]).endswith(LOCK_FREE)
    # What was approved stays as the provisioner needs it to remove the pack.
    assert not {"enablement_id", "pack_version", "config"} & _names(update)
