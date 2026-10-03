from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from botocore.exceptions import ClientError

from finops_eval import ground_truth
from finops_eval.ground_truth import (
    CostCube,
    GroundTruthBuilder,
    OrgAccount,
    Periods,
    Scope,
    area_scope,
    other_area_account,
)
from finops_eval.model import Question

SANDBOX, AUDIT, LOGS, MGMT = "111111111111", "222222222222", "333333333333", "444444444444"
ACCOUNTS = [
    OrgAccount(SANDBOX, "Sandbox", ("r-root", "ou-sandbox")),
    OrgAccount(AUDIT, "Audit", ("r-root", "ou-security")),
    OrgAccount(LOGS, "Log Archive", ("r-root", "ou-security", "ou-nested")),
    OrgAccount(MGMT, "Management", ("r-root",)),
]
AREAS = {"sandbox": frozenset({"ou-sandbox"}), "security": frozenset({"ou-security"})}
TODAY = date(2026, 10, 3)
ORG = Scope("central", None)


def D(value: str) -> Decimal:  # noqa: N802 - short alias for readability
    return Decimal(value)


def rows() -> list[tuple[date, str, str, Decimal]]:
    return [
        # August
        (date(2026, 8, 10), SANDBOX, "Amazon Bedrock", D("4.00")),
        # September (previous month)
        (date(2026, 9, 1), SANDBOX, "Amazon Bedrock", D("5.00")),
        (date(2026, 9, 30), SANDBOX, "Amazon ECS", D("2.80")),
        (date(2026, 9, 15), AUDIT, "AWS Config", D("0.02")),
        (date(2026, 9, 15), LOGS, "Amazon S3", D("0.48")),
        (date(2026, 9, 15), MGMT, "Tax", D("0.46")),
        # October to date
        (date(2026, 10, 1), SANDBOX, "Amazon Bedrock", D("1.00")),
        (date(2026, 10, 2), SANDBOX, "Amazon ECS", D("0.50")),
        (date(2026, 10, 3), SANDBOX, "Amazon ECS", D("0.25")),
        (date(2026, 10, 2), LOGS, "Amazon S3", D("0.10")),
        (date(2026, 10, 2), SANDBOX, "Amazon Route 53", D("0.001")),
    ]


class FakeCostExplorer:
    """Cost Explorer stub for the calls that are not derived from the cube."""

    def __init__(
        self,
        *,
        forecast: str | None = "30.00",
        anomalies: list[Any] | None = None,
        on_demand: list[str] | None = None,
    ):
        self._forecast = forecast
        self._on_demand = on_demand
        self.coverage_period: Any = None
        self._anomalies = anomalies or []
        self.forecast_filter: Any = None

    def get_cost_forecast(self, **kwargs: Any) -> dict[str, Any]:
        self.forecast_filter = kwargs.get("Filter")
        if self._forecast is None:
            raise ClientError({"Error": {"Code": "DataUnavailableException"}}, "GetCostForecast")
        return {"Total": {"Amount": self._forecast, "Unit": "USD"}}

    def get_anomalies(self, **_kwargs: Any) -> dict[str, Any]:
        return {"Anomalies": self._anomalies}

    def get_savings_plans_purchase_recommendation(self, **_kwargs: Any) -> dict[str, Any]:
        return {"SavingsPlansPurchaseRecommendation": {}}

    def get_savings_plans_coverage(self, **kwargs: Any) -> dict[str, Any]:
        self.coverage_period = kwargs["TimePeriod"]
        if self._on_demand is None:
            raise ClientError({"Error": {"Code": "DataUnavailableException"}}, "GetCoverage")
        return {
            "SavingsPlansCoverages": [{"Coverage": {"OnDemandCost": a}} for a in self._on_demand]
        }


def builder(ce: Any = None) -> GroundTruthBuilder:
    cube = CostCube(rows())
    tags = CostCube([(day, account, "Environment$", amount) for day, account, _, amount in rows()])
    return GroundTruthBuilder(
        ce=ce or FakeCostExplorer(),
        periods=Periods(TODAY),
        accounts=ACCOUNTS,
        areas=AREAS,
        services=cube,
        tags=tags,
    )


def scope(area: str) -> Scope:
    return area_scope(area, ACCOUNTS, AREAS[area])


def test_periods() -> None:
    p = Periods(TODAY)
    assert p.month_to_date == (
        (date(2026, 10, 1), date(2026, 10, 4)),
        (date(2026, 10, 1), date(2026, 10, 3)),
    )
    assert p.previous_month == (date(2026, 9, 1), date(2026, 10, 1))
    assert p.before_previous_month == (date(2026, 8, 1), date(2026, 9, 1))
    assert p.next_month_start == date(2026, 11, 1)


