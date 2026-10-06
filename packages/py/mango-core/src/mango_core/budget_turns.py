"""The pending record of a chat turn and how its budget reservation is closed (D73).

"I do not know what it cost" is never recorded as "it cost nothing". Every turn that reserves
budget leaves a record in the Budgets table, written in the same transaction as the
reservation. It is closed exactly once:

* ``settle``: the end of the turn is known. mango-api charges the real cost, releases the rest
  of the reservation and deletes the record.
* ``hold``: the end is not known (mango-api stopped reading the agent). What is known is
  charged and the rest of the reservation stays held.
* ``close``: the budget reconciler charges what the AgentCore traces say (or the whole
  reservation when there is no trace after the deadline), releases the rest and marks the
  record ``settled``; it deletes it once the audit event is written.

Each of them is one transaction conditioned on the record, so closing a turn twice neither
charges nor releases twice. A record whose mango-api task died stays ``open`` and the
reconciler closes it the same way.

Item layout: ``PK = TURN#<first hex character of the turn id>``, ``SK = <turn id>``. Sixteen
partitions, so the reconciler finds every record with sixteen queries and no scan. The record
holds identifiers, amounts and the price of the model when the turn reserved: never content.
"""

from __future__ import annotations

import random
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Final

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

TURN_PREFIX: Final = "TURN#"
SHARDS: Final = "0123456789abcdef"

STATE_OPEN: Final = "open"
"""Reserved; mango-api has not said how the turn ended."""
STATE_HELD: Final = "held"
"""mango-api stopped reading the agent: the known cost is charged, the rest is held."""
STATE_SETTLED: Final = "settled"
"""Closed by the reconciler; the record only waits for its audit event."""

RECONCILE_MARGIN_SECONDS: Final = 90
"""After the turn's time limit, how long until its traces are read: an invocation was seen
running 28 s past a limit of 120 s, and a trace is only written when its invocation ends."""
NO_TRACE_SECONDS: Final = 15 * 60
"""After the turn's time limit, how long a trace is waited for before the whole reservation is
charged."""

BASIS_TRACE: Final = "trace"
"""Charged what the AgentCore traces of the turn's session add up to."""
BASIS_PARTIAL: Final = "partial"
"""Charged what mango-api had already counted: the traces said less."""
BASIS_RESERVATION: Final = "reservation"
"""No readable trace by the deadline: the whole reservation was charged."""
BASIS_NOT_INVOKED: Final = "not_invoked"
"""The turn never reached the agent: everything was released."""

MAX_ATTEMPTS: Final = 4
_RETRYABLE: Final = frozenset({"TransactionConflict", "None"})
_MILLION: Final = Decimal(1_000_000)
_ZERO: Final = Decimal(0)
_TURN_ID: Final = re.compile(r"^[0-9a-f]{32}$")
_SESSION_ID: Final = re.compile(r"^[0-9a-f]{64}$")
_SCOPE: Final = re.compile(r"^(USER|AGENT)#[\w.:-]{1,128}$")
_PERIOD: Final = re.compile(r"^\d{4}-\d{2}$")
_BUDGET_COUNTERS: Final = ("committed", "reserved", "spent", "held")
_BUDGET_UPDATE: Final = "ADD " + ", ".join(f"#{name} :{name}" for name in _BUDGET_COUNTERS)


class TurnConflictError(Exception):
    """The transaction kept colliding with other writes; nothing was written. Try again."""


class InvalidTurnError(ValueError):
    """A record of the table does not have the shape this module writes."""


@dataclass(frozen=True)
class TurnPrice:
    """USD per million tokens of the model, as the catalog said when the turn reserved."""

    input: Decimal
    output: Decimal
    cache_read: Decimal = _ZERO
    cache_write: Decimal = _ZERO


@dataclass(frozen=True)
class TokenUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

    def plus(self, other: TokenUsage) -> TokenUsage:
        return TokenUsage(
            self.input_tokens + other.input_tokens,
            self.output_tokens + other.output_tokens,
            self.cache_read_tokens + other.cache_read_tokens,
            self.cache_write_tokens + other.cache_write_tokens,
        )


def token_cost(usage: TokenUsage, price: TurnPrice) -> Decimal:
    total = (
        usage.input_tokens * price.input
        + usage.output_tokens * price.output
        + usage.cache_read_tokens * price.cache_read
        + usage.cache_write_tokens * price.cache_write
    ) / _MILLION
    return total.quantize(Decimal("0.000001"))


