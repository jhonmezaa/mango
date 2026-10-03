"""What a pack knows about itself: ``pack.json`` of its zip and the runtime's environment.

``pack.json`` is written by the build from the signed manifest and travels inside the signed
zip: the tools the entry point may serve, how identity reaches the data and, for a pack over
account data, the broker chain it uses and the IAM statements each call is limited to. The
environment is the closed list the pack provisioner sets (``mango_provisioner.packs.runtime``):
where the broker is and the public key that verifies callers. Neither holds a secret.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

PACK_JSON = "pack.json"
MODE_SERVICE = "service"
MODE_CENTRAL_ONLY = "central_only"
CHAIN_PAYER = "payer"
"""One target for every call: the role behind the Billing broker, in the payer account."""
CHAIN_MEMBER = "member"
"""The target changes with every call: ``Mango-<ns>-ReadOnly`` of the member account the call
names, behind the Read broker (D51)."""

ENV_BROKER_ROLE = "MANGO_PACK_BROKER_ROLE_ARN"
ENV_TARGET_ROLE = "MANGO_PACK_TARGET_ROLE_ARN"
ENV_TARGET_ROLE_NAME = "MANGO_PACK_TARGET_ROLE_NAME"
"""Member chain: the name of the role behind the broker in every member account. Never an
ARN: the account comes from the call, the role is always this one."""
ENV_REGION = "MANGO_PACK_REGION"
"""Region of the installation: where the pack calls STS to assume the broker."""
ENV_IDENTITY_KEY = "MANGO_PACK_IDENTITY_PUBLIC_KEY"
"""Base64 of the DER (SubjectPublicKeyInfo) public key of the interceptor's signing key."""

_PACK_RE = re.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$")
_TOOL_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
_ROLE_NAME_RE = re.compile(r"^[\w+=,.@-]{1,64}$", re.ASCII)
_MAX_PACK_JSON_BYTES = 256 * 1024


class PackConfigError(Exception):
    """The pack cannot start: its own files or its environment are not what they should be."""


@dataclass(frozen=True)
class Statement:
    actions: tuple[str, ...]
    resources: tuple[str, ...]


@dataclass(frozen=True)
class PackConfig:
    pack_id: str
    version: str
    tools: frozenset[str]
    identity_mode: str
    statements: tuple[Statement, ...]
    """Ceiling of every call's session (``central_only``): the manifest's IAM statements."""
    broker_role_arn: str | None = None
    target_role_arn: str | None = None
    identity_public_key: bytes | None = None
    region: str | None = None
    identity_chain: str = CHAIN_PAYER
    target_role_name: str | None = None
    """Member chain: role assumed in the account each call names (``target_role_arn`` is unset)."""

    @property
    def needs_caller(self) -> bool:
        return self.identity_mode != MODE_SERVICE

    @property
    def member_chain(self) -> bool:
        return self.identity_chain == CHAIN_MEMBER

    @property
    def can_verify(self) -> bool:
        """The runtime was given the broker, its target and the key that verifies callers."""
        target = self.target_role_name if self.member_chain else self.target_role_arn
        return bool(self.broker_role_arn and target and self.identity_public_key and self.region)

    @staticmethod
    def load(directory: Path, env: Mapping[str, str] | None = None) -> PackConfig:
        env = os.environ if env is None else env
        path = directory / PACK_JSON
        try:
            if path.stat().st_size > _MAX_PACK_JSON_BYTES:
                raise PackConfigError("pack.json is too large")
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise PackConfigError("pack.json cannot be read") from exc
        try:
            config = _parse(raw)
        except (KeyError, TypeError, ValueError) as exc:
            raise PackConfigError("pack.json is invalid") from exc
        if not config.needs_caller:
            return config
        if config.identity_mode != MODE_CENTRAL_ONLY or not config.statements:
            # Another mode needs code that does not exist: refuse to serve.
            raise PackConfigError("unsupported identity mode")
        if config.identity_chain not in {CHAIN_PAYER, CHAIN_MEMBER}:
            # A chain this code does not know: it would assume the wrong role. Refuse to serve.
            raise PackConfigError("unsupported identity chain")
        # Without the settings the provisioner gives a runtime (the tools snapshot of the build
        # runs the zip with an empty environment) the pack lists its tools and refuses every
        # call: see ``build_guard``.
        encoded = env.get(ENV_IDENTITY_KEY)
        broker, region = env.get(ENV_BROKER_ROLE), env.get(ENV_REGION)
        target_arn, target_name = env.get(ENV_TARGET_ROLE), env.get(ENV_TARGET_ROLE_NAME)
        if config.member_chain:
            # Only ever a role name: an ARN here would pin (or let someone pick) the account.
            if target_name and not _ROLE_NAME_RE.fullmatch(target_name):
                raise PackConfigError("the member role name is invalid")
            target_arn = None
        else:
            target_name = None
        if not encoded or not broker or not (target_arn or target_name) or not region:
            return config
        try:
            key = base64.b64decode(encoded, validate=True)
        except binascii.Error as exc:
            raise PackConfigError("the caller identity key is not base64") from exc
        return PackConfig(
            pack_id=config.pack_id,
            version=config.version,
            tools=config.tools,
            identity_mode=config.identity_mode,
            statements=config.statements,
            broker_role_arn=broker,
            target_role_arn=target_arn,
            identity_public_key=key,
            region=region,
            identity_chain=config.identity_chain,
            target_role_name=target_name,
        )


def _strings(raw: object) -> tuple[str, ...]:
    if not isinstance(raw, list) or not raw or not all(isinstance(item, str) for item in raw):
        raise ValueError("not a list of strings")
    return tuple(raw)


def _parse(raw: object) -> PackConfig:
    if not isinstance(raw, dict):
        raise TypeError("pack.json must be an object")
    pack_id, version = raw["id"], raw["version"]
    tools = _strings(raw["tools"])
    mode = raw.get("identity_mode", MODE_SERVICE)
    chain = raw.get("identity_chain", CHAIN_PAYER)
    if (
        not isinstance(pack_id, str)
        or not _PACK_RE.fullmatch(pack_id)
        or not isinstance(version, str)
        or not all(_TOOL_RE.fullmatch(tool) for tool in tools)
        or not isinstance(mode, str)
        or not isinstance(chain, str)
    ):
        raise ValueError("invalid pack.json")
    statements = tuple(
        Statement(actions=_strings(entry["actions"]), resources=_strings(entry["resources"]))
        for entry in raw.get("iam", [])
    )
    return PackConfig(
        pack_id=pack_id,
        version=version,
        tools=frozenset(tools),
        identity_mode=mode,
        statements=statements,
        identity_chain=chain,
    )
