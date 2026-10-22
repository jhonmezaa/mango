"""Installation settings of the knowledge synchronization, from the Lambda environment."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

_NAMESPACE_RE = re.compile(r"^[a-z0-9]{3,8}$")
_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,255}$")
_BEDROCK_ID_RE = re.compile(r"^[0-9A-Z]{10}$")
_ACCOUNT_RE = re.compile(r"^\d{12}$")
_ARN_RE = re.compile(r"^arn:aws:states:[a-z0-9-]+:\d{12}:stateMachine:[A-Za-z0-9_-]{1,80}$")


class ConfigError(Exception):
    """The Lambda environment is not what the stack should have set."""


@dataclass(frozen=True)
class Settings:
    namespace: str
    knowledge_table: str
    documents_bucket: str
    knowledge_base_id: str
    """The one Bedrock knowledge base of the installation (D88 (7))."""
    data_source_id: str
    account_id: str
    """Owner of the documents bucket, which Bedrock asks for with an S3 location."""
    state_machine_arn: str
    """This machine: a synchronization asked for while another ran starts after it."""
    budgets_table: str
    audit_stream: str
    audit_index_table: str
    embedding_price: Decimal
    """USD per million input tokens of the embedding model (rule 7)."""
    sources_function: str = ""
    """``Mango-<ns>-KnowledgeSources``: the roles of the sources (D88 (39))."""

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env
        try:
            settings = Settings(
                namespace=env["MANGO_NAMESPACE"],
                knowledge_table=env["KNOWLEDGE_TABLE"],
                documents_bucket=env["KNOWLEDGE_BUCKET"],
                knowledge_base_id=env["KNOWLEDGE_BASE_ID"],
                data_source_id=env["DATA_SOURCE_ID"],
                account_id=env["ACCOUNT_ID"],
                state_machine_arn=env["STATE_MACHINE_ARN"],
                budgets_table=env["BUDGETS_TABLE"],
                audit_stream=env["AUDIT_STREAM"],
                audit_index_table=env["AUDIT_INDEX_TABLE"],
                embedding_price=Decimal(env["EMBEDDING_PRICE"]),
                sources_function=env.get("SOURCES_FUNCTION", ""),
            )
        except KeyError as exc:
            raise ConfigError(f"missing environment variable {exc.args[0]}") from None
        except InvalidOperation:
            raise ConfigError("invalid EMBEDDING_PRICE") from None
        if not _NAMESPACE_RE.fullmatch(settings.namespace):
            raise ConfigError("invalid MANGO_NAMESPACE")
        names = (
            settings.knowledge_table,
            settings.documents_bucket,
            settings.budgets_table,
            settings.audit_stream,
            settings.audit_index_table,
        )
        if not all(_NAME_RE.fullmatch(name) for name in names):
            raise ConfigError("invalid resource name in the environment")
        if not (
            _BEDROCK_ID_RE.fullmatch(settings.knowledge_base_id)
            and _BEDROCK_ID_RE.fullmatch(settings.data_source_id)
        ):
            raise ConfigError("invalid Bedrock knowledge base or data source id")
        if not _ACCOUNT_RE.fullmatch(settings.account_id):
            raise ConfigError("invalid ACCOUNT_ID")
        if not _ARN_RE.fullmatch(settings.state_machine_arn):
            raise ConfigError("invalid STATE_MACHINE_ARN")
        if not settings.embedding_price.is_finite() or settings.embedding_price < 0:
            raise ConfigError("invalid EMBEDDING_PRICE")
        return settings
