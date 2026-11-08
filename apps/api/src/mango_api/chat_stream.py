"""The stream of a chat turn in JSON patches, ``v1`` (D120).

The turn worker keeps writing the events of D57 to the turn's record (``TURN#<turn>#EVT#``,
D121). ``GET /api/chat/turns/{turn}/stream`` reads that record from any task of mango-api
and translates it here into deltas ``{c, p, o, v}`` over messages
``{id, author.role, recipient, channel, content_type, content, status, metadata}``:

* channel ``0`` is the answer: ``author.role = "assistant"``, ``channel = "final"``, its text
  in ``content.text``. The phase of the turn (D57: computed by mango-api, never text of the
  model), the knowledge searches, the approvals and the connections a remote MCP server asks
  for are data of its ``metadata``;
* each tool call is a message of its own (``recipient`` = the tool's display name, as the
  stream of D57 named it) and its result another one, ``author.role = "tool"``, without
  content: what a tool answered never reaches the browser (D90 (3));
* a Canvas document a turn wrote (D124) is a card in the answer's ``metadata.textdocs``
  (``textdocs.TextdocCardOut``), and its call a message with ``recipient = "textdoc.<tool>"``;
* a cell of the code sandbox (C4, D114 (7)) is a call with ``recipient = "code.run_python"``
  and ``content_type = "code"``; its result carries what the chat shows of the cell in
  ``metadata.aggregate_result`` (``code_blocks.CodeCellOut``: code, output with its cap, the
  exception and its files by id, after ``ApplyGuardrail``), the «Analizando» block. It is
  content of the conversation, not of the tool's answer to the model.

The translation is a pure function of the record: the same events always give the same
deltas, numbered from 1. A reader that resumes with ``after=<n>`` replays the record without
sending it and goes on from delta ``n + 1``: nothing is sent twice nor lost.

Security notes (security-best-practices, TM-TW4, TM-TW8):
* Every path is built here from ``MESSAGE_PATHS``; the model only ever puts text in ``v``.
* Only what the record holds is translated: text the guardrail released, the phase, tool
  names of the agent's version (TM-LP1); an unknown kind is skipped, never passed through.
"""

from __future__ import annotations

import json
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Literal

from mango_api.code_blocks import CODE_RECIPIENT
from mango_api.turns_store import TurnEvent, TurnState, TurnStatus

ENCODING = "v1"
FINAL = 0
"""The channel of the answer."""

Op = Literal["add", "replace", "remove", "append", "truncate", "patch"]
OPERATIONS: frozenset[str] = frozenset({"add", "replace", "remove", "append", "truncate", "patch"})
UNSAFE_SEGMENTS: frozenset[str] = frozenset({"__proto__", "constructor", "prototype"})

MESSAGE_PATHS: frozenset[str] = frozenset(
    {
        "",
        "/status",
        "/content/text",
        "/metadata/phase",
        "/metadata/knowledge",
        "/metadata/approvals",
        "/metadata/connection_required",
        "/metadata/result",
        "/metadata/error",
        "/metadata/aggregate_result",
        "/metadata/textdocs",
    }
)
"""Every path a delta of this server writes, relative to its channel's message."""

CANCELLED = {"code": "cancelled", "message": "the turn was stopped"}
"""The end the owner's «Detener» writes (D121 (7)): the turn is ``interrupted``."""
TURN_INTERRUPTED = {"code": "turn_interrupted", "message": "the answer was interrupted"}
"""The end of a turn lost halfway (D121 (7)): its worker stopped, or lost the agent's stream,
after the agent started. Its message ends in ``error`` with this code, never
``upstream_error`` (the agent failed): it is charged in full and asking again does not
continue it."""

MessageStatus = Literal["in_progress", "finished", "error", "interrupted"]


@dataclass(frozen=True)
class Delta:
    c: int
    p: str
    o: Op
    v: Any

    def full(self) -> dict[str, Any]:
        return {"c": self.c, "p": self.p, "o": self.o, "v": self.v}


def _message(
    message_id: str,
    *,
    role: str,
    recipient: str,
    channel: str,
    content_type: str,
    content: dict[str, Any],
    status: MessageStatus,
    metadata: dict[str, Any],
    name: str | None = None,
) -> dict[str, Any]:
    author: dict[str, Any] = {"role": role}
    if name is not None:
        author["name"] = name
    return {
        "id": message_id,
        "author": author,
        "recipient": recipient,
        "channel": channel,
        "content_type": content_type,
        "content": content,
        "status": status,
        "metadata": metadata,
    }


