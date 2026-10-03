"""Findings of the daily reconciliation (TM-M6, TM-M9), from an installation staged in moto."""

from __future__ import annotations

import json
import logging
from datetime import timedelta
from typing import Any

import pytest
from botocore.exceptions import ClientError

from mango_core.agents_table import published_key, version_key
from mango_reconciler.checks import Finding, Severity
from mango_reconciler.config import DEPROVISION_GRACE
from mango_reconciler.handler import MAX_REPORTED_FINDINGS, handle, metrics_record
from mango_reconciler.snapshot import SCAN_ATTRIBUTES

from .conftest import AGENT, AGENTS_TABLE, HASH, OTHER, PROMPT_MARKER, Lab

PACK_RUNTIME = "Mango_test_mcp_aws_pricing"


def only(lab: Lab, code: str) -> Finding:
    findings = [f for f in lab.run().findings if f.code == code]
    assert len(findings) == 1, lab.codes()
    return findings[0]


# --- Nothing to report ---------------------------------------------------------------------


def test_published_agents_as_the_provisioner_leaves_them_have_no_findings(lab: Lab) -> None:
    lab.publish(AGENT)
    lab.publish(OTHER)
    report = lab.run()
    assert report.findings == ()
    assert report.stats == {
        "Agents": 2,
        "PublishedAgents": 2,
        "RetiredAgents": 0,
        "AgentsInProgress": 0,
        "Harnesses": 2,
        "AgentRoles": 2,
        "PackRuntimes": 0,
        "VersionsInReview": 0,
        "VersionsApproved": 0,
        "VersionsFailed": 0,
    }


def test_an_empty_installation_has_no_findings(lab: Lab) -> None:
    assert lab.run().findings == ()


def test_resources_of_other_installations_are_ignored(lab: Lab) -> None:
    lab.publish()
    foreign = lab.agentcore.add("Mango_other_a_abcdefghijklmnop", "0000000009")
    lab.agentcore.add_version(foreign, role_arn="arn:aws:iam::1:role/x", markers={})
    lab.agentcore.add_version(
        lab.agentcore.add("finops_agent", "0000000008"), role_arn="x", markers={}
    )
    lab.iam.create_role(
        RoleName="Mango-other-agent-abcdefghijklmnop", AssumeRolePolicyDocument="{}"
    )
    lab.iam.create_role(RoleName="Mango-test-Provisioner", AssumeRolePolicyDocument="{}")
    assert lab.run().findings == ()


def test_it_only_reads(lab: Lab) -> None:
    lab.publish()
    lab.agentcore.add_runtime(PACK_RUNTIME, ("PUBLIC", "VPC"), live="1")
    lab.run()
    assert set(lab.agentcore.calls) == {
        "ListHarnesses",
        "GetHarness",
        "GetHarnessEndpoint",
        "ListAgentRuntimes",
        "GetAgentRuntime",
        "GetAgentRuntimeEndpoint",
    }


# --- Harnesses (TM-M6) ---------------------------------------------------------------------


def test_harness_without_a_definition_is_an_orphan(lab: Lab) -> None:
    harness = lab.agentcore.add(lab.settings.harness_name(AGENT))
    lab.agentcore.add_version(harness, role_arn="x", markers={})
    finding = only(lab, "harness_orphan")
    assert finding.severity is Severity.DRIFT
    assert (finding.agent, finding.resource) == (AGENT, harness["id"])
    assert finding.detail == {"reason": "no_agent"}


def test_harness_under_the_prefix_with_a_name_mango_never_generates(lab: Lab) -> None:
    harness = lab.agentcore.add("Mango_test_a_Not_An_Id")
    lab.agentcore.add_version(harness, role_arn="x", markers={})
    assert only(lab, "harness_orphan").detail == {"reason": "unexpected_name"}


