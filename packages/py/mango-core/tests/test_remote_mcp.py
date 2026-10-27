from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import replace
from typing import Any

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

from mango_core.remote_mcp import (
    CONSENT_TTL_SECONDS,
    SIGNING_CONTEXT,
    ApprovedRemote,
    PendingConsent,
    RemoteNotApprovedError,
    approved_key,
    consent_key,
    force_authentication_meta,
    gateway_tool_name,
    is_consent_url,
    is_force_authentication_meta,
    is_registration_id,
    item_fields,
    load_public_key,
    new_registration_id,
    organization_key,
    policy_name,
    provider_name,
    registration_of_target,
    signing_digest,
    split_gateway_tool,
    target_name,
)

REG = "abcdefghij23"
TARGET = "remote-abcdefghij23"
GATEWAY = "mango-poc-gateway-abcdefghij"
REGION = "us-east-1"
SUB = "0a1b2c3d-1111-2222-3333-444455556666"
NOW = 1_900_000_000
CONSENT_URL = f"https://bedrock-agentcore.{REGION}.amazonaws.com/identities/oauth2/authorize?x=1"

APPROVED = ApprovedRemote(
    registration_id=REG,
    generation=1,
    revision=1,
    profile_id="azure-devops",
    profile_version="2026.10.1-1",
    profile_sha256="a" * 64,
    gateway_id=GATEWAY,
    organization="contoso",
    toolsets=("core", "wiki", "wit"),
    toolsets_header="core,wiki,wit",
    tools=frozenset({"core_list_projects", "search_wiki", "wiki", "wit_work_item"}),
    probe_tool="core_list_projects",
    issued_at=NOW,
)

KEY = ec.generate_private_key(ec.SECP256R1())
OTHER_KEY = ec.generate_private_key(ec.SECP256R1())


def _der(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )


def _kms_sign(payload: bytes, key: ec.EllipticCurvePrivateKey = KEY) -> bytes:
    # What KMS does with MessageType=DIGEST: sign the digest as given.
    return key.sign(signing_digest(payload), ec.ECDSA(utils.Prehashed(hashes.SHA256())))


def _item(payload: bytes, key: ec.EllipticCurvePrivateKey = KEY) -> dict[str, str]:
    return item_fields(payload, _kms_sign(payload, key))


def _verify(item: dict[str, Any], *, target: str = TARGET, gateway: str = GATEWAY) -> Any:
    return ApprovedRemote.verify(
        load_public_key(_der(KEY)), item, target=target, gateway_id=gateway
    )


# --- Names --------------------------------------------------------------------------------


def test_registration_ids_are_random_base32() -> None:
    ids = {new_registration_id() for _ in range(200)}
    assert len(ids) == 200
    assert all(is_registration_id(value) and len(value) == 12 for value in ids)


def test_names_of_a_registration() -> None:
    assert target_name(REG) == TARGET
    assert registration_of_target(TARGET) == REG
    assert gateway_tool_name(REG, "wit_work_item") == "remote-abcdefghij23___wit_work_item"
    assert split_gateway_tool("remote-abcdefghij23___wit_work_item") == (REG, "wit_work_item")
    assert provider_name("poc", REG, 2) == "Mango-poc-remote-abcdefghij23-g2"
    assert policy_name("poc", REG, 1) == "Mango_poc_remote_abcdefghij23_1"


@pytest.mark.parametrize(
    "target", ["finops", "remote-", "remote-ABCDEFGHIJ23", "remote-abcdefghij231", "xremote-ab"]
)
def test_other_targets_are_not_remote(target: str) -> None:
    assert registration_of_target(target) is None
    assert split_gateway_tool(f"{target}___wiki") is None


@pytest.mark.parametrize(
    "call",
    [
        lambda: target_name("abc"),
        lambda: gateway_tool_name(REG, "../wiki"),
        lambda: provider_name("Poc", REG, 1),
        lambda: provider_name("poc", REG, 0),
        lambda: policy_name("poc", "x", 1),
        lambda: organization_key("azure-devops", "-contoso"),
        lambda: consent_key("user#1", REG),
    ],
)
def test_invalid_names_are_refused(call: Any) -> None:
    with pytest.raises(ValueError, match="invalid"):
        call()


