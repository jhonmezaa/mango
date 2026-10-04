"""Web session cookie (D63): creation, renewal, sign-out, CSRF guard and revocation."""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from mango_api import app as app_module
from mango_api.probe import RateLimiter
from mango_api.settings import ModelPrice, Settings
from mango_api.web import ApiError
from mango_api.web_session import (
    COOKIE_NAME,
    RenewedTokens,
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
    marks: dict[str, int] = field(default_factory=dict)

    def put(self, sid_hash: str, record: SessionRecord) -> None:
        self.sessions[sid_hash] = record

    def get(self, sid_hash: str) -> SessionRecord | None:
        return self.sessions.get(sid_hash)

    def delete(self, sid_hash: str) -> None:
        self.sessions.pop(sid_hash, None)

    def revoke_user(self, sub: str, now: int) -> None:
        self.marks[sub] = now

    def revoked_before(self, sub: str) -> int:
        return self.marks.get(sub, 0)


@dataclass
class FakeAudit:
    events: list[tuple[str, str, dict[str, Any]]] = field(default_factory=list)
    fail: bool = False

    def emit(self, event: str, user: str, detail: dict[str, Any], _actor: Any = None) -> None:
        if self.fail:
            raise RuntimeError("audit down")
        self.events.append((event, user, detail))

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
    assert _renew(client, first).status_code == 401


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


def test_renew_without_a_session_is_a_quiet_401_that_clears_the_cookie(h: Harness) -> None:
    client = h.client()
    none = _renew(client, None)
    unknown = _renew(client, f"{COOKIE_NAME}=v1.{'a' * 43}.YWJj")
    malformed = _renew(client, f"{COOKIE_NAME}=garbage")
    for response in (none, unknown, malformed):
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "no_session"
        assert f"{COOKIE_NAME}=;" in response.headers["set-cookie"]
        assert "Max-Age=0" in response.headers["set-cookie"]
    assert h.tokens.calls == 0


def test_an_expired_session_ends(h: Harness) -> None:
    client = h.client()
    cookie = _cookie(_start(client))
    h.now = START + timedelta(hours=HOURS)
    response = _renew(client, cookie)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "session_expired"
    assert h.store.sessions == {}
    assert h.audit.events[-1] == ("session.ended", "user-1", {"reason": "expired"})


def test_revoking_a_user_ends_the_sessions_started_before(h: Harness) -> None:
    client = h.client()
    deps_cookie = _cookie(_start(client))
    h.now = START + timedelta(minutes=5)
    # What People and the MFA reset call (see app.py).
    h.store.revoke_user("user-1", int(h.now.timestamp()))
    calls = h.tokens.calls
    response = _renew(client, deps_cookie)
    assert response.status_code == 401
    assert h.tokens.calls == calls  # ended before asking Cognito
    assert h.audit.events[-1] == ("session.ended", "user-1", {"reason": "revoked"})

    # A sign-in after the mark works.
    h.now = START + timedelta(minutes=6)
    h.tokens.auth_time = int(h.now.timestamp())
    assert _renew(client, _cookie(_start(client))).status_code == 200


def test_cognito_refusing_the_token_ends_the_session(h: Harness) -> None:
    client = h.client()
    cookie = _cookie(_start(client))
    h.tokens.rejected.add("rt-user-1")  # disabled, globally signed out or revoked
    response = _renew(client, cookie)
    assert response.status_code == 401
    assert "Max-Age=0" in response.headers["set-cookie"]
    assert h.store.sessions == {}
    assert h.audit.events[-1] == ("session.ended", "user-1", {"reason": "rejected"})


def test_a_ciphertext_moved_to_another_session_does_not_open(h: Harness) -> None:
    client = h.client()
    mine = _cookie(_start(client, "user-2")).split("=", 1)[1].split(".")
    victim = _cookie(_start(client, "user-1")).split("=", 1)[1].split(".")
    forged = f"{COOKIE_NAME}=v1.{mine[1]}.{victim[2]}"
    assert _renew(client, forged).status_code == 401


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
        with pytest.raises(ApiError) as refused:
            renew(deps, request_cookie)
        assert refused.value.status == 401
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
    assert _renew(client, cookie).status_code == 401
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
    for needle in ("rt-user-1", "at:user-1", sid, cookie):
        assert needle not in caplog.text


# --- AWS adapters -----------------------------------------------------------------------


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
    assert store.revoked_before("user-1") == 0
    store.revoke_user("user-1", 15)
    assert store.revoked_before("user-1") == 15
    store.delete("hash")
    assert store.get("hash") is None
