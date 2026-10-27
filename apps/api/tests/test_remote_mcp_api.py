"""Remote MCP registrations (D93, D98 (17)): real Cedar policies, moto (DynamoDB, S3), the
Azure DevOps profile of the repository signed with a test key, a recording audit and fakes of
AgentCore Identity, CloudFormation and KMS. The remote provisioner is played by direct writes
of the statuses it owns."""

from __future__ import annotations

import base64
import json
import logging
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import boto3
import pytest
import yaml
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api.agents import AgentsDeps
from mango_api.agents_store import AgentsStore
from mango_api.authz import Authorizer
from mango_api.groups import GroupRegistry
from mango_api.mcp_catalog import CatalogSource, McpCatalog
from mango_api.model_catalog import ModelCatalogCache, ModelCatalogStore
from mango_api.probe import RateLimiter
from mango_api.provisioner import ProvisionerClient, RemoteProvisionerClient
from mango_api.published import PublishedAgents
from mango_api.remote_mcp import RemoteMcpDeps, secret_level
from mango_api.remote_mcp_store import (
    ApprovedRemotes,
    IdentityProviders,
    RemoteStore,
    StackTagError,
    StackTags,
    custom_tags,
)
from mango_api.remote_release import ReleaseRemotes, parse_remote_catalog, statement_key
from mango_core.remote_mcp import (
    ApprovedRemote,
    approved_key,
    item_fields,
    organization_key,
    registration_key,
)
from mango_packs.canonical import sha256_hex
from mango_packs.enablement import is_pack_id
from mango_packs.remote import PAYLOAD_TYPE, RemoteProfileStatement, build_envelope
from mango_packs.signing import signed_message

from .cedar_fake import CedarPolicyStore
from .test_admin import RecordingAudit, _table
from .test_agents_api import (
    CONNECTORS,
    STATE_MACHINE,
    FakeStepFunctions,
    FakeVerifier,
    _group,
    _models,
)
from .test_agents_store import create_agents_table
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

REPO = Path(__file__).parents[3]
PROFILE = "azure-devops"
BUCKET = "mango-test-packs"
ACCOUNT = "123456789012"
REMOTE_MACHINE = (
    "arn:aws:states:us-east-1:111111111111:stateMachine:Mango-test-RemoteMcpProvisioner"
)
URL = "/api/mcp/remotes"
TENANT = "00000000-0000-0000-0000-00000000000a"
CLIENT = "00000000-0000-0000-0000-00000000000b"
# Built at run time: no literal with the shape of a credential in the repository.
SECRET = "sec-" + "Q" * 28
NEW_SECRET = "sec-" + "R" * 28
CALLBACK = "https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/x"
GATEWAY_ID = "gw"  # `gateway_id_of(_settings().gateway_url)`


# --- Fakes --------------------------------------------------------------------------------


@dataclass
class FakeIdentity:
    """``bedrock-agentcore-control``: the providers mango-api creates, updates and deletes."""

    providers: dict[str, dict[str, Any]] = field(default_factory=dict)
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    fail: str | None = None

    def _maybe_fail(self, op: str) -> None:
        if self.fail == op:
            raise ClientError({"Error": {"Code": "ThrottlingException"}}, op)

    def create_oauth2_credential_provider(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("create", kwargs))
        self._maybe_fail("create")
        name = kwargs["name"]
        self.providers[name] = kwargs
        return {
            "name": name,
            "credentialProviderArn": (
                f"arn:aws:bedrock-agentcore:us-east-1:111111111111:token-vault/default/"
                f"oauth2credentialprovider/{name}"
            ),
            "callbackUrl": CALLBACK,
        }

    def update_oauth2_credential_provider(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("update", kwargs))
        self._maybe_fail("update")
        self.providers[kwargs["name"]] = {**self.providers[kwargs["name"]], **kwargs}
        return {}

    def delete_oauth2_credential_provider(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("delete", kwargs))
        self._maybe_fail("delete")
        if self.providers.pop(kwargs["name"], None) is None:
            raise ClientError({"Error": {"Code": "ResourceNotFoundException"}}, "Delete")
        return {}


@dataclass
class FakeCloudFormation:
    tags: list[dict[str, str]] = field(
        default_factory=lambda: [
            {"Key": "project", "Value": "mango"},
            {"Key": "mango:namespace", "Value": "spoof"},
        ]
    )

    def describe_stacks(self, StackName: str) -> dict[str, Any]:  # noqa: N803
        return {"Stacks": [{"StackId": StackName, "Tags": self.tags}]}


