"""Common entry point of MCP packs over account data (D37).

Shipped inside the zip of every pack whose ``identity_mode`` is not ``service``, next to the
upstream server. It must stay importable there: only the standard library, ``boto3``,
``cryptography`` and ``mango_aws``, never another Mango package.
"""

from mango_pack_runtime.config import PackConfig
from mango_pack_runtime.credentials import NoCallerError
from mango_pack_runtime.guard import RESERVED_CONTEXT_ARG, CallGuard, build_guard
from mango_pack_runtime.identity import Caller, IdentityError, IdentityVerifier

__all__ = [
    "RESERVED_CONTEXT_ARG",
    "CallGuard",
    "Caller",
    "IdentityError",
    "IdentityVerifier",
    "NoCallerError",
    "PackConfig",
    "build_guard",
]
