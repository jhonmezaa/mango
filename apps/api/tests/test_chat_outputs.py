"""Charts and tables of a code cell (D118, G1 and T1): the closed spec, its tolerant parsing and
the route that reads, validates and checks a spec file before the chat draws it."""

from __future__ import annotations

import json
import math
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any

import pytest

from mango_api.chat_files import RETENTION_SECONDS
from mango_api.chat_outputs import (
    MAX_GUARD_CHARS,
    MAX_ROWS,
    MAX_SERIES,
    TABLE_SHOWN_ROWS,
    ChartSpecOut,
    ChatOutputOut,
    ChatTableOut,
    parse_chart,
    parse_table,
    texts,
)
from mango_core import chat_files as core

from .test_app import FakeAuthorizer
from .test_chat_files import BUCKET, CONVERSATION, SUB, TABLE, Env, _code, _env, _events, _h

BARS = {
    "chartType": "bar",
    "xKey": "mes",
    "series": [{"key": "EC2", "label": "EC2"}, {"key": "S3"}],
    "meta": {"title": "Costo mensual por servicio", "subtitle": "may - oct 2026 · USD"},
    "axes": {"y": {"label": "USD"}},
    "data": [{"mes": "may", "EC2": 41200, "S3": 12800}, {"mes": "jun", "EC2": 42900, "S3": 13100}],
}


def _chart(raw: object) -> ChartSpecOut:
    chart = parse_chart(raw)
    assert chart is not None
    return chart


# --- The spec -----------------------------------------------------------------------------


def test_a_full_spec_is_kept_and_every_default_filled_in() -> None:
    chart = _chart(BARS)
    assert chart.chartType == "bar"
    assert chart.xKey == "mes"
    assert [(s.key, s.label, s.valueFormat) for s in chart.series] == [
        ("EC2", "EC2", "compact"),
        ("S3", "S3", "compact"),
    ]
    assert (chart.meta.title, chart.meta.subtitle) == (
        "Costo mensual por servicio",
        "may - oct 2026 · USD",
    )
    assert chart.axes.y.label == "USD"
    assert chart.axes.x.label is None
    assert chart.layout == "horizontal"


def test_without_x_nor_series_it_takes_the_first_text_and_the_first_number() -> None:
    chart = _chart({"chartType": "line", "data": [{"v": 3, "mes": "may", "n": 1}]})
    assert chart.xKey == "mes"
    assert [s.key for s in chart.series] == ["v"]


def test_unknown_fields_are_ignored_and_invalid_ones_fall_back() -> None:
    chart = _chart(
        {
            **BARS,
            "html": "<script>alert(1)</script>",
            "valueFormat": "currency",
            "layout": "diagonal",
            "meta": {"title": "  ", "description": "del formato que copia"},
            "series": [{"dataKey": "EC2", "valueFormat": 7}, {"key": ""}, "S3", None],
        }
    )
    assert chart.valueFormat == "compact"
    assert chart.layout == "horizontal"
    assert chart.meta.title is None
    assert chart.meta.subtitle == "del formato que copia"
    assert [s.key for s in chart.series] == ["EC2"]
    assert "html" not in chart.model_dump()


def test_the_axes_of_the_format_it_copies_are_read_too() -> None:
    chart = _chart({**BARS, "axes": [{"dimension": "x", "label": "Mes"}], "yAxisLabel": "USD"})
    assert (chart.axes.x.label, chart.axes.y.label) == ("Mes", "USD")


def test_only_plain_values_reach_the_chat() -> None:
    chart = _chart(
        {
            "chartType": "scatter",
            "xKey": "cpu",
            "data": [
                {"cpu": 4, "costo": math.inf, "nota": {"a": 1}, "ok": True, "id": "x" * 500},
                {"cpu": math.nan, "costo": 2.5},
                "not a row",
                {},
            ],
        }
    )
    first, second = chart.data
    assert first == {"cpu": 4, "costo": None, "nota": None, "ok": True, "id": "x" * 200}
    assert second == {"cpu": None, "costo": 2.5}


def test_vertical_layout_is_only_for_bars() -> None:
    assert _chart({**BARS, "layout": "vertical"}).layout == "vertical"
    assert _chart({**BARS, "chartType": "line", "layout": "vertical"}).layout == "horizontal"


@pytest.mark.parametrize(
    "raw",
    [
        None,
        "bar",
        [],
        {"data": BARS["data"]},
        {**BARS, "chartType": "radar"},
        {**BARS, "data": []},
        {**BARS, "data": [1, 2]},
        {**BARS, "data": [{"mes": "may"}] * (MAX_ROWS + 1)},
        {**BARS, "series": [{"key": f"s{i}"} for i in range(MAX_SERIES + 1)]},
    ],
)
def test_what_cannot_be_drawn_is_refused(raw: object) -> None:
    assert parse_chart(raw) is None


