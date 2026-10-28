"""Steps of the remote MCP provisioner state machine (D93, D98, plan PR-4).

Enabling an approved request (``enable``, ``replace_app`` or ``params``)::

    load -> ensure_return_url -> ensure_target -> check_target* -> ensure_policies
         -> check_policies* -> sign_item -> mark_active

Disabling is ``load -> remove -> done``; on any error, ``compensate -> mark_failed``. A
``params`` request goes through the same steps: each one converges to the approved
configuration, so a change of groups only finds everything in place and signs again with a
higher ``revision`` (D98 (8)); the provider is never touched.

Rules every step follows (as in the pack provisioner):

* **Input is identifiers only** (``registration_id``, ``approval_id``). Each step reads the
  registration, its approved request and the signed profile again; nothing that decides the
  endpoint, the provider or the tools travels in the execution state.
* **Only what the release names becomes a target**: the profile statement the catalog pins,
  with the host, scopes, schema and header values it signs. A record only gives the
  organization (constant pattern) and a subset of the profile's toolsets.
* **The approved catalog is written last and deleted first** (D98 (13)): the interceptor lets
  nothing through until the target and its policies are in place, and stops before any of it
  is deleted.
* **One execution per registration** (lock on the registration), refused once mango-api
  records a newer approval (``approval_id``), and **idempotent by name**.
* **Compensation** removes what a registration with no signed catalog exposes (policies,
  target). One with a catalog keeps serving what that catalog says: the previous one, or the
  new one if only the last transition failed.
* **What is live is the signed catalog** (``MCP_REMOTE#``, which only this role writes): its
  generation is the provider the target serves with. The registration only gets its lifecycle.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from mango_core import remote_mcp
from mango_core.remote_mcp import ApprovedRemote
from mango_provisioner.audit import (
    EVENT_REMOTE_CREATE_FAILED,
    EVENT_REMOTE_DISABLED,
    EVENT_REMOTE_ENABLED,
    AuditWriter,
)
from mango_provisioner.errors import BusyError, RetryableError, StepError
from mango_provisioner.remotes.config import RemoteSettings
from mango_provisioner.remotes.gateway import RemoteGateway, policy_statements
from mango_provisioner.remotes.identity import RemoteIdentity
from mango_provisioner.remotes.release import RemoteRelease, TargetPlan, plan_target
from mango_provisioner.remotes.signing import CatalogSigner
from mango_provisioner.remotes.store import (
    APPROVAL_ID_PATTERN,
    ChangeKind,
    Registration,
    RemoteStore,
    Status,
)
from mango_provisioner.steps import COMPENSATION_FAILED, failure_of

ACTION_ENABLE = "enable"
ACTION_DISABLE = "disable"
ACTION_NOOP = "noop"
MAX_WAIT_ATTEMPTS = 60
MAX_GENERATION = 999_999
"""Polls of a target or of the policies before giving up."""
SPARE_GENERATIONS = 1
"""Providers above the live generation a disable also deletes: the one a failed change of
tenant or app may have left behind (mango-api deletes those of rejected requests)."""

_INPUT_KEYS = frozenset({"registration_id", "approval_id"})
_APPROVAL_RE = re.compile(APPROVAL_ID_PATTERN)
_EXECUTION_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


@dataclass(frozen=True)
class Request:
    registration_id: str
    approval_id: str
    execution: str

    def state(self) -> dict[str, Any]:
        return {
            "registration_id": self.registration_id,
            "approval_id": self.approval_id,
            "execution": self.execution,
        }


@dataclass(frozen=True)
class Context:
    """An approved request and its verified profile, read under this execution's lock."""

    request: Request
    registration: Registration
    kind: ChangeKind
    generation: int
    plan: TargetPlan
    profile_id: str
    profile_version: str
    profile_sha256: str
    live: tuple[int, int] | None
    """``(generation, revision)`` of the signed catalog, if any."""


def parse_input(raw: object, execution: object) -> Request:
    """The execution input: exactly ``{registration_id, approval_id}``."""
    if not isinstance(raw, dict) or set(raw) != _INPUT_KEYS:
        raise StepError("invalid_input")
    return _request({**raw, "execution": execution})


