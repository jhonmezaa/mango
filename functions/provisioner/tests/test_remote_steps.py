"""The remote MCP provisioner (D93, D98, plan PR-4) over moto and the in-memory AgentCore."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest

from mango_core import remote_mcp
from mango_core.remote_mcp import ApprovedRemote, RemoteNotApprovedError
from mango_provisioner.errors import StepError
from mango_provisioner.remotes.config import ConfigError, RemoteSettings
from mango_provisioner.remotes.handler import handle
from mango_provisioner.remotes.release import plan_target
from mango_provisioner.remotes.steps import parse_input
from mango_provisioner.remotes.store import generation_of_provider

from .remote_lab import (
    ACTION_RE,
    APPROVAL,
    GATEWAY_ID,
    KEY_ARN,
    NS,
    ORG,
    REG,
    RETURN_URL,
    ProfileSigner,
    RemoteLab,
    decode_payload,
    env,
    profile_data,
)


@pytest.fixture
def lab(aws: None) -> Iterator[RemoteLab]:
    yield RemoteLab()


def _enable(lab: RemoteLab, **change: Any) -> dict[str, Any]:
    lab.stage_change(**change)
    return lab.run(lab.approve())


def _target(lab: RemoteLab) -> dict[str, Any]:
    (target,) = [t for t in lab.agentcore.targets.values() if t["name"] == f"remote-{REG}"]
    return target


def _verify(lab: RemoteLab) -> ApprovedRemote:
    item = lab.approved()
    assert item is not None
    return ApprovedRemote.verify(
        remote_mcp.load_public_key(lab.kms.public_der),
        {k: v["S"] for k, v in item.items() if "S" in v},
        target=f"remote-{REG}",
        gateway_id=GATEWAY_ID,
    )


# --- Enable -------------------------------------------------------------------------------


def test_enable_builds_the_target_from_the_signed_profile_only(lab: RemoteLab) -> None:
    result = _enable(lab)
    assert result["enabled"] is True
    target = _target(lab)
    server = target["targetConfiguration"]["mcp"]["mcpServer"]
    # The endpoint: the profile's fixed host and the organization, nothing else.
    assert server["endpoint"] == f"https://mcp.dev.azure.com/{ORG}"
    # Only the tools of the picked toolsets (plus `core`, always on), all `read`.
    schema = json.loads(server["mcpToolSchema"]["inlinePayload"])
    names = {tool["name"] for tool in schema["tools"]}
    assert names == {
        "core_list_projects",
        "core_list_project_teams",
        "wit_work_item",
        "wit_query",
        "wit_backlog",
        "search_workitem",
        "wiki",
        "search_wiki",
    }
    profile = lab.statement.profile
    assert all(t.access.value == "read" for t in profile.tools if t.name in names)
    assert "listingMode" not in server  # never DYNAMIC: listing does not work with 3LO
    (credentials,) = target["credentialProviderConfigurations"]
    oauth = credentials["credentialProvider"]["oauthCredentialProvider"]
    assert credentials["credentialProviderType"] == "OAUTH"
    assert oauth == {
        "providerArn": (
            "arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/"
            f"oauth2credentialprovider/Mango-{NS}-remote-{REG}-g1"
        ),
        "scopes": list(profile.provider.scopes),
        "grantType": "AUTHORIZATION_CODE",
        "defaultReturnUrl": RETURN_URL,
    }
    assert target["metadataConfiguration"] == {
        "allowedRequestHeaders": ["X-MCP-Readonly", "X-MCP-Toolsets"]
    }


def test_enable_allows_the_return_url_and_keeps_the_others(lab: RemoteLab) -> None:
    _enable(lab)
    assert lab.agentcore.return_urls == ["https://example.invalid/kept", RETURN_URL]
    # Idempotent: a second execution does not add it again.
    lab.agentcore.calls.clear()
    lab.provisioner._identity.ensure_return_url()
    assert "UpdateWorkloadIdentity" not in lab.agentcore.calls


def test_enable_writes_policies_for_exactly_the_approved_tools(lab: RemoteLab) -> None:
    _enable(lab)
    (statement,) = lab.agentcore.statements()
    actions = set(ACTION_RE.findall(statement))
    approved = _verify(lab)
    assert actions == {remote_mcp.gateway_tool_name(REG, tool) for tool in approved.tools}
    assert statement.startswith("permit (\n  principal is AgentCore::OAuthUser,")
    gateway = f"arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/{GATEWAY_ID}"
    assert f'resource == AgentCore::Gateway::"{gateway}"' in statement


def test_enable_signs_the_catalog_last_and_it_verifies(lab: RemoteLab) -> None:
    _enable(lab)
    approved = _verify(lab)
    assert approved.generation == 1
    assert approved.revision == 1
    assert approved.organization == ORG
    assert approved.toolsets == ("core", "wiki", "wit")
    assert approved.headers == {"X-MCP-Readonly": "true", "X-MCP-Toolsets": "wit,wiki"}
    assert approved.probe_tool == "core_list_projects"
    assert approved.profile_sha256 == lab.digest
    assert lab.kms.signed_with == [KEY_ARN]
    item = lab.approved()
    assert item is not None
    assert item["generation"] == {"N": "1"}
    # Signed after the target was ready and the policies were active.
    calls = lab.agentcore.calls
    assert calls.index("CreatePolicy") < len(calls)
    registration = lab.registration()
    assert registration["status"] == {"S": "active"}
    # Lifecycle only (D98 (12)): what is live is the signed catalog.
    assert "generation" not in registration
    assert "provision_lock" not in registration
    # Every transition raised mango-api's optimistic lock (begin and active).
    assert registration["version"] == {"N": "5"}
    assert lab.events() == [("mcp_remote.enabled", "applied")]


def test_the_catalog_is_written_only_after_target_and_policies(lab: RemoteLab) -> None:
    lab.stage_change()
    state = lab.provisioner.load(lab.approve(), "exec-1")
    state["execution"] = "exec-1"
    state = lab.provisioner.ensure_return_url(state)
    state = lab.provisioner.ensure_target(state)
    # The target is not READY yet: signing now refuses.
    lab.agentcore.polls_until_ready = 3
    with pytest.raises(StepError, match="not_converged"):
        lab.provisioner.sign_item(state)
    assert lab.approved() is None


def test_repeating_a_finished_execution_changes_nothing(lab: RemoteLab) -> None:
    execution_input = {"registration_id": REG, "approval_id": APPROVAL}
    _enable(lab)
    writes = lab.agentcore.writes()
    assert lab.run(execution_input)["action"] == "noop"
    assert lab.agentcore.writes() == writes


# --- What a record cannot decide ----------------------------------------------------------


@pytest.mark.parametrize(
    "organization",
    ["contoso/evil", "contoso.attacker.example", "-contoso", "", "a" * 50, "contoso#x"],
)
def test_an_invalid_organization_never_reaches_the_sdk(lab: RemoteLab, organization: str) -> None:
    lab.stage_change()
    result = lab.run(lab.approve(organization={"S": organization}))
    assert lab.agentcore.writes() == []
    assert result["marked"] is False  # the record is refused before the lock is taken
    assert lab.registration()["status"] == {"S": "approved"}


def test_plan_refuses_an_invalid_organization_and_unknown_toolsets(lab: RemoteLab) -> None:
    verified = lab.provisioner._release.verified("azure-devops")
    with pytest.raises(StepError, match="invalid_organization"):
        plan_target(verified, "evil.example/x", ["wit"])
    with pytest.raises(StepError, match="invalid_toolsets"):
        plan_target(verified, ORG, ["repos-write"])
    # Without a toolset the server filters by header, it would serve everything.
    with pytest.raises(StepError, match="invalid_toolsets"):
        plan_target(verified, ORG, [])


def test_a_toolset_outside_the_profile_fails_the_registration(lab: RemoteLab) -> None:
    result = _enable(lab, toolsets={"L": [{"S": "wit"}, {"S": "advsec"}]})
    assert result["failure"] == "invalid_toolsets"
    assert lab.agentcore.writes() == []
    registration = lab.registration()
    assert registration["status"] == {"S": "failed"}
    assert registration["failure_code"] == {"S": "invalid_toolsets"}
    assert lab.events() == [("mcp_remote.create_failed", "rejected")]


def test_a_profile_outside_the_release_is_refused(lab: RemoteLab) -> None:
    lab.build({})
    result = _enable(lab)
    assert result["failure"] == "remote_profile_not_in_release"
    assert lab.agentcore.writes() == []


def test_a_change_approved_on_another_profile_version_is_refused(lab: RemoteLab) -> None:
    result = _enable(lab, profile_sha256={"S": "b" * 64})
    assert result["failure"] == "release_changed"


def test_a_profile_signed_by_another_key_is_refused(lab: RemoteLab) -> None:
    other = ProfileSigner()
    lab.publish(lab.statement, envelope=other.envelope(lab.statement))
    result = _enable(lab)
    assert result["failure"] == "signature_invalid"
    assert lab.agentcore.writes() == []


def test_a_provider_of_another_registration_is_refused(lab: RemoteLab) -> None:
    result = _enable(lab, pending_provider_name={"S": f"Mango-{NS}-remote-zzzzzzzzzzzz-g1"})
    assert result["failure"] == "change_record_invalid"
    assert lab.agentcore.writes() == []


def test_a_stale_execution_changes_nothing(lab: RemoteLab) -> None:
    lab.stage_change()
    lab.approve()
    result = lab.run({"registration_id": REG, "approval_id": "b" * 32})
    assert result["failure"] == "approval_changed"
    assert result["marked"] is False
    assert lab.agentcore.writes() == []
    assert lab.registration()["status"] == {"S": "approved"}


def test_mango_api_approving_again_mid_execution_stops_it(lab: RemoteLab) -> None:
    lab.stage_change()
    state = lab.provisioner.load(lab.approve(), "exec-1")
    state["execution"] = "exec-1"
    lab.put({**lab.registration(), "approval_id": {"S": "c" * 32}})
    with pytest.raises(StepError, match="approval_changed"):
        lab.provisioner.ensure_target(state)
    assert "CreateGatewayTarget" not in lab.agentcore.calls


def test_a_target_with_our_name_that_is_not_ours_is_refused(lab: RemoteLab) -> None:
    lab.agentcore.add_target(
        f"remote-{REG}",
        targetConfiguration={"mcp": {"mcpServer": {"endpoint": "https://evil.example/mcp"}}},
        credentialProviderConfigurations=[{"credentialProviderType": "GATEWAY_IAM_ROLE"}],
    )
    result = _enable(lab)
    assert result["failure"] == "foreign_target;compensation_failed"
    assert "UpdateGatewayTarget" not in lab.agentcore.calls
    assert "DeleteGatewayTarget" not in lab.agentcore.calls


def test_a_target_waiting_for_authorization_fails_loudly(lab: RemoteLab) -> None:
    lab.agentcore.target_status_when_ready = "CREATE_PENDING_AUTH"
    result = _enable(lab)
    # Such a target cannot be deleted either (finding of 2026-10-25): the failure says so.
    assert result["failure"] == "target_pending_auth;compensation_failed"
    assert lab.registration()["status"] == {"S": "failed"}
    assert lab.approved() is None


def _as_agentcore_returns_it(target: dict[str, Any]) -> dict[str, Any]:
    """Read back with fields Mango never sends and header names in lower case."""
    target = json.loads(json.dumps(target, default=str))
    oauth = target["credentialProviderConfigurations"][0]["credentialProvider"][
        "oauthCredentialProvider"
    ]
    oauth["customParameters"] = {}
    oauth["scopes"] = list(reversed(oauth["scopes"]))
    target["targetConfiguration"]["mcp"]["mcpServer"]["listingMode"] = "DEFAULT"
    metadata = target["metadataConfiguration"]
    metadata["allowedRequestHeaders"] = [h.lower() for h in metadata["allowedRequestHeaders"]]
    return target


def test_a_ready_target_read_back_with_agentcore_defaults_is_ready(lab: RemoteLab) -> None:
    lab.agentcore.target_read_back = _as_agentcore_returns_it
    result = _enable(lab)
    assert result["enabled"] is True
    assert "UpdateGatewayTarget" not in lab.agentcore.calls


def test_a_ready_target_that_differs_names_the_fields_only(
    lab: RemoteLab, caplog: pytest.LogCaptureFixture
) -> None:
    def other_scopes(target: dict[str, Any]) -> dict[str, Any]:
        target = _as_agentcore_returns_it(target)
        target["credentialProviderConfigurations"][0]["credentialProvider"][
            "oauthCredentialProvider"
        ]["scopes"] = ["openid"]
        return target

    lab.agentcore.target_read_back = other_scopes
    # The state machine waits until target_timeout; the lab gives up sooner.
    with pytest.raises(AssertionError, match="check_target never ready"):
        _enable(lab)
    logged = [r.getMessage() for r in caplog.records if "target_differs" in r.getMessage()]
    assert logged and json.loads(logged[-1])["differences"] == ["scopes"]
    assert "openid" not in logged[-1]


# --- Compensation -------------------------------------------------------------------------


def test_a_failed_first_enable_removes_what_it_exposed(lab: RemoteLab) -> None:
    lab.agentcore.fail_next["CreatePolicy"] = __import__("botocore").exceptions.ClientError(
        {"Error": {"Code": "ValidationException", "Message": "x"}}, "CreatePolicy"
    )
    result = _enable(lab)
    assert result["failure"] == "Policy:ValidationException"
    assert result["compensated"] is True
    assert lab.agentcore.targets == {}
    assert lab.agentcore.statements() == []
    assert lab.approved() is None
    registration = lab.registration()
    assert registration["status"] == {"S": "failed"}
    assert registration["failed_step"] == {"S": "check_policies"} or registration[
        "failed_step"
    ] == {"S": "ensure_policies"}
    assert "provision_lock" not in registration


# --- Params and replace_app ---------------------------------------------------------------


def _activate(lab: RemoteLab) -> None:
    _enable(lab)
    lab.agentcore.providers |= {
        remote_mcp.provider_name(NS, REG, 1),
        remote_mcp.provider_name(NS, REG, 2),
    }


def test_params_changes_schema_and_policies_and_signs_again(lab: RemoteLab) -> None:
    _activate(lab)
    lab.put(
        {
            **lab.registration(),
            "status": {"S": "approved"},
            "approval_id": {"S": "d" * 32},
            "change_kind": {"S": "params"},
        }
    )
    lab.stage_change(
        kind={"S": "params"},
        pending_provider_name=None,
        toolsets={"L": [{"S": "pipelines"}]},
    )
    providers = set(lab.agentcore.providers)
    result = lab.run({"registration_id": REG, "approval_id": "d" * 32})
    assert result["enabled"] is True
    approved = _verify(lab)
    assert approved.generation == 1
    assert approved.revision == 2  # same generation: the revision goes up
    assert approved.headers["X-MCP-Toolsets"] == "pipelines"
    assert "wit_work_item" not in approved.tools
    schema = json.loads(
        _target(lab)["targetConfiguration"]["mcp"]["mcpServer"]["mcpToolSchema"]["inlinePayload"]
    )
    assert {t["name"] for t in schema["tools"]} == set(approved.tools)
    # The provider is never touched: people keep their connection (D98 (8)).
    assert lab.agentcore.providers == providers
    assert "DeleteOauth2CredentialProvider" not in lab.agentcore.calls


def test_params_with_only_groups_touches_no_target(lab: RemoteLab) -> None:
    _activate(lab)
    lab.put(
        {
            **lab.registration(),
            "status": {"S": "approved"},
            "approval_id": {"S": "d" * 32},
            "change_kind": {"S": "params"},
        }
    )
    lab.stage_change(kind={"S": "params"}, pending_provider_name=None)
    lab.agentcore.calls.clear()
    lab.run({"registration_id": REG, "approval_id": "d" * 32})
    assert "UpdateGatewayTarget" not in lab.agentcore.calls
    assert "CreatePolicy" not in lab.agentcore.calls
    assert _verify(lab).revision == 2


def test_replace_app_points_the_target_at_the_new_provider_and_deletes_the_old(
    lab: RemoteLab,
) -> None:
    _activate(lab)
    lab.put(
        {
            **lab.registration(),
            "status": {"S": "approved"},
            "approval_id": {"S": "e" * 32},
            "change_kind": {"S": "replace_app"},
        }
    )
    lab.stage_change(
        kind={"S": "replace_app"},
        pending_provider_name={"S": remote_mcp.provider_name(NS, REG, 2)},
    )
    result = lab.run({"registration_id": REG, "approval_id": "e" * 32})
    assert result["enabled"] is True
    (credentials,) = _target(lab)["credentialProviderConfigurations"]
    arn = credentials["credentialProvider"]["oauthCredentialProvider"]["providerArn"]
    assert arn.endswith(f"/Mango-{NS}-remote-{REG}-g2")
    approved = _verify(lab)
    assert (approved.generation, approved.revision) == (2, 1)
    assert lab.agentcore.providers == {remote_mcp.provider_name(NS, REG, 2)}
    assert lab.store.live(REG) == (2, 1)


def test_replace_app_must_raise_the_generation(lab: RemoteLab) -> None:
    _activate(lab)
    lab.put(
        {
            **lab.registration(),
            "status": {"S": "approved"},
            "approval_id": {"S": "e" * 32},
            "change_kind": {"S": "replace_app"},
        }
    )
    lab.stage_change(kind={"S": "replace_app"})  # g1 again
    result = lab.run({"registration_id": REG, "approval_id": "e" * 32})
    assert result["failure"] == "generation_not_newer"
    # An active registration keeps serving its signed catalog.
    assert result["compensated"] is False
    assert lab.approved() is not None


# --- Disable ------------------------------------------------------------------------------


def test_disable_deletes_the_catalog_first_then_everything_else(lab: RemoteLab) -> None:
    _activate(lab)
    lab.put({**lab.registration(), "status": {"S": "disabling"}, "approval_id": {"S": "f" * 32}})
    deleted: list[str] = []
    original_delete = lab.store.delete_approved

    def delete_approved(registration_id: str) -> None:
        deleted.append(f"item:{len(lab.agentcore.writes())}")
        original_delete(registration_id)

    lab.store.delete_approved = delete_approved  # type: ignore[method-assign]
    lab.agentcore.calls.clear()
    result = lab.run({"registration_id": REG, "approval_id": "f" * 32})
    assert result["disabled"] is True
    # The catalog went before any AgentCore deletion: the interceptor stops first.
    assert deleted[0] == "item:0"
    writes = lab.agentcore.writes()
    assert writes.index("DeletePolicy") < writes.index("DeleteGatewayTarget")
    assert writes.index("DeleteGatewayTarget") < writes.index("DeleteOauth2CredentialProvider")
    assert lab.approved() is None
    assert lab.agentcore.targets == {}
    assert lab.agentcore.statements() == []
    assert lab.agentcore.providers == set()
    assert lab.registration()["status"] == {"S": "disabled"}
    assert lab.events()[-1] == ("mcp_remote.disabled", "applied")


# --- Input, settings, handler -------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        None,
        {"registration_id": REG},
        {"registration_id": REG, "approval_id": APPROVAL, "endpoint": "https://evil.example"},
        {"registration_id": "ABC", "approval_id": APPROVAL},
        {"registration_id": REG, "approval_id": "x" * 32},
    ],
)
def test_the_input_is_exactly_two_identifiers(raw: object) -> None:
    with pytest.raises(StepError, match="invalid_input"):
        parse_input(raw, "exec-1")


def test_settings_refuse_another_key_and_another_return_url() -> None:
    signer = ProfileSigner()
    good = env(signer, {})
    RemoteSettings.from_env(good)
    for key in (
        "alias/Mango-test-remote-mcp",
        "arn:aws:kms:us-east-1:111122223333:key/11111111-2222-3333-4444-555555555555",
    ):
        with pytest.raises(ConfigError, match="REMOTE_MCP_KEY_ARN"):
            RemoteSettings.from_env({**good, "REMOTE_MCP_KEY_ARN": key})
    for url in (
        "http://d123.cloudfront.net/conexiones/vuelta",
        "https://d123.cloudfront.net/api/oauth/callback",
        "https://d123.cloudfront.net/conexiones/vuelta?x=1",
        "https://user@d123.cloudfront.net/conexiones/vuelta",
    ):
        with pytest.raises(ConfigError, match="REMOTE_RETURN_URL"):
            RemoteSettings.from_env({**good, "REMOTE_RETURN_URL": url})


def test_provider_generation_is_parsed_strictly() -> None:
    assert generation_of_provider(NS, REG, f"Mango-{NS}-remote-{REG}-g12") == 12
    for name in (
        f"Mango-{NS}-remote-{REG}-g01",
        f"Mango-{NS}-remote-{REG}-g0",
        f"Mango-x-remote-{REG}-g1",
    ):
        with pytest.raises(ValueError, match=r"provider|generation"):
            generation_of_provider(NS, REG, name)


def test_the_handler_reports_codes_only(lab: RemoteLab) -> None:
    with pytest.raises(Exception, match='"code": "invalid_step"'):
        handle({"step": "rm -rf", "state": {}}, lab.provisioner)
    with pytest.raises(Exception, match='"code": "invalid_input"'):
        handle({"step": "load", "state": {"x": 1}, "execution": "e"}, lab.provisioner)


def test_an_altered_catalog_does_not_verify(lab: RemoteLab) -> None:
    _enable(lab)
    item = lab.approved()
    assert item is not None
    payload = decode_payload(item)
    payload["tools"].append("repo_create_branch")
    tampered = {
        "payload": remote_mcp.item_fields(json.dumps(payload).encode(), b"x")["payload"],
        "signature": item["signature"]["S"],
    }
    with pytest.raises(RemoteNotApprovedError):
        ApprovedRemote.verify(
            remote_mcp.load_public_key(lab.kms.public_der),
            tampered,
            target=f"remote-{REG}",
            gateway_id=GATEWAY_ID,
        )


def test_profile_fixture_is_the_released_azure_devops_profile() -> None:
    assert profile_data()["id"] == "azure-devops"


def test_only_the_gateways_own_workload_identity_gets_the_return_url(lab: RemoteLab) -> None:
    lab.agentcore.workload_identity_arn = (
        "arn:aws:bedrock-agentcore:us-east-1:123456789012:workload-identity-directory/default/"
        "workload-identity/harness_Mango_test_a_finops-x"
    )
    result = _enable(lab)
    assert result["failure"] == "workload_identity_unexpected"
    assert "UpdateWorkloadIdentity" not in lab.agentcore.calls
