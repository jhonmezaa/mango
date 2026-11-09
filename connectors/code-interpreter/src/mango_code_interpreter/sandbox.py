"""The Code Interpreter of the installation, as the connector uses it (D114 (3), (4)).

Four calls only: start a session, invoke one of its tools (``executeCode``, ``listFiles``,
``readFiles``, ``writeFiles``), stop it.

The file tools take paths relative to the session's working directory (``root``): the service
refuses an absolute path («potential path traversal», seen on a customer install), and answers
``file:///<relative path>``. The rest of the connector keeps absolute paths (the ones the cells
see); this module turns them into relative ones going in and back into absolute ones coming out.

A ``sessionId`` goes in and out of this module and nowhere else: no error, log or result here
carries it (TM-CI1). Service errors are rewritten to the kinds of
``SandboxError``, never their message.
"""

from __future__ import annotations

import base64
import contextlib
import posixpath
import secrets
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from botocore.exceptions import BotoCoreError, ClientError, ReadTimeoutError

from mango_core.code_sandbox import SESSION_SECONDS

ErrorKind = Literal["busy", "unavailable", "timeout", "gone"]
_STREAM_ERRORS: Mapping[str, ErrorKind] = {
    "throttlingException": "busy",
    "serviceQuotaExceededException": "busy",
    "resourceNotFoundException": "gone",
    "conflictException": "gone",
    "accessDeniedException": "unavailable",
    "internalServerException": "unavailable",
    "validationException": "unavailable",
}
WRITE_CALL_BYTES = 90 * 1024 * 1024
"""What one ``writeFiles`` call carries at most (the API takes up to 100 MB inline)."""
_BUSY_CODES = frozenset({"ThrottlingException", "ServiceQuotaExceededException"})
_GONE_CODES = frozenset({"ResourceNotFoundException", "ConflictException"})


class SandboxError(Exception):
    """A call to the sandbox failed; ``kind`` says how, never with the service's words."""

    def __init__(self, kind: ErrorKind) -> None:
        super().__init__(kind)
        self.kind: ErrorKind = kind


@dataclass(frozen=True)
class Blob:
    path: str
    data: bytes
    mime: str | None


@dataclass(frozen=True)
class Listing:
    name: str
    size: int | None
    mime: str | None


@dataclass
class Result:
    """What one call of a sandbox tool answered."""

    stdout: str = ""
    stderr: str = ""
    is_error: bool = False
    blobs: list[Blob] = field(default_factory=list)
    texts: list[tuple[str, str]] = field(default_factory=list)
    """``(path, text)`` of the files ``readFiles`` returned as text."""
    listing: list[Listing] = field(default_factory=list)


def relative(root: str, path: str) -> str:
    """``path`` (absolute, inside ``root``) as the file tools take it: relative to ``root``.
    Anything outside ``root`` is refused here, before the service sees it."""
    base = posixpath.normpath(root)
    full = posixpath.normpath(path if path.startswith("/") else posixpath.join(base, path))
    if not base.startswith("/") or not full.startswith(base.rstrip("/") + "/"):
        raise SandboxError("unavailable")
    return posixpath.relpath(full, base)


def _absolute(root: str, path: str) -> str:
    """A path the service answered (``/<relative>`` once ``file://`` is gone) as the cells see
    it: under ``root``."""
    base = posixpath.normpath(root).rstrip("/")
    if path == base or path.startswith(base + "/"):
        return path
    return posixpath.join(base, path.lstrip("/"))


def _absolute_paths(result: Result, root: str) -> Result:
    result.blobs = [Blob(_absolute(root, b.path), b.data, b.mime) for b in result.blobs]
    result.texts = [(_absolute(root, p), t) for p, t in result.texts]
    return result


def _kind(exc: ClientError) -> ErrorKind:
    code = exc.response.get("Error", {}).get("Code", "")
    if code in _BUSY_CODES:
        return "busy"
    if code in _GONE_CODES:
        return "gone"
    return "unavailable"


