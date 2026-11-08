"""Token usage and cost (prices are configuration, rule 7)."""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from mango_api.settings import ModelPrice
from mango_core import code_sandbox
from mango_core.agents import AgentDefinition
from mango_core.budget_turns import TokenUsage, TurnPrice, token_cost
from mango_core.knowledge_search import MAX_QUERY_CHARS, query_tokens


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

    def add(self, other: Usage) -> None:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.cache_read_tokens += other.cache_read_tokens
        self.cache_write_tokens += other.cache_write_tokens

    @staticmethod
    def from_bedrock(usage: Mapping[str, Any]) -> Usage:
        return Usage(
            input_tokens=int(usage.get("inputTokens", 0)),
            output_tokens=int(usage.get("outputTokens", 0)),
            cache_read_tokens=int(usage.get("cacheReadInputTokens", 0)),
            cache_write_tokens=int(usage.get("cacheWriteInputTokens", 0)),
        )

    def tokens(self) -> TokenUsage:
        return TokenUsage(
            self.input_tokens, self.output_tokens, self.cache_read_tokens, self.cache_write_tokens
        )


def turn_price(price: ModelPrice) -> TurnPrice:
    """The price as a turn's pending record keeps it (D73)."""
    return TurnPrice(price.input, price.output, price.cache_read, price.cache_write)


def cost(usage: Usage, price: ModelPrice) -> Decimal:
    return token_cost(usage.tokens(), turn_price(price))


def estimate_max_cost(
    price: ModelPrice, history_chars: int, max_iterations: int, max_output_tokens: int
) -> Decimal:
    """What a turn reserves before invoking the agent (rule 4). An estimate, not a ceiling.

    Input grows with every loop iteration (history, system prompt and tool results are
    re-sent), so the estimate assumes each iteration re-reads the history plus a fixed
    overhead. Output is counted once: ``max_output_tokens`` is never less than the cap of one
    model call (D74), so one call cannot outrun it; a turn of several long calls can, and
    what it spends above the reservation is charged all the same.
    """
    history_tokens = history_chars // 3 + 1
    per_iteration_input = history_tokens + 6_000
    worst = Usage(
        input_tokens=per_iteration_input * max_iterations, output_tokens=max_output_tokens
    )
    return cost(worst, price)


_MILLION = Decimal(1_000_000)


def knowledge_cost(searches: int, embedding_price: Decimal) -> Decimal:
    """What ``searches`` knowledge searches of a turn cost (D88 (14)): the embedding of each
    query, counted as the longest one (1,000 characters, about 250 tokens), at the price of
    the embedding model (USD per million tokens, rule 7). The query to S3 Vectors is left to
    the reconciliation against the bill (§4.5). An estimate that never falls short."""
    tokens = searches * query_tokens("x" * MAX_QUERY_CHARS)
    return (Decimal(tokens) * embedding_price / _MILLION).quantize(Decimal("0.000001"))


logger = logging.getLogger(__name__)


class CodeUnavailableError(Exception):
    """A version that runs code, without the sandbox prices: it cannot reserve (fail closed)."""


def code_reservation(definition: AgentDefinition, prices: code_sandbox.Prices | None) -> Decimal:
    """What the code cells of one turn of ``definition`` may cost (``_code_reserve``, D115 (1)):
    its cells at the cutoff and one new session, at the prices of the configuration (rule 7)."""
    if not definition.code_interpreter:
        return Decimal(0)
    if prices is None:
        raise CodeUnavailableError
    return code_sandbox.reserve(definition.limits.max_iterations, prices)


CodeUses = Callable[[str, str], list[code_sandbox.CellUse]]
"""``(user_id, turn_id) -> uses``: the cells of a turn as the connector metered them."""


def code_charge(
    uses: CodeUses | None, user_id: str, turn_id: str, prices: code_sandbox.Prices | None
) -> Decimal:
    """What the code cells of a turn cost (D115 (3)). When they cannot be read, the most a turn
    may run: "I do not know" is never "nothing" (D73). Never raises."""
    if prices is None:
        return Decimal(0)
    if uses is None:
        logger.error("the code cells of a turn have no reader")
        return code_sandbox.reserve(code_sandbox.CELLS_PER_TURN, prices)
    try:
        return code_sandbox.cost(uses(user_id, turn_id), prices)
    except Exception:
        logger.exception("the code cells of a turn could not be read")
        return code_sandbox.reserve(code_sandbox.CELLS_PER_TURN, prices)


JUDGE_INPUT_TOKENS = 6000
"""What a judge reservation counts for its input (``mango_eval_judge.judge``)."""
JUDGE_OUTPUT_TOKENS = 512


def eval_case_reservation(
    price: ModelPrice,
    question_chars: int,
    max_iterations: int,
    max_output_tokens: int,
    knowledge_price: Decimal | None,
) -> Decimal:
    """What one case of an eval reserves before its turn (rule 4, D111 (3)): a turn of the
    version, plus its knowledge searches when the version has knowledge bases."""
    estimate = estimate_max_cost(price, question_chars, max_iterations, max_output_tokens)
    if knowledge_price is not None:
        estimate += knowledge_cost(max_iterations, knowledge_price)
    return estimate


def judge_reservation(price: ModelPrice, evaluation_fee: Decimal) -> Decimal:
    """What the judging of one case reserves on the agent's budget (D111 (3)): the judge model's
    tokens (prices are per million tokens) and the fee of one evaluation."""
    worst = Usage(input_tokens=JUDGE_INPUT_TOKENS, output_tokens=JUDGE_OUTPUT_TOKENS)
    return cost(worst, price) + evaluation_fee
