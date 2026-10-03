"""Runtime session per conversation (D39): when to continue one and how its id is derived."""

from __future__ import annotations

import re
from dataclasses import replace
from typing import Any

import boto3
import pytest
from moto import mock_aws

from mango_api import harness, sessions
from mango_api.conversations import ConversationRepository
from mango_api.sessions import SessionBusyError, SessionPlan, SessionState
from mango_core.identity import UserContext

NOW = 1_800_000_000
IDLE, MAX_AGE, TURN = 300, 28_800, 300
BINDING = "b" * 64
"""What the session was started under (``sessions.session_binding``)."""
SESSION_ID_RE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9-_]{32,99}")  # InvokeHarness constraint


def _plan(
    state: SessionState, now: int = NOW, idle: int = IDLE, binding: str = BINDING
) -> SessionPlan:
    return sessions.plan(
        state, now, binding=binding, idle_seconds=idle, max_seconds=MAX_AGE, turn_seconds=TURN
    )


def test_new_conversation_starts_the_first_session() -> None:
    assert _plan(SessionState()) == SessionPlan(generation=1, started_at=NOW, reused=False)


def test_recent_session_is_continued() -> None:
    state = SessionState(2, NOW - 500, NOW - 30, BINDING)
    assert _plan(state) == SessionPlan(generation=2, started_at=NOW - 500, reused=True)


@pytest.mark.parametrize(("idle_for", "reused"), [(239, True), (240, True), (241, False)])
def test_reuse_stops_a_margin_before_the_idle_timeout(idle_for: int, reused: bool) -> None:
    state = SessionState(1, NOW - 1000, NOW - idle_for, BINDING)
    assert _plan(state).reused is reused


def test_stale_session_is_replaced_by_the_next_generation() -> None:
    state = SessionState(4, NOW - 5000, NOW - 900, BINDING)
    assert _plan(state) == SessionPlan(generation=5, started_at=NOW, reused=False)


def test_turn_in_flight_or_ended_badly_is_never_continued() -> None:
    state = SessionState(3, NOW - 10, 0, BINDING)
    assert _plan(state) == SessionPlan(generation=4, started_at=NOW, reused=False)


def test_session_is_replaced_when_the_turn_would_not_fit_in_its_lifetime() -> None:
    fits = SessionState(1, NOW - (MAX_AGE - TURN - 60), NOW - 5, BINDING)
    too_old = replace(fits, started_at=fits.started_at - 1)
    assert _plan(fits).reused is True
    assert _plan(too_old).reused is False


def test_session_started_under_another_binding_is_never_continued() -> None:
    # Another model, agent version or access of the user: the session id differs, so the turn
    # runs in an empty session and must be planned as new (it then gets the history).
    state = SessionState(2, NOW - 500, NOW - 30, BINDING)
    assert _plan(state).reused is True
    assert _plan(state, binding="c" * 64) == SessionPlan(3, NOW, reused=False)


def test_session_without_a_recorded_binding_is_never_continued() -> None:
    # Sessions started before the binding was stored.
    assert _plan(SessionState(2, NOW - 500, NOW - 30)).reused is False
    assert _plan(SessionState(2, NOW - 500, NOW - 30), binding="").reused is False


def test_reuse_is_off_without_an_idle_timeout() -> None:
    state = SessionState(1, NOW - 10, NOW - 5, BINDING)
    assert _plan(state, idle=0) == SessionPlan(generation=2, started_at=NOW, reused=False)


def _user(user_id: str = "user-1", **overrides: Any) -> UserContext:
    fields: dict[str, Any] = {"role": "bu-lead", "business_unit": "security", "is_admin": False}
    return UserContext(user_id, **{**fields, **overrides})


def _id(user: UserContext | None = None, **overrides: Any) -> str:
    fields: dict[str, Any] = {
        "agent_id": "finops",
        "conversation_id": "a" * 32,
        "generation": 1,
        "fingerprint": "f" * 64,
    }
    return sessions.runtime_session_id(user=user or _user(), **{**fields, **overrides})


def test_session_id_fits_the_agentcore_constraint_and_is_stable() -> None:
    assert SESSION_ID_RE.fullmatch(_id())
    assert _id() == _id()
    # Long identifiers (federated subs) do not change the length.
    assert len(_id(_user("u" * 300))) == 64


