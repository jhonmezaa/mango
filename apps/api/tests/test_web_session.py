"""Web session cookie (D63): creation, renewal, sign-out, CSRF guard and revocation."""

from __future__ import annotations

import ast
import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from fastapi.testclient import TestClient

from mango_api import app as app_module
from mango_api import web_session as web_session_module
from mango_api.probe import RateLimiter
from mango_api.settings import ModelPrice, Settings
from mango_api.web_session import (
    COOKIE_NAME,
    CognitoTokens,
    NoSessionError,
    RenewedTokens,
    Revocation,
    RevocationCause,
    SessionActor,
    SessionRecord,
    SessionRejectedError,
    SessionStore,
    SessionUnavailableError,
    TokenCipher,
    WebSessionDeps,
    renew,
)
from mango_core.identity import IdentityError

HOST = "internal-alb.example.com"
ORIGIN = "https://app.example.com"
START = datetime(2026, 10, 3, 12, 0, tzinfo=UTC)
HOURS = 8
PRICE = ModelPrice(Decimal(3), Decimal(15), Decimal("0.3"), Decimal("3.75"))
SUBS = {
    "user-1": {"mango_role": "finops-central", "mango_email": "one@example.com"},
    "user-2": {"mango_role": "finops-central"},
    "user-4": {},  # no group yet
}


def _settings() -> Settings:
    return Settings(
        namespace="test",
        region="us-east-1",
        cognito_issuer="https://cognito-idp.us-east-1.amazonaws.com/us-east-1_T",
        cognito_client_id="client",
        gateway_url="https://gw.example.com/mcp",
        agent_id="finops",
        agent_model="m",
        auxiliary_model="m",
        model_prices={"m": PRICE},
        policy_store_id="ps",
        conversations_table="conv",
        conversations_table_arn="arn:aws:dynamodb:us-east-1:111111111111:table/conv",
        data_key_arn="arn:aws:kms:us-east-1:111111111111:key/k",
        data_access_role_arn="arn:aws:iam::111111111111:role/data",
        budgets_table="budgets",
        audit_stream="audit",
        audit_index_table="audit-index",
        user_monthly_budget=Decimal(5),
        agent_monthly_budget=Decimal(30),
        allowed_hosts=frozenset({HOST}),
    )


class FakeVerifier:
    """Access tokens look like ``at:<sub>:<auth_time>``."""

    def verify(self, token: str) -> dict[str, Any]:
        parts = token.split(":")
        if len(parts) != 3 or parts[0] != "at" or parts[1] not in SUBS:
            raise IdentityError("invalid")
        return {"sub": parts[1], "auth_time": int(parts[2]), "exp": 2**31, **SUBS[parts[1]]}


@dataclass
class FakeTokens:
    """Refresh tokens look like ``rt-<sub>``; ``rejected`` and ``down`` simulate Cognito."""

    auth_time: int = int(START.timestamp())
    rejected: set[str] = field(default_factory=set)
    revoked: list[str] = field(default_factory=list)
    down: bool = False
    calls: int = 0

    def refresh(self, refresh_token: str) -> RenewedTokens:
        self.calls += 1
        if self.down:
            raise SessionUnavailableError
        sub = refresh_token.removeprefix("rt-")
        if refresh_token in self.rejected or sub not in SUBS:
            raise SessionRejectedError
        return RenewedTokens(f"at:{sub}:{self.auth_time}", f"id-{sub}", 3600)

    def revoke(self, refresh_token: str) -> None:
        self.revoked.append(refresh_token)
        self.rejected.add(refresh_token)


class FakeCipher:
    def encrypt(self, refresh_token: str, sid_hash: str, sub: str) -> bytes:
        return json.dumps([refresh_token[::-1], sid_hash, sub]).encode()

    def decrypt(self, ciphertext: bytes, sid_hash: str, sub: str) -> str:
        try:
            token, bound_sid, bound_sub = json.loads(ciphertext)
        except ValueError:
            raise SessionRejectedError from None
        if (bound_sid, bound_sub) != (sid_hash, sub):
            raise SessionRejectedError
        return str(token)[::-1]