def test_the_limits_themselves_still_draw() -> None:
    rows = [{"x": str(i), **{f"s{j}": j for j in range(MAX_SERIES)}} for i in range(MAX_ROWS)]
    chart = _chart(
        {"chartType": "bar", "data": rows, "series": [{"key": f"s{j}"} for j in range(20)]}
    )
    assert (len(chart.data), len(chart.series)) == (MAX_ROWS, MAX_SERIES)


def test_a_table_shows_its_first_rows_as_long_as_its_columns() -> None:
    table = parse_table(
        {
            "name": "costo_por_cuenta",
            "columns": ["cuenta", "costo_usd"],
            "rows": [["111122223333", 10.5, "extra"], ["cuenta-b"]]
            + [["c", i] for i in range(300)],
            "total_rows": 12_480,
            "csv": "costo_por_cuenta.csv",
        }
    )
    assert table is not None
    assert len(table.rows) == TABLE_SHOWN_ROWS
    assert table.rows[0] == ["111122223333", 10.5]
    assert table.rows[1] == ["cuenta-b", None]
    assert table.total_rows == 12_480
    assert table.csv == "costo_por_cuenta.csv"


@pytest.mark.parametrize("csv", ["../x.csv", "a/b.csv", "x.xlsx", 3, "x" * 200 + ".csv"])
def test_a_table_only_names_a_csv_of_its_own_cell(csv: object) -> None:
    table = parse_table({"columns": ["a"], "rows": [], "csv": csv})
    assert table is not None
    assert table.csv is None
    assert table.name == "table"


@pytest.mark.parametrize(
    "raw",
    [None, {"rows": []}, {"columns": [], "rows": []}, {"columns": ["a"], "rows": "x"}],
)
def test_a_table_without_columns_is_refused(raw: object) -> None:
    assert parse_table(raw) is None


def test_the_guardrail_reads_every_text_shown_once() -> None:
    shown = ChatOutputOut(kind="chart", chart=_chart({**BARS, "meta": {"title": "may"}}))
    assert sorted(texts(shown) or []) == ["EC2", "S3", "USD", "jun", "may", "mes"]
    table = parse_table({"name": "t", "columns": ["a"], "rows": [["x" * 1000]] * 200})
    assert table is not None
    assert texts(ChatOutputOut(kind="table", table=table)) == ["t", "a", "x" * 1000]
    huge = ChatOutputOut(
        kind="chart",
        chart=_chart({"chartType": "bar", "data": [{"x": f"{i}" + "y" * 199} for i in range(600)]}),
    )
    assert sum(len(r["x"]) for r in huge.chart.data) > MAX_GUARD_CHARS  # type: ignore[union-attr,arg-type]
    assert texts(huge) is None


# --- The route ----------------------------------------------------------------------------


@dataclass
class Guard:
    """``code_blocks.Guardrail.blocks_texts``: intervenes when a text has ``word``."""

    word: str = "forbidden"
    fails: bool = False
    calls: list[list[str]] = field(default_factory=list)

    def blocks_texts(self, shown: Iterable[str]) -> bool:
        call = list(shown)
        self.calls.append(call)
        return self.fails or any(self.word in t for t in call)


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for e in _env(FakeAuthorizer(), monkeypatch):
        e.deps.guardrail = Guard()  # type: ignore[assignment]
        yield e


def _spec(
    env: Env,
    body: bytes | dict[str, Any],
    *,
    name: str = "costo.chart.json",
    status: str = "ready",
    file_id: str = "01" + "B" * 24,
) -> str:
    """A spec a cell wrote, as the code connector records it."""
    data = body if isinstance(body, bytes) else json.dumps(body).encode()
    env.s3.put_object(Bucket=BUCKET, Key=core.owner_key(SUB, CONVERSATION, file_id), Body=data)
    now = int(env.clock.now)
    env.db.put_item(
        TableName=TABLE,
        Item={
            "PK": {"S": f"USER#{SUB}"},
            "SK": {"S": f"CFILE#{CONVERSATION}#{file_id}"},
            "file_id": {"S": file_id},
            "conversation_id": {"S": CONVERSATION},
            "origin": {"S": "generated"},
            "name": {"S": name},
            "kind": {"S": "json"},
            "size": {"N": str(len(data))},
            "status": {"S": status},
            "status_at": {"N": str(now)},
            "created_at": {"N": str(now)},
            "expires_at": {"N": str(now + RETENTION_SECONDS)},
            "sha256": {"S": "0" * 64},
        },
    )
    return file_id


def _output(env: Env, file_id: str, token: str = "good") -> Any:
    return env.client.get(
        f"/api/conversations/{CONVERSATION}/files/{file_id}/output", headers=_h(token)
    )


def _guard(env: Env) -> Guard:
    guard = env.deps.guardrail
    assert isinstance(guard, Guard)
    return guard


