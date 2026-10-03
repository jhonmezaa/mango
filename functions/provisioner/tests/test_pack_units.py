"""Pieces of the pack provisioner on their own: settings, names, role, runtime and Gateway."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import pytest
from botocore.exceptions import ClientError

from mango_packs.manifest import PackManifest
from mango_provisioner.errors import RetryableError, StepError
from mango_provisioner.handler import ProvisionerStepError, RetryableStepError
from mango_provisioner.packs.config import ConfigError, PackSettings
from mango_provisioner.packs.gateway import MAX_STATEMENT_CHARS, PackGateway, policy_statements
from mango_provisioner.packs.handler import handle
from mango_provisioner.packs.release import check_manifest, resolve_config
from mango_provisioner.packs.role import (
    grants_from_json,
    grants_of,
    grants_to_json,
    role_policy,
    trust_policy,
)
from mango_provisioner.packs.runtime import MAX_TOOLS_RESPONSE_BYTES, decode_tools

from .pack_lab import (
    ALLOWED_ACTIONS,
    BOUNDARY_ARN,
    GATEWAY_ARN,
    PACK,
    TOOLS,
    VERSION,
    PackLab,
    Signer,
    env,
    manifest_data,
)

KEY = Signer().public_pem
CATALOG = {PACK: {"version": VERSION, "statement_sha256": "a" * 64}}
SETTINGS = PackSettings.from_env(env(KEY, CATALOG))
MANIFEST = PackManifest.model_validate(manifest_data())


# --- Settings and names ---------------------------------------------------------------------


def test_settings_come_from_the_stack() -> None:
    assert SETTINGS.boundary_arn == BOUNDARY_ARN
    assert SETTINGS.allowed_actions == frozenset(ALLOWED_ACTIONS)
    assert SETTINGS.catalog[PACK].statement_sha256 == "a" * 64
    assert SETTINGS.gateway_arn == GATEWAY_ARN
    assert SETTINGS.connector_targets == frozenset({"finops"})


def test_no_signing_key_is_accepted_and_means_nothing_installs() -> None:
    assert PackSettings.from_env(env(None, {})).public_key_pem is None


RSA_KEY = (
    "-----BEGIN PUBLIC KEY-----\n"
    "MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf\n"
    "9Cnzj4p4WGeKLs1Pt8QuKUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQ==\n"
    "-----END PUBLIC KEY-----\n"
)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("MANGO_NAMESPACE", "Not-Valid"),
        ("MANGO_ACCOUNT_ID", "123"),
        ("AWS_REGION", "nowhere"),
        ("PACKS_BUCKET", "Bad_Bucket"),
        ("PACK_BOUNDARY_ARN", "arn:aws:iam::123456789012:policy/Mango-test-agent-boundary"),
        ("PACK_ALLOWED_ACTIONS", '["pricing:*"]'),
        ("PACK_ALLOWED_ACTIONS", '"pricing:GetProducts"'),
        ("PACK_CATALOG", "not json"),
        ("PACK_CATALOG", "[]"),
        ("PACK_CATALOG", '{"aws-pricing": {"version": "1.1.1-1"}}'),
        (
            "PACK_CATALOG",
            '{"aws-pricing": {"version": "latest", "statement_sha256": "' + "a" * 64 + '"}}',
        ),
        (
            "PACK_CATALOG",
            '{"Bad Id": {"version": "1.1.1-1", "statement_sha256": "' + "a" * 64 + '"}}',
        ),
        ("PACK_SIGNING_PUBLIC_KEY", "not a key"),
        ("PACK_SIGNING_PUBLIC_KEY", RSA_KEY),
        ("GATEWAY_ID", "UPPER"),
        ("POLICY_ENGINE_ID", "engine"),
        ("CONNECTOR_TARGETS", '["bad target"]'),
    ],
)
def test_invalid_environment_is_rejected(name: str, value: str) -> None:
    with pytest.raises(ConfigError):
        PackSettings.from_env({**env(KEY, CATALOG), name: value})


def test_missing_environment_is_rejected() -> None:
    environment = env(KEY, CATALOG)
    del environment["PACK_CATALOG"]
    with pytest.raises(ConfigError, match="PACK_CATALOG"):
        PackSettings.from_env(environment)


def test_names_fit_the_limits_of_aws() -> None:
    longest_ns = PackSettings.from_env(
        {
            **env(KEY, {}),
            "MANGO_NAMESPACE": "abcd1234",
            "PACK_BOUNDARY_ARN": "arn:aws:iam::123456789012:policy/Mango-abcd1234-mcp-boundary",
        }
    )
    longest_pack = "a" + "-b" * 11 + "c"  # 24 characters, the most a pack id may have
    assert len(longest_pack) == 24
    assert len(longest_ns.role_name(longest_pack)) <= 64
    runtime = longest_ns.runtime_name(longest_pack)
    assert len(runtime) <= 48
    assert "-" not in runtime
    assert len(longest_ns.policy_name(longest_pack, 99)) <= 48
    assert longest_ns.runtime_id_pattern(longest_pack).fullmatch(f"{runtime}-Ab3dE6gH9j")


def test_names_of_one_pack_never_match_another() -> None:
    # `aws` must not match resources of `aws-pricing` (or the other way round).
    assert not SETTINGS.runtime_id_pattern("aws").fullmatch("Mango_test_mcp_aws_pricing-Ab3dE6gH9j")
    assert not SETTINGS.policy_name_pattern("aws").fullmatch("Mango_test_mcp_aws_pricing_1")
    assert SETTINGS.policy_name_pattern("aws-pricing").fullmatch("Mango_test_mcp_aws_pricing_1")
    assert not SETTINGS.policy_name_pattern("aws-pricing").fullmatch("Mango_test_FinopsRead")


@pytest.mark.parametrize("pack_id", ["", "Aws", "a_b", "../x", "a" * 25, "-a", "a--b"])
def test_names_reject_anything_that_is_not_a_pack_id(pack_id: str) -> None:
    with pytest.raises(ValueError, match="invalid pack id"):
        SETTINGS.role_name(pack_id)


def test_runtime_url_points_at_the_live_endpoint() -> None:
    url = SETTINGS.runtime_url("Mango_test_mcp_aws_pricing-Ab3dE6gH9j")
    assert url == (
        "https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/"
        "arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A123456789012%3Aruntime%2F"
        "Mango_test_mcp_aws_pricing-Ab3dE6gH9j/invocations?qualifier=live"
    )


# --- Installation limits on a signed manifest --------------------------------------------


def test_config_defaults_and_enum() -> None:
    assert resolve_config(MANIFEST, {}) == {"region": "us-east-1"}
    assert resolve_config(MANIFEST, {"region": "eu-central-1"}) == {"region": "eu-central-1"}
    for bad in ({"region": "elsewhere"}, {"other": "us-east-1"}):
        with pytest.raises(StepError, match="invalid_config"):
            resolve_config(MANIFEST, bad)


def test_manifest_limits() -> None:
    check_manifest(SETTINGS, MANIFEST)
    greedy = PackManifest.model_validate(
        manifest_data(iam=[{"actions": ["iam:PassRole"], "resources": ["*"], "reason": "x"}])
    )
    with pytest.raises(StepError, match="action_outside_boundary"):
        check_manifest(SETTINGS, greedy)


# --- Role ----------------------------------------------------------------------------------


def test_role_policy_is_the_manifest_plus_a_fixed_template() -> None:
    document = role_policy(SETTINGS, PACK, grants_of(MANIFEST))
    sids = [s["Sid"] for s in document["Statement"]]
    assert sids == ["Manifest1", "RuntimeLogs", "Tracing", "Metrics"]
    manifest = document["Statement"][0]
    assert manifest["Action"] == ["pricing:DescribeServices", "pricing:GetProducts"]
    assert manifest["Resource"] == ["*"]
    logs = document["Statement"][1]["Resource"]
    assert all("/aws/bedrock-agentcore/runtimes/Mango_test_mcp_aws_pricing-*" in r for r in logs)
    # Nothing that reaches other data or identities.
    services = {
        action.split(":")[0]
        for statement in document["Statement"]
        for action in (
            statement["Action"] if isinstance(statement["Action"], list) else [statement["Action"]]
        )
    }
    assert services == {"pricing", "logs", "xray", "cloudwatch"}


def test_role_policy_refuses_an_action_outside_the_boundary() -> None:
    with pytest.raises(StepError, match="action_outside_boundary"):
        role_policy(SETTINGS, PACK, [(("s3:GetObject",), ("*",))])


def test_trust_is_agentcore_for_this_packs_runtime_only() -> None:
    (statement,) = trust_policy(SETTINGS, PACK)["Statement"]
    assert statement["Principal"] == {"Service": "bedrock-agentcore.amazonaws.com"}
    assert statement["Condition"] == {
        "StringEquals": {"aws:SourceAccount": "123456789012"},
        "ArnLike": {
            "aws:SourceArn": (
                "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/"
                "Mango_test_mcp_aws_pricing-*"
            )
        },
    }


def test_recorded_grants_round_trip_and_are_validated() -> None:
    grants = grants_of(MANIFEST)
    assert grants_from_json(grants_to_json(grants)) == grants
    for bad in ("x", [{"actions": ["pricing:*"], "resources": ["*"]}], [{"actions": []}], [None]):
        with pytest.raises(StepError, match="installed_record_invalid"):
            grants_from_json(bad)


def test_deleting_a_role_that_does_not_exist_makes_no_write(packlab: PackLab) -> None:
    """IAM denies (not NoSuchEntity) a policy change on a role that is not there."""
    lab = packlab
    calls: list[str] = []
    lab.iam.meta.events.register("before-call.iam", lambda model, **_: calls.append(model.name))
    lab.provisioner._roles.delete(PACK)
    assert calls == ["GetRole"]


# --- tools/list answer -----------------------------------------------------------------------


def _answer(result: Any) -> bytes:
    return json.dumps({"jsonrpc": "2.0", "id": 1, "result": result}).encode()


def test_tools_answer_as_json_or_as_one_sse_event() -> None:
    assert decode_tools(_answer({"tools": TOOLS}), "application/json") == TOOLS
    sse = b"event: message\ndata: " + _answer({"tools": TOOLS}) + b"\n\n"
    assert decode_tools(sse, "text/event-stream") == TOOLS


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"not json",
        b"[]",
        json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"code": -1}}).encode(),
        _answer({"tools": "x"}),
        _answer({"tools": TOOLS, "nextCursor": "more"}),  # a page would hide tools
        b"\xff\xfe",
    ],
)
def test_malformed_tools_answers_are_refused(raw: bytes) -> None:
    with pytest.raises(StepError, match="tools_response_invalid"):
        decode_tools(raw, "application/json")


def test_a_refused_tools_answer_logs_its_shape_and_never_its_content(
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret = "text-of-a-third-party-server"
    raw = json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"code": -32010, "message": secret}})
    with caplog.at_level("WARNING"), pytest.raises(StepError, match="tools_response_invalid"):
        decode_tools(raw.encode(), "application/json")
    logged = json.loads(caplog.records[-1].getMessage())
    assert logged == {
        "event": "pack_provisioner.tools_response_invalid",
        "reason": "jsonrpc_error",
        "bytes": len(raw),
        "content_type": "application/json",
        "jsonrpc_error_code": -32010,
    }
    assert secret not in caplog.text


def test_oversized_tools_answer_is_refused() -> None:
    with pytest.raises(StepError, match="tools_response_too_large"):
        decode_tools(b" " * (MAX_TOOLS_RESPONSE_BYTES + 1), "application/json")


def test_tools_are_only_asked_once_the_default_endpoint_serves_that_version(
    packlab: PackLab,
) -> None:
    lab = packlab
    p = lab.provisioner
    state = p.ensure_runtime(p.ensure_role(p.load(lab.approve(), "exec-1")))
    with pytest.raises(RetryableError, match="default_endpoint_not_ready"):
        p.verify_tools(state)
    assert lab.agentcore.tool_calls == 0
    while not state["ready"]:
        state = p.check_runtime(state)
    p.verify_tools(state)
    assert lab.agentcore.tool_calls == 1


def test_a_server_that_is_not_up_yet_is_retried(packlab: PackLab) -> None:
    lab = packlab
    p = lab.provisioner
    state = p.ensure_runtime(p.ensure_role(p.load(lab.approve(), "exec-1")))
    while not state["ready"]:
        state = p.check_runtime(state)
    lab.agentcore.fail_next["InvokeAgentRuntime"] = ClientError(
        {"Error": {"Code": "RuntimeClientError"}}, "InvokeAgentRuntime"
    )
    with pytest.raises(RetryableError, match="tools_list_not_ready"):
        p.verify_tools(state)
    p.verify_tools(state)


# --- Gateway: policies and target -----------------------------------------------------------


def test_policy_statements_only_permit_this_packs_tools_on_this_gateway() -> None:
    (statement,) = policy_statements(SETTINGS, PACK, ["b_tool", "a_tool"])
    assert statement.startswith("permit (\n  principal is AgentCore::OAuthUser,")
    assert 'action in [AgentCore::Action::"aws-pricing___a_tool", ' in statement
    assert f'resource == AgentCore::Gateway::"{GATEWAY_ARN}"' in statement
    assert "forbid" not in statement
    assert "when" not in statement


def test_many_tools_are_split_over_several_policies() -> None:
    tools = [f"tool_{'x' * 50}_{index:03d}" for index in range(100)]
    statements = policy_statements(SETTINGS, PACK, tools)
    assert len(statements) > 1
    assert all(len(s) <= MAX_STATEMENT_CHARS for s in statements)
    served = [
        name for s in statements for name in s.split('"') if name.startswith("aws-pricing___")
    ]
    assert sorted(served) == sorted(f"aws-pricing___{tool}" for tool in tools)
    with pytest.raises(StepError, match="no_tools"):
        policy_statements(SETTINGS, PACK, [])


def test_a_target_on_an_earlier_runtime_of_the_pack_is_converged(packlab: PackLab) -> None:
    lab = packlab
    lab.run(lab.approve())
    target = lab.agentcore.pack_target()
    assert target is not None
    runtime_id = lab.agentcore.runtime()["id"]
    server = target["config"]["targetConfiguration"]["mcp"]["mcpServer"]
    wanted = server["endpoint"]
    # The pack's runtime was created again (another generated id): same pack, stale target.
    server["endpoint"] = wanted.replace(runtime_id, "Mango_test_mcp_aws_pricing-Zz9zZ9zZ9z")
    gateway = lab.provisioner._gateway
    now = datetime.now(UTC)
    assert gateway.target_ready(PACK, runtime_id, now) is None
    gateway.ensure_target(PACK, runtime_id, now, execution="exec-2")
    assert "UpdateGatewayTarget" in lab.agentcore.calls
    assert target["config"]["targetConfiguration"]["mcp"]["mcpServer"]["endpoint"] == wanted


def test_a_failed_policy_left_behind_is_replaced(packlab: PackLab) -> None:
    lab = packlab
    lab.run(lab.approve())
    (policy,) = lab.agentcore.pack_policies().values()
    policy.update(status="CREATE_FAILED", reasons=["x"])
    gateway = lab.provisioner._gateway
    tools = [tool["name"] for tool in TOOLS]
    with pytest.raises(StepError, match="policy_failed"):
        gateway.policies_ready(PACK, tools)
    for _ in range(6):
        gateway.ensure_policies(PACK, tools)
    assert gateway.policies_ready(PACK, tools)
    (replacement,) = lab.agentcore.pack_policies().values()
    assert replacement["id"] != policy["id"]


def test_policies_of_other_owners_are_never_listed_as_the_packs(packlab: PackLab) -> None:
    lab = packlab
    connector = lab.agentcore.add_connector_policy("Mango_test_FinopsRead")
    other_pack = lab.agentcore.add_connector_policy("Mango_test_mcp_aws_1")
    assert lab.provisioner._gateway.delete_policies(PACK) is True
    assert lab.agentcore.policies[connector]["status"] == "ACTIVE"
    assert lab.agentcore.policies[other_pack]["status"] == "ACTIVE"
    assert "DeletePolicy" not in lab.agentcore.calls


# --- Lambda handler ------------------------------------------------------------------------


def test_handler_runs_a_step_and_reports_codes_only(
    packlab: PackLab, caplog: pytest.LogCaptureFixture
) -> None:
    lab = packlab
    event = {
        "step": "load",
        "state": lab.approve(config={"region": "eu-central-1"}),
        "execution": "exec-1",
    }
    with caplog.at_level("INFO"):
        result = handle(event, lab.provisioner)
    assert result["last_step"] == "load"
    assert result["action"] == "enable"
    assert "eu-central-1" not in caplog.text
    assert "pricing:" not in caplog.text

    with pytest.raises(ProvisionerStepError) as failure:
        handle(
            {
                "step": "ensure_role",
                "state": {**result, "pack_version": "9.9.9-9"},
                "execution": "exec-1",
            },
            lab.provisioner,
        )
    assert json.loads(str(failure.value)) == {"step": "ensure_role", "code": "enablement_changed"}


@pytest.mark.parametrize("event", [None, {}, {"step": "delete_everything"}, {"step": 7}])
def test_handler_rejects_unknown_steps(packlab: PackLab, event: object) -> None:
    with pytest.raises(ProvisionerStepError, match="invalid_step"):
        handle(event, packlab.provisioner)


def test_handler_maps_transient_errors_to_a_retry(packlab: PackLab) -> None:
    lab = packlab
    state = handle({"step": "load", "state": lab.approve(), "execution": "exec-1"}, lab.provisioner)
    lab.agentcore.fail_next["ListAgentRuntimes"] = ClientError({"Error": {"Code": "x"}}, "x")
    state = handle({"step": "ensure_role", "state": state, "execution": "exec-1"}, lab.provisioner)
    lab.agentcore.role_not_ready_once = True
    with pytest.raises(RetryableStepError, match="role_not_ready"):
        handle({"step": "ensure_runtime", "state": state, "execution": "exec-1"}, lab.provisioner)


def test_the_execution_name_in_the_state_is_ignored(packlab: PackLab) -> None:
    """The lock owner comes from the Step Functions context, never from the state."""
    lab = packlab
    state = handle({"step": "load", "state": lab.approve(), "execution": "exec-1"}, lab.provisioner)
    with pytest.raises(ProvisionerStepError, match="busy"):
        handle({"step": "ensure_role", "state": state, "execution": "exec-2"}, lab.provisioner)
    forged = {**state, "execution": "exec-1"}
    with pytest.raises(ProvisionerStepError, match="busy"):
        handle({"step": "ensure_role", "state": forged, "execution": "exec-2"}, lab.provisioner)


# --- Never adopt or remove what this provisioner did not make ---------------------------------


def test_a_target_with_the_packs_name_that_is_not_its_own_is_left_alone(packlab: PackLab) -> None:
    lab = packlab
    foreign = lab.agentcore.add_connector_target(PACK)  # same name, a Lambda target
    result = lab.run(lab.approve())
    assert result["failure"].startswith("foreign_target")
    assert lab.agentcore.targets[foreign]["status"] == "READY"
    for operation in ("UpdateGatewayTarget", "DeleteGatewayTarget", "SynchronizeGatewayTargets"):
        assert operation not in lab.agentcore.calls
    # Disabling does not delete it either.
    result = lab.run(lab.disable("enablement-0002"), "exec-2")
    assert result["failure"] == "foreign_target"
    assert lab.agentcore.targets[foreign]["status"] == "READY"


def test_a_target_of_another_packs_runtime_is_not_this_packs() -> None:
    gateway = PackGateway(None, SETTINGS)  # type: ignore[arg-type]

    def target(runtime_id: str, qualifier: str = "live") -> dict[str, Any]:
        url = SETTINGS.runtime_url(runtime_id).replace("qualifier=live", f"qualifier={qualifier}")
        return {"targetConfiguration": {"mcp": {"mcpServer": {"endpoint": url}}}}

    assert gateway._ours(target("Mango_test_mcp_aws_pricing-Ab3dE6gH9j"), PACK)
    assert not gateway._ours(target("Mango_test_mcp_aws_pricing_x-Ab3dE6gH9j"), PACK)
    assert not gateway._ours(target("Mango_test_mcp_aws-Ab3dE6gH9j"), PACK)
    assert not gateway._ours(target("harness_Mango_test_a_finops-Ab3dE6gH9j"), PACK)
    assert not gateway._ours(target("Mango_test_mcp_aws_pricing-Ab3dE6gH9j", "DEFAULT"), PACK)
    assert not gateway._ours({"targetConfiguration": {"mcp": {"lambda": {}}}}, PACK)
    evil = {"targetConfiguration": {"mcp": {"mcpServer": {"endpoint": "https://evil.example/mcp"}}}}
    assert not gateway._ours(evil, PACK)


def test_a_runtime_with_a_token_authorizer_is_never_adopted(packlab: PackLab) -> None:
    lab = packlab
    p = lab.provisioner
    state = p.ensure_runtime(p.ensure_role(p.load(lab.approve(), "exec-1")))
    version = lab.agentcore.runtime()["versions"][0]
    version["config"]["authorizerConfiguration"] = {"customJWTAuthorizer": {"discoveryUrl": "x"}}
    version["config"]["environmentVariables"]["MANGO_PACK_CONFIG_SHA256"] = "other"
    with pytest.raises(StepError, match="runtime_not_ours"):
        p.ensure_runtime(state)
    assert "UpdateAgentRuntime" not in lab.agentcore.calls


@pytest.mark.parametrize(
    "name", ['x"] ); permit(principal, action, resource', "a b", "", "é", "x" * 65]
)
def test_tool_names_cannot_break_out_of_the_cedar_statement(name: str) -> None:
    with pytest.raises(StepError, match="invalid_tool_name"):
        policy_statements(SETTINGS, PACK, ["get_pricing", name])


def test_an_answer_that_cannot_be_canonicalized_is_a_mismatch(packlab: PackLab) -> None:
    lab = packlab
    lab.agentcore.tools_by_version["1"] = [
        {**TOOLS[0], "inputSchema": {"maximum": float("nan")}},
        TOOLS[1],
    ]
    result = lab.run(lab.approve())
    assert (result["failed_step"], result["failure"]) == ("verify_tools", "tools_mismatch")


def test_who_asked_and_who_approved_are_bounded(packlab: PackLab) -> None:
    lab = packlab
    lab.approve()
    lab.db.update_item(
        TableName="Mango-test-Settings",
        Key={"PK": {"S": f"MCP#{PACK}"}, "SK": {"S": "ENABLEMENT"}},
        UpdateExpression="SET approved_by = :a",
        ExpressionAttributeValues={":a": {"S": "x" * 300}},
    )
    request = {"pack_id": PACK, "pack_version": VERSION, "enablement_id": "enablement-0001"}
    with pytest.raises(StepError, match="enablement_record_invalid"):
        lab.provisioner.load(request, "exec-1")
    assert lab.firehose.records == []
