"""The deprovisioner end to end against moto (DynamoDB, IAM) and the fake AgentCore.

Agents are first published with the real provisioner, then retired the way mango-api does
it, so the deprovisioner removes exactly what a publication leaves behind.
"""

from __future__ import annotations

import json
import logging
from datetime import timedelta
from typing import Any

import pytest
from botocore.exceptions import ClientError

from mango_core.agents_table import meta_key, published_key, version_key
from mango_provisioner.audit import ACTOR, EVENT_DEPROVISION, AuditWriter
from mango_provisioner.config import ConfigError
from mango_provisioner.deprovision import handler
from mango_provisioner.deprovision.config import DeprovisionSettings
from mango_provisioner.deprovision.resources import RetiredHarnesses, RetiredRoles
from mango_provisioner.deprovision.steps import MAX_WAIT_ATTEMPTS, Deprovisioner, parse_input
from mango_provisioner.deprovision.store import READ_ATTRIBUTES, DeprovisionStore
from mango_provisioner.errors import BusyError, RetryableError, StepError
from mango_provisioner.store import LOCK_TTL

from .conftest import (
    AGENT,
    AGENTS_TABLE,
    AUDIT_TABLE,
    BOUNDARY_ARN,
    ENV,
    PROMPT,
    FakeFirehose,
    Lab,
    make_definition,
)

OTHER = "bcdefghijklmnopq"
RELEASE = "finops"
DEPROVISION_ENV = {
    name: ENV[name]
    for name in (
        "MANGO_NAMESPACE",
        "MANGO_ACCOUNT_ID",
        "AWS_REGION",
        "AGENTS_TABLE",
        "AUDIT_STREAM",
        "AUDIT_INDEX_TABLE",
        "AGENT_BOUNDARY_ARN",
    )
} | {"RELEASE_AGENTS": json.dumps({RELEASE: "a" * 64})}


class RecordingDynamoDB:
    """Passes everything to moto and keeps the arguments of each call."""

    def __init__(self, client: Any) -> None:
        self._client = client
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def __getattr__(self, name: str) -> Any:
        method = getattr(self._client, name)

        def call(**kwargs: Any) -> Any:
            self.calls.append((name, kwargs))
            return method(**kwargs)

        return call


