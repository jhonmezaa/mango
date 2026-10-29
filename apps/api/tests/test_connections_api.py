"""«Mis conexiones» (D97 (3), D98 (1), (17)): real Cedar policies, moto (DynamoDB, S3), the
Azure DevOps profile of the repository signed with a test key, and fakes of the Gateway and of
AgentCore Identity.

The fake Gateway plays the vault and both interceptors: it verifies the invocation signature,
answers the probe when the person has a token, and otherwise stores the consent URL under the
verified ``sub`` (as the ``RESPONSE`` interceptor does) and answers ``consent_required``."""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, ClassVar

import boto3
import pytest
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api.authz import Authorizer
from mango_api.connections import (
    ConnectionRecords,
    ConnectionsDeps,
    ConsentCompleter,
    PendingConsents,
)
from mango_api.gateway_mcp import PROTOCOL_HEADER, SESSION_HEADER, Answer, GatewayConnections
from mango_api.model_catalog import ModelCatalogCache, ModelCatalogStore
from mango_api.probe import RateLimiter
from mango_api.remote_mcp_store import INDEX_KEY, ApprovedRemotes, RemoteStore
from mango_core import invocation
from mango_core.remote_mcp import (
    ApprovedRemote,
    approved_key,
    consent_key,
    is_force_authentication_meta,
    item_fields,
    registration_key,
    split_gateway_tool,
)

from .cedar_fake import CedarPolicyStore
from .test_admin import RecordingAudit, _table
from .test_agents_api import FakeVerifier
from .test_app import (
    HOST,
    FakeAgentCore,
    FakeBedrock,
    FakeBudgets,
    FakeConversations,
    FakeLimits,
    _settings,
)
from .test_mcp_api import Signer
from .test_remote_mcp_api import PROFILE, FakeKms, _ship, _statement

REG = "abcdefghij23"
OTHER_REG = "abcdefghij45"
GATEWAY_ID = "gw"
KEY = b"k" * 32
ORIGIN = f"https://{HOST}"
CONSENT_URL = "https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/authorize?x=1"
SESSION = "urn:ietf:params:oauth:request_uri:abc-123"
NOW = datetime(2026, 10, 27, 15, 0, tzinfo=UTC)
TOOL = "remote-" + REG + "___core_list_projects"


# --- Fakes --------------------------------------------------------------------------------


@dataclass
class FakeGateway:
    """The Gateway with its vault and both interceptors, as far as these calls go."""

    db: Any
    vault: set[str] = field(default_factory=set)
    """Subjects with a token of the remote in the vault."""
    consent_url: str = CONSENT_URL
    ignore_force: bool = False
    """The Gateway answered normally to a disconnect (it did not delete the token)."""
    down: bool = False
    url_elicitation: bool = False
    """The session declared the client capability ``elicitation.url`` in ``initialize``."""
    calls: list[dict[str, Any]] = field(default_factory=list)

    def __call__(self, url: str, headers: dict[str, str], body: bytes) -> Answer:
        if self.down:
            raise OSError("unreachable")
        message = json.loads(body)
        if message["method"] == "initialize":
            assert message["params"]["protocolVersion"] == "2025-11-25"
            capabilities = message["params"]["capabilities"]
            self.url_elicitation = "url" in capabilities.get("elicitation", {})
            result = {"jsonrpc": "2.0", "id": message["id"], "result": {}}
            return Answer(200, json.dumps(result).encode(), "session-1")
        if message["method"] == "notifications/initialized":
            return Answer(202, b"")
        assert headers[SESSION_HEADER] == "session-1"
        self.calls.append({"headers": headers, "message": message})
        # Without the header the Gateway reads the call as 2025-03-26: no URL elicitation.
        elicits = self.url_elicitation and headers.get(PROTOCOL_HEADER) == "2025-11-25"
        subject = headers["Authorization"].removeprefix("Bearer tok-")
        signed = invocation.verify(KEY, subject, headers[invocation.HEADER])
        assert signed is not None and signed.connection is not None
        name = message["params"]["name"]
        assert signed.tools == frozenset({name})
        reg, _tool = split_gateway_tool(name) or ("", "")
        meta = message["params"].get("_meta")
        if signed.connection == "disconnect":
            assert is_force_authentication_meta(meta)
            if not self.ignore_force:
                self.vault.discard(subject)
                if elicits:
                    return self._consent(message, reg)
        else:
            assert meta is None
        if subject in self.vault:
            content = [{"type": "text", "text": "[secret project list]"}]
            result = {"jsonrpc": "2.0", "id": message["id"], "result": {"content": content}}
            return Answer(200, json.dumps(result).encode())
        if not elicits:
            # Like AgentCore: without the capability, a generic tool error instead of -32042.
            content = [{"type": "text", "text": "An internal error occurred. Please retry later."}]
            result = {
                "jsonrpc": "2.0",
                "id": message["id"],
                "result": {"content": content, "isError": True},
            }
            return Answer(200, json.dumps(result).encode())
        now = int(time.time())
        # Raw, as the interceptor writes it: mango-api must not trust it blindly.
        item = {
            **consent_key(subject, reg),
            "authorization_url": {"S": self.consent_url},
            "source": {"S": "connect"},
            "created_at": {"N": str(now)},
            "expires_at": {"N": str(now + 600)},
            "ttl": {"N": str(now + 600)},
        }
        self.db.put_item(TableName="settings", Item=item)
        return self._consent(message, reg)

    @staticmethod
    def _consent(message: dict[str, Any], reg: str) -> Answer:
        data = {"mango": "consent_required", "target": f"remote-{reg}"}
        error = {"code": -32001, "message": "consent_required", "data": data}
        return Answer(
            200, json.dumps({"jsonrpc": "2.0", "id": message["id"], "error": error}).encode()
        )


