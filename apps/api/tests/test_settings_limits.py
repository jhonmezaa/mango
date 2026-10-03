import io
import json
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

import pytest
from botocore.exceptions import ClientError

from mango_api.probe import AdminProbe, ProbeError, RateLimiter
from mango_api.settings_store import BudgetDefaults, BudgetLimits, SettingsUnavailableError


@dataclass
class FakeStore:
    fail: bool = False
    reads: int = 0
    overrides: dict[str, Decimal] = field(default_factory=dict)

    def _check(self) -> None:
        self.reads += 1
        if self.fail:
            raise ClientError({"Error": {"Code": "InternalServerError"}}, "GetItem")

    def budget_defaults(self) -> BudgetDefaults:
        self._check()
        return BudgetDefaults(Decimal(20), Decimal(200), 1)

    def user_limit(self, user_id: str) -> Decimal | None:
        self._check()
        return self.overrides.get(user_id)


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def _limits(store: FakeStore, clock: Clock, **kw: Any) -> BudgetLimits:
    return BudgetLimits(store, clock=clock, **kw)  # type: ignore[arg-type]


def test_override_wins_over_default() -> None:
    store = FakeStore(overrides={"u1": Decimal(3)})
    limits = _limits(store, Clock())
    assert limits.for_user("u1") == (Decimal(3), Decimal(200))
    assert limits.for_user("u2") == (Decimal(20), Decimal(200))


def test_cache_is_at_most_thirty_seconds() -> None:
    store, clock = FakeStore(), Clock()
    limits = _limits(store, clock, ttl_seconds=600)
    limits.for_user("u1")
    clock.now = 30
    limits.for_user("u1")
    assert store.reads == 2
    clock.now = 31
    limits.for_user("u1")
    assert store.reads == 4


def test_fails_closed_without_cache() -> None:
    limits = _limits(FakeStore(fail=True), Clock())
    with pytest.raises(SettingsUnavailableError):
        limits.for_user("u1")


def test_uses_recent_value_on_transient_errors_but_not_forever() -> None:
    store, clock = FakeStore(), Clock()
    limits = _limits(store, clock, max_stale_seconds=300)
    assert limits.for_user("u1") == (Decimal(20), Decimal(200))
    store.fail = True
    clock.now = 100
    assert limits.for_user("u1") == (Decimal(20), Decimal(200))
    clock.now = 301
    with pytest.raises(SettingsUnavailableError):
        limits.for_user("u1")


class FakeLambda:
    def __init__(self, payload: object, function_error: bool = False) -> None:
        self.payload = payload
        self.function_error = function_error
        self.requests: list[dict[str, Any]] = []

    def invoke(self, **kw: Any) -> dict[str, Any]:
        self.requests.append(kw)
        resp: dict[str, Any] = {"Payload": io.BytesIO(json.dumps(self.payload).encode())}
        if self.function_error:
            resp["FunctionError"] = "Unhandled"
        return resp


def test_probe_sends_only_operation_and_actor() -> None:
    client = FakeLambda({"checks": [{"name": "broker", "status": "ok", "detail": "ok"}]})
    AdminProbe(client, "Mango-t-AdminProbe").connectivity("admin-1")  # type: ignore[arg-type]
    [request] = client.requests
    assert request["FunctionName"] == "Mango-t-AdminProbe"
    assert json.loads(request["Payload"]) == {"operation": "connectivity", "actor": "admin-1"}


@pytest.mark.parametrize(
    ("payload", "function_error"),
    [
        ({"error": {"code": "upstream_error"}}, False),
        ({"ous": []}, True),
        ({"ous": [{"id": "not-an-ou", "name": "x", "parent_id": "r-abcd", "path": ["x"]}]}, False),
        ({"ous": [], "extra": 1}, False),
        ("text", False),
    ],
)
def test_probe_responses_are_validated(payload: object, function_error: bool) -> None:
    probe = AdminProbe(FakeLambda(payload, function_error), "f")  # type: ignore[arg-type]
    with pytest.raises(ProbeError):
        probe.organization("admin-1")


def test_probe_member_access_names_the_account_and_nothing_else() -> None:
    checks = [
        {"name": name, "status": "ok", "detail": "ok"}
        for name in ("read_broker", "member_role", "account", "source_identity_required")
    ]
    client = FakeLambda({"checks": checks})
    result = AdminProbe(client, "f").member_access("admin-1", "210987654321")  # type: ignore[arg-type]
    assert result.checks[0].name == "read_broker"
    assert json.loads(client.requests[0]["Payload"]) == {
        "operation": "member_access",
        "actor": "admin-1",
        "account_id": "210987654321",
    }


@pytest.mark.parametrize(
    "payload",
    [
        {"accounts": [{"id": "21098765432", "name": "short id"}], "truncated": False},
        {
            "accounts": [{"id": "210987654321", "name": "x", "arn": "arn:aws:iam::1:role/x"}],
            "truncated": False,
        },
        {"accounts": []},
        {"accounts": [], "truncated": False, "total": -1},
        {"accounts": [], "truncated": False, "total": "63"},
        {"error": {"code": "upstream_error"}},
    ],
)
def test_probe_member_accounts_are_validated(payload: object) -> None:
    probe = AdminProbe(FakeLambda(payload), "f")  # type: ignore[arg-type]
    with pytest.raises(ProbeError):
        probe.member_accounts("admin-1")


def test_probe_member_accounts_carry_the_total_when_the_probe_sends_it() -> None:
    accounts = [{"id": "210987654321", "name": "prod"}]
    with_total = FakeLambda({"accounts": accounts, "truncated": True, "total": 63})
    assert AdminProbe(with_total, "f").member_accounts("admin-1").total == 63  # type: ignore[arg-type]
    # A probe that predates the field is still accepted.
    without = FakeLambda({"accounts": accounts, "truncated": False})
    assert AdminProbe(without, "f").member_accounts("admin-1").total is None  # type: ignore[arg-type]


def test_probe_member_access_checks_are_validated() -> None:
    probe = AdminProbe(
        FakeLambda({"checks": [{"name": "other", "status": "ok", "detail": "ok"}]}), "f"
    )  # type: ignore[arg-type]
    with pytest.raises(ProbeError):
        probe.member_access("admin-1", "210987654321")


def test_rate_limiter_sliding_window() -> None:
    clock = Clock()
    limiter = RateLimiter(limit=5, window_seconds=60, clock=clock)
    assert all(limiter.allow("a") for _ in range(5))
    assert not limiter.allow("a")
    assert limiter.allow("b")
    clock.now = 60
    assert limiter.allow("a")
