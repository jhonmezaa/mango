"""The PDF of a task run, drawn by code from validated data (D86, D87; design `Reporte de tarea`).

Security notes (TM-R1): no HTML, CSS or browser. Every text that reaches ReportLab's paragraph
markup is escaped first, so the only tags it sees are the ones written here (``<b>`` and the
font of ``code``): never ``<img>``, ``<a>`` or a font chosen by the data. The fonts are the
files of this package (IBM Plex, OFL); nothing is read from a path or a URL the data names.
"""

from __future__ import annotations

import io
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape
from zoneinfo import ZoneInfo

from reportlab.graphics.shapes import Drawing, Line, PolyLine, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import (
    BaseDocTemplate,
    CondPageBreak,
    Flowable,
    Frame,
    KeepTogether,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

from mango_core import task_reports as tr

FONTS = Path(__file__).parent / "fonts"
SANS, SANS_MEDIUM, SANS_BOLD, MONO = "PlexSans", "PlexSans-Medium", "PlexSans-SemiBold", "PlexMono"

INK = colors.HexColor("#18181b")
MUTED = colors.HexColor("#5b5b65")
RULE = colors.HexColor("#e2e2e8")
SOFT = colors.HexColor("#f4f4f6")
BAR = colors.HexColor("#33333a")
ACCENT = colors.HexColor("#e2711d")
ACCENT_SOFT = colors.Color(226 / 255, 113 / 255, 29 / 255, alpha=0.13)
UP = colors.HexColor("#c2410c")
MINUS, EN_DASH = "\u2212", tr.EN_DASH
"""Typographic minus and the dash of a range, as the design writes them."""
DOWN = colors.HexColor("#15803d")

MONTHS, SHORT_MONTHS = tr.MONTHS, tr.SHORT_MONTHS
ZONES = {
    "America/Mexico_City": "Ciudad de México",
    "America/Bogota": "Bogotá",
    "America/Sao_Paulo": "São Paulo",
    "UTC": "UTC",
}
TOOL_LABEL = "get_cost_and_usage"


class RenderError(Exception):
    """The PDF could not be drawn (``render``)."""


def _register_fonts() -> None:
    if SANS in pdfmetrics.getRegisteredFontNames():
        return
    for name, file in (
        (SANS, "IBMPlexSans-Regular.ttf"),
        (SANS_MEDIUM, "IBMPlexSans-Medium.ttf"),
        (SANS_BOLD, "IBMPlexSans-SemiBold.ttf"),
        (MONO, "IBMPlexMono-Regular.ttf"),
    ):
        pdfmetrics.registerFont(TTFont(name, str(FONTS / file)))
    pdfmetrics.registerFontFamily(
        SANS, normal=SANS, bold=SANS_BOLD, italic=SANS, boldItalic=SANS_BOLD
    )


# --- Formats --------------------------------------------------------------------------------


def number(value: Decimal, places: int = 2) -> str:
    """``84.312,40``: dot for thousands, comma for decimals (FinOps' rule)."""
    text = f"{abs(value):,.{places}f}".replace(",", " ").replace(".", ",").replace(" ", ".")
    return f"{MINUS}{text}" if value < 0 else text


def usd(value: Decimal) -> str:
    return f"USD {number(value)}" if value >= 0 else f"{MINUS}USD {number(-value)}"


def signed_usd(value: Decimal) -> str:
    return f"+USD {number(value)}" if value >= 0 else f"{MINUS}USD {number(-value)}"


def percent(value: Decimal) -> str:
    sign = "+" if value > 0 else (MINUS if value < 0 else "")
    return f"{sign}{number(abs(value), 1)} %"


day_month, short_date, date_range, period_label = (
    tr.day_month,
    tr.short_date,
    tr.date_range,
    tr.period_label,
)


def long_range(start: date, end: date) -> str:
    """``Del 1 al 30 de septiembre de 2026``."""
    if (start.year, start.month) == (end.year, end.month):
        return f"Del {start.day} al {end.day} de {MONTHS[end.month - 1]} de {end.year}"
    return (
        f"Del {start.day} de {MONTHS[start.month - 1]} de {start.year} "
        f"al {end.day} de {MONTHS[end.month - 1]} de {end.year}"
    )


def generated(at: datetime, timezone: str | None) -> str:
    zone = timezone if timezone in ZONES else "UTC"
    local = at.astimezone(ZoneInfo(zone))
    when = f"{short_date(local.date())}, {local:%H:%M}"
    return f"{when} UTC" if zone == "UTC" else f"{when} (hora de {ZONES[zone]})"


# --- Text -----------------------------------------------------------------------------------


def text(value: str) -> str:
    """Plain text for the paragraph markup: everything escaped (TM-R1)."""
    return escape(value)


_BOLD = re.compile(r"\*\*(.+?)\*\*")
_CODE = re.compile(r"`([^`]+)`")


def _inline(line: str) -> str:
    """The inline Markdown the notes may use, on escaped text: bold and code, nothing else
    (no links, images or HTML; a model's link stays text)."""
    out = escape(line)
    out = _BOLD.sub(r"<b>\1</b>", out)
    return _CODE.sub(lambda m: f'<font face="{MONO}">{m.group(1)}</font>', out)


@dataclass(frozen=True)
class Styles:
    body: ParagraphStyle
    small: ParagraphStyle
    muted: ParagraphStyle
    h1: ParagraphStyle
    h2: ParagraphStyle
    cell: ParagraphStyle
    cell_num: ParagraphStyle
    cell_mono: ParagraphStyle
    kpi_label: ParagraphStyle
    kpi_value: ParagraphStyle
    bullet: ParagraphStyle


def styles() -> Styles:
    body = ParagraphStyle("body", fontName=SANS, fontSize=11.5, leading=16, textColor=INK)
    small = ParagraphStyle("small", parent=body, fontSize=9.5, leading=13, textColor=MUTED)
    return Styles(
        body=body,
        small=small,
        muted=ParagraphStyle(
            "muted", parent=body, fontSize=10.5, leading=14.5, textColor=MUTED, spaceAfter=3
        ),
        h1=ParagraphStyle("h1", parent=body, fontName=SANS_BOLD, fontSize=19, leading=24),
        h2=ParagraphStyle(
            "h2", parent=body, fontName=SANS_BOLD, fontSize=13, leading=17, spaceAfter=6
        ),
        cell=ParagraphStyle("cell", parent=body, fontSize=10.5, leading=13.5),
        cell_num=ParagraphStyle(
            "num", parent=body, fontSize=10.5, leading=13.5, alignment=TA_RIGHT
        ),
        cell_mono=ParagraphStyle("mono", parent=body, fontName=MONO, fontSize=9.5, leading=13),
        kpi_label=ParagraphStyle("kl", parent=small, fontName=SANS_MEDIUM),
        kpi_value=ParagraphStyle("kv", parent=body, fontName=SANS_BOLD, fontSize=16, leading=21),
        bullet=ParagraphStyle("li", parent=body, leftIndent=12, bulletIndent=2),
    )


def markdown(value: str, style: Styles) -> list[Flowable]:
    """Paragraphs, bullet lists, bold and code: the Markdown the notes may use."""
    out: list[Flowable] = []
    paragraph: list[str] = []

    def flush() -> None:
        if paragraph:
            out.append(Paragraph(_inline(" ".join(paragraph)), style.body))
            out.append(Spacer(1, 4))
            paragraph.clear()

    for raw in value.splitlines():
        line = raw.strip()
        if not line:
            flush()
            continue
        bullet = re.match(r"^(?:[-*•]|\d+[.)])\s+(.*)$", line)
        heading = re.match(r"^#{1,6}\s+(.*)$", line)
        if bullet:
            flush()
            out.append(Paragraph(_inline(bullet.group(1)), style.bullet, bulletText="•"))
        elif heading:
            flush()
            out.append(Paragraph(f"<b>{_inline(heading.group(1))}</b>", style.body))
        else:
            paragraph.append(line)
    flush()
    return out


# --- Blocks ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Meta:
    """What mango-api computed for this run (``report_meta``): never the agent's."""

    task: str
    agent: str
    owner: str
    run_id: str
    file: str
    generated_at: datetime
    timezone: str | None
    keep_until: date
    anomaly_id: str | None = None
    anomaly_start: date | None = None
    anomaly_end: date | None = None


def kpis(cells: Sequence[tuple[str, str, str, colors.Color]], style: Styles) -> Table:
    row = [
        [
            Paragraph(text(label), style.kpi_label),
            Paragraph(text(value), ParagraphStyle("v", parent=style.kpi_value, textColor=tone)),
            Paragraph(text(sub), style.small),
        ]
        for label, value, sub, tone in cells
    ]
    table = Table([row], colWidths=[57 * mm] * len(cells))
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), SOFT),
                ("LINEAFTER", (0, 0), (-2, -1), 3, colors.white),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    return table


