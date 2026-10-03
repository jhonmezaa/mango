"""The member chain (D51): one member account per call, named by an argument of Mango's own.

The guard validates the account and the Region, removes what the upstream tool must never see
and assumes the session before the tool runs; the listed schemas say the same to the Gateway
and to the model. Every refusal is the same one."""

from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
from typing import Any

import boto3
import pytest
from botocore.credentials import ReadOnlyCredentials
from botocore.exceptions import ClientError, EndpointConnectionError
from botocore.stub import ANY, Stubber
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from mango_pack_runtime import credentials
from mango_pack_runtime.config import PackConfig, PackConfigError, Statement
from mango_pack_runtime.guard import (
    ACCOUNT_PATTERN,
    REGION_PATTERN,
    CallGuard,
    RegionError,
    build_guard,
    member_assume,
    session_policy,
)
from mango_pack_runtime.identity import Caller, IdentityError, IdentityVerifier
from mango_pack_runtime.server import REFUSED_MESSAGE, bind, list_schemas, restrict_tools

from .conftest import IdentityKey

PACK = "aws-cloudwatch"
TOOL = "get_active_alarms"
MANGO_ACCOUNT = "111122223333"
MEMBER = "444455556666"
BROKER = f"arn:aws:iam::{MANGO_ACCOUNT}:role/Mango-test-ReadBroker"
ROLE = "Mango-test-ReadOnly"
STATEMENTS = (
    Statement(actions=("cloudwatch:GetMetricData",), resources=("*",)),
    Statement(
        actions=("cloudwatch:DescribeAlarms",), resources=("arn:aws:cloudwatch:*:*:alarm:*",)
    ),
)
HIDDEN = ("profile_name", "account_identifiers")


def member_config(identity_key: IdentityKey | None = None) -> PackConfig:
    return PackConfig(
        pack_id=PACK,
        version="1.0.0-1",
        tools=frozenset({TOOL, "get_metric_data"}),
        identity_mode="central_only",
        statements=STATEMENTS,
        broker_role_arn=BROKER,
        identity_public_key=identity_key.public_der if identity_key else None,
        region="us-east-1",
        identity_chain="member",
        target_role_name=ROLE,
    )


class Assumed:
    """Stands for STS: records what was assumed and names the account in the keys."""

    def __init__(self, error: Exception | None = None) -> None:
        self.calls: list[tuple[str, str]] = []
        self._error = error

    def __call__(self, caller: Caller, account: str) -> ReadOnlyCredentials:
        self.calls.append((caller.subject, account))
        if self._error is not None:
            raise self._error
        return ReadOnlyCredentials(f"AKIA-{caller.subject}-{account}", "secret", "token")


def _guard(key: IdentityKey, assumed: Assumed) -> CallGuard:
    return CallGuard(
        member_config(key),
        verifier=IdentityVerifier(key.public_der, PACK),
        member_assume=assumed,
        hidden_arguments=HIDDEN,
    )


def _arguments(key: IdentityKey, subject: str = "alice", **arguments: Any) -> dict[str, Any]:
    assertion = key.assertion(subject, TOOL, pack=PACK)
    return {"_mango_ctx": {"identity": assertion}, **arguments}


# --- The guard --------------------------------------------------------------------------------


def test_the_tool_runs_in_the_account_of_the_call_and_never_sees_mangos_arguments(
    identity_key: IdentityKey,
) -> None:
    assumed = Assumed()
    arguments = _arguments(
        identity_key,
        account_id=MEMBER,
        region="us-east-1",
        max_items=5,
        profile_name="admin",
        account_identifiers=["999900001111"],
    )
    with _guard(identity_key, assumed).call(TOOL, arguments) as cleaned:
        # The Region is the tool's own argument; the account and the hidden ones are gone.
        assert cleaned == {"region": "us-east-1", "max_items": 5}
        # The session was assumed before the tool, for this person in this account.
        assert assumed.calls == [("alice", MEMBER)]
        frozen = credentials._BOUND.get_frozen_credentials()
        assert frozen.access_key == f"AKIA-alice-{MEMBER}"
    assert credentials.current_caller() is None
    assert assumed.calls == [("alice", MEMBER)]  # one session per call


