"""Shared fixtures of the remote MCP tests: a signed approved catalog and invocation headers."""

import base64
import json
import time
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

from mango_core import invocation, remote_mcp
from mango_core.invocation import Connection

KEY = b"k" * 32
REGION = "us-east-1"
GATEWAY_ID = "mango-test-tools-abcdefghij"
REGISTRATION = "abcdefghij23"
TARGET = f"remote-{REGISTRATION}"
PROBE = f"{TARGET}___core_list_projects"
WIKI = f"{TARGET}___wiki"
CATALOG_KEY = ec.generate_private_key(ec.SECP256R1())
CONSENT_URL = (
    f"https://bedrock-agentcore.{REGION}.amazonaws.com/identities/oauth2/authorize?request_uri=x"
)


def approved(**changes: Any) -> remote_mcp.ApprovedRemote:
    fields: dict[str, Any] = {
        "registration_id": REGISTRATION,
        "generation": 1,
        "revision": 1,
        "profile_id": "azure-devops",
        "profile_version": "2026.10.27-1",
        "profile_sha256": "0" * 64,
        "gateway_id": GATEWAY_ID,
        "organization": "contoso",
        "toolsets": ("core", "wiki"),
        "tools": frozenset({"core_list_projects", "wiki"}),
        "probe_tool": "core_list_projects",
        "issued_at": 1_793_000_000,
    }
    return remote_mcp.ApprovedRemote(**{**fields, **changes})


def signed_item(
    remote: remote_mcp.ApprovedRemote | None = None,
    key: ec.EllipticCurvePrivateKey = CATALOG_KEY,
) -> dict[str, str]:
    payload = (remote or approved()).encode()
    signature = key.sign(remote_mcp.SIGNING_CONTEXT + payload, ec.ECDSA(hashes.SHA256()))
    return remote_mcp.item_fields(payload, signature)


def token(sub: str = "user-1", **claims: str) -> str:
    body = json.dumps({"sub": sub, **claims}).encode()
    payload = base64.urlsafe_b64encode(body).decode().rstrip("=")
    return f"eyJhbGciOiJSUzI1NiJ9.{payload}.signature"


def headers(
    tools: tuple[str, ...] = (PROBE, WIKI),
    *,
    sub: str = "user-1",
    connection: Connection | None = None,
    playground: bool = False,
    **claims: str,
) -> dict[str, str]:
    agent = remote_mcp.CONNECTION_AGENT_ID if connection else "helper"
    return {
        "Authorization": f"Bearer {token(sub, **claims)}",
        invocation.HEADER: invocation.sign(
            KEY,
            sub,
            int(time.time()) + 300,
            agent_id=agent,
            agent_version=1,
            tools=tools,
            playground=playground,
            connection=connection,
        ),
    }