def bars(
    values: Sequence[Decimal],
    days: Sequence[date],
    *,
    reference: Sequence[Decimal | None] | None = None,
    band: tuple[int, int] | None = None,
    height: float = 62 * mm,
) -> Drawing:
    """Daily bars, a dotted reference and the window of an anomaly, as the design draws."""
    width = 174 * mm
    left, right, top, bottom = 34.0, 4.0, 8.0, 18.0
    inner_w, inner_h = width - left - right, height - top - bottom
    points = [*values, *(r for r in (reference or []) if r is not None)]
    peak = max([Decimal(1), *points])
    step = _nice_step(peak)
    ceiling = (peak / step).to_integral_value(rounding="ROUND_CEILING") * step
    drawing = Drawing(width, height)

    def y(value: Decimal) -> float:
        return bottom + float(max(value, Decimal(0)) / ceiling) * inner_h

    level = Decimal(0)
    while level <= ceiling:
        drawing.add(
            Line(
                left,
                y(level),
                width - right,
                y(level),
                strokeColor=INK if not level else RULE,
                strokeWidth=1 if not level else 0.6,
            )
        )
        drawing.add(
            String(
                left - 4,
                y(level) - 3,
                number(level, 0),
                fontName=SANS,
                fontSize=8,
                fillColor=MUTED,
                textAnchor="end",
            )
        )
        level += step
    count = max(len(values), 1)
    slot = inner_w / count
    if band is not None:
        drawing.add(
            _box(
                left + band[0] * slot, bottom, (band[1] - band[0] + 1) * slot, inner_h, ACCENT_SOFT
            )
        )
    every = max(1, round(count / 6))
    for i, value in enumerate(values):
        inside = band is not None and band[0] <= i <= band[1]
        drawing.add(
            _box(
                left + i * slot + slot * 0.14,
                bottom,
                slot * 0.72,
                y(value) - bottom,
                ACCENT if inside else BAR,
            )
        )
        if i % every == 0:
            drawing.add(
                String(
                    left + i * slot + slot / 2,
                    5,
                    day_month(days[i]),
                    fontName=SANS,
                    fontSize=8,
                    fillColor=MUTED,
                    textAnchor="middle",
                )
            )
    if reference:
        coords: list[float] = []
        for i, ref in enumerate(reference):
            if ref is not None:
                coords += [left + i * slot + slot / 2, y(ref)]
        if len(coords) >= 4:  # noqa: PLR2004 - two points make a line
            drawing.add(
                PolyLine(coords, strokeColor=MUTED, strokeWidth=1.2, strokeDashArray=[4, 3])
            )
    return drawing


