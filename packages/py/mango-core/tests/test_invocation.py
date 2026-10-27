import base64
import hashlib
import hmac
import json
from typing import Any

import pytest

from mango_core.invocation import MAX_HEADER_CHARS, Invocation, sign, verify

KEY = b"k" * 32
NOW = 1_900_000_000
EXPIRES = 2_000_000_000
TOOLS = ["finops___get_cost_and_usage", "finops___list_accounts_in_scope"]


def _sign(subject: str = "user-1", **overrides: Any) -> str:
    args: dict[str, Any] = {"agent_id": "finops", "agent_version": 3, "tools": TOOLS}
    return sign(KEY, subject, EXPIRES, **{**args, **overrides})


def _forge(payload: dict[str, Any], key: bytes = KEY) -> str:
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    mac = hmac.new(key, f"v2.{encoded}".encode(), hashlib.sha256).hexdigest()
    return f"v2.{encoded}.{mac}"


def _legacy(subject: str = "user-1", expires: int = EXPIRES) -> str:
    mac = hmac.new(KEY, f"v1|{subject}|{expires}".encode(), hashlib.sha256).hexdigest()
    return f"v1.{expires}.{mac}"


def test_valid_signature_carries_agent_version_and_tools() -> None:
    assert verify(KEY, "user-1", _sign(), now=NOW) == Invocation(
        subject="user-1",
        agent_id="finops",
        agent_version=3,
        tools=frozenset(TOOLS),
        expires_at=EXPIRES,
    )


def test_tools_are_a_set_whatever_the_order() -> None:
    assert _sign(tools=[*reversed(TOOLS), TOOLS[0]]) == _sign()


def test_agent_without_tools() -> None:
    found = verify(KEY, "user-1", _sign(tools=[]), now=NOW)
    assert found is not None
    assert found.tools == frozenset()


def test_rejects_other_subject_expiry_key_and_garbage() -> None:
    value = _sign()
    assert verify(KEY, "user-2", value, now=NOW) is None
    assert verify(KEY, "user-1", value, now=EXPIRES + 1) is None
    assert verify(b"x" * 32, "user-1", value, now=NOW) is None
    assert verify(KEY, "user-1", "", now=NOW) is None
    assert verify(KEY, "user-1", "v2.a.b.c", now=NOW) is None
    assert verify(KEY, "user-1", "v2.notbase64!.abc", now=NOW) is None
    tampered = value[:-1] + ("0" if value[-1] != "0" else "1")
    assert verify(KEY, "user-1", tampered, now=NOW) is None


def test_payload_cannot_be_swapped_under_the_same_mac() -> None:
    version, _payload, mac = _sign().split(".")
    _v, other_payload, _mac = _sign(tools=[*TOOLS, "finops___get_anomalies"]).split(".")
    assert verify(KEY, "user-1", f"{version}.{other_payload}.{mac}", now=NOW) is None


@pytest.mark.parametrize(
    "payload",
    [
        ["not", "an", "object"],
        {"exp": EXPIRES, "agent": "finops", "ver": 1, "tools": []},
        {"sub": "user-1", "exp": "soon", "agent": "finops", "ver": 1, "tools": []},
        {"sub": "user-1", "exp": True, "agent": "finops", "ver": 1, "tools": []},
        {"sub": "user-1", "exp": EXPIRES, "ver": 1, "tools": []},
        {"sub": "user-1", "exp": EXPIRES, "agent": "finops", "ver": "1", "tools": []},
        {"sub": "user-1", "exp": EXPIRES, "agent": "finops", "ver": 1},
        {"sub": "user-1", "exp": EXPIRES, "agent": "finops", "ver": 1, "tools": "finops___x"},
        {"sub": "user-1", "exp": EXPIRES, "agent": "finops", "ver": 1, "tools": [1]},
    ],
)
def test_well_signed_but_malformed_payload_is_rejected(payload: Any) -> None:
    assert verify(KEY, "user-1", _forge(payload), now=NOW) is None


def test_legacy_signature_is_rejected() -> None:
    # v1 names no agent: it would let any agent call every tool of its user (TM-M12).
    assert verify(KEY, "user-1", _legacy(), now=NOW) is None
    assert verify(KEY, "user-1", "v1.notanint.abc", now=NOW) is None


@pytest.mark.parametrize(
    "overrides",
    [
        {"agent_id": "Fin Ops"},
        {"agent_id": ""},
        {"agent_version": 0},
        {"tools": ["get_cost_and_usage"]},
        {"tools": ["finops___bad name"]},
        {"tools": [f"finops___tool_{i}" for i in range(101)]},
    ],
)
def test_sign_refuses_what_it_could_not_vouch_for(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValueError, match="invalid invocation"):
        _sign(**overrides)


