import dataclasses
import json
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber

from mango_admin_probe import handler

ADMIN = "0f1e2d3c-aaaa-bbbb-cccc-111122223333"


def _denied(op: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": "AccessDenied", "Message": "arn:aws:iam::222222222222:role/x"}}, op
    )


def _org_client() -> tuple[Any, Stubber]:
    client = boto3.client(
        "organizations",
        region_name="us-east-1",
        aws_access_key_id="x",
        aws_secret_access_key="x",
    )
    return client, Stubber(client)


@dataclass
class FakeSessions:
    org: Any
    fail_broker: bool = False
    fail_target: bool = False
    calls: list[tuple[str, str, str | None]] = field(default_factory=list)

    def _session(self) -> Any:
        return SimpleNamespace(client=lambda *_a, **_k: self.org)

    def assume(self, _chain: Any, caller: Any, policy: str) -> Any:
        self.calls.append(("assume", caller.source_identity, policy))
        return self._session()

    def assume_broker(self, _chain: Any, caller: Any) -> Any:
        self.calls.append(("broker", caller.source_identity, None))
        if self.fail_broker:
            raise _denied("AssumeRole")
        return "broker-sts"

    def assume_target(self, broker: Any, _chain: Any, caller: Any, policy: str) -> Any:
        assert broker == "broker-sts"
        self.calls.append(("target", caller.source_identity, policy))
        if self.fail_target:
            raise _denied("AssumeRole")
        return self._session()


SETTINGS = handler.Settings(
    broker_role_arn="arn:aws:iam::111111111111:role/Mango-poc-BillingBroker",
    reader_role_arn="arn:aws:iam::222222222222:role/Mango-poc-BillingReader",
    read_broker_role_arn="arn:aws:iam::111111111111:role/Mango-poc-ReadBroker",
    member_read_role_name="Mango-poc-ReadOnly",
)
MEMBER = "333333333333"


@dataclass
class FakeSts:
    """STS as the probe role (broker assume) and as the member session (caller identity)."""

    account: str = MEMBER
    accepts_unattributed: bool = False
    error_code: str = "AccessDenied"
    assumed: list[dict[str, Any]] = field(default_factory=list)

    def assume_role(self, **kwargs: Any) -> dict[str, Any]:
        self.assumed.append(kwargs)
        if not self.accepts_unattributed:
            raise ClientError({"Error": {"Code": self.error_code, "Message": "x"}}, "AssumeRole")
        return {"Credentials": {}}

    def get_caller_identity(self) -> dict[str, str]:
        return {"Account": self.account}


def _runtime(sessions: FakeSessions, sts: FakeSts | None = None) -> Any:
    return SimpleNamespace(sessions=sessions, chain=None, settings=SETTINGS, sts=sts or FakeSts())


def test_organization_lists_ous_with_name_paths_as_the_admin() -> None:
    org, stub = _org_client()
    stub.add_response("list_roots", {"Roots": [{"Id": "r-abcd", "Name": "Root"}]})
    stub.add_response(
        "list_organizational_units_for_parent",
        {"OrganizationalUnits": [{"Id": "ou-abcd-11111111", "Name": "Workloads"}]},
        {"ParentId": "r-abcd"},
    )
    stub.add_response(
        "list_organizational_units_for_parent",
        {"OrganizationalUnits": [{"Id": "ou-abcd-22222222", "Name": "<b>Prod</b>"}]},
        {"ParentId": "ou-abcd-11111111"},
    )
    stub.add_response(
        "list_organizational_units_for_parent",
        {"OrganizationalUnits": []},
        {"ParentId": "ou-abcd-22222222"},
    )
    sessions = FakeSessions(org)
    with stub:
        result = handler.handle({"operation": "organization", "actor": ADMIN}, _runtime(sessions))
    assert result == {
        "ous": [
            {
                "id": "ou-abcd-11111111",
                "name": "Workloads",
                "parent_id": "r-abcd",
                "path": ["Workloads"],
            },
            {
                "id": "ou-abcd-22222222",
                "name": "<b>Prod</b>",
                "parent_id": "ou-abcd-11111111",
                "path": ["Workloads", "<b>Prod</b>"],
            },
        ]
    }
    kind, identity, policy = sessions.calls[0]
    assert (kind, identity) == ("assume", ADMIN)
    assert json.loads(policy or "")["Statement"][0]["Action"] == [
        "organizations:ListOrganizationalUnitsForParent",
        "organizations:ListRoots",
    ]


