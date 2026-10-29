"""After an install, the remote provisioner signs again what a new release only re-headers
(D101): the catalogs and targets made with ``X-MCP-Toolsets`` converge with no new approval."""

from __future__ import annotations

import base64
import json
from collections.abc import Iterator
from typing import Any

import pytest

from mango_core import remote_mcp
from mango_core.remote_mcp import ApprovedRemote
from mango_provisioner.errors import StepError
from mango_provisioner.remotes.handler import handle
from mango_provisioner.remotes.release import release_digest
from mango_provisioner.remotes.store import INDEX_KEY

from .remote_lab import GATEWAY_ID, REG, RemoteLab, decode_payload, profile_data

OLD_DIGEST = "b" * 64
OLD_HEADERS = ["X-MCP-Readonly", "X-MCP-Toolsets"]


@pytest.fixture
def lab(aws: None) -> Iterator[RemoteLab]:
    lab = RemoteLab()
    lab.stage_change()
    assert lab.run(lab.approve())["enabled"] is True
    lab.put({**INDEX_KEY, "ids": {"SS": [REG]}})
    yield lab


def _target(lab: RemoteLab) -> dict[str, Any]:
    (target,) = [t for t in lab.agentcore.targets.values() if t["name"] == f"remote-{REG}"]
    return target


def _as_before_d101(lab: RemoteLab) -> dict[str, Any]:
    """What an installation holds from the release before D101: a target that allows
    ``X-MCP-Toolsets`` and a catalog of payload v1, signed on the previous profile."""
    _target(lab)["metadataConfiguration"] = {"allowedRequestHeaders": list(OLD_HEADERS)}
    item = lab.approved()
    assert item is not None
    claims = decode_payload(item)
    old = {
        **claims,
        "v": 1,
        "profile_version": "2026.10.27-1",
        "profile_sha256": OLD_DIGEST,
        "headers": {"X-MCP-Readonly": "true", "X-MCP-Toolsets": "wit,wiki"},
    }
    payload = json.dumps(old, sort_keys=True, separators=(",", ":")).encode()
    text = base64.urlsafe_b64encode(payload).decode().rstrip("=")
    lab.put({**item, "payload": {"S": text}})
    return old


def _verify(lab: RemoteLab) -> ApprovedRemote:
    item = lab.approved()
    assert item is not None
    return ApprovedRemote.verify(
        remote_mcp.load_public_key(lab.kms.public_der),
        {k: v["S"] for k, v in item.items() if "S" in v},
        target=f"remote-{REG}",
        gateway_id=GATEWAY_ID,
    )


def _sweep(lab: RemoteLab, execution: str = "release-1") -> list[dict[str, Any]]:
    """One execution as the state machine runs it: the plan, then each registration."""
    p = lab.provisioner
    plan = p.release_plan({"release": release_digest(lab.settings.catalog)})
    results = []
    for upgrade in plan["upgrades"]:
        state: dict[str, Any] = {**upgrade, "execution": execution}
        last = "release_begin"
        try:
            state = p.release_begin(state)
            for _ in range(20):
                last = "release_check"
                state = p.release_check(state)
                if state["ready"]:
                    break
            last = "release_sign"
            results.append(p.release_sign(state))
        except StepError as exc:
            message = json.dumps({"step": last, "code": exc.code})
            error = {
                "Error": "ProvisionerStepError",
                "Cause": json.dumps({"errorMessage": message}),
            }
            results.append(p.release_abort({**state, "error": error}))
    return results


