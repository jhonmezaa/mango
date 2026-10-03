from datetime import date, timedelta
from typing import Any

import boto3
import pytest
from botocore.stub import Stubber
from pydantic import ValidationError

from mango_cost_explorer import tools
from mango_cost_explorer.scope import AccessScope, Account

SECURITY = AccessScope(
    org_wide=False,
    accounts=(
        Account("222222222222", "Audit", ("r", "ou-sec")),
        Account("333333333333", "Log Archive", ("r", "ou-sec")),
    ),
)
CENTRAL = AccessScope(
    org_wide=True,
    accounts=(*SECURITY.accounts, Account("111111111111", "Sandbox", ("r", "ou-sbx"))),
)


def _ce() -> Any:
    return boto3.client("ce", region_name="us-east-1")


def _cost_response(amount: str) -> dict[str, Any]:
    return {
        "ResultsByTime": [
            {
                "TimePeriod": {"Start": "2026-09-01", "End": "2026-10-01"},
                "Total": {"UnblendedCost": {"Amount": amount, "Unit": "USD"}},
                "Groups": [],
                "Estimated": True,
            }
        ],
        "DimensionValueAttributes": [],
    }


def test_cost_and_usage_always_filters_by_scope() -> None:
    ce = _ce()
    args = tools.CostAndUsageArgs(start_date=date(2026, 9, 1), end_date=date(2026, 10, 1))
    with Stubber(ce) as stub:
        stub.add_response(
            "get_cost_and_usage",
            _cost_response("0.4595"),
            {
                "TimePeriod": {"Start": "2026-09-01", "End": "2026-10-01"},
                "Granularity": "MONTHLY",
                "Metrics": ["UnblendedCost"],
                "Filter": {
                    "Dimensions": {
                        "Key": "LINKED_ACCOUNT",
                        "Values": ["222222222222", "333333333333"],
                    }
                },
            },
        )
        result = tools.get_cost_and_usage(ce, SECURITY, args)
    assert result["rows"][0]["amount"] == "0.46"
    assert result["accounts_considered"] == ["222222222222", "333333333333"]


def test_cost_and_usage_combines_service_filter_with_accounts() -> None:
    ce = _ce()
    args = tools.CostAndUsageArgs(
        start_date=date(2026, 9, 1),
        end_date=date(2026, 10, 1),
        services=["AWS CloudTrail"],
        account_ids=["222222222222"],
    )
    with Stubber(ce) as stub:
        stub.add_response(
            "get_cost_and_usage",
            _cost_response("1"),
            {
                "TimePeriod": {"Start": "2026-09-01", "End": "2026-10-01"},
                "Granularity": "MONTHLY",
                "Metrics": ["UnblendedCost"],
                "Filter": {
                    "And": [
                        {"Dimensions": {"Key": "LINKED_ACCOUNT", "Values": ["222222222222"]}},
                        {"Dimensions": {"Key": "SERVICE", "Values": ["AWS CloudTrail"]}},
                    ]
                },
            },
        )
        tools.get_cost_and_usage(ce, SECURITY, args)


def _group(key: str, amount: str) -> dict[str, Any]:
    return {"Keys": [key], "Metrics": {"UnblendedCost": {"Amount": amount, "Unit": "USD"}}}


def _grouped_response(
    start: str, end: str, groups: list[dict[str, Any]], token: str | None = None
) -> dict[str, Any]:
    response: dict[str, Any] = {
        "ResultsByTime": [
            {
                "TimePeriod": {"Start": start, "End": end},
                "Total": {} if groups else {"UnblendedCost": {"Amount": "0", "Unit": "USD"}},
                "Groups": groups,
                "Estimated": True,
            }
        ],
        "DimensionValueAttributes": [],
    }
    if token:
        response["NextPageToken"] = token
    return response


