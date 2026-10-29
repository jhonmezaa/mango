"""REQUEST interceptor on remote MCP targets (D98 (13), (15), (16); TM-006, TM-008, TM-012)."""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from typing import Any

import pytest
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from mango_core import invocation, remote_mcp
from mango_gateway_interceptor import handler
from mango_gateway_interceptor.handler import RemoteCatalog, handle

from .conftest import (
    CATALOG_KEY,
    GATEWAY_ID,
    KEY,
    PROBE,
    REGISTRATION,
    TARGET,
    WIKI,
    approved,
    headers,
    signed_item,
)

TARGETS = frozenset({"finops"})
FORCE = remote_mcp.force_authentication_meta()


class _Store:
    """The ``Settings`` item of each registration, and how many reads it took."""

    def __init__(self, items: Mapping[str, Mapping[str, object] | None] | None = None) -> None:
        self.items = dict(items if items is not None else {REGISTRATION: signed_item()})
        self.reads = 0
        self.error: Exception | None = None

    def load(self, registration: str) -> Mapping[str, object] | None:
        self.reads += 1
        if self.error is not None:
            raise self.error
        return self.items.get(registration)


def _catalog(store: _Store, clock: list[float] | None = None) -> RemoteCatalog:
    now = clock if clock is not None else [0.0]
    return RemoteCatalog(
        load=store.load,
        public_key=CATALOG_KEY.public_key,
        gateway_id=lambda: GATEWAY_ID,
        clock=lambda: now[0],
    )


