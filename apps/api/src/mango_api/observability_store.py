"""Turn references of the Observability view (D108; threat model ``observability-threat-model.md``).

A span says which runtime session it belongs to (``session.id``), and that id is a digest of the
person, their access, the agent, the conversation and the generation (D73 (5)): it cannot be
read back. So when a turn binds its session (``BudgetService.bind_session``: the chat, the tasks
and the Playground), mango-api writes what it knows of the turn, keyed by that session, in the
audit index table:

    PK = TRACEREF#<day>   SK = <session.id>#<epoch seconds the turn reserved>#<turn id>

with the person (``sub``), the agent and its version, the model, the conversation or run, whether
it is a Playground test, its origin (D106), the price per million tokens the turn reserved with,
a random key that names the turn's traces in the view (D108 (3)), and a TTL of 30 days
(as ``ACTIVITY#``, D90 (6)). Metadata only: never a message, a prompt or a tool's input or output
(TM-OB7). The day partitions of the audit (``DAY#``) and of the activity are untouched.

A trace is joined with the latest reference of its session that started before it (a session
serves several turns of one conversation). The ``session.id`` never leaves mango-api.

Writing a reference never breaks the turn: a failure is logged, without the turn's data.
"""

from __future__ import annotations

import logging
import re
import secrets
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_core import usage_days
from mango_core.budget_turns import PendingTurn, TurnPrice
from mango_core.playground import PLAYGROUND_ID

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

logger = logging.getLogger(__name__)

RETENTION = timedelta(days=30)
PARTITION = "TRACEREF#"
MAX_REFS = 20_000
"""References one read may return (two days of an installation's turns at most)."""
_SESSION_RE = re.compile(r"^[0-9a-f]{64}$")
TRACE_KEY_RE = re.compile(r"^[0-9a-f]{30}$")
_SK_RE = re.compile(r"^([0-9a-f]{64})#([0-9]{10})#([A-Za-z0-9_-]{1,64})$")


class TraceRefsUnavailableError(Exception):
    """The references could not be read."""


@dataclass(frozen=True)
class TraceRef:
    session_id: str
    started_at: int
    """Epoch seconds the turn reserved: no span of its turn starts before."""
    turn_id: str
    user_id: str
    agent_id: str
    agent_version: int
    model: str
    conversation_id: str
    playground: bool
    origin: str | None
    """``chat``, ``task``, ``playground`` or ``eval`` (D106); ``None`` in an older reference."""
    price: TurnPrice
    trace_key: str
    """Random, Mango's own (D108 (3)): the id the view gives the traces of this turn."""


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: Decimal | int) -> dict[str, str]:
    return {"N": str(value)}


def _day(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, UTC).date().isoformat()


def _ref(item: dict[str, Any]) -> TraceRef | None:
    matched = _SK_RE.fullmatch(item.get("SK", {}).get("S", ""))
    key = item.get("trace_key", {}).get("S", "")
    if matched is None or not TRACE_KEY_RE.fullmatch(key):
        return None
    try:
        return TraceRef(
            session_id=matched.group(1),
            started_at=int(matched.group(2)),
            turn_id=matched.group(3),
            user_id=item["user_id"]["S"],
            agent_id=item["agent_id"]["S"],
            agent_version=int(item["agent_version"]["N"]),
            model=item["model"]["S"],
            conversation_id=item["conversation_id"]["S"],
            playground=bool(item.get("playground", {}).get("BOOL", False)),
            origin=(
                origin if usage_days.is_origin(origin := item.get("origin", {}).get("S")) else None
            ),
            price=TurnPrice(
                Decimal(item["price_input"]["N"]),
                Decimal(item["price_output"]["N"]),
                Decimal(item.get("price_cache_read", {}).get("N", "0")),
                Decimal(item.get("price_cache_write", {}).get("N", "0")),
            ),
            trace_key=key,
        )
    except (KeyError, ValueError, ArithmeticError):
        return None


class TraceRefs:
    def __init__(
        self, dynamodb: DynamoDBClient, table: str, *, clock: Callable[[], float] = time.time
    ) -> None:
        self._db = dynamodb
        self._table = table
        self._clock = clock

    def record(self, turn: PendingTurn, session_id: str) -> None:
        """Write the reference of a turn about to be invoked. Never raises."""
        if not _SESSION_RE.fullmatch(session_id):
            logger.warning("a turn reference was not written: unexpected session id")
            return
        item: dict[str, Any] = {
            "PK": _s(f"{PARTITION}{_day(turn.started_at)}"),
            "SK": _s(f"{session_id}#{turn.started_at:010d}#{turn.turn_id}"),
            "user_id": _s(turn.user_id),
            "agent_id": _s(turn.agent_id),
            "agent_version": _n(turn.agent_version),
            "model": _s(turn.model),
            "conversation_id": _s(turn.conversation_id),
            "playground": {"BOOL": turn.cost_agent == PLAYGROUND_ID},
            **(
                {"origin": _s(turn.origin)}
                if turn.origin and usage_days.is_origin(turn.origin)
                else {}
            ),
            "price_input": _n(turn.price.input),
            "price_output": _n(turn.price.output),
            "price_cache_read": _n(turn.price.cache_read),
            "price_cache_write": _n(turn.price.cache_write),
            "trace_key": _s(secrets.token_hex(15)),
            "ttl": _n(int(self._clock() + RETENTION.total_seconds())),
        }
        try:
            self._db.put_item(TableName=self._table, Item=item)
        except (BotoCoreError, ClientError):
            # The turn goes on: its trace is shown without its person (TM-OB7).
            logger.warning("a turn reference could not be written")

    def read(self, days: Iterable[date], *, cap: int = MAX_REFS) -> tuple[list[TraceRef], bool]:
        """The references of ``days``, and whether ``cap`` cut them."""
        refs: list[TraceRef] = []
        for day in days:
            request: dict[str, Any] = {
                "TableName": self._table,
                "KeyConditionExpression": "PK = :pk",
                "ExpressionAttributeValues": {":pk": _s(f"{PARTITION}{day.isoformat()}")},
            }
            while True:
                try:
                    resp = self._db.query(**request)
                except (BotoCoreError, ClientError) as exc:
                    raise TraceRefsUnavailableError from exc
                for item in resp.get("Items", []):
                    ref = _ref(item)
                    if ref is None:
                        continue
                    if len(refs) >= cap:
                        return refs, True
                    refs.append(ref)
                start = resp.get("LastEvaluatedKey")
                if not start:
                    break
                request["ExclusiveStartKey"] = start
        return refs, False
