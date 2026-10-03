"""Model catalog (Brains, D38): models and prices as configuration (rule 7).

Item ``MODELS`` / ``CATALOG`` of the Settings table: ``models`` (JSON list), ``version`` (the
optimistic lock of the whole catalog) and ``refreshed_at`` (last time Bedrock was asked).
IaC seeds it put-if-absent from ``models`` and ``modelPrices`` of the installation config;
after that the table is authoritative and administrators edit it from the Brains screen
(``mango_api.models``).

Agent rules only accept models that are enabled here. A missing or malformed catalog raises
``ModelCatalogUnavailableError`` so callers fail closed.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Annotated, Any

from botocore.exceptions import BotoCoreError, ClientError
from pydantic import BaseModel, ConfigDict, Field, StrictBool, TypeAdapter, ValidationError

from mango_api.settings_store import VersionConflictError, iso
from mango_core.agents import MODEL_ID_PATTERN

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

PK_MODELS = "MODELS"
SK_CATALOG = "CATALOG"
MAX_CATALOG_MODELS = 100

MAX_REASON_CHARS = 500

Usd = Annotated[Decimal, Field(ge=0, le=100_000)]
# Who confirmed or disabled a model, as shown to administrators (email, or the ``sub``).
Label = Annotated[str, Field(min_length=1, max_length=254)]
Timestamp = Annotated[str, Field(min_length=1, max_length=40)]


class ModelCatalogUnavailableError(Exception):
    """The model catalog could not be read or is invalid; callers fail closed."""


class ModelEntry(BaseModel):
    """A Bedrock model of the installation. Prices are USD per 1M tokens."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: Annotated[str, Field(pattern=MODEL_ID_PATTERN)]
    """Bedrock inference profile id."""
    name: Annotated[str, Field(min_length=1, max_length=128)]
    provider: Annotated[str, Field(min_length=1, max_length=60)]
    enabled: StrictBool
    supports_tools: StrictBool
    input_usd: Usd
    output_usd: Usd
    cache_read_usd: Usd
    cache_write_usd: Usd
    # Everything below is written by the Brains screen; the IaC seed does not set it.
    supports_vision: StrictBool = False
    context_tokens: Annotated[int, Field(strict=True, ge=1_000, le=100_000_000)] | None = None
    """Context size from the release capabilities; ``None`` when the release does not know it."""
    in_bedrock: StrictBool | None = None
    """Whether Bedrock listed the model in the last refresh; ``None`` until the first one."""
    confirmed_by: Label | None = None
    """Administrator who confirmed the prices; ``None`` while they are the seeded ones."""
    confirmed_at: Timestamp | None = None
    disabled_by: Label | None = None
    disabled_at: Timestamp | None = None
    disabled_reason: Annotated[str, Field(max_length=MAX_REASON_CHARS)] | None = None


_MODELS: TypeAdapter[tuple[ModelEntry, ...]] = TypeAdapter(
    Annotated[tuple[ModelEntry, ...], Field(max_length=MAX_CATALOG_MODELS)]
)


@dataclass(frozen=True)
class ModelCatalog:
    models: tuple[ModelEntry, ...]
    version: int
    refreshed_at: str | None = None

    def get(self, model_id: str) -> ModelEntry | None:
        return next((m for m in self.models if m.id == model_id), None)

    @property
    def enabled(self) -> tuple[ModelEntry, ...]:
        return tuple(m for m in self.models if m.enabled)


class ModelCatalogStore:
    def __init__(self, dynamodb: DynamoDBClient, table: str) -> None:
        self._db = dynamodb
        self._table = table

    def catalog(self) -> ModelCatalog:
        try:
            item = self._db.get_item(
                TableName=self._table,
                Key={"PK": {"S": PK_MODELS}, "SK": {"S": SK_CATALOG}},
                ConsistentRead=True,
            ).get("Item")
            if item is None:
                raise ModelCatalogUnavailableError("model catalog is not seeded")
            models = _MODELS.validate_python(json.loads(item["models"]["S"]))
            version = int(item["version"]["N"])
            refreshed_at = item["refreshed_at"]["S"] if "refreshed_at" in item else None
        except (ClientError, BotoCoreError, ValidationError, ValueError, KeyError) as exc:
            raise ModelCatalogUnavailableError("model catalog unavailable") from exc
        if len({m.id for m in models}) != len(models):
            raise ModelCatalogUnavailableError("duplicate model id")
        return ModelCatalog(models=models, version=version, refreshed_at=refreshed_at)

    def save(
        self,
        version: int,
        models: tuple[ModelEntry, ...],
        actor: str,
        now: datetime,
        *,
        refreshed: bool = False,
    ) -> int:
        """Replace the catalog if it is still at ``version``; returns the new version.

        ``refreshed`` also records ``now`` as the last time Bedrock was asked.
        """
        validated = _MODELS.validate_python([m.model_dump() for m in models])
        if len({m.id for m in validated}) != len(validated):
            raise ValueError("duplicate model id")
        body = json.dumps(
            [m.model_dump(mode="json", exclude_none=True) for m in validated],
            separators=(",", ":"),
            sort_keys=True,
        )
        update = "SET models = :models, version = :new, updated_by = :by, updated_at = :at"
        values: dict[str, Any] = {
            ":expected": {"N": str(version)},
            ":models": {"S": body},
            ":new": {"N": str(version + 1)},
            ":by": {"S": actor},
            ":at": {"S": iso(now)},
        }
        if refreshed:
            update += ", refreshed_at = :at"
        try:
            self._db.update_item(
                TableName=self._table,
                Key={"PK": {"S": PK_MODELS}, "SK": {"S": SK_CATALOG}},
                UpdateExpression=update,
                ConditionExpression="version = :expected",
                ExpressionAttributeValues=values,
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                raise VersionConflictError("model catalog changed") from exc
            raise
        return version + 1


CHAT_CACHE_SECONDS = 30


class ModelCatalogCache:
    """The catalog as the chat reads it: at most once every ``CHAT_CACHE_SECONDS`` (like the
    budget limits, D17), so disabling a model or changing its price applies within that time.

    A catalog that cannot be read is never replaced by an older copy: the error propagates
    and the caller fails closed.
    """

    def __init__(
        self,
        store: ModelCatalogStore,
        ttl_seconds: float = CHAT_CACHE_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._store = store
        self._ttl = ttl_seconds
        self._clock = clock
        self._cached: tuple[float, ModelCatalog] | None = None
        self._lock = threading.Lock()

    def catalog(self) -> ModelCatalog:
        now = self._clock()
        with self._lock:
            if self._cached and now - self._cached[0] < self._ttl:
                return self._cached[1]
            self._cached = None
        catalog = self._store.catalog()
        with self._lock:
            self._cached = (now, catalog)
        return catalog
