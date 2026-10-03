"""Account scope enforcement (threats TM-C2 / TM-003).

The set of accounts a user may see is computed from the verified identity and the
organization inventory. Accounts requested by the model are only ever intersected with it.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, replace

from mango_core.identity import UserContext

_ACCOUNT_ID_RE = re.compile(r"^\d{12}$")


class ScopeError(Exception):
    """The request falls outside the user's account scope."""


@dataclass(frozen=True)
class Account:
    account_id: str
    name: str
    ou_path: tuple[str, ...]
    """OU ids from the root down to the account's parent."""
    ou_names: tuple[str, ...] = ()
    """Display names for ``ou_path`` below the root (for answers about OUs)."""
    business_units: tuple[str, ...] = ()
    """Business units (áreas) whose OUs contain the account; set by ``resolve_scope``."""


@dataclass(frozen=True)
class AccessScope:
    org_wide: bool
    accounts: tuple[Account, ...]

    @property
    def account_ids(self) -> frozenset[str]:
        return frozenset(a.account_id for a in self.accounts)


def resolve_scope(
    user: UserContext,
    accounts: Iterable[Account],
    business_unit_ous: Mapping[str, frozenset[str]],
) -> AccessScope:
    """Return the accounts visible to ``user``.

    ``business_unit_ous`` maps a business unit to OU ids; an account is in scope when any
    OU in its path belongs to the user's business unit.
    """
    all_accounts = tuple(
        replace(a, business_units=_business_units_of(a, business_unit_ous))
        for a in sorted(accounts, key=lambda a: a.account_id)
    )
    if user.is_central:
        return AccessScope(org_wide=True, accounts=all_accounts)
    allowed_ous = business_unit_ous.get(user.business_unit or "", frozenset())
    visible = tuple(a for a in all_accounts if allowed_ous.intersection(a.ou_path))
    return AccessScope(org_wide=False, accounts=visible)


def _business_units_of(
    account: Account, business_unit_ous: Mapping[str, frozenset[str]]
) -> tuple[str, ...]:
    path = set(account.ou_path)
    return tuple(sorted(bu for bu, ous in business_unit_ous.items() if ous & path))


def effective_account_ids(scope: AccessScope, requested: Iterable[str] | None) -> list[str]:
    """Intersect requested accounts with the scope. Never widens it.

    ``None`` means "all accounts in scope". An explicit request containing any account
    outside the scope is rejected rather than silently trimmed, so the agent can tell the
    user why.
    """
    if not scope.accounts:
        raise ScopeError("no accounts are in scope for this user")
    if requested is None:
        return sorted(scope.account_ids)
    wanted = set(requested)
    for account_id in wanted:
        if not _ACCOUNT_ID_RE.fullmatch(account_id):
            raise ScopeError("invalid account id")
    outside = wanted - scope.account_ids
    if outside:
        raise ScopeError("one or more requested accounts are outside the user's scope")
    if not wanted:
        raise ScopeError("no accounts requested")
    return sorted(wanted)
