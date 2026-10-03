"""Start a pack's server and read its `tools/list` result (spec §4.2 step 4).

The server is third-party code. It runs with an empty environment (no CI secrets, no AWS
credentials), bound to loopback, and only for as long as the listing takes.

Standard library only: in CI this file runs by itself inside a container without network,
next to the unpacked zip (`python -S probe.py <directory> <entrypoint> <path>`), and prints
the result as JSON. The caller treats that output as untrusted.
"""

from __future__ import annotations

import http.client
import json
import socket
import subprocess
import sys
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

_HOST = "127.0.0.1"
_START_TIMEOUT_SECONDS = 90.0
_REQUEST_TIMEOUT_SECONDS = 30.0
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
_PROTOCOL_VERSION = "2025-06-18"


class ProbeError(Exception):
    """The pack server did not start or did not answer `tools/list`."""


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind((_HOST, 0))
        return int(probe.getsockname()[1])


@contextmanager
def running_server(directory: Path, command: list[str]) -> Iterator[int]:
    port = _free_port()
    with tempfile.TemporaryDirectory() as home:
        environment = {
            "PATH": "/usr/bin:/bin",
            "HOME": home,
            "MANGO_PACK_HOST": _HOST,
            "MANGO_PACK_PORT": str(port),
            "AWS_REGION": "us-east-1",
            "AWS_EC2_METADATA_DISABLED": "true",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        process = subprocess.Popen(  # noqa: S603 - fixed argument list, no shell
            command,
            cwd=directory,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        try:
            _wait_until_listening(process, port)
            yield port
        finally:
            process.kill()
            process.wait()
            if process.stderr is not None:
                process.stderr.close()


def _wait_until_listening(process: subprocess.Popen[bytes], port: int) -> None:
    deadline = time.monotonic() + _START_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            stderr = process.stderr.read().decode(errors="replace") if process.stderr else ""
            raise ProbeError(f"the pack server exited at startup:\n{stderr[-4000:]}")
        try:
            with socket.create_connection((_HOST, port), timeout=1):
                return
        except OSError:
            time.sleep(0.2)
    raise ProbeError("the pack server did not start listening in time")


def _rpc(port: int, path: str, method: str, request_id: int) -> dict[str, Any]:
    params: dict[str, Any] = {}
    if method == "initialize":
        params = {
            "protocolVersion": _PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "mango-pack-builder", "version": "1"},
        }
    body = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
    connection = http.client.HTTPConnection(_HOST, port, timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        connection.request(
            "POST",
            path,
            body=body,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "MCP-Protocol-Version": _PROTOCOL_VERSION,
            },
        )
        response = connection.getresponse()
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        content_type = response.getheader("Content-Type", "")
    finally:
        connection.close()
    if response.status != http.client.OK or len(raw) > MAX_RESPONSE_BYTES:
        raise ProbeError(f"{method} failed: HTTP {response.status}")
    message = _decode(raw, content_type)
    result = message.get("result")
    if message.get("id") != request_id or not isinstance(result, dict):
        raise ProbeError(f"{method} returned no result: {str(message.get('error'))[:500]}")
    return result


def _decode(raw: bytes, content_type: str) -> dict[str, Any]:
    """A streamable HTTP server answers with JSON or with one SSE `message` event."""
    text = raw.decode("utf-8")
    if content_type.startswith("text/event-stream"):
        data = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
        text = data[-1] if data else ""
    try:
        message = json.loads(text)
    except json.JSONDecodeError as error:
        raise ProbeError("the pack server did not answer with JSON-RPC") from error
    if not isinstance(message, dict):
        raise ProbeError("the pack server did not answer with a JSON-RPC object")
    return message


def tools_list(directory: Path, command: list[str], path: str) -> dict[str, Any]:
    """Result of `tools/list` of the pack in `directory` (stateless streamable HTTP)."""
    with running_server(directory, command) as port:
        _rpc(port, path, "initialize", 1)
        return _rpc(port, path, "tools/list", 2)


def main(argv: list[str]) -> int:
    directory, entrypoint, path = argv
    try:
        result = tools_list(Path(directory), [sys.executable, "-S", entrypoint], path)
    except ProbeError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
