"""A new release and the agents it ships, in an installation that already has them (D34, D80)."""

from __future__ import annotations

import json
import logging
from typing import Any

import pytest

from mango_core.agents import AgentDefinition, content_hash, dumps_definition
from mango_core.agents_table import meta_key, release_key, version_key
from mango_provisioner import handler
from mango_provisioner.errors import StepError
from mango_provisioner.release import parse_release_input

from .conftest import AGENTS_TABLE, DISABLED_MODEL, Lab, release_definition

AGENT = "finops"
RELEASE = "0.1.0"
APPROVER = f"release@{RELEASE}"
SEEDED_AT = "2026-10-01T00:00:00+00:00"
NEW_PROMPT = "You are FinOps, now with cost anomaly investigations. NEW-PROMPT-MARKER"


def _seed_first_version(lab: Lab, definition: AgentDefinition) -> str:
    """The items the stack writes on its first deployment (`release-agents.ts`)."""
    canonical = dumps_definition(definition)
    digest = content_hash(canonical)
    at = {"S": SEEDED_AT}
    one = {"N": "1"}
    lab.db.put_item(
        TableName=AGENTS_TABLE,
        Item={
            **meta_key(AGENT),
            "agent_id": {"S": AGENT},
            "status": {"S": "draft"},
            "version": one,
            "latest_version": one,
            "open_version": one,
            "created_by": {"S": APPROVER},
            "created_at": at,
            "updated_at": at,
        },
    )
    lab.db.put_item(
        TableName=AGENTS_TABLE,
        Item={
            **version_key(AGENT, 1),
            "agent_id": {"S": AGENT},
            "n": one,
            "status": {"S": "approved"},
            "status_index": {"S": "VERSION#approved"},
            "status_at": at,
            "revision": one,
            "definition": {"S": canonical},
            "content_hash": {"S": digest},
            "created_by": {"S": APPROVER},
            "editors": {"SS": [APPROVER]},
            "created_at": at,
            "updated_at": at,
            "submitted_by": {"S": APPROVER},
            "submitted_at": at,
            "approved_by": {"S": APPROVER},
            "approved_at": at,
        },
    )
    return _seed_release_definition(lab, canonical)


def _seed_release_definition(lab: Lab, canonical: str) -> str:
    """The definition the stack ships, written put-if-absent on every deployment."""
    digest = content_hash(canonical)
    lab.db.put_item(
        TableName=AGENTS_TABLE,
        Item={
            **release_key(AGENT, digest),
            "agent_id": {"S": AGENT},
            "definition": {"S": canonical},
            "content_hash": {"S": digest},
            "created_at": {"S": SEEDED_AT},
        },
    )
    return digest


def _release(digest: str) -> dict[str, Any]:
    """The execution input the stack starts on every deployment that changes the agent."""
    return {"agent_id": AGENT, "content_hash": digest, "release": RELEASE}


def _installed(lab: Lab) -> str:
    """An installation whose release agent serves version 1, as the release seeded it."""
    digest = _seed_first_version(lab, release_definition())
    lab.ship({AGENT: digest})
    assert lab.run(_release(digest), "install")["published"] is True
    lab.firehose.records.clear()
    lab.agentcore.calls.clear()
    return digest


def _new_release(lab: Lab, definition: AgentDefinition | None = None) -> str:
    """The stack of a later release: it seeds its definition and ships its hash."""
    canonical = dumps_definition(definition or release_definition(system_prompt=NEW_PROMPT))
    digest = _seed_release_definition(lab, canonical)
    lab.ship({AGENT: digest})
    return digest


def _person_version(lab: Lab, number: int, *, status: str, created_by: str = "user-1") -> None:
    """A version mango-api wrote for a person (D18), and the agent's pointers to it."""
    canonical = dumps_definition(release_definition(system_prompt="Changed in the installation."))
    lab.db.put_item(
        TableName=AGENTS_TABLE,
        Item={
            **version_key(AGENT, number),
            "agent_id": {"S": AGENT},
            "n": {"N": str(number)},
            "status": {"S": status},
            "revision": {"N": "1"},
            "definition": {"S": canonical},
            "created_by": {"S": created_by},
            "editors": {"SS": [created_by]},
        },
    )
    lab.db.update_item(
        TableName=AGENTS_TABLE,
        Key=meta_key(AGENT),
        UpdateExpression="SET latest_version = :n, open_version = :n ADD version :one",
        ExpressionAttributeValues={":n": {"N": str(number)}, ":one": {"N": "1"}},
    )