def error_of(rejection: dict[str, Any] | None) -> dict[str, Any]:
    """The error of a turn that ended before its stream started, as the stream says it: the
    same status, code and message ``POST /api/chat`` answered with (never content)."""
    if rejection is None:
        return {"status": 503, "code": "agent_unavailable", "message": "please try again"}
    if rejection.get("internal"):
        return {"status": 500, "code": "internal_error", "message": "internal error"}
    status = int(rejection.get("status", 503))
    if "code" in rejection:
        return {
            "status": status,
            "code": str(rejection["code"]),
            "message": str(rejection.get("message", "")),
        }
    codes = {401: "unauthenticated", 403: "forbidden", 404: "not_found"}
    return {
        "status": status,
        "code": codes.get(status, "error"),
        "message": str(rejection.get("detail", "error")),
    }


@dataclass
class Translator:
    """Stored events of one turn → deltas, in order. Feed every event from the first one."""

    turn_id: str
    conversation_id: str
    ended: bool = False
    _channels: int = 0
    _calls: dict[str, deque[int]] = field(default_factory=dict)
    _cells: deque[int] = field(default_factory=deque)
    """Result channels of code calls still waiting for what their cell showed."""
    _final_open: bool = False

    def _id(self, channel: int) -> str:
        return f"{self.turn_id}.{channel}"

    def _new_channel(self) -> int:
        channel = self._channels
        self._channels += 1
        return channel

    def _final(self) -> list[Delta]:
        """The answer's message, added once before anything is said about it."""
        if self._final_open:
            return []
        self._final_open = True
        channel = self._new_channel()
        return [
            Delta(
                channel,
                "",
                "add",
                _message(
                    self._id(channel),
                    role="assistant",
                    recipient="all",
                    channel="final",
                    content_type="text",
                    content={"text": ""},
                    status="in_progress",
                    metadata={
                        "conversation_id": self.conversation_id,
                        "turn_id": self.turn_id,
                        "phase": None,
                        "knowledge": [],
                        "approvals": [],
                        "connection_required": [],
                        "textdocs": [],
                    },
                ),
            )
        ]

    def feed(self, event: TurnEvent) -> list[Delta]:  # noqa: PLR0912 - one branch per kind
        if self.ended:
            return []
        out = self._final()
        kind, data = event.kind, event.data
        if kind == "conversation":
            pass
        elif kind == "status":
            phase = {"phase": str(data.get("phase", ""))}
            if data.get("tool"):
                phase["tool"] = str(data["tool"])
            out.append(Delta(FINAL, "/metadata/phase", "replace", phase))
        elif kind == "delta":
            text = data.get("text")
            if isinstance(text, str) and text:
                out.append(Delta(FINAL, "/content/text", "append", text))
        elif kind == "tool":
            out.extend(
                self._tool(
                    str(data.get("name", "tool")),
                    str(data.get("status", "")),
                    code=data.get("code") is True,
                )
            )
        elif kind == "code":
            out.extend(self._cell(data))
        elif kind == "knowledge":
            out.append(Delta(FINAL, "/metadata/knowledge", "append", [data]))
        elif kind == "approval":
            out.append(Delta(FINAL, "/metadata/approvals", "append", [data]))
        elif kind == "textdoc":
            # The card of a Canvas document the turn wrote (D124): its id, title, kind and
            # version; a later card of the same document replaces it in the chat.
            out.append(Delta(FINAL, "/metadata/textdocs", "append", [data]))
        elif kind == "remote_connection_required":
            registration = str(data.get("registration_id", ""))
            out.append(Delta(FINAL, "/metadata/connection_required", "append", [registration]))
        elif kind == "done":
            out.append(self._end("finished", "/metadata/result", data))
        elif kind == "error":
            error = {"code": str(data.get("code", "")), "message": str(data.get("message", ""))}
            status: MessageStatus = "interrupted" if error["code"] == CANCELLED["code"] else "error"
            out.append(self._end(status, "/metadata/error", error))
        return out

    def close(self, status: TurnStatus) -> list[Delta]:
        """The end of a turn whose record ended without saying so: it never started (its
        rejection), or it was stopped before its end could be written."""
        if self.ended:
            return []
        out = self._final()
        if status.state == TurnState.INTERRUPTED:
            out.append(self._end("interrupted", "/metadata/error", dict(CANCELLED)))
        elif status.state == TurnState.DONE:
            out.append(self._end("finished", "/metadata/result", {}))
        else:
            out.append(self._end("error", "/metadata/error", error_of(status.rejection)))
        return out

    def _tool(self, name: str, status: str, *, code: bool = False) -> list[Delta]:
        out: list[Delta] = []
        if code:
            name = CODE_RECIPIENT
        elif name == CODE_RECIPIENT:
            # Only a call the harness knew as a cell is one (TM-LP1).
            name = "tool"
        if status == "started":
            channel = self._new_channel()
            self._calls.setdefault(name, deque()).append(channel)
            out.append(Delta(channel, "", "add", self._call(channel, name)))
            return out
        pending = self._calls.get(name)
        if pending:
            call = pending.popleft()
        else:
            # Refused before its start was seen: the call is said all the same.
            call = self._new_channel()
            out.append(Delta(call, "", "add", self._call(call, name)))
        ended: MessageStatus = "error" if status == "error" else "finished"
        out.append(Delta(call, "/status", "replace", ended))
        channel = self._new_channel()
        out.append(
            Delta(
                channel,
                "",
                "add",
                _message(
                    self._id(channel),
                    role="tool",
                    name=name,
                    recipient="all",
                    channel="commentary",
                    content_type="code_result" if code else "tool_result",
                    content={},
                    status=ended,
                    metadata={
                        "call_id": self._id(call),
                        **({"aggregate_result": None} if code else {}),
                    },
                ),
            )
        )
        if code:
            self._cells.append(channel)
        return out

    def _cell(self, cell: dict[str, Any]) -> list[Delta]:
        """What a cell showed, on the result of its call. A cell without a result waiting for it
        (more cells than answered calls) gets a result message of its own."""
        if self._cells:
            return [Delta(self._cells.popleft(), "/metadata/aggregate_result", "replace", cell)]
        channel = self._new_channel()
        return [
            Delta(
                channel,
                "",
                "add",
                _message(
                    self._id(channel),
                    role="tool",
                    name=CODE_RECIPIENT,
                    recipient="all",
                    channel="commentary",
                    content_type="code_result",
                    content={},
                    status="finished",
                    metadata={"call_id": None, "aggregate_result": cell},
                ),
            )
        ]

    def _call(self, channel: int, name: str) -> dict[str, Any]:
        return _message(
            self._id(channel),
            role="assistant",
            recipient=name,
            channel="commentary",
            content_type="code" if name == CODE_RECIPIENT else "tool_call",
            content={},
            status="in_progress",
            metadata={},
        )

    def _end(self, status: MessageStatus, path: str, value: dict[str, Any]) -> Delta:
        self.ended = True
        return Delta(
            FINAL,
            "",
            "patch",
            [
                {"p": "/status", "o": "replace", "v": status},
                {"p": path, "o": "replace", "v": value},
            ],
        )


