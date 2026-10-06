from __future__ import annotations

from collections.abc import Iterator
from dataclasses import replace
from decimal import Decimal
from typing import Any

import boto3
import pytest
from moto import mock_aws

from mango_core import budget_turns
from mango_core.budget_turns import (
    BASIS_NOT_INVOKED,
    BASIS_PARTIAL,
    BASIS_RESERVATION,
    BASIS_TRACE,
    InvalidTurnError,
    Outcome,
    PendingTurn,
    TokenUsage,
    TurnPrice,
)

TABLE = "budgets"
PERIOD = "2026-10"
USER, AGENT = "USER#user-1", "AGENT#finops"
PRICE = TurnPrice(Decimal(3), Decimal(15), Decimal("0.3"), Decimal("3.75"))
RESERVED = Decimal("0.337")
SESSION = "ab" * 32
START = 1_791_306_900


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        client.create_table(
            TableName=TABLE,
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
        yield client


def _turn(turn_id: str = "a" * 32, **changes: Any) -> PendingTurn:
    turn = PendingTurn.new(
        turn_id=turn_id,
        user_id="user-1",
        agent_id="finops",
        agent_version=3,
        model="us.anthropic.claude-sonnet-4-6",
        conversation_id="c" * 32,
        period=PERIOD,
        scopes=(USER, AGENT),
        reserved=RESERVED,
        price=PRICE,
        started_at=START,
        timeout_seconds=120,
    )
    return replace(turn, **changes)


def _reserve(db: Any, turn: PendingTurn) -> None:
    """What ``BudgetService.reserve`` writes: the reservation and the record, together."""
    db.transact_write_items(
        TransactItems=[
            budget_turns.reservation_item(TABLE, turn),
            *[
                {
                    "Update": {
                        "TableName": TABLE,
                        "Key": {"PK": {"S": scope}, "SK": {"S": PERIOD}},
                        "UpdateExpression": "ADD committed :amount, reserved :amount",
                        "ExpressionAttributeValues": {":amount": {"N": str(turn.reserved)}},
                    }
                }
                for scope in turn.scopes
            ],
        ]
    )


def _budget(db: Any, scope: str = USER) -> dict[str, Decimal]:
    item = db.get_item(TableName=TABLE, Key={"PK": {"S": scope}, "SK": {"S": PERIOD}})["Item"]
    return {
        name: Decimal(item.get(name, {}).get("N", "0"))
        for name in ("spent", "reserved", "committed", "held")
    }


def _record(db: Any, turn: PendingTurn) -> PendingTurn | None:
    item = db.get_item(TableName=TABLE, Key=turn.key).get("Item")
    return PendingTurn.from_item(item) if item else None


def _amounts(spent: str, reserved: str, held: str = "0") -> dict[str, Decimal]:
    return {
        "spent": Decimal(spent),
        "reserved": Decimal(reserved),
        "committed": Decimal(spent) + Decimal(reserved),
        "held": Decimal(held),
    }


def test_the_record_is_written_with_the_reservation_and_read_back(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    assert _record(db, turn) == turn
    assert turn.reconcile_at == START + 120 + 90
    assert turn.charge_at == START + 120 + 15 * 60
    assert _budget(db) == _amounts("0", "0.337")


def test_a_turn_id_reserves_once(db: Any) -> None:
    _reserve(db, _turn())
    with pytest.raises(db.exceptions.TransactionCanceledException):
        _reserve(db, _turn())
    assert _budget(db) == _amounts("0", "0.337")


def test_settling_charges_the_real_cost_and_deletes_the_record(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    assert budget_turns.settle(db, TABLE, turn, Decimal("0.0045")) is True
    assert _record(db, turn) is None
    for scope in (USER, AGENT):
        assert _budget(db, scope) == _amounts("0.0045", "0")


def test_settling_twice_charges_and_releases_once(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    assert budget_turns.settle(db, TABLE, turn, Decimal("0.0045")) is True
    assert budget_turns.settle(db, TABLE, turn, Decimal("0.0045")) is False
    assert _budget(db) == _amounts("0.0045", "0")


def test_the_real_cost_may_exceed_the_reservation(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    budget_turns.settle(db, TABLE, turn, Decimal("0.5"))
    assert _budget(db) == _amounts("0.5", "0")


def test_holding_charges_what_is_known_and_keeps_the_rest(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    usage = TokenUsage(input_tokens=1000, output_tokens=100)
    held = budget_turns.hold(db, TABLE, turn, usage)
    assert held is not None
    assert (held.charged, held.retained) == (Decimal("0.004500"), Decimal("0.332500"))
    assert _record(db, turn) == held
    for scope in (USER, AGENT):
        # Nothing went back to the budget: committed is still the whole reservation.
        assert _budget(db, scope) == _amounts("0.0045", "0.3325", held="0.3325")


def test_holding_twice_or_after_settling_changes_nothing(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    assert budget_turns.hold(db, TABLE, turn, TokenUsage()) is not None
    assert budget_turns.hold(db, TABLE, turn, TokenUsage(input_tokens=9_000_000)) is None
    assert budget_turns.settle(db, TABLE, turn, Decimal(0)) is False
    assert _budget(db) == _amounts("0", "0.337", held="0.337")


def test_known_usage_above_the_reservation_holds_nothing(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    held = budget_turns.hold(db, TABLE, turn, TokenUsage(input_tokens=200_000))
    assert held is not None
    assert (held.charged, held.retained) == (Decimal("0.600000"), Decimal(0))
    assert _budget(db) == _amounts("0.6", "0")


def test_closing_a_held_turn_charges_the_trace_and_releases_the_rest(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    held = budget_turns.hold(db, TABLE, turn, TokenUsage(input_tokens=1000, output_tokens=100))
    assert held is not None
    outcome = Outcome(BASIS_TRACE, usage=TokenUsage(2681, 245), invocations=1)
    closed = budget_turns.close(db, TABLE, held, outcome)
    assert closed is not None
    assert closed.charged == Decimal("0.011718")
    assert closed.state == budget_turns.STATE_SETTLED
    for scope in (USER, AGENT):
        assert _budget(db, scope) == _amounts("0.011718", "0")
    # The record waits for its audit event with the result in it.
    assert _record(db, turn) == closed


def test_a_trace_that_says_less_than_what_was_counted_never_lowers_the_charge(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    held = budget_turns.hold(db, TABLE, turn, TokenUsage(input_tokens=1000, output_tokens=100))
    assert held is not None
    closed = budget_turns.close(db, TABLE, held, Outcome(BASIS_PARTIAL, invocations=1))
    assert closed is not None
    assert closed.charged == Decimal("0.004500")
    assert _budget(db) == _amounts("0.0045", "0")


def test_closing_without_a_trace_charges_the_whole_reservation(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    held = budget_turns.hold(db, TABLE, turn, TokenUsage(input_tokens=1000, output_tokens=100))
    assert held is not None
    closed = budget_turns.close(db, TABLE, held, Outcome(BASIS_RESERVATION, reason="no_trace"))
    assert closed is not None
    assert closed.charged == RESERVED
    assert _budget(db) == _amounts("0.337", "0")


def test_a_reservation_charge_is_never_less_than_what_the_traces_already_show(db: Any) -> None:
    # A model call of the turn was never written, and the ones that were add up to more
    # than the turn reserved.
    turn = _turn()
    _reserve(db, turn)
    held = budget_turns.hold(db, TABLE, turn, TokenUsage())
    assert held is not None
    outcome = Outcome(
        BASIS_RESERVATION,
        reason="model_call_unfinished",
        usage=TokenUsage(100, 30_000),
        model_calls=1,
        source=budget_turns.SOURCE_MODEL_CALLS,
    )
    closed = budget_turns.close(db, TABLE, held, outcome)
    assert closed is not None
    assert closed.charged == Decimal("0.450300")
    assert _budget(db) == _amounts("0.4503", "0")


def test_where_the_cost_came_from_is_kept_with_the_settled_record(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    held = budget_turns.hold(db, TABLE, turn, TokenUsage())
    assert held is not None
    outcome = Outcome(
        BASIS_TRACE,
        usage=TokenUsage(871, 5849),
        invocations=1,
        model_calls=1,
        source=budget_turns.SOURCE_MODEL_CALLS,
    )
    assert budget_turns.close(db, TABLE, held, outcome) is not None
    record = _record(db, turn)
    assert record is not None
    assert record.outcome is not None
    assert (record.outcome.model_calls, record.outcome.source) == (1, "model_calls")


def test_a_record_settled_before_model_calls_were_summed_is_still_read(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    outcome = Outcome(BASIS_TRACE, usage=TokenUsage(3030, 250), invocations=1)
    assert budget_turns.close(db, TABLE, turn, outcome) is not None
    db.update_item(
        TableName=TABLE,
        Key=turn.key,
        UpdateExpression="REMOVE model_calls, #source",
        ExpressionAttributeNames={"#source": "source"},
    )
    record = _record(db, turn)
    assert record is not None
    assert record.outcome is not None
    assert (record.outcome.invocations, record.outcome.model_calls, record.outcome.source) == (
        1,
        0,
        "",
    )


def test_closing_an_open_turn_whose_task_died(db: Any) -> None:
    turn = _turn(session_id=SESSION)
    _reserve(db, turn)
    outcome = Outcome(BASIS_TRACE, usage=TokenUsage(3030, 250), invocations=1)
    closed = budget_turns.close(db, TABLE, turn, outcome)
    assert closed is not None
    # 3030 and 250 tokens at 3 and 15 USD per million. ``held`` was never raised for it.
    assert _budget(db) == _amounts("0.01284", "0")


def test_a_turn_that_never_reached_the_agent_releases_everything(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    assert budget_turns.close(db, TABLE, turn, Outcome(BASIS_NOT_INVOKED)) is not None
    assert _budget(db) == _amounts("0", "0")


def test_closing_twice_charges_and_releases_once(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    held = budget_turns.hold(db, TABLE, turn, TokenUsage())
    assert held is not None
    outcome = Outcome(BASIS_TRACE, usage=TokenUsage(2681, 245), invocations=1)
    first = budget_turns.close(db, TABLE, held, outcome)
    assert first is not None
    # A second run that read the record before the first one closed it, and one that reads
    # it afterwards.
    assert budget_turns.close(db, TABLE, held, outcome) is None
    assert budget_turns.close(db, TABLE, first, outcome) is None
    assert _budget(db) == _amounts("0.011718", "0")


def test_a_turn_held_after_it_was_read_is_not_closed_with_stale_amounts(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    # The reconciler read it open; mango-api holds it before the reconciler writes.
    assert budget_turns.hold(db, TABLE, turn, TokenUsage(input_tokens=1000)) is not None
    assert budget_turns.close(db, TABLE, turn, Outcome(BASIS_RESERVATION)) is None
    assert _budget(db) == _amounts("0.003", "0.334", held="0.334")


def test_mango_api_settling_late_after_the_reconciler_changes_nothing(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    outcome = Outcome(BASIS_TRACE, usage=TokenUsage(2681, 245), invocations=1)
    assert budget_turns.close(db, TABLE, turn, outcome) is not None
    assert budget_turns.settle(db, TABLE, turn, Decimal("0.5")) is False
    assert budget_turns.hold(db, TABLE, turn, TokenUsage(input_tokens=1000)) is None
    assert _budget(db) == _amounts("0.011718", "0")


def test_forgetting_deletes_only_settled_records(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    budget_turns.forget(db, TABLE, turn)
    assert _record(db, turn) is not None
    closed = budget_turns.close(db, TABLE, turn, Outcome(BASIS_NOT_INVOKED))
    assert closed is not None
    budget_turns.forget(db, TABLE, closed)
    budget_turns.forget(db, TABLE, closed)
    assert _record(db, turn) is None


def test_the_session_is_bound_only_while_the_turn_is_open(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    budget_turns.bind_session(db, TABLE, turn, SESSION)
    bound = _record(db, turn)
    assert bound is not None
    assert bound.session_id == SESSION
    budget_turns.settle(db, TABLE, turn, Decimal(0))
    with pytest.raises(db.exceptions.ConditionalCheckFailedException):
        budget_turns.bind_session(db, TABLE, turn, SESSION)
    assert _record(db, turn) is None


def test_due_finds_every_shard_without_a_scan_and_only_what_is_due(db: Any) -> None:
    turns = [_turn(turn_id=shard * 32, started_at=START + i) for i, shard in enumerate("0a5f")]
    later = _turn(turn_id="b" * 32, reconcile_at=START + 10_000)
    for turn in (*turns, later):
        _reserve(db, turn)
    # Budget items of the same table are never read as turns.
    found, invalid = budget_turns.due(db, TABLE, START + 500, limit=10)
    assert [turn.turn_id for turn in found] == [turn.turn_id for turn in turns]
    assert invalid == 0
    capped, _ = budget_turns.due(db, TABLE, START + 500, limit=2)
    assert [turn.turn_id for turn in capped] == [turn.turn_id for turn in turns[:2]]


def test_a_record_with_another_shape_is_counted_and_never_used(db: Any) -> None:
    turn = _turn()
    _reserve(db, turn)
    db.put_item(
        TableName=TABLE,
        Item={"PK": {"S": "TURN#b"}, "SK": {"S": "b" * 32}, "reconcile_at": {"N": "0"}},
    )
    found, invalid = budget_turns.due(db, TABLE, START + 500, limit=10)
    assert [t.turn_id for t in found] == [turn.turn_id]
    assert invalid == 1


@pytest.mark.parametrize(
    "change",
    [
        {"session_id": {"S": 'x" } { $.name = "*'}},
        {"scopes": {"L": [{"S": "SETTINGS#x"}]}},
        {"scopes": {"L": []}},
        {"state": {"S": "paid"}},
        {"period": {"S": "2026-10-01"}},
        {"reserved": {"N": "-1"}},
        {"price_input": {"N": "NaN"}},
        {"SK": {"S": "../x"}},
        {"PK": {"S": "TURN#b"}},
    ],
)
def test_records_are_validated_before_they_are_used(change: dict[str, Any]) -> None:
    item = {**_turn(session_id=SESSION).to_item(), **change}
    with pytest.raises(InvalidTurnError):
        PendingTurn.from_item(item)


def test_token_cost_uses_the_price_stored_with_the_turn() -> None:
    usage = TokenUsage(1_000_000, 100_000, 2_000_000, 10_000)
    assert budget_turns.token_cost(usage, PRICE) == Decimal("5.137500")
