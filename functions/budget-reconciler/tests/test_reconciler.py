"""The budget reconciler closes each pending turn exactly once (D73)."""

from __future__ import annotations

import json
from collections import Counter
from decimal import Decimal
from typing import Any

import pytest

from mango_budget_reconciler import handler
from mango_budget_reconciler.handler import handle, metrics_record
from mango_budget_reconciler.traces import TraceReading
from mango_core import budget_turns
from mango_core.budget_turns import TokenUsage, TurnPrice

from .conftest import (
    AGENT,
    DUE,
    EXPIRED,
    OTHER_SESSION,
    SETTINGS,
    START,
    USER,
    Lab,
    amounts,
    span,
)

# 3030 and 250 tokens at 3 and 15 USD per million.
TRACED = "0.01284"


def _details(lab: Lab) -> list[dict[str, Any]]:
    return [record["detail"] for record in lab.firehose.records]


def test_a_cut_turn_is_charged_what_its_trace_says_and_the_rest_is_released(lab: Lab) -> None:
    turn = lab.cut()
    assert lab.budget() == amounts("0", "0.337", held="0.337")
    lab.logs.spans = [span()]
    stats = lab.run()
    for scope in (USER, AGENT):
        assert lab.budget(scope) == amounts(TRACED)
    assert lab.record(turn) is None
    assert (stats["Closed"], stats["ChargedByTrace"], stats["ChargedByReservation"]) == (1, 1, 0)
    (detail,) = _details(lab)
    assert detail == {
        "target_user": "user-1",
        "agent": "finops",
        "version": 3,
        "model": "us.anthropic.claude-sonnet-4-6",
        "conversation_id": "c" * 32,
        "turn": "a" * 32,
        "basis": "trace",
        "reason": "",
        "ended": "held",
        "cost_usd": "0.012840",
        "known_cost_usd": "0.000000",
        "reserved_usd": "0.337000",
        "released_usd": "0.324160",
        "invocations": 1,
        "input_tokens": 3030,
        "output_tokens": 250,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
    }


def test_a_turn_that_failed_without_spending_gets_everything_back(lab: Lab) -> None:
    turn = lab.cut()
    lab.logs.spans = [span(tokens=None, status="ERROR", seconds=140)]
    lab.run()
    assert lab.budget() == amounts("0")
    assert lab.record(turn) is None
    (detail,) = _details(lab)
    assert (detail["basis"], detail["cost_usd"], detail["released_usd"]) == (
        "trace",
        "0.000000",
        "0.337000",
    )


def test_what_was_already_charged_is_not_charged_again(lab: Lab) -> None:
    # mango-api had counted the first model call (1000 and 100 tokens) before the cut.
    lab.cut(usage=TokenUsage(1000, 100))
    assert lab.budget() == amounts("0.0045", "0.3325", held="0.3325")
    lab.logs.spans = [span()]
    lab.run()
    assert lab.budget() == amounts(TRACED)
    (detail,) = _details(lab)
    assert (detail["known_cost_usd"], detail["cost_usd"]) == ("0.004500", "0.012840")


def test_a_trace_that_shows_less_than_mango_api_counted_never_gives_money_back(lab: Lab) -> None:
    lab.cut(usage=TokenUsage(1000, 100))
    lab.logs.spans = [span(tokens=(10, 1))]
    lab.run()
    assert lab.budget() == amounts("0.0045")
    (detail,) = _details(lab)
    assert (detail["basis"], detail["cost_usd"]) == ("partial", "0.004500")


def test_two_invocations_of_one_turn_are_both_charged(lab: Lab) -> None:
    lab.cut()
    lab.logs.spans = [
        span(start=START + 1.0, tokens=(2681, 245), span_id="1"),
        span(start=START + 1.8, tokens=(2720, 282), span_id="2"),
    ]
    lab.run()
    # 5401 and 527 tokens.
    assert lab.budget() == amounts("0.024108")
    assert _details(lab)[0]["invocations"] == 2


def test_the_trace_of_another_turn_is_never_charged_to_this_one(lab: Lab) -> None:
    lab.cut()
    lab.logs.spans = [
        span(session=OTHER_SESSION, tokens=(900_000, 90_000), span_id="1"),
        span(start=START - 40, seconds=30, tokens=(50_000, 5000), span_id="2"),
    ]
    assert lab.run()["Waiting"] == 1
    assert lab.budget() == amounts("0", "0.337", held="0.337")