class DeprovisionLab:
    """The deprovisioner on top of ``Lab``: same table, IAM and fake AgentCore."""

    def __init__(self, lab: Lab) -> None:
        self.lab = lab
        self.settings = DeprovisionSettings.from_env(DEPROVISION_ENV)
        self.db = RecordingDynamoDB(lab.db)
        self.firehose = FakeFirehose()
        self.deprovisioner = Deprovisioner(
            self.settings,
            store=DeprovisionStore(self.db, AGENTS_TABLE),  # type: ignore[arg-type]
            harnesses=RetiredHarnesses(lab.agentcore, self.settings),  # type: ignore[arg-type]
            roles=RetiredRoles(lab.iam, self.settings),
            audit=AuditWriter(self.firehose, "Mango-test-Audit", lab.db, AUDIT_TABLE),  # type: ignore[arg-type]
            clock=lambda: lab.now,
        )

    # --- What the provisioner and mango-api would have done ---

    def publish(self, agent_id: str = AGENT) -> None:
        state = self.lab.run(
            self.lab.approve(make_definition(), agent_id=agent_id), execution=f"pub-{agent_id}"
        )
        assert state["published"] is True
        self.lab.agentcore.calls.clear()

    def retire(self, agent_id: str = AGENT, version: int = 1) -> None:
        """The two writes of ``AgentsStore.retire``."""
        for key in (meta_key(agent_id), version_key(agent_id, version)):
            self.lab.db.update_item(
                TableName=AGENTS_TABLE,
                Key=key,
                UpdateExpression="SET #s = :retired",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":retired": {"S": "retired"}},
            )

    def retired(self, agent_id: str = AGENT) -> None:
        self.publish(agent_id)
        self.retire(agent_id)

    # --- What is left ---

    def harness(self, agent_id: str = AGENT) -> dict[str, Any] | None:
        name = f"Mango_test_a_{agent_id}"
        return next((h for h in self.lab.agentcore.harnesses.values() if h["name"] == name), None)

    def events(self) -> list[tuple[str, str]]:
        return [(r["event"], r["detail"]["outcome"]) for r in self.firehose.records]

    # --- The state machine, in Python ---

    def run(self, agent_id: str = AGENT, execution: str = "retire-1") -> dict[str, Any]:
        d = self.deprovisioner
        state: dict[str, Any] = {"agent_id": agent_id}
        last = "start"

        def call(name: str, step: Any, *args: Any) -> dict[str, Any]:
            nonlocal last
            last = name
            return {**step(*args), "last_step": name}

        try:
            state = call("load", d.load, state, execution)
            if state["action"] == "noop":
                return state
            for name, step in (
                ("delete_endpoints", d.delete_endpoints),
                ("delete_harness", d.delete_harness),
            ):
                state = call(name, step, state)
                while not state["ready"]:
                    state = call(name, step, state)
            state = call("delete_role", d.delete_role, state)
            return call("finish", d.finish, state)
        except Exception as exc:  # noqa: BLE001 - like the state machine's catch-all
            code = getattr(exc, "code", type(exc).__name__)
            cause = json.dumps({"errorMessage": json.dumps({"step": last, "code": code})})
            return d.mark_failed(
                {**state, "execution": execution, "error": {"Error": "X", "Cause": cause}}
            )


@pytest.fixture
def dlab(lab: Lab) -> DeprovisionLab:
    return DeprovisionLab(lab)


def _s(item: dict[str, Any], name: str) -> str | None:
    value: str | None = item.get(name, {}).get("S")
    return value


# --- Removing a retired agent -------------------------------------------------------------


def test_retired_agent_loses_its_harness_endpoints_and_role(dlab: DeprovisionLab) -> None:
    dlab.retired()
    assert dlab.harness() is not None and dlab.lab.role_exists()

    state = dlab.run()

    assert state["deprovisioned"] is True
    assert dlab.harness() is None
    assert not dlab.lab.role_exists()
    assert dlab.events() == [(EVENT_DEPROVISION, "requested"), (EVENT_DEPROVISION, "applied")]
    applied = dlab.firehose.records[-1]
    assert applied["user_id"] == ACTOR
    assert applied["resource"] == {"type": "agent", "id": AGENT}
    assert applied["detail"] == {
        "agent": AGENT,
        "outcome": "applied",
        "execution": "retire-1",
        "harness": f"Mango_test_a_{AGENT}",
        "role": f"Mango-test-agent-{AGENT}",
        "version": 1,
    }


def test_history_stays_and_the_lock_is_released(dlab: DeprovisionLab) -> None:
    dlab.retired()
    before = {
        "version": dlab.lab.version(1),
        "pointer": dlab.lab.item(published_key(AGENT)),
    }
    dlab.run()

    meta = dlab.lab.meta()
    assert _s(meta, "status") == "retired"
    assert meta["published_version"]["N"] == "1"
    assert "provision_lock" not in meta and "provision_lock_until" not in meta
    # The version stays retired with its definition, and the pointer is not touched (D22).
    assert dlab.lab.version(1) == before["version"]
    assert _s(dlab.lab.version(1), "status") == "retired"
    assert dlab.lab.item(published_key(AGENT)) == before["pointer"]


