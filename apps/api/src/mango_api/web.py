"""HTTP primitives shared by the route modules: the verified caller and typed API errors."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi.responses import JSONResponse

from mango_core.identity import UserContext


@dataclass(frozen=True)
class Caller:
    user: UserContext
    token: str
    expires_at: int


class ApiError(Exception):
    """Domain error mapped centrally to ``{"error": {"code", "message"}}``."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        headers: dict[str, str] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.headers = headers
        self.extra = extra
        """Structured fields next to ``error`` (codes and ids only, never request content)."""


def rate_limited(retry_after_seconds: int) -> ApiError:
    """429 with ``Retry-After`` (whole seconds, at least 1) so clients can count down."""
    seconds = max(1, retry_after_seconds)
    return ApiError(
        429,
        "rate_limited",
        "too many requests; try again later",
        headers={"Retry-After": str(seconds)},
    )


def error_response(
    status: int,
    code: str,
    message: str,
    headers: dict[str, str] | None = None,
    extra: dict[str, Any] | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={**(extra or {}), "error": {"code": code, "message": message}},
        headers=headers,
    )