def _event(
    name: str = WIKI,
    *,
    arguments: dict[str, Any] | None = None,
    meta: Any = None,
    hdrs: dict[str, str] | None = None,
) -> dict[str, Any]:
    params: dict[str, Any] = {"name": name, "arguments": arguments or {"path": "/Home"}}
    if meta is not None:
        params["_meta"] = meta
    return {
        "mcp": {
            "gatewayRequest": {
                "headers": hdrs if hdrs is not None else headers(),
                "body": {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": params},
            }
        }
    }


def _run(event: dict[str, Any], store: _Store | None = None) -> dict[str, Any]:
    return handle(event, KEY, TARGETS, remotes=_catalog(store or _Store()))


def _passed(result: dict[str, Any]) -> dict[str, Any]:
    request: dict[str, Any] = result["mcp"]["transformedGatewayRequest"]
    return request


def _refused(result: dict[str, Any]) -> tuple[int, int]:
    response = result["mcp"]["transformedGatewayResponse"]
    return response["statusCode"], response["body"]["error"]["code"]


def test_an_approved_tool_goes_through_with_the_two_headers_and_no_context() -> None:
    request = _passed(_run(_event(arguments={"path": "/Home", "_mango_ctx": {"token": "x"}})))
    # D101: exactly the approved tools of the signed catalog, never the toolsets.
    assert request["headers"] == {
        "X-MCP-Readonly": "true",
        "X-MCP-Tools": "core_list_projects, wiki",
    }
    assert request["body"]["params"] == {"name": WIKI, "arguments": {"path": "/Home"}}


@pytest.mark.parametrize("claims", [{}, {"mango_central": "true"}])
def test_never_returns_an_authorization_header(claims: dict[str, str]) -> None:
    # Any Authorization the interceptor returns replaces the vault's token (TM-008).
    request = _passed(_run(_event(hdrs=headers(**claims))))
    assert not any(name.lower() == "authorization" for name in request["headers"])
    assert set(request["headers"]) == {"X-MCP-Readonly", "X-MCP-Tools"}
    assert "token" not in json.dumps(request["body"])


@pytest.mark.parametrize("sent", [{}, {"X-MCP-Toolsets": "all"}, {"x-mcp-toolsets": "repos"}])
def test_never_sends_x_mcp_toolsets(sent: dict[str, str]) -> None:
    # Its named values do not hold every tool (D101): only X-MCP-Tools filters the server, and
    # what a client sends never comes out of the interceptor.
    request = _passed(_run(_event(hdrs={**headers(), **sent})))
    assert not any(name.lower() == "x-mcp-toolsets" for name in request["headers"])
    assert "toolsets" not in json.dumps(request).lower()


def test_a_catalog_signed_before_d101_is_refused() -> None:
    # Well signed, with the shape of payload v1 (X-MCP-Toolsets): refused until the remote
    # provisioner signs it again after the release.
    claims = json.loads(approved().encode())
    old = {**claims, "v": 1, "headers": {"X-MCP-Readonly": "true", "X-MCP-Toolsets": "wiki"}}
    payload = json.dumps(old, sort_keys=True, separators=(",", ":")).encode()
    signature = CATALOG_KEY.sign(remote_mcp.SIGNING_CONTEXT + payload, ec.ECDSA(hashes.SHA256()))
    store = _Store({REGISTRATION: remote_mcp.item_fields(payload, signature)})
    assert _refused(_run(_event(), store)) == (403, -32003)


def test_a_target_without_an_item_is_refused() -> None:
    assert _refused(_run(_event(), _Store({}))) == (403, -32003)


@pytest.mark.parametrize(
    "item",
    [
        # Altered after signing: another tool added to the payload.
        {
            **signed_item(),
            "payload": signed_item(approved(tools=frozenset({"core_list_projects", "wiki", "x"})))[
                "payload"
            ],
        },
        signed_item(key=ec.generate_private_key(ec.SECP256R1())),
        signed_item(approved(gateway_id="mango-other-tools-abcdefghij")),
        {"payload": "", "signature": ""},
        {},
    ],
    ids=["altered", "another-key", "another-gateway", "empty", "no-fields"],
)
def test_an_item_that_does_not_verify_is_refused(item: dict[str, str]) -> None:
    assert _refused(_run(_event(), _Store({REGISTRATION: item}))) == (403, -32003)


def test_the_item_of_another_registration_is_refused() -> None:
    other = approved(registration_id="zzzzzzzzzz23")
    assert _refused(_run(_event(), _Store({REGISTRATION: signed_item(other)}))) == (403, -32003)


def test_a_tool_outside_the_approved_list_is_refused() -> None:
    name = f"{TARGET}___repo_create_branch"
    result = _run(_event(name, hdrs=headers((name,))))
    assert _refused(result) == (403, -32003)


def test_a_tool_outside_the_signed_invocation_is_refused_before_the_catalog_is_read() -> None:
    store = _Store()
    assert _refused(_run(_event(WIKI, hdrs=headers((PROBE,))), store)) == (403, -32003)
    assert store.reads == 0


def test_without_a_catalog_no_remote_tool_goes_through() -> None:
    assert _refused(handle(_event(), KEY, TARGETS)) == (403, -32003)


@pytest.mark.parametrize(
    "error",
    [
        ClientError({"Error": {"Code": "ProvisionedThroughputExceededException"}}, "GetItem"),
        KeyError(),
    ],
)
def test_fails_closed_as_unavailable_when_the_item_cannot_be_read(
    error: Exception, caplog: pytest.LogCaptureFixture
) -> None:
    store = _Store()
    store.error = error
    with caplog.at_level(logging.INFO):
        assert _refused(_run(_event(), store)) == (503, -32000)
    assert "remote_unavailable" in caplog.text


def test_a_verified_item_is_reused_for_30_seconds_only() -> None:
    store, clock = _Store(), [100.0]
    catalog = _catalog(store, clock)
    for _ in range(3):
        handle(_event(), KEY, TARGETS, remotes=catalog)
    assert store.reads == 1
    clock[0] += 30
    handle(_event(), KEY, TARGETS, remotes=catalog)
    assert store.reads == 2


def test_a_refused_item_is_read_again() -> None:
    store = _Store({})
    catalog = _catalog(store)
    handle(_event(), KEY, TARGETS, remotes=catalog)
    store.items[REGISTRATION] = signed_item()
    assert "transformedGatewayRequest" in handle(_event(), KEY, TARGETS, remotes=catalog)["mcp"]


@pytest.mark.parametrize(
    "meta",
    [
        {remote_mcp.META_KEY: {"oauthCredentialProvider": {"returnUrl": "https://evil.example"}}},
        FORCE,
        {
            remote_mcp.META_KEY: {
                "oauthCredentialProvider": {"forceAuthentication": True, "returnUrl": "x"}
            }
        },
        {"forceAuthentication": True},
        {"progressToken": 1},
    ],
)
def test_the_model_never_passes_a_meta(meta: Any) -> None:
    request = _passed(_run(_event(meta=meta, arguments={"_meta": meta, "path": "/"})))
    assert "_meta" not in request["body"]["params"]
    assert request["body"]["params"]["arguments"] == {"path": "/"}


def test_a_disconnect_keeps_exactly_the_force_authentication_meta() -> None:
    hdrs = headers((PROBE,), connection="disconnect")
    request = _passed(_run(_event(PROBE, meta=FORCE, hdrs=hdrs)))
    assert request["body"]["params"]["_meta"] == FORCE


@pytest.mark.parametrize(
    "meta",
    [
        {
            remote_mcp.META_KEY: {
                "oauthCredentialProvider": {"forceAuthentication": True, "returnUrl": "https://x"}
            }
        },
        {remote_mcp.META_KEY: {"oauthCredentialProvider": {"forceAuthentication": "true"}}},
        {**FORCE, "returnUrl": "https://x"},
    ],
)
def test_a_disconnect_with_any_other_meta_loses_it_entirely(meta: Any) -> None:
    hdrs = headers((PROBE,), connection="disconnect")
    request = _passed(_run(_event(PROBE, meta=meta, hdrs=hdrs)))
    assert "_meta" not in request["body"]["params"]


def test_a_connect_never_keeps_a_meta() -> None:
    hdrs = headers((PROBE,), connection="connect")
    request = _passed(_run(_event(PROBE, meta=FORCE, hdrs=hdrs)))
    assert "_meta" not in request["body"]["params"]


@pytest.mark.parametrize("connection", ["connect", "disconnect"])
def test_a_connection_call_only_reaches_the_probe_tool(
    connection: invocation.Connection, caplog: pytest.LogCaptureFixture
) -> None:
    hdrs = headers((WIKI,), connection=connection)
    with caplog.at_level(logging.INFO):
        assert _refused(_run(_event(WIKI, hdrs=hdrs))) == (403, -32003)
    assert "connection_call_invalid" in caplog.text


def test_a_playground_test_reads_a_remote_like_a_turn() -> None:
    request = _passed(_run(_event(hdrs=headers(playground=True))))
    assert request["headers"]["X-MCP-Readonly"] == "true"


def test_logs_the_shape_of_a_remote_call_and_nothing_else(caplog: pytest.LogCaptureFixture) -> None:
    meta = {remote_mcp.META_KEY: {"oauthCredentialProvider": {"returnUrl": "https://evil.example"}}}
    with caplog.at_level(logging.INFO):
        _run(_event(meta=meta, arguments={"path": "/secret-page"}))
    assert json.loads(caplog.records[-1].getMessage()) == {
        "event": "gateway.remote_call",
        "had_meta": True,
        "meta_kept": False,
        "connection": None,
    }
    assert (
        "evil" not in caplog.text and "secret-page" not in caplog.text and WIKI not in caplog.text
    )


def test_other_targets_stay_as_they_were() -> None:
    hdrs = headers(("finops___get_cost_and_usage",))
    result = handle(
        _event("finops___get_cost_and_usage", hdrs=hdrs), KEY, TARGETS, remotes=_catalog(_Store())
    )
    request = _passed(result)
    assert "headers" not in request
    assert request["body"]["params"]["arguments"]["_mango_ctx"]["token"]


def test_a_pack_cannot_pose_as_a_remote_target() -> None:
    # A name that only looks remote is not a registration: it is a pack and needs PACK_TOOLS.
    name = "remote-NOTVALID___wiki"
    result = handle(_event(name, hdrs=headers((name,))), KEY, TARGETS, remotes=_catalog(_Store()))
    assert _refused(result) == (403, -32003)


def test_the_catalog_comes_from_the_stack(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []
    public_der = CATALOG_KEY.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )

    class _Client:
        def __init__(self, service: str) -> None:
            self.service = service

        def get_item(self, **kwargs: Any) -> dict[str, Any]:
            calls.append(("get_item", kwargs))
            return {"Item": {name: {"S": value} for name, value in signed_item().items()}}

        def get_public_key(self, **kwargs: Any) -> dict[str, Any]:
            calls.append(("get_public_key", kwargs))
            return {"PublicKey": public_der}

        def get_parameter(self, **kwargs: Any) -> dict[str, Any]:
            calls.append(("get_parameter", kwargs))
            return {"Parameter": {"Value": GATEWAY_ID}}

    monkeypatch.setattr(handler.boto3, "client", lambda service, **_: _Client(service))
    monkeypatch.setenv("SETTINGS_TABLE", "Settings")
    monkeypatch.setenv("REMOTE_MCP_KEY_ARN", "arn:aws:kms:us-east-1:111122223333:key/example")
    monkeypatch.setenv("GATEWAY_ID_PARAMETER", "/Mango-test-tools/gateway-id")
    handler._remote_catalog.cache_clear()
    try:
        catalog = handler._remote_catalog()
        assert calls == []  # nothing until a remote call
        assert catalog.approved(TARGET).registration_id == REGISTRATION
    finally:
        handler._remote_catalog.cache_clear()
    assert calls == [
        (
            "get_item",
            {
                "TableName": "Settings",
                "Key": remote_mcp.approved_key(REGISTRATION),
                "ProjectionExpression": "payload, signature",
            },
        ),
        ("get_public_key", {"KeyId": "arn:aws:kms:us-east-1:111122223333:key/example"}),
        ("get_parameter", {"Name": "/Mango-test-tools/gateway-id"}),
    ]