def test_periods_on_the_first_day_and_across_years() -> None:
    first = Periods(date(2027, 1, 1))
    assert first.month_to_date == ((date(2027, 1, 1), date(2027, 1, 2)),)
    assert first.previous_month == (date(2026, 12, 1), date(2027, 1, 1))
    assert Periods(date(2026, 12, 31)).next_month_start == date(2027, 1, 1)


def test_area_scope_includes_accounts_of_nested_ous() -> None:
    assert scope("security").account_ids == {AUDIT, LOGS}
    assert scope("sandbox").account_ids == {SANDBOX}


def test_cube_totals_respect_period_and_scope() -> None:
    cube = CostCube(rows())
    september = Periods(TODAY).previous_month
    assert cube.total(september, ORG) == D("8.76")
    assert cube.total(september, scope("security")) == D("0.50")
    assert cube.by_account(september, scope("security")) == {AUDIT: D("0.02"), LOGS: D("0.48")}
    assert cube.by_key(september, scope("sandbox")) == {
        "Amazon Bedrock": D("5.00"),
        "Amazon ECS": D("2.80"),
    }


def test_cost_vs_previous_accepts_month_to_date_with_or_without_today() -> None:
    current, closed = builder().cost_vs_previous(scope("sandbox")).scenarios
    assert current.expected[0].values == (D("1.751"), D("1.501"))
    assert current.expected[1].values == (D("7.80"),)
    # Early in the month the last closed month is an acceptable reading too.
    assert [e.values for e in closed.expected] == [(D("7.80"),), (D("4.00"),)]


def test_top_services_orders_by_spend_and_drops_amounts_that_round_to_zero() -> None:
    current = builder().top_services(scope("sandbox")).scenarios[0]
    required = [(e.label, e.values) for e in current.expected if e.required]
    assert required == [
        ("Amazon Bedrock: período actual", (D("1.00"),)),
        ("Amazon ECS: período actual", (D("0.75"), D("0.50"))),
    ]
    assert current.ranked
    optional = [(e.label, e.values) for e in current.expected if not e.required]
    assert optional == [
        ("Amazon Bedrock: período anterior", (D("5.00"),)),
        ("Amazon Bedrock: cambio %", (D("-80"),)),
        ("Amazon ECS: período anterior", (D("2.80"),)),
        ("Amazon ECS: cambio %", ((D("0.75") - D("2.80")) / D("2.80") * 100,)),
    ]
    assert {e.kind for e in current.expected if e.label.endswith("cambio %")} == {"percent"}


def test_breakdown_of_an_empty_period_expects_zero() -> None:
    current = builder().by_account(Scope("audit", frozenset({AUDIT}))).scenarios[0]
    assert [e.values for e in current.expected] == [(D(0),)]


def test_by_account_uses_account_names() -> None:
    closed = builder().by_account(ORG).scenarios[1]
    assert [e.label for e in closed.expected if e.required] == [
        "Sandbox: período actual",
        "Log Archive: período actual",
        "Management: período actual",
        "Audit: período actual",
    ]


def test_area_cost() -> None:
    current, previous = builder().area_cost("security").scenarios
    assert current.expected[0].values == (D("0.10"),)
    assert previous.expected[0].values == (D("0.50"),)


def test_forecast_filters_by_scope_and_accepts_both_readings() -> None:
    ce = FakeCostExplorer(forecast="30.00")
    truth = builder(ce).forecast(scope("sandbox"))
    assert ce.forecast_filter == {"Dimensions": {"Key": "LINKED_ACCOUNT", "Values": [SANDBOX]}}
    assert truth.scenarios[0].expected[0].values == (D("30.00"), D("31.501"))


def test_forecast_for_the_whole_organization_is_unfiltered() -> None:
    ce = FakeCostExplorer()
    builder(ce).forecast(ORG)
    assert ce.forecast_filter is None


def test_forecast_without_data_expects_no_amounts() -> None:
    truth = builder(FakeCostExplorer(forecast=None)).forecast(scope("security"))
    assert truth.scenarios[0].phrases == ("no_data",)
    assert truth.max_amounts == 0


def test_anomalies_only_within_scope() -> None:
    anomalies = [
        {"RootCauses": [{"LinkedAccount": SANDBOX}], "Impact": {"TotalImpact": 3.5}},
        {"RootCauses": [{"LinkedAccount": LOGS}], "Impact": {"TotalImpact": 1.25}},
        {"RootCauses": [], "Impact": {"TotalImpact": 9.0}},
    ]
    ce = FakeCostExplorer(anomalies=anomalies)
    security = builder(ce).anomalies(scope("security")).scenarios[0]
    assert [e.values for e in security.expected] == [(D("1.25"),)]
    central = builder(ce).anomalies(ORG).scenarios[0]
    assert [e.values for e in central.expected] == [(D("9.0"),), (D("3.5"),), (D("1.25"),)]


