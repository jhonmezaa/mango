"""The CUR reconciler against a fake Athena and the Budgets table of moto (D104 (7))."""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import boto3
import pytest
from moto import mock_aws

from mango_core import usage_days
from mango_cur_reconciler import query
from mango_cur_reconciler.audit import ACTOR, EVENT_RECONCILED, AuditWriter
from mango_cur_reconciler.compare import (
    UNATTRIBUTED_BEFORE_COUNTER,
    UNATTRIBUTED_NOT_TOKENS,
    UNATTRIBUTED_OTHER_CALLER,
    Bedrock,
    agent_of,
    deviates,
    role_name,
    sort,
)
from mango_cur_reconciler.config import ConfigError, Settings
from mango_cur_reconciler.handler import (
    STATUS_NO_DATA,
    STATUS_RECONCILED,
    STATUS_UNEXPECTED,
    CurReconciler,
    handle,
    window,
)

ACCOUNT = "111122223333"
OTHER_ACCOUNT = "444455556666"
TABLE, INDEX = "budgets", "audit-index"
NOW = datetime(2026, 11, 20, 9, 0, tzinfo=UTC)
ENV = {
    "MANGO_NAMESPACE": "lab",
    "MANGO_ACCOUNT_ID": ACCOUNT,
    "BUDGETS_TABLE": TABLE,
    "AUDIT_STREAM": "audit",
    "AUDIT_INDEX_TABLE": INDEX,
    "CUR_DATABASE": "mango_lab_cur",
    "CUR_TABLE": "bedrock",
    "CUR_WORKGROUP": "Mango-lab-cur",
    "BEDROCK_PRODUCT_CODES": "AmazonBedrock,AmazonBedrockService",
    "MARKETPLACE_BILLING_ENTITY": "AWS Marketplace",
    "BEDROCK_PRODUCT_FAMILY": "Amazon Bedrock",
    "THRESHOLD_PERCENT": "10",
    "THRESHOLD_USD": "1",
}
SETTINGS = Settings.from_env(ENV)
BEDROCK = Bedrock(SETTINGS.product_codes, SETTINGS.marketplace_entity, SETTINGS.product_family)
MARKETPLACE = "AWS Marketplace"
CLAUDE = "a1b2c3d4e5f6g7h8i9j0k1l2m"
"""A Marketplace product code: one per model, random-looking (synthetic)."""
FINOPS = f"arn:aws:sts::{ACCOUNT}:assumed-role/Mango-lab-agent-finops/session-1"
PLAYGROUND = f"arn:aws:iam::{ACCOUNT}:role/Mango-lab-agent-playground"
API = f"arn:aws:sts::{ACCOUNT}:assumed-role/Mango-lab-ApiTask/task-1"


def row(
    day: str,
    cost: str,
    *,
    principal: str = FINOPS,
    tokens: bool = True,
    account: str = ACCOUNT,
    product: str = "AmazonBedrock",
    entity: str = "AWS",
    family: str = "Amazon Bedrock",
    kind: str = "Usage",
    items: int = 4,
    public: str | None = None,
) -> query.Row:
    """A row whose public on-demand cost is ``cost`` (or ``public``) and unblended cost ``cost``."""
    return query.Row(
        day,
        account,
        product,
        entity,
        family,
        principal,
        tokens,
        kind,
        Decimal(cost if public is None else public),
        Decimal(cost),
        items,
    )


def claude(day: str, cost: str, **kwargs: Any) -> query.Row:
    """A row of a Bedrock model sold through AWS Marketplace: its public on-demand cost is 0, as
    in the bill (2026-11-07), and ``cost`` is its unblended cost."""
    return row(day, cost, **{"product": CLAUDE, "entity": MARKETPLACE, "public": "0", **kwargs})


@dataclass
class FakeAthena:
    rows: list[query.Row] = field(default_factory=list)
    calls: list[tuple[str, list[str]]] = field(default_factory=list)

    def run(self, statement: str, params: list[str], timeout_seconds: float) -> list[query.Row]:
        assert timeout_seconds > 0
        self.calls.append((statement, params))
        return self.rows