@dataclass
class FakeStore:
    sessions: dict[str, SessionRecord] = field(default_factory=dict)
    marks: dict[str, Revocation] = field(default_factory=dict)

    def put(self, sid_hash: str, record: SessionRecord) -> None:
        self.sessions[sid_hash] = record

    def get(self, sid_hash: str) -> SessionRecord | None:
        return self.sessions.get(sid_hash)

    def delete(self, sid_hash: str) -> None:
        self.sessions.pop(sid_hash, None)

    def revoke_user(self, sub: str, now: int, cause: RevocationCause) -> None:
        self.marks[sub] = Revocation(now, cause)

    def revocation(self, sub: str) -> Revocation:
        return self.marks.get(sub, Revocation(0))


@dataclass
class FakeAudit:
    events: list[tuple[str, str, dict[str, Any]]] = field(default_factory=list)
    actors: list[Any] = field(default_factory=list)
    fail: bool = False

    def emit(self, event: str, user: str, detail: dict[str, Any], actor: Any = None) -> None:
        if self.fail:
            raise RuntimeError("audit down")
        self.events.append((event, user, detail))
        self.actors.append(actor)

    def names(self) -> list[str]:
        return [e[0] for e in self.events]


@dataclass
class Harness:
    store: FakeStore = field(default_factory=FakeStore)
    tokens: FakeTokens = field(default_factory=FakeTokens)
    audit: FakeAudit = field(default_factory=FakeAudit)
    now: datetime = START
    people_hook: list[str] = field(default_factory=list)

    def deps(self) -> WebSessionDeps:
        return WebSessionDeps(
            store=self.store,
            cipher=FakeCipher(),
            tokens=self.tokens,
            verifier=FakeVerifier(),
            audit=self.audit,  # type: ignore[arg-type]
            clock=lambda: self.now,
            app_origin=ORIGIN,
            session_seconds=HOURS * 3600,
            renewals=RateLimiter(5, 300),
        )

    def client(self) -> TestClient:
        def factory(settings: Settings) -> app_module.Services:
            return app_module.Services(
                settings=settings,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=None,  # type: ignore[arg-type]
                budgets=None,  # type: ignore[arg-type]
                conversations=None,  # type: ignore[arg-type]
                audit=self.audit,  # type: ignore[arg-type]
                agentcore=None,
                bedrock=None,
                settings_store=None,  # type: ignore[arg-type]
                budget_limits=None,  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=None,  # type: ignore[arg-type]
                model_catalog=None,  # type: ignore[arg-type]
                web_sessions=self.deps(),
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        return TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]


SAME_ORIGIN = {"X-Mango-Session": "1", "Origin": ORIGIN, "Sec-Fetch-Site": "same-origin"}


def _bearer(sub: str = "user-1") -> dict[str, str]:
    return {"Authorization": f"Bearer at:{sub}:{int(START.timestamp())}"}


def _start(client: TestClient, sub: str = "user-1", **body: Any) -> Any:
    return client.post(
        "/api/session",
        json={"refresh_token": f"rt-{sub}", **body},
        headers={**SAME_ORIGIN, **_bearer(sub)},
    )


def _cookie(response: Any) -> str:
    """``name=value`` of the session cookie the response set."""
    return str(response.headers["set-cookie"]).split(";", 1)[0]


def _renew(client: TestClient, cookie: str | None, **headers: str) -> Any:
    sent = {**SAME_ORIGIN, **headers}
    if cookie:
        sent["Cookie"] = cookie
    return client.post("/api/session/refresh", headers=sent)


@pytest.fixture
def h() -> Harness:
    return Harness()


