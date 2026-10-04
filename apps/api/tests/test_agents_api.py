"""Agents API (Marketplace A3): real Cedar policies, moto DynamoDB and a recording audit."""

from __future__ import annotations

import json
import re
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api.agent_rules import MAX_DRAFTS, MAX_SUBMISSIONS_PER_DAY
from mango_api.agents import MAX_DIFF_LINES, AgentsDeps, diff_definitions
from mango_api.agents_store import AgentsStore
from mango_api.authz import Authorizer
from mango_api.groups import GroupRegistry
from mango_api.mcp_catalog import McpCatalog
from mango_api.model_catalog import ModelCatalogCache, ModelCatalogStore
from mango_api.provisioner import DeprovisionerClient, ProvisionerClient
from mango_api.published import PublishedAgents
from mango_core.agents import AgentDefinition
from mango_core.agents_table import publish_items
from mango_core.identity import IdentityError

from .cedar_fake import CedarPolicyStore
from .test_admin import RecordingAudit, _table
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

CONNECTORS = Path(__file__).parents[3] / "connectors"
SONNET = "us.anthropic.claude-sonnet-4-6"
HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
STATE_MACHINE = "arn:aws:states:us-east-1:111111111111:stateMachine:Mango-test-AgentProvisioner"
DEPROVISIONER = "arn:aws:states:us-east-1:111111111111:stateMachine:Mango-test-AgentDeprovisioner"
HARNESS = "arn:aws:bedrock-agentcore:us-east-1:111111111111:harness/Mango_test_a_{}-abcdefghij"
"""Harness the provisioner creates for an agent of the ``test`` namespace."""
COST_TOOL = "cost-explorer.get_cost_and_usage"
# Assembled at run time so secret scanners do not flag the fixture.
SECRET = "AKIA" + "ABCDEFGHIJKLMNOP"
XSS = "<img src=x onerror=alert(1)>"
EXP = int(time.time()) + 3600
TOKENS: dict[str, dict[str, Any]] = {
    "admin": {
        "sub": "admin-1",
        "mango_admin": "true",
        "mango_email": "admin1@example.com",
        "cognito:groups": ["mango-admin"],
    },
    "admin2": {"sub": "admin-2", "mango_admin": "true", "cognito:groups": ["mango-admin"]},
    "creator": {
        "sub": "creator-1",
        "mango_email": "creator1@example.com",
        "cognito:groups": ["mango-agent-creator", "hr"],
    },
    "creator2": {"sub": "creator-2", "cognito:groups": ["mango-agent-creator"]},
    "member": {"sub": "member-1", "cognito:groups": ["hr"]},
    "lead": {
        "sub": "lead-1",
        "mango_role": "bu-lead",
        "mango_business_unit": "security",
        "cognito:groups": ["bu-lead", "bu-security"],
    },
    "outsider": {"sub": "out-1", "cognito:groups": ["ops"]},
}


class FakeVerifier:
    def verify(self, token: str) -> dict[str, Any]:
        if token not in TOKENS:
            raise IdentityError("invalid")
        return {**TOKENS[token], "exp": EXP}


@dataclass
class FakeStepFunctions:
    fail: bool = False
    executions: list[dict[str, Any]] = field(default_factory=list)

    def start_execution(self, **kwargs: Any) -> dict[str, Any]:
        if self.fail:
            raise ClientError({"Error": {"Code": "ThrottlingException"}}, "StartExecution")
        self.executions.append(kwargs)
        return {"executionArn": "arn:execution"}

    # What Step Functions says of each execution, by name (default: still running).
    statuses: dict[str, str] = field(default_factory=dict)
    list_fails: bool = False
    listings: int = 0

    def list_executions(self, **kwargs: Any) -> dict[str, Any]:
        self.listings += 1
        if self.list_fails:
            raise ClientError({"Error": {"Code": "AccessDeniedException"}}, "ListExecutions")
        assert set(kwargs) == {"stateMachineArn", "maxResults"}
        return {
            "executions": [
                {"name": e["name"], "status": self.statuses.get(e["name"], "RUNNING")}
                for e in reversed(self.executions)
            ]
        }


@dataclass
class Env:
    client: TestClient
    db: Any
    audit: RecordingAudit
    cedar: CedarPolicyStore
    sfn: FakeStepFunctions
    deps: AgentsDeps
    now: list[datetime]
    # What the chat tests look at (`test_chat_agents.py`).
    agentcore: FakeAgentCore = field(kw_only=True, default_factory=FakeAgentCore)
    budgets: FakeBudgets = field(kw_only=True, default_factory=FakeBudgets)
    # Executions of the deprovisioner, apart from the publications in `sfn`.
    retire_sfn: FakeStepFunctions = field(kw_only=True, default_factory=FakeStepFunctions)


def _models(db: Any, *, sonnet_enabled: bool = True) -> None:
    def model(model_id: str, enabled: bool) -> dict[str, Any]:
        return {
            "id": model_id,
            "name": model_id,
            "provider": "anthropic",
            "enabled": enabled,
            "supports_tools": True,
            "input_usd": "3",
            "output_usd": "15",
            "cache_read_usd": "0.3",
            "cache_write_usd": "3.75",
        }

    db.put_item(
        TableName="settings",
        Item={
            "PK": {"S": "MODELS"},
            "SK": {"S": "CATALOG"},
            "models": {"S": json.dumps([model(SONNET, sonnet_enabled), model(HAIKU, False)])},
            "version": {"N": "1"},
        },
    )


