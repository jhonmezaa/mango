import base64
import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pydantic import ValidationError

from mango_packs.remote import (
    PAYLOAD_TYPE,
    RemoteProfile,
    RemoteProfileError,
    RemoteProfileStatement,
    build_envelope,
    check_tool_schema,
    forced_headers,
    picked_tools,
    tool_schema_sha256,
    verify_envelope,
)
from mango_packs.signing import PackSignatureError, signed_message

REPO = Path(__file__).parents[4]

READ_ONLY = {"readOnlyHint": True, "destructiveHint": False}
SCHEMA: dict[str, Any] = {
    "tools": [
        {"name": "list_projects", "inputSchema": {"type": "object"}, "annotations": READ_ONLY},
        {"name": "get_item", "inputSchema": {"type": "object"}, "annotations": READ_ONLY},
        {"name": "search_code", "inputSchema": {"type": "object"}},
    ]
}


def profile_data(schema: dict[str, Any] = SCHEMA) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "id": "fake-remote",
        "version": "2026.10.27-1",
        "name": "Fake",
        "operator": "Someone",
        "data_leaves_aws": True,
        "endpoint": {"host": "mcp.example.com", "path": "/{organization}"},
        "link_hosts": ["example.com", "example.net"],
        "link_org": {"path_segment": 1, "subdomain_of": "example.net"},
        "provider": {
            "vendor": "MicrosoftOauth2",
            "display_name": "Microsoft",
            "needs_tenant": True,
            "scopes": ["00000000-0000-0000-0000-000000000000/.default", "offline_access"],
            "permissions": [{"resource": "Fake API", "permission": ".default"}],
        },
        "forced_headers": {"X-MCP-Readonly": "true", "X-MCP-Tools": "{tools}"},
        "toolsets": [
            {"id": "core", "label": "Core", "always": True},
            {"id": "items", "label": "Items"},
            {"id": "search-code", "label": "Code"},
        ],
        "probe": {"tool": "list_projects", "arguments": {"top": 1}},
        "tools": [
            {"name": "list_projects", "toolset": "core", "access": "read"},
            {"name": "get_item", "toolset": "items", "access": "read"},
            {"name": "search_code", "toolset": "search-code", "access": "read"},
        ],
        "tools_sha256": tool_schema_sha256(schema),
        "max_result_chars": 65536,
    }


def _profile(**changes: Any) -> RemoteProfile:
    return RemoteProfile.model_validate(profile_data() | changes)


def _tools(**access: str | None) -> list[dict[str, Any]]:
    tools = profile_data()["tools"]
    for tool in tools:
        if tool["name"] in access:
            if access[tool["name"]] is None:
                del tool["access"]
            else:
                tool["access"] = access[tool["name"]]
    return list(tools)


def test_a_valid_profile_parses() -> None:
    profile = _profile()
    assert profile.tool_names == {"list_projects", "get_item", "search_code"}
    check_tool_schema(profile, SCHEMA)


def test_the_azure_devops_profile_of_the_repository_is_valid() -> None:
    directory = REPO / "remotes" / "azure-devops"
    profile = RemoteProfile.model_validate(yaml.safe_load((directory / "profile.yaml").read_text()))
    check_tool_schema(profile, json.loads((directory / "tool-schema.json").read_text()))
    assert profile.probe.tool == "core_list_projects"
    # Kept out of every toolset (TM-011).
    assert not profile.tool_names & {"pipelines_artifact", "wit_work_item_attachment"}


SOURCE_NOTE = "El agente lee archivos, commits y pull requests de los repositorios."
REQUIREMENT = "Necesita la extensión Code Search de Microsoft instalada en la organización."


def _marked_toolsets() -> list[dict[str, Any]]:
    toolsets: list[dict[str, Any]] = profile_data()["toolsets"]
    toolsets[1] |= {"sensitivity": "source_code", "note": SOURCE_NOTE}
    toolsets[2] |= {"requirement": REQUIREMENT}
    return toolsets


