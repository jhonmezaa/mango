"""AdminProbe client (D17, TM-A7): IAM invocation, response validation, rate limit and cache.

mango-api sends only the operation and the administrator ``sub`` from the verified token.
The Lambda response is untrusted input: it is validated before it reaches the admin UI.
"""

from __future__ import annotations

import json
import math
import threading
import time
from collections import deque
from collections.abc import Callable
from typing import TYPE_CHECKING, Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from mango_core.business_units import OU_RE

if TYPE_CHECKING:
    from mypy_boto3_lambda import LambdaClient


class ProbeError(Exception):
    """The probe failed or returned an unexpected payload."""


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


OuId = Annotated[str, Field(pattern=OU_RE.pattern)]
ParentId = Annotated[str, Field(pattern=r"^(r-[0-9a-z]{4,32}|ou-[0-9a-z]{4,32}-[0-9a-z]{8,32})$")]
OuName = Annotated[str, Field(min_length=1, max_length=128)]


class OrganizationalUnit(_Strict):
    id: OuId
    name: OuName
    parent_id: ParentId
    path: Annotated[list[OuName], Field(min_length=1, max_length=5)]


class Organization(_Strict):
    ous: Annotated[list[OrganizationalUnit], Field(max_length=1000)]


class ConnectivityCheck(_Strict):
    name: Literal["broker", "billing_reader", "organizations"]
    status: Literal["ok", "error"]
    detail: Annotated[str, Field(max_length=100)]


class Connectivity(_Strict):
    checks: Annotated[list[ConnectivityCheck], Field(max_length=3)]


AccountId = Annotated[str, Field(pattern=r"^\d{12}$")]
MAX_MEMBER_ACCOUNTS = 50
# Sanity bound for a count the probe reports; far above the accounts of any organization.
MAX_ORG_ACCOUNTS = 100_000


class MemberAccount(_Strict):
    id: AccountId
    name: OuName


class MemberAccounts(_Strict):
    accounts: Annotated[list[MemberAccount], Field(max_length=MAX_MEMBER_ACCOUNTS)]
    truncated: bool
    total: Annotated[int, Field(strict=True, ge=0, le=MAX_ORG_ACCOUNTS)] | None = None
    """Target accounts in all. ``None`` from a probe that predates the field."""


class MemberAccessCheck(_Strict):
    name: Literal["read_broker", "member_role", "account", "source_identity_required"]
    status: Literal["ok", "error"]
    detail: Annotated[str, Field(max_length=100)]


class MemberAccess(_Strict):
    checks: Annotated[list[MemberAccessCheck], Field(max_length=4)]


class AdminProbe:
    def __init__(self, client: LambdaClient, function_name: str) -> None:
        self._client = client
        self._function = function_name

    def _invoke(self, operation: str, actor: str, **arguments: str) -> object:
        try:
            resp = self._client.invoke(
                FunctionName=self._function,
                InvocationType="RequestResponse",
                Payload=json.dumps({**arguments, "operation": operation, "actor": actor}).encode(),
            )
            payload: object = json.loads(resp["Payload"].read())
        except Exception as exc:
            raise ProbeError("probe unavailable") from exc
        if resp.get("FunctionError") or (isinstance(payload, dict) and "error" in payload):
            raise ProbeError("probe reported an error")
        return payload

    def organization(self, actor: str) -> Organization:
        try:
            return Organization.model_validate(self._invoke("organization", actor))
        except ValidationError as exc:
            raise ProbeError("unexpected probe response") from exc

    def connectivity(self, actor: str) -> Connectivity:
        try:
            return Connectivity.model_validate(self._invoke("connectivity", actor))
        except ValidationError as exc:
            raise ProbeError("unexpected probe response") from exc

    def member_accounts(self, actor: str) -> MemberAccounts:
        """Accounts the member roles are deployed to (empty when that is not configured)."""
        try:
            return MemberAccounts.model_validate(self._invoke("member_accounts", actor))
        except ValidationError as exc:
            raise ProbeError("unexpected probe response") from exc

    def member_access(self, actor: str, account_id: str) -> MemberAccess:
        try:
            return MemberAccess.model_validate(
                self._invoke("member_access", actor, account_id=account_id)
            )
        except ValidationError as exc:
            raise ProbeError("unexpected probe response") from exc


class RateLimiter:
    """Sliding window per key, in process: one limit per mango-api task, lost when the task
    restarts. Only for the limits ``mango_api.limits`` says may be per task; the others are
    shared (``rate_limits.SharedRateLimiter``)."""

    MAX_KEYS = 10_000

    def __init__(
        self, limit: int, window_seconds: float, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._limit = limit
        self._window = window_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._hits: dict[str, deque[float]] = {}

    def allow(self, key: str, cost: int = 1) -> bool:
        """Record ``cost`` hits for ``key`` when all of them fit in the window (all or nothing)."""
        now = self._clock()
        with self._lock:
            if len(self._hits) >= self.MAX_KEYS and key not in self._hits:
                self._hits.clear()
            hits = self._hits.setdefault(key, deque())
            while hits and now - hits[0] >= self._window:
                hits.popleft()
            if len(hits) + cost > self._limit:
                return False
            hits.extend([now] * cost)
            return True

    def retry_after(self, key: str, cost: int = 1) -> int:
        """Whole seconds until ``key`` may record ``cost`` hits (0 when it already may)."""
        now = self._clock()
        with self._lock:
            hits = self._hits.get(key)
            excess = (len(hits) if hits else 0) + cost - self._limit
            if not hits or excess <= 0:
                return 0
            # The call fits once the ``excess`` oldest hits have left the window.
            oldest = hits[min(excess, len(hits)) - 1]
            return max(0, math.ceil(self._window - (now - oldest)))


class OrganizationCache:
    """Organization tree shared by all admins for ``ttl_seconds`` (TM-A7)."""

    def __init__(
        self, ttl_seconds: float = 60, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._ttl = ttl_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._value: tuple[float, Organization] | None = None

    def get(self) -> Organization | None:
        with self._lock:
            if self._value and self._clock() - self._value[0] <= self._ttl:
                return self._value[1]
        return None

    def put(self, value: Organization) -> None:
        with self._lock:
            self._value = (self._clock(), value)
