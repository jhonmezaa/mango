"""AWS credentials of a pack that reads account data: the caller's, on every call (D37, rule 5).

Upstream servers (awslabs) build their boto3 clients from the default credential chain of the
process and take no credentials per call (S-M1). So instead of replacing their internal
functions, the default chain itself is replaced: every client the server creates signs with
one credentials object whose keys are resolved **when a request is signed**, from the tool
call running in the current context:

* inside a tool call with a verified caller, the keys are those of a session assumed for that
  call through the broker (``pack role -> broker -> target role``) with ``SourceIdentity`` =
  the user and a session policy limited to the actions of the signed manifest;
* anywhere else (import time, ``tools/list``, a background thread the server started) there
  is no caller and signing fails. Nothing falls back to the pack's own role, which holds no
  data permission to begin with: all it can do is assume the broker.

``boto3.client(...)`` and ``boto3.resource(...)`` use a process-wide default session that
keeps the first credentials it resolved, so ``install`` discards that session, and the one
client that signs with the pack role (the first hop to the broker) is built on a private
session. The entry point installs this before it imports the upstream server.

The call is carried by a ``ContextVar``: each request runs in its own task, and worker
threads started for it (``anyio.to_thread``, ``asyncio.to_thread``) inherit its context. A
client cached across calls is safe because it holds this object, not a set of keys.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar

import boto3
from botocore.credentials import CredentialResolver, Credentials, ReadOnlyCredentials

from mango_pack_runtime.identity import Caller

METHOD = "mango-pack-caller"

Assume = Callable[[Caller], ReadOnlyCredentials]
"""Assumes the broker chain for one caller and returns the keys of that session."""


class NoCallerError(Exception):
    """An AWS request was about to be signed outside a tool call with a verified caller."""


class _Call:
    """One tool call: its caller and the session assumed for it (at most one)."""

    def __init__(self, caller: Caller, assume: Assume) -> None:
        self.caller = caller
        self._assume = assume
        self._lock = threading.Lock()
        self._frozen: ReadOnlyCredentials | None = None

    def frozen(self) -> ReadOnlyCredentials:
        # A tool may sign from several threads; they share the session of the call.
        with self._lock:
            if self._frozen is None:
                self._frozen = self._assume(self.caller)
            return self._frozen


_current: ContextVar[_Call | None] = ContextVar("mango_pack_call", default=None)
# Set only while this module builds its own client with the pack role (the first hop).
_platform: ContextVar[bool] = ContextVar("mango_pack_platform", default=False)


class CallerCredentials(Credentials):
    """Credentials that are always the ones of the caller of the current tool call."""

    def __init__(self) -> None:
        # No keys are stored: the base attributes are replaced by the properties below.
        self.method = METHOD

    def get_frozen_credentials(self) -> ReadOnlyCredentials:
        call = _current.get()
        if call is None:
            raise NoCallerError("no verified caller in this context")
        return call.frozen()

    @property
    def access_key(self) -> str:  # type: ignore[override]
        return str(self.get_frozen_credentials().access_key)

    @property
    def secret_key(self) -> str:  # type: ignore[override]
        return str(self.get_frozen_credentials().secret_key)

    @property
    def token(self) -> str:  # type: ignore[override]
        return str(self.get_frozen_credentials().token)

    @property
    def account_id(self) -> None:
        return None


_BOUND = CallerCredentials()
_original_load: Callable[[CredentialResolver], Credentials | None] | None = None
_install_lock = threading.Lock()


def install() -> None:
    """Make the default credential chain of this process resolve to the caller's.

    Idempotent. Credentials given explicitly to a client or a session are not affected.
    """
    global _original_load  # noqa: PLW0603 - process-wide patch, applied once
    with _install_lock:
        if _original_load is not None:
            return
        original = CredentialResolver.load_credentials

        def load_credentials(self: CredentialResolver) -> Credentials | None:
            if _platform.get():
                return original(self)
            return _BOUND

        _original_load = original
        CredentialResolver.load_credentials = load_credentials  # type: ignore[method-assign]
        # A default session created earlier may already hold the pack role's keys.
        boto3.DEFAULT_SESSION = None


def uninstall() -> None:
    """Undo ``install`` (tests)."""
    global _original_load  # noqa: PLW0603
    with _install_lock:
        if _original_load is not None:
            CredentialResolver.load_credentials = _original_load  # type: ignore[method-assign,assignment]
            _original_load = None
            boto3.DEFAULT_SESSION = None


def platform_session() -> boto3.Session:
    """A private session that signs with the pack's own role: only for the first hop to the
    broker. Its credentials are resolved here and stay in this session; the default session
    and every session the upstream server creates keep resolving to the caller's."""
    token = _platform.set(True)
    try:
        session = boto3.Session()
        session.get_credentials()
    finally:
        _platform.reset(token)
    return session


@contextmanager
def calling(caller: Caller, assume: Assume) -> Iterator[None]:
    """Run a tool call as ``caller``: AWS requests signed inside use a session assumed for it."""
    token = _current.set(_Call(caller, assume))
    try:
        yield
    finally:
        _current.reset(token)


def current_caller() -> Caller | None:
    call = _current.get()
    return call.caller if call is not None else None
