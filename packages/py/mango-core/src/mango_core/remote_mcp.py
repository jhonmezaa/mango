"""Remote MCP servers of third parties (D93, D94, D97, D98): names, the approved catalog and
the pending consent, shared by mango-api, the Gateway interceptors and the provisioner.

A remote MCP is a server Mango does not run (Azure DevOps first). An administrator registers
it for one organization; another approves it; the remote provisioner creates a Gateway target
``remote-<registration>`` and, as its last step, writes the approved catalog: the tools that
target may serve, signed with ``alias/Mango-<ns>-remote-mcp`` (D93 (9), D98 (13)). Only the
provisioner can sign with that key, so nothing mango-api writes in ``Settings`` can widen what
the interceptor lets through (TM-012). The interceptor verifies the item on every call and
fails closed.

Item ``MCP_REMOTE#<registration>`` / ``APPROVED``: ``payload`` (canonical JSON, base64url),
``signature`` (DER ECDSA P-256, base64), ``key_arn``, ``generation`` and ``updated_at``. The
signature covers ``SIGNING_CONTEXT + payload`` exactly as stored, so nothing is parsed before
it is verified. The canonical JSON is the one of ``mango_packs.canonical`` (sorted keys, no
spaces, UTF-8); this module does not import it because the interceptor bundles no pydantic.

Item ``MCP_CONSENT#<sub>`` / ``REMOTE#<registration>``: the consent URL the Gateway handed out
for that person, written only by the ``RESPONSE`` interceptor under the ``sub`` of the verified
invocation signature, read and deleted by mango-api (D98 (3), TM-017). Both sides check the
URL with ``is_consent_url``: ``https`` on ``bedrock-agentcore.<region>.amazonaws.com`` only
(D94 (2)).
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import secrets
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final, Literal, cast
from urllib.parse import urlsplit

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

# --- Names (D98 (11)) -------------------------------------------------------------------

REGISTRATION_ID_PATTERN = r"^[a-z2-7]{12}$"
"""12 random base32 characters (60 bits): stable for the whole life of a registration."""
PROFILE_ID_PATTERN = r"^[a-z][a-z0-9-]{1,23}$"
ORGANIZATION_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9-]{0,48}$"
"""The only free part of the endpoint (D93 (5)). A constant of the code, never of a profile."""
TOOL_NAME_PATTERN = r"^[A-Za-z][A-Za-z0-9_-]{0,63}$"

TARGET_PREFIX = "remote-"
TOOL_SEPARATOR = "___"
CONNECTION_AGENT_ID = "mangoconn"
"""Agent id of the calls mango-api makes itself from «Mis conexiones» (claim ``cx``, D97 (3)).
Reserved: ``mango_core.agents`` never accepts it as the id of an agent."""
MCP_PROTOCOL_VERSION = "2025-11-25"
"""Protocol of the connect and disconnect calls: the one the ``-32042`` was tested with."""

_REGISTRATION_RE = re.compile(REGISTRATION_ID_PATTERN)
_PROFILE_RE = re.compile(PROFILE_ID_PATTERN)
_ORGANIZATION_RE = re.compile(ORGANIZATION_PATTERN)
_TOOL_NAME_RE = re.compile(TOOL_NAME_PATTERN)
_NAMESPACE_RE = re.compile(r"^[a-z0-9]{3,8}$")
_MAX_GENERATION = 999_999


def new_registration_id() -> str:
    """Random public id (never incremental)."""
    return base64.b32encode(secrets.token_bytes(10)).decode("ascii").lower()[:12]


def is_registration_id(value: object) -> bool:
    return isinstance(value, str) and bool(_REGISTRATION_RE.fullmatch(value))


def is_organization(value: object) -> bool:
    return isinstance(value, str) and bool(_ORGANIZATION_RE.fullmatch(value))


def _registration(value: str) -> str:
    if not is_registration_id(value):
        raise ValueError("invalid registration id")
    return value


def _namespace(value: str) -> str:
    if not _NAMESPACE_RE.fullmatch(value):
        raise ValueError("invalid namespace")
    return value


def target_name(registration_id: str) -> str:
    """Gateway target of a registration: ``remote-<registration>``."""
    return TARGET_PREFIX + _registration(registration_id)


def registration_of_target(target: str) -> str | None:
    """The registration of a remote target, or ``None`` for any other target."""
    if not target.startswith(TARGET_PREFIX):
        return None
    registration = target[len(TARGET_PREFIX) :]
    return registration if is_registration_id(registration) else None


def gateway_tool_name(registration_id: str, tool: str) -> str:
    """``remote-<registration>___<tool>``: the name agents and invocation signatures use."""
    if not _TOOL_NAME_RE.fullmatch(tool):
        raise ValueError("invalid tool name")
    return f"{target_name(registration_id)}{TOOL_SEPARATOR}{tool}"


def split_gateway_tool(name: str) -> tuple[str, str] | None:
    """``(registration, tool)`` of a remote Gateway tool name, or ``None``."""
    target, separator, tool = name.partition(TOOL_SEPARATOR)
    registration = registration_of_target(target)
    if not separator or registration is None or not _TOOL_NAME_RE.fullmatch(tool):
        return None
    return registration, tool


def provider_name(namespace: str, registration_id: str, generation: int) -> str:
    """Identity OAuth2 provider of one generation: ``Mango-<ns>-remote-<reg>-g<n>``."""
    if not 1 <= generation <= _MAX_GENERATION:
        raise ValueError("invalid generation")
    return f"{provider_prefix(namespace)}{_registration(registration_id)}-g{generation}"


def provider_prefix(namespace: str) -> str:
    """Prefix of every provider of remote MCPs (IAM scopes and uninstall use it)."""
    return f"Mango-{_namespace(namespace)}-remote-"


def policy_prefix(namespace: str, registration_id: str) -> str:
    """Prefix of the Cedar L2 policies of one target: ``Mango_<ns>_remote_<reg>_``."""
    return f"Mango_{_namespace(namespace)}_remote_{_registration(registration_id)}_"


def policy_name(namespace: str, registration_id: str, index: int) -> str:
    if not 1 <= index <= _MAX_GENERATION:
        raise ValueError("invalid policy index")
    return f"{policy_prefix(namespace, registration_id)}{index}"


# --- Items of Settings (D98 (12)) --------------------------------------------------------

REGISTRATION_PREFIX = "REMOTE#"
SK_REGISTRATION = "REGISTRATION"
CHANGE_PREFIX = "REMOTE_CHANGE#"
SK_CHANGE_PREFIX = "CHANGE#"
SK_PENDING = "PENDING"
ORGANIZATION_PREFIX = "REMOTE_ORG#"
SK_CURRENT = "CURRENT"
APPROVED_PREFIX = "MCP_REMOTE#"
"""Written only by the remote provisioner (IAM ``LeadingKeys``)."""
SK_APPROVED = "APPROVED"
CONSENT_PREFIX = "MCP_CONSENT#"
"""Written only by the ``RESPONSE`` interceptor (IAM ``LeadingKeys``); mango-api reads and
deletes."""
CONNECTION_SK_PREFIX = "REMOTE#"
"""``Conversations``: ``USER#<sub>`` / ``REMOTE#<reg>``, the person's connection."""

