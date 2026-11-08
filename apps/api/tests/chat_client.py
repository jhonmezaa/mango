"""A chat turn read to its end, for the tests of what a turn does (budgets, authorization,
tools, approvals, audit). Since R5 the only way in is ``POST /api/chat/turns`` and its ``v1``
stream (D120); this helper reads both and gives the turn back as the events of D57 the turn
record stores, in order, so a test can say what happened without decoding deltas.

A turn that never started (its stream only says its rejection: ``status``, ``code`` and
``message``) comes back as that HTTP error, the one the person sees in the chat.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .v1_patches import DeltaError, parse

FINAL = 0
# A call: to a tool, or a cell of code (``code.run_python``, D114 (14)); D57 said both as tools.
CALLS = frozenset({"tool_call", "code"})
# The result of a call: of a tool, or of a cell of code with what it showed (D114 (14)).
RESULTS = frozenset({"tool_result", "code_result"})


@dataclass
class ChatReply:
    """``status_code``, ``text`` (the D57 events as SSE) and ``json()``, like a response."""

    status_code: int
    events: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    body: Any = None
    turn_id: str | None = None
    conversation_id: str | None = None

    @property
    def text(self) -> str:
        if self.body is not None:
            return json.dumps(self.body)
        return "".join(
            f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
            for kind, data in self.events
        )

    def json(self) -> Any:
        return self.body


def events_of(body: str) -> list[tuple[str, dict[str, Any]]]:  # noqa: PLR0912 - one per path
    """The events of D57 a ``v1`` stream says, in order (the translator of
    ``chat_stream.py`` read backwards)."""
    out: list[tuple[str, dict[str, Any]]] = []
    previous: dict[str, Any] = {}
    calls: dict[int, str] = {}
    last_added: int | None = None
    for event, data, _id in parse(body):
        if event == "delta_encoding":
            previous = {"c": 0, "p": "", "o": "add"}
            continue
        if event != "delta":
            continue
        full = {**previous, **{k: data[k] for k in ("c", "p", "o") if k in data}}
        previous = full
        channel, path, op, value = full["c"], full["p"], full["o"], data.get("v")
        added, last_added = last_added, None
        if channel == FINAL:
            if path == "/metadata/phase" and op == "replace":
                out.append(("status", dict(value)))
            elif path == "/content/text" and op == "append":
                out.append(("delta", {"text": value}))
            elif path == "/metadata/knowledge" and op == "append":
                out.extend(("knowledge", dict(item)) for item in value)
            elif path == "/metadata/approvals" and op == "append":
                out.extend(("approval", dict(item)) for item in value)
            elif path == "/metadata/connection_required" and op == "append":
                out.extend(
                    ("remote_connection_required", {"registration_id": item}) for item in value
                )
            elif path == "" and op == "patch":
                for sub in value:
                    if sub["p"] == "/metadata/result":
                        out.append(("done", dict(sub["v"])))
                    elif sub["p"] == "/metadata/error":
                        out.append(("error", dict(sub["v"])))
            continue
        if path == "" and op == "add" and value.get("content_type") in CALLS:
            calls[channel] = str(value["recipient"])
            out.append(("tool", {"name": calls[channel], "status": "started"}))
            last_added = channel
        elif path == "/status" and op == "replace" and channel in calls:
            status = "error" if value == "error" else "completed"
            if added == channel:
                # Said before its start was seen (the translator adds the call and ends it at
                # once): D57 had only its end.
                out.pop()
            out.append(("tool", {"name": calls[channel], "status": status}))
        elif path == "" and op == "add" and value.get("content_type") in RESULTS:
            continue
        elif path == "/metadata/aggregate_result" and op == "replace":
            # A cell of the «Analizando» block (D114 (14)): only ``v1`` has it, D57 never did.
            continue
        else:
            raise DeltaError(f"unexpected delta {full}")
    return out


def post_chat(
    client: Any,
    *,
    headers: dict[str, str],
    json: Any = None,
    content: bytes | None = None,
) -> Any:
    """``POST /api/chat/turns`` and its stream from ``after=0`` to the end of the turn."""
    if content is not None:
        created = client.post("/api/chat/turns", headers=headers, content=content)
    else:
        created = client.post("/api/chat/turns", headers=headers, json=json)
    if created.status_code != 200:
        return created
    ids = created.json()
    turn_id, conversation_id = str(ids["turn_id"]), str(ids["conversation_id"])
    stream = client.get(f"/api/chat/turns/{turn_id}/stream", params={"after": 0}, headers=headers)
    assert stream.status_code == 200, stream.text
    events = events_of(stream.text)
    if len(events) == 1 and events[0][0] == "error" and "status" in events[0][1]:
        error = events[0][1]
        return ChatReply(
            int(error["status"]),
            body={"error": {"code": error["code"], "message": error["message"]}},
            turn_id=turn_id,
            conversation_id=conversation_id,
        )
    return ChatReply(
        200,
        [("conversation", {"conversation_id": conversation_id}), *events],
        turn_id=turn_id,
        conversation_id=conversation_id,
    )