def test_harness_is_deleted_only_after_its_endpoints_and_the_role_after_the_harness(
    dlab: DeprovisionLab,
) -> None:
    dlab.retired()
    agentcore = dlab.lab.agentcore
    agentcore.polls_until_deleted = 3
    seen: list[str] = []
    delete_harness, delete_role = agentcore.delete_harness, dlab.lab.iam.delete_role

    def harness_deleted(**kwargs: Any) -> Any:
        harness = dlab.harness()
        assert harness is not None
        assert harness["endpoint"] is None, "the live endpoint is still there"
        seen.append("harness")
        return delete_harness(**kwargs)

    def role_deleted(**kwargs: Any) -> Any:
        assert dlab.harness() is None, "the harness still runs with this role"
        seen.append("role")
        return delete_role(**kwargs)

    agentcore.delete_harness = harness_deleted  # type: ignore[method-assign]
    dlab.lab.iam.delete_role = role_deleted
    state = dlab.run()

    assert state["deprovisioned"] is True
    assert seen == ["harness", "role"]
    # Asked once each; the rest of the polls only look.
    assert agentcore.calls.count("DeleteHarnessEndpoint") == 1
    assert agentcore.calls.count("DeleteHarness") == 1
    # It never reads a harness: the prompt it stores is not requested.
    assert "GetHarness" not in agentcore.calls
    assert "GetHarnessEndpoint" not in agentcore.calls


def test_every_endpoint_but_default_is_deleted(dlab: DeprovisionLab) -> None:
    dlab.retired()
    harness = dlab.harness()
    assert harness is not None
    harness["extra_endpoints"]["canary"] = {"status": "READY", "polls": 0}
    deleted: list[str] = []
    original = dlab.lab.agentcore.delete_harness_endpoint

    def record(**kwargs: Any) -> Any:
        deleted.append(kwargs["endpointName"])
        return original(**kwargs)

    dlab.lab.agentcore.delete_harness_endpoint = record  # type: ignore[method-assign]
    assert dlab.run()["deprovisioned"] is True
    assert sorted(deleted) == ["canary", "live"]


def test_repeating_a_finished_removal_changes_nothing(dlab: DeprovisionLab) -> None:
    dlab.retired()
    dlab.run()
    events, calls = len(dlab.firehose.records), list(dlab.lab.agentcore.calls)

    again = dlab.run(execution="retire-2")

    assert again["action"] == "noop" and again["reason"] == "nothing_left"
    assert len(dlab.firehose.records) == events
    assert "provision_lock" not in dlab.lab.meta()
    assert [c for c in dlab.lab.agentcore.calls[len(calls) :] if c.startswith("Delete")] == []


def test_every_step_can_be_repeated(dlab: DeprovisionLab) -> None:
    dlab.retired()
    d = dlab.deprovisioner
    state = d.load({"agent_id": AGENT}, "retire-1")
    state = d.load({"agent_id": AGENT}, "retire-1")
    for step in (d.delete_endpoints, d.delete_harness):
        state = step(state)
        while not state["ready"]:
            state = step(state)
        assert step(state)["ready"] is True
    state = d.delete_role(d.delete_role(state))
    state = d.finish(state)
    assert d.finish(state)["deprovisioned"] is True
    assert dlab.harness() is None and not dlab.lab.role_exists()
    assert dlab.lab.agentcore.calls.count("DeleteHarness") == 1
    assert "provision_lock" not in dlab.lab.meta()


def test_a_second_execution_finishes_what_a_failed_one_left(dlab: DeprovisionLab) -> None:
    dlab.retired()
    dlab.lab.agentcore.polls_until_deleted = MAX_WAIT_ATTEMPTS + 5
    failed = dlab.run()
    assert (failed["failed_step"], failed["failure"]) == (
        "delete_endpoints",
        "endpoint_delete_timeout",
    )
    assert failed["marked"] is True
    assert dlab.events()[-1] == (EVENT_DEPROVISION, "rejected")
    rejected = dlab.firehose.records[-1]["detail"]
    assert rejected["failed_step"] == "delete_endpoints"
    assert rejected["failure"] == "endpoint_delete_timeout"
    assert "provision_lock" not in dlab.lab.meta()
    assert dlab.harness() is not None and dlab.lab.role_exists()

    dlab.lab.agentcore.polls_until_deleted = 1
    assert dlab.run(execution="retire-2")["deprovisioned"] is True
    assert dlab.harness() is None and not dlab.lab.role_exists()


