"""The writer of the SPA origin to the UI sandbox's key value store (D123 (2), TM-UI11)."""

from __future__ import annotations

from typing import Any

import pytest

from mango_ui_sandbox_origin import handler

ARN = "arn:aws:cloudfront::111122223333:key-value-store/0f3c2c4e-1111-2222-3333-444455556666"


def event(kind: str = "Create", **properties: str) -> dict[str, Any]:
    props = {"KeyValueStoreArn": ARN, "Key": "spa_origin", "Value": "https://d123.cloudfront.net"}
    props.update(properties)
    return {
        "RequestType": kind,
        "ResourceProperties": props,
        "StackId": "stack",
        "RequestId": "request",
        "LogicalResourceId": "Origin",
        "ResponseURL": "https://example.com/response",
    }


class FakeStore:
    def __init__(self, fail: bool = False) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.fail = fail

    def describe_key_value_store(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("describe", kwargs))
        return {"ETag": "E1"}

    def put_key(self, **kwargs: Any) -> dict[str, Any]:
        if self.fail:
            raise RuntimeError("boom")
        self.calls.append(("put", kwargs))
        return {"ETag": "E2"}


def test_writes_the_origin_with_the_current_etag() -> None:
    store = FakeStore()
    assert handler.handle(event(), lambda: store) == ("SUCCESS", "")
    assert store.calls == [
        ("describe", {"KvsARN": ARN}),
        (
            "put",
            {
                "KvsARN": ARN,
                "Key": "spa_origin",
                "Value": "https://d123.cloudfront.net",
                "IfMatch": "E1",
            },
        ),
    ]


def test_update_writes_again() -> None:
    store = FakeStore()
    assert (
        handler.handle(event("Update", Value="https://app.example.com"), lambda: store)[0]
        == "SUCCESS"
    )
    assert store.calls[-1][1]["Value"] == "https://app.example.com"


def test_delete_writes_nothing() -> None:
    store = FakeStore()
    assert handler.handle(event("Delete"), lambda: store)[0] == "SUCCESS"
    assert store.calls == []


@pytest.mark.parametrize(
    "value",
    [
        "http://d123.cloudfront.net",
        "https://d123.cloudfront.net/",
        "https://d123.cloudfront.net:443",
        "https://*.cloudfront.net",
        "https://d123.cloudfront.net; script-src *",
        "https://d123.cloudfront.net 'unsafe-inline'",
        "'none'",
        "https://localhost",
        "https://D123.cloudfront.net",
        "",
    ],
)
def test_refuses_anything_but_an_exact_https_origin(value: str) -> None:
    store = FakeStore()
    status, reason = handler.handle(event(Value=value), lambda: store)
    assert status == "FAILED"
    assert "origin" in reason
    assert store.calls == []


def test_refuses_another_key_or_store() -> None:
    store = FakeStore()
    assert handler.handle(event(Key="other"), lambda: store)[0] == "FAILED"
    assert (
        handler.handle(event(KeyValueStoreArn="arn:aws:s3:::bucket"), lambda: store)[0] == "FAILED"
    )
    assert store.calls == []


def test_a_failed_write_fails_the_resource() -> None:
    status, reason = handler.handle(event(), lambda: FakeStore(fail=True))
    assert status == "FAILED"
    assert "RuntimeError" in reason


def test_lambda_handler_always_answers(monkeypatch: pytest.MonkeyPatch) -> None:
    answers: list[tuple[str, str]] = []
    monkeypatch.setattr(
        handler, "respond", lambda _e, status, reason="": answers.append((status, reason))
    )

    def explode(_event: Any) -> tuple[str, str]:
        raise KeyError("x")

    monkeypatch.setattr(handler, "handle", explode)
    handler.lambda_handler(event(), None)
    assert answers == [("FAILED", "unexpected error (KeyError)")]


def test_respond_only_to_https() -> None:
    with pytest.raises(ValueError, match="ResponseURL"):
        handler.respond({**event(), "ResponseURL": "http://example.com"}, "SUCCESS")