def test_grouped_rows_are_ranked_by_amount_within_each_period() -> None:
    ce = _ce()
    args = tools.CostAndUsageArgs(
        start_date=date(2026, 8, 1),
        end_date=date(2026, 10, 1),
        group_by=[tools.GroupBy(type="DIMENSION", key="SERVICE")],
    )
    august = [_group("AWS Key Management Service", "1.0"), _group("AWS Config", "0.0151")]
    # Cost Explorer returns groups in no useful order, and across pages.
    september_1 = [
        _group("Amazon Bedrock", "1.3751"),
        _group("AWS Key Management Service", "1.1361"),
    ]
    september_2 = [_group("AWS Config", "1.911"), _group("Tax", "-0.25")]
    with Stubber(ce) as stub:
        first = _grouped_response("2026-08-01", "2026-09-01", august, token="next")
        first["ResultsByTime"].append(
            _grouped_response("2026-09-01", "2026-10-01", september_1)["ResultsByTime"][0]
        )
        stub.add_response("get_cost_and_usage", first)
        stub.add_response(
            "get_cost_and_usage", _grouped_response("2026-09-01", "2026-10-01", september_2)
        )
        result = tools.get_cost_and_usage(ce, CENTRAL, args)
    assert [(r["period_start"], r["keys"][0], r["amount"]) for r in result["rows"]] == [
        ("2026-08-01", "AWS Key Management Service", "1.00"),
        ("2026-08-01", "AWS Config", "0.02"),
        ("2026-09-01", "AWS Config", "1.91"),
        ("2026-09-01", "Amazon Bedrock", "1.38"),
        ("2026-09-01", "AWS Key Management Service", "1.14"),
        ("2026-09-01", "Tax", "-0.25"),
    ]


def test_grouped_totals_are_computed_from_unrounded_amounts() -> None:
    ce = _ce()
    args = tools.CostAndUsageArgs(
        start_date=date(2026, 9, 1),
        end_date=date(2026, 10, 1),
        group_by=[tools.GroupBy(type="DIMENSION", key="LINKED_ACCOUNT")],
    )
    groups = [
        _group("111111111111", "7.8021632216"),
        _group("333333333333", "0.4826790877"),
        _group("222222222222", "0.4849000000"),
    ]
    with Stubber(ce) as stub:
        stub.add_response(
            "get_cost_and_usage", _grouped_response("2026-09-01", "2026-10-01", groups)
        )
        result = tools.get_cost_and_usage(ce, CENTRAL, args)
    # The rounded rows add up to 8.76; the real total rounds to 8.77.
    assert [r["amount"] for r in result["rows"]] == ["7.80", "0.48", "0.48"]
    assert result["totals"] == [{"period_start": "2026-09-01", "amount": "8.77", "unit": "USD"}]


def test_grouped_period_without_data_is_reported_as_zero() -> None:
    ce = _ce()
    args = tools.CostAndUsageArgs(
        start_date=date(2026, 10, 1),
        end_date=date(2026, 10, 2),
        group_by=[tools.GroupBy(type="DIMENSION", key="SERVICE")],
    )
    with Stubber(ce) as stub:
        stub.add_response("get_cost_and_usage", _grouped_response("2026-10-01", "2026-10-02", []))
        result = tools.get_cost_and_usage(ce, CENTRAL, args)
    assert result["rows"] == [
        {"period_start": "2026-10-01", "keys": [], "amount": "0.00", "unit": "USD"}
    ]
    assert result["totals"] == [{"period_start": "2026-10-01", "amount": "0.00", "unit": "USD"}]


def test_ungrouped_result_has_no_totals() -> None:
    ce = _ce()
    args = tools.CostAndUsageArgs(start_date=date(2026, 9, 1), end_date=date(2026, 10, 1))
    with Stubber(ce) as stub:
        stub.add_response("get_cost_and_usage", _cost_response("8.7651"))
        result = tools.get_cost_and_usage(ce, CENTRAL, args)
    assert "totals" not in result
    assert [r["amount"] for r in result["rows"]] == ["8.77"]


