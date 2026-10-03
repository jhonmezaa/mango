"""The comparison itself: pure functions from (table, harnesses, roles) to findings.

What is live is decided by the ``PUBLISHED#<id>`` pointer, which only the provisioner can
write, never by ``META`` (mango-api can write that). Harness versions are immutable, so a
``live`` endpoint that serves the version in the pointer serves exactly what was deployed.

Findings carry identifiers, codes and version numbers only: no definition ever gets here.
"""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any

from mango_core.agents import AgentStatus, VersionStatus
from mango_reconciler.config import (
    CLOCK_SKEW,
    DEPROVISION_GRACE,
    LOCK_TTL,
    MAX_DRAFTS,
    MAX_SUBMISSIONS_PER_DAY,
    PACK_NETWORK_MODE,
    ROLE_POLICY_NAME,
    STUCK_AFTER,
    Settings,
)
from mango_reconciler.inventory import (
    ENV_AGENT_ID,
    ENV_AGENT_VERSION,
    ENV_CONTENT_HASH,
    Harness,
    HarnessVersion,
    PackRuntime,
    Role,
)
from mango_reconciler.snapshot import Pointer, Snapshot

READY = "READY"
_MAX_DETAIL_CHARS = 200
# A harness version newer than the published one is expected only while one of these exists.
_UNPUBLISHED = frozenset(
    {
        VersionStatus.DRAFT,
        VersionStatus.IN_REVIEW,
        VersionStatus.APPROVED,
        VersionStatus.FAILED,
    }
)


class Severity(StrEnum):
    DRIFT = "drift"
    """Something differs from what Mango deployed, or has no definition (TM-M6), or a pack
    runtime is outside the pack network (TM-E7). Alarms."""
    QUOTA = "quota"
    """A creator is over a limit mango-api enforces (TM-M9). Alarms."""
    CLEANUP = "cleanup"
    """Resources of a retired agent that are expected for now: the deprovisioner is about to
    remove them, or the agent ships with the release and keeps them (D48). Counted, does not
    alarm."""


@dataclass(frozen=True)
class Finding:
    code: str
    severity: Severity
    agent: str | None = None
    resource: str | None = None
    detail: Mapping[str, str] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        """For logs and the invocation result. Names come from AWS and the table: bounded."""
        return {
            "code": self.code,
            "severity": self.severity.value,
            "agent": self.agent,
            "resource": self.resource[:_MAX_DETAIL_CHARS] if self.resource else None,
            "detail": {k: v[:_MAX_DETAIL_CHARS] for k, v in self.detail.items()},
        }


@dataclass(frozen=True)
class Report:
    findings: tuple[Finding, ...]
    stats: Mapping[str, int]

    def count(self, severity: Severity) -> int:
        return sum(1 for f in self.findings if f.severity is severity)

    @property
    def alarming(self) -> int:
        return len(self.findings) - self.count(Severity.CLEANUP)


def _canonical(document: Any) -> str:
    return json.dumps(document, sort_keys=True, separators=(",", ":"))


