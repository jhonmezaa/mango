"""A reference applier of the ``v1`` deltas (D120 (3)), for tests only: the web builds its own
in R4 with the same rules (plan §2.3, the applier of ChatGPT's client).

* ``delta_encoding`` with ``"v1"`` starts a connection; a delta before it is an error.
* ``c``, ``p`` and ``o`` are inherited from the previous delta of the connection, ``v`` never.
  The first delta starts from ``{c: 0, p: "", o: "add"}``.
* Each channel is a JSON document of its own. Paths are JSON Pointers (``~1``, ``~0``); a
  numeric segment is an index; missing parents are created (``[]`` before a numeric segment,
  ``{}`` otherwise); ``__proto__``, ``constructor`` and ``prototype`` are refused.
* ``add``, ``replace``, ``remove``, ``append``, ``truncate`` and ``patch`` (a list of sub-deltas
  applied in order on the value at the path, without inheritance). Anything else is refused.
* Immutable: a delta that fails leaves every document as it was.

The documents of the channels outlive a connection: a client that resumes keeps them and
starts a new connection with ``after`` = the last ``id`` it applied.
"""

from __future__ import annotations

import copy
import itertools
import json
import re
from typing import Any

UNSAFE = frozenset({"__proto__", "constructor", "prototype"})
_INDEX = re.compile(r"^(0|[1-9]\d*)$")


class DeltaError(ValueError):
    pass


def _segments(path: str) -> list[str | int]:
    if path == "":
        return []
    raw = path[1:] if path.startswith("/") else path
    out: list[str | int] = []
    for part in raw.split("/"):
        segment = part.replace("~1", "/").replace("~0", "~")
        if segment in UNSAFE:
            raise DeltaError("Unsafe delta path segment")
        out.append(int(segment) if _INDEX.fullmatch(segment) else segment)
    return out


def _container(root: dict[str, Any], segments: list[str | int]) -> tuple[Any, str | int]:
    """The parent of the last segment, creating what is missing."""
    node: Any = root
    keys: list[str | int] = ["__root", *segments]
    for key, following in itertools.pairwise(keys):
        nxt = node[key] if _has(node, key) else None
        if nxt is None:
            nxt = [] if isinstance(following, int) else {}
            _set(node, key, nxt)
        node = nxt
    return node, keys[-1]


def _has(node: Any, key: str | int) -> bool:
    if isinstance(node, list):
        return isinstance(key, int) and key < len(node)
    if isinstance(node, dict):
        return key in node
    raise DeltaError("path through a value that is not a container")


def _set(node: Any, key: str | int, value: Any) -> None:
    if isinstance(node, list):
        if not isinstance(key, int):
            raise DeltaError("array index expected")
        if key == len(node):
            node.append(value)
        else:
            node[key] = value
    else:
        node[str(key)] = value


def _apply(root: dict[str, Any], path: str, op: str, value: Any) -> None:  # noqa: PLR0912
    parent, key = _container(root, _segments(path))
    current = parent[key] if _has(parent, key) else None
    if op == "add":
        if isinstance(parent, list) and isinstance(key, int):
            parent.insert(key, value)
        else:
            _set(parent, key, value)
    elif op == "replace":
        _set(parent, key, value)
    elif op == "remove":
        if isinstance(parent, list) and isinstance(key, int):
            del parent[key]
        else:
            parent.pop(key, None)
    elif op == "append":
        if isinstance(current, str) and isinstance(value, str):
            _set(parent, key, current + value)
        elif isinstance(current, list):
            current.extend(value if isinstance(value, list) else [value])
        elif isinstance(current, dict) and isinstance(value, dict):
            for k in value:
                if k in UNSAFE:
                    raise DeltaError("Unsafe delta path segment")
            current.update(value)
        else:
            _set(parent, key, value)
    elif op == "truncate":
        if isinstance(current, str):
            _set(parent, key, current[: int(value)])
        elif isinstance(current, list):
            del current[int(value) :]
    elif op == "patch":
        if not isinstance(value, list):
            raise DeltaError("patch takes a list")
        base = path
        for sub in value:
            if not isinstance(sub, dict) or "o" not in sub:
                raise DeltaError("sub-delta without operation")
            sub_path = str(sub.get("p", ""))
            _apply(root, base + sub_path if sub_path else base, str(sub["o"]), sub.get("v"))
    else:
        raise DeltaError("Unknown json delta operation")


class Applier:
    def __init__(self) -> None:
        self.channels: dict[int, Any] = {}
        self.started = False
        self.last_id = 0
        self._previous: dict[str, Any] = {}
        self.complete: dict[str, Any] | None = None
        self.done = False

    def encoding(self, value: Any) -> None:
        if value != "v1":
            raise DeltaError("[delta] unknown delta encoding")
        self.started = True
        # A new connection: inheritance starts again, the documents stay.
        self._previous = {"c": 0, "p": "", "o": "add"}

    def delta(self, data: dict[str, Any], event_id: int | None = None) -> None:
        if not self.started:
            raise DeltaError("[delta] delta event before delta_encoding")
        if "v" not in data and data.get("o") != "remove":
            raise DeltaError("v is never inherited")
        full = {**self._previous, **{k: data[k] for k in ("c", "p", "o") if k in data}}
        channel = full["c"]
        if not isinstance(channel, int) or channel < 0:
            raise DeltaError("bad channel")
        root = {"__root": copy.deepcopy(self.channels.get(channel))}
        _apply(root, str(full["p"]), str(full["o"]), copy.deepcopy(data.get("v")))
        self.channels[channel] = root["__root"]
        self._previous = full
        if event_id is not None:
            self.last_id = event_id


def parse(body: str) -> list[tuple[str, Any, int | None]]:
    """The SSE of a turn: (event, data, id); ``("done", None, None)`` for ``[DONE]``;
    comments (pings) are left out."""
    out: list[tuple[str, Any, int | None]] = []
    for chunk in body.split("\n\n"):
        lines = [line for line in chunk.splitlines() if line and not line.startswith(":")]
        if not lines:
            continue
        fields: dict[str, str] = {}
        for line in lines:
            name, _, value = line.partition(": ")
            fields[name] = value
        if fields.get("data") == "[DONE]":
            out.append(("[DONE]", None, None))
            continue
        event_id = int(fields["id"]) if "id" in fields else None
        out.append((fields.get("event", "message"), json.loads(fields["data"]), event_id))
    return out


def feed(applier: Applier, body: str) -> list[tuple[str, Any, int | None]]:
    events = parse(body)
    for event, data, event_id in events:
        if event == "delta_encoding":
            applier.encoding(data)
        elif event == "delta":
            applier.delta(data, event_id)
        elif event == "message_stream_complete":
            applier.complete = data
        elif event == "[DONE]":
            applier.done = True
    return events
