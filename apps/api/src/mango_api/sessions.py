"""One AgentCore runtime session per conversation (D39).

A runtime session keeps the agent's messages between invocations and is addressed only by
its id: anyone invoking the harness with the same id continues that conversation. So the id
is derived server-side from the verified user and the conversation, never taken from the
client, and two users can never share one.

While a session is known to be alive only the new user message is sent (the session already
holds the history). Whenever that is not certain (idle too long, too old, a turn in flight
or one that ended badly, another agent version or model) a new session is started and the
stored history is replayed, so history is never duplicated and never silently lost.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mango_api.harness import InvocationResult
    from mango_core.identity import UserContext

IDLE_MARGIN_SECONDS = 60
"""Reuse stops this long before AgentCore's idle timeout: the clocks are not the same."""
LIFETIME_MARGIN_SECONDS = 60
GUARDRAIL_STOP = "guardrail_intervened"
CAP_STOP = "max_tokens"


@dataclass(frozen=True)
class SessionState:
    """What the conversation record knows about its runtime session."""

    generation: int = 0
    started_at: int = 0
    """Epoch seconds of the first turn of this session."""
    used_at: int = 0
    """Epoch seconds when its last turn ended well; 0 while a turn is in flight or after a
    turn that must not be continued."""
    binding: str = ""
    """``session_binding`` the session was started under; empty for sessions started before
    it was recorded (they are not continued)."""


@dataclass(frozen=True)
class SessionPlan:
    generation: int
    started_at: int
    reused: bool
    """True: the session holds the history, send only the new message."""


class SessionBusyError(Exception):
    """Another turn of the same conversation took the session first."""


def plan(
    state: SessionState,
    now: int,
    *,
    binding: str,
    idle_seconds: int,
    max_seconds: int,
    turn_seconds: int,
) -> SessionPlan:
    """Continue the conversation's session only when it is certainly alive for this turn and
    was started under the same ``binding`` (same access of the user, agent version and model).

    Under another binding the session id differs, so the turn runs in a session that holds
    nothing: it must be planned as new and get the stored history.
    """
    alive = (
        idle_seconds > 0
        and state.generation > 0
        and state.used_at > 0
        and bool(binding)
        and state.binding == binding
        and now - state.used_at <= idle_seconds - IDLE_MARGIN_SECONDS
        # The whole agent loop must fit before AgentCore ends the session.
        and now + turn_seconds <= state.started_at + max_seconds - LIFETIME_MARGIN_SECONDS
    )
    if alive:
        return SessionPlan(state.generation, state.started_at, reused=True)
    return SessionPlan(state.generation + 1, now, reused=False)


def agent_fingerprint(
    *,
    harness_arn: str,
    harness_version: str,
    content_hash: str,
    model: str,
    guardrail_id: str,
    guardrail_version: str,
) -> str:
    """Changes whenever what the agent runs does, so a session started under another version
    (prompt, tools, limits: all in ``content_hash``), model, guardrail or harness is never
    continued."""
    material = [harness_arn, harness_version, content_hash, model, guardrail_id, guardrail_version]
    return hashlib.sha256(json.dumps(material).encode()).hexdigest()


def access_scope(user: UserContext) -> str:
    """What decides which data the user's tools return. When it changes (another role, area
    or group), the conversation continues in a new session: tool results obtained under the
    earlier access are not carried over."""
    return json.dumps([user.role, user.business_unit, sorted(user.groups)])


def session_binding(user: UserContext, fingerprint: str) -> str:
    """What a runtime session is tied to besides its conversation: the user's access and what
    the agent runs (``agent_fingerprint``). Stored with the session; a turn under another
    binding never continues it."""
    return hashlib.sha256(json.dumps([access_scope(user), fingerprint]).encode()).hexdigest()


def runtime_session_id(
    *, user: UserContext, agent_id: str, conversation_id: str, generation: int, fingerprint: str
) -> str:
    """64 hex characters (AgentCore accepts 33 to 100 of ``[a-zA-Z0-9_-]``).

    The verified user id is part of the digest: even with the same conversation id two users
    get different sessions. JSON keeps the fields unambiguous.
    """
    material = json.dumps(
        [
            "mango-session-v1",
            user.user_id,
            access_scope(user),
            agent_id,
            conversation_id,
            generation,
            fingerprint,
        ]
    )
    return hashlib.sha256(material.encode()).hexdigest()


def can_continue(result: InvocationResult) -> bool:
    """Whether the next turn may continue the session this turn ran in.

    After a failure the session may hold a half-finished turn, and after a guardrail
    intervention it holds content that would be evaluated again on every later call. A turn
    that ended on a write tool call left the harness waiting for that tool. A turn cut at
    its token cap (D74) ended as an error in the harness: what its session kept of the cut
    message is not known, and the stored history is.
    """
    return not (result.failed or result.interrupted) and result.stop_reason not in (
        GUARDRAIL_STOP,
        CAP_STOP,
    )
