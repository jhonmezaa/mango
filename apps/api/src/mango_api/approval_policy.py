"""Which confirmation a write tool call needs (D27, TM-W4).

Pure decisions, no I/O. The policy of a tool says when a call needs other people: always, above
an amount, above a number of resources, or in one environment. Below the threshold the person
who asked confirms it; above it, N approvers other than that person.

The tier is computed here from the call's real arguments and the stored policy, never from
the model's text. Which argument is the amount, the count or the environment is release data
(the connector manifest), not something a call can choose. **Fail closed:** a missing value,
one that is not a positive finite JSON number, an unknown environment or a tool that does not
declare the value all mean approvers.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
from typing import Any

EXPIRY_HOURS = (1, 4, 24, 48, 72)
MIN_APPROVERS = 1
MAX_APPROVERS = 3
ENVIRONMENTS = ("prod", "staging")
MAX_AMOUNT_USD = Decimal("1000000000")
MAX_COUNT = 100_000


class Condition(StrEnum):
    ALWAYS = "always"
    AMOUNT = "amount"
    COUNT = "count"
    ENVIRONMENT = "environment"


class Tier(StrEnum):
    SELF = "self"
    """The person who asked confirms it in the chat."""
    APPROVERS = "approvers"
    """N people other than the person who asked."""


class TierReason(StrEnum):
    ALWAYS = "always"
    ABOVE = "above"
    BELOW = "below"
    UNKNOWN = "unknown"
    """The value the policy needs is missing or cannot be read: approvers (fail closed)."""


@dataclass(frozen=True)
class Policy:
    condition: Condition = Condition.ALWAYS
    amount_usd: Decimal | None = None
    count: int | None = None
    environment: str | None = None
    approvers: int = 1
    expires_hours: int = 24
    version: int = 0
    """Optimistic-locking version of the stored policy; 0 means the default was never set."""

    def __post_init__(self) -> None:
        if not MIN_APPROVERS <= self.approvers <= MAX_APPROVERS:
            raise ValueError("approvers out of range")
        if self.expires_hours not in EXPIRY_HOURS:
            raise ValueError("invalid expiry")
        if self.condition is Condition.AMOUNT and not (
            self.amount_usd is not None and 0 < self.amount_usd <= MAX_AMOUNT_USD
        ):
            raise ValueError("an amount policy needs a positive amount")
        if self.condition is Condition.COUNT and not (
            self.count is not None and 1 <= self.count <= MAX_COUNT
        ):
            raise ValueError("a count policy needs a count of at least 1")
        if self.condition is Condition.ENVIRONMENT and self.environment not in ENVIRONMENTS:
            raise ValueError("an environment policy needs a known environment")

    def same_rule(self, other: Policy) -> bool:
        """Equal in everything an administrator can change (the version is not one)."""
        return self.rule() == other.rule()

    def rule(self) -> dict[str, Any]:
        """The policy as stored and shown: only the threshold its condition uses."""
        out: dict[str, Any] = {
            "condition": self.condition.value,
            "approvers": self.approvers,
            "expires_hours": self.expires_hours,
        }
        if self.condition is Condition.AMOUNT:
            out["amount_usd"] = str(self.amount_usd)
        elif self.condition is Condition.COUNT:
            out["count"] = self.count
        elif self.condition is Condition.ENVIRONMENT:
            out["environment"] = self.environment
        return out


DEFAULT_POLICY = Policy()
"""A write tool nobody configured: every call needs one approver, within 24 hours."""


@dataclass(frozen=True)
class TierInputs:
    """Names of the arguments of a tool that carry the amount, the count and the environment
    (release data, from the connector manifest)."""

    amount: str | None = None
    count: str | None = None
    environment: str | None = None

    def conditions(self) -> tuple[Condition, ...]:
        """Conditions a policy of this tool may use: only the ones it has a value for."""
        return (
            Condition.ALWAYS,
            *((Condition.AMOUNT,) if self.amount else ()),
            *((Condition.COUNT,) if self.count else ()),
            *((Condition.ENVIRONMENT,) if self.environment else ()),
        )


@dataclass(frozen=True)
class Decision:
    tier: Tier
    reason: TierReason


def _number(value: object) -> Decimal | None:
    """A positive, finite JSON number. Booleans and strings are not numbers here: a model
    that sends ``"5"`` or ``true`` gets the approvers tier."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    number = Decimal(str(value))
    return number if number > 0 else None


def _threshold(value: Decimal | None, limit: Decimal | int | None) -> Decision:
    """Above the limit other people decide; up to it, the person who asked."""
    if value is None or limit is None:
        return Decision(Tier.APPROVERS, TierReason.UNKNOWN)
    if value > limit:
        return Decision(Tier.APPROVERS, TierReason.ABOVE)
    return Decision(Tier.SELF, TierReason.BELOW)


def _environment(value: object, policy: Policy) -> Decision:
    if not isinstance(value, str) or value not in ENVIRONMENTS:
        return Decision(Tier.APPROVERS, TierReason.UNKNOWN)
    if value == policy.environment:
        return Decision(Tier.APPROVERS, TierReason.ABOVE)
    return Decision(Tier.SELF, TierReason.BELOW)


def decide(policy: Policy, inputs: TierInputs, arguments: Mapping[str, Any]) -> Decision:
    """The tier of one call. ``arguments`` are the ones the tool would run with."""
    condition = policy.condition
    if condition is Condition.AMOUNT:
        amount = _number(arguments.get(inputs.amount)) if inputs.amount else None
        return _threshold(amount, policy.amount_usd)
    if condition is Condition.COUNT:
        count = _number(arguments.get(inputs.count)) if inputs.count else None
        whole = count if count is not None and count == count.to_integral_value() else None
        return _threshold(whole, policy.count)
    if condition is Condition.ENVIRONMENT:
        value = arguments.get(inputs.environment) if inputs.environment else None
        return _environment(value, policy)
    return Decision(Tier.APPROVERS, TierReason.ALWAYS)
