"""A remote MCP profile under `remotes/` (D93, D98 (14)): check it, write its statement, sign it.

Nothing here reaches the remote server or AWS but `sign`: the repository is public and has no
credentials of the service, so the tool schema is refreshed by hand (remotes/README.md) and
the pipeline only checks that what was committed is consistent and read-only.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import yaml
from pydantic import ValidationError

from mango_pack_builder.kms import Signer
from mango_packs.remote import (
    MAX_TOOL_SCHEMA_BYTES,
    PAYLOAD_TYPE,
    RemoteProfile,
    RemoteProfileError,
    RemoteProfileStatement,
    build_envelope,
    check_tool_schema,
    verify_envelope,
)
from mango_packs.signing import message_digest

PROFILE = "profile.yaml"
TOOL_SCHEMA = "tool-schema.json"
_MAX_PROFILE_BYTES = 64 * 1024


@dataclass(frozen=True)
class Remote:
    directory: Path
    profile: RemoteProfile
    tool_schema: dict[str, object]

    @property
    def base_name(self) -> str:
        return f"{self.profile.id}-{self.profile.version}"


def _read(path: Path, limit: int) -> bytes:
    if not path.is_file():
        raise RemoteProfileError(f"{path} not found")
    raw = path.read_bytes()
    if len(raw) > limit:
        raise RemoteProfileError(f"{path} is too large")
    return raw


def load_remote(directory: Path) -> Remote:
    """Read and check a profile directory. Fails on the first rule it breaks."""
    path = directory / PROFILE
    try:
        profile = RemoteProfile.model_validate(yaml.safe_load(_read(path, _MAX_PROFILE_BYTES)))
    except yaml.YAMLError as error:
        raise RemoteProfileError(f"{path} is not valid YAML: {error}") from error
    except ValidationError as error:
        raise RemoteProfileError(f"{path} is not a valid remote profile:\n{error}") from error
    if profile.id != directory.name:
        raise RemoteProfileError(
            f"profile id {profile.id!r} must match its directory {directory.name!r}"
        )
    schema_path = directory / TOOL_SCHEMA
    try:
        schema = json.loads(_read(schema_path, MAX_TOOL_SCHEMA_BYTES))
    except json.JSONDecodeError as error:
        raise RemoteProfileError(f"{schema_path} is not valid JSON: {error}") from error
    check_tool_schema(profile, schema)
    return Remote(directory=directory, profile=profile, tool_schema=schema)


def statement_for(remote: Remote, revision: str) -> RemoteProfileStatement:
    try:
        return RemoteProfileStatement(
            schema_version=1,
            profile=remote.profile,
            tool_schema=remote.tool_schema,
            source_revision=revision,
        )
    except ValidationError as error:
        raise RemoteProfileError(f"cannot write the statement:\n{error}") from error


def sign_statement(
    statement: RemoteProfileStatement, signer: Signer, trusted_public_key: bytes
) -> bytes:
    """Return the signed envelope, verified with the key installations will trust."""
    signature = signer.sign_digest(message_digest(statement.payload(), PAYLOAD_TYPE))
    envelope = build_envelope(statement, signer.key_id, signature)
    verify_envelope(envelope, trusted_public_key)
    return envelope