def test_connectivity_reports_every_check() -> None:
    org, stub = _org_client()
    stub.add_response("list_roots", {"Roots": [{"Id": "r-abcd"}]})
    sessions = FakeSessions(org)
    with stub:
        result = handler.handle({"operation": "connectivity", "actor": ADMIN}, _runtime(sessions))
    assert [(c["name"], c["status"]) for c in result["checks"]] == [
        ("broker", "ok"),
        ("billing_reader", "ok"),
        ("organizations", "ok"),
    ]
    assert [c[1] for c in sessions.calls] == [ADMIN, ADMIN]
    assert json.loads(sessions.calls[1][2] or "")["Statement"][0]["Action"] == [
        "organizations:ListRoots"
    ]


def test_connectivity_failure_is_short_and_non_sensitive() -> None:
    org, _ = _org_client()
    sessions = FakeSessions(org, fail_target=True)
    result = handler.handle({"operation": "connectivity", "actor": ADMIN}, _runtime(sessions))
    assert result["checks"] == [
        {"name": "broker", "status": "ok", "detail": "ok"},
        {"name": "billing_reader", "status": "error", "detail": "access denied"},
        {"name": "organizations", "status": "error", "detail": "skipped"},
    ]
    assert "arn:" not in json.dumps(result)


def test_connectivity_stops_when_broker_fails() -> None:
    org, _ = _org_client()
    sessions = FakeSessions(org, fail_broker=True)
    result = handler.handle({"operation": "connectivity", "actor": ADMIN}, _runtime(sessions))
    assert [c["status"] for c in result["checks"]] == ["error", "error", "error"]
    assert len(sessions.calls) == 1


def test_organization_failure_is_generic() -> None:
    org, stub = _org_client()
    stub.add_client_error("list_roots", "AccessDeniedException", "secret detail arn:aws:x")
    with stub:
        result = handler.handle(
            {"operation": "organization", "actor": ADMIN}, _runtime(FakeSessions(org))
        )
    assert result == {"error": {"code": "upstream_error"}}


@pytest.mark.parametrize(
    "event",
    [
        None,
        [],
        {"operation": "delete_everything", "actor": ADMIN},
        {"operation": "organization"},
        {"operation": "organization", "actor": "a b c"},
        {"operation": "organization", "actor": "x" * 80},
    ],
)
def test_rejects_invalid_requests_without_aws_calls(event: Any) -> None:
    org, _ = _org_client()
    sessions = FakeSessions(org)
    assert handler.handle(event, _runtime(sessions)) == {"error": {"code": "invalid_request"}}
    assert sessions.calls == []


def _member(sts: FakeSts, **sessions: Any) -> tuple[dict[str, Any], FakeSessions]:
    fake = FakeSessions(sts, **sessions)
    event = {"operation": "member_access", "actor": ADMIN, "account_id": MEMBER}
    return handler.handle(event, _runtime(fake, sts)), fake


def test_member_access_checks_the_chain_as_the_admin_with_a_minimal_session() -> None:
    sts = FakeSts()
    result, sessions = _member(sts)
    assert result["checks"] == [
        {"name": "read_broker", "status": "ok", "detail": "ok"},
        {"name": "member_role", "status": "ok", "detail": "ok"},
        {"name": "account", "status": "ok", "detail": "session in the account"},
        {
            "name": "source_identity_required",
            "status": "ok",
            "detail": "refused without source identity",
        },
    ]
    assert [(kind, identity) for kind, identity, _ in sessions.calls] == [
        ("broker", ADMIN),
        ("target", ADMIN),
    ]
    assert json.loads(sessions.calls[1][2] or "")["Statement"][0]["Action"] == [
        "sts:GetCallerIdentity"
    ]
    # The refusal is asked of the Read broker itself, with no identity and no tags.
    assert sts.assumed == [
        {
            "RoleArn": SETTINGS.read_broker_role_arn,
            "RoleSessionName": "mango-probe-unattributed",
            "DurationSeconds": 900,
        }
    ]