@dataclass
class FakeIdentity:
    """``bedrock-agentcore`` (data plane): ``CompleteResourceTokenAuth``."""

    gateway: FakeGateway
    fail: str | None = None
    message: str = "x"
    calls: list[dict[str, Any]] = field(default_factory=list)

    def complete_resource_token_auth(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        if self.fail:
            raise ClientError({"Error": {"Code": self.fail, "Message": self.message}}, "Complete")
        self.gateway.vault.add(kwargs["userIdentifier"]["userToken"].removeprefix("tok-"))
        return {}


class Tokens(FakeVerifier):
    """The access token of each test person is ``tok-<sub>``; ``FakeVerifier`` knows them by
    name, so the bearer is mapped back to its name."""

    BY_SUB: ClassVar[dict[str, str]] = {
        "member-1": "member",
        "out-1": "outsider",
        "admin-1": "admin",
    }

    def verify(self, token: str) -> dict[str, Any]:
        return super().verify(self.BY_SUB.get(token.removeprefix("tok-"), token))


@dataclass
class Env:
    client: TestClient
    db: Any
    audit: RecordingAudit
    gateway: FakeGateway
    identity: FakeIdentity
    deps: ConnectionsDeps
    kms: FakeKms
    texts: list[str] = field(default_factory=list)

    def call(self, method: str, url: str, sub: str = "member-1", **kwargs: Any) -> Any:
        headers = {"Authorization": f"Bearer tok-{sub}", **kwargs.pop("headers", {})}
        if method == "POST" and "json" not in kwargs:
            kwargs["json"] = {}
        response = self.client.request(method, url, headers=headers, **kwargs)
        self.texts.append(response.text)
        return response

    def callback(self, sub: str = "member-1", session: str = SESSION, **headers: str) -> Any:
        return self.call(
            "POST",
            "/api/oauth/callback",
            sub,
            json={"session_id": session},
            headers={"Origin": ORIGIN, "Sec-Fetch-Site": "same-origin", **headers},
        )


def _register(
    db: Any, reg: str, *, status: str = "active", groups: tuple[str, ...] = ("hr",), **extra: str
) -> None:
    item = {
        **registration_key(reg),
        "profile_id": {"S": PROFILE},
        "organization": {"S": "Contoso"},
        "toolsets": {"L": [{"S": "core"}, {"S": "wit"}]},
        "groups": {"L": [{"S": g} for g in groups]},
        "status": {"S": status},
        "version": {"N": "3"},
        "generation": {"N": "1"},
        "provider_generations": {"N": "1"},
        "created_at": {"S": "2026-10-27T10:00:00Z"},
        "secret_expires_on": {"S": extra.get("secret_expires_on", "2027-06-30")},
    }
    db.put_item(TableName="settings", Item=item)
    db.update_item(
        TableName="settings",
        Key=INDEX_KEY,
        UpdateExpression="ADD ids :id",
        ExpressionAttributeValues={":id": {"SS": [reg]}},
    )


def _approve(db: Any, kms: FakeKms, reg: str) -> None:
    """What the remote provisioner signs as its last step (D98 (13))."""
    approved = ApprovedRemote(
        registration_id=reg,
        generation=1,
        revision=1,
        profile_id=PROFILE,
        profile_version="2026.10.27-1",
        profile_sha256="a" * 64,
        gateway_id=GATEWAY_ID,
        organization="Contoso",
        toolsets=("core", "wit"),
        tools=frozenset({"core_list_projects", "wit_work_item"}),
        probe_tool="core_list_projects",
        issued_at=1,
    )
    payload = approved.encode()
    signature = kms.key.sign(b"mango.remote-mcp.v1\n" + payload, ec.ECDSA(hashes.SHA256()))
    fields = item_fields(payload, signature)
    db.put_item(
        TableName="settings",
        Item={**approved_key(reg), **{k: {"S": v} for k, v in fields.items()}},
    )


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="mango-test-packs")
        _table(db, "settings")
        _table(db, "conv")
        audit, cedar, kms = RecordingAudit(), CedarPolicyStore(), FakeKms()
        authorizer = Authorizer(cedar, "ps")  # type: ignore[arg-type]
        gateway = FakeGateway(db)
        identity = FakeIdentity(gateway)
        _register(db, REG)
        _approve(db, kms, REG)
        deps = ConnectionsDeps(
            registrations=RemoteStore(db, "settings"),
            release=_ship(s3, Signer(), _statement()),
            records=ConnectionRecords(lambda _user: db, "conv"),
            consents=PendingConsents(db, "settings", region="us-east-1"),
            audit=audit,  # type: ignore[arg-type]
            clock=lambda: NOW,
            region="us-east-1",
            app_origin=ORIGIN,
            connects=RateLimiter(limit=1000, window_seconds=60),
            disconnects=RateLimiter(limit=1000, window_seconds=60),
            callbacks=RateLimiter(limit=1000, window_seconds=60),
            enabled=True,
            approved=ApprovedRemotes(
                db, "settings", kms, key_id="alias/Mango-test-remote-mcp", gateway_id=GATEWAY_ID
            ),
            gateway=GatewayConnections(
                gateway_url="https://gw.example.com/mcp", invocation_key=KEY, transport=gateway
            ),
            completer=ConsentCompleter(identity),
        )
        monkeypatch.setattr("mango_api.remote_mcp_store.APPROVED_CACHE_SECONDS", 0)

        def factory(s: Any) -> app_module.Services:
            return app_module.Services(
                settings=s,
                verifier=Tokens(),  # type: ignore[arg-type]
                authorizer=authorizer,
                budgets=FakeBudgets(),  # type: ignore[arg-type]
                conversations=FakeConversations(),  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=FakeAgentCore(),
                bedrock=FakeBedrock(),
                settings_store=None,  # type: ignore[arg-type]
                budget_limits=FakeLimits(),  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=None,  # type: ignore[arg-type]
                model_catalog=ModelCatalogCache(ModelCatalogStore(db, "settings"), ttl_seconds=0),
                invocation_key=KEY,
                connections=deps,
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(client, db, audit, gateway, identity, deps, kms)
        assert cedar.errors == []


def _code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def _list(env: Env, sub: str = "member-1") -> dict[str, Any]:
    response = env.call("GET", "/api/me/connections", sub)
    assert response.status_code == 200, response.text
    result: dict[str, Any] = response.json()
    return result


def _connections(env: Env, sub: str = "member-1") -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = _list(env, sub)["connections"]
    return result


def _connect(env: Env, sub: str = "member-1", reg: str = REG) -> Any:
    return env.call("POST", f"/api/me/connections/{reg}/connect", sub)


def _pending(env: Env, sub: str = "member-1", reg: str = REG) -> dict[str, Any] | None:
    item: dict[str, Any] | None = env.db.get_item(
        TableName="settings", Key=consent_key(sub, reg)
    ).get("Item")
    return item


# --- List ---------------------------------------------------------------------------------


def test_the_list_shows_the_registrations_of_the_persons_groups(env: Env) -> None:
    _register(env.db, OTHER_REG, groups=("ops",))
    _register(env.db, "abcdefghij67", status="creating")
    (connection,) = _connections(env)
    assert connection == {
        "registration_id": REG,
        "profile_id": PROFILE,
        "service": "Azure DevOps",
        "provider": "Microsoft",
        "organization": "Contoso",
        "link_hosts": ["dev.azure.com", "visualstudio.com"],
        "status": "not_connected",
        "connected_at": None,
    }
    assert [c["registration_id"] for c in _connections(env, "out-1")] == [OTHER_REG]
    # Being an administrator is not enough (D98 (18)).
    assert _connections(env, "admin-1") == []
    assert env.gateway.calls == []  # Listing never calls Microsoft.


def test_disabled_and_expired_registrations_say_so(env: Env) -> None:
    _register(env.db, OTHER_REG, status="disabled")
    _register(env.db, "abcdefghij67", secret_expires_on="2026-10-01")
    statuses = {c["registration_id"]: c["status"] for c in _connections(env)}
    assert statuses == {
        REG: "not_connected",
        OTHER_REG: "disabled",
        "abcdefghij67": "secret_expired",
    }


def test_the_list_says_whether_remote_servers_are_on_in_the_installation(env: Env) -> None:
    assert _list(env)["enabled"] is True
    env.deps.enabled = False
    body = _list(env)
    # The registrations are still listed: a chat card can name its service (design round 25).
    assert body["enabled"] is False
    assert [c["registration_id"] for c in body["connections"]] == [REG]


# --- Connect ------------------------------------------------------------------------------


def test_connecting_hands_out_the_consent_url_the_interceptor_stored(env: Env) -> None:
    response = _connect(env)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "consent_required"
    assert body["authorization_url"] == CONSENT_URL
    assert body["expires_at"]
    (call,) = env.gateway.calls
    params = call["message"]["params"]
    assert params == {"name": TOOL, "arguments": {"top": 1}}
    signed = invocation.verify(KEY, "member-1", call["headers"][invocation.HEADER])
    assert signed is not None
    assert (signed.agent_id, signed.connection) == ("mangoconn", "connect")
    ((user, detail),) = env.audit.named("mcp_remote.consent_started", outcome=None)
    assert user == "member-1"
    assert detail == {"registration": REG, "source": "connect"}
    # A second click starts a new consent with the caller's current token: Identity only
    # closes a consent with the token that started it (D100).
    assert _connect(env).json()["authorization_url"] == CONSENT_URL
    assert len(env.gateway.calls) == 2


def test_an_account_already_in_the_vault_is_confirmed_without_microsoft(env: Env) -> None:
    env.gateway.vault.add("member-1")
    response = _connect(env)
    assert response.json() == {
        "status": "already_connected",
        "authorization_url": None,
        "expires_at": None,
    }
    (connection,) = _connections(env)
    assert connection["status"] == "connected"
    assert connection["connected_at"] == "2026-10-27T15:00:00+00:00"
    # What the tool answered is discarded: never in a response or the audit trail.
    assert not any("secret project" in text for text in env.texts)
    assert "secret project" not in json.dumps(env.audit.events)


def test_a_url_of_another_host_never_leaves(env: Env) -> None:
    # Stored behind the interceptor's back: mango-api checks it again (D94 (2)).
    env.gateway.consent_url = "https://evil.example.com/authorize"
    response = _connect(env)
    assert (response.status_code, _code(response)) == (503, "gateway_unavailable")
    env.gateway.consent_url = "https://bedrock-agentcore.us-west-2.amazonaws.com/authorize"
    response = _connect(env)
    assert (response.status_code, _code(response)) == (503, "gateway_unavailable")
    assert not any("evil.example.com" in t or "us-west-2" in t for t in env.texts)
    assert env.audit.named("mcp_remote.consent_started", outcome=None) == []


def test_without_use_remote_mcp_connecting_is_forbidden(env: Env) -> None:
    for sub in ("out-1", "admin-1"):
        response = _connect(env, sub)
        assert (response.status_code, _code(response)) == (403, "remote_not_usable")
    assert env.gateway.calls == []
    response = _connect(env, reg=OTHER_REG)
    assert response.status_code == 404


def test_connecting_needs_the_parameter_on_and_an_active_registration(env: Env) -> None:
    env.deps.enabled = False
    assert _code(_connect(env)) == "remote_disabled"
    env.deps.enabled = True
    _register(env.db, OTHER_REG, status="disabled")
    assert (_connect(env, reg=OTHER_REG).status_code, _code(_connect(env, reg=OTHER_REG))) == (
        409,
        "remote_disabled",
    )
    _register(env.db, REG, secret_expires_on="2026-10-01")
    assert _code(_connect(env)) == "secret_expired"
    assert env.gateway.calls == []


def test_a_gateway_that_cannot_be_reached_answers_503(env: Env) -> None:
    env.gateway.down = True
    response = _connect(env)
    assert (response.status_code, _code(response)) == (503, "gateway_unavailable")


def test_connecting_is_rate_limited_per_person(env: Env) -> None:
    env.deps.connects = RateLimiter(limit=1, window_seconds=60)
    assert _connect(env).status_code == 200
    assert _connect(env).status_code == 429


# --- Callback (D98 (1)) -------------------------------------------------------------------


def test_the_callback_closes_the_persons_consent_with_their_own_token(env: Env) -> None:
    _connect(env)
    response = env.callback()
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "connected", "registration_id": REG, "profile_id": PROFILE}
    assert env.identity.calls == [
        {"userIdentifier": {"userToken": "tok-member-1"}, "sessionUri": SESSION}
    ]
    assert _pending(env) is None
    assert _connections(env)[0]["status"] == "connected"
    ((_, detail),) = env.audit.named("mcp_remote.consent_completed", outcome=None)
    assert detail == {"registration": REG, "source": "connect"}
    # Now the probe answers: already connected.
    assert _connect(env).json()["status"] == "already_connected"


