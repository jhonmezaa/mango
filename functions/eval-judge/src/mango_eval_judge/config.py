"""Environment of ``Mango-<ns>-EvalJudge`` (set by the stack, validated once)."""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from types import MappingProxyType

_NAMESPACE_RE = re.compile(r"^[a-z0-9]{3,8}$")
_ACCOUNT_RE = re.compile(r"^\d{12}$")
_REGION_RE = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d$")
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.:_-]{0,127}$")
_EVALUATOR_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9-_]{0,99}-[a-zA-Z0-9]{10}$")
_GUARDRAIL_ID_RE = re.compile(r"^[a-z0-9]{1,64}$")
_GUARDRAIL_VERSION_RE = re.compile(r"^[1-9][0-9]{0,7}$")
MAX_JUDGES = 5


class ConfigError(Exception):
    """The Lambda environment is not what the stack should have set."""


def _match(pattern: re.Pattern[str], name: str, value: str) -> str:
    if not pattern.fullmatch(value):
        raise ConfigError(f"invalid {name}")
    return value


def _prices(raw: str) -> Mapping[str, tuple[Decimal, Decimal]]:
    """USD per million input and output tokens of the canary's model and of every judge model
    (rule 7: prices are configuration)."""
    try:
        data = json.loads(raw)
        prices = {
            str(model): (Decimal(str(p["input"])), Decimal(str(p["output"])))
            for model, p in data.items()
        }
    except (ValueError, KeyError, TypeError, AttributeError, InvalidOperation):
        raise ConfigError("invalid MODEL_PRICES") from None
    if not prices or any(v < 0 for pair in prices.values() for v in pair):
        raise ConfigError("invalid MODEL_PRICES")
    return MappingProxyType(prices)


def _evaluators(raw: str) -> Mapping[str, str]:
    """Judge model -> evaluator id: the custom evaluators of the release, one per judge model
    of the installation config (D110 (8))."""
    try:
        data = json.loads(raw)
    except ValueError:
        raise ConfigError("invalid EVALUATORS") from None
    if not isinstance(data, dict) or not 0 < len(data) <= MAX_JUDGES:
        raise ConfigError("invalid EVALUATORS")
    out: dict[str, str] = {}
    for model, evaluator in data.items():
        if not (
            isinstance(model, str)
            and _MODEL_RE.fullmatch(model)
            and isinstance(evaluator, str)
            and _EVALUATOR_RE.fullmatch(evaluator)
        ):
            raise ConfigError("invalid EVALUATORS")
        out[model] = evaluator
    return MappingProxyType(out)


@dataclass(frozen=True)
class Settings:
    namespace: str
    region: str
    account_id: str
    settings_table: str
    budgets_table: str
    evaluators: Mapping[str, str]
    canary_model: str
    prices: Mapping[str, tuple[Decimal, Decimal]]
    """Of the canary's model and of every judge model."""
    evaluation_fee: Decimal
    """USD per evaluation of a custom evaluator (AgentCore pricing, 2026-11-05: 1.50 per 1,000)."""
    canary_monthly_usd: Decimal
    guardrail_id: str
    guardrail_version: str
    spans_log_group: str = "aws/spans"

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env
        try:
            settings = Settings(
                namespace=_match(_NAMESPACE_RE, "MANGO_NAMESPACE", env["MANGO_NAMESPACE"]),
                region=_match(_REGION_RE, "AWS_REGION", env["AWS_REGION"]),
                account_id=_match(_ACCOUNT_RE, "MANGO_ACCOUNT_ID", env["MANGO_ACCOUNT_ID"]),
                settings_table=env["SETTINGS_TABLE"],
                budgets_table=env["BUDGETS_TABLE"],
                evaluators=_evaluators(env["EVALUATORS"]),
                canary_model=_match(_MODEL_RE, "CANARY_MODEL", env["CANARY_MODEL"]),
                prices=_prices(env["MODEL_PRICES"]),
                evaluation_fee=Decimal(env["EVALUATION_FEE_USD"]),
                canary_monthly_usd=Decimal(env["CANARY_MONTHLY_USD"]),
                guardrail_id=_match(_GUARDRAIL_ID_RE, "GUARDRAIL_ID", env["GUARDRAIL_ID"]),
                guardrail_version=_match(
                    _GUARDRAIL_VERSION_RE, "GUARDRAIL_VERSION", env["GUARDRAIL_VERSION"]
                ),
            )
        except KeyError as exc:
            raise ConfigError(f"missing environment variable {exc.args[0]}") from None
        except InvalidOperation:
            raise ConfigError("invalid amount") from None
        settings_check = settings
        missing = {settings_check.canary_model, *settings_check.evaluators} - set(
            settings_check.prices
        )
        if missing:
            raise ConfigError("a model without a price")
        return settings_check

    @property
    def harness_prefix(self) -> str:
        base = f"arn:aws:bedrock-agentcore:{self.region}:{self.account_id}"
        return f"{base}:harness/Mango_{self.namespace}_a_evals-"

    def runtime_log_groups(self, runtime_id: str) -> tuple[str, ...]:
        """The evals runtime's own log groups (one per endpoint), where its spans and their
        content go (D110 (8)). Only names of this installation's evals runtime."""
        expected = re.compile(rf"^harness_Mango_{self.namespace}_a_evals-[A-Za-z0-9]{{10}}$")
        if not expected.fullmatch(runtime_id):
            raise ValueError("not the evals runtime")
        prefix = "/aws/bedrock-agentcore/runtimes/"
        return (f"{prefix}{runtime_id}-DEFAULT", f"{prefix}{runtime_id}-live")
