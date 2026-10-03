"""``create_budget``: a monthly cost budget in the payer account (AWS Budgets).

The first write tool of Mango, chosen because it is cheap to undo: a budget only watches
spend, it stops nothing, and this one notifies nobody (no subscribers, so nothing leaves the
account). Its name always starts with the installation's prefix: the payer role can only touch
budgets with that prefix, and the session of each call only the one being created.
"""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING, Annotated, Any

from botocore.exceptions import ClientError
from pydantic import BaseModel, ConfigDict, Field

if TYPE_CHECKING:
    from mypy_boto3_budgets import BudgetsClient

ACTIONS = ("budgets:ModifyBudget",)
"""The IAM action of ``CreateBudget`` (it also covers updating and deleting a budget, which
is why the role and the session are scoped to the budget's name)."""
MAX_AMOUNT_USD = 1_000_000_000
MAX_ACCOUNTS = 20


class CreateBudgetArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9-]{0,39}$")]
    amount_usd: Annotated[float, Field(gt=0, le=MAX_AMOUNT_USD, allow_inf_nan=False)]
    account_ids: Annotated[
        list[Annotated[str, Field(pattern=r"^\d{12}$")]], Field(max_length=MAX_ACCOUNTS)
    ] = []


class ToolFailedError(Exception):
    """A failure the caller may be told about, as a short code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def budget_name(prefix: str, args: CreateBudgetArgs) -> str:
    return f"{prefix}{args.name}"


def budget_arn(account_id: str, name: str) -> str:
    return f"arn:aws:budgets::{account_id}:budget/{name}"


def create_budget(
    client: BudgetsClient, account_id: str, name: str, args: CreateBudgetArgs
) -> dict[str, Any]:
    amount = Decimal(str(args.amount_usd)).quantize(Decimal("0.01"))
    budget: dict[str, Any] = {
        "BudgetName": name,
        "BudgetType": "COST",
        "TimeUnit": "MONTHLY",
        "BudgetLimit": {"Amount": str(amount), "Unit": "USD"},
    }
    if args.account_ids:
        budget["CostFilters"] = {"LinkedAccount": sorted(set(args.account_ids))}
    try:
        # No notifications and no subscribers: the budget sends nothing to anyone.
        client.create_budget(AccountId=account_id, Budget=budget)  # type: ignore[arg-type]
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "DuplicateRecordException":
            raise ToolFailedError("already_exists", "a budget with that name exists") from exc
        raise
    return {
        "status": "created",
        "budget_name": name,
        "amount_usd": str(amount),
        "period": "MONTHLY",
        "account_ids": sorted(set(args.account_ids)),
    }
