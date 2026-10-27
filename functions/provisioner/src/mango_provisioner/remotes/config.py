"""Installation settings of the remote MCP provisioner and the names of what it creates.

Everything here comes from the stack (Lambda environment), never from a registration: the
public key that verifies remote profiles, the release catalog (one signed statement per
profile), the Gateway and its policy engine, the Gateway's workload identity, the key that
signs the approved catalog and the SPA return URL (D98 (1)). The Gateway's workload identity
is read from the Gateway itself and must carry its name. Names derive only from the
namespace and the registration id (``mango_core.remote_mcp``), so IAM pins them by prefix.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from urllib.parse import urlsplit

from mango_core import remote_mcp
from mango_packs.signing import PackSignatureError, load_public_key
from mango_provisioner.config import ConfigError as AgentConfigError
from mango_provisioner.config import stack_id

RETURN_PATH = "/conexiones/vuelta"
"""Route of the SPA Identity sends the browser back to (D98 (1), the ``connect-return`` view)."""

_NAMESPACE_RE = re.compile(r"^[a-z0-9]{3,8}$")
_ACCOUNT_RE = re.compile(r"^\d{12}$")
_REGION_RE = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d$")
_BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
_GATEWAY_ID_RE = re.compile(r"^([0-9a-z][-]?){1,100}-[0-9a-z]{10}$")
_POLICY_ENGINE_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*-[a-z0-9_]{10}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_KMS_KEY_ARN_RE = re.compile(r"^arn:aws:kms:[a-z0-9-]+:\d{12}:key/[0-9a-f-]{36}$")
_PROFILE_RE = re.compile(remote_mcp.PROFILE_ID_PATTERN)
_TARGET_RE = re.compile(r"^[A-Za-z0-9-]{1,48}$")
_HOST_RE = re.compile(
    r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$"
)


class ConfigError(Exception):
    """The Lambda environment is not what the stack should have set."""


def _json(name: str, env: Mapping[str, str]) -> object:
    try:
        return json.loads(env[name])
    except ValueError:
        raise ConfigError(f"{name} is not JSON") from None


def _match(pattern: re.Pattern[str], name: str, value: str) -> str:
    if not pattern.fullmatch(value):
        raise ConfigError(f"{name} is invalid")
    return value


def _catalog(raw: object) -> Mapping[str, str]:
    """``REMOTE_CATALOG`` of ``RemoteRelease``: profile id -> sha256 of its signed statement."""
    if not isinstance(raw, dict) or not all(
        isinstance(k, str)
        and _PROFILE_RE.fullmatch(k)
        and isinstance(v, str)
        and _SHA256_RE.fullmatch(v)
        for k, v in raw.items()
    ):
        raise ConfigError("REMOTE_CATALOG is invalid")
    return MappingProxyType(dict(raw))


def _targets(raw: object) -> frozenset[str]:
    if not isinstance(raw, list) or not all(
        isinstance(item, str) and _TARGET_RE.fullmatch(item) for item in raw
    ):
        raise ConfigError("CONNECTOR_TARGETS is invalid")
    return frozenset(raw)


def _public_key(value: str) -> bytes | None:
    """PEM of the provider's signing key, or ``None`` while signing is not set up."""
    if not value.strip():
        return None
    pem = value.encode()
    try:
        load_public_key(pem)
    except PackSignatureError:
        raise ConfigError("PACK_SIGNING_PUBLIC_KEY is invalid") from None
    return pem


def _return_url(value: str) -> str:
    """``https://<SPA host>/conexiones/vuelta``: no port, user, query or fragment."""
    parts = urlsplit(value)
    if (
        parts.scheme != "https"
        or not _HOST_RE.fullmatch(parts.netloc)
        or parts.path != RETURN_PATH
        or parts.query
        or parts.fragment
    ):
        raise ConfigError("REMOTE_RETURN_URL is invalid")
    return value


