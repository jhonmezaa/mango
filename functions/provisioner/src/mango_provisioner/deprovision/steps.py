"""Steps of the agent deprovisioner state machine (D48).

Removing what a retired agent left in AWS::

    load -> delete_endpoints* -> delete_harness* -> delete_role -> finish

and on any error: ``mark_failed``. Nothing is undone: a removal that fails is reported and
repeated, and every step converges to "the resource is gone".

Rules every step follows:

* **Input is the agent id only.** Whether the agent may be deprovisioned is read again by
  every step: it must be ``retired``, the version it served must be ``retired`` too, and it
  must not be an agent the release ships. Nothing else is ever deleted.
* **Only the names the provisioner derives from that id**: the harness ``Mango_<ns>_a_<id>``
  and the role ``Mango-<ns>-agent-<id>``. No reference stored in the table is followed.
* **One execution per agent**: the same lock as the agent provisioner (TM-M9), which every
  step extends. A publication still running for the agent finishes (and fails) first.
* **Order matters.** A harness cannot be deleted while it has endpoints other than
  ``DEFAULT``, and deleting an endpoint is asynchronous; the role goes last, once the harness
  that runs with it is gone.
* **History stays** (D22): versions remain ``retired`` and the ``PUBLISHED#`` pointer is not
  touched. The state carries identifiers and flags only.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from mango_core.agents import AgentStatus, VersionStatus, is_agent_id
from mango_provisioner.audit import EVENT_DEPROVISION, AuditWriter
from mango_provisioner.deprovision.config import DeprovisionSettings
from mango_provisioner.deprovision.resources import DELETING, RetiredHarnesses, RetiredRoles
from mango_provisioner.deprovision.store import DeprovisionStore
from mango_provisioner.errors import BusyError, RetryableError, StepError
from mango_provisioner.steps import failure_of

ACTION_DEPROVISION = "deprovision"
ACTION_NOOP = "noop"
MAX_WAIT_ATTEMPTS = 90
"""Polls of an endpoint or harness deletion before giving up. The state machine waits 10 s
between them: 15 minutes, and an endpoint took about 7 to go in the lab."""

_INPUT_KEYS = frozenset({"agent_id"})
_EXECUTION_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


def parse_input(raw: object, execution: object) -> tuple[str, str]:
    """The execution input: exactly ``{agent_id}``, nothing else."""
    if not isinstance(raw, dict) or set(raw) != _INPUT_KEYS:
        raise StepError("invalid_input")
    return _request({**raw, "execution": execution})


def _request(state: object) -> tuple[str, str]:
    if not isinstance(state, dict):
        raise StepError("invalid_input")
    agent_id, execution = state.get("agent_id"), state.get("execution")
    if (
        not is_agent_id(agent_id)
        or not isinstance(execution, str)
        or not _EXECUTION_RE.fullmatch(execution)
    ):
        raise StepError("invalid_input")
    return str(agent_id), execution


class Deprovisioner:
    def __init__(
        self,
        settings: DeprovisionSettings,
        *,
        store: DeprovisionStore,
        harnesses: RetiredHarnesses,
        roles: RetiredRoles,
        audit: AuditWriter,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._settings = settings
        self._store = store
        self._harnesses = harnesses
        self._roles = roles
        self._audit = audit
        self._now = clock

    # --- Shared checks --------------------------------------------------------------------

    def _retired(self, agent_id: str) -> int | None:
        """Refuse anything that is not a retired agent made in the installation.

        Returns the version the agent served, if the provisioner ever published one.
        """
        meta = self._store.meta(agent_id)
        if meta is None:
            raise StepError("agent_not_found")
        if meta.status is not AgentStatus.RETIRED:
            raise StepError("not_retired")
        if agent_id in self._settings.release_agents:
            raise StepError("release_agent")
        pointer = self._store.pointer(agent_id)
        if pointer is None:
            return None
        if self._store.version_status(agent_id, pointer.version) is not VersionStatus.RETIRED:
            # The retirement did not reach the version that is live: not ours to remove.
            raise StepError("version_not_retired")
        return pointer.version

    def _guard(self, state: dict[str, Any]) -> tuple[str, int | None]:
        """The agent of a step, and the version it served: the step holds (and extends) the
        lock and the agent may still be deprovisioned."""
        agent_id, execution = _request(state)
        self._store.hold_lock(agent_id, execution, self._now())
        return agent_id, self._retired(agent_id)

    @staticmethod
    def _waiting(state: dict[str, Any], timeout_code: str) -> dict[str, Any]:
        attempts = int(state.get("attempts", 0)) + 1
        if attempts > MAX_WAIT_ATTEMPTS:
            raise StepError(timeout_code)
        return {**state, "ready": False, "attempts": attempts}

    # --- Steps ----------------------------------------------------------------------------

    def load(self, raw_input: object, execution: object) -> dict[str, Any]:
        agent_id, owner = parse_input(raw_input, execution)
        state = {"agent_id": agent_id, "execution": owner}
        meta = self._store.meta(agent_id)
        if meta is None:
            raise StepError("agent_not_found")
        if meta.status is not AgentStatus.RETIRED:
            raise StepError("not_retired")
        if agent_id in self._settings.release_agents:
            # The agents of the release keep their resources (D34): nothing to do, no error.
            return {**state, "action": ACTION_NOOP, "reason": "release_agent"}
        if self._harnesses.find(agent_id) is None and not self._roles.exists(agent_id):
            # Repeating a finished removal changes nothing.
            return {**state, "action": ACTION_NOOP, "reason": "nothing_left"}
        try:
            self._store.hold_lock(agent_id, owner, self._now())
        except BusyError:
            # A publication of this agent is still running; it fails on the retired agent and
            # releases the lock. The state machine keeps trying until then.
            raise RetryableError("busy") from None
        # From here on, a failure is audited as rejected.
        version = self._retired(agent_id)
        self._audit.emit(EVENT_DEPROVISION, self._detail(state, "requested", version), self._now())
        return {**state, "action": ACTION_DEPROVISION, "ready": False, "attempts": 0}

    def delete_endpoints(self, state: dict[str, Any]) -> dict[str, Any]:
        agent_id, _ = self._guard(state)
        harness = self._harnesses.find(agent_id)
        if harness is None or self._harnesses.delete_endpoints(harness.harness_id) == 0:
            return {**state, "ready": True, "attempts": 0}
        return self._waiting(state, "endpoint_delete_timeout")

    def delete_harness(self, state: dict[str, Any]) -> dict[str, Any]:
        agent_id, _ = self._guard(state)
        harness = self._harnesses.find(agent_id)
        if harness is None:
            return {**state, "ready": True, "attempts": 0}
        # An endpoint created meanwhile would block the deletion: remove it first.
        if harness.status != DELETING and self._harnesses.delete_endpoints(harness.harness_id) == 0:
            self._harnesses.delete(harness.harness_id)
        return self._waiting(state, "harness_delete_timeout")

    def delete_role(self, state: dict[str, Any]) -> dict[str, Any]:
        agent_id, _ = self._guard(state)
        if self._harnesses.find(agent_id) is not None:
            # Never take the role away from a harness that still exists. A listing may lag
            # behind the deletion, so this is tried again before it counts as a failure.
            raise RetryableError("harness_remaining")
        self._roles.delete(agent_id)
        return state

    def finish(self, state: dict[str, Any]) -> dict[str, Any]:
        agent_id, version = self._guard(state)
        if self._harnesses.find(agent_id) is not None or self._roles.exists(agent_id):
            # IAM is eventually consistent: a role deleted a moment ago may still be read.
            raise RetryableError("resources_remaining")
        self._audit.emit(EVENT_DEPROVISION, self._detail(state, "applied", version), self._now())
        self._store.release_lock(agent_id, str(state["execution"]))
        return {**state, "deprovisioned": True}

    # --- Failure path ---------------------------------------------------------------------

    def mark_failed(self, state: object) -> dict[str, Any]:
        """Audit the failure and release the lock. The resources that are left are reported
        by the daily reconciliation until a new execution removes them."""
        out: dict[str, Any] = dict(state) if isinstance(state, dict) else {}
        step, code = failure_of(out.get("error"), out.get("last_step"))
        result = {**out, "failed_step": step, "failure": code, "marked": False}
        try:
            agent_id, execution = _request(out)
        except StepError:
            return result
        meta = self._store.meta(agent_id)
        if meta is None or meta.lock_owner != execution:
            # Refused before taking the agent, or another execution owns it: nothing started.
            return result
        self._audit.emit(
            EVENT_DEPROVISION,
            {**self._detail(out, "rejected", None), "failed_step": step, "failure": code},
            self._now(),
        )
        self._store.release_lock(agent_id, execution)
        return {**result, "marked": True}

    def _detail(self, state: dict[str, Any], outcome: str, version: int | None) -> dict[str, Any]:
        agent_id = str(state["agent_id"])
        detail: dict[str, Any] = {
            "agent": agent_id,
            "outcome": outcome,
            "execution": state["execution"],
            "harness": self._settings.harness_name(agent_id),
            "role": self._settings.role_name(agent_id),
        }
        if version is not None:
            detail["version"] = version
        return detail