@pytest.mark.parametrize(
    "account",
    [
        None,
        "",
        "12345678901",
        "1234567890123",
        "44445555666a",
        " 444455556666",
        "٤٤٤٤٥٥٥٥٦٦٦٦",  # digits, but not ASCII
        444455556666,
        ["444455556666"],
        MANGO_ACCOUNT,  # the account of the broker holds no role to read (D51)
    ],
)
def test_an_account_that_is_not_a_member_account_id_is_refused_before_sts(
    identity_key: IdentityKey, account: object
) -> None:
    assumed = Assumed()
    arguments = _arguments(identity_key)
    if account is not None:
        arguments["account_id"] = account
    with pytest.raises(IdentityError), _guard(identity_key, assumed).call(TOOL, arguments):
        pytest.fail("the tool ran")
    assert assumed.calls == []


@pytest.mark.parametrize(
    "region",
    [
        "",
        "us-east-1.evil.example",
        "evil.example/",
        "us-east-1@evil",
        "US-EAST-1",
        "us_east_1",
        "us-east-1 ",
        "local",
        12,
        ["us-east-1"],
    ],
)
def test_a_region_that_is_not_a_region_name_is_refused_before_sts(
    identity_key: IdentityKey, region: object
) -> None:
    assumed = Assumed()
    arguments = _arguments(identity_key, account_id=MEMBER, region=region)
    with pytest.raises(IdentityError), _guard(identity_key, assumed).call(TOOL, arguments):
        pytest.fail("the tool ran")
    assert assumed.calls == []


def test_the_region_of_the_installation_passes(identity_key: IdentityKey) -> None:
    arguments = _arguments(identity_key, account_id=MEMBER, region="us-east-1")
    with _guard(identity_key, Assumed()).call(TOOL, arguments) as cleaned:
        assert cleaned == {"region": "us-east-1"}
    # No Region: the upstream default, which is the Region the runtime runs in.
    with _guard(identity_key, Assumed()).call(
        TOOL, _arguments(identity_key, account_id=MEMBER)
    ) as cleaned:
        assert cleaned == {}


@pytest.mark.parametrize("region", ["eu-central-2", "ap-southeast-4", "us-gov-west-1", "us-east-2"])
def test_another_region_is_refused_before_sts(identity_key: IdentityKey, region: str) -> None:
    """R6: the pack network only reaches the endpoints of the installation's own Region."""
    assumed = Assumed()
    arguments = _arguments(identity_key, account_id=MEMBER, region=region)
    with pytest.raises(RegionError) as refused, _guard(identity_key, assumed).call(TOOL, arguments):
        pytest.fail("the tool ran")
    assert refused.value.allowed == "us-east-1"
    assert assumed.calls == []


def test_an_unverified_caller_never_learns_about_regions(identity_key: IdentityKey) -> None:
    """The Region is only told to a caller the pack verified: everyone else gets the one
    refusal that says nothing."""
    arguments = {"account_id": MEMBER, "region": "eu-west-1"}  # no identity assertion
    with (
        pytest.raises(IdentityError) as refused,
        _guard(identity_key, Assumed()).call(TOOL, arguments),
    ):
        pytest.fail("the tool ran")
    assert not isinstance(refused.value, RegionError)


@pytest.mark.parametrize(
    "error",
    [
        # No role in that account, or an account outside the organization: IAM says no.
        ClientError({"Error": {"Code": "AccessDenied", "Message": "not authorized"}}, "AssumeRole"),
        ClientError({"Error": {"Code": "RegionDisabledException", "Message": "x"}}, "AssumeRole"),
        EndpointConnectionError(endpoint_url="https://sts.us-east-1.amazonaws.com"),
    ],
)
def test_an_account_iam_does_not_let_in_is_the_same_refusal_and_the_tool_never_runs(
    identity_key: IdentityKey, error: Exception, caplog: pytest.LogCaptureFixture
) -> None:
    assumed = Assumed(error)
    arguments = _arguments(identity_key, account_id="999900001111")
    with (
        caplog.at_level("INFO", logger="mango.pack"),
        pytest.raises(IdentityError) as refused,
        _guard(identity_key, assumed).call(TOOL, arguments),
    ):
        pytest.fail("the tool ran")
    assert assumed.calls == [("alice", "999900001111")]
    # Nothing of the AWS error travels with the refusal, and the log names who, not where.
    assert str(refused.value) == "" and refused.value.__cause__ is None
    record = json.loads(caplog.records[-1].getMessage())
    assert record == {
        "event": "pack.call",
        "pack": PACK,
        "tool": TOOL,
        "user": "alice",
        "agent": "finops",
        "outcome": "rejected",
    }