def test_start_sets_a_hardened_cookie_and_keeps_no_secret(h: Harness) -> None:
    response = _start(h.client())
    assert response.status_code == 204
    assert response.headers["cache-control"] == "no-store"
    header = response.headers["set-cookie"]
    name, value = _cookie(response).split("=", 1)
    assert name == COOKIE_NAME == "__Host-mango_session"
    attributes = {a.strip().lower() for a in header.split(";")[1:]}
    assert {"httponly", "secure", "samesite=strict", "path=/"} <= attributes
    assert f"max-age={HOURS * 3600}" in attributes
    assert not any(a.startswith("domain") for a in attributes)
    assert "rt-user-1" not in header

    version, sid, _ciphertext = value.split(".")
    assert version == "v1"
    # Only the hash of the id is stored, and nothing of the token.
    record = h.store.sessions[hashlib.sha256(sid.encode()).hexdigest()]
    assert record == SessionRecord(
        sub="user-1",
        created_at=int(START.timestamp()),
        expires_at=int((START + timedelta(hours=HOURS)).timestamp()),
        federated=False,
        # Who signed in, for the audit event of the end; no token and no secret.
        actor=SessionActor(email="one@example.com", role="finops-central", is_admin=False),
    )
    assert sid not in h.store.sessions
    assert h.audit.events == [
        ("session.started", "user-1", {"federated": False, "expires_at": record.expires_at})
    ]


def test_a_person_without_a_group_gets_a_session_too(h: Harness) -> None:
    client = h.client()
    response = _start(client, "user-4")
    assert response.status_code == 204
    assert _renew(client, _cookie(response)).status_code == 200


@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": ORIGIN},  # no custom header: what a cross-site form can send
        {"X-Mango-Session": "1"},  # no Origin
        {"X-Mango-Session": "1", "Origin": "https://evil.example.com"},
        {"X-Mango-Session": "1", "Origin": f"{ORIGIN}.evil.example.com"},
        {"X-Mango-Session": "1", "Origin": ORIGIN, "Sec-Fetch-Site": "cross-site"},
        {"X-Mango-Session": "1", "Origin": ORIGIN, "Sec-Fetch-Site": "same-site"},
        {"X-Mango-Session": "true", "Origin": ORIGIN},
    ],
)
def test_cross_site_requests_are_refused_on_every_route(
    h: Harness, headers: dict[str, str]
) -> None:
    client = h.client()
    cookie = _cookie(_start(client))
    calls = h.tokens.calls
    start = client.post(
        "/api/session", json={"refresh_token": "rt-user-1"}, headers={**headers, **_bearer()}
    )
    renew = client.post("/api/session/refresh", headers={**headers, "Cookie": cookie})
    end = client.delete("/api/session", headers={**headers, "Cookie": cookie})
    assert [start.status_code, renew.status_code, end.status_code] == [403, 403, 403]
    assert "set-cookie" not in start.headers
    assert h.tokens.calls == calls
    assert len(h.store.sessions) == 1


def test_start_needs_a_verified_access_token(h: Harness) -> None:
    client = h.client()
    body = {"refresh_token": "rt-user-1"}
    missing = client.post("/api/session", json=body, headers=SAME_ORIGIN)
    invalid = client.post(
        "/api/session", json=body, headers={**SAME_ORIGIN, "Authorization": "Bearer nope"}
    )
    assert [missing.status_code, invalid.status_code] == [401, 401]
    assert h.store.sessions == {}


def test_a_refresh_token_of_someone_else_never_becomes_a_session(h: Harness) -> None:
    response = h.client().post(
        "/api/session",
        json={"refresh_token": "rt-user-2"},
        headers={**SAME_ORIGIN, **_bearer("user-1")},
    )
    assert response.status_code == 403
    assert "set-cookie" not in response.headers
    assert h.store.sessions == {}
    assert h.audit.events == [("session.rejected", "user-1", {"reason": "sub_mismatch"})]


