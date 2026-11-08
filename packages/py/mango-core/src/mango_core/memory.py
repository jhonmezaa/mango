"""AgentCore Memory of the installation, per person and agent (D122).

The one place an ``actorId`` is built (TM-ME1). The harness of an agent with memory reads and
writes the installation's memory with its own role, the same for every person: what keeps one
person's memories from another's is only the ``actorId`` of each ``InvokeHarness``. So:

* it is built here, and only here, from the verified ``sub`` and the agent id, both checked
  against their patterns: never from the body of a request, the conversation or the model;
* the harness is configured with a sentinel actor (``SENTINEL_ACTOR``) that no person has, so
  an invocation that forgot its own actor reads nobody's memories;
* whoever cannot build the actor of a person fails closed (``MemoryActorError``): the turn does
  not run with another actor instead.

Memory is off until the M0 test in AWS confirms the isolation and what the harness stores
(D122 (2), (8)): ``Settings.memory_enabled`` is false by default, and with it off no harness
gets a memory configuration and nothing calls the memory API.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

SENTINEL_ACTOR = "mango-none"
"""Actor configured on every harness with memory: no person's. An invocation without its own
``actorId`` lands here and finds nothing; the memory sweep empties it (TM-ME1)."""
EVENT_EXPIRY_DAYS = 7
"""Short-term events: a copy of the turn's messages that must not outlive the conversation's
need for it (TM-ME5)."""
MESSAGES_COUNT = 0
"""Short-term messages the harness loads into a turn: none. The session of the runtime and the
history Mango stores already carry the conversation (finding of 2026-11-07)."""
RETRIEVAL_TOP_K = 5
"""Long-term records recalled per strategy and turn (TM-ME6, TM-ME7)."""
RETRIEVAL_MIN_SCORE = 0.5

_SUB_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
"""A Cognito ``sub`` (``USER_ID_PATTERN``): never a separator of the actor."""
_AGENT_RE = re.compile(r"^(?:[a-z2-7]{16}|[a-z][a-z0-9]{1,15})$")
"""``AGENT_ID_PATTERN`` of ``mango_core.agents``, repeated to keep this module free of it."""
_RUN_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
_PREFIX = "m1"
"""Version of the actor format: a change of format is a new prefix, never a reinterpretation."""
_RUN_MARK = "run"
_RECORD_ID_RE = re.compile(r"^mem-[a-zA-Z0-9_-]{36,46}$")


class MemoryActorError(ValueError):
    """The actor of a person could not be built: nothing runs with memory (fail closed)."""


class Kind(StrEnum):
    """The strategies of the installation's memory (D122 (8)), by the segment of their
    namespace. The CloudFormation names of the strategies are these, too."""

    PREFERENCES = "preferences"
    FACTS = "facts"
    SUMMARIES = "summaries"


NAMESPACE_TEMPLATES: dict[Kind, str] = {
    Kind.PREFERENCES: "/mango/{actorId}/preferences/",
    Kind.FACTS: "/mango/{actorId}/facts/",
    Kind.SUMMARIES: "/mango/{actorId}/summaries/{sessionId}/",
}
"""Where each strategy writes. Every namespace starts with the actor: the ownership of a
record is read from its namespace (TM-ME3). The infra writes the same templates
(``infra/lib/constructs/agent-memory.ts``); a test keeps them equal."""
RECALLED = (Kind.PREFERENCES, Kind.FACTS)
"""What a turn recalls. A summary belongs to one conversation, which its session already has."""


@dataclass(frozen=True)
class Actor:
    """Who an ``actorId`` is: the person (``sub``), the agent and, for a task run, the run."""

    sub: str
    agent_id: str
    run_id: str | None = None

    @property
    def id(self) -> str:
        parts = [_PREFIX, self.agent_id, self.sub]
        if self.run_id is not None:
            parts += [_RUN_MARK, self.run_id]
        return ":".join(parts)


def _checked(sub: str, agent_id: str) -> tuple[str, str]:
    if not isinstance(sub, str) or not _SUB_RE.fullmatch(sub):
        raise MemoryActorError("not a verified user id")
    if not isinstance(agent_id, str) or not _AGENT_RE.fullmatch(agent_id):
        raise MemoryActorError("not an agent id")
    return sub, agent_id


def is_user_id(sub: str) -> bool:
    """Whether ``sub`` can be the person of an actor."""
    return isinstance(sub, str) and bool(_SUB_RE.fullmatch(sub))


def actor_id(sub: str, agent_id: str) -> str:
    """The actor of a person with an agent in the chat (TM-ME1, TM-ME6): one per (person,
    agent), so what an agent recalls of a person never reaches another agent.

    ``sub`` must be the ``sub`` of the verified access token (``UserContext.user_id``)."""
    sub, agent_id = _checked(sub, agent_id)
    return Actor(sub, agent_id).id


def task_actor_id(sub: str, agent_id: str, run_id: str) -> str:
    """A throwaway actor for one task run (TM-ME9): tasks do not use memory in v1, but an
    agent's harness has no per-invocation switch, so a run on an agent with memory gets an
    actor nobody reads. It names its owner, so the purge of a person finds it, and the
    sweep empties it."""
    sub, agent_id = _checked(sub, agent_id)
    if not isinstance(run_id, str) or not _RUN_RE.fullmatch(run_id):
        raise MemoryActorError("not a run id")
    return Actor(sub, agent_id, run_id).id


def parse_actor(raw: str) -> Actor | None:
    """The actor an id names, if Mango built it; ``None`` for the sentinel or anything else."""
    parts = raw.split(":")
    if len(parts) not in (3, 5) or parts[0] != _PREFIX:
        return None
    agent_id, sub = parts[1], parts[2]
    if not _AGENT_RE.fullmatch(agent_id) or not _SUB_RE.fullmatch(sub):
        return None
    if len(parts) == 3:  # noqa: PLR2004 - prefix, agent, sub
        return Actor(sub, agent_id)
    if parts[3] != _RUN_MARK or not _RUN_RE.fullmatch(parts[4]):
        return None
    return Actor(sub, agent_id, parts[4])


def namespace(kind: Kind, actor: str) -> str:
    """The namespace of an actor for a strategy, without the session of a summary: a prefix
    of every namespace that strategy writes for the actor."""
    return NAMESPACE_TEMPLATES[kind].split("{sessionId}")[0].replace("{actorId}", actor)


def owner_of(record_namespace: str) -> Actor | None:
    """Whose a record is, read from its namespace (``/mango/<actor>/<kind>/…``)."""
    parts = record_namespace.split("/")
    if len(parts) < 4 or parts[0] or parts[1] != "mango":  # noqa: PLR2004 - "", mango, actor, kind
        return None
    if parts[3] not in {k.value for k in Kind}:
        return None
    return parse_actor(parts[2])


def kind_of(record_namespace: str) -> Kind | None:
    parts = record_namespace.split("/")
    try:
        return Kind(parts[3]) if len(parts) > 3 else None  # noqa: PLR2004
    except ValueError:
        return None


def is_record_id(value: str) -> bool:
    return bool(_RECORD_ID_RE.fullmatch(value))


def memory_id(memory_arn: str) -> str:
    """The id of a memory from its ARN (``…:memory/<id>``), what the data plane takes."""
    return memory_arn.rpartition("/")[2]


def harness_memory(memory_arn: str | None) -> dict[str, Any]:
    """The ``memory`` field of an agent's harness (TM-ME8): the installation's memory by ARN
    with the sentinel actor, or ``disabled``. Never ``managedMemoryConfiguration``, which
    creates a memory per harness that outlives it (finding of 2026-11-07)."""
    if not memory_arn:
        return {"disabled": {}}
    return {
        "agentCoreMemoryConfiguration": {
            "arn": memory_arn,
            "actorId": SENTINEL_ACTOR,
            "messagesCount": MESSAGES_COUNT,
            "retrievalConfig": {
                NAMESPACE_TEMPLATES[kind]: {
                    "topK": RETRIEVAL_TOP_K,
                    "relevanceScore": RETRIEVAL_MIN_SCORE,
                }
                for kind in RECALLED
            },
        }
    }
