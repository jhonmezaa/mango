import pytest

from mango_core.identity import IdentityError, user_from_claims
from mango_cost_explorer.scope import (
    Account,
    ScopeError,
    effective_account_ids,
    resolve_scope,
)

ROOT = "r-root"
OU_SANDBOX = "ou-root-sandbox"
OU_SECURITY = "ou-root-security"

ACCOUNTS = [
    Account("111111111111", "Sandbox", (ROOT, OU_SANDBOX)),
    Account("222222222222", "Audit", (ROOT, OU_SECURITY)),
    Account("333333333333", "Log Archive", (ROOT, OU_SECURITY)),
    Account("444444444444", "Management", (ROOT,)),
]
BU_OUS = {"sandbox": frozenset({OU_SANDBOX}), "security": frozenset({OU_SECURITY})}


def _claims(**overrides: object) -> dict[str, object]:
    claims: dict[str, object] = {
        "sub": "user-1",
        "mango_role": "bu-lead",
        "mango_business_unit": "security",
    }
    claims.update(overrides)
    return claims


def test_bu_lead_sees_only_own_business_unit() -> None:
    scope = resolve_scope(user_from_claims(_claims()), ACCOUNTS, BU_OUS)
    assert not scope.org_wide
    assert scope.account_ids == {"222222222222", "333333333333"}


def test_accounts_are_labelled_with_their_business_units() -> None:
    user = user_from_claims(_claims(**{"mango_role": "finops-central"}))
    scope = resolve_scope(user, ACCOUNTS, BU_OUS)
    labels = {a.account_id: a.business_units for a in scope.accounts}
    assert labels == {
        "111111111111": ("sandbox",),
        "222222222222": ("security",),
        "333333333333": ("security",),
        "444444444444": (),
    }


def test_central_sees_whole_organization() -> None:
    user = user_from_claims(_claims(**{"mango_role": "finops-central"}))
    scope = resolve_scope(user, ACCOUNTS, BU_OUS)
    assert scope.org_wide
    assert len(scope.accounts) == len(ACCOUNTS)


def test_unknown_business_unit_sees_nothing() -> None:
    user = user_from_claims(_claims(**{"mango_business_unit": "finance"}))
    scope = resolve_scope(user, ACCOUNTS, BU_OUS)
    with pytest.raises(ScopeError):
        effective_account_ids(scope, None)


def test_requested_account_outside_scope_is_rejected() -> None:
    scope = resolve_scope(user_from_claims(_claims()), ACCOUNTS, BU_OUS)
    with pytest.raises(ScopeError, match="outside"):
        effective_account_ids(scope, ["111111111111"])


def test_mixed_request_is_rejected_not_trimmed() -> None:
    scope = resolve_scope(user_from_claims(_claims()), ACCOUNTS, BU_OUS)
    with pytest.raises(ScopeError, match="outside"):
        effective_account_ids(scope, ["222222222222", "111111111111"])


def test_no_request_means_all_in_scope() -> None:
    scope = resolve_scope(user_from_claims(_claims()), ACCOUNTS, BU_OUS)
    assert effective_account_ids(scope, None) == ["222222222222", "333333333333"]


@pytest.mark.parametrize("bad", ["12345", "abcdefghijkl", "2222222222220"])
def test_malformed_account_ids_are_rejected(bad: str) -> None:
    scope = resolve_scope(user_from_claims(_claims()), ACCOUNTS, BU_OUS)
    with pytest.raises(ScopeError):
        effective_account_ids(scope, [bad])


@pytest.mark.parametrize(
    "overrides",
    [
        {"sub": ""},
        {"mango_role": "admin"},
        {"mango_role": ""},
        {"mango_business_unit": None},
    ],
)
def test_identity_fails_closed(overrides: dict[str, object]) -> None:
    with pytest.raises(IdentityError):
        user_from_claims(_claims(**overrides))