class Compressor:
    """Leaves out ``c``, ``p`` and ``o`` when they repeat the previous delta of the same
    connection (``v`` always goes). The first delta of a connection carries all of them, so a
    client that resumes never depends on what another connection sent."""

    def __init__(self) -> None:
        self._last: tuple[int, str, str] | None = None

    def short(self, delta: Delta) -> dict[str, Any]:
        out: dict[str, Any] = {}
        last = self._last
        if last is None or last[0] != delta.c:
            out["c"] = delta.c
        if last is None or last[1] != delta.p:
            out["p"] = delta.p
        if last is None or last[2] != delta.o:
            out["o"] = delta.o
        out["v"] = delta.v
        self._last = (delta.c, delta.p, delta.o)
        return out


def _json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def encoding_event() -> bytes:
    return f"event: delta_encoding\ndata: {_json(ENCODING)}\n\n".encode()


def delta_event(offset: int, delta: dict[str, Any]) -> bytes:
    return f"id: {offset}\nevent: delta\ndata: {_json(delta)}\n\n".encode()


def complete_events(conversation_id: str, turn_id: str) -> bytes:
    data = _json({"conversation_id": conversation_id, "turn_id": turn_id})
    return f"event: message_stream_complete\ndata: {data}\n\ndata: [DONE]\n\n".encode()
