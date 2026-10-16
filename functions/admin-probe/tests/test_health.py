import dataclasses
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from mango_admin_probe import handler, health

NOW = datetime(2026, 10, 16, 6, 30, tzinfo=UTC)
SETTINGS = dataclasses.replace(
    handler.Settings(
        broker_role_arn="arn:aws:iam::111111111111:role/Mango-poc-BillingBroker",
        reader_role_arn="arn:aws:iam::222222222222:role/Mango-poc-BillingReader",
        read_broker_role_arn="arn:aws:iam::111111111111:role/Mango-poc-ReadBroker",
        member_read_role_name="Mango-poc-ReadOnly",
    ),
    org_access_targets=("ou-abcd-11111111",),
)
OK, REFUSES, ELSEWHERE, FLAKY = "333333333333", "444444444444", "555555555555", "666666666666"


def _error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "arn:aws:iam::9:role/x"}}, "Op")


@dataclass
class FakeOrg:
    accounts: list[str]

    def get_paginator(self, name: str) -> Any:
        if name == "list_accounts":
            pages = [
                {
                    "Accounts": [
                        {"Id": a, "Name": f"acct {a[:3]}", "State": "ACTIVE"} for a in self.accounts
                    ]
                }
            ]
        elif name == "list_children":
            pages = [{"Children": [{"Id": a} for a in self.accounts]}]
        else:
            pages = [{"OrganizationalUnits": []}]
        return SimpleNamespace(paginate=lambda **_k: pages)


@dataclass
class FakeSessions:
    org: FakeOrg
    broker_error: str | None = None
    list_error: str | None = None
    calls: list[tuple[str, str, Any]] = field(default_factory=list)

    def assume(self, chain: Any, caller: Any, policy: str) -> Any:
        self.calls.append(("assume", caller.source_identity, (chain, json.loads(policy))))
        if self.list_error:
            raise _error(self.list_error)
        return SimpleNamespace(client=lambda *_a, **_k: self.org)

    def assume_broker(self, chain: Any, caller: Any) -> Any:
        self.calls.append(("broker", caller.source_identity, (chain, dict(caller.tags))))
        if self.broker_error:
            raise _error(self.broker_error)
        return "broker-sts"

    def assume_target(self, broker: Any, chain: Any, caller: Any, policy: str) -> Any:
        assert broker == "broker-sts"
        account = chain.target_role_arn.split(":")[4]
        self.calls.append(("target", caller.source_identity, (account, json.loads(policy))))
        if account == REFUSES:
            raise _error("AccessDenied")
        if account == FLAKY:
            raise EndpointConnectionError(endpoint_url="https://sts.amazonaws.com")
        seen = "777777777777" if account == ELSEWHERE else account
        sts = SimpleNamespace(get_caller_identity=lambda: {"Account": seen})
        return SimpleNamespace(client=lambda *_a, **_k: sts)


@dataclass
class FakeSts:
    accepts_unattributed: bool = False
    assumed: list[dict[str, Any]] = field(default_factory=list)

    def assume_role(self, **kwargs: Any) -> dict[str, Any]:
        self.assumed.append(kwargs)
        if not self.accepts_unattributed:
            raise _error("AccessDenied")
        return {"Credentials": {}}


@dataclass
class FakeDynamo:
    items: list[dict[str, Any]] = field(default_factory=list)

    def put_item(self, **kwargs: Any) -> None:
        self.items.append(kwargs)


def _check(
    sessions: FakeSessions, sts: FakeSts | None = None, remaining: int = 600_000
) -> health.HealthCheck:
    return health.HealthCheck(
        SETTINGS,
        sessions,
        sts or FakeSts(),
        remaining_ms=lambda: remaining,  # type: ignore[arg-type]
    )


