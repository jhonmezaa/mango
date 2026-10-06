"""Every rate limit of mango-api by name, and whether its tasks share it (D70).

``mango-api`` runs on several tasks. A limit marked ``shared`` is counted in DynamoDB
(``rate_limits.SharedRateLimiter``): the documented number holds whatever the number of tasks
and survives a restart. The others are counted in the memory of each task
(``probe.RateLimiter``): with N tasks their real limit is N times the number here, and each
one says why that is acceptable.

Routes take their limiters from ``Limits.limiter(name)``; nothing else builds one. A test
keeps the limits that hold a security exception of AGENTS.md shared
(``tests/test_limits.py``).
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass

from mango_api import (
    admin,
    approvals,
    directory,
    group_admin,
    mcp,
    mfa_reset,
    people,
    tool_policies,
    web_session,
)
from mango_api.probe import RateLimiter
from mango_api.rate_limits import Limiter, RateLimitStore, SharedRateLimiter

MODEL_REFRESHES_PER_MINUTE = 5
AGENT_LISTS_PER_MINUTE = 30

MINUTE = 60
HOUR = 3600


@dataclass(frozen=True)
class LimitSpec:
    limit: int
    window_seconds: int
    shared: bool
    why: str
    """What the limit bounds and, when it is per task, why that is acceptable."""


LIMITS: dict[str, LimitSpec] = {
    # --- Hold an agreed exception to «do not reveal whether a user exists» (AGENTS.md) ----
    "people.reads": LimitSpec(
        people.READS_PER_MINUTE,
        MINUTE,
        shared=True,
        why="Reads of the directory and of its changes by an administrator (D60, D66).",
    ),
    "people.invitations": LimitSpec(
        people.INVITATIONS_PER_HOUR,
        HOUR,
        shared=True,
        why="An invitation answers whether the email is already in the directory (D60).",
    ),
    "directory.emails": LimitSpec(
        directory.EMAILS_PER_MINUTE,
        MINUTE,
        shared=True,
        why="Emails an agent creator resolves to people (D33); the daily quota is shared too.",
    ),
    "directory.ids": LimitSpec(
        directory.IDS_PER_MINUTE,
        MINUTE,
        shared=True,
        why="Identifiers resolved to emails (D33): each one is a read of the user pool.",
    ),
    "mfa_reset.proposals": LimitSpec(
        mfa_reset.PROPOSALS_PER_HOUR,
        HOUR,
        shared=True,
        why="Asking to reset MFA answers whether the email exists (D20).",
    ),
    # --- Bound abuse or cost ---------------------------------------------------------------
    "people.changes": LimitSpec(
        people.CHANGES_PER_HOUR,
        HOUR,
        shared=True,
        why="Changes of groups and access: each one writes to the user pool.",
    ),
    "people.proposals": LimitSpec(
        people.PROPOSALS_PER_HOUR,
        HOUR,
        shared=True,
        why="Changes that wait for a second administrator.",
    ),
    "group_admin.proposals": LimitSpec(
        group_admin.PROPOSALS_PER_HOUR,
        HOUR,
        shared=True,
        why="Changes of the group registry that wait for a second administrator (D26).",
    ),
    "tool_policies.proposals": LimitSpec(
        tool_policies.PROPOSALS_PER_HOUR,
        HOUR,
        shared=True,
        why="Changes of write tool policies that wait for a second administrator (D27).",
    ),
    "mcp.writes": LimitSpec(
        mcp.WRITES_PER_MINUTE,
        MINUTE,
        shared=True,
        why="Requests and executions of MCP packs (TM-B20): each may start a state machine.",
    ),
    "approvals.runs": LimitSpec(
        approvals.RUNS_PER_MINUTE,
        MINUTE,
        shared=True,
        why="Each run signs with KMS and calls the Gateway with a write tool (D27).",
    ),
    "admin.probe": LimitSpec(
        admin.PROBE_CALLS_PER_MINUTE,
        MINUTE,
        shared=True,
        why="Each call invokes the probe, which reads the organization and assumes roles (D17).",
    ),
    "admin.member_access": LimitSpec(
        admin.PROBE_CALLS_PER_MINUTE,
        MINUTE,
        shared=True,
        why="Each call invokes the probe once per member account, up to fifty (D51).",
    ),
    # --- Per task ----------------------------------------------------------------------------
    "models.refreshes": LimitSpec(
        MODEL_REFRESHES_PER_MINUTE,
        MINUTE,
        shared=False,
        why=(
            "Stops a loop of the screen. Each refresh is two free list calls to Bedrock by an "
            "administrator and writes nothing by itself; N times five a minute is harmless."
        ),
    ),
    "agents.lists": LimitSpec(
        AGENT_LISTS_PER_MINUTE,
        MINUTE,
        shared=False,
        why=(
            "Stops one person's loop over the lists of agents (marketplace and organization "
            "chart), which anyone signed in may read, cost several reads and write an audit "
            "event each. It holds no exception, and counting it in the table would add two "
            "calls to the very route it makes cheaper. The page asks at most four times a "
            "minute per tab; N times thirty a minute per person is still far below what a "
            "task serves."
        ),
    ),
    "session.starts": LimitSpec(
        web_session.STARTS_PER_USER,
        web_session.WINDOW_SECONDS,
        shared=False,
        why=(
            "Stops one person's loop from spending the request quota of Cognito, which is "
            "per account (TM-S10). No per-IP limit is behind it any more: the server renews "
            "with a signed operation that does not go through the WAF of the user pool "
            "(D72), so the number of tasks and their egress do not matter. N times ten "
            "every five minutes is far from that quota, and signing in must not depend on "
            "one more table."
        ),
    ),
    "session.renewals": LimitSpec(
        web_session.RENEWALS_PER_SESSION,
        web_session.WINDOW_SECONDS,
        shared=False,
        why=(
            "As ``session.starts``, per session. It is on the path of every reload: counting "
            "it in the table would add two calls to the most frequent route for a bound that "
            "holds no exception."
        ),
    ),
}


class Limits:
    """Builds each limiter of ``LIMITS``. Without a store (tests) all of them are in memory;
    with one, the shared ones count in it."""

    def __init__(
        self, store: RateLimitStore | None = None, clock: Callable[[], float] | None = None
    ) -> None:
        self._store = store
        self._clock = clock
        self.issued: dict[str, Limiter] = {}
        """What each name was given: lets a test see what the application runs with."""

    @property
    def shared(self) -> bool:
        return self._store is not None

    def limiter(self, name: str) -> Limiter:
        spec = LIMITS[name]
        limiter: Limiter
        if spec.shared and self._store is not None:
            limiter = SharedRateLimiter(
                self._store,
                name,
                spec.limit,
                spec.window_seconds,
                clock=self._clock or time.time,
            )
        else:
            limiter = RateLimiter(spec.limit, spec.window_seconds, self._clock or time.monotonic)
        self.issued[name] = limiter
        return limiter