def test_a_toolset_may_carry_a_sensitivity_a_note_and_a_requirement() -> None:
    profile = _profile(toolsets=_marked_toolsets())
    core, items, code = profile.toolsets
    assert (items.sensitivity, items.note, items.requirement) == ("source_code", SOURCE_NOTE, None)
    assert (code.sensitivity, code.note, code.requirement) == (None, None, REQUIREMENT)
    # Unset, they are not in the statement at all.
    assert core.model_dump(mode="json") == {"id": "core", "label": "Core", "always": True}
    assert set(code.model_dump(mode="json")) == {"id", "label", "always", "requirement"}


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("sensitivity", "secrets"),
        ("sensitivity", "Source_Code"),
        ("sensitivity", ""),
        ("note", ""),
        ("note", "   "),
        ("note", "x" * 301),
        ("note", "<b>Código</b> fuente"),
        ("note", "Lee el código & los PR"),
        ("note", "Lee **todo** el código"),
        ("note", "[Abrir](https://example.com)"),
        ("note", "Dos\nlíneas"),
        ("note", "Con\ttabulador"),
        ("note", "Dos  espacios"),
        ("requirement", "Usa `search_code`"),
        ("requirement", "Ver #12"),
        ("requirement", 3),
    ],
)
def test_toolset_texts_are_short_plain_text_and_the_sensitivity_a_known_value(
    field: str, value: object
) -> None:
    toolsets = profile_data()["toolsets"]
    toolsets[1][field] = value
    with pytest.raises(ValidationError, match=field):
        _profile(toolsets=toolsets)


def test_toolset_texts_keep_spanish_punctuation() -> None:
    text = "¿Sin ella? La búsqueda no encuentra nada: «sin resultados» (Code Search, v2/3)."
    toolsets = profile_data()["toolsets"]
    toolsets[1]["note"] = f"  {text} "
    assert _profile(toolsets=toolsets).toolsets[1].note == text