@dataclass
class FakeFirehose:
    records: list[dict[str, Any]] = field(default_factory=list)

    def put_record(self, DeliveryStreamName: str, Record: dict[str, bytes]) -> None:  # noqa: N803
        self.records.append(json.loads(Record["Data"]))


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        for name in (TABLE, INDEX):
            client.create_table(
                TableName=name,
                KeySchema=[
                    {"AttributeName": "PK", "KeyType": "HASH"},
                    {"AttributeName": "SK", "KeyType": "RANGE"},
                ],
                AttributeDefinitions=[
                    {"AttributeName": "PK", "AttributeType": "S"},
                    {"AttributeName": "SK", "AttributeType": "S"},
                ],
                BillingMode="PAY_PER_REQUEST",
            )
        yield client


def count(db: Any, key: str, day: str, spent: str) -> None:
    for item in usage_days.updates(TABLE, (key,), day, spent=Decimal(spent), turns=1):
        db.update_item(**item["Update"])


@dataclass
class Run:
    reconciler: CurReconciler
    athena: FakeAthena
    firehose: FakeFirehose

    def go(self) -> dict[str, Any]:
        handle(self.reconciler, SETTINGS, NOW, lambda: 300.0)
        (record,) = self.firehose.records
        assert (record["event"], record["user_id"]) == (EVENT_RECONCILED, ACTOR)
        detail: dict[str, Any] = record["detail"]
        return detail


def make(db: Any, rows: list[query.Row]) -> Run:
    athena, firehose = FakeAthena(rows), FakeFirehose()
    audit = AuditWriter(firehose, "audit", db, INDEX)  # type: ignore[arg-type]
    reconciler = CurReconciler(SETTINGS, dynamodb=db, athena=athena, audit=audit)  # type: ignore[arg-type]
    return Run(reconciler, athena, firehose)


# --- Settings -----------------------------------------------------------------------------


def test_settings_refuse_what_the_stack_never_sets() -> None:
    assert SETTINGS.product_codes == {"AmazonBedrock", "AmazonBedrockService"}
    assert SETTINGS.agent_role_prefix == "Mango-lab-agent-"
    for key, value in (
        ("MANGO_ACCOUNT_ID", "12345"),
        ("CUR_DATABASE", 'x"; DROP'),
        ("BEDROCK_PRODUCT_CODES", ""),
        ("BEDROCK_PRODUCT_CODES", "Amazon Bedrock"),
        ("MARKETPLACE_BILLING_ENTITY", "AWS Marketplace' OR '1'='1"),
        ("BEDROCK_PRODUCT_FAMILY", ""),
        ("THRESHOLD_PERCENT", "-1"),
        ("THRESHOLD_USD", "abc"),
    ):
        with pytest.raises(ConfigError):
            Settings.from_env({**ENV, key: value})
    with pytest.raises(ConfigError, match="CUR_WORKGROUP"):
        Settings.from_env({k: v for k, v in ENV.items() if k != "CUR_WORKGROUP"})


# --- The query ------------------------------------------------------------------------------


def test_one_fixed_query_with_the_dates_as_parameters() -> None:
    assert window(NOW.date())[0] == "2026-10-16"
    assert window(NOW.date())[-1] == "2026-11-18"
    assert len(window(NOW.date())) == 34
    statement = query.sql("mango_lab_cur", "bedrock")
    assert 'FROM "mango_lab_cur"."bedrock"' in statement
    assert statement.count("?") == 4
    # Not filtered by account or product: what does not belong must be seen (TM-CUR1).
    assert "line_item_usage_account_id =" not in statement
    assert "bill_billing_entity" in statement and "product_product_family" in statement
    assert "coalesce(pricing_public_on_demand_cost, line_item_unblended_cost, 0)" in statement
    assert "sum(coalesce(line_item_unblended_cost, 0)) AS unblended_cost" in statement
    assert query.parameters("2026-10-16", "2026-11-18") == [
        "'2026-10'",
        "'2026-11'",
        "'2026-10-16 00:00:00'",
        "'2026-11-19 00:00:00'",
    ]


@dataclass
class FakeAthenaClient:
    states: list[str]
    pages: list[dict[str, Any]] = field(default_factory=list)
    started: list[dict[str, Any]] = field(default_factory=list)
    stopped: list[str] = field(default_factory=list)

    def start_query_execution(self, **request: Any) -> dict[str, Any]:
        self.started.append(request)
        return {"QueryExecutionId": "q-1"}

    def get_query_execution(self, QueryExecutionId: str) -> dict[str, Any]:  # noqa: N803
        state = self.states.pop(0) if len(self.states) > 1 else self.states[0]
        reason = "HIVE_BAD_DATA: value 444455556666 of line_item_usage_account_id"
        return {"QueryExecution": {"Status": {"State": state, "StateChangeReason": reason}}}

    def get_query_results(self, **request: Any) -> dict[str, Any]:
        return self.pages.pop(0)

    def stop_query_execution(self, QueryExecutionId: str) -> None:  # noqa: N803
        self.stopped.append(QueryExecutionId)


