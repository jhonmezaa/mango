"""Steps of the provisioner that keep the Playground's test harness (D91).

The same state machine and the same role as an agent publication, with the same steps::

    load -> ensure_role -> ensure_harness -> check_harness* -> point_live -> check_live*
         -> govern_logs -> publish

The input is ``{"playground": "ensure", "release": <label>}`` (``mango_core.playground``):
the stack sends it on every deployment and mango-api when the enabled models change. Nothing
in it says what to deploy: the configuration is the code's (``playground_config``) and the
models are the catalog's, read in the steps that use them.

* **Skills (D91 (12)).** Its role reads every approved skill version (``skills/`` of the skills
  bucket); the harness has none of its own and mango-api names the tested version's in each
  invocation.
* **Not an agent.** No version, no ``PUBLISHED#`` pointer, no lock on an agent: ``publish``
  writes ``PLAYGROUND`` / ``HARNESS`` in the Settings table, which mango-api reads.
* **Converges by name.** A repeated or concurrent execution converges to the same harness;
  ``publish`` reads the catalog again and leaves the role with the models enabled then, so
  the last execution to finish wins with the newest catalog.
* **A failure leaves what is there.** The harness may serve tests with its previous version
  and models; nothing is deleted. The execution fails (the provisioner alarm) and the audit
  event says at which step.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from datetime import datetime
from typing import Any

from mango_core.playground import PLAYGROUND_ID, PlaygroundHarness, parse_provision_input
from mango_provisioner.audit import EVENT_PLAYGROUND, AuditWriter
from mango_provisioner.config import Settings
from mango_provisioner.errors import StepError
from mango_provisioner.harness import Harnesses, HarnessRef, playground_config
from mango_provisioner.role import AgentRoles
from mango_provisioner.runtime_logs import RuntimeLogs
from mango_provisioner.store import ProvisionerStore

STATE_FLAG = "playground"
_EXECUTION_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_HARNESS_VERSION_RE = re.compile(r"^[1-9][0-9]{0,4}$")
MAX_WAIT_ATTEMPTS = 60


def is_playground_state(state: object) -> bool:
    return isinstance(state, dict) and state.get(STATE_FLAG) is True


class Playground:
    def __init__(
        self,
        settings: Settings,
        *,
        store: ProvisionerStore,
        roles: AgentRoles,
        harnesses: Harnesses,
        logs: RuntimeLogs,
        audit: AuditWriter,
        clock: Callable[[], datetime],
    ) -> None:
        self._settings = settings
        self._store = store
        self._roles = roles
        self._harnesses = harnesses
        self._logs = logs
        self._audit = audit
        self._now = clock

    # --- State ----------------------------------------------------------------------------

    @staticmethod
    def _checked(state: dict[str, Any]) -> dict[str, Any]:
        execution, release = state.get("execution"), state.get("release")
        if (
            not isinstance(execution, str)
            or not _EXECUTION_RE.fullmatch(execution)
            or not isinstance(release, str)
        ):
            raise StepError("invalid_state")
        parse_provision_input({"playground": "ensure", "release": release})
        return state

    @staticmethod
    def _ref(state: dict[str, Any]) -> HarnessRef:
        harness_id, version = state.get("harness_id"), state.get("harness_version")
        if (
            not isinstance(harness_id, str)
            or not isinstance(version, str)
            or not _HARNESS_VERSION_RE.fullmatch(version)
        ):
            raise StepError("invalid_state")
        return HarnessRef(harness_id, version)

    def _models(self) -> frozenset[str]:
        models = self._store.enabled_models()
        if not models:
            raise StepError("model_not_enabled")
        return models

    def _emit(self, state: dict[str, Any], outcome: str, **extra: Any) -> None:
        release = state.get("release")
        try:
            parse_provision_input({"playground": "ensure", "release": release})
        except ValueError:
            # A rejected input is audited without echoing what it carried.
            release = None
        self._audit.emit(
            EVENT_PLAYGROUND,
            {
                "outcome": outcome,
                "release": release,
                "execution": state.get("execution"),
                **extra,
            },
            self._now(),
        )

    # --- Steps ----------------------------------------------------------------------------

    def load(self, raw_input: object, execution: object) -> dict[str, Any]:
        try:
            release = parse_provision_input(raw_input)
        except ValueError:
            raise StepError("invalid_input") from None
        state = self._checked(
            {
                STATE_FLAG: True,
                "agent_id": PLAYGROUND_ID,
                "release": release,
                "execution": execution,
            }
        )
        # Everything the harness needs is known before anything is created.
        playground_config(self._settings, self._models())
        self._emit(state, "requested")
        return {**state, "action": "publish"}

    def ensure_role(self, state: dict[str, Any]) -> dict[str, Any]:
        # Every approved skill version (D91 (12)): the tested version's come in the invocation.
        self._roles.ensure(PLAYGROUND_ID, self._models(), all_skills=True)
        return self._checked(state)

    def ensure_harness(self, state: dict[str, Any]) -> dict[str, Any]:
        state = self._checked(state)
        ref = self._harnesses.ensure(
            PLAYGROUND_ID,
            playground_config(self._settings, self._models()),
            execution=state["execution"],
            known_arn=None,
            # A harness left failed is deleted and created again: it serves nobody yet.
            published=False,
        )
        return {
            **state,
            "harness_id": ref.harness_id,
            "harness_version": ref.version,
            "ready": False,
            "attempts": 0,
        }

    def check_harness(self, state: dict[str, Any]) -> dict[str, Any]:
        state = self._checked(state)
        status = self._harnesses.status(PLAYGROUND_ID, self._ref(state))
        if status.ready:
            return {**state, "ready": True, "runtime_id": status.runtime_id, "attempts": 0}
        return self._waiting(state, "harness_timeout")

    def point_live(self, state: dict[str, Any]) -> dict[str, Any]:
        state = self._checked(state)
        ref = self._ref(state)
        self._harnesses.point_live(
            PLAYGROUND_ID, ref.harness_id, ref.version, execution=state["execution"]
        )
        return {**state, "ready": False, "attempts": 0}

    def check_live(self, state: dict[str, Any]) -> dict[str, Any]:
        state = self._checked(state)
        ref = self._ref(state)
        if self._harnesses.live_ready(ref.harness_id, ref.version):
            return {**state, "ready": True, "attempts": 0}
        return self._waiting(state, "endpoint_timeout")

    @staticmethod
    def _waiting(state: dict[str, Any], timeout_code: str) -> dict[str, Any]:
        attempts = int(state.get("attempts", 0)) + 1
        if attempts > MAX_WAIT_ATTEMPTS:
            raise StepError(timeout_code)
        return {**state, "ready": False, "attempts": attempts}

    def govern_logs(self, state: dict[str, Any]) -> dict[str, Any]:
        state = self._checked(state)
        runtime_id = state.get("runtime_id")
        if not isinstance(runtime_id, str) or not self._settings.runtime_id_pattern(
            PLAYGROUND_ID
        ).fullmatch(runtime_id):
            raise StepError("runtime_reference_invalid")
        self._logs.govern(PLAYGROUND_ID, runtime_id)
        return state

    def publish(self, state: dict[str, Any]) -> dict[str, Any]:
        state = self._checked(state)
        ref = self._ref(state)
        if not self._settings.harness_id_pattern(PLAYGROUND_ID).fullmatch(ref.harness_id):
            raise StepError("harness_reference_invalid")
        if not self._harnesses.live_ready(ref.harness_id, ref.version):
            raise StepError("endpoint_not_ready")
        # The catalog again: a model enabled or disabled during the execution counts now.
        models = self._models()
        self._roles.ensure(PLAYGROUND_ID, models, all_skills=True)
        harness_arn = self._settings.harness_arn(ref.harness_id)
        self._store.write_playground(
            PlaygroundHarness(
                harness_arn=harness_arn,
                harness_version=ref.version,
                models=tuple(sorted(models)),
                updated_at=self._now().isoformat(timespec="seconds"),
                skills=bool(self._settings.skills_bucket and self._settings.skills_key_arn),
            )
        )
        self._emit(
            state,
            "applied",
            harness_arn=harness_arn,
            harness_version=ref.version,
            models=len(models),
        )
        return {**state, "published": True}

    # --- Failure path ---------------------------------------------------------------------

    @staticmethod
    def compensate(state: dict[str, Any]) -> dict[str, Any]:
        """Nothing to undo: a failure leaves the harness as it was (module docstring)."""
        return {**state, "compensated": False}

    def mark_failed(self, state: dict[str, Any], step: str, code: str) -> dict[str, Any]:
        self._emit(state, "rejected", failed_step=step, failure=code)
        return {**state, "failed_step": step, "failure": code, "marked": True}
