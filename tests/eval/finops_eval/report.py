"""JSON and Markdown reports of one evaluation run.

Reports hold the agent's answers and account ids of the installation, so they are written
outside version control with owner-only permissions.
"""

from __future__ import annotations

import json
import os
import stat
import statistics
from dataclasses import asdict, dataclass
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from finops_eval.model import QuestionResult

ACCURACY_QUESTIONS = frozenset(f"Q{i}" for i in range(1, 11))
ISOLATION_QUESTIONS = frozenset({"Q11", "Q12"})
EXCERPT_CHARS = 1200
P90_QUANTILES = 10


@dataclass(frozen=True)
class RunInfo:
    started_at: datetime
    app_url: str
    today: str
    tolerance: str


def _default(value: object) -> str:
    if isinstance(value, Decimal):
        return str(value)
    raise TypeError(f"not serializable: {type(value).__name__}")


def _percentile_90(values: list[float]) -> float | None:
    if not values:
        return None
    if len(values) == 1:
        return values[0]
    return statistics.quantiles(values, n=P90_QUANTILES, method="inclusive")[-1]


def summary(results: list[QuestionResult]) -> dict[str, Any]:
    def passed(ids: frozenset[str]) -> str:
        subset = [r for r in results if r.question.qid in ids]
        return f"{sum(1 for r in subset if r.evaluation.verdict == 'PASS')}/{len(subset)}"

    first = [r.chat.first_token_seconds for r in results if r.chat.first_token_seconds is not None]
    total = [r.chat.total_seconds for r in results if r.chat.status == 200]
    verdicts: dict[str, int] = {}
    for r in results:
        verdicts[r.evaluation.verdict] = verdicts.get(r.evaluation.verdict, 0) + 1
    return {
        "questions": len(results),
        "verdicts": verdicts,
        "accuracy_q1_q10": passed(ACCURACY_QUESTIONS),
        "isolation_q11_q12": passed(ISOLATION_QUESTIONS),
        "chat_cost_usd": str(sum((r.chat.cost_usd for r in results), Decimal(0))),
        "input_tokens": sum(r.chat.input_tokens for r in results),
        "output_tokens": sum(r.chat.output_tokens for r in results),
        "first_token_p50_seconds": round(statistics.median(first), 2) if first else None,
        "total_p90_seconds": _round(_percentile_90(total)),
    }


def _round(value: float | None) -> float | None:
    return None if value is None else round(value, 2)


def to_json(info: RunInfo, results: list[QuestionResult]) -> dict[str, Any]:
    return {
        "run": {
            "started_at": info.started_at.isoformat(),
            "app_url": info.app_url,
            "today": info.today,
            "tolerance": info.tolerance,
        },
        "summary": summary(results),
        "results": [
            {
                "id": r.question.qid,
                "profile": r.question.profile,
                "kind": r.question.kind,
                "question": r.text,
                "verdict": r.evaluation.verdict,
                "scenario": r.evaluation.scenario,
                "checks": [asdict(c) for c in r.evaluation.checks],
                "notes": r.evaluation.notes,
                "answer": r.chat.text,
                "tools": r.chat.tools,
                "http_status": r.chat.status,
                "error_code": r.chat.error_code,
                "stop_reason": r.chat.stop_reason,
                "input_tokens": r.chat.input_tokens,
                "output_tokens": r.chat.output_tokens,
                "cost_usd": r.chat.cost_usd,
                "first_token_seconds": _round(r.chat.first_token_seconds),
                "total_seconds": _round(r.chat.total_seconds),
            }
            for r in results
        ],
    }


def _cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def _tools(result: QuestionResult) -> str:
    started = [t.split(":", 1)[0] for t in result.chat.tools if t.endswith(":started")]
    counts: dict[str, int] = {}
    for name in started:
        counts[name] = counts.get(name, 0) + 1
    return ", ".join(f"{n} x{c}" if c > 1 else n for n, c in counts.items()) or "—"