class Sandbox:
    """One Code Interpreter (its id) through a ``bedrock-agentcore`` client. ``slow`` is the
    client for ``executeCode``, whose read timeout is longer than a cell."""

    def __init__(self, client: Any, slow: Any, interpreter_id: str) -> None:
        self._client = client
        self._slow = slow
        self._id = interpreter_id

    def start(self) -> str:
        """A new session; its name carries nothing of the person (TM-CI1)."""
        try:
            response = self._client.start_code_interpreter_session(
                codeInterpreterIdentifier=self._id,
                name=f"mango-{secrets.token_hex(8)}",
                sessionTimeoutSeconds=SESSION_SECONDS,
            )
        except ClientError as exc:
            raise SandboxError(_kind(exc)) from None
        except BotoCoreError:
            raise SandboxError("unavailable") from None
        session_id = response.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            raise SandboxError("unavailable")
        return session_id

    def stop(self, session_id: str) -> None:
        """Best effort: a session that is already gone is not an error."""
        with contextlib.suppress(ClientError, BotoCoreError):
            self._client.stop_code_interpreter_session(
                codeInterpreterIdentifier=self._id, sessionId=session_id
            )

    def execute(self, session_id: str, code: str) -> Result:
        return self._invoke(
            self._slow, session_id, "executeCode", {"code": code, "language": "python"}
        )

    def list_files(self, session_id: str, directory: str, *, root: str) -> Result:
        result = self._invoke(
            self._client, session_id, "listFiles", {"directoryPath": relative(root, directory)}
        )
        return _absolute_paths(result, root)

    def write_file(self, session_id: str, path: str, data: bytes, *, root: str) -> None:
        """One file into the session (``writeFiles``, up to 100 MB a call)."""
        content = [{"path": relative(root, path), "blob": data}]
        result = self._invoke(self._client, session_id, "writeFiles", {"content": content})
        if result.is_error:
            raise SandboxError("unavailable")

    def write_files(
        self, session_id: str, files: Iterable[tuple[str, bytes]], *, root: str
    ) -> None:
        """Several files into the session, in as few ``writeFiles`` calls as their size
        allows (each one under ``WRITE_CALL_BYTES``)."""
        batch: list[dict[str, Any]] = []
        size = 0
        for path, data in files:
            if batch and size + len(data) > WRITE_CALL_BYTES:
                self._write(session_id, batch)
                batch, size = [], 0
            batch.append({"path": relative(root, path), "blob": data})
            size += len(data)
        if batch:
            self._write(session_id, batch)

    def _write(self, session_id: str, content: list[dict[str, Any]]) -> None:
        result = self._invoke(self._client, session_id, "writeFiles", {"content": content})
        if result.is_error:
            raise SandboxError("unavailable")

    def read_files(self, session_id: str, paths: Iterable[str], *, root: str) -> Result:
        wanted = [relative(root, p) for p in paths]
        result = self._invoke(self._client, session_id, "readFiles", {"paths": wanted})
        return _absolute_paths(result, root)

    def _invoke(self, client: Any, session_id: str, name: str, arguments: dict[str, Any]) -> Result:
        try:
            response = client.invoke_code_interpreter(
                codeInterpreterIdentifier=self._id,
                sessionId=session_id,
                name=name,
                arguments=arguments,
            )
            return _collect(response.get("stream") or [])
        except ReadTimeoutError:
            raise SandboxError("timeout") from None
        except ClientError as exc:
            raise SandboxError(_kind(exc)) from None
        except BotoCoreError:
            raise SandboxError("unavailable") from None


def _collect(stream: Iterable[dict[str, Any]]) -> Result:
    out = Result()
    for event in stream:
        for key, kind in _STREAM_ERRORS.items():
            if key in event:
                raise SandboxError(kind)
        result = event.get("result")
        if not isinstance(result, dict):
            continue
        out.is_error = out.is_error or bool(result.get("isError"))
        structured = result.get("structuredContent") or {}
        out.stdout += str(structured.get("stdout") or "")
        out.stderr += str(structured.get("stderr") or "")
        texts: list[str] = []
        for block in result.get("content") or []:
            _block(out, block, texts)
        if not structured and texts:
            # Without the structured part, the text blocks are the output.
            out.stdout += "".join(texts)
    return out


def _block(out: Result, block: dict[str, Any], texts: list[str]) -> None:
    kind = block.get("type")
    if kind == "text":
        texts.append(str(block.get("text") or ""))
    elif kind == "resource_link":
        size = block.get("size")
        out.listing.append(
            Listing(
                name=str(block.get("name") or block.get("uri") or ""),
                size=size if isinstance(size, int) else None,
                mime=block.get("mimeType"),
            )
        )
    elif kind == "resource":
        resource = block.get("resource") or {}
        path = _path_of(str(resource.get("uri") or block.get("name") or ""))
        if resource.get("blob") is not None:
            out.blobs.append(Blob(path, _bytes(resource["blob"]), resource.get("mimeType")))
        elif resource.get("text") is not None:
            out.texts.append((path, str(resource["text"])))
    elif kind == "image" and block.get("data") is not None:
        out.blobs.append(
            Blob(
                _path_of(str(block.get("name") or "")), _bytes(block["data"]), block.get("mimeType")
            )
        )


def _bytes(value: Any) -> bytes:
    if isinstance(value, bytes | bytearray):
        return bytes(value)
    return base64.b64decode(str(value))


def _path_of(uri: str) -> str:
    return uri.removeprefix("file://")