def test_the_callback_without_a_pending_consent_answers_410(env: Env) -> None:
    response = env.callback()
    assert (response.status_code, _code(response)) == (410, "consent_expired")
    assert env.identity.calls == []
    ((_, detail),) = env.audit.named("mcp_remote.consent_failed", outcome=None)
    assert detail == {"registration": None, "reason": "consent_expired"}


def test_one_pending_consent_without_a_hash_is_closed_as_before(env: Env) -> None:
    _register(env.db, OTHER_REG)
    _approve(env.db, env.kms, OTHER_REG)
    _connect(env, reg=OTHER_REG)
    response = env.callback()
    assert response.json()["registration_id"] == OTHER_REG
    assert _pending(env, reg=OTHER_REG) is None


def test_several_pending_consents_without_a_hash_close_none(env: Env) -> None:
    # F-1: the session could be either one; neither is marked, deleted or closed.
    _register(env.db, OTHER_REG)
    _approve(env.db, env.kms, OTHER_REG)
    _connect(env)
    _connect(env, reg=OTHER_REG)
    response = env.callback()
    assert (response.status_code, _code(response)) == (409, "consent_ambiguous")
    assert env.identity.calls == []
    assert _pending(env) is not None
    assert _pending(env, reg=OTHER_REG) is not None
    assert {c["status"] for c in _connections(env)} == {"not_connected"}
    assert env.audit.named("mcp_remote.consent_completed", outcome=None) == []
    ((user, detail),) = env.audit.named("mcp_remote.consent_failed", outcome=None)
    assert (user, detail) == ("member-1", {"registration": None, "reason": "consent_ambiguous"})


