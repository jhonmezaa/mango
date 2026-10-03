"""Starting the provisioner: identifiers and the approved hash only (TM-M1, TM-M2)."""

from __future__ import annotations

import json
from typing import Any

import pytest
from botocore.exceptions import ClientError

from mango_api.provisioner import (
    DeprovisionerClient,
    PackProvisionerClient,
    ProvisionerClient,
    ProvisionerError,
)

ARN = "arn:aws:states:us-east-1:111111111111:stateMachine:Mango-test-AgentProvisioner"
AGENT = "abcdefghijklmnop"
HASH = "a" * 64


class FakeStepFunctions:
    def __init__(self, error: str | None = None) -> None:
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def start_execution(self, **kwargs: Any) -> dict[str, Any]:
        if self.error:
            raise ClientError({"Error": {"Code": self.error}}, "StartExecution")
        self.calls.append(kwargs)
        return {"executionArn": "arn:execution"}


def test_the_input_is_exactly_the_three_identifiers() -> None:
    sfn = FakeStepFunctions()
    name = ProvisionerClient(sfn, ARN).start(AGENT, 3, HASH)  # type: ignore[arg-type]
    (call,) = sfn.calls
    assert set(call) == {"stateMachineArn", "name", "input"}
    assert call["stateMachineArn"] == ARN
    assert json.loads(call["input"]) == {"agent_id": AGENT, "version": 3, "content_hash": HASH}
    assert call["name"] == name
    assert name.startswith(f"{AGENT}-v3-{HASH[:12]}-") and len(name) <= 80


def test_every_start_gets_a_new_execution_name() -> None:
    sfn = FakeStepFunctions()
    client = ProvisionerClient(sfn, ARN)  # type: ignore[arg-type]
    assert client.start(AGENT, 1, HASH) != client.start(AGENT, 1, HASH)


@pytest.mark.parametrize(
    ("agent_id", "version", "content_hash"),
    [
        ("Not-An-Id", 1, HASH),
        ("platform", 1, HASH),
        (AGENT, 0, HASH),
        (AGENT, 1_000_000, HASH),
        (AGENT, 1, "abc"),
        (AGENT, 1, "A" * 64),
        (AGENT, 1, HASH + '","role":"x'),
    ],
)
def test_invalid_input_never_reaches_step_functions(
    agent_id: str, version: int, content_hash: str
) -> None:
    sfn = FakeStepFunctions()
    with pytest.raises(ValueError, match="invalid provisioner input"):
        ProvisionerClient(sfn, ARN).start(agent_id, version, content_hash)  # type: ignore[arg-type]
    assert sfn.calls == []


def test_a_failed_start_is_reported_without_details() -> None:
    client = ProvisionerClient(FakeStepFunctions("AccessDeniedException"), ARN)  # type: ignore[arg-type]
    with pytest.raises(ProvisionerError) as raised:
        client.start(AGENT, 1, HASH)
    assert "AccessDenied" not in str(raised.value)


@pytest.mark.parametrize(
    "arn",
    [
        "",
        "arn:aws:states:us-east-1:111111111111:stateMachine:*",
        "arn:aws:lambda:us-east-1:111111111111:function:x",
        "arn:aws:states:us-east-1:111111111111:execution:Mango-test-AgentProvisioner:x",
    ],
)
def test_only_one_concrete_state_machine_is_accepted(arn: str) -> None:
    with pytest.raises(ValueError, match="invalid provisioner state machine ARN"):
        ProvisionerClient(FakeStepFunctions(), arn)  # type: ignore[arg-type]


# --- Pack provisioner -----------------------------------------------------------------------

PACK_ARN = "arn:aws:states:us-east-1:111111111111:stateMachine:Mango-test-PackProvisioner"
PACK = "aws-pricing"
ENABLEMENT = "0123456789abcdef0123456789abcdef"


def test_the_pack_input_is_exactly_the_three_identifiers() -> None:
    sfn = FakeStepFunctions()
    client = PackProvisionerClient(sfn, PACK_ARN)  # type: ignore[arg-type]
    name = client.start(PACK, "1.1.1-1", ENABLEMENT)
    (call,) = sfn.calls
    assert set(call) == {"stateMachineArn", "name", "input"}
    assert call["stateMachineArn"] == PACK_ARN
    assert json.loads(call["input"]) == {
        "pack_id": PACK,
        "pack_version": "1.1.1-1",
        "enablement_id": ENABLEMENT,
    }
    # The provisioner derives names from it: plain characters, at most 80.
    assert call["name"] == name and name.startswith("aws-pricing-1_1_1-1-")
    assert len(client.start("a" * 24, "1234.1234.1234.1234-9999", "e" * 64)) <= 80
    assert client.start(PACK, "1.1.1-1", ENABLEMENT) != name


@pytest.mark.parametrize(
    ("pack_id", "version", "enablement_id"),
    [
        ("Not_A_Pack", "1.1.1-1", ENABLEMENT),
        ("a" * 25, "1.1.1-1", ENABLEMENT),
        (PACK, "latest", ENABLEMENT),
        (PACK, "1.1.1", ENABLEMENT),
        (PACK, "1.1.1-1", "short"),
        (PACK, "1.1.1-1", ENABLEMENT + '","role":"x'),
    ],
)
def test_invalid_pack_input_never_reaches_step_functions(
    pack_id: str, version: str, enablement_id: str
) -> None:
    sfn = FakeStepFunctions()
    with pytest.raises(ValueError, match="invalid pack provisioner input"):
        PackProvisionerClient(sfn, PACK_ARN).start(  # type: ignore[arg-type]
            pack_id, version, enablement_id
        )
    assert sfn.calls == []


