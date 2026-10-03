from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic import ValidationError

from mango_packs.manifest import IdentityChain, PackManifest


def _invalid(data: dict[str, Any], match: str) -> None:
    with pytest.raises(ValidationError, match=match):
        PackManifest.model_validate(data)


def test_valid_manifest(manifest_data: dict[str, Any]) -> None:
    manifest = PackManifest.model_validate(manifest_data)
    assert manifest.tool_names == {"get_pricing"}
    assert manifest.runtime.entrypoint == "entrypoint.py"
    assert manifest.runtime.port == 8000


def test_rejects_unknown_fields(manifest_data: dict[str, Any]) -> None:
    _invalid({**manifest_data, "image": {"digest": "sha256:x"}}, "Extra inputs")
    manifest_data["iam"][0]["effect"] = "Allow"
    _invalid(manifest_data, "Extra inputs")


@pytest.mark.parametrize(
    "action", ["pricing:*", "*", "pricing:Get*", "*:GetProducts", "pricing", "iam:Pass Role"]
)
def test_rejects_iam_wildcards_and_malformed_actions(
    manifest_data: dict[str, Any], action: str
) -> None:
    manifest_data["iam"][0]["actions"] = [action]
    _invalid(manifest_data, "actions")


def test_wildcard_resource_needs_a_reason(manifest_data: dict[str, Any]) -> None:
    del manifest_data["iam"][0]["reason"]
    _invalid(manifest_data, "requires a reason")
    manifest_data["iam"][0]["resources"] = ["arn:aws:s3:::bucket/*"]
    PackManifest.model_validate(manifest_data)


def test_rejects_resources_that_are_not_arns(manifest_data: dict[str, Any]) -> None:
    manifest_data["iam"][0]["resources"] = ["s3://bucket"]
    _invalid(manifest_data, "resources")


@pytest.mark.parametrize(
    ("tier", "mode"),
    [("public", "central_only"), ("account_data", "service"), ("write", "service")],
)
def test_service_identity_only_for_public_data(
    manifest_data: dict[str, Any], tier: str, mode: str
) -> None:
    _invalid({**manifest_data, "data_tier": tier, "identity_mode": mode}, "identity_mode")


def test_write_tools_only_in_the_write_tier(manifest_data: dict[str, Any]) -> None:
    manifest_data["tools"].append({"name": "delete_thing", "access": "write"})
    _invalid(manifest_data, "write tools")
    write = {"data_tier": "write", "identity_mode": "central_only", "egress": {"aws": ["sts"]}}
    PackManifest.model_validate({**manifest_data, **write})
    manifest_data["tools"].pop()
    _invalid({**manifest_data, **write}, "write tools")


def test_rejects_duplicate_tools_and_bad_names(manifest_data: dict[str, Any]) -> None:
    manifest_data["tools"].append({"name": "get_pricing", "access": "read"})
    _invalid(manifest_data, "duplicate tool name")
    manifest_data["tools"] = [{"name": "get pricing; rm", "access": "read"}]
    _invalid(manifest_data, "tools")
    manifest_data["tools"] = []
    _invalid(manifest_data, "tools")


def test_version_is_bound_to_the_upstream_version(manifest_data: dict[str, Any]) -> None:
    _invalid({**manifest_data, "version": "1.1.2-1"}, "source.version")
    _invalid({**manifest_data, "version": "1.1.1"}, "version")
    _invalid({**manifest_data, "version": "1.1.1-0"}, "version")


def test_pinned_hashes_must_be_sha256(manifest_data: dict[str, Any]) -> None:
    _invalid({**manifest_data, "tools_hash": "md5:abc"}, "tools_hash")
    manifest_data["source"]["sha256"] = "A" * 64
    _invalid(manifest_data, "sha256")


def test_config_is_an_enum_and_never_a_secret(manifest_data: dict[str, Any]) -> None:
    param = manifest_data["config"][0]
    manifest_data["config"] = [{**param, "default": "us-west-2"}]
    _invalid(manifest_data, "allowed values")
    manifest_data["config"] = [{**param, "allowed": ["us-east-1", "$(curl evil)"]}]
    _invalid(manifest_data, "allowed")
    manifest_data["config"] = [{**param, "allowed": []}]
    _invalid(manifest_data, "allowed")
    for key in ("api_key", "db_password", "auth_token", "client_secret"):
        manifest_data["config"] = [{**param, "key": key}]
        _invalid(manifest_data, "looks like a secret")
    manifest_data["config"] = [param, param]
    _invalid(manifest_data, "duplicate config key")


def test_quarantine_of_seven_days(manifest_data: dict[str, Any]) -> None:
    manifest = PackManifest.model_validate(manifest_data)
    assert manifest.quarantine_error(datetime(2026, 10, 1, tzinfo=UTC)) is None
    error = manifest.quarantine_error(datetime(2026, 9, 30, 23, 59, tzinfo=UTC))
    assert error is not None
    assert "7 days" in error


