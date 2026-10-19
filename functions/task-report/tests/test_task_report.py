"""The function that draws a run's PDF (D86, D87): what it reads, writes and refuses."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import boto3
import pytest
from moto import mock_aws

from mango_core import task_reports as tr
from mango_task_report import handler as h
from mango_task_report import render as r

TABLE, BUCKET, KEY = (
    "Mango-test-Tasks",
    "mango-test-reports",
    "arn:aws:kms:us-east-1:111122223333:key/k",
)
TASK, RUN = "a" * 32, "b" * 32
RUN_SK = f"RUN#{'1' * 13}#{RUN}"
FILE = "cierre-2026-10-01-0800.pdf"
SUMMARY = {
    "period_start": "2026-09-01",
    "period_end": "2026-09-03",
    "total": 300,
    "previous_total": 250,
    "daily": [{"date": f"2026-09-0{d}", "cost": 100} for d in (1, 2, 3)],
    "services": [{"service": "Amazon EC2", "cost": 200, "previous": 150}],
    "accounts": [{"account_id": "111122223333", "name": "produccion", "cost": 300}],
    "notes": '**EC2** <img src="/etc/passwd"/> <a href="javascript:x">y</a>',
}
META = {
    "task": "Cierre",
    "agent": "FinOps",
    "owner": "nombre@empresa.com",
    "owner_id": "sub-1",
    "file": FILE,
    "generated_at": "2026-10-01T14:00:00+00:00",
    "timezone": "America/Mexico_City",
    "keep_until": "2026-12-30",
}


def _doc(data: dict[str, Any] = SUMMARY) -> str:
    return json.dumps(tr.build("cost_summary", tr.parse("cost_summary", data), []))


@pytest.fixture
def aws() -> Iterator[tuple[Any, Any]]:
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        db.create_table(
            TableName=TABLE,
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=BUCKET)
        yield db, s3


def _put(db: Any, **attrs: str) -> None:
    item = {
        "PK": {"S": f"AUTO#{TASK}"},
        "SK": {"S": RUN_SK},
        "run_id": {"S": RUN},
        "result": {"S": "the result is never read"},
        "report_status": {"S": "generating"},
        "report_meta": {"S": json.dumps(META)},
        "report_data": {"S": _doc()},
    }
    item.update({k: {"S": v} for k, v in attrs.items()})
    db.put_item(TableName=TABLE, Item=item)


def _item(db: Any) -> dict[str, Any]:
    key = {"PK": {"S": f"AUTO#{TASK}"}, "SK": {"S": RUN_SK}}
    return dict(db.get_item(TableName=TABLE, Key=key)["Item"])


def _reports(db: Any, s3: Any) -> h.Reports:
    return h.Reports(db, s3, table=TABLE, bucket=BUCKET, key_arn=KEY)


EVENT = {"task_id": TASK, "run_id": RUN, "run_sk": RUN_SK}


def test_draws_the_pdf_under_its_owner_and_marks_it_ready(aws: tuple[Any, Any]) -> None:
    db, s3 = aws
    _put(db)
    assert _reports(db, s3).handle(EVENT) == "ready"
    item = _item(db)
    assert item["report_status"] == {"S": "ready"}
    assert int(item["report_pages"]["N"]) >= 1
    obj = s3.get_object(Bucket=BUCKET, Key=f"owner/sub-1/{TASK}/{RUN}/{FILE}")
    body = obj["Body"].read()
    assert body.startswith(b"%PDF")
    assert int(item["report_bytes"]["N"]) == len(body)
    assert obj["ContentType"] == "application/pdf"


@pytest.mark.parametrize(
    "event",
    [{}, {**EVENT, "run_sk": "x"}, {**EVENT, "key": "owner/x"}, {**EVENT, "run_id": "c" * 32}],
)
def test_an_unexpected_event_is_rejected(aws: tuple[Any, Any], event: dict[str, Any]) -> None:
    db, s3 = aws
    _put(db)
    assert _reports(db, s3).handle(event) == "rejected"
    assert _item(db)["report_status"] == {"S": "generating"}


def test_a_report_not_generating_is_left_alone(aws: tuple[Any, Any]) -> None:
    db, s3 = aws
    _put(db, report_status="ready")
    assert _reports(db, s3).handle(EVENT) == "skipped"
    assert "Contents" not in s3.list_objects_v2(Bucket=BUCKET)


@pytest.mark.parametrize(
    "attrs",
    [
        {"report_data": json.dumps({"type": "cost_summary", "data": {**SUMMARY, "total": "x"}})},
        {"report_meta": json.dumps({**META, "file": "../../x.pdf"})},
        {"report_meta": json.dumps({**META, "owner_id": "../other"})},
        {"report_meta": "not json"},
    ],
)
def test_data_that_does_not_validate_fails_with_data(
    aws: tuple[Any, Any], attrs: dict[str, str]
) -> None:
    db, s3 = aws
    _put(db, **attrs)
    assert _reports(db, s3).handle(EVENT) == "failed:data"
    assert _item(db)["report_reason"] == {"S": "data"}
    assert "Contents" not in s3.list_objects_v2(Bucket=BUCKET)


def test_a_pdf_over_the_limit_fails_with_size(
    aws: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    db, s3 = aws
    _put(db)
    monkeypatch.setattr(tr, "MAX_PDF_BYTES", 10)
    assert _reports(db, s3).handle(EVENT) == "failed:size"
    assert "Contents" not in s3.list_objects_v2(Bucket=BUCKET)


def test_a_drawing_error_fails_with_render(
    aws: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    db, s3 = aws
    _put(db)

    def broken(*_args: Any, **_kwargs: Any) -> r.Pdf:
        raise r.RenderError("x")

    monkeypatch.setattr(h, "render", broken)
    assert _reports(db, s3).handle(EVENT) == "failed:render"


def _meta(**changes: Any) -> r.Meta:
    base: dict[str, Any] = {
        "task": "Cierre",
        "agent": "FinOps",
        "owner": "nombre@empresa.com",
        "run_id": RUN,
        "file": FILE,
        "generated_at": datetime(2026, 10, 1, 14, tzinfo=UTC),
        "timezone": "America/Mexico_City",
        "keep_until": date(2026, 12, 30),
    }
    return r.Meta(**{**base, **changes})


def test_markup_of_the_model_is_escaped_never_interpreted() -> None:
    kind, data, info = tr.load(_doc())
    assert r.text('<img src="/etc/passwd"/>') == '&lt;img src="/etc/passwd"/&gt;'
    paragraphs = r.markdown('**a** <img src="x"/> `c` [l](http://x)', r.styles())
    assert len(paragraphs) == 2  # the paragraph and its spacing
    markup = r._inline('**a** <img src="x"/> `c`')
    assert "<img" not in markup
    assert "<b>a</b>" in markup
    pdf = r.render(kind, data, info, _meta())
    assert pdf.content.startswith(b"%PDF")


def test_anomaly_document_with_steps() -> None:
    anomaly = {
        "expected": 640,
        "actual": 1052.3,
        "service": "Amazon EC2",
        "daily": [
            {"date": "2026-10-14", "cost": 320, "expected": 320},
            {"date": "2026-10-15", "cost": 526},
        ],
        "causes": [{"usage_type": "BoxUsage", "service": "Amazon EC2", "impact": 351.8}],
        "conclusion": "Capacidad nueva.",
        "next_step": "Confirmar.",
    }
    doc = json.dumps(tr.build("anomaly", tr.parse("anomaly", anomaly), []))
    kind, data, info = tr.load(doc)
    pdf = r.render(
        kind,
        data,
        info,
        _meta(
            anomaly_id="8d09e1c2-4b5d-4e8f-9a01-8d092b3c4d5e",
            anomaly_start=date(2026, 10, 15),
            anomaly_end=date(2026, 10, 15),
            timezone=None,
        ),
        [{"text": "Busco la anomalía <b>", "tool": "get_anomalies"}],
    )
    assert pdf.pages >= 1


def test_too_many_pages_is_a_render_error(monkeypatch: pytest.MonkeyPatch) -> None:
    kind, data, info = tr.load(_doc())
    monkeypatch.setattr(tr, "MAX_PAGES", 0)
    with pytest.raises(r.RenderError):
        r.render(kind, data, info, _meta())


@pytest.mark.parametrize(
    ("start", "end", "label"),
    [
        (date(2026, 9, 1), date(2026, 9, 30), "septiembre 2026"),
        (date(2026, 12, 1), date(2026, 12, 31), "diciembre 2026"),
        (date(2026, 9, 1), date(2026, 9, 15), f"1{r.EN_DASH}15 sep 2026"),
        (date(2026, 9, 30), date(2026, 10, 2), f"30 sep{r.EN_DASH}2 oct 2026"),
        (date(2026, 10, 15), date(2026, 10, 15), "15 oct 2026"),
    ],
)
def test_period_labels(start: date, end: date, label: str) -> None:
    assert r.period_label(start, end) == label


def test_number_formats() -> None:
    assert r.number(Decimal("84312.4")) == "84.312,40"
    assert r.usd(Decimal("-5")) == f"{r.MINUS}USD 5,00"
    assert r.percent(Decimal("5.5")) == "+5,5 %"
    assert r.period_names(date(2026, 1, 1), date(2026, 1, 31)) == ("enero", "diciembre")