def _box(x: float, y: float, width: float, height: float, fill: colors.Color) -> Rect:
    box = Rect(x, y, width, height)
    box.fillColor = fill
    box.strokeColor = None
    return box


def _nice_step(peak: Decimal) -> Decimal:
    raw = peak / 4
    magnitude = Decimal(10) ** (len(str(int(raw))) - 1) if raw >= 1 else Decimal(1)
    for factor in (1, 2, 5, 10):
        if raw <= magnitude * factor:
            return magnitude * factor
    return magnitude * 10


def change_cell(cost: Decimal, previous: Decimal | None, style: Styles) -> Paragraph:
    pct = tr.change(cost, previous)
    if pct is None:
        if previous is None:
            return Paragraph("—", style.cell_num)
        return Paragraph(text(signed_usd(cost - previous)), style.cell_num)
    tone = UP if pct > 0 else (DOWN if pct < 0 else INK)
    return Paragraph(text(percent(pct)), ParagraphStyle("c", parent=style.cell_num, textColor=tone))


class Bar(Flowable):
    """The bar of a table row: its share of the largest row."""

    def __init__(self, share: Decimal, width: float, *, accent: bool = False) -> None:
        super().__init__()
        self.share = float(share)
        self.width = width
        self.height = 6
        self.accent = accent

    def draw(self) -> None:
        canvas = self.canv
        canvas.setFillColor(ACCENT if self.accent else BAR)
        canvas.rect(0, 0, max(self.width * self.share, 0.6), self.height, stroke=0, fill=1)


