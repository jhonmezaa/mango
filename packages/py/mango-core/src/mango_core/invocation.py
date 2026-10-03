"""Binding between mango-api and the tools Gateway (audit finding F1, D33, TM-M12).

A user's access token alone must not be enough to call the Gateway directly: that would skip
mango-api's authorization, budget reservation and audit. And the Gateway only sees the user,
not the agent: without more, an agent could call any tool its user is allowed in Cedar L2,
approved for that agent or not.

So mango-api signs each harness invocation with a key only it and the Gateway interceptor can
read. The signature (v2) names the user, the agent, its published version, the exact tools of
that version and an expiry. The interceptor rejects requests without a valid, unexpired
signature for the token's subject, and ``tools/call`` for a tool outside the list.

Format: ``v2.<base64url(JSON payload)>.<HMAC-SHA256 hex of "v2.<payload>">``. The MAC covers
the encoded payload exactly as sent, so nothing is parsed before it is verified.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import re
import time
from collections.abc import Iterable
from dataclasses import dataclass

HEADER = "X-Mango-Invocation"
MAX_HEADER_CHARS = 8192
"""Upper bound of a signature; a version with more tools than fit is not served."""
_VERSION = "v2"
_AGENT_RE = re.compile(r"^[a-z0-9]{2,16}$")
_TOOL_RE = re.compile(r"^[A-Za-z0-9-]{1,48}___[A-Za-z0-9_-]{1,64}$")
_MAX_TOOLS = 100
_MAX_AGENT_VERSION = 999_999


@dataclass(frozen=True)
class Invocation:
    """What mango-api vouched for: one user using one published agent version."""

    subject: str
    agent_id: str
    agent_version: int
    tools: frozenset[str]
    """Gateway tool names (``<target>___<tool>``) this invocation may call."""
    expires_at: int


def _mac(key: bytes, signed: str) -> str:
    return hmac.new(key, signed.encode(), hashlib.sha256).hexdigest()


def sign(
    key: bytes,
    subject: str,
    expires_at: int,
    *,
    agent_id: str,
    agent_version: int,
    tools: Iterable[str],
) -> str:
    """Signature of one harness invocation. ``tools`` are Gateway names (``target___tool``)."""
    names = sorted(set(tools))
    if (
        not subject
        or not _AGENT_RE.fullmatch(agent_id)
        or not 1 <= agent_version <= _MAX_AGENT_VERSION
        or len(names) > _MAX_TOOLS
        or not all(_TOOL_RE.fullmatch(name) for name in names)
    ):
        raise ValueError("invalid invocation")
    claims = {
        "sub": subject,
        "exp": expires_at,
        "agent": agent_id,
        "ver": agent_version,
        "tools": names,
    }
    payload = json.dumps(claims, separators=(",", ":"), sort_keys=True)
    encoded = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    signed = f"{_VERSION}.{encoded}"
    value = f"{signed}.{_mac(key, signed)}"
    if len(value) > MAX_HEADER_CHARS:
        raise ValueError("invocation signature too large")
    return value


def verify(key: bytes, subject: str, value: str, now: float | None = None) -> Invocation | None:
    """The invocation ``value`` vouches for, if it is valid, unexpired and issued for ``subject``.

    A v1 signature (user and expiry only) is rejected: it names no agent, so it could not
    restrict the tools.
    """
    current = now if now is not None else time.time()
    if len(value) > MAX_HEADER_CHARS:
        return None
    payload = _verified_payload(key, value)
    if payload is None:
        return None
    sub, exp = payload.get("sub"), payload.get("exp")
    agent, ver, tools = payload.get("agent"), payload.get("ver"), payload.get("tools")
    if (
        not isinstance(sub, str)
        or not hmac.compare_digest(sub.encode(), subject.encode())
        or isinstance(exp, bool)
        or not isinstance(exp, int)
        or exp < current
        or not isinstance(agent, str)
        or isinstance(ver, bool)
        or not isinstance(ver, int)
        or not isinstance(tools, list)
        or not all(isinstance(name, str) for name in tools)
    ):
        return None
    return Invocation(
        subject=sub,
        agent_id=agent,
        agent_version=ver,
        tools=frozenset(tools),
        expires_at=exp,
    )


def _verified_payload(key: bytes, value: str) -> dict[str, object] | None:
    """Payload of a v2 signature whose MAC is right; nothing is parsed before that."""
    parts = value.split(".")
    if len(parts) != 3 or parts[0] != _VERSION:  # noqa: PLR2004
        return None
    version, encoded, mac = parts
    # Constant-time comparison before anything in the payload is trusted.
    if not hmac.compare_digest(mac.encode(), _mac(key, f"{version}.{encoded}").encode()):
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    except (ValueError, binascii.Error):
        return None
    return payload if isinstance(payload, dict) else None
