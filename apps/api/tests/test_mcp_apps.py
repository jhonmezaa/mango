"""MCP Apps of remote tools (D125 (3), (4)): moto (DynamoDB, S3), the Azure DevOps profile of
the repository with its curated app, signed with a test key, and a fake Gateway that verifies
the invocation signature of each call."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, cast

import boto3
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api.conversations import ConversationRepository
from mango_api.gateway_mcp import SESSION_HEADER, Answer, GatewayAppCalls
from mango_api.harness import AppCall
from mango_api.mcp_apps import (
    CALLS_PER_TURN,
    EVENT_CALL,
    McpAppCallIn,
    McpAppsDeps,
    McpAppStore,
    app_detail,
    app_tools,
    call_tool,
    create_apps,
    mcp_apps_router,
)
from mango_api.probe import RateLimiter
from mango_api.published import PublishedAgent
from mango_api.remote_mcp_store import ApprovedRemotes
from mango_api.web import ApiError, Caller
from mango_core import invocation
from mango_core.identity import UserContext
from mango_core.remote_mcp import gateway_tool_name, split_gateway_tool
from mango_packs.remote import app_html_sha256

from .test_admin import RecordingAudit, _table
from .test_connections_api import GATEWAY_ID, KEY, REG, _approve, _register
from .test_mcp_api import Signer
from .test_remote_mcp_api import REPO, FakeKms, _ship, _statement

CONV = "c" * 32
TURN = "d" * 32
AGENT = "agentone"
TOOL = gateway_tool_name(REG, "wit_work_item")
PROBE = gateway_tool_name(REG, "core_list_projects")
HTML = (REPO / "remotes" / "azure-devops" / "ui" / "work-items.html").read_text()
USER = UserContext(user_id="member-1", role=None, business_unit="hr", is_admin=False)
CALLER = Caller(user=USER, token="tok-member-1", expires_at=2_000_000_000)


@dataclass
class FakeGateway:
    """The Gateway as far as an app's call goes: it checks the signature names the agent and
    only this tool, and answers the tool's text."""

    answer: dict[str, Any] = field(
        default_factory=lambda: {"content": [{"type": "text", "text": '{"id":4821}'}]}
    )
    down: bool = False
    calls: list[dict[str, Any]] = field(default_factory=list)

    def __call__(self, url: str, headers: dict[str, str], body: bytes) -> Answer:
        if self.down:
            raise OSError("unreachable")
        message = json.loads(body)
        if message["method"] == "initialize":
            result = {"jsonrpc": "2.0", "id": message["id"], "result": {}}
            return Answer(200, json.dumps(result).encode(), "session-1")
        if message["method"] == "notifications/initialized":
            return Answer(202, b"")
        assert headers[SESSION_HEADER] == "session-1"
        signed = invocation.verify(KEY, "member-1", headers[invocation.HEADER])
        assert signed is not None
        name = message["params"]["name"]
        assert signed.agent_id == AGENT and signed.agent_version == 3
        assert signed.tools == frozenset({name}) and signed.connection is None
        assert "_meta" not in message["params"]
        self.calls.append({"name": name, "arguments": message["params"]["arguments"]})
        result = {"jsonrpc": "2.0", "id": message["id"], "result": self.answer}
        return Answer(200, json.dumps(result).encode())


def _agent(*tools: str) -> PublishedAgent:
    return cast(
        "PublishedAgent",
        SimpleNamespace(
            agent_id=AGENT,
            version=3,
            remote_tools=tuple((REG, f"allowed-{t}", t) for t in tools),
        ),
    )


@dataclass
class Env:
    deps: McpAppsDeps
    gateway: FakeGateway
    audit: RecordingAudit
    db: Any
    budget: list[bool]
    agent_tools: list[str]


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
        kms = FakeKms()
        _register(db, REG)
        _approve(db, kms, REG)
        gateway = FakeGateway()
        audit = RecordingAudit()
        budget = [True]
        agent_tools = [TOOL, PROBE]
        deps = McpAppsDeps(
            store=McpAppStore(lambda _user: db, "conv"),
            release=_ship(s3, Signer(), _statement()),
            approved=ApprovedRemotes(
                db, "settings", kms, key_id="alias/Mango-test-remote-mcp", gateway_id=GATEWAY_ID
            ),
            gateway=GatewayAppCalls(
                gateway_url="https://gw.example.com/mcp", invocation_key=KEY, transport=gateway
            ),
            agent=lambda _agent_id, _user: _agent(*agent_tools),
            budget_open=lambda _user, _agent_id: budget[0],
            calls=RateLimiter(limit=1000, window_seconds=60),
            audit=audit,  # type: ignore[arg-type]
        )
        yield Env(deps, gateway, audit, db, budget, agent_tools)