def _cells(*values: str) -> dict[str, Any]:
    return {"Data": [{"VarCharValue": v} for v in values]}


def test_the_token_usage_types_of_bedrock_and_of_marketplace() -> None:
    tokens = re.compile(query.TOKEN_USAGE)
    for usage in (
        "USE1-Claude4.6Sonnet-input-tokens",
        "USE1-Claude4.6Sonnet-output-tokens-cross-region-global",
        "USE1-Claude4.6Sonnet-cache-read-input-token-count",
        "USE1-Claude4.6Sonnet-cache-write-input-token-count",
        "USE1-openai.gpt-oss-120b-mantle-input-tokens-standard",
        "USE1-MP:USE1_InputTokenCount-Units",
        "USE1-MP:USE1_OutputTokenCount-Units",
        "USE1-MP:USE1_CacheReadInputTokenCount-Units",
        "USE1-MP:USE1_CacheWriteInputTokenCount-Units",
        "APN1-MP:APN1_output_tokens_global_standard-Units",
    ):
        assert tokens.search(usage), usage
    for usage in (
        "USE1-ContentPolicyUnitsConsumed",
        "USE1-guardrail-text-units",
        "USE1-MP:USE1_Hours",
    ):
        assert not tokens.search(usage), usage


def test_athena_runs_in_the_workgroup_and_reads_every_page() -> None:
    header = _cells(
        "day",
        "account",
        "product",
        "entity",
        "family",
        "principal",
        "tokens",
        "kind",
        "c",
        "u",
        "n",
    )
    first = _cells(
        "2026-11-01",
        ACCOUNT,
        CLAUDE,
        MARKETPLACE,
        "Amazon Bedrock",
        FINOPS,
        "true",
        "Usage",
        "0.0",
        "1.5",
        "3",
    )
    second = _cells(
        "2026-11-02",
        ACCOUNT,
        "AmazonBedrock",
        "AWS",
        "Amazon Bedrock",
        "",
        "false",
        "Usage",
        "0.2",
        "0.2",
        "1",
    )
    client = FakeAthenaClient(
        ["RUNNING", "SUCCEEDED"],
        [
            {"ResultSet": {"Rows": [header, first]}, "NextToken": "t"},
            {"ResultSet": {"Rows": [second]}},
        ],
    )
    athena = query.Athena(client, "Mango-lab-cur", "mango_lab_cur", sleep=lambda _s: None)  # type: ignore[arg-type]
    rows = athena.run("SELECT 1", ["'x'"], 60)
    assert client.started == [
        {
            "QueryString": "SELECT 1",
            "WorkGroup": "Mango-lab-cur",
            "QueryExecutionContext": {"Catalog": "AwsDataCatalog", "Database": "mango_lab_cur"},
            "ExecutionParameters": ["'x'"],
        }
    ]
    assert [
        (r.day, r.entity, r.tokens, r.list_cost, r.unblended_cost, r.line_items) for r in rows
    ] == [
        ("2026-11-01", MARKETPLACE, True, Decimal("0.0"), Decimal("1.5"), 3),
        ("2026-11-02", "AWS", False, Decimal("0.2"), Decimal("0.2"), 1),
    ]


def test_a_query_that_fails_or_runs_too_long_fails_the_run() -> None:
    failed = query.Athena(FakeAthenaClient(["FAILED"]), "w", "d", sleep=lambda _s: None)  # type: ignore[arg-type]
    with pytest.raises(query.QueryError, match="failed") as raised:
        failed.run("SELECT 1", [], 60)
    # Only the kind of error: never a value of a row.
    assert str(raised.value) == "query failed: HIVE_BAD_DATA"
    ticks = iter([0.0, 100.0])
    client = FakeAthenaClient(["RUNNING"])
    slow = query.Athena(client, "w", "d", sleep=lambda _s: None, clock=lambda: next(ticks))  # type: ignore[arg-type]
    with pytest.raises(query.QueryError, match="timed out"):
        slow.run("SELECT 1", [], 60)
    assert client.stopped == ["q-1"]