def test_quarantine_exception_needs_an_advisory(manifest_data: dict[str, Any]) -> None:
    manifest_data["source"]["quarantine_exception"] = "CVE-2026-12345"
    manifest = PackManifest.model_validate(manifest_data)
    assert manifest.quarantine_error(datetime(2026, 9, 25, tzinfo=UTC)) is None
    manifest_data["source"]["quarantine_exception"] = "urgent"
    _invalid(manifest_data, "quarantine_exception")


def test_cutoff_needs_a_timezone(manifest_data: dict[str, Any]) -> None:
    manifest_data["source"]["exclude_newer"] = "2026-09-24T00:00:00"
    _invalid(manifest_data, "exclude_newer")


def _account_data(manifest_data: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {
        **manifest_data,
        "data_tier": "account_data",
        "identity_mode": "central_only",
        "egress": {"aws": ["sts"]},
        **extra,
    }


def test_identity_chain_defaults_to_payer_and_is_not_serialized(
    manifest_data: dict[str, Any],
) -> None:
    # Statements signed before the field existed must keep their exact bytes (D49 (5)).
    for data in (manifest_data, _account_data(manifest_data)):
        manifest = PackManifest.model_validate(data)
        assert manifest.identity.chain is IdentityChain.PAYER
        assert not manifest.member_chain
        assert "identity" not in manifest.model_dump(mode="json")
    explicit = PackManifest.model_validate(
        _account_data(manifest_data, identity={"chain": "payer"})
    )
    assert "identity" not in explicit.model_dump(mode="json")


def test_member_chain_is_part_of_the_serialized_manifest(manifest_data: dict[str, Any]) -> None:
    manifest = PackManifest.model_validate(
        _account_data(manifest_data, identity={"chain": "member"})
    )
    assert manifest.member_chain
    dumped = manifest.model_dump(mode="json")
    assert dumped["identity"] == {"chain": "member"}
    assert PackManifest.model_validate(dumped) == manifest


def test_member_chain_only_for_central_only_packs(manifest_data: dict[str, Any]) -> None:
    _invalid({**manifest_data, "identity": {"chain": "member"}}, "central_only")
    _invalid(
        _account_data(
            manifest_data, identity_mode="per_user_adapter", identity={"chain": "member"}
        ),
        "central_only",
    )


def test_rejects_unknown_identity_chains_and_fields(manifest_data: dict[str, Any]) -> None:
    _invalid(_account_data(manifest_data, identity={"chain": "operator"}), "chain")
    _invalid(
        _account_data(manifest_data, identity={"chain": "member", "role": "x"}), "Extra inputs"
    )


def test_egress_is_mandatory_and_a_closed_list(manifest_data: dict[str, Any]) -> None:
    assert PackManifest.model_validate(manifest_data).egress.hosts == []
    _invalid({k: v for k, v in manifest_data.items() if k != "egress"}, "egress")
    for bad in (
        {"aws": ["s3"]},  # not in the endpoint catalog
        {"aws": ["pricing", "pricing"]},
        {"aws": ["pricing"], "ports": [80]},
        {"aws": ["*"]},
    ):
        _invalid({**manifest_data, "egress": bad}, "egress")


@pytest.mark.parametrize(
    "host",
    [
        "*.example.com",
        "10.0.0.5",
        "169.254.169.254",
        "localhost",
        "Example.com",
        "example.com.",
        "example.com:8443",
        "https://example.com",
        "exa mple.com",
        "a" * 250 + ".com",
    ],
)
def test_egress_hosts_are_plain_host_names(manifest_data: dict[str, Any], host: str) -> None:
    _invalid({**manifest_data, "egress": {"aws": [], "hosts": [host]}}, "egress")


def test_a_pack_with_external_hosts_is_valid_but_not_installable(
    manifest_data: dict[str, Any],
) -> None:
    """The field is part of what is signed, but no installation can enforce it yet (R6)."""
    manifest = PackManifest.model_validate(
        {**manifest_data, "egress": {"aws": ["pricing"], "hosts": ["api.example.com"]}}
    )
    assert manifest.egress.hosts == ["api.example.com"]
    assert manifest.installable is False
    assert PackManifest.model_validate(manifest_data).installable is True
    _invalid(
        {**manifest_data, "egress": {"aws": [], "hosts": ["api.example.com", "api.example.com"]}},
        "duplicate host",
    )


def test_a_pack_that_acts_as_the_user_declares_sts(manifest_data: dict[str, Any]) -> None:
    account_data = {**manifest_data, "data_tier": "account_data", "identity_mode": "central_only"}
    _invalid({**account_data, "egress": {"aws": ["ce"]}}, "'sts' in egress.aws")
    PackManifest.model_validate({**account_data, "egress": {"aws": ["ce", "sts"]}})