@pytest.mark.parametrize(
    "overrides",
    [
        {"agent_id": "ec2"},
        {"conversation_id": "b" * 32},
        {"generation": 2},
        {"fingerprint": "e" * 64},
    ],
)
def test_session_id_changes_with_every_input(overrides: dict[str, Any]) -> None:
    assert _id(**overrides) != _id()


def test_session_id_is_bound_to_the_user() -> None:
    assert _id(_user("user-2")) != _id(_user("user-1"))


@pytest.mark.parametrize(
    "changed",
    [
        {"role": "finops-central", "business_unit": None},
        {"business_unit": "sandbox"},
        {"groups": frozenset({"mango-agent-creator"})},
    ],
)
def test_session_id_changes_when_the_users_access_changes(changed: dict[str, Any]) -> None:
    assert _id(_user(**changed)) != _id()


def test_session_id_ignores_display_attributes() -> None:
    assert _id(_user(email="a@example.com", name="A")) == _id()


def test_session_id_fields_cannot_be_shifted_between_user_and_conversation() -> None:
    assert _id(_user("ab"), conversation_id="c") != _id(_user("a"), conversation_id="bc")


def _fingerprint(**overrides: Any) -> str:
    args = {
        "harness_arn": "arn:aws:bedrock-agentcore:us-east-1:111111111111:harness/h",
        "harness_version": "3",
        "content_hash": "a" * 64,
        "model": "model-a",
        "guardrail_id": "gr",
        "guardrail_version": "1",
    }
    return sessions.agent_fingerprint(**{**args, **overrides})


@pytest.mark.parametrize(
    "overrides",
    [
        {"content_hash": "b" * 64},  # prompt, tools or limits of another version
        {"model": "model-c"},
        {"guardrail_version": "2"},
        {"guardrail_id": "gr2"},
        {"harness_arn": "arn:aws:bedrock-agentcore:us-east-1:111111111111:harness/other"},
        {"harness_version": "4"},
    ],
)
def test_fingerprint_changes_with_what_the_agent_runs(overrides: dict[str, Any]) -> None:
    assert _fingerprint(**overrides) != _fingerprint()
    assert _fingerprint() == _fingerprint()


def test_binding_changes_with_the_fingerprint_and_with_the_users_access() -> None:
    base = sessions.session_binding(_user(), _fingerprint())
    assert base == sessions.session_binding(_user(), _fingerprint())
    assert base != sessions.session_binding(_user(), _fingerprint(model="model-c"))
    assert base != sessions.session_binding(_user(business_unit="other"), _fingerprint())
    # Display attributes do not decide what the tools return.
    assert base == sessions.session_binding(_user(email="x@example.com"), _fingerprint())


@pytest.mark.parametrize(
    ("failed", "stop_reason", "ok"),
    [
        (False, "end_turn", True),
        (False, "max_tokens", True),
        (True, "", False),
        (False, "guardrail_intervened", False),
    ],
)
def test_can_continue(failed: bool, stop_reason: str, ok: bool) -> None:
    result = harness.InvocationResult(stop_reason=stop_reason, failed=failed)
    assert sessions.can_continue(result) is ok


def test_a_turn_that_ended_on_a_write_tool_call_is_not_continued() -> None:
    # The harness was left waiting for that tool: its session holds half a turn.
    result = harness.InvocationResult(stop_reason="tool_use", interrupted=True)
    assert sessions.can_continue(result) is False


# --- conversation record (moto DynamoDB) -------------------------------------------------------

USER, OTHER, CID = "user-1", "user-2", "c" * 32


