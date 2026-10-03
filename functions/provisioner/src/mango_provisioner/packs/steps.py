"""Steps of the pack provisioner state machine (spec §4.4, plan B2).

Enabling an approved pack::

    load -> ensure_role -> ensure_runtime -> check_runtime* -> verify_tools -> point_live
         -> check_live* -> govern_logs -> ensure_target -> check_target* -> ensure_policies
         -> check_policies* -> finish

and on any error: ``compensate -> mark_failed``. Disabling is ``load -> remove -> done``.

Rules every step follows (the same as the agent provisioner):

* **Input is identifiers only** (``pack_id``, ``pack_version``, ``enablement_id``). Each step
  reads the enablement again and verifies the signed statement again before acting; nothing
  that decides IAM, code or tools travels in the execution state (TM-M1).
* **Only what the release names is installed**: a statement signed by the provider whose
  digest is the one in the release catalog (no rollback), with a zip that matches it.
* **Nothing is exposed before it is verified.** The Gateway only reaches the ``live``
  endpoint, which moves to a runtime version after that version answered ``tools/list`` with
  the pinned ``tools_hash``; tools stay denied until the policies are written, last.
* **One execution per pack** (lock on the enablement item, TM-M9), **idempotent by name**.
* **Compensation converges to what is installed**, read from the ``MCP_INSTALLED#`` pointer
  that only the provisioner can write: a pack that was never installed keeps no policies,
  target, runtime or role (removed in that order: what exposes it goes first); an installed
  pack gets ``live``, its role and its policies back to the installed version.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from mango_packs.enablement import ENABLEMENT_ID_PATTERN, PackStatus, is_pack_id
from mango_packs.tools import PackToolsError, check_tools
from mango_provisioner.audit import EVENT_PACK_DISABLED, EVENT_PACK_ENABLED, AuditWriter
from mango_provisioner.errors import BusyError, RetryableError, StepError
from mango_provisioner.packs.config import PackSettings
from mango_provisioner.packs.gateway import PackGateway, policy_statements
from mango_provisioner.packs.identity import IdentityKey
from mango_provisioner.packs.release import PackRelease, VerifiedPack, resolve_config
from mango_provisioner.packs.role import (
    PackRoles,
    grants_from_json,
    grants_of,
    grants_to_json,
    role_grants,
)
from mango_provisioner.packs.runtime import PackRuntimes, RuntimeRef, runtime_config
from mango_provisioner.packs.store import Enablement, Installed, PackStore
from mango_provisioner.runtime_logs import delete_log_groups, govern_log_groups
from mango_provisioner.steps import COMPENSATION_FAILED, failure_of

if TYPE_CHECKING:
    from mypy_boto3_logs import CloudWatchLogsClient

ACTION_ENABLE = "enable"
ACTION_DISABLE = "disable"
ACTION_NOOP = "noop"
MAX_WAIT_ATTEMPTS = 60
"""Polls of a runtime, endpoint, target or policy before giving up."""

_INPUT_KEYS = frozenset({"pack_id", "pack_version", "enablement_id"})
_VERSION_RE = re.compile(r"^[0-9]+(\.[0-9]+){1,3}-[1-9][0-9]{0,3}$")
_ENABLEMENT_ID_RE = re.compile(ENABLEMENT_ID_PATTERN)
_EXECUTION_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_RUNTIME_VERSION_RE = re.compile(r"^[1-9][0-9]{0,4}$")
_S3_VERSION_RE = re.compile(r"^[A-Za-z0-9._-]{1,1024}$")
_TARGET_ID_RE = re.compile(r"^[0-9a-zA-Z]{10}$")


@dataclass(frozen=True)
class Request:
    pack_id: str
    pack_version: str
    enablement_id: str
    execution: str

    def state(self) -> dict[str, Any]:
        return {
            "pack_id": self.pack_id,
            "pack_version": self.pack_version,
            "enablement_id": self.enablement_id,
            "execution": self.execution,
        }


@dataclass(frozen=True)
class Context:
    """An approved enablement and its verified pack, read under this execution's lock."""

    request: Request
    enablement: Enablement
    pack: VerifiedPack
    config: dict[str, str]
    installed: Installed | None