def test_a_chart_is_read_validated_and_checked_once(env: Env) -> None:
    file_id = _spec(env, {**BARS, "script": "<b>x</b>"})
    response = _output(env, file_id)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["kind"] == "chart"
    assert body["table"] is None
    assert body["chart"] == ChartSpecOut.model_validate(body["chart"]).model_dump(mode="json")
    assert "script" not in body["chart"]
    assert _output(env, file_id).status_code == 200
    # The verdict is kept on the file's record: the guardrail was asked once.
    assert len(_guard(env).calls) == 1
    [first, _again] = _events(env, "chat.file_download", "applied")
    assert (first["inline"], first["kind"], first["file_id"]) == (True, "json", file_id)


def test_a_table_comes_with_its_first_rows(env: Env) -> None:
    file_id = _spec(
        env,
        {
            "name": "costo_por_cuenta",
            "columns": ["a"],
            "rows": [[i] for i in range(250)],
            "total_rows": 250,
            "csv": "costo_por_cuenta.csv",
        },
        name="costo_por_cuenta.table.json",
    )
    body = _output(env, file_id).json()
    table = ChatTableOut.model_validate(body["table"])
    assert (body["kind"], len(table.rows), table.total_rows) == ("table", 200, 250)


@pytest.mark.parametrize(
    "body",
    [b"{not json", b"[1, 2]", json.dumps({"chartType": "radar", "data": [{"a": 1}]}).encode()],
)
def test_a_spec_that_cannot_be_drawn_says_so(env: Env, body: bytes) -> None:
    response = _output(env, _spec(env, body))
    assert (response.status_code, _code(response)) == (422, "invalid_output")
    assert _guard(env).calls == []


def test_a_spec_over_two_megabytes_is_not_read_whole(env: Env) -> None:
    file_id = _spec(env, b'{"chartType": "bar", "x": "' + b"y" * (2 * 1024 * 1024) + b'"}')
    assert _code(_output(env, file_id)) == "invalid_output"


def test_what_the_guardrail_does_not_allow_is_not_shown(env: Env) -> None:
    file_id = _spec(env, {**BARS, "meta": {"title": "forbidden title"}})
    response = _output(env, file_id)
    assert (response.status_code, _code(response)) == (409, "output_withheld")
    assert "forbidden" not in response.text
    # Not kept: asked again, it says the same.
    assert _code(_output(env, file_id)) == "output_withheld"
    assert len(_guard(env).calls) == 2


def test_a_guardrail_that_cannot_answer_shows_nothing_and_keeps_nothing(env: Env) -> None:
    _guard(env).fails = True
    file_id = _spec(env, BARS)
    assert _code(_output(env, file_id)) == "output_withheld"
    _guard(env).fails = False
    assert _output(env, file_id).status_code == 200


def test_without_a_guardrail_no_chart_is_shown(env: Env) -> None:
    env.deps.guardrail = None
    assert _code(_output(env, _spec(env, BARS))) == "output_withheld"


def test_a_spec_waits_for_its_scan_like_any_generated_file(env: Env) -> None:
    file_id = _spec(env, BARS, status="verifying")
    assert _code(_output(env, file_id)) == "file_not_ready"
    env.scanned(core.owner_key(SUB, CONVERSATION, file_id))
    assert _output(env, file_id).status_code == 200


def test_a_spec_the_scan_blocked_is_never_read(env: Env) -> None:
    file_id = _spec(env, BARS, status="verifying")
    env.scanned(core.owner_key(SUB, CONVERSATION, file_id), "THREATS_FOUND")
    assert _code(_output(env, file_id)) == "file_blocked"
    assert _events(env, "chat.file_download") == []


@pytest.mark.parametrize(("name", "kind"), [("datos.json", "json"), ("x.chart.json", "csv")])
def test_only_the_specs_of_a_cell_are_drawn(env: Env, name: str, kind: str) -> None:
    file_id = _spec(env, BARS, name=name)
    if kind != "json":
        env.db.update_item(
            TableName=TABLE,
            Key={"PK": {"S": f"USER#{SUB}"}, "SK": {"S": f"CFILE#{CONVERSATION}#{file_id}"}},
            UpdateExpression="SET kind = :k",
            ExpressionAttributeValues={":k": {"S": kind}},
        )
    response = _output(env, file_id)
    assert (response.status_code, _code(response)) == (415, "not_an_output")


def test_someone_elses_spec_answers_like_one_that_does_not_exist(env: Env) -> None:
    file_id = _spec(env, BARS)
    assert _output(env, file_id, token="admin").status_code == 404
    assert _output(env, "0" * 26).status_code == 404


def test_reserved_keys_never_reach_the_spa() -> None:
    chart = _chart(
        {
            "chartType": "bar",
            "xKey": "__proto__",
            "series": [{"key": "constructor"}, {"key": "v"}],
            "data": [{"__proto__": "x", "prototype": 1, "mes": "may", "v": 2}],
        }
    )
    assert chart.data == [{"mes": "may", "v": 2}]
    assert chart.xKey == "mes"
    assert [s.key for s in chart.series] == ["v"]