def _figures(result: QuestionResult) -> str:
    parts = [
        f"{c.label}: {c.expected} → {c.found}{'' if c.ok else ' ✗'}"
        for c in result.evaluation.checks
        if c.required and not c.label.startswith(("sin fuga", "tool"))
    ]
    leaks = [c for c in result.evaluation.checks if c.label.startswith("sin fuga")]
    if leaks:
        failed = sum(1 for c in leaks if not c.ok)
        parts.append(f"fugas: {failed}/{len(leaks)}")
    return "; ".join(parts) or "—"


def to_markdown(info: RunInfo, results: list[QuestionResult]) -> str:
    stats = summary(results)
    lines = [
        "# Evaluación del agente FinOps (golden set Q1 a Q12)",
        "",
        f"- Inicio: {info.started_at.isoformat(timespec='seconds')}",
        f"- Instalación: {info.app_url}",
        f"- Fecha de referencia (UTC): {info.today}",
        f"- Tolerancia: {info.tolerance}",
        f"- Veredictos: {stats['verdicts']}",
        f"- Exactitud Q1 a Q10: {stats['accuracy_q1_q10']} · Aislamiento Q11 y Q12: "
        f"{stats['isolation_q11_q12']}",
        f"- Costo de chat: USD {stats['chat_cost_usd']} "
        f"({stats['input_tokens']} tokens de entrada, {stats['output_tokens']} de salida)",
        f"- Primer bloque p50: {stats['first_token_p50_seconds']} s · "
        f"respuesta completa p90: {stats['total_p90_seconds']} s",
        "",
        "| # | Perfil | Veredicto | Esperado → respuesta | Tools | Tokens (in/out) | Costo USD | "
        "1.er bloque / total (s) |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        lines.append(
            f"| {r.question.qid} | {r.question.profile} | {r.evaluation.verdict} | "
            f"{_cell(_figures(r))} | {_cell(_tools(r))} | "
            f"{r.chat.input_tokens}/{r.chat.output_tokens} | {r.chat.cost_usd} | "
            f"{_round(r.chat.first_token_seconds)} / {_round(r.chat.total_seconds)} |"
        )
    for r in results:
        lines += [
            "",
            f"## {r.question.key}: {r.evaluation.verdict}",
            "",
            f"**Pregunta:** {r.text}",
            "",
            f"**Escenario evaluado:** {r.evaluation.scenario or '—'}",
            "",
        ]
        if r.evaluation.checks:
            lines += [
                "| Chequeo | OK | Esperado | Encontrado | Obligatorio |",
                "|---|---|---|---|---|",
            ]
            lines += [
                f"| {_cell(c.label)} | {'sí' if c.ok else 'no'} | {_cell(c.expected)} | "
                f"{_cell(c.found)} | {'sí' if c.required else 'no'} |"
                for c in r.evaluation.checks
            ]
            lines.append("")
        lines += [f"- {note}" for note in r.evaluation.notes]
        excerpt = r.chat.text[:EXCERPT_CHARS] + ("…" if len(r.chat.text) > EXCERPT_CHARS else "")
        if excerpt:
            lines += [
                "",
                "**Respuesta (extracto):**",
                "",
                *[f"> {x}" for x in excerpt.splitlines()],
            ]
    return "\n".join(lines) + "\n"


def _write_private(path: Path, content: str) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    with os.fdopen(os.open(path, flags, stat.S_IRUSR | stat.S_IWUSR), "w", encoding="utf-8") as f:
        f.write(content)


def write(directory: Path, info: RunInfo, results: list[QuestionResult]) -> tuple[Path, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    stem = f"finops-eval-{info.started_at.strftime('%Y%m%dT%H%M%SZ')}"
    json_path, md_path = directory / f"{stem}.json", directory / f"{stem}.md"
    _write_private(
        json_path,
        json.dumps(to_json(info, results), ensure_ascii=False, indent=2, default=_default),
    )
    _write_private(md_path, to_markdown(info, results))
    return json_path, md_path
