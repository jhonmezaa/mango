from __future__ import annotations

import json
import time
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from mango_api import app as app_module
from mango_api.agents_store import AgentVersion
from mango_api.audit import AuditPage
from mango_api.budget import BudgetExceededError
from mango_api.conversations import ConversationRecord, StoredMessage
from mango_api.model_catalog import ModelCatalog, ModelCatalogUnavailableError, ModelEntry
from mango_api.published import AgentUnavailableError, PublishedAgent
from mango_api.sessions import SessionBusyError, SessionState
from mango_api.settings import ModelPrice, Settings
from mango_api.settings_store import SettingsUnavailableError
from mango_core import invocation
from mango_core.agents import AgentDefinition, VersionStatus, dumps_definition
from mango_core.agents import content_hash as hash_content
from mango_core.identity import IdentityError

HOST = "internal-alb.example.com"
KEY = b"k" * 32
MODEL = "us.anthropic.claude-sonnet-4-6"
AUX = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
CHEAP = "us.anthropic.claude-haiku-4-5"
"""A second model some agents allow: a third of the price of ``MODEL``."""
PRICE = ModelPrice(Decimal(3), Decimal(15), Decimal("0.3"), Decimal("3.75"))
OTHER_AGENT = "abcdefghijklmnop"
HARNESS = "arn:aws:bedrock-agentcore:us-east-1:111111111111:harness/Mango_test_a_{}-abcdefghij"
TOOLS = ("cost-explorer.get_cost_and_usage", "cost-explorer.list_accounts_in_scope")


def _settings() -> Settings:
    return Settings(
        namespace="test",
        region="us-east-1",
        cognito_issuer="https://cognito-idp.us-east-1.amazonaws.com/us-east-1_T",
        cognito_client_id="client",
        gateway_url="https://gw.example.com/mcp",
        agent_id="finops",
        agent_model=MODEL,
        auxiliary_model=AUX,
        model_prices={MODEL: PRICE, AUX: PRICE},
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
        invocation_key_secret_arn="arn:aws:secretsmanager:us-east-1:111111111111:secret:k",
        guardrail_id="gr-base",
        guardrail_version="1",
        agent_session_idle_seconds=300,
        agent_session_max_seconds=28_800,
    )


TOKENS = {
    "good": {
        "sub": "user-1",
        "mango_role": "bu-lead",
        "mango_business_unit": "security",
        "mango_email": "lead@example.com",
        "exp": int(time.time()) + 3600,
    },
    "admin": {
        "sub": "admin-1",
        "mango_role": "finops-central",
        "mango_admin": "true",
        "exp": int(time.time()) + 3600,
    },
    "expiring": {"sub": "user-2", "mango_role": "finops-central", "exp": int(time.time()) + 30},
    "named": {
        "sub": "user-3",
        "mango_role": "finops-central",
        "mango_name": "Usuario 3",
        "exp": int(time.time()) + 3600,
    },
    "nogroup": {"sub": "user-4", "mango_email": "new@example.com", "exp": int(time.time()) + 3600},
}


class FakeVerifier:
    def verify(self, token: str) -> dict[str, Any]:
        if token not in TOKENS:
            raise IdentityError("invalid")
        return TOKENS[token]


def served(
    agent_id: str = "finops",
    *,
    version: int = 3,
    retired: bool = False,
    tools: tuple[str, ...] = TOOLS,
    **definition: Any,
) -> PublishedAgent:
    """An agent as ``PublishedAgents`` hands it to the chat (see ``test_published.py``)."""
    content = AgentDefinition.model_validate(
        {
            "name": "FinOps",
            "role": "Costos",
            "reports_to": "platform",
            "model": MODEL,
            "allowed_models": [MODEL],
            "system_prompt": "You are FinOps.",
            "tools": list(tools),
            "limits": {
                "max_iterations": 5,
                "max_tokens": 1000,
                "timeout_seconds": 300,
                "max_tokens_per_call": 4000,
                "temperature": 0.2,
            },
            "groups": ["bu-lead", "finops-central"],
            **definition,
        }
    )
    canonical = dumps_definition(content)
    at = datetime(2026, 10, 1, tzinfo=UTC)
    record = AgentVersion(
        agent_id=agent_id,
        number=version,
        status=VersionStatus.RETIRED if retired else VersionStatus.PUBLISHED,
        revision=1,
        definition=content,
        canonical=canonical,
        content_hash=hash_content(canonical),
        base_version=None,
        created_by="creator-1",
        created_by_email=None,
        created_at=at,
        updated_at=at,
        editors=frozenset({"creator-1"}),
        submitted_by="creator-1",
        submitted_at=at,
        approved_by="admin-9",
        approved_at=at,
        rejected_by=None,
        rejected_at=None,
        rejection_reason=None,
        failed_step=None,
        failure=None,
        published_at=at,
    )
    names = sorted(ref.split(".", 1)[1] for ref in content.tools)
    return PublishedAgent(
        agent_id=agent_id,
        version=version,
        content_hash=hash_content(canonical),
        harness_arn=HARNESS.format(agent_id),
        harness_version=str(version),
        qualifier="live",
        record=record,
        retired=retired,
        allowed_tools=tuple(f"@mango/finops___{name}" for name in names),
        gateway_tools=tuple(f"finops___{name}" for name in names),
    )


@dataclass
class FakeAuthorizer:
    allow: bool = True
    resources: list[Any] = field(default_factory=list)
    """The Agent entity of each decision, as mango-api built it."""

    def is_allowed(self, _user: Any, _action: str, _rt: str, _rid: str, agent: Any = None) -> bool:
        self.resources.append(agent)
        return self.allow


@dataclass
class FakePublished:
    agents: dict[str, PublishedAgent] = field(
        default_factory=lambda: {"finops": served(), OTHER_AGENT: served(OTHER_AGENT, version=1)}
    )
    unavailable: bool = False
    asked: list[str] = field(default_factory=list)

    def get(self, agent_id: str) -> PublishedAgent | None:
        self.asked.append(agent_id)
        if self.unavailable:
            raise AgentUnavailableError("down")
        return self.agents.get(agent_id)


