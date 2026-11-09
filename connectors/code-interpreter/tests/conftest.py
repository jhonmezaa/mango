"""A fake Code Interpreter for the connector's tests: sessions are real Python processes
(``fake_kernel.py``) working in a temporary folder, reached through the same four calls and
the same event stream shapes the connector reads from ``bedrock-agentcore``. No AWS."""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError, ReadTimeoutError

KERNEL = Path(__file__).with_name("fake_kernel.py")
SLOW_MARKER = "# fake: never returns"
"""A cell with this line makes the fake time out like a read timeout of the client."""


_TRAVERSAL = {
    "result": {
        "content": [
            {
                "type": "text",
                "text": "Error executing tool: Invalid file path: potential path traversal",
            }
        ],
        "isError": True,
    }
}


def _relative_ok(path: str) -> bool:
    """What the real file tools accept: a path relative to the session's folder, without ``..``."""
    return bool(path) and not path.startswith("/") and ".." not in path.split("/")


@dataclass
class _Session:
    process: subprocess.Popen[str]
    root: Path
    stopped: bool = False


@dataclass
class FakeAgentCore:
    """``start/stop_code_interpreter_session`` and ``invoke_code_interpreter`` over local
    processes. ``/mnt/data`` in the code is mapped to the session's ``data`` folder (the test
    machine has no such folder, and must not get one). Like the real service, the file tools take
    only paths relative to the session's folder: an absolute path or one with ``..`` answers
    ``isError`` («potential path traversal detected»), and paths come back as
    ``file:///<relative path>``."""

    base: Path
    interpreter_id: str = "Mango_poc_sandbox-abcdefghij"
    sessions: dict[str, _Session] = field(default_factory=dict)
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    start_error: str | None = None
    invoke_error: str | None = None
    stream_error: str | None = None

    def start_code_interpreter_session(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("start", kwargs))
        assert kwargs["codeInterpreterIdentifier"] == self.interpreter_id
        if self.start_error:
            raise ClientError({"Error": {"Code": self.start_error, "Message": "x"}}, "Start")
        session_id = secrets.token_hex(20)
        # A folder name of its own: the session id must not show up through a path.
        root = self.base / secrets.token_hex(6)
        root.mkdir(parents=True)
        process = subprocess.Popen(  # noqa: S603 - the test's own kernel
            [sys.executable, str(KERNEL)],
            cwd=root,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        self.sessions[session_id] = _Session(process, root)
        return {"sessionId": session_id, "codeInterpreterIdentifier": self.interpreter_id}

    def stop_code_interpreter_session(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("stop", kwargs))
        session = self.sessions.get(kwargs["sessionId"])
        if session is not None and not session.stopped:
            session.stopped = True
            session.process.kill()
            session.process.wait()
        return {}

    def invoke_code_interpreter(self, **kwargs: Any) -> dict[str, Any]:  # noqa: PLR0911
        self.calls.append((kwargs["name"], kwargs))
        if self.invoke_error:
            raise ClientError({"Error": {"Code": self.invoke_error, "Message": "x"}}, "Invoke")
        session = self.sessions.get(kwargs["sessionId"])
        if session is None or session.stopped:
            raise ClientError({"Error": {"Code": "ResourceNotFoundException"}}, "Invoke")
        if self.stream_error:
            return {"stream": [{self.stream_error: {"message": "x"}}]}
        args, name = kwargs["arguments"], kwargs["name"]
        if name == "executeCode":
            return {"stream": [self._execute(session, args["code"])]}
        if name == "readFiles":
            if not all(_relative_ok(p) for p in args["paths"]):
                return {"stream": [_TRAVERSAL]}
            return {"stream": [self._read(session, args["paths"])]}
        if name == "writeFiles":
            if not all(_relative_ok(item["path"]) for item in args["content"]):
                return {"stream": [_TRAVERSAL]}
            for item in args["content"]:
                real = session.root / item["path"]
                real.parent.mkdir(parents=True, exist_ok=True)
                real.write_bytes(item["blob"])
            return {"stream": [{"result": {"content": []}}]}
        if name == "listFiles":
            if not _relative_ok(args["directoryPath"]):
                return {"stream": [_TRAVERSAL]}
            return {"stream": [self._list(session, args["directoryPath"])]}
        raise AssertionError(name)

    def data_root(self, session_id: str) -> Path:
        return self.sessions[session_id].root / "data"

    def _map(self, session: _Session, text: str) -> str:
        return text.replace("/mnt/data", str(session.root / "data"))

    def _execute(self, session: _Session, code: str) -> dict[str, Any]:
        if SLOW_MARKER in code:
            raise ReadTimeoutError(endpoint_url="https://bedrock-agentcore")
        assert session.process.stdin is not None
        assert session.process.stdout is not None
        session.process.stdin.write(json.dumps({"code": self._map(session, code)}) + "\n")
        session.process.stdin.flush()
        answer = json.loads(session.process.stdout.readline())
        return {
            "result": {
                "content": [{"type": "text", "text": answer["stdout"]}],
                "structuredContent": {"stdout": answer["stdout"], "stderr": answer["stderr"]},
                "isError": answer["error"],
            }
        }

    def _read(self, session: _Session, paths: list[str]) -> dict[str, Any]:
        content = []
        for path in paths:
            real = session.root / path
            if real.is_file():
                content.append(
                    {
                        "type": "resource",
                        "resource": {"uri": f"file:///{path}", "blob": real.read_bytes()},
                    }
                )
        return {"result": {"content": content}}

    def _list(self, session: _Session, directory: str) -> dict[str, Any]:
        real = session.root / directory
        content = [
            {
                "type": "resource_link",
                "uri": f"file:///{directory}/{p.name}",
                "name": p.name,
                "size": p.stat().st_size,
            }
            for p in sorted(real.iterdir())
            if p.is_file()
        ]
        return {"result": {"content": content}}

    def close(self) -> None:
        for session in self.sessions.values():
            if not session.stopped:
                session.process.kill()
                session.process.wait()


@pytest.fixture
def agentcore(tmp_path: Path) -> Iterator[FakeAgentCore]:
    fake = FakeAgentCore(tmp_path / "sandbox")
    yield fake
    fake.close()