def cost_table(
    headers: list[str],
    labels: list[list[Paragraph]],
    data: tr.Table,
    style: Styles,
    *,
    widths: list[float],
    other_label: str,
) -> Table:
    num = style.cell_num
    head = [
        Paragraph(f"<b>{text(h)}</b>", num if i >= len(labels[0]) + 1 else style.cell)
        for i, h in enumerate(headers)
    ]
    rows: list[list[Any]] = [head]
    for row, label in zip(data.rows, labels, strict=True):
        rows.append(
            [
                *label,
                Bar(row.share, widths[len(label)] - 6),
                Paragraph(number(row.cost), num),
                Paragraph(number(row.previous) if row.previous is not None else "—", num),
                change_cell(row.cost, row.previous, style),
            ]
        )
    span = len(labels[0]) if labels else 1
    extra: list[tuple[Any, ...]] = []
    if data.others_cost is not None:
        rows.append(
            [
                Paragraph(text(other_label), style.cell),
                *[""] * span,
                Paragraph(number(data.others_cost), num),
                Paragraph(
                    number(data.others_previous) if data.others_previous is not None else "—", num
                ),
                change_cell(data.others_cost, data.others_previous, style),
            ]
        )
        extra.append(("TEXTCOLOR", (0, len(rows) - 1), (-1, len(rows) - 1), MUTED))
        if span > 1:
            extra.append(("SPAN", (0, len(rows) - 1), (span - 1, len(rows) - 1)))
    rows.append(
        [
            Paragraph("<b>Total</b>", style.cell),
            *[""] * span,
            Paragraph(f"<b>{number(data.total)}</b>", num),
            Paragraph(
                f"<b>{number(data.total_previous)}</b>" if data.total_previous is not None else "—",
                num,
            ),
            change_cell(data.total, data.total_previous, style),
        ]
    )
    if span > 1:
        extra.append(("SPAN", (0, len(rows) - 1), (span - 1, len(rows) - 1)))
    table = Table(rows, repeatRows=1, colWidths=widths)
    table.setStyle(
        TableStyle(
            [
                ("LINEBELOW", (0, 0), (-1, 0), 0.8, INK),
                ("LINEBELOW", (0, 1), (-1, -2), 0.4, RULE),
                ("LINEABOVE", (0, -1), (-1, -1), 0.8, INK),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                *extra,
            ]
        )
    )
    return table


def source(tool: str, detail: str, style: Styles) -> Paragraph:
    return Paragraph(
        f'Fuente: <font face="{MONO}">{text(tool)}</font> · {text(detail)}', style.small
    )


def section(title: str, body: list[Flowable], style: Styles) -> list[Flowable]:
    """A heading never alone at the end of a page; tables may still split across pages."""
    return [Spacer(1, 10), CondPageBreak(40 * mm), Paragraph(text(title), style.h2), *body]


def chart_block(legend: str, chart: Drawing, note: Paragraph, style: Styles) -> list[Flowable]:
    """Legend, chart and source never split."""
    return [KeepTogether([Paragraph(legend, style.small), Spacer(1, 2), chart, Spacer(1, 4), note])]


def swatch(color: str, label: str, *, dashed: bool = False) -> str:
    # A square of ZapfDingbats, a standard font of every PDF reader: IBM Plex has none.
    mark = "- - -" if dashed else '<font name="ZapfDingbats">n</font>'
    return f'<font color="{color}">{mark}</font> {text(label)}'