@dataclass
class FakeKms:
    key: ec.EllipticCurvePrivateKey = field(
        default_factory=lambda: ec.generate_private_key(ec.SECP256R1())
    )

    def get_public_key(self, KeyId: str) -> dict[str, Any]:  # noqa: N803
        assert KeyId == "alias/Mango-test-remote-mcp"
        return {
            "PublicKey": self.key.public_key().public_bytes(
                serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
            )
        }


# --- The release ----------------------------------------------------------------------------


def _statement() -> RemoteProfileStatement:
    folder = REPO / "remotes" / PROFILE
    return RemoteProfileStatement.model_validate(
        {
            "schema_version": 1,
            "profile": yaml.safe_load((folder / "profile.yaml").read_text()),
            "tool_schema": json.loads((folder / "tool-schema.json").read_text()),
            "source_revision": "f" * 40,
        }
    )


def _ship(s3: Any, signer: Signer, statement: RemoteProfileStatement | None) -> ReleaseRemotes:
    catalog: dict[str, str] = {}
    if statement is not None:
        payload = statement.payload()
        signature = signer.key.sign(
            signed_message(payload, PAYLOAD_TYPE), ec.ECDSA(hashes.SHA256())
        )
        digest = sha256_hex(payload)
        s3.put_object(
            Bucket=BUCKET,
            Key=statement_key(PROFILE, digest),
            Body=build_envelope(statement, "test-key", signature),
        )
        catalog[PROFILE] = digest
    return ReleaseRemotes(
        s3,
        bucket=BUCKET,
        bucket_owner=ACCOUNT,
        catalog=parse_remote_catalog(json.dumps(catalog)),
        public_key_pem=signer.pem,
    )


