"""Caller identity for MCP packs over account data (D37, TM-M3, TM-M14).

A pack is a third-party server: it never receives the caller's token (TM-B9). A pack that
reads account data still has to act for the person who asked (rule 5), so the Gateway
interceptor, which has seen the token the Gateway validated, issues a short assertion that
says only who is calling which tool of which pack. It is signed with an asymmetric KMS key
only the interceptor can use; the pack holds the public key. So nobody else that can invoke
the pack runtime (the pack provisioner, another principal of the account) can name a caller,
and the assertion is useless against mango-api, the Gateway or any other pack.

Format: ``v1.<base64url(JSON claims)>.<base64url(DER ECDSA P-256 signature)>``. The signature
covers ``SIGNING_CONTEXT + "v1." + <encoded claims>`` exactly as sent, so nothing is parsed
before it is verified. This module is the issuing half; packs verify with
``mango_pack_runtime.identity``, which must agree on this format.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from typing import Final

VERSION = "v1"
SIGNING_CONTEXT = b"mango-pack-identity."
"""Domain separation: a signature of this key is never valid as anything else."""
SIGNING_ALGORITHM: Final = "ECDSA_SHA_256"
TTL_SECONDS = 60
"""One tool call. The pack rejects an assertion that is expired or lives longer than this."""
MAX_CHARS = 2048

_SUBJECT_RE = re.compile(r"^[\w+=,.@-]{2,64}$", re.ASCII)
"""IAM's rule for ``SourceIdentity``: the subject is used as one."""
_PACK_RE = re.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$")
_TOOL_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
_AGENT_RE = re.compile(r"^[a-z0-9]{2,16}$")
_MAX_PACK_CHARS = 24


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def encode_claims(
    *,
    subject: str,
    pack_id: str,
    tool: str,
    agent_id: str,
    central: bool,
    expires_at: int,
) -> str:
    """Encoded claims of one tool call. Every value comes from what was already verified:
    the Gateway's token (subject, central) and mango-api's invocation signature (agent)."""
    if (
        not _SUBJECT_RE.fullmatch(subject)
        or len(pack_id) > _MAX_PACK_CHARS
        or not _PACK_RE.fullmatch(pack_id)
        or not _TOOL_RE.fullmatch(tool)
        or not _AGENT_RE.fullmatch(agent_id)
    ):
        raise ValueError("invalid pack caller")
    claims = {
        "sub": subject,
        "aud": pack_id,
        "tool": tool,
        "agent": agent_id,
        "central": central,
        "exp": expires_at,
    }
    return _b64(json.dumps(claims, separators=(",", ":"), sort_keys=True).encode())


def signing_input(encoded_claims: str) -> bytes:
    return SIGNING_CONTEXT + f"{VERSION}.{encoded_claims}".encode()


def signing_digest(encoded_claims: str) -> bytes:
    """What KMS signs (``MessageType=DIGEST``)."""
    return hashlib.sha256(signing_input(encoded_claims)).digest()


def assemble(encoded_claims: str, signature: bytes) -> str:
    value = f"{VERSION}.{encoded_claims}.{_b64(signature)}"
    if len(value) > MAX_CHARS:
        raise ValueError("pack identity assertion too large")
    return value
