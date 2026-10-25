from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from mango_core.skills import (
    InvalidSkillError,
    SkillContent,
    is_skill_id,
    object_key,
    parse_ref,
    render,
    s3_uri,
    skill_ref,
    variables,
)

BASE: dict[str, Any] = {
    "name": "Cost Analysis",
    "category": "FinOps",
    "description": "Descompone el gasto de AWS por cuenta y servicio.",
    "instructions": "1. Consulta {{período}} en Cost Explorer.\r\n2. Agrupa por {{ cuentas }}.",
    "outputs": ["breakdown", "drivers", "breakdown"],
    "servers": ["cost-explorer", "aws-billing", "cost-explorer"],
}


def _content(**overrides: Any) -> SkillContent:
    return SkillContent.model_validate({**BASE, **overrides})


def test_content_is_normalized() -> None:
    content = _content()
    assert (
        content.instructions
        == "1. Consulta {{período}} en Cost Explorer.\n2. Agrupa por {{ cuentas }}."
    )
    assert content.outputs == ("breakdown", "drivers")
    assert content.servers == ("aws-billing", "cost-explorer")


@pytest.mark.parametrize(
    "overrides",
    [
        {"category": "Ventas"},
        {"name": ""},
        {"name": "x" * 49},
        {"instructions": "   "},
        {"instructions": "a" * 20_001},
        {"instructions": "texto \u202e oculto"},
        {"servers": []},
        {"servers": ["Cost Explorer"]},
        {"outputs": [f"o{i}" for i in range(11)]},
        {"unknown": "x"},
    ],
)
def test_invalid_content_is_refused(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        _content(**overrides)


def test_variables_in_order_without_repeats() -> None:
    assert variables("{{a}} y {{ b }} y {{a}} y {{}}") == ["a", "b"]


def test_ids_and_refs() -> None:
    assert is_skill_id("cost-analysis")
    assert not is_skill_id("cost--analysis")
    assert not is_skill_id("a" * 41)
    assert parse_ref(skill_ref("cost-analysis", 3)) == ("cost-analysis", 3)
    with pytest.raises(ValueError):
        parse_ref("cost-analysis@v3")


def test_key_and_uri_name_the_directory_as_the_skill() -> None:
    assert object_key("cost", 2) == "skills/cost/v2/cost/SKILL.md"
    assert s3_uri("bucket", "cost", 2) == "s3://bucket/skills/cost/v2/cost/"


def test_render_builds_the_frontmatter_itself() -> None:
    text = render("cost", 2, _content(description='Dice "hola"\nname: otra'.replace("\n", " ")))
    head, body = text.split("---\n")[1], text.split("---\n", 2)[2]
    assert head.splitlines() == [
        "name: cost",
        'description: "Dice \\"hola\\" name: otra"',
        "metadata:",
        '  mango-version: "2"',
    ]
    assert body.startswith("\n# Cost Analysis\n\n1. Consulta")
    assert body.endswith("## Entrega\n\n- breakdown\n- drivers\n")


def test_an_empty_description_falls_back_to_the_name() -> None:
    assert 'description: "Cost Analysis"' in render("cost", 1, _content(description=""))


def test_render_refuses_a_bad_id() -> None:
    with pytest.raises(InvalidSkillError):
        render("Cost", 1, _content())