def _group(db: Any, group_id: str, kind: str, **extra: str) -> None:
    item = {"PK": {"S": "GROUPS"}, "SK": {"S": group_id}, "type": {"S": kind}}
    item.update({k: {"S": v} for k, v in extra.items()})
    db.put_item(TableName="settings", Item=item)


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "settings")
        create_agents_table(db, "agents")
        _group(db, "finops-central", "central")
        _group(db, "bu-security", "area", area="security")
        _group(db, "hr", "general")
        _group(db, "ops", "general")
        _models(db)
        audit, cedar, sfn = RecordingAudit(), CedarPolicyStore(), FakeStepFunctions()
        authorizer = Authorizer(cedar, "ps")  # type: ignore[arg-type]
        registry = GroupRegistry(db, "settings")
        catalog = McpCatalog.load(CONNECTORS)
        now = [datetime(2026, 10, 1, 15, 0, tzinfo=UTC)]
        store = AgentsStore(db, "agents")
        # No cache between requests: a test publishes or retires and asks again at once.
        published = PublishedAgents(
            store, lambda: catalog, namespace="test", region="us-east-1", clock=time.time
        )
        monkeypatch.setattr("mango_api.published.CACHE_SECONDS", 0)
        agentcore, budgets, retire_sfn = FakeAgentCore(), FakeBudgets(), FakeStepFunctions()
        deps = AgentsDeps(
            store=store,
            audit=audit,  # type: ignore[arg-type]
            authorizer=authorizer,
            groups=registry,
            models=ModelCatalogStore(db, "settings"),
            catalog=lambda: catalog,
            provisioner=ProvisionerClient(sfn, STATE_MACHINE),  # type: ignore[arg-type]
            clock=lambda: now[0],
            published=published,
            deprovisioner=DeprovisionerClient(retire_sfn, DEPROVISIONER),  # type: ignore[arg-type]
        )

        def factory(s: Any) -> app_module.Services:
            return app_module.Services(
                settings=s,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=authorizer,
                budgets=budgets,  # type: ignore[arg-type]
                conversations=FakeConversations(),  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=agentcore,
                bedrock=FakeBedrock(),
                settings_store=None,  # type: ignore[arg-type]
                budget_limits=FakeLimits(),  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=published,
                model_catalog=ModelCatalogCache(ModelCatalogStore(db, "settings"), ttl_seconds=0),
                invocation_key=b"k" * 32,
                group_registry=registry,
                agents=deps,
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(
            client,
            db,
            audit,
            cedar,
            sfn,
            deps,
            now,
            agentcore=agentcore,
            budgets=budgets,
            retire_sfn=retire_sfn,
        )
        # Every request and entity fitted the schema (same check as Verified Permissions).
        assert cedar.errors == []


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def _definition(**overrides: Any) -> dict[str, Any]:
    return {
        "name": "Asistente de costos",
        "description": "Responde preguntas de gasto.",
        "category": "FinOps",
        "role": "Analista",
        "reports_to": "platform",
        "model": SONNET,
        "allowed_models": [SONNET],
        "system_prompt": "Eres un analista.\nResponde en español.",
        "tools": [COST_TOOL],
        "groups": ["hr"],
        **overrides,
    }


def _create(env: Env, token: str = "creator", **overrides: Any) -> dict[str, Any]:
    response = env.client.post(
        "/api/agents", headers=_h(token), json={"definition": _definition(**overrides)}
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def _url(version: dict[str, Any], suffix: str = "") -> str:
    return f"/api/agents/{version['agent_id']}/versions/{version['version']}{suffix}"


def _submit(env: Env, version: dict[str, Any], token: str = "creator") -> dict[str, Any]:
    response = env.client.post(
        _url(version, "/submit"), headers=_h(token), json={"revision": version["revision"]}
    )
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def _approve(env: Env, version: dict[str, Any], token: str = "admin") -> Any:
    return env.client.post(
        _url(version, "/approve"),
        headers=_h(token),
        json={"content_hash": version["content_hash"]},
    )


def _publish(env: Env, version: dict[str, Any], previous: int | None = None) -> None:
    """What the provisioner does once the harness is ready."""
    env.db.transact_write_items(
        TransactItems=publish_items(
            "agents",
            agent_id=version["agent_id"],
            version=version["version"],
            content_hash=version["content_hash"],
            previous_version=previous,
            harness_arn=HARNESS.format(version["agent_id"]),
            harness_version=str(version["version"]),
            now=env.now[0],
        )
    )


def _published(env: Env, token: str = "creator", **overrides: Any) -> dict[str, Any]:
    """A published agent: created and sent by ``token``, approved by an administrator."""
    review = _submit(env, _create(env, token, **overrides), token)
    approver = "admin2" if token == "admin" else "admin"
    assert _approve(env, review, approver).status_code == 200
    _publish(env, review)
    return review


def _events(env: Env, name: str) -> list[tuple[str, dict[str, Any]]]:
    return [(d["outcome"], d) for e, _u, d in env.audit.events if e == name]


# --- Authorization matrix ---------------------------------------------------------------

EVERYONE = set(TOKENS)
ADMINS = {"admin", "admin2"}
CREATORS = ADMINS | {"creator", "creator2"}
OWNERS = ADMINS | {"creator"}

# (method, path with {draft} / {review} / {live} placeholders, body, Cedar action, allowed)
Case = tuple[str, str, dict[str, Any] | None, str, set[str]]
_DRAFT = "/api/agents/{draft}/versions/1"
_REVIEW = "/api/agents/{review}/versions/1"
_STALE_HASH = {"content_hash": "0" * 64}
_STALE_DRAFT = {"revision": 99, "definition": {"name": "x"}}
MATRIX: list[Case] = [
    ("GET", "/api/agents/mine", None, "CreateAgent", CREATORS),
    ("POST", "/api/agents", {"definition": {"name": "x"}}, "CreateAgent", CREATORS),
    ("GET", "/api/models", None, "CreateAgent", CREATORS),
    ("GET", "/api/mcp/catalog", None, "ViewMcpCatalog", CREATORS),
    ("GET", "/api/agents/reviews", None, "ApproveAgent", ADMINS),
    ("GET", _DRAFT, None, "EditAgent", OWNERS),
    ("PUT", _DRAFT, _STALE_DRAFT, "EditAgent", OWNERS),
    ("DELETE", _DRAFT + "?revision=99", None, "EditAgent", OWNERS),
    ("POST", _DRAFT + "/submit", {"revision": 99}, "EditAgent", OWNERS),
    ("POST", _DRAFT + "/reopen", {}, "EditAgent", OWNERS),
    ("POST", "/api/agents/{live}/versions", {}, "EditAgent", OWNERS),
    ("POST", _REVIEW + "/approve", _STALE_HASH, "ApproveAgent", ADMINS),
    ("POST", _REVIEW + "/reject", {"reason": "no"}, "ApproveAgent", ADMINS),
    ("POST", _REVIEW + "/retry", _STALE_HASH, "ApproveAgent", ADMINS),
    (
        "POST",
        "/api/agents/{live}/retire",
        {"lock_version": 99, "reason": "x"},
        "RetireAgent",
        ADMINS,
    ),
]


@pytest.mark.parametrize("case", MATRIX, ids=lambda c: f"{c[0]} {c[1]}")
def test_authorization_matrix(env: Env, case: Case) -> None:
    method, path, body, action, allowed = case
    ids = {
        "draft": _create(env)["agent_id"],
        "review": _submit(env, _create(env))["agent_id"],
        "live": _published(env)["agent_id"],
    }
    url = path.format(**ids)
    assert env.client.request(method, url, json=body).status_code == 401
    for token in sorted(EVERYONE):
        before = len(env.audit.events)
        response = env.client.request(method, url, headers=_h(token), json=body)
        sub = TOKENS[token]["sub"]
        # Reading a version is EditAgent or, for whoever cannot edit it, ApproveAgent.
        read = method == "GET" and "/versions/" in path
        expected = "ApproveAgent" if read and token not in allowed else action
        decisions = [
            d
            for e, u, d in env.audit.events[before:]
            if e == "policy.decision" and u == sub and d["action"] == expected
        ]
        if token in allowed:
            # Past authorization: the bodies above are stale on purpose (409) or minimal.
            assert response.status_code not in (401, 403), (token, response.text)
            assert decisions and decisions[0]["allowed"] is True
        else:
            assert response.status_code == 403, (token, response.text)
            assert _code(response) == "forbidden"
            # The denial is audited, and nothing else happened.
            assert [d["allowed"] for d in decisions] == [False]
            assert [e for e, _u, _d in env.audit.events[before:]] == ["policy.decision"]


def test_a_reviewer_reads_a_version_as_approver_and_a_stranger_cannot(env: Env) -> None:
    review = _submit(env, _create(env))
    assert env.client.get(_url(review), headers=_h("admin")).status_code == 200
    # Administrators may edit, so their read is an EditAgent decision; creators only on
    # their own agents.
    assert env.client.get(_url(review), headers=_h("creator2")).status_code == 403
    assert env.cedar.decisions[-1] == ("creator-2", "ApproveAgent", review["agent_id"], False)


def test_unknown_agents_look_forbidden_to_those_who_could_not_act_on_them(env: Env) -> None:
    missing = "a" * 16
    for token in ("creator", "member"):
        for path in (f"/api/agents/{missing}", f"/api/agents/{missing}/versions/1"):
            assert env.client.get(path, headers=_h(token)).status_code == 403
    assert (
        env.client.get(f"/api/agents/{missing}/versions/1", headers=_h("admin")).status_code == 404
    )
    draft = _create(env)
    assert env.client.get(_url(draft)[:-1] + "7", headers=_h("admin")).status_code == 404
    # Malformed ids never reach the store.
    assert (
        env.client.get("/api/agents/NOT-AN-ID/versions/1", headers=_h("admin")).status_code == 422
    )
    assert env.client.get(_url(draft)[:-1] + "0", headers=_h("admin")).status_code == 422


# --- Drafts -----------------------------------------------------------------------------


def test_a_creator_creates_edits_and_sends_a_draft(env: Env) -> None:
    draft = _create(env)
    assert re.fullmatch(r"[a-z2-7]{16}", draft["agent_id"])
    assert (draft["version"], draft["status"], draft["revision"]) == (1, "draft", 1)
    assert draft["created_by"] == "creator-1" and draft["is_author"] is True
    assert draft["content_hash"] is None and draft["violations"] == []
    assert draft["agent"] == {
        "status": "draft",
        "lock_version": 1,
        "published_version": None,
        "open_version": 1,
        "created_by": "creator-1",
    }
    assert "editors" not in draft

    saved = env.client.put(
        _url(draft),
        headers=_h("creator"),
        json={"revision": 1, "definition": _definition(role="")},
    )
    assert saved.status_code == 200
    assert saved.json()["revision"] == 2
    # What the builder shows as pending comes from the server rules.
    assert saved.json()["violations"] == [{"code": "role_required", "field": "role", "items": []}]

    stale = env.client.put(
        _url(draft), headers=_h("creator"), json={"revision": 1, "definition": _definition()}
    )
    assert (stale.status_code, _code(stale)) == (409, "version_conflict")

    fixed = env.client.put(
        _url(draft), headers=_h("creator"), json={"revision": 2, "definition": _definition()}
    ).json()
    review = _submit(env, fixed)
    assert review["status"] == "in_review"
    assert re.fullmatch(r"[0-9a-f]{64}", review["content_hash"])
    assert (review["submitted_by"], review["revision"]) == ("creator-1", 3)

    mine = env.client.get("/api/agents/mine", headers=_h("creator")).json()
    assert [(i["agent_id"], i["status"]) for i in mine["items"]] == [
        (draft["agent_id"], "in_review")
    ]
    assert mine["quotas"] == {
        "drafts": 0,
        "max_drafts": MAX_DRAFTS,
        "submissions_today": 1,
        "max_submissions_per_day": MAX_SUBMISSIONS_PER_DAY,
    }
    assert env.client.get("/api/agents/mine", headers=_h("creator2")).json()["items"] == []


def test_a_version_cannot_change_after_it_is_sent(env: Env) -> None:
    review = _submit(env, _create(env))
    for token in ("creator", "admin"):
        edit = env.client.put(
            _url(review),
            headers=_h(token),
            json={"revision": review["revision"], "definition": _definition(name="Otro")},
        )
        assert (edit.status_code, _code(edit)) == (409, "version_conflict")
        delete = env.client.delete(
            _url(review) + f"?revision={review['revision']}", headers=_h(token)
        )
        assert delete.status_code == 409
        again = env.client.post(
            _url(review, "/submit"), headers=_h(token), json={"revision": review["revision"]}
        )
        assert again.status_code == 409
    stored = env.client.get(_url(review), headers=_h("admin")).json()
    assert stored["definition"]["name"] == "Asistente de costos"
    assert stored["content_hash"] == review["content_hash"]


def test_a_draft_can_be_deleted_by_its_owner(env: Env) -> None:
    draft = _create(env)
    wrong = env.client.delete(_url(draft) + "?revision=5", headers=_h("creator"))
    assert wrong.status_code == 409
    assert env.client.delete(_url(draft), headers=_h("creator")).status_code == 422
    gone = env.client.delete(_url(draft) + "?revision=1", headers=_h("creator"))
    assert (gone.status_code, gone.content) == (204, b"")
    assert env.client.get(_url(draft), headers=_h("admin")).status_code == 404
    assert env.client.get("/api/agents/mine", headers=_h("creator")).json()["items"] == []
    (outcome, detail), *_ = reversed(_events(env, "agent.version.discarded"))
    assert outcome == "applied"
    assert (detail["agent"], detail["discarded_by"]) == (draft["agent_id"], "creator-1")


def test_quotas_per_creator(env: Env) -> None:
    drafts = [_create(env) for _ in range(MAX_SUBMISSIONS_PER_DAY + 1)]
    for draft in drafts[:-1]:
        _submit(env, draft)
    limited = env.client.post(
        _url(drafts[-1], "/submit"), headers=_h("creator"), json={"revision": 1}
    )
    assert (limited.status_code, _code(limited)) == (429, "submission_limit")
    # 15:00 UTC: nine hours until the counter of the next UTC day.
    assert limited.headers["Retry-After"] == str(9 * 3600)
    assert _events(env, "agent.version.submitted")[-1][1]["error"] == "submission_limit"
    assert env.client.get(_url(drafts[-1]), headers=_h("creator")).json()["status"] == "draft"

    for _ in range(MAX_DRAFTS - 1):
        _create(env)
    full = env.client.post("/api/agents", headers=_h("creator"), json={"definition": _definition()})
    assert (full.status_code, _code(full)) == (409, "too_many_drafts")
    # Another creator has their own quota.
    _create(env, "creator2")


# --- Validation -------------------------------------------------------------------------


def test_submit_reports_rule_codes_and_never_echoes_a_secret(env: Env) -> None:
    draft = _create(
        env,
        system_prompt=f"Usa la llave {SECRET} para entrar.",
        groups=["hr", "nope"],
        tools=[COST_TOOL, "cost-explorer.missing"],
        allowed_models=[HAIKU, SONNET],
    )
    response = env.client.post(_url(draft, "/submit"), headers=_h("creator"), json={"revision": 1})
    assert response.status_code == 422
    assert _code(response) == "validation_failed"
    violations = {(v["code"], v["field"]): v["items"] for v in response.json()["violations"]}
    assert violations == {
        ("secret_detected", "system_prompt"): ["aws_access_key_id"],
        ("model_not_enabled", "allowed_models"): [HAIKU],
        ("tool_not_enabled", "tools"): ["cost-explorer.missing"],
        ("group_unknown", "groups"): ["nope"],
    }
    assert SECRET not in response.text
    outcome, detail = _events(env, "agent.version.submitted")[-1]
    assert (outcome, detail["error"]) == ("rejected", "validation_failed")
    assert detail["violations"] == [
        "group_unknown",
        "model_not_enabled",
        "secret_detected",
        "tool_not_enabled",
    ]
    assert SECRET not in json.dumps(env.audit.events)
    assert env.client.get(_url(draft), headers=_h("creator")).json()["status"] == "draft"


@pytest.mark.parametrize(
    "body",
    [
        {"definition": {**_definition(), "iam_role": f"arn:aws:iam::1:role/{SECRET}"}},
        {"definition": _definition(name=""), "note": SECRET},
        {"definition": _definition(system_prompt=SECRET + chr(0x202E))},
        {"definition": _definition(tools=[SECRET])},
        {"definition": _definition(limits={"max_tokens": 10**9})},
        {"definition": _definition(reports_to="Not An Id " + SECRET)},
        # A made-up field name is content as well.
        {"definition": {**_definition(), SECRET: 1}},
        {SECRET: {}, "definition": _definition()},
    ],
)
def test_schema_errors_name_fields_without_echoing_content(env: Env, body: dict[str, Any]) -> None:
    response = env.client.post("/api/agents", headers=_h("creator"), json=body)
    assert (response.status_code, _code(response)) == (422, "invalid_request")
    assert SECRET not in response.text
    assert response.json()["error"]["message"].startswith("invalid fields: ")
    assert env.client.get("/api/agents/mine", headers=_h("creator")).json()["items"] == []


def test_creator_text_is_returned_as_plain_json_text(env: Env) -> None:
    live = _published(env, name=XSS, description=XSS, role=XSS, system_prompt=XSS)
    for path, token in (
        (_url(live), "admin"),
        (f"/api/agents/{live['agent_id']}", "member"),
        ("/api/agents", "member"),
        ("/api/agents/org", "member"),
        ("/api/agents/reviews", "admin"),
    ):
        response = env.client.get(path, headers=_h(token))
        assert response.headers["content-type"] == "application/json"
        assert XSS in json.dumps(response.json(), ensure_ascii=False)


# --- Review -----------------------------------------------------------------------------


def test_another_administrator_approves_and_the_provisioner_starts(env: Env) -> None:
    review = _submit(env, _create(env))
    queue = env.client.get("/api/agents/reviews", headers=_h("admin")).json()
    assert [(r["agent_id"], r["kind"], r["status"]) for r in queue["queue"]] == [
        (review["agent_id"], "new", "in_review")
    ]
    assert queue["queue"][0]["created_by_email"] == "creator1@example.com"

    response = _approve(env, review)
    assert response.status_code == 200
    approved = response.json()
    assert (approved["status"], approved["approved_by"]) == ("approved", "admin-1")
    assert approved["content_hash"] == review["content_hash"]

    (execution,) = env.sfn.executions
    assert execution["stateMachineArn"] == STATE_MACHINE
    # Identifiers and the approved hash only: nothing of the definition (TM-M1).
    assert json.loads(execution["input"]) == {
        "agent_id": review["agent_id"],
        "version": 1,
        "content_hash": review["content_hash"],
    }
    assert re.fullmatch(r"[A-Za-z0-9_-]{1,80}", execution["name"])

    outcomes = _events(env, "agent.version.approved")
    assert [o for o, _d in outcomes] == ["requested", "applied"]
    for _outcome, detail in outcomes:
        assert detail["created_by"] == "creator-1"
        assert detail["submitted_by"] == "creator-1"
        assert detail["approved_by"] == "admin-1"
        assert detail["content_hash"] == review["content_hash"]
        assert (detail["agent"], detail["version"]) == (review["agent_id"], 1)
    assert (
        env.audit.named("agent.provisioner.started", None)[0][1]["execution"] == execution["name"]
    )

    history = env.client.get("/api/agents/reviews", headers=_h("admin2")).json()
    assert history["queue"] == []
    assert [(r["status"], r["approved_by"]) for r in history["history"]] == [
        ("approved", "admin-1")
    ]
    # Approving twice does nothing.
    assert _approve(env, review, "admin2").status_code == 409
    assert len(env.sfn.executions) == 1


def test_whoever_wrote_a_version_cannot_approve_or_reject_it(env: Env) -> None:
    own = _submit(env, _create(env, "admin"), "admin")
    response = _approve(env, own, "admin")
    assert (response.status_code, _code(response)) == (403, "same_approver")
    rejected = _events(env, "agent.version.approved")[-1]
    assert rejected[0] == "rejected"
    assert rejected[1]["error"] == "same_approver"
    assert (rejected[1]["created_by"], rejected[1]["approved_by"]) == ("admin-1", "admin-1")
    assert rejected[1]["content_hash"] == own["content_hash"]
    reject = env.client.post(_url(own, "/reject"), headers=_h("admin"), json={"reason": "no"})
    assert (reject.status_code, _code(reject)) == (403, "same_approver")

    # An administrator who edited or sent someone else's draft is an author too.
    draft = _create(env)
    edited = env.client.put(
        _url(draft), headers=_h("admin2"), json={"revision": 1, "definition": _definition()}
    ).json()
    review = _submit(env, edited, "creator")
    assert env.client.get(_url(review), headers=_h("admin2")).json()["is_author"] is True
    assert _code(_approve(env, review, "admin2")) == "same_approver"
    sent_by_admin = _submit(env, _create(env), "admin2")
    assert _code(_approve(env, sent_by_admin, "admin2")) == "same_approver"

    assert env.sfn.executions == []
    for version in (own, review, sent_by_admin):
        status = env.client.get(_url(version), headers=_h("admin")).json()["status"]
        assert status == "in_review"
    assert _approve(env, review, "admin").status_code == 200


def test_approval_is_bound_to_the_hash_the_reviewer_saw(env: Env) -> None:
    review = _submit(env, _create(env))
    other = env.client.post(
        _url(review, "/approve"), headers=_h("admin"), json={"content_hash": "0" * 64}
    )
    assert (other.status_code, _code(other)) == (409, "version_conflict")
    malformed = env.client.post(
        _url(review, "/approve"), headers=_h("admin"), json={"content_hash": "abc"}
    )
    assert malformed.status_code == 422

    # The version goes back to draft, changes and is sent again: the old hash is useless.
    env.client.post(_url(review, "/reject"), headers=_h("admin"), json={"reason": "cambia"})
    draft = env.client.get(_url(review), headers=_h("creator")).json()
    changed = env.client.put(
        _url(draft),
        headers=_h("creator"),
        json={"revision": draft["revision"], "definition": _definition(name="Otro nombre")},
    ).json()
    again = _submit(env, changed)
    assert again["content_hash"] != review["content_hash"]
    assert _approve(env, review).status_code == 409
    assert env.sfn.executions == []
    assert _approve(env, again).status_code == 200


def test_rejecting_needs_a_reason_and_returns_the_version_to_draft(env: Env) -> None:
    review = _submit(env, _create(env))
    for body in ({}, {"reason": ""}, {"reason": "x" * 501}):
        response = env.client.post(_url(review, "/reject"), headers=_h("admin"), json=body)
        assert response.status_code == 422
    response = env.client.post(
        _url(review, "/reject"), headers=_h("admin"), json={"reason": f"Quita {XSS}"}
    )
    assert response.status_code == 200
    draft = response.json()
    assert (draft["status"], draft["content_hash"]) == ("draft", None)
    assert (draft["rejected_by"], draft["rejection_reason"]) == ("admin-1", f"Quita {XSS}")

    mine = env.client.get("/api/agents/mine", headers=_h("creator")).json()["items"]
    assert (mine[0]["status"], mine[0]["rejection_reason"]) == ("draft", f"Quita {XSS}")
    outcome, detail = _events(env, "agent.version.rejected")[-1]
    assert outcome == "applied"
    assert (detail["created_by"], detail["rejected_by"]) == ("creator-1", "admin-1")
    assert detail["content_hash"] == review["content_hash"]

    resent = _submit(env, draft)
    assert (resent["status"], resent["rejection_reason"]) == ("in_review", None)
    assert (
        env.client.post(
            _url(review, "/reject"), headers=_h("admin"), json={"reason": "no"}
        ).status_code
        == 200
    )
    assert (
        env.client.post(
            _url(review, "/reject"), headers=_h("admin"), json={"reason": "no"}
        ).status_code
        == 409
    )


def test_approval_runs_the_submit_rules_again(env: Env) -> None:
    review = _submit(env, _create(env))
    _models(env.db, sonnet_enabled=False)
    shown = env.client.get(_url(review), headers=_h("admin")).json()
    assert [v["code"] for v in shown["violations"]] == ["model_not_enabled"]
    response = _approve(env, review)
    assert (response.status_code, _code(response)) == (422, "validation_failed")
    assert response.json()["violations"] == [
        {"code": "model_not_enabled", "field": "allowed_models", "items": [SONNET]}
    ]
    outcome, detail = _events(env, "agent.version.approved")[-1]
    assert (outcome, detail["violations"]) == ("rejected", ["model_not_enabled"])
    assert env.sfn.executions == []
    assert env.client.get(_url(review), headers=_h("admin")).json()["status"] == "in_review"


def test_approval_sees_organization_changes_that_are_already_approved(env: Env) -> None:
    first = _published(env, name="A")
    second = _published(env, name="B")

    def change(agent: dict[str, Any], reports_to: str) -> dict[str, Any]:
        draft = env.client.post(
            f"/api/agents/{agent['agent_id']}/versions", headers=_h("creator"), json={}
        ).json()
        definition = {**draft["definition"], "reports_to": reports_to}
        saved = env.client.put(
            _url(draft), headers=_h("creator"), json={"revision": 1, "definition": definition}
        ).json()
        return _submit(env, saved)

    # Each change is valid against the published chart; together they are a cycle.
    a_under_b = change(first, second["agent_id"])
    b_under_a = change(second, first["agent_id"])
    assert _approve(env, a_under_b).status_code == 200
    response = _approve(env, b_under_a)
    assert (response.status_code, _code(response)) == (422, "validation_failed")
    assert response.json()["violations"] == [
        {"code": "reports_to_cycle", "field": "reports_to", "items": [first["agent_id"]]}
    ]
    assert len(env.sfn.executions) == 3  # two first versions and A's change


def test_nothing_is_approved_while_the_provisioner_is_not_deployed(env: Env) -> None:
    env.deps.provisioner = None
    review = _submit(env, _create(env))
    response = _approve(env, review)
    assert (response.status_code, _code(response)) == (503, "provisioner_unavailable")
    assert env.client.get(_url(review), headers=_h("admin")).json()["status"] == "in_review"
    assert _events(env, "agent.version.approved") == []


def test_a_publication_that_cannot_start_fails_and_can_be_retried(env: Env) -> None:
    review = _submit(env, _create(env))
    env.sfn.fail = True
    failed = _approve(env, review).json()
    assert (failed["status"], failed["failed_step"]) == ("failed", "start_provisioner")
    assert failed["approved_by"] == "admin-1"
    assert env.audit.named("agent.version.failed", None)[0][1]["failed_step"] == "start_provisioner"

    wrong = env.client.post(
        _url(review, "/retry"), headers=_h("admin2"), json={"content_hash": "0" * 64}
    )
    assert wrong.status_code == 409
    env.sfn.fail = False
    retried = env.client.post(
        _url(review, "/retry"),
        headers=_h("admin2"),
        json={"content_hash": review["content_hash"]},
    )
    assert retried.status_code == 200
    # Same content and same approver: a retry is not a new approval.
    assert (retried.json()["status"], retried.json()["approved_by"]) == ("approved", "admin-1")
    assert json.loads(env.sfn.executions[0]["input"])["content_hash"] == review["content_hash"]
    outcome, detail = _events(env, "agent.version.retried")[-1]
    assert (outcome, detail["retried_by"], detail["approved_by"]) == (
        "applied",
        "admin-2",
        "admin-1",
    )
    assert (
        env.client.post(
            _url(review, "/retry"),
            headers=_h("admin2"),
            json={"content_hash": review["content_hash"]},
        ).status_code
        == 409
    )


def test_a_failed_version_can_be_reopened_to_fix_it(env: Env) -> None:
    review = _submit(env, _create(env))
    assert (
        env.client.post(_url(review, "/reopen"), headers=_h("creator"), json={}).status_code == 409
    )
    env.sfn.fail = True
    _approve(env, review)
    reopened = env.client.post(_url(review, "/reopen"), headers=_h("creator"), json={})
    assert reopened.status_code == 200
    body = reopened.json()
    assert (body["status"], body["content_hash"], body["approved_by"]) == ("draft", None, None)
    # A corrected version needs a new review.
    assert (
        env.client.post(
            _url(review, "/retry"),
            headers=_h("admin"),
            json={"content_hash": review["content_hash"]},
        ).status_code
        == 409
    )


def test_an_approved_version_nothing_is_publishing_can_be_retried(env: Env) -> None:
    review = _submit(env, _create(env))
    assert _approve(env, review).status_code == 200
    body = {"content_hash": review["content_hash"]}

    def listed() -> dict[str, Any]:
        rows = env.client.get("/api/agents/reviews", headers=_h("admin2")).json()["history"]
        return next(r for r in rows if r["agent_id"] == review["agent_id"])

    # While an execution may still be running, the version cannot be retried.
    env.now[0] += timedelta(minutes=44)
    assert listed()["retryable"] is False
    early = env.client.post(_url(review, "/retry"), headers=_h("admin2"), json=body)
    assert (early.status_code, _code(early)) == (409, "version_conflict")
    assert len(env.sfn.executions) == 1

    env.now[0] += timedelta(minutes=2)
    assert listed()["retryable"] is True
    wrong = env.client.post(
        _url(review, "/retry"), headers=_h("admin2"), json={"content_hash": "0" * 64}
    )
    assert wrong.status_code == 409
    retried = env.client.post(_url(review, "/retry"), headers=_h("admin2"), json=body)
    assert retried.status_code == 200
    # Same content and same approver, and a second execution for exactly that hash.
    assert (retried.json()["status"], retried.json()["approved_by"]) == ("approved", "admin-1")
    assert len(env.sfn.executions) == 2
    assert json.loads(env.sfn.executions[1]["input"]) == {
        "agent_id": review["agent_id"],
        "version": 1,
        "content_hash": review["content_hash"],
    }
    outcome, detail = _events(env, "agent.version.retried")[-1]
    assert (outcome, detail["failed_step"], detail["retried_by"]) == (
        "applied",
        "publication_expired",
        "admin-2",
    )
    # The retry restarted the clock: it is not retryable again right away.
    assert listed()["retryable"] is False
    again = env.client.post(_url(review, "/retry"), headers=_h("admin2"), json=body)
    assert again.status_code == 409


def test_an_expired_approval_fails_when_the_provisioner_cannot_start(env: Env) -> None:
    review = _submit(env, _create(env))
    _approve(env, review)
    env.now[0] += timedelta(minutes=46)
    env.sfn.fail = True
    retried = env.client.post(
        _url(review, "/retry"), headers=_h("admin2"), json={"content_hash": review["content_hash"]}
    )
    assert retried.status_code == 200
    assert (retried.json()["status"], retried.json()["failed_step"]) == (
        "failed",
        "start_provisioner",
    )


def test_the_history_shows_who_decided_and_why(env: Env) -> None:
    rejected = _submit(env, _create(env, name="Rechazado"))
    env.client.post(_url(rejected, "/reject"), headers=_h("admin"), json={"reason": f"Falta {XSS}"})
    live = _published(env, name="Publicado")
    retired = _published(env, name="Retirado")
    lock = env.client.get(_url(retired), headers=_h("admin")).json()["agent"]["lock_version"]
    done = env.client.post(
        f"/api/agents/{retired['agent_id']}/retire",
        headers=_h("admin"),
        json={"lock_version": lock, "reason": "Duplicado"},
    )
    assert done.status_code == 200

    history = env.client.get("/api/agents/reviews", headers=_h("admin2")).json()["history"]
    rows = {r["name"]: r for r in history}
    assert set(rows) == {"Rechazado", "Publicado", "Retirado"}

    row = rows["Rechazado"]
    assert (row["status"], row["rejection_reason"]) == ("draft", f"Falta {XSS}")
    assert (row["rejected_by"], row["rejected_by_email"]) == ("admin-1", "admin1@example.com")
    assert row["rejected_at"] == row["decided_at"]
    assert row["retryable"] is False

    row = rows["Publicado"]
    assert (row["status"], row["approved_by"], row["approved_by_email"]) == (
        "published",
        "admin-1",
        "admin1@example.com",
    )
    # A first version: every tool, group and the prompt count as changes.
    assert row["kind"] == "new"
    assert row["changes"] == diff_definitions(None, AgentDefinition(**_definition())).changes
    assert row["retire_reason"] is None

    row = rows["Retirado"]
    assert (row["status"], row["retire_reason"]) == ("retired", "Duplicado")
    assert (row["retired_by"], row["retired_by_email"]) == ("admin-1", "admin1@example.com")
    assert row["retired_at"] == row["decided_at"]

    # A rejected draft leaves the history once its author sends it again.
    draft = env.client.get(_url(rejected), headers=_h("creator")).json()
    assert draft["rejected_by_email"] == "admin1@example.com"
    _submit(env, draft)
    history = env.client.get("/api/agents/reviews", headers=_h("admin2")).json()["history"]
    assert "Rechazado" not in {r["name"] for r in history}
    assert live["agent_id"] in {r["agent_id"] for r in history}


def test_the_history_counts_the_changes_of_a_published_change(env: Env) -> None:
    live = _published(env)
    draft = env.client.post(
        f"/api/agents/{live['agent_id']}/versions", headers=_h("creator"), json={}
    ).json()
    saved = env.client.put(
        _url(draft),
        headers=_h("creator"),
        json={"revision": draft["revision"], "definition": _definition(role="Otro rol")},
    ).json()
    review = _submit(env, saved)
    _approve(env, review)
    _publish(env, review, previous=1)
    history = env.client.get("/api/agents/reviews", headers=_h("admin2")).json()["history"]
    row = next(r for r in history if r["version"] == 2)
    assert (row["kind"], row["status"], row["changes"]) == ("change", "published", 1)


def test_writes_fail_closed_when_the_audit_trail_is_down(env: Env) -> None:
    draft = _create(env)
    review = _submit(env, _create(env))
    env.audit.fail_outcomes = {"requested"}
    attempts = [
        env.client.post("/api/agents", headers=_h("creator"), json={"definition": _definition()}),
        env.client.put(
            _url(draft), headers=_h("creator"), json={"revision": 1, "definition": _definition()}
        ),
        env.client.post(_url(draft, "/submit"), headers=_h("creator"), json={"revision": 1}),
        env.client.delete(_url(draft) + "?revision=1", headers=_h("creator")),
        _approve(env, review),
        env.client.post(_url(review, "/reject"), headers=_h("admin"), json={"reason": "no"}),
    ]
    assert [(r.status_code, _code(r)) for r in attempts] == [(503, "audit_unavailable")] * 6
    env.audit.fail_outcomes = set()
    assert env.sfn.executions == []
    mine = env.client.get("/api/agents/mine", headers=_h("creator")).json()["items"]
    assert sorted((i["status"], i["revision"]) for i in mine) == [("draft", 1), ("in_review", 1)]

    # A lost ``applied`` record does not undo the write: ``requested`` is already stored.
    env.audit.fail_outcomes = {"applied"}
    assert _approve(env, review).json()["status"] == "approved"


# --- Marketplace, organization chart and retirement -------------------------------------


def test_the_marketplace_lists_only_agents_the_caller_may_use(env: Env) -> None:
    for_hr = _published(env, name="Para HR", groups=["hr"])
    for_ops = _published(env, name="Para Ops", groups=["ops"], users=["lead-1"])
    _create(env, name="Borrador")
    _submit(env, _create(env, name="En revisión"))

    def names(token: str) -> list[str]:
        response = env.client.get("/api/agents", headers=_h(token))
        assert response.status_code == 200
        return [a["name"] for a in response.json()["items"]]

    assert names("member") == ["Para HR"]
    assert names("creator") == ["Para HR"]  # by group, not for having created them
    assert names("outsider") == ["Para Ops"]
    assert names("lead") == ["Para Ops"]  # shared with the user
    assert names("admin") == []  # administrators review agents; using one needs access

    listed = env.client.get("/api/agents", headers=_h("member")).json()["items"][0]
    assert "system_prompt" not in listed and "groups" not in listed and "users" not in listed
    assert (listed["id"], listed["status"], listed["tools"]) == (
        for_hr["agent_id"],
        "published",
        [COST_TOOL],
    )
    # One audited read per list, not one per agent.
    reads = [d for e, u, d in env.audit.events if e == "policy.decision" and u == "member-1"]
    assert reads[-1] == {
        "action": "UseAgent",
        "resource": "Mango::Agent::*",
        "allowed": True,
        "read_only": True,
        "scope": "marketplace",
        "visible": 1,
    }

    detail = env.client.get(f"/api/agents/{for_hr['agent_id']}", headers=_h("member"))
    assert detail.status_code == 200
    assert "system_prompt" not in detail.json()
    hidden = env.client.get(f"/api/agents/{for_ops['agent_id']}", headers=_h("member"))
    unknown = env.client.get(f"/api/agents/{'b' * 16}", headers=_h("member"))
    assert (hidden.status_code, hidden.json()) == (unknown.status_code, unknown.json())
    assert hidden.status_code == 403


def test_the_detail_is_the_version_the_provisioner_published(env: Env) -> None:
    agent = _published(env, name="Para HR", groups=["hr"])
    agent_id = agent["agent_id"]
    # mango-api can write META; what is served comes from the provisioner's pointer (D40).
    env.db.update_item(
        TableName="agents",
        Key={"PK": {"S": f"AGENT#{agent_id}"}, "SK": {"S": "META"}},
        UpdateExpression="SET published_version = :n",
        ExpressionAttributeValues={":n": {"N": "9"}},
    )
    detail = env.client.get(f"/api/agents/{agent_id}", headers=_h("member"))
    assert (detail.status_code, detail.json()["version"]) == (200, 1)
    # Content that is not what was deployed is not shown as the agent (fail closed).
    env.db.update_item(
        TableName="agents",
        Key={"PK": {"S": f"AGENT#{agent_id}"}, "SK": {"S": "VERSION#000001"}},
        UpdateExpression="SET #d = :d",
        ExpressionAttributeNames={"#d": "definition"},
        ExpressionAttributeValues={
            ":d": {"S": json.dumps({"name": "Otro", "groups": ["hr", "ops"]})}
        },
    )
    tampered = env.client.get(f"/api/agents/{agent_id}", headers=_h("outsider"))
    assert (tampered.status_code, _code(tampered)) == (503, "agent_unavailable")


def test_the_list_is_empty_when_authorization_is_down(env: Env) -> None:
    _published(env)
    env.cedar.fail = True
    # The token is still valid, so the request is served; nothing is visible (fail closed).
    assert env.client.get("/api/agents", headers=_h("member")).json() == {"items": []}
    assert env.client.get("/api/agents/org", headers=_h("admin")).json()["nodes"] == []


def test_the_organization_chart_is_filtered_for_users(env: Env) -> None:
    boss = _published(env, name="Jefe", groups=["ops"])
    report = _published(env, name="Reporte", groups=["hr"], reports_to=boss["agent_id"])

    def chart(token: str) -> dict[str, str | None]:
        body = env.client.get("/api/agents/org", headers=_h(token)).json()
        assert body["root"] == "platform"
        return {n["name"]: n["reports_to"] for n in body["nodes"]}

    full = {"Jefe": "platform", "Reporte": boss["agent_id"]}
    assert chart("admin") == full
    assert chart("creator2") == full
    # A user sees their agents; a supervisor they cannot use is not named.
    assert chart("member") == {"Reporte": None}
    assert chart("outsider") == {"Jefe": "platform"}
    assert chart("lead") == {}
    assert report["agent_id"] not in json.dumps(
        env.client.get("/api/agents/org", headers=_h("outsider")).json()
    )


def test_the_organization_chart_says_who_uses_an_agent_the_caller_cannot_use(env: Env) -> None:
    _published(env, name="Jefe", groups=["ops", "hr"])

    def node(token: str) -> dict[str, object]:
        nodes = env.client.get("/api/agents/org", headers=_h(token)).json()["nodes"]
        return {key: nodes[0][key] for key in ("can_use", "groups")}

    can = {"can_use": True, "groups": []}
    assert node("member") == can
    assert node("outsider") == can
    # Whoever sees the whole tree without being in its groups learns which groups use it.
    cannot = {"can_use": False, "groups": ["hr", "ops"]}
    assert node("creator2") == cannot
    # Use goes by groups for administrators too.
    assert node("admin") == cannot
    # A user outside its groups does not get the node at all.
    assert env.client.get("/api/agents/org", headers=_h("lead")).json()["nodes"] == []
    # People it is shared with are never named.
    assert "users" not in env.client.get("/api/agents/org", headers=_h("admin")).json()["nodes"][0]


def test_a_new_version_shows_its_diff_against_the_published_one(env: Env) -> None:
    live = _published(env)
    opened = env.client.post(
        f"/api/agents/{live['agent_id']}/versions", headers=_h("creator"), json={}
    )
    assert opened.status_code == 201
    draft = opened.json()
    assert (draft["version"], draft["base_version"], draft["status"]) == (2, 1, "draft")
    assert draft["diff"] == {
        "is_new": False,
        "fields": [],
        "sets": [],
        "prompt": None,
        "changes": 0,
    }
    second = env.client.post(
        f"/api/agents/{live['agent_id']}/versions", headers=_h("creator"), json={}
    )
    assert (second.status_code, _code(second)) == (409, "version_conflict")

    definition = _definition(
        name="Asistente de gasto",
        system_prompt="Eres un analista.\nResponde en español.\nCita la fuente.",
        tools=["cost-explorer.get_cost_forecast"],
        groups=["hr", "ops"],
        limits={"max_iterations": 12},
    )
    env.client.put(
        _url(draft), headers=_h("creator"), json={"revision": 1, "definition": definition}
    )
    review = _submit(env, {**draft, "revision": 2})
    # The reviewer gets the diff from the server, against what is published now.
    shown = env.client.get(_url(review), headers=_h("admin")).json()
    assert shown["base"]["name"] == "Asistente de costos"
    assert shown["diff"] == {
        "is_new": False,
        "fields": [
            {"field": "name", "before": "Asistente de costos", "after": "Asistente de gasto"},
            {"field": "limits.max_iterations", "before": 8, "after": 12},
        ],
        "sets": [
            {
                "field": "tools",
                "added": ["cost-explorer.get_cost_forecast"],
                "removed": [COST_TOOL],
            },
            {"field": "groups", "added": ["ops"], "removed": []},
        ],
        "prompt": [
            {"op": " ", "text": "Eres un analista."},
            {"op": " ", "text": "Responde en español."},
            {"op": "+", "text": "Cita la fuente."},
        ],
        "changes": 6,
    }
    queue = env.client.get("/api/agents/reviews", headers=_h("admin")).json()["queue"]
    assert [(r["kind"], r["changes"]) for r in queue] == [("change", 6)]
    # The published version keeps serving until the new one is published.
    assert env.client.get("/api/agents", headers=_h("member")).json()["items"][0]["version"] == 1


def test_a_long_prompt_is_diffed_without_a_quadratic_comparison() -> None:
    before = AgentDefinition(name="a", system_prompt="\n" * (MAX_DIFF_LINES + 5))
    after = AgentDefinition(name="a", system_prompt="x\n" * 3)
    diff = diff_definitions(before, after)
    assert diff.prompt is not None
    assert {line.op for line in diff.prompt} == {"-", "+"}
    new = diff_definitions(None, after)
    assert new.is_new and new.fields == []
    assert [line.op for line in new.prompt or []] == ["+"] * 4


def test_an_administrator_retires_an_agent_with_a_reason(env: Env) -> None:
    live = _published(env)
    url = f"/api/agents/{live['agent_id']}/retire"
    assert env.client.post(url, headers=_h("admin"), json={"lock_version": 1}).status_code == 422
    lock = env.client.get(_url(live), headers=_h("admin")).json()["agent"]["lock_version"]
    stale = env.client.post(
        url, headers=_h("admin"), json={"lock_version": lock + 1, "reason": "Duplicado"}
    )
    assert (stale.status_code, _code(stale)) == (409, "version_conflict")
    response = env.client.post(
        url, headers=_h("admin"), json={"lock_version": lock, "reason": "Duplicado"}
    )
    assert response.status_code == 200
    assert (response.json()["status"], response.json()["retire_reason"]) == ("retired", "Duplicado")
    outcome, detail = _events(env, "agent.retired")[-1]
    assert (outcome, detail["retired_by"], detail["created_by"]) == (
        "applied",
        "admin-1",
        "creator-1",
    )

    listed = env.client.get("/api/agents", headers=_h("member")).json()["items"]
    assert [(a["status"], a["retire_reason"]) for a in listed] == [("retired", "Duplicado")]
    assert env.client.get("/api/agents/org", headers=_h("admin")).json()["nodes"] == []
    again = env.client.post(
        url, headers=_h("admin"), json={"lock_version": lock + 1, "reason": "x"}
    )
    assert again.status_code == 409
    new_version = env.client.post(
        f"/api/agents/{live['agent_id']}/versions", headers=_h("creator"), json={}
    )
    assert new_version.status_code == 409


def _retire(env: Env, live: dict[str, Any], lock_offset: int = 0) -> Any:
    lock = env.client.get(_url(live), headers=_h("admin")).json()["agent"]["lock_version"]
    return env.client.post(
        f"/api/agents/{live['agent_id']}/retire",
        headers=_h("admin"),
        json={"lock_version": lock + lock_offset, "reason": "Duplicado"},
    )


def test_retiring_an_agent_starts_the_removal_of_its_aws_resources(env: Env) -> None:
    live = _published(env)
    publications = len(env.sfn.executions)
    assert _retire(env, live).status_code == 200

    (execution,) = env.retire_sfn.executions
    assert set(execution) == {"stateMachineArn", "name", "input"}
    assert execution["stateMachineArn"] == DEPROVISIONER
    # Only the id: what is deleted is derived from it by the deprovisioner (D48).
    assert json.loads(execution["input"]) == {"agent_id": live["agent_id"]}
    assert len(env.sfn.executions) == publications
    (started,) = env.audit.named("agent.deprovisioner.started", None)
    assert started[1] == {
        "agent": live["agent_id"],
        "version": live["version"],
        "execution": execution["name"],
    }
    # Retired once: a second request is refused and starts nothing.
    assert _retire(env, live).status_code == 409
    assert len(env.retire_sfn.executions) == 1


def test_a_retirement_that_is_refused_starts_no_removal(env: Env) -> None:
    live = _published(env)
    stale = _retire(env, live, lock_offset=1)
    assert (stale.status_code, _code(stale)) == (409, "version_conflict")
    member = env.client.post(
        f"/api/agents/{live['agent_id']}/retire",
        headers=_h("member"),
        json={"lock_version": 1, "reason": "x"},
    )
    assert member.status_code in {403, 404}
    assert env.retire_sfn.executions == []
    assert env.audit.named("agent.deprovisioner.started", None) == []


def test_the_agent_is_retired_even_if_the_removal_cannot_start(env: Env) -> None:
    live = _published(env)
    env.retire_sfn.fail = True
    response = _retire(env, live)
    assert response.status_code == 200
    assert response.json()["status"] == "retired"
    (failed,) = env.audit.named("agent.deprovisioner.start_failed", None)
    assert failed[1] == {"agent": live["agent_id"], "version": live["version"]}
    assert env.audit.named("agent.deprovisioner.started", None) == []
    assert _events(env, "agent.retired")[-1][0] == "applied"


def test_retirement_works_while_the_deprovisioner_is_not_deployed(env: Env) -> None:
    env.deps.deprovisioner = None
    live = _published(env)
    assert _retire(env, live).status_code == 200
    assert env.retire_sfn.executions == []
    assert env.audit.named("agent.deprovisioner.started", None) == []


@pytest.fixture
def admin_in_hr(monkeypatch: pytest.MonkeyPatch) -> None:
    """The administrator is also in the group the test agents are shared with (`UseAgent`)."""
    monkeypatch.setitem(TOKENS["admin"], "cognito:groups", ["mango-admin", "hr"])


def _listed(env: Env, token: str, agent_id: str) -> dict[str, Any]:
    response = env.client.get("/api/agents", headers=_h(token))
    assert response.status_code == 200, response.text
    return next(item for item in response.json()["items"] if item["id"] == agent_id)


@pytest.mark.usefixtures("admin_in_hr")
def test_the_marketplace_tells_a_creator_which_agents_are_theirs_and_nothing_else(
    env: Env,
) -> None:
    live = _published(env)
    agent_id = live["agent_id"]
    assert _listed(env, "creator", agent_id)["is_mine"] is True
    assert env.client.get(f"/api/agents/{agent_id}", headers=_h("creator")).json()["is_mine"]
    # Another creator, a plain member and an administrator did not create it. The answer is
    # the flag alone: nobody learns who the creator is.
    for token in ("member", "admin"):
        item = _listed(env, token, agent_id)
        assert item["is_mine"] is False
        assert not {"created_by", "created_by_email", "owner"} & set(item)
        assert "creator-1" not in json.dumps(item) and "creator1@example.com" not in json.dumps(
            item
        )


def test_a_creator_without_the_role_is_not_told_the_agent_is_theirs(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _published(env)
    monkeypatch.setitem(TOKENS["creator"], "cognito:groups", ["hr"])
    assert _listed(env, "creator", live["agent_id"])["is_mine"] is False


@pytest.mark.usefixtures("admin_in_hr")
def test_admins_see_how_the_removal_of_a_retired_agent_goes(env: Env) -> None:
    live = _published(env, groups=["hr"])
    agent_id = live["agent_id"]
    retired = _retire(env, live)
    assert retired.json()["cleanup"] == "running"
    (execution,) = env.retire_sfn.executions

    assert _listed(env, "admin", agent_id)["cleanup"] == "running"
    for status, shown in (("SUCCEEDED", "done"), ("FAILED", "failed"), ("TIMED_OUT", "failed")):
        env.retire_sfn.statuses[execution["name"]] = status
        env.deps.deprovisioner._cached = None  # type: ignore[union-attr]
        assert _listed(env, "admin", agent_id)["cleanup"] == shown
    # Whoever may still see the retired agent is told nothing about its infrastructure.
    for token in ("creator", "member"):
        assert _listed(env, token, agent_id)["cleanup"] is None


@pytest.mark.usefixtures("admin_in_hr")
def test_the_last_removal_of_an_agent_is_the_one_shown(env: Env) -> None:
    live = _published(env)
    agent_id = live["agent_id"]
    _retire(env, live)
    first = env.retire_sfn.executions[0]["name"]
    env.retire_sfn.statuses[first] = "FAILED"
    # An operator starts it again by hand, as the runbook says.
    again = f"{agent_id}-retire-manual1"
    env.retire_sfn.executions.append({"name": again})
    env.retire_sfn.statuses[again] = "SUCCEEDED"
    # Executions with other names are not removals of an agent this API can name.
    env.retire_sfn.executions.append({"name": "3f0c9b1e-0000-4000-8000-000000000000"})
    env.deps.deprovisioner._cached = None  # type: ignore[union-attr]
    assert _listed(env, "admin", agent_id)["cleanup"] == "done"


@pytest.mark.usefixtures("admin_in_hr")
def test_the_removals_are_listed_once_for_a_while_and_only_when_needed(env: Env) -> None:
    live = _published(env)
    assert _listed(env, "admin", live["agent_id"])["cleanup"] is None
    assert env.retire_sfn.listings == 0  # nothing is retired: nothing is asked
    _retire(env, live)
    for _ in range(3):
        _listed(env, "admin", live["agent_id"])
    assert env.retire_sfn.listings == 1
    _listed(env, "member", live["agent_id"])
    assert env.retire_sfn.listings == 1


@pytest.mark.usefixtures("admin_in_hr")
def test_an_unknown_removal_is_not_reported(env: Env) -> None:
    live = _published(env)
    agent_id = live["agent_id"]
    env.retire_sfn.fail = True
    # The start failed: the administrator who retired it is told at once.
    assert _retire(env, live).json()["cleanup"] == "failed"
    # Just retired and not listed yet: Step Functions may lag behind the start.
    assert _listed(env, "admin", agent_id)["cleanup"] == "running"
    env.now[0] += timedelta(minutes=5)
    env.deps.deprovisioner._cached = None  # type: ignore[union-attr]
    assert _listed(env, "admin", agent_id)["cleanup"] is None
    # The executions cannot be read (or the deprovisioner is not deployed): nothing is said.
    env.retire_sfn.list_fails = True
    env.deps.deprovisioner._cached = None  # type: ignore[union-attr]
    assert _listed(env, "admin", agent_id)["cleanup"] is None
    env.deps.deprovisioner = None
    assert _listed(env, "admin", agent_id)["cleanup"] is None


def test_the_budget_list_names_published_and_retired_agents(env: Env) -> None:
    live = _published(env, name="Vivo")
    gone = _published(env, name="Retirado")
    _create(env, name="Borrador")
    lock = env.client.get(_url(gone), headers=_h("admin")).json()["agent"]["lock_version"]
    env.client.post(
        f"/api/agents/{gone['agent_id']}/retire",
        headers=_h("admin"),
        json={"lock_version": lock, "reason": "Duplicado"},
    )
    services = SimpleNamespace(agents=env.deps)
    assert app_module._agent_names(services) == {  # type: ignore[arg-type]
        live["agent_id"]: "Vivo",
        gone["agent_id"]: "Retirado",
    }


# --- Catalogs and /api/me ---------------------------------------------------------------


def test_the_builder_reads_the_catalog_and_the_enabled_models(env: Env) -> None:
    catalog = env.client.get("/api/mcp/catalog", headers=_h("creator")).json()["items"]
    assert [c["id"] for c in catalog] == ["aws-budgets", "cost-explorer"]
    connector = catalog[1]
    assert (connector["data_tier"], connector["identity_mode"], connector["enabled"]) == (
        "account_data",
        "per_user",
        True,
    )
    assert all(p.startswith("ce:") for p in connector["permissions"])
    tools = {t["ref"]: t for t in connector["tools"]}
    assert tools[COST_TOOL]["access"] == "read"
    assert tools["cost-explorer.get_savings_plans_utilization"]["audience"] == "central"

    models = env.client.get("/api/models", headers=_h("creator")).json()
    assert models == {
        "version": 1,
        "items": [
            {
                "id": SONNET,
                "name": SONNET,
                "provider": "anthropic",
                "supports_tools": True,
                "context_tokens": None,
                "input_usd": "3",
                "output_usd": "15",
            }
        ],
    }
    env.db.delete_item(TableName="settings", Key={"PK": {"S": "MODELS"}, "SK": {"S": "CATALOG"}})
    down = env.client.get("/api/models", headers=_h("creator"))
    assert (down.status_code, _code(down)) == (503, "models_unavailable")
    # Rules that cannot be evaluated are not reported as passed, and nothing is sent.
    draft = _create(env)
    assert draft["violations"] is None
    blocked = env.client.post(_url(draft, "/submit"), headers=_h("creator"), json={"revision": 1})
    assert (blocked.status_code, _code(blocked)) == (503, "models_unavailable")


def test_me_takes_create_agent_from_the_cedar_decision(env: Env) -> None:
    def can(token: str) -> bool:
        return bool(env.client.get("/api/me", headers=_h(token)).json()["can"]["create_agent"])

    assert [can(t) for t in ("admin", "creator", "member", "lead")] == [True, True, False, False]
    assert env.cedar.allowed("CreateAgent")[-1] == ("lead-1", "mango", False)
    # A hint, not an access: it is not written to the audit trail.
    assert env.audit.events == []
    env.cedar.fail = True
    assert can("admin") is False
