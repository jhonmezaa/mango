"""Tags the customer put on the installation's stack, copied to what the provisioners create (D76).

CloudFormation gives a stack's tags to every resource the template declares. Agents and MCP
packs are created later, by SDK and outside the template (D25), so the provisioners copy the
stack's tags themselves: the customer tags the installation once, when deploying it.

Tags under ``aws:`` and ``mango:`` are never copied, in any letter case. AWS reserves the
first; the second are Mango's own, and IAM conditions of the installation read them (TM-M1): a
stack tag must not override ``mango:namespace`` or ``mango:component`` on a role or a runtime.
IAM matches tag keys without regard to case, so ``Mango:Namespace`` is Mango's too.

A tag that one of the services cannot take fails the step with a short code instead of being
left out: a resource without a tag the customer asked for is a gap nobody would notice.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable, Iterable, Mapping
from types import MappingProxyType
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_provisioner.errors import StepError, aws_error

RESERVED_PREFIXES = ("aws:", "mango:")
MAX_TAGS = 50
"""Tags per resource in AgentCore, IAM and CloudWatch Logs."""
REFRESH_SECONDS = 300
"""A changed stack tag reaches what is created at most this long after the stack update."""
# AgentCore accepts fewer characters than IAM and CloudWatch Logs: letters and digits of
# ASCII, spaces and ``_ . : / = + - @``. A tag that fits here fits every service that gets it.
_KEY_RE = re.compile(r"^[A-Za-z0-9 ._:/=+@-]{1,128}$")
_VALUE_RE = re.compile(r"^[A-Za-z0-9 ._:/=+@-]{0,256}$")


def custom_tags(stack_tags: Iterable[Mapping[str, Any]]) -> Mapping[str, str]:
    """The stack's tags that are copied: every one outside the reserved prefixes.

    Two keys that differ only in case are refused too: IAM takes them for the same key and
    rejects the role, with a less telling error.
    """
    tags: dict[str, str] = {}
    seen: set[str] = set()
    for tag in stack_tags:
        key, value = str(tag.get("Key", "")), str(tag.get("Value", ""))
        if key.lower().startswith(RESERVED_PREFIXES):
            continue
        if not _KEY_RE.fullmatch(key) or not _VALUE_RE.fullmatch(value) or key.lower() in seen:
            raise StepError("stack_tag_invalid")
        seen.add(key.lower())
        tags[key] = value
    return MappingProxyType(tags)


def merge(own: Mapping[str, str], custom: Mapping[str, str]) -> dict[str, str]:
    """Mango's tags of a resource plus the stack's; Mango's keys can never be overridden."""
    if len(own) + len(custom) > MAX_TAGS:
        raise StepError("stack_tags_too_many")
    return {**custom, **own}


class StackTags:
    """Reads the tags of the installation's stack, at most once every few minutes."""

    def __init__(
        self,
        cloudformation: Any,
        stack_id: str,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._cloudformation = cloudformation
        self._stack_id = stack_id
        self._clock = clock
        self._tags: Mapping[str, str] | None = None
        self._read_at = 0.0

    def get(self) -> Mapping[str, str]:
        if self._tags is not None and self._clock() - self._read_at < REFRESH_SECONDS:
            return self._tags
        try:
            stacks = self._cloudformation.describe_stacks(StackName=self._stack_id)["Stacks"]
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("DescribeStacks", exc) from None
        if len(stacks) != 1:
            raise StepError("stack_not_found")
        self._tags = custom_tags(stacks[0].get("Tags") or [])
        self._read_at = self._clock()
        return self._tags