def test_cost_and_usage_rejects_account_outside_scope_without_calling_aws() -> None:
    ce = _ce()
    args = tools.CostAndUsageArgs(
        start_date=date(2026, 9, 1), end_date=date(2026, 10, 1), account_ids=["111111111111"]
    )
    with Stubber(ce), pytest.raises(tools.ToolError, match="outside"):
        tools.get_cost_and_usage(ce, SECURITY, args)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"start_date": date(2025, 1, 1), "end_date": date(2026, 9, 1)},
        {"start_date": date(2026, 1, 1), "end_date": date(2026, 9, 1), "granularity": "DAILY"},
        {"start_date": date(2026, 9, 2), "end_date": date(2026, 9, 1)},
        {
            "start_date": date(2026, 9, 1),
            "end_date": date(2026, 10, 1),
            "group_by": [{"type": "DIMENSION", "key": "PURCHASE_TYPE"}],
        },
        {
            "start_date": date(2026, 9, 1),
            "end_date": date(2026, 10, 1),
            "group_by": [{"type": "DIMENSION", "key": "SERVICE"}] * 3,
        },
        {"start_date": date(2026, 9, 1), "end_date": date(2026, 10, 1), "user_role": "central"},
    ],
)
def test_cost_and_usage_argument_limits(kwargs: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        tools.CostAndUsageArgs(**kwargs)


def test_org_wide_tools_denied_to_bu_lead() -> None:
    ce = _ce()
    with Stubber(ce), pytest.raises(tools.ToolError, match="central"):
        tools.get_savings_plans_recommendation(ce, SECURITY, tools.SavingsPlansRecommendationArgs())


def test_anomalies_hide_other_accounts_and_unattributed_for_bu_lead() -> None:
    ce = _ce()
    today = date.today()
    args = tools.AnomaliesArgs(start_date=today - timedelta(days=7), end_date=today)
    response = {
        "Anomalies": [
            {
                "AnomalyId": "a1",
                "AnomalyStartDate": "2026-09-20",
                "AnomalyScore": {"MaxScore": 1.0, "CurrentScore": 1.0},
                "Impact": {"MaxImpact": 5.0, "TotalImpact": 5.0},
                "MonitorArn": "arn:aws:ce::444444444444:anomalymonitor/m",
                "RootCauses": [{"Service": "Amazon EC2", "LinkedAccount": "111111111111"}],
            },
            {
                "AnomalyId": "a2",
                "AnomalyStartDate": "2026-09-21",
                "AnomalyScore": {"MaxScore": 1.0, "CurrentScore": 1.0},
                "Impact": {"MaxImpact": 2.0, "TotalImpact": 2.0},
                "MonitorArn": "arn:aws:ce::444444444444:anomalymonitor/m",
                "RootCauses": [{"Service": "AWS Config", "LinkedAccount": "222222222222"}],
            },
            {
                "AnomalyId": "a3",
                "AnomalyStartDate": "2026-09-22",
                "AnomalyScore": {"MaxScore": 1.0, "CurrentScore": 1.0},
                "Impact": {"MaxImpact": 9.0, "TotalImpact": 9.0},
                "MonitorArn": "arn:aws:ce::444444444444:anomalymonitor/m",
                "RootCauses": [{"Service": "Amazon S3"}],
            },
        ]
    }
    with Stubber(ce) as stub:
        stub.add_response("get_anomalies", response)
        result = tools.get_anomalies(ce, SECURITY, args)
    assert [a["total_impact"] for a in result["anomalies"]] == ["2.00"]


def test_monthly_forecast_is_labelled_as_whole_month() -> None:
    ce = _ce()
    today = date.today()
    args = tools.ForecastArgs(start_date=today, end_date=today + timedelta(days=2))
    response = {
        "Total": {"Amount": "1.7014", "Unit": "USD"},
        "ForecastResultsByTime": [
            {
                "TimePeriod": {"Start": today.replace(day=1).isoformat(), "End": "2099-01-01"},
                "MeanValue": "1.7014",
            }
        ],
    }
    with Stubber(ce) as stub:
        stub.add_response("get_cost_forecast", response)
        result = tools.get_cost_forecast(ce, CENTRAL, args)
    assert result["by_period"][0]["period_start"] == today.replace(day=1).isoformat()
    if today.day > 1:
        assert "whole calendar months" in result["note"]
