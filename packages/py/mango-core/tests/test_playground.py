from typing import Any

import pytest

from mango_core.playground import (
    PlaygroundHarness,
    is_provision_input,
    parse_provision_input,
    provision_input,
)

ARN = "arn:aws:bedrock-agentcore:us-east-1:111122223333:harness/Mango_poc_a_playground-AbCdE12345"


@pytest.mark.parametrize("release", ["v0.1.0-g1a2b3c4", "v0.0.0-unpublished", "models-1793000000"])
def test_the_input_names_the_action_and_what_started_it(release: str) -> None:
    raw = provision_input(release)
    assert raw == {"playground": "ensure", "release": release}
    assert is_provision_input(raw)
    assert parse_provision_input(raw) == release


@pytest.mark.parametrize(
    "raw",
    [
        {"playground": "ensure"},
        {"playground": "ensure", "release": "../x"},
        {"playground": "ensure", "release": "v1.0.0", "extra": 1},
        {"playground": "remove", "release": "v1.0.0"},
        {"playground": "ensure", "release": 1},
    ],
)
def test_anything_else_is_refused(raw: dict[str, Any]) -> None:
    with pytest.raises(ValueError, match="invalid"):
        parse_provision_input(raw)


def test_an_agent_input_is_not_a_playground_input() -> None:
    assert not is_provision_input({"agent_id": "abcdefghijklmnop", "version": 1})


def test_the_item_round_trips_with_sorted_unique_models() -> None:
    deployed = PlaygroundHarness(ARN, "3", ("b.model", "a.model"), "2026-10-25T10:00:00+00:00")
    back = PlaygroundHarness.from_item(deployed.item())
    assert back == PlaygroundHarness(ARN, "3", ("a.model", "b.model"), deployed.updated_at)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("harness_arn", {"S": "arn:aws:iam::111122223333:role/x"}),
        ("harness_version", {"S": "latest"}),
        ("models", {"S": '["bad model id"]'}),
        ("models", {"S": "not json"}),
    ],
)
def test_an_item_out_of_layout_fails_closed(field: str, value: dict[str, str]) -> None:
    item = PlaygroundHarness(ARN, "1", ("a.model",), "now").item()
    with pytest.raises(ValueError, match="invalid"):
        PlaygroundHarness.from_item({**item, field: value})


def test_whether_the_role_reads_skills_round_trips_and_defaults_to_no() -> None:
    deployed = PlaygroundHarness(ARN, "1", ("a.model",), "now", skills=True)
    assert PlaygroundHarness.from_item(deployed.item()).skills is True
    item = deployed.item()
    del item["skills"]
    # Written before D91 (12): the role did not read skills.
    assert PlaygroundHarness.from_item(item).skills is False