def test_harness_that_does_not_go_away_gives_up(dlab: DeprovisionLab) -> None:
    dlab.retired()
    original = dlab.lab.agentcore.delete_harness

    def slow(**kwargs: Any) -> Any:
        dlab.lab.agentcore.polls_until_deleted = MAX_WAIT_ATTEMPTS + 5
        return original(**kwargs)

    dlab.lab.agentcore.delete_harness = slow  # type: ignore[method-assign]
    failed = dlab.run()
    assert (failed["failed_step"], failed["failure"]) == (
        "delete_harness",
        "harness_delete_timeout",
    )
    # The role is never deleted while the harness that runs with it exists.
    assert dlab.lab.role_exists()


def test_conflict_while_an_endpoint_is_going_away_is_waited_out(dlab: DeprovisionLab) -> None:
    """Lab: ``DeleteHarness`` answers ``ConflictException`` for minutes after the endpoint was
    deleted, even when it is no longer listed."""
    dlab.retired()
    conflicts = 3
    original = dlab.lab.agentcore.delete_harness

    def conflicting(**kwargs: Any) -> Any:
        nonlocal conflicts
        if conflicts:
            conflicts -= 1
            raise ClientError({"Error": {"Code": "ConflictException"}}, "DeleteHarness")
        return original(**kwargs)

    dlab.lab.agentcore.delete_harness = conflicting  # type: ignore[method-assign]
    assert dlab.run()["deprovisioned"] is True
    assert conflicts == 0


def test_nothing_is_reported_as_done_while_something_is_left(dlab: DeprovisionLab) -> None:
    dlab.retired()
    d = dlab.deprovisioner
    state = d.load({"agent_id": AGENT}, "retire-1")
    # The harness is still there: the role stays, and the removal is not finished.
    with pytest.raises(RetryableError, match="harness_remaining"):
        d.delete_role(state)
    with pytest.raises(RetryableError, match="resources_remaining"):
        d.finish(state)
    assert dlab.lab.role_exists()
    assert dlab.events() == [(EVENT_DEPROVISION, "requested")]
    assert _s(dlab.lab.meta(), "provision_lock") == "retire-1"


# --- What it refuses to delete -------------------------------------------------------------


def test_published_agent_is_never_deprovisioned(dlab: DeprovisionLab) -> None:
    dlab.publish()
    state = dlab.run()
    assert (state["failed_step"], state["failure"]) == ("load", "not_retired")
    assert state["marked"] is False
    assert dlab.harness() is not None and dlab.lab.role_exists()
    assert dlab.firehose.records == []
    assert "provision_lock" not in dlab.lab.meta()
    assert [c for c in dlab.lab.agentcore.calls if c.startswith(("Delete", "List"))] == []


def test_agent_published_again_meanwhile_stops_the_removal(dlab: DeprovisionLab) -> None:
    """Every step checks again: a state built for a retired agent deletes nothing if the
    table no longer says retired."""
    dlab.retired()
    d = dlab.deprovisioner
    state = d.load({"agent_id": AGENT}, "retire-1")
    dlab.lab.db.update_item(
        TableName=AGENTS_TABLE,
        Key=meta_key(AGENT),
        UpdateExpression="SET #s = :p",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":p": {"S": "published"}},
    )
    for step in (d.delete_endpoints, d.delete_harness, d.delete_role, d.finish):
        with pytest.raises(StepError, match="not_retired"):
            step(state)
    harness = dlab.harness()
    assert harness is not None and harness["endpoint"]["status"] == "READY"
    assert dlab.lab.role_exists()


