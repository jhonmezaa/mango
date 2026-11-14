"""Mango entry point of the AWS CloudTrail pack for AgentCore Runtime (D51).

The pack reads the member accounts of the organization, so it never acts with its own role:
the common entry point (`mango_pack_runtime`) is loaded before the upstream server is
imported, verifies who is calling on every `tools/call` and signs AWS requests with a session
assumed for that person, through the Read broker, in the member account the call names
(`account_id`, an argument of Mango's that the upstream tool never sees). Only the tools of
the signed manifest are served: `lookup_events`.

Upstream only speaks stdio; `mango_pack_runtime.server` serves the same server object over
stateless streamable HTTP (0.0.0.0:8000/mcp).

What this file changes of the upstream server:

* no upstream log records: the server logs the lookup parameters (user names and access key
  ids searched for, D16);
* each event's raw `CloudTrailEvent` JSON is capped (`shrink_event`): a page of up to 50
  events with full request and response elements would flood the model's context (R5).

Everything runs in `main()`: the module itself only defines the cap, so a test can import it
without loading the pack or the upstream server.
"""

from __future__ import annotations

import functools
import json
import os
from typing import Any

# Upper bound of one event's `CloudTrailEvent` as the model sees it, in characters.
MAX_EVENT_CHARS = 4096
# Upper bound of each bulky field of an event before the whole record is cut.
MAX_FIELD_CHARS = 1024
# Fields of a CloudTrail record that can be arbitrarily large; the rest (who, what, when,
# from where, error code) is small and is what an incident needs.
BULKY_FIELDS = (
    "requestParameters",
    "responseElements",
    "additionalEventData",
    "serviceEventDetails",
)
TRUNCATED = "...[truncated by Mango: {kept} of {total} characters]"


def _cut(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + TRUNCATED.format(kept=limit, total=len(text))


def shrink_event(raw: object) -> object:
    """``raw`` (an event's ``CloudTrailEvent`` JSON string) capped to ``MAX_EVENT_CHARS``.

    The bulky fields are cut first, each to ``MAX_FIELD_CHARS`` of its JSON, so the small
    fields stay whole and the record stays valid JSON when that is enough. If it still does
    not fit, the record is cut at the limit, with a marker. Anything that is not a string is
    returned as it came.
    """
    if not isinstance(raw, str) or len(raw) <= MAX_EVENT_CHARS:
        return raw
    try:
        record = json.loads(raw)
    except ValueError:
        return _cut(raw, MAX_EVENT_CHARS)
    if isinstance(record, dict):
        for key in BULKY_FIELDS:
            if record.get(key) is None:
                continue
            text = json.dumps(record[key], separators=(",", ":"), ensure_ascii=False)
            if len(text) > MAX_FIELD_CHARS:
                record[key] = _cut(text, MAX_FIELD_CHARS)
    compact = json.dumps(record, separators=(",", ":"), ensure_ascii=False)
    return _cut(compact, MAX_EVENT_CHARS)


def shrink_result(result: Any) -> Any:
    """The result of ``lookup_events`` with every event's ``CloudTrailEvent`` capped."""
    if not isinstance(result, dict) or not isinstance(result.get("events"), list):
        return result
    events = [
        {**event, "CloudTrailEvent": shrink_event(event["CloudTrailEvent"])}
        if isinstance(event, dict) and "CloudTrailEvent" in event
        else event
        for event in result["events"]
    ]
    return {**result, "events": events}


def main() -> None:
    # Read by the server (`AWS_PROFILE`: other credentials) and by the MCP SDK (its settings)
    # at import time. Nothing of the runtime's environment configures either.
    for name in list(os.environ):
        if name.startswith(("FASTMCP_", "MCP_")) or name == "AWS_PROFILE":
            del os.environ[name]

    from loguru import logger as upstream_logger  # noqa: PLC0415 - after the env is clean

    # Who called what is logged by the common entry point, without arguments or results.
    upstream_logger.remove()

    from mango_pack_runtime.server import load  # noqa: PLC0415

    # No upstream argument picks credentials, accounts or endpoints: nothing to hide.
    # `account_id` and `region` are handled by the common entry point itself (member chain).
    pack = load()  # before importing the server

    from awslabs.cloudtrail_mcp_server.tools import CloudTrailTools  # noqa: PLC0415 - after load()

    upstream = CloudTrailTools.lookup_events

    # Same signature as upstream (functools.wraps): the listed schema does not change.
    @functools.wraps(upstream)
    async def lookup_events(self: Any, *args: Any, **kwargs: Any) -> Any:
        return shrink_result(await upstream(self, *args, **kwargs))

    # Before the server module is imported: it registers the tools of one instance of the
    # class when it loads.
    CloudTrailTools.lookup_events = lookup_events  # type: ignore[method-assign]

    from awslabs.cloudtrail_mcp_server.server import mcp  # noqa: PLC0415 - after the cap

    pack.serve(mcp)


if __name__ == "__main__":
    main()