# --- Sorting the bill -------------------------------------------------------------------------


def test_the_caller_is_read_from_a_role_or_its_session() -> None:
    assert role_name(FINOPS) == "Mango-lab-agent-finops"
    assert role_name(f"arn:aws:iam::{ACCOUNT}:role/path/Mango-lab-agent-x1") == "Mango-lab-agent-x1"
    assert role_name(f"arn:aws:iam::{ACCOUNT}:user/someone") is None
    assert role_name("") is None
    assert agent_of(FINOPS, "Mango-lab-agent-") == "finops"
    assert agent_of(PLAYGROUND, "Mango-lab-agent-") == "playground"
    # Another installation's agent, mango-api, or an id that cannot be one: not an agent.
    assert agent_of(FINOPS.replace("-lab-", "-poc-"), "Mango-lab-agent-") is None
    assert agent_of(API, "Mango-lab-agent-") is None
    assert agent_of(FINOPS.replace("finops", "Bad_Id"), "Mango-lab-agent-") is None


def test_the_bill_is_sorted_into_agents_total_and_unattributed() -> None:
    sorted_rows = sort(
        [
            row("2026-11-01", "2"),
            row("2026-11-01", "0.5", principal=PLAYGROUND),
            row("2026-11-01", "0.25", principal=API),
            row("2026-11-01", "0.75", tokens=False),
            row("2026-11-01", "9", kind="Credit"),
        ],
        account=ACCOUNT,
        bedrock=BEDROCK,
        prefix=SETTINGS.agent_role_prefix,
    )
    assert sorted_rows.unexpected == 0
    assert sorted_rows.agents == {
        "finops": {"2026-11-01": Decimal(2)},
        "playground": {"2026-11-01": Decimal("0.5")},
    }
    assert sorted_rows.total == {"2026-11-01": Decimal("2.75")}
    assert sorted_rows.unattributed == {
        UNATTRIBUTED_OTHER_CALLER: Decimal("0.25"),
        UNATTRIBUTED_NOT_TOKENS: Decimal("0.75"),
    }


def test_the_marketplace_rows_of_a_bedrock_model_count_like_bedrock_s() -> None:
    """Claude on Bedrock is billed as a product of AWS Marketplace (D104, 2026-11-06)."""
    sorted_rows = sort(
        [
            row("2026-11-01", "0.5"),
            claude("2026-11-01", "3"),
            claude("2026-11-01", "1", principal=PLAYGROUND),
            claude("2026-11-01", "0.25", principal=API),
            claude("2026-11-01", "0.1", tokens=False),
            # Another model of Marketplace: another product code, the same entity and family.
            claude("2026-11-02", "2", product="z9y8x7w6v5u4t3s2r1q0p9o8n"),
        ],
        account=ACCOUNT,
        bedrock=BEDROCK,
        prefix=SETTINGS.agent_role_prefix,
    )
    assert sorted_rows.unexpected == 0
    assert sorted_rows.agents == {
        "finops": {"2026-11-01": Decimal("3.5"), "2026-11-02": Decimal(2)},
        "playground": {"2026-11-01": Decimal(1)},
    }
    assert sorted_rows.total == {"2026-11-01": Decimal("4.75"), "2026-11-02": Decimal(2)}
    assert sorted_rows.unattributed == {
        UNATTRIBUTED_OTHER_CALLER: Decimal("0.25"),
        UNATTRIBUTED_NOT_TOKENS: Decimal("0.1"),
    }


def test_the_cost_of_a_row_is_its_list_price_and_marketplace_s_is_its_unblended() -> None:
    """Marketplace's rows bring a public on-demand cost of 0 (2026-11-07); Bedrock's own rows are
    compared at their public on-demand cost, never at a discounted unblended one."""
    assert BEDROCK.cost(claude("2026-11-01", "2.75")) == Decimal("2.75")
    assert BEDROCK.cost(row("2026-11-01", "0.8", public="1")) == Decimal(1)
    sorted_rows = sort(
        [
            claude("2026-11-04", "2.7464"),
            claude("2026-11-04", "0.3691"),
            # A discount line of Marketplace: not usage, never compared.
            claude("2026-11-04", "-0.3", kind="EdpDiscount"),
        ],
        account=ACCOUNT,
        bedrock=BEDROCK,
        prefix=SETTINGS.agent_role_prefix,
    )
    assert sorted_rows.total == {"2026-11-04": Decimal("3.1155")}