@dataclass(frozen=True)
class Outcome:
    """How the reconciler closed a turn; goes to the audit event."""

    basis: str
    reason: str = ""
    """Why the reservation was charged (``no_trace``, ``trace_unreadable``,
    ``trace_query_failed``); empty otherwise."""
    usage: TokenUsage = TokenUsage()
    invocations: int = 0
    """Invocations of the agent the traces showed for this turn."""
    known: Decimal = _ZERO
    """What mango-api had already charged when the turn was closed (set by ``close``)."""
    ended: str = ""
    """State the turn was closed from (set by ``close``): ``held``, mango-api stopped reading
    the agent; ``open``, mango-api never said how the turn ended."""


@dataclass(frozen=True)
class PendingTurn:
    turn_id: str
    user_id: str
    agent_id: str
    agent_version: int
    model: str
    conversation_id: str
    period: str
    scopes: tuple[str, ...]
    """Keys of the budget items the reservation was made on (``USER#…``, ``AGENT#…``)."""
    reserved: Decimal
    started_at: int
    reconcile_at: int
    """Epoch seconds from which the reconciler may close the turn."""
    charge_at: int
    """Epoch seconds from which a turn without a trace is charged its whole reservation."""
    price: TurnPrice
    session_id: str = ""
    """AgentCore runtime session of the turn; empty until the turn is about to be invoked."""
    state: str = STATE_OPEN
    charged: Decimal = _ZERO
    """Already added to ``spent`` of every scope."""
    retained: Decimal = _ZERO
    """Still counted in ``reserved`` of every scope."""
    usage: TokenUsage = TokenUsage()
    """Tokens behind ``charged``."""
    outcome: Outcome | None = None

    @staticmethod
    def new(
        *,
        turn_id: str,
        user_id: str,
        agent_id: str,
        agent_version: int,
        model: str,
        conversation_id: str,
        period: str,
        scopes: tuple[str, ...],
        reserved: Decimal,
        price: TurnPrice,
        started_at: int,
        timeout_seconds: int,
    ) -> PendingTurn:
        limit = started_at + timeout_seconds
        return PendingTurn(
            turn_id=turn_id,
            user_id=user_id,
            agent_id=agent_id,
            agent_version=agent_version,
            model=model,
            conversation_id=conversation_id,
            period=period,
            scopes=scopes,
            reserved=reserved,
            started_at=started_at,
            reconcile_at=limit + RECONCILE_MARGIN_SECONDS,
            charge_at=limit + NO_TRACE_SECONDS,
            price=price,
            retained=reserved,
        )

    @property
    def key(self) -> dict[str, Any]:
        return {"PK": {"S": TURN_PREFIX + self.turn_id[0]}, "SK": {"S": self.turn_id}}

    def to_item(self) -> dict[str, Any]:
        item: dict[str, Any] = {
            **self.key,
            "state": {"S": self.state},
            "user_id": {"S": self.user_id},
            "agent": {"S": self.agent_id},
            "version": _n(self.agent_version),
            "model": {"S": self.model},
            "conversation_id": {"S": self.conversation_id},
            "period": {"S": self.period},
            "scopes": {"L": [{"S": scope} for scope in self.scopes]},
            "reserved": _n(self.reserved),
            "charged": _n(self.charged),
            "retained": _n(self.retained),
            "started_at": _n(self.started_at),
            "reconcile_at": _n(self.reconcile_at),
            "charge_at": _n(self.charge_at),
            "price_input": _n(self.price.input),
            "price_output": _n(self.price.output),
            "price_cache_read": _n(self.price.cache_read),
            "price_cache_write": _n(self.price.cache_write),
            **_usage_values(self.usage, prefix=""),
        }
        if self.session_id:
            item["session_id"] = {"S": self.session_id}
        return item

    @staticmethod
    def from_item(item: Mapping[str, Any]) -> PendingTurn:
        """A record as this module wrote it; anything else raises ``InvalidTurnError``."""
        try:
            turn = PendingTurn(
                turn_id=item["SK"]["S"],
                user_id=item["user_id"]["S"],
                agent_id=item["agent"]["S"],
                agent_version=int(item["version"]["N"]),
                model=item["model"]["S"],
                conversation_id=item["conversation_id"]["S"],
                period=item["period"]["S"],
                scopes=tuple(scope["S"] for scope in item["scopes"]["L"]),
                reserved=Decimal(item["reserved"]["N"]),
                started_at=int(item["started_at"]["N"]),
                reconcile_at=int(item["reconcile_at"]["N"]),
                charge_at=int(item["charge_at"]["N"]),
                price=TurnPrice(
                    input=Decimal(item["price_input"]["N"]),
                    output=Decimal(item["price_output"]["N"]),
                    cache_read=Decimal(item["price_cache_read"]["N"]),
                    cache_write=Decimal(item["price_cache_write"]["N"]),
                ),
                session_id=item.get("session_id", {}).get("S", ""),
                state=item["state"]["S"],
                charged=Decimal(item["charged"]["N"]),
                retained=Decimal(item["retained"]["N"]),
                usage=_usage_of(item, prefix=""),
                outcome=_outcome_of(item),
            )
        except (KeyError, TypeError, ValueError, ArithmeticError) as exc:
            raise InvalidTurnError("malformed pending turn") from exc
        amounts = (turn.reserved, turn.charged, turn.retained, *_prices(turn.price))
        if (
            not _TURN_ID.fullmatch(turn.turn_id)
            or item.get("PK", {}).get("S") != TURN_PREFIX + turn.turn_id[0]
            or turn.state not in (STATE_OPEN, STATE_HELD, STATE_SETTLED)
            or not _PERIOD.fullmatch(turn.period)
            or not turn.scopes
            or not all(_SCOPE.fullmatch(scope) for scope in turn.scopes)
            or (turn.session_id and not _SESSION_ID.fullmatch(turn.session_id))
            or not all(amount.is_finite() and amount >= 0 for amount in amounts)
        ):
            raise InvalidTurnError("malformed pending turn")
        return turn


