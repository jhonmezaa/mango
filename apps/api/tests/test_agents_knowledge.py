"""Knowledge bases of an agent version (D88 (15)): who adds them, review, the alert of D26 and
which agents keep one from being deleted. Real Cedar policies and moto DynamoDB."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import replace
from decimal import Decimal
from typing import Any

import pytest

from mango_api.agents import agents_using_knowledge_base
from mango_api.knowledge_store import KnowledgeBase, KnowledgeStore
from mango_api.pricing import knowledge_cost
from mango_core import invocation, knowledge
from mango_core.agents_table import agent_pk, version_sk
from mango_core.knowledge import Status

from . import test_agents_api
from .test_agents_api import (
    Env,
    _approve,
    _code,
    _create,
    _definition,
    _events,
    _h,
    _published,
    _submit,
    _url,
    env,  # noqa: F401 - fixture
)
from .test_knowledge import create_knowledge_table

NOW = "2026-10-01T15:00:00+00:00"


@pytest.fixture
def kbs(env: Env) -> Iterator[KnowledgeStore]:  # noqa: F811
    create_knowledge_table(env.db, "knowledge")
    store = KnowledgeStore(env.db, "knowledge")
    env.deps.knowledge = store
    yield store


def _kb(store: KnowledgeStore, *groups: str, name: str = "Políticas") -> str:
    kb_id = knowledge.new_id()
    store.create(
        KnowledgeBase(
            kb_id=kb_id,
            name=name,
            description="",
            owner_id="creator-2",
            owner_email=None,
            owner_name=None,
            business_unit="all",
            groups=tuple(sorted(groups)),
            classification="internal",
            sync_schedule="manual",
            status=Status.OK,
            documents=0,
            bytes=0,
            version=1,
            created_at=NOW,
            updated_at=NOW,
        )
    )
    return kb_id


def _deleting(store: KnowledgeStore, kb_id: str) -> None:
    kb = store.get(kb_id)
    assert kb is not None
    store.update(kb, {"status": "deleting", "deleting_since": NOW}, now=NOW)


def _save(env: Env, version: dict[str, Any], token: str = "creator", **overrides: Any) -> Any:  # noqa: F811
    return env.client.put(
        _url(version),
        headers=_h(token),
        json={"revision": version["revision"], "definition": _definition(**overrides)},
    )


def _violations(response: Any) -> dict[str, list[str]]:
    return {v["code"]: v["items"] for v in response.json()["violations"]}


# --- Who adds a knowledge base ----------------------------------------------------------


def test_a_creator_adds_a_knowledge_base_they_can_use(env: Env, kbs: KnowledgeStore) -> None:  # noqa: F811
    kb_id = _kb(kbs, "hr", "ops")
    version = _create(env, knowledge_bases=[kb_id])
    assert version["definition"]["knowledge_bases"] == [kb_id]
    assert version["knowledge_bases"] == [
        {"kb_id": kb_id, "name": "Políticas", "status": "ok", "groups_without_access": []}
    ]


def test_a_knowledge_base_the_author_cannot_use_is_refused(env: Env, kbs: KnowledgeStore) -> None:  # noqa: F811
    # TM-K8: the creator is in `hr`, not in `ops`.
    theirs = _kb(kbs, "ops")
    response = env.client.post(
        "/api/agents",
        headers=_h("creator"),
        json={"definition": _definition(knowledge_bases=[theirs])},
    )
    assert (response.status_code, _code(response)) == (422, "validation_failed")
    assert _violations(response) == {"knowledge_base_not_usable": [theirs]}
    [(_, rejected)] = [e for e in _events(env, "agent.created") if e[0] == "rejected"]
    assert rejected["violations"] == ["knowledge_base_not_usable"]
    # Nor added later to a draft.
    version = _create(env)
    response = _save(env, version, knowledge_bases=[theirs])
    assert _violations(response) == {"knowledge_base_not_usable": [theirs]}


def test_unknown_and_deleting_knowledge_bases_are_refused(env: Env, kbs: KnowledgeStore) -> None:  # noqa: F811
    gone = _kb(kbs, "hr")
    _deleting(kbs, gone)
    unknown = knowledge.new_id()
    response = _save(env, _create(env), knowledge_bases=[gone, unknown])
    assert response.status_code == 422
    assert _violations(response) == {"knowledge_base_unavailable": sorted([gone, unknown])}


def test_without_the_registry_no_knowledge_base_is_added(env: Env) -> None:  # noqa: F811
    # Fail closed: an installation without the Knowledge table cannot name one.
    response = env.client.post(
        "/api/agents",
        headers=_h("creator"),
        json={"definition": _definition(knowledge_bases=[knowledge.new_id()])},
    )
    assert "knowledge_base_unavailable" in _violations(response)


def test_an_administrator_keeps_the_ones_a_version_has_but_adds_only_their_own(
    env: Env,  # noqa: F811
    kbs: KnowledgeStore,
) -> None:
    # Being an administrator does not give the use of a knowledge base (D88 (13), rule 5).
    hr = _kb(kbs, "hr")
    version = _create(env, knowledge_bases=[hr])
    saved = _save(env, version, "admin", knowledge_bases=[hr], name="Otro nombre")
    assert saved.status_code == 200, saved.text
    added = _save(env, saved.json(), "admin", knowledge_bases=[hr, _kb(kbs, "ops")])
    assert list(_violations(added)) == ["knowledge_base_not_usable"]


def test_at_most_five_knowledge_bases(env: Env, kbs: KnowledgeStore) -> None:  # noqa: F811
    ids = [_kb(kbs, "hr") for _ in range(6)]
    response = _save(env, _create(env), knowledge_bases=ids)
    assert response.status_code == 422
    assert _save(env, _create(env), knowledge_bases=ids[:5]).status_code == 200


def test_a_knowledge_base_id_must_be_a_ulid(env: Env, kbs: KnowledgeStore) -> None:  # noqa: F811
    response = _save(env, _create(env), knowledge_bases=["../kb/otra"])
    assert response.status_code == 422


# --- Alert of D26 and review ------------------------------------------------------------


def test_the_alert_names_the_groups_that_get_no_answers(env: Env, kbs: KnowledgeStore) -> None:  # noqa: F811
    # D88 (26): these groups use the agent but get nothing from the knowledge base.
    kb_id = _kb(kbs, "hr", "finops-central")
    version = _create(env, knowledge_bases=[kb_id], groups=["hr", "ops", "bu-security"])
    [ref] = version["knowledge_bases"]
    assert ref["groups_without_access"] == ["bu-security", "ops"]
    # Never the groups of the knowledge base itself.
    assert "finops-central" not in str(version["knowledge_bases"])


def test_a_knowledge_base_that_is_gone_shows_without_name(env: Env, kbs: KnowledgeStore) -> None:  # noqa: F811
    kb_id = _kb(kbs, "hr")
    version = _create(env, knowledge_bases=[kb_id])
    kbs._db.delete_item(
        TableName="knowledge", Key={"PK": {"S": f"KB#{kb_id}"}, "SK": {"S": "META"}}
    )
    read = env.client.get(_url(version), headers=_h("creator")).json()
    assert read["knowledge_bases"] == [
        {"kb_id": kb_id, "name": None, "status": None, "groups_without_access": []}
    ]
    assert {v["code"] for v in read["violations"]} == {"knowledge_base_unavailable"}


def test_the_reviewer_sees_the_knowledge_bases_a_change_adds(env: Env, kbs: KnowledgeStore) -> None:  # noqa: F811
    published = _published(env)
    draft = env.client.post(
        f"/api/agents/{published['agent_id']}/versions", headers=_h("creator"), json={}
    ).json()
    kb_id = _kb(kbs, "hr")
    saved = _save(env, draft, knowledge_bases=[kb_id]).json()
    review = env.client.get(_url(_submit(env, saved)), headers=_h("admin")).json()
    assert {"field": "knowledge_bases", "added": [kb_id], "removed": []} in review["diff"]["sets"]
    assert review["knowledge_bases"][0]["name"] == "Políticas"


def test_approval_checks_again_that_the_knowledge_base_exists(
    env: Env,  # noqa: F811
    kbs: KnowledgeStore,
) -> None:
    kb_id = _kb(kbs, "hr")
    review = _submit(env, _create(env, knowledge_bases=[kb_id]))
    _deleting(kbs, kb_id)
    response = _approve(env, review)
    assert (response.status_code, _code(response)) == (422, "validation_failed")
    assert _violations(response) == {"knowledge_base_unavailable": [kb_id]}


def test_a_version_without_knowledge_bases_keeps_its_hash(env: Env, kbs: KnowledgeStore) -> None:  # noqa: F811
    # The canonical form leaves the field out while it is empty (`mango_core.agents`).
    version = _submit(env, _create(env))
    item = env.db.get_item(
        TableName="agents",
        Key={"PK": {"S": agent_pk(version["agent_id"])}, "SK": {"S": version_sk(1)}},
    )["Item"]
    assert "knowledge_bases" not in item["definition"]["S"]


# --- Which agents keep a knowledge base -------------------------------------------------


def test_published_approved_and_failed_versions_keep_a_knowledge_base(
    env: Env,  # noqa: F811
    kbs: KnowledgeStore,
) -> None:
    kb_id = _kb(kbs, "hr")
    published = _published(env, knowledge_bases=[kb_id], name="Publicado")
    approved = _submit(env, _create(env, knowledge_bases=[kb_id], name="Aprobado"))
    assert _approve(env, approved).status_code == 200
    env.sfn.fail = True  # the provisioner does not start: the version is `failed`
    failed = _submit(env, _create(env, knowledge_bases=[kb_id], name="Fallido"))
    assert _approve(env, failed).json()["status"] == "failed"
    env.sfn.fail = False
    # A version in review is checked again when it is approved; a draft serves nothing.
    _submit(env, _create(env, knowledge_bases=[kb_id], name="En revisión"))
    _create(env, knowledge_bases=[kb_id], name="Borrador")
    _published(env, name="Sin KB")
    using = agents_using_knowledge_base(env.deps.store, kb_id)
    assert [(a.agent_id, a.version, a.name) for a in using] == [
        (approved["agent_id"], 1, "Aprobado"),
        (failed["agent_id"], 1, "Fallido"),
        (published["agent_id"], 1, "Publicado"),
    ]
    assert agents_using_knowledge_base(env.deps.store, _kb(kbs, "hr")) == []


# --- The knowledge search in a turn (D88 (14)) -------------------------------------------

EMBEDDING_PRICE = Decimal("0.02")


@pytest.fixture
def priced(monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest) -> Env:
    """`env`, with the price of the embeddings in the settings of mango-api."""
    base = test_agents_api._settings
    monkeypatch.setattr(
        test_agents_api,
        "_settings",
        lambda: replace(base(), knowledge_embedding_price=EMBEDDING_PRICE),
    )
    created: Env = request.getfixturevalue("env")
    created.deps.knowledge = KnowledgeStore(created.db, "knowledge")
    create_knowledge_table(created.db, "knowledge")
    return created


def _searching(stream: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The stream of the fake harness, with its tool call made a knowledge search."""
    for event in stream:
        tool = event.get("contentBlockStart", {}).get("start", {}).get("toolUse")
        if tool is not None:
            tool["name"] = "knowledge___retrieve"
    return stream