def test_harness_left_by_a_first_publication_that_never_finished(lab: Lab) -> None:
    lab.put_meta(AGENT)
    lab.put_version(AGENT, 1, "failed")
    harness = lab.agentcore.add(lab.settings.harness_name(AGENT))
    lab.agentcore.add_version(harness, role_arn="x", markers=lab.markers(AGENT, 1))
    assert only(lab, "harness_orphan").detail == {"reason": "never_published"}


def test_live_endpoint_on_a_version_other_than_the_published_one(lab: Lab) -> None:
    harness = lab.publish()
    # Someone ran UpdateHarness and moved `live` by CLI.
    lab.agentcore.add_version(
        harness, role_arn=lab.settings.role_arn(AGENT), markers=lab.markers(AGENT, 1)
    )
    harness["live"] = {"status": "READY", "liveVersion": "2"}
    codes = lab.codes()
    assert codes == ["harness_version_unexpected", "live_endpoint_drift"]
    assert only(lab, "live_endpoint_drift").detail == {
        "reason": "version",
        "expected": "1",
        "actual": "2",
    }
    assert only(lab, "harness_version_unexpected").detail == {"expected": "1", "actual": "2"}


def test_harness_version_added_out_of_band_without_moving_live(lab: Lab) -> None:
    harness = lab.publish()
    lab.agentcore.add_version(
        harness, role_arn=lab.settings.role_arn(AGENT), markers=lab.markers(AGENT, 1)
    )
    assert lab.codes() == ["harness_version_unexpected"]


def test_live_endpoint_deleted_or_not_ready(lab: Lab) -> None:
    harness = lab.publish()
    harness["live"] = None
    assert only(lab, "live_endpoint_drift").detail == {"reason": "missing"}
    harness["live"] = {"status": "UPDATE_FAILED", "liveVersion": "1"}
    assert only(lab, "live_endpoint_drift").detail == {
        "reason": "status",
        "actual": "UPDATE_FAILED",
    }


def test_harness_version_of_a_failed_attempt_is_not_drift(lab: Lab) -> None:
    harness = lab.publish()
    lab.put_version(AGENT, 2, "failed", content_hash="b" * 64)
    lab.agentcore.add_version(
        harness, role_arn=lab.settings.role_arn(AGENT), markers=lab.markers(AGENT, 2, "b" * 64)
    )
    assert lab.run().findings == ()


def test_deployed_version_does_not_carry_the_published_hash(lab: Lab) -> None:
    harness = lab.publish()
    harness["versions"]["1"]["environmentVariables"]["MANGO_CONTENT_HASH"] = "c" * 64
    harness["versions"]["1"]["executionRoleArn"] = "arn:aws:iam::123456789012:role/Admin"
    assert only(lab, "harness_content_mismatch").detail == {
        "fields": "MANGO_CONTENT_HASH,executionRoleArn"
    }


def test_harness_deleted_and_created_again(lab: Lab) -> None:
    harness = lab.publish()
    del lab.agentcore.harnesses[harness["id"]]
    replaced = lab.agentcore.add(harness["name"], "0000000002")
    lab.agentcore.add_version(
        replaced, role_arn=lab.settings.role_arn(AGENT), markers=lab.markers(AGENT, 1)
    )
    replaced["live"] = {"status": "READY", "liveVersion": "1"}
    finding = only(lab, "harness_replaced")
    assert finding.resource == replaced["id"]
    assert lab.codes() == ["harness_replaced"]


def test_published_agent_without_harness(lab: Lab) -> None:
    harness = lab.publish()
    del lab.agentcore.harnesses[harness["id"]]
    assert only(lab, "harness_missing").agent == AGENT


# --- Roles (TM-M1, TM-M6) ------------------------------------------------------------------


def test_role_without_the_boundary(lab: Lab) -> None:
    lab.publish()
    name = lab.settings.role_name(AGENT)
    lab.iam.delete_role_permissions_boundary(RoleName=name)
    finding = only(lab, "role_without_boundary")
    assert (finding.agent, finding.resource, finding.detail) == (AGENT, name, {"boundary": "none"})


