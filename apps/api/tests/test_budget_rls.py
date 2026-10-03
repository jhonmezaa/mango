import json
from decimal import Decimal
from typing import Any

import boto3
import pytest
from botocore.stub import ANY, Stubber

from mango_api.budget import (
    BudgetExceededError,
    BudgetScope,
    BudgetService,
    BudgetUnavailableError,
)
from mango_api.conversations import RlsClientFactory
from mango_api.pricing import Usage, cost, estimate_max_cost
from mango_api.settings import ModelPrice

PRICE = ModelPrice(Decimal(3), Decimal(15), Decimal("0.3"), Decimal("3.75"))


def _db() -> Any:
    return boto3.client("dynamodb", region_name="us-east-1")


def test_reserve_checks_headroom_atomically_for_all_scopes() -> None:
    db = _db()
    scopes = [BudgetScope("USER#u", Decimal(5)), BudgetScope("AGENT#finops", Decimal(30))]
    with Stubber(db) as stub:
        stub.add_response("transact_write_items", {}, {"TransactItems": ANY})
        BudgetService(db, "budgets").reserve(scopes, Decimal("0.5"), "2026-09")
        stub.assert_no_pending_responses()


def test_reserve_rejects_amount_above_limit_without_calling_aws() -> None:
    db = _db()
    with Stubber(db), pytest.raises(BudgetExceededError):
        BudgetService(db, "budgets").reserve(
            [BudgetScope("USER#u", Decimal(1))], Decimal(2), "2026-09"
        )


def _cancel(stub: Stubber, *codes: str) -> None:
    stub.add_client_error(
        "transact_write_items",
        "TransactionCanceledException",
        modeled_fields={"CancellationReasons": [{"Code": code} for code in codes]},
    )


SCOPES = [BudgetScope("USER#u", Decimal(5)), BudgetScope("AGENT#finops", Decimal(30))]


def test_reserve_maps_condition_failure_to_budget_exceeded() -> None:
    db = _db()
    with Stubber(db) as stub:
        _cancel(stub, "None", "ConditionalCheckFailed")
        with pytest.raises(BudgetExceededError):
            BudgetService(db, "budgets", sleep=lambda _s: None).reserve(
                SCOPES, Decimal(1), "2026-09"
            )


def test_reserve_retries_concurrent_transaction_conflicts() -> None:
    db = _db()
    sleeps: list[float] = []
    with Stubber(db) as stub:
        _cancel(stub, "None", "TransactionConflict")
        _cancel(stub, "TransactionConflict", "None")
        stub.add_response("transact_write_items", {}, {"TransactItems": ANY})
        BudgetService(db, "budgets", sleep=sleeps.append).reserve(SCOPES, Decimal(1), "2026-09")
        stub.assert_no_pending_responses()
    assert len(sleeps) == 2


def test_sustained_conflicts_are_not_reported_as_budget_exceeded() -> None:
    db = _db()
    with Stubber(db) as stub:
        for _ in range(4):
            _cancel(stub, "TransactionConflict", "None")
        with pytest.raises(BudgetUnavailableError):
            BudgetService(db, "budgets", sleep=lambda _s: None).reserve(
                SCOPES, Decimal(1), "2026-09"
            )


def test_cost_and_estimate() -> None:
    assert cost(Usage(input_tokens=1_000_000, output_tokens=0), PRICE) == Decimal("3.000000")
    estimate = estimate_max_cost(
        PRICE, history_chars=3000, max_iterations=12, max_output_tokens=8000
    )
    assert Decimal("0.2") < estimate < Decimal("0.5")


def test_rls_session_policy_is_bound_to_the_user() -> None:
    factory = RlsClientFactory(
        boto3.client("sts", region_name="us-east-1"),
        role_arn="arn:aws:iam::111111111111:role/data",
        table_arn="arn:aws:dynamodb:us-east-1:111111111111:table/conv",
        key_arn="arn:aws:kms:us-east-1:111111111111:key/k",
        region="us-east-1",
    )
    policy = json.loads(factory.session_policy("user-1"))
    statement = policy["Statement"][0]
    assert statement["Condition"] == {
        "ForAllValues:StringEquals": {"dynamodb:LeadingKeys": ["USER#user-1"]}
    }
    assert "dynamodb:Scan" not in statement["Action"]
    assert "dynamodb:DeleteItem" not in statement["Action"]
