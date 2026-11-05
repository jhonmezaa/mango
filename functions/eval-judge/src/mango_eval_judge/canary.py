"""The canary of the evals harness (D110 (8)): fails closed.

After the provisioner deploys a version of the evals harness it writes ``EVALS`` / ``CAPTURE``
as ``pending`` and asks for this. The canary sends one short turn with a random marker (no
tools, the release's cheapest model, a 64-token cap) and checks, before any eval may run:

1. the marker reaches the evals runtime's own log group (content is captured where agreed);
2. the marker never reaches ``aws/spans``, the log group of the whole account (D16, D73);
3. ``Evaluate`` scores that session with the first judge of the installation (the service
   accepts the managed harness's traces).

Only then it writes ``verified`` for that harness version. Any other result, or any error, is
``failed`` with a fixed reason and an error log line the alarm counts: mango-api runs no eval.
The canary only ever saw its own marker, never content of a case.

Its cost is reserved first (rule 4) in a scope of its own, ``AGENT#evals``, with the monthly cap
of the release, and closed like a turn (D73), from origin ``eval`` (decided 2026-11-05).
"""

from __future__ import annotations

import logging
import secrets
import time
from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_core import budget_turns, usage_days
from mango_core.evals_harness import (
    EVALS_ID,
    HARNESS_SK,
    SETTINGS_PK,
    Capture,
    EvalsHarness,
)
from mango_eval_judge import judge, spans
from mango_eval_judge.config import Settings

if TYPE_CHECKING:
    from mypy_boto3_bedrock_agentcore import BedrockAgentCoreClient
    from mypy_boto3_dynamodb import DynamoDBClient
    from mypy_boto3_logs import CloudWatchLogsClient

logger = logging.getLogger(__name__)

CANARY_USER = "mango-canary"
"""Whom the canary's turn is recorded for: no person. Its day counter only ever holds this."""
MAX_TOKENS = 64
TIMEOUT_SECONDS = 60
POLL_SECONDS = 30
MAX_WAIT_SECONDS = 9 * 60
"""Traces arrive in CloudWatch 2 to 5 minutes after a turn; the function times out at 15."""
SHARED_LOG_SETTLE_SECONDS = 60
"""After the marker is in its own log group, how long until ``aws/spans`` is read: spans of a
turn land together, within seconds of each other."""
_ZERO = Decimal(0)
_MILLION = Decimal(1_000_000)


