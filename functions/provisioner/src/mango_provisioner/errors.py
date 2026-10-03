"""Errors of a provisioner step. Their text is a short code, never content or AWS messages."""

from __future__ import annotations

import re

from botocore import exceptions as botocore_errors
from botocore.exceptions import BotoCoreError, ClientError

_CODE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,79}$")
_TRANSIENT = frozenset(
    {
        "InternalServerException",
        "InternalServerError",
        "InternalFailure",
        "ServiceFailure",
        "ServiceUnavailable",
        "ServiceUnavailableException",
        "RequestLimitExceeded",
        "ThrottledException",
        "Throttling",
        "ThrottlingException",
        "TooManyRequestsException",
        "ProvisionedThroughputExceededException",
        "LimitExceededException",
        "OperationAbortedException",
    }
)


class StepError(Exception):
    """A step cannot continue; the execution compensates and marks the version as failed."""

    def __init__(self, code: str) -> None:
        if not _CODE_RE.fullmatch(code):
            raise ValueError("invalid error code")
        super().__init__(code)
        self.code = code


class RetryableError(StepError):
    """A transient condition: Step Functions retries the step with backoff."""


class BusyError(StepError):
    """Another execution holds the agent's lock; this one must not touch anything."""

    def __init__(self) -> None:
        super().__init__("busy")


def error_code(exc: ClientError) -> str:
    return str(exc.response.get("Error", {}).get("Code", "Unknown"))


def aws_error(operation: str, exc: ClientError | BotoCoreError) -> StepError:
    """Map an AWS failure to a step error named ``<Operation>:<Code>``.

    AWS messages may quote ARNs or request content, so only the error code is kept.
    """
    if isinstance(exc, ClientError):
        code = error_code(exc)
        text = f"{operation}:{code}"[:80]
        return RetryableError(text) if code in _TRANSIENT else StepError(text)
    text = f"{operation}:{type(exc).__name__}"[:80]
    # Only connection and timeout errors of the SDK are worth retrying.
    if isinstance(exc, botocore_errors.ConnectionError | botocore_errors.HTTPClientError):
        return RetryableError(text)
    return StepError(text)
