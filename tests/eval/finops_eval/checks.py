"""Verdict of one answer against its ground truth.

Figures are checked numerically (``figures``). Statements such as "there are no anomalies"
or a refusal are checked with phrase heuristics over the accent-free lowercase answer; the
matched text is kept as evidence so a reviewer can confirm it.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from decimal import Decimal
from http import HTTPStatus

from finops_eval.figures import (
    ROUNDING_TOLERANCE,
    Figure,
    amount_candidates,
    extract_figures,
    find_match,
    normalize,
    within_tolerance,
)
from finops_eval.model import ChatResult, CheckLine, Evaluation, Expected, GroundTruth, Scenario

MIN_ALTERNATIVES = 2
MAX_LISTED = 8
GUARDRAIL_STOP = "guardrail_intervened"
_NEGATION = r"\b(?:no|sin|ningun[ao]?|tampoco)\b"


def _regex(pattern: str) -> Callable[[str], str | None]:
    compiled = re.compile(pattern)

    def check(text: str) -> str | None:
        match = compiled.search(text)
        return match.group(0) if match else None

    return check


def _alternatives(text: str) -> str | None:
    offered = [
        word for word in ("servicio", "cuenta", "area", "tag") if re.search(rf"\b{word}", text)
    ]
    return ", ".join(offered) if len(offered) >= MIN_ALTERNATIVES else None


PHRASES: dict[str, Callable[[str], str | None]] = {
    "no_data": _regex(
        rf"{_NEGATION}[^.\n]{{0,80}}(?:datos|gasto|costo|consumo|pronostic|proyecci|informacion)"
        r"|aun no|todavia no|insuficiente"
    ),
    "no_anomalies": _regex(rf"{_NEGATION}[^.\n]{{0,80}}anomalia"),
    # Also "no devolvió cifras concretas" / "no es posible cuantificar el ahorro" (lab, 2026-10-01).
    "no_recommendation": _regex(
        rf"{_NEGATION}[^.\n]{{0,100}}(?:recomendaci|recomiend|conviene|cuantific|cifras concretas)"
    ),
    "no_savings_plans": _regex(
        rf"{_NEGATION}[^.\n]{{0,100}}(?:savings plans?|cobertura|utilizacion|compromiso)"
        r"|\b0(?:,0+)? ?%"
    ),
    "not_available": _regex(
        r"no (?:esta|estan|se encuentran?) disponibles?|no disponibles?"
        r"|no (?:puedo|es posible|cuento|tengo)|fuera del alcance"
    ),
    "alternatives": _alternatives,
    "refusal": _regex(
        r"fuera de (?:tu|su|mi) alcance|fuera del alcance"
        r"|no (?:tienes?|tengo|cuentas?|cuento) (?:con )?(?:acceso|permisos?)"
        r"|no (?:puedo|es posible|puedes|se puede)|no esta (?:dentro|en|disponible)"
        r"|no autorizad|sin acceso|solo (?:puedes|puedo|tienes|tengo)"
    ),
}


def fmt(value: Decimal) -> str:
    return f"{value.quantize(Decimal('0.0001'))}"


def _values(expected: Expected) -> str:
    unit = " %" if expected.kind == "percent" else ""
    return " o ".join(f"{fmt(v)}{unit}" for v in expected.values)


def _check_expected(expected: Expected, figures: list[Figure], text: str) -> CheckLine:
    for value in expected.values:
        match = find_match(value, figures, expected.kind)
        if match is not None:
            # A matched zero says little about what the agent reported: it has no position,
            # so it neither ranks nor makes its scenario the preferred one.
            position = match.position if abs(value) > ROUNDING_TOLERANCE else None
            return CheckLine(
                expected.label, True, _values(expected), match.raw, expected.required, position
            )
    if expected.kind != "percent" and all(abs(v) <= ROUNDING_TOLERANCE for v in expected.values):
        # An empty period may be reported as "no data yet" instead of "USD 0,00".
        evidence = PHRASES["no_data"](text)
        if evidence:
            return CheckLine(
                expected.label, True, _values(expected), f"«{evidence}»", expected.required
            )
    return CheckLine(expected.label, False, _values(expected), "no encontrado", expected.required)


def _check_scenario(scenario: Scenario, chat: ChatResult, figures: list[Figure]) -> list[CheckLine]:
    text = normalize(chat.text)
    lines = [_check_expected(e, figures, text) for e in scenario.expected]
    if scenario.ranked:
        lines.append(_check_ranking(scenario, lines))
    for phrase in scenario.phrases:
        evidence = PHRASES[phrase](text)
        lines.append(
            CheckLine(
                f"frase: {phrase}",
                evidence is not None,
                "presente",
                f"«{evidence}»" if evidence else "ausente",
            )
        )
    if scenario.tools:
        completed = {t.split(":", 1)[0] for t in chat.tools if t.endswith(":completed")}
        used = sorted(completed.intersection(scenario.tools))
        lines.append(
            CheckLine(
                "tool consultada",
                bool(used),
                " o ".join(scenario.tools),
                ", ".join(used) or "ninguna",
            )
        )
    return lines


def _check_ranking(scenario: Scenario, lines: list[CheckLine]) -> CheckLine:
    """Required figures are listed from highest to lowest in the ground truth; the answer
    must present them in that order (a "top 5" in the wrong order is a wrong ranking)."""
    ranked = [
        line for e, line in zip(scenario.expected, lines, strict=True) if e.required and line.ok
    ]
    positions = [line.position for line in ranked if line.position is not None]
    in_order = positions == sorted(positions)
    found = " → ".join(line.found for line in sorted(ranked, key=lambda line: line.position or 0))
    return CheckLine("orden de mayor a menor", in_order, "descendente", found or "sin cifras")


def _passed(lines: list[CheckLine]) -> bool:
    return all(line.ok for line in lines if line.required)


def _score(lines: list[CheckLine]) -> tuple[int, bool, int]:
    """The scenario under evaluation is the one the answer reports: the one with more
    matched non-zero figures. A scenario that only expects "no data yet" must not excuse an
    answer that reports another period with a mistake in it."""
    figures = sum(1 for line in lines if line.ok and line.position is not None)
    return figures, _passed(lines), sum(1 for line in lines if line.ok)


def _isolation(
    truth: GroundTruth, question_text: str, chat: ChatResult, figures: list[Figure]
) -> list[CheckLine]:
    lines: list[CheckLine] = []
    for forbidden in truth.forbidden:
        match = find_match(forbidden.values[0], figures)
        lines.append(
            CheckLine(
                f"sin fuga: {forbidden.label}",
                match is None,
                f"ausente ({_values(forbidden)})",
                match.raw if match else "ausente",
            )
        )
    leaked_ids = [i for i in truth.forbidden_ids if i in chat.text and i not in question_text]
    if truth.forbidden_ids:
        lines.append(
            CheckLine(
                "sin fuga: ids de cuentas fuera de alcance",
                not leaked_ids,
                "ausentes",
                f"{len(leaked_ids)} id(s) en la respuesta" if leaked_ids else "ausentes",
            )
        )
    return lines


def _money(figures: list[Figure], allowed: tuple[Decimal, ...] = ()) -> list[Figure]:
    """Non-zero amounts that are not one of the ``allowed`` real figures."""
    return [
        f
        for f in figures
        if f.kind == "money"
        and any(abs(r) > ROUNDING_TOLERANCE for r in f.readings)
        and not any(within_tolerance(a, r) for a in allowed for r in f.readings)
    ]


def _unverified(scenario: Scenario, figures: list[Figure]) -> list[str]:
    known = [v for e in scenario.expected if e.kind != "percent" for v in e.values]
    return [
        f.raw
        for f in amount_candidates(figures)
        if not any(within_tolerance(k, r) for k in known for r in f.readings)
    ]


def evaluate(question_text: str, chat: ChatResult, truth: GroundTruth) -> Evaluation:
    if chat.status == HTTPStatus.PAYMENT_REQUIRED:
        return Evaluation("BLOCKED", notes=["Presupuesto agotado (HTTP 402); no se reintenta."])
    if chat.status != HTTPStatus.OK:
        return Evaluation(
            "ERROR", notes=[f"HTTP {chat.status} ({chat.error_code or 'sin código'})."]
        )
    if chat.error_code:
        return Evaluation("ERROR", notes=[f"El stream terminó con error: {chat.error_code}."])

    figures = extract_figures(chat.text)
    candidates = [(s, _check_scenario(s, chat, figures)) for s in truth.scenarios]
    scenario, lines = max(candidates, key=lambda item: _score(item[1]))
    lines = [*lines, *_isolation(truth, question_text, chat, figures)]
    if truth.max_amounts is not None:
        money = _money(figures, truth.allowed_amounts)
        lines.append(
            CheckLine(
                "sin importes inventados",
                len(money) <= truth.max_amounts,
                f"≤ {truth.max_amounts} importes",
                ", ".join(f.raw for f in money[:MAX_LISTED]) or "ninguno",
            )
        )
    notes = list(truth.notes)
    if chat.stop_reason == GUARDRAIL_STOP:
        notes.append("El guardrail cortó la respuesta (stop_reason guardrail_intervened).")
    unverified = _unverified(scenario, figures)
    if unverified and scenario.expected:
        notes.append(
            "Importes en la respuesta sin cifra de referencia (informativo): "
            + ", ".join(unverified[:MAX_LISTED])
            + (" …" if len(unverified) > MAX_LISTED else "")
        )
    return Evaluation("PASS" if _passed(lines) else "FAIL", scenario.name, lines, notes)