def _events(lab: Lab, name: str) -> list[dict[str, Any]]:
    return [r["detail"] for r in lab.firehose.records if r["event"] == name]


def _version_items(lab: Lab) -> list[dict[str, Any]]:
    items = lab.db.query(
        TableName=AGENTS_TABLE,
        KeyConditionExpression="PK = :pk AND begins_with(SK, :v)",
        ExpressionAttributeValues={":pk": {"S": f"AGENT#{AGENT}"}, ":v": {"S": "VERSION#"}},
    )["Items"]
    return list(items)


def _succeeded(result: dict[str, Any]) -> bool:
    """The state machine ends in ``Succeeded``: published, or nothing to do."""
    return "failure" not in result and (result.get("published") or result["action"] == "noop")


# --- First installation -------------------------------------------------------------------


def test_first_installation_publishes_the_seeded_version(lab: Lab) -> None:
    digest = _seed_first_version(lab, release_definition())
    lab.ship({AGENT: digest})
    result = lab.run(_release(digest))
    assert result["published"] is True
    assert result["version"] == 1
    assert lab.version(1, AGENT)["status"]["S"] == "published"
    # The seed is the version: the release adds nothing of its own on a first installation.
    assert _events(lab, "agent.release.update") == []
    published = _events(lab, "agent.version.published")
    assert [e["outcome"] for e in published] == ["requested", "applied"]
    assert published[-1]["approved_by"] == APPROVER


# --- Case 1: the release ships other content and nobody changed the agent ------------------


def test_new_content_becomes_the_next_version_approved_by_the_release(lab: Lab) -> None:
    old = _installed(lab)
    digest = _new_release(lab)
    result = lab.run(_release(digest), "update")
    assert _succeeded(result)
    assert result["version"] == 2
    v2 = lab.version(2, AGENT)
    assert v2["status"]["S"] == "published"
    assert v2["content_hash"]["S"] == digest
    assert {v2["created_by"]["S"], v2["approved_by"]["S"], v2["submitted_by"]["S"]} == {APPROVER}
    assert v2["editors"]["SS"] == [APPROVER]
    assert v2["base_version"]["N"] == "1"
    assert content_hash(v2["definition"]["S"]) == digest
    # Version 1 is history, untouched apart from its status.
    v1 = lab.version(1, AGENT)
    assert (v1["status"]["S"], v1["content_hash"]["S"]) == ("superseded", old)
    meta = lab.meta(AGENT)
    assert (meta["latest_version"]["N"], meta["published_version"]["N"]) == ("2", "2")
    assert "open_version" not in meta and "provision_lock" not in meta
    # The same harness gets a new version with the new instruction.
    assert lab.agentcore.calls.count("CreateHarness") == 0
    assert "NEW-PROMPT-MARKER" in json.dumps(lab.agentcore.only())
    (update,) = _events(lab, "agent.release.update")
    assert update == {
        "agent": AGENT,
        "content_hash": digest,
        "outcome": "applied",
        "approved_by": APPROVER,
        "execution": "update",
        "version": 2,
        "previous_version": 1,
    }
    assert [e["outcome"] for e in _events(lab, "agent.version.published")] == [
        "requested",
        "applied",
    ]


def test_each_later_release_adds_one_more_version(lab: Lab) -> None:
    _installed(lab)
    assert _succeeded(lab.run(_release(_new_release(lab)), "update-1"))
    third = _new_release(lab, release_definition(system_prompt="Third release."))
    assert lab.run(_release(third), "update-2")["version"] == 3
    assert lab.meta(AGENT)["published_version"]["N"] == "3"
    assert [lab.version(n, AGENT)["status"]["S"] for n in (1, 2, 3)] == [
        "superseded",
        "superseded",
        "published",
    ]


def test_a_repeated_load_publishes_the_version_it_already_added(lab: Lab) -> None:
    # Step Functions retries `load` after a transient error that came after the write.
    _installed(lab)
    digest = _new_release(lab)
    first = lab.provisioner.load(_release(digest), "update")
    assert first["version"] == 2
    again = lab.provisioner.load(_release(digest), "update")
    assert (again["action"], again["version"]) == ("publish", 2)
    assert len(_version_items(lab)) == 2
    assert len(_events(lab, "agent.release.update")) == 1


# --- Case 2: the installation changed the agent (D18) --------------------------------------