@dataclass(frozen=True)
class RemoteSettings:
    namespace: str
    region: str
    account_id: str
    settings_table: str
    audit_stream: str
    audit_index_table: str
    packs_bucket: str
    catalog: Mapping[str, str]
    public_key_pem: bytes | None
    gateway_id: str
    policy_engine_id: str
    signing_key: str
    """ARN of ``alias/Mango-<ns>-remote-mcp``: only this function's role may sign with it
    (TM-012). By ARN, as the interceptor verifies: an alias moved elsewhere signs nothing."""
    return_url: str
    connector_targets: frozenset[str]
    stack_id: str

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> RemoteSettings:
        env = os.environ if env is None else env
        try:
            namespace = _match(_NAMESPACE_RE, "MANGO_NAMESPACE", env["MANGO_NAMESPACE"])
            region = _match(_REGION_RE, "AWS_REGION", env["AWS_REGION"])
            account_id = _match(_ACCOUNT_RE, "MANGO_ACCOUNT_ID", env["MANGO_ACCOUNT_ID"])
            settings = RemoteSettings(
                namespace=namespace,
                region=region,
                account_id=account_id,
                settings_table=env["SETTINGS_TABLE"],
                audit_stream=env["AUDIT_STREAM"],
                audit_index_table=env["AUDIT_INDEX_TABLE"],
                packs_bucket=_match(_BUCKET_RE, "PACKS_BUCKET", env["PACKS_BUCKET"]),
                catalog=_catalog(_json("REMOTE_CATALOG", env)),
                public_key_pem=_public_key(env["PACK_SIGNING_PUBLIC_KEY"]),
                gateway_id=_match(_GATEWAY_ID_RE, "GATEWAY_ID", env["GATEWAY_ID"]),
                policy_engine_id=_match(
                    _POLICY_ENGINE_ID_RE, "POLICY_ENGINE_ID", env["POLICY_ENGINE_ID"]
                ),
                signing_key=_match(
                    _KMS_KEY_ARN_RE, "REMOTE_MCP_KEY_ARN", env["REMOTE_MCP_KEY_ARN"]
                ),
                return_url=_return_url(env["REMOTE_RETURN_URL"]),
                connector_targets=_targets(_json("CONNECTOR_TARGETS", env)),
                stack_id=_stack_id(env["MANGO_STACK_ID"], region, account_id, namespace),
            )
        except KeyError as exc:
            raise ConfigError(f"missing environment variable {exc.args[0]}") from None
        if not settings.signing_key.startswith(f"arn:aws:kms:{region}:{account_id}:key/"):
            raise ConfigError("REMOTE_MCP_KEY_ARN is not a key of this installation")
        return settings

    # --- Names (regla 6, D98 (11)) --------------------------------------------------------

    @property
    def _agentcore(self) -> str:
        return f"arn:aws:bedrock-agentcore:{self.region}:{self.account_id}"

    @property
    def gateway_arn(self) -> str:
        return f"{self._agentcore}:gateway/{self.gateway_id}"

    @property
    def workload_identity_prefix(self) -> str:
        """AgentCore names the Gateway's workload identity after the Gateway (``mango-<ns>-
        tools-…``, finding of 2026-10-27; CloudFormation does not return it as a string)."""
        return f"mango-{self.namespace}-tools-"

    @property
    def workload_identity_arn_prefix(self) -> str:
        return (
            f"{self._agentcore}:workload-identity-directory/default/workload-identity/"
            f"{self.workload_identity_prefix}"
        )

    def provider_name(self, registration_id: str, generation: int) -> str:
        return remote_mcp.provider_name(self.namespace, registration_id, generation)

    def provider_arn(self, registration_id: str, generation: int) -> str:
        """Built from the name, never read from a record: the target only gets our provider."""
        name = self.provider_name(registration_id, generation)
        return f"{self._agentcore}:token-vault/default/oauth2credentialprovider/{name}"

    def profile_key(self, profile_id: str, statement_sha256: str) -> str:
        """Where ``RemoteRelease`` copied the signed profile (``remotes/<id>/<sha256>.json``)."""
        if not _PROFILE_RE.fullmatch(profile_id) or not _SHA256_RE.fullmatch(statement_sha256):
            raise ValueError("invalid profile")
        return f"remotes/{profile_id}/{statement_sha256}.json"


def _stack_id(value: str, region: str, account_id: str, namespace: str) -> str:
    try:
        return stack_id(value, region=region, account_id=account_id, namespace=namespace)
    except AgentConfigError:
        raise ConfigError("MANGO_STACK_ID is invalid") from None
