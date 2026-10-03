"""Area -> OU mapping read from the Settings table (D17, TM-A6).

The connector may only ``GetItem`` the mapping partition. The value is re-validated here with
the shared schema; when it is missing, unreadable or invalid the mapping is empty, so
``bu-lead`` users see no accounts (fail closed). Failures are never cached, so a valid
mapping is picked up again on the next call.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING

from botocore.exceptions import BotoCoreError, ClientError

from mango_core.business_units import InvalidMappingError, loads_units

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

logger = logging.getLogger(__name__)

MAPPING_PK = "BU_MAPPING"
MAPPING_SK = "CURRENT"
DEFAULT_TTL_SECONDS = 300  # threat model: cache at most 5 minutes

BusinessUnits = Mapping[str, frozenset[str]]


def load_mapping(dynamodb: DynamoDBClient, table: str) -> BusinessUnits:
    """Read and validate the current mapping; raises ``InvalidMappingError`` when unusable."""
    item = dynamodb.get_item(
        TableName=table,
        Key={"PK": {"S": MAPPING_PK}, "SK": {"S": MAPPING_SK}},
        ConsistentRead=True,
    ).get("Item")
    if item is None:
        raise InvalidMappingError("mapping not found")
    raw = item.get("units", {}).get("S")
    if raw is None:
        raise InvalidMappingError("mapping has no units")
    return {area: frozenset(ous) for area, ous in loads_units(raw).items()}


class MappingCache:
    """Per execution environment cache of the validated mapping (≤ 5 minutes)."""

    def __init__(
        self,
        loader: Callable[[], BusinessUnits],
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._loader = loader
        self._ttl = min(ttl_seconds, DEFAULT_TTL_SECONDS)
        self._clock = clock
        self._value: BusinessUnits | None = None
        self._loaded_at = 0.0

    def get(self) -> BusinessUnits:
        now = self._clock()
        if self._value is not None and now - self._loaded_at <= self._ttl:
            return self._value
        self._value = None
        try:
            value = self._loader()
        except InvalidMappingError:
            logger.error(json.dumps({"event": "mapping_invalid"}))  # noqa: TRY400
            return {}
        except (ClientError, BotoCoreError):
            logger.exception("mapping could not be read")
            return {}
        self._value, self._loaded_at = value, now
        return value
