from __future__ import annotations

import json
from typing import Any

import pytest
from pydantic import ValidationError

from mango_core.agents import (
    MAX_PROMPT_CHARS,
    ROOT_SUPERVISOR,
    AgentDefinition,
    InvalidDefinitionError,
    content_hash,
    dumps_definition,
    is_agent_id,
    loads_definition,
    new_agent_id,
    verify_content,
)

BASE: dict[str, Any] = {
    "name": "Analista de costos",
    "description": "Analiza el gasto de AWS.",
    "category": "FinOps",
    "reports_to": ROOT_SUPERVISOR,
    "role": "Análisis de costos",
    "model": "us.anthropic.claude-sonnet-4-6",
    "allowed_models": ["us.anthropic.claude-sonnet-4-6"],
    "system_prompt": "Eres un analista.\nResponde en español.",
    "tools": ["cost-explorer.get_cost_forecast", "cost-explorer.get_cost_and_usage"],
    "groups": ["finops-central", "bu-lead"],
    "limits": {"max_tokens": 4096, "max_iterations": 8, "timeout_seconds": 120},
}
# Pinned: a change here means stored hashes of approved versions no longer verify.
BASE_HASH = "73b8725793b90e499c579f14ead61eb546afffc6fd8d579869708996656adf48"


def _definition(**overrides: Any) -> AgentDefinition:
    return AgentDefinition.model_validate({**BASE, **overrides})


def test_generated_ids_are_random_base32_and_fit_a_harness_name() -> None:
    ids = {new_agent_id() for _ in range(200)}
    assert len(ids) == 200
    for agent_id in ids:
        assert is_agent_id(agent_id)
        assert len(agent_id) == 16
        assert len(f"Mango_abcdefgh_a_{agent_id}") <= 40


@pytest.mark.parametrize("value", ["finops", "a1", "abcdefghijklmnop", "a2345672345672ab"])
def test_release_slugs_and_generated_ids_are_valid(value: str) -> None:
    assert is_agent_id(value)


@pytest.mark.parametrize(
    "value",
    [ROOT_SUPERVISOR, "", "a", "Finops", "fin-ops", "fin_ops", "1finops", "a" * 17, None, 7],
)
def test_other_values_are_not_agent_ids(value: object) -> None:
    assert not is_agent_id(value)


def test_canonical_json_is_sorted_compact_and_keeps_unicode() -> None:
    canonical = dumps_definition(_definition())
    assert canonical == json.dumps(
        json.loads(canonical), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    assert "Análisis" in canonical


def test_hash_is_stable_across_processes() -> None:
    assert content_hash(dumps_definition(_definition())) == BASE_HASH


def test_hash_ignores_order_and_duplicates_of_sets() -> None:
    shuffled = _definition(
        tools=[*reversed(BASE["tools"]), BASE["tools"][0]],
        groups=["bu-lead", "finops-central", "bu-lead"],
    )
    assert content_hash(dumps_definition(shuffled)) == BASE_HASH


def test_hash_ignores_unicode_form_and_line_endings() -> None:
    decomposed = _definition(
        role="Ana\u0301lisis de costos", system_prompt="Eres un analista.\r\nResponde en español."
    )
    assert content_hash(dumps_definition(decomposed)) == BASE_HASH


@pytest.mark.parametrize(
    "change",
    [
        {"system_prompt": "Eres un analista.\nResponde en inglés."},
        {"tools": ["cost-explorer.get_cost_and_usage"]},
        {"groups": ["finops-central"]},
        {"reports_to": "finops"},
        {"role": "Otro rol"},
        {"limits": {"max_tokens": 4096, "max_iterations": 9, "timeout_seconds": 120}},
        {"approval_tools": ["cost-explorer.get_cost_forecast"]},
    ],
)
def test_any_content_change_changes_the_hash(change: dict[str, Any]) -> None:
    assert content_hash(dumps_definition(_definition(**change))) != BASE_HASH


def test_round_trip_keeps_the_stored_bytes() -> None:
    canonical = dumps_definition(_definition())
    assert dumps_definition(loads_definition(canonical)) == canonical


def test_verify_content_checks_the_stored_string() -> None:
    canonical = dumps_definition(_definition())
    assert verify_content(canonical, BASE_HASH)
    assert not verify_content(canonical + " ", BASE_HASH)
    assert not verify_content(canonical, BASE_HASH.upper())
    assert not verify_content(canonical, "")


def test_a_draft_only_needs_a_name() -> None:
    draft = AgentDefinition(name="Borrador")
    assert draft.reports_to is None
    assert draft.tools == ()


@pytest.mark.parametrize(
    "change",
    [
        {"iam_policy": {"Action": "*"}},
        {"role_arn": "arn:aws:iam::111111111111:role/Admin"},
        {"limits": {"max_tokens": 4096, "budget": 10}},
        {"name": ""},
        {"name": "   "},
        {"name": "x" * 41},
        {"description": "x" * 141},
        {"role": "x" * 41},
        {"name": "Agente\u202egnp.exe"},
        {"name": "Dos\nlíneas"},
        {"system_prompt": "x" * (MAX_PROMPT_CHARS + 1)},
        {"system_prompt": "visible\u202eoculto"},
        {"system_prompt": "con\x00nulo"},
        {"tools": ["get_cost_and_usage"]},
        {"tools": ["Cost-Explorer.get"]},
        {"tools": [f"cost-explorer.t{i}" for i in range(51)]},
        {"groups": ["Finops Central"]},
        {"users": ["user@example.com"]},
        {"reports_to": "Platform"},
        {"reports_to": "not an id"},
        {"model": "bad model"},
        {"color": 8},
        {"color": True},
        {"icon": "<script>"},
        {"limits": {"max_tokens": 8193}},
        {"limits": {"max_iterations": 26}},
        {"limits": {"timeout_seconds": 601}},
        {"limits": {"max_iterations": "8"}},
        {"limits": {"temperature": 1.5}},
    ],
)
def test_schema_rejects(change: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        _definition(**change)


def test_prompt_keeps_tabs_and_new_lines() -> None:
    assert _definition(system_prompt="a\n\tb").system_prompt == "a\n\tb"


def test_definition_is_immutable() -> None:
    definition = _definition()
    with pytest.raises(ValidationError):
        definition.name = "otro"  # type: ignore[misc]


def test_invalid_stored_definition_fails_closed_without_echoing_content() -> None:
    stored = json.dumps({"name": "x", "system_prompt": "sk-secreto", "iam": "*"})
    with pytest.raises(InvalidDefinitionError) as error:
        loads_definition(stored)
    assert "sk-secreto" not in str(error.value)
    assert error.value.__cause__ is None


def test_every_version_has_a_cap_per_model_call() -> None:
    # D74: the version's own cap, else its `max_tokens`. The reservation counts a whole call.
    for limits, cap, reserved in (
        ({}, 4096, 4096),
        ({"max_tokens": 1024}, 1024, 1024),
        ({"max_tokens": 8000, "max_tokens_per_call": 4000}, 4000, 8000),
        ({"max_tokens": 1024, "max_tokens_per_call": 8192}, 8192, 8192),
    ):
        got = _definition(limits=limits).limits
        assert (got.call_max_tokens, got.reserved_output_tokens) == (cap, reserved)
    # Derived, never stored: the content hash of a version does not change.
    assert "call_max_tokens" not in _definition().limits.model_dump()
    assert content_hash(dumps_definition(_definition())) == BASE_HASH