def daily_source(info: dict[str, Any]) -> str:
    if info.get("daily") != "query":
        return "por día · copiada por el agente de sus consultas"
    scope = []
    if info.get("accounts"):
        scope.append("cuentas " + ", ".join(str(a) for a in info["accounts"]))
    if info.get("services"):
        scope.append(", ".join(str(s) for s in info["services"]))
    return " · ".join(["por día", *scope, "tomada de la consulta"])


def about(meta: Meta, *, anomaly: bool, style: Styles) -> list[Flowable]:
    when = generated(meta.generated_at, meta.timezone)
    data = (
        f"<b>De dónde salen los datos.</b> El id y las fechas de la anomalía llegan de AWS a "
        f"Mango. Servicio, cuenta, impacto y causas los leyó el agente {text(meta.agent)} con sus "
        f"consultas, con el acceso de {text(meta.owner)}. Mango calcula las variaciones y las "
        f"partes; el resto de las cifras las copió el agente."
        if anomaly
        else f"<b>De dónde salen los datos.</b> El agente {text(meta.agent)} los leyó de AWS "
        f"con el acceso de {text(meta.owner)} ({text(when)}). Mango arma este documento con una "
        f"plantilla fija, calcula las variaciones, las partes y los totales, y toma la serie "
        f"diaria de la consulta cuando puede; el resto de las cifras las copió el agente."
    )
    keep = short_date(meta.keep_until)
    return [
        Spacer(1, 12),
        Paragraph(data, style.muted),
        Paragraph(
            "<b>Sobre las cifras.</b> Costo en USD, como lo devolvió la consulta. AWS puede "
            "ajustar el costo de los últimos días.",
            style.muted,
        ),
        Paragraph(
            "<b>Quién lo ve.</b> Solo quien creó la tarea puede descargarlo en Mango. Cada "
            "descarga queda en la auditoría de Mango.",
            style.muted,
        ),
        Paragraph(
            f"<b>Hasta cuándo.</b> Mango lo guarda hasta el {keep}, como el resultado de su "
            f'ejecución. Archivo: <font face="{MONO}">{text(meta.file)}</font>',
            style.muted,
        ),
    ]


# --- The two documents ----------------------------------------------------------------------


def period_names(start: date, end: date) -> tuple[str, str]:
    """What the columns and the comparison call both periods: ``septiembre`` and ``agosto``
    for a whole month; otherwise ``periodo`` and ``periodo anterior``."""
    label = period_label(start, end)
    if label[0].isalpha():
        previous = MONTHS[(start.month - 2) % 12]
        return label.split(" ")[0], previous
    return "periodo", "periodo anterior"


