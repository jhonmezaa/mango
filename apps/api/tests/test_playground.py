"""The Playground (D91), end to end inside mango-api: the real Cedar policies, the Agents
table (moto), the harness the provisioner wrote and the Gateway signature."""

from __future__ import annotations

import json
from typing import Any

import pytest

from mango_core import invocation
from mango_core.playground import PlaygroundHarness

from .test_agents_api import (
    COST_TOOL,
    HAIKU,
    SECRET,
    SONNET,
    Env,
    _code,
    _create,
    _h,
    _published,
    _submit,
    env,  # noqa: F401 - fixture
)

KEY = b"k" * 32
PLAYGROUND = (
    "arn:aws:bedrock-agentcore:us-east-1:111111111111:harness/Mango_test_a_playground-AbCdE12345"
)
WRITE_TOOL = "aws-budgets.create_budget"


@pytest.fixture(autouse=True)
def _no_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("mango_api.playground.HARNESS_CACHE_SECONDS", 0)


def _harness(env: Env, models: tuple[str, ...] = (SONNET,), arn: str = PLAYGROUND) -> None:  # noqa: F811
    """What the provisioner writes once the test harness is up to date."""
    env.db.put_item(
        TableName="settings",
        Item=PlaygroundHarness(arn, "2", models, "2026-10-25T10:00:00+00:00").item(),
    )


def _run(env: Env, token: str, version: dict[str, Any], **body: Any) -> Any:  # noqa: F811
    payload = {
        "agent_id": version["agent_id"],
        "version": version["version"],
        "revision": version["revision"],
        "message": "¿Cuánto gasté?",
        **body,
    }
    return env.client.post("/api/playground/runs", headers=_h(token), json=payload)


def _events(response: Any) -> list[tuple[str, dict[str, Any]]]:
    out = []
    for chunk in response.text.split("\n\n"):
        lines = dict(line.split(": ", 1) for line in chunk.splitlines() if ": " in line)
        if "event" in lines:
            out.append((lines["event"], json.loads(lines["data"])))
    return out


def _audited(env: Env, name: str) -> list[dict[str, Any]]:  # noqa: F811
    return [d for e, _u, d in env.audit.events if e == name]


def test_the_creator_tests_a_draft_with_unsaved_changes_on_the_test_harness(env: Env) -> None:  # noqa: F811
    _harness(env)
    draft = _create(env)
    response = _run(
        env,
        "creator",
        draft,
        overrides={"system_prompt": "Eres breve.", "temperature": 0.7},
    )
    assert response.status_code == 200, response.text
    kinds = [kind for kind, _ in _events(response)]
    assert "delta" in kinds and kinds[-1] == "done"
    done = _events(response)[-1][1]
    assert done["usage"] == {"input_tokens": 1000, "output_tokens": 100}
    assert set(done["flags"]) == {"guardrail", "token_cap", "time_limit", "iteration_limit"}

    (request,) = env.agentcore.requests
    # The shared harness, never the agent's; the version's tools and limits; the changes.
    assert request["harnessArn"] == PLAYGROUND
    assert request["qualifier"] == "live"
    assert request["systemPrompt"][0]["text"].startswith("Eres breve.")
    assert request["model"]["bedrockModelConfig"]["modelId"] == SONNET
    assert request["model"]["bedrockModelConfig"]["temperature"] == 0.7
    assert request["allowedTools"] == ["@mango/finops___get_cost_and_usage"]
    # One question alone: no history.
    assert len(request["messages"]) == 1
    headers = request["tools"][0]["config"]["remoteMcp"]["headers"]
    assert headers["Authorization"] == "Bearer creator"
    signed = invocation.verify(KEY, "creator-1", headers[invocation.HEADER])
    assert signed is not None
    assert signed.playground is True
    assert (signed.agent_id, signed.agent_version) == (draft["agent_id"], 1)
    # Reserved before invoking, on the person and the agent (rule 4).
    assert [s.key for s in env.budgets.scopes] == ["USER#creator-1", f"AGENT#{draft['agent_id']}"]
    assert len(env.budgets.settled) == 1

    (run,) = _audited(env, "playground.run")
    assert run["agent"] == draft["agent_id"]
    assert run["changed"] == ["system_prompt", "temperature"]
    assert run["settlement"] == "final"
    # Never the prompt, the question or the answer.
    text = json.dumps(env.audit.events)
    assert "Eres breve" not in text and "Cuánto gasté" not in text and "mundo" not in text