def test_the_price_is_the_one_stored_when_the_turn_reserved(lab: Lab) -> None:
    # The catalog may have changed since: the reconciler never reads it.
    lab.cut(price=TurnPrice(Decimal(1), Decimal(5)))
    lab.logs.spans = [span()]
    lab.run()
    assert lab.budget() == amounts("0.00428")


def test_a_turn_is_not_read_before_its_time_limit_has_passed(lab: Lab) -> None:
    turn = lab.cut()
    lab.logs.spans = [span()]
    stats = lab.run(DUE - 1)
    # A second invocation of the turn may still be running.
    assert lab.logs.calls == []
    assert stats["Closed"] == stats["Waiting"] == 0
    assert lab.record(turn) == turn


def test_without_a_trace_the_turn_waits_until_its_deadline(lab: Lab) -> None:
    turn = lab.cut()
    for now in (DUE, DUE + 300, EXPIRED - 1):
        stats = lab.run(now)
        assert (stats["Waiting"], stats["Closed"]) == (1, 0)
    assert lab.record(turn) == turn
    assert lab.budget() == amounts("0", "0.337", held="0.337")
    assert lab.firehose.records == []


def test_without_a_trace_at_the_deadline_the_whole_reservation_is_charged(lab: Lab) -> None:
    turn = lab.cut(usage=TokenUsage(1000, 100))
    stats = lab.run(EXPIRED)
    for scope in (USER, AGENT):
        assert lab.budget(scope) == amounts("0.337")
    assert lab.record(turn) is None
    assert (stats["ChargedByReservation"], stats["ChargedByTrace"]) == (1, 0)
    (detail,) = _details(lab)
    assert (detail["basis"], detail["reason"]) == ("reservation", "no_trace")
    assert (detail["cost_usd"], detail["released_usd"]) == ("0.337000", "0.000000")
    assert detail["invocations"] == 0


def test_a_query_that_fails_charges_nothing_blindly_before_the_deadline(lab: Lab) -> None:
    turn = lab.cut()
    lab.logs.fail = True
    stats = lab.run(EXPIRED - 1)
    assert (stats["TraceQueryErrors"], stats["Waiting"], stats["Closed"]) == (1, 1, 0)
    assert lab.record(turn) == turn
    # The next run asks again, and the trace is there.
    lab.logs.fail = False
    lab.logs.spans = [span()]
    lab.run(EXPIRED - 1)
    assert lab.budget() == amounts(TRACED)


def test_a_query_that_still_fails_at_the_deadline_charges_the_reservation(lab: Lab) -> None:
    lab.cut()
    lab.logs.fail = True
    stats = lab.run(EXPIRED)
    assert (stats["TraceQueryErrors"], stats["ChargedByReservation"]) == (1, 1)
    assert lab.budget() == amounts("0.337")
    assert _details(lab)[0]["reason"] == "trace_query_failed"


def test_a_trace_that_cannot_be_read_is_never_read_as_zero(lab: Lab) -> None:
    lab.cut()
    # Finished well, and the token attributes are not where they used to be.
    lab.logs.spans = [span(tokens=None, **{"gen_ai.usage.tokens_in": 3030})]
    assert lab.run(EXPIRED - 1)["Waiting"] == 1
    assert lab.budget() == amounts("0", "0.337", held="0.337")
    lab.run(EXPIRED)
    assert lab.budget() == amounts("0.337")
    assert _details(lab)[0]["reason"] == "trace_unreadable"


def test_a_turn_whose_task_died_is_closed_from_its_trace(lab: Lab) -> None:
    turn = lab.turn()
    assert lab.budget() == amounts("0", "0.337")
    lab.logs.spans = [span()]
    lab.run()
    assert lab.budget() == amounts(TRACED)
    assert lab.record(turn) is None
    assert _details(lab)[0]["ended"] == "open"


def test_a_turn_that_never_reached_the_agent_is_released_without_asking(lab: Lab) -> None:
    lab.turn(session="")
    stats = lab.run()
    assert lab.logs.calls == []
    assert lab.budget() == amounts("0")
    assert stats["NotInvoked"] == 1
    assert _details(lab)[0]["basis"] == "not_invoked"


