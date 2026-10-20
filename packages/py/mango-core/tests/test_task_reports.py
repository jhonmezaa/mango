"""The data of a downloadable report (D86, D87): validation, computation and names."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from mango_core import task_reports as tr

SUMMARY = {
    "period_start": "2026-09-01",
    "period_end": "2026-09-03",
    "total": 300.004,
    "previous_total": "250",
    "daily": [
        {"date": "2026-09-01", "cost": 100},
        {"date": "2026-09-02", "cost": 100},
        {"date": "2026-09-03", "cost": "100.004"},
    ],
    "services": [{"service": "Amazon EC2", "cost": 200, "previous": 150}],
    "accounts": [{"account_id": "111122223333", "name": "produccion", "cost": 300}],
    "notes": "**EC2** subió.\n\n- una línea",
}
ANOMALY = {
    "expected": 640,
    "actual": 1052.3,
    "service": "Amazon EC2",
    "daily": [
        {"date": "2026-10-14", "cost": 320, "expected": 320},
        {"date": "2026-10-15", "cost": 526.2, "expected": 320},
    ],
    "causes": [
        {"usage_type": "BoxUsage:m6i.2xlarge", "service": "Amazon EC2", "impact": 351.8},
        {"usage_type": "EBS:VolumeUsage.gp3", "service": "Amazon EC2", "impact": 60.5},
    ],
    "conclusion": "Capacidad nueva.",
    "next_step": "Confirmar con el equipo.",
}


def test_valid_summary_rounds_amounts_to_cents() -> None:
    data = tr.parse("cost_summary", json.dumps(SUMMARY))
    assert isinstance(data, tr.CostSummaryData)
    assert data.total == Decimal("300.00")
    assert data.daily[2].cost == Decimal("100.00")


@pytest.mark.parametrize(
    "change",
    [
        {"extra": 1},
        {"total": "NaN"},
        {"total": 1e13},
        {"period_end": "2026-08-01"},
        {"period_start": "2025-01-01", "period_end": "2026-09-03", "daily": []},
        {"notes": "x" * 4001},
        {"notes": "texto \u202e oculto"},
        {"services": [{"service": "a\nb", "cost": 1}]},
        {"services": [{"service": "<img src=x>", "cost": 1, "x": 1}]},
        {"accounts": [{"account_id": "12", "cost": 1}]},
        {"daily": [{"date": "2026-09-02", "cost": 1}, {"date": "2026-09-01", "cost": 1}]},
        {"daily": [{"date": "2026-10-01", "cost": 1}]},
        {"services": [{"service": "S", "cost": 1}] * 2},
        {"services": [{"service": f"S{i}", "cost": 1} for i in range(201)]},
        {"services": [{"service": "S", "cost": 400}]},
        {"accounts": [{"account_id": "111122223333", "cost": 1, "previous": 300}]},
    ],
)
def test_invalid_summary_is_refused(change: dict[str, object]) -> None:
    with pytest.raises(tr.InvalidReportError):
        tr.parse("cost_summary", {**SUMMARY, **change})


def test_refused_input_never_carries_the_models_text() -> None:
    with pytest.raises(tr.InvalidReportError) as error:
        tr.parse("cost_summary", {**SUMMARY, "notes": "secreto\x00"})
    assert "secreto" not in str(error.value)


@pytest.mark.parametrize(
    ("change", "said"),
    [
        ({"services": [{"service": "S", "cost": 400}]}, ": the rows add up to more than the total"),
        ({"services": [{"service": "a\nb", "cost": 1}]}, "services.0.service: one line only"),
        ({"accounts": [{"account_id": "12", "cost": 1}]}, "accounts.0.account_id: string_pattern"),
        ({"total": "NaN"}, "total: finite_number"),
    ],
)
def test_refused_input_says_which_rule_failed(change: dict[str, object], said: str) -> None:
    with pytest.raises(tr.InvalidReportError) as error:
        tr.parse("cost_summary", {**SUMMARY, **change})
    assert said in str(error.value)


def test_refused_input_never_names_the_models_own_keys_or_values() -> None:
    with pytest.raises(tr.InvalidReportError) as error:
        tr.parse("cost_summary", {**SUMMARY, "clave secreta": "valor secreto"})
    assert "secret" not in str(error.value)
    assert "?: extra_forbidden" in str(error.value)


def test_input_too_large_or_not_json_is_refused() -> None:
    with pytest.raises(tr.InvalidReportError):
        tr.parse("anomaly", "x" * (tr.MAX_INPUT_CHARS + 1))
    with pytest.raises(tr.InvalidReportError):
        tr.parse("anomaly", "{not json")
    with pytest.raises(tr.InvalidReportError):
        tr.parse("anomaly", "[]")


def test_markup_is_kept_as_text_for_the_renderer_to_escape() -> None:
    data = tr.parse("anomaly", {**ANOMALY, "conclusion": '<img src="/etc/passwd"/>'})
    assert isinstance(data, tr.AnomalyData)
    assert data.conclusion == '<img src="/etc/passwd"/>'


def test_anomaly_needs_no_ids_from_the_agent() -> None:
    with pytest.raises(tr.InvalidReportError):
        tr.parse("anomaly", {**ANOMALY, "anomaly_id": "x"})


def test_tool_spec_has_no_refs_and_one_name() -> None:
    for kind in ("cost_summary", "anomaly"):
        spec = tr.tool_spec(kind)  # type: ignore[arg-type]
        assert spec["type"] == "inline_function"
        assert spec["name"] == tr.REPORT_TOOL
        assert "$ref" not in json.dumps(spec)
        assert len(spec["config"]["inlineFunction"]["description"]) <= 4096


def test_type_is_fixed_by_the_trigger() -> None:
    assert tr.report_type("schedule", None) == "cost_summary"
    assert tr.report_type("manual", None) == "cost_summary"
    assert tr.report_type("event", "cost_anomaly") == "anomaly"


def test_reads_costs() -> None:
    assert tr.reads_costs(["cost-explorer.get_cost_and_usage"])
    assert tr.reads_costs(["aws-billing.cost-explorer"])
    assert not tr.reads_costs(["aws-cloudwatch.get_metric_data", "costs.fake"])


def _query(
    rows: list[dict[str, object]], answer_extra: dict[str, object] | None = None, **args: object
) -> tr.ToolCall:
    call_args = {"start_date": "2026-09-01", "end_date": "2026-09-04", "granularity": "DAILY"}
    answer = {"metric": "UnblendedCost", "granularity": "DAILY", "group_by": [], "rows": rows}
    answer.update(answer_extra or {})
    return tr.ToolCall(
        call_id="t1",
        name=tr.COST_QUERY_TOOL,
        input=json.dumps({**call_args, **args}),
        output=json.dumps({"content": [{"type": "text", "text": json.dumps(answer)}]}),
    )


ROWS = [
    {"period_start": f"2026-09-0{d}", "keys": [], "amount": f"{d}0.50", "unit": "USD"}
    for d in (1, 2, 3)
]


def test_series_is_taken_from_a_matching_query() -> None:
    data = tr.parse("cost_summary", SUMMARY)
    doc = tr.build("cost_summary", data, [_query(ROWS, account_ids=["111122223333"])])
    assert doc["source"] == {"daily": "query", "accounts": ["111122223333"], "services": []}
    assert [d["cost"] for d in doc["data"]["daily"]] == ["10.50", "20.50", "30.50"]
    assert doc["tools"] == [tr.COST_QUERY_TOOL]


BY_SERVICE = [{"type": "DIMENSION", "key": "SERVICE"}]
GROUPED_ROWS = [
    {"period_start": f"2026-09-0{d}", "keys": [service], "amount": "1.00", "unit": "USD"}
    for d in (1, 2, 3)
    for service in ("EC2", "S3")
]
TOTALS = [{"period_start": f"2026-09-0{d}", "amount": f"{d}1.25", "unit": "USD"} for d in (1, 2, 3)]


def test_series_is_taken_from_the_daily_totals_of_a_grouped_query() -> None:
    call = _query(GROUPED_ROWS, {"group_by": BY_SERVICE, "totals": TOTALS}, group_by=BY_SERVICE)
    doc = tr.build("cost_summary", tr.parse("cost_summary", SUMMARY), [call])
    assert doc["source"] == {"daily": "query", "accounts": [], "services": []}
    assert [d["cost"] for d in doc["data"]["daily"]] == ["11.25", "21.25", "31.25"]


def test_a_summary_without_its_own_series_takes_the_grouped_totals() -> None:
    call = _query(GROUPED_ROWS, {"group_by": BY_SERVICE, "totals": TOTALS}, group_by=BY_SERVICE)
    data = tr.parse("cost_summary", {**SUMMARY, "daily": []})
    doc = tr.build("cost_summary", data, [call])
    assert doc["source"]["daily"] == "query"
    assert len(doc["data"]["daily"]) == 3


@pytest.mark.parametrize(
    "call",
    [
        _query(GROUPED_ROWS, {"group_by": BY_SERVICE}, group_by=BY_SERVICE),
        _query(GROUPED_ROWS, {"group_by": BY_SERVICE, "totals": TOTALS[:2]}, group_by=BY_SERVICE),
        _query(GROUPED_ROWS, {"group_by": BY_SERVICE, "totals": TOTALS}),
        _query(ROWS[:2]),
        _query(ROWS, group_by=[{"type": "DIMENSION", "key": "SERVICE"}]),
        _query(ROWS, granularity="MONTHLY"),
        _query([{**ROWS[0], "keys": ["EC2"]}, *ROWS[1:]]),
        _query([{**ROWS[0], "amount": "NaN"}, *ROWS[1:]]),
        tr.ToolCall("t1", "get_cost_forecast", "{}", "{}"),
        tr.ToolCall("t1", tr.COST_QUERY_TOOL, "not json", "not json"),
    ],
)
def test_otherwise_the_agents_series_is_kept(call: tr.ToolCall) -> None:
    doc = tr.build("cost_summary", tr.parse("cost_summary", SUMMARY), [call])
    assert doc["source"] == {"daily": "agent"}
    assert [d["cost"] for d in doc["data"]["daily"]] == ["100.00", "100.00", "100.00"]


def test_summary_without_any_series_is_not_a_report() -> None:
    data = tr.parse("cost_summary", {**SUMMARY, "daily": []})
    with pytest.raises(tr.InvalidReportError):
        tr.build("cost_summary", data, [])


def test_anomaly_series_takes_cost_from_the_query_and_keeps_expected() -> None:
    rows = [
        {"period_start": "2026-10-14", "keys": [], "amount": "300", "unit": "USD"},
        {"period_start": "2026-10-15", "keys": [], "amount": "500", "unit": "USD"},
    ]
    call = _query(rows, start_date="2026-10-14", end_date="2026-10-16")
    doc = tr.build("anomaly", tr.parse("anomaly", ANOMALY), [call])
    assert doc["data"]["daily"][1] == {"date": "2026-10-15", "cost": "500.00", "expected": "320.00"}
    kind, data, source = tr.load(json.dumps(doc))
    assert kind == "anomaly"
    assert isinstance(data, tr.AnomalyData)
    assert source["daily"] == "query"


def test_load_validates_again() -> None:
    with pytest.raises(tr.InvalidReportError):
        tr.load(json.dumps({"type": "cost_summary", "data": {**SUMMARY, "total": "x"}}))
    with pytest.raises(tr.InvalidReportError):
        tr.load(json.dumps({"type": "other", "data": {}}))


def test_table_keeps_25_rows_and_the_rest_in_others() -> None:
    rows = [(f"S{i}", None, Decimal(100 - i), Decimal(50)) for i in range(30)]
    total = sum((r[2] for r in rows), Decimal(0)) + Decimal(10)
    out = tr.table(rows, total=total, total_previous=None)
    assert len(out.rows) == tr.MAX_ROWS_SHOWN
    assert out.rows[0].share == Decimal("1.000")
    assert out.others == 5
    assert out.others_cost == Decimal(10) + sum(Decimal(100 - i) for i in range(25, 30))
    assert out.others_previous is None


def test_change_needs_a_base_of_one_dollar() -> None:
    assert tr.change(Decimal(110), Decimal(100)) == Decimal("10.0")
    assert tr.change(Decimal(5), Decimal("0.5")) is None
    assert tr.change(Decimal(5), None) is None


def test_shares() -> None:
    assert tr.shares([Decimal(85), Decimal(15)]) == [Decimal(85), Decimal(15)]
    assert tr.shares([Decimal(0)]) == [Decimal(0)]


def test_file_name_of_the_design() -> None:
    at = datetime(2026, 10, 1, 14, 0, tzinfo=UTC)
    name = tr.file_name(
        "Cierre mensual de costos", at=at, timezone="America/Mexico_City", anomaly_id=None
    )
    assert name == "cierre-mensual-de-costos-2026-10-01-0800.pdf"
    anomaly = tr.file_name(
        "Investigar anomalías de costo",
        at=datetime(2026, 10, 16, 9, 41, tzinfo=UTC),
        timezone=None,
        anomaly_id="8d09e1c2-4b5d-4e8f-9a01-8d092b3c4d5e",
    )
    assert anomaly == "investigar-anomalias-de-costo-2026-10-16-8d09e1c2.pdf"
    assert tr.slug("¡¡!!") == "tarea"
    assert len(tr.slug("a" * 100)) == 60


def test_object_key_is_under_its_owner() -> None:
    key = tr.object_key("sub-1", "a" * 32, "b" * 32, "t-2026-10-01-0800.pdf")
    assert key == f"owner/sub-1/{'a' * 32}/{'b' * 32}/t-2026-10-01-0800.pdf"
    with pytest.raises(ValueError, match="invalid"):
        tr.object_key("../x", "a" * 32, "b" * 32, "t-2026-10-01-0800.pdf")
    with pytest.raises(ValueError, match="invalid"):
        tr.object_key("sub", "a" * 32, "b" * 32, "../../x.pdf")


def test_event_of_the_function() -> None:
    run_sk = f"RUN#{'1' * 13}#{'b' * 32}"
    assert tr.valid_event({"task_id": "a" * 32, "run_id": "b" * 32, "run_sk": run_sk}) == (
        "a" * 32,
        "b" * 32,
        run_sk,
    )
    for event in (
        {"task_id": "a" * 32, "run_id": "b" * 32},
        {"task_id": "a" * 32, "run_id": "b" * 32, "run_sk": run_sk, "key": "x"},
        {"task_id": "a" * 32, "run_id": "c" * 32, "run_sk": run_sk},
        {"task_id": "A", "run_id": "b" * 32, "run_sk": run_sk},
        "x",
    ):
        with pytest.raises(ValueError, match="unexpected"):
            tr.valid_event(event)


def test_keep_until() -> None:
    queued = int(datetime(2026, 10, 1, tzinfo=UTC).timestamp())
    assert tr.keep_until(queued) == date(2026, 12, 30)