def test_role_with_another_boundary(lab: Lab) -> None:
    lab.publish()
    other = lab.iam.create_policy(
        PolicyName="Wide",
        PolicyDocument=json.dumps(
            {
                "Version": "2012-10-17",
                "Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}],
            }
        ),
    )["Policy"]["Arn"]
    lab.iam.put_role_permissions_boundary(
        RoleName=lab.settings.role_name(AGENT), PermissionsBoundary=other
    )
    assert only(lab, "role_without_boundary").detail == {"boundary": "other"}


def test_role_trust_changed(lab: Lab) -> None:
    lab.publish()
    trust = lab.settings.trust_policy(AGENT)
    trust["Statement"][0]["Principal"] = {"AWS": "arn:aws:iam::999999999999:root"}
    lab.iam.update_assume_role_policy(
        RoleName=lab.settings.role_name(AGENT), PolicyDocument=json.dumps(trust)
    )
    assert lab.codes() == ["role_trust_changed"]


def test_role_with_extra_policies(lab: Lab) -> None:
    lab.publish()
    name = lab.settings.role_name(AGENT)
    lab.iam.put_role_policy(
        RoleName=name,
        PolicyName="extra",
        PolicyDocument=json.dumps(
            {
                "Version": "2012-10-17",
                "Statement": [{"Effect": "Allow", "Action": "s3:*", "Resource": "*"}],
            }
        ),
    )
    lab.iam.attach_role_policy(RoleName=name, PolicyArn=lab.settings.boundary_arn)
    assert only(lab, "role_policies_changed").detail == {"inline": "agent,extra", "attached": "1"}


def test_role_without_a_definition_is_an_orphan_and_is_still_checked(lab: Lab) -> None:
    lab.create_role(OTHER, boundary=None)
    assert lab.codes() == ["role_orphan", "role_without_boundary"]
    assert only(lab, "role_orphan").detail == {"reason": "no_agent"}


def test_role_name_that_differs_only_in_case_is_seen(lab: Lab) -> None:
    lab.iam.create_role(RoleName="mango-TEST-agent-x", AssumeRolePolicyDocument="{}")
    assert only(lab, "role_orphan").detail == {"reason": "unexpected_name"}


def test_published_agent_without_role(lab: Lab) -> None:
    lab.publish()
    name = lab.settings.role_name(AGENT)
    lab.iam.delete_role_policy(RoleName=name, PolicyName="agent")
    lab.iam.delete_role(RoleName=name)
    assert only(lab, "role_missing").resource == name


# --- Publication in progress and stuck versions --------------------------------------------


def test_agent_being_provisioned_is_not_compared(lab: Lab) -> None:
    harness = lab.publish()
    # Version 2 approved a minute ago: the provisioner already moved `live`, not yet the table.
    lab.put_version(AGENT, 2, "approved", at=lab.now - timedelta(minutes=1), content_hash="b" * 64)
    lab.agentcore.add_version(
        harness, role_arn=lab.settings.role_arn(AGENT), markers=lab.markers(AGENT, 2, "b" * 64)
    )
    harness["live"] = {"status": "READY", "liveVersion": "2"}
    lab.iam.delete_role_policy(RoleName=lab.settings.role_name(AGENT), PolicyName="agent")
    report = lab.run()
    assert report.findings == ()
    assert report.stats["AgentsInProgress"] == 1


def test_agent_with_an_unexpired_provisioner_lock_is_not_compared(lab: Lab) -> None:
    harness = lab.publish()
    harness["live"] = None
    lab.update_meta(
        AGENT,
        "SET provision_lock = :o, provision_lock_until = :u",
        {":o": {"S": "exec-1"}, ":u": {"N": str(int(lab.now.timestamp()) + 60)}},
    )
    assert lab.run().findings == ()
    lab.now += timedelta(minutes=2)
    assert lab.codes() == ["live_endpoint_drift"]