def test_the_pending_consent_of_another_person_is_never_read(env: Env) -> None:
    _connect(env, "member-1")
    # The outsider closes nothing: their partition is empty, whatever session they post.
    response = env.callback("out-1")
    assert (response.status_code, _code(response)) == (410, "consent_expired")
    assert env.identity.calls == []
    assert _pending(env, "member-1") is not None


def test_identity_refusing_the_session_is_consent_not_yours(
    env: Env, caplog: pytest.LogCaptureFixture
) -> None:
    _connect(env)
    env.identity.fail = "AccessDeniedException"
    env.identity.message = (
        "Invalid or expired session urn:ietf:params:oauth:request_uri:abc-123 for "
        "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln at https://example.invalid/x?y=1"
    )
    response = env.callback()
    assert (response.status_code, _code(response)) == (403, "consent_not_yours")
    assert _pending(env) is not None
    assert _connections(env)[0]["status"] == "not_connected"
    ((_, detail),) = env.audit.named("mcp_remote.consent_failed", outcome=None)
    assert detail == {"registration": REG, "reason": "consent_not_yours"}
    # Identity's reason reaches the log, never the session, a token or a URL.
    (line,) = [r.getMessage() for r in caplog.records if "identity refused" in r.getMessage()]
    assert line == (
        "identity refused a consent: Invalid or expired session <redacted> for <redacted> "
        "at <redacted>"
    )


