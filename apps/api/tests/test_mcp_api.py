"""MCP catalog API (Marketplace B3): real Cedar policies, moto (DynamoDB, S3), a pack signed
with a test key and a recording audit. The pack provisioner is played by the same item
builders it uses (``mango_packs.enablement``)."""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api import mcp as mcp_module
from mango_api.agents import AgentsDeps
from mango_api.agents_store import AgentsStore
from mango_api.authz import Authorizer
from mango_api.groups import GroupRegistry
from mango_api.mcp import McpDeps
from mango_api.mcp_catalog import CatalogSource, McpCatalog
from mango_api.mcp_store import (
    ChangeKind,
    ChangeStatus,
    PackChange,
    PackConflictError,
    PackStore,
)
from mango_api.model_catalog import ModelCatalogCache, ModelCatalogStore
from mango_api.pack_release import (
    PackReleaseUnavailableError,
    ReleasePacks,
    envelope_key,
    parse_catalog,
)
from mango_api.probe import RateLimiter
from mango_api.provisioner import PackProvisionerClient, ProvisionerClient
from mango_api.published import PublishedAgents
from mango_packs.canonical import sha256_hex
from mango_packs.enablement import (
    begin_item,
    disabled_items,
    enabled_items,
    enablement_key,
    fail_item,
    unlock_item,
)
from mango_packs.signing import PackStatement, build_envelope, signed_message

from .cedar_fake import CedarPolicyStore
from .test_admin import RecordingAudit, _table
from .test_agents_api import (
    CONNECTORS,
    STATE_MACHINE,
    TOKENS,
    FakeStepFunctions,
    FakeVerifier,
    _approve,
    _create,
    _group,
    _models,
    _publish,
    _submit,
)
from .test_agents_api import Env as AgentsEnv
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

PACK = "aws-pricing"
V1, V2 = "1.1.1-1", "1.1.1-2"
BUCKET = "mango-test-packs"
ACCOUNT = "123456789012"
PACK_MACHINE = "arn:aws:states:us-east-1:111111111111:stateMachine:Mango-test-PackProvisioner"
URL = "/api/mcp/catalog"
TOOLS = ["get_pricing", "get_pricing_service_codes"]
PRICING_ACTIONS = ["pricing:DescribeServices", "pricing:GetProducts"]
PRICING_TOOL = f"{PACK}.get_pricing"
XSS = "<img src=x onerror=alert(1)>"


# --- A release with signed packs ----------------------------------------------------------


def _manifest(pack_id: str = PACK, version: str = V1, **overrides: Any) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "id": pack_id,
        "version": version,
        "name": "AWS Pricing",
        "description": "Public AWS list prices.",
        "source": {
            "package": "awslabs.aws-pricing-mcp-server",
            "version": "1.1.1",
            "sha256": "a" * 64,
            "exclude_newer": "2026-09-01T00:00:00Z",
        },
        "data_tier": "public",
        "identity_mode": "service",
        "iam": [{"actions": PRICING_ACTIONS, "resources": ["*"], "reason": "No ARNs."}],
        "egress": {"aws": ["pricing"]},
        "tools": [{"name": name, "access": "read"} for name in TOOLS],
        "tools_hash": "sha256:" + "b" * 64,
        "config": [
            {
                "key": "region",
                "allowed": ["us-east-1", "eu-central-1"],
                "default": "us-east-1",
                "description": "Pricing endpoint",
            }
        ],
        **overrides,
    }


@dataclass
class Signer:
    key: ec.EllipticCurvePrivateKey = field(
        default_factory=lambda: ec.generate_private_key(ec.SECP256R1())
    )

    @property
    def pem(self) -> str:
        return (
            self.key.public_key()
            .public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
            )
            .decode()
        )

    def envelope(self, manifest: dict[str, Any]) -> tuple[bytes, str]:
        """Signed envelope of ``manifest`` and the digest of its statement."""
        name = f"{manifest['id']}-{manifest['version']}"
        statement = PackStatement.model_validate(
            {
                "schema_version": 1,
                "manifest": manifest,
                "artifact": {"file": f"{name}.zip", "sha256": "c" * 64, "size": 10},
                "sbom": {"file": f"{name}.sbom.cdx.json", "sha256": "d" * 64, "size": 10},
                "lock_sha256": "e" * 64,
                "source_revision": "f" * 40,
            }
        )
        payload = statement.payload()
        signature = self.key.sign(signed_message(payload), ec.ECDSA(hashes.SHA256()))
        return build_envelope(statement, "test-key", signature), sha256_hex(payload)


def _ship(
    s3: Any, signer: Signer, *manifests: dict[str, Any], key: str | None = None
) -> ReleasePacks:
    """Put the signed packs in the bucket and name them in the release catalog."""
    catalog: dict[str, dict[str, str]] = {}
    for manifest in manifests:
        envelope, digest = signer.envelope(manifest)
        s3.put_object(
            Bucket=BUCKET, Key=envelope_key(manifest["id"], manifest["version"]), Body=envelope
        )
        catalog[manifest["id"]] = {"version": manifest["version"], "statement_sha256": digest}
    return ReleasePacks(
        s3,
        bucket=BUCKET,
        bucket_owner=ACCOUNT,
        catalog=parse_catalog(json.dumps(catalog)),
        public_key_pem=signer.pem if key is None else key,
    )


@dataclass
class Env(AgentsEnv):
    s3: Any
    signer: Signer
    source: CatalogSource
    store: PackStore
    pack_sfn: FakeStepFunctions
    mcp: McpDeps
    published: PublishedAgents

    def ship(self, *manifests: dict[str, Any]) -> None:
        """A stack update: the release names other signed statements."""
        self.source._release = _ship(self.s3, self.signer, *manifests)


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
        _models(db)
        audit, cedar = RecordingAudit(), CedarPolicyStore()
        sfn, pack_sfn = FakeStepFunctions(), FakeStepFunctions()
        authorizer = Authorizer(cedar, "ps")  # type: ignore[arg-type]
        registry = GroupRegistry(db, "settings")
        connectors = McpCatalog.load(CONNECTORS)
        signer = Signer()
        store = PackStore(db, "settings")
        source = CatalogSource(lambda: connectors, _ship(s3, signer, _manifest()), store)
        # No cache between requests: a test changes the state and asks again at once.
        monkeypatch.setattr("mango_api.mcp_catalog.PACK_STATE_SECONDS", 0)
        monkeypatch.setattr("mango_api.published.CACHE_SECONDS", 0)
        now = [datetime(2026, 10, 1, 15, 0, tzinfo=UTC)]
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
            provisioner=ProvisionerClient(sfn, STATE_MACHINE),  # type: ignore[arg-type]
            clock=lambda: now[0],
            published=published,
        )
        mcp = McpDeps(
            catalog=source,
            agents=agents_store,
            audit=audit,  # type: ignore[arg-type]
            clock=lambda: now[0],
            store=store,
            provisioner=PackProvisionerClient(pack_sfn, PACK_MACHINE),  # type: ignore[arg-type]
            rate_limiter=RateLimiter(limit=1000, window_seconds=60),
        )

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
                mcp=mcp,
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(
            client,
            db,
            audit,
            cedar,
            sfn,
            agents,
            now,
            s3=s3,
            signer=signer,
            source=source,
            store=store,
            pack_sfn=pack_sfn,
            mcp=mcp,
            published=published,
        )
        # Every request and entity fitted the schema (same check as Verified Permissions).
        assert cedar.errors == []