@dataclass
class Env:
    client: TestClient
    db: Any
    s3: Any
    audit: RecordingAudit
    cedar: CedarPolicyStore
    identity: FakeIdentity
    sfn: FakeStepFunctions
    kms: FakeKms
    signer: Signer
    deps: RemoteMcpDeps
    now: list[datetime]
    responses: list[str] = field(default_factory=list)

    def call(self, method: str, url: str, token: str = "admin", **body: Any) -> Any:
        kwargs: dict[str, Any] = {"headers": {"Authorization": f"Bearer {token}"}}
        if method != "GET":
            kwargs["json"] = body
        response = self.client.request(method, url, **kwargs)
        self.responses.append(response.text)
        return response

    def ship(self, statement: RemoteProfileStatement | None) -> None:
        self.deps.release = _ship(self.s3, self.signer, statement)


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=BUCKET)
        _table(db, "settings")
        create_agents_table(db, "agents")
        _group(db, "hr", "general")
        _group(db, "ops", "general")
        _models(db)
        audit, cedar = RecordingAudit(), CedarPolicyStore()
        sfn, identity, kms, signer = FakeStepFunctions(), FakeIdentity(), FakeKms(), Signer()
        authorizer = Authorizer(cedar, "ps")  # type: ignore[arg-type]
        registry = GroupRegistry(db, "settings")
        connectors = McpCatalog.load(CONNECTORS)
        source = CatalogSource(lambda: connectors, None, None)
        now = [datetime(2026, 10, 27, 15, 0, tzinfo=UTC)]
        agents_store = AgentsStore(db, "agents")
        published = PublishedAgents(
            agents_store, source, namespace="test", region="us-east-1", clock=time.time
        )
        agents = AgentsDeps(
            store=agents_store,
            audit=audit,  # type: ignore[arg-type]
            authorizer=authorizer,
            groups=registry,
            models=ModelCatalogStore(db, "settings"),
            catalog=source,
            provisioner=ProvisionerClient(FakeStepFunctions(), STATE_MACHINE),  # type: ignore[arg-type]
            clock=lambda: now[0],
            published=published,
        )
        deps = RemoteMcpDeps(
            release=_ship(s3, signer, _statement()),
            store=RemoteStore(db, "settings"),
            groups=registry,
            authorizer=authorizer,
            audit=audit,  # type: ignore[arg-type]
            clock=lambda: now[0],
            namespace="test",
            enabled=True,
            identity=IdentityProviders(
                identity, StackTags(FakeCloudFormation(), "stack-id"), "test"
            ),
            approved=ApprovedRemotes(
                db, "settings", kms, key_id="alias/Mango-test-remote-mcp", gateway_id=GATEWAY_ID
            ),
            provisioner=RemoteProvisionerClient(sfn, REMOTE_MACHINE),  # type: ignore[arg-type]
            rate_limiter=RateLimiter(limit=1000, window_seconds=60),
        )
        monkeypatch.setattr("mango_api.remote_mcp_store.APPROVED_CACHE_SECONDS", 0)

        def factory(s: Any) -> app_module.Services:
            return app_module.Services(
                settings=s,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=authorizer,
                budgets=FakeBudgets(),  # type: ignore[arg-type]
                conversations=FakeConversations(),  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=FakeAgentCore(),
                bedrock=FakeBedrock(),
                settings_store=None,  # type: ignore[arg-type]
                budget_limits=FakeLimits(),  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=published,
                model_catalog=ModelCatalogCache(ModelCatalogStore(db, "settings"), ttl_seconds=0),
                invocation_key=b"k" * 32,
                group_registry=registry,
                agents=agents,
                remote_mcp=deps,
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(client, db, s3, audit, cedar, identity, sfn, kms, signer, deps, now)
        assert cedar.errors == []


# --- Helpers ------------------------------------------------------------------------------


def _code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def _body(**overrides: Any) -> dict[str, Any]:
    return {
        "organization": "Contoso",
        "tenant_id": TENANT,
        "client_id": CLIENT,
        "client_secret": SECRET,
        "secret_expires_on": "2027-06-30",
        "toolsets": ["wit", "wiki"],
        "groups": ["hr"],
        "reason": "Read work items",
        **overrides,
    }


def _register(env: Env, token: str = "admin", **overrides: Any) -> dict[str, Any]:
    response = env.call("POST", f"{URL}/{PROFILE}/registrations", token, **_body(**overrides))
    assert response.status_code == 201, response.text
    organization = _body(**overrides)["organization"]
    (registration,) = [
        r for r in response.json()["registrations"] if r["organization"] == organization
    ]
    result: dict[str, Any] = registration
    return result


def _catalog(env: Env, token: str = "admin") -> dict[str, Any]:
    response = env.call("GET", URL, token)
    assert response.status_code == 200, response.text
    result: dict[str, Any] = response.json()
    return result


def _reg(env: Env, reg: str, token: str = "admin") -> dict[str, Any]:
    (found,) = [r for r in _catalog(env, token)["registrations"] if r["id"] == reg]
    result: dict[str, Any] = found
    return result


def _decide(env: Env, reg: str, decision: str, token: str = "admin2", **body: Any) -> Any:
    change = _reg(env, reg)["pending"]["id"]
    url = f"{URL}/registrations/{reg}/requests/{change}/{decision}"
    return env.call("POST", url, token, **body)


def _set_status(env: Env, reg: str, status: str) -> None:
    """What the remote provisioner writes."""
    env.db.update_item(
        TableName="settings",
        Key=registration_key(reg),
        UpdateExpression="SET #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": {"S": status}},
    )


def _active(env: Env, **overrides: Any) -> dict[str, Any]:
    reg = _register(env, **overrides)["id"]
    assert _decide(env, reg, "approve").status_code == 200
    _set_status(env, reg, "active")
    return _reg(env, reg)


def _item(env: Env, key: dict[str, Any]) -> dict[str, Any] | None:
    item: dict[str, Any] | None = env.db.get_item(TableName="settings", Key=key).get("Item")
    return item


# --- Catalog ------------------------------------------------------------------------------


def test_the_catalog_lists_the_signed_profile_of_the_release(env: Env) -> None:
    body = _catalog(env, "creator")
    assert body["enabled"] is True
    (profile,) = body["profiles"]
    assert profile["id"] == PROFILE
    assert profile["host"] == "mcp.dev.azure.com"
    assert profile["enabled_in_installation"] is True
    toolsets = {t["id"]: t for t in profile["toolsets"]}
    assert toolsets["core"]["always"] is True
    assert "search_code" in toolsets["search-code"]["tools"]
    assert body["registrations"] == []