def test_a_refresh_token_cognito_refuses_starts_nothing(h: Harness) -> None:
    h.tokens.rejected.add("rt-user-1")
    response = _start(h.client())
    assert response.status_code == 401
    assert "set-cookie" not in response.headers
    assert h.store.sessions == {}


def test_start_fails_closed_without_audit(h: Harness) -> None:
    h.audit.fail = True
    response = _start(h.client())
    assert response.status_code == 503
    assert "set-cookie" not in response.headers
    assert h.store.sessions == {}


def test_start_rejects_unknown_fields_and_oversized_tokens(h: Harness) -> None:
    client = h.client()
    extra = _start(client, sid="chosen-by-the-client")
    huge = client.post(
        "/api/session",
        json={"refresh_token": "x" * 4097},
        headers={**SAME_ORIGIN, **_bearer()},
    )
    assert [extra.status_code, huge.status_code] == [422, 422]
    # Field names only: the value is never echoed.
    assert "chosen-by-the-client" not in extra.text
    assert h.store.sessions == {}


def test_the_session_limit_counts_from_the_sign_in(h: Harness) -> None:
    h.tokens.auth_time = int((START - timedelta(hours=3)).timestamp())
    response = _start(h.client())
    assert f"Max-Age={5 * 3600}" in response.headers["set-cookie"]
    (record,) = h.store.sessions.values()
    assert record.expires_at == int((START + timedelta(hours=5)).timestamp())


def test_a_sign_in_older_than_the_limit_starts_nothing(h: Harness) -> None:
    h.tokens.auth_time = int((START - timedelta(hours=HOURS)).timestamp())
    assert _start(h.client()).status_code == 401
    assert h.store.sessions == {}


def test_starting_again_ends_the_previous_session_of_the_cookie(h: Harness) -> None:
    client = h.client()
    first = _cookie(_start(client))
    second = client.post(
        "/api/session",
        json={"refresh_token": "rt-user-2"},
        headers={**SAME_ORIGIN, **_bearer("user-2"), "Cookie": first},
    )
    assert second.status_code == 204
    assert [r.sub for r in h.store.sessions.values()] == ["user-2"]
    assert _renew(client, first).status_code == 204


def test_renew_returns_new_tokens_and_never_the_refresh_token(h: Harness) -> None:
    client = h.client()
    cookie = _cookie(_start(client, federated=True))
    response = _renew(client, cookie)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "access_token": f"at:user-1:{int(START.timestamp())}",
        "id_token": "id-user-1",
        "expires_in": 3600,
        "federated": True,
    }
    assert "set-cookie" not in response.headers
    assert h.audit.names() == ["session.started", "session.renewed"]
    assert "rt-user-1" not in json.dumps(h.audit.events)


def test_renew_without_a_session_is_a_quiet_204_that_clears_the_cookie(h: Harness) -> None:
    client = h.client()
    none = _renew(client, None)
    unknown = _renew(client, f"{COOKIE_NAME}=v1.{'a' * 43}.YWJj")
    malformed = _renew(client, f"{COOKIE_NAME}=garbage")
    for response in (none, unknown, malformed):
        # No error status: a first visit must not log a failed request in the browser.
        assert response.status_code == 204
        assert response.content == b""
        assert response.headers["cache-control"] == "no-store"
        assert f"{COOKIE_NAME}=;" in response.headers["set-cookie"]
        assert "Max-Age=0" in response.headers["set-cookie"]
    assert h.tokens.calls == 0


def test_an_expired_session_ends(h: Harness) -> None:
    client = h.client()
    cookie = _cookie(_start(client))
    h.now = START + timedelta(hours=HOURS)
    response = _renew(client, cookie)
    assert response.status_code == 204
    assert h.store.sessions == {}
    assert h.audit.events[-1] == ("session.ended", "user-1", {"reason": "expired"})


