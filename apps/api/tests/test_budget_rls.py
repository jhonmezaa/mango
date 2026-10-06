import gc
import json
import threading
import weakref
from decimal import Decimal
from typing import Any

import boto3
import pytest
from botocore.stub import ANY, Stubber

from mango_api import conversations
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


# --- Clients per person: bounded, and never shared ---------------------------------------


class _Sts:
    """Issues credentials that name the person of the session policy they were asked with."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def assume_role(self, **request: Any) -> dict[str, Any]:
        policy = json.loads(request["Policy"])
        (key,) = policy["Statement"][0]["Condition"]["ForAllValues:StringEquals"][
            "dynamodb:LeadingKeys"
        ]
        user_id = key.removeprefix("USER#")
        self.calls.append(user_id)
        return {
            "Credentials": {
                "AccessKeyId": f"key-{user_id}-{len(self.calls)}",
                "SecretAccessKey": "secret",
                "SessionToken": "token",
            }
        }


def _factory(sts: _Sts, now: list[float]) -> RlsClientFactory:
    return RlsClientFactory(
        sts,  # type: ignore[arg-type]
        role_arn="arn:aws:iam::111111111111:role/data",
        table_arn="arn:aws:dynamodb:us-east-1:111111111111:table/conv",
        key_arn="arn:aws:kms:us-east-1:111111111111:key/k",
        region="us-east-1",
        clock=lambda: now[0],
    )


def _access_key(client: Any) -> str:
    return str(client._request_signer._credentials.access_key)


def test_rls_client_is_reused_for_its_user_and_never_for_another() -> None:
    sts, now = _Sts(), [0.0]
    factory = _factory(sts, now)
    first = factory.for_user("user-1")
    other = factory.for_user("user-2")
    assert factory.for_user("user-1") is first
    assert other is not first
    assert _access_key(first).startswith("key-user-1-")
    assert _access_key(other).startswith("key-user-2-")
    assert sts.calls == ["user-1", "user-2"]


def test_rls_clients_are_released_once_their_credentials_are_old() -> None:
    sts, now = _Sts(), [0.0]
    factory = _factory(sts, now)
    released = [weakref.ref(factory.for_user(f"user-{n}")) for n in range(5)]
    now[0] = 9 * 60
    kept = factory.for_user("user-late")
    assert len(factory._cache) == 6
    # Ten minutes after the first five: the next person to arrive clears them out.
    now[0] = 10 * 60 + 1
    factory.for_user("user-new")
    assert list(factory._cache) == ["user-late", "user-new"]
    gc.collect()
    assert [ref() for ref in released] == [None] * 5
    assert factory.for_user("user-late") is kept
    # Someone who comes back gets new credentials, asked for under their own id.
    again = factory.for_user("user-0")
    assert sts.calls[-1] == "user-0"
    assert _access_key(again).startswith("key-user-0-")


def test_rls_clients_have_a_ceiling(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(conversations, "MAX_USER_CLIENTS", 3)
    sts, now = _Sts(), [0.0]
    factory = _factory(sts, now)
    for n in range(5):
        now[0] += 1
        factory.for_user(f"user-{n}")
    # The oldest went first; nobody was handed the client of somebody else on the way.
    assert list(factory._cache) == ["user-2", "user-3", "user-4"]
    for user_id, (_, client) in factory._cache.items():
        assert _access_key(client).startswith(f"key-{user_id}-")
    assert _access_key(factory.for_user("user-0")).startswith("key-user-0-")


def test_rls_clients_stay_bound_to_their_user_under_concurrency() -> None:
    sts, now = _Sts(), [0.0]
    factory = _factory(sts, now)
    wrong: list[str] = []

    def work(worker: int) -> None:
        for n in range(40):
            user_id = f"user-{(worker + n) % 7}"
            if not _access_key(factory.for_user(user_id)).startswith(f"key-{user_id}-"):
                wrong.append(user_id)

    threads = [threading.Thread(target=work, args=(worker,)) for worker in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert wrong == []
    assert len(factory._cache) == 7