def test_the_published_version_is_tested_for_the_comparison(env: Env) -> None:  # noqa: F811
    _harness(env)
    live = _published(env)
    response = _run(env, "creator", live)
    assert response.status_code == 200, response.text
    (request,) = env.agentcore.requests
    assert request["harnessArn"] == PLAYGROUND
    assert request["systemPrompt"][0]["text"].startswith("Eres un analista.")


@pytest.mark.parametrize(("token", "status"), [("creator2", 403), ("member", 403), ("admin", 200)])
def test_only_whoever_edits_the_agent_tests_it(env: Env, token: str, status: int) -> None:  # noqa: F811
    _harness(env)
    draft = _create(env)
    assert _run(env, token, draft).status_code == status
    if status == 403:
        assert env.agentcore.requests == []


def test_an_agent_that_does_not_exist_is_denied_like_any_other(env: Env) -> None:  # noqa: F811
    _harness(env)
    ghost = {"agent_id": "abcdefghijklmnop", "version": 1, "revision": 1}
    assert _run(env, "creator", ghost).status_code == 403


def test_a_prompt_with_a_secret_never_reaches_the_model(env: Env) -> None:  # noqa: F811
    _harness(env)
    draft = _create(env)
    response = _run(env, "creator", draft, overrides={"system_prompt": f"clave {SECRET}"})
    assert response.status_code == 422
    assert _code(response) == "secret_in_prompt"
    assert SECRET not in response.text
    assert env.agentcore.requests == []
    assert env.budgets.reserved == []


def test_without_the_test_harness_the_playground_is_unavailable(env: Env) -> None:  # noqa: F811
    draft = _create(env)
    response = _run(env, "creator", draft)
    assert (response.status_code, _code(response)) == (503, "playground_unavailable")


def test_a_harness_that_is_not_this_installations_is_not_invoked(env: Env) -> None:  # noqa: F811
    _harness(env, arn=PLAYGROUND.replace("Mango_test_a_", "Mango_other_a_"))
    response = _run(env, "creator", _create(env))
    assert (response.status_code, _code(response)) == (503, "playground_unavailable")
    assert env.agentcore.requests == []


def test_the_model_must_be_enabled_and_in_the_harness_role(env: Env) -> None:  # noqa: F811
    _harness(env)
    draft = _create(env)
    # HAIKU is disabled in the catalog.
    response = _run(env, "creator", draft, overrides={"model": HAIKU})
    assert (response.status_code, _code(response)) == (409, "model_unavailable")
    # Enabled, but the provisioner has not written it into the role yet.
    _harness(env, models=(HAIKU,))
    response = _run(env, "creator", draft)
    assert (response.status_code, _code(response)) == (503, "playground_unavailable")
    assert env.agentcore.requests == []


def test_a_draft_that_changed_is_not_tested_blind(env: Env) -> None:  # noqa: F811
    _harness(env)
    draft = _create(env)
    response = _run(env, "creator", {**draft, "revision": draft["revision"] + 1})
    assert (response.status_code, _code(response)) == (409, "version_conflict")


def test_a_version_in_review_is_not_testable(env: Env) -> None:  # noqa: F811
    _harness(env)
    review = _submit(env, _create(env))
    response = _run(env, "creator", review)
    assert (response.status_code, _code(response)) == (409, "version_not_testable")