@pytest.mark.parametrize("cause", ["disabled", "group_removed", "mfa_reset"])
def test_revoking_a_user_ends_the_sessions_started_before(
    h: Harness, cause: RevocationCause
) -> None:
    client = h.client()
    deps_cookie = _cookie(_start(client))
    h.now = START + timedelta(minutes=5)
    # What People and the MFA reset call (see app.py).
    h.deps().revoke_user("user-1", cause)
    calls = h.tokens.calls
    response = _renew(client, deps_cookie)
    assert response.status_code == 204
    assert h.tokens.calls == calls  # ended before asking Cognito
    # The event says which change ended the session, not just that it was revoked.
    assert h.audit.events[-1] == ("session.ended", "user-1", {"reason": cause})

    # A sign-in after the mark works.
    h.now = START + timedelta(minutes=6)
    h.tokens.auth_time = int(h.now.timestamp())
    assert _renew(client, _cookie(_start(client))).status_code == 200


@pytest.mark.parametrize("cause", [None, "made_up"])
def test_a_mark_without_a_known_cause_stays_revoked(h: Harness, cause: str | None) -> None:
    client = h.client()
    cookie = _cookie(_start(client))
    # A mark written before the cause was recorded, or one this code never writes.
    h.store.marks["user-1"] = Revocation(int(START.timestamp()), cause)
    assert _renew(client, cookie).status_code == 204
    assert h.audit.events[-1] == ("session.ended", "user-1", {"reason": "revoked"})


def test_the_latest_mark_names_the_cause(h: Harness) -> None:
    client = h.client()
    cookie = _cookie(_start(client))
    deps = h.deps()
    deps.revoke_user("user-1", "group_removed")
    h.now = START + timedelta(minutes=1)
    deps.revoke_user("user-1", "disabled")
    assert _renew(client, cookie).status_code == 204
    assert h.audit.events[-1] == ("session.ended", "user-1", {"reason": "disabled"})


def _end_by(h: Harness, client: TestClient, cookie: str, reason: str) -> None:
    if reason == "sign_out":
        client.delete("/api/session", headers={**SAME_ORIGIN, "Cookie": cookie})
        return
    if reason == "expired":
        h.now = START + timedelta(hours=HOURS)
    elif reason == "rejected":
        h.tokens.rejected.add("rt-user-1")
    else:
        h.deps().revoke_user("user-1", "disabled")
    _renew(client, cookie)


@pytest.mark.parametrize("reason", ["sign_out", "expired", "disabled", "rejected"])
def test_the_end_of_a_session_names_the_person_like_its_start(h: Harness, reason: str) -> None:
    client = h.client()
    cookie = _cookie(_start(client))
    started = h.audit.actors[-1]
    _end_by(h, client, cookie, reason)
    assert h.audit.events[-1] == ("session.ended", "user-1", {"reason": reason})
    ended = h.audit.actors[-1]
    # No token is at hand when a session ends: the actor comes from the session record.
    assert (ended.user_id, ended.email, ended.role, ended.is_admin) == (
        "user-1",
        "one@example.com",
        "finops-central",
        False,
    )
    assert (ended.email, ended.role, ended.is_admin) == (
        started.email,
        started.role,
        started.is_admin,
    )


def test_the_end_of_a_session_without_a_recorded_actor_has_none(h: Harness) -> None:
    client = h.client()
    # A person without a group: the start has no actor either.
    cookie = _cookie(_start(client, "user-4"))
    assert h.audit.actors[-1] is None
    client.delete("/api/session", headers={**SAME_ORIGIN, "Cookie": cookie})
    assert h.audit.events[-1] == ("session.ended", "user-4", {"reason": "sign_out"})
    assert h.audit.actors[-1] is None

    # A record written before the actor was kept.
    cookie = _cookie(_start(client))
    (sid_hash,) = h.store.sessions
    record = h.store.sessions[sid_hash]
    h.store.sessions[sid_hash] = SessionRecord(
        record.sub, record.created_at, record.expires_at, record.federated
    )
    client.delete("/api/session", headers={**SAME_ORIGIN, "Cookie": cookie})
    assert h.audit.events[-1] == ("session.ended", "user-1", {"reason": "sign_out"})
    assert h.audit.actors[-1] is None


