"""Rate limits every mango-api task shares (D70): ``mango_core.rate_limits``, with the logger of
mango-api.

A call refused because the table could not say is logged by this module's logger: the metric
filter of the alarm ``Api-rate-limit-store-unavailable`` reads its name (D71 (18)).
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable

from mango_core import rate_limits as _shared
from mango_core.rate_limits import (
    ATTEMPTS,
    SK_HITS,
    SKEW_SECONDS,
    STORE_UNAVAILABLE_LOG,
    TTL_MARGIN_SECONDS,
    UNAVAILABLE_RETRY_SECONDS,
    Hits,
    Leases,
    Limiter,
    MemoryLeases,
    RateLimitStore,
    RateLimitUnavailableError,
)

__all__ = [
    "ATTEMPTS",
    "SKEW_SECONDS",
    "SK_HITS",
    "STORE_UNAVAILABLE_LOG",
    "TTL_MARGIN_SECONDS",
    "UNAVAILABLE_RETRY_SECONDS",
    "Hits",
    "Leases",
    "Limiter",
    "MemoryLeases",
    "RateLimitStore",
    "RateLimitUnavailableError",
    "SharedLeases",
    "SharedRateLimiter",
]

logger = logging.getLogger(__name__)


class SharedRateLimiter(_shared.SharedRateLimiter):
    """The shared limit, logging its refusals as ``mango_api.rate_limits``."""

    def __init__(
        self,
        store: RateLimitStore,
        name: str,
        limit: int,
        window_seconds: float,
        *,
        clock: Callable[[], float] = time.time,
        pause: Callable[[float], None] = time.sleep,
    ) -> None:
        super().__init__(store, name, limit, window_seconds, clock=clock, pause=pause, log=logger)


class SharedLeases(_shared.SharedLeases):
    """The shared leases, logging their refusals as ``mango_api.rate_limits``."""

    def __init__(
        self,
        store: RateLimitStore,
        name: str,
        limit: int,
        ttl_seconds: float,
        *,
        clock: Callable[[], float] = time.time,
        pause: Callable[[float], None] = time.sleep,
    ) -> None:
        super().__init__(store, name, limit, ttl_seconds, clock=clock, pause=pause, log=logger)
