"""Starts the provisioners (Step Functions) for what was approved (spec §5, D25).

mango-api never creates AWS resources for an agent or an MCP pack: it only starts the state
machines of the release, and only with identifiers (TM-M1, TM-M2):

* an agent version: ``{agent_id, version, content_hash}``. The provisioner loads the version
  itself and refuses to deploy if the stored content no longer matches that hash;
* a pack enablement: ``{pack_id, pack_version, enablement_id}``. Whether it installs or
  removes the pack is what the stored enablement says, and the provisioner verifies the
  signed statement of the release itself;
* a retired agent: ``{agent_id}``. The deprovisioner checks itself that the agent is retired
  before it deletes the agent's harness and role (D48).

It also reads how the removals went (``ListExecutions``: names and statuses only), so an
administrator sees a removal that is still running or that failed.
"""

from __future__ import annotations

import json
import re
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from botocore.exceptions import BotoCoreError, ClientError

from mango_core.agents import is_agent_id
from mango_core.agents_table import MAX_VERSION
from mango_packs.enablement import ENABLEMENT_ID_PATTERN, is_pack_id

if TYPE_CHECKING:
    from mypy_boto3_stepfunctions import SFNClient

_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_PACK_VERSION_RE = re.compile(r"^[0-9]+(\.[0-9]+){1,3}-[1-9][0-9]{0,3}$")
_ENABLEMENT_ID_RE = re.compile(ENABLEMENT_ID_PATTERN)
_STATE_MACHINE_RE = re.compile(
    r"^arn:aws[a-z-]*:states:[a-z0-9-]+:\d{12}:stateMachine:[A-Za-z0-9_-]{1,80}$"
)


_RETIRE_MARK = "-retire-"
_RETIRE_SUFFIX_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
CLEANUP_PAGE_SIZE = 1000
CLEANUP_MAX_PAGES = 2
"""Executions read per listing (newest first). Older ones are not looked at."""
CLEANUP_CACHE_SECONDS = 15
"""The Marketplace of every administrator asks: one listing serves them all for a moment."""

CleanupStatus = Literal["running", "done", "failed"]
_CLEANUP: dict[str, CleanupStatus] = {
    "RUNNING": "running",
    "PENDING_REDRIVE": "running",
    "SUCCEEDED": "done",
    "FAILED": "failed",
    "TIMED_OUT": "failed",
    "ABORTED": "failed",
}


@dataclass(frozen=True)
class Cleanups:
    """How the last removal of each retired agent went, by agent id."""

    by_agent: dict[str, CleanupStatus]
    complete: bool
    """False when there were more executions than the ones read."""


class ProvisionerError(Exception):
    """The execution could not be started; the caller marks the version as failed."""


class ProvisionerClient:
    def __init__(self, stepfunctions: SFNClient, state_machine_arn: str) -> None:
        if not _STATE_MACHINE_RE.fullmatch(state_machine_arn):
            raise ValueError("invalid provisioner state machine ARN")
        self._sfn = stepfunctions
        self._arn = state_machine_arn

    def start(self, agent_id: str, version: int, content_hash: str) -> str:
        """Start one execution for ``agent_id`` version ``version``; returns its name.

        The input is exactly ``{agent_id, version, content_hash}``: values this module
        re-validates, never text from the definition.
        """
        if (
            not is_agent_id(agent_id)
            or not 1 <= version <= MAX_VERSION
            or not _HASH_RE.fullmatch(content_hash)
        ):
            raise ValueError("invalid provisioner input")
        # A retry needs a new name: Step Functions keeps execution names for 90 days.
        name = f"{agent_id}-v{version}-{content_hash[:12]}-{secrets.token_hex(4)}"
        try:
            self._sfn.start_execution(
                stateMachineArn=self._arn,
                name=name,
                input=json.dumps(
                    {"agent_id": agent_id, "version": version, "content_hash": content_hash},
                    separators=(",", ":"),
                    sort_keys=True,
                ),
            )
        except (ClientError, BotoCoreError) as exc:
            raise ProvisionerError("the provisioner could not be started") from exc
        return name