def test_approved_version_with_no_execution_behind_it(lab: Lab) -> None:
    """A4 report §9 (execution timed out) and A3 report §7.8 (execution never started)."""
    lab.publish()
    at = lab.now - timedelta(minutes=46)
    lab.put_version(AGENT, 2, "approved", at=at, content_hash="b" * 64)
    finding = only(lab, "version_stuck_approved")
    assert finding.agent == AGENT
    assert finding.detail == {"version": "2", "since": at.isoformat()}


def test_timed_out_execution_that_had_moved_live_is_reported(lab: Lab) -> None:
    harness = lab.publish()
    lab.put_version(AGENT, 2, "approved", at=lab.now - timedelta(hours=3), content_hash="b" * 64)
    lab.agentcore.add_version(
        harness, role_arn=lab.settings.role_arn(AGENT), markers=lab.markers(AGENT, 2, "b" * 64)
    )
    harness["live"] = {"status": "READY", "liveVersion": "2"}
    assert lab.codes() == ["live_endpoint_drift", "version_stuck_approved"]


def test_a_lock_longer_than_any_execution_does_not_hide_the_agent(lab: Lab) -> None:
    """Whoever can write the table must not be able to exempt an agent from the comparison."""
    harness = lab.publish()
    harness["live"] = None
    lab.update_meta(
        AGENT,
        "SET provision_lock = :o, provision_lock_until = :u",
        {":o": {"S": "x"}, ":u": {"N": str(int(lab.now.timestamp()) + 365 * 86400)}},
    )
    assert lab.codes() == ["live_endpoint_drift", "provision_lock_invalid"]


def test_an_approval_dated_in_the_future_does_not_hide_the_agent(lab: Lab) -> None:
    harness = lab.publish()
    harness["live"] = None
    lab.put_version(AGENT, 2, "approved", at=lab.now + timedelta(days=30), content_hash="b" * 64)
    assert lab.codes() == ["live_endpoint_drift", "version_stuck_approved"]


def test_a_timestamp_without_offset_is_an_invalid_record(lab: Lab) -> None:
    lab.publish()
    lab.put_version(AGENT, 2, "approved", content_hash="b" * 64)
    lab.db.update_item(
        TableName=AGENTS_TABLE,
        Key=version_key(AGENT, 2),
        UpdateExpression="SET status_at = :at",
        ExpressionAttributeValues={":at": {"S": "2026-10-02T06:59:00"}},
    )
    assert lab.codes() == ["record_invalid"]


# --- Retired agents ------------------------------------------------------------------------


def _retire(lab: Lab, agent_id: str = AGENT, *, ago: timedelta = timedelta(minutes=5)) -> None:
    """A published agent as mango-api leaves it when it is retired ``ago``."""
    lab.publish(agent_id)
    lab.update_meta(agent_id, "SET #s = :r", {":r": {"S": "retired"}}, {"#s": "status"})
    lab.put_version(agent_id, 1, "retired", at=lab.now - ago)


def test_resources_of_an_agent_retired_just_now_are_counted_but_do_not_alarm(lab: Lab) -> None:
    """The deprovisioner starts with the retirement (D48): for a while this is expected."""
    _retire(lab)
    report = lab.run()
    assert sorted(f.code for f in report.findings) == ["retired_agent_resources"] * 2
    assert report.alarming == 0
    assert report.count(Severity.CLEANUP) == 2
    assert report.stats["RetiredAgents"] == 1


def test_retired_agent_whose_resources_are_gone_has_no_findings(lab: Lab) -> None:
    """What the deprovisioner leaves: the records stay, the harness and the role do not."""
    _retire(lab, ago=timedelta(days=3))
    lab.agentcore.harnesses.clear()
    name = lab.settings.role_name(AGENT)
    lab.iam.delete_role_policy(RoleName=name, PolicyName="agent")
    lab.iam.delete_role(RoleName=name)
    report = lab.run()
    assert report.findings == ()
    assert report.stats["RetiredAgents"] == 1
    assert (report.stats["Harnesses"], report.stats["AgentRoles"]) == (0, 0)