def parse_input(raw: object, execution: object) -> Request:
    """The execution input: exactly ``{pack_id, pack_version, enablement_id}``."""
    if not isinstance(raw, dict) or set(raw) != _INPUT_KEYS:
        raise StepError("invalid_input")
    return _request({**raw, "execution": execution})


def _request(state: object) -> Request:
    if not isinstance(state, dict):
        raise StepError("invalid_input")
    pack_id, version = state.get("pack_id"), state.get("pack_version")
    enablement_id, execution = state.get("enablement_id"), state.get("execution")
    if (
        not is_pack_id(pack_id)
        or not isinstance(version, str)
        or not _VERSION_RE.fullmatch(version)
        or not isinstance(enablement_id, str)
        or not _ENABLEMENT_ID_RE.fullmatch(enablement_id)
        or not isinstance(execution, str)
        or not _EXECUTION_RE.fullmatch(execution)
    ):
        raise StepError("invalid_input")
    return Request(str(pack_id), version, enablement_id, execution)


def _text(state: dict[str, Any], name: str, pattern: re.Pattern[str]) -> str:
    value = state.get(name)
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise StepError("invalid_state")
    return value


class PackProvisioner:
    def __init__(
        self,
        settings: PackSettings,
        *,
        store: PackStore,
        release: PackRelease,
        roles: PackRoles,
        runtimes: PackRuntimes,
        gateway: PackGateway,
        identity: IdentityKey,
        logs: CloudWatchLogsClient,
        audit: AuditWriter,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._settings = settings
        self._store = store
        self._release = release
        self._roles = roles
        self._runtimes = runtimes
        self._gateway = gateway
        self._identity = identity
        self._logs = logs
        self._audit = audit
        self._now = clock

    # --- Shared checks --------------------------------------------------------------------

    def _owned(self, request: Request) -> Enablement:
        """The enablement this execution was started for, while it holds the lock."""
        enablement = self._store.enablement(request.pack_id)
        if enablement is None:
            raise StepError("enablement_not_found")
        if enablement.lock_owner != request.execution:
            raise BusyError
        if (
            enablement.enablement_id != request.enablement_id
            or enablement.pack_version != request.pack_version
        ):
            raise StepError("enablement_changed")
        return enablement

    def _context(self, request: Request) -> Context:
        enablement = self._owned(request)
        if enablement.status is not PackStatus.INSTALLING:
            raise StepError("not_approved")
        pack = self._release.verified(request.pack_id, request.pack_version)
        return Context(
            request=request,
            enablement=enablement,
            pack=pack,
            config=resolve_config(pack.manifest, enablement.config),
            installed=self._store.installed(request.pack_id),
        )

    def _runtime_config(self, ctx: Context, artifact_version_id: str) -> dict[str, Any]:
        """Runtime configuration of the verified pack; a pack over account data also gets
        the broker and the key that verifies its callers (D37)."""
        return runtime_config(
            self._settings,
            ctx.pack,
            artifact_key=self._release.artifact_key(ctx.pack),
            artifact_version_id=artifact_version_id,
            config=ctx.config,
            identity_public_key=(
                self._identity.public_key() if ctx.pack.manifest.central_only else None
            ),
        )

    def _runtime_ref(self, pack_id: str, state: dict[str, Any]) -> RuntimeRef:
        runtime_id = state.get("runtime_id")
        if not isinstance(runtime_id, str) or not self._settings.runtime_id_pattern(
            pack_id
        ).fullmatch(runtime_id):
            raise StepError("invalid_state")
        return RuntimeRef(runtime_id, _text(state, "runtime_version", _RUNTIME_VERSION_RE))

    @staticmethod
    def _audit_detail(
        request: Request, enablement: Enablement, outcome: str, **extra: Any
    ) -> dict[str, Any]:
        return {
            "pack": request.pack_id,
            "pack_version": request.pack_version,
            "enablement_id": request.enablement_id,
            "outcome": outcome,
            "requested_by": enablement.requested_by,
            "approved_by": enablement.approved_by,
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
        enablement = self._store.enablement(request.pack_id)
        if enablement is None:
            raise StepError("enablement_not_found")
        if (
            enablement.enablement_id != request.enablement_id
            or enablement.pack_version != request.pack_version
        ):
            raise StepError("enablement_changed")
        installed = self._store.installed(request.pack_id)
        status = enablement.status
        finished = (
            status is PackStatus.ENABLED
            and installed is not None
            and installed.enablement_id == request.enablement_id
        ) or (status is PackStatus.DISABLED and installed is None)
        if finished:
            # Repeating a finished execution changes nothing.
            return {**request.state(), "action": ACTION_NOOP}
        if status is PackStatus.DISABLING:
            self._store.begin(**self._begin(request), disable=True)
            self._audit.emit(
                EVENT_PACK_DISABLED,
                self._audit_detail(request, enablement, "requested"),
                self._now(),
            )
            return {**request.state(), "action": ACTION_DISABLE}
        if status not in {PackStatus.APPROVED, PackStatus.INSTALLING}:
            raise StepError("not_approved")
        self._store.begin(**self._begin(request), disable=False)
        # From here on, a failure marks the enablement as failed.
        ctx = self._context(request)
        artifact_version_id = self._release.verified_artifact(ctx.pack)
        manifest = ctx.pack.manifest
        self._runtime_config(ctx, artifact_version_id)
        policy_statements(
            self._settings, request.pack_id, manifest.tool_names, central=manifest.central_only
        )
        self._audit.emit(
            EVENT_PACK_ENABLED,
            self._audit_detail(
                request, ctx.enablement, "requested", statement_sha256=ctx.pack.statement_sha256
            ),
            self._now(),
        )
        return {
            **request.state(),
            "action": ACTION_ENABLE,
            "artifact_version_id": artifact_version_id,
        }

    def _begin(self, request: Request) -> dict[str, Any]:
        return {
            "pack_id": request.pack_id,
            "enablement_id": request.enablement_id,
            "pack_version": request.pack_version,
            "owner": request.execution,
            "now": self._now(),
        }

    def ensure_role(self, state: dict[str, Any]) -> dict[str, Any]:
        ctx = self._context(_request(state))
        manifest, installed = ctx.pack.manifest, ctx.installed
        grants = role_grants(manifest.identity_mode.value, grants_of(manifest))
        broker = manifest.central_only
        if installed is not None:
            if installed.central_only and installed.member_chain != manifest.member_chain:
                # The role would need both brokers while the two versions overlap, and the
                # update would move the pack to other accounts under agents that already
                # have its tools: disable and enable instead, like a change of mode (D49 (6)).
                raise StepError("identity_chain_changed")
            # The installed version keeps serving until the last step: it keeps its access.
            grants += role_grants(installed.identity_mode, grants_from_json(installed.grants))
            broker = broker or installed.central_only
        self._roles.ensure(ctx.request.pack_id, grants, broker=broker, member=manifest.member_chain)
        return state

    def ensure_runtime(self, state: dict[str, Any]) -> dict[str, Any]:
        ctx = self._context(_request(state))
        request = ctx.request
        # Same object version as in `load`, checked again right before it becomes code.
        version_id = self._release.verified_artifact(
            ctx.pack, _text(state, "artifact_version_id", _S3_VERSION_RE)
        )
        config = self._runtime_config(ctx, version_id)
        ref = self._runtimes.ensure(
            request.pack_id,
            config,
            execution=request.execution,
            known_id=ctx.installed.runtime_id if ctx.installed else None,
            installed=ctx.installed is not None,
        )
        return {
            **state,
            "runtime_id": ref.runtime_id,
            "runtime_version": ref.version,
            "ready": False,
            "attempts": 0,
        }

    def check_runtime(self, state: dict[str, Any]) -> dict[str, Any]:
        request = _request(state)
        if self._runtimes.ready(request.pack_id, self._runtime_ref(request.pack_id, state)):
            return {**state, "ready": True, "attempts": 0}
        return self._waiting(state, "runtime_timeout")

    def verify_tools(self, state: dict[str, Any]) -> dict[str, Any]:
        """The new runtime version must serve exactly the tools the signed manifest pins."""
        ctx = self._context(_request(state))
        tools = self._runtimes.tools(self._runtime_ref(ctx.request.pack_id, state))
        try:
            check_tools(ctx.pack.manifest, tools)
        except (PackToolsError, ValueError):
            # ValueError: an answer that cannot be put in canonical form (NaN, Infinity).
            raise StepError("tools_mismatch") from None
        return state

    def point_live(self, state: dict[str, Any]) -> dict[str, Any]:
        ctx = self._context(_request(state))
        pack_id = ctx.request.pack_id
        installed = ctx.installed
        manifest = ctx.pack.manifest
        if (
            installed is not None
            and (
                frozenset(installed.tools) != manifest.tool_names
                or installed.identity_mode != manifest.identity_mode.value
            )
            and not self._gateway.delete_policies(pack_id)
        ):
            # The tools change, or who may call them: deny them all until the new version's
            # policies are written. `live` never serves account data under the policies of a
            # public version.
            raise RetryableError("policies_deleting")
        self._runtimes.point_live(
            pack_id, self._runtime_ref(pack_id, state), execution=ctx.request.execution
        )
        return {**state, "ready": False, "attempts": 0}

    def check_live(self, state: dict[str, Any]) -> dict[str, Any]:
        request = _request(state)
        if self._runtimes.live(self._runtime_ref(request.pack_id, state)) is not None:
            return {**state, "ready": True, "attempts": 0}
        return self._waiting(state, "endpoint_timeout")

    def govern_logs(self, state: dict[str, Any]) -> dict[str, Any]:
        ctx = self._context(_request(state))
        settings = self._settings
        ref = self._runtime_ref(ctx.request.pack_id, state)
        govern_log_groups(
            self._logs,
            settings.log_group_names(ref.runtime_id),
            settings.runtime_logs_key_arn,
            settings.tags(ctx.request.pack_id),
        )
        return state

    def _live_since(self, ref: RuntimeRef) -> datetime:
        since = self._runtimes.live(ref)
        if since is None:
            raise StepError("endpoint_not_ready")
        return since

    def ensure_target(self, state: dict[str, Any]) -> dict[str, Any]:
        ctx = self._context(_request(state))
        pack_id = ctx.request.pack_id
        ref = self._runtime_ref(pack_id, state)
        self._gateway.ensure_target(
            pack_id, ref.runtime_id, self._live_since(ref), execution=ctx.request.execution
        )
        return {**state, "ready": False, "attempts": 0}

    def check_target(self, state: dict[str, Any]) -> dict[str, Any]:
        request = _request(state)
        ref = self._runtime_ref(request.pack_id, state)
        target_id = self._gateway.target_ready(
            request.pack_id, ref.runtime_id, self._live_since(ref)
        )
        if target_id is not None:
            return {**state, "target_id": target_id, "ready": True, "attempts": 0}
        return self._waiting(state, "target_timeout")

    def ensure_policies(self, state: dict[str, Any]) -> dict[str, Any]:
        ctx = self._context(_request(state))
        manifest = ctx.pack.manifest
        self._gateway.ensure_policies(
            ctx.request.pack_id, manifest.tool_names, central=manifest.central_only
        )
        return {**state, "ready": False, "attempts": 0}

    def check_policies(self, state: dict[str, Any]) -> dict[str, Any]:
        ctx = self._context(_request(state))
        manifest = ctx.pack.manifest
        pack_id, tools, central = ctx.request.pack_id, manifest.tool_names, manifest.central_only
        if self._gateway.policies_ready(pack_id, tools, central=central):
            return {**state, "ready": True, "attempts": 0}
        # Converge again: a policy being replaced is created once the old one is gone.
        self._gateway.ensure_policies(pack_id, tools, central=central)
        return self._waiting(state, "policy_timeout")

    def finish(self, state: dict[str, Any]) -> dict[str, Any]:
        request = _request(state)
        pack_id = request.pack_id
        ref = self._runtime_ref(pack_id, state)
        target_id = _text(state, "target_id", _TARGET_ID_RE)
        enablement = self._owned(request)
        installed = self._store.installed(pack_id)
        pack = self._release.verified(pack_id, request.pack_version)
        manifest = pack.manifest
        already = (
            enablement.status is PackStatus.ENABLED
            and installed is not None
            and installed.enablement_id == request.enablement_id
            and (installed.runtime_id, installed.runtime_version) == (ref.runtime_id, ref.version)
        )
        if not already:
            # A retry of this step after the transaction went through skips this block.
            ctx = self._context(request)
            # Last checks before it counts as enabled: what is served is what was verified.
            if self._gateway.target_ready(
                pack_id, ref.runtime_id, self._live_since(ref)
            ) != target_id or not self._gateway.policies_ready(
                pack_id, manifest.tool_names, central=manifest.central_only
            ):
                raise StepError("not_converged")
            self._store.enabled(
                pack_id=pack_id,
                enablement_id=request.enablement_id,
                owner=request.execution,
                installed=Installed(
                    enablement_id=request.enablement_id,
                    pack_version=request.pack_version,
                    statement_sha256=pack.statement_sha256,
                    artifact_version_id=_text(state, "artifact_version_id", _S3_VERSION_RE),
                    runtime_id=ref.runtime_id,
                    runtime_version=ref.version,
                    target_id=target_id,
                    tools=tuple(sorted(manifest.tool_names)),
                    grants=grants_to_json(grants_of(manifest)),
                    config=ctx.config,
                    data_tier=manifest.data_tier.value,
                    identity_mode=manifest.identity_mode.value,
                    identity_chain=manifest.identity.chain.value,
                ),
                now=self._now(),
            )
        # The previous version no longer serves: the role keeps only this version's access.
        self._roles.ensure(
            pack_id,
            role_grants(manifest.identity_mode.value, grants_of(manifest)),
            broker=manifest.central_only,
            member=manifest.member_chain,
        )
        self._audit.emit(
            EVENT_PACK_ENABLED,
            self._audit_detail(
                request,
                enablement,
                "applied",
                statement_sha256=pack.statement_sha256,
                tools_hash=manifest.tools_hash,
                runtime=ref.runtime_id,
                runtime_version=ref.version,
            ),
            self._now(),
        )
        self._store.release_lock(pack_id, request.execution)
        return {**state, "enabled": True}

    # --- Forward step: disable ------------------------------------------------------------

    def remove(self, state: dict[str, Any]) -> dict[str, Any]:
        """Delete everything the pack has, then mark it disabled.

        Deletions are asynchronous: this raises ``RetryableError`` until each resource is
        gone, and the state machine calls it again.
        """
        request = _request(state)
        enablement = self._owned(request)
        if enablement.status is PackStatus.DISABLING:
            self._remove_all(request.pack_id, self._store.installed(request.pack_id))
            self._store.disabled(
                pack_id=request.pack_id,
                enablement_id=request.enablement_id,
                owner=request.execution,
                now=self._now(),
            )
        elif enablement.status is not PackStatus.DISABLED:
            raise StepError("not_disabling")
        self._audit.emit(
            EVENT_PACK_DISABLED, self._audit_detail(request, enablement, "applied"), self._now()
        )
        self._store.release_lock(request.pack_id, request.execution)
        return {**state, "disabled": True}

    def _remove_all(
        self, pack_id: str, installed: Installed | None, *, delete_logs: bool = False
    ) -> None:
        """Policies, target, runtime and role, in the order that closes access first."""
        if not self._gateway.delete_policies(pack_id):
            raise RetryableError("policies_deleting")
        if not self._gateway.delete_target(pack_id):
            raise RetryableError("target_deleting")
        runtime = self._runtimes.find(pack_id, installed.runtime_id if installed else None)
        if runtime is not None:
            runtime_id = str(runtime["agentRuntimeId"])
            if delete_logs:
                delete_log_groups(self._logs, self._settings.log_group_names(runtime_id))
            if runtime["status"] != "DELETING":
                self._runtimes.delete(runtime_id)
            # Only once the runtime is gone is the role it runs with removed.
            raise RetryableError("runtime_deleting")
        self._roles.delete(pack_id)

    # --- Failure path ---------------------------------------------------------------------

    def compensate(self, state: object) -> dict[str, Any]:
        """Put the pack's resources back to what is installed (see module docstring)."""
        out: dict[str, Any] = dict(state) if isinstance(state, dict) else {}
        try:
            request = _request(out)
        except StepError:
            return {**out, "compensated": False}
        enablement = self._store.enablement(request.pack_id)
        if (
            enablement is None
            or enablement.lock_owner != request.execution
            or enablement.status is not PackStatus.INSTALLING
        ):
            # Not ours to touch: another execution owns the pack, nothing was started, or a
            # removal failed half way (it is retried, never undone).
            return {**out, "compensated": False}
        pack_id = request.pack_id
        installed = self._store.installed(pack_id)
        if installed is None:
            # Never installed: logs of a runtime that served nothing go with it.
            self._remove_all(pack_id, None, delete_logs=True)
            return {**out, "compensated": True}
        if self._runtimes.find(pack_id, installed.runtime_id) is None:
            return {**out, "compensated": False}
        undo = f"{request.execution}-undo"[:80]
        ref = RuntimeRef(installed.runtime_id, installed.runtime_version)
        self._runtimes.point_live(pack_id, ref, execution=undo)
        live_since = self._runtimes.live(ref)
        if live_since is None:
            raise RetryableError("endpoint_updating")
        if self._roles.exists(pack_id):
            self._roles.ensure(
                pack_id,
                role_grants(installed.identity_mode, grants_from_json(installed.grants)),
                broker=installed.central_only,
                member=installed.member_chain,
            )
        self._gateway.ensure_target(pack_id, ref.runtime_id, live_since, execution=undo)
        if self._gateway.target_ready(pack_id, ref.runtime_id, live_since) is None:
            raise RetryableError("target_synchronizing")
        # Converge first: a policy the failed attempt left half written (or failed) is replaced.
        central = installed.central_only
        self._gateway.ensure_policies(pack_id, installed.tools, central=central)
        if not self._gateway.policies_ready(pack_id, installed.tools, central=central):
            raise RetryableError("policies_updating")
        return {**out, "compensated": True}

    def mark_failed(self, state: object) -> dict[str, Any]:
        """Record the failure on the enablement, audit it and release the lock."""
        out: dict[str, Any] = dict(state) if isinstance(state, dict) else {}
        step, code = failure_of(out.get("error"), out.get("last_step"))
        if out.get("compensation_error") is not None:
            code = f"{code};{COMPENSATION_FAILED}"[:80]
        result = {**out, "failed_step": step, "failure": code, "marked": False}
        try:
            request = _request(out)
        except StepError:
            return result
        enablement = self._store.enablement(request.pack_id)
        if enablement is None or enablement.lock_owner != request.execution:
            return result
        disable = enablement.status in {PackStatus.DISABLING, PackStatus.DISABLED}
        now = self._now()
        marked = self._store.fail(
            pack_id=request.pack_id,
            owner=request.execution,
            failed_step=step,
            failure=code,
            now=now,
            disable=disable,
        )
        # Still holding the lock with the failure already recorded: a retry of this step
        # whose audit event did not get through. The lock is only released once it is written.
        pending_audit = enablement.status is PackStatus.FAILED
        if marked or pending_audit:
            self._audit.emit(
                EVENT_PACK_DISABLED if disable else EVENT_PACK_ENABLED,
                self._audit_detail(request, enablement, "rejected", failed_step=step, failure=code),
                now,
            )
        self._store.release_lock(request.pack_id, request.execution)
        return {**result, "marked": marked or pending_audit}