# --- Helpers ------------------------------------------------------------------------------


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def _item(body: dict[str, Any], server_id: str = PACK) -> dict[str, Any]:
    found = [item for item in body["items"] if item["id"] == server_id]
    assert len(found) == 1, body
    result: dict[str, Any] = found[0]
    return result


def _pack(env: Env, token: str = "admin", pack_id: str = PACK) -> dict[str, Any]:
    response = env.client.get(URL, headers=_h(token))
    assert response.status_code == 200, response.text
    return _item(response.json(), pack_id)


def _lock(env: Env, pack_id: str = PACK) -> int:
    return int(_pack(env, pack_id=pack_id)["pack"]["lock_version"])


def _request(env: Env, token: str = "admin", path: str = "enablements", **body: Any) -> Any:
    body.setdefault("version", _lock(env))
    return env.client.post(f"/api/mcp/{PACK}/{path}", headers=_h(token), json=body)


def _pending_id(env: Env) -> str:
    return str(_pack(env)["pack"]["pending"]["change_id"])


def _decide(env: Env, decision: str, token: str = "admin2", **body: Any) -> Any:
    url = f"/api/mcp/{PACK}/enablements/{_pending_id(env)}/{decision}"
    return env.client.post(url, headers=_h(token), json=body)


def _approved(env: Env, path: str = "enablements", **body: Any) -> None:
    """A request of ``admin`` that ``admin2`` approved."""
    assert _request(env, path=path, **body).status_code == 201
    response = _decide(env, "approve")
    assert response.status_code == 200, response.text


def _raw(env: Env, pack_id: str = PACK) -> dict[str, Any]:
    item: dict[str, Any] = env.db.get_item(TableName="settings", Key=enablement_key(pack_id))[
        "Item"
    ]
    return item


def _begin(env: Env, *, disable: bool = False, owner: str = "exec-1") -> None:
    """The provisioner takes the pack (``load``)."""
    raw = _raw(env)
    env.db.update_item(
        **begin_item(
            "settings",
            pack_id=PACK,
            enablement_id=raw["enablement_id"]["S"],
            pack_version=raw["pack_version"]["S"],
            owner=owner,
            now=env.now[0],
            ttl=timedelta(minutes=45),
            disable=disable,
        )
    )


def _provision(
    env: Env,
    tools: list[str] | None = None,
    statement: str | None = None,
    *,
    tier: tuple[str, str] | None = None,
) -> None:
    """What the pack provisioner does when an installation ends well.

    ``tier`` is ``(data_tier, identity_mode)`` of the installed version; without it the
    pointer is one written before packs over account data existed (no such attributes).
    """
    _begin(env)
    raw = _raw(env)
    release = env.source.pack_states()[0].release
    env.db.transact_write_items(
        TransactItems=enabled_items(
            "settings",
            pack_id=PACK,
            enablement_id=raw["enablement_id"]["S"],
            owner="exec-1",
            installed={
                "enablement_id": raw["enablement_id"]["S"],
                "pack_version": raw["pack_version"]["S"],
                "statement_sha256": statement or release.statement_sha256,
                "artifact_version_id": "v1",
                "runtime_id": "Mango_test_mcp_aws_pricing-abcdefghij",
                "runtime_version": "1",
                "target_id": "TARGET0001",
                "tools": tools or list(release.manifest.tool_names),
                "grants": [{"actions": list(release.actions), "resources": ["*"]}],
                "config": json.loads(raw["config"]["S"]),
                **({"data_tier": tier[0], "identity_mode": tier[1]} if tier else {}),
            },
            now=env.now[0],
        )
    )
    env.db.update_item(**unlock_item("settings", pack_id=PACK, owner="exec-1"))


def _fail(env: Env) -> None:
    """The provisioner gives up: ``failed`` with a step and a code."""
    _begin(env)
    env.db.update_item(
        **fail_item(
            "settings",
            pack_id=PACK,
            owner="exec-1",
            failed_step="verify_tools",
            failure="tools_mismatch",
            now=env.now[0],
            disable=False,
        )
    )
    env.db.update_item(**unlock_item("settings", pack_id=PACK, owner="exec-1"))


def _remove(env: Env) -> None:
    """The provisioner removed everything the pack had."""
    _begin(env, disable=True)
    env.db.transact_write_items(
        TransactItems=disabled_items(
            "settings",
            pack_id=PACK,
            enablement_id=_raw(env)["enablement_id"]["S"],
            owner="exec-1",
            now=env.now[0],
        )
    )
    env.db.update_item(**unlock_item("settings", pack_id=PACK, owner="exec-1"))


def _enabled(env: Env, **body: Any) -> None:
    _approved(env, **body)
    _provision(env)
    assert _pack(env)["pack"]["status"] == "enabled"


def _disable(env: Env, token: str = "admin", **body: Any) -> Any:
    body.setdefault("version", _lock(env))
    return env.client.request("DELETE", f"/api/mcp/{PACK}", headers=_h(token), json=body)


def _events(env: Env, name: str) -> list[dict[str, Any]]:
    return [d for e, _u, d in env.audit.events if e == name]


def _started(env: Env) -> list[dict[str, Any]]:
    return [json.loads(e["input"]) for e in env.pack_sfn.executions]


# --- Authorization --------------------------------------------------------------------------

ADMINS = {"admin", "admin2"}
CREATORS = ADMINS | {"creator", "creator2"}
CHANGE = "0" * 32
Case = tuple[str, str, dict[str, Any] | None, str, set[str]]
MATRIX: list[Case] = [
    ("GET", URL, None, "ViewMcpCatalog", CREATORS),
    ("POST", f"/api/mcp/{PACK}/enablements", {"version": 99}, "EnableMcp", ADMINS),
    ("POST", f"/api/mcp/{PACK}/params", {"version": 99, "config": {}}, "EnableMcp", ADMINS),
    ("POST", f"/api/mcp/{PACK}/update", {"version": 99}, "EnableMcp", ADMINS),
    ("POST", f"/api/mcp/{PACK}/retry", {"version": 99}, "EnableMcp", ADMINS),
    ("DELETE", f"/api/mcp/{PACK}", {"version": 99, "reason": "x"}, "EnableMcp", ADMINS),
    ("POST", f"/api/mcp/{PACK}/enablements/{CHANGE}/approve", {}, "ApproveMcp", ADMINS),
    ("POST", f"/api/mcp/{PACK}/enablements/{CHANGE}/reject", {"reason": "x"}, "ApproveMcp", ADMINS),
    ("POST", f"/api/mcp/{PACK}/enablements/{CHANGE}/withdraw", {}, "EnableMcp", ADMINS),
]


@pytest.mark.parametrize("case", MATRIX, ids=lambda c: f"{c[0]} {c[1]}")
def test_authorization_matrix(env: Env, case: Case) -> None:
    method, url, body, action, allowed = case
    assert env.client.request(method, url, json=body).status_code == 401
    for token in sorted(TOKENS):
        before = len(env.audit.events)
        response = env.client.request(method, url, headers=_h(token), json=body)
        decisions = [d for e, _u, d in env.audit.events[before:] if e == "policy.decision"]
        assert [d["action"] for d in decisions] == [action]
        assert decisions[0]["allowed"] is (token in allowed)
        assert decisions[0]["resource"] == "Mango::Platform::mango"
        if token in allowed:
            assert response.status_code != 403, (token, response.text)
        else:
            assert response.status_code == 403, (token, response.text)
    # Nothing was written or started by requests that only passed authorization.
    assert env.pack_sfn.executions == []
    assert "Item" not in env.db.get_item(TableName="settings", Key=enablement_key(PACK))