def test_version_that_is_still_published_is_not_deprovisioned(dlab: DeprovisionLab) -> None:
    """``META`` says retired but the version the pointer names does not: not a retirement."""
    dlab.publish()
    dlab.lab.db.update_item(
        TableName=AGENTS_TABLE,
        Key=meta_key(AGENT),
        UpdateExpression="SET #s = :r",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":r": {"S": "retired"}},
    )
    state = dlab.run()
    assert (state["failed_step"], state["failure"]) == ("load", "version_not_retired")
    assert dlab.harness() is not None and dlab.lab.role_exists()
    assert dlab.events() == [(EVENT_DEPROVISION, "rejected")]
    assert "provision_lock" not in dlab.lab.meta()


def test_release_agent_keeps_its_resources(dlab: DeprovisionLab) -> None:
    dlab.retired(RELEASE)
    state = dlab.run(RELEASE)
    assert state["action"] == "noop" and state["reason"] == "release_agent"
    assert dlab.harness(RELEASE) is not None and dlab.lab.role_exists(RELEASE)
    assert dlab.firehose.records == []
    # Even with a state that says otherwise, no step touches it.
    forged = {"agent_id": RELEASE, "execution": "retire-1", "action": "deprovision"}
    for step in (
        dlab.deprovisioner.delete_endpoints,
        dlab.deprovisioner.delete_harness,
        dlab.deprovisioner.delete_role,
        dlab.deprovisioner.finish,
    ):
        with pytest.raises(StepError, match="release_agent"):
            step(forged)
    assert dlab.harness(RELEASE) is not None and dlab.lab.role_exists(RELEASE)


def test_only_the_retired_agent_is_touched(dlab: DeprovisionLab) -> None:
    dlab.retired()
    dlab.publish(OTHER)
    assert dlab.run()["deprovisioned"] is True
    assert dlab.harness() is None and not dlab.lab.role_exists()
    other = dlab.harness(OTHER)
    assert other is not None and other["endpoint"]["status"] == "READY"
    assert not other["deleting"]
    assert dlab.lab.role_exists(OTHER)
    assert dlab.lab.role_models(OTHER)


def test_unknown_agent(dlab: DeprovisionLab) -> None:
    state = dlab.run()
    assert (state["failed_step"], state["failure"]) == ("load", "agent_not_found")
    assert state["marked"] is False


@pytest.mark.parametrize(
    "bad",
    [
        None,
        "abcdefghijklmnop",
        {},
        {"agent_id": AGENT, "version": 1},
        {"agent_id": AGENT, "harness_id": "Mango_test_a_other-0000000001"},
        {"agent_id": "../etc"},
        {"agent_id": "platform"},
        {"agent_id": "Mango-test-Provisioner"},
        {"agent_id": 7},
    ],
)
def test_input_is_exactly_the_agent_id(bad: object) -> None:
    with pytest.raises(StepError, match="invalid_input"):
        parse_input(bad, "retire-1")


def test_execution_name_must_be_plain() -> None:
    for execution in (None, "", "a b", "x" * 81, "a/b"):
        with pytest.raises(StepError, match="invalid_input"):
            parse_input({"agent_id": AGENT}, execution)


# --- Roles -------------------------------------------------------------------------------


def test_every_inline_policy_goes_before_the_role(dlab: DeprovisionLab) -> None:
    dlab.retired()
    dlab.lab.iam.put_role_policy(
        RoleName=f"Mango-test-agent-{AGENT}",
        PolicyName="added-by-hand",
        PolicyDocument=json.dumps(
            {
                "Version": "2012-10-17",
                "Statement": [{"Effect": "Allow", "Action": "s3:ListBucket", "Resource": "*"}],
            }
        ),
    )
    assert dlab.run()["deprovisioned"] is True
    assert not dlab.lab.role_exists()