def cost_summary(
    data: tr.CostSummaryData, info: dict[str, Any], meta: Meta, style: Styles
) -> tuple[str, list[Flowable]]:
    period = period_label(data.period_start, data.period_end)
    days = (data.period_end - data.period_start).days + 1
    current, before = period_names(data.period_start, data.period_end)
    story: list[Flowable] = [
        Paragraph(text(f"{meta.task} · {period}"), style.h1),
        Spacer(1, 4),
        Paragraph(text(f"{long_range(data.period_start, data.period_end)} · USD"), style.muted),
        Paragraph(
            text(
                f"Generado el {generated(meta.generated_at, meta.timezone)} por {meta.agent} "
                f"para {meta.owner}"
            ),
            style.muted,
        ),
        Spacer(1, 10),
    ]
    average = (data.total / days).quantize(tr.CENT)
    cells: list[tuple[str, str, str, colors.Color]] = [
        ("Total del periodo", usd(data.total), f"{days} días", INK)
    ]
    if data.previous_total is not None:
        delta = data.total - data.previous_total
        pct = tr.change(data.total, data.previous_total)
        tone = UP if delta > 0 else (DOWN if delta < 0 else INK)
        cells.append(
            (
                f"Contra {before}",
                percent(pct) if pct is not None else signed_usd(delta),
                f"{signed_usd(delta)} · {before}: {usd(data.previous_total)}",
                tone,
            )
        )
    else:
        cells.append((f"Contra {before}", "—", "Sin el total anterior", INK))
    if data.forecast is not None:
        cells.append(("Pronóstico de cierre", usd(data.forecast), "con el periodo en curso", INK))
    else:
        sub = (
            f"{before}: {usd((data.previous_total / days).quantize(tr.CENT))}"
            if data.previous_total is not None
            else f"{days} días"
        )
        cells.append(("Promedio diario", usd(average), sub, INK))
    story.append(kpis(cells, style))
    reference: list[Decimal | None] | None = (
        [(data.previous_total / days).quantize(tr.CENT)] * len(data.daily)
        if data.previous_total is not None
        else None
    )
    legend = swatch("#33333a", current)
    if reference:
        legend += "   " + swatch("#5b5b65", f"promedio diario de {before}", dashed=True)
    chart = bars([d.cost for d in data.daily], [d.date for d in data.daily], reference=reference)
    story += section(
        "Costo diario",
        chart_block(legend, chart, source(TOOL_LABEL, daily_source(info), style), style),
        style,
    )
    heads = [current.capitalize(), before.capitalize(), "Cambio"]
    if data.services:
        services = tr.table(
            [(r.service, None, r.cost, r.previous) for r in data.services],
            total=data.total,
            total_previous=data.previous_total,
        )
        table = cost_table(
            ["Servicio", "", *heads],
            [[Paragraph(text(r.label), style.cell)] for r in services.rows],
            services,
            style,
            widths=[58 * mm, 28 * mm, 30 * mm, 30 * mm, 28 * mm],
            other_label=_others(services.others, "servicio", "servicios"),
        )
        story += section(
            "Servicios que más gastan",
            [table, Spacer(1, 4), source(TOOL_LABEL, "por servicio · USD", style)],
            style,
        )
    if data.accounts:
        accounts = tr.table(
            [(r.account_id, r.name, r.cost, r.previous) for r in data.accounts],
            total=data.total,
            total_previous=data.previous_total,
        )
        table = cost_table(
            ["Cuenta", "Nombre", "", *heads],
            [
                [
                    Paragraph(text(r.label), style.cell_mono),
                    Paragraph(text(r.detail or "—"), style.cell),
                ]
                for r in accounts.rows
            ],
            accounts,
            style,
            widths=[30 * mm, 40 * mm, 20 * mm, 29 * mm, 29 * mm, 26 * mm],
            other_label=_others(accounts.others, "cuenta", "cuentas"),
        )
        story += section(
            "Cuentas",
            [table, Spacer(1, 4), source(TOOL_LABEL, "por cuenta vinculada · USD", style)],
            style,
        )
    if data.notes:
        story += section(f"Notas de {meta.agent}", markdown(data.notes, style), style)
    story += about(meta, anomaly=False, style=style)
    return f"Resumen de costos · {period}", story


def _others(count: int, one: str, many: str) -> str:
    if count == 0:
        return "Otros (sin detalle)"
    return f"Otros {count} {one if count == 1 else many}"