def test_reading_the_catalog_is_a_read_decision(env: Env) -> None:
    env.client.get(URL, headers=_h("creator"))
    decision = _events(env, "policy.decision")[-1]
    assert decision["read_only"] is True


# --- Catalog --------------------------------------------------------------------------------


def test_catalog_lists_connectors_and_the_packs_of_the_release(env: Env) -> None:
    body = env.client.get(URL, headers=_h("admin")).json()
    assert [(i["id"], i["kind"]) for i in body["items"]] == [
        ("aws-budgets", "connector"),
        ("cost-explorer", "connector"),
        (PACK, "pack"),
    ]
    assert body["max_enabled_packs"] == mcp_module.MAX_ENABLED_PACKS
    connector = _item(body, "cost-explorer")
    assert connector["enabled"] is True and connector["pack"] is None
    assert all(tool["enabled"] for tool in connector["tools"])

    pack = _item(body)
    assert pack["name"] == "AWS Pricing"
    assert pack["provider"] == "awslabs.aws-pricing-mcp-server"
    assert (pack["data_tier"], pack["identity_mode"]) == ("public", "service")
    assert pack["permissions"] == PRICING_ACTIONS
    assert pack["enabled"] is False
    assert [(t["ref"], t["access"], t["enabled"]) for t in pack["tools"]] == [
        (f"{PACK}.get_pricing", "read", False),
        (f"{PACK}.get_pricing_service_codes", "read", False),
    ]
    assert pack["agents"] == []
    detail = pack["pack"]
    assert detail["status"] == "available"
    assert (detail["version"], detail["installed_version"], detail["lock_version"]) == (V1, None, 0)
    assert detail["update"] is None and detail["pending"] is None
    assert detail["params"] == [
        {
            "key": "region",
            "description": "Pricing endpoint",
            "allowed": ["us-east-1", "eu-central-1"],
            "default": "us-east-1",
            "value": None,
        }
    ]


def test_creators_see_the_catalog_without_who_asked_or_why(env: Env) -> None:
    assert _request(env, reason="para el equipo de costos").status_code == 201
    admin = _pack(env, "admin2")["pack"]
    assert admin["status"] == "pending"
    assert admin["pending"]["requested_by"] == "admin-1"
    assert admin["pending"]["requested_by_email"] == "admin1@example.com"
    assert admin["pending"]["reason"] == "para el equipo de costos"
    assert admin["pending"]["own"] is False

    creator = _pack(env, "creator")["pack"]
    assert creator["status"] == "pending"
    assert creator["pending"] is None
    assert creator["requested_by"] is None and creator["last_rejected"] is None

    # After a failure the code is for administrators only.
    assert _decide(env, "approve").status_code == 200
    _fail(env)
    assert _pack(env)["pack"]["failure"] == "tools_mismatch"
    creator = _pack(env, "creator")["pack"]
    assert creator["status"] == "error"
    assert creator["failure"] is None and creator["failed_step"] is None
    assert creator["approved_by"] is None