def test_a_marketplace_row_that_is_not_a_bedrock_model_is_unexpected() -> None:
    for foreign in (
        claude("2026-11-01", "5", family="Software", items=2),
        claude("2026-11-01", "5", family="", items=2),
        claude("2026-11-01", "5", account=OTHER_ACCOUNT, items=2),
        # Bedrock's family under AWS, but with a product code that is not Bedrock's.
        row("2026-11-01", "5", product="AmazonSageMaker", items=2),
    ):
        sorted_rows = sort(
            [claude("2026-11-01", "3"), foreign],
            account=ACCOUNT,
            bedrock=BEDROCK,
            prefix=SETTINGS.agent_role_prefix,
        )
        assert sorted_rows.unexpected == 2, foreign


def test_both_thresholds_must_be_passed() -> None:
    one, ten = Decimal(1), Decimal(10)
    assert not deviates(Decimal(100), Decimal(105), percent=ten, usd=one)  # 5 %
    assert not deviates(Decimal("0.5"), Decimal("1.4"), percent=ten, usd=one)  # under USD 1
    assert deviates(Decimal(10), Decimal("12.5"), percent=ten, usd=one)
    assert deviates(Decimal(0), Decimal(3), percent=ten, usd=one)
    assert deviates(Decimal(3), Decimal(0), percent=ten, usd=one)


# --- Runs -------------------------------------------------------------------------------------


def test_without_data_it_audits_no_data_and_does_not_alarm(db: Any) -> None:
    run = make(db, [])
    detail = run.go()
    assert detail["status"] == STATUS_NO_DATA
    assert (detail["first_day"], detail["last_day"]) == ("2026-10-16", "2026-11-18")
    report = run.reconciler.run(NOW, lambda: 300.0)
    assert (report.findings, report.metrics("lab", NOW)["NoData"]) == (0, 1)