def test_a_profile_that_does_not_verify_is_left_out(env: Env) -> None:
    env.deps.release = ReleaseRemotes(
        env.s3,
        bucket=BUCKET,
        bucket_owner=ACCOUNT,
        catalog=parse_remote_catalog(json.dumps({PROFILE: "0" * 64})),
        public_key_pem=env.signer.pem,
    )
    assert _catalog(env)["profiles"] == []
    response = env.call("POST", f"{URL}/{PROFILE}/registrations", **_body())
    assert (response.status_code, _code(response)) == (409, "remote_profile_not_in_release")
    assert env.identity.calls == []


def test_only_administrators_see_the_app_and_others_only_their_groups(env: Env) -> None:
    reg = _active(env)["id"]
    admin = _reg(env, reg)
    assert admin["tenant_id"] == TENANT and admin["callback_url"] == CALLBACK
    creator = _reg(env, reg, "creator")  # an agent creator in `hr`
    assert creator["tenant_id"] is None and creator["callback_url"] is None
    assert creator["pending"] is None and creator["requested_by"] is None
    # Not in the registration's groups: the organization is not even listed.
    assert _catalog(env, "creator2")["registrations"] == []
    # The catalog is for administrators and agent creators (`ViewMcpCatalog`).
    assert env.call("GET", URL, "member").status_code == 403


# --- Asking -------------------------------------------------------------------------------


def test_a_request_creates_the_provider_with_the_secret_and_waits(env: Env) -> None:
    registration = _register(env)
    reg = registration["id"]
    assert registration["status"] == "pending"
    # The `core` toolset is always on; at least one toolset has a header value.
    assert registration["toolsets"] == ["core", "wiki", "wit"]
    ((op, call),) = env.identity.calls
    assert op == "create"
    assert call["name"] == f"Mango-test-remote-{reg}-g1"
    assert call["credentialProviderVendor"] == "MicrosoftOauth2"
    assert call["oauth2ProviderConfigInput"] == {
        "microsoftOauth2ProviderConfig": {
            "clientId": CLIENT,
            "clientSecret": SECRET,
            "tenantId": TENANT,
        }
    }
    # The stack's tags (D76), never overriding Mango's own.
    assert call["tags"] == {
        "project": "mango",
        "mango:namespace": "test",
        "mango:component": "remote-mcp",
        "mango:remote": reg,
    }
    pending = _reg(env, reg)["pending"]
    assert pending["kind"] == "enable" and pending["callback_url"] == CALLBACK
    assert pending["own"] is True
    ((_, detail),) = env.audit.named("mcp_remote.request")
    assert detail["registration"] == reg and detail["tenant_id"] == TENANT