class CanaryFailedError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class Canary:
    def __init__(
        self,
        settings: Settings,
        *,
        dynamodb: DynamoDBClient,
        logs: CloudWatchLogsClient,
        agentcore: BedrockAgentCoreClient,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._s = settings
        self._db = dynamodb
        self._logs = logs
        self._ac = agentcore
        self._clock = clock
        self._sleep = sleep

    # --- Settings items -------------------------------------------------------------------

    def _harness(self, version: str) -> EvalsHarness:
        item = self._db.get_item(
            TableName=self._s.settings_table,
            Key={"PK": {"S": SETTINGS_PK}, "SK": {"S": HARNESS_SK}},
            ConsistentRead=True,
        ).get("Item")
        if item is None:
            raise CanaryFailedError("harness_unknown")
        try:
            harness = EvalsHarness.from_item(item)
        except ValueError:
            raise CanaryFailedError("harness_unknown") from None
        if (
            harness.deployed.harness_version != version
            or not harness.deployed.harness_arn.startswith(self._s.harness_prefix)
        ):
            # A newer version was deployed meanwhile: its own canary decides.
            raise CanaryFailedError("harness_changed")
        return harness

    def _write(self, capture: Capture) -> None:
        """Only for the version it checked: a newer ``pending`` is never overwritten."""
        try:
            self._db.put_item(
                TableName=self._s.settings_table,
                Item=capture.item(),
                ConditionExpression="attribute_not_exists(PK) OR harness_version = :v",
                ExpressionAttributeValues={":v": {"S": capture.harness_version}},
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise

    # --- Budget (rule 4) ------------------------------------------------------------------

    def _price(self, model: str) -> budget_turns.TurnPrice:
        input_price, output_price = self._s.prices[model]
        return budget_turns.TurnPrice(
            input=input_price / _MILLION,
            output=output_price / _MILLION,
            cache_read=_ZERO,
            cache_write=_ZERO,
        )

    def _reserve(
        self,
        model: str,
        started: int,
        *,
        input_tokens: int,
        output_tokens: int,
        fee: Decimal = _ZERO,
    ) -> budget_turns.PendingTurn:
        price = self._price(model)
        estimate = (
            Decimal(input_tokens) * price.input + Decimal(output_tokens) * price.output + fee
        ).quantize(Decimal("0.000001"))
        turn_id = secrets.token_hex(16)
        period = datetime.fromtimestamp(started, UTC).strftime("%Y-%m")
        turn = budget_turns.PendingTurn.new(
            turn_id=turn_id,
            user_id=CANARY_USER,
            agent_id=EVALS_ID,
            agent_version=0,
            model=model,
            conversation_id=turn_id,
            period=period,
            scopes=(f"AGENT#{EVALS_ID}",),
            reserved=estimate,
            price=price,
            started_at=started,
            timeout_seconds=TIMEOUT_SECONDS,
            cost_agent=EVALS_ID,
            origin=usage_days.ORIGIN_EVAL,
        )
        limit = self._s.canary_monthly_usd
        if limit - estimate < 0:
            # As BudgetService: the condition alone lets the first reservation of a month pass.
            raise CanaryFailedError("budget_exceeded")
        try:
            self._db.transact_write_items(
                TransactItems=[
                    budget_turns.reservation_item(self._s.budgets_table, turn),  # type: ignore[list-item]
                    {
                        "Update": {
                            "TableName": self._s.budgets_table,
                            "Key": {"PK": {"S": f"AGENT#{EVALS_ID}"}, "SK": {"S": period}},
                            "UpdateExpression": "ADD committed :amt, reserved :amt SET #l = :limit",
                            "ConditionExpression": (
                                "attribute_not_exists(committed) OR committed <= :headroom"
                            ),
                            "ExpressionAttributeNames": {"#l": "limit"},
                            "ExpressionAttributeValues": {
                                ":amt": {"N": str(estimate)},
                                ":headroom": {"N": str(limit - estimate)},
                                ":limit": {"N": str(limit)},
                            },
                        }
                    },
                ]
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "TransactionCanceledException":
                raise CanaryFailedError("budget_exceeded") from None
            raise
        return turn

    # --- The turn -------------------------------------------------------------------------

    def _invoke(
        self, harness: EvalsHarness, session_id: str, marker: str
    ) -> budget_turns.TokenUsage:
        request: dict[str, Any] = {
            "harnessArn": harness.deployed.harness_arn,
            "qualifier": "live",
            "runtimeSessionId": session_id,
            "actorId": CANARY_USER,
            "messages": [{"role": "user", "content": [{"text": f"Repite exactamente: {marker}"}]}],
            "systemPrompt": [{"text": "Responde solo con el texto que se te pide repetir."}],
            "tools": [],
            "allowedTools": [],
            "maxIterations": 1,
            "maxTokens": MAX_TOKENS,
            "timeoutSeconds": TIMEOUT_SECONDS,
            "model": {
                "bedrockModelConfig": {
                    "modelId": self._s.canary_model,
                    "maxTokens": MAX_TOKENS,
                    "additionalParams": {
                        "guardrailConfig": {
                            "guardrailIdentifier": self._s.guardrail_id,
                            "guardrailVersion": self._s.guardrail_version,
                            "trace": "disabled",
                        }
                    },
                }
            },
        }
        tokens_in = tokens_out = 0
        response = self._ac.invoke_harness(**request)
        for event in response["stream"]:
            usage = event.get("metadata", {}).get("usage", {}) if isinstance(event, dict) else {}
            tokens_in += int(usage.get("inputTokens", 0) or 0)
            tokens_out += int(usage.get("outputTokens", 0) or 0)
        return budget_turns.TokenUsage(input_tokens=tokens_in, output_tokens=tokens_out)

    # --- Run ------------------------------------------------------------------------------

    def run(self, harness_version: str) -> Capture:
        now = datetime.now(UTC).isoformat(timespec="seconds")
        try:
            self._check(harness_version)
        except CanaryFailedError as exc:
            if exc.reason == "harness_changed":
                logger.info("a newer evals harness was deployed; its canary decides")
                return Capture("pending", harness_version, now)
            capture = Capture("failed", harness_version, now, exc.reason)
            # The alarm counts this line (D110 (8)): evals stay off until a release fixes it.
            logger.error("evals canary failed: %s", exc.reason)  # noqa: TRY400 - a code only
            self._write(capture)
            return capture
        capture = Capture("verified", harness_version, now)
        self._write(capture)
        logger.info("evals canary verified harness version %s", harness_version)
        return capture

    def _check(self, harness_version: str) -> None:
        harness = self._harness(harness_version)
        if self._s.canary_model not in harness.deployed.models:
            raise CanaryFailedError("canary_model_not_enabled")
        groups = self._s.runtime_log_groups(harness.runtime_id)
        marker = secrets.token_hex(16)
        session_id = "mango-canary-" + secrets.token_hex(24)
        started = int(self._clock())
        # The marker prompt is under 200 tokens; the answer is capped (rule 4: reserved first).
        turn = self._reserve(
            self._s.canary_model, started, input_tokens=200, output_tokens=MAX_TOKENS
        )
        usage = budget_turns.TokenUsage()
        try:
            budget_turns.bind_session(self._db, self._s.budgets_table, turn, session_id)
            usage = self._invoke(harness, session_id, marker)
        except (ClientError, BotoCoreError) as exc:
            logger.error("evals canary turn failed: %s", type(exc).__name__)  # noqa: TRY400 - no content
            raise CanaryFailedError("turn_failed") from None
        finally:
            cost = budget_turns.token_cost(usage, turn.price)
            budget_turns.settle(self._db, self._s.budgets_table, turn, cost)
        start_ms = started * 1000 - 60_000
        waited = 0
        while True:
            end_ms = int(self._clock() * 1000) + 60_000
            if spans.marker_count(self._logs, groups[1], marker, start_ms, end_ms):
                break
            if waited >= MAX_WAIT_SECONDS:
                raise CanaryFailedError("no_content")
            self._sleep(POLL_SECONDS)
            waited += POLL_SECONDS
        self._sleep(SHARED_LOG_SETTLE_SECONDS)
        end_ms = int(self._clock() * 1000) + 60_000
        if spans.marker_count(self._logs, self._s.spans_log_group, marker, start_ms, end_ms):
            raise CanaryFailedError("content_in_shared_log")
        first_judge = sorted(self._s.evaluators)[0]
        # The smoke Evaluate, reserved first too: a one-turn session and the judge's answer.
        judge_turn = self._reserve(
            first_judge,
            started,
            input_tokens=judge.ESTIMATED_INPUT_TOKENS,
            output_tokens=judge.MAX_OUTPUT_TOKENS,
            fee=self._s.evaluation_fee,
        )
        verdict = judge.score(
            self._s,
            self._logs,
            self._ac,
            groups=groups,
            session_id=session_id,
            expected=marker,
            judge_model=first_judge,
            start_ms=start_ms,
            end_ms=end_ms,
        )
        usage = budget_turns.TokenUsage(
            input_tokens=verdict.input_tokens, output_tokens=verdict.output_tokens
        )
        cost = budget_turns.token_cost(usage, judge_turn.price) + (
            self._s.evaluation_fee * verdict.evaluations
        )
        budget_turns.settle(self._db, self._s.budgets_table, judge_turn, cost)
        if verdict.status != "scored":
            raise CanaryFailedError(f"evaluate_{verdict.status}")