def test_cognito_refusing_the_token_ends_the_session(h: Harness) -> None:
    client = h.client()
    cookie = _cookie(_start(client))
    h.tokens.rejected.add("rt-user-1")  # disabled, globally signed out or revoked
    response = _renew(client, cookie)
    assert response.status_code == 204
    assert "Max-Age=0" in response.headers["set-cookie"]
    assert h.store.sessions == {}
    assert h.audit.events[-1] == ("session.ended", "user-1", {"reason": "rejected"})


def test_a_ciphertext_moved_to_another_session_does_not_open(h: Harness) -> None:
    client = h.client()
    mine = _cookie(_start(client, "user-2")).split("=", 1)[1].split(".")
    victim = _cookie(_start(client, "user-1")).split("=", 1)[1].split(".")
    forged = f"{COOKIE_NAME}=v1.{mine[1]}.{victim[2]}"
    assert _renew(client, forged).status_code == 204


def test_an_outage_keeps_the_session(h: Harness) -> None:
    client = h.client()
    cookie = _cookie(_start(client))
    h.tokens.down = True
    response = _renew(client, cookie)
    assert response.status_code == 503
    assert "set-cookie" not in response.headers
    assert len(h.store.sessions) == 1
    h.tokens.down = False
    assert _renew(client, cookie).status_code == 200


def test_renewals_are_rate_limited_per_session(h: Harness) -> None:
    client = h.client()
    cookie = _cookie(_start(client))
    codes = [_renew(client, cookie).status_code for _ in range(6)]
    assert codes == [200] * 5 + [429]


def test_made_up_session_ids_do_not_touch_the_rate_limiter(h: Harness) -> None:
    deps = h.deps()
    request_cookie = ("0" * 64, b"x")
    for _ in range(3):
        with pytest.raises(NoSessionError):
            renew(deps, request_cookie)
    # Nothing was recorded for an id without a session.
    assert deps.renewals.retry_after("0" * 64) == 0
    assert all(deps.renewals.allow("0" * 64) for _ in range(5))


def test_sign_out_revokes_the_token_and_forgets_the_session(h: Harness) -> None:
    client = h.client()
    cookie = _cookie(_start(client))
    response = client.delete("/api/session", headers={**SAME_ORIGIN, "Cookie": cookie})
    assert response.status_code == 204
    assert "Max-Age=0" in response.headers["set-cookie"]
    assert h.tokens.revoked == ["rt-user-1"]
    assert h.store.sessions == {}
    assert h.audit.events[-1] == ("session.ended", "user-1", {"reason": "sign_out"})
    assert _renew(client, cookie).status_code == 204
    # Idempotent, also without a cookie.
    again = client.delete("/api/session", headers=SAME_ORIGIN)
    assert again.status_code == 204


def test_the_cookie_authenticates_nothing_else(h: Harness) -> None:
    client = h.client()
    cookie = _cookie(_start(client))
    response = client.get("/api/me", headers={"Cookie": cookie})
    assert response.status_code == 401