def _model(model_id: str, input_usd: str, output_usd: str, enabled: bool = True) -> ModelEntry:
    return ModelEntry(
        id=model_id,
        name=model_id,
        provider="anthropic",
        enabled=enabled,
        supports_tools=True,
        input_usd=Decimal(input_usd),
        output_usd=Decimal(output_usd),
        cache_read_usd=Decimal("0.3"),
        cache_write_usd=Decimal("3.75"),
    )


@dataclass
class FakeModelCatalog:
    models: tuple[ModelEntry, ...] = (_model(MODEL, "3", "15"), _model(CHEAP, "1", "5"))
    unavailable: bool = False

    def catalog(self) -> ModelCatalog:
        if self.unavailable:
            raise ModelCatalogUnavailableError("down")
        return ModelCatalog(models=self.models, version=1)


@dataclass
class FakeBudgets:
    exceed: bool = False
    reserved: list[Decimal] = field(default_factory=list)
    settled: list[tuple[Decimal, Decimal]] = field(default_factory=list)
    scopes: list[Any] = field(default_factory=list)

    def reserve(self, scopes: Any, amount: Decimal, _period: str) -> None:
        if self.exceed:
            raise BudgetExceededError("x")
        self.scopes = list(scopes)
        self.reserved.append(amount)

    def settle(self, _scopes: Any, reserved: Decimal, actual: Decimal, _period: str) -> None:
        self.settled.append((reserved, actual))


@dataclass
class FakeConversations:
    stored: list[tuple[str, str, str]] = field(default_factory=list)
    fail_writes: bool = False
    sessions: dict[tuple[str, str], SessionState] = field(default_factory=dict)
    fail_complete: bool = False
    concurrent_turns: int = 0
    agents: dict[tuple[str, str], str] = field(default_factory=dict)
    """Agent of each conversation, as stored by its first turn."""

    def session_state(self, user: str, cid: str) -> SessionState | None:
        if (user, cid) in self.sessions:
            return self.sessions[(user, cid)]
        return SessionState() if cid == "a" * 32 else None

    def conversation(self, user: str, cid: str) -> ConversationRecord | None:
        session = self.session_state(user, cid)
        if session is None:
            return None
        # The seeded conversation ("a" * 32) predates agents as data: it has no agent.
        return ConversationRecord(session, self.agents.get((user, cid)))

    def begin_session(
        self,
        user: str,
        cid: str,
        previous: SessionState,
        generation: int,
        started_at: int,
        *,
        binding: str,
    ) -> None:
        if self.concurrent_turns:
            # Another turn of the conversation takes the session first.
            self.concurrent_turns -= 1
            self.sessions[(user, cid)] = SessionState(
                previous.generation + 1, started_at, 0, binding
            )
        current = self.sessions.get((user, cid), SessionState())
        if (current.generation, current.used_at) != (previous.generation, previous.used_at):
            raise SessionBusyError
        self.sessions[(user, cid)] = SessionState(generation, started_at, 0, binding)

    def complete_session(self, user: str, cid: str, generation: int, used_at: int) -> None:
        if self.fail_complete:
            raise RuntimeError("storage unavailable")
        state = self.sessions[(user, cid)]
        if state.generation == generation:
            self.sessions[(user, cid)] = replace(state, used_at=used_at)

    def upsert_conversation(self, user: str, cid: str, _title: str, agent_id: str) -> None:
        if self.fail_writes:
            raise RuntimeError("storage unavailable")
        self.agents.setdefault((user, cid), agent_id)

    def set_title(self, *_a: Any) -> None: ...

    def add_message(
        self, user: str, _cid: str, role: str, content: str, *_a: Any, **_k: Any
    ) -> str:
        self.stored.append((user, role, content))
        return "m" * 32

    def messages(self, _u: str, _cid: str) -> list[StoredMessage]:
        return [StoredMessage("x", "user", "hola", "t", [])]

    def list_conversations(self, user: str) -> list[dict[str, str | None]]:
        return [
            {"conversation_id": "a" * 32, "title": "t", "updated_at": "now", "agent_id": None},
            *(
                {"conversation_id": cid, "title": "t", "updated_at": "now", "agent_id": agent}
                for (owner, cid), agent in self.agents.items()
                if owner == user
            ),
        ]

    def summary(self, user: str, cid: str) -> tuple[str, str | None] | None:
        if cid == "a" * 32 or (user, cid) in self.agents:
            return "t", self.agents.get((user, cid))
        return None


@dataclass
class FakeLimits:
    unavailable: bool = False

    def for_user(self, user_id: str) -> tuple[Decimal, Decimal]:
        if self.unavailable:
            raise SettingsUnavailableError("down")
        return (Decimal(7) if user_id == "user-1" else Decimal(5)), Decimal(30)

    def invalidate(self) -> None: ...


@dataclass
class FakeAudit:
    events: list[str] = field(default_factory=list)
    details: list[dict[str, Any]] = field(default_factory=list)
    actors: list[Any] = field(default_factory=list)
    queries: list[Any] = field(default_factory=list)

    def emit(self, event: str, _user: str, detail: dict[str, Any], actor: Any = None) -> None:
        self.events.append(event)
        self.details.append(detail)
        self.actors.append(actor)

    def page(self, query: Any) -> AuditPage:
        self.queries.append(query)
        return AuditPage(
            [
                {
                    "event_id": "e" * 32,
                    "ts": "2026-09-30T10:00:00.000+00:00",
                    "event": "x",
                    "user_id": "admin-1",
                    "detail": {},
                    "hash": "h" * 64,
                    "unexpected": "dropped",
                }
            ],
            "c1",
        )