def test_the_caller_is_verified_before_the_account_is_even_looked_at(
    identity_key: IdentityKey,
) -> None:
    assumed = Assumed()
    guard = _guard(identity_key, assumed)
    for arguments in (
        {"account_id": MEMBER},
        {
            "account_id": MEMBER,
            "_mango_ctx": {"identity": IdentityKey().assertion("alice", TOOL, pack=PACK)},
        },
        {
            "account_id": MEMBER,
            "_mango_ctx": {
                "identity": identity_key.assertion("area", TOOL, pack=PACK, central=False)
            },
        },
    ):
        with pytest.raises(IdentityError), guard.call(TOOL, arguments):
            pytest.fail("the tool ran")
    assert assumed.calls == []


def test_account_id_stays_an_argument_of_the_tool_outside_the_member_chain(
    identity_key: IdentityKey,
) -> None:
    # Billing's budget tools take an `account_id` of their own (payer chain).
    from .conftest import PACK as BILLING  # noqa: PLC0415
    from .conftest import TOOL as BILLING_TOOL  # noqa: PLC0415
    from .conftest import central_config, keys_of  # noqa: PLC0415

    guard = CallGuard(
        central_config(identity_key),
        verifier=IdentityVerifier(identity_key.public_der, BILLING),
        assume=keys_of,
    )
    arguments = {"account_id": MEMBER, "_mango_ctx": {"identity": identity_key.assertion("bob")}}
    with guard.call(BILLING_TOOL, arguments) as cleaned:
        assert cleaned == {"account_id": MEMBER}


def test_a_member_pack_without_its_settings_refuses_every_call(identity_key: IdentityKey) -> None:
    locked = CallGuard(member_config(identity_key))
    with (
        pytest.raises(IdentityError),
        locked.call(TOOL, _arguments(identity_key, account_id=MEMBER)),
    ):
        pytest.fail("the tool ran")
    # The verifier and the payer chain's session are not enough for a member pack.
    payer_only = CallGuard(
        member_config(identity_key),
        verifier=IdentityVerifier(identity_key.public_der, PACK),
        assume=lambda caller: ReadOnlyCredentials("AKIA", "s", "t"),
    )
    with (
        pytest.raises(IdentityError),
        payer_only.call(TOOL, _arguments(identity_key, account_id=MEMBER)),
    ):
        pytest.fail("the tool ran")


# --- The chain --------------------------------------------------------------------------------


def _credentials(tag: str) -> dict[str, Any]:
    return {
        "Credentials": {
            "AccessKeyId": f"ASIA0000000000{tag}",
            "SecretAccessKey": "s" * 40,
            "SessionToken": "t" * 40,
            "Expiration": "2030-01-01T00:00:00Z",
        }
    }