def test_tokens_never_reach_the_logs(h: Harness, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    client = h.client()
    cookie = _cookie(_start(client))
    sid = cookie.split(".")[1]
    h.audit.fail = True
    _renew(client, cookie)
    _start(client)
    h.audit.fail = False
    h.tokens.down = True
    _renew(client, cookie)
    client.delete("/api/session", headers={**SAME_ORIGIN, "Cookie": cookie})
    assert caplog.records
    # Nor the email of the person: it goes to the audit trail only.
    for needle in ("rt-user-1", "at:user-1", sid, cookie, "one@example.com"):
        assert needle not in caplog.text


# --- AWS adapters -----------------------------------------------------------------------


class _Cognito:
    """The user pool as the probe of the lab saw it answer (D72)."""

    def __init__(self, answer: Any = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.answer = answer or {
            "ChallengeParameters": {},
            "AuthenticationResult": {
                "AccessToken": "at",
                "IdToken": "it",
                "ExpiresIn": 3600,
                "TokenType": "Bearer",
            },
        }

    def admin_initiate_auth(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("admin_initiate_auth", kwargs))
        if isinstance(self.answer, Exception):
            raise self.answer
        return dict(self.answer)

    def revoke_token(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("revoke_token", kwargs))
        return {}


def _cognito_error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "x"}}, "AdminInitiateAuth")


def test_the_session_is_renewed_with_the_signed_operation_on_this_pool_and_client() -> None:
    cognito = _Cognito()
    tokens = CognitoTokens(cognito, "pool-1", "client-1")  # type: ignore[arg-type]
    assert tokens.refresh("rt") == RenewedTokens("at", "it", 3600)
    # The public ``initiate_auth`` does not exist on the double: calling it would fail here.
    assert cognito.calls == [
        (
            "admin_initiate_auth",
            {
                "UserPoolId": "pool-1",
                "ClientId": "client-1",
                "AuthFlow": "REFRESH_TOKEN_AUTH",
                "AuthParameters": {"REFRESH_TOKEN": "rt"},
            },
        )
    ]


@pytest.mark.parametrize(
    ("answer", "expected"),
    [
        # What the lab answered to a token that is not one, a tampered one and a revoked one.
        (_cognito_error("NotAuthorizedException"), SessionRejectedError),
        (_cognito_error("UserNotFoundException"), SessionRejectedError),
        # Anything else says nothing about the session: it is kept.
        (_cognito_error("TooManyRequestsException"), SessionUnavailableError),
        (_cognito_error("AccessDeniedException"), SessionUnavailableError),
        (_cognito_error("ForbiddenException"), SessionUnavailableError),
        (_cognito_error("InvalidParameterException"), SessionUnavailableError),
        (_cognito_error("InternalErrorException"), SessionUnavailableError),
        (EndpointConnectionError(endpoint_url="https://cognito"), SessionUnavailableError),
        # A challenge or an incomplete answer is not a session either.
        ({"ChallengeName": "SOFTWARE_TOKEN_MFA", "Session": "s"}, SessionUnavailableError),
        (
            {"AuthenticationResult": {"AccessToken": "at", "ExpiresIn": 3600}},
            SessionUnavailableError,
        ),
        (
            {"AuthenticationResult": {"AccessToken": "at", "IdToken": "it", "ExpiresIn": 0}},
            SessionUnavailableError,
        ),
    ],
)
def test_the_signed_renewal_keeps_the_map_of_rejected_and_unavailable(
    answer: Any, expected: type[Exception]
) -> None:
    tokens = CognitoTokens(_Cognito(answer), "pool-1", "client-1")  # type: ignore[arg-type]
    with pytest.raises(expected) as raised:
        tokens.refresh("rt-secret")
    # Neither the token nor the answer of Cognito travels with the error.
    assert raised.value.__cause__ is None
    assert "rt-secret" not in repr(raised.value)


def test_the_renewer_needs_the_pool_and_the_client() -> None:
    for pool, client in (("", "client-1"), ("pool-1", "")):
        with pytest.raises(ValueError, match="required"):
            CognitoTokens(_Cognito(), pool, client)  # type: ignore[arg-type]


