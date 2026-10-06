"""Token usage and cost (prices are configuration, rule 7)."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from mango_api.settings import ModelPrice
from mango_core.budget_turns import TokenUsage, TurnPrice, token_cost


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
    """Conservative upper bound reserved before invoking the agent (rule 4).

    Input grows with every loop iteration (history, system prompt and tool results are
    re-sent), so the bound assumes each iteration re-reads the history plus a fixed overhead.
    """
    history_tokens = history_chars // 3 + 1
    per_iteration_input = history_tokens + 6_000
    worst = Usage(
        input_tokens=per_iteration_input * max_iterations, output_tokens=max_output_tokens
    )
    return cost(worst, price)