def test_resources_left_after_the_grace_period_alarm_as_a_failed_removal(lab: Lab) -> None:
    _retire(lab, ago=DEPROVISION_GRACE + timedelta(minutes=1))
    report = lab.run()
    findings = sorted(report.findings, key=lambda f: str(f.resource))
    assert [f.code for f in findings] == ["deprovision_incomplete"] * 2
    assert [f.severity for f in findings] == [Severity.DRIFT] * 2
    assert report.alarming == 2
    assert {f.resource for f in findings} == {
        lab.settings.role_name(AGENT),
        f"{lab.settings.harness_name(AGENT)}-0000000001",
    }
    retired_at = (lab.now - DEPROVISION_GRACE - timedelta(minutes=1)).isoformat()
    assert all(f.detail == {"retired_at": retired_at} for f in findings)


def test_only_what_is_left_is_reported(lab: Lab) -> None:
    """The harness went and the role did not (for example, a role changed by hand)."""
    _retire(lab, ago=timedelta(days=1))
    lab.agentcore.harnesses.clear()
    finding = only(lab, "deprovision_incomplete")
    assert finding.resource == lab.settings.role_name(AGENT)
    assert lab.codes() == ["deprovision_incomplete"]


def test_a_removal_in_progress_is_not_reported(lab: Lab) -> None:
    _retire(lab, ago=timedelta(hours=3))
    until = int((lab.now + timedelta(minutes=20)).timestamp())
    lab.update_meta(
        AGENT,
        "SET provision_lock = :o, provision_lock_until = :u",
        {":o": {"S": "retire-1"}, ":u": {"N": str(until)}},
    )
    report = lab.run()
    assert report.findings == ()
    assert report.stats["AgentsInProgress"] == 1


def test_a_retirement_dated_in_the_future_does_not_hide_what_is_left(lab: Lab) -> None:
    """``status_at`` is written by mango-api: it cannot extend the grace period."""
    _retire(lab, ago=-timedelta(days=30))
    assert lab.codes() == ["deprovision_incomplete"] * 2


def test_retired_release_agent_keeps_its_resources_without_alarm(lab: Lab) -> None:
    """The deprovisioner never deletes the agents of the release (D48)."""
    _retire(lab, "finops", ago=timedelta(days=30))
    report = lab.run()
    assert sorted(f.code for f in report.findings) == ["retired_agent_resources"] * 2
    assert report.alarming == 0


# --- Agents of the release (D34, D42, TM-M16) -------------------------------------------------

FINOPS = "finops"


def test_release_agent_serving_the_release_content_has_no_findings(lab: Lab) -> None:
    lab.publish(FINOPS)
    assert lab.settings.release_agents == {FINOPS: HASH}
    assert lab.run().findings == ()


def test_release_agent_serving_other_content_is_reported(lab: Lab) -> None:
    # Content written under the release agent's id around mango-api (accepted risk, D42), or
    # a change approved in the installation: the table cannot tell, so a person confirms it.
    lab.publish(FINOPS)
    other = "d" * 64
    lab.put_version(FINOPS, 1, "published", content_hash=other)
    lab.db.update_item(
        TableName=AGENTS_TABLE,
        Key=published_key(FINOPS),
        UpdateExpression="SET content_hash = :h",
        ExpressionAttributeValues={":h": {"S": other}},
    )
    report = lab.run()
    (finding,) = [f for f in report.findings if f.code == "release_agent_content_changed"]
    assert finding.severity is Severity.DRIFT
    assert (finding.agent, finding.detail) == (FINOPS, {"version": "1"})
    assert other not in json.dumps(finding.as_dict())
    assert report.alarming >= 1


def test_other_agents_are_not_compared_with_the_release(lab: Lab) -> None:
    lab.publish(AGENT)
    lab.publish(FINOPS)
    lab.put_version(AGENT, 1, "published", content_hash="d" * 64)
    assert "release_agent_content_changed" not in lab.codes()


def test_release_agent_that_is_not_published_yet_is_not_reported(lab: Lab) -> None:
    lab.put_meta(FINOPS)
    lab.put_version(FINOPS, 1, "approved", at=lab.now)
    assert lab.run().findings == ()


