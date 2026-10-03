"""Canonical JSON and digests.

Every hash and signature of the pack format is computed over this encoding, so the pipeline
that signs and the provisioner that verifies must share it.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

SHA256_PREFIX = "sha256:"


def canonical_json(value: Any) -> bytes:
    """Sorted keys, no insignificant whitespace, UTF-8. NaN and Infinity are rejected."""
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