def test_role_without_the_boundary_is_left_alone_and_reported(dlab: DeprovisionLab) -> None:
    dlab.retired()
    dlab.lab.iam.delete_role_permissions_boundary(RoleName=f"Mango-test-agent-{AGENT}")
    state = dlab.run()
    assert (state["failed_step"], state["failure"]) == ("delete_role", "role_without_boundary")
    assert dlab.lab.role_exists()
    assert dlab.lab.role_models()
    assert dlab.harness() is None
    assert dlab.events()[-1] == (EVENT_DEPROVISION, "rejected")


def test_role_with_a_managed_policy_is_not_detached_by_the_deprovisioner(
    dlab: DeprovisionLab,
) -> None:
    dlab.retired()
    dlab.lab.iam.attach_role_policy(RoleName=f"Mango-test-agent-{AGENT}", PolicyArn=BOUNDARY_ARN)
    state = dlab.run()
    assert state["failed_step"] == "delete_role"
    assert state["failure"] == "DeleteRole:DeleteConflict"
    assert dlab.lab.role_exists()


def test_role_that_is_already_gone_is_fine(dlab: DeprovisionLab) -> None:
    dlab.retired()
    name = f"Mango-test-agent-{AGENT}"
    dlab.lab.iam.delete_role_policy(RoleName=name, PolicyName="agent")
    dlab.lab.iam.delete_role(RoleName=name)
    assert dlab.run()["deprovisioned"] is True
    assert dlab.harness() is None


# --- Lock, audit and errors -----------------------------------------------------------------


def test_running_publication_makes_the_removal_wait(dlab: DeprovisionLab) -> None:
    dlab.retired()
    dlab.lab.store.acquire_lock(AGENT, "pub-2", dlab.lab.now)
    with pytest.raises(RetryableError, match="busy"):
        dlab.deprovisioner.load({"agent_id": AGENT}, "retire-1")
    assert dlab.firehose.records == []
    assert dlab.harness() is not None and dlab.lab.role_exists()
    assert _s(dlab.lab.meta(), "provision_lock") == "pub-2"

    dlab.lab.store.release_lock(AGENT, "pub-2")
    assert dlab.run()["deprovisioned"] is True


def test_step_without_the_lock_deletes_nothing(dlab: DeprovisionLab) -> None:
    dlab.retired()
    dlab.lab.store.acquire_lock(AGENT, "someone-else", dlab.lab.now)
    state = {"agent_id": AGENT, "execution": "retire-1", "action": "deprovision"}
    for step in (
        dlab.deprovisioner.delete_endpoints,
        dlab.deprovisioner.delete_harness,
        dlab.deprovisioner.delete_role,
        dlab.deprovisioner.finish,
    ):
        with pytest.raises(BusyError):
            step(state)
    assert dlab.harness() is not None and dlab.lab.role_exists()
    # Not its lock: the failure path neither audits nor releases it.
    marked = dlab.deprovisioner.mark_failed({**state, "error": {"Error": "X"}})
    assert marked["marked"] is False
    assert _s(dlab.lab.meta(), "provision_lock") == "someone-else"


def test_every_step_extends_the_lock(dlab: DeprovisionLab) -> None:
    dlab.retired()
    d = dlab.deprovisioner
    state = d.load({"agent_id": AGENT}, "retire-1")
    first = int(dlab.lab.meta()["provision_lock_until"]["N"])
    assert first == int((dlab.lab.now + LOCK_TTL).timestamp())
    dlab.lab.now += timedelta(minutes=20)
    d.delete_endpoints(state)
    assert int(dlab.lab.meta()["provision_lock_until"]["N"]) == first + 20 * 60


