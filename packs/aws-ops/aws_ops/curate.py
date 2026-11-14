"""What every tool of the pack shares: clients, bounds, and how a value is cut down.

Nothing here reads files, the environment or the web. Clients are created inside the call, so
they sign with the session ``mango_pack_runtime`` assumed for the person who asked.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Iterator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from mcp.server.mcpserver.exceptions import ToolError

TEXT_LIMIT = 500
"""Longest free text (reasons, messages, descriptions) a tool returns, in characters."""

ERROR_LIMIT = 300
TAG_VALUE_LIMIT = 128
SCAN_LIMIT = 1000
"""Most items a tool reads from AWS to answer one call, whatever it returns."""

# botocore accepts ignore_configured_endpoint_urls since 1.31; its stubs do not list it yet.
CLIENT_CONFIG = Config(  # type: ignore[call-arg]
    connect_timeout=5,
    read_timeout=20,
    retries={"max_attempts": 3, "mode": "standard"},
    # Endpoints come from the Region only: never from AWS_ENDPOINT_URL_* or a config file.
    ignore_configured_endpoint_urls=True,
    user_agent_extra="mango-aws-ops",
)

# Tags are free text anyone with access to the account writes. Only these keys are returned,
# and only when the value does not look like a secret.
TAG_KEYS = frozenset(
    {
        "Name",
        "Environment",
        "aws:autoscaling:groupName",
        "aws:cloudformation:stack-name",
        "aws:cloudformation:logical-id",
        "aws:ecs:clusterName",
        "aws:ecs:serviceName",
        "aws:eks:cluster-name",
        "eks:cluster-name",
        "elasticbeanstalk:environment-name",
    }
)
_SECRET_LIKE = re.compile(
    r"(?i)(secret|passw|pwd|token|api[_-]?key|credential|private[_-]?key|BEGIN [A-Z ]*KEY)"
    r"|(?:AKIA|ASIA)[A-Z0-9]{12,}"
    # A long run without separators looks like a key or a token, not like a name.
    r"|[A-Za-z0-9+/=]{32,}"
)
REDACTED = "[redacted]"


def now() -> datetime:
    """The current time (a function, so tests can fix it)."""
    return datetime.now(UTC)


def since(hours: int) -> datetime:
    return now() - timedelta(hours=hours)


def client(service: str, region: str | None) -> Any:
    """A boto3 client of ``service`` in ``region``, created inside the call."""
    return boto3.client(service, region_name=region, config=CLIENT_CONFIG)  # type: ignore[call-overload]


def text(value: object, limit: int = TEXT_LIMIT) -> str | None:
    """``value`` as text, cut to ``limit`` characters; ``None`` stays ``None``."""
    if value is None:
        return None
    string = " ".join(str(value).split())
    if len(string) <= limit:
        return string
    return string[: limit - 1] + "…"


def when(value: object) -> str | None:
    """A timestamp of a boto3 response in ISO 8601."""
    if isinstance(value, datetime):
        return value.isoformat()
    return None


def aware(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    return None


def tags(items: Iterable[Mapping[str, Any]] | None) -> dict[str, str]:
    """The allowlisted tags of ``items`` (``Key``/``Value`` pairs), values cut and screened."""
    curated: dict[str, str] = {}
    for item in items or ():
        key = item.get("Key")
        if key not in TAG_KEYS:
            continue
        value = str(item.get("Value") or "")
        curated[key] = (
            REDACTED if _SECRET_LIKE.search(value) else text(value, TAG_VALUE_LIMIT) or ""
        )
    return curated


def name_of(arn: str | None) -> str | None:
    """The last part of an ARN (``.../name``), or ``None``."""
    if not arn:
        return None
    return arn.rsplit("/", 1)[-1]


def pick(source: Mapping[str, Any] | None, *keys: str) -> dict[str, Any]:
    """The ``keys`` of ``source`` that are present, unchanged (scalars only)."""
    if not source:
        return {}
    return {key: source[key] for key in keys if source.get(key) is not None}


def drop_empty(values: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value not in (None, [], {}, "")}


def bounded(pages: Iterable[Mapping[str, Any]], key: str, limit: int) -> tuple[list[Any], bool]:
    """Up to ``limit`` items of ``key`` across ``pages``, and whether there were more."""
    items: list[Any] = []
    for page in pages:
        for item in page.get(key) or ():
            if len(items) == limit:
                return items, True
            items.append(item)
    return items, False


def chunks(values: list[str], size: int) -> Iterator[list[str]]:
    for start in range(0, len(values), size):
        yield values[start : start + size]


@contextmanager
def aws_errors(operation: str) -> Iterator[None]:
    """Turn an AWS error into a short tool error: its code and a cut message, nothing else."""
    try:
        yield
    except ClientError as error:
        details = error.response.get("Error", {})
        code = details.get("Code") or "Unknown"
        message = text(details.get("Message"), ERROR_LIMIT)
        raise ToolError(
            f"{operation} failed: {code}" + (f": {message}" if message else "")
        ) from None
    except BotoCoreError as error:
        raise ToolError(f"{operation} failed: {type(error).__name__}") from None