# --- Table consistency (TM-M2) -------------------------------------------------------------


def test_meta_that_disagrees_with_the_pointer(lab: Lab) -> None:
    lab.publish()
    lab.update_meta(AGENT, "SET published_version = :n", {":n": {"N": "7"}})
    assert only(lab, "publication_record_mismatch").detail == {"reason": "meta"}


def test_published_version_whose_hash_is_not_the_one_deployed(lab: Lab) -> None:
    lab.publish()
    lab.put_version(AGENT, 1, "published", content_hash="d" * 64)
    assert only(lab, "publication_record_mismatch").detail == {"reason": "version"}


def test_agent_marked_published_without_pointer(lab: Lab) -> None:
    harness = lab.publish()
    lab.db.delete_item(TableName=AGENTS_TABLE, Key=published_key(AGENT))
    assert lab.codes() == ["harness_orphan", "publication_record_mismatch", "role_orphan"]
    del lab.agentcore.harnesses[harness["id"]]
    assert only(lab, "publication_record_mismatch").detail == {"reason": "no_pointer"}


def test_pointer_without_agent(lab: Lab) -> None:
    lab.db.put_item(
        TableName=AGENTS_TABLE,
        Item={
            **published_key(AGENT),
            "n": {"N": "1"},
            "content_hash": {"S": HASH},
            "harness_arn": {"S": "arn"},
            "harness_version": {"S": "1"},
        },
    )
    assert only(lab, "publication_record_mismatch").detail == {"reason": "no_agent"}


def test_items_outside_the_layout_are_reported_not_fatal(lab: Lab) -> None:
    lab.publish()
    lab.db.put_item(
        TableName=AGENTS_TABLE, Item={"PK": {"S": "AGENT#" + OTHER}, "SK": {"S": "META"}}
    )
    lab.db.put_item(TableName=AGENTS_TABLE, Item={"PK": {"S": "WHAT"}, "SK": {"S": "EVER"}})
    resources = sorted(str(f.resource) for f in lab.run().findings if f.code == "record_invalid")
    assert resources == [f"AGENT#{OTHER}|META", "WHAT|EVER"]


# --- Quotas (TM-M9) ------------------------------------------------------------------------


def test_creator_over_the_daily_submission_limit(lab: Lab) -> None:
    lab.put_submissions("creator-ok", 5)
    lab.put_submissions("creator-9", 6)
    finding = only(lab, "creator_over_submissions")
    assert finding.severity is Severity.QUOTA
    assert finding.resource == "creator-9"
    assert finding.detail == {"day": lab.now.date().isoformat(), "count": "6"}


def test_creator_over_the_draft_limit(lab: Lab) -> None:
    lab.put_meta(AGENT)
    for number in range(1, 22):
        lab.put_version(AGENT, number, "draft", creator="creator-9", content_hash=None)
    lab.put_meta(OTHER)
    for number in range(1, 21):
        lab.put_version(OTHER, number, "draft", creator="creator-ok", content_hash=None)
    finding = only(lab, "creator_over_drafts")
    assert (finding.resource, finding.detail) == ("creator-9", {"count": "21"})
    assert lab.run().alarming == 1


# --- Pack runtimes outside the pack network (R6, TM-E7) --------------------------------------


def test_pack_runtimes_in_the_pack_vpc_have_no_findings(lab: Lab) -> None:
    lab.agentcore.add_runtime(PACK_RUNTIME)
    lab.agentcore.add_runtime("Mango_test_mcp_aws_billing", ("VPC", "VPC"), suffix="0000000002")
    report = lab.run()
    assert report.findings == ()
    assert report.stats["PackRuntimes"] == 2