def test_a_row_of_another_account_or_product_stops_the_run(
    db: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    count(db, "DAY#AGENT#finops", "2026-11-01", "2")
    for rows in (
        [row("2026-11-01", "2"), row("2026-11-01", "40", account=OTHER_ACCOUNT, items=7)],
        [row("2026-11-01", "2"), row("2026-11-01", "40", product="AmazonEC2", items=7)],
    ):
        run = make(db, rows)
        detail = run.go()
        assert detail["status"] == STATUS_UNEXPECTED
        assert (detail["line_items"], detail["unexpected_line_items"]) == (11, 7)
        # Nothing of the foreign rows is described: neither the account nor the amount.
        assert OTHER_ACCOUNT not in json.dumps(detail)
        assert "40" not in json.dumps({k: v for k, v in detail.items() if "line_items" not in k})
        printed = json.loads(capsys.readouterr().out.splitlines()[0])
        assert (printed["Findings"], printed["UnexpectedRows"]) == (1, 7)


def test_agents_and_the_organization_are_compared_from_the_day_after_the_first_counter(
    db: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    # The counters start on 2026-10-30 (the release that brought them): that day is partial.
    count(db, "DAY#AGENT#finops", "2026-10-30", "0.4")
    for day, spent in (("2026-11-01", "2"), ("2026-11-02", "3"), ("2026-11-03", "1")):
        count(db, "DAY#AGENT#finops", day, spent)
    count(db, "DAY#AGENT#playground", "2026-11-01", "0.5")
    for day, spent in (
        ("2026-10-30", "0.4"),
        ("2026-11-01", "2.75"),
        ("2026-11-02", "3"),
        ("2026-11-03", "1"),
    ):
        count(db, usage_days.ORG_KEY, day, spent)
    rows = [
        row("2026-10-29", "7"),  # before the counters: never compared
        row("2026-10-30", "1"),  # the partial day
        row("2026-11-01", "2.05"),
        row("2026-11-01", "0.5", principal=PLAYGROUND),
        row("2026-11-01", "0.25", principal=API),  # the title, in DAY#ORG
        row("2026-11-02", "8"),  # Mango counted 3: a deviation, and of the total
        row("2026-11-03", "1"),
        row("2026-11-03", "0.3", tokens=False),  # a guardrail: apart
    ]
    run = make(db, rows)
    detail = run.go()
    assert detail["status"] == STATUS_RECONCILED
    assert (detail["since"], detail["org_since"]) == ("2026-10-31", "2026-10-31")
    assert (detail["days_compared"], detail["org_days_compared"]) == (19, 19)
    assert detail["agents"] == 2
    assert detail["deviations"] == 2
    assert detail["deviation_list"] == [
        {"day": "2026-11-02", "agent": "*", "mango_usd": "3.000000", "cur_usd": "8.000000"},
        {"day": "2026-11-02", "agent": "finops", "mango_usd": "3.000000", "cur_usd": "8.000000"},
    ]
    assert (detail["mango_usd"], detail["cur_usd"]) == ("6.750000", "11.800000")
    assert detail["unattributed_usd"] == {
        UNATTRIBUTED_BEFORE_COUNTER: "8.000000",
        UNATTRIBUTED_NOT_TOKENS: "0.300000",
        UNATTRIBUTED_OTHER_CALLER: "0.250000",
    }
    printed = json.loads(capsys.readouterr().out.splitlines()[0])
    assert (printed["Findings"], printed["Deviations"], printed["NoData"]) == (2, 2, 0)
    # Read only: the counters are as they were.
    assert usage_days.read(db, TABLE, "DAY#AGENT#finops", "2026-11-02", "2026-11-02")[0].spent == 3


def test_the_spend_of_claude_billed_by_marketplace_reconciles(db: Any) -> None:
    """The case of the installation: Claude's tokens are Marketplace rows, Bedrock's own rows are
    only what is not model tokens. Before the precision of 2026-11-06 the bill read 0 USD."""
    count(db, "DAY#AGENT#finops", "2026-10-30", "0.1")
    count(db, usage_days.ORG_KEY, "2026-10-30", "0.1")
    for day, spent in (("2026-11-01", "3.4"), ("2026-11-02", "4.8")):
        count(db, "DAY#AGENT#finops", day, spent)
        count(db, usage_days.ORG_KEY, day, spent)
    rows = [
        claude("2026-11-01", "3.35"),
        claude("2026-11-02", "4.78"),
        row("2026-11-01", "0.06", tokens=False),
        row("2026-11-02", "0.06", tokens=False),
    ]
    detail = make(db, rows).go()
    assert detail["status"] == STATUS_RECONCILED
    assert detail["deviations"] == 0
    assert detail["cur_usd"] == "8.130000"
    assert detail["unattributed_usd"] == {UNATTRIBUTED_NOT_TOKENS: "0.120000"}


def test_an_agent_the_bill_charges_and_mango_never_counted_deviates(db: Any) -> None:
    count(db, "DAY#AGENT#finops", "2026-11-01", "1")
    other = FINOPS.replace("finops", "abcdefghijklmnop")
    detail = make(db, [row("2026-11-01", "1"), row("2026-11-05", "4", principal=other)]).go()
    assert detail["deviation_list"][-1] == {
        "day": "2026-11-05",
        "agent": "abcdefghijklmnop",
        "mango_usd": "0.000000",
        "cur_usd": "4.000000",
    }


def test_before_any_counter_nothing_is_compared(db: Any) -> None:
    count(db, usage_days.ORG_KEY, "2026-11-10", "1")
    detail = make(db, [row("2026-11-05", "4")]).go()
    assert (detail["status"], detail["since"], detail["days_compared"]) == (
        STATUS_RECONCILED,
        "",
        0,
    )
    assert (detail["deviations"], detail["org_since"]) == (0, "2026-11-11")
    assert detail["unattributed_usd"] == {UNATTRIBUTED_BEFORE_COUNTER: "4.000000"}


def test_the_audit_record_is_the_one_mango_api_writes() -> None:
    from mango_api.audit import AuditLog  # noqa: PLC0415

    ours, theirs = FakeFirehose(), FakeFirehose()

    class Index:
        def put_item(self, **_: Any) -> None: ...

    detail = {"status": "no_data", "first_day": "2026-10-16"}
    AuditWriter(ours, "s", Index(), "i").emit(EVENT_RECONCILED, detail, NOW)  # type: ignore[arg-type]
    AuditLog(theirs, "s", Index(), "i").emit(EVENT_RECONCILED, ACTOR, detail)  # type: ignore[arg-type]
    mine, api = ours.records[0], theirs.records[0]
    assert sorted(mine) == sorted(api)
    assert (mine["event"], mine["user_id"], mine["detail"]) == (
        api["event"],
        api["user_id"],
        api["detail"],
    )