def test_running_again_changes_nothing(lab: Lab) -> None:
    lab.cut()
    lab.logs.spans = [span()]
    lab.run()
    stats = lab.run()
    assert stats["Closed"] == 0
    assert lab.budget() == amounts(TRACED)
    assert len(lab.firehose.records) == 1


def test_two_runs_at_once_close_the_turn_once(lab: Lab, monkeypatch: pytest.MonkeyPatch) -> None:
    lab.cut()
    lab.logs.spans = [span()]
    first, second = lab.reconciler(), lab.reconciler()
    read = second._traces.read
    overlapped: list[Counter[str]] = []

    def read_while_the_other_closes(*args: Any) -> TraceReading:
        # The first run reads the same record and closes it before this one writes.
        if not overlapped:
            overlapped.append(first.run(DUE, lambda: 200.0))
        return read(*args)

    monkeypatch.setattr(second._traces, "read", read_while_the_other_closes)
    stats = second.run(DUE, lambda: 200.0)
    assert overlapped[0]["Closed"] == 1
    assert (stats["Closed"], stats["Conflicts"]) == (0, 1)
    assert lab.budget() == amounts(TRACED)
    assert len(lab.firehose.records) == 1


def test_a_run_that_dies_before_auditing_is_finished_by_the_next_one(lab: Lab) -> None:
    turn = lab.cut()
    lab.logs.spans = [span()]
    lab.firehose.fail = True
    with pytest.raises(Exception, match="ServiceUnavailableException"):
        lab.run()
    # Charged once, and the record stays until its event is written.
    assert lab.budget() == amounts(TRACED)
    record = lab.record(turn)
    assert record is not None
    assert record.state == budget_turns.STATE_SETTLED
    lab.firehose.fail = False
    lab.logs.spans = []
    stats = lab.run()
    assert stats["Closed"] == 1
    assert lab.budget() == amounts(TRACED)
    assert lab.record(turn) is None
    (detail,) = _details(lab)
    assert (detail["basis"], detail["cost_usd"], detail["known_cost_usd"]) == (
        "trace",
        "0.012840",
        "0.000000",
    )
    assert detail["input_tokens"] == 3030


def test_a_turn_mango_api_settles_in_the_meantime_is_left_alone(
    lab: Lab, monkeypatch: pytest.MonkeyPatch
) -> None:
    turn = lab.turn()
    lab.logs.spans = [span()]
    reconciler = lab.reconciler()
    read = reconciler._traces.read

    def settle_first(*args: Any) -> TraceReading:
        assert budget_turns.settle(lab.db, "budgets", turn, Decimal("0.0045"))
        return read(*args)

    monkeypatch.setattr(reconciler._traces, "read", settle_first)
    stats = reconciler.run(DUE, lambda: 200.0)
    assert stats["Conflicts"] == 1
    assert lab.budget() == amounts("0.0045")
    assert lab.firehose.records == []


def test_many_turns_are_closed_oldest_first_and_only_while_there_is_time(lab: Lab) -> None:
    sessions = {shard: (shard * 2) * 32 for shard in "0123456789abcdef"}
    for index, (shard, session) in enumerate(sessions.items()):
        lab.cut(shard * 32, session=session, started_at=START + index)
        lab.logs.spans.append(span(session=session, start=START + index + 1, span_id=shard))
    assert lab.run(DUE + 60)["Closed"] == 16
    assert lab.budget()["reserved"] == 0
    assert lab.budget()["spent"] == Decimal(TRACED) * 16


def test_a_run_short_of_time_leaves_the_rest_for_the_next_one(lab: Lab) -> None:
    lab.cut()
    lab.logs.spans = [span()]
    lab.remaining = 5.0
    stats = lab.run()
    assert (stats["Closed"], stats["Waiting"]) == (0, 1)
    assert lab.logs.calls == []


