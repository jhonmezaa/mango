"""Directory lookups to share agents (TM-M24): real Cedar policies, moto DynamoDB, fake Cognito."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api.authz import Authorizer
from mango_api.directory import (
    EMAILS_PER_DAY,
    IDS_PER_MINUTE,
    MAX_EMAILS_PER_CALL,
    MAX_IDS_PER_CALL,
    CognitoDirectory,
    DirectoryUnavailableError,
    LookupQuota,
    QuotaExceededError,
)
from mango_api.limits import Limits
from mango_api.probe import RateLimiter

from .cedar_fake import CedarPolicyStore
from .test_admin import RecordingAudit, _table
from .test_agents_api import TOKENS, FakeVerifier, _code, _h
from .test_app import (
    HOST,
    FakeAgentCore,
    FakeBedrock,
    FakeBudgets,
    FakeConversations,
    FakeLimits,
    _settings,
)

URL = "/api/directory/users/resolve"
POOL = "us-east-1_pool"
PEOPLE = {"ana@example.com": "sub-ana", "luis@example.com": "sub-luis"}


@dataclass
class FakeDirectory:
    fail: bool = False
    emails: list[str] = field(default_factory=list)
    ids: list[str] = field(default_factory=list)

    def id_of(self, email: str) -> str | None:
        if self.fail:
            raise DirectoryUnavailableError
        self.emails.append(email)
        return PEOPLE.get(email)

    def email_of(self, user_id: str) -> str | None:
        if self.fail:
            raise DirectoryUnavailableError
        self.ids.append(user_id)
        return next((email for email, sub in PEOPLE.items() if sub == user_id), None)


@dataclass
class Env:
    client: TestClient
    audit: RecordingAudit
    directory: FakeDirectory
    now: list[datetime]
    limiter_clock: list[float]


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    now = [datetime(2026, 10, 2, 15, 0, tzinfo=UTC)]
    limiter_clock = [0.0]
    monkeypatch.setattr(app_module, "now_utc", lambda: now[0])
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "settings")
        audit, cedar, directory = RecordingAudit(), CedarPolicyStore(), FakeDirectory()

        def factory(s: Any) -> app_module.Services:
            return app_module.Services(
                settings=s,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=Authorizer(cedar, "ps"),  # type: ignore[arg-type]
                budgets=FakeBudgets(),  # type: ignore[arg-type]
                conversations=FakeConversations(),  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=FakeAgentCore(),
                bedrock=FakeBedrock(),
                settings_store=None,  # type: ignore[arg-type]
                budget_limits=FakeLimits(),  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=None,  # type: ignore[arg-type]
                model_catalog=None,  # type: ignore[arg-type]
                invocation_key=b"k" * 32,
                directory=directory,  # type: ignore[arg-type]
                directory_quota=LookupQuota(db, "settings"),
                limits=Limits(clock=lambda: limiter_clock[0]),
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(client, audit, directory, now, limiter_clock)
        assert cedar.errors == []


def _resolve(env: Env, token: str = "creator", **body: Any) -> Any:
    return env.client.post(URL, headers=_h(token), json=body)


def _lookups(env: Env, outcome: str = "applied") -> list[tuple[str, dict[str, Any]]]:
    return env.audit.named("directory.lookup", outcome)


# --- Authorization ----------------------------------------------------------------------


def test_requires_a_token(env: Env) -> None:
    assert env.client.post(URL, json={"emails": ["ana@example.com"]}).status_code == 401
    assert env.directory.emails == []


@pytest.mark.parametrize("token", ["member", "lead", "outsider"])
def test_only_agent_creators_and_admins_may_look_people_up(env: Env, token: str) -> None:
    response = _resolve(env, token, emails=["ana@example.com"], ids=["sub-ana"])
    assert response.status_code == 403
    assert env.directory.emails == []
    assert env.directory.ids == []
    assert _lookups(env, None) == []  # type: ignore[arg-type]
    decision = env.audit.named("policy.decision", None)[-1][1]
    assert decision["action"] == "CreateAgent"
    assert decision["allowed"] is False


@pytest.mark.parametrize("token", ["creator", "admin"])
def test_creators_and_admins_resolve_emails(env: Env, token: str) -> None:
    response = _resolve(env, token, emails=["ana@example.com", "nadie@example.com"])
    assert response.status_code == 200, response.text
    assert response.json() == {
        "users": [{"id": "sub-ana", "email": "ana@example.com"}],
        "emails_not_found": ["nadie@example.com"],
        "ids_not_found": [],
    }
    decision = env.audit.named("policy.decision", None)[-1][1]
    assert decision == {
        "action": "CreateAgent",
        "resource": "Mango::Platform::mango",
        "allowed": True,
        "read_only": True,
    }


# --- Resolution -------------------------------------------------------------------------


def test_resolves_identifiers_back_to_emails(env: Env) -> None:
    response = _resolve(env, ids=["sub-luis", "sub-gone"])
    assert response.status_code == 200
    assert response.json() == {
        "users": [{"id": "sub-luis", "email": "luis@example.com"}],
        "emails_not_found": [],
        "ids_not_found": ["sub-gone"],
    }
    assert env.directory.emails == []


def test_emails_are_normalized_and_deduplicated(env: Env) -> None:
    response = _resolve(env, emails=["  Ana@Example.com ", "ana@example.com"], ids=["sub-ana"])
    assert response.status_code == 200
    assert response.json()["users"] == [{"id": "sub-ana", "email": "ana@example.com"}]
    assert env.directory.emails == ["ana@example.com"]


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"emails": [], "ids": []},
        {"emails": ["not-an-email"]},
        {"emails": ['a"b@example.com']},
        {"emails": ["a\\b@example.com"]},
        {"emails": ["a b@example.com"]},
        {"emails": ["a@" + "x" * 254]},
        {"emails": [f"u{i}@example.com" for i in range(MAX_EMAILS_PER_CALL + 1)]},
        {"ids": [f"sub-{i}" for i in range(MAX_IDS_PER_CALL + 1)]},
        {"ids": ['sub" or email ^= "a']},
        {"ids": [""]},
        {"emails": ["ana@example.com"], "extra": True},
        {"emails": "ana@example.com"},
    ],
)
def test_rejects_invalid_bodies_without_touching_the_directory(
    env: Env, body: dict[str, Any]
) -> None:
    response = env.client.post(URL, headers=_h("creator"), json=body)
    assert response.status_code == 422
    assert _code(response) == "invalid_request"
    # Field names only: what the caller typed is never echoed.
    assert "example.com" not in response.text
    assert env.directory.emails == []
    assert env.directory.ids == []


def test_directory_failure_is_an_upstream_error(env: Env) -> None:
    env.directory.fail = True
    response = _resolve(env, emails=["ana@example.com"])
    assert response.status_code == 502
    assert _code(response) == "upstream_error"
    assert _lookups(env) == []


# --- Audit ------------------------------------------------------------------------------


def test_every_lookup_is_audited_with_counts_and_never_the_emails(
    env: Env, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="mango_api")
    response = _resolve(
        env, emails=["ana@example.com", "nadie@example.com"], ids=["sub-luis", "sub-gone"]
    )
    assert response.status_code == 200
    assert _lookups(env) == [
        (
            "creator-1",
            {
                "emails": 2,
                "ids": 2,
                "emails_found": 1,
                "ids_found": 1,
                "found_users": ["sub-ana"],
                "outcome": "applied",
            },
        )
    ]
    assert env.audit.actors[-1].user_id == "creator-1"
    logged = "".join(r.getMessage() for r in caplog.records if r.name.startswith("mango_"))
    recorded = repr(env.audit.events) + logged
    assert "example.com" not in recorded.replace("creator1@example.com", "")


def test_nothing_is_returned_when_the_lookup_cannot_be_audited(env: Env) -> None:
    env.audit.fail_outcomes.add("applied")
    response = _resolve(env, emails=["ana@example.com"])
    assert response.status_code == 503
    assert _code(response) == "audit_unavailable"
    assert "sub-ana" not in response.text


# --- Rate limits ------------------------------------------------------------------------


def _emails(start: int, count: int) -> list[str]:
    return [f"u{i}@example.com" for i in range(start, start + count)]


def test_emails_per_minute_are_limited_per_caller(env: Env) -> None:
    assert _resolve(env, emails=_emails(0, 20)).status_code == 200
    assert _resolve(env, emails=_emails(20, 10)).status_code == 200
    response = _resolve(env, emails=["ana@example.com"])
    assert response.status_code == 429
    assert _code(response) == "rate_limited"
    assert response.headers["retry-after"] == "60"
    assert "ana@example.com" not in env.directory.emails
    assert _lookups(env, "rejected")[-1][1] == {
        "emails": 1,
        "ids": 0,
        "outcome": "rejected",
        "error": "rate_limited",
    }
    # Another caller has their own allowance, and the window moves on.
    assert _resolve(env, "admin", emails=["ana@example.com"]).status_code == 200
    env.limiter_clock[0] = 61
    assert _resolve(env, emails=["ana@example.com"]).status_code == 200


def test_emails_per_day_are_limited_across_tasks(env: Env) -> None:
    for batch in range(EMAILS_PER_DAY // MAX_EMAILS_PER_CALL):
        env.limiter_clock[0] += 61
        assert _resolve(env, emails=_emails(batch * 20, 20)).status_code == 200
    env.limiter_clock[0] += 61
    response = _resolve(env, emails=["ana@example.com"])
    assert response.status_code == 429
    assert response.headers["retry-after"] == str(9 * 3600)
    assert "ana@example.com" not in env.directory.emails
    # Identifiers do not spend the daily allowance of emails.
    assert _resolve(env, ids=["sub-ana"]).status_code == 200
    env.now[0] += timedelta(hours=9)
    assert _resolve(env, emails=["ana@example.com"]).status_code == 200


def test_identifiers_per_minute_are_limited(env: Env) -> None:
    ids = [f"sub-{i}" for i in range(MAX_IDS_PER_CALL)]
    for _ in range(IDS_PER_MINUTE // MAX_IDS_PER_CALL):
        assert _resolve(env, ids=ids).status_code == 200
    response = _resolve(env, ids=["sub-ana"], emails=["ana@example.com"])
    assert response.status_code == 429
    # The refusal did not spend emails or reach the directory.
    assert env.directory.emails == []


def test_quota_counts_per_user_and_day() -> None:
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "settings")
        quota = LookupQuota(db, "settings", limit=5)
        day = datetime(2026, 10, 2, 23, 59, tzinfo=UTC)
        quota.consume("u1", 3, day)
        quota.consume("u1", 2, day)
        with pytest.raises(QuotaExceededError):
            quota.consume("u1", 1, day)
        with pytest.raises(QuotaExceededError):
            quota.consume("u2", 6, day)
        quota.consume("u2", 5, day)
        quota.consume("u1", 5, day + timedelta(minutes=1))
        item = db.get_item(
            TableName="settings",
            Key={"PK": {"S": "DIRECTORY_LOOKUPS"}, "SK": {"S": "u1#2026-10-02"}},
        )["Item"]
        assert item["emails"]["N"] == "5"
        assert int(item["ttl"]["N"]) == int((day + timedelta(days=2)).timestamp())


# --- Cognito adapter --------------------------------------------------------------------


def _cognito() -> tuple[Any, Stubber]:
    client = boto3.client(
        "cognito-idp",
        region_name="us-east-1",
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
    )
    return client, Stubber(client)


def _user(status: str = "CONFIRMED", *, enabled: bool = True) -> dict[str, Any]:
    return {
        "Username": "uuid-ana",
        "Enabled": enabled,
        "UserStatus": status,
        "UserAttributes": [
            {"Name": "sub", "Value": "sub-ana"},
            {"Name": "email", "Value": "ana@example.com"},
        ],
    }


def test_cognito_lookup_by_email_stays_on_the_pool() -> None:
    client, stub = _cognito()
    request = {"UserPoolId": POOL, "Username": "ana@example.com"}
    stub.add_response("admin_get_user", _user(), request)
    stub.add_response("admin_get_user", _user("FORCE_CHANGE_PASSWORD"), request)
    with stub:
        directory = CognitoDirectory(client, POOL)
        assert directory.id_of("ana@example.com") == "sub-ana"
        assert directory.id_of("ana@example.com") == "sub-ana"
    stub.assert_no_pending_responses()


@pytest.mark.parametrize(
    "user", [_user("UNCONFIRMED"), _user(enabled=False), {**_user(), "UserAttributes": []}]
)
def test_unconfirmed_or_disabled_users_are_not_found_by_email(user: dict[str, Any]) -> None:
    client, stub = _cognito()
    stub.add_response("admin_get_user", user)
    with stub:
        assert CognitoDirectory(client, POOL).id_of("ana@example.com") is None


@pytest.mark.parametrize("code", ["UserNotFoundException", "InvalidParameterException"])
def test_unknown_emails_are_not_found(code: str) -> None:
    client, stub = _cognito()
    stub.add_client_error("admin_get_user", service_error_code=code)
    with stub:
        assert CognitoDirectory(client, POOL).id_of("nadie@example.com") is None


def test_cognito_errors_are_not_mistaken_for_missing_users() -> None:
    client, stub = _cognito()
    stub.add_client_error("admin_get_user", service_error_code="TooManyRequestsException")
    stub.add_client_error("list_users", service_error_code="InternalErrorException")
    with stub:
        directory = CognitoDirectory(client, POOL)
        with pytest.raises(DirectoryUnavailableError):
            directory.id_of("ana@example.com")
        with pytest.raises(DirectoryUnavailableError):
            directory.email_of("sub-ana")


def test_cognito_lookup_by_identifier_asks_for_the_email_only() -> None:
    client, stub = _cognito()
    request = {
        "UserPoolId": POOL,
        "AttributesToGet": ["email"],
        "Filter": 'sub = "sub-ana"',
        "Limit": 1,
    }
    found = {"Users": [{"Username": "x", "Attributes": [{"Name": "email", "Value": "a@b.co"}]}]}
    stub.add_response("list_users", found, request)
    stub.add_response("list_users", {"Users": []}, request)
    stub.add_response("list_users", {"Users": [{"Username": "x", "Attributes": []}]}, request)
    with stub:
        directory = CognitoDirectory(client, POOL)
        assert directory.email_of("sub-ana") == "a@b.co"
        assert directory.email_of("sub-ana") is None
        assert directory.email_of("sub-ana") is None
    stub.assert_no_pending_responses()


def test_the_adapter_never_puts_anything_but_an_identifier_in_the_filter() -> None:
    client, stub = _cognito()
    with stub:
        directory = CognitoDirectory(client, POOL)
        for value in ('x" or email ^= "a', "", "a b", "x" * 65, "sub\n"):
            assert directory.email_of(value) is None
    stub.assert_no_pending_responses()


def test_the_adapter_needs_a_user_pool() -> None:
    with pytest.raises(ValueError, match="user pool"):
        CognitoDirectory(None, "")  # type: ignore[arg-type]


def test_cognito_client_errors_keep_their_cause() -> None:
    error = ClientError({"Error": {"Code": "AccessDeniedException"}}, "ListUsers")

    class Broken:
        def list_users(self, **_kwargs: Any) -> Any:
            raise error

    with pytest.raises(DirectoryUnavailableError) as raised:
        CognitoDirectory(Broken(), POOL).email_of("sub-ana")  # type: ignore[arg-type]
    assert raised.value.__cause__ is error


def test_tokens_used_here_exist() -> None:
    assert {"creator", "admin", "member", "lead", "outsider"} <= set(TOKENS)


def test_limiter_takes_weighted_hits_all_or_nothing() -> None:
    clock = [0.0]
    limiter = RateLimiter(limit=5, window_seconds=60, clock=lambda: clock[0])
    assert limiter.allow("u", 3)
    clock[0] = 10
    assert limiter.allow("u", 1)
    assert not limiter.allow("u", 2)
    # Nothing was recorded by the refusal, and two hits fit once the first three expire.
    assert limiter.retry_after("u", 2) == 50
    assert limiter.retry_after("u", 1) == 0
    assert limiter.allow("u", 1)
    assert limiter.retry_after("u") == 50
    clock[0] = 60
    assert limiter.allow("u", 3)
    assert not limiter.allow("u", 6)
    # More than the limit never fits; the answer is still bounded by the window.
    assert limiter.retry_after("u", 6) == 60
