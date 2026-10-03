"""Steps of the agent provisioner state machine (spec §5, plan A4).

Publishing an approved version::

    load -> ensure_role -> ensure_harness -> check_harness* -> point_live -> check_live*
         -> govern_logs -> publish

and on any error: ``compensate -> mark_failed``.

Rules every step follows:

* **Input is identifiers only** (``agent_id``, ``version``, ``content_hash``). Each step reads
  the version again and checks the stored content against the approved hash before acting,
  so the definition never travels in the execution state and cannot change on the way
  (TM-M1, TM-M2).
* **One execution per agent** (lock on the agent's ``META`` item, TM-M9). A step that does not
  hold the lock changes nothing.
* **Idempotent by name.** Resources are found by their derived names; a repeated step, or a
  whole repeated execution, converges to the same result.
* **Release agents** (FinOps) arrive already approved by the release (D34). Such a version is
  published only when its id and hash are the ones the stack says this release ships.
* **Compensation converges to what is published**, read from the ``PUBLISHED#`` pointer that
  only the provisioner can write. An agent that was never published keeps no role, harness
  or log groups; a published agent gets its ``live`` endpoint and role policy back to the
  published version. This needs no bookkeeping of what this execution created, so it is safe
  after a crash in the middle of a step, and nothing mango-api writes can make it delete the
  resources of a published agent.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from mango_core.agents import (
    AgentDefinition,
    AgentStatus,
    InvalidDefinitionError,
    VersionStatus,
    is_agent_id,
    loads_definition,
    verify_content,
)
from mango_core.agents_table import MAX_VERSION
from mango_provisioner.audit import EVENT_PUBLISHED, AuditWriter
from mango_provisioner.config import RELEASE_APPROVER_PREFIX, Settings
from mango_provisioner.errors import BusyError, RetryableError, StepError
from mango_provisioner.harness import Harnesses, HarnessRef, harness_config
from mango_provisioner.role import AgentRoles
from mango_provisioner.runtime_logs import RuntimeLogs
from mango_provisioner.store import Meta, ProvisionerStore, Published, Version

ACTION_PUBLISH = "publish"
ACTION_NOOP = "noop"
MAX_WAIT_ATTEMPTS = 60
"""Polls of a harness or endpoint before giving up (the state machine waits between them)."""

_INPUT_KEYS = frozenset({"agent_id", "version", "content_hash"})
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_EXECUTION_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_HARNESS_VERSION_RE = re.compile(r"^[1-9][0-9]{0,4}$")
_STEP_RE = re.compile(r"^[a-z][a-z0-9_]{0,47}$")
_CODE_RE = re.compile(r"[^A-Za-z0-9_.:-]")
COMPENSATION_FAILED = "compensation_failed"


@dataclass(frozen=True)
class Request:
    agent_id: str
    version: int
    content_hash: str
    execution: str

    def state(self) -> dict[str, Any]:
        return {
            "agent_id": self.agent_id,
            "version": self.version,
            "content_hash": self.content_hash,
            "execution": self.execution,
        }


@dataclass(frozen=True)
class Context:
    """An approved version, verified against its hash, read under this execution's lock."""

    request: Request
    meta: Meta
    version: Version
    definition: AgentDefinition


def parse_input(raw: object, execution: object) -> Request:
    """The execution input: exactly ``{agent_id, version, content_hash}``, nothing else."""
    if not isinstance(raw, dict) or set(raw) != _INPUT_KEYS:
        raise StepError("invalid_input")
    return _request({**raw, "execution": execution})


def _request(state: object) -> Request:
    if not isinstance(state, dict):
        raise StepError("invalid_input")
    agent_id, version = state.get("agent_id"), state.get("version")
    content_hash, execution = state.get("content_hash"), state.get("execution")
    if (
        not is_agent_id(agent_id)
        or isinstance(version, bool)
        or not isinstance(version, int)
        or not 1 <= version <= MAX_VERSION
        or not isinstance(content_hash, str)
        or not _HASH_RE.fullmatch(content_hash)
        or not isinstance(execution, str)
        or not _EXECUTION_RE.fullmatch(execution)
    ):
        raise StepError("invalid_input")
    return Request(str(agent_id), version, content_hash, execution)