def test_iam_refusing_mango_api_is_not_the_persons_fault(
    env: Env, caplog: pytest.LogCaptureFixture
) -> None:
    _connect(env)
    env.identity.fail = "AccessDeniedException"
    env.identity.message = (
        "User: arn:aws:sts::111122223333:assumed-role/Mango-ns-ApiTask/s is not authorized to "
        "perform: bedrock-agentcore:CompleteResourceTokenAuth on resource: "
        "arn:aws:bedrock-agentcore:us-east-1:111122223333:token-vault/default because no "
        "identity-based policy allows it"
    )
    response = env.callback()
    assert (response.status_code, _code(response)) == (502, "identity_unavailable")
    assert _pending(env) is not None
    # Only the action and the resource reach the log, never the session or a token.
    (line,) = [r.getMessage() for r in caplog.records if "identity denied" in r.getMessage()]
    assert line == (
        "identity denied mango-api bedrock-agentcore:CompleteResourceTokenAuth on "
        "arn:aws:bedrock-agentcore:us-east-1:111122223333:token-vault/default"
    )
    assert "tok-" not in caplog.text


@pytest.mark.parametrize(
    ("code", "status", "error"),
    [
        ("ValidationException", 410, "consent_expired"),
        ("ResourceNotFoundException", 410, "consent_expired"),
        ("InternalServerException", 502, "identity_unavailable"),
    ],
)
def test_identity_errors_map_to_closed_codes(env: Env, code: str, status: int, error: str) -> None:
    _connect(env)
    env.identity.fail = code
    response = env.callback()
    assert (response.status_code, _code(response)) == (status, error)