def test_the_server_never_starts_another_auth_flow() -> None:
    """The task role may call ``AdminInitiateAuth`` on the user pool (D72). That operation
    also signs in with a password where the client allows it: the only flow any code of
    mango-api may name is the renewal, and only the signed operation starts it."""
    sources = Path(app_module.__file__).parent
    flows: list[tuple[str, str]] = []
    starters: set[tuple[str, str]] = set()
    for path in sources.rglob("*.py"):
        text = path.read_text()
        assert "PASSWORD_AUTH" not in text and "USER_AUTH" not in text, path.name
        for node in ast.walk(ast.parse(text)):
            if isinstance(node, ast.keyword) and node.arg == "AuthFlow":
                flows.append((path.name, ast.unparse(node.value)))
            if isinstance(node, ast.Attribute) and node.attr in {
                "initiate_auth",
                "admin_initiate_auth",
                "respond_to_auth_challenge",
                "admin_respond_to_auth_challenge",
            }:
                starters.add((path.name, node.attr))
    assert flows == [("web_session.py", "REFRESH_FLOW")]
    assert starters == {("web_session.py", "admin_initiate_auth")}
    assert web_session_module.REFRESH_FLOW == "REFRESH_TOKEN_AUTH"


class _Kms:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def encrypt(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {"CiphertextBlob": b"sealed"}

    def decrypt(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {"Plaintext": b"rt"}


def test_the_cipher_binds_the_token_to_the_session_and_the_user() -> None:
    kms = _Kms()
    cipher = TokenCipher(kms, "arn:key")  # type: ignore[arg-type]
    assert cipher.encrypt("rt", "hash", "user-1") == b"sealed"
    assert cipher.decrypt(b"sealed", "hash", "user-1") == "rt"
    context = {"mango:purpose": "web-session", "mango:session": "hash", "mango:sub": "user-1"}
    assert [c["EncryptionContext"] for c in kms.calls] == [context, context]
    assert {c["KeyId"] for c in kms.calls} == {"arn:key"}


class _Dynamo:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str], dict[str, Any]] = {}

    def put_item(self, **kwargs: Any) -> None:
        item = kwargs["Item"]
        self.items[(item["PK"]["S"], item["SK"]["S"])] = item

    def get_item(self, **kwargs: Any) -> dict[str, Any]:
        key = kwargs["Key"]
        item = self.items.get((key["PK"]["S"], key["SK"]["S"]))
        return {"Item": item} if item else {}

    def delete_item(self, **kwargs: Any) -> None:
        key = kwargs["Key"]
        self.items.pop((key["PK"]["S"], key["SK"]["S"]), None)


def test_the_store_round_trips_records_and_marks() -> None:
    store = SessionStore(_Dynamo(), "sessions")  # type: ignore[arg-type]
    record = SessionRecord(sub="user-1", created_at=10, expires_at=20, federated=True)
    store.put("hash", record)
    assert store.get("hash") == record
    assert store.get("other") is None
    assert store.revocation("user-1") == Revocation(0)
    store.revoke_user("user-1", 15, "mfa_reset")
    assert store.revocation("user-1") == Revocation(15, "mfa_reset")
    store.delete("hash")
    assert store.get("hash") is None


def test_the_store_keeps_the_actor_and_reads_items_written_before_it() -> None:
    dynamo = _Dynamo()
    store = SessionStore(dynamo, "sessions")  # type: ignore[arg-type]
    actor = SessionActor(email="one@example.com", role=None, is_admin=True)
    record = SessionRecord(sub="user-1", created_at=10, expires_at=20, federated=False, actor=actor)
    store.put("hash", record)
    assert store.get("hash") == record
    item = dynamo.items[("SESSION#hash", "SESSION")]
    assert item["actor_email"] == {"S": "one@example.com"}
    assert "actor_role" not in item

    # Items of the previous version: a session without an actor, a mark without a cause.
    for name in ("actor_email", "actor_is_admin"):
        del item[name]
    assert store.get("hash") == SessionRecord(
        sub="user-1", created_at=10, expires_at=20, federated=False
    )
    dynamo.items[("USER#user-2", "REVOKED")] = {"revoked_before": {"N": "7"}}
    assert store.revocation("user-2") == Revocation(7)