def _harness_ref(state: dict[str, Any]) -> HarnessRef:
    harness_id, version = state.get("harness_id"), state.get("harness_version")
    if (
        not isinstance(harness_id, str)
        or not isinstance(version, str)
        or not _HARNESS_VERSION_RE.fullmatch(version)
    ):
        raise StepError("invalid_state")
    return HarnessRef(harness_id, version)


def failure_of(error: object, last_step: object) -> tuple[str, str]:
    """``(failed_step, code)`` from what Step Functions caught.

    A step error carries ``{"step", "code"}`` as its message; anything else (a timeout, a
    crash) is reported by its error name, after the last step that completed.
    """
    fallback = f"after_{last_step}" if isinstance(last_step, str) and last_step else "unknown"
    name = cause = ""
    if isinstance(error, dict):
        name, cause = str(error.get("Error", "")), str(error.get("Cause", ""))
    try:
        message = json.loads(json.loads(cause)["errorMessage"])
        step, code = str(message["step"]), str(message["code"])
    except (ValueError, KeyError, TypeError):
        step, code = fallback, name or "unknown"
    if not _STEP_RE.fullmatch(step):
        step = fallback if _STEP_RE.fullmatch(fallback) else "unknown"
    return step, _CODE_RE.sub("_", code)[:80] or "unknown"