def _n(value: Decimal | int) -> dict[str, str]:
    return {"N": str(value)}


def _prices(price: TurnPrice) -> tuple[Decimal, ...]:
    return (price.input, price.output, price.cache_read, price.cache_write)


def _usage_values(usage: TokenUsage, *, prefix: str) -> dict[str, Any]:
    return {
        f"{prefix}input_tokens": _n(usage.input_tokens),
        f"{prefix}output_tokens": _n(usage.output_tokens),
        f"{prefix}cache_read_tokens": _n(usage.cache_read_tokens),
        f"{prefix}cache_write_tokens": _n(usage.cache_write_tokens),
    }


def _names(*attributes: str) -> dict[str, str]:
    """``#name`` aliases: no expression depends on DynamoDB's list of reserved words."""
    return {f"#{attribute}": attribute for attribute in attributes}


def _usage_of(item: Mapping[str, Any], *, prefix: str) -> TokenUsage:
    return TokenUsage(
        int(item[f"{prefix}input_tokens"]["N"]),
        int(item[f"{prefix}output_tokens"]["N"]),
        int(item[f"{prefix}cache_read_tokens"]["N"]),
        int(item[f"{prefix}cache_write_tokens"]["N"]),
    )


def _outcome_of(item: Mapping[str, Any]) -> Outcome | None:
    if "basis" not in item:
        return None
    return Outcome(
        basis=item["basis"]["S"],
        reason=item.get("reason", {}).get("S", ""),
        usage=_usage_of(item, prefix="final_"),
        invocations=int(item["invocations"]["N"]),
        known=Decimal(item["known"]["N"]),
        ended=item["ended"]["S"],
    )


def _budget_updates(
    table: str,
    turn: PendingTurn,
    *,
    committed: Decimal,
    reserved: Decimal,
    spent: Decimal,
    held: Decimal,
) -> list[dict[str, Any]]:
    return [
        {
            "Update": {
                "TableName": table,
                "Key": {"PK": {"S": scope}, "SK": {"S": turn.period}},
                "UpdateExpression": _BUDGET_UPDATE,
                "ExpressionAttributeNames": _names(*_BUDGET_COUNTERS),
                "ExpressionAttributeValues": {
                    ":committed": _n(committed),
                    ":reserved": _n(reserved),
                    ":spent": _n(spent),
                    ":held": _n(held),
                },
            }
        }
        for scope in turn.scopes
    ]


