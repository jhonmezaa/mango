"""MFA reset with dual approval (D20, TM-L14) against moto DynamoDB and a fake Cognito."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import boto3
import pytest
from botocore.stub import Stubber
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api.budget import BudgetService
from mango_api.mfa_reset import (
    CognitoUnavailableError,
    CognitoUsers,
    DirectoryUser,
    ResetStore,
    UserNotFoundError,
)
from mango_api.settings_store import BudgetLimits, SettingsStore
from mango_api.web_session import WebSessionDeps

from .test_admin import (
    TOKENS,
    CedarLikeAuthorizer,
    FakeProbe,
    FakeVerifier,
    RecordingAudit,
    _code,
    _h,
    _table,
)
from .test_app import (
    HOST,
    FakeAgentCore,
    FakeBedrock,
    FakeConversations,
    FakeModelCatalog,
    FakePublished,
    _settings,
)

# admin-1 and admin-2 are admins; user-1 is not. Emails for the self checks.
TOKENS.setdefault("admin-mail", {**TOKENS["admin"], "mango_email": "admin1@example.com"})

DIRECTORY = {
    "target@example.com": DirectoryUser("uuid-target", "target-sub", "target@example.com", False),
    "admin1@example.com": DirectoryUser("uuid-admin-1", "admin-1", "admin1@example.com", False),
    "admin2@example.com": DirectoryUser("uuid-admin-2", "admin-2", "admin2@example.com", False),
    "sso@example.com": DirectoryUser("idp_sso", "sso-sub", "sso@example.com", True),
}


@dataclass
class FakeCognito:
    resets: list[str] = field(default_factory=list)
    fail_reset: bool = False

    def lookup(self, email: str) -> DirectoryUser:
        if email not in DIRECTORY:
            raise UserNotFoundError
        return DIRECTORY[email]

    def reset_mfa(self, username: str) -> None:
        if self.fail_reset:
            raise CognitoUnavailableError
        self.resets.append(username)

    # The web sessions table, as far as a reset uses it (D63).
    ended: list[tuple[str, str]] = field(default_factory=list)

    def revoke_user(self, sub: str, _now: int, cause: str) -> None:
        self.ended.append((sub, cause))


@dataclass
class Env:
    client: TestClient
    audit: RecordingAudit
    authorizer: CedarLikeAuthorizer
    cognito: FakeCognito
    clock: list[datetime]


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    clock = [datetime(2026, 9, 30, 12, tzinfo=UTC)]
    monkeypatch.setattr(app_module, "now_utc", lambda: clock[0])
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "settings")
        store = SettingsStore(db, "settings", Decimal(5), Decimal(30))
        audit, authorizer, cognito = RecordingAudit(), CedarLikeAuthorizer(), FakeCognito()

        def factory(s: Any) -> app_module.Services:
            return app_module.Services(
                settings=s,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=authorizer,  # type: ignore[arg-type]
                budgets=BudgetService(db, "settings"),
                conversations=FakeConversations(),  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=FakeAgentCore(),
                bedrock=FakeBedrock(),
                settings_store=store,
                budget_limits=BudgetLimits(store),
                probe=FakeProbe(),  # type: ignore[arg-type]
                published=FakePublished(),  # type: ignore[arg-type]
                model_catalog=FakeModelCatalog(),  # type: ignore[arg-type]
                invocation_key=b"k" * 32,
                cognito_users=cognito,  # type: ignore[arg-type]
                mfa_reset_store=ResetStore(db, "settings"),
                web_sessions=WebSessionDeps(
                    store=cognito,  # type: ignore[arg-type]
                    cipher=None,  # type: ignore[arg-type]
                    tokens=None,  # type: ignore[arg-type]
                    verifier=None,  # type: ignore[arg-type]
                    audit=audit,  # type: ignore[arg-type]
                    clock=lambda: clock[0],
                    app_origin="https://app.example.com",
                    session_seconds=8 * 3600,
                ),
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(client, audit, authorizer, cognito, clock)


BASE = "/api/admin/mfa-resets"


def _propose(env: Env, token: str = "admin", email: str = "target@example.com") -> Any:
    return env.client.post(
        BASE,
        headers=_h(token),
        json={"email": email, "reason": "Lost phone; verified by call", "identity_verified": True},
    )


def _pending_id(env: Env, token: str = "admin") -> str:
    response = _propose(env, token)
    assert response.status_code == 201, response.json()
    return str(response.json()["change_id"])


ENDPOINTS: list[tuple[str, str, dict[str, Any] | None, str]] = [
    ("GET", BASE, None, "ViewAdmin"),
    (
        "POST",
        BASE,
        {"email": "target@example.com", "reason": "x", "identity_verified": True},
        "ProposeMfaReset",
    ),
    ("POST", f"{BASE}/{'a' * 32}/approve", {}, "ApproveMfaReset"),
    ("POST", f"{BASE}/{'a' * 32}/reject", {"reason": "no"}, "ApproveMfaReset"),
    ("POST", f"{BASE}/{'a' * 32}/withdraw", {}, "ProposeMfaReset"),
]


@pytest.mark.parametrize(("method", "path", "body", "action"), ENDPOINTS)
def test_every_endpoint_requires_its_admin_action(
    env: Env, method: str, path: str, body: dict[str, Any] | None, action: str
) -> None:
    assert env.client.request(method, path, json=body).status_code == 401
    response = env.client.request(method, path, json=body, headers=_h("user"))
    assert response.status_code == 403
    assert env.authorizer.decisions == [("user-1", action, False)]
    assert [e for e, _, _ in env.audit.events] == ["policy.decision"]
    assert env.cognito.resets == []


def test_dual_approval_resets_mfa_and_signs_out(env: Env) -> None:
    change_id = _pending_id(env)
    listed = env.client.get(BASE, headers=_h("admin2")).json()["items"]
    assert [(i["change_id"], i["status"], i["target_email"]) for i in listed] == [
        (change_id, "pending", "target@example.com")
    ]
    assert env.cognito.resets == []

    response = env.client.post(f"{BASE}/{change_id}/approve", headers=_h("admin2"), json={})
    assert response.status_code == 200
    item = response.json()["items"][0]
    assert (item["status"], item["decided_by"]) == ("approved", "admin-2")
    # Cognito is called with the username returned by AdminGetUser, never the typed email.
    assert env.cognito.resets == ["uuid-target"]
    # The web sessions of the person end too (D63), by user id.
    assert env.cognito.ended == [(DIRECTORY["target@example.com"].sub, "mfa_reset")]
    applied = env.audit.named("account.mfa_reset")
    assert applied == [
        (
            "admin-2",
            {
                "change_id": change_id,
                "target_user": "target-sub",
                "target_email": "target@example.com",
                "proposed_by": "admin-1",
                "identity_verified": True,
                "approved_by": "admin-2",
                "sessions_revoked": True,
                "outcome": "applied",
            },
        )
    ]
    assert [d["outcome"] for _, d in env.audit.named("account.mfa_reset_approve", None)] == [
        "requested",
        "applied",
    ]
    # A closed request cannot be approved again.
    again = env.client.post(f"{BASE}/{change_id}/approve", headers=_h("admin2"), json={})
    assert (again.status_code, _code(again)) == (409, "version_conflict")
    assert env.cognito.resets == ["uuid-target"]


def test_proposer_cannot_approve_and_the_refusal_is_audited(env: Env) -> None:
    change_id = _pending_id(env)
    response = env.client.post(f"{BASE}/{change_id}/approve", headers=_h("admin"), json={})
    assert (response.status_code, _code(response)) == (403, "same_approver")
    refused = env.audit.named("account.mfa_reset_approve", "rejected")
    assert refused
    assert refused[0][1]["error"] == "same_approver"
    assert env.cognito.resets == []


@pytest.mark.parametrize("email", ["admin1@example.com", "ADMIN1@example.com "])
def test_nobody_resets_their_own_mfa(env: Env, email: str) -> None:
    response = _propose(env, "admin-mail", email)
    assert (response.status_code, _code(response)) == (403, "self_reset")
    assert env.audit.named("account.mfa_reset_propose", "rejected")[0][1]["error"] == "self_reset"


def test_self_check_uses_the_sub_even_without_an_email_claim(env: Env) -> None:
    # The "admin" token has no email claim; the directory lookup still maps to sub admin-1.
    response = _propose(env, "admin", "admin1@example.com")
    assert (response.status_code, _code(response)) == (403, "self_reset")


def test_target_cannot_decide_on_a_request_about_themselves(env: Env) -> None:
    response = _propose(env, "admin", "admin2@example.com")
    change_id = response.json()["change_id"]
    for action, body in (("approve", {}), ("reject", {"reason": "no"})):
        decided = env.client.post(f"{BASE}/{change_id}/{action}", headers=_h("admin2"), json=body)
        assert (decided.status_code, _code(decided)) == (403, "self_reset")
    assert env.cognito.resets == []


def test_one_open_request_per_user_and_cooldown_after_a_reset(env: Env) -> None:
    change_id = _pending_id(env)
    duplicate = _propose(env, "admin2")
    assert (duplicate.status_code, _code(duplicate)) == (409, "already_pending")
    env.client.post(f"{BASE}/{change_id}/approve", headers=_h("admin2"), json={})
    cooldown = _propose(env, "admin2")
    assert (cooldown.status_code, _code(cooldown)) == (429, "rate_limited")
    # What is left of the 24 hours since the reset, in whole seconds.
    assert cooldown.headers["Retry-After"] == str(24 * 3600)
    env.clock[0] += timedelta(hours=1, seconds=30, milliseconds=500)
    assert _propose(env, "admin2").headers["Retry-After"] == str(23 * 3600 - 30)
    env.clock[0] += timedelta(hours=24)
    assert _propose(env, "admin2").status_code == 201


def test_proposals_are_rate_limited_per_admin(env: Env) -> None:
    for _ in range(5):
        _propose(env, "admin", "nobody@example.com")
    response = _propose(env, "admin")
    assert (response.status_code, _code(response)) == (429, "rate_limited")
    # Like every other limit: how long until the oldest proposal leaves the hour.
    assert 1 <= int(response.headers["Retry-After"]) <= 3600


def test_unknown_and_federated_users(env: Env) -> None:
    missing = _propose(env, "admin", "nobody@example.com")
    assert (missing.status_code, _code(missing)) == (404, "user_not_found")
    federated = _propose(env, "admin", "sso@example.com")
    assert (federated.status_code, _code(federated)) == (422, "federated_user")


def test_requests_expire_after_72_hours(env: Env) -> None:
    _pending_id(env)
    env.clock[0] += timedelta(hours=71)
    item = env.client.get(BASE, headers=_h("admin")).json()["items"][0]
    assert item["status"] == "pending"
    created = datetime.fromisoformat(item["created_at"])
    assert datetime.fromisoformat(item["expires_at"]) - created == timedelta(hours=72)
    duplicate = _propose(env, "admin2")
    assert (duplicate.status_code, _code(duplicate)) == (409, "already_pending")


def test_expired_request_cannot_be_approved_and_no_longer_blocks(env: Env) -> None:
    change_id = _pending_id(env)
    env.clock[0] += timedelta(hours=73)
    assert env.client.get(BASE, headers=_h("admin")).json()["items"][0]["status"] == "expired"
    response = env.client.post(f"{BASE}/{change_id}/approve", headers=_h("admin2"), json={})
    assert (response.status_code, _code(response)) == (410, "expired")
    assert _propose(env, "admin2").status_code == 201
    # The expired request can still be withdrawn without touching the new one's lock.
    withdrawn = env.client.post(f"{BASE}/{change_id}/withdraw", headers=_h("admin"), json={})
    assert withdrawn.status_code == 200
    duplicate = _propose(env, "admin")
    assert (duplicate.status_code, _code(duplicate)) == (409, "already_pending")


def test_reject_and_withdraw(env: Env) -> None:
    change_id = _pending_id(env)
    own = env.client.post(f"{BASE}/{change_id}/reject", headers=_h("admin"), json={"reason": "x"})
    assert (own.status_code, _code(own)) == (403, "same_approver")
    other = env.client.post(f"{BASE}/{change_id}/withdraw", headers=_h("admin2"), json={})
    assert other.status_code == 403
    rejected = env.client.post(
        f"{BASE}/{change_id}/reject", headers=_h("admin2"), json={"reason": "No verificado"}
    )
    item = rejected.json()["items"][0]
    assert (item["status"], item["note"], item["decided_by"]) == (
        "rejected",
        "No verificado",
        "admin-2",
    )

    second = _pending_id(env)
    withdrawn = env.client.post(f"{BASE}/{second}/withdraw", headers=_h("admin"), json={})
    statuses = {i["change_id"]: i["status"] for i in withdrawn.json()["items"]}
    assert statuses == {change_id: "rejected", second: "withdrawn"}
    assert env.audit.named("account.mfa_reset_withdraw")
    assert env.cognito.resets == []


def test_identity_verification_is_stored_and_audited(env: Env) -> None:
    change_id = _pending_id(env)
    item = env.client.get(BASE, headers=_h("admin")).json()["items"][0]
    assert item["identity_verified"] is True
    proposed = env.audit.named("account.mfa_reset_propose", "applied")[0][1]
    assert proposed["identity_verified"] is True
    env.client.post(f"{BASE}/{change_id}/approve", headers=_h("admin2"), json={})
    approved = env.audit.named("account.mfa_reset_approve", "applied")[0][1]
    assert approved["identity_verified"] is True


def test_audit_unavailable_blocks_the_reset(env: Env) -> None:
    change_id = _pending_id(env)
    env.audit.fail_outcomes.add("requested")
    response = env.client.post(f"{BASE}/{change_id}/approve", headers=_h("admin2"), json={})
    assert (response.status_code, _code(response)) == (503, "audit_unavailable")
    assert env.cognito.resets == []


def test_cognito_failure_keeps_the_request_pending(env: Env) -> None:
    change_id = _pending_id(env)
    env.cognito.fail_reset = True
    response = env.client.post(f"{BASE}/{change_id}/approve", headers=_h("admin2"), json={})
    assert (response.status_code, _code(response)) == (502, "upstream_error")
    assert env.audit.named("account.mfa_reset_approve", "rejected")[0][1]["error"] == (
        "upstream_error"
    )
    assert env.audit.named("account.mfa_reset") == []
    env.cognito.fail_reset = False
    retried = env.client.post(f"{BASE}/{change_id}/approve", headers=_h("admin2"), json={})
    assert retried.status_code == 200


@pytest.mark.parametrize(
    "body",
    [
        {"email": "target@example.com"},
        {"email": "target@example.com", "reason": ""},
        {"email": "not-an-email", "reason": "x"},
        {"email": "target@example.com", "reason": "x", "identity_verified": True, "user_id": "a"},
        # D20: the out-of-band identity check is declared explicitly, never implied.
        {"email": "target@example.com", "reason": "x"},
        {"email": "target@example.com", "reason": "x", "identity_verified": False},
        {"email": "target@example.com", "reason": "x", "identity_verified": "true"},
        {"email": "target@example.com", "reason": "x", "identity_verified": 1},
    ],
)
def test_proposal_body_is_strict(env: Env, body: dict[str, Any]) -> None:
    assert env.client.post(BASE, headers=_h("admin"), json=body).status_code == 422


# --- Cognito wrapper ---------------------------------------------------------------------


def test_cognito_wrapper_calls_only_the_configured_pool() -> None:
    client = boto3.client(
        "cognito-idp", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x"
    )
    users = CognitoUsers(client, "us-east-1_Pool")
    with Stubber(client) as stub:
        stub.add_response(
            "admin_get_user",
            {
                "Username": "uuid-1",
                "UserAttributes": [
                    {"Name": "sub", "Value": "sub-1"},
                    {"Name": "email", "Value": "a@example.com"},
                ],
                "UserStatus": "CONFIRMED",
            },
            {"UserPoolId": "us-east-1_Pool", "Username": "a@example.com"},
        )
        # AdminSetUserMFAPreference is not enough: it keeps the registered TOTP (lab finding).
        stub.add_response(
            "admin_delete_software_token",
            {},
            {"UserPoolId": "us-east-1_Pool", "Username": "uuid-1"},
        )
        stub.add_response(
            "admin_user_global_sign_out", {}, {"UserPoolId": "us-east-1_Pool", "Username": "uuid-1"}
        )
        user = users.lookup("a@example.com")
        assert user == DirectoryUser("uuid-1", "sub-1", "a@example.com", False)
        users.reset_mfa(user.username)
        stub.add_client_error("admin_get_user", "UserNotFoundException")
        with pytest.raises(UserNotFoundError):
            users.lookup("b@example.com")
        stub.add_client_error("admin_delete_software_token", "InternalErrorException")
        with pytest.raises(CognitoUnavailableError):
            users.reset_mfa("uuid-1")
        # No TOTP registered (never enrolled, or a retry): still revoke the sessions.
        stub.add_client_error("admin_delete_software_token", "ResourceNotFoundException")
        stub.add_response(
            "admin_user_global_sign_out", {}, {"UserPoolId": "us-east-1_Pool", "Username": "uuid-1"}
        )
        users.reset_mfa("uuid-1")
        # Token deleted but sign-out failed: the request stays pending and can be retried.
        stub.add_response(
            "admin_delete_software_token",
            {},
            {"UserPoolId": "us-east-1_Pool", "Username": "uuid-1"},
        )
        stub.add_client_error("admin_user_global_sign_out", "InternalErrorException")
        with pytest.raises(CognitoUnavailableError):
            users.reset_mfa("uuid-1")
        stub.assert_no_pending_responses()