def test_a_registration_signed_before_d101_converges_with_no_approval(lab: RemoteLab) -> None:
    old = _as_before_d101(lab)
    version = lab.registration()["version"]
    lab.firehose.records.clear()
    lab.agentcore.calls.clear()
    (result,) = _sweep(lab)
    assert result["upgraded"] is True
    # The target now lets only Mango's two headers through, X-MCP-Tools among them.
    assert _target(lab)["metadataConfiguration"] == {
        "allowedRequestHeaders": ["X-MCP-Readonly", "X-MCP-Tools"]
    }
    approved = _verify(lab)
    assert approved.headers == {
        "X-MCP-Readonly": "true",
        "X-MCP-Tools": ", ".join(sorted(old["tools"])),
    }
    # The same approval: organization, toolsets, tools and provider; a new revision.
    assert approved.tools == frozenset(old["tools"])
    assert list(approved.toolsets) == old["toolsets"]
    assert approved.organization == old["organization"]
    assert approved.generation == old["generation"]
    assert approved.revision == old["revision"] + 1
    assert approved.profile_sha256 == lab.digest
    assert approved.profile_version == "2026.10.27-3"
    registration = lab.registration()
    assert registration["status"] == {"S": "active"}
    assert "provision_lock" not in registration
    assert int(registration["version"]["N"]) > int(version["N"])
    # Never another provider, policy or target: only the target's headers were updated.
    assert [c for c in lab.agentcore.writes() if c != "UpdateGatewayTarget"] == []
    (record,) = lab.firehose.records
    assert record["event"] == "mcp_remote.enabled"
    assert record["detail"]["kind"] == "release"
    assert record["detail"]["outcome"] == "applied"
    assert record["detail"]["approved_by"] == "user-b"


def _as_previous_profile(lab: RemoteLab) -> dict[str, Any]:
    """A registration enabled on the profile before the ``repos`` toolset (D98 (6)): payload
    v2 and the target already on ``X-MCP-Tools``, signed on another profile digest."""
    item = lab.approved()
    assert item is not None
    old = {**decode_payload(item), "profile_version": "2026.10.27-2", "profile_sha256": OLD_DIGEST}
    payload = json.dumps(old, sort_keys=True, separators=(",", ":")).encode()
    lab.put({**item, "payload": {"S": base64.urlsafe_b64encode(payload).decode().rstrip("=")}})
    return old


def test_a_new_toolset_signs_again_with_the_approved_toolsets_only(lab: RemoteLab) -> None:
    # The release adds "Repositorios" (D98 (6)); the registration did not pick it (D101 (7)).
    assert "repos" in {t["id"] for t in profile_data()["toolsets"]}
    old = _as_previous_profile(lab)
    target_before = {k: v for k, v in _target(lab).items() if k != "polls"}
    lab.firehose.records.clear()
    lab.agentcore.calls.clear()
    (result,) = _sweep(lab)
    assert result["upgraded"] is True
    approved = _verify(lab)
    # The same approval, under the new profile: no repo_* tool and the same header.
    assert list(approved.toolsets) == old["toolsets"]
    assert approved.tools == frozenset(old["tools"])
    assert not any(t.startswith("repo_") for t in approved.tools)
    assert approved.headers == old["headers"]
    assert approved.revision == old["revision"] + 1
    assert approved.profile_sha256 == lab.digest
    assert approved.profile_version == "2026.10.27-3"
    # Nothing to converge: the target is the same and nothing was written to the Gateway.
    assert lab.agentcore.writes() == []
    assert {k: v for k, v in _target(lab).items() if k != "polls"} == target_before
    assert lab.events() == [("mcp_remote.enabled", "applied")]


def test_a_registration_already_on_this_release_is_left_alone(lab: RemoteLab) -> None:
    plan = lab.provisioner.release_plan({"release": release_digest(lab.settings.catalog)})
    assert plan["upgrades"] == []


@pytest.mark.parametrize(
    "registration",
    [
        {"status": {"S": "failed"}},
        {"status": {"S": "disabled"}},
        {"provision_lock": {"S": "another-execution"}},
    ],
)
def test_only_an_active_unlocked_registration_is_planned(
    lab: RemoteLab, registration: dict[str, Any]
) -> None:
    _as_before_d101(lab)
    lab.put({**lab.registration(), **registration})
    plan = lab.provisioner.release_plan({"release": release_digest(lab.settings.catalog)})
    assert plan["upgrades"] == []