def anomaly(
    data: tr.AnomalyData,
    info: dict[str, Any],
    meta: Meta,
    steps: list[dict[str, str]],
    style: Styles,
) -> tuple[str, list[Flowable]]:
    start = meta.anomaly_start or (data.daily[-1].date if data.daily else meta.generated_at.date())
    end = meta.anomaly_end or start
    dates = date_range(start, end)
    title = f"{data.service} · {dates}" if data.service else f"Anomalía · {dates}"
    days = (end - start).days + 1
    story: list[Flowable] = [Paragraph(text(title), style.h1), Spacer(1, 4)]
    if meta.anomaly_id:
        story.append(
            Paragraph(f'Anomalía <font face="{MONO}">{text(meta.anomaly_id)}</font>', style.muted)
        )
    story += [
        Paragraph(
            text(
                f"Tarea «{meta.task}» · generado el {generated(meta.generated_at, 'UTC')} por "
                f"{meta.agent} para {meta.owner}"
            ),
            style.muted,
        ),
        Spacer(1, 10),
    ]
    impact = data.actual - data.expected
    pct = tr.change(data.actual, data.expected)
    story.append(
        kpis(
            [
                (
                    "Impacto",
                    signed_usd(impact),
                    (f"{percent(pct)} sobre lo esperado · " if pct is not None else "")
                    + f"{days} {'día' if days == 1 else 'días'}",
                    UP if impact > 0 else (DOWN if impact < 0 else INK),
                ),
                (
                    "Esperado",
                    usd(data.expected),
                    f"{usd((data.expected / days).quantize(tr.CENT))} por día",
                    INK,
                ),
                (
                    "Real",
                    usd(data.actual),
                    f"{usd((data.actual / days).quantize(tr.CENT))} por día",
                    INK,
                ),
            ],
            style,
        )
    )
    window = [i for i, d in enumerate(data.daily) if start <= d.date <= end]
    expected = [d.expected for d in data.daily]
    chart = bars(
        [d.cost for d in data.daily],
        [d.date for d in data.daily],
        reference=expected,
        band=(window[0], window[-1]) if window else None,
        height=58 * mm,
    )
    legend = swatch("#33333a", "costo") + "   " + swatch("#e2711d", "días de la anomalía")
    if any(e is not None for e in expected):
        legend += "   " + swatch("#5b5b65", "esperado", dashed=True)
    where = f"Costo diario de {data.service}" if data.service else "Costo diario"
    if data.account_name:
        where += f" en {data.account_name}"
    note = source(TOOL_LABEL, daily_source(info), style)
    story += section(where, chart_block(legend, chart, note, style), style)
    if data.causes:
        ordered = sorted(data.causes, key=lambda c: c.impact, reverse=True)[: tr.MAX_ROWS_SHOWN]
        parts = tr.shares([c.impact for c in ordered])
        top = max((c.impact for c in ordered), default=Decimal(0))
        rows: list[list[Any]] = [
            [
                Paragraph(f"<b>{h}</b>", style.cell_num if i >= 4 else style.cell)  # noqa: PLR2004
                for i, h in enumerate(["Tipo de uso", "Servicio", "Cuenta", "", "Impacto", "Parte"])
            ]
        ]
        for cause, part in zip(ordered, parts, strict=True):
            share = (
                (cause.impact / top).quantize(Decimal("0.001"))
                if top > 0 and cause.impact > 0
                else Decimal(0)
            )
            rows.append(
                [
                    Paragraph(text(cause.usage_type), style.cell_mono),
                    Paragraph(text(cause.service), style.cell),
                    Paragraph(text(cause.account_id or "—"), style.cell_mono),
                    Bar(share, 20 * mm, accent=True),
                    Paragraph(number(cause.impact), style.cell_num),
                    Paragraph(f"{part} %", style.cell_num),
                ]
            )
        total = sum((c.impact for c in ordered), Decimal(0))
        rows.append(
            [
                Paragraph("<b>Total</b>", style.cell),
                "",
                "",
                "",
                Paragraph(f"<b>{number(total)}</b>", style.cell_num),
                Paragraph("<b>100 %</b>", style.cell_num),
            ]
        )
        table = Table(
            rows, repeatRows=1, colWidths=[52 * mm, 30 * mm, 30 * mm, 22 * mm, 22 * mm, 18 * mm]
        )
        table.setStyle(
            TableStyle(
                [
                    ("LINEBELOW", (0, 0), (-1, 0), 0.8, INK),
                    ("LINEBELOW", (0, 1), (-1, -2), 0.4, RULE),
                    ("LINEABOVE", (0, -1), (-1, -1), 0.8, INK),
                    ("SPAN", (0, -1), (3, -1)),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ]
            )
        )
        story += section(
            "Qué la explica",
            [table, Spacer(1, 4), source(TOOL_LABEL, "por tipo de uso · USD", style)],
            style,
        )
    conclusion = markdown(data.conclusion, style) if data.conclusion else []
    if data.next_step:
        box = Table(
            [[Paragraph(f"<b>Siguiente paso</b><br/>{_inline(data.next_step)}", style.body)]],
            colWidths=[174 * mm],
        )
        box.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), ACCENT_SOFT),
                    ("LINEBEFORE", (0, 0), (0, -1), 2.5, ACCENT),
                    ("TOPPADDING", (0, 0), (-1, -1), 7),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ]
            )
        )
        conclusion += [Spacer(1, 6), box]
    if conclusion:
        story += section(f"Conclusión de {meta.agent}", conclusion, style)
    if steps:
        items: list[Flowable] = []
        for index, step in enumerate(steps, start=1):
            tool = (
                f' <font face="{MONO}" color="#5b5b65">{text(step["tool"])}</font>'
                if step.get("tool")
                else ""
            )
            items.append(
                Paragraph(
                    f"{text(step.get('text', ''))}{tool}", style.bullet, bulletText=f"{index}."
                )
            )
        story += section("Consultas del agente", items, style)
    story += about(meta, anomaly=True, style=style)
    return f"Investigación de anomalía · {title}", story