def test_the_secret_appears_in_no_response_log_audit_or_item(
    env: Env, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    reg = _active(env)["id"]
    env.call(
        "POST",
        f"{URL}/registrations/{reg}/secret",
        version=_reg(env, reg)["version"],
        client_secret=NEW_SECRET,
        secret_expires_on="2027-12-31",
    )
    env.call(
        "POST",
        f"{URL}/registrations/{reg}/requests",
        kind="replace_app",
        version=_reg(env, reg)["version"],
        tenant_id=TENANT,
        client_id=CLIENT,
        client_secret=SECRET,
        secret_expires_on="2027-06-30",
    )
    # A refused body never repeats a value either.
    env.call("POST", f"{URL}/{PROFILE}/registrations", **_body(organization="bad org!"))
    env.call("POST", f"{URL}/{PROFILE}/registrations", **_body(client_secret="x" * 513 + SECRET))
    items = env.db.scan(TableName="settings")["Items"]
    for secret in (SECRET, NEW_SECRET):
        assert all(secret not in text for text in env.responses)
        assert secret not in json.dumps(env.audit.events)
        assert secret not in json.dumps(items)
        assert secret not in caplog.text
    assert [op for op, _ in env.identity.calls] == ["create", "update", "create"]


def test_who_asks_does_not_approve(env: Env) -> None:
    reg = _register(env)["id"]
    response = _decide(env, reg, "approve", "admin")
    assert (response.status_code, _code(response)) == (403, "same_approver")
    response = _decide(env, reg, "approve", "member")
    assert response.status_code == 403
    assert env.sfn.executions == []


def test_another_administrator_approves_and_the_provisioner_starts(env: Env) -> None:
    reg = _register(env)["id"]
    response = _decide(env, reg, "approve")
    assert response.status_code == 200, response.text
    item = _item(env, registration_key(reg))
    assert item is not None
    assert item["status"]["S"] == "approved"
    assert item["generation"]["N"] == "1"
    assert item["provider_name"]["S"] == f"Mango-test-remote-{reg}-g1"
    assert item["change_kind"]["S"] == "enable"
    assert "client_secret" not in item
    ((execution),) = env.sfn.executions
    assert execution["stateMachineArn"] == REMOTE_MACHINE
    assert json.loads(execution["input"]) == {
        "approval_id": item["approval_id"]["S"],
        "registration_id": reg,
    }
    assert env.audit.named("mcp_remote.approve")


@pytest.mark.parametrize("decision", ["reject", "withdraw"])
def test_rejecting_or_withdrawing_deletes_the_provider_and_the_registration(
    env: Env, decision: str
) -> None:
    reg = _register(env)["id"]
    if decision == "reject":
        response = _decide(env, reg, "reject", "admin2")
        assert response.status_code == 422  # a reason is required
        response = _decide(env, reg, "reject", "admin", reason="no")
        assert (response.status_code, _code(response)) == (403, "use_withdraw")
        response = _decide(env, reg, "reject", "admin2", reason="Not this tenant")
    else:
        response = _decide(env, reg, "withdraw", "admin2")
        assert (response.status_code, _code(response)) == (403, "not_requester")
        response = _decide(env, reg, "withdraw", "admin")
    assert response.status_code == 200, response.text
    assert env.identity.providers == {}
    assert _item(env, registration_key(reg)) is None
    assert _item(env, organization_key(PROFILE, "contoso")) is None
    assert response.json()["registrations"] == []
    # The organization can be asked for again.
    assert _register(env)["id"] != reg


def test_a_duplicate_organization_is_refused_before_creating_anything(env: Env) -> None:
    _register(env)
    response = env.call("POST", f"{URL}/{PROFILE}/registrations", **_body(organization="contoso"))
    assert (response.status_code, _code(response)) == (409, "remote_exists")
    assert len(env.identity.providers) == 1


def test_a_request_that_cannot_be_recorded_leaves_no_provider(env: Env) -> None:
    store = env.deps.store

    def fail(_change: Any) -> None:
        raise ClientError({"Error": {"Code": "InternalServerError"}}, "TransactWriteItems")

    env.deps.store.create_registration = fail  # type: ignore[method-assign]
    with pytest.raises(ClientError):
        env.call("POST", f"{URL}/{PROFILE}/registrations", **_body())
    assert env.identity.providers == {}
    assert [op for op, _ in env.identity.calls] == ["create", "delete"]
    assert env.audit.named("mcp_remote.request", "rejected")
    assert store.registrations() == []


def test_identity_down_answers_502_and_records_nothing(env: Env) -> None:
    env.identity.fail = "create"
    response = env.call("POST", f"{URL}/{PROFILE}/registrations", **_body())
    assert (response.status_code, _code(response)) == (502, "identity_unavailable")
    assert env.deps.store.registrations() == []


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"toolsets": []}, "toolsets_required"),
        ({"toolsets": ["core"]}, "toolsets_required"),
        ({"toolsets": ["admin"]}, "invalid_toolsets"),
        ({"groups": ["nobody"]}, "group_unknown"),
        ({"secret_expires_on": "2026-10-27"}, "invalid_secret_expiry"),
        ({"secret_expires_on": "2029-01-01"}, "invalid_secret_expiry"),
        ({"organization": "contoso.visualstudio.com"}, "invalid_request"),
        ({"tenant_id": "not-a-guid"}, "invalid_request"),
        ({"host": "evil.example"}, "invalid_request"),
    ],
)
def test_a_request_names_only_what_the_profile_allows(
    env: Env, overrides: dict[str, Any], code: str
) -> None:
    response = env.call("POST", f"{URL}/{PROFILE}/registrations", **_body(**overrides))
    assert (response.status_code, _code(response)) == (422, code)
    assert env.identity.calls == []


def test_only_administrators_ask(env: Env) -> None:
    response = env.call("POST", f"{URL}/{PROFILE}/registrations", "creator", **_body())
    assert response.status_code == 403
    assert env.identity.calls == []