def test_pack_start_failures_are_one_error_and_the_arn_is_checked() -> None:
    sfn = FakeStepFunctions(error="ThrottlingException")
    with pytest.raises(ProvisionerError):
        PackProvisionerClient(sfn, PACK_ARN).start(  # type: ignore[arg-type]
            PACK, "1.1.1-1", ENABLEMENT
        )
    with pytest.raises(ValueError, match="invalid pack provisioner state machine ARN"):
        PackProvisionerClient(sfn, "arn:aws:lambda:us-east-1:1:function:x")  # type: ignore[arg-type]


# --- Deprovisioner (D48) -----------------------------------------------------------------

DEPROVISIONER_ARN = (
    "arn:aws:states:us-east-1:111111111111:stateMachine:Mango-test-AgentDeprovisioner"
)


def test_the_deprovisioner_input_is_exactly_the_agent_id() -> None:
    sfn = FakeStepFunctions()
    client = DeprovisionerClient(sfn, DEPROVISIONER_ARN)  # type: ignore[arg-type]
    name = client.start(AGENT)
    (call,) = sfn.calls
    assert set(call) == {"stateMachineArn", "name", "input"}
    assert call["stateMachineArn"] == DEPROVISIONER_ARN
    assert json.loads(call["input"]) == {"agent_id": AGENT}
    assert call["name"] == name
    assert name.startswith(f"{AGENT}-retire-") and len(name) <= 80
    assert client.start(AGENT) != name


@pytest.mark.parametrize(
    "agent_id", ["Not-An-Id", "platform", "", "abc/../x", AGENT + '","x":"y', "a" * 17]
)
def test_an_invalid_agent_id_never_reaches_the_deprovisioner(agent_id: str) -> None:
    sfn = FakeStepFunctions()
    with pytest.raises(ValueError, match="invalid deprovisioner input"):
        DeprovisionerClient(sfn, DEPROVISIONER_ARN).start(agent_id)  # type: ignore[arg-type]
    assert sfn.calls == []


def test_a_failed_deprovisioner_start_is_reported_without_details() -> None:
    client = DeprovisionerClient(FakeStepFunctions("AccessDeniedException"), DEPROVISIONER_ARN)  # type: ignore[arg-type]
    with pytest.raises(ProvisionerError) as raised:
        client.start(AGENT)
    assert "AccessDenied" not in str(raised.value)


def test_the_deprovisioner_arn_must_be_a_state_machine() -> None:
    for arn in ("", "arn:aws:lambda:us-east-1:111111111111:function:x"):
        with pytest.raises(ValueError, match="invalid deprovisioner state machine ARN"):
            DeprovisionerClient(FakeStepFunctions(), arn)  # type: ignore[arg-type]


class ListingStepFunctions:
    def __init__(self, pages: list[list[tuple[str, str]]], error: str | None = None) -> None:
        self.pages, self.error = pages, error
        self.calls: list[dict[str, Any]] = []

    def list_executions(self, **kwargs: Any) -> dict[str, Any]:
        if self.error:
            raise ClientError({"Error": {"Code": self.error}}, "ListExecutions")
        self.calls.append(kwargs)
        index = int(kwargs.get("nextToken", "0"))
        page: dict[str, Any] = {
            "executions": [{"name": n, "status": s} for n, s in self.pages[index]]
        }
        if index + 1 < len(self.pages):
            page["nextToken"] = str(index + 1)
        return page


def test_removals_are_read_by_name_and_status_newest_first() -> None:
    other = "bcdefghijklmnopa"
    sfn = ListingStepFunctions(
        [
            [
                (f"{AGENT}-retire-0a1b2c3d", "SUCCEEDED"),
                (f"{AGENT}-retire-ffffffff", "FAILED"),  # older: replaced by the retry above
                (f"{other}-retire-00000000", "RUNNING"),
                ("finops-retire-11111111", "ABORTED"),
                ("9d2c1a7e-1111-4222-8333-444455556666", "FAILED"),  # not named by this API
                ("Not-An-Id-retire-22222222", "FAILED"),
                (f"{AGENT}-retire-bad/suffix", "FAILED"),
                ("zzzzzzzzzzzzzzzz-retire-33333333", "SOMETHING_NEW"),
            ]
        ]
    )
    client = DeprovisionerClient(sfn, DEPROVISIONER_ARN)  # type: ignore[arg-type]
    removals = client.cleanups()
    assert removals.by_agent == {AGENT: "done", other: "running", "finops": "failed"}
    assert removals.complete
    (call,) = sfn.calls
    # Names and statuses of this state machine only: no execution is described.
    assert call == {"stateMachineArn": DEPROVISIONER_ARN, "maxResults": 1000}


def test_the_listing_is_bounded_and_cached() -> None:
    now = [0.0]
    pages = [[(f"{AGENT}-retire-0000000{i}", "RUNNING")] for i in range(5)]
    sfn = ListingStepFunctions(pages)
    client = DeprovisionerClient(sfn, DEPROVISIONER_ARN, clock=lambda: now[0])  # type: ignore[arg-type]
    assert not client.cleanups().complete
    assert len(sfn.calls) == 2
    client.cleanups()
    assert len(sfn.calls) == 2
    now[0] += 16
    client.cleanups()
    assert len(sfn.calls) == 4


def test_removals_that_cannot_be_read_are_reported_without_details() -> None:
    sfn = ListingStepFunctions([], "AccessDeniedException")
    client = DeprovisionerClient(sfn, DEPROVISIONER_ARN)  # type: ignore[arg-type]
    with pytest.raises(ProvisionerError) as raised:
        client.cleanups()
    assert "AccessDenied" not in str(raised.value)