def test_a_write_tool_is_simulated_never_asked(env: Env) -> None:  # noqa: F811
    _harness(env)
    draft = _create(env, tools=[COST_TOOL, WRITE_TOOL], approval_tools=[WRITE_TOOL])
    env.agentcore.stream = [
        {
            "contentBlockStart": {
                "contentBlockIndex": 0,
                "start": {"toolUse": {"toolUseId": "w1", "name": "ops___create_budget"}},
            }
        },
        {
            "contentBlockDelta": {
                "contentBlockIndex": 0,
                "delta": {"toolUse": {"input": '{"amount": 500}'}},
            }
        },
        {"contentBlockStop": {"contentBlockIndex": 0}},
        {"messageStop": {"stopReason": "tool_use"}},
        {"metadata": {"usage": {"inputTokens": 500, "outputTokens": 40}}},
    ]
    response = _run(env, "creator", draft)
    assert response.status_code == 200, response.text
    events = _events(response)
    assert ("simulated_write", {"tool": "create_budget"}) in events
    assert all(kind != "approval" for kind, _ in events)
    (run,) = _audited(env, "playground.run")
    assert run["simulated_writes"] == ["create_budget"]
    assert '"amount"' not in json.dumps(env.audit.events)


def test_without_budget_the_test_does_not_run(env: Env) -> None:  # noqa: F811
    _harness(env)
    env.budgets.exceed = True
    response = _run(env, "creator", _create(env))
    assert response.status_code == 200
    # The fake names a scope that is not an agent's: the person's budget stopped it.
    assert _events(response) == [("error", {"code": "budget_exceeded", "scope": "user"})]
    assert env.agentcore.requests == []


def test_a_failed_test_says_so_and_settles(env: Env) -> None:  # noqa: F811
    _harness(env)
    env.agentcore.fail = True
    response = _run(env, "creator", _create(env))
    failed = {"code": "upstream_error", "message": "the test failed"}
    assert _events(response)[-1] == ("error", failed)
    (run,) = _audited(env, "playground.run")
    assert run["settlement"] in {"final", "pending"}


def test_the_body_is_strict(env: Env) -> None:  # noqa: F811
    _harness(env)
    draft = _create(env)
    assert _run(env, "creator", draft, tools=["x.y"]).status_code == 422
    assert _run(env, "creator", draft, overrides={"tools": []}).status_code == 422
    assert _run(env, "creator", draft, overrides={"temperature": 2}).status_code == 422
    assert _run(env, "creator", draft, message="x" * 4001).status_code == 422
    assert env.agentcore.requests == []


# --- Skills of the tested version (D91 (12)) ----------------------------------------------


SKILL_REF = "revisar-costos@2"
BUCKET = "mango-test-skills"


class FakeSkills:
    """The approved versions of the skills registry, by ref."""

    def __init__(self, approved: set[str]) -> None:
        self._approved = approved

    def approved(self, refs: dict[str, tuple[str, int]]) -> dict[str, Any]:
        return {ref: object() for ref in refs if ref in self._approved}


def _deps(env: Env, skills: Any, bucket: str = BUCKET) -> Any:  # noqa: F811
    from decimal import Decimal  # noqa: PLC0415

    from mango_api.model_catalog import ModelCatalogStore  # noqa: PLC0415
    from mango_api.playground import PlaygroundDeps, PlaygroundHarnesses  # noqa: PLC0415
    from mango_api.rate_limits import MemoryLeases  # noqa: PLC0415
    from mango_api.settings import ModelPrice  # noqa: PLC0415
    from mango_api.web import Caller  # noqa: PLC0415

    from .test_admin import RecordingAudit  # noqa: PLC0415

    class _Runs:
        def allow(self, _key: str) -> bool:
            return True

        def retry_after(self, _key: str) -> int:
            return 0

    deps = PlaygroundDeps(
        store=env.deps.store,
        published=env.deps.published,  # type: ignore[arg-type]
        harnesses=PlaygroundHarnesses(env.db, "settings", namespace="test", region="us-east-1"),
        catalog=ModelCatalogStore(env.db, "settings").catalog,
        price=lambda _m: ModelPrice(
            input=Decimal(3), output=Decimal(15), cache_read=Decimal(0), cache_write=Decimal(0)
        ),
        scopes=lambda _caller, _agent: [],
        budgets=env.budgets,  # type: ignore[arg-type]
        audit=RecordingAudit(),  # type: ignore[arg-type]
        agentcore=env.agentcore,
        invocation_key=KEY,
        gateway_url="https://gateway.example.com/mcp",
        guardrail_id="gr1",
        guardrail_version="1",
        knowledge_price=Decimal(0),
        runs=_Runs(),
        concurrent=MemoryLeases(2, 60),
        skills=skills,
        skills_bucket=bucket,
    )
    return deps, Caller


