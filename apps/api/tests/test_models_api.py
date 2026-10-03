"""Brains: the model catalog administrators edit, against moto and the real Cedar policies."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api.agents import AgentsDeps
from mango_api.agents_store import AgentsStore
from mango_api.authz import PLATFORM, Authorizer
from mango_api.groups import GroupRegistry
from mango_api.mcp_catalog import McpCatalog
from mango_api.model_capabilities import (
    ModelCapabilitiesError,
    ModelCapability,
    load_capabilities,
)
from mango_api.model_catalog import MAX_CATALOG_MODELS, ModelCatalogStore, ModelEntry
from mango_api.models import (
    BedrockCatalog,
    BedrockModel,
    ModelsDeps,
    merge_bedrock,
)
from mango_api.probe import RateLimiter
from mango_api.provisioner import ProvisionerClient
from mango_api.settings import ModelPrice
from mango_api.settings_store import VersionConflictError

from .cedar_fake import CedarPolicyStore
from .test_admin import RecordingAudit, _table
from .test_agents_api import (
    CONNECTORS,
    HAIKU,
    SONNET,
    STATE_MACHINE,
    TOKENS,
    FakeStepFunctions,
    FakeVerifier,
    _group,
    _models,
    _published,
)
from .test_agents_api import Env as AgentsEnv
from .test_agents_store import create_agents_table
from .test_app import (
    HOST,
    FakeAgentCore,
    FakeBedrock,
    FakeConversations,
    FakeLimits,
    FakeModelCatalog,
    FakePublished,
    _settings,
)
from .test_cedar_policies import EVERYONE

NOVA = "us.amazon.nova-pro-v1:0"
OPUS = "us.anthropic.claude-opus-4-7"
XSS = "<img src=x onerror=alert(1)>"
URL = "/api/admin/models"


def _profile(profile_id: str, model_id: str, **overrides: Any) -> dict[str, Any]:
    return {
        "inferenceProfileId": profile_id,
        "inferenceProfileName": f"US {model_id}",
        "status": "ACTIVE",
        "type": "SYSTEM_DEFINED",
        "models": [{"modelArn": f"arn:aws:bedrock:us-east-1::foundation-model/{model_id}"}],
        **overrides,
    }


def _foundation(model_id: str, provider: str, *modalities: str) -> dict[str, Any]:
    return {
        "modelId": model_id,
        "modelName": model_id,
        "providerName": provider,
        "inputModalities": list(modalities),
        "outputModalities": ["TEXT"],
    }


@dataclass
class FakeBedrockControl:
    """The two list calls of the ``bedrock`` client, with one profile per page."""

    foundation: list[dict[str, Any]] = field(
        default_factory=lambda: [
            _foundation("anthropic.claude-sonnet-4-6", "Anthropic", "TEXT", "IMAGE"),
            _foundation("anthropic.claude-opus-4-7", "Anthropic", "TEXT", "IMAGE"),
            _foundation("amazon.nova-pro-v1:0", "Amazon", "TEXT"),
        ]
    )
    profiles: list[dict[str, Any]] = field(
        default_factory=lambda: [
            _profile(SONNET, "anthropic.claude-sonnet-4-6"),
            _profile(OPUS, "anthropic.claude-opus-4-7"),
            _profile(NOVA, "amazon.nova-pro-v1:0"),
        ]
    )
    fail: bool = False
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)

    def list_foundation_models(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("list_foundation_models", kwargs))
        if self.fail:
            raise ClientError({"Error": {"Code": "AccessDeniedException"}}, "ListFoundationModels")
        return {"modelSummaries": self.foundation}

    def list_inference_profiles(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("list_inference_profiles", kwargs))
        start = int(kwargs.get("nextToken", "0"))
        page: dict[str, Any] = {"inferenceProfileSummaries": self.profiles[start : start + 1]}
        if start + 1 < len(self.profiles):
            page["nextToken"] = str(start + 1)
        return page


@dataclass
class Env(AgentsEnv):
    bedrock: FakeBedrockControl
    store: ModelCatalogStore
    limiter_clock: list[float]
    models: ModelsDeps


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "settings")
        create_agents_table(db, "agents")
        _group(db, "hr", "general")
        _models(db)
        audit, cedar, sfn = RecordingAudit(), CedarPolicyStore(), FakeStepFunctions()
        authorizer = Authorizer(cedar, "ps")  # type: ignore[arg-type]
        registry = GroupRegistry(db, "settings")
        catalog = McpCatalog.load(CONNECTORS)
        now = [datetime(2026, 10, 1, 15, 0, tzinfo=UTC)]
        limiter_clock = [0.0]
        agents_store = AgentsStore(db, "agents")
        store = ModelCatalogStore(db, "settings")
        bedrock = FakeBedrockControl()
        settings = _settings()
        agents = AgentsDeps(
            store=agents_store,
            audit=audit,  # type: ignore[arg-type]
            authorizer=authorizer,
            groups=registry,
            models=store,
            catalog=lambda: catalog,
            provisioner=ProvisionerClient(sfn, STATE_MACHINE),  # type: ignore[arg-type]
            clock=lambda: now[0],
        )
        models = ModelsDeps(
            store=store,
            bedrock=BedrockCatalog(bedrock),
            agents=agents_store,
            audit=audit,  # type: ignore[arg-type]
            rate_limiter=RateLimiter(limit=2, window_seconds=60, clock=lambda: limiter_clock[0]),
            region="us-east-1",
            default_model=settings.agent_model,
            list_prices=settings.model_prices,
            clock=lambda: now[0],
        )

        def factory(s: Any) -> app_module.Services:
            return app_module.Services(
                settings=s,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=authorizer,
                budgets=None,  # type: ignore[arg-type]
                conversations=FakeConversations(),  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=FakeAgentCore(),
                bedrock=FakeBedrock(),
                settings_store=None,  # type: ignore[arg-type]
                budget_limits=FakeLimits(),  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=FakePublished(),  # type: ignore[arg-type]
                model_catalog=FakeModelCatalog(),  # type: ignore[arg-type]
                invocation_key=b"k" * 32,
                group_registry=registry,
                agents=agents,
                models=models,
            )

        asgi = app_module.create_app(settings, services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(client, db, audit, cedar, sfn, agents, now, bedrock, store, limiter_clock, models)
        assert cedar.errors == []


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def _get(env: Env) -> dict[str, Any]:
    response = env.client.get(URL, headers=_h("admin"))
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def _item(body: dict[str, Any], model_id: str) -> dict[str, Any]:
    found: dict[str, Any] = next(i for i in body["items"] if i["id"] == model_id)
    return found


def _put(env: Env, model_id: str, body: dict[str, Any], token: str = "admin") -> Any:
    return env.client.put(f"{URL}/{model_id}", headers=_h(token), json=body)


def _enable(env: Env, model_id: str, **overrides: Any) -> Any:
    body = {"version": _get(env)["version"], "enabled": True, "input_usd": "1", "output_usd": "5"}
    return _put(env, model_id, {**body, **overrides})


def _disable(env: Env, model_id: str, **overrides: Any) -> Any:
    return _put(env, model_id, {"version": _get(env)["version"], "enabled": False, **overrides})


def _refresh(env: Env, token: str = "admin") -> Any:
    return env.client.post(f"{URL}/refresh", headers=_h(token), json={})


def _events(env: Env, name: str) -> list[dict[str, Any]]:
    return [d for e, _u, d in env.audit.events if e == name]


# --- Authorization ----------------------------------------------------------------------

ROUTES: list[tuple[str, str, dict[str, Any] | None]] = [
    ("GET", URL, None),
    ("POST", f"{URL}/refresh", {}),
    ("PUT", f"{URL}/{HAIKU}", {"version": 1, "enabled": True, "input_usd": "1", "output_usd": "5"}),
]


@pytest.mark.parametrize(("method", "path", "body"), ROUTES)
def test_every_route_is_for_administrators(
    env: Env, method: str, path: str, body: dict[str, Any] | None
) -> None:
    assert env.client.request(method, path, json=body).status_code == 401
    for token in TOKENS:
        env.cedar.decisions.clear()
        response = env.client.request(method, path, headers=_h(token), json=body)
        admin = token in ("admin", "admin2")
        # The second administrator's write meets the version the first one left behind.
        expected = {200, 409} if admin else {403}
        assert response.status_code in expected, (token, response.text)
        sub = TOKENS[token]["sub"]
        assert env.cedar.decisions == [(sub, "ManageModels", "mango", admin)]
    # Every decision is audited; only the listing counts as a read.
    decisions = [d for d in _events(env, "policy.decision") if d["action"] == "ManageModels"]
    assert len(decisions) == len(TOKENS)
    assert {d["read_only"] for d in decisions} == {method == "GET"}
    # A denied caller changed nothing.
    assert env.store.catalog().version <= 3


def test_the_cedar_policy_only_matches_administrators() -> None:
    authz = Authorizer(CedarPolicyStore(), "ps")  # type: ignore[arg-type]
    allowed = {u.user_id for u in EVERYONE if authz.is_allowed(u, "ManageModels", *PLATFORM)}
    assert allowed == {"admin-1"}
    assert not authz.is_allowed(EVERYONE[0], "ManageModels", "Mango::Agent", "finops")


# --- Listing ----------------------------------------------------------------------------


def test_lists_the_seeded_catalog(env: Env) -> None:
    body = _get(env)
    assert body["version"] == 1
    assert body["region"] == "us-east-1"
    assert body["refreshed_at"] is None
    assert _item(body, SONNET) == {
        "id": SONNET,
        "name": SONNET,
        "provider": "anthropic",
        "status": "enabled",
        "is_default": True,
        "supports_tools": True,
        "supports_vision": False,
        "context_tokens": None,
        "input_usd": "3",
        "output_usd": "15",
        "cache_read_usd": "0.3",
        "cache_write_usd": "3.75",
        "list_input_usd": "3",
        "list_output_usd": "15",
        "confirmed_by": None,
        "confirmed_at": None,
        "disabled_by": None,
        "disabled_at": None,
        "disabled_reason": None,
        # Only agents of the Agents table: the release agent is one of them once seeded.
        "agents": [],
    }
    haiku = _item(body, HAIKU)
    assert haiku["status"] == "available"
    assert haiku["is_default"] is False
    assert haiku["agents"] == []


def test_a_broken_catalog_fails_closed(env: Env) -> None:
    env.db.delete_item(TableName="settings", Key={"PK": {"S": "MODELS"}, "SK": {"S": "CATALOG"}})
    response = env.client.get(URL, headers=_h("admin"))
    assert response.status_code == 503
    assert _code(response) == "models_unavailable"


def test_published_agents_are_listed_under_the_models_they_may_use(env: Env) -> None:
    assert _enable(env, HAIKU).status_code == 200
    both = _published(env, name=XSS, allowed_models=[SONNET, HAIKU])
    _published(env, name="Solo Sonnet")
    body = _get(env)
    assert _item(body, HAIKU)["agents"] == [
        {"id": both["agent_id"], "name": XSS, "category": "FinOps"}
    ]
    assert [a["name"] for a in _item(body, SONNET)["agents"]] == [XSS, "Solo Sonnet"]


# --- Enabling and prices ----------------------------------------------------------------


def test_enabling_confirms_the_prices_and_is_audited(env: Env) -> None:
    response = _enable(env, HAIKU, input_usd="0.8", output_usd="4.0000")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["version"] == 2
    haiku = _item(body, HAIKU)
    assert haiku["status"] == "enabled"
    assert (haiku["input_usd"], haiku["output_usd"]) == ("0.8", "4")
    assert (haiku["list_input_usd"], haiku["list_output_usd"]) == ("3", "15")
    assert (haiku["cache_read_usd"], haiku["cache_write_usd"]) == ("0.08", "1")
    assert haiku["confirmed_by"] == "admin1@example.com"
    assert haiku["confirmed_at"] == "2026-10-01T15:00:00+00:00"
    # The builder sees it at once, with the confirmed prices.
    builder = env.client.get("/api/models", headers=_h("admin")).json()
    assert {m["id"]: m["input_usd"] for m in builder["items"]} == {SONNET: "3", HAIKU: "0.8"}
    # The cache prices keep their ratio to the input price.
    stored = env.store.catalog().get(HAIKU)
    assert stored is not None
    assert (stored.cache_read_usd, stored.cache_write_usd) == (Decimal("0.08"), Decimal("1"))
    requested, applied = _events(env, "settings.model.enabled")
    assert requested == {
        "model": HAIKU,
        "base_version": 1,
        "before": {"input_usd": "3", "output_usd": "15"},
        "after": {"input_usd": "0.8", "output_usd": "4"},
        "outcome": "requested",
    }
    assert applied["outcome"] == "applied"


def test_editing_the_prices_of_an_enabled_model_is_its_own_event(env: Env) -> None:
    response = _enable(env, SONNET, input_usd="2.7", output_usd="13.5")
    assert response.status_code == 200
    sonnet = _item(response.json(), SONNET)
    assert (sonnet["status"], sonnet["input_usd"], sonnet["output_usd"]) == (
        "enabled",
        "2.7",
        "13.5",
    )
    assert [d["outcome"] for d in _events(env, "settings.model.price_updated")] == [
        "requested",
        "applied",
    ]
    assert _events(env, "settings.model.enabled") == []


@pytest.mark.parametrize(
    "body",
    [
        {"enabled": True, "input_usd": "0", "output_usd": "5"},
        {"enabled": True, "input_usd": "1", "output_usd": "0.0"},
        {"enabled": True, "input_usd": "-1", "output_usd": "5"},
        {"enabled": True, "input_usd": "1", "output_usd": "100000.01"},
        {"enabled": True, "input_usd": "1.00001", "output_usd": "5"},
        {"enabled": True, "input_usd": "1e2", "output_usd": "5"},
        {"enabled": True, "input_usd": 1, "output_usd": 5},
        {"enabled": True, "input_usd": "1"},
        {"enabled": True},
        {"enabled": True, "input_usd": "1", "output_usd": "5", "reason": "x"},
        {"enabled": False, "input_usd": "1", "output_usd": "5"},
        {"enabled": "yes", "input_usd": "1", "output_usd": "5"},
        {"enabled": False, "reason": "x" * 501},
        {"enabled": False, "reason": "bad\x00reason"},
        {"enabled": True, "input_usd": "1", "output_usd": "5", "supports_tools": True},
        {"input_usd": "1", "output_usd": "5"},
    ],
)
def test_invalid_bodies_are_rejected_before_anything_is_written(
    env: Env, body: dict[str, Any]
) -> None:
    response = _put(env, HAIKU, {"version": 1, **body})
    assert response.status_code == 422, response.text
    assert _code(response) == "invalid_request"
    assert "x" * 50 not in response.text
    assert env.store.catalog().version == 1
    assert [e for e, _u, _d in env.audit.events if e.startswith("settings.")] == []


def test_a_stale_version_is_a_conflict(env: Env) -> None:
    assert _enable(env, HAIKU).status_code == 200
    stale = _put(env, HAIKU, {"version": 1, "enabled": False})
    assert stale.status_code == 409
    assert _code(stale) == "version_conflict"
    assert _item(_get(env), HAIKU)["status"] == "enabled"


def test_the_version_is_also_a_condition_of_the_write(env: Env) -> None:
    catalog = env.store.catalog()
    env.store.save(1, catalog.models, "admin-1", env.now[0])
    with pytest.raises(VersionConflictError):
        env.store.save(1, catalog.models, "admin-2", env.now[0])
    assert env.store.catalog().version == 2


def test_an_unknown_model_is_not_found(env: Env) -> None:
    response = _enable(env, "us.unknown.model")
    assert response.status_code == 404
    assert _put(env, "bad id!", {"version": 1, "enabled": False}).status_code == 422


def test_nothing_is_written_when_the_audit_is_down(env: Env) -> None:
    env.audit.fail_outcomes = {"requested"}
    response = _put(
        env, HAIKU, {"version": 1, "enabled": True, "input_usd": "1", "output_usd": "5"}
    )
    assert response.status_code == 503
    assert _code(response) == "audit_unavailable"
    assert env.store.catalog().version == 1


# --- Disabling --------------------------------------------------------------------------


def test_disabling_records_who_why_and_the_agents_affected(env: Env) -> None:
    assert _enable(env, HAIKU).status_code == 200
    agent = _published(env, allowed_models=[SONNET, HAIKU])
    response = _disable(env, HAIKU, reason="  Contrato vencido  ")
    assert response.status_code == 200, response.text
    haiku = _item(response.json(), HAIKU)
    assert haiku["status"] == "disabled"
    assert haiku["disabled_by"] == "admin1@example.com"
    assert haiku["disabled_reason"] == "Contrato vencido"
    # Still listed as affected until a version with another model is approved.
    assert [a["id"] for a in haiku["agents"]] == [agent["agent_id"]]
    # The builder no longer offers it, and a new version cannot be sent with it.
    builder = env.client.get("/api/models", headers=_h("admin")).json()
    assert [m["id"] for m in builder["items"]] == [SONNET]
    requested, applied = _events(env, "settings.model.disabled")
    assert requested["reason"] == "Contrato vencido"
    assert requested["affected_agents"] == [agent["agent_id"]]
    assert requested["affected_agent_count"] == 1
    assert applied["outcome"] == "applied"


def test_a_disabled_model_can_be_enabled_again(env: Env) -> None:
    assert _enable(env, HAIKU).status_code == 200
    assert _disable(env, HAIKU).status_code == 200
    assert _item(_get(env), HAIKU)["disabled_reason"] is None
    haiku = _item(_enable(env, HAIKU).json(), HAIKU)
    assert (haiku["status"], haiku["disabled_by"], haiku["disabled_at"]) == ("enabled", None, None)


def test_the_default_model_cannot_be_disabled(env: Env) -> None:
    response = _disable(env, SONNET)
    assert response.status_code == 409
    assert _code(response) == "default_model"
    assert _item(_get(env), SONNET)["status"] == "enabled"


def test_a_model_that_is_not_enabled_cannot_be_disabled(env: Env) -> None:
    response = _disable(env, HAIKU)
    assert response.status_code == 409
    assert _code(response) == "model_not_enabled"


def test_the_reason_is_returned_as_text(env: Env) -> None:
    assert _enable(env, HAIKU).status_code == 200
    response = _disable(env, HAIKU, reason=XSS)
    assert response.headers["content-type"] == "application/json"
    assert _item(response.json(), HAIKU)["disabled_reason"] == XSS


# --- Refresh ----------------------------------------------------------------------------


def test_refresh_adds_what_bedrock_lists_and_marks_what_it_does_not(env: Env) -> None:
    response = _refresh(env)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["version"] == 2
    assert body["refreshed_at"] == "2026-10-01T15:00:00+00:00"
    assert [i["id"] for i in body["items"]] == [SONNET, HAIKU, NOVA, OPUS]
    sonnet = _item(body, SONNET)
    # Known models keep their state and prices; Bedrock only describes them.
    assert (sonnet["status"], sonnet["input_usd"]) == ("enabled", "3")
    assert (sonnet["name"], sonnet["provider"], sonnet["supports_vision"]) == (
        "US anthropic.claude-sonnet-4-6",
        "Anthropic",
        True,
    )
    # Not listed by Bedrock: no access.
    assert _item(body, HAIKU)["status"] == "noaccess"
    # New ones start disabled, without tools (Bedrock does not say) and without a price.
    nova = _item(body, NOVA)
    assert nova == {
        **nova,
        "status": "available",
        "provider": "Amazon",
        "supports_tools": False,
        "supports_vision": False,
        "input_usd": None,
        "output_usd": None,
        "list_input_usd": None,
        "confirmed_by": None,
    }
    assert ("list_foundation_models", {"byOutputModality": "TEXT"}) in env.bedrock.calls
    pages = [k for name, k in env.bedrock.calls if name == "list_inference_profiles"]
    assert len(pages) == 3
    assert all(k["typeEquals"] == "SYSTEM_DEFINED" for k in pages)
    requested, applied = _events(env, "settings.models.refreshed")
    assert requested == {
        "base_version": 1,
        "added": [NOVA, OPUS],
        "added_count": 2,
        "missing": [HAIKU],
        "missing_count": 1,
        "outcome": "requested",
    }
    assert applied["outcome"] == "applied"
    # The builder still only offers what an administrator enabled.
    builder = env.client.get("/api/models", headers=_h("admin")).json()
    assert [m["id"] for m in builder["items"]] == [SONNET]


def test_refresh_takes_capabilities_from_the_release(env: Env) -> None:
    capabilities = {
        "amazon.nova-pro-v1:0": ModelCapability(supports_tools=True, context_tokens=300_000),
        "anthropic.claude-sonnet-4-6": ModelCapability(supports_tools=True, context_tokens=200_000),
    }
    env.models.capabilities = lambda: capabilities
    body = _refresh(env).json()
    # A discovered model the release knows gets its capabilities; one it does not, none.
    nova, opus = _item(body, NOVA), _item(body, OPUS)
    assert (nova["supports_tools"], nova["context_tokens"]) == (True, 300_000)
    assert (opus["supports_tools"], opus["context_tokens"]) == (False, None)
    # A known model takes them too; one Bedrock no longer lists keeps what it had.
    assert _item(body, SONNET)["context_tokens"] == 200_000
    assert _item(body, HAIKU)["supports_tools"] is True

    assert _enable(env, NOVA).status_code == 200
    builder = env.client.get("/api/models", headers=_h("admin")).json()["items"]
    assert {m["id"]: (m["supports_tools"], m["context_tokens"]) for m in builder} == {
        SONNET: (True, 200_000),
        NOVA: (True, 300_000),
    }

    # The release stops listing a model: it keeps the capabilities it had.
    env.models.capabilities = dict
    assert _item(_refresh(env).json(), NOVA)["context_tokens"] == 300_000


def test_refresh_changes_nothing_without_the_release_capabilities(env: Env) -> None:
    def broken() -> dict[str, ModelCapability]:
        raise ModelCapabilitiesError("missing")

    env.models.capabilities = broken
    response = _refresh(env)
    assert (response.status_code, _code(response)) == (503, "capabilities_unavailable")
    assert env.store.catalog().version == 1
    assert _events(env, "settings.models.refreshed") == []


def test_the_release_capabilities_file_is_valid() -> None:
    capabilities = load_capabilities(Path(__file__).parents[3] / "models" / "capabilities.json")
    assert capabilities["anthropic.claude-sonnet-4-6"].supports_tools is True
    # Keys are foundation model ids, never inference profile ids.
    assert not [k for k in capabilities if k.split(".")[0] in {"us", "eu", "apac", "global"}]


@pytest.mark.parametrize(
    "content",
    [
        "",
        "[]",
        '{"schema": 2, "models": {}}',
        '{"schema": 1, "models": {"anthropic.claude-x": {"supports_tools": "yes"}}}',
        '{"schema": 1, "models": {"anthropic.claude-x": {"supports_tools": true, "extra": 1}}}',
        '{"schema": 1, "models": {"no dot": {"supports_tools": true}}}',
        '{"schema": 1, "models": {"a.b": {"supports_tools": true, "context_tokens": 5}}}',
    ],
)
def test_an_invalid_capabilities_file_is_rejected(tmp_path: Path, content: str) -> None:
    file = tmp_path / "capabilities.json"
    file.write_text(content)
    with pytest.raises(ModelCapabilitiesError):
        load_capabilities(file)
    with pytest.raises(ModelCapabilitiesError):
        load_capabilities(tmp_path / "missing.json")


def test_a_model_without_access_cannot_be_enabled(env: Env) -> None:
    assert _refresh(env).status_code == 200
    response = _enable(env, HAIKU)
    assert response.status_code == 409
    assert _code(response) == "model_no_access"
    # Access comes back when Bedrock lists it again.
    env.bedrock.foundation.append(_foundation("anthropic.claude-haiku-4-5-20251001-v1:0", "A"))
    env.bedrock.profiles.append(_profile(HAIKU, "anthropic.claude-haiku-4-5-20251001-v1:0"))
    assert _item(_refresh(env).json(), HAIKU)["status"] == "available"
    assert _enable(env, HAIKU).status_code == 200


def test_a_new_model_needs_a_price_to_be_enabled(env: Env) -> None:
    assert _refresh(env).status_code == 200
    response = _enable(env, NOVA, input_usd="0.8", output_usd="3.2")
    assert response.status_code == 200
    stored = env.store.catalog().get(NOVA)
    assert stored is not None
    # Without a known cache price, cache tokens cost as much as input: never cheaper.
    assert (stored.cache_read_usd, stored.cache_write_usd) == (Decimal("0.8"), Decimal("0.8"))
    assert stored.supports_tools is False


def test_refresh_ignores_what_it_cannot_use(env: Env) -> None:
    env.bedrock.foundation.append(_foundation("stability.sd3", "Stability"))
    env.bedrock.profiles[:] = [
        _profile(SONNET, "anthropic.claude-sonnet-4-6", inferenceProfileName=f"  {XSS}\x00  "),
        _profile("us.old.model", "anthropic.claude-opus-4-7", status="DEPRECATED"),
        _profile("bad id", "anthropic.claude-opus-4-7"),
        _profile("us.embed.model", "cohere.embed-v4"),  # not a text model of the region
        _profile("us.no.models", "anthropic.claude-opus-4-7", models=None),
        {"inferenceProfileId": 7, "status": "ACTIVE"},
    ]
    body = _refresh(env).json()
    assert [i["id"] for i in body["items"]] == [SONNET, HAIKU]
    # A name with control characters is not stored; the id stands in for it.
    assert _item(body, SONNET)["name"] == SONNET


def test_refresh_is_rate_limited_per_administrator(env: Env) -> None:
    assert _refresh(env).status_code == 200
    assert _refresh(env).status_code == 200
    limited = _refresh(env)
    assert limited.status_code == 429
    assert limited.headers["Retry-After"] == "60"
    assert _refresh(env, "admin2").status_code == 200
    env.limiter_clock[0] = 61
    assert _refresh(env).status_code == 200


def test_refresh_leaves_the_catalog_alone_when_bedrock_fails(env: Env) -> None:
    env.bedrock.fail = True
    response = _refresh(env)
    assert response.status_code == 502
    assert _code(response) == "bedrock_unavailable"
    assert env.store.catalog().version == 1
    assert _events(env, "settings.models.refreshed") == []
    assert _refresh(env).status_code == 502
    assert env.client.post(f"{URL}/refresh", headers=_h("admin"), json={"x": 1}).status_code == 422


def test_the_catalog_never_grows_past_its_limit() -> None:
    def entry(index: int) -> ModelEntry:
        return ModelEntry.model_validate(
            {
                "id": f"us.known.m{index:03d}",
                "name": "m",
                "provider": "p",
                "enabled": False,
                "supports_tools": True,
                "input_usd": "1",
                "output_usd": "1",
                "cache_read_usd": "1",
                "cache_write_usd": "1",
            }
        )

    known = [entry(i) for i in range(MAX_CATALOG_MODELS - 1)]
    listed = [BedrockModel(f"us.new.m{i}", "n", "p", False) for i in range(3)]
    price = ModelPrice(Decimal(2), Decimal(4), Decimal("0.2"), Decimal("2.5"))
    merged, added, missing = merge_bedrock(known, listed, {"us.new.m0": price})
    assert len(merged) == MAX_CATALOG_MODELS
    assert added == ["us.new.m0"]
    assert len(missing) == MAX_CATALOG_MODELS - 1
    # A price of the installation configuration is the starting price of a new model.
    assert (merged[-1].input_usd, merged[-1].cache_write_usd) == (Decimal(2), Decimal("2.5"))


def test_the_stored_catalog_stays_readable_by_the_seed_format(env: Env) -> None:
    assert _refresh(env).status_code == 200
    item = env.db.get_item(
        TableName="settings", Key={"PK": {"S": "MODELS"}, "SK": {"S": "CATALOG"}}
    )["Item"]
    assert item["updated_by"]["S"] == "admin-1"
    assert item["refreshed_at"]["S"] == item["updated_at"]["S"]
    stored = {m["id"]: m for m in json.loads(item["models"]["S"])}
    assert stored[SONNET]["input_usd"] == "3"
    assert stored[SONNET]["in_bedrock"] is True
    assert "confirmed_by" not in stored[SONNET]