@pytest.mark.parametrize(
    ("access", "message"),
    [
        ({"get_item": "write"}, r"must be read .*get_item \(write\)"),
        ({"get_item": "destructive"}, r"must be read .*get_item \(destructive\)"),
        ({"get_item": None}, r"access"),
    ],
)
def test_every_tool_must_be_classified_read(access: dict[str, str | None], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        _profile(tools=_tools(**access))


@pytest.mark.parametrize("host", ["*.example.com", "10.0.0.1", "mcp.example.com.", "a b.com"])
def test_the_host_is_a_fixed_name(host: str) -> None:
    with pytest.raises(ValidationError, match=r"endpoint\.host"):
        _profile(endpoint={"host": host, "path": "/{organization}"})


def test_the_path_names_only_the_organization() -> None:
    with pytest.raises(ValidationError, match=r"endpoint\.path"):
        _profile(endpoint={"host": "mcp.example.com", "path": "/{organization}/{project}"})


def test_the_probe_is_a_tool_of_a_toolset_that_is_always_on() -> None:
    with pytest.raises(ValidationError, match="probe tool"):
        _profile(probe={"tool": "get_item"})
    with pytest.raises(ValidationError, match="probe tool"):
        _profile(probe={"tool": "not_a_tool"})


def test_unknown_fields_and_other_headers_are_refused() -> None:
    with pytest.raises(ValidationError, match="extra"):
        _profile(organization_pattern=".*")
    for headers in (
        {"X-MCP-Readonly": "false", "X-MCP-Tools": "{tools}"},
        # The header of the toolsets is gone (D101): a profile cannot bring it back.
        {"X-MCP-Readonly": "true", "X-MCP-Toolsets": "{toolsets}"},
        {"X-MCP-Readonly": "true", "X-MCP-Tools": "{tools}", "X-MCP-Toolsets": "{toolsets}"},
    ):
        with pytest.raises(ValidationError, match="forced_headers must be exactly"):
            _profile(forced_headers=headers)
    authorization = {**profile_data()["forced_headers"], "Authorization": "Bearer x"}
    with pytest.raises(ValidationError, match="forced_headers must be exactly"):
        _profile(forced_headers=authorization)


def test_toolsets_are_consistent_with_the_tools() -> None:
    toolsets = profile_data()["toolsets"]
    with pytest.raises(ValidationError, match="extra"):
        _profile(toolsets=[*toolsets[:2], {**toolsets[2], "header": "repos"}])
    with pytest.raises(ValidationError, match="can pick"):
        _profile(toolsets=[{**t, "always": True} for t in toolsets])
    with pytest.raises(ValidationError, match="toolsets without tools"):
        _profile(toolsets=[*toolsets, {"id": "wiki", "label": "Wiki"}])
    tools = _tools()
    tools[1]["toolset"] = "pipelines"
    with pytest.raises(ValidationError, match="in no declared toolset"):
        _profile(tools=tools)


def test_the_schema_must_be_the_pinned_one() -> None:
    profile = _profile()
    changed = {"tools": [*SCHEMA["tools"][:2], {**SCHEMA["tools"][2], "description": "new"}]}
    with pytest.raises(RemoteProfileError, match="the tool schema changed"):
        check_tool_schema(profile, changed)
    with pytest.raises(RemoteProfileError, match=r"not in the schema \['search_code'\]"):
        check_tool_schema(profile, {"tools": SCHEMA["tools"][:2]})
    extra = {"tools": [*SCHEMA["tools"], {"name": "delete_item"}]}
    with pytest.raises(RemoteProfileError, match=r"not in the profile \['delete_item'\]"):
        check_tool_schema(profile, extra)
    with pytest.raises(RemoteProfileError, match='only "tools"'):
        check_tool_schema(profile, {**SCHEMA, "captured_at": "2026-10-27"})
    with pytest.raises(RemoteProfileError, match="duplicate"):
        check_tool_schema(profile, {"tools": [*SCHEMA["tools"], SCHEMA["tools"][0]]})


@pytest.mark.parametrize(
    "annotations",
    [
        {"readOnlyHint": False},
        {"destructiveHint": True},
        {"readOnlyHint": True, "destructiveHint": True},
    ],
)
def test_annotations_can_only_make_the_check_stricter(annotations: dict[str, bool]) -> None:
    schema = {"tools": [*SCHEMA["tools"][:2], {**SCHEMA["tools"][2], "annotations": annotations}]}
    profile = RemoteProfile.model_validate(profile_data(schema))
    with pytest.raises(RemoteProfileError, match=r"annotates \['search_code'\]"):
        check_tool_schema(profile, schema)


def test_the_schema_fits_the_inline_quota_of_a_target() -> None:
    big = {"tools": [{**SCHEMA["tools"][0], "description": "x" * (1024 * 1024)}]}
    with pytest.raises(RemoteProfileError, match="1 MB"):
        check_tool_schema(_profile(), big)


def test_forced_headers_send_the_picked_tools_and_always_read_only() -> None:
    profile = _profile()
    # D101: the exact tools, sorted, as the server's docs separate them; never the toolsets.
    assert forced_headers(profile, ["search-code", "items"]) == {
        "X-MCP-Readonly": "true",
        "X-MCP-Tools": "get_item, list_projects, search_code",
    }
    assert forced_headers(profile, ["core", "items"]) == {
        "X-MCP-Readonly": "true",
        "X-MCP-Tools": "get_item, list_projects",
    }
    assert picked_tools(profile, ["search-code"]) == {"list_projects", "search_code"}
    with pytest.raises(RemoteProfileError, match=r"not in profile fake-remote: \['repos'\]"):
        forced_headers(profile, ["repos"])
    for toolsets in ([], ["core"]):
        with pytest.raises(RemoteProfileError, match="at least one toolset"):
            forced_headers(profile, toolsets)


def test_the_tools_must_fit_in_their_header() -> None:
    names = [f"t{n:02d}_{'x' * 60}" for n in range(70)]
    tools = [*_tools(), *({"name": n, "toolset": "items", "access": "read"} for n in names)]
    with pytest.raises(ValidationError, match="do not fit in X-MCP-Tools"):
        _profile(tools=tools)


# --- Signed statement ---------------------------------------------------------------------


@pytest.fixture(scope="module")
def key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


def _pem(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )


@pytest.fixture
def statement() -> RemoteProfileStatement:
    return RemoteProfileStatement(
        schema_version=1, profile=_profile(), tool_schema=SCHEMA, source_revision="f" * 40
    )


def _sign(key: ec.EllipticCurvePrivateKey, payload: bytes, kind: str = PAYLOAD_TYPE) -> bytes:
    return key.sign(signed_message(payload, kind), ec.ECDSA(hashes.SHA256()))


def _envelope(payload: bytes, signature: bytes, kind: str = PAYLOAD_TYPE) -> bytes:
    return json.dumps(
        {
            "payload_type": kind,
            "payload": base64.b64encode(payload).decode(),
            "signature": {
                "algorithm": "ECDSA_SHA_256",
                "key_id": "alias/test",
                "value": base64.b64encode(signature).decode(),
            },
        }
    ).encode()


def test_a_signed_statement_verifies_offline(
    key: ec.EllipticCurvePrivateKey, statement: RemoteProfileStatement
) -> None:
    envelope = build_envelope(statement, "alias/test", _sign(key, statement.payload()))
    assert verify_envelope(envelope, _pem(key)) == statement
    assert (
        statement.payload()
        == RemoteProfileStatement.model_validate_json(statement.payload()).payload()
    )


def test_another_key_or_a_changed_payload_does_not_verify(
    key: ec.EllipticCurvePrivateKey, statement: RemoteProfileStatement
) -> None:
    other = ec.generate_private_key(ec.SECP256R1())
    envelope = build_envelope(statement, "alias/test", _sign(key, statement.payload()))
    with pytest.raises(PackSignatureError, match="does not match"):
        verify_envelope(envelope, _pem(other))
    data = json.loads(envelope)
    tampered = statement.payload().replace(b'"max_result_chars":65536', b'"max_result_chars":65537')
    data["payload"] = base64.b64encode(tampered).decode()
    with pytest.raises(PackSignatureError, match="does not match"):
        verify_envelope(json.dumps(data).encode(), _pem(key))


def test_a_pack_signature_is_not_a_profile_signature(
    key: ec.EllipticCurvePrivateKey, statement: RemoteProfileStatement
) -> None:
    pack_type = "application/vnd.mango.pack.v1+json"
    signature = _sign(key, statement.payload(), pack_type)
    with pytest.raises(PackSignatureError, match="malformed"):
        verify_envelope(_envelope(statement.payload(), signature, pack_type), _pem(key))
    with pytest.raises(PackSignatureError, match="does not match"):
        verify_envelope(_envelope(statement.payload(), signature), _pem(key))


def test_a_statement_signed_before_the_toolset_fields_still_verifies(
    key: ec.EllipticCurvePrivateKey, statement: RemoteProfileStatement
) -> None:
    # What a release signed before `sensitivity`, `note` and `requirement` existed: a toolset
    # has only `id`, `label` and `always`. It must read back to the same canonical payload.
    payload = statement.payload()
    assert b"sensitivity" not in payload and b"requirement" not in payload
    verified = verify_envelope(_envelope(payload, _sign(key, payload)), _pem(key))
    assert verified.payload() == payload


def test_a_statement_with_toolset_fields_verifies_and_signs_them(
    key: ec.EllipticCurvePrivateKey,
) -> None:
    marked = RemoteProfileStatement(
        schema_version=1,
        profile=_profile(toolsets=_marked_toolsets()),
        tool_schema=SCHEMA,
        source_revision="f" * 40,
    )
    payload = marked.payload()
    verified = verify_envelope(_envelope(payload, _sign(key, payload)), _pem(key))
    assert verified.profile.toolsets[1].sensitivity == "source_code"
    assert verified.profile.toolsets[2].requirement == REQUIREMENT
    # The texts are signed: changing one breaks the signature.
    tampered = payload.replace(b"repositorios", b"repositorio ")
    with pytest.raises(PackSignatureError, match="does not match"):
        verify_envelope(_envelope(tampered, _sign(key, payload)), _pem(key))
    # A null where the field is unset is not the canonical form.
    data = marked.model_dump(mode="json")
    data["profile"]["toolsets"][0]["note"] = None
    with_null = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    with pytest.raises(PackSignatureError, match="canonical"):
        raw = with_null.encode()
        verify_envelope(_envelope(raw, _sign(key, raw)), _pem(key))


def test_a_signed_statement_that_breaks_a_rule_is_refused(
    key: ec.EllipticCurvePrivateKey, statement: RemoteProfileStatement
) -> None:
    data = statement.model_dump(mode="json")
    data["profile"]["tools"][1]["access"] = "write"
    payload = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    with pytest.raises(PackSignatureError, match="not a valid remote profile"):
        verify_envelope(_envelope(payload, _sign(key, payload)), _pem(key))
    pretty = json.dumps(statement.model_dump(mode="json"), indent=1).encode()
    with pytest.raises(PackSignatureError, match="canonical"):
        verify_envelope(_envelope(pretty, _sign(key, pretty)), _pem(key))