_CHANGE_ID_RE = re.compile(r"^[0-9A-Za-z]{1,40}$")
_SUBJECT_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
"""Cognito ``sub`` (a UUID); a partition key never carries anything else."""


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: int) -> dict[str, str]:
    return {"N": str(value)}


def registration_key(registration_id: str) -> dict[str, Any]:
    return {
        "PK": _s(REGISTRATION_PREFIX + _registration(registration_id)),
        "SK": _s(SK_REGISTRATION),
    }


def change_key(registration_id: str, change_id: str) -> dict[str, Any]:
    if not _CHANGE_ID_RE.fullmatch(change_id):
        raise ValueError("invalid change id")
    return {
        "PK": _s(CHANGE_PREFIX + _registration(registration_id)),
        "SK": _s(SK_CHANGE_PREFIX + change_id),
    }


def pending_change_key(registration_id: str) -> dict[str, Any]:
    """Marker of the one pending request of a registration (D46 (7))."""
    return {"PK": _s(CHANGE_PREFIX + _registration(registration_id)), "SK": _s(SK_PENDING)}


def organization_key(profile_id: str, organization: str) -> dict[str, Any]:
    """One registration per profile and organization; compared in lowercase (D93 (5))."""
    if not _PROFILE_RE.fullmatch(profile_id) or not is_organization(organization):
        raise ValueError("invalid profile or organization")
    return {
        "PK": _s(f"{ORGANIZATION_PREFIX}{profile_id}#{organization.lower()}"),
        "SK": _s(SK_CURRENT),
    }