@dataclass
class FakeAgentCore:
    requests: list[dict[str, Any]] = field(default_factory=list)
    stop_reason: str = "end_turn"
    fail: bool = False

    def invoke_harness(self, **request: Any) -> dict[str, Any]:
        self.requests.append(request)
        if self.fail:
            return {"stream": [{"internalServerException": {"message": "boom"}}]}
        return {
            "stream": [
                {"contentBlockStart": {"contentBlockIndex": 0, "start": {}}},
                {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "Hola "}}},
                {
                    "contentBlockStart": {
                        "contentBlockIndex": 1,
                        "start": {
                            "toolUse": {"toolUseId": "t1", "name": "finops___get_cost_and_usage"}
                        },
                    }
                },
                {
                    "contentBlockStart": {
                        "contentBlockIndex": 2,
                        "start": {"toolResult": {"toolUseId": "t1", "status": "success"}},
                    }
                },
                {"contentBlockDelta": {"contentBlockIndex": 3, "delta": {"text": "mundo"}}},
                {"messageStop": {"stopReason": self.stop_reason}},
                {"metadata": {"usage": {"inputTokens": 1000, "outputTokens": 100}}},
            ]
        }


class FakeBedrock:
    def converse(self, **_kw: Any) -> dict[str, Any]:
        return {"output": {"message": {"content": [{"text": "Título"}]}}, "usage": {}}


@dataclass
class Harness:
    authorizer: FakeAuthorizer = field(default_factory=FakeAuthorizer)
    budgets: FakeBudgets = field(default_factory=FakeBudgets)
    conversations: FakeConversations = field(default_factory=FakeConversations)
    audit: FakeAudit = field(default_factory=FakeAudit)
    agentcore: FakeAgentCore = field(default_factory=FakeAgentCore)
    limits: FakeLimits = field(default_factory=FakeLimits)
    published: FakePublished = field(default_factory=FakePublished)
    models: FakeModelCatalog = field(default_factory=FakeModelCatalog)

    def client(self) -> TestClient:
        def factory(settings: Settings) -> app_module.Services:
            return app_module.Services(
                settings=settings,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=self.authorizer,  # type: ignore[arg-type]
                budgets=self.budgets,  # type: ignore[arg-type]
                conversations=self.conversations,  # type: ignore[arg-type]
                audit=self.audit,  # type: ignore[arg-type]
                agentcore=self.agentcore,
                bedrock=FakeBedrock(),
                settings_store=None,  # type: ignore[arg-type]  # admin routes: test_admin.py
                budget_limits=self.limits,  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=self.published,  # type: ignore[arg-type]
                model_catalog=self.models,  # type: ignore[arg-type]
                invocation_key=KEY,
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        return TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]


def _auth(token: str = "good") -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _events(body: str) -> list[tuple[str, dict[str, Any]]]:
    out = []
    for chunk in body.split("\n\n"):
        lines = chunk.strip().splitlines()
        if len(lines) == 2 and lines[0].startswith("event: "):
            out.append((lines[0][7:], json.loads(lines[1][6:])))
    return out


@pytest.fixture
def h() -> Harness:
    return Harness()


def test_health_needs_no_auth_and_accepts_any_host(h: Harness) -> None:
    client = h.client()
    assert client.get("/api/health", headers={"Host": "10.0.0.5:8000"}).json() == {"status": "ok"}


def test_rejects_unknown_host(h: Harness) -> None:
    response = h.client().get("/api/me", headers={**_auth(), "Host": "evil.example.com"})
    assert response.status_code == 400


def test_requires_valid_bearer_token(h: Harness) -> None:
    client = h.client()
    assert client.get("/api/me").status_code == 401
    assert client.get("/api/me", headers=_auth("forged")).status_code == 401


def test_me_returns_only_public_fields(h: Harness) -> None:
    h.authorizer.allow = False  # ``can`` mirrors the CreateAgent decision
    assert h.client().get("/api/me", headers=_auth()).json() == {
        "user_id": "user-1",
        "email": "lead@example.com",
        "name": None,
        "role": "bu-lead",
        "business_unit": "security",
        "is_admin": False,
        "groups": [],
        "can": {"create_agent": False},
    }


def test_me_returns_the_display_name(h: Harness) -> None:
    assert h.client().get("/api/me", headers=_auth("named")).json()["name"] == "Usuario 3"


def test_user_without_group_gets_no_group_everywhere(h: Harness) -> None:
    client = h.client()
    for method, path, body in (
        ("GET", "/api/me", None),
        ("GET", "/api/conversations", None),
        ("POST", "/api/chat", {"message": "hola"}),
        ("GET", "/api/admin/audit", None),
    ):
        response = client.request(method, path, headers=_auth("nogroup"), json=body)
        assert response.status_code == 403
        assert response.json() == {
            "error": {"code": "no_group", "message": "no group assigned yet"}
        }
    assert h.agentcore.requests == []


def test_chat_rejects_client_supplied_agent_configuration(h: Harness) -> None:
    for extra in (
        {"tools": []},
        {"model": "x"},
        {"allowedTools": ["*"]},
        {"skills": []},
        {"system_prompt": "x"},
        {"limits": {"max_iterations": 99}},
        {"harness_arn": HARNESS.format("finops")},
    ):
        response = h.client().post("/api/chat", headers=_auth(), json={"message": "hola", **extra})
        assert response.status_code == 422
    assert h.agentcore.requests == []


def test_chat_denied_by_authorization(h: Harness) -> None:
    h.authorizer.allow = False
    response = h.client().post("/api/chat", headers=_auth(), json={"message": "hola"})
    assert response.status_code == 403
    assert "policy.decision" in h.audit.events
    assert h.budgets.reserved == []


def test_chat_budget_exceeded(h: Harness) -> None:
    h.budgets.exceed = True
    response = h.client().post("/api/chat", headers=_auth(), json={"message": "hola"})
    assert response.status_code == 402
    assert response.json()["error"]["code"] == "budget_exceeded"
    assert h.agentcore.requests == []