def test_the_callback_needs_use_remote_mcp(env: Env) -> None:
    _connect(env)
    _register(env.db, REG, groups=("ops",))  # The administrators moved it to another group.
    response = env.callback()
    assert (response.status_code, _code(response)) == (403, "remote_not_usable")
    assert env.identity.calls == []


def test_the_callback_requires_the_applications_own_origin(env: Env) -> None:
    _connect(env)
    for headers in (
        {"Origin": "https://evil.example.com"},
        {"Sec-Fetch-Site": "cross-site"},
    ):
        response = env.callback(**headers)
        assert response.status_code == 403
    response = env.call("POST", "/api/oauth/callback", json={"session_id": SESSION})
    assert response.status_code == 403
    assert env.identity.calls == []


def test_the_callback_only_takes_an_identity_request_uri(env: Env) -> None:
    for session in ("https://evil.example.com", "urn:ietf:params:oauth:request_uri:a b", ""):
        assert env.callback(session=session).status_code == 422
    response = env.call(
        "POST",
        "/api/oauth/callback",
        json={"session_id": SESSION, "registration_id": REG},
        headers={"Origin": ORIGIN},
    )
    assert response.status_code == 422


# --- Disconnect (D97 (3)) -----------------------------------------------------------------


def test_disconnecting_deletes_the_token_with_force_authentication(env: Env) -> None:
    env.gateway.vault.add("member-1")
    _connect(env)
    response = env.call("POST", f"/api/me/connections/{REG}/disconnect")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "not_connected"
    call = env.gateway.calls[-1]
    assert is_force_authentication_meta(call["message"]["params"]["_meta"])
    signed = invocation.verify(KEY, "member-1", call["headers"][invocation.HEADER])
    assert signed is not None and signed.connection == "disconnect"
    assert "member-1" not in env.gateway.vault
    # No consent is offered: the person did not ask to connect (D97 (3)).
    assert _pending(env) is None
    assert "authorization_url" not in response.json()
    assert _connections(env)[0]["status"] == "not_connected"
    ((user, detail),) = env.audit.named("mcp_remote.disconnect", outcome=None)
    assert (user, detail) == ("member-1", {"registration": REG})


