"""Tools of remote MCPs in agents, the Builder, the chat and the tasks (D93 (7), D98 (2),
(13), (17), (18), (20)): real Cedar policies, the Agents and Settings tables (moto) and the
catalog the remote provisioner signs, played here with a test key."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from mango_api.mcp import McpDeps, catalog_view
from mango_api.mcp_catalog import CatalogSource, McpCatalog, RemoteStates
from mango_api.remote_mcp_store import INDEX_KEY, ApprovedRemotes, RemoteRecordError, RemoteStore
from mango_api.remote_release import ReleaseRemotes
from mango_api.web import Caller
from mango_core import invocation
from mango_core.identity import user_from_claims
from mango_core.remote_mcp import (
    SIGNING_CONTEXT,
    ApprovedRemote,
    approved_key,
    item_fields,
    registration_key,
)

from .test_agents_api import (
    CONNECTORS,
    COST_TOOL,
    TOKENS,
    Env,
    _code,
    _create,
    _definition,
    _h,
    _published,
    _url,
    env,  # noqa: F401 - fixture
)
from .test_app import FakeConversations
from .test_playground import _harness, _run

KEY = b"k" * 32
REG = "abcdefghij23"
OTHER = "zyxwvutsrq23"
PROJECTS = f"remote-{REG}.core_list_projects"
WIKI = f"remote-{REG}.wiki"
NOT_SIGNED = f"remote-{REG}.wit_work_item"
GATEWAY_PROJECTS = f"remote-{REG}___core_list_projects"
CONSENT = '{"code":-32001,"message":"consent_required","data":{"mango":"consent_required"}}'


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


@dataclass
class Remotes:
    env: Env
    kms: FakeKms

    def register(
        self,
        reg: str = REG,
        *,
        status: str = "active",
        groups: tuple[str, ...] = ("hr",),
        tools: tuple[str, ...] = ("core_list_projects", "wiki"),
        signer: ec.EllipticCurvePrivateKey | None = None,
    ) -> None:
        """What mango-api and the remote provisioner leave for one registration."""
        db = self.env.db
        db.put_item(
            TableName="settings",
            Item={
                **registration_key(reg),
                "profile_id": {"S": "azure-devops"},
                "organization": {"S": "contoso"},
                "toolsets": {"L": [{"S": "core"}, {"S": "wiki"}]},
                "groups": {"L": [{"S": g} for g in groups]},
                "status": {"S": status},
                "version": {"N": "1"},
                "generation": {"N": "1"},
                "created_at": {"S": "2026-10-27T15:00:00+00:00"},
            },
        )
        db.update_item(
            TableName="settings",
            Key=INDEX_KEY,
            UpdateExpression="ADD ids :r",
            ExpressionAttributeValues={":r": {"SS": [reg]}},
        )
        payload = ApprovedRemote(
            registration_id=reg,
            generation=1,
            revision=1,
            profile_id="azure-devops",
            profile_version="2026.10.1-1",
            profile_sha256="a" * 64,
            gateway_id="gw",
            organization="contoso",
            toolsets=("core", "wiki"),
            tools=frozenset(tools),
            probe_tool=tools[0],
            issued_at=1,
        ).encode()
        key = signer or self.kms.key
        signature = key.sign(SIGNING_CONTEXT + payload, ec.ECDSA(hashes.SHA256()))
        db.put_item(
            TableName="settings",
            Item={
                **approved_key(reg),
                **{k: {"S": v} for k, v in item_fields(payload, signature).items()},
            },
        )

    def status(self, reg: str, status: str) -> None:
        self.env.db.update_item(
            TableName="settings",
            Key=registration_key(reg),
            UpdateExpression="SET #s = :s",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": {"S": status}},
        )


@pytest.fixture
def remotes(env: Env, monkeypatch: pytest.MonkeyPatch) -> Iterator[Remotes]:  # noqa: F811
    """The agents environment with the catalog of production: connectors, plus the remote
    registrations of Settings with their signed catalogs."""
    kms = FakeKms()
    monkeypatch.setattr("mango_api.remote_mcp_store.APPROVED_CACHE_SECONDS", 0)
    states = RemoteStates(
        RemoteStore(env.db, "settings"),
        ApprovedRemotes(
            env.db, "settings", kms, key_id="alias/Mango-test-remote-mcp", gateway_id="gw"
        ),
        ReleaseRemotes(None, bucket="", bucket_owner="", catalog={}, public_key_pem=""),  # type: ignore[arg-type]
    )
    connectors = McpCatalog.load(CONNECTORS)
    source = CatalogSource(lambda: connectors, None, None, remotes=states, clock=lambda: 0.0)
    monkeypatch.setattr("mango_api.mcp_catalog.PACK_STATE_SECONDS", -1)
    env.deps.catalog = source
    assert env.deps.published is not None
    monkeypatch.setattr(env.deps.published, "_catalog", source)
    yield Remotes(env, kms)


def _chat(env: Env, token: str, agent_id: str) -> Any:  # noqa: F811
    return env.client.post(
        "/api/chat", headers=_h(token), json={"message": "hola", "agent_id": agent_id}
    )


def _signed_tools(env: Env, user: str) -> set[str]:  # noqa: F811
    request = env.agentcore.requests[-1]
    headers = request["tools"][0]["config"]["remoteMcp"]["headers"]
    signed = invocation.verify(KEY, user, headers[invocation.HEADER])
    assert signed is not None
    return set(signed.tools)


# --- The Builder's catalog ----------------------------------------------------------------


def _builder_catalog(env: Env, token: str) -> dict[str, Any]:  # noqa: F811
    deps = McpDeps(
        catalog=env.deps.catalog,  # type: ignore[arg-type]
        agents=env.deps.store,
        audit=env.deps.audit,
        clock=env.deps.clock,
        authorizer=env.deps.authorizer,
    )
    caller = Caller(user=user_from_claims(TOKENS[token]), token="t", expires_at=0)
    return catalog_view(deps, caller).model_dump()


def test_the_builder_lists_active_remotes_only_to_people_of_their_groups(
    env: Env,  # noqa: F811
    remotes: Remotes,
) -> None:
    remotes.register()
    remotes.register(OTHER, status="disabled")
    body = _builder_catalog(env, "creator")
    (remote,) = body["remotes"]
    assert (remote["id"], remote["registration_id"], remote["organization"]) == (
        f"remote-{REG}",
        REG,
        "contoso",
    )
    assert [t["ref"] for t in remote["tools"]] == [PROJECTS, WIKI]
    assert all(t["access"] == "read" and t["enabled"] for t in remote["tools"])
    # The MCP catalog itself never lists them: they are administered elsewhere.
    assert all(not i["id"].startswith("remote-") for i in body["items"])
    # Being an administrator is not enough (D98 (18)).
    for token in ("creator2", "admin"):
        assert _builder_catalog(env, token)["remotes"] == []


# --- Giving remote tools to an agent --------------------------------------------------------


def test_a_remote_tool_enters_a_version_only_by_someone_of_its_groups(
    env: Env,  # noqa: F811
    remotes: Remotes,
) -> None:
    remotes.register()
    version = _create(env, tools=[COST_TOOL, PROJECTS])
    assert version["definition"]["tools"] == [COST_TOOL, PROJECTS]
    outside = env.client.post(
        "/api/agents",
        headers=_h("creator2"),
        json={"definition": _definition(tools=[PROJECTS])},
    )
    assert (outside.status_code, _code(outside)) == (422, "validation_failed")
    assert outside.json()["violations"] == [
        {"code": "remote_not_usable", "field": "tools", "items": [PROJECTS]}
    ]
    for ref in (NOT_SIGNED, f"remote-{OTHER}.wiki"):
        refused = env.client.post(
            "/api/agents", headers=_h("creator"), json={"definition": _definition(tools=[ref])}
        )
        assert refused.json()["violations"] == [
            {"code": "tool_not_enabled", "field": "tools", "items": [ref]}
        ], ref
    remotes.status(REG, "disabled")
    refused = env.client.post(
        "/api/agents", headers=_h("creator"), json={"definition": _definition(tools=[WIKI])}
    )
    assert refused.json()["violations"][0]["code"] == "tool_not_enabled"


def test_an_editor_outside_the_groups_keeps_the_tools_the_version_had(
    env: Env,  # noqa: F811
    remotes: Remotes,
) -> None:
    remotes.register()
    draft = _create(env, tools=[PROJECTS])
    kept = env.client.put(
        _url(draft),
        headers=_h("admin"),
        json={"revision": 1, "definition": _definition(tools=[PROJECTS], name="Otro nombre")},
    )
    assert kept.status_code == 200, kept.text
    added = env.client.put(
        _url(draft),
        headers=_h("admin"),
        json={"revision": 2, "definition": _definition(tools=[PROJECTS, WIKI])},
    )
    assert added.json()["violations"] == [
        {"code": "remote_not_usable", "field": "tools", "items": [WIKI]}
    ]


def test_the_builder_says_which_groups_use_the_agent_without_its_remote_tools(
    env: Env,  # noqa: F811
    remotes: Remotes,
) -> None:
    remotes.register()
    version = _create(env, tools=[PROJECTS, WIKI], groups=["hr", "ops"])
    assert version["remotes"] == [
        {"registration_id": REG, "service": "azure-devops", "groups_without_access": ["ops"]}
    ]
    # Not a rule: the version still has nothing to fix for it.
    assert version["violations"] == []
    assert _create(env, tools=[COST_TOOL])["remotes"] == []


# --- What each invocation gets ---------------------------------------------------------------


def test_only_people_of_the_registrations_groups_get_its_tools(
    env: Env,  # noqa: F811
    remotes: Remotes,
) -> None:
    remotes.register()
    agent = _published(env, tools=[COST_TOOL, PROJECTS], groups=["hr", "ops"])
    assert _chat(env, "member", agent["agent_id"]).status_code == 200
    assert env.agentcore.requests[-1]["allowedTools"] == [
        "@mango/finops___get_cost_and_usage",
        f"@mango/{GATEWAY_PROJECTS}",
    ]
    assert _signed_tools(env, "member-1") == {"finops___get_cost_and_usage", GATEWAY_PROJECTS}
    # Someone of the agent's groups but not of the registration's: the agent answers without
    # its remote tools, which are neither allowed nor signed (D98 (2)).
    assert _chat(env, "outsider", agent["agent_id"]).status_code == 200
    assert env.agentcore.requests[-1]["allowedTools"] == ["@mango/finops___get_cost_and_usage"]
    assert _signed_tools(env, "out-1") == {"finops___get_cost_and_usage"}


def test_a_registration_that_stops_being_active_takes_its_tools_away(
    env: Env,  # noqa: F811
    remotes: Remotes,
) -> None:
    remotes.register()
    agent = _published(env, tools=[COST_TOOL, PROJECTS])
    detail = env.client.get(f"/api/agents/{agent['agent_id']}", headers=_h("member")).json()
    assert detail["unavailable_tools"] == []
    remotes.status(REG, "disabled")
    detail = env.client.get(f"/api/agents/{agent['agent_id']}", headers=_h("member")).json()
    assert detail["unavailable_tools"] == [PROJECTS]
    assert _chat(env, "member", agent["agent_id"]).status_code == 200
    assert env.agentcore.requests[-1]["allowedTools"] == ["@mango/finops___get_cost_and_usage"]


def test_a_catalog_nobody_signed_gives_no_tools(
    env: Env,  # noqa: F811
    remotes: Remotes,
) -> None:
    remotes.register()
    agent = _published(env, tools=[COST_TOOL, PROJECTS])
    # Written with another key: what mango-api (or anyone) could write is never trusted.
    remotes.register(signer=ec.generate_private_key(ec.SECP256R1()))
    detail = env.client.get(f"/api/agents/{agent['agent_id']}", headers=_h("member")).json()
    assert detail["unavailable_tools"] == [PROJECTS]
    assert _chat(env, "member", agent["agent_id"]).status_code == 200
    assert GATEWAY_PROJECTS not in _signed_tools(env, "member-1")


# --- Consent in the chat ----------------------------------------------------------------------


def _stream(answer: str, status: str) -> list[dict[str, Any]]:
    return [
        {
            "contentBlockStart": {
                "contentBlockIndex": 0,
                "start": {"toolUse": {"toolUseId": "t1", "name": f"mango/{GATEWAY_PROJECTS}"}},
            }
        },
        {"contentBlockStop": {"contentBlockIndex": 0}},
        {
            "contentBlockStart": {
                "contentBlockIndex": 1,
                "start": {"toolResult": {"toolUseId": "t1", "status": status}},
            }
        },
        {
            "contentBlockDelta": {
                "contentBlockIndex": 1,
                "delta": {"toolResult": [{"text": answer}]},
            }
        },
        {"contentBlockStop": {"contentBlockIndex": 1}},
        {"contentBlockDelta": {"contentBlockIndex": 2, "delta": {"text": "Listo"}}},
        {"messageStop": {"stopReason": "end_turn"}},
        {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5}}},
    ]


def _events(body: str) -> list[tuple[str, dict[str, Any]]]:
    out = []
    for block in body.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        if "event" in lines:
            out.append((lines["event"], json.loads(lines["data"])))
    return out


def test_consent_required_shows_the_card_and_is_kept_with_the_message(
    env: Env,  # noqa: F811
    remotes: Remotes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stored: list[tuple[Any, Any]] = []
    add = FakeConversations.add_message

    def record(self: FakeConversations, *args: Any, **kwargs: Any) -> str:
        stored.append((kwargs.get("connection_required"), kwargs.get("remote_sources")))
        return add(self, *args, **kwargs)

    monkeypatch.setattr(FakeConversations, "add_message", record)
    remotes.register()
    agent = _published(env, tools=[PROJECTS])
    env.agentcore.stream = _stream(CONSENT, "error")
    response = _chat(env, "member", agent["agent_id"])
    events = _events(response.text)
    assert ("remote_connection_required", {"registration_id": REG}) in events
    assert "bedrock-agentcore" not in response.text
    assert stored[-1] == ([REG], [])
    assert dict(events)["done"]["remote_sources"] == []
    env.agentcore.stream = _stream('{"projects":[]}', "success")
    response = _chat(env, "member", agent["agent_id"])
    assert stored[-1] == ([], [REG])
    # The live turn carries the same registrations as the stored message, never content or URLs.
    done = dict(_events(response.text))["done"]
    assert done["remote_sources"] == [REG]
    assert "projects" not in json.dumps(done)


# --- The catalog when the registrations cannot be read ----------------------------------------


def test_unread_registrations_make_remote_tools_unavailable_and_are_read_again() -> None:
    connectors = McpCatalog.load(CONNECTORS)
    calls = [0]

    def failing() -> tuple[Any, ...]:
        calls[0] += 1
        raise RemoteRecordError("down")

    source = CatalogSource(lambda: connectors, None, None, remotes=failing, clock=lambda: 0.0)
    catalog = source()
    assert catalog.remotes_available is False
    assert catalog.remote_tool_unavailable(PROJECTS)
    assert catalog.tool_unavailable(PROJECTS)
    # Connectors keep working, and a tool that is not remote is never marked by it.
    assert not catalog.remote_tool_unavailable(COST_TOOL)
    assert catalog.tool(COST_TOOL) is not None
    # A read error is never cached.
    source()
    assert calls[0] == 2


# --- The Playground ---------------------------------------------------------------------------


def test_a_test_gets_only_the_remote_tools_its_person_may_use(
    env: Env,  # noqa: F811
    remotes: Remotes,
) -> None:
    _harness(env)
    remotes.register()
    draft = _create(env, tools=[COST_TOOL, PROJECTS])
    env.agentcore.stream = _stream(CONSENT, "error")
    response = _run(env, "creator", draft)
    assert response.status_code == 200, response.text
    assert f"@mango/{GATEWAY_PROJECTS}" in env.agentcore.requests[-1]["allowedTools"]
    assert ("remote_connection_required", {"registration_id": REG}) in _events(response.text)
    # The registration moves to other groups: the person tests without its tools.
    remotes.register(groups=("ops",))
    response = _run(env, "creator", draft)
    assert response.status_code == 200, response.text
    assert env.agentcore.requests[-1]["allowedTools"] == ["@mango/finops___get_cost_and_usage"]