@pytest.fixture
def repo(monkeypatch: pytest.MonkeyPatch) -> Any:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        db.create_table(
            TableName="conv",
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
        yield ConversationRepository(lambda _user: db, "conv")


def test_unknown_conversation_has_no_session_state(repo: ConversationRepository) -> None:
    assert repo.session_state(USER, CID) is None


def test_conversation_without_a_session_yet(repo: ConversationRepository) -> None:
    repo.upsert_conversation(USER, CID, "t", "finops")
    assert repo.session_state(USER, CID) == SessionState()


def test_session_becomes_reusable_only_after_the_turn_completes(
    repo: ConversationRepository,
) -> None:
    repo.upsert_conversation(USER, CID, "t", "finops")
    repo.begin_session(USER, CID, SessionState(), 1, NOW, binding=BINDING)
    assert repo.session_state(USER, CID) == SessionState(1, NOW, 0, BINDING)
    repo.complete_session(USER, CID, 1, NOW + 12)
    assert repo.session_state(USER, CID) == SessionState(1, NOW, NOW + 12, BINDING)


def test_only_one_of_two_turns_takes_the_session(repo: ConversationRepository) -> None:
    repo.upsert_conversation(USER, CID, "t", "finops")
    repo.begin_session(USER, CID, SessionState(), 1, NOW, binding=BINDING)
    repo.complete_session(USER, CID, 1, NOW + 12)
    reusable = repo.session_state(USER, CID)
    assert reusable is not None
    # Both turns planned from the same state; the first one takes the session.
    repo.begin_session(USER, CID, reusable, 1, NOW, binding=BINDING)
    with pytest.raises(SessionBusyError):
        repo.begin_session(USER, CID, reusable, 1, NOW, binding=BINDING)
    # The loser plans again from the current state and gets the next session.
    in_flight = repo.session_state(USER, CID)
    assert in_flight == SessionState(1, NOW, 0, BINDING)
    repo.begin_session(USER, CID, in_flight, 2, NOW + 1, binding="c" * 64)
    assert repo.session_state(USER, CID) == SessionState(2, NOW + 1, 0, "c" * 64)


def test_first_session_of_a_conversation_is_taken_once(repo: ConversationRepository) -> None:
    repo.upsert_conversation(USER, CID, "t", "finops")
    repo.begin_session(USER, CID, SessionState(), 1, NOW, binding=BINDING)
    with pytest.raises(SessionBusyError):
        repo.begin_session(USER, CID, SessionState(), 1, NOW, binding=BINDING)


def test_late_turn_does_not_mark_a_newer_session_as_reusable(
    repo: ConversationRepository,
) -> None:
    repo.upsert_conversation(USER, CID, "t", "finops")
    repo.begin_session(USER, CID, SessionState(), 1, NOW, binding=BINDING)
    # A second turn started while the first was still running and moved on to session 2.
    repo.begin_session(USER, CID, SessionState(1, NOW, 0), 2, NOW + 5, binding=BINDING)
    repo.complete_session(USER, CID, 1, NOW + 9)
    assert repo.session_state(USER, CID) == SessionState(2, NOW + 5, 0, BINDING)


def test_session_state_is_per_user(repo: ConversationRepository) -> None:
    repo.upsert_conversation(USER, CID, "t", "finops")
    repo.begin_session(USER, CID, SessionState(), 1, NOW, binding=BINDING)
    assert repo.session_state(OTHER, CID) is None


# --- the agent of a conversation ---------------------------------------------------------------


def test_conversation_keeps_the_agent_of_its_first_turn(repo: ConversationRepository) -> None:
    assert repo.conversation(USER, CID) is None
    repo.upsert_conversation(USER, CID, "t", "abcdefghijklmnop")
    # A later turn never moves the conversation, and its history, to another agent.
    repo.upsert_conversation(USER, CID, "other title", "finops")
    record = repo.conversation(USER, CID)
    assert record is not None
    assert (record.agent_id, record.session) == ("abcdefghijklmnop", SessionState())
    assert repo.summary(USER, CID) == ("t", "abcdefghijklmnop")
    assert repo.list_conversations(USER)[0]["agent_id"] == "abcdefghijklmnop"
    assert repo.conversation(OTHER, CID) is None
    assert repo.summary(OTHER, CID) is None


def test_conversation_stored_before_agents_were_data_has_no_agent(
    repo: ConversationRepository,
) -> None:
    db = repo._clients(USER)
    db.put_item(
        TableName="conv",
        Item={
            "PK": {"S": f"USER#{USER}"},
            "SK": {"S": f"CONV#{CID}"},
            "title": {"S": "antigua"},
            "updated_at": {"S": "2026-09-30T10:00:00+00:00"},
            "session_gen": {"N": "2"},
            "session_started_at": {"N": str(NOW)},
            "session_used_at": {"N": str(NOW + 5)},
        },
    )
    record = repo.conversation(USER, CID)
    assert record is not None
    assert record.agent_id is None
    # Its session predates the binding: the next turn starts a new one and replays history.
    assert record.session == SessionState(2, NOW, NOW + 5, "")
    assert repo.summary(USER, CID) == ("antigua", None)
    assert repo.list_conversations(USER)[0]["agent_id"] is None