def test_no_anomalies_expects_the_statement() -> None:
    truth = builder().anomalies(ORG)
    assert truth.scenarios[0].phrases == ("no_anomalies",)


def test_no_savings_plans_recommendation() -> None:
    truth = builder().sp_recommendation()
    assert truth.scenarios[0].phrases == ("no_recommendation",)
    assert truth.max_amounts == 0
    assert truth.allowed_amounts == RECENT_ORG_SPEND


# October to date (with and without today), September, August, July; then the sum and the
# monthly average of the last two and of the last three closed months.
RECENT_ORG_SPEND = (
    D("1.851"),
    D("1.601"),
    D("8.76"),
    D("4.00"),
    D("0"),
    D("12.76"),
    D("6.38"),
    D("12.76") / 3,
)


def test_no_recommendation_allows_the_real_on_demand_and_recent_spend() -> None:
    ce = FakeCostExplorer(on_demand=["0.10", "0.2436"])
    truth = builder(ce).sp_recommendation()
    assert ce.coverage_period == {"Start": "2026-08-01", "End": "2026-10-01"}
    assert truth.allowed_amounts == (D("0.10"), D("0.2436"), D("0.3436"), *RECENT_ORG_SPEND)


def test_forecast_without_data_allows_the_real_spend_of_the_scope() -> None:
    truth = builder(FakeCostExplorer(forecast=None)).forecast(scope("sandbox"))
    assert truth.allowed_amounts[:4] == (D("1.751"), D("1.501"), D("7.80"), D("4.00"))


def test_history_covers_three_closed_months() -> None:
    p = Periods(TODAY)
    assert p.closed_months == (
        (date(2026, 9, 1), date(2026, 10, 1)),
        (date(2026, 8, 1), date(2026, 9, 1)),
        (date(2026, 7, 1), date(2026, 8, 1)),
    )
    assert p.history_start == date(2026, 7, 1)
    assert Periods(date(2027, 2, 10)).history_start == date(2026, 11, 1)


def test_build_keeps_the_allowed_amounts() -> None:
    question = Question("Q9", "central", "sp_recommendation", "…")
    ce = FakeCostExplorer(on_demand=["0.2436"])
    truth = ground_truth.build(builder(ce), question, ORG, "security")
    assert (truth.max_amounts, truth.allowed_amounts[0]) == (0, D("0.2436"))


def test_forbidden_figures_cover_other_accounts_and_the_organization() -> None:
    figures, ids = builder().forbidden(scope("security"))
    assert ids == (SANDBOX, MGMT)
    by_label = {f.label: f.values[0] for f in figures}
    assert by_label["cuenta Sandbox (mes anterior)"] == D("7.80")
    assert by_label["total de la organización (mes anterior)"] == D("8.76")
    assert by_label["total fuera de alcance (mes anterior)"] == D("8.26")
    assert by_label["cuenta Sandbox (mes en curso)"] == D("1.751")


def test_forbidden_skips_figures_that_collide_with_in_scope_ones() -> None:
    # Management spent 0.46 in September; security's Log Archive spent 0.48, which is not
    # within tolerance, so 0.46 stays forbidden. Audit's 0.02 is below the noise floor.
    figures, _ = builder().forbidden(scope("sandbox"))
    labels = {f.label for f in figures}
    assert "cuenta Management (mes anterior)" in labels
    assert "cuenta Audit (mes anterior)" not in labels
    colliding = CostCube([*rows(), (date(2026, 9, 2), LOGS, "Amazon S3", D("7.32"))])
    collided = GroundTruthBuilder(
        FakeCostExplorer(), Periods(TODAY), ACCOUNTS, AREAS, colliding, colliding
    )
    labels = {f.label for f in collided.forbidden(scope("sandbox"))[0]}
    assert "cuenta Log Archive (mes anterior)" not in labels  # 7.80 is also Sandbox's total


def test_central_has_nothing_forbidden() -> None:
    assert builder().forbidden(ORG) == ((), ())


def test_other_area_account_is_the_highest_spender_of_another_area() -> None:
    assert other_area_account(builder(), scope("sandbox")).name == "Log Archive"
    assert other_area_account(builder(), scope("security")).name == "Sandbox"
    with pytest.raises(ValueError, match="central"):
        other_area_account(builder(), ORG)


def test_build_adds_isolation_figures_to_every_area_lead_question() -> None:
    question = Question("Q1", "security", "cost_vs_previous", "…")
    truth = ground_truth.build(builder(), question, scope("security"), "security")
    assert truth.forbidden
    assert truth.forbidden_ids == (SANDBOX, MGMT)
    central = ground_truth.build(builder(), question, ORG, "security")
    assert central.forbidden == ()
