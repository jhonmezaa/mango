"""OpenAPI document of mango-api, exported at build time for the generated TypeScript client.

``python -m mango_api.openapi <file>`` writes the document that ``packages/ts/api-client`` is
generated from (``mise run api-client``). Nothing is served at runtime: the app keeps
``openapi_url=None`` (FASTAPI-OPENAPI-001). No AWS client is created: the services are stubs,
because only the routes and their models are read.

The document FastAPI produces is adjusted so that it describes what the API really does:

* paths are relative to ``/api`` (the SPA gets that prefix from its runtime configuration);
* ``operationId`` is the route function name, which must be unique;
* FastAPI's default 422 body is replaced by the error envelope of ``mango_api.web``, which is
  what the exception handlers of the app return for every error.
"""

from __future__ import annotations

import dataclasses
import json
import re
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

from fastapi import FastAPI

from mango_api import app as app_module
from mango_api.settings import Settings

API_PREFIX = "/api"
_METHODS = frozenset({"get", "put", "post", "delete", "patch"})
_FASTAPI_VALIDATION_SCHEMAS = ("HTTPValidationError", "ValidationError")
_ERROR_SCHEMAS: dict[str, Any] = {
    "ErrorDetail": {
        "type": "object",
        "title": "ErrorDetail",
        "required": ["code", "message"],
        "properties": {
            "code": {"type": "string", "title": "Code"},
            "message": {"type": "string", "title": "Message"},
        },
    },
    "ErrorBody": {
        "type": "object",
        "title": "ErrorBody",
        "required": ["error"],
        "properties": {"error": {"$ref": "#/components/schemas/ErrorDetail"}},
    },
}
_ERROR_RESPONSE = {
    "description": "Error",
    "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ErrorBody"}}},
}


def _placeholder_settings() -> Settings:
    """Values are never used: no request is served and no AWS client is built."""
    return Settings(
        namespace="openapi",
        region="us-east-1",
        cognito_issuer="",
        cognito_client_id="",
        gateway_url="",
        agent_id="agent",
        agent_model="",
        auxiliary_model="",
        model_prices={},
        policy_store_id="",
        conversations_table="",
        conversations_table_arn="",
        data_key_arn="",
        data_access_role_arn="",
        budgets_table="",
        audit_stream="",
        audit_index_table="",
        user_monthly_budget=Decimal(0),
        agent_monthly_budget=Decimal(0),
        allowed_hosts=frozenset(),
    )


def _stub_services(settings: Settings) -> app_module.Services:
    # Every service is present, so routers that are optional in tests are included too.
    values: dict[str, Any] = {
        field.name: MagicMock() for field in dataclasses.fields(app_module.Services)
    }
    values["settings"] = settings
    return app_module.Services(**values)


def _fastapi_app() -> FastAPI:
    asgi = app_module.create_app(_placeholder_settings(), services_factory=_stub_services)
    inner = getattr(asgi, "app", None)
    if not isinstance(inner, FastAPI):
        raise TypeError("create_app no longer wraps a FastAPI application")
    return inner


def build_openapi() -> dict[str, Any]:
    """The contract of mango-api as the generated client sees it."""
    document: dict[str, Any] = _fastapi_app().openapi()

    paths: dict[str, Any] = {}
    seen: set[str] = set()
    for path, item in document["paths"].items():
        if not path.startswith(f"{API_PREFIX}/"):
            raise ValueError(f"route outside {API_PREFIX}: {path}")
        for method, operation in item.items():
            if method not in _METHODS:
                continue
            name = _route_name(operation["operationId"], path, method)
            if name in seen:
                raise ValueError(f"duplicate route function name: {name}")
            seen.add(name)
            operation["operationId"] = name
            operation["responses"].pop("422", None)
            operation["responses"]["default"] = _ERROR_RESPONSE
        paths[path.removeprefix(API_PREFIX)] = item

    document["paths"] = paths
    document["servers"] = [{"url": API_PREFIX}]
    schemas: dict[str, Any] = document.setdefault("components", {}).setdefault("schemas", {})
    for name in _FASTAPI_VALIDATION_SCHEMAS:
        schemas.pop(name, None)
    for name, schema in _ERROR_SCHEMAS.items():
        if name in schemas:
            raise ValueError(f"schema name is reserved for the error envelope: {name}")
        schemas[name] = schema
    return document


def _route_name(operation_id: str, path: str, method: str) -> str:
    """Function name of the route: FastAPI's default id is ``<name><path>_<method>``."""
    suffix = f"{re.sub(r'\W', '_', path)}_{method}"
    if not operation_id.endswith(suffix) or operation_id == suffix:
        raise ValueError(f"unexpected operationId for {method.upper()} {path}: {operation_id}")
    return operation_id.removesuffix(suffix)


def dumps_openapi(document: dict[str, Any]) -> str:
    """Stable text form (sorted keys), so the committed file only changes with the contract."""
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        sys.stderr.write("usage: python -m mango_api.openapi <output file>\n")
        return 2
    Path(argv[0]).write_text(dumps_openapi(build_openapi()), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