def test_a_turn_signs_the_knowledge_bases_and_pays_for_its_searches(priced: Env) -> None:
    kbs = priced.deps.knowledge
    assert kbs is not None
    kb_id = _kb(kbs, "hr")
    agent = _published(priced, name="Con KB", groups=["hr"], knowledge_bases=[kb_id])
    chat = {"message": "hola", "agent_id": agent["agent_id"]}
    assert priced.client.post("/api/chat", headers=_h("member"), json=chat).status_code == 200
    request = priced.agentcore.requests[-1]
    assert "@mango/knowledge___retrieve" in request["allowedTools"]
    headers = request["tools"][0]["config"]["remoteMcp"]["headers"]
    signed = invocation.verify(b"k" * 32, "member-1", headers[invocation.HEADER])
    assert signed is not None
    assert signed.knowledge_bases == (kb_id,)
    assert "knowledge___retrieve" in signed.tools
    # One search per iteration at most, each as the longest query: 8 x 250 tokens.
    without = _published(priced, name="Sin KB", groups=["hr"])
    chat_without = {"message": "hola", "agent_id": without["agent_id"]}
    assert (
        priced.client.post("/api/chat", headers=_h("member"), json=chat_without).status_code == 200
    )
    reserved_with, reserved_without = priced.budgets.reserved[-2:]
    assert (
        reserved_with - reserved_without
        == knowledge_cost(8, EMBEDDING_PRICE)
        == Decimal("0.000040")
    )
    # The search the turn made is charged with it.
    original = priced.agentcore.invoke_harness

    def harness(**kwargs: Any) -> dict[str, Any]:
        return {"stream": _searching(list(original(**kwargs)["stream"]))}

    priced.agentcore.invoke_harness = harness  # type: ignore[method-assign]
    assert priced.client.post("/api/chat", headers=_h("member"), json=chat).status_code == 200
    (_, plain), (_, searched) = priced.budgets.settled[0], priced.budgets.settled[-1]
    assert searched - plain == knowledge_cost(1, EMBEDDING_PRICE) == Decimal("0.000005")


def test_a_version_without_knowledge_bases_is_signed_as_before(env: Env) -> None:  # noqa: F811
    agent = _published(env, name="Sin KB", groups=["hr"])
    chat = {"message": "hola", "agent_id": agent["agent_id"]}
    assert env.client.post("/api/chat", headers=_h("member"), json=chat).status_code == 200
    request = env.agentcore.requests[-1]
    assert request["allowedTools"] == ["@mango/finops___get_cost_and_usage"]
    headers = request["tools"][0]["config"]["remoteMcp"]["headers"]
    signed = invocation.verify(b"k" * 32, "member-1", headers[invocation.HEADER])
    assert signed is not None
    assert signed.knowledge_bases == ()