def test_member_assume_goes_through_the_read_broker_to_the_role_of_that_account(
    identity_key: IdentityKey, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = member_config(identity_key)
    sts = boto3.client(
        "sts", region_name="us-east-1", aws_access_key_id="AKIA-PACK", aws_secret_access_key="s"
    )
    with Stubber(sts) as stub:
        stub.add_response(
            "assume_role",
            _credentials("BROKER"),
            {
                "RoleArn": BROKER,
                "RoleSessionName": ANY,
                "DurationSeconds": 900,
                "SourceIdentity": "alice",
                "Tags": [
                    {"Key": "mango_agent", "Value": "finops"},
                    {"Key": "mango_bu", "Value": "central"},
                    {"Key": "mango_user", "Value": "alice"},
                ],
                "TransitiveTagKeys": ["mango_agent", "mango_bu", "mango_user"],
            },
        )
        second_hop: dict[str, Any] = {}

        class BrokerSts:
            class meta:  # noqa: N801 - mimics a boto3 client
                region_name = "us-east-1"

            def assume_role(self, **kwargs: Any) -> dict[str, Any]:
                second_hop.update(kwargs)
                return _credentials("MEMBER")

        monkeypatch.setattr(
            "mango_aws.broker.CrossAccountSessions._client_from", lambda _self, _c: BrokerSts()
        )
        frozen = member_assume(config, sts)(
            Caller(subject="alice", tool=TOOL, agent_id="finops", central=True), MEMBER
        )
        stub.assert_no_pending_responses()
    assert frozen.access_key == "ASIA0000000000MEMBER"
    # Always the role the provisioner named, in the account of the call.
    assert second_hop["RoleArn"] == f"arn:aws:iam::{MEMBER}:role/{ROLE}"
    assert second_hop["SourceIdentity"] == "alice"
    assert json.loads(second_hop["Policy"]) == json.loads(session_policy(STATEMENTS))


def test_a_member_pack_without_broker_or_role_name_cannot_assume() -> None:
    base = member_config()
    for missing in ("broker_role_arn", "target_role_name"):
        config = PackConfig(**{**base.__dict__, missing: None})
        with pytest.raises(ValueError, match="broker"):
            member_assume(config)


# --- pack.json and the runtime's environment --------------------------------------------------


def _pack_json(directory: Path, **content: Any) -> Path:
    base = {
        "id": PACK,
        "version": "1.0.0-1",
        "tools": [TOOL],
        "identity_mode": "central_only",
        "iam": [{"actions": ["cloudwatch:GetMetricData"], "resources": ["*"]}],
        "identity_chain": "member",
    }
    (directory / "pack.json").write_text(json.dumps({**base, **content}))
    return directory


def test_a_member_pack_reads_the_broker_and_a_role_name_never_an_arn(
    tmp_path: Path, identity_key: IdentityKey
) -> None:
    env = {
        "MANGO_PACK_BROKER_ROLE_ARN": BROKER,
        "MANGO_PACK_TARGET_ROLE_NAME": ROLE,
        "MANGO_PACK_IDENTITY_PUBLIC_KEY": base64.b64encode(identity_key.public_der).decode(),
        "MANGO_PACK_REGION": "us-east-1",
    }
    config = PackConfig.load(_pack_json(tmp_path), env)
    assert config.member_chain and config.can_verify
    assert (config.target_role_name, config.target_role_arn) == (ROLE, None)
    for missing in env:
        partial = {k: v for k, v in env.items() if k != missing}
        assert PackConfig.load(tmp_path, partial).can_verify is False
    # The payer chain's setting does not stand in for the role name, and is never kept.
    payer = {k: v for k, v in env.items() if k != "MANGO_PACK_TARGET_ROLE_NAME"}
    payer["MANGO_PACK_TARGET_ROLE_ARN"] = f"arn:aws:iam::{MEMBER}:role/Other"
    assert PackConfig.load(tmp_path, payer).can_verify is False
    assert PackConfig.load(tmp_path, {**env, **payer}).target_role_arn is None
    for name in (f"arn:aws:iam::{MEMBER}:role/{ROLE}", "role/Other", "a b"):
        with pytest.raises(PackConfigError, match="role name"):
            PackConfig.load(tmp_path, {**env, "MANGO_PACK_TARGET_ROLE_NAME": name})


def test_a_payer_pack_ignores_a_role_name(tmp_path: Path, identity_key: IdentityKey) -> None:
    env = {
        "MANGO_PACK_BROKER_ROLE_ARN": BROKER,
        "MANGO_PACK_TARGET_ROLE_NAME": ROLE,
        "MANGO_PACK_IDENTITY_PUBLIC_KEY": base64.b64encode(identity_key.public_der).decode(),
        "MANGO_PACK_REGION": "us-east-1",
    }
    config = PackConfig.load(_pack_json(tmp_path, identity_chain="payer"), env)
    assert not config.member_chain and not config.can_verify


@pytest.mark.parametrize("chain", ["operator", "", 7, None])
def test_a_chain_the_runtime_does_not_know_stops_the_start(tmp_path: Path, chain: object) -> None:
    with pytest.raises(PackConfigError):
        PackConfig.load(_pack_json(tmp_path, identity_chain=chain), {})


def test_build_guard_wires_the_member_chain(
    tmp_path: Path, identity_key: IdentityKey, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIA-PACK-ROLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "s")
    try:
        guard = build_guard(member_config(identity_key), HIDDEN)
        assert guard._member_assume is not None and guard._assume is None
        assert guard._hidden == frozenset(HIDDEN)
    finally:
        credentials.uninstall()


# --- What tools/list says ---------------------------------------------------------------------


def _upstream() -> MCPServer:
    """Tools shaped like the ones of the awslabs CloudWatch server."""
    mcp = MCPServer("upstream")

    @mcp.tool()
    def get_active_alarms(
        max_items: int | None = 50,
        region: str | None = None,
        profile_name: str | None = None,
    ) -> str:
        """Active alarms."""
        return json.dumps({"max_items": max_items, "region": region, "profile": profile_name})

    @mcp.tool()
    def get_metric_data(
        namespace: str, account_identifiers: list[str] | None = None, region: str = "us-east-1"
    ) -> str:
        """Metric data."""
        return namespace

    @mcp.tool()
    def execute_log_insights_query(query: str) -> str:
        """Left out of the manifest."""
        return "never served"

    return mcp


def _served(key: IdentityKey, assumed: Assumed) -> MCPServer:
    mcp = _upstream()
    config = member_config(key)
    restrict_tools(mcp, config.tools)
    bind(mcp, _guard(key, assumed))
    list_schemas(mcp, config, HIDDEN)
    return mcp


def test_listed_schemas_ask_for_the_account_bound_the_region_and_hide_the_rest(
    identity_key: IdentityKey,
) -> None:
    tools = {t.name: t for t in asyncio.run(_served(identity_key, Assumed()).list_tools())}
    assert sorted(tools) == ["get_active_alarms", "get_metric_data"]
    for tool in tools.values():
        schema = tool.input_schema
        assert schema["properties"]["account_id"]["pattern"] == ACCOUNT_PATTERN
        assert schema["required"][0] == "account_id"
        assert not {"profile_name", "account_identifiers"} & set(schema["properties"])
        # The Gateway adds `_mango_ctx` before it validates against this schema (#52).
        assert schema.get("additionalProperties") is not False
        assert "_mango_ctx" not in json.dumps(schema)
    alarms = tools["get_active_alarms"].input_schema["properties"]["region"]
    assert {"type": "string", "pattern": REGION_PATTERN} in alarms["anyOf"]
    assert {"type": "null"} in alarms["anyOf"]
    metrics = tools["get_metric_data"].input_schema
    assert metrics["properties"]["region"]["pattern"] == REGION_PATTERN
    assert metrics["required"] == ["account_id", "namespace"]


def test_listing_does_not_change_what_the_upstream_tool_validates(
    identity_key: IdentityKey,
) -> None:
    mcp = _served(identity_key, Assumed())
    first = asyncio.run(mcp.list_tools())
    assert asyncio.run(mcp.list_tools()) == first  # the rewrite is not applied twice
    internal = mcp._tool_manager.get_tool("get_active_alarms")
    assert internal is not None
    assert "profile_name" in internal.parameters["properties"]
    assert "account_id" not in internal.parameters["properties"]


def test_a_call_through_the_server_reaches_the_tool_without_mangos_arguments(
    identity_key: IdentityKey,
) -> None:
    assumed = Assumed()
    mcp = _served(identity_key, assumed)
    arguments = _arguments(
        identity_key, account_id=MEMBER, region="us-east-1", profile_name="admin", max_items=3
    )
    result = asyncio.run(mcp.call_tool(TOOL, arguments))
    assert json.loads(result.content[0].text) == {
        "max_items": 3,
        "region": "us-east-1",
        "profile": None,
    }
    assert assumed.calls == [("alice", MEMBER)]
    # Another Region: a refusal the model can act on, and no session is assumed for it.
    elsewhere = _arguments(identity_key, account_id=MEMBER, region="eu-west-1")
    with pytest.raises(ToolError, match="only reads the Region us-east-1"):
        asyncio.run(mcp.call_tool(TOOL, elsewhere))
    assert assumed.calls == [("alice", MEMBER)]
    for bad in ({"account_id": MANGO_ACCOUNT}, {}, {"account_id": MEMBER, "region": "x.y/z"}):
        with pytest.raises(ToolError, match=REFUSED_MESSAGE):
            asyncio.run(mcp.call_tool(TOOL, _arguments(identity_key, **bad)))


def test_an_upstream_tool_with_its_own_account_id_stops_the_start(
    identity_key: IdentityKey,
) -> None:
    mcp = MCPServer("upstream")

    @mcp.tool()
    def get_active_alarms(account_id: str) -> str:
        """Clashes with Mango's argument."""
        return account_id

    with pytest.raises(SystemExit, match="account_id"):
        list_schemas(mcp, member_config(identity_key), HIDDEN)


def test_a_payer_pack_lists_open_schemas_and_no_account(identity_key: IdentityKey) -> None:
    from .conftest import central_config  # noqa: PLC0415

    mcp = _upstream()
    list_schemas(mcp, central_config(identity_key), ("profile_name",))
    for tool in asyncio.run(mcp.list_tools()):
        assert "account_id" not in tool.input_schema["properties"]
        assert "profile_name" not in tool.input_schema["properties"]
        assert "pattern" not in json.dumps(tool.input_schema)
