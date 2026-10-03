from typing import Any

from mango_cost_explorer import tools
from mango_cost_explorer.inventory import load_accounts
from mango_cost_explorer.scope import AccessScope, Account


class _Paginator:
    def __init__(self, pages: dict[str, list[dict[str, Any]]], key: str) -> None:
        self._pages = pages
        self._key = key

    def paginate(self, ParentId: str, **_kw: Any) -> list[dict[str, Any]]:  # noqa: N803
        return [{self._key: self._pages.get(ParentId, [])}]


class _Org:
    """Root r -> OU Security (ou-sec) -> OU Prod (ou-prod); accounts at each level."""

    def list_roots(self) -> dict[str, Any]:
        return {"Roots": [{"Id": "r"}]}

    def get_paginator(self, name: str) -> Any:
        if name == "list_accounts":
            return _Accounts()
        if name == "list_children":
            return _Paginator(
                {
                    "r": [{"Id": "111111111111"}],
                    "ou-sec": [{"Id": "222222222222"}],
                    "ou-prod": [{"Id": "333333333333"}, {"Id": "999999999999"}],
                },
                "Children",
            )
        return _Paginator(
            {
                "r": [{"Id": "ou-sec", "Name": "Security"}],
                "ou-sec": [{"Id": "ou-prod", "Name": "Prod"}],
            },
            "OrganizationalUnits",
        )


class _Accounts:
    def paginate(self) -> list[dict[str, Any]]:
        return [
            {
                "Accounts": [
                    {"Id": "111111111111", "Name": "Management", "Status": "ACTIVE"},
                    {"Id": "222222222222", "Name": "Audit", "Status": "ACTIVE"},
                    {"Id": "333333333333", "Name": "Payments", "Status": "ACTIVE"},
                    {"Id": "999999999999", "Name": "Closed", "Status": "SUSPENDED"},
                ]
            }
        ]


def test_inventory_keeps_ou_ids_and_names() -> None:
    accounts = {a.account_id: a for a in load_accounts(_Org())}  # type: ignore[arg-type]
    assert set(accounts) == {"111111111111", "222222222222", "333333333333"}
    assert accounts["111111111111"].ou_path == ("r",)
    assert accounts["111111111111"].ou_names == ()
    assert accounts["333333333333"].ou_path == ("r", "ou-sec", "ou-prod")
    assert accounts["333333333333"].ou_names == ("Security", "Prod")


def test_list_accounts_exposes_business_units_and_ou_names() -> None:
    scope = AccessScope(
        org_wide=False,
        accounts=(
            Account(
                "333333333333",
                "Payments",
                ("r", "ou-sec", "ou-prod"),
                ou_names=("Security", "Prod"),
                business_units=("security",),
            ),
        ),
    )
    result = tools.list_accounts_in_scope(scope, tools.NoArgs())
    assert result["accounts"] == [
        {
            "account_id": "333333333333",
            "name": "Payments",
            "business_units": ["security"],
            "ou_path": ["Security", "Prod"],
        }
    ]
