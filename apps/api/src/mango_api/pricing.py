"""Token usage and cost (prices are configuration, rule 7)."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from mango_api.settings import ModelPrice
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
