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

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_core import evals_harness
from mango_core.playground import PLAYGROUND_ID, PlaygroundHarness
from mango_core.playground import parse_provision_input as parse_playground_input
from mango_provisioner.audit import EVENT_EVALS, EVENT_PLAYGROUND, AuditWriter
from mango_provisioner.config import Settings
from mango_provisioner.errors import StepError, aws_error
from mango_provisioner.harness import Harnesses, HarnessRef, evals_config, playground_config
from mango_provisioner.role import AgentRoles
from mango_provisioner.runtime_logs import RuntimeLogs
from mango_provisioner.store import ProvisionerStore

if TYPE_CHECKING:
    from mypy_boto3_lambda import LambdaClient

STATE_FLAG = "playground"
EVALS_FLAG = "evals"


@dataclass(frozen=True)
class Kind:
    """What changes between the shared test harnesses: the Playground's (D91), without content,
    and the evals' (D110), the only one with content, its own log key and a canary."""

    agent_id: str
    flag: str
    event: str
    parse: Callable[[object], str]
    config: Callable[[Settings, frozenset[str]], dict[str, Any]]
    unified_traces: bool


PLAYGROUND = Kind(
    agent_id=PLAYGROUND_ID,
    flag=STATE_FLAG,
    event=EVENT_PLAYGROUND,
    parse=parse_playground_input,
    config=playground_config,
    unified_traces=False,
)
EVALS = Kind(
    agent_id=evals_harness.EVALS_ID,
    flag=EVALS_FLAG,
    event=EVENT_EVALS,
    parse=evals_harness.parse_provision_input,
    config=evals_config,
    unified_traces=True,
)
_EXECUTION_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_HARNESS_VERSION_RE = re.compile(r"^[1-9][0-9]{0,4}$")
MAX_WAIT_ATTEMPTS = 60


def is_playground_state(state: object) -> bool:
    return isinstance(state, dict) and state.get(STATE_FLAG) is True


