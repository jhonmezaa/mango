import time
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from mango_core.identity import (
    AccessTokenVerifier,
    IdentityError,
    NoGroupError,
    NoRoleError,
    require_role,
    user_from_claims,
)

ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST"
CLIENT = "webclient123"

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class _FakeJwks:
    def get_signing_key_from_jwt(self, _token: str) -> Any:
        return jwt.PyJWK.from_dict(
            {**jwt.algorithms.RSAAlgorithm.to_jwk(_KEY.public_key(), as_dict=True), "alg": "RS256"}
        )


def _token(key: Any = _KEY, **overrides: Any) -> str:
    now = int(time.time())
    claims: dict[str, Any] = {
        "sub": "user-1",
        "iss": ISSUER,
        "client_id": CLIENT,
        "token_use": "access",
        "iat": now,
        "exp": now + 600,
        "mango_role": "bu-lead",
        "mango_business_unit": "security",
    }
    claims.update(overrides)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, key, algorithm="RS256")


@pytest.fixture
def verifier() -> AccessTokenVerifier:
    return AccessTokenVerifier(ISSUER, CLIENT, jwks_client=_FakeJwks())  # type: ignore[arg-type]


def test_valid_access_token(verifier: AccessTokenVerifier) -> None:
    user = user_from_claims(verifier.verify(_token()))
    assert user.user_id == "user-1"
    assert user.business_unit == "security"
    assert not user.is_central


@pytest.mark.parametrize(
    "overrides",
    [
        {"token_use": "id"},
        {"client_id": "other"},
        {"iss": "https://cognito-idp.us-east-1.amazonaws.com/other"},
        {"exp": int(time.time()) - 3600},
        {"client_id": None},
    ],
)
def test_rejected_tokens(verifier: AccessTokenVerifier, overrides: dict[str, Any]) -> None:
    with pytest.raises(IdentityError):
        verifier.verify(_token(**overrides))


def test_wrong_signature_rejected(verifier: AccessTokenVerifier) -> None:
    with pytest.raises(IdentityError):
        verifier.verify(_token(key=_OTHER_KEY))


def test_unsigned_token_rejected(verifier: AccessTokenVerifier) -> None:
    unsigned = jwt.encode({"sub": "x"}, key=None, algorithm="none")
    with pytest.raises(IdentityError):
        verifier.verify(unsigned)


@pytest.mark.parametrize(
    "claims",
    [
        {"sub": "u", "mango_role": "superadmin"},
        {"sub": "u"},
        {"sub": "u", "mango_role": "bu-lead"},
        {"sub": "", "mango_role": "finops-central"},
    ],
)
def test_user_context_fails_closed(claims: dict[str, Any]) -> None:
    with pytest.raises(IdentityError):
        user_from_claims(claims)


def test_central_without_business_unit() -> None:
    user = user_from_claims({"sub": "u", "mango_role": "finops-central"})
    assert user.is_central
    assert user.business_unit is None


def test_email_claim_is_display_only_and_validated() -> None:
    base = {"sub": "u", "mango_role": "finops-central"}
    assert user_from_claims({**base, "mango_email": "ana@example.com"}).email == "ana@example.com"
    assert user_from_claims({**base, "mango_email": 42}).email is None
    assert user_from_claims({**base, "mango_email": "x" * 300}).email is None
    assert user_from_claims(base).email is None


def test_user_without_group_is_a_distinct_denial() -> None:
    with pytest.raises(NoGroupError):
        user_from_claims({"sub": "u"})
    with pytest.raises(NoGroupError):
        user_from_claims({"sub": "u", "cognito:groups": []})
    # An unknown role is not "no group": it stays a generic identity error.
    with pytest.raises(IdentityError) as info:
        user_from_claims({"sub": "u", "mango_role": "superadmin"})
    assert not isinstance(info.value, NoGroupError)


def test_user_with_a_group_and_no_finops_role_gets_in() -> None:
    user = user_from_claims({"sub": "u", "cognito:groups": ["mango-agent-creator", "hr"]})
    assert user.role is None
    assert user.groups == frozenset({"mango-agent-creator", "hr"})
    assert user.is_agent_creator
    assert not user.is_central
    assert not user.is_admin
    with pytest.raises(NoRoleError):
        require_role(user)


def test_role_users_keep_their_groups() -> None:
    claims = {
        "sub": "u",
        "mango_role": "bu-lead",
        "mango_business_unit": "security",
        "cognito:groups": ["bu-lead", "bu-security"],
    }
    user = user_from_claims(claims)
    assert require_role(user) == "bu-lead"
    assert user.groups == frozenset({"bu-lead", "bu-security"})
    assert not user.is_agent_creator


def test_groups_never_grant_admin_or_a_role() -> None:
    # The admin flag and the role come only from the pre-token claims.
    user = user_from_claims({"sub": "u", "cognito:groups": ["mango-admin", "finops-central"]})
    assert not user.is_admin
    assert user.role is None


@pytest.mark.parametrize(
    "names",
    [
        ["us-east-1_AbCdEfGhI_Okta"],  # created by Cognito for a federated provider
        ["Admins"],
        ["a"],
        ["-x"],
        ["x" * 65],
        ["hr team"],
        [42],
        [None],
    ],
)
def test_names_that_are_not_mango_groups_are_ignored(names: list[object]) -> None:
    with pytest.raises(NoGroupError):
        user_from_claims({"sub": "u", "cognito:groups": names})
    user = user_from_claims({"sub": "u", "cognito:groups": [*names, "hr"]})
    assert user.groups == frozenset({"hr"})


@pytest.mark.parametrize("groups", ["hr", {"hr": True}, 7, ["g"] * 101])
def test_malformed_groups_claim_fails_closed(groups: object) -> None:
    with pytest.raises(IdentityError) as info:
        user_from_claims({"sub": "u", "mango_role": "finops-central", "cognito:groups": groups})
    assert not isinstance(info.value, NoGroupError)


@pytest.mark.parametrize(
    ("value", "expected"),
    [("Usuario 1", "Usuario 1"), (" x", None), ("a" * 129, None), ("x\u200b", None), (3, None)],
)
def test_name_claim_is_display_only_and_validated(value: object, expected: str | None) -> None:
    user = user_from_claims({"sub": "u", "mango_role": "finops-central", "mango_name": value})
    assert user.name == expected