def test_the_audit_record_has_the_shape_of_mango_api_records(lab: Lab) -> None:
    from mango_api.audit import AuditLog, resource_of  # noqa: PLC0415

    from .conftest import AUDIT_TABLE, FakeFirehose  # noqa: PLC0415

    lab.cut()
    lab.logs.spans = [span()]
    lab.run()
    (mine,) = lab.firehose.records
    theirs = FakeFirehose()
    AuditLog(theirs, "s", lab.db, AUDIT_TABLE).emit(  # type: ignore[arg-type]
        "budget.reconciled", "system:budget-reconciler", dict(mine["detail"])
    )
    (reference,) = theirs.records
    assert set(mine) == set(reference)
    assert mine["user_id"] == reference["user_id"]
    assert mine["resource"] == reference["resource"]
    assert mine["resource"] == resource_of("budget.reconciled", mine["detail"])
    assert mine["resource"] == {"type": "user", "id": "user-1"}
    body = {key: value for key, value in mine.items() if key != "hash"}
    import hashlib  # noqa: PLC0415

    assert (
        mine["hash"]
        == hashlib.sha256(
            json.dumps(body, separators=(",", ":"), sort_keys=True).encode()
        ).hexdigest()
    )
    stored = [json.loads(i["record"]["S"]) for i in lab.db.scan(TableName=AUDIT_TABLE)["Items"]]
    assert mine in stored


def test_nothing_of_a_span_but_its_numbers_reaches_the_audit_event_or_the_log(
    lab: Lab, capsys: pytest.CaptureFixture[str], caplog: pytest.LogCaptureFixture
) -> None:
    lab.cut()
    secret = "the user asked about the Q3 layoffs"
    lab.logs.spans = [
        span(
            **{
                "gen_ai.prompt": secret,
                "gen_ai.agent.tools": [secret],
                "gen_ai.request.model": secret,
            }
        )
    ]
    with caplog.at_level("INFO"):
        handle(lab.reconciler(), SETTINGS, DUE, lambda: 200.0)
    written = json.dumps(lab.firehose.records) + capsys.readouterr().out + caplog.text
    assert secret not in written
    assert "user-1" not in capsys.readouterr().out + caplog.text


def test_metrics_are_embedded_in_one_log_line(lab: Lab, capsys: pytest.CaptureFixture[str]) -> None:
    lab.cut()
    result = handle(lab.reconciler(), SETTINGS, EXPIRED, lambda: 200.0)
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert line == metrics_record("lab", Counter(result), EXPIRED)
    (metrics,) = line["_aws"]["CloudWatchMetrics"]
    assert metrics["Namespace"] == "Mango/BudgetReconciler"
    assert metrics["Dimensions"] == [["Installation"]]
    assert line["Installation"] == "lab"
    assert (line["Runs"], line["ChargedByReservation"], line["Closed"]) == (1, 1, 1)
    # Reported even when zero, so the alarm sees a value every run.
    assert {m["Name"] for m in metrics["Metrics"]} >= {"ChargedByTrace", "Waiting", "Conflicts"}


def test_a_record_of_another_shape_is_counted_and_never_acted_on(lab: Lab) -> None:
    turn = lab.cut()
    lab.db.update_item(
        TableName="budgets",
        Key=turn.key,
        UpdateExpression="SET scopes = :scopes",
        ExpressionAttributeValues={":scopes": {"L": [{"S": "SETTINGS#BUDGETS"}]}},
    )
    lab.logs.spans = [span()]
    stats = lab.run(EXPIRED)
    assert (stats["InvalidRecords"], stats["Closed"]) == (1, 0)
    assert lab.budget() == amounts("0", "0.337", held="0.337")


def test_the_lambda_reads_the_time_left_from_its_context(
    lab: Lab, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Context:
        def get_remaining_time_in_millis(self) -> int:
            return 200_000

    lab.turn(session="")
    monkeypatch.setattr(handler, "_reconciler", lambda: (lab.reconciler(), SETTINGS))
    monkeypatch.setattr(handler.time, "time", lambda: float(DUE))
    assert handler.lambda_handler({}, Context())["NotInvoked"] == 1


def test_the_held_amount_is_tracked_per_turn(lab: Lab) -> None:
    first = lab.cut("1" * 32, session="11" * 32)
    lab.cut("2" * 32, session="22" * 32)
    assert lab.budget() == amounts("0", "0.674", held="0.674")
    lab.logs.spans = [span(session=first.session_id)]
    lab.run()
    assert lab.budget() == amounts(TRACED, "0.337", held="0.337")