def test_sign_refuses_an_empty_subject_and_an_oversized_header() -> None:
    with pytest.raises(ValueError, match="invalid invocation"):
        _sign(subject="")
    many = [f"{'t' * 48}___{'x' * 60}{i:04d}" for i in range(100)]
    with pytest.raises(ValueError, match="too large"):
        _sign(tools=many)
    assert len(_sign()) < MAX_HEADER_CHARS


# --- Knowledge bases of the version (D88 (14)) ------------------------------------------

KB_A = "01JABCDEFGHJKMNPQRSTVWXYZ0"
KB_B = "01JABCDEFGHJKMNPQRSTVWXYZ1"


def test_the_knowledge_bases_of_the_version_are_signed() -> None:
    signed = verify(KEY, "user-1", _sign(knowledge_bases=[KB_B, KB_A, KB_B]), now=NOW)
    assert signed is not None
    assert signed.knowledge_bases == (KB_A, KB_B)


def test_a_signature_without_knowledge_bases_is_as_before() -> None:
    # The claim is only there when the version has some: the signature of an agent without
    # knowledge bases does not change.
    value = _sign()
    payload = json.loads(base64.urlsafe_b64decode(value.split(".")[1] + "=="))
    assert "kbs" not in payload
    signed = verify(KEY, "user-1", value, now=NOW)
    assert signed is not None
    assert signed.knowledge_bases == ()


@pytest.mark.parametrize(
    "kbs",
    [
        ["../kb/otra"],
        ["01jabcdefghjkmnpqrstvwxyz0"],
        [f"01JABCDEFGHJKMNPQRSTVWXYZ{i}" for i in range(6)],
    ],
)
def test_only_ids_of_knowledge_bases_are_signed(kbs: list[str]) -> None:
    with pytest.raises(ValueError, match="invalid invocation"):
        _sign(knowledge_bases=kbs)


@pytest.mark.parametrize(
    "kbs",
    [
        "01JABCDEFGHJKMNPQRSTVWXYZ0",
        ["../kb/otra"],
        [1],
        [f"01JABCDEFGHJKMNPQRSTVWXYZ{i}" for i in range(6)],
    ],
)
def test_a_signed_claim_that_is_not_a_list_of_ids_is_refused(kbs: object) -> None:
    payload = {
        "sub": "user-1",
        "exp": EXPIRES,
        "agent": "finops",
        "ver": 3,
        "tools": TOOLS,
        "kbs": kbs,
    }
    assert verify(KEY, "user-1", _forge(payload), now=NOW) is None


def test_a_playground_test_is_signed_as_such() -> None:
    signed = verify(KEY, "user-1", _sign(playground=True), now=NOW)
    assert signed is not None
    assert signed.playground is True


def test_an_ordinary_signature_is_not_a_playground_test() -> None:
    # Without the claim, nothing changes in the signature of a chat turn or a task run.
    value = _sign()
    payload = json.loads(base64.urlsafe_b64decode(value.split(".")[1] + "=="))
    assert "pg" not in payload
    signed = verify(KEY, "user-1", value, now=NOW)
    assert signed is not None
    assert signed.playground is False


def test_the_playground_claim_is_under_the_mac() -> None:
    # Dropping the claim from a test's payload breaks its MAC: a test never passes for a turn.
    _, encoded, mac = _sign(playground=True).split(".")
    payload = json.loads(base64.urlsafe_b64decode(encoded + "=="))
    del payload["pg"]
    stripped = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    assert verify(KEY, "user-1", f"v2.{stripped}.{mac}", now=NOW) is None


@pytest.mark.parametrize("value", [1, "true", None, []])
def test_a_playground_claim_that_is_not_a_boolean_is_refused(value: object) -> None:
    payload = {"sub": "user-1", "exp": EXPIRES, "agent": "finops", "ver": 3, "tools": TOOLS}
    assert verify(KEY, "user-1", _forge({**payload, "pg": value}), now=NOW) is None


# --- Calls of «Mis conexiones»: the claim ``cx`` (D97 (3), D98 (15)) ----------------------