def approved_key(registration_id: str) -> dict[str, Any]:
    return {"PK": _s(APPROVED_PREFIX + _registration(registration_id)), "SK": _s(SK_APPROVED)}


def consent_key(subject: str, registration_id: str) -> dict[str, Any]:
    if not _SUBJECT_RE.fullmatch(subject):
        raise ValueError("invalid subject")
    return {
        "PK": _s(CONSENT_PREFIX + subject),
        "SK": _s(CONNECTION_SK_PREFIX + _registration(registration_id)),
    }


# --- The 3LO ``_meta`` of the Gateway (D97 (3)) ------------------------------------------

META_KEY = "aws.bedrock-agentcore.gateway/credentialProviderConfiguration"
"""The documented key of ``params._meta`` (the one P7b' used; finding of 2026-10-27)."""


def force_authentication_meta() -> dict[str, Any]:
    """The only ``_meta`` a disconnect call may carry: it deletes that person's token."""
    return {META_KEY: {"oauthCredentialProvider": {"forceAuthentication": True}}}


def is_force_authentication_meta(value: object) -> bool:
    """True only for exactly ``force_authentication_meta()``: no ``returnUrl``, no other key,
    and ``forceAuthentication`` the boolean ``true`` (not ``1``, not ``"true"``)."""
    if not isinstance(value, dict) or set(value) != {META_KEY}:
        return False
    provider = value[META_KEY]
    if not isinstance(provider, dict) or set(provider) != {"oauthCredentialProvider"}:
        return False
    oauth = provider["oauthCredentialProvider"]
    return (
        isinstance(oauth, dict)
        and set(oauth) == {"forceAuthentication"}
        and oauth["forceAuthentication"] is True
    )


# --- The consent URL (D94 (2)) -----------------------------------------------------------

MAX_CONSENT_URL_CHARS = 2048
_REGION_RE = re.compile(r"^[a-z]{2}(?:-[a-z]+)+-[0-9]$")
_URL_CHARS_RE = re.compile(r"^[\x21-\x7e]+$")
"""Printable ASCII without spaces: no control, whitespace or non-ASCII lookalike."""


def is_consent_url(url: object, region: str) -> bool:
    """An authorization URL of AgentCore Identity in this region, and nothing else."""
    if (
        not isinstance(url, str)
        or not 0 < len(url) <= MAX_CONSENT_URL_CHARS
        or not _REGION_RE.fullmatch(region)
        or not _URL_CHARS_RE.fullmatch(url)
        or "\\" in url
    ):
        return False
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    # ``netloc`` exactly the host: no user info, no port, no other case.
    return (
        parts.scheme == "https"
        and parts.netloc == f"bedrock-agentcore.{region}.amazonaws.com"
        and parts.path.startswith("/")
    )


# --- The approved catalog (D98 (13)) -----------------------------------------------------

SIGNING_CONTEXT = b"mango.remote-mcp.v1\n"
"""Domain separation: a signature of this key is never valid as anything else."""
SIGNING_ALGORITHM: Final = "ECDSA_SHA_256"
PAYLOAD_VERSION = 1
MAX_PAYLOAD_BYTES = 32 * 1024
MAX_TOOLS = 200
MAX_TOOLSETS = 16
READONLY_HEADER = "X-MCP-Readonly"
TOOLSETS_HEADER = "X-MCP-Toolsets"