def test_chat_rejects_token_about_to_expire(h: Harness) -> None:
    response = h.client().post("/api/chat", headers=_auth("expiring"), json={"message": "hola"})
    assert response.status_code == 401


def test_chat_unknown_conversation_is_not_found(h: Harness) -> None:
    response = h.client().post(
        "/api/chat", headers=_auth(), json={"message": "hola", "conversation_id": "b" * 32}
    )
    assert response.status_code == 404


def test_chat_streams_and_settles_budget(h: Harness) -> None:
    response = h.client().post("/api/chat", headers=_auth(), json={"message": "¿Cuánto gasté?"})
    assert response.status_code == 200
    events = _events(response.text)
    kinds = [k for k, _ in events]
    assert kinds[0] == "conversation"
    assert ("tool", {"name": "get_cost_and_usage", "status": "started"}) in events
    # Text around a tool call is kept as separate paragraphs.
    assert "".join(d["text"] for k, d in events if k == "delta") == "Hola \n\nmundo"
    done = next(d for k, d in events if k == "done")
    assert done["usage"] == {"input_tokens": 1000, "output_tokens": 100}
    assert done["cost_usd"] == "0.0045"
    reserved, actual = h.budgets.settled[0]
    assert reserved == h.budgets.reserved[0]
    assert actual == Decimal("0.004500")
    assert ("user-1", "assistant", "Hola \n\nmundo") in h.conversations.stored


def test_chat_streams_live_progress(h: Harness) -> None:
    response = h.client().post("/api/chat", headers=_auth(), json={"message": "¿Cuánto gasté?"})
    events = _events(response.text)
    # The first thing after the conversation id: the turn is running, before any text.
    assert events[1] == ("status", {"phase": "thinking"})
    statuses = [d for k, d in events if k == "status"]
    assert {"phase": "tool", "tool": "get_cost_and_usage"} in statuses
    assert statuses[-1] == {"phase": "writing"}
    # Progress is transient: only the tool calls are stored with the answer and audited.
    completed = h.audit.details[h.audit.events.index("agent.completed")]
    assert completed["tools"] == ["get_cost_and_usage"]
    assert "status" not in completed
    assert "phase" not in completed


def test_harness_request_is_built_server_side(h: Harness) -> None:
    h.client().post("/api/chat", headers=_auth(), json={"message": "hola"})
    request = h.agentcore.requests[0]
    # Exactly the tools of the published version, by name, on the `live` endpoint (D32, D33).
    assert request["harnessArn"] == HARNESS.format("finops")
    assert request["qualifier"] == "live"
    assert request["allowedTools"] == [
        "@mango/finops___get_cost_and_usage",
        "@mango/finops___list_accounts_in_scope",
    ]
    assert request["actorId"] == "user-1"
    assert (request["maxIterations"], request["maxTokens"], request["timeoutSeconds"]) == (
        5,
        1000,
        300,
    )
    assert request["systemPrompt"][0]["text"].startswith("You are FinOps.\n\nCurrent date")
    (tool,) = request["tools"]
    assert (tool["type"], tool["name"]) == ("remote_mcp", "mango")
    remote = tool["config"]["remoteMcp"]
    assert remote["url"] == "https://gw.example.com/mcp"
    assert remote["headers"]["Authorization"] == "Bearer good"
    # The Gateway only accepts calls signed by mango-api for this user, this agent version
    # and its tools (audit finding F1, TM-M12).
    signed = invocation.verify(KEY, "user-1", remote["headers"][invocation.HEADER])
    assert signed is not None
    assert (signed.agent_id, signed.agent_version) == ("finops", 3)
    assert signed.tools == {"finops___get_cost_and_usage", "finops___list_accounts_in_scope"}
    assert invocation.verify(KEY, "user-2", remote["headers"][invocation.HEADER]) is None
    model = request["model"]["bedrockModelConfig"]
    assert (model["modelId"], model["maxTokens"], model["temperature"]) == (MODEL, 4000, 0.2)
    assert model["additionalParams"]["guardrailConfig"] == {
        "guardrailIdentifier": "gr-base",
        "guardrailVersion": "1",
        "trace": "disabled",
    }
    # The token never reaches the model context.
    assert "good" not in json.dumps(request["messages"] + request["systemPrompt"])


def test_oversized_body_rejected(h: Harness) -> None:
    response = h.client().post("/api/chat", headers=_auth(), content=b"{" + b" " * 40_000 + b"}")
    assert response.status_code == 413


def test_admin_audit_requires_permission(h: Harness) -> None:
    h.authorizer.allow = False
    assert h.client().get("/api/admin/audit", headers=_auth()).status_code == 403
    assert h.audit.queries == []
    h.authorizer.allow = True
    assert h.client().get("/api/admin/audit", headers=_auth("admin")).json() == {
        "items": [
            {
                "event_id": "e" * 32,
                "ts": "2026-09-30T10:00:00.000+00:00",
                "event": "x",
                "user_id": "admin-1",
                "actor_email": None,
                "actor_role": None,
                "actor_is_admin": None,
                "resource": None,
                "detail": {},
                "hash": "h" * 64,
            }
        ],
        "next_cursor": "c1",
    }


def test_admin_audit_query_parameters(h: Harness) -> None:
    client = h.client()
    response = client.get(
        "/api/admin/audit",
        headers=_auth("admin"),
        params={
            "limit": 20,
            "since": "2026-09-01T00:00:00Z",
            "until": "2026-09-02T00:00:00",
            "exclude": "reads",
            "event": "settings.",
            "cursor": "abc",
        },
    )
    assert response.status_code == 200
    [query] = h.audit.queries
    assert (query.limit, query.exclude_reads, query.event, query.cursor) == (
        20,
        True,
        "settings.",
        "abc",
    )
    assert query.since.isoformat() == "2026-09-01T00:00:00+00:00"
    # Naive datetimes are UTC.
    assert query.until.isoformat() == "2026-09-02T00:00:00+00:00"
    for bad in (
        {"limit": 0},
        {"limit": 201},
        {"exclude": "writes"},
        {"event": "Bad Event"},
        {"cursor": "x" * 129},
        {"since": "yesterday"},
        {"unknown": "1"},
    ):
        assert client.get("/api/admin/audit", headers=_auth("admin"), params=bad).status_code == 422