def test_a_release_that_changes_the_tools_needs_a_request(lab: RemoteLab) -> None:
    old = _as_before_d101(lab)
    item = lab.approved()
    assert item is not None
    # Approved with one tool less than the toolsets give today.
    fewer = {**old, "tools": [t for t in old["tools"] if t != "search_wiki"]}
    payload = json.dumps(fewer, sort_keys=True, separators=(",", ":")).encode()
    lab.put({**item, "payload": {"S": base64.urlsafe_b64encode(payload).decode().rstrip("=")}})
    lab.firehose.records.clear()
    (result,) = _sweep(lab)
    assert result["upgraded"] is False
    assert result["failure"] == "release_needs_request"
    # Nothing changed: the old catalog, the old target, and the lock released.
    assert decode_payload(lab.approved() or {})["profile_sha256"] == OLD_DIGEST
    assert _target(lab)["metadataConfiguration"]["allowedRequestHeaders"] == OLD_HEADERS
    assert "provision_lock" not in lab.registration()
    assert lab.events() == [("mcp_remote.enabled", "rejected")]


def test_a_target_that_differs_in_more_than_headers_needs_a_request(lab: RemoteLab) -> None:
    _as_before_d101(lab)
    server = _target(lab)["targetConfiguration"]["mcp"]["mcpServer"]
    server["endpoint"] = "https://mcp.dev.azure.com/another"
    lab.agentcore.calls.clear()
    (result,) = _sweep(lab)
    assert result["failure"] == "release_needs_request"
    assert "UpdateGatewayTarget" not in lab.agentcore.calls


def test_a_registration_another_execution_holds_is_not_touched(lab: RemoteLab) -> None:
    _as_before_d101(lab)
    p = lab.provisioner
    (upgrade,) = p.release_plan({"release": release_digest(lab.settings.catalog)})["upgrades"]
    lab.put({**lab.registration(), "provision_lock": {"S": "exec-other"}})
    lab.put({**lab.registration(), "provision_lock_until": {"N": "9999999999"}})
    with pytest.raises(StepError, match="busy"):
        p.release_begin({**upgrade, "execution": "release-1"})
    error = {"Error": "BusyStepError", "Cause": ""}
    result = p.release_abort({**upgrade, "execution": "release-1", "error": error})
    assert result["upgraded"] is False
    assert lab.registration()["provision_lock"] == {"S": "exec-other"}


@pytest.mark.parametrize("release", ["c" * 64, "not-a-digest", None])
def test_an_execution_of_another_release_does_nothing(lab: RemoteLab, release: Any) -> None:
    _as_before_d101(lab)
    with pytest.raises(StepError, match=r"release_changed|invalid_input"):
        lab.provisioner.release_plan({"release": release})


def test_the_release_input_is_exactly_the_release(lab: RemoteLab) -> None:
    release = release_digest(lab.settings.catalog)
    for raw in ({"release": release, "registration_id": REG}, {}, [release], None):
        with pytest.raises(StepError, match="invalid_input"):
            lab.provisioner.release_plan(raw)


def test_the_release_digest_is_the_one_the_stack_computes() -> None:
    # Pinned with infra/test/remote-provisioner.test.ts (`remoteReleaseDigest`).
    catalog = {"azure-devops": "a" * 64, "another": "b" * 64}
    assert release_digest(catalog) == release_digest(dict(reversed(catalog.items())))
    assert release_digest(catalog) == (
        "1aba42f0b502fe5bdbab8a16fcb189290f2f3ce2df5bd326819f147a489b27ca"
    )


def test_the_handler_runs_the_release_steps(lab: RemoteLab) -> None:
    _as_before_d101(lab)
    event = {
        "step": "release_plan",
        "state": {"release": release_digest(lab.settings.catalog)},
        "execution": "release-1",
    }
    result = handle(event, lab.provisioner)
    assert [u["registration_id"] for u in result["upgrades"]] == [REG]
    assert result["last_step"] == "release_plan"