PROBE = "remote-abcdefghij23___core_list_projects"
# Pinned before the claim existed: a signature without ``cx`` must stay the same, byte by byte.
PINNED = (
    "v2.eyJhZ2VudCI6ImZpbm9wcyIsImV4cCI6MjAwMDAwMDAwMCwic3ViIjoidXNlci0xIiwidG9vbHMiOlsiZmlub3"
    "BzX19fZ2V0X2Nvc3RfYW5kX3VzYWdlIiwiZmlub3BzX19fbGlzdF9hY2NvdW50c19pbl9zY29wZSJdLCJ2ZXIiOjN9"
    ".9e8a567d4441c83011cf32e89bfe536fb0057f982be6b0feb81722e6ecd22709"
)
PINNED_PLAYGROUND = (
    "v2.eyJhZ2VudCI6ImZpbm9wcyIsImV4cCI6MjAwMDAwMDAwMCwicGciOnRydWUsInN1YiI6InVzZXItMSIsInRvb2"
    "xzIjpbImZpbm9wc19fX2dldF9jb3N0X2FuZF91c2FnZSJdLCJ2ZXIiOjN9"
    ".7a264e07cc2e13c8db2a4a0bf837c9753e95da42510ad75a5e19b209aac4d661"
)


def _connection(connection: str = "connect", **overrides: Any) -> str:
    args: dict[str, Any] = {
        "agent_id": "mangoconn",
        "agent_version": 1,
        "tools": [PROBE],
        "connection": connection,
    }
    return sign(KEY, "user-1", EXPIRES, **{**args, **overrides})


def test_a_signature_without_the_claim_is_the_same_byte_by_byte() -> None:
    assert _sign() == PINNED
    assert _sign(tools=[TOOLS[0]], playground=True) == PINNED_PLAYGROUND
    signed = verify(KEY, "user-1", PINNED, now=NOW)
    assert signed is not None
    assert signed.connection is None


@pytest.mark.parametrize("connection", ["connect", "disconnect"])
def test_a_connection_call_is_signed_as_such(connection: str) -> None:
    value = _connection(connection)
    payload = json.loads(base64.urlsafe_b64decode(value.split(".")[1] + "=="))
    assert payload["cx"] == connection
    assert verify(KEY, "user-1", value, now=NOW) == Invocation(
        subject="user-1",
        agent_id="mangoconn",
        agent_version=1,
        tools=frozenset({PROBE}),
        expires_at=EXPIRES,
        connection=connection,  # type: ignore[arg-type]
    )


@pytest.mark.parametrize(
    "overrides",
    [
        {"tools": [PROBE, "remote-abcdefghij23___search_wiki"]},
        {"tools": []},
        {"tools": ["finops___get_cost_and_usage"]},
        {"tools": ["remote-ABCDEFGHIJ23___core_list_projects"]},
        {"tools": ["remote-abc___core_list_projects"]},
        {"agent_id": "finops"},
        {"agent_version": 2},
        {"knowledge_bases": [KB_A]},
        {"playground": True},
        {"connection": "revoke"},
    ],
)
def test_a_connection_call_is_one_remote_tool_of_the_reserved_agent(
    overrides: dict[str, Any],
) -> None:
    with pytest.raises(ValueError, match="invalid invocation"):
        _connection(**overrides)


def test_no_agent_signs_as_the_reserved_one_without_the_claim() -> None:
    with pytest.raises(ValueError, match="invalid invocation"):
        _sign(agent_id="mangoconn", agent_version=1, tools=[PROBE])


CONNECTION_PAYLOAD: dict[str, Any] = {
    "sub": "user-1",
    "exp": EXPIRES,
    "agent": "mangoconn",
    "ver": 1,
    "tools": [PROBE],
    "cx": "disconnect",
}


@pytest.mark.parametrize(
    "overrides",
    [
        {"cx": "revoke"},
        {"cx": True},
        {"cx": None},
        {"agent": "finops"},
        {"ver": 2},
        {"tools": [PROBE, "remote-abcdefghij23___search_wiki"]},
        {"tools": ["finops___get_cost_and_usage"]},
        {"kbs": [KB_A]},
        {"pg": True},
    ],
)
def test_a_well_signed_connection_call_of_another_shape_is_refused(
    overrides: dict[str, Any],
) -> None:
    assert verify(KEY, "user-1", _forge(CONNECTION_PAYLOAD), now=NOW) is not None
    assert verify(KEY, "user-1", _forge({**CONNECTION_PAYLOAD, **overrides}), now=NOW) is None


def test_the_reserved_agent_without_the_claim_is_refused() -> None:
    payload = {key: value for key, value in CONNECTION_PAYLOAD.items() if key != "cx"}
    assert verify(KEY, "user-1", _forge(payload), now=NOW) is None


def test_the_connection_claim_is_under_the_mac() -> None:
    # Turning a connect into a disconnect breaks the MAC.
    _, encoded, mac = _connection("connect").split(".")
    payload = json.loads(base64.urlsafe_b64decode(encoded + "=="))
    payload["cx"] = "disconnect"
    swapped = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    assert verify(KEY, "user-1", f"v2.{swapped}.{mac}", now=NOW) is None