def test_read_decisions_are_still_audited_and_flagged(h: Harness) -> None:
    h.client().get("/api/admin/audit", headers=_auth("admin"))
    [decision] = [
        d for e, d in zip(h.audit.events, h.audit.details, strict=True) if e == "policy.decision"
    ]
    assert decision == {
        "action": "ViewAudit",
        "resource": "Mango::Platform::mango",
        "allowed": True,
        "read_only": True,
    }
    assert h.audit.actors[0].user_id == "admin-1"


def test_chat_decision_is_not_a_read(h: Harness) -> None:
    h.client().post("/api/chat", headers=_auth(), json={"message": "hola"})
    decision = h.audit.details[h.audit.events.index("policy.decision")]
    assert decision["read_only"] is False
    # Every event of the turn records who acted.
    assert {a.email for a in h.audit.actors} == {"lead@example.com"}


def _detail(h: Harness, event: str) -> dict[str, Any]:
    return h.audit.details[h.audit.events.index(event)]


def test_chat_decision_is_linked_to_its_turn(h: Harness) -> None:
    h.client().post("/api/chat", headers=_auth(), json={"message": "hola"})
    decision = _detail(h, "policy.decision")
    completed = _detail(h, "agent.completed")
    assert (decision["conversation_id"], decision["turn"]) == (
        completed["conversation_id"],
        completed["turn"],
    )
    assert completed["authz"] == {"action": "UseAgent", "allowed": True}


def test_chat_decision_is_audited_when_the_turn_never_completes(h: Harness) -> None:
    h.budgets.exceed = True
    h.client().post("/api/chat", headers=_auth(), json={"message": "hola"})
    decision = _detail(h, "policy.decision")
    assert decision["allowed"] is True
    assert set(decision) >= {"conversation_id", "turn"}
    assert "agent.completed" not in h.audit.events


def test_denied_chat_decision_carries_the_requested_turn(h: Harness) -> None:
    h.authorizer.allow = False
    h.client().post(
        "/api/chat", headers=_auth(), json={"message": "hola", "conversation_id": "c" * 32}
    )
    decision = _detail(h, "policy.decision")
    assert decision["allowed"] is False
    assert decision["conversation_id"] == "c" * 32
    assert len(decision["turn"]) == 32


def test_conversation_ids_are_validated(h: Harness) -> None:
    client = h.client()
    assert client.get("/api/conversations/../../x", headers=_auth()).status_code == 404
    assert client.get("/api/conversations/" + "b" * 32, headers=_auth()).status_code == 404
    assert client.get("/api/conversations/" + "a" * 32, headers=_auth()).status_code == 200


def test_reservation_released_when_turn_cannot_start(h: Harness) -> None:
    h.conversations.fail_writes = True
    client = TestClient(h.client().app, base_url=f"http://{HOST}", raise_server_exceptions=False)
    response = client.post("/api/chat", headers=_auth(), json={"message": "hola"})
    assert response.status_code == 500
    reserved, actual = h.budgets.settled[0]
    assert reserved == h.budgets.reserved[0]
    assert actual == Decimal(0)
    assert h.agentcore.requests == []


def test_chat_uses_settings_limits_and_labels_the_user(h: Harness) -> None:
    h.client().post("/api/chat", headers=_auth(), json={"message": "hola"})
    user_scope, agent_scope = h.budgets.scopes
    assert (user_scope.key, user_scope.limit, user_scope.label) == (
        "USER#user-1",
        Decimal(7),
        "lead@example.com",
    )
    assert (agent_scope.key, agent_scope.limit, agent_scope.label) == (
        "AGENT#finops",
        Decimal(30),
        None,
    )


def test_chat_fails_closed_without_budget_settings(h: Harness) -> None:
    h.limits.unavailable = True
    response = h.client().post("/api/chat", headers=_auth(), json={"message": "hola"})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "budget_unavailable"
    assert h.budgets.reserved == []
    assert h.agentcore.requests == []


# --- runtime session per conversation (D39) ---------------------------------------------------

CONVERSATION = "a" * 32


def _turn(h: Harness, token: str = "good", conversation_id: str | None = None) -> str:
    """Send one turn; returns the conversation id."""
    body: dict[str, Any] = {"message": "¿y el mes pasado?"}
    if conversation_id:
        body["conversation_id"] = conversation_id
    response = h.client().post("/api/chat", headers=_auth(token), json=body)
    assert response.status_code == 200
    return str(next(d for k, d in _events(response.text) if k == "conversation")["conversation_id"])


def _texts(request: dict[str, Any]) -> list[str]:
    return [m["content"][0]["text"] for m in request["messages"]]


def test_session_id_has_a_valid_shape_and_is_not_the_conversation_id(h: Harness) -> None:
    conversation_id = _turn(h)
    session_id = h.agentcore.requests[0]["runtimeSessionId"]
    assert len(session_id) == 64  # AgentCore accepts 33 to 100 characters
    assert conversation_id not in session_id


def test_first_turn_starts_a_session_and_sends_the_stored_history(h: Harness) -> None:
    _turn(h, conversation_id=CONVERSATION)
    assert _texts(h.agentcore.requests[0]) == ["hola", "¿y el mes pasado?"]
    assert h.audit.details[h.audit.events.index("agent.invoke")]["session"] == "new"