class _Evaluation:
    def __init__(self, settings: Settings, snapshot: Snapshot, now: datetime) -> None:
        self.settings = settings
        self.snapshot = snapshot
        self.now = now
        self.findings: list[Finding] = []

    def add(self, code: str, severity: Severity, **kwargs: Any) -> None:
        self.findings.append(Finding(code, severity, **kwargs))

    def drift(self, code: str, agent: str | None, resource: str | None, **detail: str) -> None:
        self.add(code, Severity.DRIFT, agent=agent, resource=resource, detail=detail)

    # --- State of an agent in the table -------------------------------------------------

    def in_progress(self, agent_id: str) -> bool:
        """A provisioner execution may be changing this agent's resources right now.

        Both signals live in items mango-api can write, so they only count inside the window
        a real execution can produce: nothing in the table exempts an agent for longer.
        """
        meta = self.snapshot.agents.get(agent_id)
        if meta and meta.lock_until is not None and self._lock_state(meta.lock_until) == "held":
            return True
        return any(
            v.status is VersionStatus.APPROVED and not self._stuck(v.status_at)
            for v in self.snapshot.versions.get(agent_id, {}).values()
        )

    def _lock_state(self, until: int) -> str:
        now = self.now.timestamp()
        if until <= now:
            return "expired"
        return "held" if until <= now + (LOCK_TTL + CLOCK_SKEW).total_seconds() else "invalid"

    def _stuck(self, since: datetime | None) -> bool:
        return since is None or not -CLOCK_SKEW <= self.now - since <= STUCK_AFTER

    def owner(self, agent_id: str | None, resource: str, kind: str) -> Pointer | None:
        """Pointer of the published agent a resource belongs to; else records why not."""
        if agent_id is None:
            self.drift(f"{kind}_orphan", None, resource, reason="unexpected_name")
            return None
        meta = self.snapshot.agents.get(agent_id)
        if meta is None:
            self.drift(f"{kind}_orphan", agent_id, resource, reason="no_agent")
            return None
        if self.in_progress(agent_id):
            return None
        pointer = self.snapshot.pointers.get(agent_id)
        if pointer is None:
            # Compensation deletes what a failed first publication created.
            self.drift(f"{kind}_orphan", agent_id, resource, reason="never_published")
            return None
        if meta.status is AgentStatus.RETIRED:
            self._retired_resource(agent_id, resource, pointer)
            return None
        return pointer

    def _retired_resource(self, agent_id: str, resource: str, pointer: Pointer) -> None:
        """A harness or role of a retired agent, with no execution holding the agent.

        The deprovisioner removes them right after the retirement (D48). Past the grace
        period, what is still there means that removal failed or never started: it alarms
        until an execution finishes it. The agents of the release keep their resources.
        """
        version = self.snapshot.versions.get(agent_id, {}).get(pointer.version)
        retired_at = version.status_at if version else None
        recent = retired_at is not None and -CLOCK_SKEW <= self.now - retired_at <= (
            DEPROVISION_GRACE
        )
        if agent_id in self.settings.release_agents or recent:
            self.add("retired_agent_resources", Severity.CLEANUP, agent=agent_id, resource=resource)
            return
        self.drift(
            "deprovision_incomplete",
            agent_id,
            resource,
            retired_at=retired_at.isoformat() if retired_at else "unknown",
        )

    def active(self) -> list[str]:
        """Published agents that are not retired nor being provisioned."""
        return [
            agent_id
            for agent_id in self.snapshot.pointers
            if (meta := self.snapshot.agents.get(agent_id)) is not None
            and meta.status is not AgentStatus.RETIRED
            and not self.in_progress(agent_id)
        ]

    # --- Harnesses (TM-M6) --------------------------------------------------------------

    def harnesses(
        self, harnesses: Sequence[Harness], deployed: Mapping[str, HarnessVersion | None]
    ) -> None:
        for harness in harnesses:
            pointer = self.owner(harness.agent_id, harness.harness_id, "harness")
            if pointer is not None and harness.agent_id is not None:
                self._harness(harness.agent_id, harness, pointer, deployed.get(harness.harness_id))
        existing = {h.agent_id for h in harnesses}
        for agent_id in self.active():
            if agent_id not in existing:
                self.drift(
                    "harness_missing", agent_id, self.snapshot.pointers[agent_id].harness_arn
                )

    def _harness(
        self, agent_id: str, harness: Harness, pointer: Pointer, deployed: HarnessVersion | None
    ) -> None:
        resource = harness.harness_id
        if harness.arn != pointer.harness_arn:
            # Deleted and created again: none of its versions is the one Mango deployed.
            self.drift("harness_replaced", agent_id, resource, expected=pointer.harness_arn)
            return
        live = harness.live
        expected = pointer.harness_version
        if live is None:
            self.drift("live_endpoint_drift", agent_id, resource, reason="missing")
        elif live.status != READY:
            self.drift(
                "live_endpoint_drift", agent_id, resource, reason="status", actual=live.status
            )
        elif live.live_version != expected:
            self.drift(
                "live_endpoint_drift",
                agent_id,
                resource,
                reason="version",
                expected=expected,
                actual=str(live.live_version),
            )
        if deployed is None:
            self.drift("harness_content_mismatch", agent_id, resource, reason="version_missing")
        else:
            wrong = [
                name
                for name, value in (
                    (ENV_AGENT_ID, agent_id),
                    (ENV_AGENT_VERSION, str(pointer.version)),
                    (ENV_CONTENT_HASH, pointer.content_hash),
                )
                if deployed.markers.get(name) != value
            ]
            if deployed.execution_role_arn != self.settings.role_arn(agent_id):
                wrong.append("executionRoleArn")
            if wrong:
                self.drift(
                    "harness_content_mismatch", agent_id, resource, fields=",".join(sorted(wrong))
                )
        latest = harness.latest
        if latest.version != expected and not self._leftover(agent_id, latest, pointer):
            self.drift(
                "harness_version_unexpected",
                agent_id,
                resource,
                expected=expected,
                actual=latest.version,
            )

    def _leftover(self, agent_id: str, latest: HarnessVersion, pointer: Pointer) -> bool:
        """Harness versions of failed attempts cannot be deleted; they are not drift.

        ``UpdateHarness`` keeps the variables it is not given, so a version someone added on
        top of the published one still carries the published markers and is reported.
        """
        number = latest.markers.get(ENV_AGENT_VERSION, "")
        if latest.markers.get(ENV_AGENT_ID) != agent_id or not number.isdecimal():
            return False
        version = self.snapshot.versions.get(agent_id, {}).get(int(number))
        return (
            int(number) > pointer.version and version is not None and version.status in _UNPUBLISHED
        )

    # --- Roles (TM-M1, TM-M6) -----------------------------------------------------------

    def roles(self, roles: Sequence[Role]) -> None:
        for role in roles:
            if role.boundary_arn != self.settings.boundary_arn:
                self.drift(
                    "role_without_boundary",
                    role.agent_id,
                    role.name,
                    boundary="other" if role.boundary_arn else "none",
                )
            expected_trust = (
                _canonical(self.settings.trust_policy(role.agent_id)) if role.agent_id else None
            )
            if role.path != "/" or (expected_trust and _canonical(role.trust) != expected_trust):
                self.drift("role_trust_changed", role.agent_id, role.name)
            busy = role.agent_id is not None and self.in_progress(role.agent_id)
            if not busy and (role.inline_policies != (ROLE_POLICY_NAME,) or role.attached_policies):
                self.drift(
                    "role_policies_changed",
                    role.agent_id,
                    role.name,
                    inline=",".join(role.inline_policies),
                    attached=str(len(role.attached_policies)),
                )
            self.owner(role.agent_id, role.name, "role")
        existing = {r.agent_id for r in roles}
        for agent_id in self.active():
            if agent_id not in existing:
                self.drift("role_missing", agent_id, self.settings.role_name(agent_id))

    # --- Pack runtimes (R6, TM-E7) ------------------------------------------------------

    def pack_runtimes(self, runtimes: Sequence[PackRuntime]) -> None:
        """A pack runtime that can be invoked outside the pack VPC, so with a way out to the
        internet: one installed before R6 and not updated since, or changed outside Mango.

        The pack provisioner only asks for ``VPC`` and never exposes anything else, so this
        does not wait for an execution: there is no moment in which ``PUBLIC`` is expected.
        """
        for runtime in runtimes:
            for version in runtime.versions:
                if version.network_mode != PACK_NETWORK_MODE:
                    self.drift(
                        "pack_runtime_not_in_vpc",
                        None,
                        runtime.runtime_id,
                        version=version.version,
                        network=version.network_mode or "unknown",
                        endpoints=",".join(version.endpoints),
                    )

    # --- Table (TM-M2, TM-M9) -----------------------------------------------------------

    def records(self) -> None:
        snapshot = self.snapshot
        for key in snapshot.invalid:
            self.drift("record_invalid", None, key)
        for agent_id, pointer in snapshot.pointers.items():
            meta = snapshot.agents.get(agent_id)
            if meta is None:
                self.drift("publication_record_mismatch", agent_id, None, reason="no_agent")
                continue
            if self.in_progress(agent_id):
                continue
            retired = meta.status is AgentStatus.RETIRED
            if (meta.published_version, meta.harness_arn, meta.harness_version) != (
                pointer.version,
                pointer.harness_arn,
                pointer.harness_version,
            ):
                self.drift("publication_record_mismatch", agent_id, None, reason="meta")
            version = snapshot.versions.get(agent_id, {}).get(pointer.version)
            served = VersionStatus.RETIRED if retired else VersionStatus.PUBLISHED
            if (
                version is None
                or version.content_hash != pointer.content_hash
                or version.status is not served
            ):
                self.drift("publication_record_mismatch", agent_id, None, reason="version")
        for agent_id, meta in snapshot.agents.items():
            if meta.lock_until is not None and self._lock_state(meta.lock_until) == "invalid":
                # Longer than any execution holds an agent: it would hide the agent from here.
                self.drift("provision_lock_invalid", agent_id, None)
            if agent_id in snapshot.pointers or self.in_progress(agent_id):
                continue
            if meta.published_version is not None or meta.status is AgentStatus.PUBLISHED:
                self.drift("publication_record_mismatch", agent_id, None, reason="no_pointer")

    # --- Agents of the release (D34, D42, TM-M16) ----------------------------------------

    def release_agents(self) -> None:
        """A release agent that serves content other than the release's.

        The seed is written by a deployment custom resource, whose role could also write
        other content under a release agent's id (accepted risk, D42). A change approved in
        the installation (D18) shows up here too, on purpose: the table cannot tell that
        apart from a row written around mango-api, so a person confirms it.

        Who approved a version is not read (the reconciler sees no user ids of approvers):
        the provisioner already refuses a release approval of anything the release does not
        ship.
        """
        for agent_id, release_hash in self.settings.release_agents.items():
            pointer = self.snapshot.pointers.get(agent_id)
            if pointer is not None and pointer.content_hash != release_hash:
                self.drift(
                    "release_agent_content_changed", agent_id, None, version=str(pointer.version)
                )

    def stuck_versions(self) -> None:
        """``approved`` with no execution behind it: it timed out or never started."""
        for agent_id, versions in self.snapshot.versions.items():
            if self.in_progress(agent_id):
                continue
            for version in versions.values():
                if version.status is VersionStatus.APPROVED:
                    self.drift(
                        "version_stuck_approved",
                        agent_id,
                        None,
                        version=str(version.number),
                        since=version.status_at.isoformat() if version.status_at else "unknown",
                    )

    def quotas(self) -> None:
        for entry in self.snapshot.submissions:
            if entry.count > MAX_SUBMISSIONS_PER_DAY:
                self.add(
                    "creator_over_submissions",
                    Severity.QUOTA,
                    resource=entry.creator,
                    detail={"day": entry.day, "count": str(entry.count)},
                )
        drafts = Counter(
            version.created_by
            for versions in self.snapshot.versions.values()
            for version in versions.values()
            if version.status is VersionStatus.DRAFT and version.created_by
        )
        for creator, count in sorted(drafts.items()):
            if count > MAX_DRAFTS:
                self.add(
                    "creator_over_drafts",
                    Severity.QUOTA,
                    resource=creator,
                    detail={"count": str(count)},
                )

    def stats(
        self,
        harnesses: Sequence[Harness],
        roles: Sequence[Role],
        pack_runtimes: Sequence[PackRuntime],
    ) -> dict[str, int]:
        agents = self.snapshot.agents
        versions = Counter(v.status for vs in self.snapshot.versions.values() for v in vs.values())
        return {
            "Agents": len(agents),
            "PublishedAgents": sum(m.status is AgentStatus.PUBLISHED for m in agents.values()),
            "RetiredAgents": sum(m.status is AgentStatus.RETIRED for m in agents.values()),
            "AgentsInProgress": sum(self.in_progress(agent_id) for agent_id in agents),
            "Harnesses": len(harnesses),
            "AgentRoles": len(roles),
            "PackRuntimes": len(pack_runtimes),
            "VersionsInReview": versions[VersionStatus.IN_REVIEW],
            "VersionsApproved": versions[VersionStatus.APPROVED],
            "VersionsFailed": versions[VersionStatus.FAILED],
        }


def evaluate(
    settings: Settings,
    snapshot: Snapshot,
    *,
    harnesses: Sequence[Harness],
    deployed: Mapping[str, HarnessVersion | None],
    roles: Sequence[Role],
    pack_runtimes: Sequence[PackRuntime],
    now: datetime,
) -> Report:
    """Compare. ``deployed`` maps a harness id to the harness version its pointer names."""
    evaluation = _Evaluation(settings, snapshot, now)
    evaluation.harnesses(harnesses, deployed)
    evaluation.roles(roles)
    evaluation.pack_runtimes(pack_runtimes)
    evaluation.records()
    evaluation.release_agents()
    evaluation.stuck_versions()
    evaluation.quotas()
    return Report(tuple(evaluation.findings), evaluation.stats(harnesses, roles, pack_runtimes))
