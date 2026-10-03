"""Mango identity: verified Cognito access tokens and the user context derived from them.

Claims ``mango_role`` and ``mango_business_unit`` are added by the Cognito pre-token
generation trigger from Cognito groups (D14); ``cognito:groups`` is written by Cognito itself.
Only IaC or an administrator changes group membership (TM-I4). Nothing here trusts client or
model input.

A user needs at least one Mango group to get in (D20: deny by default). The FinOps role is
optional: a user may belong to access groups or to the agent creators group without it.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import jwt

from mango_core.groups import GROUP_AGENT_CREATOR, MAX_USER_GROUPS, is_group_name

ROLE_FINOPS_CENTRAL = "finops-central"
ROLE_BU_LEAD = "bu-lead"
KNOWN_ROLES = frozenset({ROLE_FINOPS_CENTRAL, ROLE_BU_LEAD})

CLAIM_ROLE = "mango_role"
CLAIM_GROUPS = "cognito:groups"
CLAIM_BUSINESS_UNIT = "mango_business_unit"
CLAIM_ADMIN = "mango_admin"
CLAIM_EMAIL = "mango_email"  # display only, never used for authorization
CLAIM_NAME = "mango_name"  # display only, chosen by the user at sign-up
MAX_EMAIL_LENGTH = 254
MAX_NAME_LENGTH = 128

_REQUIRED_CLAIMS = ["exp", "iat", "iss", "sub", "token_use", "client_id"]


class IdentityError(Exception):
    """No trustworthy identity is available; callers must fail closed."""


class NoGroupError(IdentityError):
    """A verified user who belongs to no Mango group yet (D20: deny by default)."""


class NoRoleError(IdentityError):
    """A verified user without a FinOps role, where one is required (the FinOps connector)."""


@dataclass(frozen=True)
class UserContext:
    user_id: str
    role: str | None
    business_unit: str | None
    is_admin: bool
    email: str | None = None
    name: str | None = None
    groups: frozenset[str] = frozenset()

    @property
    def is_central(self) -> bool:
        return self.role == ROLE_FINOPS_CENTRAL

    @property
    def is_agent_creator(self) -> bool:
        return GROUP_AGENT_CREATOR in self.groups


def groups_from_claims(claims: Mapping[str, Any]) -> frozenset[str]:
    """Mango groups of a verified token: lowercase names only, anything else is ignored.

    Cognito also lists the groups it creates for federated identity providers
    (``<pool id>_<provider>``); those never match a Mango group name.
    """
    raw = claims.get(CLAIM_GROUPS)
    if raw is None:
        return frozenset()
    if not isinstance(raw, list) or len(raw) > MAX_USER_GROUPS:
        raise IdentityError("invalid groups")
    return frozenset(g for g in raw if is_group_name(g))


def user_from_claims(claims: Mapping[str, Any]) -> UserContext:
    """Build the user context from claims of an already verified access token."""
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        raise IdentityError("missing subject")
    groups = groups_from_claims(claims)
    role = claims.get(CLAIM_ROLE)
    if role is not None and role not in KNOWN_ROLES:
        raise IdentityError("unknown FinOps role")
    if role is None and not groups:
        raise NoGroupError("user has no Mango group")
    business_unit = claims.get(CLAIM_BUSINESS_UNIT) or None
    if business_unit is not None and not isinstance(business_unit, str):
        raise IdentityError("invalid business unit")
    if role == ROLE_BU_LEAD and not business_unit:
        raise IdentityError("business unit is required for bu-lead")
    return UserContext(
        user_id=sub,
        role=role,
        business_unit=business_unit,
        is_admin=claims.get(CLAIM_ADMIN) == "true",
        email=_display_email(claims.get(CLAIM_EMAIL)),
        name=_display_name(claims.get(CLAIM_NAME)),
        groups=groups,
    )


def require_role(user: UserContext) -> str:
    """The FinOps role, for components that only serve FinOps users (fail closed)."""
    if user.role is None:
        raise NoRoleError("user has no FinOps role")
    return user.role


def _display_email(value: object) -> str | None:
    return value if isinstance(value, str) and 0 < len(value) <= MAX_EMAIL_LENGTH else None


def _display_name(value: object) -> str | None:
    if not isinstance(value, str) or not 0 < len(value) <= MAX_NAME_LENGTH:
        return None
    return value if value.isprintable() and value.strip() == value else None


class AccessTokenVerifier:
    """Verifies Cognito access tokens: signature (cached JWKS), issuer, expiry, client and use."""

    def __init__(
        self,
        issuer: str,
        client_id: str,
        jwks_client: jwt.PyJWKClient | None = None,
        leeway_seconds: int = 30,
    ) -> None:
        if not issuer.startswith("https://cognito-idp.") or not client_id:
            raise ValueError("invalid verifier configuration")
        self._issuer = issuer
        self._client_id = client_id
        self._jwks = jwks_client or jwt.PyJWKClient(
            f"{issuer}/.well-known/jwks.json", cache_keys=True, lifespan=3600, timeout=5
        )
        self._leeway = leeway_seconds

    def verify(self, token: str) -> dict[str, Any]:
        try:
            key = self._jwks.get_signing_key_from_jwt(token)
            claims: dict[str, Any] = jwt.decode(
                token,
                key=key.key,
                algorithms=["RS256"],
                issuer=self._issuer,
                leeway=self._leeway,
                options={"require": _REQUIRED_CLAIMS, "verify_aud": False},
            )
        except jwt.PyJWTError as exc:
            raise IdentityError("invalid access token") from exc
        # Cognito access tokens carry no "aud"; the client binding is "client_id".
        if claims.get("token_use") != "access":
            raise IdentityError("not an access token")
        if claims.get("client_id") != self._client_id:
            raise IdentityError("token issued to another client")
        return claims
