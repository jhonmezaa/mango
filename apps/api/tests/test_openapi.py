"""The OpenAPI document the TypeScript client is generated from (D6, D38)."""

from pathlib import Path

from fastapi.testclient import TestClient

from mango_api.openapi import API_PREFIX, _fastapi_app, build_openapi, dumps_openapi, main

COMMITTED = Path(__file__).parents[3] / "packages" / "ts" / "api-client" / "openapi.json"
METHODS = {"get", "put", "post", "delete", "patch"}


def _operations() -> list[tuple[str, str, dict[str, object]]]:
    return [
        (path, method, operation)
        for path, item in build_openapi()["paths"].items()
        for method, operation in item.items()
        if method in METHODS
    ]


def test_committed_document_matches_the_app() -> None:
    # A route or model changed: run `mise run api-client` and commit the result.
    assert COMMITTED.read_text(encoding="utf-8") == dumps_openapi(build_openapi())


def test_paths_are_relative_to_the_api_prefix() -> None:
    document = build_openapi()
    assert document["servers"] == [{"url": API_PREFIX}]
    assert all(not path.startswith(API_PREFIX) for path in document["paths"])
    assert {"/me", "/chat", "/admin/budgets", "/groups"} <= set(document["paths"])


def test_operation_ids_are_unique_route_names() -> None:
    ids = [str(operation["operationId"]) for _, _, operation in _operations()]
    assert len(ids) == len(set(ids))
    assert {"me", "get_agent", "list_groups", "approve_change"} <= set(ids)
    assert all(name.isidentifier() and name == name.lower() for name in ids)


def test_errors_use_the_api_envelope() -> None:
    document = build_openapi()
    schemas = document["components"]["schemas"]
    assert "HTTPValidationError" not in schemas
    assert schemas["ErrorBody"]["required"] == ["error"]
    for _, _, operation in _operations():
        responses = operation["responses"]
        assert isinstance(responses, dict)
        assert "422" not in responses
        assert responses["default"]["content"]["application/json"]["schema"] == {
            "$ref": "#/components/schemas/ErrorBody"
        }


def test_main_writes_the_document(tmp_path: Path) -> None:
    target = tmp_path / "openapi.json"
    assert main([str(target)]) == 0
    assert target.read_text(encoding="utf-8") == dumps_openapi(build_openapi())
    assert main([]) == 2


def test_the_document_is_not_served_at_runtime() -> None:
    # FASTAPI-OPENAPI-001: exporting it at build time must not turn the endpoints on.
    client = TestClient(_fastapi_app())
    for path in ("/openapi.json", "/docs", "/redoc", "/api/openapi.json", "/api/docs"):
        assert client.get(path).status_code == 404