def test_a_disconnect_the_gateway_does_not_confirm_is_an_error(env: Env) -> None:
    env.gateway.vault.add("member-1")
    _connect(env)
    env.gateway.ignore_force = True
    response = env.call("POST", f"/api/me/connections/{REG}/disconnect")
    assert (response.status_code, _code(response)) == (502, "disconnect_not_confirmed")
    assert env.audit.named("mcp_remote.disconnect", outcome=None) == []
    assert _connections(env)[0]["status"] == "connected"


def test_an_expired_secret_still_says_the_account_was_connected(env: Env) -> None:
    # Design round 24: «Desconectar» is offered with the secret expired only to who connected.
    env.gateway.vault.add("member-1")
    _connect(env)
    _register(env.db, REG, secret_expires_on="2026-10-01")
    (item,) = [c for c in _connections(env) if c["registration_id"] == REG]
    assert item["status"] == "secret_expired"
    assert item["connected_at"]
    _register(env.db, OTHER_REG, secret_expires_on="2026-10-01")
    (other,) = [c for c in _connections(env) if c["registration_id"] == OTHER_REG]
    assert (other["status"], other["connected_at"]) == ("secret_expired", None)


def test_disconnecting_works_with_the_secret_expired(env: Env) -> None:
    # NV-2: an expired secret blocks connecting, not taking access away.
    env.gateway.vault.add("member-1")
    _connect(env)
    _register(env.db, REG, secret_expires_on="2026-10-01")
    response = env.call("POST", f"/api/me/connections/{REG}/disconnect")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "secret_expired"
    assert response.json()["connected_at"] is None
    assert "member-1" not in env.gateway.vault
    assert len(env.audit.named("mcp_remote.disconnect", outcome=None)) == 1


def test_disconnecting_a_registration_that_is_not_active_is_refused(env: Env) -> None:
    _register(env.db, REG, status="disabled")
    response = env.call("POST", f"/api/me/connections/{REG}/disconnect")
    assert (response.status_code, _code(response)) == (409, "remote_disabled")
    assert env.gateway.calls == []


def test_without_use_remote_mcp_disconnecting_is_forbidden(env: Env) -> None:
    response = env.call("POST", f"/api/me/connections/{REG}/disconnect", "out-1")
    assert (response.status_code, _code(response)) == (403, "remote_not_usable")
    assert env.gateway.calls == []


def test_a_connection_of_another_generation_counts_as_not_connected(env: Env) -> None:
    env.gateway.vault.add("member-1")
    _connect(env)
    env.db.update_item(
        TableName="settings",
        Key=registration_key(REG),
        UpdateExpression="SET generation = :g",
        ExpressionAttributeValues={":g": {"N": "2"}},
    )
    assert _connections(env)[0]["status"] == "not_connected"


def test_no_route_logs_or_audits_a_url_a_session_or_a_token(
    env: Env, caplog: pytest.LogCaptureFixture
) -> None:
    _connect(env)
    env.identity.fail = "AccessDeniedException"
    env.callback()
    env.identity.fail = None
    env.callback()
    env.call("POST", f"/api/me/connections/{REG}/disconnect")
    trail = json.dumps(env.audit.events) + caplog.text
    for secret in (CONSENT_URL, SESSION, "tok-member-1", "session-1"):
        assert secret not in trail
