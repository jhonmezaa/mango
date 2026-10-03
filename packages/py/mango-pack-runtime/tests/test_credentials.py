"""Caller isolation (closes S-M1): two identities at once never share AWS credentials.

Real botocore signing, no network: every request is answered locally with the access key
that signed it. The upstream patterns are the ones of the awslabs servers: a new boto3 session
per call, a client cached across calls, and sync boto3 calls from worker threads.
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any

import boto3
import pytest
from botocore.credentials import ReadOnlyCredentials

from mango_pack_runtime import credentials
from mango_pack_runtime.credentials import NoCallerError
from mango_pack_runtime.identity import Caller

from .conftest import TOOL, echo_signer, keys_of


def _caller(subject: str) -> Caller:
    return Caller(subject=subject, tool=TOOL, agent_id="finops", central=True)


def _client() -> Any:
    client = boto3.Session(region_name="us-east-1").client("sts")
    echo_signer(client)
    return client


def _who(client: Any | None = None) -> str:
    """Access key the request was signed with."""
    return str((client or _client()).get_caller_identity()["Arn"])


def test_a_call_signs_with_its_caller(bound: None) -> None:
    with credentials.calling(_caller("alice"), keys_of):
        assert _who() == "AKIA-alice"
        assert credentials.current_caller() == _caller("alice")
    assert credentials.current_caller() is None


def test_outside_a_call_nothing_is_signed_not_even_with_the_pack_role(bound: None) -> None:
    client = _client()  # created at import time by an upstream server
    with pytest.raises(NoCallerError):
        _who(client)
    # A background thread the server started has no caller either.
    errors: list[BaseException] = []

    def background() -> None:
        try:
            _who(client)
        except BaseException as exc:  # noqa: BLE001 - recorded for the assertion
            errors.append(exc)

    with credentials.calling(_caller("alice"), keys_of):
        thread = threading.Thread(target=background)
        thread.start()
        thread.join()
    assert [type(e) for e in errors] == [NoCallerError]


def test_a_client_cached_across_calls_follows_the_caller(bound: None) -> None:
    cached = _client()
    for subject in ("alice", "bob", "alice"):
        with credentials.calling(_caller(subject), keys_of):
            assert _who(cached) == f"AKIA-{subject}"


def test_one_session_is_assumed_per_call(bound: None) -> None:
    assumed: list[str] = []

    def assume(caller: Caller) -> ReadOnlyCredentials:
        assumed.append(caller.subject)
        return keys_of(caller)

    client = _client()
    with credentials.calling(_caller("alice"), assume):
        for _ in range(3):
            _who(client)
        _who()
    with credentials.calling(_caller("alice"), assume):
        _who(client)
    # Nothing is kept between calls: each one assumes its own session (D37).
    assert assumed == ["alice", "alice"]


def test_concurrent_callers_never_cross(bound: None) -> None:
    cached = _client()

    async def tool(subject: str, n: int) -> set[str]:
        seen: set[str] = set()
        with credentials.calling(_caller(subject), keys_of):
            for i in range(4):
                await asyncio.sleep(0)  # let the other callers run in between
                if (n + i) % 3 == 0:
                    seen.add(_who(cached))  # cached client, event loop thread
                elif (n + i) % 3 == 1:
                    seen.add(await asyncio.to_thread(_who))  # fresh session, worker thread
                else:
                    seen.add(await asyncio.to_thread(_who, cached))
        return seen

    async def main() -> list[tuple[str, set[str]]]:
        subjects = [f"user-{n % 5}" for n in range(60)]
        results = await asyncio.gather(*(tool(s, n) for n, s in enumerate(subjects)))
        return list(zip(subjects, results, strict=True))

    for subject, seen in asyncio.run(main()):
        assert seen == {f"AKIA-{subject}"}


def test_a_failed_assume_fails_the_request_and_is_not_cached(bound: None) -> None:
    attempts: list[int] = []

    def assume(caller: Caller) -> ReadOnlyCredentials:
        attempts.append(1)
        if len(attempts) == 1:
            raise PermissionError("broker said no")
        return keys_of(caller)

    with credentials.calling(_caller("alice"), assume):
        with pytest.raises(PermissionError):
            _who()
        assert _who() == "AKIA-alice"


def test_explicit_credentials_are_left_alone(bound: None) -> None:
    client = boto3.client(
        "sts", region_name="us-east-1", aws_access_key_id="AKIA-EXPLICIT", aws_secret_access_key="s"
    )
    echo_signer(client)
    assert _who(client) == "AKIA-EXPLICIT"


def test_only_the_first_hop_uses_the_pack_role(bound: None) -> None:
    sts = credentials.platform_session().client("sts", region_name="us-east-1")
    echo_signer(sts)
    # Usable anywhere afterwards: it holds the pack role's keys, to assume the broker.
    assert _who(sts) == "AKIA-PACK-ROLE"
    # Nothing leaks: the next client is the caller's again, on a new session or on boto3's
    # default one (`boto3.client`), which keeps the first credentials it resolves.
    default = boto3.client("sts", region_name="us-east-1")
    echo_signer(default)
    for client in (None, default):
        with pytest.raises(NoCallerError):
            _who(client)
        with credentials.calling(_caller("alice"), keys_of):
            assert _who(client) == "AKIA-alice"


def test_a_default_session_from_before_the_install_is_discarded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An upstream module that touched ``boto3.client`` before the entry point installed the
    caller's credentials must not keep the pack role's keys for later calls."""
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIA-PACK-ROLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "s")
    monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)
    monkeypatch.delenv("AWS_PROFILE", raising=False)
    boto3.DEFAULT_SESSION = None
    early = boto3.client("sts", region_name="us-east-1")
    echo_signer(early)
    assert _who(early) == "AKIA-PACK-ROLE"
    credentials.install()
    try:
        late = boto3.client("sts", region_name="us-east-1")
        echo_signer(late)
        with credentials.calling(_caller("alice"), keys_of):
            assert _who(late) == "AKIA-alice"
    finally:
        credentials.uninstall()


def test_install_is_idempotent_and_reversible(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIA-PACK-ROLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "s")
    monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)
    credentials.install()
    credentials.install()
    with pytest.raises(NoCallerError):
        _who()
    credentials.uninstall()
    credentials.uninstall()
    assert _who() == "AKIA-PACK-ROLE"
