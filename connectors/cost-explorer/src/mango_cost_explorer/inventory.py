"""Organization inventory: accounts with their OU path, read through the billing reader."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import TYPE_CHECKING

from mango_cost_explorer.scope import Account

if TYPE_CHECKING:
    from mypy_boto3_organizations import OrganizationsClient

INVENTORY_ACTIONS = (
    "organizations:ListRoots",
    "organizations:ListChildren",
    "organizations:ListAccounts",
    "organizations:ListOrganizationalUnitsForParent",
)
DEFAULT_TTL_SECONDS = 3600
MAX_OU_DEPTH = 5  # AWS Organizations allows at most five levels of OUs under the root.


def load_accounts(org: OrganizationsClient) -> list[Account]:
    """Walk the organization tree and return every active account with its OU path."""
    names: dict[str, str] = {}
    for accounts_page in org.get_paginator("list_accounts").paginate():
        for acct in accounts_page["Accounts"]:
            if acct.get("Status") == "ACTIVE" or acct.get("State") == "ACTIVE":
                names[acct["Id"]] = acct["Name"]

    accounts: list[Account] = []
    roots = org.list_roots()["Roots"]
    # (parent id, OU id path from the root, OU name path below the root)
    stack: list[tuple[str, tuple[str, ...], tuple[str, ...]]] = [
        (r["Id"], (r["Id"],), ()) for r in roots
    ]
    children = org.get_paginator("list_children")
    ous = org.get_paginator("list_organizational_units_for_parent")
    while stack:
        parent_id, path, ou_names = stack.pop()
        if len(path) > MAX_OU_DEPTH + 1:
            continue
        for page in children.paginate(ParentId=parent_id, ChildType="ACCOUNT"):
            for child in page["Children"]:
                if child["Id"] in names:
                    accounts.append(
                        Account(child["Id"], names[child["Id"]], path, ou_names=ou_names)
                    )
        for ou_page in ous.paginate(ParentId=parent_id):
            for ou in ou_page["OrganizationalUnits"]:
                stack.append((ou["Id"], (*path, ou["Id"]), (*ou_names, ou.get("Name", ou["Id"]))))
    return accounts


class InventoryCache:
    """In-memory cache per Lambda execution environment."""

    def __init__(
        self,
        loader: Callable[[], list[Account]],
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._loader = loader
        self._ttl = ttl_seconds
        self._clock = clock
        self._value: list[Account] | None = None
        self._loaded_at = 0.0

    def get(self) -> list[Account]:
        now = self._clock()
        if self._value is None or now - self._loaded_at > self._ttl:
            self._value = self._loader()
            self._loaded_at = now
        return self._value