def test_keys_of_the_partitions() -> None:
    assert approved_key(REG) == {"PK": {"S": "MCP_REMOTE#abcdefghij23"}, "SK": {"S": "APPROVED"}}
    assert consent_key(SUB, REG) == {
        "PK": {"S": f"MCP_CONSENT#{SUB}"},
        "SK": {"S": "REMOTE#abcdefghij23"},
    }
    # One registration per organization, whatever its case (D93 (5)).
    assert organization_key("azure-devops", "Contoso") == organization_key(
        "azure-devops", "contoso"
    )


# --- The 3LO ``_meta`` ------------------------------------------------------------------


def test_only_the_exact_force_authentication_meta_passes() -> None:
    assert is_force_authentication_meta(force_authentication_meta())


@pytest.mark.parametrize(
    "meta",
    [
        None,
        {},
        {"forceAuthentication": True},
        {"aws.bedrock-agentcore.gateway/credentialProviderConfiguration": {}},
        {
            "aws.bedrock-agentcore.gateway/credentialProviderConfiguration": {
                "oauthCredentialProvider": {
                    "forceAuthentication": True,
                    "returnUrl": "https://example.invalid/",
                }
            }
        },
        {
            "aws.bedrock-agentcore.gateway/credentialProviderConfiguration": {
                "oauthCredentialProvider": {"forceAuthentication": 1}
            }
        },
        {
            "aws.bedrock-agentcore.gateway/credentialProviderConfiguration": {
                "oauthCredentialProvider": {"forceAuthentication": "true"}
            }
        },
        {
            "aws.bedrock-agentcore.gateway/credentialProviderConfiguration": {
                "oauthCredentialProvider": {"forceAuthentication": False}
            }
        },
        {**force_authentication_meta(), "progressToken": 1},
    ],
)
def test_any_other_meta_is_not_a_disconnect(meta: object) -> None:
    assert not is_force_authentication_meta(meta)


# --- The consent URL ---------------------------------------------------------------------


def test_an_identity_url_of_the_region_is_a_consent_url() -> None:
    assert is_consent_url(CONSENT_URL, REGION)


@pytest.mark.parametrize(
    "url",
    [
        CONSENT_URL.replace("https://", "http://"),
        "https://bedrock-agentcore.eu-west-1.amazonaws.com/identities/oauth2/authorize",
        "https://bedrock-agentcore.us-east-1.amazonaws.com.example.invalid/x",
        "https://example.invalid/?h=bedrock-agentcore.us-east-1.amazonaws.com",
        "https://user@bedrock-agentcore.us-east-1.amazonaws.com/x",
        "https://bedrock-agentcore.us-east-1.amazonaws.com:8443/x",
        "https://BEDROCK-AGENTCORE.us-east-1.amazonaws.com/x",
        "https://bedrock-agentcore.us-east-1.amazonaws.com\\@example.invalid/x",
        "https://bedrock-agentcore.us-east-1.amazonaws.com/x y",
        "https://bedrock-agentcore.us-east-1.amazonaws.com/" + chr(0x430),
        "https://bedrock-agentcore.us-east-1.amazonaws.com",
        "javascript:alert(1)",
        CONSENT_URL + "a" * 2048,
        "",
        None,
        42,
    ],
)
def test_any_other_url_is_refused(url: object) -> None:
    assert not is_consent_url(url, REGION)


def test_a_malformed_region_is_refused() -> None:
    assert not is_consent_url(CONSENT_URL, "us-east-1.example.invalid")


# --- The approved catalog ----------------------------------------------------------------


def test_the_signed_catalog_verifies_and_names_the_headers() -> None:
    approved = _verify(_item(APPROVED.encode()))
    assert approved == APPROVED
    assert approved.headers == {"X-MCP-Readonly": "true", "X-MCP-Toolsets": "core,wiki,wit"}
    assert not any(key.lower() == "authorization" for key in approved.headers)
    assert approved.allows("remote-abcdefghij23___wit_work_item")
    assert not approved.allows("remote-abcdefghij23___wit_work_item_attachment")
    assert not approved.allows("remote-zzzzzzzzzz23___wit_work_item")
    assert not approved.allows("finops___wit_work_item")