def test_pack_runtime_installed_before_the_pack_network_is_reported(lab: Lab) -> None:
    runtime = lab.agentcore.add_runtime(PACK_RUNTIME, ("PUBLIC",))
    finding = only(lab, "pack_runtime_not_in_vpc")
    assert finding.severity is Severity.DRIFT
    assert (finding.agent, finding.resource) == (None, runtime["id"])
    assert finding.detail == {"version": "1", "network": "PUBLIC", "endpoints": "DEFAULT,live"}
    # It alarms: the runtime can reach the internet until the pack is updated or disabled.
    assert lab.run().alarming == 1


def test_an_update_that_never_moved_live_leaves_the_public_version_served(lab: Lab) -> None:
    lab.agentcore.add_runtime(PACK_RUNTIME, ("PUBLIC", "VPC"), live="1")
    finding = only(lab, "pack_runtime_not_in_vpc")
    assert finding.detail == {"version": "1", "network": "PUBLIC", "endpoints": "live"}


def test_an_updated_pack_is_no_longer_reported(lab: Lab) -> None:
    # Runtime versions cannot be deleted: the old one stays, but nothing serves it.
    lab.agentcore.add_runtime(PACK_RUNTIME, ("PUBLIC", "VPC"))
    assert lab.run().findings == ()


def test_a_version_added_outside_mango_is_reported_even_if_live_did_not_move(lab: Lab) -> None:
    lab.agentcore.add_runtime(PACK_RUNTIME, ("VPC", "PUBLIC"), live="1")
    finding = only(lab, "pack_runtime_not_in_vpc")
    assert finding.detail == {"version": "2", "network": "PUBLIC", "endpoints": "DEFAULT"}


def test_a_pack_runtime_without_live_or_without_a_network_is_still_checked(lab: Lab) -> None:
    lab.agentcore.add_runtime(PACK_RUNTIME, ("PUBLIC",), live=None)
    lab.agentcore.add_runtime("Mango_test_mcp_aws_billing", (None,), suffix="0000000002")
    details = sorted(
        (f.resource, f.detail["network"], f.detail["endpoints"]) for f in lab.run().findings
    )
    assert details == [
        ("Mango_test_mcp_aws_billing-0000000002", "unknown", "DEFAULT,live"),
        (f"{PACK_RUNTIME}-0000000001", "PUBLIC", "DEFAULT"),
    ]


def test_runtimes_that_are_not_this_installation_s_packs_are_ignored(lab: Lab) -> None:
    lab.publish()
    # The managed runtime of a harness, another installation's pack and someone else's.
    for number, name in enumerate(
        (f"harness_{lab.settings.harness_name(AGENT)}", "Mango_other_mcp_aws_pricing", "my_agent")
    ):
        lab.agentcore.add_runtime(name, ("PUBLIC",), suffix=f"000000000{number}")
    report = lab.run()
    assert report.findings == ()
    assert report.stats["PackRuntimes"] == 0
    assert "GetAgentRuntime" not in lab.agentcore.calls


def test_a_pack_runtime_deleted_during_the_run_is_skipped(lab: Lab) -> None:
    lab.agentcore.add_runtime(PACK_RUNTIME, ("PUBLIC",))
    lab.agentcore.fail["GetAgentRuntime"] = ClientError(
        {"Error": {"Code": "ResourceNotFoundException", "Message": ""}}, "GetAgentRuntime"
    )
    assert lab.run().findings == ()


# --- Fail closed ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "operation",
    [
        "ListHarnesses",
        "GetHarness",
        "GetHarnessEndpoint",
        "ListAgentRuntimes",
        "GetAgentRuntime",
        "GetAgentRuntimeEndpoint",
    ],
)
def test_a_failed_read_fails_the_run(lab: Lab, operation: str) -> None:
    lab.publish()
    lab.agentcore.add_runtime(PACK_RUNTIME)
    lab.agentcore.fail[operation] = ClientError(
        {"Error": {"Code": "AccessDeniedException", "Message": ""}}, operation
    )
    with pytest.raises(ClientError):
        lab.run()


def test_a_missing_table_fails_the_run(lab: Lab) -> None:
    lab.db.delete_table(TableName=AGENTS_TABLE)
    with pytest.raises(ClientError):
        lab.run()