# --- The PDF --------------------------------------------------------------------------------


@dataclass(frozen=True)
class Pdf:
    content: bytes
    pages: int


class _Numbered(Canvas):
    """Draws «Página n de N» once the number of pages is known."""

    header = ""
    footer = ""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._pages: list[dict[str, Any]] = []

    def showPage(self) -> None:  # noqa: N802 - ReportLab's name
        self._pages.append(dict(self.__dict__))
        getattr(self, "_startPage")()  # noqa: B009 - ReportLab has no public name for it

    def save(self) -> None:
        total = len(self._pages)
        for state in self._pages:
            self.__dict__.update(state)
            self._decorate(total)
            super().showPage()
        super().save()

    def _decorate(self, total: int) -> None:
        width, height = A4
        self.setFont(SANS_BOLD, 9.5)
        self.setFillColor(INK)
        self.drawString(18 * mm, height - 14 * mm, "Mango")
        self.setFont(SANS, 9.5)
        self.setFillColor(MUTED)
        self.drawString(
            18 * mm + self.stringWidth("Mango ", SANS_BOLD, 9.5),
            height - 14 * mm,
            f"· {self.header}"[:110],
        )
        self.drawRightString(width - 18 * mm, height - 14 * mm, "Uso interno")
        self.setStrokeColor(RULE)
        self.line(18 * mm, height - 16.5 * mm, width - 18 * mm, height - 16.5 * mm)
        self.line(18 * mm, 15 * mm, width - 18 * mm, 15 * mm)
        self.drawString(18 * mm, 10 * mm, self.footer[:120])
        self.drawRightString(width - 18 * mm, 10 * mm, f"Página {self.getPageNumber()} de {total}")


def render(
    report_type: str,
    data: tr.CostSummaryData | tr.AnomalyData,
    info: dict[str, Any],
    meta: Meta,
    steps: list[dict[str, str]] | None = None,
) -> Pdf:
    """The PDF of a run. ``RenderError`` if it cannot be drawn or exceeds its page limit."""
    _register_fonts()
    style = styles()
    if report_type == "cost_summary" and isinstance(data, tr.CostSummaryData):
        header, story = cost_summary(data, info, meta, style)
    elif report_type == "anomaly" and isinstance(data, tr.AnomalyData):
        header, story = anomaly(data, info, meta, steps or [], style)
    else:
        raise RenderError("unknown report")
    buffer = io.BytesIO()
    doc = BaseDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=22 * mm,
        bottomMargin=20 * mm,
        title=f"{meta.task} · {tr.TYPE_NAMES[report_type]}",
        author="Mango",
        creator="Mango",
        subject=tr.TYPE_NAMES[report_type],
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="body")
    doc.addPageTemplates([PageTemplate(id="page", frames=[frame])])

    class Page(_Numbered):
        pass

    Page.header = header
    Page.footer = f"Mango · {meta.task} · ejecución {meta.run_id[:8]}"
    try:
        doc.build(story, canvasmaker=Page)
    except Exception as exc:
        raise RenderError("the PDF could not be drawn") from exc
    pages = doc.page
    if pages > tr.MAX_PAGES:
        raise RenderError("too many pages")
    return Pdf(content=buffer.getvalue(), pages=pages)