def test_audit_failure_stops_the_removal_before_anything_is_deleted(dlab: DeprovisionLab) -> None:
    dlab.retired()
    dlab.firehose.fail = True
    with pytest.raises(StepError, match="Audit:ServiceUnavailableException") as raised:
        dlab.deprovisioner.load({"agent_id": AGENT}, "retire-1")
    assert isinstance(raised.value, RetryableError)
    assert dlab.harness() is not None and dlab.lab.role_exists()
    assert [c for c in dlab.lab.agentcore.calls if c.startswith("Delete")] == []


def test_removal_is_not_reported_as_applied_without_its_audit_record(
    dlab: DeprovisionLab,
) -> None:
    dlab.retired()
    d = dlab.deprovisioner
    state = d.load({"agent_id": AGENT}, "retire-1")
    for step in (d.delete_endpoints, d.delete_harness):
        state = step(state)
        while not state["ready"]:
            state = step(state)
    state = d.delete_role(state)
    dlab.firehose.fail = True
    with pytest.raises(StepError, match="Audit:"):
        d.finish(state)
    # Still holding the agent: the retry writes the record and only then lets go.
    assert _s(dlab.lab.meta(), "provision_lock") == "retire-1"
    dlab.firehose.fail = False
    assert d.finish(state)["deprovisioned"] is True
    assert dlab.events() == [(EVENT_DEPROVISION, "requested"), (EVENT_DEPROVISION, "applied")]
    assert "provision_lock" not in dlab.lab.meta()


def test_aws_messages_never_reach_the_error(dlab: DeprovisionLab) -> None:
    dlab.retired()
    dlab.lab.agentcore.fail_next["DeleteHarnessEndpoint"] = ClientError(
        {"Error": {"Code": "AccessDeniedException", "Message": "arn:aws:secret SECRET-ARN"}},
        "DeleteHarnessEndpoint",
    )
    state = dlab.run()
    assert state["failure"] == "DeleteHarnessEndpoint:AccessDeniedException"
    assert "SECRET-ARN" not in json.dumps(state)
    assert "SECRET-ARN" not in json.dumps(dlab.firehose.records)


def test_transient_aws_errors_are_retryable(dlab: DeprovisionLab) -> None:
    dlab.retired()
    state = dlab.deprovisioner.load({"agent_id": AGENT}, "retire-1")
    dlab.lab.agentcore.fail_next["ListHarnesses"] = ClientError(
        {"Error": {"Code": "ThrottlingException"}}, "ListHarnesses"
    )
    with pytest.raises(RetryableError, match="ListHarnesses:ThrottlingException"):
        dlab.deprovisioner.delete_endpoints(state)


# --- No agent content ---------------------------------------------------------------------


def test_no_definition_is_read_logged_or_audited(
    dlab: DeprovisionLab, caplog: pytest.LogCaptureFixture
) -> None:
    dlab.retired()
    with caplog.at_level(logging.INFO):
        events = [{"step": "load", "state": {"agent_id": AGENT}, "execution": "retire-1"}]
        state = handler.handle(events[0], dlab.deprovisioner)
        for step in ("delete_endpoints", "delete_harness"):
            state = handler.handle(
                {"step": step, "state": state, "execution": "retire-1"}, dlab.deprovisioner
            )
            while not state["ready"]:
                state = handler.handle(
                    {"step": step, "state": state, "execution": "retire-1"}, dlab.deprovisioner
                )
        for step in ("delete_role", "finish"):
            state = handler.handle(
                {"step": step, "state": state, "execution": "retire-1"}, dlab.deprovisioner
            )
    assert state["deprovisioned"] is True

    reads = [kwargs for name, kwargs in dlab.db.calls if name == "get_item"]
    assert reads
    for kwargs in reads:
        projected = {
            kwargs["ExpressionAttributeNames"][n.strip()]
            for n in kwargs["ProjectionExpression"].split(",")
        }
        assert projected == set(READ_ATTRIBUTES)
        assert kwargs["ConsistentRead"] is True
    assert "definition" not in READ_ATTRIBUTES
    # The only writes are the lock.
    for name, kwargs in dlab.db.calls:
        assert name in {"get_item", "update_item"}
        if name == "update_item":
            assert "provision_lock" in kwargs["UpdateExpression"]
            assert "status" not in kwargs["UpdateExpression"]
    for text in (json.dumps(state), caplog.text, json.dumps(dlab.firehose.records)):
        assert PROMPT not in text
        assert "SECRET-PROMPT-MARKER" not in text