_TOOLSET_RE = re.compile(r"^[a-z][a-z0-9-]{0,23}$")
_TOOLSETS_HEADER_RE = re.compile(r"^[a-z][a-z0-9_-]{0,23}(?:,[a-z][a-z0-9_-]{0,23}){0,15}$")
_GATEWAY_ID_RE = re.compile(r"^[0-9a-z][0-9a-z-]{0,110}$")
_PROFILE_VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_FIELDS = frozenset(
    {
        "v",
        "registration_id",
        "generation",
        "revision",
        "profile_id",
        "profile_version",
        "profile_sha256",
        "gateway_id",
        "target",
        "organization",
        "toolsets",
        "headers",
        "tools",
        "probe_tool",
        "issued_at",
    }
)


_STRING_FIELDS = (
    "registration_id",
    "profile_id",
    "profile_version",
    "profile_sha256",
    "gateway_id",
    "target",
    "organization",
    "probe_tool",
)


class RemoteNotApprovedError(Exception):
    """The approved catalog is missing, altered or not the one of this call. Never says which
    check failed: the interceptor answers ``remote_not_approved`` either way."""


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _canonical(value: Any) -> bytes:
    """``mango_packs.canonical.canonical_json``: a test keeps the two equal."""
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


@dataclass(frozen=True)
class ApprovedRemote:
    """What the provisioner vouched for: the tools one remote target may serve."""

    registration_id: str
    generation: int
    """Generation of the Identity provider (a new tenant or app raises it)."""
    revision: int
    """Raised by every signing of the same generation (a change of toolsets or groups)."""
    profile_id: str
    profile_version: str
    profile_sha256: str
    """SHA-256 of the signed statement of the profile in the release."""
    gateway_id: str
    organization: str
    toolsets: tuple[str, ...]
    toolsets_header: str
    """Value of ``X-MCP-Toolsets``: the header values of ``toolsets``, comma-separated."""
    tools: frozenset[str]
    """Tool names as the server knows them (``wit_work_item``), all ``read`` (D84 (5))."""
    probe_tool: str
    issued_at: int

    @property
    def target(self) -> str:
        return target_name(self.registration_id)

    @property
    def headers(self) -> dict[str, str]:
        """The two headers the interceptor forces on every call. Never ``Authorization``: it
        would replace the vault's token (finding of 2026-10-26, TM-008)."""
        return {READONLY_HEADER: "true", TOOLSETS_HEADER: self.toolsets_header}

    def allows(self, gateway_tool: str) -> bool:
        """True for ``remote-<this registration>___<an approved tool>`` only."""
        split = split_gateway_tool(gateway_tool)
        return split is not None and split[0] == self.registration_id and split[1] in self.tools

    def _validate(self) -> None:
        if (
            not is_registration_id(self.registration_id)
            or not _is_int(self.generation)
            or not 1 <= self.generation <= _MAX_GENERATION
            or not _is_int(self.revision)
            or not 1 <= self.revision <= _MAX_GENERATION
            or not _PROFILE_RE.fullmatch(self.profile_id)
            or not _PROFILE_VERSION_RE.fullmatch(self.profile_version)
            or not _SHA256_RE.fullmatch(self.profile_sha256)
            or not _GATEWAY_ID_RE.fullmatch(self.gateway_id)
            or not is_organization(self.organization)
            or not 1 <= len(self.toolsets) <= MAX_TOOLSETS
            or list(self.toolsets) != sorted(set(self.toolsets))
            or not all(_TOOLSET_RE.fullmatch(toolset) for toolset in self.toolsets)
            or not _TOOLSETS_HEADER_RE.fullmatch(self.toolsets_header)
            or not 1 <= len(self.tools) <= MAX_TOOLS
            or not all(_TOOL_NAME_RE.fullmatch(tool) for tool in self.tools)
            or self.probe_tool not in self.tools
            or not _is_int(self.issued_at)
            or self.issued_at < 0
        ):
            raise ValueError("invalid approved remote")

    # --- Signing (remote provisioner) ---------------------------------------------------

    def encode(self) -> bytes:
        """Canonical JSON payload. Raises ``ValueError`` for anything it could not vouch for."""
        self._validate()
        payload = _canonical(
            {
                "v": PAYLOAD_VERSION,
                "registration_id": self.registration_id,
                "generation": self.generation,
                "revision": self.revision,
                "profile_id": self.profile_id,
                "profile_version": self.profile_version,
                "profile_sha256": self.profile_sha256,
                "gateway_id": self.gateway_id,
                "target": self.target,
                "organization": self.organization,
                "toolsets": list(self.toolsets),
                "headers": self.headers,
                "tools": sorted(self.tools),
                "probe_tool": self.probe_tool,
                "issued_at": self.issued_at,
            }
        )
        if len(payload) > MAX_PAYLOAD_BYTES:
            raise ValueError("approved remote too large")
        return payload

    # --- Verifying (REQUEST interceptor, mango-api, agent provisioner) ------------------

    @classmethod
    def verify(
        cls,
        public_key: ec.EllipticCurvePublicKey,
        item: Mapping[str, object],
        *,
        target: str,
        gateway_id: str,
    ) -> ApprovedRemote:
        """The catalog ``item`` vouches for, if its signature is right and it was issued for
        this target of this Gateway. ``item`` holds plain values (``payload``, ``signature``)."""
        payload_text, signature_text = item.get("payload"), item.get("signature")
        if (
            not isinstance(payload_text, str)
            or not isinstance(signature_text, str)
            or not 0 < len(payload_text) <= MAX_PAYLOAD_BYTES * 2
            or not 0 < len(signature_text) <= 256  # noqa: PLR2004
        ):
            raise RemoteNotApprovedError
        try:
            payload = _b64url_decode(payload_text)
            signature = base64.b64decode(signature_text, validate=True)
            public_key.verify(signature, SIGNING_CONTEXT + payload, ec.ECDSA(hashes.SHA256()))
            claims = json.loads(payload)
        except (InvalidSignature, ValueError, binascii.Error):
            raise RemoteNotApprovedError from None
        approved = _from_claims(claims)
        if (
            approved is None
            or approved.target != target
            or approved.gateway_id != gateway_id
            # The payload is what was signed: it must be the canonical form of itself.
            or approved.encode() != payload
        ):
            raise RemoteNotApprovedError
        return approved