def test_live_registrations_are_capped(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("mango_api.remote_mcp.MAX_LIVE_REGISTRATIONS", 1)
    _register(env)
    response = env.call("POST", f"{URL}/{PROFILE}/registrations", **_body(organization="other"))
    assert (response.status_code, _code(response)) == (409, "too_many_remotes")


# --- On a registration --------------------------------------------------------------------


def test_a_new_app_is_a_request_on_the_same_registration(env: Env) -> None:
    registration = _active(env)
    reg = registration["id"]
    response = env.call(
        "POST",
        f"{URL}/registrations/{reg}/requests",
        kind="replace_app",
        version=registration["version"],
        tenant_id=TENANT,
        client_id="00000000-0000-0000-0000-00000000000c",
        client_secret=NEW_SECRET,
        secret_expires_on="2027-06-30",
    )
    assert response.status_code == 201, response.text
    after = _reg(env, reg)
    assert after["status"] == "active"  # the current app serves until approved
    assert after["pending"]["kind"] == "replace_app"
    assert sorted(env.identity.providers) == [
        f"Mango-test-remote-{reg}-g1",
        f"Mango-test-remote-{reg}-g2",
    ]
    assert _decide(env, reg, "approve").status_code == 200
    item = _item(env, registration_key(reg))
    assert item is not None
    assert item["generation"]["N"] == "2"
    assert item["client_id"]["S"].endswith("c")
    assert item["change_kind"]["S"] == "replace_app"
    assert len(env.deps.store.registrations()) == 1


def test_a_provider_name_is_never_used_twice(env: Env) -> None:
    registration = _active(env)
    reg = registration["id"]

    def ask() -> None:
        response = env.call(
            "POST",
            f"{URL}/registrations/{reg}/requests",
            kind="replace_app",
            version=_reg(env, reg)["version"],
            tenant_id=TENANT,
            client_id=CLIENT,
            client_secret=NEW_SECRET,
            secret_expires_on="2027-06-30",
        )
        assert response.status_code == 201, response.text

    ask()
    assert _decide(env, reg, "withdraw", "admin").status_code == 200
    ask()
    names = [call["name"] for op, call in env.identity.calls if op == "create"]
    assert names == [f"Mango-test-remote-{reg}-g{n}" for n in (1, 2, 3)]


def test_a_request_that_expired_undecided_loses_its_provider(env: Env) -> None:
    registration = _active(env)
    reg = registration["id"]

    def replace_app() -> Any:
        return env.call(
            "POST",
            f"{URL}/registrations/{reg}/requests",
            kind="replace_app",
            version=_reg(env, reg)["version"],
            tenant_id=TENANT,
            client_id=CLIENT,
            client_secret=NEW_SECRET,
            secret_expires_on="2027-06-30",
        )

    assert replace_app().status_code == 201
    env.now[0] += timedelta(days=8)
    assert _reg(env, reg)["pending"] is None
    assert replace_app().status_code == 201
    assert sorted(env.identity.providers) == [
        f"Mango-test-remote-{reg}-g1",
        f"Mango-test-remote-{reg}-g3",
    ]
    statuses = sorted(c["status"] for c in _reg(env, reg)["history"])
    assert statuses == ["approved", "cancelled"]


def test_one_pending_request_per_registration(env: Env) -> None:
    registration = _active(env)
    reg = registration["id"]
    body = {"version": registration["version"], "toolsets": ["wit"], "groups": ["hr"]}
    assert env.call("POST", f"{URL}/registrations/{reg}/params", **body).status_code == 201
    response = env.call("POST", f"{URL}/registrations/{reg}/params", **body)
    assert (response.status_code, _code(response)) == (409, "pending_exists")


def test_changing_toolsets_or_groups_keeps_the_provider(env: Env) -> None:
    registration = _active(env)
    reg = registration["id"]
    response = env.call(
        "POST",
        f"{URL}/registrations/{reg}/params",
        version=registration["version"],
        toolsets=registration["toolsets"],
        groups=["hr"],
    )
    assert (response.status_code, _code(response)) == (422, "no_change")
    response = env.call(
        "POST",
        f"{URL}/registrations/{reg}/params",
        version=registration["version"],
        toolsets=["pipelines"],
        groups=["hr", "ops"],
    )
    assert response.status_code == 201, response.text
    pending = _reg(env, reg)["pending"]
    assert pending["previous_toolsets"] == ["core", "wiki", "wit"]
    assert pending["toolsets"] == ["core", "pipelines"]
    assert pending["previous_groups"] == ["hr"]
    assert [op for op, _ in env.identity.calls] == ["create"]
    assert _decide(env, reg, "approve").status_code == 200
    item = _item(env, registration_key(reg))
    assert item is not None
    assert item["generation"]["N"] == "1"
    assert [v["S"] for v in item["groups"]["L"]] == ["hr", "ops"]


def test_rotating_the_secret_needs_no_approval(env: Env) -> None:
    registration = _active(env)
    reg = registration["id"]
    executions = len(env.sfn.executions)
    response = env.call(
        "POST",
        f"{URL}/registrations/{reg}/secret",
        version=registration["version"],
        client_secret=NEW_SECRET,
        secret_expires_on="2026-11-02",
    )
    assert response.status_code == 200, response.text
    after = _reg(env, reg)
    assert after["secret_expires_on"] == "2026-11-02"
    assert after["secret_level"] == "d7"
    assert after["version"] == registration["version"] + 1
    op, call = env.identity.calls[-1]
    assert op == "update" and call["name"] == f"Mango-test-remote-{reg}-g1"
    assert call["oauth2ProviderConfigInput"]["microsoftOauth2ProviderConfig"]["clientSecret"] == (
        NEW_SECRET
    )
    assert len(env.sfn.executions) == executions
    ((_, detail),) = env.audit.named("mcp_remote.secret_rotated")
    assert detail["secret_expires_on"] == "2026-11-02"


def test_disabling_cancels_the_pending_request_and_starts_the_provisioner(env: Env) -> None:
    registration = _active(env)
    reg = registration["id"]
    env.call(
        "POST",
        f"{URL}/registrations/{reg}/requests",
        kind="replace_app",
        version=registration["version"],
        tenant_id=TENANT,
        client_id=CLIENT,
        client_secret=NEW_SECRET,
        secret_expires_on="2027-06-30",
    )
    response = env.call("DELETE", f"{URL}/registrations/{reg}", version=registration["version"])
    assert response.status_code == 422  # a reason is required
    response = env.call(
        "DELETE", f"{URL}/registrations/{reg}", version=registration["version"], reason="Done"
    )
    assert response.status_code == 200, response.text
    after = _reg(env, reg)
    assert after["status"] == "disabling" and after["pending"] is None
    statuses = {c["kind"]: c["status"] for c in after["history"]}
    assert statuses == {"enable": "approved", "replace_app": "cancelled"}
    # The cancelled request's provider is gone; the active one is the provisioner's to delete.
    assert list(env.identity.providers) == [f"Mango-test-remote-{reg}-g1"]
    item = _item(env, registration_key(reg))
    assert item is not None
    assert json.loads(env.sfn.executions[-1]["input"])["approval_id"] == item["approval_id"]["S"]


def test_a_failed_registration_is_retried_with_the_same_approval(env: Env) -> None:
    reg = _register(env)["id"]
    _decide(env, reg, "approve")
    _set_status(env, reg, "failed")
    version = _reg(env, reg)["version"]
    response = env.call("POST", f"{URL}/registrations/{reg}/retry", version=version)
    assert response.status_code == 200, response.text
    first, second = (json.loads(e["input"]) for e in env.sfn.executions)
    assert first == second
    assert _reg(env, reg)["status"] == "approved"
    response = env.call("POST", f"{URL}/registrations/{reg}/retry", version=version + 1)
    assert (response.status_code, _code(response)) == (409, "busy")


def test_a_disabled_registration_is_asked_for_again_with_a_new_app(env: Env) -> None:
    reg = _register(env)["id"]
    _decide(env, reg, "approve")
    _set_status(env, reg, "disabled")
    response = env.call(
        "POST",
        f"{URL}/registrations/{reg}/requests",
        kind="enable",
        version=_reg(env, reg)["version"],
        tenant_id=TENANT,
        client_id=CLIENT,
        client_secret=NEW_SECRET,
        secret_expires_on="2027-06-30",
        toolsets=["wiki"],
        groups=["ops"],
    )
    assert response.status_code == 201, response.text
    assert _reg(env, reg)["pending"]["groups"] == ["ops"]
    # Rejecting it keeps the registration: it was approved once.
    assert _decide(env, reg, "reject", reason="Later").status_code == 200
    assert _reg(env, reg)["status"] == "disabled"


def test_the_release_changing_blocks_the_approval(env: Env) -> None:
    reg = _register(env)["id"]
    env.ship(None)
    response = _decide(env, reg, "approve")
    assert (response.status_code, _code(response)) == (409, "release_changed")


def test_a_stale_version_is_a_conflict(env: Env) -> None:
    registration = _active(env)
    response = env.call(
        "POST",
        f"{URL}/registrations/{registration['id']}/secret",
        version=registration["version"] + 1,
        client_secret=NEW_SECRET,
        secret_expires_on="2027-06-30",
    )
    assert (response.status_code, _code(response)) == (409, "version_conflict")


# --- Off by default (D98 (4)) ------------------------------------------------------------


def test_with_the_parameter_off_every_write_is_refused(env: Env) -> None:
    reg = _register(env)["id"]
    env.deps.enabled = False
    body = _catalog(env)
    assert body["enabled"] is False
    assert body["profiles"][0]["enabled_in_installation"] is False
    response = env.call("POST", f"{URL}/{PROFILE}/registrations", **_body(organization="other"))
    assert (response.status_code, _code(response)) == (409, "remote_disabled")
    response = _decide(env, reg, "approve")
    assert (response.status_code, _code(response)) == (409, "remote_disabled")
    assert env.sfn.executions == []


# --- Routing ------------------------------------------------------------------------------


def test_remotes_is_never_taken_by_the_packs_router(env: Env) -> None:
    assert not is_pack_id("remotes")
    assert env.call("GET", URL).status_code == 200
    # `/api/mcp/{pack}/params` of packs: `remotes` is not a pack there.
    response = env.call("POST", f"{URL}/params", version=0, config={})
    assert response.status_code >= 400
    assert env.audit.named("mcp.pack.request.proposed", None) == []


# --- The approved catalog -----------------------------------------------------------------


def test_the_tools_served_come_from_the_signed_approved_catalog(env: Env) -> None:
    reg = _active(env)["id"]
    assert _reg(env, reg)["tools"] == []
    approved = ApprovedRemote(
        registration_id=reg,
        generation=1,
        revision=1,
        profile_id=PROFILE,
        profile_version="2026.10.27-1",
        profile_sha256="a" * 64,
        gateway_id=GATEWAY_ID,
        organization="Contoso",
        toolsets=("core", "wiki", "wit"),
        toolsets_header="wit,wiki",
        tools=frozenset({"core_list_projects", "wiki"}),
        probe_tool="core_list_projects",
        issued_at=1,
    )
    payload = approved.encode()
    signature = env.kms.key.sign(b"mango.remote-mcp.v1\n" + payload, ec.ECDSA(hashes.SHA256()))
    fields = item_fields(payload, signature)
    item = {**approved_key(reg), **{k: {"S": v} for k, v in fields.items()}}
    env.db.put_item(TableName="settings", Item=item)
    assert _reg(env, reg)["tools"] == ["core_list_projects", "wiki"]
    # Altered: it no longer counts.
    raw = base64.b64decode(fields["signature"])
    tampered = base64.b64encode(raw[:-1] + bytes([raw[-1] ^ 1])).decode()
    env.db.put_item(TableName="settings", Item={**item, "signature": {"S": tampered}})
    assert _reg(env, reg)["tools"] == []


# --- Units --------------------------------------------------------------------------------


def test_secret_levels() -> None:
    today = date(2026, 10, 27)
    assert secret_level(None, today) is None
    assert secret_level("2027-01-01", today) == "ok"
    assert secret_level((today + timedelta(days=30)).isoformat(), today) == "d30"
    assert secret_level((today + timedelta(days=7)).isoformat(), today) == "d7"
    assert secret_level(today.isoformat(), today) == "d7"
    assert secret_level((today - timedelta(days=1)).isoformat(), today) == "expired"


def test_stack_tags_follow_the_provisioners_rules() -> None:
    tags = [{"Key": "Mango:Namespace", "Value": "x"}, {"Key": "a", "Value": "b"}]
    assert dict(custom_tags(tags)) == {"a": "b"}
    with pytest.raises(StackTagError):
        custom_tags([{"Key": "A", "Value": "1"}, {"Key": "a", "Value": "2"}])
    with pytest.raises(StackTagError):
        custom_tags([{"Key": "bad\nkey", "Value": "1"}])
