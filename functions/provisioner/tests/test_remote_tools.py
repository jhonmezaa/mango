"""Tools of remote MCPs in an agent's harness (D93, D98 (13)): only the ones the catalog the
remote provisioner signed names, verified with the public half of its key."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from moto import mock_aws

from mango_core.remote_mcp import SIGNING_CONTEXT, ApprovedRemote, approved_key, item_fields
from mango_provisioner.config import Settings
from mango_provisioner.errors import RetryableError, StepError
from mango_provisioner.harness import allowed_tools, harness_config
from mango_provisioner.store import ApprovedRemoteTools

from .conftest import AGENT, ENV, make_definition

SETTINGS = Settings.from_env(ENV)
REG = "abcdefghij23"
PROJECTS = f"remote-{REG}.core_list_projects"
TABLE = "settings"


@dataclass
class FakeKms:
    key: ec.EllipticCurvePrivateKey = field(
        default_factory=lambda: ec.generate_private_key(ec.SECP256R1())
    )
    asked: list[str] = field(default_factory=list)

    def get_public_key(self, KeyId: str) -> dict[str, Any]:  # noqa: N803
        self.asked.append(KeyId)
        return {
            "PublicKey": self.key.public_key().public_bytes(
                serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
            )
        }


def test_the_settings_name_the_key_and_the_gateway() -> None:
    assert SETTINGS.remote_mcp_key_alias == "alias/Mango-test-remote-mcp"
    assert SETTINGS.gateway_url.startswith(f"https://{SETTINGS.gateway_id}.gateway.")


def test_a_remote_tool_is_allowed_only_if_its_signed_catalog_names_it() -> None:
    signed = {REG: frozenset({"core_list_projects"})}
    definition = make_definition(tools=["cost-explorer.get_cost_and_usage", PROJECTS])
    assert allowed_tools(SETTINGS, definition, remote_tools=signed.get) == [
        "@mango/finops___get_cost_and_usage",
        f"@mango/remote-{REG}___core_list_projects",
    ]
    for tool in (f"remote-{REG}.wiki", "remote-zyxwvutsrq23.core_list_projects"):
        with pytest.raises(StepError, match="unknown_tool"):
            allowed_tools(SETTINGS, make_definition(tools=[tool]), remote_tools=signed.get)
    # Without a reader of signed catalogs (the default) nothing remote is published.
    with pytest.raises(StepError, match="unknown_tool"):
        allowed_tools(SETTINGS, make_definition(tools=[PROJECTS]))
    # A remote tool never asks for approval: they are all read (D84 (5)).
    with pytest.raises(StepError, match="write_tools_unsupported"):
        allowed_tools(
            SETTINGS,
            make_definition(tools=[PROJECTS], approval_tools=[PROJECTS]),
            remote_tools=signed.get,
        )
    config = harness_config(
        SETTINGS,
        agent_id=AGENT,
        version=1,
        content_hash="a" * 64,
        definition=make_definition(tools=[PROJECTS]),
        remote_tools=signed.get,
    )
    assert config["allowedTools"] == [f"@mango/remote-{REG}___core_list_projects"]


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        client.create_table(
            TableName=TABLE,
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield client


def _sign(db: Any, key: ec.EllipticCurvePrivateKey, gateway_id: str) -> None:
    payload = ApprovedRemote(
        registration_id=REG,
        generation=1,
        revision=1,
        profile_id="azure-devops",
        profile_version="2026.10.1-1",
        profile_sha256="a" * 64,
        gateway_id=gateway_id,
        organization="contoso",
        toolsets=("core",),
        tools=frozenset({"core_list_projects"}),
        probe_tool="core_list_projects",
        issued_at=1,
    ).encode()
    signature = key.sign(SIGNING_CONTEXT + payload, ec.ECDSA(hashes.SHA256()))
    db.put_item(
        TableName=TABLE,
        Item={
            **approved_key(REG),
            **{k: {"S": v} for k, v in item_fields(payload, signature).items()},
        },
    )


def _reader(db: Any, kms: FakeKms) -> ApprovedRemoteTools:
    return ApprovedRemoteTools(
        db,
        TABLE,
        kms,  # type: ignore[arg-type]
        key_id=SETTINGS.remote_mcp_key_alias,
        gateway_id=SETTINGS.gateway_id,
    )


def test_the_signed_catalog_is_verified_before_it_counts(db: Any) -> None:
    kms = FakeKms()
    reader = _reader(db, kms)
    assert reader(REG) is None
    _sign(db, kms.key, SETTINGS.gateway_id)
    assert reader(REG) == frozenset({"core_list_projects"})
    assert kms.asked == ["alias/Mango-test-remote-mcp"]
    # Another key (what anyone else could write) or another Gateway: nothing.
    _sign(db, ec.generate_private_key(ec.SECP256R1()), SETTINGS.gateway_id)
    assert reader(REG) is None
    _sign(db, kms.key, "othergateway")
    assert reader(REG) is None


def test_a_read_error_is_raised_never_read_as_no_tools(db: Any) -> None:
    class Failing:
        def get_item(self, **_kwargs: Any) -> Any:
            raise ClientError({"Error": {"Code": "ThrottlingException"}}, "GetItem")

    reader = ApprovedRemoteTools(
        Failing(),  # type: ignore[arg-type]
        TABLE,
        FakeKms(),  # type: ignore[arg-type]
        key_id=SETTINGS.remote_mcp_key_alias,
        gateway_id=SETTINGS.gateway_id,
    )
    with pytest.raises(RetryableError):
        reader(REG)