def _from_claims(claims: object) -> ApprovedRemote | None:
    if not isinstance(claims, dict) or set(claims) != _FIELDS or claims["v"] != PAYLOAD_VERSION:
        return None
    data = cast(dict[str, Any], claims)
    headers, toolsets, tools = data["headers"], data["toolsets"], data["tools"]
    if (
        not isinstance(headers, dict)
        or set(headers) != {READONLY_HEADER, TOOLSETS_HEADER}
        or headers[READONLY_HEADER] != "true"
        or not isinstance(headers[TOOLSETS_HEADER], str)
        or not isinstance(toolsets, list)
        or not all(isinstance(toolset, str) for toolset in toolsets)
        or not isinstance(tools, list)
        or not all(isinstance(tool, str) for tool in tools)
        or len(set(tools)) != len(tools)
    ):
        return None
    if not all(isinstance(data[name], str) for name in _STRING_FIELDS):
        return None
    try:
        approved = ApprovedRemote(
            registration_id=data["registration_id"],
            generation=data["generation"],
            revision=data["revision"],
            profile_id=data["profile_id"],
            profile_version=data["profile_version"],
            profile_sha256=data["profile_sha256"],
            gateway_id=data["gateway_id"],
            organization=data["organization"],
            toolsets=tuple(toolsets),
            toolsets_header=headers[TOOLSETS_HEADER],
            tools=frozenset(tools),
            probe_tool=data["probe_tool"],
            issued_at=data["issued_at"],
        )
        approved._validate()
    except ValueError:
        return None
    # The registration in the payload is the target's suffix.
    return approved if data["target"] == approved.target else None


def signing_digest(payload: bytes) -> bytes:
    """What KMS signs (``MessageType=DIGEST``, ``ECDSA_SHA_256``)."""
    return hashlib.sha256(SIGNING_CONTEXT + payload).digest()