class Provisioner:
    def __init__(
        self,
        settings: Settings,
        *,
        store: ProvisionerStore,
        roles: AgentRoles,
        harnesses: Harnesses,
        logs: RuntimeLogs,
        audit: AuditWriter,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._settings = settings
        self._store = store
        self._roles = roles
        self._harnesses = harnesses
        self._logs = logs
        self._audit = audit
        self._now = clock

    # --- Shared checks --------------------------------------------------------------------

    def _context(self, request: Request) -> Context:
        meta = self._store.meta(request.agent_id)
        version = self._store.version(request.agent_id, request.version)
        if meta is None or version is None:
            raise StepError("version_not_found")
        if meta.lock_owner != request.execution:
            raise BusyError
        if meta.status is AgentStatus.RETIRED:
            raise StepError("agent_retired")
        if version.status is not VersionStatus.APPROVED or meta.open_version != request.version:
            raise StepError("not_approved")
        if version.content_hash != request.content_hash or not verify_content(
            version.canonical, request.content_hash
        ):
            raise StepError("hash_mismatch")
        self._check_release_approval(request, version)
        try:
            definition = loads_definition(version.canonical)
        except InvalidDefinitionError:
            raise StepError("invalid_definition") from None
        return Context(request, meta, version, definition)

    def _check_release_approval(self, request: Request, version: Version) -> None:
        """A version approved by the release, not by a person, is only published if it is
        exactly an agent this release ships (D34, TM-M16): its id and its content hash come
        from the stack, not from the table. People approve through mango-api, whose user ids
        never look like a release approver."""
        if not (version.approved_by or "").startswith(RELEASE_APPROVER_PREFIX):
            return
        if self._settings.release_agents.get(request.agent_id) != request.content_hash:
            raise StepError("release_approval_invalid")

    def _models(self, definition: AgentDefinition) -> tuple[str, ...]:
        """Allowed models of a version being published: all must be enabled in the catalog."""
        enabled = self._store.enabled_models()
        if not definition.allowed_models or not set(definition.allowed_models) <= enabled:
            raise StepError("model_not_enabled")
        return definition.allowed_models

    def _published_models(self, agent_id: str, published: Published | None) -> tuple[str, ...]:
        """Models of the version that is live and are still enabled (nothing wider)."""
        if published is None:
            return ()
        version = self._store.version(agent_id, published.version)
        if version is None or not verify_content(version.canonical, published.content_hash):
            return ()
        try:
            allowed = loads_definition(version.canonical).allowed_models
        except InvalidDefinitionError:
            return ()
        enabled = self._store.enabled_models()
        return tuple(m for m in allowed if m in enabled)

    def _audit_detail(self, ctx: Context, outcome: str, **extra: Any) -> dict[str, Any]:
        return {
            "agent": ctx.request.agent_id,
            "version": ctx.request.version,
            "content_hash": ctx.request.content_hash,
            "outcome": outcome,
            "created_by": ctx.version.created_by,
            "approved_by": ctx.version.approved_by,
            "execution": ctx.request.execution,
            **extra,
        }

    # --- Forward steps --------------------------------------------------------------------

    def load(self, raw_input: object, execution: object) -> dict[str, Any]:
        request = parse_input(raw_input, execution)
        meta = self._store.meta(request.agent_id)
        version = self._store.version(request.agent_id, request.version)
        if meta is None or version is None:
            raise StepError("version_not_found")
        if (
            version.status is VersionStatus.PUBLISHED
            and version.content_hash == request.content_hash
            and meta.published_version == request.version
        ):
            # Repeating a finished publication changes nothing.
            return {**request.state(), "action": ACTION_NOOP}
        if version.status is not VersionStatus.APPROVED:
            raise StepError("not_approved")
        self._store.acquire_lock(request.agent_id, request.execution, self._now())
        # From here on, a failure marks the version as failed.
        ctx = self._context(request)
        self._models(ctx.definition)
        harness_config(
            self._settings,
            agent_id=request.agent_id,
            version=request.version,
            content_hash=request.content_hash,
            definition=ctx.definition,
            pack_tools=self._store.installed_pack_tools,
        )
        self._audit.emit(EVENT_PUBLISHED, self._audit_detail(ctx, "requested"), self._now())
        return {**request.state(), "action": ACTION_PUBLISH}

    def ensure_role(self, state: dict[str, Any]) -> dict[str, Any]:
        ctx = self._context(_request(state))
        agent_id = ctx.request.agent_id
        # The published version keeps serving until the last step: its models stay allowed.
        published = self._store.published(agent_id)
        models = {*self._models(ctx.definition), *self._published_models(agent_id, published)}
        self._roles.ensure(agent_id, models)
        return state

    def ensure_harness(self, state: dict[str, Any]) -> dict[str, Any]:
        ctx = self._context(_request(state))
        request = ctx.request
        config = harness_config(
            self._settings,
            agent_id=request.agent_id,
            version=request.version,
            content_hash=request.content_hash,
            definition=ctx.definition,
            pack_tools=self._store.installed_pack_tools,
        )
        published = self._store.published(request.agent_id)
        ref = self._harnesses.ensure(
            request.agent_id,
            config,
            execution=request.execution,
            known_arn=published.harness_arn if published else None,
            published=published is not None,
        )
        return {
            **state,
            "harness_id": ref.harness_id,
            "harness_version": ref.version,
            "ready": False,
            "attempts": 0,
        }

    def check_harness(self, state: dict[str, Any]) -> dict[str, Any]:
        request = _request(state)
        status = self._harnesses.status(request.agent_id, _harness_ref(state))
        if status.ready:
            return {**state, "ready": True, "runtime_id": status.runtime_id, "attempts": 0}
        return self._waiting(state, "harness_timeout")

    def point_live(self, state: dict[str, Any]) -> dict[str, Any]:
        ctx = self._context(_request(state))
        ref = _harness_ref(state)
        self._harnesses.point_live(
            ctx.request.agent_id, ref.harness_id, ref.version, execution=ctx.request.execution
        )
        return {**state, "ready": False, "attempts": 0}

    def check_live(self, state: dict[str, Any]) -> dict[str, Any]:
        ref = _harness_ref(state)
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
        ctx = self._context(_request(state))
        runtime_id = state.get("runtime_id")
        if not isinstance(runtime_id, str) or not self._settings.runtime_id_pattern(
            ctx.request.agent_id
        ).fullmatch(runtime_id):
            raise StepError("runtime_reference_invalid")
        self._logs.govern(ctx.request.agent_id, runtime_id)
        return state

    def publish(self, state: dict[str, Any]) -> dict[str, Any]:
        request = _request(state)
        ref = _harness_ref(state)
        harness_arn = self._settings.harness_arn(ref.harness_id)
        meta = self._store.meta(request.agent_id)
        version = self._store.version(request.agent_id, request.version)
        if meta is None or version is None:
            raise StepError("version_not_found")
        if meta.lock_owner != request.execution:
            raise BusyError
        already = (
            version.status is VersionStatus.PUBLISHED
            and version.content_hash == request.content_hash
            and meta.published_version == request.version
            and meta.harness_arn == harness_arn
            and meta.harness_version == ref.version
        )
        if already:
            # A retry of this step after the transaction went through.
            definition = loads_definition(version.canonical)
            ctx = Context(request, meta, version, definition)
        else:
            ctx = self._context(request)
            # Last check before serving it: `live` must be on the version we deployed.
            if not self._harnesses.live_ready(ref.harness_id, ref.version):
                raise StepError("endpoint_not_ready")
            # The version being replaced comes from the pointer; if META disagrees with it,
            # the transaction's condition fails and nothing is published.
            live = self._store.published(request.agent_id)
            self._store.publish(
                agent_id=request.agent_id,
                version=request.version,
                content_hash=request.content_hash,
                previous_version=live.version if live else None,
                harness_arn=harness_arn,
                harness_version=ref.version,
                now=self._now(),
            )
        # The previous version no longer serves: the role keeps only this version's models.
        self._roles.ensure(request.agent_id, self._models(ctx.definition))
        self._audit.emit(
            EVENT_PUBLISHED,
            self._audit_detail(
                ctx, "applied", harness_arn=harness_arn, harness_version=ref.version
            ),
            self._now(),
        )
        self._store.release_lock(request.agent_id, request.execution)
        return {**state, "published": True}

    # --- Failure path ---------------------------------------------------------------------

    def compensate(self, state: object) -> dict[str, Any]:
        """Put the agent's resources back to what is published (see module docstring)."""
        out: dict[str, Any] = dict(state) if isinstance(state, dict) else {}
        try:
            request = _request(out)
        except StepError:
            return {**out, "compensated": False}
        meta = self._store.meta(request.agent_id)
        if meta is None or meta.lock_owner != request.execution:
            # Not ours to touch: another execution owns the agent, or nothing was started.
            return {**out, "compensated": False}
        agent_id = request.agent_id
        published = self._store.published(agent_id)
        harness = self._harnesses.find(agent_id, published.harness_arn if published else None)
        if published is None:
            if harness is not None:
                runtime = (harness.get("environment") or {}).get("agentCoreRuntimeEnvironment")
                runtime_id = str((runtime or {}).get("agentRuntimeId") or "")
                if self._settings.runtime_id_pattern(agent_id).fullmatch(runtime_id):
                    self._logs.delete(runtime_id)
                if harness["status"] != "DELETING":
                    self._harnesses.delete(str(harness["harnessId"]))
                # Asynchronous: the state machine retries until the harness is gone, and only
                # then removes the role it runs with.
                raise RetryableError("harness_deleting")
            self._roles.delete(agent_id)
        elif meta.status is not AgentStatus.RETIRED:
            if harness is not None:
                self._harnesses.point_live(
                    agent_id,
                    str(harness["harnessId"]),
                    published.harness_version,
                    execution=f"{request.execution}-undo",
                )
            models = self._published_models(agent_id, published)
            if models and self._roles.exists(agent_id):
                self._roles.ensure(agent_id, models)
        return {**out, "compensated": True}

    def mark_failed(self, state: object) -> dict[str, Any]:
        """Record the failure on the version, audit it and release the lock."""
        out: dict[str, Any] = dict(state) if isinstance(state, dict) else {}
        step, code = failure_of(out.get("error"), out.get("last_step"))
        if out.get("compensation_error") is not None:
            code = f"{code};{COMPENSATION_FAILED}"[:80]
        result = {**out, "failed_step": step, "failure": code, "marked": False}
        try:
            request = _request(out)
        except StepError:
            return result
        meta = self._store.meta(request.agent_id)
        if meta is None or meta.lock_owner != request.execution:
            return result
        now = self._now()
        marked = self._store.fail(
            agent_id=request.agent_id,
            version=request.version,
            failed_step=step,
            failure=code,
            now=now,
        )
        version = self._store.version(request.agent_id, request.version)
        # Still holding the lock with the version already failed: a retry of this step whose
        # audit event did not get through. The lock is only released once it is written.
        pending_audit = version is not None and version.status is VersionStatus.FAILED
        if marked or pending_audit:
            self._audit.emit(
                EVENT_PUBLISHED,
                {
                    "agent": request.agent_id,
                    "version": request.version,
                    "content_hash": request.content_hash,
                    "outcome": "rejected",
                    "created_by": version.created_by if version else None,
                    "approved_by": version.approved_by if version else None,
                    "execution": request.execution,
                    "failed_step": step,
                    "failure": code,
                },
                now,
            )
        self._store.release_lock(request.agent_id, request.execution)
        return {**result, "marked": marked or pending_audit}