def test_agents_of_the_base_catalog_still_work_without_pack_administration(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    # An installation whose services have no MCP dependencies only serves the connectors.
    deps = McpDeps.catalog_only(env.deps)
    monkeypatch.setattr(deps, "catalog", CatalogSource(env.source._connectors, None, None))
    body = mcp_module.catalog_view(deps, _caller("admin"))
    assert [i["id"] for i in body.model_dump()["items"]] == ["aws-budgets", "cost-explorer"]
    with pytest.raises(mcp_module.ApiError) as error:
        mcp_module.request_change(
            deps, _caller("admin"), PACK, mcp_module.Ask(ChangeKind.ENABLE, 0)
        )
    assert (error.value.status, error.value.code) == (503, "packs_unavailable")


def _caller(token: str) -> Any:
    from mango_api.web import Caller  # noqa: PLC0415
    from mango_core.identity import user_from_claims  # noqa: PLC0415

    return Caller(user=user_from_claims({**TOKENS[token], "exp": 1}), token=token, expires_at=1)


# --- Dual approval --------------------------------------------------------------------------


def test_enabling_needs_another_administrator_and_starts_the_provisioner(env: Env) -> None:
    response = _request(env, config={"region": "eu-central-1"}, reason="costos")
    assert response.status_code == 201, response.text
    detail = _item(response.json())["pack"]
    assert detail["status"] == "pending"
    pending = detail["pending"]
    assert pending["kind"] == "enable" and pending["own"] is True
    assert pending["config"] == {"region": "eu-central-1"}
    assert pending["pack_version"] == V1
    assert len(pending["change_id"]) == 32
    # Nothing is approved yet: no enablement, no execution.
    assert "Item" not in env.db.get_item(TableName="settings", Key=enablement_key(PACK))
    assert env.pack_sfn.executions == []

    # Whoever asked neither approves nor rejects.
    own = _decide(env, "approve", token="admin")
    assert (own.status_code, _code(own)) == (403, "same_approver")
    own = _decide(env, "reject", token="admin", reason="no")
    assert (own.status_code, _code(own)) == (403, "use_withdraw")
    assert env.pack_sfn.executions == []

    response = _decide(env, "approve")
    assert response.status_code == 200, response.text
    detail = _item(response.json())["pack"]
    assert detail["status"] == "installing" and detail["pending"] is None
    assert (detail["requested_by"], detail["approved_by"]) == ("admin-1", "admin-2")
    assert detail["lock_version"] == 1

    raw = _raw(env)
    assert raw["status"]["S"] == "approved"
    assert raw["pack_version"]["S"] == V1
    assert json.loads(raw["config"]["S"]) == {"region": "eu-central-1"}
    assert (raw["requested_by"]["S"], raw["approved_by"]["S"]) == ("admin-1", "admin-2")
    # The provisioner gets identifiers only, and exactly the three it accepts.
    execution = env.pack_sfn.executions[0]
    assert execution["stateMachineArn"] == PACK_MACHINE
    assert json.loads(execution["input"]) == {
        "pack_id": PACK,
        "pack_version": V1,
        "enablement_id": raw["enablement_id"]["S"],
    }
    assert len(execution["name"]) <= 80

    _provision(env)
    pack = _pack(env)
    assert pack["enabled"] is True
    assert all(tool["enabled"] for tool in pack["tools"])
    detail = pack["pack"]
    assert (detail["status"], detail["installed_version"]) == ("enabled", V1)
    assert detail["params"][0]["value"] == "eu-central-1"


def test_every_decision_is_audited_with_both_administrators(env: Env) -> None:
    _approved(env, reason="costos")
    proposed = _events(env, "mcp.pack.request.proposed")
    assert [d["outcome"] for d in proposed] == ["requested", "applied"]
    assert proposed[0]["pack"] == PACK and proposed[0]["kind"] == "enable"
    assert proposed[0]["requested_by"] == "admin-1" and proposed[0]["reason"] == "costos"
    release = env.source.pack_states()[0].release
    assert proposed[0]["statement_sha256"] == release.statement_sha256

    approved = _events(env, "mcp.pack.request.approved")
    assert [d["outcome"] for d in approved] == ["requested", "applied"]
    assert (approved[1]["requested_by"], approved[1]["approved_by"]) == ("admin-1", "admin-2")
    assert approved[1]["enablement_id"] == _raw(env)["enablement_id"]["S"]
    assert approved[1]["config"] == {"region": "us-east-1"}


def test_audit_failure_stops_the_write(env: Env) -> None:
    env.audit.fail_outcomes = {"requested"}
    response = _request(env)
    assert (response.status_code, _code(response)) == (503, "audit_unavailable")
    env.audit.fail_outcomes = set()
    assert _pack(env)["pack"]["status"] == "available"

    assert _request(env).status_code == 201
    env.audit.fail_outcomes = {"requested"}
    response = _decide(env, "approve")
    assert (response.status_code, _code(response)) == (503, "audit_unavailable")
    env.audit.fail_outcomes = set()
    assert _pack(env)["pack"]["status"] == "pending"
    assert env.pack_sfn.executions == []
    assert "Item" not in env.db.get_item(TableName="settings", Key=enablement_key(PACK))


def test_rejecting_needs_a_reason_and_frees_the_pack(env: Env) -> None:
    assert _request(env).status_code == 201
    response = _decide(env, "reject")
    assert (response.status_code, _code(response)) == (422, "reason_required")
    response = _decide(env, "reject", reason=XSS)
    assert response.status_code == 200, response.text
    detail = _item(response.json())["pack"]
    assert detail["status"] == "available" and detail["pending"] is None
    assert detail["last_rejected"]["decided_by"] == "admin-2"
    assert detail["last_rejected"]["reason"] == XSS  # returned as data, never as markup
    assert response.headers["content-type"] == "application/json"
    assert env.pack_sfn.executions == []
    rejected = _events(env, "mcp.pack.request.rejected")
    assert [d["outcome"] for d in rejected] == ["requested", "applied"]
    assert rejected[1]["rejected_by"] == "admin-2"
    # The pack can be asked for again.
    assert _request(env).status_code == 201


def test_only_who_asked_withdraws(env: Env) -> None:
    assert _request(env).status_code == 201
    other = _decide(env, "withdraw", token="admin2")
    assert (other.status_code, _code(other)) == (403, "not_requester")
    response = _decide(env, "withdraw", token="admin")
    assert response.status_code == 200
    assert _item(response.json())["pack"]["status"] == "available"
    assert [d["outcome"] for d in _events(env, "mcp.pack.request.withdrawn")] == [
        "requested",
        "applied",
    ]


def test_one_request_per_pack_at_a_time_and_closed_requests_stay_closed(env: Env) -> None:
    assert _request(env).status_code == 201
    change_id = _pending_id(env)
    second = _request(env, token="admin2")
    assert (second.status_code, _code(second)) == (409, "pending_exists")
    assert _decide(env, "approve").status_code == 200
    again = env.client.post(
        f"/api/mcp/{PACK}/enablements/{change_id}/approve", headers=_h("admin2"), json={}
    )
    assert (again.status_code, _code(again)) == (409, "version_conflict")
    assert len(env.pack_sfn.executions) == 1
    unknown = env.client.post(
        f"/api/mcp/{PACK}/enablements/{CHANGE}/approve", headers=_h("admin2"), json={}
    )
    assert (unknown.status_code, _code(unknown)) == (404, "not_found")


def test_requests_expire(env: Env) -> None:
    assert _request(env).status_code == 201
    change_id = _pending_id(env)
    env.now[0] += timedelta(days=7, seconds=1)
    response = env.client.post(
        f"/api/mcp/{PACK}/enablements/{change_id}/approve", headers=_h("admin2"), json={}
    )
    assert (response.status_code, _code(response)) == (410, "expired")
    assert _pack(env)["pack"]["status"] == "available"
    # An expired request no longer blocks the pack.
    assert _request(env, token="admin2").status_code == 201


# --- Validation -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "config",
    [
        {"region": "ap-south-1"},  # not one of the allowed values
        {"profile": "default"},  # not a parameter of the manifest
        {"region": "us-east-1", "role_arn": "arn:aws:iam::1:role/x"},
    ],
)
def test_parameters_outside_the_manifest_are_refused(env: Env, config: dict[str, str]) -> None:
    response = _request(env, config=config)
    assert response.status_code == 422, response.text
    if "error" in response.json():
        assert _code(response) == "invalid_config"
    assert _pack(env)["pack"]["status"] == "available"


@pytest.mark.parametrize(
    "body",
    [
        {"version": 0, "pack_version": V2},
        {"version": 0, "iam": [{"actions": ["s3:*"]}]},
        {"version": 0, "config": {"region": "x" * 65}},
        {"version": 0, "config": {"Region": "us-east-1"}},
        {"version": -1},
        {"version": 0, "reason": "x" * 501},
        {},
    ],
)
def test_bodies_are_strict(env: Env, body: dict[str, Any]) -> None:
    response = env.client.post(f"/api/mcp/{PACK}/enablements", headers=_h("admin"), json=body)
    assert response.status_code == 422, response.text
    assert env.audit.named("mcp.pack.request.proposed", None) == []


@pytest.mark.parametrize("pack", ["Aws", "a_b", "a" * 25, "x--y", "9pack"])
def test_pack_ids_are_validated_before_anything_else(env: Env, pack: str) -> None:
    response = env.client.post(
        f"/api/mcp/{pack}/enablements", headers=_h("admin"), json={"version": 0}
    )
    assert response.status_code == 422


def test_a_pack_the_release_does_not_ship_cannot_be_asked_for(env: Env) -> None:
    response = env.client.post(
        "/api/mcp/aws-billing/enablements", headers=_h("admin"), json={"version": 0}
    )
    assert (response.status_code, _code(response)) == (404, "not_found")


def test_stale_version_is_a_conflict(env: Env) -> None:
    response = _request(env, version=3)
    assert (response.status_code, _code(response)) == (409, "version_conflict")


@pytest.mark.parametrize(
    "changes",
    [
        {
            "data_tier": "account_data",
            "identity_mode": "per_user_adapter",
            "egress": {"aws": ["sts"]},
        },
        {
            "data_tier": "write",
            "identity_mode": "central_only",
            "egress": {"aws": ["sts"]},
            "tools": [{"name": "get_pricing", "access": "write"}],
        },
        # Hosts outside AWS cannot be allowed one by one yet (R6).
        {"egress": {"aws": ["pricing"], "hosts": ["api.example.com"]}},
    ],
)
def test_packs_this_installation_cannot_install_are_not_requested(
    env: Env, changes: dict[str, Any]
) -> None:
    env.ship(_manifest(**changes))
    assert _pack(env)["data_tier"] == changes.get("data_tier", "public")
    response = _request(env)
    assert (response.status_code, _code(response)) == (409, "pack_unsupported")


# --- Packs over account data (central_only, D37) --------------------------------------------

ACCOUNT_DATA = {
    "data_tier": "account_data",
    "identity_mode": "central_only",
    "egress": {"aws": ["sts", "ce"]},
}


def _violations(env: Env, **definition: Any) -> set[str]:
    draft = _create(env, **definition)
    response = env.client.post(
        f"/api/agents/{draft['agent_id']}/versions/1/submit",
        headers=_h("creator"),
        json={"revision": draft["revision"]},
    )
    if response.status_code == 200:
        return set()
    assert response.status_code == 422, response.text
    return {v["code"] for v in response.json()["violations"]}