def item_fields(payload: bytes, signature: bytes) -> dict[str, str]:
    """``payload`` and ``signature`` attributes of ``MCP_REMOTE#<reg>`` / ``APPROVED``."""
    return {"payload": _b64url(payload), "signature": base64.b64encode(signature).decode()}


def load_public_key(der: bytes) -> ec.EllipticCurvePublicKey:
    """The public half of ``alias/Mango-<ns>-remote-mcp`` (``kms:GetPublicKey``)."""
    key = serialization.load_der_public_key(der)
    if not isinstance(key, ec.EllipticCurvePublicKey) or key.curve.name != "secp256r1":
        raise ValueError("the remote MCP key must be ECC NIST P-256")
    return key


# --- The pending consent (D98 (3)) -------------------------------------------------------

CONSENT_TTL_SECONDS = 600
ConsentSource = Literal["chat", "task", "playground", "connect"]
CONSENT_SOURCES: frozenset[str] = frozenset({"chat", "task", "playground", "connect"})


@dataclass(frozen=True)
class PendingConsent:
    """A consent URL the Gateway handed out for one person and one registration."""

    registration_id: str
    authorization_url: str
    source: ConsentSource
    created_at: int
    expires_at: int
    session_sha256: str | None = None
    """SHA-256 of the Identity session, if the URL names it (D98, live check V-3)."""

    @classmethod
    def new(
        cls,
        registration_id: str,
        authorization_url: str,
        source: ConsentSource,
        *,
        now: int,
        region: str,
        session_sha256: str | None = None,
    ) -> PendingConsent:
        consent = cls(
            registration_id=registration_id,
            authorization_url=authorization_url,
            source=source,
            created_at=now,
            expires_at=now + CONSENT_TTL_SECONDS,
            session_sha256=session_sha256,
        )
        if not consent._valid(region):
            raise ValueError("invalid pending consent")
        return consent

    def _valid(self, region: str) -> bool:
        return (
            is_registration_id(self.registration_id)
            and is_consent_url(self.authorization_url, region)
            and isinstance(self.source, str)
            and self.source in CONSENT_SOURCES
            and _is_int(self.created_at)
            and _is_int(self.expires_at)
            and 0 < self.expires_at - self.created_at <= CONSENT_TTL_SECONDS
            and (
                self.session_sha256 is None
                or (
                    isinstance(self.session_sha256, str)
                    and bool(_SHA256_RE.fullmatch(self.session_sha256))
                )
            )
        )

    def to_item(self, subject: str) -> dict[str, Any]:
        """DynamoDB item (typed values). ``subject`` must come from the verified invocation
        signature, never from the body of a request or a response (TM-017)."""
        item: dict[str, Any] = {
            **consent_key(subject, self.registration_id),
            "authorization_url": _s(self.authorization_url),
            "source": _s(self.source),
            "created_at": _n(self.created_at),
            "expires_at": _n(self.expires_at),
            "ttl": _n(self.expires_at),
        }
        if self.session_sha256 is not None:
            item["session_sha256"] = _s(self.session_sha256)
        return item

    @classmethod
    def from_item(
        cls,
        item: Mapping[str, Any],
        *,
        subject: str,
        registration_id: str,
        region: str,
        now: float,
    ) -> PendingConsent | None:
        """The pending consent of ``item`` if it is this person's, for this registration,
        unexpired and its URL is still an Identity URL; ``None`` otherwise (TTL deletion is
        late, so expiry is checked here)."""
        try:
            if {"PK": item["PK"], "SK": item["SK"]} != consent_key(subject, registration_id):
                return None
            session = item.get("session_sha256")
            consent = cls(
                registration_id=registration_id,
                authorization_url=item["authorization_url"]["S"],
                source=item["source"]["S"],
                created_at=int(item["created_at"]["N"]),
                expires_at=int(item["expires_at"]["N"]),
                session_sha256=None if session is None else session["S"],
            )
        except (KeyError, TypeError, ValueError):
            return None
        if not consent._valid(region) or consent.expires_at <= now:
            return None
        return consent
