"""FinOps tools exposed through the AgentCore Gateway.

Arguments are model output: they are validated strictly (TM-C5) and never carry identity.
Every Cost Explorer query is filtered by the accounts in the user's scope (TM-C2).
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import TYPE_CHECKING, Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from mango_cost_explorer.scope import AccessScope, ScopeError, effective_account_ids

if TYPE_CHECKING:
    from mypy_boto3_ce import CostExplorerClient
    from mypy_boto3_ce.type_defs import ExpressionTypeDef, GroupDefinitionTypeDef

MAX_RANGE_DAYS = 400  # ~13 months, Cost Explorer's history window
MAX_DAILY_RANGE_DAYS = 92
MAX_FORECAST_DAYS = 366
MAX_ITEMS = 50

AccountId = Annotated[str, Field(pattern=r"^\d{12}$")]
ServiceName = Annotated[str, Field(min_length=1, max_length=128)]
Metric = Literal["UnblendedCost", "AmortizedCost", "NetUnblendedCost"]
Dimension = Literal["SERVICE", "LINKED_ACCOUNT", "REGION", "USAGE_TYPE", "INSTANCE_TYPE"]


class ToolError(Exception):
    """A user-facing error the agent can explain (not an internal failure)."""


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class GroupBy(_Args):
    type: Literal["DIMENSION", "TAG"]
    key: Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[\w.:/=+\-@ ]+$")]

    @model_validator(mode="after")
    def _dimension_is_known(self) -> GroupBy:
        allowed = {"SERVICE", "LINKED_ACCOUNT", "REGION", "USAGE_TYPE", "INSTANCE_TYPE"}
        if self.type == "DIMENSION" and self.key not in allowed:
            raise ValueError(f"unsupported dimension {self.key}")
        return self


class DateRange(_Args):
    start_date: date
    end_date: date = Field(description="Exclusive end date")

    @model_validator(mode="after")
    def _valid_range(self) -> DateRange:
        if self.end_date <= self.start_date:
            raise ValueError("end_date must be after start_date")
        return self


class CostAndUsageArgs(DateRange):
    granularity: Literal["DAILY", "MONTHLY"] = "MONTHLY"
    metric: Metric = "UnblendedCost"
    group_by: Annotated[list[GroupBy], Field(max_length=2)] = []
    account_ids: Annotated[list[AccountId], Field(max_length=MAX_ITEMS)] | None = None
    services: (
        Annotated[list[Annotated[str, Field(max_length=128)]], Field(max_length=20)] | None
    ) = None

    @model_validator(mode="after")
    def _limits(self) -> CostAndUsageArgs:
        days = (self.end_date - self.start_date).days
        if days > MAX_RANGE_DAYS:
            raise ValueError("date range exceeds 13 months")
        if self.granularity == "DAILY" and days > MAX_DAILY_RANGE_DAYS:
            raise ValueError("DAILY granularity is limited to 92 days")
        return self


class ForecastArgs(DateRange):
    granularity: Literal["DAILY", "MONTHLY"] = "MONTHLY"
    metric: Literal["UNBLENDED_COST", "AMORTIZED_COST", "NET_UNBLENDED_COST"] = "UNBLENDED_COST"
    account_ids: Annotated[list[AccountId], Field(max_length=MAX_ITEMS)] | None = None

    @model_validator(mode="after")
    def _limits(self) -> ForecastArgs:
        if (self.end_date - self.start_date).days > MAX_FORECAST_DAYS:
            raise ValueError("forecast horizon exceeds 12 months")
        return self


class AnomaliesArgs(DateRange):
    account_ids: Annotated[list[AccountId], Field(max_length=MAX_ITEMS)] | None = None


class CoverageArgs(DateRange):
    account_ids: Annotated[list[AccountId], Field(max_length=MAX_ITEMS)] | None = None


class SavingsPlansRecommendationArgs(_Args):
    savings_plans_type: Literal["COMPUTE_SP", "EC2_INSTANCE_SP", "SAGEMAKER_SP"] = "COMPUTE_SP"
    term: Literal["ONE_YEAR", "THREE_YEARS"] = "ONE_YEAR"
    payment_option: Literal["NO_UPFRONT", "PARTIAL_UPFRONT", "ALL_UPFRONT"] = "NO_UPFRONT"
    lookback_days: Literal["SEVEN_DAYS", "THIRTY_DAYS", "SIXTY_DAYS"] = "THIRTY_DAYS"


class NoArgs(_Args):
    pass


def _money(amount: str | float | Decimal) -> str:
    return str(Decimal(str(amount)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _account_filter(account_ids: list[str]) -> ExpressionTypeDef:
    return {"Dimensions": {"Key": "LINKED_ACCOUNT", "Values": account_ids}}


def _with_accounts(
    account_ids: list[str], extra: ExpressionTypeDef | None = None
) -> ExpressionTypeDef:
    base = _account_filter(account_ids)
    return {"And": [base, extra]} if extra is not None else base


def require_central(scope: AccessScope) -> None:
    if not scope.org_wide:
        raise ToolError("this tool is only available to the central FinOps team")


def _accounts(scope: AccessScope, requested: list[str] | None) -> list[str]:
    try:
        return effective_account_ids(scope, requested)
    except ScopeError as exc:
        raise ToolError(str(exc)) from exc


def list_accounts_in_scope(scope: AccessScope, _args: NoArgs) -> dict[str, Any]:
    return {
        "org_wide": scope.org_wide,
        "accounts": [
            {
                "account_id": a.account_id,
                "name": a.name[:64],
                "business_units": list(a.business_units),
                "ou_path": [name[:64] for name in a.ou_names],
            }
            for a in scope.accounts
        ],
    }


def get_cost_and_usage(
    ce: CostExplorerClient, scope: AccessScope, args: CostAndUsageArgs
) -> dict[str, Any]:
    accounts = _accounts(scope, args.account_ids)
    service_filter: ExpressionTypeDef | None = (
        {"Dimensions": {"Key": "SERVICE", "Values": list(args.services)}} if args.services else None
    )
    group_by: list[GroupDefinitionTypeDef] = [{"Type": g.type, "Key": g.key} for g in args.group_by]
    # (period start, group keys, unrounded amount, unit)
    raw: list[tuple[str, list[str], Decimal, str]] = []
    token: str | None = None
    while True:
        kwargs: dict[str, Any] = {
            "TimePeriod": {"Start": args.start_date.isoformat(), "End": args.end_date.isoformat()},
            "Granularity": args.granularity,
            "Metrics": [args.metric],
            "Filter": _with_accounts(accounts, service_filter),
        }
        if group_by:
            kwargs["GroupBy"] = group_by
        if token:
            kwargs["NextPageToken"] = token
        resp = ce.get_cost_and_usage(**kwargs)
        for period in resp["ResultsByTime"]:
            start = period["TimePeriod"]["Start"]
            if period.get("Groups"):
                for group in period["Groups"]:
                    metric = group["Metrics"][args.metric]
                    keys = [k[:128] for k in group["Keys"]]
                    raw.append((start, keys, Decimal(metric["Amount"]), metric["Unit"]))
            else:
                metric = period["Total"][args.metric]
                raw.append((start, [], Decimal(metric["Amount"]), metric["Unit"]))
        token = resp.get("NextPageToken")
        if not token:
            break
    # Highest amount first within each period, so a "top N" is the first N rows: the model
    # must not have to sort a long list itself.
    raw.sort(key=lambda row: (row[0], -row[2]))
    result: dict[str, Any] = {
        "metric": args.metric,
        "granularity": args.granularity,
        "period": {
            "start": args.start_date.isoformat(),
            "end_exclusive": args.end_date.isoformat(),
        },
        "accounts_considered": accounts,
        "group_by": [g.model_dump() for g in args.group_by],
        "rows": [
            {"period_start": start, "keys": keys, "amount": _money(amount), "unit": unit}
            for start, keys, amount, unit in raw
        ],
    }
    if group_by:
        # Totals come from the unrounded amounts: adding up rounded rows drifts by cents.
        totals: dict[str, Decimal] = {}
        units: dict[str, str] = {}
        for start, _, amount, unit in raw:
            totals[start] = totals.get(start, Decimal(0)) + amount
            units.setdefault(start, unit)
        result["totals"] = [
            {"period_start": start, "amount": _money(total), "unit": units[start]}
            for start, total in sorted(totals.items())
        ]
    return result


def get_cost_forecast(
    ce: CostExplorerClient, scope: AccessScope, args: ForecastArgs
) -> dict[str, Any]:
    accounts = _accounts(scope, args.account_ids)
    if args.start_date < date.today():
        raise ToolError("forecast start_date must be today or later")
    resp = ce.get_cost_forecast(
        TimePeriod={"Start": args.start_date.isoformat(), "End": args.end_date.isoformat()},
        Metric=args.metric,
        Granularity=args.granularity,
        Filter=_account_filter(accounts),
    )
    periods = [
        {
            "period_start": p["TimePeriod"]["Start"],
            "period_end_exclusive": p["TimePeriod"]["End"],
            "forecast": _money(p["MeanValue"]),
        }
        for p in resp.get("ForecastResultsByTime", [])
    ]
    result: dict[str, Any] = {
        "metric": args.metric,
        "granularity": args.granularity,
        "accounts_considered": accounts,
        "total": _money(resp["Total"]["Amount"]),
        "unit": resp["Total"]["Unit"],
        "by_period": periods,
    }
    if args.granularity == "MONTHLY" and any(
        p["period_start"] < args.start_date.isoformat() for p in periods
    ):
        result["note"] = (
            "MONTHLY forecasts cover whole calendar months: each amount is the projected total "
            "for that month (actual spend to date plus the forecast for the remaining days)."
        )
    return result


def get_anomalies(
    ce: CostExplorerClient, scope: AccessScope, args: AnomaliesArgs
) -> dict[str, Any]:
    accounts = set(_accounts(scope, args.account_ids))
    anomalies: list[dict[str, Any]] = []
    token: str | None = None
    while True:
        kwargs: dict[str, Any] = {
            "DateInterval": {
                "StartDate": args.start_date.isoformat(),
                "EndDate": (args.end_date - timedelta(days=1)).isoformat(),
            },
            "MaxResults": MAX_ITEMS,
        }
        if token:
            kwargs["NextPageToken"] = token
        resp = ce.get_anomalies(**kwargs)
        for anomaly in resp["Anomalies"]:
            causes = anomaly.get("RootCauses", [])
            linked = {c["LinkedAccount"] for c in causes if c.get("LinkedAccount")}
            # Without an account attribution only org-wide users may see the anomaly.
            visible = linked & accounts if linked else (accounts if scope.org_wide else set())
            if not visible:
                continue
            anomalies.append(
                {
                    "start": anomaly.get("AnomalyStartDate"),
                    "end": anomaly.get("AnomalyEndDate"),
                    "total_impact": _money(anomaly["Impact"].get("TotalImpact", 0)),
                    "root_causes": [
                        {
                            "service": c.get("Service"),
                            "region": c.get("Region"),
                            "account_id": c.get("LinkedAccount"),
                            "usage_type": c.get("UsageType"),
                        }
                        for c in causes
                        if not c.get("LinkedAccount") or c["LinkedAccount"] in accounts
                    ],
                }
            )
        token = resp.get("NextPageToken")
        if not token or len(anomalies) >= MAX_ITEMS:
            break
    return {"accounts_considered": sorted(accounts), "anomalies": anomalies[:MAX_ITEMS]}


def get_savings_plans_coverage(
    ce: CostExplorerClient, scope: AccessScope, args: CoverageArgs
) -> dict[str, Any]:
    accounts = _accounts(scope, args.account_ids)
    resp = ce.get_savings_plans_coverage(
        TimePeriod={"Start": args.start_date.isoformat(), "End": args.end_date.isoformat()},
        Granularity="MONTHLY",
        Filter=_account_filter(accounts),
    )
    return {
        "accounts_considered": accounts,
        "coverages": [
            {
                "period_start": c["TimePeriod"]["Start"],
                "coverage_percentage": c["Coverage"].get("CoveragePercentage"),
                "spend_covered": c["Coverage"].get("SpendCoveredBySavingsPlans"),
                "on_demand_cost": c["Coverage"].get("OnDemandCost"),
            }
            for c in resp.get("SavingsPlansCoverages", [])
        ],
    }


def get_savings_plans_utilization(
    ce: CostExplorerClient, scope: AccessScope, args: DateRange
) -> dict[str, Any]:
    require_central(scope)
    resp = ce.get_savings_plans_utilization(
        TimePeriod={"Start": args.start_date.isoformat(), "End": args.end_date.isoformat()},
        Granularity="MONTHLY",
    )
    total = resp.get("Total", {})
    return {
        "utilization_percentage": total.get("Utilization", {}).get("UtilizationPercentage"),
        "net_savings": total.get("Savings", {}).get("NetSavings"),
    }


def get_savings_plans_recommendation(
    ce: CostExplorerClient, scope: AccessScope, args: SavingsPlansRecommendationArgs
) -> dict[str, Any]:
    require_central(scope)
    resp = ce.get_savings_plans_purchase_recommendation(
        SavingsPlansType=args.savings_plans_type,
        TermInYears=args.term,
        PaymentOption=args.payment_option,
        LookbackPeriodInDays=args.lookback_days,
        AccountScope="PAYER",
    )
    rec = resp.get("SavingsPlansPurchaseRecommendation", {})
    summary = rec.get("SavingsPlansPurchaseRecommendationSummary", {})
    return {
        "type": args.savings_plans_type,
        "term": args.term,
        "payment_option": args.payment_option,
        "hourly_commitment": summary.get("HourlyCommitmentToPurchase"),
        "estimated_monthly_savings": summary.get("EstimatedMonthlySavingsAmount"),
        "estimated_savings_percentage": summary.get("EstimatedSavingsPercentage"),
        "recommendations_count": summary.get("TotalRecommendationCount"),
    }