def test_member_chain_targets_the_shared_role_name_in_the_given_account() -> None:
    chain = SETTINGS.member_chain(MEMBER)
    assert chain.broker_role_arn == SETTINGS.read_broker_role_arn
    assert chain.target_role_arn == f"arn:aws:iam::{MEMBER}:role/Mango-poc-ReadOnly"


def test_member_access_fails_when_the_broker_accepts_a_session_without_a_person() -> None:
    result, _ = _member(FakeSts(accepts_unattributed=True))
    assert result["checks"][-1] == {
        "name": "source_identity_required",
        "status": "error",
        "detail": "accepted without source identity",
    }


def test_member_access_does_not_take_another_error_for_a_refusal() -> None:
    result, _ = _member(FakeSts(error_code="Throttling"))
    assert result["checks"][-1] == {
        "name": "source_identity_required",
        "status": "error",
        "detail": "unavailable",
    }


def test_member_access_reports_a_session_in_another_account() -> None:
    result, _ = _member(FakeSts(account="444444444444"))
    assert result["checks"][2] == {
        "name": "account",
        "status": "error",
        "detail": "unexpected account",
    }


def test_member_access_without_the_role_still_checks_the_broker_refusal() -> None:
    result, _ = _member(FakeSts(), fail_target=True)
    assert [(c["name"], c["status"], c["detail"]) for c in result["checks"]] == [
        ("read_broker", "ok", "ok"),
        ("member_role", "error", "access denied"),
        ("account", "error", "skipped"),
        ("source_identity_required", "ok", "refused without source identity"),
    ]
    assert "arn:" not in json.dumps(result)
    assert MEMBER not in json.dumps(result)


@pytest.mark.parametrize(
    "account_id", [None, 333333333333, "", "33333333333", "3333333333333", "33333333333a", "*"]
)
def test_member_access_rejects_an_invalid_account_without_aws_calls(account_id: Any) -> None:
    sts = FakeSts()
    sessions = FakeSessions(sts)
    event = {"operation": "member_access", "actor": ADMIN, "account_id": account_id}
    assert handler.handle(event, _runtime(sessions, sts)) == {"error": {"code": "invalid_request"}}
    assert sessions.calls == []
    assert sts.assumed == []


# --- member_accounts ------------------------------------------------------------------------

OU_PROD = "ou-abcd-11111111"
OU_DATA = "ou-abcd-22222222"
MANAGEMENT = "222222222222"
MANGO = "111111111111"


def _targeting(*targets: str, excluded: frozenset[str] = frozenset()) -> Any:
    return dataclasses.replace(SETTINGS, org_access_targets=targets, org_access_excluded=excluded)


def _accounts(*accounts: tuple[str, str, str]) -> dict[str, Any]:
    return {"Accounts": [{"Id": i, "Name": name, "State": state} for i, name, state in accounts]}


def _member_accounts(org: Any, settings: Any) -> tuple[dict[str, Any], FakeSessions]:
    sessions = FakeSessions(org)
    runtime = SimpleNamespace(sessions=sessions, chain=None, settings=settings, sts=FakeSts())
    return handler.handle({"operation": "member_accounts", "actor": ADMIN}, runtime), sessions