# --- Handler ------------------------------------------------------------------------------


def test_handler_takes_the_execution_name_from_the_context_not_the_state(
    dlab: DeprovisionLab,
) -> None:
    dlab.retired()
    state = handler.handle(
        {"step": "load", "state": {"agent_id": AGENT}, "execution": "retire-1"}, dlab.deprovisioner
    )
    assert state["execution"] == "retire-1" and state["last_step"] == "load"
    # A state that claims another owner does not make the step act for it.
    forged = {**state, "execution": "someone-else"}
    out = handler.handle(
        {"step": "delete_endpoints", "state": forged, "execution": "retire-1"}, dlab.deprovisioner
    )
    assert out["execution"] == "retire-1"


def test_handler_reports_retryable_errors_with_their_own_type(dlab: DeprovisionLab) -> None:
    dlab.retired()
    dlab.lab.store.acquire_lock(AGENT, "pub-2", dlab.lab.now)
    with pytest.raises(handler.RetryableStepError) as raised:
        handler.handle(
            {"step": "load", "state": {"agent_id": AGENT}, "execution": "retire-1"},
            dlab.deprovisioner,
        )
    assert json.loads(str(raised.value)) == {"step": "load", "code": "busy"}
    with pytest.raises(handler.ProvisionerStepError) as failed:
        handler.handle(
            {"step": "load", "state": {"agent_id": "nope", "x": 1}, "execution": "retire-1"},
            dlab.deprovisioner,
        )
    assert json.loads(str(failed.value)) == {"step": "load", "code": "invalid_input"}


@pytest.mark.parametrize(
    "event", [None, {}, {"step": "publish"}, {"step": "compensate"}, {"step": 3}]
)
def test_handler_rejects_unknown_steps(dlab: DeprovisionLab, event: object) -> None:
    with pytest.raises(handler.ProvisionerStepError, match="invalid_step"):
        handler.handle(event, dlab.deprovisioner)


# --- Settings -----------------------------------------------------------------------------


def test_names_are_the_ones_the_provisioner_creates(dlab: DeprovisionLab) -> None:
    ours, theirs = dlab.settings, dlab.lab.settings
    for agent_id in (AGENT, RELEASE):
        assert ours.role_name(agent_id) == theirs.role_name(agent_id)
        assert ours.harness_name(agent_id) == theirs.harness_name(agent_id)
        assert ours.harness_id_pattern(agent_id) == theirs.harness_id_pattern(agent_id)
    assert ours.harness_arn("x") == theirs.harness_arn("x")
    assert ours.boundary_arn == theirs.boundary_arn == BOUNDARY_ARN
    assert ours.release_agents == frozenset({RELEASE})


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("MANGO_NAMESPACE", "Not Valid"),
        ("MANGO_ACCOUNT_ID", "12"),
        ("AWS_REGION", "nowhere"),
        ("AGENT_BOUNDARY_ARN", "arn:aws:iam::123456789012:policy/Other"),
        ("RELEASE_AGENTS", "not json"),
        ("RELEASE_AGENTS", '{"finops": "nothash"}'),
        ("RELEASE_AGENTS", "[]"),
        ("AGENTS_TABLE", None),
    ],
)
def test_settings_reject_an_environment_the_stack_would_not_set(
    name: str, value: str | None
) -> None:
    env = {k: v for k, v in DEPROVISION_ENV.items() if k != name}
    if value is not None:
        env[name] = value
    with pytest.raises(ConfigError):
        DeprovisionSettings.from_env(env)
