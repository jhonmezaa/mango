"""Installation settings of the CUR reconciler, from the Lambda environment (D104)."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

_NAMESPACE_RE = re.compile(r"^[a-z0-9]{3,8}$")
_ACCOUNT_RE = re.compile(r"^[0-9]{12}$")
_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,255}$")
_GLUE_RE = re.compile(r"^[a-z0-9_]{1,128}$")
_PRODUCT_RE = re.compile(r"^[A-Za-z0-9_.-]{2,64}$")
_WORDS_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}[A-Za-z0-9]$")
MAX_PRODUCT_CODES = 10


class ConfigError(Exception):
    """The Lambda environment is not what the stack should have set."""


@dataclass(frozen=True)
class Settings:
    namespace: str
    account_id: str
    """The installation's account: the only usage account the export may bring (TM-CUR1)."""
    budgets_table: str
    audit_stream: str
    audit_index_table: str
    database: str
    table: str
    workgroup: str
    product_codes: frozenset[str]
    """Bedrock's product codes in the bill."""
    marketplace_entity: str
    product_family: str
    """A Bedrock model sold through AWS Marketplace (precision of D104 of 2026-11-06): a row of
    that billing entity and of Bedrock's product family, whatever its product code. Any other row
    is an unexpected one."""
    threshold_percent: Decimal
    threshold_usd: Decimal
    """A day of an agent deviates when the difference passes both thresholds."""

    @property
    def agent_role_prefix(self) -> str:
        """``Mango-<ns>-agent-``: the roles of the agents and of the Playground (D10, D91)."""
        return f"Mango-{self.namespace}-agent-"

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env
        try:
            codes = frozenset(c for c in env["BEDROCK_PRODUCT_CODES"].split(",") if c)
            settings = Settings(
                namespace=env["MANGO_NAMESPACE"],
                account_id=env["MANGO_ACCOUNT_ID"],
                budgets_table=env["BUDGETS_TABLE"],
                audit_stream=env["AUDIT_STREAM"],
                audit_index_table=env["AUDIT_INDEX_TABLE"],
                database=env["CUR_DATABASE"],
                table=env["CUR_TABLE"],
                workgroup=env["CUR_WORKGROUP"],
                product_codes=codes,
                marketplace_entity=env["MARKETPLACE_BILLING_ENTITY"],
                product_family=env["BEDROCK_PRODUCT_FAMILY"],
                threshold_percent=Decimal(env["THRESHOLD_PERCENT"]),
                threshold_usd=Decimal(env["THRESHOLD_USD"]),
            )
        except KeyError as exc:
            raise ConfigError(f"missing environment variable {exc.args[0]}") from None
        except InvalidOperation:
            raise ConfigError("invalid threshold") from None
        if not _NAMESPACE_RE.fullmatch(settings.namespace):
            raise ConfigError("invalid MANGO_NAMESPACE")
        if not _ACCOUNT_RE.fullmatch(settings.account_id):
            raise ConfigError("invalid MANGO_ACCOUNT_ID")
        for name in (
            settings.budgets_table,
            settings.audit_stream,
            settings.audit_index_table,
            settings.workgroup,
        ):
            if not _NAME_RE.fullmatch(name):
                raise ConfigError("invalid resource name in the environment")
        if not _GLUE_RE.fullmatch(settings.database) or not _GLUE_RE.fullmatch(settings.table):
            # They are written into the query text: only what a Glue name can be.
            raise ConfigError("invalid CUR_DATABASE or CUR_TABLE")
        if (
            not codes
            or len(codes) > MAX_PRODUCT_CODES
            or not all(_PRODUCT_RE.fullmatch(c) for c in codes)
        ):
            raise ConfigError("invalid BEDROCK_PRODUCT_CODES")
        if not _WORDS_RE.fullmatch(settings.marketplace_entity) or not _WORDS_RE.fullmatch(
            settings.product_family
        ):
            raise ConfigError("invalid MARKETPLACE_BILLING_ENTITY or BEDROCK_PRODUCT_FAMILY")
        for value in (settings.threshold_percent, settings.threshold_usd):
            if not value.is_finite() or value < 0:
                raise ConfigError("invalid threshold")
        return settings