def _run(sessions: FakeSessions, **kwargs: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    db = FakeDynamo()
    summary = health.handle(_check(sessions, **kwargs), db, "Mango-poc-Settings", "poc", NOW)  # type: ignore[arg-type]
    (put,) = db.items
    return summary, put


def test_every_account_ends_valid_invalid_or_pending() -> None:
    sessions = FakeSessions(FakeOrg([OK, REFUSES, ELSEWHERE, FLAKY]))
    summary, put = _run(sessions)
    assert put["TableName"] == "Mango-poc-Settings"
    item = put["Item"]
    assert (item["PK"], item["SK"]) == ({"S": "ACCOUNT_HEALTH"}, {"S": "MEMBER"})
    assert item["checked_at"] == {"S": "2026-10-16T06:30:00+00:00"}
    assert item["identity_required"] == {"BOOL": True}
    accounts = {a["id"]: a for a in json.loads(item["accounts"]["S"])}
    assert {k: (a["status"], a.get("reason")) for k, a in accounts.items()} == {
        OK: ("valid", None),
        REFUSES: ("invalid", "role_refused"),
        ELSEWHERE: ("invalid", "unexpected_account"),
        FLAKY: ("pending", "unavailable"),
    }
    assert summary == {
        "valid": 1,
        "invalid": 2,
        "pending": 1,
        "total": 4,
        "identity_required": True,
    }


def test_it_enters_only_as_the_system_identity_and_reads_nothing() -> None:
    """D84: SourceIdentity `mango-health`; each member session can only say where it is."""
    sessions = FakeSessions(FakeOrg([OK]))
    _run(sessions)
    assert {identity for _, identity, _ in sessions.calls} == {"mango-health"}
    listing = next(detail for kind, _, detail in sessions.calls if kind == "assume")
    assert listing[1]["Statement"][0]["Action"] == sorted(handler.MEMBER_ACCOUNTS_ACTIONS)
    _, _, (_, tags) = next(c for c in sessions.calls if c[0] == "broker")
    assert tags == {"mango_user": "mango-health", "mango_agent": "account-health"}
    for kind, _, detail in sessions.calls:
        if kind == "target":
            assert detail[1]["Statement"] == [
                {"Effect": "Allow", "Action": ["sts:GetCallerIdentity"], "Resource": ["*"]}
            ]


def test_a_broker_that_refuses_makes_every_account_invalid() -> None:
    sessions = FakeSessions(FakeOrg([OK, REFUSES]), broker_error="AccessDenied")
    summary, put = _run(sessions)
    statuses = {a["status"] + "/" + a["reason"] for a in json.loads(put["Item"]["accounts"]["S"])}
    assert statuses == {"invalid/broker_refused"}
    assert summary["invalid"] == 2
    assert [kind for kind, _, _ in sessions.calls].count("target") == 0


@pytest.mark.parametrize("failure", ["list", "broker"])
def test_a_run_that_cannot_list_or_reach_the_broker_writes_nothing(failure: str) -> None:
    """The invocation fails, Lambda retries it and then the dead-letter queue alarms."""
    sessions = FakeSessions(
        FakeOrg([OK]),
        list_error="AccessDenied" if failure == "list" else None,
        broker_error="ThrottlingException" if failure == "broker" else None,
    )
    db = FakeDynamo()
    with pytest.raises(ClientError):
        health.handle(_check(sessions), db, "t", "poc", NOW)  # type: ignore[arg-type]
    assert db.items == []


def test_a_broker_that_accepts_a_session_without_identity_is_reported() -> None:
    sts = FakeSts(accepts_unattributed=True)
    summary, put = _run(FakeSessions(FakeOrg([OK])), sts=sts)
    assert summary["identity_required"] is False
    assert put["Item"]["identity_required"] == {"BOOL": False}
    assert sts.assumed[0]["RoleArn"] == SETTINGS.read_broker_role_arn
    assert "SourceIdentity" not in sts.assumed[0]


def test_accounts_it_has_no_time_for_stay_pending() -> None:
    summary, put = _run(FakeSessions(FakeOrg([OK, REFUSES])), remaining=10_000)
    assert {a["reason"] for a in json.loads(put["Item"]["accounts"]["S"])} == {"not_checked"}
    assert summary["pending"] == 2


def test_more_accounts_than_one_run_checks(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(health, "MAX_HEALTH_ACCOUNTS", 1)
    accounts = [OK, "999999999999"]
    report = _check(FakeSessions(FakeOrg(accounts))).run(NOW)
    assert (len(report.accounts), report.total) == (1, 2)
    assert health.metrics_record("poc", report)["PendingAccounts"] == 1


def test_without_member_targets_it_records_no_accounts() -> None:
    sessions = FakeSessions(FakeOrg([OK]))
    check = health.HealthCheck(
        dataclasses.replace(SETTINGS, org_access_targets=()),
        sessions,
        FakeSts(),  # type: ignore[arg-type]
    )
    report = check.run(NOW)
    assert (report.accounts, report.total) == ((), 0)
    assert [kind for kind, _, _ in sessions.calls] == []


def test_metrics_and_logs_carry_counts_and_codes_only(capsys: pytest.CaptureFixture[str]) -> None:
    sessions = FakeSessions(FakeOrg([OK, REFUSES]))
    _run(sessions)
    out = capsys.readouterr().out
    record = json.loads(out.strip().splitlines()[-1])
    assert record["_aws"]["CloudWatchMetrics"][0]["Namespace"] == "Mango/AccountHealth"
    assert (record["Installation"], record["InvalidAccounts"], record["ValidAccounts"]) == (
        "poc",
        1,
        1,
    )
    assert record["IdentityNotRequired"] == 0
    assert "arn:" not in out