def _app(env: Env, output: str = '[{"id":4821}]') -> str:
    apps = create_apps(
        env.deps,
        "member-1",
        CONV,
        TURN,
        _agent(TOOL, PROBE),
        [AppCall(TOOL, '{"action":"my","project":"P"}', output)],
    )
    assert len(apps) == 1
    return apps[0]["app_id"]


def _instance(env: Env, app_id: str) -> Any:
    found = env.deps.store.get("member-1", CONV, app_id)
    assert found is not None
    return found


def test_only_the_tools_whose_profile_curates_an_app_are_recorded(env: Env) -> None:
    assert app_tools(env.deps, _agent(TOOL, PROBE)) == {TOOL}
    assert app_tools(None, _agent(TOOL)) == frozenset()


def test_a_turn_stores_its_apps_and_the_message_keeps_only_ids(env: Env) -> None:
    calls = [
        AppCall(TOOL, '{"action":"my"}', "[1]"),
        AppCall(PROBE, "{}", "[2]"),  # no app
        AppCall(gateway_tool_name("abcdefghij45", "wit_work_item"), "{}", "[3]"),  # not its own
    ]
    apps = create_apps(env.deps, "member-1", CONV, TURN, _agent(TOOL, PROBE), calls)
    assert [(a["registration_id"], a["tool"]) for a in apps] == [(REG, "wit_work_item")]
    assert set(apps[0]) == {"app_id", "registration_id", "tool"}
    stored = _instance(env, apps[0]["app_id"])
    assert stored.tool_output == "[1]" and stored.calls == 0
    # Someone else's partition does not have it.
    assert env.deps.store.get("member-2", CONV, apps[0]["app_id"]) is None


def test_the_app_comes_with_the_curated_html_of_the_release(env: Env) -> None:
    out = app_detail(env.deps, _instance(env, _app(env)))
    assert out.service == "Azure DevOps"
    assert out.html == HTML and out.html_sha256 == app_html_sha256(HTML)
    assert out.tool_input == {"action": "my", "project": "P"}
    assert out.tool_result.content[0].text == '[{"id":4821}]'
    assert (out.calls_used, out.calls_limit) == (0, CALLS_PER_TURN)


def test_a_model_input_that_is_not_an_object_reaches_the_app_as_empty(env: Env) -> None:
    apps = create_apps(
        env.deps, "member-1", CONV, TURN, _agent(TOOL), [AppCall(TOOL, "[1, 2]", "x")]
    )
    assert app_detail(env.deps, _instance(env, apps[0]["app_id"])).tool_input == {}


def test_a_call_of_the_app_goes_through_the_gateway_as_the_agent_and_is_audited(
    env: Env,
) -> None:
    instance = _instance(env, _app(env))
    body = McpAppCallIn(name="wit_work_item", arguments={"action": "get", "id": 4821})
    out = call_tool(env.deps, CALLER, instance, body)
    assert out.result.content[0].text == '{"id":4821}' and out.result.is_error is False
    assert out.calls_used == 1
    assert env.gateway.calls == [{"name": TOOL, "arguments": {"action": "get", "id": 4821}}]
    ((event, user, detail),) = env.audit.events
    assert (event, user) == (EVENT_CALL, "member-1")
    assert detail == {
        "origin": "app",
        "app": instance.app_id,
        "conversation_id": CONV,
        "agent": AGENT,
        "registration": REG,
        "tool": "wit_work_item",
        "outcome": "answered",
    }
    # Never the arguments nor the answer.
    assert "4821" not in json.dumps(detail)


@pytest.mark.parametrize(
    ("name", "setup", "status", "code"),
    [
        ("core_list_projects", None, 403, "app_tool_not_allowed"),
        ("wit_work_item", "no_tool", 403, "app_call_denied"),
        ("wit_work_item", "budget", 402, "budget_exceeded"),
        ("wit_work_item", "down", 502, "remote_unavailable"),
    ],
)
def test_a_call_mango_does_not_make(
    env: Env, name: str, setup: str | None, status: int, code: str
) -> None:
    instance = _instance(env, _app(env))
    if setup == "no_tool":
        env.agent_tools.remove(TOOL)
    elif setup == "budget":
        env.budget[0] = False
    elif setup == "down":
        env.gateway.down = True
    with pytest.raises(ApiError) as error:
        call_tool(env.deps, CALLER, instance, McpAppCallIn(name=name))
    assert (error.value.status, error.value.code) == (status, code)
    if setup != "down":
        assert env.gateway.calls == []
    assert env.audit.events[-1][2]["outcome"] in {
        "not_allowed",
        "denied",
        "budget_exceeded",
        "failed",
    }