def test_the_payload_is_canonical_json_with_the_target() -> None:
    payload = APPROVED.encode()
    claims = json.loads(payload)
    assert claims["target"] == TARGET
    assert claims["v"] == 1
    assert (
        payload
        == json.dumps(claims, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    )
    assert signing_digest(payload) == hashlib.sha256(b"mango.remote-mcp.v1\n" + payload).digest()


def test_the_canonical_form_is_the_one_of_the_packs() -> None:
    canonical = pytest.importorskip("mango_packs.canonical")
    assert canonical.canonical_json(json.loads(APPROVED.encode())) == APPROVED.encode()


def test_an_item_of_another_target_or_gateway_does_not_verify() -> None:
    item = _item(APPROVED.encode())
    with pytest.raises(RemoteNotApprovedError):
        _verify(item, target="remote-zzzzzzzzzz23")
    with pytest.raises(RemoteNotApprovedError):
        _verify(item, gateway="mango-other-gateway-abcdefghij")


def test_an_altered_item_does_not_verify() -> None:
    payload = APPROVED.encode()
    signature = _kms_sign(payload)
    widened = replace(APPROVED, tools=APPROVED.tools | {"repo_create_branch"}).encode()
    with pytest.raises(RemoteNotApprovedError):
        _verify(item_fields(widened, signature))


def test_an_item_signed_with_another_key_does_not_verify() -> None:
    with pytest.raises(RemoteNotApprovedError):
        _verify(_item(APPROVED.encode(), OTHER_KEY))


def test_a_signature_without_the_context_does_not_verify() -> None:
    # Domain separation: the same key signing the bare payload is not a catalog signature.
    payload = APPROVED.encode()
    bare = KEY.sign(payload, ec.ECDSA(hashes.SHA256()))
    with pytest.raises(RemoteNotApprovedError):
        _verify(item_fields(payload, bare))
    assert SIGNING_CONTEXT == b"mango.remote-mcp.v1\n"


def _signed_claims(**overrides: Any) -> dict[str, str]:
    claims = {**json.loads(APPROVED.encode()), **overrides}
    payload = json.dumps(claims, sort_keys=True, separators=(",", ":")).encode()
    return _item(payload)


@pytest.mark.parametrize(
    "overrides",
    [
        {"v": 2},
        {"registration_id": "zzzzzzzzzz23"},
        {"target": "remote-zzzzzzzzzz23"},
        {"headers": {"X-MCP-Readonly": "false", "X-MCP-Toolsets": "core,wiki,wit"}},
        {
            "headers": {
                "X-MCP-Readonly": "true",
                "X-MCP-Toolsets": "core,wiki,wit",
                "Authorization": "Bearer x",
            }
        },
        {"tools": ["wiki", "wiki", "core_list_projects"]},
        {"tools": ["wiki"]},
        {"tools": ["../wiki", "core_list_projects"]},
        {"probe_tool": "search_wiki_x"},
        {"generation": True},
        {"generation": 1.0},
        {"revision": 0},
        {"toolsets": ["wit", "core"]},
        {"organization": "contoso/evil"},
        {"profile_sha256": "A" * 64},
        {"extra": "field"},
    ],
)
def test_a_well_signed_catalog_of_another_shape_is_refused(overrides: dict[str, Any]) -> None:
    with pytest.raises(RemoteNotApprovedError):
        _verify(_signed_claims(**overrides))


def test_a_well_signed_payload_that_is_not_canonical_is_refused() -> None:
    claims = json.loads(APPROVED.encode())
    spaced = json.dumps(claims, sort_keys=True, indent=1).encode()
    with pytest.raises(RemoteNotApprovedError):
        _verify(_item(spaced))


@pytest.mark.parametrize(
    "item",
    [
        {},
        {"payload": "x"},
        {"payload": 1, "signature": "x"},
        {"payload": "!!!", "signature": "AAAA"},
        {"payload": base64.urlsafe_b64encode(b"[]").decode(), "signature": "not base64!"},
    ],
)
def test_a_missing_or_garbled_item_is_refused(item: dict[str, Any]) -> None:
    with pytest.raises(RemoteNotApprovedError):
        _verify(item)


@pytest.mark.parametrize(
    "overrides",
    [
        {"probe_tool": "search_code"},
        {"tools": frozenset()},
        {"toolsets": ("wit", "core")},
        {"toolsets_header": "core, wit"},
        {"gateway_id": "Gateway/1"},
        {"organization": "con toso"},
        {"generation": 0},
    ],
)
def test_the_provisioner_cannot_sign_what_it_could_not_vouch_for(
    overrides: dict[str, Any],
) -> None:
    with pytest.raises(ValueError, match="invalid approved remote"):
        replace(APPROVED, **overrides).encode()


def test_only_a_p256_key_is_loaded() -> None:
    other = ec.generate_private_key(ec.SECP384R1())
    with pytest.raises(ValueError, match="P-256"):
        load_public_key(_der(other))


# --- The pending consent -----------------------------------------------------------------


def _consent(**overrides: Any) -> PendingConsent:
    args: dict[str, Any] = {"now": NOW, "region": REGION}
    return PendingConsent.new(REG, CONSENT_URL, "chat", **{**args, **overrides})


def test_a_pending_consent_lives_ten_minutes_and_reads_back() -> None:
    consent = _consent(session_sha256="b" * 64)
    item = consent.to_item(SUB)
    assert item["ttl"] == {"N": str(NOW + CONSENT_TTL_SECONDS)}
    assert item["PK"] == {"S": f"MCP_CONSENT#{SUB}"}
    read = PendingConsent.from_item(
        item, subject=SUB, registration_id=REG, region=REGION, now=NOW + 599
    )
    assert read == consent


def test_a_pending_consent_without_session_has_no_attribute() -> None:
    assert "session_sha256" not in _consent().to_item(SUB)


@pytest.mark.parametrize(
    ("subject", "registration", "now"),
    [
        ("0a1b2c3d-9999-2222-3333-444455556666", REG, NOW),
        (SUB, "zzzzzzzzzz23", NOW),
        (SUB, REG, NOW + CONSENT_TTL_SECONDS),
    ],
)
def test_a_pending_consent_of_someone_else_or_expired_is_none(
    subject: str, registration: str, now: int
) -> None:
    item = _consent().to_item(SUB)
    found = PendingConsent.from_item(
        item, subject=subject, registration_id=registration, region=REGION, now=now
    )
    assert found is None


@pytest.mark.parametrize(
    "change",
    [
        {"authorization_url": {"S": "https://example.invalid/authorize"}},
        {"source": {"S": "email"}},
        {"expires_at": {"N": str(NOW + 3600)}},
        {"created_at": {"N": "x"}},
        {"session_sha256": {"S": "nothex"}},
        {"source": None},
        {"source": {"S": ["chat"]}},
        {"session_sha256": {"S": 7}},
        {"PK": {"S": "MCP_CONSENT#other"}},
    ],
)
def test_a_tampered_pending_consent_is_none(change: dict[str, Any]) -> None:
    item = {**_consent().to_item(SUB), **change}
    found = PendingConsent.from_item(item, subject=SUB, registration_id=REG, region=REGION, now=NOW)
    assert found is None


@pytest.mark.parametrize(
    "overrides",
    [
        {"region": "eu-west-1"},
        {"session_sha256": "x"},
    ],
)
def test_a_pending_consent_is_written_only_for_an_identity_url(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValueError, match="invalid pending consent"):
        _consent(**overrides)


def test_a_pending_consent_needs_a_known_source() -> None:
    with pytest.raises(ValueError, match="invalid pending consent"):
        PendingConsent.new(REG, CONSENT_URL, "email", now=NOW, region=REGION)  # type: ignore[arg-type]