@pytest.mark.parametrize(
    "change",
    [
        "published_by_a_person",
        "open_draft_of_a_person",
        "release_version_edited_by_a_person",
    ],
)
def test_an_agent_the_installation_changed_is_left_alone(lab: Lab, change: str) -> None:
    _installed(lab)
    if change == "published_by_a_person":
        person = lab.approve(
            release_definition(system_prompt="Changed in the installation."),
            agent_id=AGENT,
            version=2,
        )
        assert lab.run(person, "d18")["published"] is True
        lab.firehose.records.clear()
    elif change == "open_draft_of_a_person":
        _person_version(lab, 2, status="draft")
    else:
        lab.db.update_item(
            TableName=AGENTS_TABLE,
            Key=version_key(AGENT, 1),
            UpdateExpression="ADD editors :p",
            ExpressionAttributeValues={":p": {"SS": ["user-1"]}},
        )
    before = _version_items(lab)
    calls = list(lab.agentcore.calls)
    digest = _new_release(lab)
    result = lab.run(_release(digest), "update")
    # No failure, so no alarm: the execution ends in `NothingToDo`.
    assert _succeeded(result)
    assert (result["action"], result["release_update"]) == ("noop", "skipped")
    assert result["reason"] == "changed_in_installation"
    assert _version_items(lab) == before
    assert lab.agentcore.calls == calls
    assert "provision_lock" not in lab.meta(AGENT)
    (skipped,) = _events(lab, "agent.release.update")
    assert skipped["outcome"] == "skipped"
    assert skipped["reason"] == "changed_in_installation"
    assert skipped["content_hash"] == digest
    assert _events(lab, "agent.version.published") == []


def test_a_retired_release_agent_is_left_alone(lab: Lab) -> None:
    _installed(lab)
    lab.db.update_item(
        TableName=AGENTS_TABLE,
        Key=meta_key(AGENT),
        UpdateExpression="SET #s = :r",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":r": {"S": "retired"}},
    )
    result = lab.run(_release(_new_release(lab)), "update")
    assert _succeeded(result)
    assert result["reason"] == "agent_retired"
    assert len(_version_items(lab)) == 1
    assert _events(lab, "agent.release.update")[0]["reason"] == "agent_retired"


def test_an_open_version_of_the_release_with_other_content_is_left_alone(lab: Lab) -> None:
    # A previous release update whose publication failed: an admin retries or discards it.
    _installed(lab)
    failed = _new_release(lab, release_definition(model=DISABLED_MODEL, allowed_models=[]))
    assert lab.run(_release(failed), "update-1")["failure"] == "model_not_enabled"
    assert lab.version(2, AGENT)["status"]["S"] == "failed"
    lab.firehose.records.clear()
    result = lab.run(_release(_new_release(lab)), "update-2")
    assert _succeeded(result)
    assert result["reason"] == "version_open"
    assert len(_version_items(lab)) == 2


def test_a_person_who_opens_a_draft_meanwhile_wins(lab: Lab, monkeypatch: Any) -> None:
    _installed(lab)
    digest = _new_release(lab)
    add = lab.store.add_release_version

    def racing(**kwargs: Any) -> bool:
        # A person opens a draft between the decision and the write.
        _person_version(lab, 2, status="draft")
        return add(**kwargs)

    monkeypatch.setattr(lab.store, "add_release_version", racing)
    result = lab.run(_release(digest), "update")
    assert _succeeded(result)
    assert result["reason"] == "changed_in_installation"
    assert lab.version(2, AGENT)["created_by"]["S"] == "user-1"
    assert "provision_lock" not in lab.meta(AGENT)


# --- Case 3: the release ships the same content --------------------------------------------


def test_the_same_content_changes_nothing(lab: Lab) -> None:
    digest = _installed(lab)
    meta = lab.meta(AGENT)
    result = lab.run(_release(digest), "again")
    assert _succeeded(result)
    assert (result["action"], result["release_update"], result["version"]) == (
        "noop",
        "unchanged",
        1,
    )
    assert lab.meta(AGENT) == meta
    assert len(_version_items(lab)) == 1
    assert lab.firehose.records == []
    assert lab.agentcore.calls == []


# --- Guarantees that do not change (TM-M2, TM-M16) -----------------------------------------


@pytest.mark.parametrize(
    "shipped",
    [
        {},  # the release ships no such agent
        {AGENT: "0" * 64},  # the release ships other content under that id
    ],
)
def test_a_hash_the_stack_does_not_ship_is_refused_before_anything_happens(
    lab: Lab, shipped: dict[str, str]
) -> None:
    _installed(lab)
    digest = _new_release(lab)
    meta = lab.meta(AGENT)
    lab.ship(shipped)
    result = lab.run(_release(digest), "forged")
    # A failure: it alarms, because nothing legitimate starts it.
    assert (result["failed_step"], result["failure"]) == ("after_start", "release_approval_invalid")
    assert result["marked"] is False
    assert lab.meta(AGENT) == meta
    assert len(_version_items(lab)) == 1
    assert lab.firehose.records == []