def test_an_app_makes_at_most_its_calls_of_the_turn(env: Env) -> None:
    instance = _instance(env, _app(env))
    for _ in range(CALLS_PER_TURN):
        call_tool(env.deps, CALLER, instance, McpAppCallIn(name="wit_work_item"))
    with pytest.raises(ApiError) as error:
        call_tool(env.deps, CALLER, instance, McpAppCallIn(name="wit_work_item"))
    assert (error.value.status, error.value.code) == (429, "app_call_limit")
    assert len(env.gateway.calls) == CALLS_PER_TURN


def test_a_person_makes_at_most_their_calls_per_minute(env: Env) -> None:
    env.deps.calls = RateLimiter(limit=1, window_seconds=60)
    instance = _instance(env, _app(env))
    call_tool(env.deps, CALLER, instance, McpAppCallIn(name="wit_work_item"))
    with pytest.raises(ApiError) as error:
        call_tool(env.deps, CALLER, instance, McpAppCallIn(name="wit_work_item"))
    assert error.value.status == 429 and error.value.code == "rate_limited"


def test_a_tool_error_and_a_consent_reach_the_app(env: Env) -> None:
    instance = _instance(env, _app(env))
    env.gateway.answer = {"content": [{"type": "text", "text": "no such item"}], "isError": True}
    out = call_tool(env.deps, CALLER, instance, McpAppCallIn(name="wit_work_item"))
    assert out.result.is_error is True and out.result.content[0].text == "no such item"
    env.gateway.answer = {"content": [{"type": "image", "data": "AAAA"}]}
    out = call_tool(env.deps, CALLER, instance, McpAppCallIn(name="wit_work_item"))
    assert out.result.content == []


def test_no_answer_leaves_without_its_trail(env: Env) -> None:
    instance = _instance(env, _app(env))
    env.audit.fail_outcomes = {"answered"}
    with pytest.raises(ApiError) as error:
        call_tool(env.deps, CALLER, instance, McpAppCallIn(name="wit_work_item"))
    assert error.value.code == "audit_unavailable"


def test_the_arguments_are_bounded() -> None:
    with pytest.raises(ValueError, match="too large"):
        McpAppCallIn(name="wit_work_item", arguments={"q": "x" * 20_000})
    deep: dict[str, Any] = {}
    node = deep
    for _ in range(10):
        node["a"] = {}
        node = node["a"]
    with pytest.raises(ValueError, match="too deep"):
        McpAppCallIn(name="wit_work_item", arguments=deep)
    with pytest.raises(ValueError):
        McpAppCallIn.model_validate({"name": "wit_work_item", "extra": 1})


def test_the_routes_need_the_owner_of_the_conversation(env: Env) -> None:
    app_id = _app(env)
    denied: list[str] = []

    async def current_user() -> Caller:
        return CALLER

    async def own(caller: Caller, conversation_id: str, owner: str, read_only: bool) -> None:
        if owner != caller.user.user_id:
            denied.append(conversation_id)
            raise ApiError(404, "not_found", "not found")

    api = FastAPI()

    @api.exception_handler(ApiError)
    async def _error(_request: Any, exc: ApiError) -> Any:
        return JSONResponse({"error": {"code": exc.code}}, status_code=exc.status)

    api.include_router(mcp_apps_router(env.deps, current_user, own))
    client = TestClient(api)
    got = client.get(f"/api/conversations/{CONV}/apps/{app_id}")
    assert got.status_code == 200 and got.json()["tool"] == "wit_work_item"
    assert client.get(f"/api/conversations/{CONV}/apps/{'e' * 32}").status_code == 404
    assert client.get(f"/api/conversations/{CONV}/apps/../x").status_code == 404
    called = client.post(
        f"/api/conversations/{CONV}/apps/{app_id}/calls",
        json={"name": "wit_work_item", "arguments": {"id": 1}},
    )
    assert called.status_code == 200 and called.json()["calls_used"] == 1
    assert (
        client.post(
            f"/api/conversations/{CONV}/apps/{app_id}/calls", json={"name": "x", "token": "y"}
        ).status_code
        == 422
    )
    assert split_gateway_tool(TOOL) == (REG, "wit_work_item")


def test_the_message_keeps_the_ids_of_its_apps(env: Env) -> None:
    repo = ConversationRepository(lambda _user: env.db, "conv")
    apps = [{"app_id": "a" * 32, "registration_id": REG, "tool": "wit_work_item"}]
    repo.add_message("member-1", CONV, "assistant", "hola", [], apps=apps)
    repo.add_message("member-1", CONV, "assistant", "sin app", [])
    first, second = repo.messages("member-1", CONV)
    assert first.apps == apps and second.apps == []