def test_an_account_data_pack_is_enabled_like_any_other_and_only_for_central_groups(
    env: Env,
) -> None:
    _group(env.db, "finops-central", "central")
    env.ship(_manifest(**ACCOUNT_DATA))
    _approved(env)
    _provision(env, tier=("account_data", "central_only"))
    pack = _pack(env)
    assert (pack["data_tier"], pack["identity_mode"]) == ("account_data", "central_only")
    assert all(tool["central_groups_only"] for tool in pack["tools"])

    # An agent with its tools cannot be sent to review for an area or general group, nor
    # shared with individual users (D35). Cedar L2 denies them anyway.
    assert "account_data_for_non_central_group" in _violations(env, tools=[PRICING_TOOL])
    assert "account_data_for_users" in _violations(
        env,
        tools=[PRICING_TOOL],
        groups=["finops-central"],
        users=["11111111-2222-3333-4444-555555555555"],
    )
    assert _violations(env, tools=[PRICING_TOOL], groups=["finops-central"]) == set()


def test_tools_that_need_an_opt_in_aws_service_say_which(env: Env) -> None:
    tools = ["cost-explorer", "compute-optimizer", "cost-optimization"]
    env.ship(
        _manifest(),
        _manifest("aws-billing", tools=[{"name": name, "access": "read"} for name in tools]),
    )
    billing = {t["name"]: t["requires_service"] for t in _pack(env, pack_id="aws-billing")["tools"]}
    assert billing == {
        "cost-explorer": None,
        "compute-optimizer": "Compute Optimizer",
        "cost-optimization": "Cost Optimization Hub",
    }
    # Creators read it too (they pick tools in the Agent Builder); nobody else needs more.
    creator = _pack(env, "creator", "aws-billing")
    assert [t["requires_service"] for t in creator["tools"]] == list(billing.values())
    assert all(t["requires_service"] is None for t in _pack(env)["tools"])


def test_the_installed_version_decides_who_may_get_the_tools(env: Env) -> None:
    """The release may ship another version than the one that serves (B3, open point 10)."""
    env.ship(_manifest(**ACCOUNT_DATA))
    _approved(env)
    _provision(env, tier=("account_data", "central_only"))
    # A later release turns the pack public; the installed version still reads account data.
    env.ship(_manifest(version=V2))
    pack = _pack(env)
    assert pack["pack"]["installed_version"] == V1
    assert (pack["data_tier"], pack["identity_mode"]) == ("account_data", "central_only")
    assert "account_data_for_non_central_group" in _violations(env, tools=[PRICING_TOOL])


def test_a_pointer_older_than_account_data_packs_is_a_public_pack(env: Env) -> None:
    _enabled(env)  # `_provision` without tier: the pointer has no such attributes
    pack = _pack(env)
    assert (pack["data_tier"], pack["identity_mode"]) == ("public", "service")
    assert _violations(env, tools=[PRICING_TOOL]) == set()


def test_an_update_cannot_change_how_the_pack_reaches_data(env: Env) -> None:
    _enabled(env)
    env.ship(_manifest(version=V2, **ACCOUNT_DATA))
    response = _request(env, path="update")
    assert (response.status_code, _code(response)) == (409, "identity_mode_changed")
    # Still the public pack that was approved, for the agents that already use it.
    assert _pack(env)["data_tier"] == "public"