def test_a_definition_that_does_not_match_its_hash_is_refused(lab: Lab) -> None:
    _installed(lab)
    digest = _new_release(lab)
    lab.db.update_item(
        TableName=AGENTS_TABLE,
        Key=release_key(AGENT, digest),
        UpdateExpression="SET #d = :d",
        ExpressionAttributeNames={"#d": "definition"},
        ExpressionAttributeValues={
            ":d": {"S": dumps_definition(release_definition(system_prompt="Tampered."))}
        },
    )
    result = lab.run(_release(digest), "update")
    assert result["failure"] == "hash_mismatch"
    assert len(_version_items(lab)) == 1
    assert lab.meta(AGENT)["published_version"]["N"] == "1"
    assert "provision_lock" not in lab.meta(AGENT)


def test_a_release_definition_that_was_not_seeded_is_a_failure(lab: Lab) -> None:
    _installed(lab)
    digest = content_hash(dumps_definition(release_definition(system_prompt="Never seeded.")))
    lab.ship({AGENT: digest})
    result = lab.run(_release(digest), "update")
    assert result["failure"] == "release_definition_not_found"
    assert len(_version_items(lab)) == 1
    assert "provision_lock" not in lab.meta(AGENT)


def test_nothing_overwrites_an_existing_version(lab: Lab) -> None:
    _installed(lab)
    # A version 2 the agent's pointers do not count (it can only come from outside mango-api).
    lab.db.put_item(
        TableName=AGENTS_TABLE,
        Item={
            **version_key(AGENT, 2),
            "agent_id": {"S": AGENT},
            "n": {"N": "2"},
            "status": {"S": "draft"},
            "definition": {"S": "{}"},
            "created_by": {"S": APPROVER},
            "editors": {"SS": [APPROVER]},
        },
    )
    before = lab.version(2, AGENT)
    result = lab.run(_release(_new_release(lab)), "update")
    assert result["failure"] == "release_update_conflict"
    assert lab.version(2, AGENT) == before
    assert lab.meta(AGENT)["published_version"]["N"] == "1"
    assert "provision_lock" not in lab.meta(AGENT)


def test_a_failed_publication_marks_the_new_version_and_keeps_the_old_one_serving(
    lab: Lab,
) -> None:
    _installed(lab)
    digest = _new_release(lab, release_definition(model=DISABLED_MODEL, allowed_models=[]))
    result = lab.run(_release(digest), "update")
    assert (result["failure"], result["marked"]) == ("model_not_enabled", True)
    v2 = lab.version(2, AGENT)
    assert (v2["status"]["S"], v2["approved_by"]["S"]) == ("failed", APPROVER)
    meta = lab.meta(AGENT)
    assert meta["published_version"]["N"] == "1"
    assert "provision_lock" not in meta
    assert [e["outcome"] for e in _events(lab, "agent.version.published")] == ["rejected"]


@pytest.mark.parametrize(
    "bad",
    [
        {"agent_id": AGENT, "content_hash": "a" * 64},
        {"agent_id": AGENT, "content_hash": "a" * 64, "release": "0.1.0", "version": 2},
        {"agent_id": AGENT, "content_hash": "a" * 64, "release": "latest"},
        {"agent_id": AGENT, "content_hash": "a" * 64, "release": 1},
        {"agent_id": AGENT, "content_hash": "A" * 64, "release": "0.1.0"},
        {"agent_id": "Fin Ops", "content_hash": "a" * 64, "release": "0.1.0"},
    ],
)
def test_release_input_is_exactly_id_hash_and_release(bad: dict[str, Any]) -> None:
    with pytest.raises(StepError, match="invalid_input"):
        parse_release_input(bad, "exec-1")


def test_the_definition_never_travels_in_state_logs_or_audit(
    lab: Lab, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    _installed(lab)
    digest = _new_release(lab)
    state = handler.handle(
        {"step": "load", "state": _release(digest), "execution": "update"}, lab.provisioner
    )
    assert (state["action"], state["version"]) == ("publish", 2)
    for text in (json.dumps(state), caplog.text, json.dumps(lab.firehose.records)):
        assert "NEW-PROMPT-MARKER" not in text