def test_member_accounts_walks_the_target_ous_as_the_admin_with_a_minimal_session() -> None:
    org, stub = _org_client()
    stub.add_response(
        "list_accounts",
        _accounts(
            ("333333333333", "prod-main", "ACTIVE"),
            ("444444444444", "<b>data</b>", "ACTIVE"),
            ("555555555555", "closed", "SUSPENDED"),
            ("666666666666", "excluded", "ACTIVE"),
            ("777777777777", "elsewhere", "ACTIVE"),
            (MANGO, "mango", "ACTIVE"),
        ),
    )
    stub.add_response(
        "list_children",
        {"Children": [{"Id": i, "Type": "ACCOUNT"} for i in ("333333333333", "555555555555")]},
        {"ParentId": OU_PROD, "ChildType": "ACCOUNT"},
    )
    stub.add_response(
        "list_organizational_units_for_parent",
        {"OrganizationalUnits": [{"Id": OU_DATA, "Name": "Data"}]},
        {"ParentId": OU_PROD},
    )
    stub.add_response(
        "list_children",
        {
            "Children": [
                {"Id": i, "Type": "ACCOUNT"} for i in ("444444444444", "666666666666", MANGO)
            ]
        },
        {"ParentId": OU_DATA, "ChildType": "ACCOUNT"},
    )
    stub.add_response(
        "list_organizational_units_for_parent", {"OrganizationalUnits": []}, {"ParentId": OU_DATA}
    )
    with stub:
        result, sessions = _member_accounts(
            org, _targeting(OU_PROD, excluded=frozenset({"666666666666"}))
        )
    # Suspended, excluded and Mango's own account are left out; names are data, as they came.
    assert result == {
        "accounts": [
            {"id": "444444444444", "name": "<b>data</b>"},
            {"id": "333333333333", "name": "prod-main"},
        ],
        "truncated": False,
        "total": 2,
    }
    [(kind, actor, policy)] = sessions.calls
    assert (kind, actor) == ("assume", ADMIN)
    assert json.loads(policy or "")["Statement"][0]["Action"] == [
        "organizations:ListAccounts",
        "organizations:ListChildren",
        "organizations:ListOrganizationalUnitsForParent",
    ]


def test_member_accounts_of_the_root_are_every_active_member_account() -> None:
    org, stub = _org_client()
    stub.add_response(
        "list_accounts",
        _accounts(
            ("333333333333", "b", "ACTIVE"),
            ("444444444444", "A", "ACTIVE"),
            (MANAGEMENT, "management", "ACTIVE"),
            (MANGO, "mango", "ACTIVE"),
        ),
    )
    with stub:
        result, _ = _member_accounts(org, _targeting("r-abcd"))
    assert [a["id"] for a in result["accounts"]] == ["444444444444", "333333333333"]


def test_member_accounts_are_capped_and_say_so() -> None:
    org, stub = _org_client()
    stub.add_response(
        "list_accounts",
        _accounts(*((f"{300000000000 + n}", f"account-{n:03}", "ACTIVE") for n in range(60))),
    )
    with stub:
        result, _ = _member_accounts(org, _targeting("r-abcd"))
    assert len(result["accounts"]) == handler.MAX_MEMBER_ACCOUNTS
    assert result["truncated"] is True
    # The count of all the target accounts, so the screen can say how many were left out.
    assert result["total"] == 60


def test_member_accounts_without_targets_makes_no_aws_call() -> None:
    result, sessions = _member_accounts(None, SETTINGS)
    assert result == {"accounts": [], "truncated": False, "total": 0}
    assert sessions.calls == []


def test_member_accounts_failure_is_generic() -> None:
    org, stub = _org_client()
    stub.add_client_error("list_accounts", "AccessDeniedException", "arn:aws:iam::2:role/x")
    with stub:
        result, _ = _member_accounts(org, _targeting("r-abcd"))
    assert result == {"error": {"code": "upstream_error"}}


def test_settings_read_the_targets_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for key, value in {
        "BILLING_BROKER_ROLE_ARN": SETTINGS.broker_role_arn,
        "BILLING_READER_ROLE_ARN": SETTINGS.reader_role_arn,
        "READ_BROKER_ROLE_ARN": SETTINGS.read_broker_role_arn,
        "MEMBER_READ_ROLE_NAME": SETTINGS.member_read_role_name,
        "ORG_ACCESS_TARGETS": f"{OU_PROD},{OU_DATA}",
        "ORG_ACCESS_EXCLUDED_ACCOUNT_IDS": "",
    }.items():
        monkeypatch.setenv(key, value)
    settings = handler.Settings.from_env()
    assert settings.org_access_targets == (OU_PROD, OU_DATA)
    assert settings.never_member_accounts() == {MANAGEMENT, MANGO}