def test_enabled_packs_are_capped(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    env.ship(_manifest(), _manifest("aws-billing"))
    monkeypatch.setattr(mcp_module, "MAX_ENABLED_PACKS", 1)
    _enabled(env)
    response = env.client.post(
        "/api/mcp/aws-billing/enablements", headers=_h("admin"), json={"version": 0}
    )
    assert (response.status_code, _code(response)) == (409, "too_many_packs")


def test_writes_are_rate_limited(env: Env) -> None:
    env.mcp.rate_limiter = RateLimiter(limit=2, window_seconds=60)
    assert _request(env).status_code == 201
    assert _decide(env, "withdraw", token="admin").status_code == 200
    response = _request(env)
    assert (response.status_code, _code(response)) == (429, "rate_limited")
    assert int(response.headers["Retry-After"]) >= 1


# --- Installation, retry --------------------------------------------------------------------


def test_failed_installation_is_retried_by_one_administrator_with_the_same_request(
    env: Env,
) -> None:
    _approved(env, config={"region": "eu-central-1"})
    _fail(env)
    detail = _pack(env)["pack"]
    assert (detail["status"], detail["failed_step"], detail["failure"]) == (
        "error",
        "verify_tools",
        "tools_mismatch",
    )
    before = _raw(env)

    stale = env.client.post(f"/api/mcp/{PACK}/retry", headers=_h("admin"), json={"version": 9})
    assert (stale.status_code, _code(stale)) == (409, "version_conflict")
    response = env.client.post(
        f"/api/mcp/{PACK}/retry", headers=_h("admin"), json={"version": detail["lock_version"]}
    )
    assert response.status_code == 200, response.text
    assert _item(response.json())["pack"]["status"] == "installing"
    after = _raw(env)
    assert after["status"]["S"] == "approved"
    # Nothing that was approved changed.
    for name in ("enablement_id", "pack_version", "config", "requested_by", "approved_by"):
        assert after[name] == before[name]
    assert "failure" not in after and "failed_step" not in after
    assert _started(env)[-1]["enablement_id"] == before["enablement_id"]["S"]
    retried = _events(env, "mcp.pack.retried")
    assert [d["outcome"] for d in retried] == ["requested", "applied"]
    assert retried[0]["from_status"] == "failed"


def test_nothing_to_retry_unless_it_failed_or_never_started(env: Env) -> None:
    missing = env.client.post(f"/api/mcp/{PACK}/retry", headers=_h("admin"), json={"version": 0})
    assert (missing.status_code, _code(missing)) == (404, "not_found")
    _approved(env)
    # Just approved: the execution is on its way.
    fresh = env.client.post(f"/api/mcp/{PACK}/retry", headers=_h("admin"), json={"version": 1})
    assert (fresh.status_code, _code(fresh)) == (409, "busy")
    _provision(env)
    done = env.client.post(f"/api/mcp/{PACK}/retry", headers=_h("admin"), json={"version": 1})
    assert (done.status_code, _code(done)) == (409, "invalid_state")
    assert len(env.pack_sfn.executions) == 1


def test_approval_whose_execution_did_not_start_is_shown_as_an_error_and_retried(
    env: Env,
) -> None:
    assert _request(env).status_code == 201
    env.pack_sfn.fail = True
    response = _decide(env, "approve")
    assert (response.status_code, _code(response)) == (503, "provisioner_unavailable")
    # The decision is committed and audited; only the start is missing.
    assert _raw(env)["status"]["S"] == "approved"
    assert _pack(env)["pack"]["status"] == "installing"

    env.now[0] += timedelta(minutes=3)
    detail = _pack(env)["pack"]
    assert (detail["status"], detail["failure"]) == ("error", "not_started")
    env.pack_sfn.fail = False
    response = env.client.post(
        f"/api/mcp/{PACK}/retry", headers=_h("admin2"), json={"version": detail["lock_version"]}
    )
    assert response.status_code == 200, response.text
    assert _started(env) == [
        {"pack_id": PACK, "pack_version": V1, "enablement_id": _raw(env)["enablement_id"]["S"]}
    ]
    assert _events(env, "mcp.pack.retried")[0]["from_status"] == "approved"


def test_interrupted_installation_is_retried_once_its_lock_expires(env: Env) -> None:
    _approved(env)
    _begin(env)  # installing, with the lock of an execution that then dies
    assert _pack(env)["pack"]["status"] == "installing"
    held = env.client.post(f"/api/mcp/{PACK}/retry", headers=_h("admin"), json={"version": 1})
    assert (held.status_code, _code(held)) == (409, "busy")
    env.now[0] += timedelta(minutes=46)
    detail = _pack(env)["pack"]
    assert (detail["status"], detail["failure"]) == ("error", "interrupted")
    response = env.client.post(f"/api/mcp/{PACK}/retry", headers=_h("admin"), json={"version": 1})
    assert response.status_code == 200
    assert len(env.pack_sfn.executions) == 2


def test_retry_is_refused_when_the_release_names_another_version(env: Env) -> None:
    _approved(env)
    _fail(env)
    env.ship(_manifest(version=V2))
    response = env.client.post(f"/api/mcp/{PACK}/retry", headers=_h("admin"), json={"version": 1})
    assert (response.status_code, _code(response)) == (409, "release_changed")


# --- Parameters and updates (D26) -----------------------------------------------------------


def test_changing_parameters_needs_approval_and_keeps_serving_meanwhile(env: Env) -> None:
    _enabled(env)
    same = _request(env, path="params", config={"region": "us-east-1"})
    assert (same.status_code, _code(same)) == (422, "no_change")
    bad = _request(env, path="params", config={"region": "mars-1"})
    assert (bad.status_code, _code(bad)) == (422, "invalid_config")

    response = _request(env, path="params", config={"region": "eu-central-1"})
    assert response.status_code == 201, response.text
    pack = _item(response.json())
    detail = pack["pack"]
    # The current configuration stays active until another administrator approves.
    assert detail["status"] == "enabled" and pack["enabled"] is True
    assert detail["params"][0]["value"] == "us-east-1"
    assert detail["pending"]["kind"] == "params"
    assert detail["pending"]["config"] == {"region": "eu-central-1"}
    before = _raw(env)["enablement_id"]["S"]

    own = _decide(env, "approve", token="admin")
    assert (own.status_code, _code(own)) == (403, "same_approver")
    # A change of parameters may be rejected without a reason.
    assert _decide(env, "reject").status_code == 200
    assert _raw(env)["enablement_id"]["S"] == before

    _approved(env, path="params", config={"region": "eu-central-1"})
    raw = _raw(env)
    assert raw["status"]["S"] == "approved" and raw["enablement_id"]["S"] != before
    assert json.loads(raw["config"]["S"]) == {"region": "eu-central-1"}
    assert _started(env)[-1] == {
        "pack_id": PACK,
        "pack_version": V1,
        "enablement_id": raw["enablement_id"]["S"],
    }
    # Still serving the installed configuration until the provisioner finishes.
    pack = _pack(env)
    assert pack["enabled"] is True
    assert pack["pack"]["status"] == "installing"
    assert pack["pack"]["params"][0]["value"] == "us-east-1"
    _provision(env)
    assert _pack(env)["pack"]["params"][0]["value"] == "eu-central-1"


def test_parameters_and_updates_need_an_installed_pack(env: Env) -> None:
    for path, body in (("params", {"config": {"region": "eu-central-1"}}), ("update", {})):
        response = _request(env, path=path, **body)
        assert (response.status_code, _code(response)) == (409, "invalid_state")
    _enabled(env)
    response = _request(env, path="update")
    assert (response.status_code, _code(response)) == (409, "up_to_date")
    response = _request(env)
    assert (response.status_code, _code(response)) == (409, "invalid_state")


def test_update_shows_what_changes_and_goes_through_dual_approval(env: Env) -> None:
    _enabled(env, config={"region": "eu-central-1"})
    new_tools = [{"name": name, "access": "read"} for name in ("get_pricing", "get_price_list")]
    new_iam = [
        {
            "actions": ["pricing:GetProducts", "pricing:ListPriceLists"],
            "resources": ["*"],
            "reason": "No ARNs.",
        }
    ]
    env.ship(_manifest(version=V2, tools=new_tools, iam=new_iam))

    pack = _pack(env)
    detail = pack["pack"]
    # The installed version keeps serving its own tools.
    assert (detail["status"], detail["installed_version"], detail["version"]) == ("enabled", V1, V2)
    enabled = {t["name"]: t["enabled"] for t in pack["tools"]}
    assert enabled == {
        "get_pricing": True,
        "get_price_list": False,
        "get_pricing_service_codes": True,
    }
    assert detail["update"] == {
        "version": V2,
        "added_tools": ["get_price_list"],
        "removed_tools": ["get_pricing_service_codes"],
        "added_permissions": ["pricing:ListPriceLists"],
        "removed_permissions": ["pricing:DescribeServices"],
    }
    # Parameters cannot change on a version the release no longer installs.
    params = _request(env, path="params", config={"region": "us-east-1"})
    assert (params.status_code, _code(params)) == (409, "update_required")

    response = _request(env, path="update")
    assert response.status_code == 201, response.text
    pending = _item(response.json())["pack"]["pending"]
    assert (pending["kind"], pending["pack_version"]) == ("update", V2)
    assert pending["config"] == {"region": "eu-central-1"}  # the parameters in use are kept
    assert _decide(env, "reject").status_code == 422  # an update is rejected with a reason
    assert _decide(env, "approve").status_code == 200
    raw = _raw(env)
    assert _started(env)[-1] == {
        "pack_id": PACK,
        "pack_version": V2,
        "enablement_id": raw["enablement_id"]["S"],
    }
    # A failed update leaves the previous version serving.
    _fail(env)
    pack = _pack(env)
    assert pack["enabled"] is True
    assert (pack["pack"]["status"], pack["pack"]["installed_version"]) == ("error", V1)


def test_approval_is_refused_when_the_release_changed_since_the_request(env: Env) -> None:
    assert _request(env).status_code == 201
    # A stack update ships another statement of the same version before the approval.
    env.ship(_manifest(description="Changed."))
    response = _decide(env, "approve")
    assert (response.status_code, _code(response)) == (409, "release_changed")
    assert env.pack_sfn.executions == []
    assert "Item" not in env.db.get_item(TableName="settings", Key=enablement_key(PACK))


def test_approval_is_refused_when_the_pack_changed_since_the_request(env: Env) -> None:
    _enabled(env)
    assert _request(env, path="params", config={"region": "eu-central-1"}).status_code == 201
    change_id = _pending_id(env)
    # Meanwhile the installed pack is disabled and removed.
    assert _disable(env, reason="ya no se usa").status_code == 200
    closed = env.client.post(
        f"/api/mcp/{PACK}/enablements/{change_id}/approve", headers=_h("admin2"), json={}
    )
    assert (closed.status_code, _code(closed)) == (409, "version_conflict")
    change = env.store.change(PACK, change_id)
    assert change is not None and change.status is ChangeStatus.CANCELLED


# --- Disabling ------------------------------------------------------------------------------


def _agent_with(env: Env, *tools: str) -> dict[str, Any]:
    review = _submit(env, _create(env, tools=list(tools)))
    assert _approve(env, review).status_code == 200
    _publish(env, review)
    return review


def test_disabling_needs_a_reason_lists_the_affected_agents_and_starts_the_removal(
    env: Env,
) -> None:
    _enabled(env)
    agent = _agent_with(env, "cost-explorer.get_cost_and_usage", PRICING_TOOL)
    served = env.published.get(agent["agent_id"])
    assert served is not None
    assert served.allowed_tools == (
        "@mango/aws-pricing___get_pricing",
        "@mango/finops___get_cost_and_usage",
    )
    assert served.gateway_tools == ("aws-pricing___get_pricing", "finops___get_cost_and_usage")
    assert served.unavailable_tools == ()
    # Who is affected is known before deciding.
    affected = [{"id": agent["agent_id"], "name": "Asistente de costos", "category": "FinOps"}]
    before = env.client.get(f"/api/agents/{agent['agent_id']}", headers=_h("creator")).json()
    assert before["unavailable_tools"] == []
    assert _pack(env)["agents"] == affected
    assert _pack(env, pack_id="cost-explorer")["agents"] == affected

    for body in ({}, {"reason": ""}, {"reason": "x" * 501}):
        assert _disable(env, **body).status_code == 422
    before = _raw(env)
    response = _disable(env, token="admin2", reason="ya no se usa")
    assert response.status_code == 200, response.text
    pack = _item(response.json())
    assert pack["agents"] == affected
    assert pack["enabled"] is False
    detail = pack["pack"]
    assert detail["status"] == "disabling"
    assert (detail["disabled_by"], detail["disable_reason"]) == ("admin-2", "ya no se usa")
    raw = _raw(env)
    assert raw["status"]["S"] == "disabling"
    assert _started(env)[-1] == {
        "pack_id": PACK,
        "pack_version": V1,
        "enablement_id": before["enablement_id"]["S"],
    }
    events = _events(env, "mcp.pack.disable.requested")
    assert [d["outcome"] for d in events] == ["requested", "applied"]
    assert events[0]["disabled_by"] == "admin-2" and events[0]["reason"] == "ya no se usa"

    # The agent keeps serving, without the tools of the pack.
    served = env.published.get(agent["agent_id"])
    assert served is not None
    assert served.allowed_tools == ("@mango/finops___get_cost_and_usage",)
    assert served.gateway_tools == ("finops___get_cost_and_usage",)
    assert served.unavailable_tools == (PRICING_TOOL,)

    # The marketplace and the detail say which tools the agent lost; its definition is intact.
    listed = env.client.get("/api/agents", headers=_h("creator")).json()["items"]
    assert [(a["id"], a["unavailable_tools"]) for a in listed] == [
        (agent["agent_id"], [PRICING_TOOL])
    ]
    detail = env.client.get(f"/api/agents/{agent['agent_id']}", headers=_h("creator")).json()
    assert detail["unavailable_tools"] == [PRICING_TOOL]
    assert detail["tools"] == [PRICING_TOOL, "cost-explorer.get_cost_and_usage"]

    _remove(env)
    detail = _pack(env)["pack"]
    assert (detail["status"], detail["installed_version"]) == ("disabled", None)
    # It can be asked for again, with dual approval again.
    assert _request(env).status_code == 201
    assert _pack(env)["pack"]["status"] == "pending"


def test_removal_that_did_not_start_or_failed_is_started_again(env: Env) -> None:
    _enabled(env)
    env.pack_sfn.fail = True
    response = _disable(env, reason="x")
    assert (response.status_code, _code(response)) == (503, "provisioner_unavailable")
    assert _raw(env)["status"]["S"] == "disabling"
    env.pack_sfn.fail = False
    response = _disable(env, reason="x")
    assert response.status_code == 200
    assert len(env.pack_sfn.executions) == 2  # enable, removal
    assert _raw(env)["disable_reason"]["S"] == "x"


def test_only_installed_or_failed_packs_are_disabled(env: Env) -> None:
    missing = env.client.request(
        "DELETE", f"/api/mcp/{PACK}", headers=_h("admin"), json={"version": 0, "reason": "x"}
    )
    assert (missing.status_code, _code(missing)) == (404, "not_found")
    _approved(env)
    waiting = _disable(env, reason="x")
    assert (waiting.status_code, _code(waiting)) == (409, "busy")
    _fail(env)
    assert _disable(env, reason="limpiar").status_code == 200  # cleans up a failed installation
    _remove(env)
    done = _disable(env, reason="x")
    assert (done.status_code, _code(done)) == (409, "invalid_state")


def test_nothing_is_decided_while_the_provisioner_holds_the_pack(env: Env) -> None:
    _enabled(env)
    # An execution took the pack again (a reinstall in progress).
    env.db.update_item(
        TableName="settings",
        Key=enablement_key(PACK),
        UpdateExpression="SET provision_lock = :o, provision_lock_until = :u",
        ExpressionAttributeValues={
            ":o": {"S": "exec-2"},
            ":u": {"N": str(int((env.now[0] + timedelta(minutes=45)).timestamp()))},
        },
    )
    for response in (
        _disable(env, reason="x"),
        _request(env, path="params", config={"region": "eu-central-1"}),
    ):
        assert (response.status_code, _code(response)) == (409, "busy")
    # The same guard as a condition of the write, for a race the checks did not see.
    enablement = env.store.enablement(PACK)
    assert enablement is not None
    with pytest.raises(PackConflictError):
        env.store.disable(
            enablement, by="admin-1", by_email=None, reason="x", pending=None, now=env.now[0]
        )


# --- Store conditions (the race windows of the checks above) --------------------------------


def _change(env: Env, **overrides: Any) -> PackChange:
    fields: dict[str, Any] = {
        "change_id": "c" * 32,
        "pack_id": PACK,
        "kind": ChangeKind.ENABLE,
        "status": ChangeStatus.PENDING,
        "pack_version": V1,
        "statement_sha256": "a" * 64,
        "config": {},
        "reason": None,
        "base_version": 0,
        "requested_by": "admin-1",
        "requested_by_email": None,
        "created_at": env.now[0],
        "expires_at": env.now[0] + timedelta(days=7),
        **overrides,
    }
    return PackChange(**fields)


def test_store_refuses_self_approval_expired_requests_and_stale_enablements(env: Env) -> None:
    change = _change(env)
    env.store.create_change(change)
    with pytest.raises(PackConflictError):
        env.store.create_change(_change(env, change_id="d" * 32))  # one pending per pack
    approve = {"enablement_id": "e" * 32, "approver_email": None}
    with pytest.raises(PackConflictError):
        env.store.approve_change(change, approver="admin-1", now=env.now[0], **approve)
    with pytest.raises(PackConflictError):
        env.store.approve_change(
            change, approver="admin-2", now=env.now[0] + timedelta(days=8), **approve
        )
    with pytest.raises(PackConflictError):
        env.store.reject_change(change, by="admin-1", by_email=None, reason="x", now=env.now[0])
    with pytest.raises(PackConflictError):
        env.store.withdraw_change(change, by="admin-2", now=env.now[0])
    assert "Item" not in env.db.get_item(TableName="settings", Key=enablement_key(PACK))

    env.store.approve_change(change, approver="admin-2", now=env.now[0], **approve)
    assert _raw(env)["status"]["S"] == "approved"
    # A second request made on the previous state of the pack no longer applies.
    stale = _change(env, change_id="d" * 32)
    env.store.create_change(stale)
    with pytest.raises(PackConflictError):
        env.store.approve_change(stale, approver="admin-2", now=env.now[0], **approve)
    assert _raw(env)["enablement_id"]["S"] == "e" * 32


def test_mango_api_never_writes_what_is_installed(env: Env) -> None:
    _enabled(env)
    assert _disable(env, reason="x").status_code == 200
    # Only the provisioner deletes its pointer: the pack keeps "installed" until it does.
    installed = env.store.installed(PACK)
    assert installed is not None and installed.pack_version == V1


# --- Agents use the tools of an enabled pack ------------------------------------------------


def test_agents_get_pack_tools_only_while_the_pack_is_enabled(env: Env) -> None:
    draft = _create(env, tools=[PRICING_TOOL])
    response = env.client.post(
        f"/api/agents/{draft['agent_id']}/versions/1/submit",
        headers=_h("creator"),
        json={"revision": draft["revision"]},
    )
    assert response.status_code == 422
    violations = {(v["code"], tuple(v["items"])) for v in response.json()["violations"]}
    assert ("tool_not_enabled", (PRICING_TOOL,)) in violations

    _enabled(env)
    review = _submit(env, draft)
    assert _approve(env, review).status_code == 200
    _publish(env, review)
    served = env.published.get(draft["agent_id"])
    assert served is not None
    assert served.allowed_tools == ("@mango/aws-pricing___get_pricing",)
    assert served.gateway_tools == ("aws-pricing___get_pricing",)

    # A tool the pack does not have is still refused.
    other = _create(env, tools=[f"{PACK}.analyze_cdk_project"])
    response = env.client.post(
        f"/api/agents/{other['agent_id']}/versions/1/submit",
        headers=_h("creator"),
        json={"revision": other["revision"]},
    )
    assert response.status_code == 422


def test_agent_is_not_served_while_the_packs_cannot_be_read(env: Env) -> None:
    from mango_api.published import AgentUnavailableError  # noqa: PLC0415

    _enabled(env)
    agent = _agent_with(env, PRICING_TOOL)

    def broken(*_args: Any, **_kwargs: Any) -> Any:
        raise ClientError({"Error": {"Code": "InternalServerError"}}, "GetItem")

    env.store._db = type("Broken", (), {"get_item": broken})()  # type: ignore[assignment]
    # Unknown is not "disabled": the agent is unavailable, it does not lose its tools.
    with pytest.raises(AgentUnavailableError):
        env.published.get(agent["agent_id"])
    response = env.client.get(URL, headers=_h("admin"))
    assert (response.status_code, _code(response)) == (503, "catalog_unavailable")


# --- Release packs: only what the provider signed and the release names ---------------------


def _source(env: Env, release: ReleasePacks) -> list[str]:
    connectors = McpCatalog.load(CONNECTORS)
    return [p.pack_id for p in CatalogSource(lambda: connectors, release, env.store).fresh().packs]


def test_only_statements_signed_by_the_release_key_are_listed(env: Env) -> None:
    assert _source(env, _ship(env.s3, env.signer, _manifest())) == [PACK]
    # Signed by someone else.
    assert _source(env, _ship(env.s3, Signer(), _manifest(), key=env.signer.pem)) == []
    # No key in the stack: nothing can be verified, so there are no packs.
    assert _source(env, _ship(env.s3, env.signer, _manifest(), key="")) == []
    assert _ship(env.s3, env.signer, _manifest(), key="").get(PACK) is None
    with pytest.raises(ValueError, match="PACK_SIGNING_PUBLIC_KEY"):
        _ship(env.s3, env.signer, _manifest(), key="not a key")


def test_a_validly_signed_statement_the_release_does_not_name_is_left_out(env: Env) -> None:
    release = _ship(env.s3, env.signer, _manifest())
    # The bucket now holds an older statement, still signed by the provider (rollback).
    old, _digest = env.signer.envelope(_manifest(description="Older build."))
    env.s3.put_object(Bucket=BUCKET, Key=envelope_key(PACK, V1), Body=old)
    assert _source(env, release) == []

    release = _ship(env.s3, env.signer, _manifest())
    tampered = bytearray(env.signer.envelope(_manifest())[0])
    tampered[40] ^= 1
    env.s3.put_object(Bucket=BUCKET, Key=envelope_key(PACK, V1), Body=bytes(tampered))
    assert _source(env, release) == []

    release = _ship(env.s3, env.signer, _manifest())
    env.s3.delete_object(Bucket=BUCKET, Key=envelope_key(PACK, V1))
    assert _source(env, release) == []


def test_a_pack_never_takes_the_id_or_the_target_of_a_connector(env: Env) -> None:
    release = _ship(
        env.s3, env.signer, _manifest("cost-explorer"), _manifest("finops"), _manifest()
    )
    assert _source(env, release) == [PACK]


def test_bucket_errors_are_not_cached_and_do_not_look_like_an_empty_release(env: Env) -> None:
    release = _ship(env.s3, env.signer, _manifest())
    real = release._s3

    class Down:
        def get_object(self, **_kwargs: Any) -> Any:
            raise ClientError({"Error": {"Code": "SlowDown"}}, "GetObject")

    release._s3 = Down()  # type: ignore[assignment]
    with pytest.raises(PackReleaseUnavailableError):
        release.packs()
    release._s3 = real
    assert [p.manifest.id for p in release.packs()] == [PACK]
    # Verified once: the release does not change for the life of a task.
    release._s3 = Down()  # type: ignore[assignment]
    assert [p.manifest.id for p in release.packs()] == [PACK]


@pytest.mark.parametrize(
    "raw",
    [
        "[]",
        "not json",
        '{"Bad_Id": {"version": "1.0-1", "statement_sha256": "' + "a" * 64 + '"}}',
        '{"aws-pricing": {"version": "latest", "statement_sha256": "' + "a" * 64 + '"}}',
        '{"aws-pricing": {"version": "1.0-1", "statement_sha256": "abc"}}',
        '{"aws-pricing": "1.0-1"}',
    ],
)
def test_release_catalog_of_the_stack_is_strict(raw: str) -> None:
    with pytest.raises((ValueError, TypeError)):
        parse_catalog(raw)


def test_empty_release_catalog() -> None:
    assert dict(parse_catalog("")) == {}
    assert dict(parse_catalog("{}")) == {}


def test_a_statement_that_arrives_after_the_task_started_is_picked_up(env: Env) -> None:
    # A stack update: the task starts before CloudFormation copied the pack to the bucket.
    clock = [0.0]
    envelope, digest = env.signer.envelope(_manifest("aws-billing"))
    release = ReleasePacks(
        env.s3,
        bucket=BUCKET,
        bucket_owner=ACCOUNT,
        catalog=parse_catalog(
            json.dumps({"aws-billing": {"version": V1, "statement_sha256": digest}})
        ),
        public_key_pem=env.signer.pem,
        clock=lambda: clock[0],
    )
    assert release.packs() == ()
    env.s3.put_object(Bucket=BUCKET, Key=envelope_key("aws-billing", V1), Body=envelope)
    assert release.packs() == ()  # not read again on every request
    clock[0] += 61
    assert [p.manifest.id for p in release.packs()] == ["aws-billing"]