def test_next_turn_continues_the_session_and_sends_only_the_new_message(h: Harness) -> None:
    _turn(h, conversation_id=CONVERSATION)
    _turn(h, conversation_id=CONVERSATION)
    first, second = h.agentcore.requests
    assert second["runtimeSessionId"] == first["runtimeSessionId"]
    # The session already holds the earlier turns: resending them would duplicate them.
    assert _texts(second) == ["¿y el mes pasado?"]
    invokes = [
        d for e, d in zip(h.audit.events, h.audit.details, strict=True) if e == "agent.invoke"
    ]
    assert [d["session"] for d in invokes] == ["new", "reused"]


def test_idle_session_is_replaced_and_the_history_is_replayed(h: Harness) -> None:
    _turn(h, conversation_id=CONVERSATION)
    state = h.conversations.sessions[("user-1", CONVERSATION)]
    # The last turn ended longer ago than the idle timeout allows (300 s minus the margin).
    h.conversations.sessions[("user-1", CONVERSATION)] = replace(state, used_at=state.used_at - 241)
    _turn(h, conversation_id=CONVERSATION)
    first, second = h.agentcore.requests
    assert second["runtimeSessionId"] != first["runtimeSessionId"]
    assert _texts(second) == ["hola", "¿y el mes pasado?"]


def test_session_is_never_shared_between_users(h: Harness) -> None:
    # Both users have a conversation with the same id (each in their own partition).
    _turn(h, "good", CONVERSATION)
    _turn(h, "named", CONVERSATION)
    first, second = h.agentcore.requests
    assert (first["actorId"], second["actorId"]) == ("user-1", "user-3")
    assert first["runtimeSessionId"] != second["runtimeSessionId"]
    # The second user starts their own session: nothing of the first one is continued.
    assert _texts(second) == ["hola", "¿y el mes pasado?"]