class DeprovisionerClient:
    def __init__(
        self,
        stepfunctions: SFNClient,
        state_machine_arn: str,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not _STATE_MACHINE_RE.fullmatch(state_machine_arn):
            raise ValueError("invalid deprovisioner state machine ARN")
        self._sfn = stepfunctions
        self._arn = state_machine_arn
        self._clock = clock
        self._lock = threading.Lock()
        self._cached: tuple[float, Cleanups] | None = None

    def start(self, agent_id: str) -> str:
        """Start removing the AWS resources of the retired agent ``agent_id``; returns the
        execution name.

        The input is exactly ``{agent_id}``, re-validated here. What gets deleted is derived
        from that id by the deprovisioner, never sent from here.
        """
        if not is_agent_id(agent_id):
            raise ValueError("invalid deprovisioner input")
        # A retry needs a new name: Step Functions keeps execution names for 90 days.
        name = f"{agent_id}-retire-{secrets.token_hex(4)}"
        try:
            self._sfn.start_execution(
                stateMachineArn=self._arn,
                name=name,
                input=json.dumps({"agent_id": agent_id}, separators=(",", ":")),
            )
        except (ClientError, BotoCoreError) as exc:
            raise ProvisionerError("the deprovisioner could not be started") from exc
        with self._lock:
            self._cached = None
        return name

    def cleanups(self) -> Cleanups:
        """The status of the last removal of each agent, from the executions of the state
        machine (names and statuses; never their input, output or error).

        Only executions named ``<agent id>-retire-<suffix>`` count: the ones ``start`` makes
        and the ones the runbook tells an operator to start by hand.
        """
        with self._lock:
            cached = self._cached
        if cached is not None and self._clock() - cached[0] < CLEANUP_CACHE_SECONDS:
            return cached[1]
        by_agent: dict[str, CleanupStatus] = {}
        token: str | None = None
        try:
            for _ in range(CLEANUP_MAX_PAGES):
                page = (
                    self._sfn.list_executions(
                        stateMachineArn=self._arn, maxResults=CLEANUP_PAGE_SIZE, nextToken=token
                    )
                    if token
                    else self._sfn.list_executions(
                        stateMachineArn=self._arn, maxResults=CLEANUP_PAGE_SIZE
                    )
                )
                # Newest first: the first execution seen for an agent is its last removal.
                for execution in page.get("executions", []):
                    agent_id, mark, suffix = str(execution.get("name", "")).partition(_RETIRE_MARK)
                    status = _CLEANUP.get(str(execution.get("status", "")))
                    if (
                        mark
                        and status is not None
                        and is_agent_id(agent_id)
                        and _RETIRE_SUFFIX_RE.fullmatch(suffix)
                    ):
                        by_agent.setdefault(agent_id, status)
                token = page.get("nextToken")
                if not token:
                    break
        except (ClientError, BotoCoreError) as exc:
            raise ProvisionerError("the removals could not be read") from exc
        result = Cleanups(by_agent=by_agent, complete=not token)
        with self._lock:
            self._cached = (self._clock(), result)
        return result


class PackProvisionerClient:
    def __init__(self, stepfunctions: SFNClient, state_machine_arn: str) -> None:
        if not _STATE_MACHINE_RE.fullmatch(state_machine_arn):
            raise ValueError("invalid pack provisioner state machine ARN")
        self._sfn = stepfunctions
        self._arn = state_machine_arn

    def start(self, pack_id: str, pack_version: str, enablement_id: str) -> str:
        """Start one execution for the stored enablement of ``pack_id``; returns its name.

        The input is exactly ``{pack_id, pack_version, enablement_id}``: values this module
        re-validates, never parameters or text from the request.
        """
        if (
            not is_pack_id(pack_id)
            or not _PACK_VERSION_RE.fullmatch(pack_version)
            or not _ENABLEMENT_ID_RE.fullmatch(enablement_id)
        ):
            raise ValueError("invalid pack provisioner input")
        # Execution names are at most 80 characters and kept for 90 days: a retry needs a
        # new one.
        name = f"{pack_id}-{pack_version.replace('.', '_')}-{secrets.token_hex(8)}"
        try:
            self._sfn.start_execution(
                stateMachineArn=self._arn,
                name=name,
                input=json.dumps(
                    {
                        "pack_id": pack_id,
                        "pack_version": pack_version,
                        "enablement_id": enablement_id,
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                ),
            )
        except (ClientError, BotoCoreError) as exc:
            raise ProvisionerError("the pack provisioner could not be started") from exc
        return name