def _transact(
    dynamodb: DynamoDBClient, items: list[dict[str, Any]], sleep: Callable[[float], None]
) -> bool:
    """Run the transaction. False: a condition did not hold and nothing was written."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            dynamodb.transact_write_items(TransactItems=items)  # type: ignore[arg-type]
        except dynamodb.exceptions.TransactionCanceledException as exc:
            reasons = {
                str(reason.get("Code")) for reason in exc.response.get("CancellationReasons", [])
            }
            if "ConditionalCheckFailed" in reasons:
                return False
            if not reasons <= _RETRYABLE or attempt == MAX_ATTEMPTS:
                raise TurnConflictError("turn accounting not recorded") from exc
            # Concurrent turns update the shared agent item: full jitter, then again.
            sleep(random.uniform(0, 0.05 * 2**attempt))  # noqa: S311
        else:
            return True
    return False


def reservation_item(table: str, turn: PendingTurn) -> dict[str, Any]:
    """The write that goes into the transaction of the reservation."""
    return {
        "Put": {
            "TableName": table,
            "Item": turn.to_item(),
            "ConditionExpression": "attribute_not_exists(PK)",
        }
    }


def bind_session(dynamodb: DynamoDBClient, table: str, turn: PendingTurn, session_id: str) -> None:
    """Record the runtime session the turn is about to be invoked in. A record without one
    never reached the agent."""
    dynamodb.update_item(
        TableName=table,
        Key=turn.key,
        UpdateExpression="SET #session_id = :session",
        ConditionExpression="attribute_exists(PK) AND #state = :open",
        ExpressionAttributeNames=_names("session_id", "state"),
        ExpressionAttributeValues={":session": {"S": session_id}, ":open": {"S": STATE_OPEN}},
    )


def settle(
    dynamodb: DynamoDBClient,
    table: str,
    turn: PendingTurn,
    actual: Decimal,
    sleep: Callable[[float], None] = time.sleep,
) -> bool:
    """The end of the turn is known: charge ``actual`` (it may exceed the reservation),
    release the reservation and delete the record. False if the turn was already closed."""
    items = [
        {
            "Delete": {
                "TableName": table,
                "Key": turn.key,
                "ConditionExpression": "attribute_exists(PK) AND #state = :open",
                "ExpressionAttributeNames": {"#state": "state"},
                "ExpressionAttributeValues": {":open": {"S": STATE_OPEN}},
            }
        },
        *_budget_updates(
            table,
            turn,
            committed=actual - turn.reserved,
            reserved=-turn.reserved,
            spent=actual,
            held=_ZERO,
        ),
    ]
    return _transact(dynamodb, items, sleep)


def hold(
    dynamodb: DynamoDBClient,
    table: str,
    turn: PendingTurn,
    usage: TokenUsage,
    sleep: Callable[[float], None] = time.sleep,
) -> PendingTurn | None:
    """The end of the turn is not known: charge the usage counted so far and keep the rest of
    the reservation held for the reconciler. None if the turn was already closed."""
    known = token_cost(usage, turn.price)
    retained = max(turn.reserved - known, _ZERO)
    items = [
        {
            "Update": {
                "TableName": table,
                "Key": turn.key,
                "UpdateExpression": (
                    "SET #state = :held, #charged = :charged, #retained = :retained, "
                    "#input_tokens = :input_tokens, #output_tokens = :output_tokens, "
                    "#cache_read_tokens = :cache_read_tokens, "
                    "#cache_write_tokens = :cache_write_tokens"
                ),
                "ConditionExpression": "attribute_exists(PK) AND #state = :open",
                "ExpressionAttributeNames": _names(
                    "state", "charged", "retained", *_usage_values(usage, prefix="")
                ),
                "ExpressionAttributeValues": {
                    ":held": {"S": STATE_HELD},
                    ":open": {"S": STATE_OPEN},
                    ":charged": _n(known),
                    ":retained": _n(retained),
                    **{
                        f":{name}": value for name, value in _usage_values(usage, prefix="").items()
                    },
                },
            }
        },
        *_budget_updates(
            table,
            turn,
            committed=known + retained - turn.reserved,
            reserved=retained - turn.reserved,
            spent=known,
            held=retained,
        ),
    ]
    if not _transact(dynamodb, items, sleep):
        return None
    return replace(turn, state=STATE_HELD, charged=known, retained=retained, usage=usage)


def due(
    dynamodb: DynamoDBClient, table: str, now: int, *, limit: int, max_pages: int = 10
) -> tuple[list[PendingTurn], int]:
    """Records the reconciler may close at ``now``: the ``limit`` oldest, and how many records
    of the table could not be read as a pending turn.

    Every partition is read (``max_pages`` pages each at most) before the oldest are chosen,
    so no partition waits behind another.
    """
    turns: list[PendingTurn] = []
    invalid = 0
    for shard in SHARDS:
        start: dict[str, Any] | None = None
        for _ in range(max_pages):
            request: dict[str, Any] = {
                "TableName": table,
                "KeyConditionExpression": "PK = :pk",
                "FilterExpression": "#reconcile_at <= :now",
                "ExpressionAttributeNames": _names("reconcile_at"),
                "ExpressionAttributeValues": {
                    ":pk": {"S": TURN_PREFIX + shard},
                    ":now": _n(now),
                },
                "ConsistentRead": True,
            }
            if start:
                request["ExclusiveStartKey"] = start
            page = dynamodb.query(**request)
            for item in page.get("Items", []):
                try:
                    turns.append(PendingTurn.from_item(item))
                except InvalidTurnError:
                    invalid += 1
            start = page.get("LastEvaluatedKey")
            if not start:
                break
    turns.sort(key=lambda turn: (turn.started_at, turn.turn_id))
    return turns[:limit], invalid


def final_cost(turn: PendingTurn, outcome: Outcome) -> Decimal:
    """What the turn costs in the end. Never less than what mango-api already counted."""
    if outcome.basis == BASIS_RESERVATION:
        return turn.charged + turn.retained
    if outcome.basis == BASIS_NOT_INVOKED:
        return turn.charged
    return max(token_cost(outcome.usage, turn.price), turn.charged)


def close(
    dynamodb: DynamoDBClient,
    table: str,
    turn: PendingTurn,
    outcome: Outcome,
    sleep: Callable[[float], None] = time.sleep,
) -> PendingTurn | None:
    """Reconciler: charge the final cost, release what was retained and mark the record
    ``settled``. None if the turn changed since it was read (someone else closed it)."""
    outcome = replace(outcome, known=turn.charged, ended=turn.state)
    final = final_cost(turn, outcome)
    delta = final - turn.charged
    items = [
        {
            "Update": {
                "TableName": table,
                "Key": turn.key,
                "UpdateExpression": (
                    "SET #state = :settled, #charged = :final, #retained = :zero, "
                    "#basis = :basis, #reason = :reason, #invocations = :invocations, "
                    "#known = :charged, #ended = :state, "
                    "#final_input_tokens = :final_input_tokens, "
                    "#final_output_tokens = :final_output_tokens, "
                    "#final_cache_read_tokens = :final_cache_read_tokens, "
                    "#final_cache_write_tokens = :final_cache_write_tokens"
                ),
                # The amounts are the ones read: a turn mango-api held in between is not
                # closed with stale numbers.
                "ConditionExpression": (
                    "attribute_exists(PK) AND #state = :state "
                    "AND #charged = :charged AND #retained = :retained"
                ),
                "ExpressionAttributeNames": _names(
                    "state",
                    "charged",
                    "retained",
                    "basis",
                    "reason",
                    "invocations",
                    "known",
                    "ended",
                    *_usage_values(outcome.usage, prefix="final_"),
                ),
                "ExpressionAttributeValues": {
                    ":settled": {"S": STATE_SETTLED},
                    ":state": {"S": turn.state},
                    ":charged": _n(turn.charged),
                    ":retained": _n(turn.retained),
                    ":final": _n(final),
                    ":zero": _n(_ZERO),
                    ":basis": {"S": outcome.basis},
                    ":reason": {"S": outcome.reason},
                    ":invocations": _n(outcome.invocations),
                    **{
                        f":{name}": value
                        for name, value in _usage_values(outcome.usage, prefix="final_").items()
                    },
                },
            }
        },
        *_budget_updates(
            table,
            turn,
            committed=delta - turn.retained,
            reserved=-turn.retained,
            spent=delta,
            # Only a held turn was counted in ``held``; an open one is a plain reservation.
            held=-turn.retained if turn.state == STATE_HELD else _ZERO,
        ),
    ]
    if turn.state == STATE_SETTLED or not _transact(dynamodb, items, sleep):
        return None
    return replace(turn, state=STATE_SETTLED, charged=final, retained=_ZERO, outcome=outcome)


def forget(dynamodb: DynamoDBClient, table: str, turn: PendingTurn) -> None:
    """Delete a settled record once its audit event is written."""
    try:
        dynamodb.delete_item(
            TableName=table,
            Key=turn.key,
            ConditionExpression="attribute_not_exists(PK) OR #state = :settled",
            ExpressionAttributeNames={"#state": "state"},
            ExpressionAttributeValues={":settled": {"S": STATE_SETTLED}},
        )
    except dynamodb.exceptions.ConditionalCheckFailedException:
        return