def test_change_of_access_starts_a_new_session(h: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    _turn(h, conversation_id=CONVERSATION)
    # Same user and conversation, but the token now carries another area.
    monkeypatch.setitem(TOKENS, "good", {**TOKENS["good"], "mango_business_unit": "sandbox"})
    _turn(h, conversation_id=CONVERSATION)
    first, second = h.agentcore.requests
    assert second["actorId"] == first["actorId"]
    assert second["runtimeSessionId"] != first["runtimeSessionId"]
    # The new session holds nothing: it gets the stored history.
    assert _texts(second) == ["hola", "¿y el mes pasado?"]


def test_two_turns_at_once_never_share_a_session(h: Harness) -> None:
    _turn(h, conversation_id=CONVERSATION)
    reusable = h.conversations.sessions[("user-1", CONVERSATION)]
    h.conversations.concurrent_turns = 1
    _turn(h, conversation_id=CONVERSATION)
    first, second = h.agentcore.requests
    # The other turn took the next session; this one got one of its own, with the history.
    assert h.conversations.sessions[("user-1", CONVERSATION)].generation == reusable.generation + 2
    assert second["runtimeSessionId"] != first["runtimeSessionId"]
    assert _texts(second) == ["hola", "¿y el mes pasado?"]


def test_conversation_that_stays_busy_is_rejected_and_the_budget_released(h: Harness) -> None:
    h.conversations.concurrent_turns = 5
    response = h.client().post(
        "/api/chat", headers=_auth(), json={"message": "hola", "conversation_id": CONVERSATION}
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "conversation_busy"
    assert h.agentcore.requests == []
    assert h.budgets.settled == [(h.budgets.reserved[0], Decimal(0))]


def test_client_cannot_choose_the_session(h: Harness) -> None:
    response = h.client().post(
        "/api/chat", headers=_auth(), json={"message": "hola", "runtimeSessionId": "x" * 40}
    )
    assert response.status_code == 422


def test_failed_turn_is_not_continued(h: Harness) -> None:
    h.agentcore.fail = True
    _turn(h, conversation_id=CONVERSATION)
    assert h.conversations.sessions[("user-1", CONVERSATION)].used_at == 0
    h.agentcore.fail = False
    _turn(h, conversation_id=CONVERSATION)
    first, second = h.agentcore.requests
    assert second["runtimeSessionId"] != first["runtimeSessionId"]
    assert _texts(second) == ["hola", "¿y el mes pasado?"]


def test_turn_cut_by_the_guardrail_is_not_continued(h: Harness) -> None:
    h.agentcore.stop_reason = "guardrail_intervened"
    _turn(h, conversation_id=CONVERSATION)
    h.agentcore.stop_reason = "end_turn"
    _turn(h, conversation_id=CONVERSATION)
    first, second = h.agentcore.requests
    assert second["runtimeSessionId"] != first["runtimeSessionId"]


def test_answer_is_delivered_when_the_session_mark_cannot_be_saved(h: Harness) -> None:
    h.conversations.fail_complete = True
    response = h.client().post("/api/chat", headers=_auth(), json={"message": "hola"})
    kinds = [k for k, _ in _events(response.text)]
    assert "done" in kinds
    assert "error" not in kinds


def test_new_conversations_get_different_sessions(h: Harness) -> None:
    _turn(h)
    _turn(h)
    first, second = h.agentcore.requests
    assert first["runtimeSessionId"] != second["runtimeSessionId"]


# --- chat with several agents (Marketplace v1, A5) --------------------------------------------


def _chat(h: Harness, token: str = "good", **body: Any) -> Any:
    return h.client().post("/api/chat", headers=_auth(token), json={"message": "hola", **body})


def _error_code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def test_chat_runs_the_agent_the_client_names(h: Harness) -> None:
    h.published.agents[OTHER_AGENT] = served(
        OTHER_AGENT, version=7, system_prompt="You are another agent.", tools=()
    )
    assert _chat(h, agent_id=OTHER_AGENT).status_code == 200
    request = h.agentcore.requests[0]
    assert request["harnessArn"] == HARNESS.format(OTHER_AGENT)
    assert request["systemPrompt"][0]["text"].startswith("You are another agent.")
    # An agent without tools gets no MCP server and an empty allow-list.
    assert (request["tools"], request["allowedTools"]) == ([], [])
    invoke = _detail(h, "agent.invoke")
    assert (invoke["agent"], invoke["version"], invoke["model"]) == (OTHER_AGENT, 7, MODEL)
    completed = _detail(h, "agent.completed")
    assert (completed["agent"], completed["version"]) == (OTHER_AGENT, 7)
    assert _detail(h, "policy.decision")["resource"] == f"Mango::Agent::{OTHER_AGENT}"


def test_chat_without_an_agent_uses_the_release_agent(h: Harness) -> None:
    assert _chat(h).status_code == 200
    assert h.published.asked == ["finops"]
    assert h.conversations.agents and set(h.conversations.agents.values()) == {"finops"}


def test_use_agent_is_decided_with_the_groups_of_the_served_version(h: Harness) -> None:
    h.published.agents[OTHER_AGENT] = served(OTHER_AGENT, groups=["ventas"], users=["user-9"])
    _chat(h, agent_id=OTHER_AGENT)
    resource = h.authorizer.resources[0]
    assert resource.agent_id == OTHER_AGENT
    assert (resource.groups, resource.users) == (frozenset({"ventas"}), frozenset({"user-9"}))
    # The creator of an agent has no right to use it by being its creator.
    assert resource.creator is None


def test_chat_with_an_unknown_or_unpublished_agent_is_forbidden(h: Harness) -> None:
    # An agent that was never published has no attributes: the policy matches nobody. Even
    # if a policy allowed it, there is nothing to serve.
    for allow in (False, True):
        h.authorizer.allow = allow
        response = _chat(h, agent_id="zzzzzzzzzzzzzzzz")
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "forbidden"
    resource = h.authorizer.resources[0]
    assert (resource.groups, resource.users) == (frozenset(), frozenset())
    assert h.audit.events.count("policy.decision") == 2
    assert h.budgets.reserved == []
    assert h.agentcore.requests == []


def test_chat_without_use_agent_is_forbidden(h: Harness) -> None:
    h.authorizer.allow = False
    response = _chat(h, agent_id=OTHER_AGENT)
    assert response.status_code == 403
    assert _detail(h, "policy.decision")["allowed"] is False
    assert h.agentcore.requests == []


def test_retired_agent_takes_no_turns(h: Harness) -> None:
    h.published.agents["finops"] = served(retired=True)
    for body in ({}, {"conversation_id": CONVERSATION}):
        response = _chat(h, **body)
        assert response.status_code == 409
        assert _error_code(response) == "agent_retired"
    assert h.budgets.reserved == []
    assert h.agentcore.requests == []
    # History stays readable.
    assert h.client().get(f"/api/conversations/{CONVERSATION}", headers=_auth()).status_code == 200


def test_retirement_is_not_revealed_to_who_cannot_use_the_agent(h: Harness) -> None:
    h.published.agents["finops"] = served(retired=True)
    h.authorizer.allow = False
    assert _chat(h).status_code == 403


def test_chat_fails_closed_when_the_published_version_cannot_be_established(h: Harness) -> None:
    h.published.unavailable = True
    response = _chat(h)
    assert response.status_code == 503
    assert _error_code(response) == "agent_unavailable"
    assert h.audit.events == []
    assert h.agentcore.requests == []


@pytest.mark.parametrize("agent_id", ["FinOps", "fin ops", "../finops", "a", "x" * 17, ""])
def test_agent_id_is_validated(h: Harness, agent_id: str) -> None:
    assert _chat(h, agent_id=agent_id).status_code == 422
    assert h.published.asked == []


# The model (D22)


def test_chat_runs_the_model_the_user_picks_among_the_allowed_ones(h: Harness) -> None:
    h.published.agents["finops"] = served(allowed_models=[CHEAP, MODEL])
    assert _chat(h, model=CHEAP).status_code == 200
    assert h.agentcore.requests[0]["model"]["bedrockModelConfig"]["modelId"] == CHEAP
    assert _detail(h, "agent.completed")["model"] == CHEAP


def test_budget_is_reserved_and_settled_with_the_price_of_the_chosen_model(h: Harness) -> None:
    h.published.agents["finops"] = served(allowed_models=[CHEAP, MODEL])
    _chat(h)
    _chat(h, model=CHEAP)
    default, cheap = h.budgets.reserved
    # Same turn, a third of the price (CHEAP costs 1 and 5 USD per million; MODEL 3 and 15).
    assert default == cheap * 3
    assert [actual for reserved, actual in h.budgets.settled if reserved] == [
        Decimal("0.004500"),
        Decimal("0.001500"),
    ]


@pytest.mark.parametrize("model", ["us.anthropic.claude-opus-4-1", CHEAP, "x"])
def test_model_outside_the_agents_list_is_rejected(h: Harness, model: str) -> None:
    # CHEAP is enabled in the catalog, but this agent's version does not allow it.
    response = _chat(h, model=model)
    assert response.status_code == 422
    assert _error_code(response) == "model_not_allowed"
    assert h.budgets.reserved == []
    assert h.agentcore.requests == []


@pytest.mark.parametrize(
    "catalog",
    [
        (_model(MODEL, "3", "15", enabled=False),),  # disabled after the version was published
        (_model(CHEAP, "1", "5"),),  # no longer in the catalog
        (_model(MODEL, "0", "15"),),  # no price: nothing could be reserved
        (_model(MODEL, "3", "0"),),
    ],
)
def test_model_the_catalog_does_not_enable_is_not_used(
    h: Harness, catalog: tuple[ModelEntry, ...]
) -> None:
    h.models.models = catalog
    response = _chat(h)
    assert response.status_code == 409
    assert _error_code(response) == "model_unavailable"
    assert h.budgets.reserved == []
    assert h.agentcore.requests == []


def test_chat_fails_closed_without_the_model_catalog(h: Harness) -> None:
    h.models.unavailable = True
    response = _chat(h)
    assert response.status_code == 503
    assert h.budgets.reserved == []
    assert h.agentcore.requests == []


def test_changing_the_model_starts_a_new_session(h: Harness) -> None:
    h.published.agents["finops"] = served(allowed_models=[CHEAP, MODEL])
    _chat(h, conversation_id=CONVERSATION)
    _chat(h, conversation_id=CONVERSATION, model=CHEAP)
    first, second = h.agentcore.requests
    assert second["runtimeSessionId"] != first["runtimeSessionId"]
    assert _texts(second) == ["hola", "hola"]


# Budget per agent


def test_each_agent_has_its_own_budget_scope(h: Harness) -> None:
    _chat(h, agent_id=OTHER_AGENT)
    user_scope, agent_scope = h.budgets.scopes
    assert user_scope.key == "USER#user-1"
    assert (agent_scope.key, agent_scope.limit) == (f"AGENT#{OTHER_AGENT}", Decimal(30))


def test_budget_exceeded_is_audited_with_the_agent(h: Harness) -> None:
    h.budgets.exceed = True
    assert _chat(h, agent_id=OTHER_AGENT).status_code == 402
    assert _detail(h, "budget.exceeded")["agent"] == OTHER_AGENT


# The conversation keeps its agent


def test_conversation_keeps_the_agent_of_its_first_turn(h: Harness) -> None:
    conversation_id = _turn_with(h, agent_id=OTHER_AGENT)
    assert h.conversations.agents[("user-1", conversation_id)] == OTHER_AGENT
    # The next turn names no agent: it runs on the conversation's.
    _chat(h, conversation_id=conversation_id)
    assert [r["harnessArn"] for r in h.agentcore.requests] == [HARNESS.format(OTHER_AGENT)] * 2
    assert h.budgets.scopes[1].key == f"AGENT#{OTHER_AGENT}"


def test_conversation_cannot_be_moved_to_another_agent(h: Harness) -> None:
    conversation_id = _turn_with(h, agent_id=OTHER_AGENT)
    response = _chat(h, conversation_id=conversation_id, agent_id="finops")
    assert response.status_code == 409
    assert _error_code(response) == "agent_mismatch"
    assert len(h.agentcore.requests) == 1
    # Naming the same agent is fine.
    assert _chat(h, conversation_id=conversation_id, agent_id=OTHER_AGENT).status_code == 200


def test_conversations_stored_before_agents_were_data_belong_to_the_release_agent(
    h: Harness,
) -> None:
    assert _chat(h, conversation_id=CONVERSATION).status_code == 200
    assert h.published.asked == ["finops"]
    assert _chat(h, conversation_id=CONVERSATION, agent_id=OTHER_AGENT).status_code == 409


def test_sessions_of_two_agents_never_coincide(h: Harness) -> None:
    h.conversations.agents[("user-1", CONVERSATION)] = "finops"
    _chat(h, conversation_id=CONVERSATION)
    h.conversations = FakeConversations(agents={("user-1", CONVERSATION): OTHER_AGENT})
    _chat(h, conversation_id=CONVERSATION)
    first, second = h.agentcore.requests
    assert first["runtimeSessionId"] != second["runtimeSessionId"]


def test_new_version_of_the_agent_starts_a_new_session(h: Harness) -> None:
    _chat(h, conversation_id=CONVERSATION)
    h.published.agents["finops"] = served(version=4, system_prompt="You are FinOps v4.")
    _chat(h, conversation_id=CONVERSATION)
    first, second = h.agentcore.requests
    assert second["runtimeSessionId"] != first["runtimeSessionId"]
    # The stored history is replayed under the new version.
    assert _texts(second) == ["hola", "hola"]


def test_conversations_say_which_agent_they_belong_to(h: Harness) -> None:
    conversation_id = _turn_with(h, agent_id=OTHER_AGENT)
    client = h.client()
    listed = client.get("/api/conversations", headers=_auth()).json()["items"]
    assert {c["conversation_id"]: c["agent_id"] for c in listed} == {
        CONVERSATION: "finops",
        conversation_id: OTHER_AGENT,
    }
    detail = client.get(f"/api/conversations/{conversation_id}", headers=_auth()).json()
    assert detail["agent_id"] == OTHER_AGENT
    legacy = client.get(f"/api/conversations/{CONVERSATION}", headers=_auth()).json()
    assert legacy["agent_id"] == "finops"


def test_token_must_outlive_the_agents_own_timeout(h: Harness) -> None:
    # "good" expires in an hour: enough for 300 s, not for a 3 600 s loop... which the schema
    # caps at 600 s, so use a token that is about to expire against a short agent.
    h.published.agents["finops"] = served(limits={"timeout_seconds": 10})
    assert _chat(h, "expiring").status_code == 401
    monkey = {**TOKENS["expiring"], "exp": int(time.time()) + 120}
    TOKENS["short"] = monkey
    try:
        assert _chat(h, "short").status_code == 200
    finally:
        del TOKENS["short"]


def test_signature_names_the_agent_version_in_use(h: Harness) -> None:
    h.published.agents[OTHER_AGENT] = served(
        OTHER_AGENT, version=2, tools=("cost-explorer.get_anomalies",)
    )
    _chat(h, agent_id=OTHER_AGENT)
    headers = h.agentcore.requests[0]["tools"][0]["config"]["remoteMcp"]["headers"]
    signed = invocation.verify(KEY, "user-1", headers[invocation.HEADER])
    assert signed is not None
    assert (signed.agent_id, signed.agent_version) == (OTHER_AGENT, 2)
    assert signed.tools == {"finops___get_anomalies"}
    assert signed.expires_at <= int(time.time()) + 300 + 60


def _turn_with(h: Harness, **body: Any) -> str:
    response = _chat(h, **body)
    assert response.status_code == 200
    return str(next(d for k, d in _events(response.text) if k == "conversation")["conversation_id"])