def _body(version: dict[str, Any]) -> Any:
    from mango_api.playground import PlaygroundRunIn  # noqa: PLC0415

    return PlaygroundRunIn(
        agent_id=version["agent_id"],
        version=version["version"],
        revision=version["revision"],
        message="hola",
    )


def test_the_tested_versions_skills_go_in_the_test_invocation(env: Env) -> None:  # noqa: F811
    from mango_api import playground  # noqa: PLC0415

    env.db.put_item(
        TableName="settings",
        Item=PlaygroundHarness(PLAYGROUND, "2", (SONNET,), "now", skills=True).item(),
    )
    draft = _create(env, skills=[SKILL_REF])
    deps, _ = _deps(env, FakeSkills({SKILL_REF}))
    test = playground._prepare(deps, draft["agent_id"], _body(draft))
    # Built here from the stored version, in this installation's bucket.
    assert test.skill_sources == (
        {"s3": {"uri": f"s3://{BUCKET}/skills/revisar-costos/v2/revisar-costos/"}},
    )
    assert test.skill_ids == ("revisar-costos",)


def test_a_skill_that_is_not_approved_is_not_tested(env: Env) -> None:  # noqa: F811
    from mango_api import playground  # noqa: PLC0415
    from mango_api.web import ApiError  # noqa: PLC0415

    env.db.put_item(
        TableName="settings",
        Item=PlaygroundHarness(PLAYGROUND, "2", (SONNET,), "now", skills=True).item(),
    )
    draft = _create(env, skills=[SKILL_REF])
    deps, _ = _deps(env, FakeSkills(set()))
    with pytest.raises(ApiError) as caught:
        playground._prepare(deps, draft["agent_id"], _body(draft))
    assert (caught.value.status, caught.value.code) == (422, "skill_unavailable")
    # It names which ones, as `id@version` only (design round 23).
    assert caught.value.extra == {"skills": [SKILL_REF]}


def test_only_the_skills_that_are_not_approved_are_named(env: Env) -> None:  # noqa: F811
    from mango_api import playground  # noqa: PLC0415
    from mango_api.web import ApiError  # noqa: PLC0415

    env.db.put_item(
        TableName="settings",
        Item=PlaygroundHarness(PLAYGROUND, "2", (SONNET,), "now", skills=True).item(),
    )
    draft = _create(env, skills=["alertas@1", SKILL_REF, "costos-ec2@3"])
    deps, _ = _deps(env, FakeSkills({SKILL_REF}))
    with pytest.raises(ApiError) as caught:
        playground._prepare(deps, draft["agent_id"], _body(draft))
    assert caught.value.extra == {"skills": ["alertas@1", "costos-ec2@3"]}


@pytest.mark.parametrize("case", ["role_reads_none", "no_bucket", "no_registry"])
def test_without_a_way_to_load_skills_a_version_with_them_is_not_tested(
    env: Env,  # noqa: F811
    case: str,
) -> None:
    from mango_api import playground  # noqa: PLC0415
    from mango_api.web import ApiError  # noqa: PLC0415

    env.db.put_item(
        TableName="settings",
        Item=PlaygroundHarness(
            PLAYGROUND, "2", (SONNET,), "now", skills=case != "role_reads_none"
        ).item(),
    )
    draft = _create(env, skills=[SKILL_REF])
    deps, _ = _deps(
        env,
        None if case == "no_registry" else FakeSkills({SKILL_REF}),
        bucket="" if case == "no_bucket" else BUCKET,
    )
    with pytest.raises(ApiError) as caught:
        playground._prepare(deps, draft["agent_id"], _body(draft))
    assert (caught.value.status, caught.value.code) == (503, "skills_unavailable")


def test_through_the_route_a_version_with_skills_needs_the_registry(env: Env) -> None:  # noqa: F811
    # The shared test app has no skills registry: the version is not tested blind.
    _harness(env)
    response = _run(env, "creator", _create(env, skills=[SKILL_REF]))
    assert (response.status_code, _code(response)) == (503, "skills_unavailable")
    assert env.agentcore.requests == []
