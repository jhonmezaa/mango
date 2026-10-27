"""Binding between mango-api and the tools Gateway (audit finding F1, D33, TM-M12).

A user's access token alone must not be enough to call the Gateway directly: that would skip
mango-api's authorization, budget reservation and audit. And the Gateway only sees the user,
not the agent: without more, an agent could call any tool its user is allowed in Cedar L2,
approved for that agent or not.

So mango-api signs each harness invocation with a key only it and the Gateway interceptor can
read. The signature (v2) names the user, the agent, its published version, the exact tools of
that version and an expiry. The interceptor rejects requests without a valid, unexpired
signature for the token's subject, and ``tools/call`` for a tool outside the list.

A test of the Playground (D91) carries the claim ``pg``: it runs a version nobody approved,
for whoever edits it, and the interceptor refuses every write tool under it, approval or not.
Without the claim, the invocation is an ordinary one.

A version with knowledge bases also names them (``kbs``, D88 (14)): the interceptor hands them
to the ``knowledge-retrieve`` tool, which searches only those, and of those only the ones the
person can use. The model never names them. Without the claim, the list is empty.

A call mango-api makes itself from «Mis conexiones» carries the claim ``cx`` (``connect`` or
``disconnect``, D97 (3), D98 (15)): the reserved agent ``mangoconn``, version 1 and exactly
one tool of a remote target, with no knowledge bases and no Playground mark. The interceptor
accepts it only for the probe tool of that target; with ``disconnect`` it lets through the one
``_meta`` that deletes the person's token. No agent can carry the claim, and the reserved agent
never goes without it.

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
from typing import Literal, cast

from mango_core.knowledge import ID_PATTERN as KNOWLEDGE_BASE_ID
from mango_core.remote_mcp import CONNECTION_AGENT_ID, split_gateway_tool

HEADER = "X-Mango-Invocation"
MAX_HEADER_CHARS = 8192
"""Upper bound of a signature; a version with more tools than fit is not served."""
_VERSION = "v2"
_AGENT_RE = re.compile(r"^[a-z0-9]{2,16}$")
_TOOL_RE = re.compile(r"^[A-Za-z0-9-]{1,48}___[A-Za-z0-9_-]{1,64}$")
_MAX_TOOLS = 100
_MAX_AGENT_VERSION = 999_999
_MAX_KNOWLEDGE_BASES = 5
_KB_RE = re.compile(KNOWLEDGE_BASE_ID)

Connection = Literal["connect", "disconnect"]
CONNECTIONS: frozenset[str] = frozenset({"connect", "disconnect"})


@dataclass(frozen=True)
class Invocation:
    """What mango-api vouched for: one user using one published agent version."""

    subject: str
    agent_id: str
    agent_version: int
    tools: frozenset[str]
    """Gateway tool names (``<target>___<tool>``) this invocation may call."""
    expires_at: int
    knowledge_bases: tuple[str, ...] = ()
    """Knowledge bases of the agent version (ids, sorted); the tool searches no other."""
    playground: bool = False
    """A test of the Playground (D91): no write tool goes through, approval or not."""
    connection: Connection | None = None
    """A call of «Mis conexiones» (D97 (3)): only the probe tool of one remote target."""


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
    knowledge_bases: Iterable[str] = (),
    playground: bool = False,
    connection: Connection | None = None,
) -> str:
    """Signature of one harness invocation. ``tools`` are Gateway names (``target___tool``);
    ``knowledge_bases``, the ids of the version's knowledge bases; ``playground``, a test of
    a version that may not be approved (D91); ``connection``, a call of «Mis conexiones»
    (D97 (3))."""
    names = sorted(set(tools))
    kbs = sorted(set(knowledge_bases))
    if (
        not subject
        or not _AGENT_RE.fullmatch(agent_id)
        or not 1 <= agent_version <= _MAX_AGENT_VERSION
        or len(names) > _MAX_TOOLS
        or not all(_TOOL_RE.fullmatch(name) for name in names)
        or len(kbs) > _MAX_KNOWLEDGE_BASES
        or not all(_KB_RE.fullmatch(kb) for kb in kbs)
        or not _is_connection_shape(
            connection,
            agent_id=agent_id,
            agent_version=agent_version,
            tools=names,
            knowledge_bases=kbs,
            playground=playground,
        )
    ):
        raise ValueError("invalid invocation")
    claims: dict[str, object] = {
        "sub": subject,
        "exp": expires_at,
        "agent": agent_id,
        "ver": agent_version,
        "tools": names,
    }
    if kbs:
        # Only when there are some: a signature without knowledge bases stays as it was.
        claims["kbs"] = kbs
    if playground:
        # Only on a test: every other signature stays as it was.
        claims["pg"] = True
    if connection is not None:
        # Only on a call of «Mis conexiones»: every other signature stays as it was.
        claims["cx"] = connection
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
    kbs = payload.get("kbs", [])
    playground = payload.get("pg", False)
    connection = payload.get("cx")
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
        or not isinstance(kbs, list)
        or len(kbs) > _MAX_KNOWLEDGE_BASES
        or not all(isinstance(kb, str) and _KB_RE.fullmatch(kb) for kb in kbs)
        or not isinstance(playground, bool)
        or not (connection is None or connection in CONNECTIONS)
        or not _is_connection_shape(
            cast("Connection | None", connection),
            agent_id=agent,
            agent_version=ver,
            tools=tools,
            knowledge_bases=kbs,
            playground=playground,
        )
    ):
        return None
    return Invocation(
        subject=sub,
        agent_id=agent,
        agent_version=ver,
        tools=frozenset(tools),
        expires_at=exp,
        knowledge_bases=tuple(sorted(set(kbs))),
        playground=playground,
        connection=cast("Connection | None", connection),
    )


def _is_connection_shape(
    connection: Connection | None,
    *,
    agent_id: str,
    agent_version: int,
    tools: list[str],
    knowledge_bases: list[str],
    playground: bool,
) -> bool:
    """A connection call is the reserved agent, version 1, one remote tool and nothing else;
    any other invocation is not the reserved agent."""
    if connection is None:
        return agent_id != CONNECTION_AGENT_ID
    return (
        connection in CONNECTIONS
        and agent_id == CONNECTION_AGENT_ID
        and agent_version == 1
        and len(tools) == 1
        and split_gateway_tool(tools[0]) is not None
        and not knowledge_bases
        and not playground
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