# --- No agent content ----------------------------------------------------------------------


def test_the_scan_never_asks_for_the_definition(lab: Lab, monkeypatch: pytest.MonkeyPatch) -> None:
    lab.publish()
    requests: list[dict[str, Any]] = []
    scan = lab.db._make_api_call

    def record(operation: str, params: dict[str, Any]) -> Any:
        if operation == "Scan":
            requests.append(params)
        return scan(operation, params)

    monkeypatch.setattr(lab.db, "_make_api_call", record)
    lab.run()
    assert requests
    for request in requests:
        assert request["Select"] == "SPECIFIC_ATTRIBUTES"
        assert request["ConsistentRead"] is True
        assert "FilterExpression" not in request
        assert sorted(request["ExpressionAttributeNames"].values()) == sorted(SCAN_ATTRIBUTES)
    assert "definition" not in SCAN_ATTRIBUTES


# --- Output --------------------------------------------------------------------------------


def test_handler_logs_findings_and_emits_metrics_without_content(
    lab: Lab, caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str]
) -> None:
    lab.publish()
    lab.iam.delete_role_permissions_boundary(RoleName=lab.settings.role_name(AGENT))
    with caplog.at_level(logging.INFO):
        result = handle(lab.reconciler, lab.settings, lab.now)

    assert result["findings"] == 1
    assert result["reported"] == [
        {
            "code": "role_without_boundary",
            "severity": "drift",
            "agent": AGENT,
            "resource": lab.settings.role_name(AGENT),
            "detail": {"boundary": "none"},
        }
    ]
    events = [json.loads(r.getMessage()) for r in caplog.records]
    assert [e["event"] for e in events] == ["reconciler.finding", "reconciler.summary"]
    assert events[0]["code"] == "role_without_boundary"

    emf = json.loads(capsys.readouterr().out)
    directive = emf["_aws"]["CloudWatchMetrics"][0]
    assert directive["Namespace"] == "Mango/Reconciler"
    assert directive["Dimensions"] == [["Installation"]]
    assert emf["Installation"] == "test"
    assert emf["_aws"]["Timestamp"] == int(lab.now.timestamp() * 1000)
    counts = {name: emf[name] for name in ("Runs", "Findings", "DriftFindings", "QuotaFindings")}
    assert counts == {"Runs": 1, "Findings": 1, "DriftFindings": 1, "QuotaFindings": 0}
    for metric in directive["Metrics"]:
        assert isinstance(emf[metric["Name"]], int)
    names = {metric["Name"] for metric in directive["Metrics"]}
    assert {"Harnesses", "AgentRoles", "PackRuntimes", "PublishedAgents"} <= names

    everything = json.dumps(result) + caplog.text + json.dumps(emf)
    assert PROMPT_MARKER not in everything


def test_a_clean_run_reports_zero_so_the_alarm_can_clear(lab: Lab) -> None:
    lab.publish()
    record = metrics_record("test", lab.run(), lab.now)
    assert record["Findings"] == 0
    assert record["Runs"] == 1


def test_many_findings_are_all_counted_but_reported_up_to_a_limit(
    lab: Lab, capsys: pytest.CaptureFixture[str]
) -> None:
    for number in range(MAX_REPORTED_FINDINGS + 5):
        lab.db.put_item(TableName=AGENTS_TABLE, Item={"PK": {"S": f"X#{number}"}, "SK": {"S": "Y"}})
    result = handle(lab.reconciler, lab.settings, lab.now)
    assert result["findings"] == MAX_REPORTED_FINDINGS + 5
    assert len(result["reported"]) == MAX_REPORTED_FINDINGS
    assert json.loads(capsys.readouterr().out)["Findings"] == MAX_REPORTED_FINDINGS + 5


def test_detail_values_are_bounded() -> None:
    finding = Finding("x", Severity.DRIFT, detail={"inline": "p" * 5000})
    assert len(finding.as_dict()["detail"]["inline"]) == 200
