"""The stream of ``InvokeHarness`` as botocore delivers it, from the bytes on the wire.

A test that scripts the stream as a list of dictionaries decides by itself what an error
looks like. Here the events are encoded as event-stream frames and read by a real botocore
client (its HTTP send is replaced; nothing reaches the network), so an error of the harness
arrives the way it does in an installation: the service model marks
``internalServerException``, ``validationException`` and ``runtimeClientError`` as exceptions,
the service sends them as ``:message-type: exception`` frames, and botocore raises
``EventStreamError`` while the stream is read instead of yielding them.
"""

from __future__ import annotations

import json
import struct
import zlib
from collections.abc import Iterator
from typing import Any

import boto3
from botocore.awsrequest import AWSResponse
from botocore.config import Config

ERROR_TEXT = "Model stopped generating due to maximum token limit."
_STRING = b"\x07"
"""Header value type 7 of the event-stream encoding: a string."""
_REQUEST: dict[str, Any] = {
    "harnessArn": "arn:aws:bedrock-agentcore:us-east-1:111122223333:harness/example-0000000000",
    "runtimeSessionId": "s" * 40,
    "messages": [{"role": "user", "content": [{"text": "x"}]}],
}


def _header(name: str, value: str) -> bytes:
    key, text = name.encode(), value.encode()
    return bytes([len(key)]) + key + _STRING + struct.pack("!H", len(text)) + text


def _frame(headers: dict[str, str], payload: dict[str, Any]) -> bytes:
    head = b"".join(_header(name, value) for name, value in headers.items())
    body = json.dumps(payload).encode()
    prelude = struct.pack("!II", 12 + len(head) + len(body) + 4, len(head))
    prelude += struct.pack("!I", zlib.crc32(prelude))
    message = prelude + head + body
    return message + struct.pack("!I", zlib.crc32(message))


def event_frame(event: dict[str, Any]) -> bytes:
    """One event of the stream, given as ``{<member>: <payload>}``."""
    ((name, payload),) = event.items()
    headers = {
        ":message-type": "event",
        ":event-type": name,
        ":content-type": "application/json",
    }
    return _frame(headers, payload)


def exception_frame(code: str, message: str = ERROR_TEXT) -> bytes:
    """The error the harness ends an invocation with, as the service sends it."""
    headers = {
        ":message-type": "exception",
        ":exception-type": code,
        ":content-type": "application/json",
    }
    return _frame(headers, {"message": message})


class _Body:
    """The HTTP body of the response: botocore reads it in chunks, one frame each here."""

    def __init__(self, frames: list[bytes]) -> None:
        self._frames = frames
        self.closed = False

    def stream(self, *_args: Any, **_kwargs: Any) -> Iterator[bytes]:
        yield from self._frames

    def read(self, *_args: Any, **_kwargs: Any) -> bytes:
        return b""

    def close(self) -> None:
        self.closed = True


def wire_stream(*events: dict[str, Any], error: str | None = None, frames: bytes = b"") -> Any:
    """botocore's own ``EventStream`` over ``events`` and, after them, the exception ``error``
    (a code of the service model). ``frames`` are appended as they are."""
    chunks = [event_frame(event) for event in events]
    if error is not None:
        chunks.append(exception_frame(error))
    if frames:
        chunks.append(frames)
    client = boto3.client(
        "bedrock-agentcore",
        region_name="us-east-1",
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
        config=Config(retries={"total_max_attempts": 1, "mode": "standard"}),
    )
    body = _Body(chunks)

    def send(request: Any, **_kwargs: Any) -> AWSResponse:
        headers = {"content-type": "application/vnd.amazon.eventstream"}
        return AWSResponse(request.url, 200, headers, body)

    client.meta.events.register("before-send.bedrock-agentcore.InvokeHarness", send)
    return client.invoke_harness(**_REQUEST)["stream"]