def _request(state: object) -> Request:
    if not isinstance(state, dict):
        raise StepError("invalid_input")
    registration_id, approval_id = state.get("registration_id"), state.get("approval_id")
    execution = state.get("execution")
    if (
        not remote_mcp.is_registration_id(registration_id)
        or not isinstance(approval_id, str)
        or not _APPROVAL_RE.fullmatch(approval_id)
        or not isinstance(execution, str)
        or not _EXECUTION_RE.fullmatch(execution)
    ):
        raise StepError("invalid_input")
    return Request(str(registration_id), approval_id, execution)


class RemoteProvisioner:
    def __init__(
        self,
        settings: RemoteSettings,
        *,
        store: RemoteStore,
        release: RemoteRelease,
        gateway: RemoteGateway,
        identity: RemoteIdentity,
        signer: CatalogSigner,
        audit: AuditWriter,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._settings = settings
        self._store = store
        self._release = release
        self._gateway = gateway
        self._identity = identity
        self._signer = signer
        self._audit = audit
        self._now = clock

    # --- Shared checks --------------------------------------------------------------------

    def _current(self, request: Request) -> Registration:
        registration = self._store.registration(request.registration_id)
        if registration is None:
            raise StepError("registration_not_found")
        if registration.approval_id != request.approval_id:
            # mango-api recorded a newer approval or a disable: this execution is stale.
            raise StepError("approval_changed")
        return registration

    def _owned(self, request: Request) -> Registration:
        registration = self._current(request)
        if registration.lock_owner != request.execution:
            raise BusyError
        return registration

    def _context(self, request: Request) -> Context:
        registration = self._owned(request)
        if registration.status is not Status.CREATING:
            raise StepError("not_approved")
        if registration.change_id is None or registration.change_kind is None:
            raise StepError("change_not_found")
        change = self._store.change(request.registration_id, registration.change_id)
        if change.kind is not registration.change_kind:
            raise StepError("change_changed")
        verified = self._release.verified(registration.profile_id)
        if change.profile_sha256 != verified.statement_sha256:
            # Approved on another profile version than this release ships.
            raise StepError("release_changed")
        live = self._store.live(request.registration_id)
        if change.kind is ChangeKind.PARAMS:
            # Same provider: the people keep their connection (D98 (8)).
            if change.pending_generation is not None:
                raise StepError("change_record_invalid")
            if live is None:
                raise StepError("not_active")
            generation = live[0]
        else:
            if change.pending_generation is None:
                raise StepError("change_record_invalid")
            generation = change.pending_generation
            if live is not None and generation < live[0]:
                raise StepError("generation_not_newer")
        toolsets = change.toolsets or registration.toolsets
        plan = plan_target(verified, registration.organization, list(toolsets))
        return Context(
            request=request,
            registration=registration,
            kind=change.kind,
            generation=generation,
            plan=plan,
            profile_id=verified.profile.id,
            profile_version=verified.profile.version,
            profile_sha256=verified.statement_sha256,
            live=live,
        )

    @staticmethod
    def _detail(
        request: Request, registration: Registration, outcome: str, **extra: Any
    ) -> dict[str, Any]:
        return {
            "remote": remote_mcp.target_name(request.registration_id),
            "registration_id": request.registration_id,
            "profile": registration.profile_id,
            "kind": registration.change_kind.value if registration.change_kind else None,
            "outcome": outcome,
            "requested_by": registration.requested_by,
            "approved_by": registration.approved_by,
            "execution": request.execution,
            **extra,
        }

    @staticmethod
    def _waiting(state: dict[str, Any], timeout_code: str) -> dict[str, Any]:
        attempts = int(state.get("attempts", 0)) + 1
        if attempts > MAX_WAIT_ATTEMPTS:
            raise StepError(timeout_code)
        return {**state, "ready": False, "attempts": attempts}

    # --- Forward steps: enable ------------------------------------------------------------

    def load(self, raw_input: object, execution: object) -> dict[str, Any]:
        request = parse_input(raw_input, execution)
        registration = self._current(request)
        status = registration.status
        if status in {Status.ACTIVE, Status.DISABLED} and registration.lock_owner is None:
            # Repeating a finished execution changes nothing.
            return {**request.state(), "action": ACTION_NOOP}
        now = self._now()
        if status is Status.DISABLING:
            self._store.begin(
                request.registration_id, request.approval_id, request.execution, now, disable=True
            )
            # The catalog is deleted first, so the live generation travels in the state: the
            # providers to delete once the target is gone.
            live = self._store.live(request.registration_id)
            last = max(live[0] if live else 1, registration.generation or 1)
            return {
                **request.state(),
                "action": ACTION_DISABLE,
                "providers_up_to": last + SPARE_GENERATIONS,
            }
        if status not in {Status.APPROVED, Status.CREATING}:
            raise StepError("not_approved")
        self._store.begin(
            request.registration_id, request.approval_id, request.execution, now, disable=False
        )
        # From here on, a failure marks the registration as failed.
        ctx = self._context(request)
        if ctx.kind is not ChangeKind.PARAMS and ctx.live and ctx.generation <= ctx.live[0]:
            # A new tenant or app is a new provider generation, above what is live.
            raise StepError("generation_not_newer")
        policy_statements(self._settings, request.registration_id, ctx.plan.tools)
        return {**request.state(), "action": ACTION_ENABLE}

    def ensure_return_url(self, state: dict[str, Any]) -> dict[str, Any]:
        self._context(_request(state))
        self._identity.ensure_return_url()
        return state

    def ensure_target(self, state: dict[str, Any]) -> dict[str, Any]:
        ctx = self._context(_request(state))
        self._gateway.ensure_target(
            ctx.request.registration_id, ctx.generation, ctx.plan, execution=ctx.request.execution
        )
        return {**state, "ready": False, "attempts": 0}

    def check_target(self, state: dict[str, Any]) -> dict[str, Any]:
        ctx = self._context(_request(state))
        if self._gateway.target_ready(ctx.request.registration_id, ctx.generation, ctx.plan):
            return {**state, "ready": True, "attempts": 0}
        return self._waiting(state, "target_timeout")

    def ensure_policies(self, state: dict[str, Any]) -> dict[str, Any]:
        ctx = self._context(_request(state))
        self._gateway.ensure_policies(ctx.request.registration_id, ctx.plan.tools)
        return {**state, "ready": False, "attempts": 0}

    def check_policies(self, state: dict[str, Any]) -> dict[str, Any]:
        ctx = self._context(_request(state))
        registration_id, tools = ctx.request.registration_id, ctx.plan.tools
        if self._gateway.policies_ready(registration_id, tools):
            return {**state, "ready": True, "attempts": 0}
        # Converge again: a policy being replaced is created once the old one is gone.
        self._gateway.ensure_policies(registration_id, tools)
        return self._waiting(state, "policy_timeout")

    def _converged(self, ctx: Context) -> None:
        registration_id = ctx.request.registration_id
        if not self._gateway.target_ready(
            registration_id, ctx.generation, ctx.plan
        ) or not self._gateway.policies_ready(registration_id, ctx.plan.tools):
            raise StepError("not_converged")

    def sign_item(self, state: dict[str, Any]) -> dict[str, Any]:
        """Write the approved catalog: the last thing the interceptor needs to let calls in."""
        ctx = self._context(_request(state))
        self._converged(ctx)
        registration_id = ctx.request.registration_id
        previous = self._store.live(registration_id)
        revision = previous[1] + 1 if previous and previous[0] == ctx.generation else 1
        now = self._now()
        approved = ApprovedRemote(
            registration_id=registration_id,
            generation=ctx.generation,
            revision=min(revision, 999_999),
            profile_id=ctx.profile_id,
            profile_version=ctx.profile_version,
            profile_sha256=ctx.profile_sha256,
            gateway_id=self._settings.gateway_id,
            organization=ctx.registration.organization,
            toolsets=ctx.plan.toolsets,
            toolsets_header=ctx.plan.headers[remote_mcp.TOOLSETS_HEADER],
            tools=ctx.plan.tools,
            probe_tool=ctx.plan.probe_tool,
            issued_at=int(now.timestamp()),
        )
        self._store.put_approved(registration_id, self._signer.item(approved, now))
        return {**state, "revision": approved.revision}

    def mark_active(self, state: dict[str, Any]) -> dict[str, Any]:
        request = _request(state)
        registration = self._owned(request)
        extra: dict[str, Any] = {"revision": state.get("revision")}
        if registration.status is Status.ACTIVE:
            # A retry of this step after the transition went through: only the audit is left.
            live = self._store.live(request.registration_id)
            extra["generation"] = live[0] if live else None
        else:
            ctx = self._context(request)
            self._converged(ctx)
            # The generation is live: the previous providers and their secrets go, those of a
            # replaced tenant or app and those that failed attempts left behind.
            self._identity.delete_providers(request.registration_id, range(1, ctx.generation))
            self._store.active(
                request.registration_id, request.approval_id, request.execution, self._now()
            )
            extra |= {
                "generation": ctx.generation,
                "profile_version": ctx.profile_version,
                "profile_sha256": ctx.profile_sha256,
                "toolsets": list(ctx.plan.toolsets),
            }
        self._audit.emit(
            EVENT_REMOTE_ENABLED,
            self._detail(request, registration, "applied", **extra),
            self._now(),
        )
        self._store.release_lock(request.registration_id, request.execution)
        return {**state, "enabled": True}

    # --- Forward step: disable ------------------------------------------------------------

    def remove(self, state: dict[str, Any]) -> dict[str, Any]:
        """Catalog, policies, target and providers, in the order that closes access first.

        Deletions are asynchronous: this raises ``RetryableError`` until each resource is
        gone, and the state machine calls it again.
        """
        request = _request(state)
        registration = self._owned(request)
        registration_id = request.registration_id
        if registration.status is Status.DISABLING:
            self._store.delete_approved(registration_id)
            if not self._gateway.delete_policies(registration_id):
                raise RetryableError("policies_deleting")
            if not self._gateway.delete_target(registration_id):
                raise RetryableError("target_deleting")
            last = state.get("providers_up_to")
            if (
                not isinstance(last, int)
                or isinstance(last, bool)
                or not 1 <= last <= MAX_GENERATION
            ):
                raise StepError("invalid_state")
            self._identity.delete_providers(registration_id, range(1, last + 1))
            self._store.disabled(
                registration_id, request.approval_id, request.execution, self._now()
            )
        elif registration.status is not Status.DISABLED:
            raise StepError("not_disabling")
        self._audit.emit(
            EVENT_REMOTE_DISABLED, self._detail(request, registration, "applied"), self._now()
        )
        self._store.release_lock(registration_id, request.execution)
        return {**state, "disabled": True}

    # --- Failure path ---------------------------------------------------------------------

    def compensate(self, state: object) -> dict[str, Any]:
        """Remove what a registration that never was active exposes (see module docstring)."""
        out: dict[str, Any] = dict(state) if isinstance(state, dict) else {}
        try:
            request = _request(out)
            registration = self._owned(request)
        except StepError:
            return {**out, "compensated": False}
        if (
            registration.status is not Status.CREATING
            or self._store.live(request.registration_id) is not None
        ):
            # A removal failed half way (retried, never undone), or a catalog is signed: the
            # registration serves what that catalog says until it is disabled.
            return {**out, "compensated": False}
        registration_id = request.registration_id
        self._store.delete_approved(registration_id)
        if not self._gateway.delete_policies(registration_id):
            raise RetryableError("policies_deleting")
        if not self._gateway.delete_target(registration_id):
            raise RetryableError("target_deleting")
        return {**out, "compensated": True}

    def mark_failed(self, state: object) -> dict[str, Any]:
        """Record the failure on the registration, audit it and release the lock."""
        out: dict[str, Any] = dict(state) if isinstance(state, dict) else {}
        step, code = failure_of(out.get("error"), out.get("last_step"))
        if out.get("compensation_error") is not None:
            code = f"{code};{COMPENSATION_FAILED}"[:80]
        result = {**out, "failed_step": step, "failure": code, "marked": False}
        try:
            request = _request(out)
            registration = self._store.registration(request.registration_id)
        except StepError:
            # A record mango-api wrote that cannot be read: nothing is ours to mark.
            return result
        if (
            registration is None
            or registration.approval_id != request.approval_id
            or registration.lock_owner != request.execution
        ):
            return result
        # A failed disable leaves `failed` too; the audit event says which it was.
        disable = registration.status is Status.DISABLING or out.get("action") == ACTION_DISABLE
        now = self._now()
        if registration.status is not Status.FAILED and not self._store.failed(
            request.registration_id,
            request.approval_id,
            request.execution,
            now,
            failed_step=step,
            failure=code,
        ):
            return result
        self._audit.emit(
            EVENT_REMOTE_DISABLED if disable else EVENT_REMOTE_CREATE_FAILED,
            self._detail(request, registration, "rejected", failed_step=step, failure_code=code),
            now,
        )
        self._store.release_lock(request.registration_id, request.execution)
        return {**result, "marked": True}