def is_evals_state(state: object) -> bool:
    return isinstance(state, dict) and state.get(EVALS_FLAG) is True


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
        kind: Kind = PLAYGROUND,
        judge: LambdaClient | None = None,
        release_skills: Callable[[], None] | None = None,
    ) -> None:
        self._kind = kind
        self._release_skills = release_skills
        self._judge = judge
        self._settings = settings
        self._store = store
        self._roles = roles
        self._harnesses = harnesses
        self._logs = logs
        self._audit = audit
        self._now = clock

    # --- State ----------------------------------------------------------------------------

    def _checked(self, state: dict[str, Any]) -> dict[str, Any]:
        execution, release = state.get("execution"), state.get("release")
        if (
            not isinstance(execution, str)
            or not _EXECUTION_RE.fullmatch(execution)
            or not isinstance(release, str)
        ):
            raise StepError("invalid_state")
        self._kind.parse({self._kind.flag: "ensure", "release": release})
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
            self._kind.parse({self._kind.flag: "ensure", "release": release})
        except ValueError:
            # A rejected input is audited without echoing what it carried.
            release = None
        self._audit.emit(
            self._kind.event,
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
            release = self._kind.parse(raw_input)
        except ValueError:
            raise StepError("invalid_input") from None
        if self._kind.unified_traces and not (
            self._settings.evals_logs_key_arn and self._settings.eval_judge_function
        ):
            raise StepError("evals_unavailable")
        state = self._checked(
            {
                self._kind.flag: True,
                "agent_id": self._kind.agent_id,
                "release": release,
                "execution": execution,
            }
        )
        # Everything the harness needs is known before anything is created.
        self._kind.config(self._settings, self._models())
        self._emit(state, "requested")
        return {**state, "action": "publish"}

    def ensure_role(self, state: dict[str, Any]) -> dict[str, Any]:
        # Every approved skill version (D91 (12)): the tested version's come in the invocation.
        self._roles.ensure(
            self._kind.agent_id,
            self._models(),
            all_skills=True,
            unified_traces=self._kind.unified_traces,
        )
        return self._checked(state)

    def ensure_harness(self, state: dict[str, Any]) -> dict[str, Any]:
        state = self._checked(state)
        if self._release_skills is not None and self._settings.skills_bucket:
            # A tested version that runs code gets the document skills of the release in its
            # invocation (D119): they must be in the bucket before mango-api names them.
            self._release_skills()
        ref = self._harnesses.ensure(
            self._kind.agent_id,
            self._kind.config(self._settings, self._models()),
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
        status = self._harnesses.status(self._kind.agent_id, self._ref(state))
        if status.ready:
            return {**state, "ready": True, "runtime_id": status.runtime_id, "attempts": 0}
        return self._waiting(state, "harness_timeout")

    def point_live(self, state: dict[str, Any]) -> dict[str, Any]:
        state = self._checked(state)
        ref = self._ref(state)
        self._harnesses.point_live(
            self._kind.agent_id, ref.harness_id, ref.version, execution=state["execution"]
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
            self._kind.agent_id
        ).fullmatch(runtime_id):
            raise StepError("runtime_reference_invalid")
        # D110 (3): the evals harness's log group gets its own key, before anything runs on it.
        key = self._settings.evals_logs_key_arn if self._kind.unified_traces else None
        # D110 (9): bind the key again while no eval may run (the capture is not verified), so
        # X-Ray delivers the spans; once the canary verified, the log groups are left alone.
        rebind = self._kind.unified_traces and not self._store.evals_capture_verified()
        self._logs.govern(self._kind.agent_id, runtime_id, key, rebind=rebind)
        return state

    def publish(self, state: dict[str, Any]) -> dict[str, Any]:
        state = self._checked(state)
        ref = self._ref(state)
        if not self._settings.harness_id_pattern(self._kind.agent_id).fullmatch(ref.harness_id):
            raise StepError("harness_reference_invalid")
        if not self._harnesses.live_ready(ref.harness_id, ref.version):
            raise StepError("endpoint_not_ready")
        # The catalog again: a model enabled or disabled during the execution counts now.
        models = self._models()
        self._roles.ensure(
            self._kind.agent_id,
            models,
            all_skills=True,
            unified_traces=self._kind.unified_traces,
        )
        harness_arn = self._settings.harness_arn(ref.harness_id)
        deployed = PlaygroundHarness(
            harness_arn=harness_arn,
            harness_version=ref.version,
            models=tuple(sorted(models)),
            updated_at=self._now().isoformat(timespec="seconds"),
            skills=bool(self._settings.skills_bucket and self._settings.skills_key_arn),
        )
        if self._kind.unified_traces:
            runtime_id = state.get("runtime_id")
            if not isinstance(runtime_id, str) or not self._settings.runtime_id_pattern(
                self._kind.agent_id
            ).fullmatch(runtime_id):
                raise StepError("runtime_reference_invalid")
            self._publish_evals(evals_harness.EvalsHarness(deployed, runtime_id))
        else:
            self._store.write_playground(deployed)
        self._emit(
            state,
            "applied",
            harness_arn=harness_arn,
            harness_version=ref.version,
            models=len(models),
        )
        return {**state, "published": True}

    def _publish_evals(self, harness: evals_harness.EvalsHarness) -> None:
        """D110 (8): the capture is ``pending`` before mango-api may read the new version, and
        only the canary of the evaluator turns it ``verified``. Until then no eval runs."""
        deployed = harness.deployed
        self._store.write_test_harness(
            evals_harness.Capture(
                status="pending",
                harness_version=deployed.harness_version,
                checked_at=deployed.updated_at,
                reason=None,
            ).item()
        )
        self._store.write_test_harness(harness.item())
        if self._judge is None:
            raise StepError("evals_unavailable")
        try:
            # Asynchronous: the canary waits for the trace to reach CloudWatch (minutes).
            self._judge.invoke(
                FunctionName=self._settings.eval_judge_function,
                InvocationType="Event",
                Payload=json.dumps(
                    {"action": "canary", "harness_version": deployed.harness_version}
                ).encode(),
            )
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("Invoke", exc) from None

    # --- Failure path ---------------------------------------------------------------------

    @staticmethod
    def compensate(state: dict[str, Any]) -> dict[str, Any]:
        """Nothing to undo: a failure leaves the harness as it was (module docstring)."""
        return {**state, "compensated": False}

    def mark_failed(self, state: dict[str, Any], step: str, code: str) -> dict[str, Any]:
        self._emit(state, "rejected", failed_step=step, failure=code)
        return {**state, "failed_step": step, "failure": code, "marked": True}
