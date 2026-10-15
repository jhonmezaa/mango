"""What a new release does with one of its agents in an existing installation (D34, D80).

The stack starts the provisioner with ``{agent_id, content_hash, release}`` whenever the release
ships other content for one of its agents. Before anything else the provisioner checks that
the stack ships exactly that id and hash (``RELEASE_AGENTS``, TM-M16). Then, holding the
agent's lock, it decides:

* **unchanged:** the agent already serves that content. Nothing happens.
* **update:** every version of the agent was written by the release and none is open. The
  release adds the next version, already approved by ``release@<version>`` like the first
  one, and it is published by its hash like any approved version.
* **publish:** the open version is the release's, approved, with that content: the first
  version of a new installation, or a repeat of an execution that already added it.
* **skip:** the installation changed the agent (a version, draft or edit by a person, D18),
  retired it, or has a version of the release still open with other content. The release does
  not touch it; the execution ends without failing and leaves an audit event saying why.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum

from mango_core.agents import AgentStatus, VersionStatus, is_agent_id
from mango_provisioner.config import RELEASE_APPROVER_PREFIX
from mango_provisioner.errors import StepError
from mango_provisioner.store import Authors, Meta, Published, Version

_KEYS = frozenset({"agent_id", "content_hash", "release"})
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_EXECUTION_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_RELEASE_RE = re.compile(r"^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$")

SKIP_CHANGED = "changed_in_installation"
SKIP_RETIRED = "agent_retired"
SKIP_OPEN = "version_open"


class Outcome(StrEnum):
    UNCHANGED = "unchanged"
    UPDATE = "update"
    PUBLISH = "publish"
    SKIP = "skip"


@dataclass(frozen=True)
class ReleaseRequest:
    agent_id: str
    content_hash: str
    release: str
    execution: str

    @property
    def approver(self) -> str:
        return RELEASE_APPROVER_PREFIX + self.release


@dataclass(frozen=True)
class Decision:
    outcome: Outcome
    version: int | None = None
    """The version to publish (``publish``) or to add (``update``)."""
    reason: str | None = None
    """Why the release left the agent alone (``skip``)."""


def is_release_input(raw: object) -> bool:
    return isinstance(raw, dict) and "release" in raw


def parse_release_input(raw: object, execution: object) -> ReleaseRequest:
    """Exactly ``{agent_id, content_hash, release}``, nothing else."""
    if not isinstance(raw, dict) or set(raw) != _KEYS:
        raise StepError("invalid_input")
    agent_id, digest, release = raw.get("agent_id"), raw.get("content_hash"), raw.get("release")
    if (
        not is_agent_id(agent_id)
        or not isinstance(digest, str)
        or not _HASH_RE.fullmatch(digest)
        or not isinstance(release, str)
        or not _RELEASE_RE.fullmatch(release)
        or not isinstance(execution, str)
        or not _EXECUTION_RE.fullmatch(execution)
    ):
        raise StepError("invalid_input")
    return ReleaseRequest(str(agent_id), digest, release, execution)


def written_by_release(authors: Authors) -> bool:
    """Created, edited and approved by a release only. People are mango-api user ids, which
    never look like a release approver."""
    people = {authors.created_by, *authors.editors}
    if authors.approved_by is not None:
        people.add(authors.approved_by)
    return all(who.startswith(RELEASE_APPROVER_PREFIX) for who in people)


def unchanged(meta: Meta, published: Published | None, content_hash: str) -> bool:
    return (
        published is not None
        and published.content_hash == content_hash
        and meta.published_version == published.version
    )


def decide(
    meta: Meta,
    published: Published | None,
    authors: list[Authors],
    open_version: Version | None,
    content_hash: str,
) -> Decision:
    """Pure decision on what the release does with its agent (module docstring)."""
    if meta.status is AgentStatus.RETIRED:
        return Decision(Outcome.SKIP, reason=SKIP_RETIRED)
    if unchanged(meta, published, content_hash):
        return Decision(Outcome.UNCHANGED, version=meta.published_version)
    if not all(written_by_release(a) for a in authors):
        return Decision(Outcome.SKIP, reason=SKIP_CHANGED)
    if meta.open_version is not None:
        if (
            open_version is not None
            and open_version.number == meta.open_version
            and open_version.status is VersionStatus.APPROVED
            and open_version.content_hash == content_hash
        ):
            return Decision(Outcome.PUBLISH, version=meta.open_version)
        return Decision(Outcome.SKIP, reason=SKIP_OPEN)
    if meta.latest_version is None or meta.record_version is None:
        raise StepError("agent_record_invalid")
    return Decision(Outcome.UPDATE, version=meta.latest_version + 1)
