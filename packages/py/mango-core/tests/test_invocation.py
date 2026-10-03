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
